//! Supressão de ruído "Forte" (IA): RNNoise (Xiph.Org) via `nnnoiseless`, port em Rust puro (BSD-3-Clause).
//!
//! Módulo PURO (sem libwebrtc nem tauri) para ser testado isoladamente. Opera nos mesmos quadros de 10 ms
//! (480 amostras, 48 kHz mono, `i16`) do pipeline do microfone, no lugar.
//!
//! Detalhes que importam:
//!
//! * **Escala:** o RNNoise espera amostras `f32` na escala de `i16` (±32768), não ±1.0.
//! * **Primeiro quadro:** o estado novo devolve um quadro atenuado/de aquecimento (estalo na entrada). Ele é
//!   processado (para aquecer o estado) mas a saída é descartada: sai o quadro original e só depois o
//!   efeito entra em fade.
//! * **Liga/desliga sem estalo:** a mistura entre o sinal original ("seco") e o processado ("molhado") sobe
//!   ou desce linearmente ao longo de um quadro (10 ms). Totalmente desligado, o `DenoiseState` não roda (zero
//!   CPU) e é recriado ao religar, porque o estado antigo está defasado.
//! * **Caminho quente sem alocação:** `process` só usa os dois buffers de 480 `f32` do próprio struct e o
//!   `DenoiseState` (que guarda seus buffers internos em arrays fixos; `process_frame` não aloca). A única
//!   alocação (`DenoiseState::new`, ~100 kB) ocorre em `set_enabled(true)`, fora do callback de áudio.
//! * O RNNoise tem ~10 ms de atraso algorítmico; durante o fade de 10 ms o seco e o molhado ficam levemente
//!   defasados, o que é inaudível numa transição tão curta.

use nnnoiseless::DenoiseState;

/// Tamanho do quadro do RNNoise (10 ms a 48 kHz).
pub const FRAME: usize = DenoiseState::FRAME_SIZE;

pub struct Denoiser {
    state: Option<Box<DenoiseState<'static>>>,
    target_on: bool,
    /// Mistura atual: 0.0 = só seco (original), 1.0 = só molhado (RNNoise).
    mix: f32,
    /// Quadros de aquecimento que ainda faltam (a saída deles é descartada).
    warmup: u8,
    input: [f32; FRAME],
    output: [f32; FRAME],
}

impl Default for Denoiser {
    fn default() -> Self {
        Self::new()
    }
}

impl Denoiser {
    /// Nasce desligado e sem alocar o estado do modelo.
    pub fn new() -> Self {
        Self {
            state: None,
            target_on: false,
            mix: 0.0,
            warmup: 0,
            input: [0.0; FRAME],
            output: [0.0; FRAME],
        }
    }

