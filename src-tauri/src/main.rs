#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
compile_error!("Caprine supports Windows and Linux only");

mod calls;
mod diagnostics;
mod downloads;
mod engine;
mod notifications;
mod offline;
mod policy;
mod settings;
mod tray;
mod update;

use std::fs;
use tauri::{Manager, Webview, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    version: String,
    platform: &'static str,
    custom_css: String,
    custom_css_error: Option<String>,
    settings: settings::Settings,
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
        platform: std::env::consts::OS,
        custom_css,
        custom_css_error,
        settings: app.state::<settings::SettingsState>().get(),
    })
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle, webview: Webview) -> Result<settings::Settings, String> {
    require_messenger(&webview)?;
    Ok(app.state::<settings::SettingsState>().get())
}

#[tauri::command]
fn update_setting(
    app: tauri::AppHandle,
    webview: Webview,
    update: settings::Update,
) -> Result<settings::Settings, String> {
    require_messenger(&webview)?;
    app.state::<settings::SettingsState>().update(&app, update)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum PanelAction {
    CustomStyles,
    Relaunch,
    Quit,
}

#[tauri::command]
fn panel_action(
    app: tauri::AppHandle,
    webview: Webview,
    action: PanelAction,
) -> Result<(), String> {
    require_messenger(&webview)?;
    match action {
        PanelAction::CustomStyles => {
            let path = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("custom.css");
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            app.opener()
                .open_path(path.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())?;
        }
        PanelAction::Relaunch => {
            use tauri_plugin_window_state::AppHandleExt;
            app.save_window_state(tray::WINDOW_STATE)
                .map_err(|e| e.to_string())?;
            app.restart();
        }
        PanelAction::Quit => tray::quit_app(&app),
    }
    Ok(())
}

#[tauri::command]
fn report_unread(app: tauri::AppHandle, webview: Webview, count: u32) -> Result<(), String> {
    require_messenger(&webview)?;
    if count > 1_000_000 {
        return Err("Unread count exceeds supported range".into());
    }
    app.state::<tray::TrayState>()
        .unread
        .store(count, std::sync::atomic::Ordering::Relaxed);
    tray::refresh(&app)
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
fn collect_notification(
    app: tauri::AppHandle,
    webview: Webview,
    event: notifications::Collected,
) -> Result<(), String> {
    require_messenger(&webview)?;
    event.validate()?;
    app.state::<notifications::Broker>()
        .send(notifications::Event::Page(event))
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, webview: Webview, url: String) -> Result<(), String> {
    require_messenger(&webview)?;
    open_link(&app, &url)
}

#[tauri::command]
async fn updater_action(
    app: tauri::AppHandle,
    webview: Webview,
    request: update::Request,
) -> Result<update::Status, String> {
    require_messenger(&webview)?;
    Ok(match request {
        update::Request::Status => update::status(&app),
        update::Request::Check => update::check(&app).await,
        update::Request::Install => update::install(&app).await,
    })
}

pub(crate) fn open_link(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
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
            if let Err(error) = tray::restore(app) { eprintln!("Could not restore Caprine: {error}"); }
        }))
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::Builder::new().app_name(autostart_name).args(["--autostart"]).build())
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(tray::WINDOW_STATE).with_filter(|label| label == "main").build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![bootstrap, open_external, log_service_worker_inventory, get_settings, update_setting, panel_action, report_unread, collect_notification, updater_action])
        .setup(|app| {
            let profile = app.path().app_local_data_dir()?.join("webview");
            fs::create_dir_all(&profile)?;
            fs::create_dir_all(app.path().app_data_dir()?)?;
            let settings_state = settings::SettingsState::load(app.handle())?;
            let settings = settings_state.get();
            app.manage(settings_state);
            app.manage(diagnostics::Diagnostics::new(app.handle(), settings.debug_notifications)?);
            app.manage(tray::TrayState::default());
            app.manage(notifications::Broker::start(app.handle().clone()));
            app.manage(offline::Offline::default());
            app.manage(update::UpdateState::default());
            let navigation_app = app.handle().clone();
            let popup_app = app.handle().clone();
            // Install engine hooks before Messenger can construct notifications.
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External("about:blank".parse()?))
                .title("caprine")
                .inner_size(1000.0, 720.0)
                .min_inner_size(400.0, 300.0)
                .always_on_top(settings.always_on_top)
                .theme(settings.native_theme())
                .visible(false)
                .data_directory(profile)
                .incognito(false)
                .disable_drag_drop_handler()
                .zoom_hotkeys_enabled(false)
                .initialization_script(include_str!("../../dist/inject.js"))
                .on_permission_request(|webview, kind| calls::permission(&webview, kind))
                .on_page_load(|window, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished { offline::page_loaded(&window, payload.url()); }
                })
                .on_navigation(move |url| {
                    if url.as_str() == "about:blank" || policy::is_messenger(url) || policy::is_authentication(url) {
                        true
                    } else {
                        if let Err(error) = open_link(&navigation_app, url.as_str()) {
                            eprintln!("Could not open external navigation: {error}");
                        }
                        false
                    }
                })
                .on_new_window(move |url, features| calls::new_window(&popup_app, url, features));
            #[cfg(target_os = "windows")]
            let builder = builder
                .additional_browser_args(&format!(
                    "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows{}",
                    if settings.hardware_acceleration { "" } else { " --disable-gpu" }
                ))
                // WebView2 picks a unique name in the default download folder.
                .on_download(|webview, event| {
                    if let tauri::webview::DownloadEvent::Finished { path, success, .. } = event {
                        downloads::finished(webview.app_handle(), path, success);
                    }
                    true
                });
            let window = builder.build()?;
            window.set_zoom(settings.zoom_factor)?;
            settings::apply_title_bar(&window, settings.theme);
            tray::install(app.handle())?;
            tray::refresh(app.handle())?;
            tray::start_blinking(app.handle());
            engine::install(&window, &settings)?;
            notifications::install(&window)?;
            update::start(app.handle());
            let close_app = app.handle().clone();
            let theme_window = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::ThemeChanged(_) = event {
                    // System follows Windows, so its caption must follow too.
                    // set_theme fires this inside a settings update, which holds
                    // the lock and applies the caption itself.
                    if let Some(settings) = close_app.state::<settings::SettingsState>().try_get() {
                        settings::apply_title_bar(&theme_window, settings.theme);
                    }
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if close_app.state::<settings::SettingsState>().get().quit_on_window_close {
                        tray::quit_app(&close_app);
                    } else if let Err(error) = tray::park(&close_app) {
                        eprintln!("Could not close to tray: {error}");
                    }
                }
            });
            // Show the native window before minimizing; the child webview keeps
            // its controller visibility. Saved visibility never traps startup.
            window.show()?;
            if settings.launch_minimized { tray::park(app.handle())?; }
            Ok(())
        })
        .run(context)
        .expect("could not run Caprine");
}
