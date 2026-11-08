//! Detecção de captura de tela PRETA persistente (lógica pura, sem dependências nativas).
//!
//! Por que existe: no macOS, sem a permissão de Gravação de Tela (ou com ela revogada), e no Windows/macOS com
//! janelas protegidas (DRM, aceleradas por GPU), o `scap` entrega quadros válidos, só que zerados. A pessoa
//! transmite e quem assiste vê preto, sem que nada acuse erro. O detector olha uma grade esparsa de pixels de
//! tempos em tempos e, se tudo estiver preto por vários segundos, avisa (e avisa de novo quando voltar ao normal).

use std::time::{Duration, Instant};

/// Quanto tempo seguido de preto absoluto antes de avisar (uma transição de tela preta legítima dura menos).
pub const BLACK_AFTER: Duration = Duration::from_secs(3);
/// Intervalo mínimo entre duas amostragens (a grade é pequena, mas não precisa ser olhada a 60 fps).
pub const SAMPLE_EVERY: Duration = Duration::from_millis(250);
/// Brilho máximo (por canal, 0 a 255) que ainda conta como preto.
const BLACK_LEVEL: u8 = 6;
/// Pontos amostrados por eixo.
const GRID: usize = 48;

/// `true` se todos os pontos da grade amostrada são pretos. `data` = pixels de 32 bits (B,G,R,A ou R,G,B,A: só os
/// três primeiros bytes importam, e a ordem não muda o resultado); `stride` em bytes (0 = `width * 4`).
pub fn is_black(data: &[u8], width: usize, height: usize, stride: usize) -> bool {
    if width == 0 || height == 0 {
        return false;
    }
    let stride = if stride == 0 { width * 4 } else { stride };
    if stride < width * 4 || data.len() < stride * (height - 1) + width * 4 {
        return false; // quadro inconsistente: não acusa
    }
    for gy in 0..GRID.min(height) {
        let y = gy * height / GRID.min(height);
        for gx in 0..GRID.min(width) {
            let x = gx * width / GRID.min(width);
            let i = y * stride + x * 4;
            if data[i] > BLACK_LEVEL || data[i + 1] > BLACK_LEVEL || data[i + 2] > BLACK_LEVEL {
                return false;
            }
        }
    }
    true
}

/// Estado do detector. `observe` devolve `Some(true)` quando a captura PASSA a ser considerada preta, `Some(false)`
/// quando volta ao normal depois de ter avisado, e `None` nos demais casos (nada a dizer).
#[derive(Debug, Default)]
pub struct BlackDetector {
    black_since: Option<Instant>,
    last_sample: Option<Instant>,
    flagged: bool,
}

