//! Erros tipados da voz nativa. Chegam ao webview como JSON (`{kind, code, device?, message}`) e a engine
//! web os converte em `VoiceConnectError`/`VoiceMediaError`. As mensagens são em pt-br e já trazem a
//! instrução do sistema operacional certo (a UI mostra `message` quando existe).

use serde::Serialize;

/// Qual dispositivo local falhou.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaDevice {
    Microphone,
    Camera,
    Screen,
    Speaker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaCode {
    PermissionDenied,
    Cancelled,
    NotFound,
    InUse,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectCode {
    TokenRejected,
    Unreachable,
    Unknown,
}

/// Sistema operacional para as instruções de permissão (parâmetro para testar todos).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Macos,
    Windows,
    Linux,
}

impl Os {
    pub const fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Macos
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum VoiceError {
    #[error("{message}")]
    Connect { code: ConnectCode, message: String },
    #[error("{message}")]
    Media {
        code: MediaCode,
        device: MediaDevice,
        message: String,
    },
    #[error("{message}")]
    Other { message: String },
}

impl VoiceError {
    pub fn media(code: MediaCode, device: MediaDevice) -> Self {
        Self::media_on(Os::current(), code, device)
    }

    pub fn media_on(os: Os, code: MediaCode, device: MediaDevice) -> Self {
        VoiceError::Media {
            code,
            device,
            message: media_message(os, code, device),
        }
    }

    pub fn connect(code: ConnectCode, message: impl Into<String>) -> Self {
        VoiceError::Connect {
            code,
            message: message.into(),
        }
    }

    pub fn other(message: impl Into<String>) -> Self {
        VoiceError::Other {
            message: message.into(),
        }
    }

    pub fn no_room() -> Self {
        Self::other("Você não está em nenhuma chamada de voz.")
    }
}

fn what(device: MediaDevice) -> &'static str {
    match device {
        MediaDevice::Microphone => "o microfone",
        MediaDevice::Camera => "a câmera",
        MediaDevice::Screen => "a captura de tela",
        MediaDevice::Speaker => "o alto-falante",
    }
}

/// Texto de "como liberar" por sistema e dispositivo.
pub fn permission_hint(os: Os, device: MediaDevice) -> &'static str {
    match (os, device) {
        (Os::Macos, MediaDevice::Microphone) => {
            "Abra Ajustes do Sistema > Privacidade e Segurança > Microfone, ative o Spook e tente de novo."
        }
        (Os::Macos, MediaDevice::Camera) => {
            "Abra Ajustes do Sistema > Privacidade e Segurança > Câmera, ative o Spook e tente de novo."
        }
        (Os::Macos, MediaDevice::Screen) => {
            "Abra Ajustes do Sistema > Privacidade e Segurança > Gravação de Tela e Áudio do Sistema, ative o Spook, feche e abra o app de novo e tente compartilhar."
        }
        (Os::Windows, MediaDevice::Microphone) => {
            "Abra Configurações > Privacidade e segurança > Microfone e permita que aplicativos da área de trabalho usem o microfone."
        }
        (Os::Windows, MediaDevice::Camera) => {
            "Abra Configurações > Privacidade e segurança > Câmera e permita que aplicativos da área de trabalho usem a câmera."
        }
        (Os::Windows, MediaDevice::Screen) => {
            "O Windows não permitiu capturar a tela. Verifique se outro programa não está bloqueando a captura."
        }
        (Os::Linux, MediaDevice::Microphone | MediaDevice::Speaker) => {
            "Verifique se o seu usuário tem acesso ao áudio (PipeWire/PulseAudio/ALSA) e se o microfone não está silenciado no sistema."
        }
        (Os::Linux, MediaDevice::Camera) => {
            "Verifique se o seu usuário pode acessar /dev/video* (grupo \"video\") e tente de novo."
        }
        (Os::Linux, MediaDevice::Screen) => {
            "Aceite o pedido de compartilhamento de tela do sistema (portal do desktop). No Wayland é preciso ter o xdg-desktop-portal e o PipeWire ativos."
        }
        (_, MediaDevice::Speaker) => "Verifique a saída de áudio do sistema.",
    }
}

pub fn media_message(os: Os, code: MediaCode, device: MediaDevice) -> String {
    match code {
        MediaCode::PermissionDenied => format!(
            "O sistema bloqueou {}. {}",
            what(device),
            permission_hint(os, device)
        ),
        MediaCode::Cancelled => "Compartilhamento de tela cancelado.".to_string(),
        MediaCode::NotFound => match device {
            MediaDevice::Speaker => "Nenhum alto-falante encontrado.".to_string(),
            MediaDevice::Screen => {
                "Nenhuma tela ou janela disponível para compartilhar.".to_string()
            }
            _ => format!(
                "Nenhum dispositivo encontrado para usar {}. Conecte um e tente de novo.",
                what(device)
            ),
        },
        MediaCode::InUse => format!(
            "Não foi possível abrir {}: outro programa pode estar usando.",
            what(device)
        ),
        MediaCode::Unsupported => match device {
            MediaDevice::Camera => {
                "Esta versão do Spook não inclui suporte à câmera nativa.".to_string()
            }
            MediaDevice::Screen => {
                "Este sistema não permite compartilhar a tela pelo Spook.".to_string()
            }
            _ => "Este sistema não permite essa função.".to_string(),
        },
        MediaCode::Unknown => format!("Não foi possível usar {}.", what(device)),
    }
}

