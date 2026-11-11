//! Integração do núcleo de voz nativo contra o LiveKit de desenvolvimento (Compose). Roda SEM dispositivos
//! reais: o núcleo troca microfone/câmera/tela por tom e barras de cor (`use_synthetic_inputs`), e um segundo
//! participante (livekit SDK puro) confere o que chega, incluindo o pipeline I420 → JPEG do webview.
//!
//! Tudo é `#[ignore]` (precisa do LiveKit no ar). Rode sob demanda:
//!
//! ```sh
//! pnpm infra:up
//! # no host (Linux) ou no Docker na rede do Compose:
//! LIVEKIT_URL=ws://livekit:7880 cargo test --test livekit_integration -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Variáveis: `LIVEKIT_URL` (padrão `ws://localhost:7880`), `LIVEKIT_API_KEY` (`devkey`) e
//! `LIVEKIT_API_SECRET` (`devsecret-devsecret-devsecret-32`, de `deploy/livekit/livekit.yaml`).

use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use libwebrtc::audio_source::native::NativeAudioSource;
use libwebrtc::audio_stream::native::NativeAudioStream;
use libwebrtc::prelude::{
    AudioFrame, AudioSourceOptions, RtcAudioSource, RtcVideoSource, VideoFrame, VideoResolution,
    VideoRotation,
};
use libwebrtc::video_source::native::NativeVideoSource;
use libwebrtc::video_stream::native::NativeVideoStream;
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit_api::access_token::{AccessToken, VideoGrants};
use spook_desktop_lib::voice::audio::{tone, FRAME_SAMPLES, SAMPLE_RATE};
use spook_desktop_lib::voice::core::{
    ScreenOptions, ViewOptions, VoiceCore, LOCAL_CAMERA_ID, LOCAL_SCREEN_ID,
};
use spook_desktop_lib::voice::error::{ConnectCode, VoiceError};
use spook_desktop_lib::voice::events::VoiceEvent;
use spook_desktop_lib::voice::frames::encode_jpeg;
use spook_desktop_lib::voice::limits;
use spook_desktop_lib::voice::router::FrameSink;
use spook_desktop_lib::voice::synth::{color_bars, SyntheticInputs, BARS};
use spook_desktop_lib::voice::wire;
use tokio::sync::mpsc::UnboundedReceiver;

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

fn url() -> String {
    env("LIVEKIT_URL", "ws://localhost:7880")
}

fn token(room: &str, identity: &str) -> String {
    AccessToken::with_api_key(
        &env("LIVEKIT_API_KEY", "devkey"),
        &env("LIVEKIT_API_SECRET", "devsecret-devsecret-devsecret-32"),
    )
    .with_ttl(Duration::from_secs(600))
    .with_identity(identity)
    .with_grants(VideoGrants {
        room_join: true,
        room: room.to_string(),
        can_publish: Some(true),
        can_subscribe: Some(true),
        ..Default::default()
    })
    .to_jwt()
    .expect("token")
}

fn room_name(tag: &str) -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("spook-it-{tag}-{n}")
}

type Events = Arc<Mutex<Vec<VoiceEvent>>>;

fn collector() -> (Events, spook_desktop_lib::voice::core::Emit) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (
        events,
        Arc::new(move |e| sink.lock().unwrap_or_else(|p| p.into_inner()).push(e)),
    )
}

fn snapshot(events: &Events) -> Vec<VoiceEvent> {
    events.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

async fn eventually(secs: u64, mut cond: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    cond()
}

/// Recebe quadros "como o webview": guarda os bytes crus.
#[derive(Clone, Default)]
struct Collect(Arc<Mutex<Vec<Vec<u8>>>>);

impl Collect {
    fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
    fn get(&self, i: usize) -> Vec<u8> {
        self.0.lock().unwrap()[i].clone()
    }
}

impl FrameSink for Collect {
    fn send(&self, bytes: Vec<u8>) -> bool {
        self.0.lock().unwrap().push(bytes);
        true
    }
}

fn decode_jpeg(jpeg: &[u8]) -> image::RgbImage {
    image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)
        .expect("JPEG válido")
        .to_rgb8()
}

