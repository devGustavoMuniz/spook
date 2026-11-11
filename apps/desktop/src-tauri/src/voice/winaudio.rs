//! Áudio por aplicativo no Windows: lista de sessões de áudio (`IAudioSessionManager2`) e captura por processo
//! ("process loopback" do WASAPI: `AUDIOCLIENT_ACTIVATION_PARAMS`, modo incluir ou excluir a árvore de um PID).
//! Só compila e roda no Windows; a lógica de decisão, mixagem e limitador está em `appaudio.rs` (testada).
//!
//! Arquitetura da captura:
//! - UMA thread por PID capturado (`capture_loop`): ativa o cliente de loopback, lê pacotes de 48 kHz estéreo f32
//!   (o dispositivo virtual não tem formato de mistura, então o formato é pedido com conversão automática) e
//!   enfileira numa `FrameQueue`.
//! - UMA thread misturadora (a cada 10 ms): puxa um bloco de cada fila, aplica ganho do app × master, limita e
//!   entrega PCM i16 estéreo ao canal que alimenta o `NativeAudioSource`.
//! - No modo "aplicativos", uma thread supervisora (a cada 2 s) consulta a tabela de processos e liga/desliga
//!   capturas conforme os aplicativos escolhidos abrem e fecham.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, PROPVARIANT, PWSTR};
use windows::Wdk::System::SystemServices::RtlGetVersion;
use windows::Win32::Foundation::{CloseHandle, E_POINTER, S_OK};
use windows::Win32::Media::Audio::{
    eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IAudioSessionControl2, IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, DEVICE_STATE_ACTIVE,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IAgileObject, IAgileObject_Impl, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::appaudio::{
    self, desired_targets, group_sessions, is_in_tree, mix_block, normalize_exe, parent_map,
    reconcile, AudioApp, CapturePlan, FrameQueue, Limiter, OsSupport, ProcessInfo, RawSession,
    BLOCK_SAMPLES, CHANNELS, SAMPLE_RATE,
};

/// Intervalo da leitura dos pacotes (o WASAPI entrega blocos de ~10 ms).
const POLL: Duration = Duration::from_millis(5);
/// Intervalo da varredura de processos (aplicativos que abrem/fecham durante a transmissão).
const RESCAN: Duration = Duration::from_secs(2);
/// Quantas falhas seguidas de ativação para um PID antes de desistir dele.
const MAX_FAILURES: u32 = 3;
/// Espera máxima pela ativação assíncrona do cliente de loopback.
const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(5);

/// Guarda de COM por thread: inicializa como MTA e desfaz no fim (só se este uso inicializou).
struct ComGuard(bool);

impl ComGuard {
    fn init() -> Self {
        // `S_FALSE` (já inicializado) também é sucesso e também exige o `CoUninitialize` correspondente;
        // `RPC_E_CHANGED_MODE` é erro e não deve ser desfeito.
        Self(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// `VT_BLOB` (tipo de variante "bloco de bytes").
const VT_BLOB: u16 = 65;
/// Formato de onda IEEE float (`WAVE_FORMAT_IEEE_FLOAT`).
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

/// `PROPVARIANT` com um BLOB, montado à mão (o `windows` 0.58 não expõe os campos). O layout é o do Windows
/// (`vt`, três reservados, `BLOB { cbSize, pBlobData }`); a asserção abaixo trava o tamanho igual ao do tipo real.
#[repr(C)]
struct BlobVariant {
    vt: u16,
    reserved: [u16; 3],
    cb_size: u32,
    blob: *mut u8,
}
const _: () = assert!(std::mem::size_of::<BlobVariant>() == std::mem::size_of::<PROPVARIANT>());

/// Interface COM movida entre threads (todas as threads daqui são MTA, então é seguro).
struct SendIface<T>(T);
unsafe impl<T> Send for SendIface<T> {}

/// Número da build do Windows (via `RtlGetVersion`, que não mente como `GetVersionEx`). 0 se falhar.
pub fn windows_build() -> u32 {
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    let status = unsafe { RtlGetVersion(&mut info) };
    if status.is_ok() {
        info.dwBuildNumber
    } else {
        0
    }
}

pub fn os_support() -> OsSupport {
    if windows_build() >= appaudio::MIN_WINDOWS_BUILD {
        OsSupport::Supported
    } else {
        OsSupport::OldWindows
    }
}

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// Tabela de processos (PID, pai, nome do executável).
pub fn process_table() -> Vec<ProcessInfo> {
    let mut out = Vec::new();
    let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return out;
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snap, &mut entry) }.is_ok() {
        loop {
            out.push(ProcessInfo {
                pid: entry.th32ProcessID,
                ppid: entry.th32ParentProcessID,
                exe: normalize_exe(&wide_to_string(&entry.szExeFile)),
            });
            if unsafe { Process32NextW(snap, &mut entry) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snap) };
    out
}

/// Caminho completo do executável de um PID (`None` se o acesso for negado, p.ex. processo protegido).
fn image_path(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    }
    .is_ok();
    let _ = unsafe { CloseHandle(handle) };
    ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
}

fn sessions_of(device: &IMMDevice, out: &mut Vec<RawSession>) -> windows::core::Result<()> {
    let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None)? };
    let list = unsafe { manager.GetSessionEnumerator()? };
    let count = unsafe { list.GetCount()? };
    for i in 0..count {
        let Ok(control) = (unsafe { list.GetSession(i) }) else {
            continue;
        };
        let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
            continue;
        };
        // Sons do sistema do Windows não são um aplicativo. `IsSystemSoundsSession` responde `S_OK` (é) ou `S_FALSE`
        // (não é); o wrapper do `windows` trata os dois como sucesso, então lemos o HRESULT cru da vtable.
        let hr = unsafe {
            (Interface::vtable(&control2).IsSystemSoundsSession)(Interface::as_raw(&control2))
        };
        if hr == S_OK {
            continue;
        }
        let Ok(pid) = (unsafe { control2.GetProcessId() }) else {
            continue;
        };
        if pid == 0 {
            continue;
        }
        let Some(exe_path) = image_path(pid) else {
            continue;
        };
        let playing = unsafe { control.GetState() }
            .map(|s| s == AudioSessionStateActive)
            .unwrap_or(false);
        out.push(RawSession {
            pid,
            exe_path,
            display_name: None,
            icon: None,
            playing,
        });
    }
    Ok(())
}

