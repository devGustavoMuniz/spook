//! Infra comum da captura local (tela e câmera): a thread de captura e o "funil" que leva cada quadro ao
//! LiveKit (`NativeVideoSource`) e, se alguém estiver olhando a prévia, ao webview.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use libwebrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use libwebrtc::video_source::native::NativeVideoSource;

use super::frames::{encode_jpeg, fit_i420};
use super::limits::{self, FpsLimiter};
use super::router::VideoRouter;

/// Último quadro enviado ao LiveKit e quando (para repeti-lo se a tela ficar parada).
type LastFrame = Arc<Mutex<Option<(VideoFrame<I420Buffer>, Instant)>>>;

/// Reenvia o último quadro de uma tela parada (ver `limits::IDLE_REPEAT_AFTER`). Uma thread leve que acorda a cada
/// 200 ms; para sozinha quando o `VideoOut` é solto.
struct IdleRepeater {
    last: LastFrame,
    stop: Arc<AtomicBool>,
}

impl IdleRepeater {
    fn start(source: NativeVideoSource) -> Self {
        let last: LastFrame = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let (l, s) = (last.clone(), stop.clone());
        let spawned = std::thread::Builder::new()
            .name("spook-screen-idle".into())
            .spawn(move || {
                while !s.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(200));
                    let mut guard = l.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some((frame, at)) = guard.as_mut() {
                        if limits::idle_repeat_due(at.elapsed()) {
                            source.capture_frame(&*frame);
                            *at = Instant::now();
                        }
                    }
                }
            });
        if let Err(e) = spawned {
            log::warn!("não foi possível iniciar o reenvio de quadros da tela parada: {e}");
        }
        Self { last, stop }
    }

    fn remember(&self, frame: VideoFrame<I420Buffer>) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some((frame, Instant::now()));
    }
}

impl Drop for IdleRepeater {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Entrega os quadros capturados: limita fps e resolução, publica no LiveKit e alimenta a prévia local.
pub struct VideoOut {
    source: NativeVideoSource,
    router: Arc<VideoRouter>,
    track_id: String,
    limiter: FpsLimiter,
    max: (u32, u32),
    idle: Option<IdleRepeater>,
}

impl VideoOut {
    pub fn new(
        source: NativeVideoSource,
        router: Arc<VideoRouter>,
        track_id: String,
        fps: u32,
        max: (u32, u32),
    ) -> Self {
        Self::with_fps_cap(source, router, track_id, fps, max, limits::MAX_FPS)
    }

    /// Como `new`, com outro teto de fps (tela compartilhada: até 60).
    pub fn with_fps_cap(
        source: NativeVideoSource,
        router: Arc<VideoRouter>,
        track_id: String,
        fps: u32,
        max: (u32, u32),
        fps_cap: u32,
    ) -> Self {
        Self {
            source,
            router,
            track_id,
            limiter: FpsLimiter::with_max(fps, fps_cap),
            max,
            idle: None,
        }
    }

    /// Tela: se a captura ficar parada (nenhum quadro novo), reenvia o último para os espectadores não verem preto.
    pub fn repeat_when_idle(mut self) -> Self {
        self.idle = Some(IdleRepeater::start(self.source.clone()));
        self
    }

    /// Recebe um quadro I420 (qualquer tamanho). Devolve `false` se foi descartado pelo limite de fps.
    pub fn push(&mut self, i420: I420Buffer) -> bool {
        let now = Instant::now();
        if !self.limiter.allow(now) {
            return false;
        }
        let i420 = fit_i420(i420, self.max);
        // Prévia local: só codifica se o webview estiver desenhando e tiver crédito.
        if let Some(res) = self.router.reserve(&self.track_id, now) {
            match encode_jpeg(&i420, res.max, res.quality) {
                Ok((jpeg, w, h)) => self.router.deliver(&self.track_id, &jpeg, w, h),
                Err(e) => {
                    log::debug!("prévia local descartada: {e}");
                    self.router.cancel(&self.track_id);
                }
            }
        }
        let frame = VideoFrame::new(VideoRotation::VideoRotation0, i420);
        self.source.capture_frame(&frame);
        if let Some(idle) = &self.idle {
            idle.remember(frame);
        }
        true
    }
}

/// Thread de captura com parada cooperativa. Alguns backends bloqueiam esperando o próximo quadro
/// (tela parada); por isso o `Drop` espera um tempo curto e, se a thread não responder, ela é deixada
/// terminar sozinha no próximo quadro (a flag `stop` já vale).
pub struct CaptureThread {
    stop: Arc<AtomicBool>,
    done: std_mpsc::Receiver<()>,
    join: Option<JoinHandle<()>>,
}

impl CaptureThread {
    /// `run` recebe a flag de parada e um aviso de "pronto" (resultado da abertura do dispositivo).
    pub fn spawn<E, F>(
        name: &str,
        run: F,
    ) -> Result<(Self, std_mpsc::Receiver<Result<(), E>>), String>
    where
        E: Send + 'static,
        F: FnOnce(Arc<AtomicBool>, std_mpsc::Sender<Result<(), E>>) + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std_mpsc::channel();
        let (done_tx, done_rx) = std_mpsc::channel();
        let flag = stop.clone();
        let join = std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                run(flag, ready_tx);
                let _ = done_tx.send(());
            })
            .map_err(|e| e.to_string())?;
        Ok((
            Self {
                stop,
                done: done_rx,
                join: Some(join),
            },
            ready_rx,
        ))
    }

    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }
}

impl Drop for CaptureThread {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        match self.done.recv_timeout(Duration::from_millis(1500)) {
            Ok(()) | Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(j) = self.join.take() {
                    let _ = j.join();
                }
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {
                log::warn!("a captura não parou a tempo; ela termina no próximo quadro");
                self.join.take();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_thread_stops_cooperatively() {
        let (t, ready) = CaptureThread::spawn::<String, _>("t", |stop, ready| {
            let _ = ready.send(Ok(()));
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        })
        .unwrap();
        assert!(ready.recv().unwrap().is_ok());
        let started = Instant::now();
        drop(t);
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn capture_thread_does_not_hang_forever_on_a_blocked_backend() {
        let (tx, rx) = std_mpsc::channel::<()>();
        let (t, _ready) = CaptureThread::spawn::<String, _>("t", move |_stop, ready| {
            let _ = ready.send(Ok(()));
            let _ = rx.recv(); // simula get_next_frame() bloqueado
        })
        .unwrap();
        let started = Instant::now();
        drop(t);
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(tx);
    }
}
