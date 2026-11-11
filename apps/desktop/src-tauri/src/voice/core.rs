//! Núcleo da voz nativa: uma sala do LiveKit por vez, microfone/reprodução (cpal), tela (scap), câmera
//! (nokhwa) e o vídeo remoto convertido em JPEG. Não depende do Tauri (só de `VideoRouter`/eventos), então
//! o teste de integração o usa direto contra o LiveKit de desenvolvimento.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use libwebrtc::audio_source::native::NativeAudioSource;
use libwebrtc::audio_stream::native::{NativeAudioStream, NativeAudioStreamOptions};
use libwebrtc::prelude::{
    AudioFrame, AudioSourceOptions, RtcAudioSource, RtcVideoSource, VideoResolution,
};
use libwebrtc::video_source::native::NativeVideoSource;
use libwebrtc::video_stream::native::NativeVideoStream;
use livekit::options::{DegradationPreference, TrackPublishOptions, VideoEncoding};
use livekit::prelude::*;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::apm::{ApmBridge, AudioProcessingSettings};
use super::appaudio::{self, AppAudioOptions, CapturePlan};
use super::audio::{self, Direction, MicCapture, Playback, FRAME_SAMPLES, SAMPLE_RATE};
use super::camera;
use super::capture::VideoOut;
use super::error::{classify_connect_message, connect_message, MediaCode, MediaDevice, VoiceError};
use super::events::{map_disconnect_reason, map_quality, VoiceEvent};
use super::frames::encode_jpeg;
use super::limits;
use super::mictest::{Feeder, Recorder, RECORD_MS};
use super::mixer::{AudioSource, Mixer};
use super::quality::ScreenQuality;
use super::router::{FrameSink, VideoRouter, ViewParams};
use super::screen;
use super::screen_audio::{self, AudioCapture};
use super::synth::{self, SyntheticInputs, ToneTask};
use super::watch::{decide, SubKind, WatchSet};

pub type Emit = Arc<dyn Fn(VoiceEvent) + Send + Sync>;

pub const LOCAL_CAMERA_ID: &str = "local:camera";
pub const LOCAL_SCREEN_ID: &str = "local:screen";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    AudioInput,
    AudioOutput,
    VideoInput,
}

impl DeviceKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "audioinput" => Some(Self::AudioInput),
            "audiooutput" => Some(Self::AudioOutput),
            "videoinput" => Some(Self::VideoInput),
            _ => None,
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct DevicePrefs {
    pub input: Option<String>,
    pub output: Option<String>,
    pub camera: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScreenOptions {
    pub source_id: String,
    /// Compartilhar áudio junto da tela. No Windows 10 2004+/11 vira uma faixa `ScreenshareAudio` (por padrão todo o
    /// sistema, MENOS o Spook); nas outras plataformas é aceito e ignorado (só a imagem vai).
    pub audio: bool,
    /// Áudio por aplicativo (`{ mode: "system" | "apps", master, apps: [{ exe, volume }] }`). Ausente = formato
    /// antigo (`audio: true` = todo o sistema).
    pub audio_apps: Option<AppAudioOptions>,
    /// Qualidade (altura, fps, prioridade, bitrate). Ausente = 1080p, 15 fps, nitidez (o que sempre foi).
    pub quality: Option<ScreenQuality>,
}

/// Configuração opcional do vídeo mostrado no webview.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewOptions {
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub fps: Option<u32>,
}

struct RemoteVideo {
    track: RemoteVideoTrack,
    identity: String,
    kind: &'static str,
    task: Option<JoinHandle<()>>,
}

struct Shared {
    emit: Emit,
    router: Arc<VideoRouter>,
    mixer: Arc<Mutex<Mixer>>,
    remote_audio: Mutex<HashMap<String, JoinHandle<()>>>,
    remote_video: Mutex<HashMap<String, RemoteVideo>>,
    known: Mutex<HashSet<String>>,
    closing: AtomicBool,
    /// Telas de outras pessoas que o usuário escolheu assistir. As telas começam NÃO assinadas (igual à web):
    /// assinar gasta banda de download e CPU de decodificação/JPEG, então só vale com alguém assistindo.
    watching: WatchSet,
}

/// Sala e estado compartilhado da sessão atual, acessíveis SEM esperar o `session` (que o microfone, a câmera e a
/// tela seguram durante awaits longos): assistir/parar de assistir precisa ser imediato.
struct Live {
    id: u64,
    room: Arc<Room>,
    shared: Arc<Shared>,
}

/// Natureza (para a política de assinatura) de uma publicação remota.
fn sub_kind(source: TrackSource) -> SubKind {
    match source {
        TrackSource::Screenshare => SubKind::ScreenVideo,
        TrackSource::ScreenshareAudio => SubKind::ScreenAudio,
        _ => SubKind::Other,
    }
}

/// Põe a assinatura de UMA publicação como a política manda: voz e câmera sempre; tela (vídeo e áudio) só
/// com "assistir". Idempotente. `set_subscribed` usa `tokio::spawn` (envia o pedido ao servidor): só chamar de
/// dentro do runtime (tarefas async), nunca de um comando Tauri síncrono.
fn sync_publication(shared: &Shared, identity: &str, publication: &RemoteTrackPublication) {
    let want = shared
        .watching
        .wants(sub_kind(publication.source()), identity);
    if let Some(on) = decide(want, publication.is_desired(), publication.is_subscribed()) {
        publication.set_subscribed(on);
    }
}

fn sync_participant(shared: &Shared, participant: &RemoteParticipant) {
    let identity = participant.identity().to_string();
    for (_, publication) in participant.track_publications() {
        sync_publication(shared, &identity, &publication);
    }
}

