//! Compartilhamento de tela com `scap`: ScreenCaptureKit (macOS), Windows Graphics Capture (Windows) e
//! portal xdg + PipeWire (Linux; lá quem escolhe a tela é o diálogo do sistema).
//!
//! O `scap` só oferece `get_next_frame()` bloqueante: a parada é cooperativa (veja `CaptureThread`).
//! Áudio do sistema: o `scap` 0.0.8 não captura áudio; fica como limitação documentada.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use scap::capturer::{Capturer, Options, Resolution};
use scap::frame::{Frame, FrameType};
use scap::Target;
use serde::Serialize;

use super::capture::{CaptureThread, VideoOut};
use super::error::{MediaCode, MediaDevice, VoiceError};
use super::frames::{to_i420, PixelOrder};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSource {
    /// `display:<id>`, `window:<id>` ou `portal` (Linux: o sistema pergunta).
    pub id: String,
    pub name: String,
    /// `screen` | `window`.
    pub kind: &'static str,
}

/// Identificador estável de um alvo do scap.
pub fn source_id(kind: &str, id: u32) -> String {
    format!("{kind}:{id}")
}

pub fn parse_source_id(id: &str) -> Option<(&str, u32)> {
    let (kind, n) = id.split_once(':')?;
    if kind != "display" && kind != "window" {
        return None;
    }
    Some((kind, n.parse().ok()?))
}

pub fn list_sources() -> Vec<ScreenSource> {
    if cfg!(target_os = "linux") {
        // No Linux o scap não enumera: o portal do desktop mostra o seletor quando a captura começa.
        return vec![ScreenSource {
            id: "portal".into(),
            name: "Escolher no seletor do sistema".into(),
            kind: "screen",
        }];
    }
    let mut out = Vec::new();
    let mut n_display = 0;
    for t in scap::get_all_targets() {
        match t {
            Target::Display(d) => {
                n_display += 1;
                let name = if d.title.trim().is_empty() {
                    format!("Tela {n_display}")
                } else {
                    d.title
                };
                out.push(ScreenSource {
                    id: source_id("display", d.id),
                    name,
                    kind: "screen",
                });
            }
            Target::Window(w) => {
                if w.title.trim().is_empty() {
                    continue;
                }
                out.push(ScreenSource {
                    id: source_id("window", w.id),
                    name: w.title,
                    kind: "window",
                });
            }
        }
    }
    // Telas primeiro, depois janelas por nome.
    out.sort_by(|a, b| (a.kind != "screen", &a.name).cmp(&(b.kind != "screen", &b.name)));
    out
}

fn find_target(source_id_str: &str) -> Result<Option<Target>, VoiceError> {
    if source_id_str == "portal" || source_id_str.is_empty() {
        return Ok(None);
    }
    let (kind, id) = parse_source_id(source_id_str)
        .ok_or_else(|| VoiceError::other("Fonte de compartilhamento inválida."))?;
    scap::get_all_targets()
        .into_iter()
        .find(|t| match (kind, t) {
            ("display", Target::Display(d)) => d.id == id,
            ("window", Target::Window(w)) => w.id == id,
            _ => false,
        })
        .map(Some)
        .ok_or_else(|| VoiceError::media(MediaCode::NotFound, MediaDevice::Screen))
}

/// Captura de tela em andamento (soltar = parar).
pub struct ScreenCapture {
    _thread: CaptureThread,
}

