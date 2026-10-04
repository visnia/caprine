//! Main-frame load failures for Messenger show an app-owned retry page and are
//! retried from Rust, so recovery never depends on a throttled page timer.
//! Mid-session connectivity loss without a navigation stays Messenger's own
//! reconnect behavior.
use std::{sync::Mutex, time::Duration};
use tauri::Manager;

const DELAYS: [u64; 5] = [2, 5, 10, 30, 60];

#[derive(Default)]
pub struct Offline(Mutex<State>);

#[derive(Default)]
struct State {
    active: bool,
    attempt: u32,
    generation: u64,
    target: String,
    reason: String,
}

pub fn delay(attempt: u32) -> Duration {
    let index = (attempt.max(1) as usize - 1).min(DELAYS.len() - 1);
    Duration::from_secs(DELAYS[index])
}

fn messenger_url(url: &str) -> Option<url::Url> {
    url::Url::parse(url)
        .ok()
        .filter(crate::policy::is_messenger)
}

/// A main-frame Messenger navigation failed with a network error.
pub fn failed(app: &tauri::AppHandle, url: &str, reason: &str) {
    let Some(target) = messenger_url(url) else {
        return;
    };
    let (generation, attempt) = {
        let mut state = app
            .state::<Offline>()
            .inner()
            .0
            .lock()
            .expect("offline state");
        state.active = true;
        state.attempt = state.attempt.saturating_add(1);
        state.generation += 1;
        state.target = target.to_string();
        state.reason = reason.chars().take(200).collect();
        (state.generation, state.attempt)
    };
    crate::notifications::log(
        app,
        serde_json::json!({"source":"offline","decision":"retry_scheduled","reason":reason,"attempt":attempt,"delaySeconds":delay(attempt).as_secs()}),
    );
    if let Some(window) = app.get_webview_window("main") {
        // Replace the engine error page; the page-load hook renders the notice.
        let _ = window.navigate("about:blank".parse().expect("about:blank"));
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay(attempt));
        let target = {
            let state = app
                .state::<Offline>()
                .inner()
                .0
                .lock()
                .expect("offline state");
            if !state.active || state.generation != generation {
                return;
            }
            state.target.clone()
        };
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = window.navigate(target.parse().expect("validated Messenger URL")) {
                eprintln!("Could not retry Messenger: {error}");
            }
        }
    });
}

/// A main-frame navigation committed/completed successfully.
pub fn succeeded(app: &tauri::AppHandle, url: &str) {
    if messenger_url(url).is_none() {
        return;
    }
    let mut state = app
        .state::<Offline>()
        .inner()
        .0
        .lock()
        .expect("offline state");
    if state.active {
        let attempts = state.attempt;
        state.active = false;
        state.attempt = 0;
        state.generation += 1;
        drop(state);
        crate::notifications::log(
            app,
            serde_json::json!({"source":"offline","decision":"recovered","reason":"messenger_loaded","attempt":attempts}),
        );
    }
}

/// Render the retry notice into the about:blank placeholder.
pub fn page_loaded(window: &tauri::WebviewWindow, url: &url::Url) {
    if window.label() != "main" || url.as_str() != "about:blank" {
        return;
    }
    let state = window.state::<Offline>();
    let state = state.0.lock().expect("offline state");
    if !state.active {
        return;
    }
    let script = include_str!("offline.js")
        .replace("__TARGET__", &serde_json::to_string(&state.target).unwrap())
        .replace("__REASON__", &serde_json::to_string(&state.reason).unwrap())
        .replace("__ATTEMPT__", &state.attempt.to_string())
        .replace("__DELAY__", &delay(state.attempt).as_secs().to_string());
    drop(state);
    if let Err(error) = window.eval(script) {
        eprintln!("Could not render offline notice: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_delay_backs_off_and_caps() {
        assert_eq!(delay(0), Duration::from_secs(2));
        assert_eq!(delay(1), Duration::from_secs(2));
        assert_eq!(delay(3), Duration::from_secs(10));
        assert_eq!(delay(5), Duration::from_secs(60));
        assert_eq!(delay(u32::MAX), Duration::from_secs(60));
    }
    #[test]
    fn only_messenger_failures_are_retried() {
        assert!(messenger_url("https://www.messenger.com/t/1/").is_some());
        assert!(messenger_url("https://www.facebook.com/login").is_none());
        assert!(messenger_url("about:blank").is_none());
    }
}
