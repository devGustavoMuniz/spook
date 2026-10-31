//! Câmera nativa com `nokhwa` (AVFoundation no macOS, Media Foundation no Windows, V4L2 no Linux).
//! Fica atrás da feature Cargo `camera`: sem ela, o módulo só devolve "não suportado".

use serde::Serialize;

use super::error::{MediaCode, MediaDevice, VoiceError};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CameraInfo {
    pub id: String,
    pub label: String,
}

#[cfg(feature = "camera")]
mod imp {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::Ordering;
    use std::sync::mpsc as std_mpsc;
    use std::time::Duration;

    use nokhwa::pixel_format::RgbAFormat;
    use nokhwa::utils::{
        ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
        Resolution,
    };
    use nokhwa::Camera;

    use super::*;
    use crate::voice::capture::{CaptureThread, VideoOut};
    use crate::voice::error::classify_backend_message;
    use crate::voice::frames::{to_i420, PixelOrder};

    pub struct CameraCapture {
        _thread: CaptureThread,
    }

    pub fn list() -> Vec<CameraInfo> {
        #[cfg(target_os = "macos")]
        {
            if !nokhwa::nokhwa_check() {
                // Dispara o pedido de permissão; a lista volta vazia até o usuário responder.
                nokhwa::nokhwa_initialize(|_| {});
                return Vec::new();
            }
        }
        catch_unwind(|| nokhwa::query(ApiBackend::Auto))
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default()
            .into_iter()
            .map(|c| CameraInfo {
                id: c.index().to_string(),
                label: c.human_name(),
            })
            .collect()
    }

    fn index_of(id: Option<&str>) -> CameraIndex {
        match id.and_then(|s| s.parse::<u32>().ok()) {
            Some(n) => CameraIndex::Index(n),
            None => CameraIndex::Index(0),
        }
    }

    fn map_err(e: &nokhwa::NokhwaError) -> VoiceError {
        VoiceError::media(
            classify_backend_message(&e.to_string()),
            MediaDevice::Camera,
        )
    }

    /// Decodifica o quadro da câmera em RGBA (MJPEG pelo crate `image`, o resto pelo nokhwa).
    fn rgba_of(buf: &nokhwa::Buffer) -> Option<(Vec<u8>, u32, u32)> {
        if buf.source_frame_format() == FrameFormat::MJPEG {
            let img = image::load_from_memory_with_format(buf.buffer(), image::ImageFormat::Jpeg)
                .ok()?
                .to_rgba8();
            let (w, h) = img.dimensions();
            return Some((img.into_raw(), w, h));
        }
        let img = buf.decode_image::<RgbAFormat>().ok()?;
        let (w, h) = img.dimensions();
        Some((img.into_raw(), w, h))
    }

    pub async fn start(
        device_id: Option<String>,
        fps: u32,
        max: (u32, u32),
        mut out: VideoOut,
    ) -> Result<CameraCapture, VoiceError> {
        let (thread, ready) =
            CaptureThread::spawn::<VoiceError, _>("spook-camera", move |stop, ready| {
                #[cfg(target_os = "macos")]
                {
                    if !nokhwa::nokhwa_check() {
                        // 0 = sem resposta, 1 = concedida, 2 = negada. O diálogo do macOS responde em outra thread.
                        let answer = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(0));
                        let a = answer.clone();
                        nokhwa::nokhwa_initialize(move |ok| {
                            a.store(if ok { 1 } else { 2 }, Ordering::SeqCst)
                        });
                        for _ in 0..600 {
                            if answer.load(Ordering::SeqCst) != 0
                                || nokhwa::nokhwa_check()
                                || stop.load(Ordering::SeqCst)
                            {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        if !nokhwa::nokhwa_check() {
                            let _ = ready.send(Err(VoiceError::media(
                                MediaCode::PermissionDenied,
                                MediaDevice::Camera,
                            )));
                            return;
                        }
                    }
                }
                let wanted =
                    CameraFormat::new(Resolution::new(max.0, max.1), FrameFormat::MJPEG, fps);
                let format =
                    RequestedFormat::new::<RgbAFormat>(RequestedFormatType::Closest(wanted));
                let opened = catch_unwind(AssertUnwindSafe(|| {
                    let mut cam = Camera::new(index_of(device_id.as_deref()), format)?;
                    cam.open_stream()?;
                    Ok::<_, nokhwa::NokhwaError>(cam)
                }));
                let mut cam = match opened {
                    Ok(Ok(c)) => c,
                    Ok(Err(e)) => {
                        let _ = ready.send(Err(map_err(&e)));
                        return;
                    }
                    Err(_) => {
                        let _ = ready.send(Err(VoiceError::media(
                            MediaCode::Unknown,
                            MediaDevice::Camera,
                        )));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));
                let mut failures = 0u32;
                while !stop.load(Ordering::SeqCst) {
                    match cam.frame() {
                        Ok(buf) => {
                            failures = 0;
                            if let Some((rgba, w, h)) = rgba_of(&buf) {
                                if let Ok(i420) = to_i420(&rgba, w, h, PixelOrder::Rgba) {
                                    out.push(i420);
                                }
                            }
                        }
                        Err(e) => {
                            failures += 1;
                            log::debug!("falha ao ler a câmera: {e}");
                            if failures > 30 {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(30));
                        }
                    }
                }
                let _ = cam.stop_stream();
            })
            .map_err(VoiceError::other)?;
        let result =
            tokio::task::spawn_blocking(move || ready.recv_timeout(Duration::from_secs(40)))
                .await
                .map_err(|e| VoiceError::other(e.to_string()))?;
        match result {
            Ok(Ok(())) => Ok(CameraCapture { _thread: thread }),
            Ok(Err(e)) => Err(e),
            Err(std_mpsc::RecvTimeoutError::Timeout) => {
                Err(VoiceError::media(MediaCode::InUse, MediaDevice::Camera))
            }
            Err(_) => Err(VoiceError::media(MediaCode::Unknown, MediaDevice::Camera)),
        }
    }
}

#[cfg(feature = "camera")]
pub use imp::{list, start, CameraCapture};

#[cfg(not(feature = "camera"))]
mod stub {
    use super::*;
    use crate::voice::capture::VideoOut;

    pub struct CameraCapture;

    pub fn list() -> Vec<CameraInfo> {
        Vec::new()
    }

    pub async fn start(
        _device_id: Option<String>,
        _fps: u32,
        _max: (u32, u32),
        _out: VideoOut,
    ) -> Result<CameraCapture, VoiceError> {
        Err(VoiceError::media(
            MediaCode::Unsupported,
            MediaDevice::Camera,
        ))
    }
}

#[cfg(not(feature = "camera"))]
pub use stub::{list, start, CameraCapture};