    /// Liga ou desliga. NÃO chamar do callback de áudio: ligar do zero aloca o estado do modelo.
    pub fn set_enabled(&mut self, on: bool) {
        if on == self.target_on {
            return;
        }
        self.target_on = on;
        if on && self.state.is_none() {
            self.state = Some(DenoiseState::new());
            self.warmup = 1;
            self.mix = 0.0;
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.target_on
    }

    /// Há algo a fazer (ligado, ou ainda desvanecendo)? Falso = o quadro passa intacto, sem custo.
    pub fn is_active(&self) -> bool {
        self.target_on || self.mix > 0.0
    }

    /// Processa um quadro de 480 amostras no lugar. Devolve `false` (sem tocar) se o tamanho está errado ou
    /// se o processador está totalmente desligado.
    pub fn process(&mut self, frame: &mut [i16]) -> bool {
        if frame.len() != FRAME || !self.is_active() {
            if !self.target_on && self.mix <= 0.0 && self.state.is_some() {
                // Terminou o fade-out: libera o estado (evita manter ~100 kB e um estado defasado). Acontece
                // uma única vez por desligamento, na thread que processa o microfone (não no callback do cpal).
                self.state = None;
            }
            return false;
        }
        let Some(state) = self.state.as_mut() else {
            return false;
        };
        for (d, &s) in self.input.iter_mut().zip(frame.iter()) {
            *d = s as f32;
        }
        state.process_frame(&mut self.output, &self.input);

        if self.warmup > 0 {
            // Saída de aquecimento: descarta (o quadro segue original).
            self.warmup -= 1;
            return true;
        }

        let target = if self.target_on { 1.0 } else { 0.0 };
        let step = 1.0 / FRAME as f32;
        let mut mix = self.mix;
        for ((out, &dry), &wet) in frame
            .iter_mut()
            .zip(self.input.iter())
            .zip(self.output.iter())
        {
            if mix < target {
                mix = (mix + step).min(target);
            } else if mix > target {
                mix = (mix - step).max(target);
            }
            let v = dry + (wet - dry) * mix;
            *out = v.round().clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        }
        self.mix = mix;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    /// LCG determinístico em [-1, 1].
    struct Rng(u32);
    impl Rng {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (self.0 >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        }
    }

    /// Voz sintética: harmônicos de ~130 Hz com envelope silábico (4 Hz), amplitude de pico ~`amp`.
    fn voice(n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f32 / RATE;
                let env = (0.5 + 0.5 * (2.0 * std::f32::consts::PI * 4.0 * t).sin()).powf(0.7);
                let mut s = 0.0;
                for h in 1..=12 {
                    let f = 130.0 * h as f32;
                    let formant = 1.0 / (1.0 + ((f - 700.0) / 400.0).powi(2))
                        + 0.6 / (1.0 + ((f - 1800.0) / 500.0).powi(2));
                    s += formant / h as f32 * (2.0 * std::f32::consts::PI * f * t).sin();
                }
                s * env * amp * 0.5
            })
            .collect()
    }

    /// Ventilador: ruído branco suavizado (passa-baixas de um polo) + cliques de teclado esparsos.
    fn fan_and_clicks(n: usize, amp: f32) -> Vec<f32> {
        let mut rng = Rng(99);
        let mut lp = 0.0;
        (0..n)
            .map(|i| {
                lp += 0.15 * (rng.next() - lp);
                let click = if i % 24_000 < 40 {
                    rng.next() * 0.8
                } else {
                    0.0
                };
                lp * amp * 2.0 + click * amp
            })
            .collect()
    }

    fn to_i16(x: &[f32]) -> Vec<i16> {
        x.iter()
            .map(|&v| v.clamp(-32768.0, 32767.0) as i16)
            .collect()
    }

