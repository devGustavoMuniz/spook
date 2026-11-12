//! Supressão de ruído "Máximo" (IA): DeepFilterNet3 (Rikorose, MIT OR Apache-2.0), inferência em Rust puro com
//! `tract` (ONNX), SEM Python e sem biblioteca nativa. O modelo vai embutido no binário (~8 MB, feature
//! `deepfilter` do Cargo, ligada por padrão).
//!
//! Módulo com lógica PURA (sem libwebrtc nem tauri): o `Enhancer` fala com um `Model` abstrato, e só o submódulo
//! `model` (atrás da feature `deepfilter`) conhece o `tract`. Assim a decisão de queda por CPU, o carregamento em
//! segundo plano e o crossfade têm `cargo test` real com modelos falsos.
//!
//! Operação, nos mesmos quadros de 10 ms (480 amostras, 48 kHz mono, `i16`) do pipeline do microfone:
//!
//! * **Carregamento preguiçoso, em segundo plano.** `set_enabled(true)` dispara uma thread (`std::thread`, nunca
//!   tokio) que constrói o modelo (alguns centenas de ms) e o aquece; o `process` só faz `try_recv` (não espera).
//!   Até o modelo ficar pronto, `process` devolve `false` sem tocar no quadro e `is_serving()` é falso: quem chama
//!   (`apm.rs`) mantém o RNNoise (Forte) ligado nesse intervalo.
//! * **Proteção contra CPU (`CpuGuard`).** Cada inferência é cronometrada. Se a média passar de 70% do orçamento de
//!   10 ms por 100 quadros (1 s), ou de 100% por 20 quadros (0,2 s: já não acompanha o tempo real), o enhancer
//!   "cai": faz fade-out, libera o modelo, para de ser servido e gera `Notice::Fallback(Cpu)` (o chamador cobre com
//!   o RNNoise e avisa o webview). A queda é pegajosa: só é desfeita desligando e ligando de novo (`set_enabled`).
//! * **Liga/desliga sem estalo:** a mistura entre o sinal original ("seco") e o processado ("molhado") sobe ou desce
//!   linearmente ao longo de um quadro. O molhado sai ~30 ms depois do seco (STFT de 20 ms + 2 quadros de
//!   lookahead do DeepFilterNet3), então durante o fade os dois ficam defasados; a mistura é contínua amostra a
//!   amostra (sem salto), o que é inaudível numa transição de 10 ms (mesmo critério do `rnnoise.rs`).
//! * **Alocação:** o `Enhancer` em si usa só buffers fixos de 480 `f32`. O `tract` aloca tensores pequenos a cada
//!   inferência (não há como evitar sem forkar a biblioteca); por isso isto roda na thread que processa o
//!   microfone (tarefa do tokio), NUNCA no callback de tempo real do cpal.
//! * **Escala:** o DeepFilterNet espera `f32` em ±1,0 (o RNNoise espera a escala de `i16`). A entrada é limitada
//!   a ±0,9998 para não disparar o aviso de clipping da biblioteca a cada quadro.
//! * **Silêncio digital** (RMS < 1e-7) sai como zeros, pela própria biblioteca, a um custo mínimo.
//! * `panic = "abort"` no perfil release: nada aqui faz `unwrap` em dados de áudio.

use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::sync::Arc;
use std::time::Instant;

/// Tamanho do quadro (10 ms a 48 kHz): é o `hop_size` do DeepFilterNet3.
pub const FRAME: usize = 480;

/// Orçamento de tempo por quadro: 10 ms de áudio precisam ser processados em menos de 10 ms de relógio.
pub const BUDGET_US: u64 = 10_000;

/// Limite da média "lenta": 70% do orçamento por 100 quadros (1 s).
pub const SLOW_LIMIT_US: u64 = BUDGET_US * 70 / 100;
pub const SLOW_FRAMES: u32 = 100;
/// Limite da média "rápida": 100% do orçamento por 20 quadros (0,2 s). Já está atrasando o áudio.
pub const FAST_LIMIT_US: u64 = BUDGET_US;
pub const FAST_FRAMES: u32 = 20;

/// Decisão de queda por tempo de processamento. Janelas "em lote" (zeram a cada janela cheia): barato e sem
/// alocação. Pura: recebe a duração de cada quadro em microssegundos.
#[derive(Debug, Clone)]
pub struct CpuGuard {
    slow_frames: u32,
    slow_limit_us: u64,
    fast_frames: u32,
    fast_limit_us: u64,
    slow_sum: u64,
    slow_n: u32,
    fast_sum: u64,
    fast_n: u32,
}

impl Default for CpuGuard {
    fn default() -> Self {
        Self::with_limits(SLOW_FRAMES, SLOW_LIMIT_US, FAST_FRAMES, FAST_LIMIT_US)
    }
}

impl CpuGuard {
    /// `*_frames` = tamanho da janela; `*_limit_us` = média máxima por quadro naquela janela.
    pub fn with_limits(
        slow_frames: u32,
        slow_limit_us: u64,
        fast_frames: u32,
        fast_limit_us: u64,
    ) -> Self {
        Self {
            slow_frames: slow_frames.max(1),
            slow_limit_us,
            fast_frames: fast_frames.max(1),
            fast_limit_us,
            slow_sum: 0,
            slow_n: 0,
            fast_sum: 0,
            fast_n: 0,
        }
    }

    /// Registra o tempo de um quadro. Devolve `true` quando alguma janela cheia estourou o limite.
    pub fn record(&mut self, elapsed_us: u64) -> bool {
        self.slow_sum = self.slow_sum.saturating_add(elapsed_us);
        self.slow_n += 1;
        self.fast_sum = self.fast_sum.saturating_add(elapsed_us);
        self.fast_n += 1;
        let mut trip = false;
        if self.fast_n >= self.fast_frames {
            trip |= self.fast_sum / u64::from(self.fast_n) > self.fast_limit_us;
            self.fast_sum = 0;
            self.fast_n = 0;
        }
        if self.slow_n >= self.slow_frames {
            trip |= self.slow_sum / u64::from(self.slow_n) > self.slow_limit_us;
            self.slow_sum = 0;
            self.slow_n = 0;
        }
        trip
    }

    pub fn reset(&mut self) {
        self.slow_sum = 0;
        self.slow_n = 0;
        self.fast_sum = 0;
        self.fast_n = 0;
    }
}

