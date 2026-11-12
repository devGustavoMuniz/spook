//! Processamento de áudio do microfone: APM do WebRTC (cancelamento de eco, supressão de ruído "Padrão" e
//! controle de ganho) mais a supressão por IA nativa: RNNoise ("Forte", `rnnoise.rs`) e DeepFilterNet
//! ("Máximo", `deepfilter.rs`).
//!
//! O `NativeAudioSource` do LiveKit NÃO passa pelo APM (ele só atua no caminho do ADM do WebRTC, que não
//! usamos porque capturamos e tocamos com o cpal). Por isso fazemos a ponte à mão com o
//! `libwebrtc::native::apm::AudioProcessingModule`:
//!
//! * **far-end (reverse stream):** o que TOCAMOS. O renderizador de saída entrega cada quadro de 10 ms
//!   (48 kHz mono, o mesmo PCM que sai do mixer) a `push_far`, no callback de áudio, sem alocar nem bloquear
//!   (`try_lock`: se a captura estiver usando o APM naquele instante, esse quadro de referência é pulado).
//! * **near-end (stream):** cada quadro de 10 ms do MICROFONE passa por `process_near` ANTES de ir ao
//!   `NativeAudioSource`. Ordem: **AEC primeiro** (precisa do microfone cru e do far-end), depois NS/AGC do APM e,
//!   no nível Forte, o RNNoise por último e, no Máximo, o DeepFilterNet (com o NS do APM desligado: não se
//!   processa ruído duas vezes). O DeepFilterNet carrega em segundo plano e, até ficar pronto (ou se o processador
//!   não aguentar e ele cair), o RNNoise cobre; a queda é avisada por `set_notice_sink`.
//! * **dica de atraso:** estimada a cada ~1 s pelos timestamps do cpal (`delay.rs`); 60 ms sem timestamps.
//!
//! Níveis de ruído: `off` (NS do APM desligado), `standard` (NS do APM), `strong` (APM sem NS + RNNoise) e `max`
//! (APM sem NS + DeepFilterNet, com RNNoise de reserva).
//! A API do APM do libwebrtc 0.3 só expõe quatro interruptores (`echo_cancellation`, `gain_control`,
//! `high_pass_filter`, `noise_suppression`): o filtro passa-altas fica sempre ligado; não há como escolher o
//! nível de supressão de eco nem o modo "móvel" por aqui (o AEC3 usa os padrões do WebRTC).
//!
//! Sem reprodução ativa não há far-end e o APM só aplica supressão de ruído e ganho. O APM não troca
//! configuração em execução, então mudar AEC/AGC/Padrão recria o módulo (o AEC reconverge em ~1 s). Ligar ou
//! desligar o Forte ou o Máximo NÃO recria o APM (só liga/desliga o RNNoise/DeepFilterNet, com crossfade).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use libwebrtc::native::apm::AudioProcessingModule;
use serde::{Deserialize, Serialize};

use super::audio::{FRAME_SAMPLES, SAMPLE_RATE};
use super::deepfilter::{Enhancer, FallbackReason, Notice};
use super::delay::{DelayEstimator, LatencyProbe, DEFAULT_DELAY_MS};
use super::gate::{GateLevel, InputSensitivity, NoiseGate};
pub use super::level::NoiseSuppressionLevel;
use super::rnnoise::Denoiser;

/// Dica de atraso padrão (sem timestamps do cpal).
pub const DEFAULT_STREAM_DELAY_MS: i32 = DEFAULT_DELAY_MS;

/// Atualiza a estimativa de atraso a cada 100 quadros (~1 s).
const DELAY_UPDATE_FRAMES: u32 = 100;

/// Aviso de que o nível Máximo (DeepFilterNet) deixou de atender e o Forte (RNNoise) cobre. Quem monta o
/// `ApmBridge` decide como entregá-lo à interface (`set_notice_sink`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoiseFallback {
    pub reason: FallbackReason,
}

