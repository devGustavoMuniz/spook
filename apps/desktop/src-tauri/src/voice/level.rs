//! Nível de supressão de ruído do microfone (lógica pura, sem libwebrtc nem tauri).
//!
//! Vocabulário igual ao da interface: `"off" | "standard" | "strong" | "max"`. O `"max"` (DeepFilterNet, IA mais
//! pesada) é ADICIONAL: os formatos antigos (`"off"`, `"standard"`, `"strong"` e o booleano das primeiras
//! versões) continuam válidos e significam o mesmo de antes.

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoiseSuppressionLevel {
    Off,
    Standard,
    Strong,
    /// DeepFilterNet3 (`deepfilter.rs`). Enquanto o modelo carrega, ou se o processador não aguentar, o RNNoise
    /// (Forte) cobre.
    Max,
}

impl NoiseSuppressionLevel {
    /// Só o nível Padrão usa o NS do APM do WebRTC; Forte e Máximo rodam fora dele (não se processa ruído duas vezes).
    pub fn uses_apm_ns(self) -> bool {
        self == Self::Standard
    }

    /// O DeepFilterNet é o supressor principal neste nível.
    pub fn wants_enhancer(self) -> bool {
        self == Self::Max
    }

    /// O RNNoise deve estar ligado agora? No Forte sempre; no Máximo só enquanto o DeepFilterNet NÃO está
    /// atendendo (carregando, falhou ou caiu por CPU): é a rede de segurança.
    pub fn wants_rnnoise(self, enhancer_serving: bool) -> bool {
        match self {
            Self::Strong => true,
            Self::Max => !enhancer_serving,
            Self::Off | Self::Standard => false,
        }
    }

    /// Há algum supressor fora do APM (RNNoise ou DeepFilterNet) neste nível?
    pub fn uses_native_denoiser(self) -> bool {
        matches!(self, Self::Strong | Self::Max)
    }

    /// Nome em texto (o mesmo do JSON).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Standard => "standard",
            Self::Strong => "strong",
            Self::Max => "max",
        }
    }
}

impl<'de> Deserialize<'de> for NoiseSuppressionLevel {
    /// Aceita o texto e também o booleano das versões anteriores da interface
    /// (`true` = padrão, `false` = desligada).
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "lowercase")]
        enum Named {
            Off,
            Standard,
            Strong,
            Max,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Legacy(bool),
            Level(Named),
        }
        Ok(match Raw::deserialize(d)? {
            Raw::Legacy(true) | Raw::Level(Named::Standard) => Self::Standard,
            Raw::Legacy(false) | Raw::Level(Named::Off) => Self::Off,
            Raw::Level(Named::Strong) => Self::Strong,
            Raw::Level(Named::Max) => Self::Max,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(j: &str) -> Result<NoiseSuppressionLevel, serde_json::Error> {
        serde_json::from_str(j)
    }

    #[test]
    fn json_accepts_all_levels_and_the_legacy_boolean() {
        assert_eq!(parse(r#""off""#).unwrap(), NoiseSuppressionLevel::Off);
        assert_eq!(
            parse(r#""standard""#).unwrap(),
            NoiseSuppressionLevel::Standard
        );
        assert_eq!(parse(r#""strong""#).unwrap(), NoiseSuppressionLevel::Strong);
        assert_eq!(parse(r#""max""#).unwrap(), NoiseSuppressionLevel::Max);
        assert_eq!(parse("true").unwrap(), NoiseSuppressionLevel::Standard);
        assert_eq!(parse("false").unwrap(), NoiseSuppressionLevel::Off);
        assert!(parse(r#""ultra""#).is_err());
        assert!(parse("3").is_err());
    }

    #[test]
    fn json_round_trips_every_level() {
        for l in [
            NoiseSuppressionLevel::Off,
            NoiseSuppressionLevel::Standard,
            NoiseSuppressionLevel::Strong,
            NoiseSuppressionLevel::Max,
        ] {
            let s = serde_json::to_string(&l).unwrap();
            assert_eq!(s, format!("\"{}\"", l.as_str()));
            assert_eq!(parse(&s).unwrap(), l);
        }
    }

    #[test]
    fn only_standard_uses_the_apm_ns() {
        assert!(NoiseSuppressionLevel::Standard.uses_apm_ns());
        for l in [
            NoiseSuppressionLevel::Off,
            NoiseSuppressionLevel::Strong,
            NoiseSuppressionLevel::Max,
        ] {
            assert!(!l.uses_apm_ns());
        }
    }

    #[test]
    fn rnnoise_covers_max_until_the_enhancer_is_serving() {
        use NoiseSuppressionLevel::*;
        assert!(Strong.wants_rnnoise(false) && Strong.wants_rnnoise(true));
        assert!(
            Max.wants_rnnoise(false),
            "carregando ou caiu: RNNoise cobre"
        );
        assert!(
            !Max.wants_rnnoise(true),
            "DeepFilterNet atendendo: sem RNNoise"
        );
        assert!(!Off.wants_rnnoise(false) && !Standard.wants_rnnoise(false));
        assert!(Max.wants_enhancer() && !Strong.wants_enhancer());
        assert!(Max.uses_native_denoiser() && Strong.uses_native_denoiser());
        assert!(!Standard.uses_native_denoiser() && !Off.uses_native_denoiser());
    }
}