/// Classifica a mensagem de erro de um backend (WASAPI, CoreAudio, ALSA, V4L2…) em um código.
/// Os backends só devolvem texto; por isso a heurística fica isolada e testada.
pub fn classify_backend_message(msg: &str) -> MediaCode {
    let m = msg.to_lowercase();
    const DENIED: [&str; 7] = [
        "permission",
        "denied",
        "not permitted",
        "not authorized",
        "unauthorized",
        "0x80070005",
        "access is denied",
    ];
    const IN_USE: [&str; 5] = [
        "in use",
        "busy",
        "exclusive",
        "0x8889000a",
        "resource temporarily unavailable",
    ];
    const MISSING: [&str; 5] = [
        "no such device",
        "not found",
        "not available",
        "no device",
        "disconnected",
    ];
    if DENIED.iter().any(|k| m.contains(k)) {
        MediaCode::PermissionDenied
    } else if IN_USE.iter().any(|k| m.contains(k)) {
        MediaCode::InUse
    } else if MISSING.iter().any(|k| m.contains(k)) {
        MediaCode::NotFound
    } else {
        MediaCode::Unknown
    }
}

/// Erro do `Room::connect` do LiveKit → código da interface. 401/403 do endpoint de validação viram
/// token recusado; falhas de rede viram "inalcançável".
pub fn classify_connect_message(msg: &str) -> ConnectCode {
    let m = msg.to_lowercase();
    if m.contains("401")
        || m.contains("403")
        || m.contains("unauthorized")
        || m.contains("forbidden")
        || m.contains("invalid token")
        || m.contains("token")
            && (m.contains("expired") || m.contains("invalid") || m.contains("rejected"))
    {
        ConnectCode::TokenRejected
    } else if m.contains("timeout")
        || m.contains("timed out")
        || m.contains("connect")
        || m.contains("dns")
        || m.contains("network")
        || m.contains("refused")
        || m.contains("unreachable")
        || m.contains("websocket")
        || m.contains("io error")
    {
        ConnectCode::Unreachable
    } else {
        ConnectCode::Unknown
    }
}

pub fn connect_message(code: ConnectCode) -> &'static str {
    match code {
        ConnectCode::TokenRejected => "O servidor de voz recusou o acesso. Tente entrar de novo.",
        ConnectCode::Unreachable => {
            "Não foi possível alcançar o servidor de voz. Verifique a sua conexão."
        }
        ConnectCode::Unknown => "Não foi possível entrar na chamada de voz.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_message_names_the_os_settings() {
        let m = media_message(
            Os::Macos,
            MediaCode::PermissionDenied,
            MediaDevice::Microphone,
        );
        assert!(m.contains("Ajustes do Sistema > Privacidade e Segurança > Microfone"));
        let m = media_message(Os::Macos, MediaCode::PermissionDenied, MediaDevice::Screen);
        assert!(m.contains("Gravação de Tela"));
        let m = media_message(
            Os::Windows,
            MediaCode::PermissionDenied,
            MediaDevice::Camera,
        );
        assert!(m.contains("Configurações > Privacidade e segurança > Câmera"));
        let m = media_message(Os::Linux, MediaCode::PermissionDenied, MediaDevice::Screen);
        assert!(m.contains("portal"));
    }

    #[test]
    fn every_code_and_device_has_a_portuguese_message() {
        for os in [Os::Macos, Os::Windows, Os::Linux] {
            for device in [
                MediaDevice::Microphone,
                MediaDevice::Camera,
                MediaDevice::Screen,
                MediaDevice::Speaker,
            ] {
                for code in [
                    MediaCode::PermissionDenied,
                    MediaCode::Cancelled,
                    MediaCode::NotFound,
                    MediaCode::InUse,
                    MediaCode::Unsupported,
                    MediaCode::Unknown,
                ] {
                    assert!(!media_message(os, code, device).is_empty());
                }
            }
        }
    }

    #[test]
    fn backend_messages_are_classified() {
        assert_eq!(
            classify_backend_message("Acesso negado. (0x80070005) access is denied"),
            MediaCode::PermissionDenied
        );
        assert_eq!(
            classify_backend_message("The device is already in use"),
            MediaCode::InUse
        );
        assert_eq!(
            classify_backend_message("No such device"),
            MediaCode::NotFound
        );
        assert_eq!(classify_backend_message("???"), MediaCode::Unknown);
    }

    #[test]
    fn connect_errors_are_classified() {
        assert_eq!(
            classify_connect_message("HTTP error: 401 Unauthorized"),
            ConnectCode::TokenRejected
        );
        assert_eq!(
            classify_connect_message("signal client: connection timed out"),
            ConnectCode::Unreachable
        );
        assert_eq!(classify_connect_message("???"), ConnectCode::Unknown);
    }

    #[test]
    fn serializes_with_kind_and_kebab_codes() {
        let e = VoiceError::media_on(Os::Linux, MediaCode::InUse, MediaDevice::Microphone);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "media");
        assert_eq!(v["code"], "in-use");
        assert_eq!(v["device"], "microphone");
        assert!(v["message"].as_str().unwrap().contains("microfone"));
        let c = VoiceError::connect(ConnectCode::TokenRejected, "x");
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["kind"], "connect");
        assert_eq!(v["code"], "token-rejected");
    }
}
