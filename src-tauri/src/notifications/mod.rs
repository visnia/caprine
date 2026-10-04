mod native;
mod policy;

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

pub use native::{install, log_runtime};
pub use policy::thread_url;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Collected {
    pub id: String,
    pub thread_id: Option<String>,
    pub thread_url: Option<String>,
    pub source: Source,
    pub title: String,
    pub body: String,
    pub icon_data_url: Option<String>,
    pub timestamp: u64,
    pub tag: String,
    pub data: String,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Notification,
    ShowNotification,
    Sidebar,
}

impl Collected {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.len() > 100
            || self.title.len() > 1024
            || self.body.len() > 8192
            || self.tag.len() > 2048
            || self.data.len() > 8192
            || self
                .icon_data_url
                .as_ref()
                .is_some_and(|s| s.len() > 100_000)
        {
            return Err("Notification metadata exceeds supported limits".into());
        }
        match (&self.thread_id, &self.thread_url) {
            (None, None) => Ok(()),
            (Some(id), Some(url))
                if id.len() <= 200 && thread_url(url).is_some_and(|(actual, _)| actual == *id) =>
            {
                Ok(())
            }
            _ => Err("Invalid Messenger thread identity".into()),
        }
    }
}

#[derive(Clone)]
pub struct NativeEvent {
    pub id: u64,
    pub title: String,
    pub body: String,
    pub tag: String,
    pub source: &'static str,
}
pub enum Event {
    Page(Collected),
    Native(NativeEvent),
    Click(u64),
    Close(u64),
    Runtime(serde_json::Value),
    /// App-owned notices (downloads, updates). They bypass message policy
    /// and arbitration because no Messenger event owns them.
    System {
        title: String,
        body: String,
        action: Action,
    },
}
pub struct Broker {
    sender: mpsc::Sender<Event>,
    next: AtomicU64,
}
impl Broker {
    pub fn start(app: tauri::AppHandle) -> Self {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("caprine-notifications".into())
            .spawn(move || run(app, receiver))
            .expect("notification worker");
        Self {
            sender,
            next: AtomicU64::new(1),
        }
    }
    pub fn id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }
    pub fn send(&self, event: Event) -> Result<(), String> {
        self.sender.send(event).map_err(|e| e.to_string())
    }
}

pub fn send(app: &tauri::AppHandle, event: Event) {
    if let Err(error) = app.state::<Broker>().send(event) {
        eprintln!("Notification routing failed: {error}");
    }
}
pub fn log(app: &tauri::AppHandle, value: serde_json::Value) {
    let mut value = value;
    value["timestamp"] = serde_json::json!(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());
    app.state::<crate::diagnostics::Diagnostics>()
        .notification(value);
}

struct Pending {
    due: Instant,
    item: PendingEvent,
}
enum PendingEvent {
    Native(NativeEvent),
    Fallback(Collected),
}
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// Restore the window and open a validated thread URL when known.
    Message(Option<String>),
    RevealFile(std::path::PathBuf),
    RestoreWindow,
    InstallUpdate,
}
#[derive(Clone)]
pub struct Delivery {
    pub id: u64,
    pub title: String,
    pub body: String,
    pub action: Action,
    pub icon: Option<std::path::PathBuf>,
}