impl BlackDetector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn observe(
        &mut self,
        now: Instant,
        data: &[u8],
        width: usize,
        height: usize,
        stride: usize,
    ) -> Option<bool> {
        if let Some(last) = self.last_sample {
            if now.saturating_duration_since(last) < SAMPLE_EVERY {
                return None;
            }
        }
        self.last_sample = Some(now);
        if is_black(data, width, height, stride) {
            let since = *self.black_since.get_or_insert(now);
            if !self.flagged && now.saturating_duration_since(since) >= BLACK_AFTER {
                self.flagged = true;
                return Some(true);
            }
            None
        } else {
            self.black_since = None;
            if self.flagged {
                self.flagged = false;
                return Some(false);
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: usize, h: usize, px: [u8; 4]) -> Vec<u8> {
        px.iter().copied().cycle().take(w * h * 4).collect()
    }

    #[test]
    fn all_zero_is_black_and_content_is_not() {
        assert!(is_black(&frame(64, 36, [0, 0, 0, 0]), 64, 36, 0));
        assert!(is_black(&frame(64, 36, [3, 2, 1, 255]), 64, 36, 0));
        assert!(!is_black(&frame(64, 36, [0, 0, 40, 255]), 64, 36, 0));
        assert!(!is_black(&frame(64, 36, [200, 200, 200, 0]), 64, 36, 0));
    }

    #[test]
    fn a_single_bright_region_is_enough_to_not_be_black() {
        let (w, h) = (1920, 1080);
        let mut f = frame(w, h, [0, 0, 0, 255]);
        // janela clara no centro (cobre vários pontos da grade)
        for y in 400..700 {
            for x in 800..1200 {
                let i = (y * w + x) * 4;
                f[i] = 255;
                f[i + 1] = 255;
                f[i + 2] = 255;
            }
        }
        assert!(!is_black(&f, w, h, 0));
    }

    #[test]
    fn inconsistent_frames_never_raise_a_false_alarm() {
        assert!(!is_black(&[], 0, 0, 0));
        assert!(!is_black(&[0u8; 10], 64, 36, 0));
        assert!(!is_black(&frame(8, 8, [0, 0, 0, 0]), 8, 8, 16)); // stride menor que a linha
    }

    #[test]
    fn stride_with_padding_is_respected() {
        let (w, h, stride) = (16, 8, 80);
        let mut f = vec![0u8; stride * h];
        assert!(is_black(&f, w, h, stride));
        f[stride * 3 + 4 * 5] = 90; // pixel (5, 3) claro
        assert!(!is_black(&f, w, h, stride));
    }

    #[test]
    fn warns_only_after_three_seconds_of_black_and_once() {
        let mut d = BlackDetector::new();
        let black = frame(32, 32, [0, 0, 0, 0]);
        let t0 = Instant::now();
        let mut warnings = 0;
        for i in 0..30u64 {
            let now = t0 + Duration::from_millis(i * 250);
            if d.observe(now, &black, 32, 32, 0) == Some(true) {
                warnings += 1;
                assert!(now - t0 >= BLACK_AFTER, "cedo demais: {:?}", now - t0);
            }
        }
        assert_eq!(warnings, 1, "avisa uma única vez");
    }

    #[test]
    fn a_short_black_flash_does_not_warn() {
        let mut d = BlackDetector::new();
        let black = frame(32, 32, [0, 0, 0, 0]);
        let lit = frame(32, 32, [90, 90, 90, 255]);
        let t0 = Instant::now();
        for i in 0..8u64 {
            assert_eq!(
                d.observe(t0 + Duration::from_millis(i * 250), &black, 32, 32, 0),
                None
            );
        }
        assert_eq!(
            d.observe(t0 + Duration::from_millis(2100), &lit, 32, 32, 0),
            None
        );
        // recomeçou do zero: mais 2 s de preto ainda não avisam
        for i in 0..8u64 {
            assert_eq!(
                d.observe(
                    t0 + Duration::from_millis(2400 + i * 250),
                    &black,
                    32,
                    32,
                    0
                ),
                None
            );
        }
    }

    #[test]
    fn recovery_is_reported_after_a_warning() {
        let mut d = BlackDetector::new();
        let black = frame(32, 32, [0, 0, 0, 0]);
        let lit = frame(32, 32, [90, 90, 90, 255]);
        let t0 = Instant::now();
        let mut flagged = false;
        for i in 0..20u64 {
            flagged |=
                d.observe(t0 + Duration::from_millis(i * 250), &black, 32, 32, 0) == Some(true);
        }
        assert!(flagged);
        assert_eq!(
            d.observe(t0 + Duration::from_millis(6000), &lit, 32, 32, 0),
            Some(false)
        );
        assert_eq!(
            d.observe(t0 + Duration::from_millis(6500), &lit, 32, 32, 0),
            None
        );
    }

    #[test]
    fn sampling_is_rate_limited() {
        let mut d = BlackDetector::new();
        let lit = frame(32, 32, [90, 90, 90, 255]);
        let black = frame(32, 32, [0, 0, 0, 0]);
        let t0 = Instant::now();
        d.observe(t0, &lit, 32, 32, 0);
        // dentro de 250 ms o quadro é ignorado (nem sequer é examinado)
        assert_eq!(
            d.observe(t0 + Duration::from_millis(50), &black, 32, 32, 0),
            None
        );
        assert!(d.black_since.is_none());
    }
}
