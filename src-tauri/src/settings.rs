use std::{
    fs,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_store::{Store, StoreExt};

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub theme: Theme,
    pub zoom_factor: f64,
    pub always_on_top: bool,
    pub launch_at_login: bool,
    pub launch_minimized: bool,
    pub quit_on_window_close: bool,
    pub show_unread_badge: bool,
    pub debug_notifications: bool,
    pub mute_notifications: bool,
    pub notification_preview: bool,
    pub flash_taskbar: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            zoom_factor: 1.0,
            always_on_top: false,
            launch_at_login: false,
            launch_minimized: false,
            quit_on_window_close: false,
            show_unread_badge: true,
            debug_notifications: false,
            mute_notifications: false,
            notification_preview: true,
            flash_taskbar: true,
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(
    tag = "setting",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum Update {
    Theme(Theme),
    ZoomFactor(f64),
    AlwaysOnTop(bool),
    LaunchAtLogin(bool),
    LaunchMinimized(bool),
    QuitOnWindowClose(bool),
    ShowUnreadBadge(bool),
    DebugNotifications(bool),
    MuteNotifications(bool),
    NotificationPreview(bool),
    FlashTaskbar(bool),
}

impl Settings {
    pub fn native_theme(&self) -> Option<tauri::Theme> {
        match self.theme {
            Theme::System => None,
            Theme::Light => Some(tauri::Theme::Light),
            Theme::Dark => Some(tauri::Theme::Dark),
        }
    }
    fn validate(&self) -> Result<(), String> {
        if !self.zoom_factor.is_finite() || !(0.5..=2.0).contains(&self.zoom_factor) {
            return Err("Zoom must be between 50% and 200%".into());
        }
        Ok(())
    }
    fn updated(&self, update: Update) -> Result<Self, String> {
        let mut next = self.clone();
        match update {
            Update::Theme(v) => next.theme = v,
            Update::ZoomFactor(v) => next.zoom_factor = (v * 100.0).round() / 100.0,
            Update::AlwaysOnTop(v) => next.always_on_top = v,
            Update::LaunchAtLogin(v) => next.launch_at_login = v,
            Update::LaunchMinimized(v) => next.launch_minimized = v,
            Update::QuitOnWindowClose(v) => next.quit_on_window_close = v,
            Update::ShowUnreadBadge(v) => next.show_unread_badge = v,
            Update::DebugNotifications(v) => next.debug_notifications = v,
            Update::MuteNotifications(v) => next.mute_notifications = v,
            Update::NotificationPreview(v) => next.notification_preview = v,
            Update::FlashTaskbar(v) => next.flash_taskbar = v,
        }
        next.validate()?;
        Ok(next)
    }
}

pub struct SettingsState {
    value: Mutex<Settings>,
    store: Arc<Store<tauri::Wry>>,
}

impl SettingsState {
    pub fn load(app: &tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        // StoreBuilder ignores initial load errors. Reject malformed/invalid
        // settings before registering the store, whose exit hook saves it.
        let mut settings = match fs::read(app.path().app_data_dir()?.join("settings.json")) {
            Ok(bytes) => serde_json::from_slice::<Settings>(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(error) => return Err(error.into()),
        };
        settings.validate()?;
        // Reflect the actual OS entry, including changes made outside Caprine.
        settings.launch_at_login = app.autolaunch().is_enabled()?;
        let state = Self {
            value: Mutex::new(settings.clone()),
            store: app.store("settings.json")?,
        };
        state.persist(&settings)?;
        Ok(state)
    }

    pub fn get(&self) -> Settings {
        self.value.lock().expect("settings mutex poisoned").clone()
    }

    fn persist(&self, settings: &Settings) -> Result<(), String> {
        let serde_json::Value::Object(values) =
            serde_json::to_value(settings).map_err(|e| e.to_string())?
        else {
            unreachable!()
        };
        for (key, value) in values {
            self.store.set(key, value);
        }
        self.store.save().map_err(|e| e.to_string())
    }

    pub fn update(&self, app: &tauri::AppHandle, update: Update) -> Result<Settings, String> {
        let mut current = self.value.lock().map_err(|e| e.to_string())?;
        let next = current.updated(update)?;
        apply_native(app, &current, &next)?;
        if let Err(error) = self.persist(&next) {
            let native_rollback = apply_native(app, &next, &current);
            let store_rollback = self.persist(&current);
            return Err(format!("Could not save settings: {error}; restore native state: {native_rollback:?}; restore store: {store_rollback:?}"));
        }
        *current = next.clone();
        drop(current);
        app.state::<crate::diagnostics::Diagnostics>()
            .set_enabled(next.debug_notifications);
        if next.debug_notifications {
            crate::notifications::log_runtime(app);
        }
        crate::tray::refresh(app)?;
        app.emit_to("main", "settings-changed", &next)
            .map_err(|e| e.to_string())?;
        Ok(next)
    }
}

fn apply_native(app: &tauri::AppHandle, old: &Settings, new: &Settings) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    if old.theme != new.theme {
        window
            .set_theme(new.native_theme())
            .map_err(|e| e.to_string())?;
    }
    if old.always_on_top != new.always_on_top {
        window
            .set_always_on_top(new.always_on_top)
            .map_err(|e| e.to_string())?;
    }
    if old.zoom_factor != new.zoom_factor {
        window
            .set_zoom(new.zoom_factor)
            .map_err(|e| e.to_string())?;
    }
    if old.launch_at_login != new.launch_at_login {
        if new.launch_at_login {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_round_trip_and_missing_keys_get_defaults() {
        let settings: Settings = serde_json::from_str(r#"{"debugNotifications":true}"#).unwrap();
        assert!(settings.debug_notifications);
        assert!(!settings.quit_on_window_close);
        assert_eq!(settings.zoom_factor, 1.0);
        assert_eq!(
            serde_json::from_slice::<Settings>(&serde_json::to_vec(&settings).unwrap()).unwrap(),
            settings
        );
    }
    #[test]
    fn updates_reject_dropped_settings_wrong_types_and_invalid_zoom() {
        for json in [
            r#"{"setting":"privateMode","value":true}"#,
            r#"{"setting":"theme","value":"vibrant"}"#,
            r#"{"setting":"launchMinimized","value":"false"}"#,
        ] {
            assert!(serde_json::from_str::<Update>(json).is_err());
        }
        for zoom in [0.0, 2.1, f64::NAN, f64::INFINITY] {
            assert!(Settings::default()
                .updated(Update::ZoomFactor(zoom))
                .is_err());
        }
        assert!(serde_json::from_str::<Settings>(r#"{"debugNotifications":"true"}"#).is_err());
        assert!(serde_json::from_str::<Settings>(r#"{"privateMode":true}"#).is_err());
    }
}
