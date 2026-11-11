//! Casca Tauri 2 do Spook. A interface é o `apps/web` em modo desktop; aqui ficam só as
//! capacidades nativas: chaveiro do SO para o token, instância única, notificações, estado da janela
//! e a guarda de navegação (links externos abrem no navegador do sistema).
//!
//! A bandeja, o fechar-para-a-bandeja, o início com o sistema e o contador no ícone ficam em `shell`
//! (lógica pura em `settings` e `badge`).
//!
//! Atualização automática: plugins `updater` e `process` (a lógica fica em `apps/web/src/desktop/updater.ts`).
//!
//! Voz, vídeo e tela nativos (Parte 7b, RF12.2) ficam no módulo `voice`: LiveKit Rust SDK + cpal + scap +
//! nokhwa, sem WebRTC no WebView.

mod badge;
mod deeplink;
mod nav;
mod settings;
mod shell;
mod token;
pub mod voice;

use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

use token::{KeyringStore, TokenState, TokenVault};
use voice::commands as vc;

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
    // Logs do núcleo de voz (nunca contêm token); `RUST_LOG=spook_desktop_lib=debug` para detalhar.
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("warn,spook_desktop_lib=info"),
    )
    .init();
    tauri::Builder::default()
        // Instância única precisa ser o primeiro plugin: a segunda execução só traz a janela à frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_main(app);
        }))
        // A visibilidade NÃO é restaurada: quem decide se a janela nasce escondida é `shell::setup`
        // ("iniciar minimizado"); senão sair com a janela na bandeja faria o app abrir escondido para sempre.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        // Início com o sistema (padrão desligado; ligado em `/settings/app`). O argumento marca a abertura automática.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(settings::AUTOSTART_ARG)
                .build(),
        )
        // Esquema `spook://` (login pelo navegador). Depois do single-instance: com a feature `deep-link` dele, abrir
        // `spook://...` com o app rodando entrega a URL a este plugin na instância existente. Sem permissão no
        // webview (capabilities): o tratamento é todo em Rust (`deeplink`), que só repassa o código validado.
        .plugin(tauri_plugin_deep_link::init())
        // Atualizações assinadas (chave pública e endpoint em `tauri.conf.json`); o webview só chama
        // `check`/`download`/`install` (capabilities) e reinicia com o plugin de processo.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(navigation_guard())
        .manage(TokenVault::new(Box::new(KeyringStore)))
        .manage(voice::VoiceState::new())
        .setup(|app| {
            shell::setup(app)?;
            // Depois do `shell::setup`: um deep link no início a frio traz a janela mesmo com "iniciar minimizado".
            shell::deep_link_setup(app);
            Ok(())
        })
        .on_window_event(shell::on_window_event)
        .invoke_handler(tauri::generate_handler![
            auth_get_token,
            auth_set_token,
            auth_clear_token,
            shell::app_get_settings,
            shell::app_set_settings,
            shell::app_set_badge,
            shell::app_set_locale,
            vc::voice_connect,
            vc::voice_disconnect,
            vc::voice_set_microphone,
            vc::voice_reset_microphone,
            vc::voice_prepare_microphone,
            vc::voice_discard_prepared_microphone,
            vc::voice_set_deafened,
            vc::voice_set_audio_processing,
            vc::voice_get_audio_processing,
            vc::voice_set_participant_volume,
            vc::voice_set_input_level_monitor,
            vc::voice_start_mic_test,
            vc::voice_cancel_mic_test,
            vc::voice_set_camera_enabled,
            vc::voice_list_screen_sources,
            vc::voice_screen_source_thumbnails,
            vc::voice_cancel_screen_thumbnails,
            vc::app_open_screen_recording_settings,
            vc::voice_list_audio_apps,
            vc::voice_set_screen_share,
            vc::voice_list_devices,
            vc::voice_set_device,
            vc::voice_set_screen_watching,
            vc::voice_video_subscribe,
            vc::voice_video_unsubscribe,
            vc::voice_video_ack
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Spook")
        .run(|app, event| shell::on_run_event(app, &event));
}
