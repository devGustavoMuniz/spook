//! Porta de ruído (sensibilidade de entrada) do microfone. Lógica pura, sem libwebrtc/cpal/Tauri.
//!
//! Porta fiel do algoritmo de `apps/web/src/features/voice/gate-worklet.js` (decisão em SPEC.md 5.5, "Adicional:
//! volume por pessoa, teste de microfone e qualidade da tela"):
//!
//! * detector: potência suavizada (um polo, ~10 ms) em dBFS;
//! * lookahead de 10 ms: o áudio sai atrasado, então a porta abre ANTES de o início da palavra chegar à saída;
//! * attack 5 ms, hold 200 ms, release 80 ms: o ganho é uma rampa LINEAR (sem degraus, sem cliques);
//! * histerese de 4 dB: abre acima do limiar; só começa a fechar abaixo de (limiar − 4 dB) e depois do hold;
//! * `manual`: limiar fixo em dBFS; `auto`: limiar = piso de ruído estimado + 12 dB (limitado a −65..−25 dB), com
//!   o piso seguindo o MÍNIMO do nível (desce a 30 dB/s, sobe a 6 dB/s com a porta fechada e a 2 dB/s com ela
//!   aberta, para a fala não puxar o piso para cima);
//! * `off`: só mede (o sinal passa intacto e SEM o atraso do lookahead; ao ligar/desligar a porta há um crossfade
//!   de 10 ms entre o caminho direto e o caminho com lookahead, para não haver clique na troca). No web, `off`
//!   também mede mas mantém os 10 ms de atraso; aqui o caminho direto é preferido para não penalizar quem não usa a porta.
//!
//! Roda DEPOIS do AEC/NS/RNNoise e antes do `NativeAudioSource`, em qualquer nível de supressão.

use serde::{Deserialize, Serialize};

const LOOKAHEAD_S: f32 = 0.01;
const ATTACK_S: f32 = 0.005;
const HOLD_S: f32 = 0.2;
const RELEASE_S: f32 = 0.08;
const DETECTOR_TAU_S: f32 = 0.01;
const HYSTERESIS_DB: f32 = 4.0;
const AUTO_MARGIN_DB: f32 = 12.0;
const AUTO_MIN_THRESHOLD_DB: f32 = -65.0;
const AUTO_MAX_THRESHOLD_DB: f32 = -25.0;
const FLOOR_INIT_DB: f32 = -55.0;
const FLOOR_MIN_DB: f32 = -90.0;
const FLOOR_DOWN_DB_S: f32 = 30.0;
const FLOOR_UP_CLOSED_DB_S: f32 = 6.0;
const FLOOR_UP_OPEN_DB_S: f32 = 2.0;
const SILENCE_POWER: f32 = 1e-12;
/// Limites do limiar aceitos (como o worklet).
const MIN_THRESHOLD_DB: f32 = -90.0;
const MAX_THRESHOLD_DB: f32 = -5.0;
const DEFAULT_THRESHOLD_DB: f32 = -50.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GateMode {
    #[default]
    Off,
    Auto,
    Manual,
}

/// Mesmo formato da interface: `{ mode: "off" | "auto" | "manual", thresholdDb }`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InputSensitivity {
    pub mode: GateMode,
    pub threshold_db: f32,
}

impl Default for InputSensitivity {
    fn default() -> Self {
        Self {
            mode: GateMode::Off,
            threshold_db: DEFAULT_THRESHOLD_DB,
        }
    }
}

/// Estado instantâneo do medidor: nível pós-processamento (dBFS) e se a porta está aberta.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateLevel {
    pub db: f32,
    pub gate_open: bool,
}

fn to_power(db: f32) -> f32 {
    10f32.powf(db / 10.0)
}

fn to_db(power: f32) -> f32 {
    10.0 * (power + SILENCE_POWER).log10()
}

pub struct NoiseGate {
    sample_rate: f32,
    mode: GateMode,
    threshold_db: f32,
    delay: Vec<i16>,
    write_pos: usize,
    det_alpha: f32,
    hold_samples: i32,
    up_step: f32,
    down_step: f32,
    /// Quanto do sinal sai pelo caminho direto (1 = direto, 0 = passando pela porta).
    bypass: f32,
    bypass_step: f32,
    env: f32,
    gain: f32,
    open: bool,
    hold_left: i32,
    floor_db: f32,
}

