//! Estimativa dinâmica do atraso entre o que tocamos e o que o microfone ouve de volta (dica do AEC).
//!
//! Soma, em milissegundos: latência de saída (`playback − callback` do cpal no callback de saída), latência de
//! entrada (`callback − capture` no callback de entrada) e o que ainda está na fila do renderizador antes de
//! chegar ao dispositivo. Os callbacks de áudio só ESCREVEM átomos (`LatencyProbe`, sem alocar nem bloquear);
//! a thread que processa o microfone chama `DelayEstimator::update` a cada ~1 s: mediana das últimas
//! medições (resistente a picos) e limites sensatos. Sem timestamps, cai para o padrão (60 ms).
//! Módulo PURO (sem libwebrtc, cpal nem tauri).

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

/// Padrão quando não há timestamps do cpal.
pub const DEFAULT_DELAY_MS: i32 = 60;
pub const MIN_DELAY_MS: i32 = 10;
pub const MAX_DELAY_MS: i32 = 400;
/// Quantas medições (≈1 s cada) entram na mediana.
pub const WINDOW: usize = 5;
/// Contribuição presumida de um lado que não reporta (metade do padrão).
const MISSING_SIDE_MS: f32 = DEFAULT_DELAY_MS as f32 / 2.0;

/// Valores gravados pelos callbacks do cpal. 0 = "ainda não medido"; o valor guardado é µs + 1.
#[derive(Debug, Default)]
pub struct LatencyProbe {
    output_us: AtomicU32,
    input_us: AtomicU32,
    queued_us: AtomicU32,
}

fn pack(d: Duration) -> u32 {
    (d.as_micros().min(u32::MAX as u128 - 1) as u32) + 1
}

fn unpack(v: u32) -> Option<f32> {
    (v != 0).then(|| (v - 1) as f32 / 1000.0)
}

impl LatencyProbe {
    pub fn new() -> Self {
        Self::default()
    }

    /// Callback de saída: `playback − callback`.
    pub fn store_output(&self, latency: Option<Duration>) {
        if let Some(d) = latency {
            self.output_us.store(pack(d), Ordering::Relaxed);
        }
    }

    /// Callback de entrada: `callback − capture`.
    pub fn store_input(&self, latency: Option<Duration>) {
        if let Some(d) = latency {
            self.input_us.store(pack(d), Ordering::Relaxed);
        }
    }

    /// Fila interna do renderizador (amostras já mixadas e ainda não entregues ao dispositivo).
    pub fn store_queued(&self, d: Duration) {
        self.queued_us.store(pack(d), Ordering::Relaxed);
    }

    /// Esquece as medições (ao trocar de dispositivo as antigas não valem).
    pub fn reset_output(&self) {
        self.output_us.store(0, Ordering::Relaxed);
        self.queued_us.store(0, Ordering::Relaxed);
    }

    pub fn reset_input(&self) {
        self.input_us.store(0, Ordering::Relaxed);
    }

    pub fn output_ms(&self) -> Option<f32> {
        unpack(self.output_us.load(Ordering::Relaxed))
    }

    pub fn input_ms(&self) -> Option<f32> {
        unpack(self.input_us.load(Ordering::Relaxed))
    }

    pub fn queued_ms(&self) -> f32 {
        unpack(self.queued_us.load(Ordering::Relaxed)).unwrap_or(0.0)
    }
}

/// Mediana móvel + limites. `update` é chamado ~1x/s.
#[derive(Debug, Clone)]
pub struct DelayEstimator {
    window: [f32; WINDOW],
    len: usize,
    head: usize,
    current: i32,
}

impl Default for DelayEstimator {
    fn default() -> Self {
        Self::new()
    }
}

impl DelayEstimator {
    pub fn new() -> Self {
        Self {
            window: [0.0; WINDOW],
            len: 0,
            head: 0,
            current: DEFAULT_DELAY_MS,
        }
    }

    pub fn current(&self) -> i32 {
        self.current
    }

    /// Medição bruta a partir da sonda: `None` se NENHUM dos dois lados tem timestamp.
    pub fn raw_from(probe: &LatencyProbe) -> Option<f32> {
        match (probe.output_ms(), probe.input_ms()) {
            (None, None) => None,
            (o, i) => Some(
                o.unwrap_or(MISSING_SIDE_MS) + i.unwrap_or(MISSING_SIDE_MS) + probe.queued_ms(),
            ),
        }
    }

