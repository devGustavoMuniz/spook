//! Qualidade do compartilhamento de tela (lógica pura, sem dependências nativas).
//!
//! Espelha `apps/web/src/features/voice/screen-quality.ts`: alturas 720/1080/1440, fps 15/30/60, prioridade
//! nitidez (`detail`) x fluidez (`motion`) e a mesma tabela de teto de bitrate. Sem `quality` o padrão é o que o
//! app já fazia: 1080p, 15 fps, nitidez, 2,5 Mbps.
//!
//! Mapeamento no Rust (ver `core.rs`):
//! * captura (`scap`): `fps` e redução do quadro para caber em `max_size()` (o `scap` captura na resolução da
//!   tela e o funil reduz; nunca amplia);
//! * publicação (LiveKit): `VideoEncoding { max_bitrate, max_framerate }` e `degradation_preference`
//!   (`detail` = manter resolução, `motion` = manter fps), o equivalente ao `contentHint` do navegador.

use serde::Deserialize;

pub const HEIGHTS: [u32; 3] = [720, 1080, 1440];
pub const FPS_OPTIONS: [u32; 3] = [15, 30, 60];
pub const MIN_BITRATE_KBPS: u32 = 300;
pub const MAX_BITRATE_KBPS: u32 = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    /// Nitidez (texto, código): mantém a resolução e descarta quadros se faltar banda.
    #[default]
    Detail,
    /// Fluidez (jogos, vídeo): mantém os quadros por segundo e reduz a resolução se faltar banda.
    Motion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScreenQuality {
    pub height: u32,
    pub fps: u32,
    pub priority: Priority,
    pub max_bitrate_kbps: Option<u32>,
}

impl Default for ScreenQuality {
    /// O que o app já fazia antes do ajuste de qualidade.
    fn default() -> Self {
        Self {
            height: 1080,
            fps: 15,
            priority: Priority::Detail,
            max_bitrate_kbps: None,
        }
    }
}

/// Teto de subida padrão (kbps) por altura e fps (tabela de `screen-quality.ts`).
fn base_kbps(height: u32, fps: u32) -> u32 {
    match (height, fps) {
        (720, 15) => 1500,
        (720, 30) => 2000,
        (720, 60) => 3500,
        (1080, 15) => 2500,
        (1080, 30) => 5000,
        (1080, 60) => 8000,
        (1440, 15) => 4000,
        (1440, 30) => 7000,
        (1440, 60) => 12000,
        _ => 2500,
    }
}

impl ScreenQuality {
    /// Valores fora da lista voltam ao padrão (campo a campo); o bitrate é limitado a 300..20000 kbps.
    pub fn normalized(self) -> Self {
        let d = Self::default();
        Self {
            height: if HEIGHTS.contains(&self.height) {
                self.height
            } else {
                d.height
            },
            fps: if FPS_OPTIONS.contains(&self.fps) {
                self.fps
            } else {
                d.fps
            },
            priority: self.priority,
            max_bitrate_kbps: self
                .max_bitrate_kbps
                .map(|k| k.clamp(MIN_BITRATE_KBPS, MAX_BITRATE_KBPS)),
        }
    }

    /// Teto de bitrate em kbps (o informado, ou o da tabela).
    pub fn bitrate_kbps(&self) -> u32 {
        self.max_bitrate_kbps
            .unwrap_or_else(|| base_kbps(self.height, self.fps))
    }

    /// Teto de bitrate em bits por segundo, como o `VideoEncoding` do LiveKit pede.
    pub fn max_bitrate_bps(&self) -> u64 {
        u64::from(self.bitrate_kbps()) * 1000
    }

    /// Caixa 16:9 em que o quadro cabe (largura, altura); o quadro nunca é ampliado.
    pub fn max_size(&self) -> (u32, u32) {
        let w = (self.height * 16 / 9) & !1;
        (w, self.height)
    }

    /// `true` quando a preferência é manter a resolução (nitidez); `false` mantém os quadros por segundo.
    pub fn keeps_resolution(&self) -> bool {
        self.priority == Priority::Detail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(height: u32, fps: u32) -> ScreenQuality {
        ScreenQuality {
            height,
            fps,
            ..Default::default()
        }
    }

    #[test]
    fn default_is_what_the_app_already_did() {
        let d = ScreenQuality::default();
        assert_eq!((d.height, d.fps), (1080, 15));
        assert_eq!(d.priority, Priority::Detail);
        assert_eq!(d.max_bitrate_bps(), 2_500_000);
        assert_eq!(d.max_size(), (1920, 1080));
        // coincide com os limites de antes (`limits::SHARE_*`)
        assert_eq!(d.fps, 15);
    }

    #[test]
    fn bitrate_table_matches_the_web() {
        let expected = [
            (720, 15, 1500),
            (720, 30, 2000),
            (720, 60, 3500),
            (1080, 15, 2500),
            (1080, 30, 5000),
            (1080, 60, 8000),
            (1440, 15, 4000),
            (1440, 30, 7000),
            (1440, 60, 12000),
        ];
        for (h, f, kbps) in expected {
            assert_eq!(q(h, f).bitrate_kbps(), kbps, "{h}p{f}");
            assert_eq!(q(h, f).max_bitrate_bps(), u64::from(kbps) * 1000);
        }
    }

    #[test]
    fn explicit_bitrate_wins_and_is_clamped() {
        let mut s = q(1080, 30);
        s.max_bitrate_kbps = Some(3000);
        assert_eq!(s.bitrate_kbps(), 3000);
        s.max_bitrate_kbps = Some(10);
        assert_eq!(s.normalized().bitrate_kbps(), 300);
        s.max_bitrate_kbps = Some(99_999);
        assert_eq!(s.normalized().bitrate_kbps(), 20_000);
    }

    #[test]
    fn capture_box_is_16_by_9_per_height() {
        assert_eq!(q(720, 15).max_size(), (1280, 720));
        assert_eq!(q(1080, 15).max_size(), (1920, 1080));
        assert_eq!(q(1440, 15).max_size(), (2560, 1440));
    }

    #[test]
    fn priority_maps_to_the_degradation_preference() {
        let mut s = q(720, 60);
        s.priority = Priority::Motion;
        assert!(!s.keeps_resolution());
        assert!(ScreenQuality::default().keeps_resolution());
    }

    #[test]
    fn invalid_values_fall_back_to_the_default() {
        let n = ScreenQuality {
            height: 999,
            fps: 24,
            priority: Priority::Motion,
            max_bitrate_kbps: None,
        }
        .normalized();
        assert_eq!((n.height, n.fps), (1080, 15));
        assert_eq!(n.priority, Priority::Motion);
        // valores válidos passam intactos
        assert_eq!(q(1440, 60).normalized(), q(1440, 60));
    }

    #[test]
    fn json_uses_camel_case_and_every_field_is_optional() {
        let s: ScreenQuality = serde_json::from_str(
            r#"{"height":720,"fps":60,"priority":"motion","maxBitrateKbps":4000}"#,
        )
        .unwrap();
        assert_eq!(
            s,
            ScreenQuality {
                height: 720,
                fps: 60,
                priority: Priority::Motion,
                max_bitrate_kbps: Some(4000)
            }
        );
        let d: ScreenQuality = serde_json::from_str("{}").unwrap();
        assert_eq!(d, ScreenQuality::default());
        assert!(serde_json::from_str::<ScreenQuality>(r#"{"priority":"x"}"#).is_err());
    }
}
