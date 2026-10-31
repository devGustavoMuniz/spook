//! Mixer do áudio remoto (lógica pura). Cada faixa remota tem uma fila de PCM 48 kHz mono; o callback de
//! saída do cpal chama `mix_into` e recebe a soma (com saturação). Tudo atrás de um `Mutex` curto.
//! "Ensurdecer" descarta o que chega e toca silêncio, para não voltar com áudio velho.
//!
//! **Volume por pessoa:** cada fila pode ser ligada (`bind`) a uma pessoa e a uma origem (voz ou áudio da tela).
//! O ganho (0 a 2,0 = 200%) é guardado por (pessoa, origem), vale para as faixas de agora e as que a pessoa
//! republicar, e é aplicado na soma com saturação. Mudanças de ganho entram em rampa linear dentro do bloco
//! (10 ms), sem estalo. Volume 0 silencia só para quem ouve (a fila continua sendo consumida).

use std::collections::{HashMap, VecDeque};

use serde::Deserialize;

/// Quanto cada fila guarda (200 ms a 48 kHz). Passou disso, descarta o mais antigo: a latência fica limitada.
pub const MAX_BUFFERED: usize = 9_600;

/// Maior ganho aceito (200%).
pub const MAX_GAIN: f32 = 2.0;

/// Origem do áudio de uma pessoa: o microfone ou o som da tela compartilhada.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSource {
    Voice,
    Screen,
}

/// Normaliza o volume pedido: NaN vira 100%, e o resultado fica entre 0 e `MAX_GAIN`.
pub fn clamp_gain(volume: f32) -> f32 {
    if volume.is_nan() {
        1.0
    } else {
        volume.clamp(0.0, MAX_GAIN)
    }
}

#[derive(Debug, Default)]
struct Queue {
    samples: VecDeque<i16>,
    key: Option<(String, AudioSource)>,
    /// Ganho aplicado no fim do último bloco (`None` = ainda não tocou: nasce já no valor-alvo).
    gain: Option<f32>,
}

#[derive(Debug, Default)]
pub struct Mixer {
    queues: HashMap<String, Queue>,
    gains: HashMap<(String, AudioSource), f32>,
    deafened: bool,
}