/// Aplicativos com sessão de áudio em qualquer saída ativa, sem o Spook e os filhos dele (WebView2).
pub fn list_apps(own_pid: u32) -> Result<Vec<AudioApp>, String> {
    let _com = ComGuard::init();
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| format!("enumerador de áudio: {e}"))?;
    let devices = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }
        .map_err(|e| format!("saídas de áudio: {e}"))?;
    let count = unsafe { devices.GetCount() }.map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    for i in 0..count {
        if let Ok(device) = unsafe { devices.Item(i) } {
            if let Err(e) = sessions_of(&device, &mut raw) {
                log::debug!("áudio por aplicativo: sessões de uma saída falharam: {e}");
            }
        }
    }
    let parent = parent_map(&process_table());
    Ok(group_sessions(raw, &|pid| {
        is_in_tree(pid, own_pid, &parent)
    }))
}

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct ActivationHandler {
    tx: Mutex<Option<mpsc::Sender<Result<SendIface<IAudioClient>, String>>>>,
}

// Marca o objeto como "ágil" (pode ser chamado de qualquer apartamento), exigência da ativação assíncrona.
impl IAgileObject_Impl for ActivationHandler_Impl {}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        operation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let result: Result<SendIface<IAudioClient>, String> = (|| {
            let op = operation.ok_or_else(|| windows::core::Error::from(E_POINTER))?;
            let mut hr = windows::core::HRESULT(0);
            let mut unknown: Option<windows::core::IUnknown> = None;
            unsafe { op.GetActivateResult(&mut hr, &mut unknown)? };
            hr.ok()?;
            let client = unknown
                .ok_or_else(|| windows::core::Error::from(E_POINTER))?
                .cast::<IAudioClient>()?;
            Ok(SendIface(client))
        })()
        .map_err(|e: windows::core::Error| e.to_string());
        if let Some(tx) = self.tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(result);
        }
        Ok(())
    }
}

/// Ativa o dispositivo virtual de "process loopback" para `pid`. `include`: captura só a árvore do processo;
/// `false`: captura TUDO MENOS a árvore dele (usado para "todo o sistema menos o Spook").
fn activate_loopback(pid: u32, include: bool) -> Result<IAudioClient, String> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: if include {
                    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                } else {
                    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                },
            },
        },
    };
    let variant = BlobVariant {
        vt: VT_BLOB,
        reserved: [0; 3],
        cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        blob: &mut params as *mut _ as *mut u8,
    };
    let (tx, rx) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = ActivationHandler {
        tx: Mutex::new(Some(tx)),
    }
    .into();
    // `variant` e `params` ficam vivos até o fim desta função (a ativação lê o blob durante a chamada).
    let _operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&variant as *const BlobVariant as *const PROPVARIANT),
            &handler,
        )
    }
    .map_err(|e| format!("ActivateAudioInterfaceAsync: {e}"))?;
    match rx.recv_timeout(ACTIVATE_TIMEOUT) {
        Ok(Ok(client)) => Ok(client.0),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("tempo esgotado ao ativar a captura por processo".into()),
    }
}