    /// Incorpora uma medição (em ms) e devolve o novo atraso. `None` (sem timestamps) não polui a janela:
    /// se a janela está vazia o padrão é mantido; senão a última mediana continua valendo.
    pub fn update(&mut self, raw_ms: Option<f32>) -> i32 {
        let Some(raw) = raw_ms.filter(|v| v.is_finite() && *v >= 0.0) else {
            return self.current;
        };
        self.window[self.head] = raw;
        self.head = (self.head + 1) % WINDOW;
        self.len = (self.len + 1).min(WINDOW);

        let mut tmp = [0.0f32; WINDOW];
        tmp[..self.len].copy_from_slice(&self.window[..self.len]);
        let s = &mut tmp[..self.len];
        s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = if s.len() % 2 == 1 {
            s[s.len() / 2]
        } else {
            (s[s.len() / 2 - 1] + s[s.len() / 2]) / 2.0
        };
        self.current = (median.round() as i32).clamp(MIN_DELAY_MS, MAX_DELAY_MS);
        self.current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(v: u64) -> Option<Duration> {
        Some(Duration::from_millis(v))
    }

    #[test]
    fn falls_back_to_default_without_timestamps() {
        let probe = LatencyProbe::new();
        assert_eq!(DelayEstimator::raw_from(&probe), None);
        let mut e = DelayEstimator::new();
        assert_eq!(e.update(DelayEstimator::raw_from(&probe)), DEFAULT_DELAY_MS);
        assert_eq!(e.update(None), DEFAULT_DELAY_MS);
    }

    #[test]
    fn sums_output_input_and_queue() {
        let probe = LatencyProbe::new();
        probe.store_output(ms(25));
        probe.store_input(ms(15));
        probe.store_queued(Duration::from_millis(5));
        let raw = DelayEstimator::raw_from(&probe).unwrap();
        assert!((raw - 45.0).abs() < 0.01, "{raw}");
        let mut e = DelayEstimator::new();
        assert_eq!(e.update(Some(raw)), 45);
    }

    #[test]
    fn a_missing_side_uses_half_the_default() {
        let probe = LatencyProbe::new();
        probe.store_output(ms(40));
        let raw = DelayEstimator::raw_from(&probe).unwrap();
        assert!((raw - 70.0).abs() < 0.01);
    }

    #[test]
    fn zero_latency_counts_as_measured() {
        let probe = LatencyProbe::new();
        probe.store_output(ms(0));
        probe.store_input(ms(0));
        assert_eq!(DelayEstimator::raw_from(&probe), Some(0.0));
        let mut e = DelayEstimator::new();
        assert_eq!(e.update(Some(0.0)), MIN_DELAY_MS);
    }

    #[test]
    fn median_ignores_spikes() {
        let mut e = DelayEstimator::new();
        for v in [50.0, 52.0, 51.0, 300.0, 49.0] {
            e.update(Some(v));
        }
        assert_eq!(e.current(), 51);
    }

    #[test]
    fn follows_a_real_change_after_a_few_samples() {
        let mut e = DelayEstimator::new();
        for _ in 0..WINDOW {
            e.update(Some(40.0));
        }
        assert_eq!(e.current(), 40);
        for _ in 0..WINDOW {
            e.update(Some(120.0));
        }
        assert_eq!(e.current(), 120);
    }

    #[test]
    fn clamps_to_sane_limits_and_ignores_garbage() {
        let mut e = DelayEstimator::new();
        assert_eq!(e.update(Some(5000.0)), MAX_DELAY_MS);
        let mut e = DelayEstimator::new();
        assert_eq!(e.update(Some(1.0)), MIN_DELAY_MS);
        let mut e = DelayEstimator::new();
        assert_eq!(e.update(Some(f32::NAN)), DEFAULT_DELAY_MS);
        assert_eq!(e.update(Some(-3.0)), DEFAULT_DELAY_MS);
    }

    #[test]
    fn reset_forgets_measurements() {
        let probe = LatencyProbe::new();
        probe.store_output(ms(30));
        probe.store_input(ms(10));
        probe.reset_output();
        probe.reset_input();
        assert_eq!(DelayEstimator::raw_from(&probe), None);
    }
}
