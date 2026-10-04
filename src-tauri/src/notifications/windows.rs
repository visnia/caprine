use crate::notifications::{self as broker, Broker, Delivery, Event, NativeEvent};
use std::{cell::RefCell, collections::HashMap};
use tauri::Manager;
use webview2_com::{
    take_pwstr, Microsoft::Web::WebView2::Win32::*, NotificationCloseRequestedEventHandler,
    NotificationReceivedEventHandler, SetPermissionStateCompletedHandler,
};
use windows::{
    core::{Interface, HSTRING, PWSTR},
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};

struct EngineNotification {
    notification: ICoreWebView2Notification,
    close_token: i64,
}
thread_local! {
    // WebView2 COM objects never cross the UI thread boundary.
    static ENGINE: RefCell<HashMap<u64, EngineNotification>> = RefCell::new(HashMap::new());
    static TOASTS: RefCell<HashMap<u64, ToastNotification>> = RefCell::new(HashMap::new());
    static APP_ID: RefCell<String> = const { RefCell::new(String::new()) };
}
fn read_string(
    read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
) -> windows::core::Result<String> {
    let mut value = PWSTR::null();
    read(&mut value)?;
    Ok(take_pwstr(value))
}

pub fn install(
    app: &tauri::AppHandle,
    webview: tauri::webview::PlatformWebview,
) -> Result<(), String> {
    APP_ID.with(|id| *id.borrow_mut() = app.config().identifier.clone());
    #[cfg(debug_assertions)]
    debug_shortcut(app).map_err(|e| format!("Debug notification shortcut: {e}"))?;
    let controller = webview.controller();
    let core = unsafe { controller.CoreWebView2() }.map_err(|e| e.to_string())?;
    let core24 = core.cast::<ICoreWebView2_24>().map_err(|e| {
        format!("ICoreWebView2_24 unavailable (runtime 128.0.2739.15+ required): {e}")
    })?;
    // The permission handler only sees new requests. A denial stored by an
    // earlier build makes Messenger read `denied` and never ask again, so set
    // the profile state before Messenger loads (this also makes it `granted`
    // from the first page load, as in Electron).
    let state_app = app.clone();
    let granted = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
        if let Err(error) = result {
            broker::send(
                &state_app,
                Event::Runtime(
                    serde_json::json!({"source":"engine","decision":"error","reason":format!("notification_permission: {error}")}),
                ),
            );
        }
        Ok(())
    }));
    unsafe {
        core24
            .Profile()
            .and_then(|profile| profile.cast::<ICoreWebView2Profile4>())
            .and_then(|profile| {
                profile.SetPermissionState(
                    COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
                    &HSTRING::from(crate::policy::MESSENGER),
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    &granted,
                )
            })
    }
    .map_err(|e| format!("Notification permission: {e}"))?;
    let handle = app.clone();
    let handler = NotificationReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        unsafe {
            let origin = read_string(|out| args.SenderOrigin(out))?;
            if origin.trim_end_matches('/') != "https://www.messenger.com" {
                return Ok(());
            }
            args.SetHandled(true)?;
            let notification = args.Notification()?;
            let id = handle.state::<Broker>().id();
            let title = read_string(|out| notification.Title(out))?;
            let body = read_string(|out| notification.Body(out))?;
            let tag = read_string(|out| notification.Tag(out))?;
            let closed_app = handle.clone();
            let close_handler =
                NotificationCloseRequestedEventHandler::create(Box::new(move |_, _| {
                    broker::send(&closed_app, Event::Close(id));
                    Ok(())
                }));
            let mut close_token = 0;
            notification.add_CloseRequested(&close_handler, &mut close_token)?;
            ENGINE.with(|items| {
                items.borrow_mut().insert(
                    id,
                    EngineNotification {
                        notification,
                        close_token,
                    },
                )
            });
            broker::send(
                &handle,
                Event::Native(NativeEvent {
                    id,
                    title,
                    body,
                    tag,
                    source: "webview2",
                }),
            );
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe { core24.add_NotificationReceived(&handler, &mut token) }.map_err(|e| e.to_string())?;
    // The core owns the registered callback until the webview is destroyed.
    log_runtime(app, webview);
    Ok(())
}