fn run(app: tauri::AppHandle, receiver: mpsc::Receiver<Event>) {
    let mut metadata: VecDeque<(Instant, Collected)> = VecDeque::new();
    let mut pending: Vec<Pending> = Vec::new();
    let mut delivered: HashMap<u64, Delivery> = HashMap::new();
    let mut arbitration = policy::Arbitration::default();
    let start = Instant::now();
    loop {
        let timeout = pending
            .iter()
            .map(|p| p.due.saturating_duration_since(Instant::now()))
            .min()
            .unwrap_or(Duration::from_secs(60));
        match receiver.recv_timeout(timeout) {
            Ok(Event::Page(event)) => {
                log(
                    &app,
                    serde_json::json!({"source":event.source,"threadId":event.thread_id,"eventId":event.id,"eventTimestamp":event.timestamp,"title":event.title,"tag":event.tag,"data":event.data,"decision":"collected","reason":if event.source == Source::Sidebar {"fallback_candidate"} else {"metadata_only"}}),
                );
                if event.source == Source::Sidebar {
                    pending.push(Pending {
                        due: Instant::now() + Duration::from_millis(1200),
                        item: PendingEvent::Fallback(event),
                    });
                } else {
                    metadata.push_back((Instant::now(), event));
                    while metadata.len() > 128 {
                        metadata.pop_front();
                    }
                }
            }
            Ok(Event::Native(event)) => {
                log(
                    &app,
                    serde_json::json!({"source":event.source,"nativeId":event.id,"threadId":null,"title":event.title,"tag":event.tag,"decision":"collected","reason":"native_owner"}),
                );
                pending.push(Pending {
                    due: Instant::now() + Duration::from_millis(250),
                    item: PendingEvent::Native(event),
                });
            }
            Ok(Event::Click(id)) => {
                if let Some(delivery) = delivered.remove(&id) {
                    log(
                        &app,
                        serde_json::json!({"source":"activation","nativeId":id,"decision":"open","action":format!("{:?}", delivery.action)}),
                    );
                    native::activate(&app, &delivery);
                    if let Some(path) = delivery.icon {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
            Ok(Event::Close(id)) => {
                retire(&app, &mut delivered, id);
                pending.retain(|p| !matches!(&p.item, PendingEvent::Native(n) if n.id == id));
            }
            Ok(Event::Runtime(value)) => log(&app, value),
            Ok(Event::System {
                title,
                body,
                action,
            }) => {
                let delivery = Delivery {
                    id: app.state::<Broker>().id(),
                    title,
                    body,
                    action,
                    icon: None,
                };
                native::show(&app, delivery.clone());
                delivered.insert(delivery.id, delivery);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
        }
        let now = Instant::now();
        metadata.retain(|(time, _)| now.duration_since(*time) <= Duration::from_secs(3));
        let mut index = 0;
        while index < pending.len() {
            if pending[index].due > now {
                index += 1;
                continue;
            }
            let entry = pending.remove(index);
            let (id, source, primary, thread, title, body, icon_data) = match entry.item {
                PendingEvent::Native(event) => {
                    let matched = policy::metadata_match(
                        &event.tag,
                        &event.title,
                        metadata
                            .iter()
                            .map(|(_, m)| (&m.tag, &m.title, m.thread_id.as_deref())),
                    );
                    let meta = matched.and_then(|i| metadata.remove(i)).map(|(_, m)| m);
                    let thread = meta
                        .as_ref()
                        .and_then(|m| m.thread_url.as_deref())
                        .and_then(thread_url)
                        .or_else(|| policy::tag_thread(&event.tag));
                    log(
                        &app,
                        serde_json::json!({"source":event.source,"nativeId":event.id,"threadId":thread.as_ref().map(|v| &v.0),"metadataSource":meta.as_ref().map(|m| m.source),"eventId":meta.as_ref().map(|m| &m.id),"decision":"correlation","reason":if meta.is_some() {"matched_tag_title_time"} else {"uncorrelated_native"}}),
                    );
                    (
                        event.id,
                        event.source,
                        true,
                        thread,
                        event.title,
                        event.body,
                        meta.and_then(|m| m.icon_data_url),
                    )
                }
                PendingEvent::Fallback(event) => {
                    let id = app.state::<Broker>().id();
                    (
                        id,
                        "sidebar",
                        false,
                        event.thread_url.as_deref().and_then(thread_url),
                        event.title,
                        event.body,
                        event.icon_data_url,
                    )
                }
            };
            let tick = start.elapsed().as_millis() as u64;
            let settings = app.state::<crate::settings::SettingsState>().get();
            let window = app.get_webview_window("main");
            let focused = window
                .as_ref()
                .is_some_and(|w| w.is_focused().unwrap_or(false));
            let active = window
                .as_ref()
                .and_then(|w| w.url().ok())
                .and_then(|u| thread_url(u.as_str()))
                .map(|v| v.0);
            let suppressed = policy::suppression(
                settings.mute_notifications,
                focused,
                active.as_deref(),
                thread.as_ref().map(|v| v.0.as_str()),
            );
            // Suppressed fallback candidates did not own a displayed event and
            // must not consume a later real primary after focus/mute changes.
            let dedupe = if primary || suppressed.is_none() {
                arbitration.decide(thread.as_ref().map(|v| v.0.as_str()), primary, tick)
            } else {
                Ok(())
            };
            let reason = dedupe.err().or(suppressed);
            log(
                &app,
                serde_json::json!({"source":source,"nativeId":id,"threadId":thread.as_ref().map(|v| &v.0),"activeThreadId":active,"focused":focused,"decision":if reason.is_some() {"suppress"} else {"show"},"reason":reason.unwrap_or("eligible")}),
            );
            if reason.is_some() {
                native::close(&app, id);
                continue;
            }
            let icon = icon_file(&app, id, icon_data.as_deref());
            let delivery = Delivery {
                id,
                title,
                body: if settings.notification_preview {
                    body
                } else {
                    "You have a new message".into()
                },
                action: Action::Message(thread.map(|v| v.1)),
                icon,
            };
            native::show(&app, delivery.clone());
            if settings.flash_taskbar && !focused {
                if let Some(window) = window {
                    #[cfg(target_os = "windows")]
                    if let Err(error) =
                        window.request_user_attention(Some(tauri::UserAttentionType::Informational))
                    {
                        log(
                            &app,
                            serde_json::json!({"source":"taskbar","decision":"error","reason":error.to_string()}),
                        );
                    }
                    #[cfg(not(target_os = "windows"))]
                    let _ = window;
                }
            }
            delivered.insert(id, delivery);
            if delivered.len() > 256 {
                if let Some(oldest) = delivered.keys().min().copied() {
                    retire(&app, &mut delivered, oldest);
                }
            }
        }
    }
}

fn retire(app: &tauri::AppHandle, delivered: &mut HashMap<u64, Delivery>, id: u64) {
    native::close(app, id);
    if let Some(delivery) = delivered.remove(&id) {
        if let Some(path) = delivery.icon {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn icon_file(app: &tauri::AppHandle, id: u64, data: Option<&str>) -> Option<std::path::PathBuf> {
    use base64::Engine;
    let data = data?.strip_prefix("data:image/png;base64,")?;
    if data.len() > 100_000 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    let mut reader = png::Decoder::new(std::io::Cursor::new(&bytes))
        .read_info()
        .ok()?;
    if reader.info().width > 128 || reader.info().height > 128 {
        return None;
    }
    let mut decoded = vec![0; reader.output_buffer_size()?];
    reader.next_frame(&mut decoded).ok()?;
    let directory = app.path().app_cache_dir().ok()?.join("notification-icons");
    std::fs::create_dir_all(&directory).ok()?;
    let path = directory.join(format!("{}-{id}.png", std::process::id()));
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}
