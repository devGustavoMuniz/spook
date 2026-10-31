//! Mixer do áudio remoto (lógica pura). Cada participante tem uma fila de PCM 48 kHz mono; o callback de
//! saída do cpal chama `mix_into` e recebe a soma (com saturação). Tudo atrás de um `Mutex` curto.
//! "Ensurdecer" descarta o que chega e toca silêncio, para não voltar com áudio velho.

use std::collections::{HashMap, VecDeque};

/// Quanto cada fila guarda (200 ms a 48 kHz). Passou disso, descarta o mais antigo: a latência fica limitada.
pub const MAX_BUFFERED: usize = 9_600;

#[derive(Debug, Default)]
pub struct Mixer {
    queues: HashMap<String, VecDeque<i16>>,
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
                q.clear();
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
        q.extend(samples.iter().copied());
        let excess = q.len().saturating_sub(MAX_BUFFERED);
        if excess > 0 {
            q.drain(..excess);
        }
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
        let mut acc = vec![0i32; out.len()];
        for q in self.queues.values_mut() {
            for slot in acc.iter_mut() {
                match q.pop_front() {
                    Some(s) => *slot += s as i32,
                    None => break,
                }
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
}