/// Fila compartilhada entre a thread de captura (escreve) e a misturadora (lê).
type SharedQueue = Arc<Mutex<FrameQueue>>;

struct Source {
    pid: u32,
    /// Ganho linear do aplicativo (1,0 no modo sistema).
    gain: f32,
    queue: SharedQueue,
}

type Sources = Arc<Mutex<Vec<Source>>>;

/// Corpo da thread de captura de um PID. Devolve quando `stop` é acionado ou o dispositivo falha.
fn capture_loop(
    pid: u32,
    include: bool,
    gain: f32,
    sources: Sources,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let _com = ComGuard::init();
    let client = activate_loopback(pid, include)?;
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: CHANNELS as u16,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * CHANNELS as u32 * 4,
        nBlockAlign: (CHANNELS * 4) as u16,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                2_000_000, // 200 ms em unidades de 100 ns
                0,
                &format,
                None,
            )
            .map_err(|e| format!("Initialize: {e}"))?;
    }
    let capture: IAudioCaptureClient =
        unsafe { client.GetService() }.map_err(|e| format!("GetService: {e}"))?;
    let queue: SharedQueue = Arc::new(Mutex::new(FrameQueue::new()));
    unsafe { client.Start() }.map_err(|e| format!("Start: {e}"))?;
    lock(&sources).push(Source {
        pid,
        gain,
        queue: queue.clone(),
    });
    let result = read_packets(&capture, &queue, &stop);
    let _ = unsafe { client.Stop() };
    lock(&sources).retain(|s| s.pid != pid);
    result
}

fn read_packets(
    capture: &IAudioCaptureClient,
    queue: &SharedQueue,
    stop: &AtomicBool,
) -> Result<(), String> {
    let mut scratch: Vec<f32> = Vec::new();
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(POLL);
        loop {
            let packet = unsafe { capture.GetNextPacketSize() }
                .map_err(|e| format!("GetNextPacketSize: {e}"))?;
            if packet == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
                .map_err(|e| format!("GetBuffer: {e}"))?;
            let samples = frames as usize * CHANNELS;
            scratch.clear();
            if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                scratch.resize(samples, 0.0);
            } else {
                // O formato pedido é f32 estéreo; o ponteiro do WASAPI pode não estar alinhado a 4 bytes.
                let bytes = unsafe { std::slice::from_raw_parts(data, samples * 4) };
                scratch.extend(
                    bytes
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                );
            }
            unsafe { capture.ReleaseBuffer(frames) }.map_err(|e| format!("ReleaseBuffer: {e}"))?;
            lock(queue).push(&scratch);
        }
    }
    Ok(())
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct CaptureHandle {
    stop: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl CaptureHandle {
    fn spawn(pid: u32, include: bool, gain: f32, sources: Sources) -> Option<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let (s, f) = (stop.clone(), finished.clone());
        let join = std::thread::Builder::new()
            .name(format!("spook-app-audio-{pid}"))
            .spawn(move || {
                if let Err(e) = capture_loop(pid, include, gain, sources, s) {
                    log::warn!("áudio por aplicativo: a captura do PID {pid} parou: {e}");
                    // Sinaliza a falha à supervisora (ela conta as tentativas).
                    f.store(true, Ordering::SeqCst);
                } else {
                    f.store(true, Ordering::SeqCst);
                }
            })
            .ok()?;
        Some(Self {
            stop,
            finished,
            join: Some(join),
        })
    }

    fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.request_stop();
        // Não espera: a thread termina sozinha em até ~5 ms (ou ao fim da ativação em andamento).
        self.join.take();
    }
}

/// Captura em andamento: soltar = parar tudo (as threads encerram sozinhas).
pub struct ScreenAudioCapture {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Drop for ScreenAudioCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // A misturadora e a supervisora dormem no máximo 10 ms/2 s; não bloqueamos o comando esperando.
        self.threads.clear();
    }
}