/// Por que o DeepFilterNet deixou de atender.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackReason {
    /// O processador não acompanha (média de tempo por quadro acima do limite).
    Cpu,
    /// O modelo não carregou (erro ou thread morta).
    LoadFailed,
    /// Compilado sem a feature `deepfilter`.
    Unavailable,
    /// A inferência devolveu erro.
    Runtime,
}

impl FallbackReason {
    /// Texto estável enviado ao webview (`reason` do evento).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::LoadFailed => "load-failed",
            Self::Unavailable => "unavailable",
            Self::Runtime => "error",
        }
    }
}

/// Aviso gerado pelo enhancer; quem chama lê com `take_notice`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    /// O modelo ficou pronto e passou a atender.
    Ready,
    /// Deixou de atender (e não volta sozinho).
    Fallback(FallbackReason),
}

/// Por que uma inferência não devolveu saída.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelError {
    /// Não respondeu a tempo (o processador não acompanha): conta como queda por CPU.
    Timeout,
    /// A inferência falhou ou o modelo deixou de existir.
    Failed,
}

/// Um modelo de supressão: recebe um quadro e escreve o quadro melhorado. `f32` na escala ±1,0.
pub trait Model: Send {
    /// `Err` = o `output` não vale.
    fn process(
        &mut self,
        input: &[f32; FRAME],
        output: &mut [f32; FRAME],
    ) -> Result<(), ModelError>;
}

/// Constrói o modelo (pesado: roda numa thread própria).
pub type Loader = Arc<dyn Fn() -> Result<Box<dyn Model>, String> + Send + Sync>;

type LoadResult = Result<Box<dyn Model>, String>;

enum Phase {
    /// Sem modelo (desligado).
    Off,
    /// Thread carregando; o resultado chega por aqui.
    Loading(Receiver<LoadResult>),
    /// Modelo pronto (inclusive durante o fade-out).
    Ready(Box<dyn Model>),
    /// Não está atendendo, e continua assim até desligar e ligar de novo.
    Failed,
}

pub struct Enhancer {
    loader: Option<Loader>,
    phase: Phase,
    target_on: bool,
    /// A proteção derrubou o modelo (fade-out em curso ou concluído).
    tripped: Option<FallbackReason>,
    /// Mistura atual: 0.0 = só seco (original), 1.0 = só molhado (DeepFilterNet).
    mix: f32,
    guard: CpuGuard,
    notice: Option<Notice>,
    input: [f32; FRAME],
    output: [f32; FRAME],
}

impl Enhancer {
    /// `loader = None` = sem suporte nesta build (`Notice::Fallback(Unavailable)` ao ligar).
    pub fn new(loader: Option<Loader>) -> Self {
        Self {
            loader,
            phase: Phase::Off,
            target_on: false,
            tripped: None,
            mix: 0.0,
            guard: CpuGuard::default(),
            notice: None,
            input: [0.0; FRAME],
            output: [0.0; FRAME],
        }
    }

    /// Com o modelo embutido (feature `deepfilter`); sem a feature, "indisponível".
    pub fn with_default_loader() -> Self {
        Self::new(default_loader())
    }

    /// Troca os limites da proteção (testes).
    pub fn set_guard(&mut self, guard: CpuGuard) {
        self.guard = guard;
    }

    pub fn is_enabled(&self) -> bool {
        self.target_on
    }

    /// O DeepFilterNet está de fato processando (e não deve ser coberto pelo RNNoise)? Falso enquanto carrega,
    /// depois de uma queda e quando desligado.
    pub fn is_serving(&self) -> bool {
        self.target_on && self.tripped.is_none() && matches!(self.phase, Phase::Ready(_))
    }

    /// Estado para log e diagnóstico.
    pub fn state(&self) -> &'static str {
        match self.phase {
            Phase::Off => "off",
            Phase::Loading(_) => "loading",
            Phase::Ready(_) => "ready",
            Phase::Failed => "failed",
        }
    }

    /// Lê (e limpa) o último aviso.
    pub fn take_notice(&mut self) -> Option<Notice> {
        self.notice.take()
    }

    /// Liga ou desliga. Ligar dispara o carregamento em segundo plano (thread própria; não bloqueia). Desligar
    /// faz fade-out e libera o modelo. Pode ser chamado de qualquer thread que NÃO seja o callback do cpal.
    pub fn set_enabled(&mut self, on: bool) {
        if on == self.target_on {
            return;
        }
        self.target_on = on;
        if on {
            self.tripped = None;
            self.guard.reset();
            match self.phase {
                // Estava em fade-out e voltou: reaproveita o modelo.
                Phase::Ready(_) | Phase::Loading(_) => {}
                Phase::Off | Phase::Failed => self.start_loading(),
            }
        } else {
            match self.phase {
                Phase::Loading(_) | Phase::Failed => self.phase = Phase::Off, // descarta o resultado
                Phase::Ready(_) if self.mix <= 0.0 => self.phase = Phase::Off,
                Phase::Ready(_) | Phase::Off => {} // o fade-out termina em `process`
            }
            self.tripped = None;
        }
    }

    fn fail(&mut self, reason: FallbackReason) {
        self.phase = Phase::Failed;
        self.notice = Some(Notice::Fallback(reason));
    }

    fn start_loading(&mut self) {
        let Some(loader) = self.loader.clone() else {
            log::warn!("voz: DeepFilterNet indisponível nesta build");
            self.fail(FallbackReason::Unavailable);
            return;
        };
        let (tx, rx) = channel();
        let spawned = std::thread::Builder::new()
            .name("spook-deepfilter-load".into())
            .spawn(move || {
                let _ = tx.send(loader());
            });
        match spawned {
            Ok(_) => self.phase = Phase::Loading(rx),
            Err(e) => {
                log::warn!("voz: não foi possível iniciar a thread do DeepFilterNet: {e}");
                self.fail(FallbackReason::LoadFailed);
            }
        }
    }

    /// Recolhe o resultado do carregamento, sem esperar.
    fn poll_loading(&mut self) {
        let Phase::Loading(rx) = &self.phase else {
            return;
        };
        match rx.try_recv() {
            Ok(Ok(model)) => {
                log::info!("voz: modelo DeepFilterNet pronto");
                self.phase = Phase::Ready(model);
                self.mix = 0.0;
                self.guard.reset();
                self.notice = Some(Notice::Ready);
            }
            Ok(Err(e)) => {
                log::warn!("voz: falha ao carregar o DeepFilterNet: {e}");
                self.fail(FallbackReason::LoadFailed);
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                log::warn!("voz: a thread do DeepFilterNet terminou sem resultado");
                self.fail(FallbackReason::LoadFailed);
            }
        }
    }

    /// Processa um quadro de 480 amostras no lugar. Devolve `true` se o DeepFilterNet contribuiu com este quadro
    /// (inclusive durante o fade-in/fade-out); `false` (sem tocar) se o tamanho está errado, se o modelo não está
    /// pronto ou se está desligado/caído. Nunca espera nem entra em pânico.
    pub fn process(&mut self, frame: &mut [i16]) -> bool {
        if frame.len() != FRAME {
            return false;
        }
        self.poll_loading();
        if matches!(self.phase, Phase::Ready(_)) && !self.target_on && self.mix <= 0.0 {
            self.phase = Phase::Off; // fade-out terminado: libera o modelo
            return false;
        }
        let Phase::Ready(model) = &mut self.phase else {
            return false;
        };

        for (d, &s) in self.input.iter_mut().zip(frame.iter()) {
            *d = (s as f32 / 32768.0).clamp(-0.9998, 0.9998);
        }
        let started = Instant::now();
        let result = model.process(&self.input, &mut self.output);
        let elapsed_us = started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;

        let mut fell = None;
        if let Err(e) = result {
            // Sem saída válida: o molhado vira cópia do seco (nada de estalo) e o modelo cai.
            self.output = self.input;
            fell = Some(match e {
                ModelError::Timeout => FallbackReason::Cpu,
                ModelError::Failed => FallbackReason::Runtime,
            });
        } else if self.target_on && self.tripped.is_none() && self.guard.record(elapsed_us) {
            fell = Some(FallbackReason::Cpu);
        }
        if let Some(reason) = fell {
            log::warn!(
                "voz: DeepFilterNet desligado ({}); último quadro levou {elapsed_us} µs",
                reason.as_str()
            );
            self.tripped = Some(reason);
            self.notice = Some(Notice::Fallback(reason));
        }

        let target = if self.target_on && self.tripped.is_none() {
            1.0
        } else {
            0.0
        };
        let step = 1.0 / FRAME as f32;
        let mut mix = self.mix;
        for ((out, &dry), &wet) in frame
            .iter_mut()
            .zip(self.input.iter())
            .zip(self.output.iter())
        {
            // Saída inválida (NaN/inf) nunca chega ao áudio.
            let wet = if wet.is_finite() { wet } else { dry };
            if mix < target {
                mix = (mix + step).min(target);
            } else if mix > target {
                mix = (mix - step).max(target);
            }
            let v = (dry + (wet - dry) * mix) * 32768.0;
            *out = v.round().clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        }
        self.mix = mix;

        if target <= 0.0 && mix <= 0.0 {
            self.phase = if self.tripped.is_some() {
                Phase::Failed
            } else {
                Phase::Off
            };
        }
        true
    }
}

