//! Áudio por aplicativo no compartilhamento de tela: lógica PURA (sem tauri, sem windows, sem cpal), com
//! `cargo test` real. A captura em si (WASAPI "process loopback") fica em `winaudio.rs`; aqui moram o formato dos
//! parâmetros, a decisão do que capturar, o agrupamento de sessões por executável, a árvore de processos, a
//! reconciliação das capturas, a fila de quadros, a mixagem com ganho individual × master e o limitador.
//!
//! Formato do áudio de tela: 48 kHz, estéreo, intercalado (L R L R...), blocos de 10 ms (480 quadros = 960 amostras).

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
/// Quadros (amostras por canal) de um bloco de 10 ms.
pub const BLOCK_FRAMES: usize = 480;
/// Amostras (intercaladas) de um bloco de 10 ms.
pub const BLOCK_SAMPLES: usize = BLOCK_FRAMES * CHANNELS;
/// Teto da fila de cada captura: 500 ms. O que passar disso é o mais antigo e é descartado (relógio que deriva).
pub const QUEUE_MAX_SAMPLES: usize = SAMPLE_RATE as usize / 2 * CHANNELS;

/// Primeira versão do Windows 10 que tem o "process loopback" do WASAPI na prática (2004, build 19041; é o piso que
/// o OBS usa). A documentação da Microsoft cita a build 20348, mas a API existe antes; se a ativação falhar em
/// runtime o compartilhamento segue só com a imagem (ver `core.rs`).
pub const MIN_WINDOWS_BUILD: u32 = 19_041;

/// Modo do áudio do compartilhamento.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppAudioMode {
    /// Todo o sistema, MENOS o próprio Spook (evita eco das vozes da chamada).
    #[default]
    System,
    /// Só os aplicativos escolhidos.
    Apps,
}

fn full_volume() -> f32 {
    100.0
}

/// Um aplicativo escolhido: executável (nome do arquivo, não PID) e volume de 0 a 100.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSelection {
    pub exe: String,
    pub volume: f32,
}

impl Default for AppSelection {
    fn default() -> Self {
        Self {
            exe: String::new(),
            volume: full_volume(),
        }
    }
}

/// Parâmetro `audioApps` de `voice_set_screen_share`. Ausente = formato antigo (`audio: true` = modo `system`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppAudioOptions {
    pub mode: AppAudioMode,
    /// Volume master de 0 a 100.
    pub master: f32,
    pub apps: Vec<AppSelection>,
}

impl Default for AppAudioOptions {
    fn default() -> Self {
        Self {
            mode: AppAudioMode::System,
            master: full_volume(),
            apps: Vec::new(),
        }
    }
}

/// Volume de 0 a 100 (%) -> ganho linear. Curva quadrática (50% = -12 dB), mais natural ao ouvido que a linear;
/// 0 = mudo, 100 = ganho 1. Fora da faixa é limitado; NaN vale 100 (o padrão).
pub fn volume_to_gain(percent: f32) -> f32 {
    let p = if percent.is_nan() { 100.0 } else { percent };
    let n = p.clamp(0.0, 100.0) / 100.0;
    n * n
}

/// Nome do arquivo do executável em minúsculas, sem pasta: `C:\\Apps\\Spotify.EXE` -> `spotify.exe`. É a chave que
/// a interface persiste (PID muda a cada execução).
pub fn normalize_exe(path_or_name: &str) -> String {
    let t = path_or_name.trim();
    let name = t.rsplit(['\\', '/']).next().unwrap_or(t);
    name.to_lowercase()
}

/// Nome de exibição quando o SO não dá um: `spotify.exe` -> `Spotify`.
pub fn pretty_name(exe: &str) -> String {
    let stem = exe.strip_suffix(".exe").unwrap_or(exe);
    let mut chars = stem.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Uma sessão de áudio crua do SO.
#[derive(Debug, Clone, PartialEq)]
pub struct RawSession {
    pub pid: u32,
    /// Caminho completo ou nome do executável.
    pub exe_path: String,
    pub display_name: Option<String>,
    pub icon: Option<String>,
    /// A sessão está tocando agora (estado "ativo").
    pub playing: bool,
}

/// Aplicativo da lista do diálogo.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioApp {
    /// Estável entre execuções: o próprio executável normalizado.
    pub id: String,
    pub name: String,
    pub exe: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub playing: bool,
}