impl NoiseGate {
    pub fn new(sample_rate: u32, sensitivity: InputSensitivity) -> Self {
        let sr = sample_rate.max(8_000) as f32;
        let mut g = Self {
            sample_rate: sr,
            mode: GateMode::Off,
            threshold_db: DEFAULT_THRESHOLD_DB,
            delay: vec![0; ((LOOKAHEAD_S * sr).round() as usize).max(1)],
            write_pos: 0,
            det_alpha: 1.0 - (-1.0 / (DETECTOR_TAU_S * sr)).exp(),
            hold_samples: (HOLD_S * sr).round() as i32,
            up_step: 1.0 / (ATTACK_S * sr),
            down_step: 1.0 / (RELEASE_S * sr),
            bypass: 1.0,
            bypass_step: 1.0 / (DETECTOR_TAU_S * sr),
            env: 0.0,
            gain: 0.0,
            open: false,
            hold_left: 0,
            floor_db: FLOOR_INIT_DB,
        };
        g.configure(sensitivity);
        g
    }

    /// Troca modo/limiar sem recriar nem zerar o estado (vale já no próximo quadro).
    pub fn configure(&mut self, s: InputSensitivity) {
        self.mode = s.mode;
        if s.threshold_db.is_finite() {
            self.threshold_db = s.threshold_db.clamp(MIN_THRESHOLD_DB, MAX_THRESHOLD_DB);
        }
    }

    pub fn sensitivity(&self) -> InputSensitivity {
        InputSensitivity {
            mode: self.mode,
            threshold_db: self.threshold_db,
        }
    }

    /// Atraso (lookahead) que a porta adiciona ao áudio, em amostras.
    pub fn latency_samples(&self) -> usize {
        self.delay.len()
    }

    fn effective_threshold_db(&self) -> f32 {
        match self.mode {
            GateMode::Auto => {
                (self.floor_db + AUTO_MARGIN_DB).clamp(AUTO_MIN_THRESHOLD_DB, AUTO_MAX_THRESHOLD_DB)
            }
            _ => self.threshold_db,
        }
    }

    /// Processa `frame` no lugar (qualquer tamanho) e devolve o nível/estado ao fim do quadro.
    pub fn process(&mut self, frame: &mut [i16]) -> GateLevel {
        let off = self.mode == GateMode::Off;
        let th_db = self.effective_threshold_db();
        let open_pow = to_power(th_db);
        let close_pow = to_power(th_db - HYSTERESIS_DB);
        let len = self.delay.len();
        let mut wp = self.write_pos;

        for s in frame.iter_mut() {
            let x = *s as f32 / 32768.0;
            self.env += self.det_alpha * (x * x - self.env);

            if off || self.env >= open_pow {
                self.open = true;
                self.hold_left = self.hold_samples;
            } else if self.open {
                if self.env >= close_pow {
                    self.hold_left = self.hold_samples;
                } else {
                    self.hold_left -= 1;
                    if self.hold_left <= 0 {
                        self.open = false;
                    }
                }
            }
            self.gain = if self.open {
                (self.gain + self.up_step).min(1.0)
            } else {
                (self.gain - self.down_step).max(0.0)
            };

            self.bypass = if off {
                (self.bypass + self.bypass_step).min(1.0)
            } else {
                (self.bypass - self.bypass_step).max(0.0)
            };

            let direct = *s;
            let delayed = self.delay[wp];
            self.delay[wp] = direct;
            wp = if wp + 1 == len { 0 } else { wp + 1 };
            if self.bypass < 1.0 {
                let gated = delayed as f32 * self.gain;
                let mixed = if self.bypass <= 0.0 {
                    gated
                } else {
                    gated * (1.0 - self.bypass) + direct as f32 * self.bypass
                };
                *s = mixed.round().clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            }
        }
        self.write_pos = wp;

        let db = to_db(self.env);
        if self.mode == GateMode::Auto {
            self.track_floor(db, frame.len() as f32 / self.sample_rate);
        }
        GateLevel {
            db,
            gate_open: self.open,
        }
    }