/// Destino do aviso. Chamado no máximo uma vez por queda, fora do `Mutex` do áudio.
pub type NoticeSink = Arc<dyn Fn(NoiseFallback) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioProcessingSettings {
    pub echo_cancellation: bool,
    pub noise_suppression: NoiseSuppressionLevel,
    pub auto_gain_control: bool,
    /// Porta de ruído (depois do NS/RNNoise). Ausente = desligada (formato antigo continua válido).
    pub input_sensitivity: InputSensitivity,
}

impl Default for AudioProcessingSettings {
    /// Tudo ligado por padrão (o eco é o problema de quem usa alto-falante).
    fn default() -> Self {
        Self {
            echo_cancellation: true,
            noise_suppression: NoiseSuppressionLevel::Standard,
            auto_gain_control: true,
            input_sensitivity: InputSensitivity::default(),
        }
    }
}

impl AudioProcessingSettings {
    /// O APM só é necessário para AEC, AGC ou NS "Padrão" (Forte e Máximo rodam fora dele).
    pub fn needs_apm(&self) -> bool {
        self.echo_cancellation || self.auto_gain_control || self.noise_suppression.uses_apm_ns()
    }

    pub fn any(&self) -> bool {
        self.needs_apm() || self.noise_suppression.uses_native_denoiser()
    }

    /// O que define a configuração do APM (Forte e Máximo não entram: não exigem recriá-lo).
    fn apm_key(&self) -> (bool, bool, bool) {
        (
            self.echo_cancellation,
            self.auto_gain_control,
            self.noise_suppression.uses_apm_ns(),
        )
    }
}

struct Inner {
    settings: AudioProcessingSettings,
    apm: Option<AudioProcessingModule>,
    denoiser: Denoiser,
    /// DeepFilterNet (nível Máximo). Enquanto carrega ou depois de cair, o `denoiser` (RNNoise) cobre.
    enhancer: Enhancer,
    gate: NoiseGate,
    delay_ms: i32,
    estimator: DelayEstimator,
    frames_since_delay_update: u32,
    /// Cópia do quadro far-end (o APM escreve no buffer que recebe); pré-alocada: nada de alocar no callback.
    far: [i16; FRAME_SAMPLES],
    far_frames: u64,
}

fn build(settings: AudioProcessingSettings) -> Option<AudioProcessingModule> {
    settings.needs_apm().then(|| {
        AudioProcessingModule::new(
            settings.echo_cancellation,
            settings.auto_gain_control,
            // O filtro passa-altas acompanha qualquer processamento (tira ruído grave de DC/vento).
            true,
            // Só o nível Padrão usa o NS do APM; no Forte e no Máximo quem suprime é o RNNoise/DeepFilterNet.
            settings.noise_suppression.uses_apm_ns(),
        )
    })
}

pub struct ApmBridge {
    inner: Mutex<Inner>,
    /// Latências medidas nos callbacks do cpal (átomos; ver `delay.rs`).
    probe: Arc<LatencyProbe>,
    /// Último nível medido depois de toda a cadeia (átomos: o medidor lê sem tocar no `Mutex` do áudio).
    level_db: AtomicU32,
    level_open: AtomicBool,
    level_frames: AtomicU64,
    /// Para onde vai o aviso de queda do nível Máximo (definido por quem monta a ponte).
    sink: Mutex<Option<NoticeSink>>,
}

impl ApmBridge {
    pub fn new(settings: AudioProcessingSettings) -> Self {
        Self::with_enhancer(settings, Enhancer::with_default_loader())
    }

    /// Como `new`, com o DeepFilterNet dado (testes injetam um modelo falso).
    pub fn with_enhancer(settings: AudioProcessingSettings, mut enhancer: Enhancer) -> Self {
        let mut denoiser = Denoiser::new();
        enhancer.set_enabled(settings.noise_suppression.wants_enhancer());
        denoiser.set_enabled(
            settings
                .noise_suppression
                .wants_rnnoise(enhancer.is_serving()),
        );
        Self {
            inner: Mutex::new(Inner {
                settings,
                apm: build(settings),
                denoiser,
                enhancer,
                gate: NoiseGate::new(SAMPLE_RATE, settings.input_sensitivity),
                delay_ms: DEFAULT_STREAM_DELAY_MS,
                estimator: DelayEstimator::new(),
                frames_since_delay_update: 0,
                far: [0; FRAME_SAMPLES],
                far_frames: 0,
            }),
            probe: Arc::new(LatencyProbe::new()),
            level_db: AtomicU32::new((-100f32).to_bits()),
            level_open: AtomicBool::new(false),
            level_frames: AtomicU64::new(0),
            sink: Mutex::new(None),
        }
    }