/// Resposta de `voice_list_audio_apps`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioAppsResponse {
    /// A plataforma consegue captar áudio por aplicativo.
    pub supported: bool,
    /// Por que não (só com `supported: false`): `platform` | `windows-version` | `error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub apps: Vec<AudioApp>,
}

impl AudioAppsResponse {
    pub fn unsupported(reason: &'static str) -> Self {
        Self {
            supported: false,
            reason: Some(reason),
            apps: Vec::new(),
        }
    }
}

/// Sessões -> lista da interface: tira o Spook (e os filhos dele, p.ex. o WebView2), agrupa por executável
/// (vários processos do mesmo app viram uma linha), ordena os que tocam primeiro e depois por nome.
pub fn group_sessions(sessions: Vec<RawSession>, is_self: &dyn Fn(u32) -> bool) -> Vec<AudioApp> {
    let mut by_exe: HashMap<String, AudioApp> = HashMap::new();
    for s in sessions {
        if s.pid == 0 || is_self(s.pid) {
            continue;
        }
        let exe = normalize_exe(&s.exe_path);
        if exe.is_empty() {
            continue;
        }
        let entry = by_exe.entry(exe.clone()).or_insert_with(|| AudioApp {
            id: exe.clone(),
            name: s
                .display_name
                .clone()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| pretty_name(&exe)),
            exe: exe.clone(),
            icon: s.icon.clone(),
            playing: false,
        });
        entry.playing |= s.playing;
        if entry.icon.is_none() {
            entry.icon = s.icon;
        }
    }
    let mut apps: Vec<AudioApp> = by_exe.into_values().collect();
    apps.sort_by(|a, b| {
        b.playing
            .cmp(&a.playing)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.exe.cmp(&b.exe))
    });
    apps
}

/// Um processo em execução (tabela do SO).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    /// Nome do arquivo do executável, normalizado.
    pub exe: String,
}

pub fn parent_map(procs: &[ProcessInfo]) -> HashMap<u32, u32> {
    procs.iter().map(|p| (p.pid, p.ppid)).collect()
}

/// `pid` é `root` ou descende dele? Com trava contra ciclos (PID reaproveitado pode formar um laço na tabela).
pub fn is_in_tree(pid: u32, root: u32, parent: &HashMap<u32, u32>) -> bool {
    let mut cur = pid;
    for _ in 0..64 {
        if cur == root {
            return true;
        }
        match parent.get(&cur) {
            Some(&p) if p != cur && p != 0 => cur = p,
            _ => return false,
        }
    }
    false
}

