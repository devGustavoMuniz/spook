//! Roteador de vídeo para o webview. Cada faixa que o webview está desenhando tem uma "inscrição" com o
//! canal binário, o limitador de fps, o controle de fluxo (créditos) e os limites de resolução. Quem
//! produz quadros (faixas remotas e a prévia local) pergunta `reserve` ANTES de converter/codificar: se
//! ninguém desenha, o fps estourou ou o consumidor atrasou, o quadro é descartado de graça.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::ipc::{Channel, InvokeResponseBody};

use super::limits::{self, FlowControl, FpsLimiter};
use super::wire::{self, FrameHeader};

/// Para onde o quadro codificado vai. Em produção é o `Channel` do Tauri; nos testes, um coletor.
pub trait FrameSink: Send + Sync {
    fn send(&self, bytes: Vec<u8>) -> bool;
}

impl FrameSink for Channel<InvokeResponseBody> {
    fn send(&self, bytes: Vec<u8>) -> bool {
        Channel::send(self, InvokeResponseBody::Raw(bytes)).is_ok()
    }
}

struct Subscription {
    sink: Box<dyn FrameSink>,
    limiter: FpsLimiter,
    flow: FlowControl,
    max: (u32, u32),
    quality: u8,
    participant_id: String,
    source: &'static str,
}

/// Parâmetros da inscrição.
#[derive(Debug, Clone)]
pub struct ViewParams {
    pub participant_id: String,
    pub source: &'static str,
    pub max: (u32, u32),
    pub fps: u32,
    /// Qualidade do JPEG (1 a 100).
    pub quality: u8,
}

/// Resultado de `reserve`: o que o produtor precisa para codificar.
#[derive(Debug, Clone, Copy)]
pub struct Reservation {
    pub max: (u32, u32),
    pub quality: u8,
}

#[derive(Default)]
pub struct VideoRouter {
    subs: Mutex<HashMap<String, Subscription>>,
}

impl VideoRouter {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Subscription>> {
        self.subs.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn subscribe(&self, track_id: &str, sink: Box<dyn FrameSink>, params: ViewParams) {
        self.lock().insert(
            track_id.to_string(),
            Subscription {
                sink,
                limiter: FpsLimiter::new(params.fps),
                flow: FlowControl::new(limits::MAX_IN_FLIGHT),
                max: params.max,
                quality: params.quality,
                participant_id: params.participant_id,
                source: params.source,
            },
        );
    }

