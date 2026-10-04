//! Engine integrations outside notifications: main-frame load results for
//! offline recovery, spell checking, GPU policy and (Linux) downloads.
//! Installed before Messenger is first navigated.

/// Spell-check languages from the POSIX locale variables, in priority order.
/// WebKitGTK needs an explicit list; there is no language-selection UI.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn locale_languages(var: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let mut languages: Vec<String> = Vec::new();
    let mut candidates: Vec<String> = var("LANGUAGE")
        .map(|value| value.split(':').map(str::to_string).collect())
        .unwrap_or_default();
    candidates.extend(
        ["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .filter_map(|name| var(name)),
    );
    for candidate in candidates {
        let language = candidate
            .split(['.', '@'])
            .next()
            .unwrap_or_default()
            .trim();
        if language.is_empty()
            || matches!(language, "C" | "POSIX")
            || !language
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            || languages.iter().any(|l| l == language)
        {
            continue;
        }
        languages.push(language.to_string());
    }
    if languages.is_empty() {
        languages.push("en_US".into());
    }
    languages
}

#[cfg(target_os = "windows")]
mod platform {
    use std::cell::RefCell;
    use tauri::Manager;
    use webview2_com::{
        take_pwstr, Microsoft::Web::WebView2::Win32::*, NavigationCompletedEventHandler,
        NavigationStartingEventHandler,
    };
    use windows::core::PWSTR;

    thread_local! {
        // NavigationId -> URI, recorded on the UI thread.
        static STARTED: RefCell<Vec<(u64, String)>> = const { RefCell::new(Vec::new()) };
    }

    /// Network failures that mean "unreachable". Cancelled/aborted navigations
    /// (our own URL policy, downloads, newer navigations) are not offline.
    fn offline_reason(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> Option<&'static str> {
        Some(match status {
            COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT => "cannot_connect",
            COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => "host_name_not_resolved",
            COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => "timeout",
            COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE => "server_unreachable",
            COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => "disconnected",
            COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET => "connection_reset",
            _ => return None,
        })
    }

    pub fn install(
        window: &tauri::WebviewWindow,
        _settings: &crate::settings::Settings,
    ) -> tauri::Result<()> {
        let app = window.app_handle().clone();
        window.with_webview(move |webview| {
            if let Err(error) = hook(&app, webview) {
                eprintln!("Could not install navigation diagnostics: {error}");
            }
        })
    }

