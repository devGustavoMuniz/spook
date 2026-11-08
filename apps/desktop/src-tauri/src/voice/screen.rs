//! Compartilhamento de tela com `scap`: ScreenCaptureKit (macOS), Windows Graphics Capture (Windows) e
//! portal xdg + PipeWire (Linux; lá quem escolhe a tela é o diálogo do sistema).
//!
//! O `scap` só oferece `get_next_frame()` bloqueante: a parada é cooperativa (veja `CaptureThread`).
//! Áudio do sistema: o `scap` 0.0.8 não captura áudio; fica como limitação documentada.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use scap::capturer::{Capturer, Options, Resolution};
use scap::frame::{Frame, FrameType};
use scap::Target;
use serde::Serialize;

use super::capture::{CaptureThread, VideoOut};
use super::error::{MediaCode, MediaDevice, VoiceError};
use super::frames::{to_i420, PixelOrder};
use super::thumbnail::{self, Order, ScreenThumbnail, Thumb, ThumbFailure};

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
    // `Target`/`Options` carregam HWND/HMONITOR crus (`!Send` no Windows): só dados `Send` cruzam para a
    // thread, e alvo, opções e `Capturer` nascem e morrem lá dentro.
    let source_id_owned = source_id_str.to_string();

    let (thread, ready) =
        CaptureThread::spawn::<VoiceError, _>("spook-screen", move |stop, ready| {
            let target = match find_target(&source_id_owned) {
                Ok(t) => t,
                Err(e) => {
                    let _ = ready.send(Err(e));
                    return;
                }
            };
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

// ---------------------------------------------------------------------------------------------------------
// Miniaturas do seletor de fonte (um quadro pequeno por tela/janela; só local, nada vai a disco nem ao log).
// ---------------------------------------------------------------------------------------------------------

/// Tempo máximo para uma fonte entregar o primeiro quadro (depois disso ela vira "sem miniatura").
const THUMB_TIMEOUT: Duration = Duration::from_millis(2500);
/// Quadros tentados por fonte até obter um válido (o primeiro do ScreenCaptureKit às vezes vem vazio).
const THUMB_FRAME_TRIES: usize = 3;

/// Geração do pedido corrente: um pedido novo (ou `cancel_thumbnails`) invalida o anterior.
static THUMB_GENERATION: AtomicU64 = AtomicU64::new(0);
/// Só um conjunto de capturas por vez (criar/derrubar `Capturer` em paralelo é pesado e pisca bordas).
static THUMB_LOCK: Mutex<()> = Mutex::new(());

/// Cancela o pedido de miniaturas em andamento (ele para antes da próxima fonte).
pub fn cancel_thumbnails() {
    THUMB_GENERATION.fetch_add(1, Ordering::SeqCst);
}

fn to_thumb_order(o: PixelOrder) -> Order {
    match o {
        PixelOrder::Bgra => Order::Bgra,
        PixelOrder::Rgba => Order::Rgba,
    }
}

/// Captura miniaturas de `ids` em sequência, chamando `emit` a cada uma (ou falha). Bloqueante: rode em
/// `spawn_blocking`. Fontes `portal` (Linux) não têm miniatura e são ignoradas.
pub fn capture_thumbnails(ids: &[String], mut emit: impl FnMut(ScreenThumbnail)) {
    let ids: Vec<&String> = ids
        .iter()
        .filter(|i| i.as_str() != "portal" && parse_source_id(i).is_some())
        .take(thumbnail::MAX_SOURCES)
        .collect();
    if ids.is_empty() {
        return;
    }
    let generation = THUMB_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let cancelled = || THUMB_GENERATION.load(Ordering::SeqCst) != generation;
    // Espera o pedido anterior (que já foi invalidado) terminar a fonte atual.
    let _guard = THUMB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if cancelled() {
        return;
    }
    let fail_all = |why: ThumbFailure, emit: &mut dyn FnMut(ScreenThumbnail)| {
        for id in &ids {
            emit(ScreenThumbnail::failed(id, why));
        }
    };
    let supported = catch_unwind(scap::is_supported).unwrap_or(false);
    if !supported {
        fail_all(ThumbFailure::Unsupported, &mut emit);
        return;
    }
    // Sem pedir a permissão aqui: o diálogo do TCC só aparece quando o usuário de fato compartilha.
    if !catch_unwind(scap::has_permission).unwrap_or(false) {
        fail_all(ThumbFailure::Permission, &mut emit);
        return;
    }
    for id in ids {
        if cancelled() {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = std_mpsc::channel();
        let (worker_id, worker_stop) = (id.clone(), stop.clone());
        let spawned = std::thread::Builder::new()
            .name("spook-thumb".into())
            .spawn(move || {
                // O scap usa `expect`/`panic`: contido aqui. Alvo e `Capturer` nascem e morrem nesta thread
                // (`!Send` no Windows).
                let r = catch_unwind(AssertUnwindSafe(|| capture_one(&worker_id, &worker_stop)))
                    .unwrap_or(Err(ThumbFailure::Failed));
                let _ = tx.send(r);
            });
        let result = match spawned {
            Ok(_) => rx.recv_timeout(THUMB_TIMEOUT).unwrap_or_else(|_| {
                // A thread abandonada termina quando o backend entregar um quadro; `stop` evita o trabalho.
                stop.store(true, Ordering::SeqCst);
                Err(ThumbFailure::Timeout)
            }),
            Err(_) => Err(ThumbFailure::Failed),
        };
        if cancelled() {
            return;
        }
        emit(match result {
            Ok(t) => ScreenThumbnail::ok(id, &t),
            Err(why) => ScreenThumbnail::failed(id, why),
        });
    }
}

fn capture_one(id: &str, stop: &AtomicBool) -> Result<Thumb, ThumbFailure> {
    let target = match find_target(id) {
        Ok(Some(t)) => Some(t),
        _ => return Err(ThumbFailure::Failed),
    };
    let options = Options {
        fps: 2,
        show_cursor: false,
        show_highlight: false,
        target,
        crop_area: None,
        output_type: FrameType::BGRAFrame,
        // macOS reduz na própria captura (ScreenCaptureKit); nos outros o scap entrega o tamanho cheio.
        output_resolution: if cfg!(target_os = "macos") {
            Resolution::_480p
        } else {
            Resolution::Captured
        },
        excluded_targets: None,
    };
    let mut capturer = Capturer::build(options).map_err(|e| match e {
        scap::capturer::CapturerBuildError::PermissionNotGranted => ThumbFailure::Permission,
        scap::capturer::CapturerBuildError::NotSupported => ThumbFailure::Unsupported,
    })?;
    capturer.start_capture();
    let mut out = Err(ThumbFailure::Failed);
    for _ in 0..THUMB_FRAME_TRIES {
        let Ok(frame) = capturer.get_next_frame() else {
            break;
        };
        if stop.load(Ordering::SeqCst) {
            out = Err(ThumbFailure::Timeout);
            break;
        }
        if let Some((data, w, h, order)) = pixels(frame) {
            if let Ok(t) = thumbnail::build(&data, w, h, to_thumb_order(order)) {
                out = Ok(t);
                break;
            }
        }
    }
    let _ = catch_unwind(AssertUnwindSafe(|| capturer.stop_capture()));
    out
}

/// macOS: abre Ajustes > Privacidade > Gravação de Tela. Nos outros sistemas não faz nada.
pub fn open_screen_recording_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
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