    /// Define (ou remove) o destino do aviso de queda do nível Máximo.
    pub fn set_notice_sink(&self, sink: Option<NoticeSink>) {
        *self.sink.lock().unwrap_or_else(|e| e.into_inner()) = sink;
    }

    fn deliver(&self, fallback: NoiseFallback) {
        let sink = self.sink.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(sink) = sink {
            sink(fallback);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn settings(&self) -> AudioProcessingSettings {
        self.lock().settings
    }

    /// Sonda de latência que os callbacks do cpal alimentam.
    pub fn probe(&self) -> Arc<LatencyProbe> {
        self.probe.clone()
    }

    /// Aplica novos interruptores. Recria o APM só se AEC, AGC ou o NS "Padrão" mudaram; o Forte liga/desliga
    /// o RNNoise sem tocar no APM (o AEC não reconverge).
    pub fn configure(&self, settings: AudioProcessingSettings) {
        let mut g = self.lock();
        if g.settings.apm_key() != settings.apm_key() || g.apm.is_some() != settings.needs_apm() {
            g.apm = build(settings);
        }
        // Máximo: o DeepFilterNet carrega em segundo plano e o RNNoise cobre até ele ficar pronto.
        g.enhancer
            .set_enabled(settings.noise_suppression.wants_enhancer());
        let serving = g.enhancer.is_serving();
        g.denoiser
            .set_enabled(settings.noise_suppression.wants_rnnoise(serving));
        g.gate.configure(settings.input_sensitivity);
        g.settings = settings;
    }

    /// Último nível (dBFS, depois da supressão e da porta) e quantos quadros já foram medidos no total
    /// (o medidor só emite quando esse contador anda: sem captura, nada de valores velhos).
    pub fn level(&self) -> (GateLevel, u64) {
        (
            GateLevel {
                db: f32::from_bits(self.level_db.load(Ordering::Relaxed)),
                gate_open: self.level_open.load(Ordering::Relaxed),
            },
            self.level_frames.load(Ordering::Relaxed),
        )
    }

    /// Define a dica de atraso à mão (e a mantém até a próxima estimativa).
    pub fn set_stream_delay_ms(&self, delay_ms: i32) {
        self.lock().delay_ms = delay_ms.clamp(0, 500);
    }

    /// Dica de atraso em uso agora.
    pub fn stream_delay_ms(&self) -> i32 {
        self.lock().delay_ms
    }

    /// Passa um quadro de 10 ms do microfone (48 kHz mono) pelo AEC/NS/AGC e, no Forte, pelo RNNoise (no
    /// Máximo, pelo DeepFilterNet), no lugar. Devolve `true` se algum processamento foi aplicado.
    pub fn process_near(&self, frame: &mut [i16]) -> bool {
        if frame.len() != FRAME_SAMPLES {
            return false;
        }
        let mut g = self.lock();

        // Estimativa dinâmica do atraso, ~1x/s (só lê átomos).
        g.frames_since_delay_update += 1;
        if g.frames_since_delay_update >= DELAY_UPDATE_FRAMES {
            g.frames_since_delay_update = 0;
            let raw = DelayEstimator::raw_from(&self.probe);
            g.delay_ms = g.estimator.update(raw);
        }

        let delay = g.delay_ms;
        let mut processed = false;
        // 1) AEC + NS "Padrão" + AGC. Se a dica falhar, o AEC3 ainda estima o atraso sozinho.
        if let Some(apm) = g.apm.as_mut() {
            let _ = apm.set_stream_delay_ms(delay);
            processed = apm.process_stream(frame, SAMPLE_RATE as i32, 1).is_ok();
        }
        // 2) DeepFilterNet (Máximo) ou RNNoise (Forte), por último, logo antes do NativeAudioSource. No Máximo o
        //    RNNoise só trabalha enquanto o DeepFilterNet não atende (carregando ou caído); a troca é por fade.
        processed |= g.enhancer.process(frame);
        let level_setting = g.settings.noise_suppression;
        let serving = g.enhancer.is_serving();
        g.denoiser.set_enabled(level_setting.wants_rnnoise(serving));
        processed |= g.denoiser.process(frame);
        let notice = g.enhancer.take_notice();
        // 3) Porta de ruído (sensibilidade de entrada), depois de qualquer supressão; também mede o nível.
        let level = g.gate.process(frame);
        drop(g);
        self.level_db.store(level.db.to_bits(), Ordering::Relaxed);
        self.level_open.store(level.gate_open, Ordering::Relaxed);
        self.level_frames.fetch_add(1, Ordering::Relaxed);
        if let Some(Notice::Fallback(reason)) = notice {
            self.deliver(NoiseFallback { reason });
        }
        processed
    }

    /// Entrega ao APM um quadro de 10 ms do que está tocando (referência do eco). Seguro para o callback de
    /// áudio: não aloca e não espera. Devolve `true` se o quadro foi aceito.
    pub fn push_far(&self, frame: &[i16]) -> bool {
        if frame.len() != FRAME_SAMPLES {
            return false;
        }
        let Ok(mut g) = self.inner.try_lock() else {
            return false;
        };
        let Inner {
            apm,
            far,
            far_frames,
            ..
        } = &mut *g;
        let Some(apm) = apm.as_mut() else {
            return false;
        };
        far.copy_from_slice(frame);
        let ok = apm
            .process_reverse_stream(far, SAMPLE_RATE as i32, 1)
            .is_ok();
        if ok {
            *far_frames += 1;
        }
        ok
    }

    /// Quantos quadros de referência (far-end) o APM já recebeu (diagnóstico e testes).
    pub fn far_frames(&self) -> u64 {
        self.lock().far_frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::gate::GateMode;

    /// Ruído branco determinístico (LCG), amplitude `amp`, `n` amostras.
    fn noise(n: usize, amp: f32, seed: u32) -> Vec<i16> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let x = ((s >> 8) as f32 / (1u32 << 24) as f32) * 2.0 - 1.0;
                (x * amp * i16::MAX as f32) as i16
            })
            .collect()
    }