/// As quatro barras (vermelho, verde, azul, branco) estão nas posições certas?
fn assert_bars(img: &image::RgbImage) {
    let (w, h) = img.dimensions();
    for (i, (r, g, b)) in BARS.iter().enumerate() {
        let x = (w * (2 * i as u32 + 1)) / 8;
        let px = img.get_pixel(x, h / 2).0;
        let d = |a: u8, e: u8| (a as i32 - e as i32).abs();
        assert!(
            d(px[0], *r) < 70 && d(px[1], *g) < 70 && d(px[2], *b) < 70,
            "barra {i} em ({x},{}): esperado {:?}, veio {:?}",
            h / 2,
            (r, g, b),
            px
        );
    }
}

fn rising_crossings(s: &[i16]) -> usize {
    s.windows(2).filter(|w| w[0] < 0 && w[1] >= 0).count()
}

async fn next_event(
    rx: &mut UnboundedReceiver<RoomEvent>,
    secs: u64,
    mut pick: impl FnMut(RoomEvent) -> Option<RoomEvent>,
) -> Option<RoomEvent> {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        let left = end.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Some(e)) => {
                if let Some(e) = pick(e) {
                    return Some(e);
                }
            }
            _ => return None,
        }
    }
    None
}

/// Mede a frequência (Hz) do áudio de uma faixa remota por cruzamentos de zero.
async fn measure_tone(track: RemoteAudioTrack) -> f64 {
    let mut stream = NativeAudioStream::new(track.rtc_track(), SAMPLE_RATE as i32, 1);
    let mut onset = false;
    let mut skip = 50; // ~500 ms de acomodação do NetEq
    let mut samples: Vec<i16> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let Ok(Some(frame)) = tokio::time::timeout(Duration::from_secs(5), stream.next()).await
        else {
            break;
        };
        if !onset {
            if !frame.data.iter().any(|s| s.unsigned_abs() > 3000) {
                continue;
            }
            onset = true;
        }
        if skip > 0 {
            skip -= 1;
            continue;
        }
        samples.extend_from_slice(&frame.data);
        if samples.len() >= SAMPLE_RATE as usize {
            break;
        }
    }
    assert!(
        samples.len() >= SAMPLE_RATE as usize / 2,
        "áudio insuficiente: {}",
        samples.len()
    );
    rising_crossings(&samples) as f64 * SAMPLE_RATE as f64 / samples.len() as f64
}

/// Lê o primeiro quadro de uma faixa remota e passa pelo pipeline JPEG do webview.
async fn first_jpeg(track: RemoteVideoTrack, max: (u32, u32)) -> (Vec<u8>, u32, u32) {
    let mut stream = NativeVideoStream::new(track.rtc_track());
    let frame = tokio::time::timeout(Duration::from_secs(20), stream.next())
        .await
        .expect("nenhum quadro de vídeo em 20 s")
        .expect("stream de vídeo fechou");
    encode_jpeg(frame.buffer.as_ref(), max, limits::JPEG_QUALITY).expect("JPEG")
}