/// Tira de `pids` os que descendem de outro `pid` da lista: a captura "incluir árvore" do pai já os cobre, e
/// capturar duas vezes dobraria o volume.
pub fn prune_descendants(pids: &[u32], parent: &HashMap<u32, u32>) -> Vec<u32> {
    let set: HashSet<u32> = pids.iter().copied().collect();
    let mut out: Vec<u32> = pids
        .iter()
        .copied()
        .filter(|&pid| {
            !set.iter().any(|&other| {
                other != pid && is_in_tree(pid, other, parent) && !is_in_tree(other, pid, parent)
            })
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Quais processos capturar agora: os executáveis escolhidos que estão rodando, sem o Spook (nem filhos) e só
/// as raízes de cada árvore. Devolve `(pid, executável)`.
pub fn desired_targets(
    selected: &HashSet<String>,
    procs: &[ProcessInfo],
    own_pid: u32,
) -> Vec<(u32, String)> {
    let parent = parent_map(procs);
    let candidates: Vec<&ProcessInfo> = procs
        .iter()
        .filter(|p| selected.contains(&p.exe) && !is_in_tree(p.pid, own_pid, &parent))
        .collect();
    let pids: Vec<u32> = candidates.iter().map(|p| p.pid).collect();
    let roots: HashSet<u32> = prune_descendants(&pids, &parent).into_iter().collect();
    let mut out: Vec<(u32, String)> = candidates
        .into_iter()
        .filter(|p| roots.contains(&p.pid))
        .map(|p| (p.pid, p.exe.clone()))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Diferença entre o que está sendo capturado e o que deveria estar: `(iniciar, parar)`.
pub fn reconcile(current: &HashSet<u32>, desired: &HashSet<u32>) -> (Vec<u32>, Vec<u32>) {
    let mut start: Vec<u32> = desired.difference(current).copied().collect();
    let mut stop: Vec<u32> = current.difference(desired).copied().collect();
    start.sort_unstable();
    stop.sort_unstable();
    (start, stop)
}

/// O que capturar.
#[derive(Debug, Clone, PartialEq)]
pub enum CapturePlan {
    /// Sem áudio (não pedido, plataforma sem suporte ou nenhum aplicativo marcado).
    Off(OffReason),
    /// Todo o sistema menos o Spook; `master` já é ganho linear.
    System { master: f32 },
    /// Só estes executáveis (ganho linear de cada um) com o ganho linear do master.
    Apps {
        gains: HashMap<String, f32>,
        master: f32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffReason {
    NotRequested,
    UnsupportedPlatform,
    UnsupportedWindowsVersion,
    NoAppSelected,
}

/// Ambiente de captura (decisão de recuo).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsSupport {
    Supported,
    /// Windows antes da build mínima.
    OldWindows,
    /// macOS/Linux: o `scap` 0.0.8 não captura áudio.
    OtherPlatform,
}

/// Regra única de decisão. `audio` é o pedido (interruptor); `opts` ausente = formato antigo = `system`.
pub fn decide(audio: bool, opts: Option<&AppAudioOptions>, os: OsSupport) -> CapturePlan {
    if !audio {
        return CapturePlan::Off(OffReason::NotRequested);
    }
    match os {
        OsSupport::OtherPlatform => return CapturePlan::Off(OffReason::UnsupportedPlatform),
        OsSupport::OldWindows => return CapturePlan::Off(OffReason::UnsupportedWindowsVersion),
        OsSupport::Supported => {}
    }
    let default = AppAudioOptions::default();
    let opts = opts.unwrap_or(&default);
    let master = volume_to_gain(opts.master);
    match opts.mode {
        AppAudioMode::System => CapturePlan::System { master },
        AppAudioMode::Apps => {
            let mut gains: HashMap<String, f32> = HashMap::new();
            for a in &opts.apps {
                let exe = normalize_exe(&a.exe);
                if !exe.is_empty() {
                    gains.insert(exe, volume_to_gain(a.volume));
                }
            }
            if gains.is_empty() {
                CapturePlan::Off(OffReason::NoAppSelected)
            } else {
                CapturePlan::Apps { gains, master }
            }
        }
    }
}

/// Fila de amostras f32 intercaladas de UMA captura, com pequeno "jitter buffer": só começa a entregar com 20 ms
/// acumulados e, se esvaziar, volta a esperar (em vez de entregar blocos quebrados). Limitada a 500 ms.
#[derive(Debug, Default)]
pub struct FrameQueue {
    buf: VecDeque<f32>,
    primed: bool,
}

impl FrameQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn push(&mut self, samples: &[f32]) {
        self.buf.extend(samples.iter().copied());
        let over = self.buf.len().saturating_sub(QUEUE_MAX_SAMPLES);
        if over > 0 {
            // Descarta o mais antigo, em múltiplos de um quadro para não trocar L/R de lugar.
            let drop = over.div_ceil(CHANNELS) * CHANNELS;
            self.buf.drain(..drop.min(self.buf.len()));
        }
    }

    /// Um bloco de 10 ms, ou `None` se ainda não há o suficiente (o chamador trata como silêncio).
    pub fn pop_block(&mut self) -> Option<Vec<f32>> {
        if !self.primed {
            if self.buf.len() >= BLOCK_SAMPLES * 2 {
                self.primed = true;
            } else {
                return None;
            }
        }
        if self.buf.len() < BLOCK_SAMPLES {
            self.primed = false;
            return None;
        }
        Some(self.buf.drain(..BLOCK_SAMPLES).collect())
    }
}

/// Limitador contra clipping: ataque instantâneo (nunca passa de `CEILING`), liberação suave.
#[derive(Debug, Clone)]
pub struct Limiter {
    gain: f32,
}

impl Default for Limiter {
    fn default() -> Self {
        Self { gain: 1.0 }
    }
}

impl Limiter {
    /// Teto de pico (um pouco abaixo de 1,0 para sobrar margem na conversão para i16).
    pub const CEILING: f32 = 0.98;
    /// Fração da diferença recuperada por amostra (~ 0,25 s para voltar a 1).
    const RELEASE: f32 = 1.0 / 24_000.0;

    pub fn new() -> Self {
        Self::default()
    }

    pub fn gain(&self) -> f32 {
        self.gain
    }

    pub fn process(&mut self, samples: &mut [f32]) {
        for s in samples.iter_mut() {
            if !s.is_finite() {
                *s = 0.0;
            }
            let peak = s.abs() * self.gain;
            if peak > Self::CEILING {
                self.gain = Self::CEILING / s.abs();
            } else if self.gain < 1.0 {
                self.gain = (self.gain + (1.0 - self.gain) * Self::RELEASE).min(1.0);
            }
            *s = (*s * self.gain).clamp(-Self::CEILING, Self::CEILING);
        }
    }
}

/// Mixa os blocos (cada um com o seu ganho linear) multiplicados pelo ganho do master, passa pelo limitador e
/// converte para i16. `inputs` com tamanhos diferentes de `out` são lidos até onde vão (o resto conta como 0).
pub fn mix_block(inputs: &[(&[f32], f32)], master: f32, limiter: &mut Limiter, out: &mut [i16]) {
    let mut acc = vec![0.0f32; out.len()];
    for (block, gain) in inputs {
        let g = gain * master;
        if g == 0.0 {
            continue;
        }
        for (a, s) in acc.iter_mut().zip(block.iter()) {
            *a += *s * g;
        }
    }
    limiter.process(&mut acc);
    for (o, a) in out.iter_mut().zip(acc.iter()) {
        *o = (*a * 32767.0).round() as i16;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(pid: u32, path: &str, playing: bool) -> RawSession {
        RawSession {
            pid,
            exe_path: path.into(),
            display_name: None,
            icon: None,
            playing,
        }
    }

    #[test]
    fn volume_maps_to_a_quadratic_gain() {
        assert_eq!(volume_to_gain(0.0), 0.0);
        assert_eq!(volume_to_gain(100.0), 1.0);
        assert!((volume_to_gain(50.0) - 0.25).abs() < 1e-6);
        assert_eq!(volume_to_gain(250.0), 1.0);
        assert_eq!(volume_to_gain(-5.0), 0.0);
        assert_eq!(volume_to_gain(f32::NAN), 1.0);
    }

    #[test]
    fn exe_is_normalized_to_a_lowercase_file_name() {
        assert_eq!(normalize_exe("C:\\Apps\\Spotify.EXE"), "spotify.exe");
        assert_eq!(normalize_exe("  /usr/bin/Firefox "), "firefox");
        assert_eq!(normalize_exe("chrome.exe"), "chrome.exe");
        assert_eq!(normalize_exe(""), "");
        assert_eq!(pretty_name("spotify.exe"), "Spotify");
    }

    #[test]
    fn options_accept_the_new_shape_and_defaults() {
        let o: AppAudioOptions = serde_json::from_str(
            r#"{"mode":"apps","master":80,"apps":[{"exe":"Spotify.exe","volume":40},{"exe":"x.exe"}]}"#,
        )
        .unwrap();
        assert_eq!(o.mode, AppAudioMode::Apps);
        assert_eq!(o.master, 80.0);
        assert_eq!(o.apps[0].volume, 40.0);
        assert_eq!(o.apps[1].volume, 100.0);
        let empty: AppAudioOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, AppAudioOptions::default());
    }

    #[test]
    fn groups_by_exe_and_drops_self_and_system_sounds() {
        let apps = group_sessions(
            vec![
                session(10, "C:\\X\\chrome.exe", false),
                session(11, "C:\\X\\Chrome.exe", true),
                session(20, "C:\\Spotify\\Spotify.exe", false),
                session(30, "C:\\Spook\\Spook.exe", true),
                session(31, "C:\\Edge\\msedgewebview2.exe", true),
                session(0, "", true),
            ],
            &|pid| pid == 30 || pid == 31,
        );
        let ids: Vec<&str> = apps.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["chrome.exe", "spotify.exe"]);
        assert!(apps[0].playing);
        assert_eq!(apps[0].name, "Chrome");
    }

    #[test]
    fn prune_keeps_only_tree_roots() {
        // 1 -> 2 -> 3 ; 7 isolado
        let parent: HashMap<u32, u32> = [(1, 0), (2, 1), (3, 2), (7, 0)].into();
        assert_eq!(prune_descendants(&[3, 2, 1, 7], &parent), vec![1, 7]);
        assert_eq!(prune_descendants(&[3, 2], &parent), vec![2]);
    }

    #[test]
    fn tree_walk_survives_cycles() {
        let parent: HashMap<u32, u32> = [(1, 2), (2, 1)].into();
        assert!(!is_in_tree(1, 99, &parent));
        let own: HashMap<u32, u32> = [(5, 4), (4, 3)].into();
        assert!(is_in_tree(5, 3, &own));
    }

    fn proc(pid: u32, ppid: u32, exe: &str) -> ProcessInfo {
        ProcessInfo {
            pid,
            ppid,
            exe: exe.into(),
        }
    }

    #[test]
    fn targets_are_the_roots_of_the_selected_apps_and_never_spook() {
        let procs = vec![
            proc(100, 1, "spotify.exe"),
            proc(101, 100, "spotify.exe"),
            proc(200, 1, "chrome.exe"),
            proc(300, 1, "spook.exe"),
            proc(301, 300, "spook.exe"),
            proc(400, 300, "msedgewebview2.exe"),
        ];
        let sel: HashSet<String> = ["spotify.exe", "spook.exe", "msedgewebview2.exe"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let got = desired_targets(&sel, &procs, 300);
        assert_eq!(got, vec![(100, "spotify.exe".to_string())]);
    }

    #[test]
    fn reconcile_starts_new_and_stops_gone() {
        let cur: HashSet<u32> = [1, 2].into();
        let want: HashSet<u32> = [2, 3].into();
        assert_eq!(reconcile(&cur, &want), (vec![3], vec![1]));
    }

    #[test]
    fn decide_covers_every_branch() {
        use OffReason::*;
        let apps = |list: &[(&str, f32)], master: f32| AppAudioOptions {
            mode: AppAudioMode::Apps,
            master,
            apps: list
                .iter()
                .map(|(e, v)| AppSelection {
                    exe: e.to_string(),
                    volume: *v,
                })
                .collect(),
        };
        assert_eq!(
            decide(false, None, OsSupport::Supported),
            CapturePlan::Off(NotRequested)
        );
        // Formato antigo (`audio: true`, sem `audioApps`): todo o sistema.
        assert_eq!(
            decide(true, None, OsSupport::Supported),
            CapturePlan::System { master: 1.0 }
        );
        assert_eq!(
            decide(true, None, OsSupport::OtherPlatform),
            CapturePlan::Off(UnsupportedPlatform)
        );
        assert_eq!(
            decide(true, None, OsSupport::OldWindows),
            CapturePlan::Off(UnsupportedWindowsVersion)
        );
        assert_eq!(
            decide(true, Some(&apps(&[], 100.0)), OsSupport::Supported),
            CapturePlan::Off(NoAppSelected)
        );
        match decide(
            true,
            Some(&apps(&[("Spotify.exe", 50.0), ("", 10.0)], 100.0)),
            OsSupport::Supported,
        ) {
            CapturePlan::Apps { gains, master } => {
                assert_eq!(master, 1.0);
                assert_eq!(gains.len(), 1);
                assert!((gains["spotify.exe"] - 0.25).abs() < 1e-6);
            }
            other => panic!("esperava Apps, veio {other:?}"),
        }
    }

    #[test]
    fn queue_primes_then_delivers_whole_blocks() {
        let mut q = FrameQueue::new();
        q.push(&vec![0.5; BLOCK_SAMPLES]);
        assert!(q.pop_block().is_none(), "ainda não há 20 ms");
        q.push(&vec![0.5; BLOCK_SAMPLES]);
        assert_eq!(q.pop_block().unwrap().len(), BLOCK_SAMPLES);
        assert_eq!(q.pop_block().unwrap().len(), BLOCK_SAMPLES);
        assert!(q.pop_block().is_none());
        // Esvaziou: volta a esperar 20 ms.
        q.push(&vec![0.1; BLOCK_SAMPLES]);
        assert!(q.pop_block().is_none());
    }

    #[test]
    fn queue_is_bounded_and_keeps_channel_alignment() {
        let mut q = FrameQueue::new();
        q.push(&vec![0.0; QUEUE_MAX_SAMPLES + 4]);
        assert!(q.len() <= QUEUE_MAX_SAMPLES);
        assert_eq!(q.len() % CHANNELS, 0);
    }

    #[test]
    fn mix_applies_individual_and_master_gains() {
        let a = vec![0.4f32; 8];
        let b = vec![0.2f32; 8];
        let mut out = vec![0i16; 8];
        let mut lim = Limiter::new();
        mix_block(&[(&a, 1.0), (&b, 0.5)], 0.5, &mut lim, &mut out);
        // (0.4*1 + 0.2*0.5) * 0.5 = 0.25
        let expected = (0.25f32 * 32767.0).round() as i16;
        assert!(out.iter().all(|&s| (s - expected).abs() <= 1));
    }

    #[test]
    fn mix_with_zero_master_is_silent() {
        let a = vec![0.9f32; 4];
        let mut out = vec![7i16; 4];
        mix_block(&[(&a, 1.0)], 0.0, &mut Limiter::new(), &mut out);
        assert!(out.iter().all(|&s| s == 0));
    }

    #[test]
    fn limiter_never_exceeds_the_ceiling_and_recovers() {
        let mut lim = Limiter::new();
        let mut loud: Vec<f32> = (0..960)
            .map(|i| if i % 2 == 0 { 3.0 } else { -3.0 })
            .collect();
        lim.process(&mut loud);
        assert!(loud.iter().all(|s| s.abs() <= Limiter::CEILING + 1e-6));
        assert!(lim.gain() < 0.5);
        // Sinal baixo e longo: o ganho volta perto de 1.
        for _ in 0..200 {
            let mut quiet = vec![0.01f32; 960];
            lim.process(&mut quiet);
        }
        assert!(lim.gain() > 0.99);
    }

    #[test]
    fn limiter_leaves_quiet_signals_untouched_and_scrubs_nan() {
        let mut lim = Limiter::new();
        let mut s = vec![0.1, -0.2, f32::NAN, f32::INFINITY];
        lim.process(&mut s);
        assert_eq!(&s[..2], &[0.1, -0.2]);
        assert_eq!(&s[2..], &[0.0, 0.0]);
    }

    #[test]
    fn response_serializes_with_the_documented_keys() {
        let r = AudioAppsResponse {
            supported: true,
            reason: None,
            apps: vec![AudioApp {
                id: "a.exe".into(),
                name: "A".into(),
                exe: "a.exe".into(),
                icon: None,
                playing: true,
            }],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["supported"], true);
        assert!(v.get("reason").is_none());
        assert_eq!(v["apps"][0]["id"], "a.exe");
        assert!(v["apps"][0].get("icon").is_none());
        let u = serde_json::to_value(AudioAppsResponse::unsupported("platform")).unwrap();
        assert_eq!(u["reason"], "platform");
    }
}
