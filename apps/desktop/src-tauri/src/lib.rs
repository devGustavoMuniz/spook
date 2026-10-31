//! Casca Tauri 2 do Spook. A interface é o `apps/web` em modo desktop; aqui ficam só as
//! capacidades nativas: chaveiro do SO para o token, instância única, notificações, estado da janela
//! e a guarda de navegação (links externos abrem no navegador do sistema).
//!
//! Ponto de extensão da Parte 7b (voz/tela nativas em Rust): registre os comandos novos em
//! `invoke_handler` abaixo e crie um módulo irmão de `token`/`nav` (ex.: `voice`).

mod nav;
mod token;

use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

use token::{KeyringStore, TokenState, TokenVault};

#[tauri::command]
fn auth_get_token(vault: State<'_, TokenVault>) -> TokenState {
    vault.get()
}

#[tauri::command]
fn auth_set_token(vault: State<'_, TokenVault>, token: String) -> Result<TokenState, String> {
    if token.trim().is_empty() {
        return Err("token vazio".into());
    }
    Ok(vault.set(&token))
}

#[tauri::command]
fn auth_clear_token(vault: State<'_, TokenVault>) -> Result<(), String> {
    vault.clear()
}

/// Bloqueia qualquer navegação do webview para fora do app e abre o destino no navegador do sistema.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let dev_origin = if cfg!(debug_assertions) {
        Some("http://localhost:5180")
    } else {
        None
    };
    tauri::plugin::Builder::<R>::new("navigation-guard")
        .on_navigation(move |webview, url| {
            if nav::is_internal(url, dev_origin) {
                return true;
            }
            if nav::is_openable_externally(url) {
                let _ = webview
                    .app_handle()
                    .opener()
                    .open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
}

pub fn run() {
    tauri::Builder::default()
        // Instância única precisa ser o primeiro plugin: a segunda execução só traz a janela à frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(navigation_guard())
        .manage(TokenVault::new(Box::new(KeyringStore)))
        .invoke_handler(tauri::generate_handler![
            auth_get_token,
            auth_set_token,
            auth_clear_token
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Spook");
}