    fn rms(x: &[i16]) -> f64 {
        (x.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt()
    }

    fn run(d: &mut Denoiser, input: &[i16]) -> Vec<i16> {
        let mut out = Vec::with_capacity(input.len());
        for c in input.chunks_exact(FRAME) {
            let mut q = c.to_vec();
            d.process(&mut q);
            out.extend(q);
        }
        out
    }

    #[test]
    fn noise_drops_and_voice_is_preserved() {
        let n = 48_000 * 6;
        let clean = voice(n, 8000.0);
        let noise = fan_and_clicks(n, 1500.0);
        let noisy: Vec<f32> = clean.iter().zip(&noise).map(|(a, b)| a + b).collect();

        // 1) ruído sozinho (sem voz): deve cair bastante.
        let mut d = Denoiser::new();
        d.set_enabled(true);
        let noise_i = to_i16(&noise);
        let out_noise = run(&mut d, &noise_i);
        let tail = 48_000 * 2; // pula o aquecimento do modelo
        let drop_db = 20.0 * (rms(&noise_i[tail..]) / rms(&out_noise[tail..]).max(1e-9)).log10();
        eprintln!("ruído sozinho: redução = {drop_db:.1} dB");
        assert!(
            drop_db > 10.0,
            "ruído deveria cair > 10 dB, caiu {drop_db:.1}"
        );

        // 2) voz + ruído: o que sobra deve estar perto da voz limpa (energia da voz preservada).
        let mut d = Denoiser::new();
        d.set_enabled(true);
        let noisy_i = to_i16(&noisy);
        let out = run(&mut d, &noisy_i);
        let clean_i = to_i16(&clean);
        let v_in = rms(&noisy_i[tail..]);
        let v_out = rms(&out[tail..]);
        let v_clean = rms(&clean_i[tail..]);
        eprintln!("rms limpa {v_clean:.0}, com ruído {v_in:.0}, saída {v_out:.0}");
        let ratio_db = 20.0 * (v_out / v_clean).log10();
        assert!(
            ratio_db.abs() < 4.0,
            "a voz deveria ser preservada (±4 dB da limpa), diferença {ratio_db:.1} dB"
        );
        assert!(v_out < v_in, "a saída deve ser mais limpa que a entrada");
    }

    #[test]
    fn first_frame_does_not_click() {
        let mut d = Denoiser::new();
        d.set_enabled(true);
        let v = to_i16(&voice(FRAME * 4, 8000.0));
        let out = run(&mut d, &v);
        // O primeiro quadro sai idêntico ao original (aquecimento descartado).
        assert_eq!(&out[..FRAME], &v[..FRAME]);
        // Sem saltos grandes entre amostras vizinhas ao longo da transição.
        let max_jump_in = v
            .windows(2)
            .map(|w| (w[1] as i32 - w[0] as i32).abs())
            .max()
            .unwrap();
        let max_jump_out = out
            .windows(2)
            .map(|w| (w[1] as i32 - w[0] as i32).abs())
            .max()
            .unwrap();
        assert!(
            max_jump_out <= max_jump_in * 2 + 200,
            "salto na saída {max_jump_out} vs entrada {max_jump_in}"
        );
    }

    #[test]
    fn toggling_is_continuous() {
        let n = FRAME * 300;
        let v = to_i16(&voice(n, 6000.0));
        let mut d = Denoiser::new();
        let mut out = Vec::new();
        for (i, c) in v.chunks_exact(FRAME).enumerate() {
            d.set_enabled((i / 40) % 2 == 1); // alterna a cada 400 ms
            let mut q = c.to_vec();
            d.process(&mut q);
            out.extend(q);
        }
        let max_jump_in = v
            .windows(2)
            .map(|w| (w[1] as i32 - w[0] as i32).abs())
            .max()
            .unwrap();
        let max_jump_out = out
            .windows(2)
            .map(|w| (w[1] as i32 - w[0] as i32).abs())
            .max()
            .unwrap();
        assert!(
            max_jump_out <= max_jump_in * 3 + 300,
            "descontinuidade ao ligar/desligar: {max_jump_out} (entrada {max_jump_in})"
        );
    }

    #[test]
    fn disabled_is_a_bit_exact_passthrough() {
        let v = to_i16(&voice(FRAME * 10, 6000.0));
        let mut d = Denoiser::new();
        let mut q = v[..FRAME].to_vec();
        assert!(!d.process(&mut q));
        assert_eq!(q, &v[..FRAME]);
    }

    #[test]
    fn state_is_released_after_fade_out() {
        let v = to_i16(&voice(FRAME * 10, 6000.0));
        let mut d = Denoiser::new();
        d.set_enabled(true);
        run(&mut d, &v);
        d.set_enabled(false);
        run(&mut d, &v); // fade-out de 1 quadro e depois bypass
        let mut q = v[..FRAME].to_vec();
        assert!(!d.process(&mut q));
        assert!(!d.is_active());
        assert!(d.state.is_none());
    }

    #[test]
    fn denoiser_can_move_across_threads() {
        fn assert_send<T: Send>() {}
        assert_send::<Denoiser>();
    }

    #[test]
    fn wrong_sizes_never_panic() {
        let mut d = Denoiser::new();
        d.set_enabled(true);
        for len in [0, 1, 479, 481, 960] {
            let mut q = vec![1000i16; len];
            assert!(!d.process(&mut q));
            assert!(q.iter().all(|&s| s == 1000));
        }
    }

    #[test]
    fn extreme_samples_do_not_overflow() {
        let mut d = Denoiser::new();
        d.set_enabled(true);
        let loud: Vec<i16> = (0..FRAME * 20)
            .map(|i| {
                if (i / 20) % 2 == 0 {
                    i16::MAX
                } else {
                    i16::MIN
                }
            })
            .collect();
        let _ = run(&mut d, &loud);
    }
}