    fn energy(x: &[i16]) -> f64 {
        x.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / x.len().max(1) as f64
    }

    /// Simula o eco: o near-end é o far-end atrasado e atenuado. Devolve a energia (média por amostra) da
    /// saída nos últimos `tail` quadros e a da entrada no mesmo trecho.
    fn run_echo(settings: AudioProcessingSettings, delay_samples: usize, gain: f32) -> (f64, f64) {
        let frames = 1500; // 15 s
        let far = noise(frames * FRAME_SAMPLES, 0.3, 7);
        let near: Vec<i16> = (0..far.len())
            .map(|i| {
                if i >= delay_samples {
                    (far[i - delay_samples] as f32 * gain) as i16
                } else {
                    0
                }
            })
            .collect();
        let bridge = ApmBridge::new(settings);
        let mut out_tail = Vec::new();
        let mut in_tail = Vec::new();
        let tail_start = frames - 300; // últimos 3 s
        for f in 0..frames {
            let r = f * FRAME_SAMPLES..(f + 1) * FRAME_SAMPLES;
            bridge.push_far(&far[r.clone()]);
            let mut q = near[r.clone()].to_vec();
            bridge.process_near(&mut q);
            if f >= tail_start {
                out_tail.extend_from_slice(&q);
                in_tail.extend_from_slice(&near[r]);
            }
        }
        (energy(&out_tail), energy(&in_tail))
    }