/// Código tipado (`"in-use"`, `"permission-denied"`...) de um erro de dispositivo, para o evento `mic-test`.
fn error_code(e: &VoiceError) -> &'static str {
    match e {
        VoiceError::Media { code, .. } => code.as_str(),
        _ => "unknown",
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Quem alimenta o microfone: o dispositivo real (cpal) ou o tom sintético dos testes.
/// Os campos só existem para ser soltos (o `Drop` para o dispositivo/tom).
#[allow(dead_code)]
enum MicInput {
    Device(MicCapture),
    Synthetic(ToneTask),
}

/// Microfone aberto ANTES de a sala conectar (em paralelo com o token e o `Room::connect`): a captura e o canal de
/// quadros. `start_mic_locked` o consome em vez de abrir o dispositivo de novo; soltar = parar a captura.
struct PreparedMic {
    capture: MicInput,
    rx: mpsc::Receiver<Vec<i16>>,
}

/// Captura de PRÉVIA do microfone (medidor de nível fora da chamada): passa pela mesma cadeia AEC/NS/porta, mas o
/// áudio nunca é publicado nem tocado. Soltar = parar.
struct Preview {
    _capture: MicInput,
    pump: JoinHandle<()>,
}

impl Drop for Preview {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

/// Intervalo do medidor de nível (~20 por segundo).
const METER_INTERVAL: Duration = Duration::from_millis(50);
/// Intervalo dos avisos de andamento do teste de microfone.
const TEST_TICK: Duration = Duration::from_millis(100);
/// Antecedência com que a gravação do teste é entregue ao alto-falante (o mixer guarda no máximo 200 ms).
const TEST_LEAD_MS: u64 = 60;

struct MicState {
    track: LocalAudioTrack,
    source: NativeAudioSource,
    capture: Option<MicInput>,
    pump: Option<JoinHandle<()>>,
}

/// Captura de vídeo em andamento (câmera, tela ou sintética): soltar = parar.
type VideoInput = Box<dyn std::any::Any + Send>;

struct CameraState {
    sid: TrackSid,
    _capture: VideoInput,
}

struct ScreenState {
    sid: TrackSid,
    _capture: VideoInput,
    /// Registra no log a cada poucos segundos o que o codificador realmente entrega (resolução, fps, bitrate,
    /// motivo de limitação). Para junto com a tela.
    stats_task: JoinHandle<()>,
    /// Áudio da tela (faixa `ScreenshareAudio`), quando pedido e suportado.
    audio: Option<ScreenAudio>,
}

impl Drop for ScreenState {
    fn drop(&mut self) {
        self.stats_task.abort();
    }
}

/// Faixa de áudio da tela: a captura (threads WASAPI), a tarefa que entrega os blocos ao LiveKit e a publicação.
struct ScreenAudio {
    sid: TrackSid,
    _capture: AudioCapture,
    pump: JoinHandle<()>,
}

impl Drop for ScreenAudio {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

/// Intervalo entre as linhas de estatística da transmissão no log.
const SCREEN_STATS_EVERY: Duration = Duration::from_secs(5);

/// `voz: tela enviada ...`: o que o libwebrtc de fato codifica e envia, para diagnosticar "não parece 1080p"
/// (`limitation=cpu|bandwidth` diz POR QUE a qualidade caiu). Só leitura; falhas são ignoradas.
fn spawn_screen_stats(track: LocalVideoTrack, quality: ScreenQuality) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut last: Option<(Instant, u64)> = None;
        loop {
            tokio::time::sleep(SCREEN_STATS_EVERY).await;
            let Ok(stats) = track.get_stats().await else {
                continue;
            };
            for st in stats {
                let libwebrtc::stats::RtcStats::OutboundRtp(o) = st else {
                    continue;
                };
                let now = Instant::now();
                let bytes = o.sent.bytes_sent;
                let kbps = match last {
                    Some((t, b)) if now > t => {
                        (bytes.saturating_sub(b) as f64 * 8.0 / 1000.0)
                            / now.duration_since(t).as_secs_f64()
                    }
                    _ => 0.0,
                };
                last = Some((now, bytes));
                log::info!(
                    "voz: tela enviada {}x{} {:.0} fps ~{:.0} kbps (teto {} kbps, pedido {}p{}) encoder={} limitation={:?} keyframes={} pli={}",
                    o.outbound.frame_width,
                    o.outbound.frame_height,
                    o.outbound.frames_per_second,
                    kbps,
                    quality.bitrate_kbps(),
                    quality.height,
                    quality.fps,
                    o.outbound.encoder_implementation,
                    o.outbound.quality_limitation_reason,
                    o.outbound.key_frames_encoded,
                    o.outbound.pli_count,
                );
            }
        }
    })
}

struct Session {
    id: u64,
    room: Arc<Room>,
    shared: Arc<Shared>,
    event_task: JoinHandle<()>,
    playback: Option<Playback>,
    mic: Option<MicState>,
    camera: Option<CameraState>,
    screen: Option<ScreenState>,
}

impl Session {
    fn local_media(&self) -> VoiceEvent {
        VoiceEvent::LocalMedia {
            microphone: self.mic.as_ref().is_some_and(|m| m.capture.is_some()),
            camera: self.camera.is_some(),
            screen_share: self.screen.is_some(),
        }
    }

    fn emit_local_media(&self) {
        (self.shared.emit)(self.local_media());
    }
}

pub struct VoiceCore {
    session: tokio::sync::Mutex<Option<Session>>,
    live: Mutex<Option<Live>>,
    router: Arc<VideoRouter>,
    mixer: Arc<Mutex<Mixer>>,
    prefs: Mutex<DevicePrefs>,
    deafened: AtomicBool,
    next_id: AtomicU64,
    synthetic: Mutex<Option<SyntheticInputs>>,
    apm: Arc<ApmBridge>,
    /// Canal de eventos do medidor e do teste de microfone (independente do da sala: valem fora de chamada).
    aux_emit: Arc<Mutex<Option<Emit>>>,
    monitor_on: AtomicBool,
    /// Medição só da captura da chamada (anel de "falando" do próprio usuário): nunca abre prévia.
    call_meter: AtomicBool,
    /// Abertura do microfone em andamento/pronta antes da conexão (`prepare_microphone`).
    prepared: Mutex<Option<JoinHandle<Result<PreparedMic, VoiceError>>>>,
    meter: Mutex<Option<JoinHandle<()>>>,
    preview: Mutex<Option<Preview>>,
    mic_test: Mutex<Option<JoinHandle<()>>>,
}

impl Default for VoiceCore {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceCore {
    pub fn new() -> Self {
        Self {
            session: tokio::sync::Mutex::new(None),
            live: Mutex::new(None),
            router: Arc::new(VideoRouter::new()),
            mixer: Arc::new(Mutex::new(Mixer::new())),
            prefs: Mutex::new(DevicePrefs::default()),
            deafened: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            synthetic: Mutex::new(None),
            apm: Arc::new(ApmBridge::new(AudioProcessingSettings::default())),
            aux_emit: Arc::new(Mutex::new(None)),
            monitor_on: AtomicBool::new(false),
            call_meter: AtomicBool::new(false),
            prepared: Mutex::new(None),
            meter: Mutex::new(None),
            preview: Mutex::new(None),
            mic_test: Mutex::new(None),
        }
    }

    /// Só para testes de integração: troca microfone, câmera e tela por tom e barras de cor.
    #[doc(hidden)]
    pub fn use_synthetic_inputs(&self, inputs: Option<SyntheticInputs>) {
        *lock(&self.synthetic) = inputs;
    }

    fn synthetic(&self) -> Option<SyntheticInputs> {
        *lock(&self.synthetic)
    }

    #[doc(hidden)]
    pub fn mixer(&self) -> Arc<Mutex<Mixer>> {
        self.mixer.clone()
    }

    fn prefs(&self) -> DevicePrefs {
        lock(&self.prefs).clone()
    }

    // ----- sessão -----

