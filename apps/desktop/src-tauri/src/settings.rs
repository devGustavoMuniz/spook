//! Configurações do app desktop (lógica pura, sem Tauri): três interruptores guardados num JSON simples no
//! diretório de configuração do app. Nada sensível (o token fica no chaveiro, ver `token.rs`).
//!
//! * `closeToTray` (padrão LIGADO, como o Discord): fechar a janela esconde o app na bandeja;
//! * `keepCallOnClose` (padrão DESLIGADO): fechar a janela ESTANDO EM CHAMADA sai da chamada (e vai para a bandeja,
//!   se `closeToTray`); ligado, a chamada continua com a janela escondida;
//! * `startWithSystem` (padrão desligado): abre o Spook ao iniciar a sessão do sistema (plugin autostart);
//! * `startMinimized` (padrão desligado): na inicialização automática, abre só na bandeja.
//!
//! O mesmo arquivo guarda se o aviso único "O Spook continua rodando na bandeja" já foi mostrado.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "app-settings.json";
/// Argumento que o plugin de autostart passa ao app aberto pelo sistema.
pub const AUTOSTART_ARG: &str = "--autostart";
/// Argumento manual para abrir direto na bandeja (útil para testar).
pub const MINIMIZED_ARG: &str = "--minimized";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub close_to_tray: bool,
    /// Fechar a janela com uma chamada em andamento mantém a chamada (na bandeja). Desligado = sai da chamada.
    pub keep_call_on_close: bool,
    pub start_with_system: bool,
    pub start_minimized: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            keep_call_on_close: false,
            start_with_system: false,
            start_minimized: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    #[serde(flatten)]
    settings: AppSettings,
    tray_notice_shown: bool,
}

/// O que fazer quando o usuário pede para fechar a janela principal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Deixa fechar de verdade (o app encerra e desconecta a voz).
    Quit,
    /// Esconde na bandeja; a chamada (se houver) continua.
    Hide,
    /// Esconde na bandeja E sai da chamada em andamento.
    HideAndLeaveCall,
}

/// Decide o fechar da janela: `quitting` = o app já está saindo; `in_call` = há sala de voz conectada.
pub fn close_action(settings: &AppSettings, quitting: bool, in_call: bool) -> CloseAction {
    if quitting || !settings.close_to_tray {
        CloseAction::Quit
    } else if in_call && !settings.keep_call_on_close {
        CloseAction::HideAndLeaveCall
    } else {
        CloseAction::Hide
    }
}

/// A janela deve nascer escondida? Só nas aberturas pelo sistema (`--autostart`) ou manuais (`--minimized`),
/// e só com "iniciar minimizado" ligado; abrir o app pelo ícone mostra a janela sempre.
pub fn should_start_hidden(settings: &AppSettings, args: &[String]) -> bool {
    settings.start_minimized
        && args
            .iter()
            .any(|a| a == AUTOSTART_ARG || a == MINIMIZED_ARG)
}

pub struct SettingsStore {
    path: PathBuf,
    state: Mutex<Stored>,
}

fn read(path: &Path) -> Stored {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write(path: &Path, stored: &Stored) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("não foi possível criar a pasta: {e}"))?;
    }
    let json = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    // Grava num arquivo temporário e renomeia: uma queda no meio não deixa o JSON pela metade.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("não foi possível salvar: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("não foi possível salvar: {e}"))
}

