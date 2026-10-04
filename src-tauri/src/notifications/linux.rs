use crate::notifications::{self as broker, Broker, Delivery, Event, NativeEvent};
use std::{cell::RefCell, collections::HashMap, sync::Mutex};
use tauri::Manager;
use webkit2gtk::{Notification, NotificationExt, WebViewExt};

thread_local! { static ENGINE: RefCell<HashMap<u64, Notification>> = RefCell::new(HashMap::new()); }
#[derive(Default)]
struct Handles(Mutex<HashMap<u64, tokio::sync::oneshot::Sender<()>>>);

pub fn install(
    app: &tauri::AppHandle,
    webview: tauri::webview::PlatformWebview,
) -> Result<(), String> {
    app.manage(Handles::default());
    let handle = app.clone();
    webview
        .inner()
        .connect_show_notification(move |view, notification| {
            if !view
                .uri()
                .and_then(|uri| url::Url::parse(&uri).ok())
                .is_some_and(|url| crate::policy::is_messenger(&url))
            {
                return false;
            }
            let id = handle.state::<Broker>().id();
            let close_app = handle.clone();
            notification.connect_closed(move |_| broker::send(&close_app, Event::Close(id)));
            ENGINE.with(|items| items.borrow_mut().insert(id, notification.clone()));
            broker::send(
                &handle,
                Event::Native(NativeEvent {
                    id,
                    title: notification.title().unwrap_or_default().to_string(),
                    body: notification.body().unwrap_or_default().to_string(),
                    tag: notification.tag().unwrap_or_default().to_string(),
                    source: "webkitgtk",
                }),
            );
            true // Stop WebKit's default libnotify presenter.
        });
    log_runtime(app, webview);
    Ok(())
}
pub fn log_runtime(app: &tauri::AppHandle, _webview: tauri::webview::PlatformWebview) {
    broker::send(
        app,
        Event::Runtime(
            serde_json::json!({"source":"webkitgtkState","decision":"sample","reason":"show_notification_hook; no supported background throttle override"}),
        ),
    );
}
pub fn show(app: &tauri::AppHandle, delivery: Delivery) {
    let handle = app.clone();
    let id = delivery.id;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.state::<Handles>().0.lock().unwrap().insert(id, sender);
    tauri::async_runtime::spawn(async move {
        let mut notification = notify_rust::Notification::new();
        notification
            .appname("caprine")
            .summary(&delivery.title)
            .body(
                &delivery
                    .body
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;"),
            )
            .action("default", "Open conversation");
        if let Some(icon) = &delivery.icon {
            notification.icon(&icon.to_string_lossy());
        }
        match notification.show_async().await {
            Ok(shown) => {
                broker::send(
                    &handle,
                    Event::Runtime(
                        serde_json::json!({"source":"notify-rust","nativeId":id,"decision":"submitted","reason":"dbus_accepted"}),
                    ),
                );
                let click_app = handle.clone();
                tokio::select! {
                    _ = shown.wait_for_action_async(move |action| {
                        if matches!(action, notify_rust::NotificationResponse::Default) { broker::send(&click_app, Event::Click(id)); }
                        else { broker::send(&click_app, Event::Close(id)); }
                    }) => {},
                    _ = receiver => { shown.close_async().await; },
                }
            }
            Err(error) => {
                broker::send(
                    &handle,
                    Event::Runtime(
                        serde_json::json!({"source":"notify-rust","nativeId":id,"decision":"error","reason":error.to_string()}),
                    ),
                );
                broker::send(&handle, Event::Close(id));
            }
        }
        handle.state::<Handles>().0.lock().unwrap().remove(&id);
    });
}
pub fn clicked(id: u64) {
    ENGINE.with(|items| {
        if let Some(notification) = items.borrow().get(&id) {
            notification.clicked();
        }
    });
}
pub fn close(app: &tauri::AppHandle, id: u64) {
    if let Some(sender) = app.state::<Handles>().0.lock().unwrap().remove(&id) {
        let _ = sender.send(());
    }
    let _ = app.run_on_main_thread(move || close_on_main(id));
}
pub fn close_on_main(id: u64) {
    if let Some(notification) = ENGINE.with(|items| items.borrow_mut().remove(&id)) {
        notification.close();
    }
}