    pub fn unsubscribe(&self, track_id: &str) -> bool {
        self.lock().remove(track_id).is_some()
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    pub fn is_subscribed(&self, track_id: &str) -> bool {
        self.lock().contains_key(track_id)
    }

    /// O webview terminou de desenhar (ou descartou) um quadro: devolve o crédito.
    pub fn ack(&self, track_id: &str) {
        if let Some(s) = self.lock().get_mut(track_id) {
            s.flow.ack(Instant::now());
        }
    }

    /// Reserva o envio de um quadro agora (limite de fps + crédito). `None` = descarte.
    pub fn reserve(&self, track_id: &str, now: Instant) -> Option<Reservation> {
        let mut subs = self.lock();
        let s = subs.get_mut(track_id)?;
        // O limitador só "gasta" a vez se houver crédito; senão o próximo quadro tenta de novo.
        if !s.limiter.allow(now) {
            return None;
        }
        if !s.flow.try_acquire(now) {
            return None;
        }
        Some(Reservation {
            max: s.max,
            quality: s.quality,
        })
    }

    /// A codificação falhou: devolve o crédito reservado.
    pub fn cancel(&self, track_id: &str) {
        if let Some(s) = self.lock().get_mut(track_id) {
            s.flow.release();
        }
    }

    /// Envia o JPEG já codificado. Se o canal fechou (webview recarregou), remove a inscrição.
    pub fn deliver(&self, track_id: &str, jpeg: &[u8], width: u32, height: u32) {
        let mut subs = self.lock();
        let Some(s) = subs.get_mut(track_id) else {
            return;
        };
        let header = FrameHeader {
            track_id: track_id.to_string(),
            participant_id: s.participant_id.clone(),
            source: s.source.to_string(),
            width,
            height,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        };
        if !s.sink.send(wire::encode(&header, jpeg)) {
            subs.remove(track_id);
        }
    }

    /// Estatística (enviados, descartados) para diagnóstico e testes.
    pub fn stats(&self, track_id: &str) -> Option<(u64, u64)> {
        self.lock()
            .get(track_id)
            .map(|s| (s.flow.sent(), s.flow.dropped()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[derive(Default, Clone)]
    struct Collect(Arc<Mutex<Vec<Vec<u8>>>>);
    impl FrameSink for Collect {
        fn send(&self, bytes: Vec<u8>) -> bool {
            self.0.lock().unwrap().push(bytes);
            true
        }
    }

    struct Closed;
    impl FrameSink for Closed {
        fn send(&self, _: Vec<u8>) -> bool {
            false
        }
    }

    fn params() -> ViewParams {
        ViewParams {
            participant_id: "42".into(),
            source: "screen",
            max: (1280, 720),
            fps: 30,
            quality: 70,
        }
    }

    #[test]
    fn nobody_watching_means_no_work() {
        let r = VideoRouter::new();
        assert!(r.reserve("t", Instant::now()).is_none());
    }

    #[test]
    fn slow_consumer_gets_frames_dropped_not_queued() {
        let r = VideoRouter::new();
        let sink = Collect::default();
        r.subscribe("t", Box::new(sink.clone()), params());
        let t0 = Instant::now();
        let mut sent = 0;
        // 90 quadros em 3 s a 30 fps, e o webview nunca confirma.
        for i in 0..90u64 {
            let now = t0 + Duration::from_millis(i * 33);
            if r.reserve("t", now).is_some() {
                r.deliver("t", &[0xFF, 0xD8, 0xFF, 0xD9], 8, 8);
                sent += 1;
            }
        }
        // Limite de créditos (2) + recuperação por timeout (1,5 s) → bem menos que 90.
        assert!(sent <= 6, "enviou {sent}");
        assert_eq!(sink.0.lock().unwrap().len(), sent);
        let (s, d) = r.stats("t").unwrap();
        assert_eq!(s as usize, sent);
        assert!(d > 50);
    }

    #[test]
    fn acks_keep_the_stream_flowing() {
        let r = VideoRouter::new();
        r.subscribe("t", Box::new(Collect::default()), params());
        let t0 = Instant::now();
        let mut sent = 0;
        for i in 0..60u64 {
            let now = t0 + Duration::from_millis(i * 34);
            if r.reserve("t", now).is_some() {
                sent += 1;
                r.ack("t");
            }
        }
        assert!(sent >= 55, "enviou {sent}");
    }

    #[test]
    fn delivered_message_decodes_with_the_header() {
        let r = VideoRouter::new();
        let sink = Collect::default();
        r.subscribe("TR_9", Box::new(sink.clone()), params());
        assert!(r.reserve("TR_9", Instant::now()).is_some());
        r.deliver("TR_9", &[1, 2, 3], 1280, 720);
        let msgs = sink.0.lock().unwrap();
        let (h, body) = wire::decode(&msgs[0]).unwrap();
        assert_eq!(h.track_id, "TR_9");
        assert_eq!(h.participant_id, "42");
        assert_eq!(h.source, "screen");
        assert_eq!((h.width, h.height), (1280, 720));
        assert_eq!(body, [1, 2, 3]);
    }

    #[test]
    fn closed_channel_removes_the_subscription() {
        let r = VideoRouter::new();
        r.subscribe("t", Box::new(Closed), params());
        assert!(r.reserve("t", Instant::now()).is_some());
        r.deliver("t", &[1], 2, 2);
        assert!(!r.is_subscribed("t"));
    }

    #[test]
    fn unsubscribe_stops_everything() {
        let r = VideoRouter::new();
        r.subscribe("t", Box::new(Collect::default()), params());
        assert!(r.unsubscribe("t"));
        assert!(r.reserve("t", Instant::now()).is_none());
        assert!(!r.unsubscribe("t"));
    }

    #[test]
    fn cancel_returns_the_credit() {
        let r = VideoRouter::new();
        let mut p = params();
        p.fps = 30;
        r.subscribe("t", Box::new(Collect::default()), p);
        let t0 = Instant::now();
        assert!(r.reserve("t", t0).is_some());
        assert!(r.reserve("t", t0 + Duration::from_millis(40)).is_some());
        assert!(r.reserve("t", t0 + Duration::from_millis(80)).is_none());
        r.cancel("t");
        assert!(r.reserve("t", t0 + Duration::from_millis(120)).is_some());
    }
}
