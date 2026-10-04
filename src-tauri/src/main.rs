#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
compile_error!("Caprine supports Windows and Linux only");

mod diagnostics;
mod policy;

use std::fs;
use tauri::{Manager, Webview, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    version: String,
    custom_css: String,
    custom_css_error: Option<String>,
    debug_notifications: bool,
}

fn require_messenger(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" && policy::is_messenger(&webview.url().map_err(|e| e.to_string())?)
    {
        Ok(())
    } else {
        Err("This command is only available to the main Messenger webview".into())
    }
}

#[tauri::command]
fn bootstrap(app: tauri::AppHandle, webview: Webview) -> Result<Bootstrap, String> {
    require_messenger(&webview)?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("custom.css");
    let (custom_css, custom_css_error) = match fs::read_to_string(path) {
        Ok(css) => (css, None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (String::new(), None),
        Err(error) => (
            String::new(),
            Some(format!("Could not read custom.css: {error}")),
        ),
    };
    Ok(Bootstrap {
        version: app.package_info().version.to_string(),
        custom_css,
        custom_css_error,
        debug_notifications: app.state::<diagnostics::Diagnostics>().enabled,
    })
}

#[tauri::command]
fn log_service_worker_inventory(
    webview: Webview,
    diagnostics: tauri::State<'_, diagnostics::Diagnostics>,
    sample: diagnostics::WorkerSample,
) -> Result<(), String> {
    require_messenger(&webview)?;
    diagnostics.record(sample)
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, webview: Webview, url: String) -> Result<(), String> {
    require_messenger(&webview)?;
    open_link(&app, &url)
}

fn open_link(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(policy::external_url(url)?.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn main() {
    let context = tauri::generate_context!();
    // Match the NSIS shortcut's AUMID before creating any native windows.
    #[cfg(target_os = "windows")]
    {
        let app_id: Vec<u16> = context
            .config()
            .identifier
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let result = unsafe {
            windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr())
        };
        assert!(
            result >= 0,
            "could not set Windows AppUserModelID: {result:#x}"
        );
    }
    let autostart_name = context.config().identifier.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::Builder::new().app_name(autostart_name).args(["--autostart"]).build())
        .invoke_handler(tauri::generate_handler![bootstrap, open_external, log_service_worker_inventory])
        .setup(|app| {
            let profile = app.path().app_local_data_dir()?.join("webview");
            fs::create_dir_all(&profile)?;
            fs::create_dir_all(app.path().app_data_dir()?)?;
            app.manage(diagnostics::Diagnostics::load(app.handle())?);
            let navigation_app = app.handle().clone();
            let popup_app = app.handle().clone();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(policy::MESSENGER.parse()?))
                .title("Caprine")
                .inner_size(1000.0, 720.0)
                .min_inner_size(400.0, 300.0)
                .data_directory(profile)
                .incognito(false)
                .disable_drag_drop_handler()
                .initialization_script(include_str!("../../dist/inject.js"))
                .on_navigation(move |url| {
                    if policy::is_messenger(url) || policy::is_authentication(url) {
                        true
                    } else {
                        if let Err(error) = open_link(&navigation_app, url.as_str()) {
                            eprintln!("Could not open external navigation: {error}");
                        }
                        false
                    }
                })
                .on_new_window(move |url, _| {
                    // Related call windows are implemented in the calls phase.
                    if !policy::is_messenger(&url) && url.scheme() != "about" {
                        if let Err(error) = open_link(&popup_app, url.as_str()) {
                            eprintln!("Could not open external popup: {error}");
                        }
                    }
                    tauri::webview::NewWindowResponse::Deny
                });
            #[cfg(target_os = "windows")]
            let builder = builder.additional_browser_args("--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows");
            builder.build()?;
            Ok(())
        })
        .run(context)
        .expect("could not run Caprine");
}