    /// Entra na sala. Se já houver uma, ela é encerrada antes (um canal de voz por vez).
    pub async fn connect(
        self: &Arc<Self>,
        url: &str,
        token: &str,
        emit: Emit,
    ) -> Result<(), VoiceError> {
        self.disconnect_inner(false).await;
        emit(VoiceEvent::ConnectionState {
            state: "connecting",
        });

        // `RoomOptions` é `#[non_exhaustive]`: parte do padrão e ajusta os campos.
        let mut options = RoomOptions::default();
        // Assinatura manual (como a web): o SDK 0.10 só tem auto-subscribe da SALA inteira. Voz e câmera são
        // assinadas em `sync_publication` assim que a publicação aparece; telas só quando alguém as assiste.
        options.auto_subscribe = false;
        options.adaptive_stream = false;
        options.dynacast = true;
        let connect_started = Instant::now();
        let (room, rx) = Room::connect(url, token, options).await.map_err(|e| {
            // Nunca registre a URL com token nem o token.
            let raw = e.to_string();
            log::warn!("falha ao conectar na sala de voz: {raw}");
            let code = classify_connect_message(&raw);
            VoiceError::connect(code, connect_message(code))
        })?;
        log::info!(
            "voz: Room::connect levou {} ms",
            connect_started.elapsed().as_millis()
        );
        let room = Arc::new(room);

        let shared = Arc::new(Shared {
            emit: emit.clone(),
            router: self.router.clone(),
            mixer: self.mixer.clone(),
            remote_audio: Mutex::new(HashMap::new()),
            remote_video: Mutex::new(HashMap::new()),
            known: Mutex::new(HashSet::new()),
            closing: AtomicBool::new(false),
            watching: WatchSet::new(),
        });
        {
            let mut mixer = lock(&self.mixer);
            mixer.clear();
            mixer.clear_gains(); // os volumes por pessoa valem só enquanto ela está na sala; o web reenvia
            mixer.set_deafened(self.deafened.load(Ordering::SeqCst));
        }

        // Quem já estava na sala.
        for (identity, participant) in room.remote_participants() {
            let id = identity.to_string();
            // Com a assinatura manual nada chega sozinho: pede a voz e a câmera de quem já estava.
            sync_participant(&shared, &participant);
            if lock(&shared.known).insert(id.clone()) {
                emit(VoiceEvent::ParticipantJoined { identity: id });
            }
        }

        let playback_started = Instant::now();
        let playback = match audio::start_playback(
            self.prefs().output,
            self.mixer.clone(),
            Some(self.apm.clone()),
        ) {
            Ok(p) => {
                log::info!(
                    "voz: abrir a reprodução levou {} ms",
                    playback_started.elapsed().as_millis()
                );
                Some(p)
            }
            Err(e) => {
                // Sem alto-falante a pessoa ainda pode falar; só não ouve.
                log::warn!("reprodução de áudio indisponível: {e}");
                None
            }
        };

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let event_task = tokio::spawn(run_events(
            self.clone(),
            id,
            room.clone(),
            shared.clone(),
            rx,
        ));
        *lock(&self.live) = Some(Live {
            id,
            room: room.clone(),
            shared: shared.clone(),
        });
        *self.session.lock().await = Some(Session {
            id,
            room,
            shared,
            event_task,
            playback,
            mic: None,
            camera: None,
            screen: None,
        });
        emit(VoiceEvent::ConnectionState { state: "connected" });
        Ok(())
    }

    /// Sai da sala (emite `disconnected` com `client`). Idempotente.
    pub async fn disconnect(&self) {
        self.disconnect_inner(true).await;
    }

    async fn disconnect_inner(&self, announce: bool) {
        let session = self.session.lock().await.take();
        if let Some(s) = session {
            let emit = s.shared.emit.clone();
            self.teardown(s).await;
            if announce {
                emit(VoiceEvent::Disconnected { reason: "client" });
            }
        }
    }

    /// A sala caiu por fora (servidor, rede). Só atua se ainda for a mesma sessão.
    async fn on_room_disconnected(&self, session_id: u64, reason: &'static str) {
        let session = {
            let mut guard = self.session.lock().await;
            if guard.as_ref().map(|s| s.id) != Some(session_id) {
                return;
            }
            guard.take()
        };
        if let Some(s) = session {
            let emit = s.shared.emit.clone();
            self.teardown(s).await;
            emit(VoiceEvent::Disconnected { reason });
        }
    }

    async fn teardown(&self, mut s: Session) {
        s.shared.closing.store(true, Ordering::SeqCst);
        {
            let mut live = lock(&self.live);
            if live.as_ref().is_some_and(|l| l.id == s.id) {
                *live = None;
            }
        }
        s.shared.watching.clear();
        s.event_task.abort();
        for (_, t) in lock(&s.shared.remote_audio).drain() {
            t.abort();
        }
        for (_, v) in lock(&s.shared.remote_video).drain() {
            if let Some(t) = v.task {
                t.abort();
            }
        }
        if let Some(mic) = s.mic.take() {
            if let Some(p) = mic.pump {
                p.abort();
            }
            drop(mic.capture);
        }
        // Soltar as capturas para as threads (cpal, scap, nokhwa) e o dispositivo.
        s.camera = None;
        s.screen = None;
        s.playback = None;
        self.router.clear();
        lock(&self.mixer).clear();
        let room = s.room.clone();
        drop(s);
        let _ = room.close().await;
        // Sem a captura da chamada, o medidor (se ligado) volta a usar a prévia.
        let _ = self.refresh_preview(false).await;
    }

    pub async fn is_connected(&self) -> bool {
        self.session.lock().await.is_some()
    }

    /// Há sala de voz conectada? Resposta imediata, sem esperar (serve a callbacks síncronos, como o fechar da
    /// janela): se a sessão está ocupada (entrando, sendo alterada), assume que SIM, que é o lado seguro.
    pub fn in_call_hint(&self) -> bool {
        match self.session.try_lock() {
            Ok(guard) => guard.is_some(),
            Err(_) => true,
        }
    }

    // ----- áudio local -----

    /// Abre o microfone em segundo plano ANTES de a sala conectar. Não bloqueia: o resultado (ou o erro) é entregue
    /// pelo `set_microphone(true)` seguinte, que usa a captura pronta. Um preparo anterior é descartado.
    pub fn prepare_microphone(&self) {
        self.discard_prepared_microphone();
        let device = self.prefs().input;
        let probe = self.apm.probe();
        let synthetic = self.synthetic();
        // Sem runtime do Tokio no contexto (chamado de uma thread qualquer) `tokio::spawn` entra em pânico e, no build
        // de produção, fecha o app: nesse caso só não pré-abre; `set_microphone` abre o dispositivo na hora.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log::warn!("voz: sem runtime do Tokio no preparo do microfone; abrindo só na hora");
            return;
        };
        let handle = runtime.spawn(async move {
            let started = Instant::now();
            let (tx, rx) = mpsc::channel::<Vec<i16>>(50);
            let capture = match synthetic {
                Some(syn) => MicInput::Synthetic(synth::start_tone(syn.tone_hz, tx)),
                None => MicInput::Device(
                    tokio::task::spawn_blocking(move || audio::start_mic(device, tx, Some(probe)))
                        .await
                        .map_err(|e| VoiceError::other(e.to_string()))??,
                ),
            };
            log::info!(
                "voz: microfone preparado em {} ms",
                started.elapsed().as_millis()
            );
            Ok::<PreparedMic, VoiceError>(PreparedMic { capture, rx })
        });
        *lock(&self.prepared) = Some(handle);
    }

    /// Descarta o microfone preparado e solta o dispositivo (a entrada falhou ou foi cancelada). Idempotente.
    pub fn discard_prepared_microphone(&self) {
        let old = lock(&self.prepared).take();
        if let Some(h) = old {
            h.abort();
        }
    }

    async fn take_prepared(&self) -> Option<Result<PreparedMic, VoiceError>> {
        let handle = { lock(&self.prepared).take() };
        let handle = handle?;
        Some(match handle.await {
            Ok(r) => r,
            Err(e) => Err(VoiceError::other(e.to_string())),
        })
    }

    pub async fn set_microphone(&self, enabled: bool) -> Result<(), VoiceError> {
        let mut guard = self.session.lock().await;
        let s = guard.as_mut().ok_or_else(VoiceError::no_room)?;
        if !enabled {
            if let Some(mic) = s.mic.as_mut() {
                if let Some(p) = mic.pump.take() {
                    p.abort();
                }
                mic.capture = None; // solta o microfone (a luz do sistema apaga)
                mic.track.mute();
            }
            s.emit_local_media();
            let _ = self.refresh_preview(false).await;
            return Ok(());
        }
        self.start_mic_locked(s).await?;
        s.emit_local_media();
        Ok(())
    }

