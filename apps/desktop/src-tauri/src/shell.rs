//! Casca do desktop: bandeja do sistema, fechar para a bandeja, iniciar com o sistema, contador no ícone e
//! sair de verdade. A lógica pura mora em `settings.rs` e `badge.rs` (testadas sem Tauri); aqui só a cola.
//!
//! Plataformas (o que realmente aparece está em `apps/desktop/README.md`):
//! * **Windows/macOS:** ícone na bandeja/barra de menus, clique esquerdo alterna a janela, menu "Abrir Spook"/"Sair";
//! * **Linux:** o ícone depende de um host de StatusNotifier/AppIndicator (KDE, XFCE e afins têm; o GNOME precisa da
//!   extensão "AppIndicator"). Clique esquerdo no ícone NÃO chega ao app no Linux: use o menu. Sem host de bandeja,
//!   desligue "Fechar vai para a bandeja" (ou abra o app de novo: a segunda instância traz a janela de volta).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

use crate::badge;
use crate::settings::{self, AppSettings, SettingsStore};
use crate::voice::VoiceState;

/// Id do ícone da bandeja.
const TRAY_ID: &str = "main";
/// Janela principal (a única).
const MAIN: &str = "main";
/// Evento enviado ao webview quando a janela é trazida à frente pelo app (bandeja, segunda instância, Dock).
/// O adaptador de notificações o usa para abrir o canal da última notificação (ver `notifier.ts`).
pub const ACTIVATED_EVENT: &str = "app://activated";
/// Quanto esperamos a voz desconectar ao sair, antes de encerrar de qualquer jeito.
const QUIT_VOICE_TIMEOUT: Duration = Duration::from_secs(3);

/// Textos que o Rust mostra por conta própria (menu da bandeja e o aviso de "continua rodando").
/// O idioma vem do webview (`app_set_locale`); sem ele, português.
#[derive(Debug, PartialEq, Eq)]
pub struct TrayText {
    pub open: &'static str,
    pub quit: &'static str,
    pub notice: &'static str,
}

/// Textos do idioma pedido (`"en"`, `"en-US"`...); qualquer outro vira português do Brasil.
pub fn tray_text(locale: &str) -> TrayText {
    if locale.to_ascii_lowercase().starts_with("en") {
        TrayText {
            open: "Open Spook",
            quit: "Quit",
            notice: "Spook keeps running in the tray. Use the icon to open or quit.",
        }
    } else {
        TrayText {
            open: "Abrir Spook",
            quit: "Sair",
            notice: "O Spook continua rodando na bandeja. Use o ícone para abrir ou sair.",
        }
    }
}

pub struct ShellState {
    pub settings: SettingsStore,
    quitting: AtomicBool,
    /// Idioma da interface, repassado pelo webview.
    locale: Mutex<String>,
    /// Itens do menu da bandeja (abrir, sair), para trocar o texto ao mudar o idioma.
    tray_items: Mutex<Option<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)>>,
}

type SetupResult = Result<(), Box<dyn std::error::Error>>;

/// Chamado em `setup`: lê as configurações, cria a bandeja, alinha o autostart e esconde a janela se for o caso.
pub fn setup(app: &mut tauri::App) -> SetupResult {
    let dir = app.path().app_config_dir()?;
    let store = SettingsStore::open(&dir);
    let current = store.get();
    app.manage(ShellState {
        settings: store,
        quitting: AtomicBool::new(false),
        locale: Mutex::new("pt-BR".to_string()),
        tray_items: Mutex::new(None),
    });

    build_tray(app)?;

    // O arquivo é a fonte da verdade: se o item de login do sistema divergiu (apagado à mão, app movido), realinha.
    let launcher = app.autolaunch();
    if launcher.is_enabled().unwrap_or(current.start_with_system) != current.start_with_system {
        let _ = apply_autostart(app.handle(), current.start_with_system);
    }

    let args: Vec<String> = std::env::args().collect();
    if settings::should_start_hidden(&current, &args) {
        if let Some(w) = app.get_webview_window(MAIN) {
            let _ = w.hide();
        }
    }
    Ok(())
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let text = tray_text("pt-BR");
    let open = MenuItem::with_id(app, "open", text.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", text.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Spook")
        .menu(&menu)
        // Clique esquerdo alterna a janela; o menu fica no direito (Windows/macOS). Linux: só o menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    if let Some(state) = app.try_state::<ShellState>() {
        if let Ok(mut items) = state.tray_items.lock() {
            *items = Some((open, quit));
        }
    }
    Ok(())
}

/// Traz a janela à frente (restaura se estava minimizada ou escondida) e avisa o webview.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit(ACTIVATED_EVENT, ());
}

fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    let visible = app
        .get_webview_window(MAIN)
        .map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false);
    if visible {
        if let Some(w) = app.get_webview_window(MAIN) {
            let _ = w.hide();
        }
    } else {
        show_main(app);
    }
}

/// Sai de verdade: desconecta a voz (o servidor vê a saída na hora, sem esperar o tempo limite) e encerra.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<ShellState>() else {
        app.exit(0);
        return;
    };
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(voice) = app.try_state::<VoiceState>() {
            let _ = tokio::time::timeout(QUIT_VOICE_TIMEOUT, voice.0.disconnect()).await;
        }
        app.exit(0);
    });
}

/// Eventos da janela: fechar a principal vai para a bandeja quando a opção está ligada.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN {
        return;
    }
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let app = window.app_handle();
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    if state.quitting.load(Ordering::SeqCst) || !state.settings.get().close_to_tray {
        return; // fecha de verdade (e `on_run_event` encerra o app desconectando a voz)
    }
    api.prevent_close();
    let _ = window.hide();
    if state.settings.take_tray_notice() {
        // Aviso único, só na primeira vez. Se o sistema não deixar notificar, tudo bem: o ícone está na bandeja.
        let locale = state.locale.lock().map(|l| l.clone()).unwrap_or_default();
        let _ = app
            .notification()
            .builder()
            .title("Spook")
            .body(tray_text(&locale).notice)
            .show();
    }
}

/// Eventos do app: sair pelo último fechamento/Cmd+Q também desconecta a voz; clique no Dock reabre a janela.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    match event {
        RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            let quitting = app
                .try_state::<ShellState>()
                .is_some_and(|s| s.quitting.load(Ordering::SeqCst));
            if !quitting {
                api.prevent_exit();
                request_quit(app);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_main(app),
        _ => {}
    }
}

fn apply_autostart<R: Runtime>(app: &AppHandle<R>, enable: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enable {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())
}

// ----- comandos -----

#[tauri::command]
pub fn app_get_settings(state: State<'_, ShellState>) -> AppSettings {
    state.settings.get()
}

/// Salva as configurações. O autostart é aplicado ANTES de gravar: se o sistema recusar, nada muda.
#[tauri::command]
pub fn app_set_settings(
    app: AppHandle,
    state: State<'_, ShellState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    if settings.start_with_system != state.settings.get().start_with_system {
        apply_autostart(&app, settings.start_with_system)
            .map_err(|e| format!("Não foi possível alterar o início com o sistema: {e}"))?;
    }
    state.settings.set(settings)
}

/// Idioma da interface (`"pt-BR"` ou `"en"`): troca o menu da bandeja e o aviso de "continua rodando".
#[tauri::command]
pub fn app_set_locale(state: State<'_, ShellState>, locale: String) {
    let text = tray_text(&locale);
    if let Ok(mut current) = state.locale.lock() {
        *current = locale;
    }
    if let Ok(items) = state.tray_items.lock() {
        if let Some((open, quit)) = items.as_ref() {
            let _ = open.set_text(text.open);
            let _ = quit.set_text(text.quit);
        }
    }
}

#[derive(Serialize)]
pub struct BadgeResult {
    /// O que realmente foi aplicado nesta plataforma (para diagnóstico na interface e nos testes).
    pub tooltip: String,
}

/// Contador de não lidas no ícone: Dock (macOS), ícone sobreposto da barra de tarefas (Windows), contador do
/// lançador (Linux, onde existir) e tooltip/título da bandeja. Zero limpa tudo.
#[tauri::command]
pub fn app_set_badge(app: AppHandle, window: tauri::WebviewWindow, count: u32) -> BadgeResult {
    let count = count.min(9_999);
    let tooltip = badge::tooltip(count);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&tooltip)); // Linux: sem suporte (ignorado)
        #[cfg(target_os = "linux")]
        let _ = tray.set_title((count > 0).then(|| badge::label(count)));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window.set_badge_count((count > 0).then_some(i64::from(count)));
    }
    #[cfg(target_os = "windows")]
    {
        let icon = badge::render_overlay(count)
            .map(|(rgba, w, h)| tauri::image::Image::new_owned(rgba, w, h));
        let _ = window.set_overlay_icon(icon);
    }
    BadgeResult { tooltip }
}

#[cfg(test)]
mod tests {
    use super::tray_text;

    #[test]
    fn tray_text_follows_the_locale() {
        assert_eq!(tray_text("en").quit, "Quit");
        assert_eq!(tray_text("en-US").open, "Open Spook");
        assert_eq!(tray_text("pt-BR").quit, "Sair");
        assert_eq!(tray_text("fr").open, "Abrir Spook");
    }
}
