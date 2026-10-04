//! Messenger call popups. Messenger opens `about:blank` (then navigates it) or a
//! Messenger URL with `window.open`; the new window keeps the native opener
//! relationship and shares the engine profile, but gets no injected script and
//! no Caprine IPC capability.
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc,
};
use tauri::{
    webview::{NewWindowFeatures, NewWindowResponse, PermissionKind, PermissionResponse},
    Manager, Webview, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

static NEXT: AtomicU32 = AtomicU32::new(1);

fn is_blank(url: &Url) -> bool {
    url.scheme() == "about" && url.path() == "blank"
}

/// Media for Messenger pages only. Notifications only for the main window.
pub fn permission(webview: &Webview, kind: PermissionKind) -> PermissionResponse {
    let messenger = webview
        .url()
        .is_ok_and(|url| crate::policy::is_messenger(&url));
    match kind {
        PermissionKind::Notifications if webview.label() == "main" && messenger => {
            PermissionResponse::Allow
        }
        PermissionKind::Notifications => PermissionResponse::Deny,
        PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::DisplayCapture => {
            if messenger {
                PermissionResponse::Allow
            } else {
                PermissionResponse::Deny
            }
        }
        _ => PermissionResponse::Default,
    }
}

pub fn new_window(
    app: &tauri::AppHandle,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    if !crate::policy::is_messenger(&url) && !is_blank(&url) {
        if let Err(error) = crate::open_link(app, url.as_str()) {
            eprintln!("Could not open external popup: {error}");
        }
        return NewWindowResponse::Deny;
    }
    let label = format!("call-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let loaded_messenger = Arc::new(AtomicBool::new(crate::policy::is_messenger(&url)));
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let navigation_label = label.clone();
    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External("about:blank".parse().expect("about:blank")),
    )
    .title("caprine call")
    .inner_size(960.0, 720.0)
    .window_features(features)
    .on_document_title_changed(|window, title| {
        let _ = window.set_title(if title.trim().is_empty() {
            "caprine call"
        } else {
            &title
        });
    })
    .on_permission_request(|webview, kind| permission(&webview, kind))
    .on_navigation(move |url| {
        if crate::policy::is_messenger(url) {
            loaded_messenger.store(true, Ordering::Relaxed);
            return true;
        }
        if is_blank(url) {
            return true;
        }
        if let Err(error) = crate::open_link(&navigation_app, url.as_str()) {
            eprintln!("Could not open external call navigation: {error}");
        }
        // A blank popup that turns out to be an external link is not a call.
        if !loaded_messenger.load(Ordering::Relaxed) {
            let app = navigation_app.clone();
            let label = navigation_label.clone();
            // Queue the close from another thread; this runs inside the
            // engine's navigation callback.
            std::thread::spawn(move || {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.close();
                }
            });
        }
        false
    })
    .on_new_window(move |url, features| new_window(&popup_app, url, features));
    match builder.build() {
        Ok(window) => {
            crate::notifications::log(
                app,
                serde_json::json!({"source":"call","decision":"window_created","reason":if is_blank(&url) {"about_blank_popup"} else {"messenger_popup"}}),
            );
            NewWindowResponse::Create { window }
        }
        Err(error) => {
            eprintln!("Could not create call window: {error}");
            NewWindowResponse::Deny
        }
    }
}