impl Mixer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_deafened(&mut self, deafened: bool) {
        self.deafened = deafened;
        if deafened {
            for q in self.queues.values_mut() {
                q.samples.clear();
            }
        }
    }

    pub fn is_deafened(&self) -> bool {
        self.deafened
    }

    pub fn push(&mut self, id: &str, samples: &[i16]) {
        if self.deafened {
            return;
        }
        let q = self.queues.entry(id.to_string()).or_default();
        q.samples.extend(samples.iter().copied());
        let excess = q.samples.len().saturating_sub(MAX_BUFFERED);
        if excess > 0 {
            q.samples.drain(..excess);
        }
    }

    /// Liga a fila `id` a uma pessoa e origem (o ganho dessa dupla passa a valer nela).
    pub fn bind(&mut self, id: &str, identity: &str, source: AudioSource) {
        let q = self.queues.entry(id.to_string()).or_default();
        q.key = Some((identity.to_string(), source));
    }

    /// Define o volume (1,0 = 100%) de uma pessoa/origem. Vale para as filas atuais e futuras.
    pub fn set_participant_gain(&mut self, identity: &str, source: AudioSource, volume: f32) {
        let g = clamp_gain(volume);
        if g == 1.0 {
            self.gains.remove(&(identity.to_string(), source));
        } else {
            self.gains.insert((identity.to_string(), source), g);
        }
    }

    pub fn participant_gain(&self, identity: &str, source: AudioSource) -> f32 {
        self.gains
            .get(&(identity.to_string(), source))
            .copied()
            .unwrap_or(1.0)
    }

    /// Esquece os volumes de uma pessoa (ela saiu da sala).
    pub fn forget_participant(&mut self, identity: &str) {
        self.gains.retain(|(i, _), _| i != identity);
    }

    /// Esquece todos os volumes (nova sala).
    pub fn clear_gains(&mut self) {
        self.gains.clear();
    }

    pub fn remove(&mut self, id: &str) {
        self.queues.remove(id);
    }

    pub fn clear(&mut self) {
        self.queues.clear();
    }

    pub fn sources(&self) -> usize {
        self.queues.len()
    }

    /// Soma as filas em `out` (substitui o conteúdo). Faltou amostra → silêncio naquela fonte.
    pub fn mix_into(&mut self, out: &mut [i16]) {
        if self.deafened || self.queues.is_empty() {
            out.fill(0);
            return;
        }
        let len = out.len().max(1) as f32;
        let mut acc = vec![0i32; out.len()];
        for q in self.queues.values_mut() {
            let target = q
                .key
                .as_ref()
                .and_then(|k| self.gains.get(k))
                .copied()
                .unwrap_or(1.0);
            let start = q.gain.unwrap_or(target);
            q.gain = Some(target);
            for (i, slot) in acc.iter_mut().enumerate() {
                let Some(s) = q.samples.pop_front() else {
                    break;
                };
                let g = if start == target {
                    target
                } else {
                    // rampa linear: o último amostra do bloco já está no alvo
                    start + (target - start) * ((i + 1) as f32 / len)
                };
                *slot += if g == 1.0 {
                    s as i32
                } else {
                    (s as f32 * g).round() as i32
                };
            }
        }
        for (o, a) in out.iter_mut().zip(acc) {
            *o = a.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_sources_and_saturates() {
        let mut m = Mixer::new();
        m.push("a", &[100, 200, i16::MAX]);
        m.push("b", &[1, -50, i16::MAX]);
        let mut out = [0i16; 3];
        m.mix_into(&mut out);
        assert_eq!(out, [101, 150, i16::MAX]);
    }

    #[test]
    fn underrun_plays_silence() {
        let mut m = Mixer::new();
        m.push("a", &[10, 20]);
        let mut out = [7i16; 4];
        m.mix_into(&mut out);
        assert_eq!(out, [10, 20, 0, 0]);
        // sem nada na fila
        m.mix_into(&mut out);
        assert_eq!(out, [0; 4]);
    }

    #[test]
    fn caps_latency_dropping_the_oldest() {
        let mut m = Mixer::new();
        let big: Vec<i16> = (0..(MAX_BUFFERED + 100) as i32)
            .map(|i| (i % 1000) as i16)
            .collect();
        m.push("a", &big);
        let mut out = vec![0i16; MAX_BUFFERED];
        m.mix_into(&mut out);
        // as 100 primeiras amostras foram descartadas
        assert_eq!(out[0], big[100]);
    }

    #[test]
    fn deafen_silences_and_discards() {
        let mut m = Mixer::new();
        m.push("a", &[1000; 480]);
        m.set_deafened(true);
        let mut out = [5i16; 480];
        m.mix_into(&mut out);
        assert!(out.iter().all(|&s| s == 0));
        // enquanto ensurdecido, o que chega é descartado
        m.push("a", &[1000; 480]);
        m.set_deafened(false);
        m.mix_into(&mut out);
        assert!(out.iter().all(|&s| s == 0));
        // depois de voltar, o áudio novo toca
        m.push("a", &[1000; 480]);
        m.mix_into(&mut out);
        assert!(out.iter().all(|&s| s == 1000));
    }

    #[test]
    fn remove_drops_a_participant() {
        let mut m = Mixer::new();
        m.push("a", &[1, 2]);
        m.push("b", &[3, 4]);
        m.remove("a");
        assert_eq!(m.sources(), 1);
        let mut out = [0i16; 2];
        m.mix_into(&mut out);
        assert_eq!(out, [3, 4]);
    }

    fn mixed(m: &mut Mixer, n: usize) -> Vec<i16> {
        let mut out = vec![0i16; n];
        m.mix_into(&mut out);
        out
    }

    #[test]
    fn gain_scales_one_person_and_leaves_others_alone() {
        let mut m = Mixer::new();
        m.bind("t1", "ana", AudioSource::Voice);
        m.bind("t2", "bia", AudioSource::Voice);
        m.set_participant_gain("ana", AudioSource::Voice, 0.5);
        // o primeiro bloco já nasce no ganho-alvo (sem rampa a partir de 100%)
        m.push("t1", &[1000; 480]);
        m.push("t2", &[100; 480]);
        let out = mixed(&mut m, 480);
        assert!(out.iter().all(|&s| s == 600), "{:?}", &out[..4]);
    }

    #[test]
    fn gain_up_to_200_percent_and_saturates() {
        let mut m = Mixer::new();
        m.bind("t1", "ana", AudioSource::Voice);
        m.set_participant_gain("ana", AudioSource::Voice, 2.0);
        m.push("t1", &[1000, -1000, 20_000, -20_000]);
        let out = mixed(&mut m, 4);
        assert_eq!(out, [2000, -2000, i16::MAX, i16::MIN]);
        // acima de 200% é limitado a 200%
        m.set_participant_gain("ana", AudioSource::Voice, 9.0);
        assert_eq!(m.participant_gain("ana", AudioSource::Voice), 2.0);
        // NaN volta a 100%
        m.set_participant_gain("ana", AudioSource::Voice, f32::NAN);
        assert_eq!(m.participant_gain("ana", AudioSource::Voice), 1.0);
        m.set_participant_gain("ana", AudioSource::Voice, -3.0);
        assert_eq!(m.participant_gain("ana", AudioSource::Voice), 0.0);
    }

    #[test]
    fn gain_stacks_with_the_sum_and_still_saturates() {
        let mut m = Mixer::new();
        m.bind("t1", "ana", AudioSource::Voice);
        m.bind("t2", "bia", AudioSource::Voice);
        m.set_participant_gain("ana", AudioSource::Voice, 2.0);
        m.push("t1", &[20_000]);
        m.push("t2", &[20_000]);
        assert_eq!(mixed(&mut m, 1), [i16::MAX]);
    }

    #[test]
    fn zero_volume_mutes_only_for_me_but_keeps_consuming() {
        let mut m = Mixer::new();
        m.bind("t1", "ana", AudioSource::Voice);
        m.bind("t2", "bia", AudioSource::Voice);
        m.set_participant_gain("ana", AudioSource::Voice, 0.0);
        m.push("t1", &[1000; 480]);
        m.push("t2", &[7; 480]);
        let out = mixed(&mut m, 480);
        assert!(out.iter().all(|&s| s == 7));
        // a fila da silenciada foi consumida: não toca atraso velho ao reativar
        m.set_participant_gain("ana", AudioSource::Voice, 1.0);
        m.push("t1", &[500; 480]);
        let out = mixed(&mut m, 480);
        assert_eq!(out[479], 500);
    }

    #[test]
    fn voice_and_screen_audio_have_independent_gains() {
        let mut m = Mixer::new();
        m.bind("voz", "ana", AudioSource::Voice);
        m.bind("tela", "ana", AudioSource::Screen);
        m.set_participant_gain("ana", AudioSource::Screen, 0.0);
        m.push("voz", &[100; 480]);
        m.push("tela", &[1000; 480]);
        let out = mixed(&mut m, 480);
        assert!(out.iter().all(|&s| s == 100));
        assert_eq!(m.participant_gain("ana", AudioSource::Voice), 1.0);
    }

    #[test]
    fn gain_changes_ramp_without_a_step() {
        let mut m = Mixer::new();
        m.bind("t1", "ana", AudioSource::Voice);
        m.push("t1", &[10_000; 960]);
        let first = mixed(&mut m, 480);
        assert!(first.iter().all(|&s| s == 10_000));
        m.set_participant_gain("ana", AudioSource::Voice, 0.0);
        let ramp = mixed(&mut m, 480);
        // desce em rampa linear, sem salto maior que o passo da rampa, e chega a zero no fim do bloco
        let step = 10_000 / 480 + 2;
        assert!(ramp[0] >= 10_000 - step, "{}", ramp[0]);
        assert!(ramp
            .windows(2)
            .all(|w| (w[0] as i32 - w[1] as i32).abs() <= step as i32));
        assert_eq!(ramp[479], 0);
        assert!(ramp[240] > 4_000 && ramp[240] < 6_000);
    }

    #[test]
    fn gain_survives_a_republished_track() {
        let mut m = Mixer::new();
        m.bind("t1", "ana", AudioSource::Voice);
        m.set_participant_gain("ana", AudioSource::Voice, 0.5);
        m.remove("t1"); // a pessoa parou de publicar
        m.bind("t9", "ana", AudioSource::Voice); // republicou com outro sid
        m.push("t9", &[1000; 4]);
        assert_eq!(mixed(&mut m, 4), [500; 4]);
    }

    #[test]
    fn forgetting_a_person_or_the_room_resets_their_gain() {
        let mut m = Mixer::new();
        m.set_participant_gain("ana", AudioSource::Voice, 0.5);
        m.set_participant_gain("ana", AudioSource::Screen, 1.5);
        m.set_participant_gain("bia", AudioSource::Voice, 0.2);
        m.forget_participant("ana");
        assert_eq!(m.participant_gain("ana", AudioSource::Voice), 1.0);
        assert_eq!(m.participant_gain("ana", AudioSource::Screen), 1.0);
        assert_eq!(m.participant_gain("bia", AudioSource::Voice), 0.2);
        m.clear_gains();
        assert_eq!(m.participant_gain("bia", AudioSource::Voice), 1.0);
    }

    #[test]
    fn deafen_is_independent_of_the_gain() {
        let mut m = Mixer::new();
        m.bind("t1", "ana", AudioSource::Voice);
        m.set_participant_gain("ana", AudioSource::Voice, 2.0);
        m.set_deafened(true);
        m.push("t1", &[1000; 4]);
        assert_eq!(mixed(&mut m, 4), [0; 4]);
        m.set_deafened(false);
        // o ganho continua guardado
        assert_eq!(m.participant_gain("ana", AudioSource::Voice), 2.0);
        m.push("t1", &[1000; 4]);
        assert_eq!(mixed(&mut m, 4), [2000; 4]);
    }

    #[test]
    fn audio_source_json() {
        let v: AudioSource = serde_json::from_str("\"screen\"").unwrap();
        assert_eq!(v, AudioSource::Screen);
        assert!(serde_json::from_str::<AudioSource>("\"x\"").is_err());
    }
}
