//! Reamostragem linear e conversão de canais (lógica pura). Basta para voz: o microfone é capturado na
//! taxa do dispositivo (44,1/48/96 kHz, 1–8 canais) e vira PCM 48 kHz mono; a reprodução faz o caminho
//! inverso.

/// Reamostrador linear com estado (sem cliques entre blocos). Modelo "empurra": cada bloco de entrada
/// produz os quadros de saída que ficam completos.
#[derive(Debug, Clone)]
pub struct LinearResampler {
    /// Amostras de entrada consumidas por amostra de saída (`taxa_entrada / taxa_saída`).
    step: f64,
    /// Posição fracionária da próxima saída entre `prev` (0.0) e a amostra seguinte (1.0).
    pos: f64,
    prev: f32,
    primed: bool,
}

impl LinearResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let in_rate = in_rate.max(1);
        let out_rate = out_rate.max(1);
        Self {
            step: in_rate as f64 / out_rate as f64,
            pos: 0.0,
            prev: 0.0,
            primed: false,
        }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &x in input {
            if !self.primed {
                self.prev = x;
                self.primed = true;
                continue;
            }
            while self.pos < 1.0 {
                out.push(self.prev + (x - self.prev) * self.pos as f32);
                self.pos += self.step;
            }
            self.pos -= 1.0;
            self.prev = x;
        }
    }
}

/// Média dos canais → mono.
pub fn downmix_to_mono(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    let channels = channels.max(1);
    if channels == 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    for frame in interleaved.chunks_exact(channels) {
        out.push(frame.iter().sum::<f32>() / channels as f32);
    }
}

pub fn f32_to_i16(x: f32) -> i16 {
    (x.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

pub fn i16_to_f32(x: i16) -> f32 {
    x as f32 / i16::MAX as f32
}

/// Acumula amostras mono e entrega quadros de tamanho fixo (10 ms = 480 amostras a 48 kHz).
#[derive(Debug)]
pub struct FrameChunker {
    size: usize,
    buf: Vec<i16>,
}

impl FrameChunker {
    pub fn new(size: usize) -> Self {
        Self {
            size: size.max(1),
            buf: Vec::new(),
        }
    }

    /// Empurra amostras e devolve (chamando `emit`) cada quadro completo.
    pub fn push(&mut self, samples: &[f32], mut emit: impl FnMut(Vec<i16>)) {
        self.buf.extend(samples.iter().map(|&s| f32_to_i16(s)));
        while self.buf.len() >= self.size {
            let rest = self.buf.split_off(self.size);
            let frame = std::mem::replace(&mut self.buf, rest);
            emit(frame);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    fn crossings(x: &[f32]) -> usize {
        x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count()
    }

    #[test]
    fn same_rate_is_nearly_identity() {
        let input = sine(440.0, 48_000, 4800);
        let mut r = LinearResampler::new(48_000, 48_000);
        let mut out = Vec::new();
        r.process(&input, &mut out);
        assert!(out.len() >= input.len() - 2 && out.len() <= input.len());
        assert!((out[100] - input[100]).abs() < 1e-5);
    }

    #[test]
    fn downsample_halves_the_length_and_keeps_the_pitch() {
        let input = sine(200.0, 48_000, 48_000);
        let mut r = LinearResampler::new(48_000, 24_000);
        let mut out = Vec::new();
        r.process(&input, &mut out);
        assert!((out.len() as i64 - 24_000).abs() <= 2, "len {}", out.len());
        // 200 Hz durante 1 s = ~200 cruzamentos
        assert!((crossings(&out) as i64 - 200).abs() <= 2);
    }

    #[test]
    fn upsample_44100_to_48000_is_chunk_invariant() {
        let input = sine(300.0, 44_100, 44_100);
        let mut whole = Vec::new();
        LinearResampler::new(44_100, 48_000).process(&input, &mut whole);
        let mut chunked = Vec::new();
        let mut r = LinearResampler::new(44_100, 48_000);
        for c in input.chunks(441) {
            r.process(c, &mut chunked);
        }
        assert_eq!(whole.len(), chunked.len());
        assert!((whole.len() as i64 - 48_000).abs() <= 3);
        assert!(whole
            .iter()
            .zip(&chunked)
            .all(|(a, b)| (a - b).abs() < 1e-6));
    }

    #[test]
    fn downmix_averages_channels() {
        let mut out = Vec::new();
        downmix_to_mono(&[1.0, 0.0, 0.5, 0.5], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
        let mut mono = Vec::new();
        downmix_to_mono(&[0.25, 0.75], 1, &mut mono);
        assert_eq!(mono, vec![0.25, 0.75]);
    }

    #[test]
    fn pcm_conversion_clamps() {
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), -i16::MAX);
        assert_eq!(f32_to_i16(0.0), 0);
        assert!((i16_to_f32(i16::MAX) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn chunker_emits_exact_frames() {
        let mut c = FrameChunker::new(480);
        let mut frames = Vec::new();
        c.push(&vec![0.1; 1000], |f| frames.push(f));
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|f| f.len() == 480));
        c.push(&[0.1; 500], |f| frames.push(f));
        assert_eq!(frames.len(), 3);
    }
}
