//! Signed GitHub-release updates through tauri-plugin-updater. All updater
//! access is Rust-side; Messenger only gets the narrow `updater_action` command.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{utils::config::BundleType, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::notifications::{self, Action, Event};

const FIRST_CHECK: Duration = Duration::from_secs(60);
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct UpdateState {
    busy: AtomicBool,
    status: Mutex<Status>,
    notified: Mutex<Option<String>>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    #[default]
    Idle,
    Unsupported,
    Checking,
    UpToDate,
    Available,
    Installing,
    Error,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Request {
    Status,
    Check,
    Install,
}

/// Packaging formats whose installed copy the updater can replace. A plain
/// executable (debug build, CI artifact) carries no bundle marker.
pub fn support(bundle: Option<BundleType>) -> Result<&'static str, &'static str> {
    match bundle {
        Some(BundleType::Nsis) => Ok("nsis"),
        Some(BundleType::AppImage) => Ok("appimage"),
        Some(_) => Err("This package format is not published for Caprine (Visnia)."),
        None => Err("Updates are available only in installed release builds (NSIS or AppImage)."),
    }
}

fn set(app: &tauri::AppHandle, status: Status) -> Status {
    *app.state::<UpdateState>()
        .status
        .lock()
        .expect("update status") = status.clone();
    let _ = app.emit_to("main", "update-status", &status);
    status
}

fn unsupported() -> Option<Status> {
    support(tauri::utils::platform::bundle_type())
        .err()
        .map(|message| Status {
            state: State::Unsupported,
            version: None,
            message: Some(message.into()),
        })
}

pub async fn check(app: &tauri::AppHandle) -> Status {
    if let Some(status) = unsupported() {
        return set(app, status);
    }
    let state = app.state::<UpdateState>();
    if state.busy.swap(true, Ordering::AcqRel) {
        return state.status.lock().expect("update status").clone();
    }
    set(
        app,
        Status {
            state: State::Checking,
            ..Status::default()
        },
    );
    let result = match app.updater() {
        Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
        Err(error) => Err(error.to_string()),
    };
    state.busy.store(false, Ordering::Release);
    let status = match result {
        Ok(Some(update)) => Status {
            state: State::Available,
            version: Some(update.version),
            message: None,
        },
        Ok(None) => Status {
            state: State::UpToDate,
            version: None,
            message: None,
        },
        Err(error) => Status {
            state: State::Error,
            version: None,
            message: Some(error),
        },
    };
    notifications::log(
        app,
        serde_json::json!({"source":"updater","decision":format!("{:?}", status.state),"reason":status.message}),
    );
    set(app, status)
}

/// Re-checks, verifies the signature while downloading, then installs.
/// Windows: the plugin launches the NSIS installer and exits Caprine.
/// Linux: the AppImage is replaced in place, then Caprine restarts.
pub async fn install(app: &tauri::AppHandle) -> Status {
    if let Some(status) = unsupported() {
        return set(app, status);
    }
    let state = app.state::<UpdateState>();
    if state.busy.swap(true, Ordering::AcqRel) {
        return state.status.lock().expect("update status").clone();
    }
    let result = async {
        let update = app
            .updater()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No update is available.".to_string())?;
        set(
            app,
            Status {
                state: State::Installing,
                version: Some(update.version.clone()),
                message: None,
            },
        );
        use tauri_plugin_window_state::AppHandleExt;
        let _ = app.save_window_state(crate::tray::WINDOW_STATE);
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    state.busy.store(false, Ordering::Release);
    match result {
        Ok(()) => app.restart(),
        Err(error) => {
            notifications::log(
                app,
                serde_json::json!({"source":"updater","decision":"error","reason":error}),
            );
            set(
                app,
                Status {
                    state: State::Error,
                    version: None,
                    message: Some(error),
                },
            )
        }
    }
}

pub fn install_in_background(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        install(&app).await;
    });
}

pub fn status(app: &tauri::AppHandle) -> Status {
    unsupported().unwrap_or_else(|| {
        app.state::<UpdateState>()
            .status
            .lock()
            .expect("update status")
            .clone()
    })
}

/// Periodic checks while automatic updates are enabled. A found update is
/// announced once per version; installing always needs a click.
pub fn start(app: &tauri::AppHandle) {
    if unsupported().is_some() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if app
                .state::<crate::settings::SettingsState>()
                .get()
                .auto_update
            {
                let status = check(&app).await;
                if let (State::Available, Some(version)) = (status.state, status.version) {
                    let mut notified = app
                        .state::<UpdateState>()
                        .inner()
                        .notified
                        .lock()
                        .expect("update notice");
                    if notified.as_deref() != Some(version.as_str()) {
                        *notified = Some(version.clone());
                        notifications::send(
                            &app,
                            Event::System {
                                title: format!("Caprine {version} is available"),
                                body: "Click to install the update and restart Caprine.".into(),
                                action: Action::InstallUpdate,
                            },
                        );
                    }
                }
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_published_installed_formats_update() {
        assert_eq!(support(Some(BundleType::Nsis)), Ok("nsis"));
        assert_eq!(support(Some(BundleType::AppImage)), Ok("appimage"));
        assert!(support(Some(BundleType::Deb)).is_err());
        assert!(support(Some(BundleType::Msi)).is_err());
        assert!(support(Some(BundleType::Rpm)).is_err());
        assert!(support(None).is_err());
    }
}