/// Inicia a captura segundo o plano. `tx` recebe blocos de 10 ms (960 amostras i16 estéreo intercaladas).
pub fn start(
    plan: CapturePlan,
    own_pid: u32,
    tx: tokio::sync::mpsc::Sender<Vec<i16>>,
) -> Result<ScreenAudioCapture, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let sources: Sources = Arc::new(Mutex::new(Vec::new()));
    let mut threads = Vec::new();
    let master;
    match plan {
        CapturePlan::Off(_) => return Err("plano sem áudio".into()),
        CapturePlan::System { master: m } => {
            master = m;
            // Todo o sistema MENOS a árvore do Spook (a chamada não volta pelo áudio da tela).
            let handle = CaptureHandle::spawn(own_pid, false, 1.0, sources.clone())
                .ok_or("não foi possível criar a thread de captura")?;
            let stop2 = stop.clone();
            threads.push(
                std::thread::Builder::new()
                    .name("spook-app-audio-hold".into())
                    .spawn(move || {
                        // Segura a captura viva até a parada (soltar o handle a encerra).
                        while !stop2.load(Ordering::SeqCst)
                            && !handle.finished.load(Ordering::SeqCst)
                        {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    })
                    .map_err(|e| e.to_string())?,
            );
        }
        CapturePlan::Apps { gains, master: m } => {
            master = m;
            let (sources2, stop2) = (sources.clone(), stop.clone());
            threads.push(
                std::thread::Builder::new()
                    .name("spook-app-audio-scan".into())
                    .spawn(move || supervise(gains, own_pid, sources2, stop2))
                    .map_err(|e| e.to_string())?,
            );
        }
    }
    let (sources3, stop3) = (sources, stop.clone());
    threads.push(
        std::thread::Builder::new()
            .name("spook-app-audio-mix".into())
            .spawn(move || mix_loop(master, sources3, stop3, tx))
            .map_err(|e| e.to_string())?,
    );
    Ok(ScreenAudioCapture { stop, threads })
}

/// Liga/desliga as capturas conforme os executáveis escolhidos abrem e fecham.
fn supervise(gains: HashMap<String, f32>, own_pid: u32, sources: Sources, stop: Arc<AtomicBool>) {
    let selected: HashSet<String> = gains.keys().cloned().collect();
    let mut running: HashMap<u32, CaptureHandle> = HashMap::new();
    let mut failures: HashMap<u32, u32> = HashMap::new();
    while !stop.load(Ordering::SeqCst) {
        // Capturas que terminaram sozinhas (processo fechou, erro): contam falha e saem do mapa.
        let dead: Vec<u32> = running
            .iter()
            .filter(|(_, h)| h.finished.load(Ordering::SeqCst))
            .map(|(pid, _)| *pid)
            .collect();
        for pid in dead {
            running.remove(&pid);
            *failures.entry(pid).or_insert(0) += 1;
        }
        let procs = process_table();
        let targets = desired_targets(&selected, &procs, own_pid);
        let exe_of: HashMap<u32, String> = targets.iter().cloned().collect();
        let desired: HashSet<u32> = targets
            .iter()
            .map(|(p, _)| *p)
            .filter(|p| failures.get(p).copied().unwrap_or(0) < MAX_FAILURES)
            .collect();
        let current: HashSet<u32> = running.keys().copied().collect();
        let (start, stop_pids) = reconcile(&current, &desired);
        for pid in stop_pids {
            running.remove(&pid);
            // Processo que sumiu: zera a contagem (um PID reaproveitado começa limpo).
            if !exe_of.contains_key(&pid) {
                failures.remove(&pid);
            }
        }
        for pid in start {
            let gain = exe_of
                .get(&pid)
                .and_then(|e| gains.get(e))
                .copied()
                .unwrap_or(1.0);
            if let Some(h) = CaptureHandle::spawn(pid, true, gain, sources.clone()) {
                running.insert(pid, h);
            }
        }
        let deadline = Instant::now() + RESCAN;
        while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    // `running` é solto aqui: cada captura recebe o pedido de parada.
}

/// A cada 10 ms mistura um bloco de cada captura e entrega ao canal.
fn mix_loop(
    master: f32,
    sources: Sources,
    stop: Arc<AtomicBool>,
    tx: tokio::sync::mpsc::Sender<Vec<i16>>,
) {
    let mut limiter = Limiter::new();
    let tick = Duration::from_millis(10);
    let mut next = Instant::now() + tick;
    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        }
        next += tick;
        // Se a thread ficou muito atrasada, não tenta recuperar de uma vez (evita rajada de blocos).
        if Instant::now() > next + Duration::from_millis(100) {
            next = Instant::now() + tick;
        }
        let blocks: Vec<(Vec<f32>, f32)> = lock(&sources)
            .iter()
            .filter_map(|s| lock(&s.queue).pop_block().map(|b| (b, s.gain)))
            .collect();
        let inputs: Vec<(&[f32], f32)> = blocks.iter().map(|(b, g)| (b.as_slice(), *g)).collect();
        let mut out = vec![0i16; BLOCK_SAMPLES];
        mix_block(&inputs, master, &mut limiter, &mut out);
        // Canal cheio (consumidor atrasado): descarta este bloco em vez de acumular latência.
        let _ = tx.try_send(out);
    }
}