    fn aec_only() -> AudioProcessingSettings {
        AudioProcessingSettings {
            echo_cancellation: true,
            noise_suppression: NoiseSuppressionLevel::Off,
            auto_gain_control: false,
            ..Default::default()
        }
    }

    #[test]
    fn echo_canceller_removes_a_simulated_echo() {
        // 40 ms de atraso (1920 amostras) e eco a 50 % da amplitude.
        let (with_aec, input) = run_echo(aec_only(), 1920, 0.5);
        let (without, input2) = run_echo(
            AudioProcessingSettings {
                echo_cancellation: false,
                noise_suppression: NoiseSuppressionLevel::Off,
                auto_gain_control: false,
                ..Default::default()
            },
            1920,
            0.5,
        );
        // Desligado, o APM não toca no sinal: a saída é a entrada.
        assert!(
            (without - input2).abs() / input2 < 1e-6,
            "sem APM a saída deve ser igual à entrada"
        );
        assert!((input - input2).abs() / input2 < 1e-6);
        let erle_db = 10.0 * (without / with_aec.max(1e-9)).log10();
        eprintln!("AEC: redução do eco após convergir = {erle_db:.1} dB");
        assert!(
            erle_db > 15.0,
            "o AEC deveria reduzir o eco em mais de 15 dB depois de convergir, reduziu {erle_db:.1} dB \
             (com AEC {with_aec:.1}, sem {without:.1})"
        );
    }

    #[test]
    fn near_end_speech_survives_when_there_is_no_far_end() {
        // Sem reprodução (nenhum far-end) o AEC não pode comer a fala do microfone.
        let bridge = ApmBridge::new(aec_only());
        let speech = noise(300 * FRAME_SAMPLES, 0.3, 11);
        let mut out = Vec::new();
        for c in speech.chunks(FRAME_SAMPLES) {
            let mut q = c.to_vec();
            assert!(bridge.process_near(&mut q));
            out.extend(q);
        }
        let tail = out.len() - 100 * FRAME_SAMPLES;
        let ratio = energy(&out[tail..]) / energy(&speech[tail..]);
        eprintln!("sem far-end, energia mantida = {ratio:.2}");
        assert!(
            ratio > 0.3,
            "o sinal do microfone foi atenuado demais: {ratio:.2}"
        );
    }

    #[test]
    fn disabled_settings_bypass_the_module() {
        let off = AudioProcessingSettings {
            echo_cancellation: false,
            noise_suppression: NoiseSuppressionLevel::Off,
            auto_gain_control: false,
            ..Default::default()
        };
        let b = ApmBridge::new(off);
        let mut q = vec![123i16; FRAME_SAMPLES];
        assert!(!b.process_near(&mut q));
        assert!(!b.push_far(&q));
        assert!(q.iter().all(|&s| s == 123));
    }

    #[test]
    fn configure_rebuilds_and_reports_settings() {
        let b = ApmBridge::new(AudioProcessingSettings::default());
        assert!(
            b.settings().echo_cancellation
                && b.settings().noise_suppression == NoiseSuppressionLevel::Standard
                && b.settings().auto_gain_control
        );
        let mut q = vec![0i16; FRAME_SAMPLES];
        assert!(b.process_near(&mut q));
        b.configure(AudioProcessingSettings {
            echo_cancellation: false,
            noise_suppression: NoiseSuppressionLevel::Off,
            auto_gain_control: false,
            ..Default::default()
        });
        assert!(!b.process_near(&mut q));
        b.configure(aec_only());
        assert!(b.process_near(&mut q));
        assert_eq!(b.settings(), aec_only());
    }

    #[test]
    fn wrong_frame_sizes_are_rejected_without_panicking() {
        let b = ApmBridge::new(AudioProcessingSettings::default());
        assert!(!b.process_near(&mut [0i16; 100]));
        assert!(!b.push_far(&[0i16; 481]));
    }

    #[test]
    fn push_far_never_blocks_while_the_capture_holds_the_module() {
        let b = ApmBridge::new(AudioProcessingSettings::default());
        let _guard = b.lock(); // simula a captura usando o APM
        assert!(
            !b.push_far(&[0i16; FRAME_SAMPLES]),
            "deveria pular o quadro em vez de esperar"
        );
    }