    /// Piso de ruído por estatística de mínimos: desce rápido, sobe devagar (mais devagar com a porta aberta).
    fn track_floor(&mut self, level_db: f32, dt: f32) {
        if level_db <= self.floor_db {
            self.floor_db = FLOOR_MIN_DB.max(level_db.max(self.floor_db - FLOOR_DOWN_DB_S * dt));
        } else {
            let rate = if self.open {
                FLOOR_UP_OPEN_DB_S
            } else {
                FLOOR_UP_CLOSED_DB_S
            };
            self.floor_db = level_db.min(self.floor_db + rate * dt);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;
    const BLOCK: usize = 480;

    fn db_to_amp(db: f32) -> f32 {
        10f32.powf(db / 20.0)
    }

    fn manual(th: f32) -> NoiseGate {
        NoiseGate::new(
            SR,
            InputSensitivity {
                mode: GateMode::Manual,
                threshold_db: th,
            },
        )
    }

    fn auto() -> NoiseGate {
        NoiseGate::new(
            SR,
            InputSensitivity {
                mode: GateMode::Auto,
                threshold_db: -50.0,
            },
        )
    }

    /// Ruído branco determinístico (LCG) com RMS `db`.
    fn noise(seconds: f32, db: f32, seed: u32) -> Vec<i16> {
        let n = (seconds * SR as f32) as usize;
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let u = s as f32 / u32::MAX as f32;
                ((u * 2.0 - 1.0) * 3f32.sqrt() * db_to_amp(db) * 32768.0) as i16
            })
            .collect()
    }