    /// Descarta a faixa do microfone (para a captura e despublica). Usado quando o servidor muta a pessoa: o
    /// LiveKit derruba a faixa ao revogar a permissão, mas o `MicState` continuava guardado e, ao liberar, o
    /// "desmutar" só reativava uma faixa que não existia mais (sem áudio até sair e voltar). Sem faixa guardada, a
    /// próxima ligada publica uma nova.
    pub async fn reset_microphone(&self) -> Result<(), VoiceError> {
        let mut guard = self.session.lock().await;
        let s = guard.as_mut().ok_or_else(VoiceError::no_room)?;
        if let Some(mut mic) = s.mic.take() {
            if let Some(p) = mic.pump.take() {
                p.abort();
            }
            mic.capture = None; // solta o microfone
            let sid = mic.track.sid();
            let _ = s.room.local_participant().unpublish_track(&sid).await; // já pode ter sido derrubada
        }
        s.emit_local_media();
        let _ = self.refresh_preview(false).await;
        Ok(())
    }

    async fn start_mic_locked(&self, s: &mut Session) -> Result<(), VoiceError> {
        if s.mic.as_ref().is_some_and(|m| m.capture.is_some()) {
            return Ok(());
        }
        // A captura da chamada passa a alimentar o medidor: a prévia e o teste de microfone cedem o dispositivo.
        self.abort_mic_test();
        self.stop_preview();
        let mic_started = Instant::now();
        let (capture, mut rx) = match self.take_prepared().await {
            // Já aberto em paralelo com a conexão: descarta o que se acumulou até aqui (seria áudio velho).
            Some(Ok(mut p)) => {
                while p.rx.try_recv().is_ok() {}
                (p.capture, p.rx)
            }
            Some(Err(e)) => return Err(e),
            None => {
                let device = self.prefs().input;
                let (tx, rx) = mpsc::channel::<Vec<i16>>(50);
                let probe = self.apm.probe();
                let capture = match self.synthetic() {
                    Some(syn) => MicInput::Synthetic(synth::start_tone(syn.tone_hz, tx)),
                    // A abertura do dispositivo é bloqueante (CoreAudio pode mostrar o diálogo de permissão).
                    None => MicInput::Device(
                        tokio::task::spawn_blocking(move || {
                            audio::start_mic(device, tx, Some(probe))
                        })
                        .await
                        .map_err(|e| VoiceError::other(e.to_string()))??,
                    ),
                };
                (capture, rx)
            }
        };
        log::info!(
            "voz: abrir o microfone (esperar/abrir) levou {} ms",
            mic_started.elapsed().as_millis()
        );

        let publish_started = Instant::now();
        if s.mic.is_none() {
            let source = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, 1, 100);
            let track = LocalAudioTrack::create_audio_track(
                "microphone",
                RtcAudioSource::Native(source.clone()),
            );
            let opts = TrackPublishOptions {
                source: TrackSource::Microphone,
                dtx: true,
                ..Default::default()
            };
            s.room
                .local_participant()
                .publish_track(LocalTrack::Audio(track.clone()), opts)
                .await
                .map_err(|e| {
                    log::warn!("falha ao publicar o microfone: {e}");
                    VoiceError::media(MediaCode::Unknown, MediaDevice::Microphone)
                })?;
            log::info!(
                "voz: publicar o microfone levou {} ms",
                publish_started.elapsed().as_millis()
            );
            s.mic = Some(MicState {
                track,
                source,
                capture: None,
                pump: None,
            });
        }
        let mic = s.mic.as_mut().ok_or_else(VoiceError::no_room)?;
        let source = mic.source.clone();
        let apm = self.apm.clone();
        mic.pump = Some(tokio::spawn(async move {
            while let Some(mut pcm) = rx.recv().await {
                // AEC + supressão de ruído + ganho antes de ir ao LiveKit (o NativeAudioSource não passa pelo APM).
                apm.process_near(&mut pcm);
                let frame = AudioFrame {
                    data: Cow::Owned(pcm),
                    sample_rate: SAMPLE_RATE,
                    num_channels: 1,
                    samples_per_channel: FRAME_SAMPLES as u32,
                };
                if source.capture_frame(&frame).await.is_err() {
                    break;
                }
            }
        }));
        mic.capture = Some(capture);
        mic.track.unmute();
        Ok(())
    }

    /// Liga/desliga AEC, supressão de ruído e controle de ganho (vale já na chamada em curso).
    pub fn set_audio_processing(&self, settings: AudioProcessingSettings) {
        self.apm.configure(settings);
    }

    pub fn audio_processing(&self) -> AudioProcessingSettings {
        self.apm.settings()
    }

    // ----- volume por pessoa -----

    /// Volume local (1,0 = 100%, até 2,0) de uma pessoa e origem. Vale para as faixas de agora e as que ela
    /// publicar depois, enquanto estiver na sala.
    pub fn set_participant_volume(&self, identity: &str, source: AudioSource, volume: f32) {
        lock(&self.mixer).set_participant_gain(identity, source, volume);
    }

    // ----- medidor de nível, prévia e teste do microfone -----

    fn aux_emitter(&self) -> Arc<Mutex<Option<Emit>>> {
        self.aux_emit.clone()
    }

    /// Liga/desliga o medidor (evento `input-level`). Em chamada com o microfone aberto mede a captura real;
    /// fora dela (ou com o microfone mudo) abre uma captura de PRÉVIA com a mesma cadeia, sem publicar nada.
    pub async fn set_input_level_monitor(
        &self,
        enabled: bool,
        events: Option<Emit>,
        call_only: bool,
    ) -> Result<(), VoiceError> {
        if let Some(e) = events {
            *lock(&self.aux_emit) = Some(e);
        }
        if call_only {
            // Só mede a captura da chamada: sem prévia, então com o microfone mudo não abre dispositivo nenhum
            // (sem quadros novos o medidor não emite nada).
            self.call_meter.store(enabled, Ordering::SeqCst);
            self.update_meter();
            return Ok(());
        }
        self.monitor_on.store(enabled, Ordering::SeqCst);
        if !enabled {
            self.stop_preview();
            self.update_meter();
            return Ok(());
        }
        self.update_meter();
        let call_mic = self.call_mic_open().await;
        match self.refresh_preview(call_mic).await {
            Ok(()) => Ok(()),
            Err(e) => {
                self.monitor_on.store(false, Ordering::SeqCst);
                self.update_meter();
                Err(e)
            }
        }
    }

    async fn call_mic_open(&self) -> bool {
        self.session
            .lock()
            .await
            .as_ref()
            .and_then(|s| s.mic.as_ref())
            .is_some_and(|m| m.capture.is_some())
    }

    fn mic_test_running(&self) -> bool {
        lock(&self.mic_test).is_some()
    }

    fn stop_preview(&self) {
        // Soltar o `Preview` aborta a bomba e solta o dispositivo (a luz do SO apaga).
        let old = lock(&self.preview).take();
        drop(old);
    }

    /// Garante que a prévia só exista quando o medidor está ligado e ninguém mais usa o microfone.
    /// `call_mic`: a captura da chamada está aberta (ela mesma alimenta o medidor).
    async fn refresh_preview(&self, call_mic: bool) -> Result<(), VoiceError> {
        if !self.monitor_on.load(Ordering::SeqCst) || call_mic || self.mic_test_running() {
            self.stop_preview();
            return Ok(());
        }
        if lock(&self.preview).is_some() {
            return Ok(());
        }
        let device = self.prefs().input;
        let (tx, mut rx) = mpsc::channel::<Vec<i16>>(50);
        let probe = self.apm.probe();
        let capture = match self.synthetic() {
            Some(syn) => MicInput::Synthetic(synth::start_tone(syn.tone_hz, tx)),
            None => MicInput::Device(
                tokio::task::spawn_blocking(move || audio::start_mic(device, tx, Some(probe)))
                    .await
                    .map_err(|e| VoiceError::other(e.to_string()))??,
            ),
        };
        let apm = self.apm.clone();
        let pump = tokio::spawn(async move {
            while let Some(mut pcm) = rx.recv().await {
                apm.process_near(&mut pcm);
            }
        });
        *lock(&self.preview) = Some(Preview {
            _capture: capture,
            pump,
        });
        // Outra chamada concorrente pode ter desligado o medidor enquanto o dispositivo abria.
        if !self.monitor_on.load(Ordering::SeqCst) {
            self.stop_preview();
        }
        Ok(())
    }

    /// Mantém a tarefa do medidor viva só enquanto há medidor ligado ou teste de microfone em curso.
    fn update_meter(&self) {
        let wanted = self.monitor_on.load(Ordering::SeqCst)
            || self.call_meter.load(Ordering::SeqCst)
            || self.mic_test_running();
        let mut slot = lock(&self.meter);
        if !wanted {
            if let Some(h) = slot.take() {
                h.abort();
            }
            return;
        }
        if slot.is_some() {
            return;
        }
        let apm = self.apm.clone();
        let emit = self.aux_emitter();
        *slot = Some(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(METER_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut seen = apm.level().1;
            loop {
                ticker.tick().await;
                let (level, frames) = apm.level();
                // Sem quadros novos = nenhuma captura ativa: nada de valores velhos.
                if frames == seen {
                    continue;
                }
                seen = frames;
                let emit = lock(&emit).clone();
                if let Some(emit) = emit {
                    emit(VoiceEvent::InputLevel {
                        db: level.db,
                        gate_open: level.gate_open,
                    });
                }
            }
        }));
    }

    fn emit_aux(&self, event: VoiceEvent) {
        let emit = lock(&self.aux_emit).clone();
        if let Some(emit) = emit {
            emit(event);
        }
    }

    /// Teste de microfone: grava ~5 s do microfone já processado e toca no alto-falante escolhido (nunca ao vivo).
    /// Recusa com o microfone aberto na chamada (a gravação tocaria no alto-falante com a chamada ouvindo o mesmo
    /// áudio e geraria realimentação). O andamento sai pelo evento `mic-test`.
    pub async fn start_mic_test(self: &Arc<Self>, events: Option<Emit>) -> Result<(), VoiceError> {
        if let Some(e) = events {
            *lock(&self.aux_emit) = Some(e);
        }
        if self.mic_test_running() {
            return Ok(());
        }
        if self.call_mic_open().await {
            return Err(VoiceError::media(MediaCode::InUse, MediaDevice::Microphone));
        }
        // O teste usa o dispositivo: a prévia cede.
        self.stop_preview();
        {
            let mut slot = lock(&self.mic_test);
            if slot.is_some() {
                return Ok(());
            }
            let core = self.clone();
            *slot = Some(tokio::spawn(async move {
                core.run_mic_test().await;
                // Fim natural: libera o espaço (soltar o handle só o desanexa, a tarefa já acabou).
                drop(lock(&core.mic_test).take());
                core.update_meter();
                let call_mic = core.call_mic_open().await;
                let _ = core.refresh_preview(call_mic).await;
            }));
        }
        self.update_meter();
        Ok(())
    }

    /// Aborta o teste em curso (se houver) e emite `done`, como o web. Devolve se havia um teste.
    fn abort_mic_test(&self) -> bool {
        let handle = lock(&self.mic_test).take();
        let Some(h) = handle else { return false };
        h.abort(); // solta o microfone e o alto-falante (as capturas morrem com a tarefa)
        self.emit_aux(VoiceEvent::MicTest {
            phase: "done",
            remaining_ms: None,
            error: None,
        });
        self.update_meter();
        true
    }

    /// Interrompe o teste de microfone (idempotente) e devolve a prévia, se o medidor estiver ligado.
    pub async fn cancel_mic_test(&self) {
        if self.abort_mic_test() {
            let call_mic = self.call_mic_open().await;
            let _ = self.refresh_preview(call_mic).await;
        }
    }

    async fn run_mic_test(self: &Arc<Self>) {
        let phase =
            |phase: &'static str, remaining_ms: Option<u32>, error: Option<&'static str>| {
                self.emit_aux(VoiceEvent::MicTest {
                    phase,
                    remaining_ms,
                    error,
                });
            };
        phase("requesting", None, None);

        // ---- gravando ----
        let device = self.prefs().input;
        let (tx, mut rx) = mpsc::channel::<Vec<i16>>(50);
        let probe = self.apm.probe();
        let capture = match self.synthetic() {
            Some(syn) => Ok(MicInput::Synthetic(synth::start_tone(syn.tone_hz, tx))),
            None => {
                match tokio::task::spawn_blocking(move || audio::start_mic(device, tx, Some(probe)))
                    .await
                {
                    Ok(Ok(c)) => Ok(MicInput::Device(c)),
                    Ok(Err(e)) => Err(e),
                    Err(e) => Err(VoiceError::other(e.to_string())),
                }
            }
        };
        let capture = match capture {
            Ok(c) => c,
            Err(e) => {
                phase("error", None, Some(error_code(&e)));
                return;
            }
        };
        let mut rec = Recorder::new(RECORD_MS);
        phase("recording", Some(rec.remaining_ms()), None);
        let mut last = Instant::now();
        loop {
            // Sem quadros por 3 s = o dispositivo travou: avisa em vez de ficar "gravando" para sempre.
            let mut pcm = match tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
                Ok(Some(p)) => p,
                _ => {
                    phase("error", None, Some("unknown"));
                    return;
                }
            };
            self.apm.process_near(&mut pcm);
            let full = rec.push(&pcm);
            if full {
                break;
            }
            if last.elapsed() >= TEST_TICK {
                last = Instant::now();
                phase("recording", Some(rec.remaining_ms()), None);
            }
        }
        drop(capture); // fecha o microfone ANTES de tocar: nunca ao vivo
        let samples = rec.into_samples();

        // ---- reproduzindo no alto-falante escolhido ----
        let mixer = Arc::new(Mutex::new(Mixer::new()));
        let output = self.prefs().output;
        let playback = match audio::start_playback(output, mixer.clone(), None) {
            Ok(p) => p,
            Err(e) => {
                phase("error", None, Some(error_code(&e)));
                return;
            }
        };
        let mut feeder = Feeder::new(samples);
        let total = feeder.total_ms();
        phase("playing", Some(total), None);
        let started = Instant::now();
        let mut ticker = tokio::time::interval(Duration::from_millis(10));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last = Instant::now();
        loop {
            ticker.tick().await;
            let elapsed = started.elapsed().as_millis() as u64;
            let chunk = feeder.due(elapsed + TEST_LEAD_MS);
            if !chunk.is_empty() {
                lock(&mixer).push("mic-test", chunk);
            }
            if last.elapsed() >= TEST_TICK {
                last = Instant::now();
                phase("playing", Some(feeder.remaining_ms(elapsed)), None);
            }
            // Deixa o que sobrou na fila (até 200 ms) terminar de sair antes de fechar.
            if feeder.all_sent() && elapsed >= u64::from(total) + 250 {
                break;
            }
        }
        drop(playback);
        phase("done", None, None);
    }

    /// Ensurdecer: para de tocar o áudio remoto (o microfone é decisão do controlador da UI).
    pub fn set_deafened(&self, deafened: bool) {
        self.deafened.store(deafened, Ordering::SeqCst);
        lock(&self.mixer).set_deafened(deafened);
    }

    // ----- dispositivos -----

    pub fn list_devices(&self, kind: DeviceKind) -> Vec<audio::DeviceInfo> {
        match kind {
            DeviceKind::AudioInput => audio::list_devices(Direction::Input),
            DeviceKind::AudioOutput => audio::list_devices(Direction::Output),
            DeviceKind::VideoInput => camera::list()
                .into_iter()
                .map(|c| audio::DeviceInfo {
                    id: c.id,
                    label: c.label,
                })
                .collect(),
        }
    }

    /// Guarda a escolha e, se já estiver em uso, reabre o dispositivo.
    pub async fn set_device(&self, kind: DeviceKind, id: &str) -> Result<(), VoiceError> {
        let value = (!id.is_empty()).then(|| id.to_string());
        {
            let mut p = lock(&self.prefs);
            match kind {
                DeviceKind::AudioInput => p.input = value.clone(),
                DeviceKind::AudioOutput => p.output = value.clone(),
                DeviceKind::VideoInput => p.camera = value.clone(),
            }
        }
        let mut guard = self.session.lock().await;
        if kind == DeviceKind::AudioInput && lock(&self.preview).is_some() {
            // O medidor usa o microfone novo: reabre a prévia.
            self.stop_preview();
            let call_mic = guard
                .as_ref()
                .and_then(|s| s.mic.as_ref())
                .is_some_and(|m| m.capture.is_some());
            self.refresh_preview(call_mic).await?;
        }
        let Some(s) = guard.as_mut() else {
            return Ok(());
        };
        match kind {
            DeviceKind::AudioOutput => {
                s.playback = None;
                s.playback = Some(audio::start_playback(
                    value,
                    self.mixer.clone(),
                    Some(self.apm.clone()),
                )?);
            }
            DeviceKind::AudioInput => {
                if s.mic.as_ref().is_some_and(|m| m.capture.is_some()) {
                    if let Some(m) = s.mic.as_mut() {
                        if let Some(p) = m.pump.take() {
                            p.abort();
                        }
                        m.capture = None;
                    }
                    self.start_mic_locked(s).await?;
                }
            }
            DeviceKind::VideoInput => {
                if s.camera.is_some() {
                    self.stop_camera_locked(s).await;
                    self.start_camera_locked(s, value).await?;
                    s.emit_local_media();
                }
            }
        }
        Ok(())
    }

    // ----- câmera e tela -----

    pub async fn set_camera(
        &self,
        enabled: bool,
        device_id: Option<String>,
    ) -> Result<(), VoiceError> {
        let mut guard = self.session.lock().await;
        let s = guard.as_mut().ok_or_else(VoiceError::no_room)?;
        if enabled {
            if s.camera.is_none() {
                let device = device_id.filter(|d| !d.is_empty()).or(self.prefs().camera);
                self.start_camera_locked(s, device).await?;
            }
        } else {
            self.stop_camera_locked(s).await;
        }
        s.emit_local_media();
        Ok(())
    }

    async fn start_camera_locked(
        &self,
        s: &mut Session,
        device: Option<String>,
    ) -> Result<(), VoiceError> {
        let fps = limits::CAMERA_FPS;
        let max = limits::CAMERA_MAX;
        let source = NativeVideoSource::new(
            VideoResolution {
                width: max.0,
                height: max.1,
            },
            false,
        );
        let out = VideoOut::new(
            source.clone(),
            self.router.clone(),
            LOCAL_CAMERA_ID.into(),
            fps,
            max,
        );
        // Abre o dispositivo antes de publicar: erro de permissão não deixa uma faixa fantasma na sala.
        let capture: VideoInput = match self.synthetic() {
            Some(syn) => Box::new(synth::start_video(out, syn).map_err(VoiceError::other)?),
            None => Box::new(camera::start(device, fps, max, out).await?),
        };
        let track = LocalVideoTrack::create_video_track("camera", RtcVideoSource::Native(source));
        let opts = TrackPublishOptions {
            source: TrackSource::Camera,
            simulcast: true,
            video_encoding: Some(VideoEncoding {
                max_bitrate: 1_700_000,
                max_framerate: fps as f64,
            }),
            ..Default::default()
        };
        let publication = s
            .room
            .local_participant()
            .publish_track(LocalTrack::Video(track), opts)
            .await
            .map_err(|e| {
                log::warn!("falha ao publicar a câmera: {e}");
                VoiceError::media(MediaCode::Unknown, MediaDevice::Camera)
            })?;
        s.camera = Some(CameraState {
            sid: publication.sid(),
            _capture: capture,
        });
        (s.shared.emit)(VoiceEvent::VideoTrackAdded {
            id: LOCAL_CAMERA_ID.into(),
            identity: s.room.local_participant().identity().to_string(),
            kind: "camera",
            local: true,
        });
        Ok(())
    }

    async fn stop_camera_locked(&self, s: &mut Session) {
        if let Some(cam) = s.camera.take() {
            let sid = cam.sid.clone();
            drop(cam); // para a captura
            let _ = s.room.local_participant().unpublish_track(&sid).await;
            self.router.unsubscribe(LOCAL_CAMERA_ID);
            (s.shared.emit)(VoiceEvent::VideoTrackRemoved {
                id: LOCAL_CAMERA_ID.into(),
            });
        }
    }

    pub fn list_screen_sources(&self) -> Vec<screen::ScreenSource> {
        screen::list_sources()
    }

    pub async fn set_screen_share(
        &self,
        enabled: bool,
        opts: ScreenOptions,
    ) -> Result<(), VoiceError> {
        let mut guard = self.session.lock().await;
        let s = guard.as_mut().ok_or_else(VoiceError::no_room)?;
        if !enabled {
            self.stop_screen_locked(s).await;
            s.emit_local_media();
            return Ok(());
        }
        if s.screen.is_some() {
            return Ok(());
        }
        // Sem `quality` vale o que sempre foi: 1080p, 15 fps, nitidez, 2,5 Mbps.
        let quality = opts.quality.unwrap_or_default().normalized();
        let fps = quality.fps;
        let max = quality.max_size();
        let source = NativeVideoSource::new(
            VideoResolution {
                width: max.0,
                height: max.1,
            },
            true,
        );
        let out = VideoOut::with_fps_cap(
            source.clone(),
            self.router.clone(),
            LOCAL_SCREEN_ID.into(),
            fps,
            max,
            limits::MAX_SHARE_FPS,
        )
        .repeat_when_idle();
        let capture: VideoInput = match self.synthetic() {
            Some(syn) => Box::new(synth::start_video(out, syn).map_err(VoiceError::other)?),
            None => {
                // Captura preta persistente (permissão de gravação ausente, janela protegida): avisa a interface.
                let emit = s.shared.emit.clone();
                let on_black: screen::BlackCallback = Arc::new(move |black| {
                    emit(VoiceEvent::ScreenBlack { black });
                });
                Box::new(screen::start(&opts.source_id, fps, out, on_black).await?)
            }
        };
        let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source));
        let stats_track = track.clone();
        let publish = TrackPublishOptions {
            source: TrackSource::Screenshare,
            simulcast: false,
            video_encoding: Some(VideoEncoding {
                max_bitrate: quality.max_bitrate_bps(),
                max_framerate: fps as f64,
            }),
            // Nitidez = manter a resolução (descarta quadros se faltar banda); fluidez = manter os quadros.
            degradation_preference: Some(if quality.keeps_resolution() {
                DegradationPreference::MaintainResolution
            } else {
                DegradationPreference::MaintainFramerate
            }),
            ..Default::default()
        };
        let publication = s
            .room
            .local_participant()
            .publish_track(LocalTrack::Video(track), publish)
            .await
            .map_err(|e| {
                log::warn!("falha ao publicar a tela: {e}");
                VoiceError::media(MediaCode::Unknown, MediaDevice::Screen)
            })?;
        // O áudio vem depois do vídeo e NUNCA derruba a transmissão: qualquer falha vira log e só a imagem vai.
        let audio = self.start_screen_audio(s.room.clone(), &opts).await;
        s.screen = Some(ScreenState {
            sid: publication.sid(),
            _capture: capture,
            stats_task: spawn_screen_stats(stats_track, quality),
            audio,
        });
        (s.shared.emit)(VoiceEvent::VideoTrackAdded {
            id: LOCAL_SCREEN_ID.into(),
            identity: s.room.local_participant().identity().to_string(),
            kind: "screen",
            local: true,
        });
        s.emit_local_media();
        Ok(())
    }

    /// Captura e publica o áudio da tela conforme o plano (`appaudio::decide`). `None` = sem áudio (não pedido,
    /// plataforma sem suporte, nenhum aplicativo marcado ou falha, sempre registrada no log).
    // Recebe só a sala (clonada): `&Session` não é `Sync` e segurá-la entre awaits tornava o comando não-`Send`.
    async fn start_screen_audio(
        &self,
        room: Arc<Room>,
        opts: &ScreenOptions,
    ) -> Option<ScreenAudio> {
        let plan = appaudio::decide(
            opts.audio,
            opts.audio_apps.as_ref(),
            screen_audio::os_support(),
        );
        if let CapturePlan::Off(reason) = &plan {
            if opts.audio {
                log::info!("áudio da tela não iniciado ({reason:?}); compartilhando só o vídeo");
            }
            return None;
        }
        if self.synthetic().is_some() {
            return None;
        }
        let (tx, mut rx) = mpsc::channel::<Vec<i16>>(50);
        let capture = match screen_audio::start(plan, tx) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("não foi possível capturar o áudio da tela: {e}");
                return None;
            }
        };
        let source = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, 2, 100);
        let track = LocalAudioTrack::create_audio_track(
            "screen_audio",
            RtcAudioSource::Native(source.clone()),
        );
        let publish = TrackPublishOptions {
            source: TrackSource::ScreenshareAudio,
            ..Default::default()
        };
        let publication = match room
            .local_participant()
            .publish_track(LocalTrack::Audio(track), publish)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                log::warn!("falha ao publicar o áudio da tela: {e}");
                return None;
            }
        };
        let pump = tokio::spawn(async move {
            while let Some(pcm) = rx.recv().await {
                let frame = AudioFrame {
                    data: Cow::Owned(pcm),
                    sample_rate: SAMPLE_RATE,
                    num_channels: 2,
                    samples_per_channel: appaudio::BLOCK_FRAMES as u32,
                };
                if source.capture_frame(&frame).await.is_err() {
                    break;
                }
            }
        });
        Some(ScreenAudio {
            sid: publication.sid(),
            _capture: capture,
            pump,
        })
    }

    async fn stop_screen_locked(&self, s: &mut Session) {
        if let Some(mut scr) = s.screen.take() {
            let sid = scr.sid.clone();
            let audio_sid = scr.audio.take().map(|a| a.sid.clone());
            drop(scr);
            if let Some(audio_sid) = audio_sid {
                let _ = s.room.local_participant().unpublish_track(&audio_sid).await;
            }
            let _ = s.room.local_participant().unpublish_track(&sid).await;
            self.router.unsubscribe(LOCAL_SCREEN_ID);
            (s.shared.emit)(VoiceEvent::VideoTrackRemoved {
                id: LOCAL_SCREEN_ID.into(),
            });
        }
    }

    // ----- assistir telas sob demanda -----

    /// Começa (`true`) ou para (`false`) de assistir a tela de `identity`: assina/cancela o vídeo e o áudio da
    /// tela dessa pessoa no servidor. Parar libera tudo: `set_subscribed(false)` solta a faixa, o evento
    /// `TrackUnsubscribed` aborta a tarefa de decodificação/JPEG, remove a inscrição do roteador e avisa o webview
    /// (`video-track-removed`). Idempotente. Se a pessoa não está (ou ainda não publicou), o desejo fica guardado e
    /// vale quando ela entrar/publicar. Não espera o `session`.
    pub fn set_screen_watching(&self, identity: &str, watching: bool) -> Result<(), VoiceError> {
        let (room, shared) = {
            let live = lock(&self.live);
            let l = live.as_ref().ok_or_else(VoiceError::no_room)?;
            (l.room.clone(), l.shared.clone())
        };
        shared.watching.set(identity, watching);
        // Sempre reconcilia (mesmo sem mudança no conjunto): serve ao "Tentar de novo" e a faixas atrasadas.
        for (id, participant) in room.remote_participants() {
            if id.to_string() == identity {
                sync_participant(&shared, &participant);
            }
        }
        Ok(())
    }

    // ----- vídeo para o webview -----

    /// O webview vai desenhar a faixa: começa a converter e enviar quadros. Idempotente (reinscrever
    /// troca o canal).
    pub async fn subscribe_video(
        &self,
        track_id: &str,
        sink: Box<dyn FrameSink>,
        view: ViewOptions,
    ) -> Result<(), VoiceError> {
        let guard = self.session.lock().await;
        let s = guard.as_ref().ok_or_else(VoiceError::no_room)?;
        let local = track_id.starts_with("local:");
        let (participant_id, source) = if local {
            let kind = if track_id == LOCAL_SCREEN_ID {
                "screen"
            } else {
                "camera"
            };
            (s.room.local_participant().identity().to_string(), kind)
        } else {
            let map = lock(&s.shared.remote_video);
            let v = map
                .get(track_id)
                .ok_or_else(|| VoiceError::other("Faixa de vídeo não encontrada."))?;
            (v.identity.clone(), v.kind)
        };
        let plan = limits::view_plan(
            local,
            source == "screen",
            view.max_width,
            view.max_height,
            view.fps,
        );
        self.router.subscribe(
            track_id,
            sink,
            ViewParams {
                participant_id,
                source,
                max: plan.max,
                fps: plan.fps,
                quality: plan.quality,
            },
        );
        if !local {
            let mut map = lock(&s.shared.remote_video);
            if let Some(v) = map.get_mut(track_id) {
                if let Some(old) = v.task.take() {
                    old.abort();
                }
                v.task = Some(spawn_remote_video(
                    self.router.clone(),
                    track_id.to_string(),
                    v.track.clone(),
                ));
            }
        }
        Ok(())
    }

    /// Ninguém está desenhando a faixa: para de converter/enviar.
    pub async fn unsubscribe_video(&self, track_id: &str) {
        self.router.unsubscribe(track_id);
        let guard = self.session.lock().await;
        if let Some(s) = guard.as_ref() {
            if let Some(v) = lock(&s.shared.remote_video).get_mut(track_id) {
                if let Some(t) = v.task.take() {
                    t.abort();
                }
            }
        }
    }

    pub fn ack_video(&self, track_id: &str) {
        self.router.ack(track_id);
    }

    pub fn router(&self) -> Arc<VideoRouter> {
        self.router.clone()
    }
}

