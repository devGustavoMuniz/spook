//! Comandos Tauri da voz nativa. Camada fina: valida a entrada e delega ao `VoiceCore`.
//! Erros chegam ao webview como `VoiceError` serializado (`{kind, code, device?, message}`).

use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody, JavaScriptChannelId};
use tauri::State;

use super::apm::{AudioProcessingSettings, NoiseSuppressionLevel};
use super::appaudio::AudioAppsResponse;
use super::audio::DeviceInfo;
use super::core::{DeviceKind, Emit, ScreenOptions, ViewOptions, VoiceCore};
use super::error::{ConnectCode, VoiceError};
use super::events::VoiceEvent;
use super::gate::InputSensitivity;
use super::mixer::AudioSource;
use super::screen::{self, ScreenSource};
use super::screen_audio;
use super::thumbnail::ScreenThumbnail;

pub struct VoiceState(pub Arc<VoiceCore>);

impl VoiceState {
    pub fn new() -> Self {
        Self(Arc::new(VoiceCore::new()))
    }
}

impl Default for VoiceState {
    fn default() -> Self {
        Self::new()
    }
}

/// Valida a URL de sinalização e o token antes de falar com a rede. O token nunca vai para o log.
pub fn validate_connect(url: &str, token: &str) -> Result<(), VoiceError> {
    let ok_scheme = ["wss://", "ws://", "https://", "http://"]
        .iter()
        .any(|p| url.starts_with(p));
    if !ok_scheme || url.len() < 9 || url.contains(char::is_whitespace) {
        return Err(VoiceError::connect(
            ConnectCode::Unknown,
            "Endereço do servidor de voz inválido.",
        ));
    }
    // JWT: três partes separadas por ponto.
    if token.split('.').count() != 3 || token.contains(char::is_whitespace) {
        return Err(VoiceError::connect(
            ConnectCode::TokenRejected,
            "Credencial de voz inválida. Tente entrar de novo.",
        ));
    }
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CameraOptions {
    pub device_id: Option<String>,
}

fn parse_kind(kind: &str) -> Result<DeviceKind, VoiceError> {
    DeviceKind::parse(kind).ok_or_else(|| VoiceError::other("Tipo de dispositivo desconhecido."))
}

#[tauri::command]
pub async fn voice_connect(
    state: State<'_, VoiceState>,
    url: String,
    token: String,
    events: Channel<VoiceEvent>,
) -> Result<(), VoiceError> {
    validate_connect(&url, &token)?;
    state.0.connect(&url, &token, emitter(events)).await
}

#[tauri::command]
pub async fn voice_disconnect(state: State<'_, VoiceState>) -> Result<(), VoiceError> {
    state.0.disconnect().await;
    Ok(())
}

#[tauri::command]
pub async fn voice_set_microphone(
    state: State<'_, VoiceState>,
    enabled: bool,
) -> Result<(), VoiceError> {
    state.0.set_microphone(enabled).await
}

/// Descarta a faixa do microfone (mute pelo servidor): a próxima ligada publica uma faixa nova. Idempotente.
#[tauri::command]
pub async fn voice_reset_microphone(state: State<'_, VoiceState>) -> Result<(), VoiceError> {
    state.0.reset_microphone().await
}

/// Abre o microfone em paralelo com a conexão (não bloqueia; o `voice_set_microphone(true)` seguinte o usa).
/// `async` de propósito: comando síncrono roda FORA do runtime do Tokio e o `tokio::spawn` de dentro entrava em pânico
/// ("no reactor running"), o que fechava o app ao entrar numa chamada.
#[tauri::command]
pub async fn voice_prepare_microphone(state: State<'_, VoiceState>) -> Result<(), VoiceError> {
    state.0.prepare_microphone();
    Ok(())
}

/// Descarta o microfone preparado (entrada cancelada ou falha). Idempotente.
#[tauri::command]
pub fn voice_discard_prepared_microphone(state: State<'_, VoiceState>) {
    state.0.discard_prepared_microphone();
}

#[tauri::command]
pub fn voice_set_deafened(state: State<'_, VoiceState>, deafened: bool) {
    state.0.set_deafened(deafened);
}

#[tauri::command]
pub fn voice_set_audio_processing(
    state: State<'_, VoiceState>,
    echo_cancellation: bool,
    // Texto (`off|standard|strong`); o booleano das interfaces antigas também é aceito (true = standard).
    noise_suppression: NoiseSuppressionLevel,
    auto_gain_control: bool,
    // Porta de ruído (`{ mode: "off" | "auto" | "manual", thresholdDb }`); ausente = desligada (formato antigo).
    input_sensitivity: Option<InputSensitivity>,
) {
    state.0.set_audio_processing(AudioProcessingSettings {
        echo_cancellation,
        noise_suppression,
        auto_gain_control,
        input_sensitivity: input_sensitivity.unwrap_or_default(),
    });
}

/// Volume local de uma pessoa (1,0 = 100%, até 2,0 = 200%; 0 = silenciada só para mim). `source`: `voice` ou
/// `screen` (áudio da tela). Vale para as faixas de agora e as que a pessoa republicar enquanto estiver na sala.
#[tauri::command]
pub fn voice_set_participant_volume(
    state: State<'_, VoiceState>,
    identity: String,
    source: AudioSource,
    volume: f32,
) {
    state.0.set_participant_volume(&identity, source, volume);
}

/// Liga/desliga o medidor de nível (evento `input-level` no canal `events`). Fora de chamada abre uma prévia do
/// microfone (mesma cadeia, sem publicar).
#[tauri::command]
pub async fn voice_set_input_level_monitor(
    state: State<'_, VoiceState>,
    webview: tauri::Webview,
    enabled: bool,
    events: Option<JavaScriptChannelId>,
    // Só a captura da chamada (anel de "falando"): nunca abre a prévia do microfone.
    call_only: Option<bool>,
) -> Result<(), VoiceError> {
    // `Channel` só vira argumento obrigatório; opcional, recebemos o id e montamos o canal na janela que chamou.
    let emit = events.map(|id| emitter(id.channel_on(webview)));
    state
        .0
        .set_input_level_monitor(enabled, emit, call_only.unwrap_or(false))
        .await
}

/// Teste de microfone: grava ~5 s e toca no alto-falante escolhido. Recusa (`in-use`) com o microfone aberto na
/// chamada. O andamento sai pelo evento `mic-test` do canal `events`.
#[tauri::command]
pub async fn voice_start_mic_test(
    state: State<'_, VoiceState>,
    webview: tauri::Webview,
    events: Option<JavaScriptChannelId>,
) -> Result<(), VoiceError> {
    let emit = events.map(|id| emitter(id.channel_on(webview)));
    state.0.start_mic_test(emit).await
}

#[tauri::command]
pub async fn voice_cancel_mic_test(state: State<'_, VoiceState>) -> Result<(), VoiceError> {
    state.0.cancel_mic_test().await;
    Ok(())
}

fn emitter(events: Channel<VoiceEvent>) -> Emit {
    Arc::new(move |e| {
        let _ = events.send(e);
    })
}

#[tauri::command]
pub fn voice_get_audio_processing(state: State<'_, VoiceState>) -> AudioProcessingSettings {
    state.0.audio_processing()
}

#[tauri::command]
pub async fn voice_set_camera_enabled(
    state: State<'_, VoiceState>,
    on: bool,
    options: Option<CameraOptions>,
) -> Result<(), VoiceError> {
    let device = options.and_then(|o| o.device_id);
    state.0.set_camera(on, device).await
}

#[tauri::command]
pub async fn voice_list_screen_sources(
    state: State<'_, VoiceState>,
) -> Result<Vec<ScreenSource>, VoiceError> {
    let core = state.0.clone();
    // Enumerar janelas pode demorar e usa APIs do sistema: fora da thread async.
    tokio::task::spawn_blocking(move || core.list_screen_sources())
        .await
        .map_err(|e| VoiceError::other(e.to_string()))
}

/// Miniaturas do seletor de fonte: uma por vez, em sequência, enviadas pelo canal `thumbnails` conforme ficam
/// prontas (fonte sem miniatura chega com `error`). Só local: nada é gravado nem enviado ao servidor.
#[tauri::command]
pub async fn voice_screen_source_thumbnails(
    ids: Vec<String>,
    thumbnails: Channel<ScreenThumbnail>,
) -> Result<(), VoiceError> {
    tokio::task::spawn_blocking(move || {
        screen::capture_thumbnails(&ids, |t| {
            let _ = thumbnails.send(t);
        })
    })
    .await
    .map_err(|e| VoiceError::other(e.to_string()))
}

/// Interrompe as miniaturas em andamento (diálogo fechado).
#[tauri::command]
pub fn voice_cancel_screen_thumbnails() {
    screen::cancel_thumbnails();
}

/// macOS: abre as preferências de Gravação de Tela (para liberar as miniaturas e o compartilhamento).
#[tauri::command]
pub fn app_open_screen_recording_settings() {
    screen::open_screen_recording_settings();
}

/// Aplicativos com sessão de áudio agora (para escolher qual som compartilhar com a tela), sem o próprio Spook.
/// `{ supported, reason?, apps: [{ id, name, exe, icon?, playing }] }`; `supported: false` fora do Windows 10 2004+/11
/// (`reason`: `platform` | `windows-version` | `error`). `async` de propósito (comando síncrono roda fora do runtime)
/// e a enumeração (COM) vai para a thread de bloqueio.
#[tauri::command]
pub async fn voice_list_audio_apps() -> Result<AudioAppsResponse, VoiceError> {
    tokio::task::spawn_blocking(screen_audio::list_apps)
        .await
        .map_err(|e| VoiceError::other(e.to_string()))
}

#[tauri::command]
pub async fn voice_set_screen_share(
    state: State<'_, VoiceState>,
    on: bool,
    options: Option<ScreenOptions>,
) -> Result<(), VoiceError> {
    state
        .0
        .set_screen_share(on, options.unwrap_or_default())
        .await
}

#[tauri::command]
pub async fn voice_list_devices(
    state: State<'_, VoiceState>,
    kind: String,
) -> Result<Vec<DeviceInfo>, VoiceError> {
    let kind = parse_kind(&kind)?;
    let core = state.0.clone();
    tokio::task::spawn_blocking(move || core.list_devices(kind))
        .await
        .map_err(|e| VoiceError::other(e.to_string()))
}

#[tauri::command]
pub async fn voice_set_device(
    state: State<'_, VoiceState>,
    kind: String,
    id: String,
) -> Result<(), VoiceError> {
    state.0.set_device(parse_kind(&kind)?, &id).await
}

/// Assistir (`watching: true`) ou parar de assistir a tela de uma pessoa (`participant_id` = identidade da sala =
/// ID do usuário). As telas começam NÃO assinadas; só quem está na lista gasta banda e CPU. `async` de propósito:
/// `set_subscribed` do SDK faz `tokio::spawn` e comando síncrono roda fora do runtime (foi o crash da 0.1.4).
/// A faixa chega (ou sai) pelos eventos `video-track-added`/`video-track-removed` do canal da sala.
#[tauri::command]
pub async fn voice_set_screen_watching(
    state: State<'_, VoiceState>,
    participant_id: String,
    watching: bool,
) -> Result<(), VoiceError> {
    state.0.set_screen_watching(&participant_id, watching)
}

#[tauri::command]
pub async fn voice_video_subscribe(
    state: State<'_, VoiceState>,
    track_id: String,
    frames: Channel<InvokeResponseBody>,
    options: Option<ViewOptions>,
) -> Result<(), VoiceError> {
    state
        .0
        .subscribe_video(&track_id, Box::new(frames), options.unwrap_or_default())
        .await
}

#[tauri::command]
pub async fn voice_video_unsubscribe(
    state: State<'_, VoiceState>,
    track_id: String,
) -> Result<(), VoiceError> {
    state.0.unsubscribe_video(&track_id).await;
    Ok(())
}

#[tauri::command]
pub fn voice_video_ack(state: State<'_, VoiceState>, track_id: String) {
    state.0.ack_video(&track_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    const JWT: &str = "aaa.bbb.ccc";

    #[test]
    fn accepts_dev_and_prod_urls() {
        assert!(validate_connect("ws://localhost:7880", JWT).is_ok());
        assert!(validate_connect("wss://spook-rtc.dottadigital.com", JWT).is_ok());
    }

    #[test]
    fn rejects_bad_urls() {
        for u in [
            "",
            "localhost:7880",
            "ftp://x.com/aaa",
            "wss://a b.com",
            "file:///etc/passwd",
            "ws://",
        ] {
            assert!(validate_connect(u, JWT).is_err(), "{u}");
        }
    }

    #[test]
    fn rejects_bad_tokens_without_echoing_them() {
        for t in ["", "abc", "a.b", "a.b.c.d", "a. b.c"] {
            let err = validate_connect("wss://x.example.com", t).unwrap_err();
            assert!(!err.to_string().contains(t) || t.is_empty());
        }
    }

    #[test]
    fn device_kinds_parse() {
        assert_eq!(
            DeviceKind::parse("audioinput"),
            Some(DeviceKind::AudioInput)
        );
        assert_eq!(
            DeviceKind::parse("audiooutput"),
            Some(DeviceKind::AudioOutput)
        );
        assert_eq!(
            DeviceKind::parse("videoinput"),
            Some(DeviceKind::VideoInput)
        );
        assert!(parse_kind("lixo").is_err());
    }

    #[test]
    fn audio_processing_payload_accepts_the_level_and_the_legacy_boolean() {
        let new: AudioProcessingSettings = serde_json::from_str(
            r#"{"echoCancellation":true,"noiseSuppression":"strong","autoGainControl":false}"#,
        )
        .unwrap();
        assert_eq!(new.noise_suppression, NoiseSuppressionLevel::Strong);
        assert!(!new.auto_gain_control);
        let old: AudioProcessingSettings = serde_json::from_str(
            r#"{"echoCancellation":true,"noiseSuppression":false,"autoGainControl":true}"#,
        )
        .unwrap();
        assert_eq!(old.noise_suppression, NoiseSuppressionLevel::Off);
    }

    #[test]
    fn audio_processing_payload_accepts_the_input_sensitivity() {
        let s: AudioProcessingSettings = serde_json::from_str(
            r#"{"echoCancellation":true,"noiseSuppression":"strong","autoGainControl":true,
                "inputSensitivity":{"mode":"manual","thresholdDb":-42}}"#,
        )
        .unwrap();
        assert_eq!(
            s.input_sensitivity.mode,
            crate::voice::gate::GateMode::Manual
        );
        assert_eq!(s.input_sensitivity.threshold_db, -42.0);
        // sem o campo (interface antiga) a porta fica desligada
        let old: AudioProcessingSettings =
            serde_json::from_str(r#"{"echoCancellation":true}"#).unwrap();
        assert_eq!(
            old.input_sensitivity.mode,
            crate::voice::gate::GateMode::Off
        );
    }

    #[test]
    fn screen_options_carry_the_quality() {
        let s: ScreenOptions = serde_json::from_str(
            r#"{"sourceId":"display:1","audio":false,
                "quality":{"height":1440,"fps":30,"priority":"detail","maxBitrateKbps":6000}}"#,
        )
        .unwrap();
        let q = s.quality.unwrap();
        assert_eq!(
            (q.height, q.fps, q.max_bitrate_kbps),
            (1440, 30, Some(6000))
        );
        let d: ScreenOptions = serde_json::from_str(r#"{"sourceId":"x"}"#).unwrap();
        assert!(d.quality.is_none());
    }

    #[test]
    fn option_payloads_use_camel_case() {
        let s: ScreenOptions =
            serde_json::from_str(r#"{"sourceId":"display:1","audio":true}"#).unwrap();
        assert_eq!(s.source_id, "display:1");
        assert!(s.audio);
        let c: CameraOptions = serde_json::from_str(r#"{"deviceId":"0"}"#).unwrap();
        assert_eq!(c.device_id.as_deref(), Some("0"));
        let v: ViewOptions = serde_json::from_str(r#"{"maxWidth":640,"fps":10}"#).unwrap();
        assert_eq!(
            (v.max_width, v.max_height, v.fps),
            (Some(640), None, Some(10))
        );
        let d: ScreenOptions = serde_json::from_str("{}").unwrap();
        assert!(d.source_id.is_empty());
    }
}