impl SettingsStore {
    /// Abre (ou cria em memória) as configurações em `dir/app-settings.json`. Arquivo ausente ou corrompido =
    /// padrões.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(FILE_NAME);
        let state = Mutex::new(read(&path));
        Self { path, state }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Stored> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self) -> AppSettings {
        self.lock().settings
    }

    /// Grava as configurações. Se a gravação falhar, o valor anterior continua valendo.
    pub fn set(&self, settings: AppSettings) -> Result<AppSettings, String> {
        let mut g = self.lock();
        let next = Stored { settings, ..*g };
        write(&self.path, &next)?;
        *g = next;
        Ok(settings)
    }

    /// `true` só na primeira vez (e grava que o aviso da bandeja já foi mostrado).
    pub fn take_tray_notice(&self) -> bool {
        let mut g = self.lock();
        if g.tray_notice_shown {
            return false;
        }
        let next = Stored {
            tray_notice_shown: true,
            ..*g
        };
        // Mesmo que não consiga gravar, avisa agora; na pior hipótese avisa de novo no próximo uso.
        let _ = write(&self.path, &next);
        *g = next;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("spook-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_close_to_tray_on_everything_else_off() {
        let d = AppSettings::default();
        assert!(d.close_to_tray);
        assert!(
            !d.keep_call_on_close,
            "fechar a janela sai da chamada por padrão"
        );
        assert!(!d.start_with_system);
        assert!(!d.start_minimized);
    }

    #[test]
    fn json_is_camel_case_and_partial_files_get_defaults() {
        let s: AppSettings = serde_json::from_str(r#"{"startWithSystem":true}"#).unwrap();
        assert!(
            s.close_to_tray && s.start_with_system && !s.start_minimized && !s.keep_call_on_close
        );
        let v = serde_json::to_value(AppSettings::default()).unwrap();
        assert_eq!(v["closeToTray"], true);
        assert_eq!(v["startWithSystem"], false);
        assert_eq!(v["keepCallOnClose"], false);
        assert_eq!(v["startMinimized"], false);
        // campos desconhecidos são ignorados
        assert!(serde_json::from_str::<AppSettings>(r#"{"x":1}"#).is_ok());
    }

    #[test]
    fn missing_or_corrupt_file_means_defaults() {
        let dir = temp_dir("corrupt");
        assert_eq!(SettingsStore::open(&dir).get(), AppSettings::default());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE_NAME), "{ não é json").unwrap();
        assert_eq!(SettingsStore::open(&dir).get(), AppSettings::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_persist_across_openings() {
        let dir = temp_dir("persist");
        let store = SettingsStore::open(&dir);
        let want = AppSettings {
            close_to_tray: false,
            keep_call_on_close: true,
            start_with_system: true,
            start_minimized: true,
        };
        assert_eq!(store.set(want).unwrap(), want);
        assert_eq!(SettingsStore::open(&dir).get(), want);
        // o arquivo guarda só interruptores (nenhum segredo)
        let text = fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert!(text.contains("closeToTray") && !text.to_lowercase().contains("token"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_keeps_the_previous_value() {
        let dir = temp_dir("fail");
        fs::create_dir_all(&dir).unwrap();
        // o "diretório" é um arquivo: criar a pasta e gravar falham
        let blocker = dir.join("arquivo");
        fs::write(&blocker, "x").unwrap();
        let store = SettingsStore::open(&blocker);
        let before = store.get();
        let err = store.set(AppSettings {
            close_to_tray: false,
            ..before
        });
        assert!(err.is_err());
        assert_eq!(store.get(), before);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tray_notice_is_shown_once_even_after_restart() {
        let dir = temp_dir("notice");
        let store = SettingsStore::open(&dir);
        assert!(store.take_tray_notice());
        assert!(!store.take_tray_notice());
        assert!(!SettingsStore::open(&dir).take_tray_notice());
        // e não mexe nos interruptores
        assert_eq!(SettingsStore::open(&dir).get(), AppSettings::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_does_not_reset_the_tray_notice() {
        let dir = temp_dir("notice2");
        let store = SettingsStore::open(&dir);
        assert!(store.take_tray_notice());
        store
            .set(AppSettings {
                start_minimized: true,
                ..AppSettings::default()
            })
            .unwrap();
        assert!(!SettingsStore::open(&dir).take_tray_notice());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn closing_the_window_in_a_call_leaves_it_unless_the_user_opted_out() {
        let d = AppSettings::default();
        assert_eq!(close_action(&d, false, true), CloseAction::HideAndLeaveCall);
        assert_eq!(close_action(&d, false, false), CloseAction::Hide);
        let keep = AppSettings {
            keep_call_on_close: true,
            ..d
        };
        assert_eq!(close_action(&keep, false, true), CloseAction::Hide);
        // sem bandeja a janela fecha de verdade (e o app desconecta ao sair)
        let no_tray = AppSettings {
            close_to_tray: false,
            ..d
        };
        assert_eq!(close_action(&no_tray, false, true), CloseAction::Quit);
        // já saindo: deixa fechar
        assert_eq!(close_action(&d, true, true), CloseAction::Quit);
    }

    #[test]
    fn starts_hidden_only_for_automatic_launches_with_the_option_on() {
        let on = AppSettings {
            start_minimized: true,
            ..AppSettings::default()
        };
        let off = AppSettings::default();
        assert!(should_start_hidden(&on, &args(&["spook", "--autostart"])));
        assert!(should_start_hidden(&on, &args(&["spook", "--minimized"])));
        assert!(!should_start_hidden(&on, &args(&["spook"])));
        assert!(!should_start_hidden(&off, &args(&["spook", "--autostart"])));
    }
}
