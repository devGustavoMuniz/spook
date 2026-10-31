//! Teste de microfone (lógica pura): grava ~5 s do microfone JÁ processado pela cadeia (AEC/NS/porta) num buffer
//! limitado em memória e depois entrega a gravação ao alto-falante no ritmo do tempo real. Nunca toca o microfone
//! ao vivo. A orquestração (cpal, fases e eventos) fica em `core.rs`.

/// Duração da gravação.
pub const RECORD_MS: u32 = 5_000;
const SAMPLES_PER_MS: usize = 48; // 48 kHz mono

/// Buffer de gravação com capacidade fixa (`RECORD_MS`): não cresce além disso.
#[derive(Debug)]
pub struct Recorder {
    buf: Vec<i16>,
    cap: usize,
}

impl Recorder {
    pub fn new(duration_ms: u32) -> Self {
        let cap = duration_ms as usize * SAMPLES_PER_MS;
        Self {
            buf: Vec::with_capacity(cap),
            cap,
        }
    }

    /// Acrescenta amostras até a capacidade. Devolve `true` quando a gravação está completa.
    pub fn push(&mut self, samples: &[i16]) -> bool {
        let room = self.cap - self.buf.len();
        self.buf
            .extend_from_slice(&samples[..samples.len().min(room)]);
        self.is_full()
    }

    pub fn is_full(&self) -> bool {
        self.buf.len() >= self.cap
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Quanto falta gravar, em ms.
    pub fn remaining_ms(&self) -> u32 {
        ((self.cap - self.buf.len()) / SAMPLES_PER_MS) as u32
    }

    pub fn into_samples(self) -> Vec<i16> {
        self.buf
    }
}

/// Entrega a gravação no ritmo do relógio: a cada chamada devolve as amostras que já "venceram" desde o início.
#[derive(Debug)]
pub struct Feeder {
    buf: Vec<i16>,
    pos: usize,
}

impl Feeder {
    pub fn new(buf: Vec<i16>) -> Self {
        Self { buf, pos: 0 }
    }

    /// Amostras novas que devem estar no alto-falante ao fim de `elapsed_ms` (já descontada a antecedência que o
    /// chamador queira dar). Nunca passa do fim.
    pub fn due(&mut self, elapsed_ms: u64) -> &[i16] {
        let upto = ((elapsed_ms as usize).saturating_mul(SAMPLES_PER_MS)).min(self.buf.len());
        let from = self.pos.min(upto);
        self.pos = upto;
        &self.buf[from..upto]
    }

    pub fn all_sent(&self) -> bool {
        self.pos >= self.buf.len()
    }

    pub fn total_ms(&self) -> u32 {
        (self.buf.len() / SAMPLES_PER_MS) as u32
    }

    /// Quanto falta tocar, em ms, ao fim de `elapsed_ms`.
    pub fn remaining_ms(&self, elapsed_ms: u64) -> u32 {
        self.total_ms()
            .saturating_sub(elapsed_ms.min(u64::from(u32::MAX)) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorder_is_bounded_to_the_duration() {
        let mut r = Recorder::new(RECORD_MS);
        assert!(r.is_empty());
        assert_eq!(r.remaining_ms(), 5000);
        for _ in 0..499 {
            assert!(!r.push(&[1i16; 480]));
        }
        assert_eq!(r.remaining_ms(), 10);
        assert!(r.push(&[1i16; 480]));
        assert_eq!(r.len(), 240_000);
        // além do limite não cresce
        assert!(r.push(&[1i16; 480]));
        assert_eq!(r.len(), 240_000);
        assert_eq!(r.remaining_ms(), 0);
        assert_eq!(r.into_samples().len(), 240_000);
    }

    #[test]
    fn recorder_truncates_the_last_chunk() {
        let mut r = Recorder::new(10); // 480 amostras
        assert!(!r.push(&[1i16; 300]));
        assert!(r.push(&[2i16; 300]));
        let s = r.into_samples();
        assert_eq!(s.len(), 480);
        assert_eq!(s[299], 1);
        assert_eq!(s[300], 2);
    }

    #[test]
    fn feeder_delivers_in_realtime_without_repeating_or_skipping() {
        let data: Vec<i16> = (0..4800).map(|i| i as i16).collect(); // 100 ms
        let mut f = Feeder::new(data.clone());
        let mut got: Vec<i16> = Vec::new();
        assert!(f.due(0).is_empty());
        got.extend_from_slice(f.due(10));
        assert_eq!(got.len(), 480);
        got.extend_from_slice(f.due(10)); // mesmo instante: nada novo
        assert_eq!(got.len(), 480);
        got.extend_from_slice(f.due(55));
        assert_eq!(got.len(), 55 * 48);
        assert!(!f.all_sent());
        got.extend_from_slice(f.due(5_000)); // passou do fim: entrega só o que sobra
        assert_eq!(got, data);
        assert!(f.all_sent());
        assert!(f.due(6_000).is_empty());
    }

    #[test]
    fn feeder_reports_remaining_time() {
        let f = Feeder::new(vec![0; 48_000]);
        assert_eq!(f.total_ms(), 1000);
        assert_eq!(f.remaining_ms(250), 750);
        assert_eq!(f.remaining_ms(9_999), 0);
    }

    #[test]
    fn empty_recording_is_all_sent() {
        let f = Feeder::new(Vec::new());
        assert!(f.all_sent());
        assert_eq!(f.total_ms(), 0);
    }
}
