//! Núcleo da voz nativa: uma sala do LiveKit por vez, microfone/reprodução (cpal), tela (scap), câmera
//! (nokhwa) e o vídeo remoto convertido em JPEG. Não depende do Tauri (só de `VideoRouter`/eventos), então
//! o teste de integração o usa direto contra o LiveKit de desenvolvimento.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::StreamExt;
use libwebrtc::audio_source::native::NativeAudioSource;
use libwebrtc::audio_stream::native::{NativeAudioStream, NativeAudioStreamOptions};
use libwebrtc::prelude::{
    AudioFrame, AudioSourceOptions, RtcAudioSource, RtcVideoSource, VideoResolution,
};
use libwebrtc::video_source::native::NativeVideoSource;
use libwebrtc::video_stream::native::NativeVideoStream;
use livekit::options::{TrackPublishOptions, VideoEncoding};
use livekit::prelude::*;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::apm::{ApmBridge, AudioProcessingSettings};
use super::audio::{self, Direction, MicCapture, Playback, FRAME_SAMPLES, SAMPLE_RATE};
use super::camera;
use super::capture::VideoOut;
use super::error::{classify_connect_message, connect_message, MediaCode, MediaDevice, VoiceError};
use super::events::{map_disconnect_reason, map_quality, VoiceEvent};
use super::frames::encode_jpeg;
use super::limits::{self, clamp_fps};
use super::mixer::Mixer;
use super::router::{FrameSink, VideoRouter, ViewParams};
use super::screen;
use super::synth::{self, SyntheticInputs, ToneTask};

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
    /// Áudio do sistema: sem suporte nesta versão (aceito e ignorado).
    pub audio: bool,
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
    router: Arc<VideoRouter>,
    mixer: Arc<Mutex<Mixer>>,
    prefs: Mutex<DevicePrefs>,
    deafened: AtomicBool,
    next_id: AtomicU64,
    synthetic: Mutex<Option<SyntheticInputs>>,
    apm: Arc<ApmBridge>,
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
            router: Arc::new(VideoRouter::new()),
            mixer: Arc::new(Mutex::new(Mixer::new())),
            prefs: Mutex::new(DevicePrefs::default()),
            deafened: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            synthetic: Mutex::new(None),
            apm: Arc::new(ApmBridge::new(AudioProcessingSettings::default())),
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
        options.auto_subscribe = true;
        options.adaptive_stream = false;
        options.dynacast = true;
        let (room, rx) = Room::connect(url, token, options).await.map_err(|e| {
            // Nunca registre a URL com token nem o token.
            let raw = e.to_string();
            log::warn!("falha ao conectar na sala de voz: {raw}");
            let code = classify_connect_message(&raw);
            VoiceError::connect(code, connect_message(code))
        })?;
        let room = Arc::new(room);

        let shared = Arc::new(Shared {
            emit: emit.clone(),
            router: self.router.clone(),
            mixer: self.mixer.clone(),
            remote_audio: Mutex::new(HashMap::new()),
            remote_video: Mutex::new(HashMap::new()),
            known: Mutex::new(HashSet::new()),
            closing: AtomicBool::new(false),
        });
        lock(&self.mixer).clear();
        lock(&self.mixer).set_deafened(self.deafened.load(Ordering::SeqCst));

        // Quem já estava na sala.
        for (identity, _) in room.remote_participants() {
            let id = identity.to_string();
            if lock(&shared.known).insert(id.clone()) {
                emit(VoiceEvent::ParticipantJoined { identity: id });
            }
        }

        let playback = match audio::start_playback(
            self.prefs().output,
            self.mixer.clone(),
            Some(self.apm.clone()),
        ) {
            Ok(p) => Some(p),
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
    }

    pub async fn is_connected(&self) -> bool {
        self.session.lock().await.is_some()
    }

    // ----- áudio local -----

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
            return Ok(());
        }
        self.start_mic_locked(s).await?;
        s.emit_local_media();
        Ok(())
    }

    async fn start_mic_locked(&self, s: &mut Session) -> Result<(), VoiceError> {
        if s.mic.as_ref().is_some_and(|m| m.capture.is_some()) {
            return Ok(());
        }
        let device = self.prefs().input;
        let (tx, mut rx) = mpsc::channel::<Vec<i16>>(50);
        let probe = self.apm.probe();
        let capture = match self.synthetic() {
            Some(syn) => MicInput::Synthetic(synth::start_tone(syn.tone_hz, tx)),
            // A abertura do dispositivo é bloqueante (CoreAudio pode mostrar o diálogo de permissão).
            None => MicInput::Device(
                tokio::task::spawn_blocking(move || audio::start_mic(device, tx, Some(probe)))
                    .await
                    .map_err(|e| VoiceError::other(e.to_string()))??,
            ),
        };

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
        if opts.audio {
            log::info!("áudio do sistema não é suportado nesta versão; compartilhando só o vídeo");
        }
        let fps = limits::SHARE_FPS;
        let max = limits::SHARE_MAX;
        let source = NativeVideoSource::new(
            VideoResolution {
                width: max.0,
                height: max.1,
            },
            true,
        );
        let out = VideoOut::new(
            source.clone(),
            self.router.clone(),
            LOCAL_SCREEN_ID.into(),
            fps,
            max,
        );
        let capture: VideoInput = match self.synthetic() {
            Some(syn) => Box::new(synth::start_video(out, syn).map_err(VoiceError::other)?),
            None => Box::new(screen::start(&opts.source_id, fps, out).await?),
        };
        let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source));
        let publish = TrackPublishOptions {
            source: TrackSource::Screenshare,
            simulcast: false,
            video_encoding: Some(VideoEncoding {
                max_bitrate: 2_500_000,
                max_framerate: fps as f64,
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
        s.screen = Some(ScreenState {
            sid: publication.sid(),
            _capture: capture,
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

    async fn stop_screen_locked(&self, s: &mut Session) {
        if let Some(scr) = s.screen.take() {
            let sid = scr.sid.clone();
            drop(scr);
            let _ = s.room.local_participant().unpublish_track(&sid).await;
            self.router.unsubscribe(LOCAL_SCREEN_ID);
            (s.shared.emit)(VoiceEvent::VideoTrackRemoved {
                id: LOCAL_SCREEN_ID.into(),
            });
        }
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
        let default_max = if local { (640, 360) } else { limits::VIEW_MAX };
        let max = (
            view.max_width
                .unwrap_or(default_max.0)
                .clamp(160, limits::VIEW_MAX.0),
            view.max_height
                .unwrap_or(default_max.1)
                .clamp(90, limits::VIEW_MAX.1),
        );
        let fps = clamp_fps(
            view.fps
                .unwrap_or(if local { 10 } else { limits::VIEW_FPS }),
        );
        self.router.subscribe(
            track_id,
            sink,
            ViewParams {
                participant_id,
                source,
                max,
                fps,
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
                encode_jpeg(buffer.as_ref(), res.max, limits::JPEG_QUALITY)
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
    track: RemoteAudioTrack,
) -> JoinHandle<()> {
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
                if lock(&shared.known).insert(id.clone()) {
                    emit(VoiceEvent::ParticipantJoined { identity: id });
                }
            }
            RoomEvent::ParticipantDisconnected(p) => {
                let id = p.identity().to_string();
                lock(&shared.known).remove(&id);
                emit(VoiceEvent::ParticipantLeft { identity: id });
            }
            RoomEvent::ActiveSpeakersChanged { speakers } => {
                emit(VoiceEvent::SpeakersChanged {
                    identities: speakers.iter().map(|s| s.identity().to_string()).collect(),
                });
            }
            RoomEvent::TrackSubscribed {
                track,
                publication,
                participant,
            } => {
                let sid = publication.sid().to_string();
                match track {
                    RemoteTrack::Audio(t) => {
                        let task = spawn_remote_audio(shared.mixer.clone(), sid.clone(), t);
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