    /// "Voz" sintética: 150 Hz com harmônico, RMS `db`.
    fn voice(seconds: f32, db: f32) -> Vec<i16> {
        let n = (seconds * SR as f32) as usize;
        let raw: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                (2.0 * std::f32::consts::PI * 150.0 * t).sin()
                    + 0.5 * (2.0 * std::f32::consts::PI * 300.0 * t).sin()
            })
            .collect();
        let rms = (raw.iter().map(|v| v * v).sum::<f32>() / n as f32).sqrt();
        raw.iter()
            .map(|v| (v / rms * db_to_amp(db) * 32768.0) as i16)
            .collect()
    }

    fn run(g: &mut NoiseGate, signal: &[i16]) -> Vec<i16> {
        let mut out = signal.to_vec();
        for chunk in out.chunks_mut(BLOCK) {
            g.process(chunk);
        }
        out
    }

    fn rms_db(s: &[i16]) -> f32 {
        let acc: f64 = s
            .iter()
            .map(|&v| {
                let x = v as f64 / 32768.0;
                x * x
            })
            .sum();
        (10.0 * (acc / s.len().max(1) as f64 + 1e-20).log10()) as f32
    }

    fn seconds(s: f32) -> usize {
        (s * SR as f32) as usize
    }

    #[test]
    fn manual_closes_with_noise_below_the_threshold() {
        let mut g = manual(-50.0);
        let out = run(&mut g, &noise(1.0, -65.0, 1));
        // depois do release a saída é silêncio
        let tail = &out[seconds(0.5)..];
        assert!(rms_db(tail) < -90.0, "{}", rms_db(tail));
        let lvl = g.process(&mut [0i16; BLOCK]);
        assert!(!lvl.gate_open);
    }

    #[test]
    fn manual_opens_with_voice_above_the_threshold_keeping_the_level() {
        let mut g = manual(-50.0);
        let v = voice(1.0, -30.0);
        let out = run(&mut g, &v);
        let body = seconds(0.3)..seconds(0.9);
        let diff = (rms_db(&out[body.clone()]) - rms_db(&v[body])).abs();
        assert!(diff < 0.5, "diferença {diff} dB");
    }

    #[test]
    fn lookahead_lets_the_start_of_the_word_through_whole() {
        let mut g = manual(-50.0);
        let mut signal = vec![0i16; seconds(0.5)];
        signal.extend(voice(0.5, -25.0));
        let start = seconds(0.5);
        let out = run(&mut g, &signal);
        // a saída é a entrada atrasada de 10 ms; os 10 ms depois do início já estão no nível pleno
        let lat = g.latency_samples();
        assert_eq!(lat, 480);
        let first = &out[start + lat + 480..start + lat + 960];
        let want = &signal[start + 480..start + 960];
        assert!((rms_db(first) - rms_db(want)).abs() < 1.0);
        // e a porta já subiu (gain 1) quando o primeiro pico chega à saída
        let peak_in = signal[start..start + 480]
            .iter()
            .map(|s| s.unsigned_abs())
            .max()
            .unwrap();
        let peak_out = out[start + lat..start + lat + 480]
            .iter()
            .map(|s| s.unsigned_abs())
            .max()
            .unwrap();
        assert!(
            peak_out as f32 > peak_in as f32 * 0.5,
            "{peak_out} vs {peak_in}"
        );
    }

    #[test]
    fn hold_keeps_the_gate_open_about_200ms_then_closes() {
        let state_after = |tail_s: f32| {
            let mut g = manual(-50.0);
            let mut signal = voice(0.5, -25.0);
            signal.extend(vec![0i16; seconds(tail_s)]);
            let mut st = g.process(&mut [0i16; 1]);
            for chunk in signal.chunks_mut(BLOCK) {
                st = g.process(chunk);
            }
            st
        };
        assert!(state_after(0.1).gate_open, "aberta 100 ms depois do fim");
        assert!(!state_after(0.5).gate_open, "fechada 500 ms depois do fim");
        // e a saída fica em silêncio total depois do release
        let mut g = manual(-50.0);
        let mut signal = voice(0.5, -25.0);
        let end = signal.len();
        signal.extend(vec![0i16; seconds(1.0)]);
        let out = run(&mut g, &signal);
        assert!(rms_db(&out[end + seconds(0.6)..]) < -90.0);
    }

    #[test]
    fn opening_and_closing_do_not_click() {
        let mut g = manual(-50.0);
        let mut signal = vec![0i16; seconds(0.3)];
        signal.extend(voice(0.5, -25.0));
        signal.extend(vec![0i16; seconds(0.8)]);
        let out = run(&mut g, &signal);
        let max_step = |s: &[i16]| {
            s.windows(2)
                .map(|w| (w[1] as i32 - w[0] as i32).abs())
                .max()
                .unwrap_or(0)
        };
        let voice_step = max_step(&signal);
        let out_step = max_step(&out);
        assert!(
            out_step as f32 <= voice_step as f32 * 1.2 + 4.0,
            "salto {out_step} vs voz {voice_step}"
        );
    }

    #[test]
    fn threshold_changes_apply_without_recreating_the_gate() {
        let mut g = manual(-50.0);
        let v = voice(0.5, -45.0);
        let open = run(&mut g, &v);
        assert!(rms_db(&open[seconds(0.3)..]) > -50.0);
        g.configure(InputSensitivity {
            mode: GateMode::Manual,
            threshold_db: -30.0,
        });
        let closed = run(&mut g, &voice(1.0, -45.0));
        assert!(rms_db(&closed[seconds(0.8)..]) < -90.0);
    }

    #[test]
    fn off_mode_passes_the_signal_untouched_and_keeps_measuring() {
        let mut g = NoiseGate::new(SR, InputSensitivity::default());
        let v = voice(0.5, -60.0);
        let out = run(&mut g, &v);
        // desligada, o sinal passa intacto (sem atraso nem ganho)
        assert!(
            out[seconds(0.05)..] == v[seconds(0.05)..],
            "passa sem alteração"
        );
        let lvl = g.process(&mut [0i16; BLOCK]);
        assert!(lvl.db < -50.0 && lvl.db > -90.0, "mede o nível: {}", lvl.db);
    }

    #[test]
    fn switching_between_off_and_active_does_not_click() {
        let mut g = NoiseGate::new(SR, InputSensitivity::default());
        let v = voice(2.0, -25.0);
        let mut out = Vec::new();
        for (i, chunk) in v.chunks(BLOCK).enumerate() {
            // alterna a cada 0,25 s entre desligada e manual (a voz está bem acima do limiar)
            let mode = if (i / 25) % 2 == 0 {
                GateMode::Off
            } else {
                GateMode::Manual
            };
            g.configure(InputSensitivity {
                mode,
                threshold_db: -50.0,
            });
            let mut c = chunk.to_vec();
            g.process(&mut c);
            out.extend(c);
        }
        let max_step = |s: &[i16]| {
            s.windows(2)
                .map(|w| (w[1] as i32 - w[0] as i32).abs())
                .max()
                .unwrap_or(0)
        };
        let from = seconds(0.1);
        assert!(
            max_step(&out[from..]) as f32 <= max_step(&v[from..]) as f32 * 1.6 + 8.0,
            "salto {} vs voz {}",
            max_step(&out[from..]),
            max_step(&v[from..])
        );
    }

    #[test]
    fn meter_reports_the_signal_level() {
        let mut g = manual(-80.0);
        let mut last = GateLevel {
            db: -100.0,
            gate_open: false,
        };
        for chunk in voice(0.5, -20.0).chunks_mut(BLOCK) {
            last = g.process(chunk);
        }
        assert!((last.db - -20.0).abs() < 3.0, "{}", last.db);
        assert!(last.gate_open);
    }

    #[test]
    fn auto_learns_the_floor_closes_with_noise_and_opens_with_voice() {
        let mut g = auto();
        let out = run(&mut g, &noise(4.0, -50.0, 3));
        // depois de aprender, o ruído constante fica abaixo do limiar: porta fechada
        assert!(rms_db(&out[seconds(3.0)..]) < -90.0);
        // a voz bem acima passa
        let v = voice(1.0, -25.0);
        let o = run(&mut g, &v);
        assert!((rms_db(&o[seconds(0.3)..]) - rms_db(&v[seconds(0.3)..])).abs() < 1.5);
    }

    #[test]
    fn auto_follows_a_louder_fan_and_still_passes_the_voice() {
        let mut g = auto();
        run(&mut g, &noise(3.0, -60.0, 5));
        // ventilador novo e mais alto: no início ainda abre a porta; depois de ~10 s o piso sobe e ela fecha
        let mut early_open = false;
        for chunk in noise(1.0, -40.0, 6).chunks_mut(BLOCK) {
            early_open |= g.process(chunk).gate_open;
        }
        assert!(early_open, "o ruído novo, mais alto, ainda abre a porta");
        run(&mut g, &noise(13.0, -40.0, 7));
        let tail = run(&mut g, &noise(1.0, -40.0, 8));
        assert!(
            rms_db(&tail[seconds(0.5)..]) < -90.0,
            "o piso subiu e a porta fechou"
        );
        let v = voice(1.0, -20.0);
        let o = run(&mut g, &v);
        assert!((rms_db(&o[seconds(0.3)..]) - rms_db(&v[seconds(0.3)..])).abs() < 1.5);
    }

    #[test]
    fn extreme_samples_do_not_overflow() {
        let mut g = manual(-50.0);
        let mut buf = [i16::MIN, i16::MAX].repeat(2400);
        run(&mut g, &buf.clone());
        let lvl = g.process(&mut buf);
        assert!(lvl.db.is_finite());
    }

    #[test]
    fn sensitivity_json_uses_camel_case_and_defaults_to_off() {
        let s: InputSensitivity =
            serde_json::from_str(r#"{"mode":"manual","thresholdDb":-42.5}"#).unwrap();
        assert_eq!(s.mode, GateMode::Manual);
        assert_eq!(s.threshold_db, -42.5);
        let d: InputSensitivity = serde_json::from_str("{}").unwrap();
        assert_eq!(d, InputSensitivity::default());
        assert_eq!(d.mode, GateMode::Off);
        let a: InputSensitivity = serde_json::from_str(r#"{"mode":"auto"}"#).unwrap();
        assert_eq!(a.mode, GateMode::Auto);
        assert!(serde_json::from_str::<InputSensitivity>(r#"{"mode":"x"}"#).is_err());
    }

    #[test]
    fn out_of_range_thresholds_are_clamped() {
        let mut g = manual(-200.0);
        assert_eq!(g.sensitivity().threshold_db, -90.0);
        g.configure(InputSensitivity {
            mode: GateMode::Manual,
            threshold_db: 10.0,
        });
        assert_eq!(g.sensitivity().threshold_db, -5.0);
        g.configure(InputSensitivity {
            mode: GateMode::Manual,
            threshold_db: f32::NAN,
        });
        assert_eq!(g.sensitivity().threshold_db, -5.0);
    }
}
