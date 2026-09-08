#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
mod runtime;

type ControllerState = Arc<Mutex<runtime::Controller>>;

#[tauri::command]
async fn desktop(
    app: tauri::AppHandle,
    state: tauri::State<'_, ControllerState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "Cannot find application resources")?;
    let quit = method == "quit";
    let result = tauri::async_runtime::spawn_blocking(move || {
        state.lock().map_err(|_| "Controller is unavailable")?.call(
            &resources,
            &method,
            params.unwrap_or(Value::Null),
        )
    })
    .await
    .map_err(|_| "Controller failed")??;
    if quit {
        app.exit(0);
    }
    Ok(result)
}

#[tauri::command]
fn startup(enabled: Option<bool>) -> Result<bool, String> {
    runtime::autostart(enabled)
}

#[tauri::command]
fn open_overseer(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = tauri::Url::parse(&url).map_err(|_| "Enter a complete Overseer URL")?;
    if !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Enter an HTTP or HTTPS Overseer URL without credentials".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|_| "Cannot open your browser".into())
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(Mutex::new(runtime::Controller::default())))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![desktop, startup, open_overseer])
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Peon", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Peon", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .tooltip("Peon — setup")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => {
                        show(app);
                        use tauri::Emitter;
                        let _ = app.emit("quit-requested", ());
                    }
                    _ => {}
                })
                .build(app)?;
            if std::env::args().any(|arg| arg == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Peon desktop startup failed");
}