    fn hook(
        app: &tauri::AppHandle,
        webview: tauri::webview::PlatformWebview,
    ) -> windows::core::Result<()> {
        let core = unsafe { webview.controller().CoreWebView2() }?;
        let starting = NavigationStartingEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut id = 0;
            let mut uri = PWSTR::null();
            unsafe {
                args.NavigationId(&mut id)?;
                args.Uri(&mut uri)?;
            }
            let uri = take_pwstr(uri);
            STARTED.with(|started| {
                let mut started = started.borrow_mut();
                started.push((id, uri));
                let excess = started.len().saturating_sub(32);
                started.drain(..excess);
            });
            Ok(())
        }));
        let handle = app.clone();
        let completed = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut id = 0;
            let mut success = windows::core::BOOL(0);
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
            unsafe {
                args.NavigationId(&mut id)?;
                args.IsSuccess(&mut success)?;
                args.WebErrorStatus(&mut status)?;
            }
            let Some(uri) = STARTED.with(|started| {
                let mut started = started.borrow_mut();
                let index = started
                    .iter()
                    .position(|(started_id, _)| *started_id == id)?;
                Some(started.remove(index).1)
            }) else {
                return Ok(());
            };
            if success.as_bool() {
                crate::offline::succeeded(&handle, &uri);
            } else if let Some(reason) = offline_reason(status) {
                crate::offline::failed(&handle, &uri, reason);
            }
            Ok(())
        }));
        let mut token = 0;
        unsafe {
            core.add_NavigationStarting(&starting, &mut token)?;
            core.add_NavigationCompleted(&completed, &mut token)?;
        }
        Ok(())
    }

    /// WebView2 exposes no spell-check setting; the injected script toggles the
    /// HTML `spellcheck` attribute instead.
    pub fn set_spell_check(_window: &tauri::WebviewWindow, _enabled: bool) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{cell::Cell, rc::Rc};
    use tauri::Manager;
    use webkit2gtk::{
        glib, DownloadExt, HardwareAccelerationPolicy, LoadEvent, NetworkError, PolicyError,
        SettingsExt, WebContext, WebContextExt, WebViewExt,
    };

    fn offline_error(error: &glib::Error) -> bool {
        !(error.matches(NetworkError::Cancelled)
            || error.kind::<PolicyError>().is_some()
            || error.kind::<webkit2gtk::DownloadError>().is_some()
            || error.kind::<webkit2gtk::PluginError>().is_some())
    }

    fn apply_spell_check(context: &WebContext, enabled: bool) {
        if enabled {
            let languages = super::locale_languages(|name| std::env::var(name).ok());
            let languages: Vec<&str> = languages.iter().map(String::as_str).collect();
            context.set_spell_checking_languages(&languages);
        }
        context.set_spell_checking_enabled(enabled);
    }

    pub fn install(
        window: &tauri::WebviewWindow,
        settings: &crate::settings::Settings,
    ) -> tauri::Result<()> {
        let app = window.app_handle().clone();
        let hardware = settings.hardware_acceleration;
        let spell = settings.spell_check;
        window.with_webview(move |webview| {
            let view = webview.inner();
            if !hardware {
                if let Some(settings) = WebViewExt::settings(&view) {
                    // Related call views share these settings.
                    settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
                }
            }
            if let Some(context) = view.context() {
                apply_spell_check(&context, spell);
                downloads(&app, &context);
            }
            let committed = app.clone();
            view.connect_load_changed(move |view, event| {
                if event == LoadEvent::Committed {
                    if let Some(uri) = view.uri() {
                        crate::offline::succeeded(&committed, &uri);
                    }
                }
            });
            let failed = app.clone();
            view.connect_load_failed(move |_, _, uri, error| {
                if offline_error(error) {
                    crate::offline::failed(&failed, uri, &error.to_string());
                }
                false
            });
        })
    }

    fn downloads(app: &tauri::AppHandle, context: &WebContext) {
        let app = app.clone();
        context.connect_download_started(move |_, download| {
            let directory = app.path().download_dir().ok();
            download.connect_decide_destination(move |download, suggested| {
                let uri = directory
                    .as_deref()
                    .map(|directory| crate::downloads::unique_path(directory, suggested))
                    .and_then(|path| glib::filename_to_uri(path, None).ok());
                match uri {
                    // WebKitGTK 4.1 expects a destination URI, not a path.
                    Some(uri) => download.set_destination(&uri),
                    None => download.cancel(),
                }
                true
            });
            // Per download: one failure must not mark later downloads failed.
            let failed = Rc::new(Cell::new(false));
            let flag = failed.clone();
            download.connect_failed(move |_, _| flag.set(true));
            let finished = app.clone();
            download.connect_finished(move |download| {
                let path = download
                    .destination()
                    .and_then(|uri| glib::filename_from_uri(&uri).ok())
                    .map(|(path, _)| path);
                crate::downloads::finished(&finished, path, !failed.get());
            });
        });
    }

    pub fn set_spell_check(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
        window
            .with_webview(move |webview| {
                if let Some(context) = webview.inner().context() {
                    apply_spell_check(&context, enabled);
                }
            })
            .map_err(|e| e.to_string())
    }
}

pub use platform::{install, set_spell_check};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spell_languages_follow_locale_without_duplicates() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
            }
        };
        assert_eq!(
            locale_languages(env(&[("LANGUAGE", "pl:en_GB"), ("LANG", "pl_PL.UTF-8")])),
            ["pl", "en_GB", "pl_PL"]
        );
        assert_eq!(locale_languages(env(&[("LANG", "C.UTF-8")])), ["en_US"]);
        assert_eq!(
            locale_languages(env(&[("LC_ALL", "de_DE@euro"), ("LANG", "../x")])),
            ["de_DE"]
        );
    }
}