/// Carregador do modelo embutido, se a build o tem.
pub fn default_loader() -> Option<Loader> {
    #[cfg(feature = "deepfilter")]
    {
        Some(Arc::new(model::load))
    }
    #[cfg(not(feature = "deepfilter"))]
    {
        None
    }
}

/// Modelo que mora numa thread própria (o `DfTract` do `tract` 0.19 não é `Send`: o estado dos operadores não
/// declara `Send`, então ele é criado, usado e destruído na MESMA thread). O lado do áudio fala com ela por uma
/// troca de um quadro (um `Mutex` + duas `Condvar`, buffers fixos: sem alocação e sem fila). A espera tem prazo:
/// estourou, o modelo é abandonado (`ModelError::Timeout`) e a thread encerra sozinha.
pub mod worker {
    use super::{Model, ModelError, FRAME};
    use std::sync::mpsc::channel;
    use std::sync::{Arc, Condvar, Mutex, MutexGuard};
    use std::time::Duration;

    /// Prazo por quadro: 4x o orçamento de 10 ms. Passou disso o áudio já está atrasando de forma audível.
    pub const REPLY_TIMEOUT: Duration = Duration::from_millis(40);

    /// O modelo de verdade, vivendo (e morrendo) na thread do worker. NÃO exige `Send`.
    pub trait LocalModel {
        fn process(&mut self, input: &[f32; FRAME], output: &mut [f32; FRAME]) -> bool;
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum State {
        Idle,
        Request,
        Done,
        Failed,
        Closed,
    }

    struct Slot {
        input: [f32; FRAME],
        output: [f32; FRAME],
        state: State,
    }

    struct Exchange {
        slot: Mutex<Slot>,
        request: Condvar,
        response: Condvar,
    }

    impl Exchange {
        fn lock(&self) -> MutexGuard<'_, Slot> {
            self.slot.lock().unwrap_or_else(|e| e.into_inner())
        }

        fn close(&self) {
            self.lock().state = State::Closed;
            self.request.notify_all();
            self.response.notify_all();
        }
    }

    /// Fecha a troca quando a thread do worker sai (inclusive por pânico), para o lado do áudio não esperar à toa.
    struct CloseOnExit(Arc<Exchange>);

    impl Drop for CloseOnExit {
        fn drop(&mut self) {
            self.0.close();
        }
    }