// ------------------------------------------------------------------------------------------------
// 1) O núcleo PUBLICA (tom + barras) e um segundo participante RECEBE.
// ------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "precisa do LiveKit de desenvolvimento (pnpm infra:up)"]
async fn core_publishes_synthetic_audio_and_video_to_another_participant() {
    let room = room_name("pub");
    let (mut observer, mut rx) = {
        let (r, rx) = Room::connect(&url(), &token(&room, "observer"), RoomOptions::default())
            .await
            .expect("observador conecta");
        (r, rx)
    };
    let _ = &mut observer;

    let core = Arc::new(VoiceCore::new());
    core.use_synthetic_inputs(Some(SyntheticInputs {
        tone_hz: 440.0,
        video: (1280, 720),
        fps: 15,
    }));
    let (events, emit) = collector();
    core.connect(&url(), &token(&room, "native"), emit)
        .await
        .expect("núcleo conecta");
    assert!(core.is_connected().await);

    // Quem já estava na sala aparece (o observador).
    assert!(snapshot(&events).contains(&VoiceEvent::ParticipantJoined {
        identity: "observer".into()
    }));

    core.set_microphone(true).await.expect("microfone");
    core.set_camera(true, None).await.expect("câmera");
    core.set_screen_share(
        true,
        ScreenOptions {
            source_id: "x".into(),
            audio: true,
            audio_apps: None,
            quality: None,
        },
    )
    .await
    .expect("tela");

    let ev = snapshot(&events);
    assert!(ev.contains(&VoiceEvent::LocalMedia {
        microphone: true,
        camera: true,
        screen_share: true
    }));
    assert!(ev.iter().any(|e| matches!(e, VoiceEvent::VideoTrackAdded { id, local: true, kind: "camera", .. } if id == LOCAL_CAMERA_ID)));
    assert!(ev.iter().any(|e| matches!(e, VoiceEvent::VideoTrackAdded { id, local: true, kind: "screen", .. } if id == LOCAL_SCREEN_ID)));

    // O observador recebe 1 áudio e 2 vídeos (câmera e tela).
    let mut audio: Option<RemoteAudioTrack> = None;
    let mut camera: Option<RemoteVideoTrack> = None;
    let mut screen: Option<RemoteVideoTrack> = None;
    let mut audio_pub: Option<RemoteTrackPublication> = None;
    let end = Instant::now() + Duration::from_secs(30);
    while (audio.is_none() || camera.is_none() || screen.is_none()) && Instant::now() < end {
        let Some(RoomEvent::TrackSubscribed {
            track, publication, ..
        }) = next_event(&mut rx, 30, |e| {
            matches!(e, RoomEvent::TrackSubscribed { .. }).then_some(e)
        })
        .await
        else {
            break;
        };
        match (track, publication.source()) {
            (RemoteTrack::Audio(t), TrackSource::Microphone) => {
                audio = Some(t);
                audio_pub = Some(publication);
            }
            (RemoteTrack::Video(t), TrackSource::Camera) => camera = Some(t),
            (RemoteTrack::Video(t), TrackSource::Screenshare) => screen = Some(t),
            _ => {}
        }
    }
    let (audio, camera, screen) = (
        audio.expect("áudio do microfone"),
        camera.expect("vídeo da câmera"),
        screen.expect("vídeo da tela"),
    );

    // Áudio: o tom de 440 Hz chega decodificado.
    let hz = measure_tone(audio.clone()).await;
    assert!((hz - 440.0).abs() < 25.0, "frequência recebida {hz} Hz");

    // Vídeo: JPEG válido, proporção 16:9, dentro do limite do webview, barras de cor corretas.
    for (name, track) in [("câmera", camera), ("tela", screen)] {
        let (jpeg, w, h) = first_jpeg(track, limits::VIEW_MAX).await;
        assert!(
            w <= 1280 && h <= 720 && w % 2 == 0 && h % 2 == 0,
            "{name}: {w}x{h}"
        );
        assert!(
            ((w as f64 / h as f64) - 16.0 / 9.0).abs() < 0.05,
            "{name}: {w}x{h}"
        );
        let img = decode_jpeg(&jpeg);
        assert_eq!(img.dimensions(), (w, h));
        assert_bars(&img);
    }

    // Prévia local (o que o webview desenha da própria câmera): menor, com cabeçalho correto.
    let preview = Collect::default();
    core.subscribe_video(
        LOCAL_CAMERA_ID,
        Box::new(preview.clone()),
        ViewOptions {
            max_width: Some(640),
            max_height: Some(360),
            fps: Some(10),
        },
    )
    .await
    .expect("prévia");
    assert!(
        eventually(10, || preview.len() >= 2).await,
        "sem quadros de prévia"
    );
    let bytes = preview.get(0);
    let (header, jpeg) = wire::decode(&bytes).expect("quadro bem formado");
    assert_eq!(header.track_id, LOCAL_CAMERA_ID);
    assert_eq!(header.source, "camera");
    assert_eq!(header.participant_id, "native");
    assert!(
        header.width <= 640 && header.height <= 360,
        "{}x{}",
        header.width,
        header.height
    );
    let img = decode_jpeg(jpeg);
    assert_eq!(img.dimensions(), (header.width, header.height));
    assert_bars(&img);
    core.ack_video(LOCAL_CAMERA_ID);

    // Mute: a faixa continua publicada e o observador vê "mudo"; desmutar volta.
    core.set_microphone(false).await.expect("mudo");
    let muted = next_event(&mut rx, 10, |e| {
        matches!(e, RoomEvent::TrackMuted { .. }).then_some(e)
    })
    .await;
    assert!(muted.is_some(), "o observador não viu o mute");
    assert!(audio_pub.is_some());
    assert!(snapshot(&events).contains(&VoiceEvent::LocalMedia {
        microphone: false,
        camera: true,
        screen_share: true
    }));
    core.set_microphone(true).await.expect("desmutar");
    let unmuted = next_event(&mut rx, 10, |e| {
        matches!(e, RoomEvent::TrackUnmuted { .. }).then_some(e)
    })
    .await;
    assert!(unmuted.is_some(), "o observador não viu o unmute");

    // Câmera desligada: some para os outros e para a prévia.
    core.set_camera(false, None).await.expect("câmera off");
    let gone = next_event(&mut rx, 10, |e| {
        matches!(e, RoomEvent::TrackUnpublished { .. }).then_some(e)
    })
    .await;
    assert!(gone.is_some(), "o observador não viu a câmera sair");
    assert!(
        !core.router().is_subscribed(LOCAL_CAMERA_ID),
        "prévia deveria ter sido removida"
    );
    assert!(snapshot(&events).contains(&VoiceEvent::VideoTrackRemoved {
        id: LOCAL_CAMERA_ID.into()
    }));

    // Disconnect limpa tudo: sai da sala, zera inscrições, é idempotente.
    core.disconnect().await;
    assert!(!core.is_connected().await);
    let left = next_event(&mut rx, 15, |e| match &e {
        RoomEvent::ParticipantDisconnected(p) if p.identity().as_str() == "native" => Some(e),
        _ => None,
    })
    .await;
    assert!(left.is_some(), "o observador não viu o núcleo sair");
    assert!(!core.router().is_subscribed(LOCAL_SCREEN_ID));
    let disconnected = snapshot(&events)
        .iter()
        .filter(|e| matches!(e, VoiceEvent::Disconnected { reason: "client" }))
        .count();
    assert_eq!(disconnected, 1);
    core.disconnect().await;
    assert_eq!(
        snapshot(&events)
            .iter()
            .filter(|e| matches!(e, VoiceEvent::Disconnected { .. }))
            .count(),
        1,
        "disconnect repetido não pode emitir de novo"
    );
    assert!(
        core.set_microphone(true).await.is_err(),
        "sem sala não pode ligar o microfone"
    );
    observer.close().await.ok();
}