/// Lê quadros de uma faixa remota e manda JPEGs ao webview, respeitando fps e créditos.
fn spawn_remote_video(
    router: Arc<VideoRouter>,
    id: String,
    track: RemoteVideoTrack,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // Fila padrão de 1 quadro: o libwebrtc descarta o antigo, então nunca acumulamos atraso.
        let mut stream = NativeVideoStream::new(track.rtc_track());
        while let Some(frame) = stream.next().await {
            if !router.is_subscribed(&id) {
                break;
            }
            let Some(res) = router.reserve(&id, Instant::now()) else {
                continue;
            };
            let buffer = frame.buffer;
            let encoded = tokio::task::spawn_blocking(move || {
                encode_jpeg(buffer.as_ref(), res.max, res.quality)
            })
            .await;
            match encoded {
                Ok(Ok((jpeg, w, h))) => router.deliver(&id, &jpeg, w, h),
                Ok(Err(e)) => {
                    log::debug!("quadro remoto descartado: {e}");
                    router.cancel(&id);
                }
                Err(_) => router.cancel(&id),
            }
        }
    })
}

/// Consome o áudio de um participante e empurra no mixer.
fn spawn_remote_audio(
    mixer: Arc<Mutex<Mixer>>,
    sid: String,
    identity: String,
    source: AudioSource,
    track: RemoteAudioTrack,
) -> JoinHandle<()> {
    // Liga a fila à pessoa e à origem: o volume dela (voz ou áudio da tela) passa a valer nesta faixa.
    lock(&mixer).bind(&sid, &identity, source);
    tokio::spawn(async move {
        let mut stream = NativeAudioStream::with_options(
            track.rtc_track(),
            SAMPLE_RATE as i32,
            1,
            NativeAudioStreamOptions {
                queue_size_frames: Some(50),
            },
        );
        while let Some(frame) = stream.next().await {
            lock(&mixer).push(&sid, &frame.data);
        }
        lock(&mixer).remove(&sid);
    })
}