/// Inicia a captura. Só devolve depois que a captura abriu (ou falhou/foi cancelada).
pub async fn start(
    source_id_str: &str,
    fps: u32,
    mut out: VideoOut,
) -> Result<ScreenCapture, VoiceError> {
    // macOS: pede a permissão de gravação de tela (diálogo do TCC) antes de qualquer coisa.
    if !scap::is_supported() {
        return Err(VoiceError::media(
            MediaCode::Unsupported,
            MediaDevice::Screen,
        ));
    }
    if !scap::has_permission() && !scap::request_permission() {
        return Err(VoiceError::media(
            MediaCode::PermissionDenied,
            MediaDevice::Screen,
        ));
    }
    let target = find_target(source_id_str)?;
    let options = Options {
        fps,
        show_cursor: true,
        show_highlight: false,
        target,
        crop_area: None,
        output_type: FrameType::BGRAFrame,
        output_resolution: Resolution::Captured,
        excluded_targets: None,
    };

    let (thread, ready) =
        CaptureThread::spawn::<VoiceError, _>("spook-screen", move |stop, ready| {
            // O scap usa `expect`/`panic` em vários caminhos (portal cancelado, alvo inválido): contém.
            let built = catch_unwind(AssertUnwindSafe(|| Capturer::build(options)));
            let mut capturer = match built {
                Ok(Ok(c)) => c,
                Ok(Err(e)) => {
                    let code = match e {
                        scap::capturer::CapturerBuildError::PermissionNotGranted => {
                            MediaCode::PermissionDenied
                        }
                        scap::capturer::CapturerBuildError::NotSupported => MediaCode::Unsupported,
                    };
                    let _ = ready.send(Err(VoiceError::media(code, MediaDevice::Screen)));
                    return;
                }
                Err(_) => {
                    // No Linux, recusar o seletor do portal derruba o scap.
                    let code = if cfg!(target_os = "linux") {
                        MediaCode::Cancelled
                    } else {
                        MediaCode::Unknown
                    };
                    let _ = ready.send(Err(VoiceError::media(code, MediaDevice::Screen)));
                    return;
                }
            };
            let started = catch_unwind(AssertUnwindSafe(|| capturer.start_capture()));
            if started.is_err() {
                let _ = ready.send(Err(VoiceError::media(
                    MediaCode::Unknown,
                    MediaDevice::Screen,
                )));
                return;
            }
            let _ = ready.send(Ok(()));
            while !stop.load(Ordering::SeqCst) {
                let frame = match catch_unwind(AssertUnwindSafe(|| capturer.get_next_frame())) {
                    Ok(Ok(f)) => f,
                    _ => break,
                };
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                if let Some((data, w, h, order)) = pixels(frame) {
                    // Descartar antes de converter é mais barato, mas o `push` já limita o fps.
                    match to_i420(&data, w, h, order) {
                        Ok(i420) => {
                            out.push(i420);
                        }
                        Err(e) => log::debug!("quadro de tela ignorado: {e}"),
                    }
                }
            }
            let _ = catch_unwind(AssertUnwindSafe(|| capturer.stop_capture()));
        })
        .map_err(VoiceError::other)?;

    // O seletor do portal (Linux) espera o usuário; os demais respondem na hora.
    let result = tokio::task::spawn_blocking(move || ready.recv_timeout(Duration::from_secs(120)))
        .await
        .map_err(|e| VoiceError::other(e.to_string()))?;
    match result {
        Ok(Ok(())) => Ok(ScreenCapture { _thread: thread }),
        Ok(Err(e)) => Err(e),
        Err(std_mpsc::RecvTimeoutError::Timeout) => {
            Err(VoiceError::media(MediaCode::Cancelled, MediaDevice::Screen))
        }
        Err(_) => Err(VoiceError::media(MediaCode::Unknown, MediaDevice::Screen)),
    }
}

/// Extrai bytes/dimensões/ordem de um quadro do scap. Formatos sem 4 bytes por pixel são ignorados.
fn pixels(frame: Frame) -> Option<(Vec<u8>, u32, u32, PixelOrder)> {
    match frame {
        Frame::BGRA(f) => Some((
            f.data,
            f.width.max(0) as u32,
            f.height.max(0) as u32,
            PixelOrder::Bgra,
        )),
        Frame::BGRx(f) => Some((
            f.data,
            f.width.max(0) as u32,
            f.height.max(0) as u32,
            PixelOrder::Bgra,
        )),
        Frame::RGBx(f) => Some((
            f.data,
            f.width.max(0) as u32,
            f.height.max(0) as u32,
            PixelOrder::Rgba,
        )),
        Frame::XBGR(mut f) => {
            // Bytes x,B,G,R → R,G,B,x.
            for px in f.data.chunks_exact_mut(4) {
                px.swap(0, 3);
                px.swap(1, 2);
            }
            Some((
                f.data,
                f.width.max(0) as u32,
                f.height.max(0) as u32,
                PixelOrder::Rgba,
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_ids_roundtrip() {
        let id = source_id("window", 4242);
        assert_eq!(parse_source_id(&id), Some(("window", 4242)));
        assert_eq!(parse_source_id("display:1"), Some(("display", 1)));
    }

    #[test]
    fn invalid_source_ids_are_rejected() {
        assert_eq!(parse_source_id("portal"), None);
        assert_eq!(parse_source_id("tela:1"), None);
        assert_eq!(parse_source_id("window:abc"), None);
        assert!(find_target("lixo").is_err());
    }

    #[test]
    fn portal_means_system_picker() {
        assert!(matches!(find_target("portal"), Ok(None)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_lists_the_portal_entry() {
        let l = list_sources();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].id, "portal");
    }

    #[test]
    fn xbgr_is_swizzled_to_rgba() {
        let f = Frame::XBGR(scap::frame::XBGRFrame {
            display_time: 0,
            width: 1,
            height: 1,
            data: vec![0, 30, 20, 10], // x,B,G,R
        });
        let (data, w, h, order) = pixels(f).unwrap();
        assert_eq!((w, h, order), (1, 1, PixelOrder::Rgba));
        assert_eq!(data, vec![10, 20, 30, 0]);
    }
}
