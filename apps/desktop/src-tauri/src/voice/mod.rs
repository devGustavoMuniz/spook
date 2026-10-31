//! Voz, vídeo e tela NATIVOS do desktop (RF12.2): o WebView nunca usa WebRTC. O LiveKit Rust SDK
//! (libwebrtc) cuida da sala; `cpal` captura/toca áudio, `scap` captura a tela e `nokhwa` a câmera.
//! O vídeo remoto vira JPEG e viaja ao webview por `tauri::ipc::Channel` binário.
//!
//! Camadas: lógica pura e testável (`limits`, `mixer`, `resample`, `rnnoise`, `delay`, `wire`, `error`, `frames`, `router`,
//! `events`, `gate`, `quality`, `mictest`) → dispositivos (`audio`, `screen`, `camera`, `capture`) → `core` (sala) → `commands` (Tauri).

pub mod apm;
pub mod audio;
pub mod camera;
pub mod capture;
pub mod commands;
pub mod core;
pub mod delay;
pub mod error;
pub mod events;
pub mod frames;
pub mod gate;
pub mod limits;
pub mod mictest;
pub mod mixer;
pub mod quality;
pub mod resample;
pub mod rnnoise;
pub mod router;
pub mod screen;
pub mod synth;
pub mod wire;

pub use commands::VoiceState;