async fn run_events(
    core: Arc<VoiceCore>,
    session_id: u64,
    room: Arc<Room>,
    shared: Arc<Shared>,
    mut rx: mpsc::UnboundedReceiver<RoomEvent>,
) {
    let emit = shared.emit.clone();
    let local_identity = room.local_participant().identity().to_string();
    while let Some(ev) = rx.recv().await {
        if shared.closing.load(Ordering::SeqCst) {
            break;
        }
        match ev {
            RoomEvent::ParticipantConnected(p) => {
                let id = p.identity().to_string();
                sync_participant(&shared, &p);
                if lock(&shared.known).insert(id.clone()) {
                    emit(VoiceEvent::ParticipantJoined { identity: id });
                }
            }
            RoomEvent::ParticipantDisconnected(p) => {
                let id = p.identity().to_string();
                lock(&shared.known).remove(&id);
                lock(&shared.mixer).forget_participant(&id);
                emit(VoiceEvent::ParticipantLeft { identity: id });
            }
            RoomEvent::ActiveSpeakersChanged { speakers } => {
                emit(VoiceEvent::SpeakersChanged {
                    identities: speakers.iter().map(|s| s.identity().to_string()).collect(),
                });
            }
            RoomEvent::TrackPublished {
                publication,
                participant,
            } => {
                // Publicação nova (inclusive as iniciais de quem já estava): voz e câmera são assinadas aqui;
                // a tela só se a pessoa estiver na lista de "assistindo".
                sync_publication(&shared, participant.identity().as_str(), &publication);
            }
            RoomEvent::TrackSubscriptionFailed {
                participant,
                error,
                track_sid,
            } => {
                log::warn!(
                    "voz: falha ao assinar a faixa {track_sid:?} de {}: {error}",
                    participant.identity()
                );
            }
            RoomEvent::TrackSubscribed {
                track,
                publication,
                participant,
            } => {
                // Faixa de tela que chegou sem ninguém assistindo (assistir e parar antes de ela chegar): descarta.
                if !shared.watching.wants(
                    sub_kind(publication.source()),
                    participant.identity().as_str(),
                ) {
                    publication.set_subscribed(false);
                    continue;
                }
                let sid = publication.sid().to_string();
                match track {
                    RemoteTrack::Audio(t) => {
                        // O áudio da tela vem como `ScreenshareAudio`; o resto é voz.
                        let source = match publication.source() {
                            TrackSource::ScreenshareAudio => AudioSource::Screen,
                            _ => AudioSource::Voice,
                        };
                        let task = spawn_remote_audio(
                            shared.mixer.clone(),
                            sid.clone(),
                            participant.identity().to_string(),
                            source,
                            t,
                        );
                        if let Some(old) = lock(&shared.remote_audio).insert(sid, task) {
                            old.abort();
                        }
                    }
                    RemoteTrack::Video(t) => {
                        let kind = match publication.source() {
                            TrackSource::Screenshare => "screen",
                            TrackSource::Camera => "camera",
                            _ => continue,
                        };
                        let identity = participant.identity().to_string();
                        lock(&shared.remote_video).insert(
                            sid.clone(),
                            RemoteVideo {
                                track: t,
                                identity: identity.clone(),
                                kind,
                                task: None,
                            },
                        );
                        emit(VoiceEvent::VideoTrackAdded {
                            id: sid,
                            identity,
                            kind,
                            local: false,
                        });
                    }
                }
            }
            RoomEvent::TrackUnsubscribed {
                track, publication, ..
            } => {
                let sid = publication.sid().to_string();
                match track {
                    RemoteTrack::Audio(_) => {
                        if let Some(t) = lock(&shared.remote_audio).remove(&sid) {
                            t.abort();
                        }
                        lock(&shared.mixer).remove(&sid);
                    }
                    RemoteTrack::Video(_) => {
                        shared.router.unsubscribe(&sid);
                        if let Some(v) = lock(&shared.remote_video).remove(&sid) {
                            if let Some(t) = v.task {
                                t.abort();
                            }
                            emit(VoiceEvent::VideoTrackRemoved { id: sid });
                        }
                    }
                }
            }
            RoomEvent::ConnectionQualityChanged {
                quality,
                participant,
            } => {
                if participant.identity().as_str() == local_identity {
                    emit(VoiceEvent::LinkQuality {
                        quality: map_quality(quality),
                    });
                }
            }
            RoomEvent::Reconnecting => emit(VoiceEvent::ConnectionState {
                state: "reconnecting",
            }),
            RoomEvent::Reconnected => emit(VoiceEvent::ConnectionState { state: "connected" }),
            RoomEvent::Disconnected { reason } => {
                core.on_room_disconnected(session_id, map_disconnect_reason(reason))
                    .await;
                break;
            }
            _ => {}
        }
    }
}