// ------------------------------------------------------------------------------------------------
// 2) Um participante PUBLICA e o núcleo RECEBE: áudio no mixer, vídeo em JPEG, deafen, backpressure.
// ------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "precisa do LiveKit de desenvolvimento (pnpm infra:up)"]
async fn core_receives_audio_and_video_with_deafen_and_backpressure() {
    let room = room_name("sub");
    let (publisher, _prx) = Room::connect(&url(), &token(&room, "tx"), RoomOptions::default())
        .await
        .expect("publicador conecta");
    let publisher = Arc::new(publisher);

    // Áudio sintético (600 Hz) em tempo real.
    let asrc = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, 1, 100);
    let atrack = LocalAudioTrack::create_audio_track("tone", RtcAudioSource::Native(asrc.clone()));
    publisher
        .local_participant()
        .publish_track(
            LocalTrack::Audio(atrack),
            TrackPublishOptions {
                source: TrackSource::Microphone,
                ..Default::default()
            },
        )
        .await
        .expect("publica áudio");
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut n = 0usize;
            let mut tick = tokio::time::interval(Duration::from_millis(10));
            while !stop.load(Ordering::SeqCst) {
                tick.tick().await;
                let pcm = tone(600.0, n, FRAME_SAMPLES, 0.5);
                n += FRAME_SAMPLES;
                let f = AudioFrame {
                    data: Cow::Owned(pcm),
                    sample_rate: SAMPLE_RATE,
                    num_channels: 1,
                    samples_per_channel: FRAME_SAMPLES as u32,
                };
                if asrc.capture_frame(&f).await.is_err() {
                    break;
                }
            }
        });
    }
    // Vídeo sintético (barras de cor) a 15 fps.
    let vsrc = NativeVideoSource::new(
        VideoResolution {
            width: 1280,
            height: 720,
        },
        false,
    );
    let vtrack = LocalVideoTrack::create_video_track("bars", RtcVideoSource::Native(vsrc.clone()));
    let vpub = publisher
        .local_participant()
        .publish_track(
            LocalTrack::Video(vtrack),
            TrackPublishOptions {
                source: TrackSource::Camera,
                simulcast: false,
                ..Default::default()
            },
        )
        .await
        .expect("publica vídeo");
    let video_sid = vpub.sid().to_string();
    {
        let stop = stop.clone();
        tokio::spawn(async move {
            while !stop.load(Ordering::SeqCst) {
                vsrc.capture_frame(&VideoFrame::new(
                    VideoRotation::VideoRotation0,
                    color_bars(1280, 720),
                ));
                tokio::time::sleep(Duration::from_millis(66)).await;
            }
        });
    }

    let core = Arc::new(VoiceCore::new());
    let (events, emit) = collector();
    core.connect(&url(), &token(&room, "native-rx"), emit)
        .await
        .expect("núcleo conecta");

    // Eventos: o publicador já estava, e a faixa de vídeo chega com o id da publicação.
    assert!(
        eventually(20, || snapshot(&events).iter().any(|e| matches!(e,
            VoiceEvent::VideoTrackAdded { id, identity, kind: "camera", local: false } if *id == video_sid && identity == "tx")))
        .await,
        "VideoTrackAdded não chegou: {:?}",
        snapshot(&events)
    );
    assert!(snapshot(&events).contains(&VoiceEvent::ParticipantJoined {
        identity: "tx".into()
    }));

    // Áudio: o mixer recebe o tom de 600 Hz (sem placa de som o núcleo não toca; aqui nós drenamos).
    let mixer = core.mixer();
    let mut good_chunks = 0usize;
    let mut crossings = 0usize;
    let end = Instant::now() + Duration::from_secs(25);
    let mut buf = vec![0i16; FRAME_SAMPLES];
    while good_chunks < 40 && Instant::now() < end {
        mixer.lock().unwrap().mix_into(&mut buf);
        if buf.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0) > 3000
            && buf.iter().all(|s| *s != 0)
        {
            good_chunks += 1;
            crossings += rising_crossings(&buf);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        good_chunks >= 40,
        "pouco áudio no mixer ({good_chunks} blocos)"
    );
    let hz = crossings as f64 * 100.0 / good_chunks as f64; // cada bloco = 10 ms
    assert!((hz - 600.0).abs() < 60.0, "frequência no mixer {hz} Hz");

    // Ensurdecer: silêncio imediato e nada acumula; voltar a ouvir retoma.
    core.set_deafened(true);
    for _ in 0..30 {
        mixer.lock().unwrap().mix_into(&mut buf);
        assert!(
            buf.iter().all(|s| *s == 0),
            "deveria estar em silêncio ensurdecido"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    core.set_deafened(false);
    let back = eventually(10, || {
        mixer.lock().unwrap().mix_into(&mut buf);
        buf.iter().any(|s| s.unsigned_abs() > 3000)
    })
    .await;
    assert!(back, "o áudio não voltou depois de deixar de ensurdecer");

    // Vídeo remoto → JPEG no canal, no formato do IPC.
    let sink = Collect::default();
    core.subscribe_video(
        &video_sid,
        Box::new(sink.clone()),
        ViewOptions {
            max_width: Some(640),
            max_height: Some(360),
            fps: Some(10),
        },
    )
    .await
    .expect("inscrição");
    assert!(
        eventually(20, || sink.len() >= 2).await,
        "sem quadros de vídeo remoto"
    );
    let (header, jpeg) = {
        let bytes = sink.get(0);
        let (h, j) = wire::decode(&bytes).expect("quadro bem formado");
        (h, j.to_vec())
    };
    assert_eq!(header.track_id, video_sid);
    assert_eq!(header.participant_id, "tx");
    assert_eq!(header.source, "camera");
    assert!(
        header.width <= 640 && header.height <= 360 && header.width > 0,
        "{}x{}",
        header.width,
        header.height
    );
    let img = decode_jpeg(&jpeg);
    assert_eq!(img.dimensions(), (header.width, header.height));
    assert_bars(&img);

    // Backpressure: sem confirmação o núcleo não passa de MAX_IN_FLIGHT quadros e descarta o resto
    // (a janela de 900 ms é menor que o prazo de 1,5 s em que um crédito perdido é recuperado).
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(
        sink.len(),
        limits::MAX_IN_FLIGHT as usize,
        "o núcleo continuou enviando sem confirmação"
    );
    let (sent, dropped) = core.router().stats(&video_sid).expect("inscrição ativa");
    assert!(
        sent >= 2 && dropped > 0,
        "enviados {sent}, descartados {dropped}"
    );
    // Créditos perdidos (webview que nunca confirma) expiram e o fluxo recomeça sozinho.
    assert!(
        eventually(10, || sink.len() > limits::MAX_IN_FLIGHT as usize).await,
        "o crédito perdido não expirou"
    );
    // Confirmando, o fluxo segue.
    for _ in 0..4 {
        core.ack_video(&video_sid);
    }
    let before = sink.len();
    assert!(
        eventually(10, || sink.len() > before).await,
        "o fluxo não retomou após o ack"
    );

    // Desinscrever para a conversão: nada novo chega depois de assentar.
    core.unsubscribe_video(&video_sid).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let settled = sink.len();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(sink.len(), settled, "chegou quadro depois de desinscrever");
    assert!(!core.router().is_subscribed(&video_sid));

    // O publicador tira o vídeo e sai: o núcleo avisa a interface.
    publisher
        .local_participant()
        .unpublish_track(&vpub.sid())
        .await
        .ok();
    assert!(
        eventually(15, || snapshot(&events).contains(
            &VoiceEvent::VideoTrackRemoved {
                id: video_sid.clone()
            }
        ))
        .await,
        "VideoTrackRemoved não chegou"
    );
    stop.store(true, Ordering::SeqCst);
    publisher.close().await.ok();
    assert!(
        eventually(15, || snapshot(&events).contains(
            &VoiceEvent::ParticipantLeft {
                identity: "tx".into()
            }
        ))
        .await,
        "ParticipantLeft não chegou"
    );

    core.disconnect().await;
    assert_eq!(
        mixer.lock().unwrap().sources(),
        0,
        "o mixer deveria estar vazio após sair"
    );
    assert!(!core.is_connected().await);
}

// ------------------------------------------------------------------------------------------------
// 3) Ciclo de vida e erros: um canal por vez, token inválido, servidor inalcançável.
// ------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "precisa do LiveKit de desenvolvimento (pnpm infra:up)"]
async fn lifecycle_one_room_at_a_time_and_typed_errors() {
    let core = Arc::new(VoiceCore::new());
    let (events, emit) = collector();

    // Comandos sem sala devolvem erro tipado, sem pânico.
    assert!(matches!(
        core.set_microphone(true).await,
        Err(VoiceError::Other { .. })
    ));
    assert!(matches!(
        core.set_camera(true, None).await,
        Err(VoiceError::Other { .. })
    ));
    assert!(core
        .set_screen_share(true, ScreenOptions::default())
        .await
        .is_err());
    // Escolher dispositivo sem sala só guarda a preferência.
    core.set_device(
        spook_desktop_lib::voice::core::DeviceKind::AudioInput,
        "qualquer",
    )
    .await
    .expect("guarda");

    // Token inválido: erro de conexão tipado e nada fica "conectado".
    let bad = core.connect(&url(), "aaa.bbb.ccc", emit.clone()).await;
    match bad {
        Err(VoiceError::Connect { code, message }) => {
            assert!(matches!(
                code,
                ConnectCode::TokenRejected | ConnectCode::Unreachable | ConnectCode::Unknown
            ));
            assert!(
                !message.contains("aaa.bbb.ccc"),
                "a mensagem não pode vazar o token"
            );
        }
        other => panic!("esperava erro de conexão, veio {other:?}"),
    }
    assert!(!core.is_connected().await);

    // Um canal por vez: entrar no segundo tira do primeiro.
    let (r1, mut rx1) = Room::connect(
        &url(),
        &token("spook-it-a", "watch"),
        RoomOptions::default(),
    )
    .await
    .expect("observador da sala A");
    core.connect(&url(), &token("spook-it-a", "native"), emit.clone())
        .await
        .expect("sala A");
    assert!(eventually(10, || r1.remote_participants().len() == 1).await);
    core.connect(&url(), &token("spook-it-b", "native"), emit.clone())
        .await
        .expect("sala B");
    let left = next_event(&mut rx1, 15, |e| match &e {
        RoomEvent::ParticipantDisconnected(p) if p.identity().as_str() == "native" => Some(e),
        _ => None,
    })
    .await;
    assert!(left.is_some(), "a sala A deveria ter perdido o núcleo");
    assert!(core.is_connected().await);
    core.disconnect().await;
    assert!(!core.is_connected().await);
    assert!(snapshot(&events)
        .iter()
        .any(|e| matches!(e, VoiceEvent::Disconnected { reason: "client" })));
    r1.close().await.ok();
}