pub fn log_runtime(app: &tauri::AppHandle, webview: tauri::webview::PlatformWebview) {
    let mut visible = windows::core::BOOL(0);
    let visibility = unsafe { webview.controller().IsVisible(&mut visible) };
    let version = unsafe { read_string(|out| webview.environment().BrowserVersionString(out)) };
    broker::send(
        app,
        Event::Runtime(
            serde_json::json!({"source":"webview2State","decision":"sample","controllerVisible":visibility.ok().map(|_| visible.as_bool()),"runtimeVersion":version.ok(),"reason":"visibility_and_runtime","persistentNotificationCoverage":false}),
        ),
    );
}
pub fn show(app: &tauri::AppHandle, delivery: Delivery) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let id = delivery.id;
        let click_app = handle.clone();
        let close_app = handle.clone();
        let mut toast = tauri_winrt_notification::Toast::new(&handle.config().identifier)
            .title(&delivery.title).text1(&delivery.body)
            .on_activated(move |_| { broker::send(&click_app, Event::Click(id)); Ok(()) })
            .on_dismissed(move |reason| {
                // Banner timeout still leaves an actionable Action Center item.
                if reason != Some(tauri_winrt_notification::ToastDismissalReason::TimedOut) { broker::send(&close_app, Event::Close(id)); }
                Ok(())
            });
        // Messenger already plays its own tone for every message; a toast sound
        // on top would double it. App notices (downloads, updates) have no tone.
        if matches!(delivery.action, broker::Action::Message(_)) { toast = toast.sound(None); }
        if let Some(icon) = &delivery.icon { toast = toast.icon(icon, tauri_winrt_notification::IconCrop::Circular, ""); }
        match toast.show_with_handle() {
            Ok(toast) => {
                let failed_app = handle.clone();
                let _ = toast.Failed(&windows::Foundation::TypedEventHandler::<ToastNotification, windows::UI::Notifications::ToastFailedEventArgs>::new(move |_, args| {
                    let code = args.as_ref().and_then(|a| a.ErrorCode().ok());
                    broker::send(&failed_app, Event::Runtime(serde_json::json!({"source":"winrt","nativeId":id,"decision":"error","reason":format!("toast_failed: {code:?}")})));
                    broker::send(&failed_app, Event::Close(id)); Ok(())
                }));
                TOASTS.with(|items| items.borrow_mut().insert(id, toast));
                ENGINE.with(|items| { if let Some(item) = items.borrow().get(&id) { let _ = unsafe { item.notification.ReportShown() }; } });
                broker::send(&handle, Event::Runtime(serde_json::json!({"source":"winrt","nativeId":id,"decision":"submitted","reason":"toast_api_accepted"})));
            }
            Err(error) => {
                broker::send(&handle, Event::Runtime(serde_json::json!({"source":"winrt","nativeId":id,"decision":"error","reason":error.to_string()})));
                broker::send(&handle, Event::Close(id));
            }
        }
    });
}
pub fn clicked(id: u64) {
    ENGINE.with(|items| {
        if let Some(item) = items.borrow().get(&id) {
            let _ = unsafe { item.notification.ReportClicked() };
        }
    });
}
pub fn close(app: &tauri::AppHandle, id: u64) {
    let _ = app.run_on_main_thread(move || close_on_main(id));
}
pub fn close_on_main(id: u64) {
    if let Some(toast) = TOASTS.with(|items| items.borrow_mut().remove(&id)) {
        APP_ID.with(|id| {
            if let Ok(notifier) = ToastNotificationManager::CreateToastNotifierWithId(
                &HSTRING::from(id.borrow().as_str()),
            ) {
                let _ = notifier.Hide(&toast);
            }
        });
    }
    if let Some(item) = ENGINE.with(|items| items.borrow_mut().remove(&id)) {
        unsafe {
            let _ = item.notification.remove_CloseRequested(item.close_token);
            let _ = item.notification.ReportClosed();
        }
    }
}

#[cfg(debug_assertions)]
fn debug_shortcut(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use windows::{
        core::GUID,
        Win32::{
            Foundation::PROPERTYKEY,
            System::Com::{
                CoCreateInstance, IPersistFile, StructuredStorage::PROPVARIANT,
                CLSCTX_INPROC_SERVER,
            },
            UI::Shell::{
                FOLDERID_Programs, IShellLinkW, PropertiesSystem::IPropertyStore,
                SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT,
            },
        },
    };
    unsafe {
        let programs = take_pwstr(SHGetKnownFolderPath(
            &FOLDERID_Programs,
            KF_FLAG_DEFAULT,
            None,
        )?);
        let directory = std::path::PathBuf::from(programs).join("Visnia");
        std::fs::create_dir_all(&directory)?;
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(std::env::current_exe()?.as_os_str()))?;
        link.SetDescription(&HSTRING::from("Caprine (Visnia) development build"))?;
        let properties: IPropertyStore = link.cast()?;
        // PKEY_AppUserModel_ID, matching the NSIS SetLnkAppUserModelId macro.
        let key = PROPERTYKEY {
            fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
            pid: 5,
        };
        properties.SetValue(&key, &PROPVARIANT::from(app.config().identifier.as_str()))?;
        properties.Commit()?;
        let file: IPersistFile = link.cast()?;
        file.Save(
            &HSTRING::from(directory.join("Caprine (Visnia) Debug.lnk").as_os_str()),
            true,
        )?;
    }
    Ok(())
}
