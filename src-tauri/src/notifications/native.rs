#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod platform;

use super::{Delivery, Event};
use tauri::Manager;

pub fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle().clone();
    let ready = window.clone();
    window.with_webview(move |webview| {
        match platform::install(&app, webview) {
            Ok(()) => {
                super::send(&app, Event::Runtime(serde_json::json!({"source":"engine","decision":"ready","reason":"native_hook_installed"})));
                // Navigating synchronously from this setup-time callback never returns
                // (the window then stays hidden and the event loop never starts).
                // From another thread the request is queued to the event loop.
                let messenger = ready.clone();
                std::thread::spawn(move || {
                    if let Err(error) = messenger.navigate(crate::policy::MESSENGER.parse().expect("Messenger URL")) { eprintln!("Could not load Messenger: {error}"); }
                });
            }
            Err(error) => {
                eprintln!("Notification engine initialization failed: {error}");
                super::send(&app, Event::Runtime(serde_json::json!({"source":"engine","decision":"error","reason":error})));
                // Stop on a missing hook instead of enabling two presentation owners.
                let message = serde_json::to_string(&format!("Caprine could not initialize notifications: {error}. Update the system webview runtime and restart.")).unwrap();
                let _ = ready.eval(format!("document.body.textContent={message}"));
                let _ = ready.show();
            }
        }
    })
}
pub fn log_runtime(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let app = app.clone();
        let _ = window.with_webview(move |webview| platform::log_runtime(&app, webview));
    }
}
pub fn show(app: &tauri::AppHandle, delivery: Delivery) {
    platform::show(app, delivery);
}
pub fn close(app: &tauri::AppHandle, id: u64) {
    platform::close(app, id);
}
pub fn activate(app: &tauri::AppHandle, delivery: &Delivery) {
    let delivery = delivery.clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        platform::clicked(delivery.id);
        let result = match &delivery.action {
            super::Action::RevealFile(path) => {
                use tauri_plugin_opener::OpenerExt;
                handle
                    .opener()
                    .reveal_item_in_dir(path)
                    .map_err(|e| e.to_string())
            }
            super::Action::InstallUpdate => {
                crate::update::install_in_background(&handle);
                Ok(())
            }
            super::Action::RestoreWindow => crate::tray::restore(&handle),
            super::Action::Message(thread) => crate::tray::restore(&handle).and_then(|()| {
                match (
                    handle.get_webview_window("main"),
                    thread.as_deref().and_then(super::thread_url),
                ) {
                    (Some(window), Some(url)) => window
                        .navigate(url.1.parse().expect("validated thread URL"))
                        .map_err(|e| e.to_string()),
                    _ => Ok(()),
                }
            }),
        };
        if let Err(error) = result {
            super::log(
                &handle,
                serde_json::json!({"source":"activation","decision":"error","reason":error}),
            );
        }
        platform::close_on_main(delivery.id);
    });
}