    /// Lado do áudio.
    pub struct Handle {
        ex: Arc<Exchange>,
        timeout: Duration,
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            self.ex.close(); // o worker acorda, vê `Closed` e solta o modelo
        }
    }

    impl Model for Handle {
        fn process(
            &mut self,
            input: &[f32; FRAME],
            output: &mut [f32; FRAME],
        ) -> Result<(), ModelError> {
            let mut g = self.ex.lock();
            if g.state != State::Idle {
                return Err(ModelError::Failed); // fechado (worker morreu) ou fora de sincronia
            }
            g.input = *input;
            g.state = State::Request;
            self.ex.request.notify_one();
            let (mut g, _) = self
                .ex
                .response
                .wait_timeout_while(g, self.timeout, |s| s.state == State::Request)
                .unwrap_or_else(|e| e.into_inner());
            match g.state {
                State::Done => {
                    *output = g.output;
                    g.state = State::Idle;
                    Ok(())
                }
                State::Request => {
                    // Prazo estourado: abandona o modelo (o worker vê `Closed` ao terminar e sai).
                    g.state = State::Closed;
                    Err(ModelError::Timeout)
                }
                State::Failed | State::Closed | State::Idle => Err(ModelError::Failed),
            }
        }
    }

    /// Sobe a thread do worker, constrói o modelo DENTRO dela com `build` e espera o resultado. `Err` se a
    /// construção falhar ou a thread morrer. Bloqueia até lá: chame de uma thread de carregamento.
    pub fn spawn<F>(name: &str, timeout: Duration, build: F) -> Result<Box<dyn Model>, String>
    where
        F: FnOnce() -> Result<Box<dyn LocalModel>, String> + Send + 'static,
    {
        let ex = Arc::new(Exchange {
            slot: Mutex::new(Slot {
                input: [0.0; FRAME],
                output: [0.0; FRAME],
                state: State::Idle,
            }),
            request: Condvar::new(),
            response: Condvar::new(),
        });
        let (ready_tx, ready_rx) = channel::<Result<(), String>>();
        let worker_ex = ex.clone();
        std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                let _close = CloseOnExit(worker_ex.clone());
                let mut model = match build() {
                    Ok(m) => {
                        let _ = ready_tx.send(Ok(()));
                        m
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let ex = worker_ex;
                loop {
                    let input = {
                        let mut g = ex.lock();
                        // `Done`: a resposta ainda não foi lida pelo lado do áudio; espera o próximo pedido.
                        while matches!(g.state, State::Idle | State::Done) {
                            g = ex.request.wait(g).unwrap_or_else(|e| e.into_inner());
                        }
                        if g.state != State::Request {
                            return; // `Closed`
                        }
                        g.input
                    };
                    let mut out = [0.0f32; FRAME];
                    let ok = model.process(&input, &mut out);
                    let mut g = ex.lock();
                    if g.state != State::Request {
                        return; // o lado do áudio desistiu enquanto isso
                    }
                    g.output = out;
                    g.state = if ok { State::Done } else { State::Failed };
                    ex.response.notify_one();
                    // Falha: o lado do áudio vê `Failed`, derruba o modelo e o `Drop` do `Handle` fecha tudo.
                    if !ok {
                        return;
                    }
                }
            })
            .map_err(|e| format!("não foi possível iniciar a thread do modelo: {e}"))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Box::new(Handle { ex, timeout })),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("a thread do modelo terminou sem responder".into()),
        }
    }
}

/// DeepFilterNet3 via `tract` (só com a feature `deepfilter`).
#[cfg(feature = "deepfilter")]
pub mod model {
    use super::worker::{self, LocalModel, REPLY_TIMEOUT};
    use super::{Model, FRAME};
    use df::tract::{DfParams, DfTract, RuntimeParams};
    use ndarray::{ArrayView2, ArrayViewMut2};

    struct DeepFilter(DfTract);

    impl LocalModel for DeepFilter {
        fn process(&mut self, input: &[f32; FRAME], output: &mut [f32; FRAME]) -> bool {
            let Ok(noisy) = ArrayView2::from_shape((1, FRAME), &input[..]) else {
                return false;
            };
            let Ok(enh) = ArrayViewMut2::from_shape((1, FRAME), &mut output[..]) else {
                return false;
            };
            self.0.process(noisy, enh).is_ok()
        }
    }

    /// Quadros de aquecimento (a primeira inferência paga alocações e caches): ~0,5 s de ruído baixo.
    const WARMUP_FRAMES: usize = 50;

