//! Limites de vídeo e política de descarte (lógica pura, sem dependências nativas).

use std::time::{Duration, Instant};

/// Tela compartilhada enviada ao LiveKit: no máximo 1080p.
pub const SHARE_MAX: (u32, u32) = (1920, 1080);
/// Câmera enviada ao LiveKit: no máximo 720p.
pub const CAMERA_MAX: (u32, u32) = (1280, 720);
/// Vídeo remoto mostrado no webview: no máximo 720p por padrão.
pub const VIEW_MAX: (u32, u32) = (1280, 720);
pub const SHARE_FPS: u32 = 15;
pub const CAMERA_FPS: u32 = 24;
pub const VIEW_FPS: u32 = 15;
pub const MIN_FPS: u32 = 5;
pub const MAX_FPS: u32 = 30;
pub const JPEG_QUALITY: u8 = 70;
/// Quadros enviados ao webview sem confirmação (`voice_video_ack`) antes de começar a descartar.
pub const MAX_IN_FLIGHT: u32 = 2;
/// Sem confirmação por este tempo, considera-se que o consumidor perdeu o quadro e libera o crédito.
pub const ACK_TIMEOUT: Duration = Duration::from_millis(1500);

pub fn clamp_fps(fps: u32) -> u32 {
    fps.clamp(MIN_FPS, MAX_FPS)
}

/// Cabe `(w, h)` em `(max_w, max_h)` mantendo a proporção, sem ampliar e com dimensões pares (I420 e
/// codificadores pedem largura/altura pares). Nunca devolve zero.
pub fn fit_within(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (2, 2);
    }
    let scale = (max_w as f64 / w as f64)
        .min(max_h as f64 / h as f64)
        .min(1.0);
    let nw = ((w as f64 * scale).round() as u32).max(2) & !1;
    let nh = ((h as f64 * scale).round() as u32).max(2) & !1;
    (nw.max(2), nh.max(2))
}

/// Deixa passar no máximo `fps` quadros por segundo.
#[derive(Debug, Clone)]
pub struct FpsLimiter {
    interval: Duration,
    last: Option<Instant>,
}

impl FpsLimiter {
    pub fn new(fps: u32) -> Self {
        let fps = clamp_fps(fps);
        Self {
            interval: Duration::from_micros(1_000_000 / fps as u64),
            last: None,
        }
    }

    pub fn set_fps(&mut self, fps: u32) {
        *self = Self {
            interval: FpsLimiter::new(fps).interval,
            last: self.last,
        };
    }

    /// Pergunta (e registra) se um quadro em `now` pode passar. Uma tolerância de 10% do intervalo evita
    /// descartar quadros que chegam um pouco adiantados.
    pub fn allow(&mut self, now: Instant) -> bool {
        match self.last {
            Some(last) if now.saturating_duration_since(last) < self.interval.mul_f32(0.9) => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }
}

/// Controle de fluxo com créditos: o Rust só envia se houver crédito; o webview devolve um crédito a
/// cada quadro desenhado (ou descartado) com `ack`. Evita acumular quadros na fila do IPC.
#[derive(Debug, Clone)]
pub struct FlowControl {
    max_in_flight: u32,
    in_flight: u32,
    since: Option<Instant>,
    dropped: u64,
    sent: u64,
}

impl FlowControl {
    pub fn new(max_in_flight: u32) -> Self {
        Self {
            max_in_flight: max_in_flight.max(1),
            in_flight: 0,
            since: None,
            dropped: 0,
            sent: 0,
        }
    }

    /// Tenta reservar um crédito para enviar um quadro agora.
    pub fn try_acquire(&mut self, now: Instant) -> bool {
        if self.in_flight >= self.max_in_flight {
            let stale = self
                .since
                .is_some_and(|t| now.saturating_duration_since(t) >= ACK_TIMEOUT);
            if stale {
                self.in_flight = 0;
            } else {
                self.dropped += 1;
                return false;
            }
        }
        if self.in_flight == 0 {
            self.since = Some(now);
        }
        self.in_flight += 1;
        self.sent += 1;
        true
    }

    /// Devolve um crédito sem ter enviado (a codificação falhou).
    pub fn release(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
        self.sent = self.sent.saturating_sub(1);
    }

    pub fn ack(&mut self, now: Instant) {
        self.in_flight = self.in_flight.saturating_sub(1);
        self.since = if self.in_flight > 0 { Some(now) } else { None };
    }

    pub fn in_flight(&self) -> u32 {
        self.in_flight
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn sent(&self) -> u64 {
        self.sent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_within_keeps_aspect_never_upscales_and_is_even() {
        assert_eq!(fit_within(3840, 2160, 1920, 1080), (1920, 1080));
        assert_eq!(fit_within(2560, 1440, 1280, 720), (1280, 720));
        assert_eq!(fit_within(1280, 720, 1920, 1080), (1280, 720));
        assert_eq!(fit_within(640, 480, 1280, 720), (640, 480));
        // 4:3 em 720p de altura
        assert_eq!(fit_within(2000, 1500, 1280, 720), (960, 720));
        // ímpares viram pares
        let (w, h) = fit_within(1001, 563, 1280, 720);
        assert_eq!((w % 2, h % 2), (0, 0));
        // retrato
        assert_eq!(fit_within(1080, 1920, 1280, 720), (404, 720));
        assert_eq!(fit_within(0, 10, 100, 100), (2, 2));
        assert_eq!(fit_within(1, 1, 100, 100), (2, 2));
    }

    #[test]
    fn fps_limiter_caps_the_rate() {
        let mut l = FpsLimiter::new(10);
        let t0 = Instant::now();
        let mut passed = 0;
        // 60 quadros em 1 segundo (60 fps) → ~10 passam.
        for i in 0..60u32 {
            if l.allow(t0 + Duration::from_micros(i as u64 * 1_000_000 / 60)) {
                passed += 1;
            }
        }
        assert!((9..=11).contains(&passed), "passaram {passed}");
    }

    #[test]
    fn fps_is_clamped() {
        assert_eq!(clamp_fps(0), MIN_FPS);
        assert_eq!(clamp_fps(120), MAX_FPS);
        assert_eq!(clamp_fps(15), 15);
    }

    #[test]
    fn flow_control_drops_when_the_consumer_lags() {
        let mut f = FlowControl::new(2);
        let t = Instant::now();
        assert!(f.try_acquire(t));
        assert!(f.try_acquire(t));
        // Sem ack: o terceiro e o quarto são descartados.
        assert!(!f.try_acquire(t));
        assert!(!f.try_acquire(t));
        assert_eq!(f.dropped(), 2);
        f.ack(t);
        assert!(f.try_acquire(t));
        assert_eq!(f.in_flight(), 2);
    }

    #[test]
    fn flow_control_recovers_from_lost_acks() {
        let mut f = FlowControl::new(1);
        let t = Instant::now();
        assert!(f.try_acquire(t));
        assert!(!f.try_acquire(t + Duration::from_millis(100)));
        assert!(f.try_acquire(t + ACK_TIMEOUT + Duration::from_millis(1)));
    }

    #[test]
    fn release_gives_the_credit_back() {
        let mut f = FlowControl::new(1);
        let t = Instant::now();
        assert!(f.try_acquire(t));
        f.release();
        assert!(f.try_acquire(t));
        assert_eq!(f.sent(), 1);
    }
}
