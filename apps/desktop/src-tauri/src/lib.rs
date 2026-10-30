//! Núcleo nativo do VYRON.
//!
//! Princípio: o frontend só alcança o sistema operacional pelos comandos registrados aqui e
//! liberados em `capabilities/default.json`. Nada de shell, sistema de arquivos ou processos
//! genéricos expostos ao WebView.

mod credentials;
mod remote_input;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State, WindowEvent,
};

/// Se fechar a janela deve escondê-la na bandeja (true) ou encerrar o app (false).
struct CloseToTray(AtomicBool);

/// Aviso nativo do Windows. Só texto (título e corpo limitados); o WebView não ganha acesso ao plugin
/// de notificações em si — apenas a este comando.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let title: String = title.chars().take(120).collect();
    let body: String = body.chars().take(300).collect();
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_close_to_tray(enabled: bool, state: State<'_, CloseToTray>) {
    state.0.store(enabled, Ordering::Relaxed);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(CloseToTray(AtomicBool::new(true)))
        .manage(remote_input::PlayState::default())
        .invoke_handler(tauri::generate_handler![
            credentials::auth_token_get,
            credentials::auth_token_set,
            credentials::auth_token_clear,
            set_close_to_tray,
            notify,
            remote_input::play_list_windows,
            remote_input::play_arm,
            remote_input::play_input,
            remote_input::play_disarm,
        ])
        .setup(|app| {
            // Jogar Juntos: atalho de emergência global (funciona com o jogo em primeiro plano).
            // Desarma no núcleo na hora e avisa a interface, que revoga a autorização no servidor.
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let panic = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F12);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &panic && event.state() == ShortcutState::Pressed {
                                remote_input::disarm(&app.state::<remote_input::PlayState>());
                                let _ = app.emit("play-panic", ());
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(panic)?;
            }
            // Bandeja com saída explícita: "Sair do VYRON" encerra o processo inteiro
            // (nas próximas etapas, isso também encerra chamadas, capturas e sessões remotas).
            let show = MenuItem::with_id(app, "show", "Abrir o VYRON", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair do VYRON", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("VYRON");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "show" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                "quit" => {
                    // Sair encerra também qualquer controle remoto em andamento.
                    remote_input::disarm(&app.state::<remote_input::PlayState>());
                    app.exit(0)
                }
                _ => {}
            })
            .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let to_tray = window.state::<CloseToTray>().0.load(Ordering::Relaxed);
                if window.label() == "main" && to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o VYRON");
}
