//! Comandos Tauri da voz nativa. Camada fina: valida a entrada e delega ao `VoiceCore`.
//! Erros chegam ao webview como `VoiceError` serializado (`{kind, code, device?, message}`).

use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use super::audio::DeviceInfo;
use super::core::{DeviceKind, Emit, ScreenOptions, ViewOptions, VoiceCore};
use super::error::{ConnectCode, VoiceError};
use super::events::VoiceEvent;
use super::screen::ScreenSource;

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
    let emit: Emit = Arc::new(move |e| {
        let _ = events.send(e);
    });
    state.0.connect(&url, &token, emit).await
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

#[tauri::command]
pub fn voice_set_deafened(state: State<'_, VoiceState>, deafened: bool) {
    state.0.set_deafened(deafened);
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