    fn build() -> Result<Box<dyn LocalModel>, String> {
        let params = DfParams::default();
        let runtime = RuntimeParams::default_with_ch(1);
        let df = DfTract::new(params, &runtime).map_err(|e| format!("{e:#}"))?;
        if df.sr != 48_000 || df.hop_size != FRAME || df.ch != 1 {
            return Err(format!(
                "modelo incompatível: {} Hz, hop {}, {} canais",
                df.sr, df.hop_size, df.ch
            ));
        }
        let mut model = DeepFilter(df);
        let mut input = [0.0f32; FRAME];
        let mut output = [0.0f32; FRAME];
        let mut seed = 12_345u32;
        for _ in 0..WARMUP_FRAMES {
            for s in input.iter_mut() {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *s = ((seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * 0.01;
            }
            if !model.process(&input, &mut output) {
                return Err("a inferência de aquecimento falhou".into());
            }
        }
        Ok(Box::new(model))
    }

    /// Constrói o DeepFilterNet3 embutido numa thread própria e o aquece. Pesado (centenas de ms): chame de uma
    /// thread de carregamento, nunca do áudio.
    pub fn load() -> Result<Box<dyn Model>, String> {
        worker::spawn("spook-deepfilter", REPLY_TIMEOUT, build)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const RATE: f32 = 48_000.0;

    fn sine(n: usize, hz: f32, amp: f32) -> Vec<i16> {
        (0..n)
            .map(|i| ((2.0 * std::f32::consts::PI * hz * i as f32 / RATE).sin() * amp) as i16)
            .collect()
    }

    fn max_jump(x: &[i16]) -> i32 {
        x.windows(2)
            .map(|w| (w[1] as i32 - w[0] as i32).abs())
            .max()
            .unwrap_or(0)
    }

    /// Modelo falso que multiplica por um ganho (0 = "remove tudo", 1 = identidade) e demora `delay`.
    struct Fake {
        gain: f32,
        delay: Duration,
        fail_after: Option<usize>,
        calls: usize,
    }

    impl Fake {
        fn boxed(gain: f32) -> Box<dyn Model> {
            Box::new(Self {
                gain,
                delay: Duration::ZERO,
                fail_after: None,
                calls: 0,
            })
        }
    }

    impl Model for Fake {
        fn process(
            &mut self,
            input: &[f32; FRAME],
            output: &mut [f32; FRAME],
        ) -> Result<(), ModelError> {
            self.calls += 1;
            if self.fail_after.is_some_and(|n| self.calls > n) {
                return Err(ModelError::Failed);
            }
            if !self.delay.is_zero() {
                std::thread::sleep(self.delay);
            }
            for (o, &i) in output.iter_mut().zip(input.iter()) {
                *o = i * self.gain;
            }
            Ok(())
        }
    }

    fn loader_of(f: impl Fn() -> Result<Box<dyn Model>, String> + Send + Sync + 'static) -> Loader {
        Arc::new(f)
    }

    /// Roda quadros até o modelo ficar pronto (a thread de carga é assíncrona).
    fn wait_ready(e: &mut Enhancer) {
        for _ in 0..400 {
            e.poll_loading(); // sem processar nenhum quadro: a mistura continua em 0
            if e.state() != "loading" {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("o modelo falso não ficou pronto");
    }

    fn run(e: &mut Enhancer, input: &[i16]) -> Vec<i16> {
        let mut out = Vec::new();
        for c in input.chunks_exact(FRAME) {
            let mut q = c.to_vec();
            e.process(&mut q);
            out.extend(q);
        }
        out
    }

    #[test]
    fn guard_trips_only_when_the_average_is_over_the_limit() {
        let mut g = CpuGuard::default();
        // 69% do orçamento durante 10 janelas lentas: nunca cai.
        for _ in 0..(SLOW_FRAMES * 10) {
            assert!(!g.record(6_900));
        }
        // 71%: cai ao fechar a janela de 100 quadros.
        let mut g = CpuGuard::default();
        let mut tripped_at = None;
        for i in 0..SLOW_FRAMES {
            if g.record(7_100) {
                tripped_at = Some(i + 1);
                break;
            }
        }
        assert_eq!(tripped_at, Some(SLOW_FRAMES));
    }

    #[test]
    fn guard_ignores_isolated_spikes() {
        let mut g = CpuGuard::default();
        for i in 0..(SLOW_FRAMES * 20) {
            // 1 quadro em 50 leva 30 ms (pico do SO); a média fica longe do limite.
            let us = if i % 50 == 0 { 30_000 } else { 2_000 };
            assert!(
                !g.record(us),
                "pico isolado não deveria derrubar (quadro {i})"
            );
        }
    }

    #[test]
    fn guard_fast_window_catches_falling_behind_real_time() {
        let mut g = CpuGuard::default();
        let mut at = None;
        for i in 0..SLOW_FRAMES {
            if g.record(12_000) {
                at = Some(i + 1);
                break;
            }
        }
        assert_eq!(
            at,
            Some(FAST_FRAMES),
            "100% do orçamento deve cair em 0,2 s"
        );
    }

    #[test]
    fn guard_custom_limits_and_reset() {
        let mut g = CpuGuard::with_limits(4, 100, 2, 1_000);
        assert!(!g.record(50) && !g.record(50) && !g.record(50) && !g.record(50));
        assert!(!g.record(500));
        g.reset();
        assert!(!g.record(101));
        assert!(!g.record(101));
        assert!(!g.record(101));
        assert!(g.record(101), "média 101 > 100 na janela de 4");
        assert_eq!(CpuGuard::with_limits(0, 1, 0, 1).slow_frames, 1);
    }

    #[test]
    fn fallback_reasons_have_stable_names() {
        assert_eq!(FallbackReason::Cpu.as_str(), "cpu");
        assert_eq!(FallbackReason::LoadFailed.as_str(), "load-failed");
        assert_eq!(FallbackReason::Unavailable.as_str(), "unavailable");
        assert_eq!(FallbackReason::Runtime.as_str(), "error");
    }

    #[test]
    fn disabled_is_a_bit_exact_passthrough() {
        let v = sine(FRAME * 4, 300.0, 6000.0);
        let mut e = Enhancer::new(Some(loader_of(|| Ok(Fake::boxed(1.0)))));
        let mut q = v[..FRAME].to_vec();
        assert!(!e.process(&mut q));
        assert_eq!(q, &v[..FRAME]);
        assert!(!e.is_serving() && !e.is_enabled());
        assert_eq!(e.state(), "off");
    }

    #[test]
    fn loading_does_not_block_nor_touch_the_frame() {
        let gate = Arc::new(std::sync::Mutex::new(()));
        let held = gate.lock().unwrap();
        let g2 = gate.clone();
        let mut e = Enhancer::new(Some(loader_of(move || {
            let _wait = g2.lock().unwrap(); // trava até o teste soltar
            Ok(Fake::boxed(0.0))
        })));
        e.set_enabled(true);
        let v = sine(FRAME, 300.0, 6000.0);
        let mut q = v.clone();
        let t = Instant::now();
        assert!(!e.process(&mut q));
        assert!(
            t.elapsed() < Duration::from_millis(100),
            "process esperou o modelo"
        );
        assert_eq!(q, v);
        assert_eq!(e.state(), "loading");
        assert!(!e.is_serving());
        drop(held);
        wait_ready(&mut e);
        assert_eq!(e.state(), "ready");
        assert!(e.is_serving());
        assert_eq!(e.take_notice(), Some(Notice::Ready));
        assert_eq!(e.take_notice(), None);
    }

    #[test]
    fn processes_with_fade_in_and_without_clicks() {
        let mut e = Enhancer::new(Some(loader_of(|| Ok(Fake::boxed(0.0)))));
        e.set_enabled(true);
        wait_ready(&mut e);
        let v = sine(FRAME * 20, 300.0, 8000.0);
        let out = run(&mut e, &v);
        // Primeiro quadro: fade-in do seco para o molhado (silêncio): começa igual e termina quase zerado.
        assert_eq!(out[0], v[0]);
        assert!(out[FRAME - 1].abs() < 100, "{}", out[FRAME - 1]);
        // Daí em diante o modelo "remove tudo".
        assert!(out[FRAME..].iter().all(|&s| s == 0));
        assert!(
            max_jump(&out) <= max_jump(&v) * 2 + 50,
            "salto {}",
            max_jump(&out)
        );
    }

    #[test]
    fn identity_model_is_transparent() {
        let mut e = Enhancer::new(Some(loader_of(|| Ok(Fake::boxed(1.0)))));
        e.set_enabled(true);
        wait_ready(&mut e);
        let v = sine(FRAME * 10, 440.0, 9000.0);
        let out = run(&mut e, &v);
        for (a, b) in v.iter().zip(&out) {
            assert!((*a as i32 - *b as i32).abs() <= 1);
        }
    }

    #[test]
    fn toggling_is_continuous_and_releases_the_model() {
        let mut e = Enhancer::new(Some(loader_of(|| Ok(Fake::boxed(0.0)))));
        e.set_enabled(true);
        wait_ready(&mut e);
        let v = sine(FRAME * 200, 300.0, 6000.0);
        let mut out = Vec::new();
        for (i, c) in v.chunks_exact(FRAME).enumerate() {
            e.set_enabled((i / 40) % 2 == 0);
            let mut q = c.to_vec();
            e.process(&mut q);
            out.extend(q);
        }
        assert!(
            max_jump(&out) <= max_jump(&v) * 3 + 100,
            "descontinuidade ao ligar/desligar: {} (entrada {})",
            max_jump(&out),
            max_jump(&v)
        );
        // Desligado de vez: após o fade-out o modelo é liberado e o quadro passa intacto.
        e.set_enabled(false);
        let mut q = v[..FRAME].to_vec();
        e.process(&mut q);
        let mut q = v[..FRAME].to_vec();
        assert!(!e.process(&mut q));
        assert_eq!(q, &v[..FRAME]);
        assert_eq!(e.state(), "off");
    }

    #[test]
    fn disabling_with_the_model_unused_releases_it_at_once() {
        let mut e = Enhancer::new(Some(loader_of(|| Ok(Fake::boxed(1.0)))));
        e.set_enabled(true);
        wait_ready(&mut e);
        e.set_enabled(false);
        assert_eq!(e.state(), "off");
    }

    #[test]
    fn disabling_while_loading_discards_the_result() {
        let mut e = Enhancer::new(Some(loader_of(|| {
            std::thread::sleep(Duration::from_millis(30));
            Ok(Fake::boxed(1.0))
        })));
        e.set_enabled(true);
        e.set_enabled(false);
        assert_eq!(e.state(), "off");
        std::thread::sleep(Duration::from_millis(80));
        let mut q = vec![5i16; FRAME];
        assert!(!e.process(&mut q));
        assert_eq!(e.state(), "off");
        assert_eq!(e.take_notice(), None);
    }

    #[test]
    fn load_failure_is_reported_once_and_is_sticky() {
        let mut e = Enhancer::new(Some(loader_of(|| Err("modelo corrompido".into()))));
        e.set_enabled(true);
        let mut q = vec![0i16; FRAME];
        for _ in 0..400 {
            e.process(&mut q);
            if e.state() == "failed" {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(e.state(), "failed");
        assert!(!e.is_serving());
        assert_eq!(
            e.take_notice(),
            Some(Notice::Fallback(FallbackReason::LoadFailed))
        );
        // Ligar de novo (mesmo nível reenviado) não tenta outra vez; só desligar e ligar.
        e.set_enabled(true);
        assert_eq!(e.take_notice(), None);
        e.set_enabled(false);
        assert_eq!(e.state(), "off");
    }

    #[test]
    fn a_panicking_loader_is_a_load_failure() {
        let mut e = Enhancer::new(Some(loader_of(|| panic!("tract exploded"))));
        e.set_enabled(true);
        let mut q = vec![0i16; FRAME];
        for _ in 0..400 {
            e.process(&mut q);
            if e.state() == "failed" {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            e.take_notice(),
            Some(Notice::Fallback(FallbackReason::LoadFailed))
        );
    }

    #[test]
    fn without_a_loader_the_level_is_unavailable() {
        let mut e = Enhancer::new(None);
        e.set_enabled(true);
        assert_eq!(
            e.take_notice(),
            Some(Notice::Fallback(FallbackReason::Unavailable))
        );
        assert!(!e.is_serving());
        let mut q = vec![7i16; FRAME];
        assert!(!e.process(&mut q));
        assert!(q.iter().all(|&s| s == 7));
    }

    #[test]
    fn slow_model_falls_back_with_a_smooth_fade_and_stays_down() {
        let mut e = Enhancer::new(Some(loader_of(|| {
            Ok(Box::new(Fake {
                gain: 0.0,
                delay: Duration::from_millis(3),
                fail_after: None,
                calls: 0,
            }))
        })));
        // Janela pequena para o teste: 10 quadros, limite de média 1 ms (o modelo falso leva >= 3 ms).
        e.set_guard(CpuGuard::with_limits(10, 1_000, 5, 1_000));
        e.set_enabled(true);
        wait_ready(&mut e);
        assert!(e.is_serving());
        let v = sine(FRAME * 40, 300.0, 8000.0);
        let out = run(&mut e, &v);
        assert!(!e.is_serving(), "deveria ter caído");
        assert_eq!(e.state(), "failed");
        assert_eq!(e.take_notice(), Some(Notice::Fallback(FallbackReason::Cpu)));
        assert_eq!(e.take_notice(), None, "o aviso sai uma vez só");
        assert!(
            max_jump(&out) <= max_jump(&v) * 2 + 100,
            "salto {}",
            max_jump(&out)
        );
        // Depois da queda o quadro passa intacto (quem chama cobre com o RNNoise).
        let mut q = v[..FRAME].to_vec();
        assert!(!e.process(&mut q));
        assert_eq!(q, &v[..FRAME]);
        // Reenviar o mesmo nível não revive o modelo.
        e.set_enabled(true);
        assert!(!e.is_serving());
        // Desligar e ligar de novo recarrega.
        e.set_enabled(false);
        e.set_enabled(true);
        assert_eq!(e.state(), "loading");
    }

    #[test]
    fn a_fast_model_never_falls() {
        let mut e = Enhancer::new(Some(loader_of(|| Ok(Fake::boxed(1.0)))));
        e.set_enabled(true);
        wait_ready(&mut e);
        let v = sine(FRAME * 500, 300.0, 8000.0);
        let _ = run(&mut e, &v);
        assert!(e.is_serving());
        assert_eq!(e.take_notice(), Some(Notice::Ready));
    }

    #[test]
    fn inference_error_falls_back_without_a_click() {
        let mut e = Enhancer::new(Some(loader_of(|| {
            Ok(Box::new(Fake {
                gain: 1.0,
                delay: Duration::ZERO,
                fail_after: Some(10),
                calls: 0,
            }))
        })));
        e.set_enabled(true);
        wait_ready(&mut e);
        let v = sine(FRAME * 30, 300.0, 8000.0);
        let out = run(&mut e, &v);
        assert_eq!(
            e.take_notice(),
            Some(Notice::Fallback(FallbackReason::Runtime))
        );
        assert_eq!(e.state(), "failed");
        assert!(max_jump(&out) <= max_jump(&v) * 2 + 100);
        assert_eq!(&out[out.len() - FRAME..], &v[v.len() - FRAME..]);
    }

    #[test]
    fn nan_from_the_model_never_reaches_the_audio() {
        struct Nan;
        impl Model for Nan {
            fn process(
                &mut self,
                _: &[f32; FRAME],
                o: &mut [f32; FRAME],
            ) -> Result<(), ModelError> {
                o.fill(f32::NAN);
                Ok(())
            }
        }
        let mut e = Enhancer::new(Some(loader_of(|| Ok(Box::new(Nan)))));
        e.set_enabled(true);
        wait_ready(&mut e);
        let v = sine(FRAME * 5, 300.0, 5000.0);
        let out = run(&mut e, &v);
        for (a, b) in v.iter().zip(&out) {
            assert!((*a as i32 - *b as i32).abs() <= 1);
        }
    }

    #[test]
    fn wrong_sizes_never_panic() {
        let mut e = Enhancer::new(Some(loader_of(|| Ok(Fake::boxed(1.0)))));
        e.set_enabled(true);
        wait_ready(&mut e);
        for len in [0, 1, 479, 481, 960] {
            let mut q = vec![1000i16; len];
            assert!(!e.process(&mut q));
            assert!(q.iter().all(|&s| s == 1000));
        }
    }

    #[test]
    fn extreme_samples_do_not_overflow() {
        let mut e = Enhancer::new(Some(loader_of(|| Ok(Fake::boxed(1.0)))));
        e.set_enabled(true);
        wait_ready(&mut e);
        let loud: Vec<i16> = (0..FRAME * 20)
            .map(|i| {
                if (i / 20) % 2 == 0 {
                    i16::MAX
                } else {
                    i16::MIN
                }
            })
            .collect();
        let _ = run(&mut e, &loud);
    }

    // ----- worker (modelo que não é `Send`) -----

    use super::worker::{self, LocalModel};
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Modelo local NÃO `Send` (guarda um `Rc`), para provar que ele nasce e morre na thread do worker.
    struct LocalGain {
        _not_send: std::rc::Rc<()>,
        gain: f32,
        sleep: Duration,
        ok: bool,
        dropped: Option<Arc<AtomicBool>>,
    }

    impl LocalGain {
        fn new(gain: f32) -> Self {
            Self {
                _not_send: std::rc::Rc::new(()),
                gain,
                sleep: Duration::ZERO,
                ok: true,
                dropped: None,
            }
        }
    }

    impl LocalModel for LocalGain {
        fn process(&mut self, input: &[f32; FRAME], output: &mut [f32; FRAME]) -> bool {
            if !self.sleep.is_zero() {
                std::thread::sleep(self.sleep);
            }
            for (o, &i) in output.iter_mut().zip(input.iter()) {
                *o = i * self.gain;
            }
            self.ok
        }
    }

    impl Drop for LocalGain {
        fn drop(&mut self) {
            if let Some(f) = &self.dropped {
                f.store(true, Ordering::SeqCst);
            }
        }
    }

    fn spawn_gain(
        timeout: Duration,
        f: impl FnOnce() -> LocalGain + Send + 'static,
    ) -> Result<Box<dyn Model>, String> {
        worker::spawn("spook-test-model", timeout, move || {
            Ok(Box::new(f()) as Box<dyn LocalModel>)
        })
    }

    #[test]
    fn worker_round_trips_frames_in_order() {
        let mut m = spawn_gain(Duration::from_secs(2), || LocalGain::new(0.5)).unwrap();
        let mut out = [0.0f32; FRAME];
        for n in 0..200 {
            let mut inp = [0.0f32; FRAME];
            for (i, s) in inp.iter_mut().enumerate() {
                *s = ((n * FRAME + i) % 1000) as f32 / 2000.0;
            }
            m.process(&inp, &mut out).unwrap();
            for (a, b) in inp.iter().zip(out.iter()) {
                assert_eq!(*a * 0.5, *b);
            }
        }
    }

    #[test]
    fn worker_build_error_is_returned() {
        let r = worker::spawn("spook-test-model", Duration::from_secs(1), || {
            Err("sem modelo".to_string())
        });
        assert_eq!(r.err().as_deref(), Some("sem modelo"));
    }

    #[test]
    fn worker_failure_is_an_error_and_the_model_is_released() {
        let dropped = Arc::new(AtomicBool::new(false));
        let d = dropped.clone();
        let mut m = spawn_gain(Duration::from_secs(2), move || {
            let mut l = LocalGain::new(1.0);
            l.ok = false;
            l.dropped = Some(d);
            l
        })
        .unwrap();
        let mut out = [0.0f32; FRAME];
        assert_eq!(m.process(&[0.1; FRAME], &mut out), Err(ModelError::Failed));
        // Depois da falha a troca está fechada: nada de ficar esperando.
        let t = Instant::now();
        assert_eq!(m.process(&[0.1; FRAME], &mut out), Err(ModelError::Failed));
        assert!(t.elapsed() < Duration::from_millis(500));
        for _ in 0..200 {
            if dropped.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("o modelo local não foi liberado");
    }

    #[test]
    fn worker_timeout_abandons_the_model() {
        let dropped = Arc::new(AtomicBool::new(false));
        let d = dropped.clone();
        let mut m = spawn_gain(Duration::from_millis(20), move || {
            let mut l = LocalGain::new(1.0);
            l.sleep = Duration::from_millis(150);
            l.dropped = Some(d);
            l
        })
        .unwrap();
        let mut out = [0.0f32; FRAME];
        let t = Instant::now();
        assert_eq!(m.process(&[0.1; FRAME], &mut out), Err(ModelError::Timeout));
        assert!(
            t.elapsed() < Duration::from_millis(140),
            "esperou além do prazo"
        );
        assert_eq!(m.process(&[0.1; FRAME], &mut out), Err(ModelError::Failed));
        for _ in 0..200 {
            if dropped.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("a thread do worker não encerrou depois do prazo");
    }

    #[test]
    fn dropping_the_handle_releases_the_local_model() {
        let dropped = Arc::new(AtomicBool::new(false));
        let d = dropped.clone();
        let m = spawn_gain(Duration::from_secs(1), move || {
            let mut l = LocalGain::new(1.0);
            l.dropped = Some(d);
            l
        })
        .unwrap();
        assert!(!dropped.load(Ordering::SeqCst));
        drop(m);
        for _ in 0..200 {
            if dropped.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("o modelo local não foi liberado ao soltar o handle");
    }

    #[test]
    fn enhancer_on_a_slow_worker_falls_back_to_cpu_and_stays_smooth() {
        let loader = loader_of(|| {
            worker::spawn("spook-test-model", Duration::from_millis(15), || {
                let mut l = LocalGain::new(0.0);
                l.sleep = Duration::from_millis(60);
                Ok(Box::new(l) as Box<dyn LocalModel>)
            })
        });
        let mut e = Enhancer::new(Some(loader));
        e.set_enabled(true);
        wait_ready(&mut e);
        let v = sine(FRAME * 6, 300.0, 8000.0);
        let out = run(&mut e, &v);
        assert_eq!(e.take_notice(), Some(Notice::Fallback(FallbackReason::Cpu)));
        assert!(!e.is_serving());
        assert!(max_jump(&out) <= max_jump(&v) * 2 + 100);
    }

    #[test]
    fn enhancer_can_move_across_threads() {
        fn assert_send<T: Send>() {}
        assert_send::<Enhancer>();
    }
}

// ----- modelo REAL (só com a feature; ignorado por padrão: carrega ~8 MB e leva segundos) -----
//
// Rodar: `cargo test --release --lib deepfilter::real_model -- --ignored --nocapture`. Compara RNNoise e
// DeepFilterNet com PCM sintético (voz de harmônicos + ventilador + cliques de teclado) e imprime o atraso, a
// redução de ruído e o tempo por quadro (indicativo: depende da máquina).
#[cfg(all(test, feature = "deepfilter"))]
mod real_model {
    use super::*;
    use crate::voice::rnnoise::Denoiser;
    use std::time::Duration;

    const RATE: f32 = 48_000.0;

    struct Rng(u32);
    impl Rng {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (self.0 >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        }
    }

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

    fn db(a: f64, b: f64) -> f64 {
        20.0 * (a / b.max(1e-9)).log10()
    }

    fn ready_enhancer() -> Enhancer {
        let mut e = Enhancer::with_default_loader();
        e.set_enabled(true);
        let t = Instant::now();
        for _ in 0..2000 {
            e.poll_loading();
            if e.state() != "loading" {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        eprintln!(
            "carga do modelo: {} ms ({})",
            t.elapsed().as_millis(),
            e.state()
        );
        assert!(e.is_serving(), "o modelo real deveria carregar");
        e
    }

    fn run_df(e: &mut Enhancer, input: &[i16], times: &mut Vec<u64>) -> Vec<i16> {
        let mut out = Vec::with_capacity(input.len());
        for c in input.chunks_exact(FRAME) {
            let mut q = c.to_vec();
            let t = Instant::now();
            e.process(&mut q);
            times.push(t.elapsed().as_micros() as u64);
            out.extend(q);
        }
        out
    }

    fn run_rn(d: &mut Denoiser, input: &[i16], times: &mut Vec<u64>) -> Vec<i16> {
        let mut out = Vec::with_capacity(input.len());
        for c in input.chunks_exact(FRAME) {
            let mut q = c.to_vec();
            let t = Instant::now();
            d.process(&mut q);
            times.push(t.elapsed().as_micros() as u64);
            out.extend(q);
        }
        out
    }

    fn stats(label: &str, mut t: Vec<u64>) {
        t.sort_unstable();
        let mean = t.iter().sum::<u64>() as f64 / t.len() as f64;
        eprintln!(
            "{label}: tempo por quadro de 10 ms: média {mean:.0} µs ({:.1}% do orçamento), p50 {} µs, p99 {} µs, máx {} µs",
            mean / BUDGET_US as f64 * 100.0,
            t[t.len() / 2],
            t[t.len() * 99 / 100],
            t[t.len() - 1]
        );
    }

    /// Atraso (em amostras) que maximiza a correlação entre os ENVELOPES (|x| suavizado, 5 ms) da entrada e da
    /// saída: a voz sintética é periódica (130 Hz), então a correlação direta teria vários picos falsos.
    fn lag(input: &[i16], output: &[i16]) -> usize {
        fn envelope(x: &[i16]) -> Vec<f64> {
            let w = 240;
            let mut acc = 0.0;
            let mut out = Vec::with_capacity(x.len());
            for i in 0..x.len() {
                acc += (x[i] as f64).abs();
                if i >= w {
                    acc -= (x[i - w] as f64).abs();
                }
                out.push(acc / w as f64);
            }
            out
        }
        let (ei, eo) = (envelope(input), envelope(output));
        let (skip, n) = (48_000, 96_000);
        let mut best = (0usize, f64::MIN);
        for lag in (0..4800).step_by(8) {
            let mut acc = 0.0;
            for i in skip..skip + n {
                acc += ei[i] * eo[i + lag];
            }
            if acc > best.1 {
                best = (lag, acc);
            }
        }
        best.0
    }

    #[test]
    #[ignore = "carrega o modelo real; ver o comentário do módulo"]
    fn rnnoise_vs_deepfilternet_on_synthetic_pcm() {
        let n = 48_000 * 8;
        let tail = 48_000 * 3; // pula carga/aquecimento do estado
        let clean = voice(n, 8000.0);
        let noise = fan_and_clicks(n, 1500.0);
        let noisy: Vec<f32> = clean.iter().zip(&noise).map(|(a, b)| a + b).collect();
        let (noise_i, noisy_i, clean_i) = (to_i16(&noise), to_i16(&noisy), to_i16(&clean));

        let mut e = ready_enhancer();
        let mut t_df = Vec::new();
        let df_noise = run_df(&mut e, &noise_i, &mut t_df);
        let df_drop = db(rms(&noise_i[tail..]), rms(&df_noise[tail..]));
        let mut e2 = ready_enhancer();
        let df_mix = run_df(&mut e2, &noisy_i, &mut t_df);

        let mut d = Denoiser::new();
        d.set_enabled(true);
        let mut t_rn = Vec::new();
        let rn_noise = run_rn(&mut d, &noise_i, &mut t_rn);
        let rn_drop = db(rms(&noise_i[tail..]), rms(&rn_noise[tail..]));
        let mut d2 = Denoiser::new();
        d2.set_enabled(true);
        let rn_mix = run_rn(&mut d2, &noisy_i, &mut t_rn);

        eprintln!("ruído sozinho (ventilador + cliques): RNNoise {rn_drop:.1} dB, DeepFilterNet {df_drop:.1} dB de redução");
        eprintln!(
            "voz sintética + ruído, nível da saída vs. voz limpa: RNNoise {:+.1} dB, DeepFilterNet {:+.1} dB (entrada com ruído {:+.1} dB)",
            db(rms(&rn_mix[tail..]), rms(&clean_i[tail..])),
            db(rms(&df_mix[tail..]), rms(&clean_i[tail..])),
            db(rms(&noisy_i[tail..]), rms(&clean_i[tail..])),
        );
        // Atraso medido na voz sem ruído.
        let mut e3 = ready_enhancer();
        let df_clean = run_df(&mut e3, &clean_i, &mut Vec::new());
        let l = lag(&clean_i, &df_clean);
        eprintln!(
            "atraso do DeepFilterNet: {l} amostras = {:.1} ms",
            l as f32 / RATE * 1000.0
        );
        stats("DeepFilterNet (inclui a troca de thread)", t_df);
        stats("RNNoise", t_rn);
        eprintln!("estado final do enhancer: serving = {}", e.is_serving());
        assert!(
            df_drop > 6.0,
            "o ruído deveria cair > 6 dB, caiu {df_drop:.1}"
        );
    }
}
