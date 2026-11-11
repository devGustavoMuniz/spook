//! Cola entre o núcleo de voz e a captura de áudio por aplicativo: no Windows usa `winaudio` (WASAPI), nas outras
//! plataformas responde "sem suporte" (o `scap` 0.0.8 não captura áudio; ver SPEC 5.5, "áudio por aplicativo").

use tokio::sync::mpsc::Sender;

use super::appaudio::{AudioAppsResponse, CapturePlan, OsSupport};

/// Captura em andamento (soltar = parar).
pub type AudioCapture = Box<dyn std::any::Any + Send>;

/// O SO consegue captar áudio por processo?
pub fn os_support() -> OsSupport {
    #[cfg(windows)]
    {
        super::winaudio::os_support()
    }
    #[cfg(not(windows))]
    {
        OsSupport::OtherPlatform
    }
}

/// Lista bloqueante (COM): chamar de `spawn_blocking`. Nunca devolve o Spook nem os filhos dele.
pub fn list_apps() -> AudioAppsResponse {
    match os_support() {
        OsSupport::OtherPlatform => AudioAppsResponse::unsupported("platform"),
        OsSupport::OldWindows => AudioAppsResponse::unsupported("windows-version"),
        OsSupport::Supported => list_supported(),
    }
}

#[cfg(windows)]
fn list_supported() -> AudioAppsResponse {
    match super::winaudio::list_apps(std::process::id()) {
        Ok(apps) => AudioAppsResponse {
            supported: true,
            reason: None,
            apps,
        },
        Err(e) => {
            log::warn!("áudio por aplicativo: não foi possível listar as sessões: {e}");
            AudioAppsResponse::unsupported("error")
        }
    }
}

#[cfg(not(windows))]
fn list_supported() -> AudioAppsResponse {
    AudioAppsResponse::unsupported("platform")
}

/// Inicia a captura do plano; cada bloco de 10 ms (960 amostras i16, estéreo intercalado, 48 kHz) vai a `tx`.
#[cfg(windows)]
pub fn start(plan: CapturePlan, tx: Sender<Vec<i16>>) -> Result<AudioCapture, String> {
    let capture = super::winaudio::start(plan, std::process::id(), tx)?;
    Ok(Box::new(capture))
}

#[cfg(not(windows))]
pub fn start(_plan: CapturePlan, _tx: Sender<Vec<i16>>) -> Result<AudioCapture, String> {
    Err("áudio por aplicativo só existe no Windows".into())
}