    #[test]
    fn settings_json_uses_camel_case_and_defaults_to_on() {
        let s: AudioProcessingSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, AudioProcessingSettings::default());
        let s: AudioProcessingSettings =
            serde_json::from_str(r#"{"echoCancellation":false}"#).unwrap();
        assert!(
            !s.echo_cancellation
                && s.noise_suppression == NoiseSuppressionLevel::Standard
                && s.auto_gain_control
        );
        let v = serde_json::to_value(AudioProcessingSettings::default()).unwrap();
        assert_eq!(v["autoGainControl"], true);
    }

    #[test]
    fn noise_level_json_accepts_text_and_the_legacy_boolean() {
        let parse = |j: &str| -> AudioProcessingSettings { serde_json::from_str(j).unwrap() };
        assert_eq!(
            parse(r#"{"noiseSuppression":"strong"}"#).noise_suppression,
            NoiseSuppressionLevel::Strong
        );
        assert_eq!(
            parse(r#"{"noiseSuppression":"standard"}"#).noise_suppression,
            NoiseSuppressionLevel::Standard
        );
        assert_eq!(
            parse(r#"{"noiseSuppression":"off"}"#).noise_suppression,
            NoiseSuppressionLevel::Off
        );
        // Formato antigo da interface: booleano.
        assert_eq!(
            parse(r#"{"noiseSuppression":true}"#).noise_suppression,
            NoiseSuppressionLevel::Standard
        );
        assert_eq!(
            parse(r#"{"noiseSuppression":false}"#).noise_suppression,
            NoiseSuppressionLevel::Off
        );
        assert!(
            serde_json::from_str::<AudioProcessingSettings>(r#"{"noiseSuppression":"ultra"}"#)
                .is_err()
        );
        let v = serde_json::to_value(AudioProcessingSettings {
            noise_suppression: NoiseSuppressionLevel::Strong,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(v["noiseSuppression"], "strong");
    }

    fn strong(aec: bool, agc: bool) -> AudioProcessingSettings {
        AudioProcessingSettings {
            echo_cancellation: aec,
            noise_suppression: NoiseSuppressionLevel::Strong,
            auto_gain_control: agc,
            ..Default::default()
        }
    }

    #[test]
    fn strong_runs_without_the_apm_when_aec_and_agc_are_off() {
        let b = ApmBridge::new(strong(false, false));
        assert!(b.lock().apm.is_none());
        assert!(b.settings().any());
        let mut q = noise(FRAME_SAMPLES, 0.3, 5);
        // O primeiro quadro é de aquecimento do RNNoise (devolve o original), mas conta como processado.
        assert!(b.process_near(&mut q));
    }

    #[test]
    fn switching_to_strong_keeps_aec_and_agc_in_the_apm() {
        let b = ApmBridge::new(AudioProcessingSettings::default());
        b.configure(strong(true, true));
        {
            let g = b.lock();
            assert!(g.apm.is_some(), "AEC e AGC seguem no APM no Forte");
            assert!(g.denoiser.is_enabled());
        }
        b.configure(AudioProcessingSettings::default());
        assert!(!b.lock().denoiser.is_enabled());
    }

    #[test]
    fn strong_noise_switch_does_not_recreate_the_apm() {
        // Forte <-> Desligada com AEC/AGC iguais: a chave do APM não muda, então o módulo é mantido.
        let off = AudioProcessingSettings {
            noise_suppression: NoiseSuppressionLevel::Off,
            ..Default::default()
        };
        let s = strong(true, true);
        assert_eq!(off.apm_key(), s.apm_key());
        assert_ne!(AudioProcessingSettings::default().apm_key(), s.apm_key());
    }

    #[test]
    fn delay_hint_starts_at_default_and_follows_the_probe() {
        use std::time::Duration;
        let b = ApmBridge::new(AudioProcessingSettings::default());
        assert_eq!(b.stream_delay_ms(), DEFAULT_STREAM_DELAY_MS);
        let probe = b.probe();
        probe.store_output(Some(Duration::from_millis(50)));
        probe.store_input(Some(Duration::from_millis(20)));
        let mut q = vec![0i16; FRAME_SAMPLES];
        for _ in 0..DELAY_UPDATE_FRAMES {
            b.process_near(&mut q);
        }
        assert_eq!(b.stream_delay_ms(), 70);
        probe.store_output(Some(Duration::from_millis(100)));
        for _ in 0..(DELAY_UPDATE_FRAMES * 5) {
            b.process_near(&mut q);
        }
        assert_eq!(b.stream_delay_ms(), 120);
    }

    fn gate_only(mode: GateMode, threshold_db: f32) -> AudioProcessingSettings {
        AudioProcessingSettings {
            echo_cancellation: false,
            noise_suppression: NoiseSuppressionLevel::Off,
            auto_gain_control: false,
            input_sensitivity: InputSensitivity { mode, threshold_db },
        }
    }

    fn run_frames(b: &ApmBridge, x: &[i16]) -> Vec<i16> {
        let mut out = Vec::new();
        for c in x.chunks(FRAME_SAMPLES) {
            let mut q = c.to_vec();
            b.process_near(&mut q);
            out.extend(q);
        }
        out
    }

    #[test]
    fn gate_closes_on_quiet_noise_and_opens_on_loud_signal_after_the_suppression() {
        let b = ApmBridge::new(gate_only(GateMode::Manual, -30.0));
        let quiet = run_frames(&b, &noise(100 * FRAME_SAMPLES, 0.01, 3));
        assert!(quiet[quiet.len() - 20 * FRAME_SAMPLES..]
            .iter()
            .all(|&s| s == 0));
        let (lvl, frames) = b.level();
        assert_eq!(frames, 100);
        assert!(!lvl.gate_open && lvl.db < -30.0, "{lvl:?}");
        let loud = run_frames(&b, &noise(100 * FRAME_SAMPLES, 0.5, 4));
        assert!(loud[loud.len() - 20 * FRAME_SAMPLES..]
            .iter()
            .any(|&s| s != 0));
        let (lvl, frames) = b.level();
        assert_eq!(frames, 200);
        assert!(lvl.gate_open && lvl.db > -30.0, "{lvl:?}");
    }

    #[test]
    fn gate_off_is_transparent_but_the_meter_keeps_counting() {
        let b = ApmBridge::new(gate_only(GateMode::Off, -50.0));
        let x = noise(50 * FRAME_SAMPLES, 0.2, 9);
        let y = run_frames(&b, &x);
        assert_eq!(x, y);
        assert_eq!(b.level().1, 50);
        // ligar a porta na hora (sem recriar o APM) passa a valer
        b.configure(gate_only(GateMode::Manual, -10.0));
        let z = run_frames(&b, &noise(100 * FRAME_SAMPLES, 0.05, 10));
        assert!(z[z.len() - 10 * FRAME_SAMPLES..].iter().all(|&s| s == 0));
    }

    #[test]
    fn input_sensitivity_json_is_optional_and_camel_case() {
        let s: AudioProcessingSettings =
            serde_json::from_str(r#"{"inputSensitivity":{"mode":"auto","thresholdDb":-50}}"#)
                .unwrap();
        assert_eq!(s.input_sensitivity.mode, GateMode::Auto);
        let d: AudioProcessingSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(d.input_sensitivity.mode, GateMode::Off);
        let v = serde_json::to_value(s).unwrap();
        assert_eq!(v["inputSensitivity"]["mode"], "auto");
    }

    // ----- nível Máximo (DeepFilterNet) -----

    use crate::voice::deepfilter::{Model, ModelError, FRAME as DF_FRAME};

    /// Modelo falso: identidade.
    struct Identity;
    impl Model for Identity {
        fn process(
            &mut self,
            i: &[f32; DF_FRAME],
            o: &mut [f32; DF_FRAME],
        ) -> Result<(), ModelError> {
            *o = *i;
            Ok(())
        }
    }

    fn max_settings() -> AudioProcessingSettings {
        AudioProcessingSettings {
            echo_cancellation: false,
            noise_suppression: NoiseSuppressionLevel::Max,
            auto_gain_control: false,
            ..Default::default()
        }
    }

    fn wait_serving(b: &ApmBridge) {
        let mut q = vec![0i16; FRAME_SAMPLES];
        for _ in 0..400 {
            b.process_near(&mut q);
            if b.lock().enhancer.is_serving() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        panic!("o DeepFilterNet falso não ficou pronto");
    }

    #[test]
    fn max_json_and_apm_key() {
        let s: AudioProcessingSettings =
            serde_json::from_str(r#"{"noiseSuppression":"max"}"#).unwrap();
        assert_eq!(s.noise_suppression, NoiseSuppressionLevel::Max);
        assert!(s.any());
        assert_eq!(max_settings().apm_key(), strong(false, false).apm_key());
        assert!(!max_settings().needs_apm(), "Máximo roda fora do APM");
        let v = serde_json::to_value(max_settings()).unwrap();
        assert_eq!(v["noiseSuppression"], "max");
    }

    #[test]
    fn max_is_covered_by_rnnoise_until_the_model_is_ready_then_takes_over() {
        use crate::voice::deepfilter::Loader;
        let loader: Loader = Arc::new(|| {
            std::thread::sleep(std::time::Duration::from_millis(40));
            Ok(Box::new(Identity) as Box<dyn Model>)
        });
        let b = ApmBridge::with_enhancer(max_settings(), Enhancer::new(Some(loader)));
        {
            let g = b.lock();
            assert!(!g.enhancer.is_serving(), "ainda carregando");
            assert!(g.denoiser.is_enabled(), "RNNoise cobre enquanto carrega");
        }
        let mut q = noise(FRAME_SAMPLES, 0.3, 5);
        assert!(
            b.process_near(&mut q),
            "o RNNoise processa durante o carregamento"
        );
        wait_serving(&b);
        let mut q = noise(FRAME_SAMPLES, 0.3, 6);
        b.process_near(&mut q);
        assert!(
            !b.lock().denoiser.is_enabled(),
            "DeepFilterNet atendendo: sem RNNoise"
        );
    }

    #[test]
    fn max_without_the_model_reports_unavailable_and_keeps_rnnoise() {
        use std::sync::atomic::AtomicUsize;
        let b = ApmBridge::with_enhancer(max_settings(), Enhancer::new(None));
        let hits = Arc::new(AtomicUsize::new(0));
        let reasons = Arc::new(Mutex::new(Vec::new()));
        {
            let (hits, reasons) = (hits.clone(), reasons.clone());
            b.set_notice_sink(Some(Arc::new(move |n: NoiseFallback| {
                hits.fetch_add(1, Ordering::SeqCst);
                reasons.lock().unwrap().push(n.reason);
            })));
        }
        let mut q = noise(FRAME_SAMPLES, 0.3, 5);
        for _ in 0..5 {
            b.process_near(&mut q);
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1, "o aviso sai uma vez só");
        assert_eq!(reasons.lock().unwrap()[0], FallbackReason::Unavailable);
        assert!(b.lock().denoiser.is_enabled());
    }

    #[test]
    fn leaving_max_releases_the_enhancer_and_keeps_the_apm() {
        use crate::voice::deepfilter::Loader;
        let loader: Loader = Arc::new(|| Ok(Box::new(Identity) as Box<dyn Model>));
        let b = ApmBridge::with_enhancer(max_settings(), Enhancer::new(Some(loader)));
        wait_serving(&b);
        b.configure(strong(true, true));
        {
            let g = b.lock();
            assert!(!g.enhancer.is_enabled());
            assert!(g.denoiser.is_enabled(), "Forte liga o RNNoise");
            assert!(g.apm.is_some());
        }
        let mut q = noise(FRAME_SAMPLES, 0.3, 5);
        b.process_near(&mut q);
        b.process_near(&mut q);
        assert_eq!(
            b.lock().enhancer.state(),
            "off",
            "modelo liberado após o fade-out"
        );
    }
}
