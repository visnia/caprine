use std::{
    sync::atomic::{AtomicBool, AtomicU32, Ordering},
    time::Duration,
};
#[cfg(target_os = "windows")]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

pub const WINDOW_STATE: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

#[derive(Default)]
pub struct TrayState {
    pub unread: AtomicU32,
    parked: AtomicBool,
    /// The off phase of the unread blink: grey tray icon, no taskbar badge.
    dim: AtomicBool,
}

const BLINK: Duration = Duration::from_millis(800);

/// Blinks the tray icon (colour/grey) and taskbar badge while chats are unread
/// and the window is not focused; a focused window shows them steadily.
pub fn start_blinking(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("caprine-tray-blink".into())
        .spawn(move || loop {
            std::thread::sleep(BLINK);
            let state = app.state::<TrayState>();
            let blinking = state.unread.load(Ordering::Relaxed) > 0
                && !app
                    .get_webview_window("main")
                    .is_some_and(|w| w.is_focused().unwrap_or(false));
            let dim = blinking && !state.dim.load(Ordering::Relaxed);
            if state.dim.swap(dim, Ordering::Relaxed) != dim {
                if let Err(error) = refresh(&app) {
                    eprintln!("Tray blink failed: {error}");
                }
            }
        })
        .expect("tray blink worker");
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let builder = TrayIconBuilder::with_id("main-tray")
        .icon(Image::from_bytes(include_bytes!("../icons/tray-read.png"))?)
        .tooltip("Caprine (Visnia)")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "show" => restore(app),
                "quit" => {
                    quit_app(app);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                eprintln!("Tray action failed: {error}");
            }
        });
    #[cfg(target_os = "windows")]
    let builder = builder
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let result = if app.state::<TrayState>().parked.load(Ordering::Relaxed)
                    || app
                        .get_webview_window("main")
                        .is_some_and(|w| w.is_minimized().unwrap_or(false))
                {
                    restore(app)
                } else {
                    park(app)
                };
                if let Err(error) = result {
                    eprintln!("Tray toggle failed: {error}");
                }
            }
        });
    builder.build(app)?;
    Ok(())
}

pub fn park(app: &tauri::AppHandle) -> Result<(), String> {
    if app.tray_by_id("main-tray").is_none() {
        return Err("Tray is unavailable".into());
    }
    app.save_window_state(WINDOW_STATE)
        .map_err(|e| e.to_string())?;
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    #[cfg(target_os = "windows")]
    {
        // Wry leaves the controller visible when the HWND is minimized. Never
        // call Webview::hide or TrySuspend for close-to-tray.
        window.minimize().map_err(|e| e.to_string())?;
        window.set_skip_taskbar(true).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    window.hide().map_err(|e| e.to_string())?;
    app.state::<TrayState>()
        .parked
        .store(true, Ordering::Relaxed);
    crate::notifications::log_runtime(app);
    Ok(())
}

pub fn restore(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    #[cfg(target_os = "windows")]
    window.set_skip_taskbar(false).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    app.state::<TrayState>()
        .parked
        .store(false, Ordering::Relaxed);
    crate::notifications::log_runtime(app);
    refresh(app)
}

pub fn quit_app(app: &tauri::AppHandle) {
    if let Err(error) = app.save_window_state(WINDOW_STATE) {
        eprintln!("Could not save window state: {error}");
    }
    app.exit(0);
}

pub fn refresh(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<TrayState>();
    let count = state.unread.load(Ordering::Relaxed);
    let lit = count > 0 && !state.dim.load(Ordering::Relaxed);
    let show_badge = app
        .state::<crate::settings::SettingsState>()
        .get()
        .show_unread_badge;
    let tray = app.tray_by_id("main-tray").ok_or("Tray is unavailable")?;
    let icon = if lit {
        include_bytes!("../icons/tray-unread.png").as_slice()
    } else {
        include_bytes!("../icons/tray-read.png").as_slice()
    };
    tray.set_icon(Some(Image::from_bytes(icon).map_err(|e| e.to_string())?))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        tray.set_tooltip(Some(if count == 0 {
            "Caprine (Visnia) — no unread chats".into()
        } else {
            format!("Caprine (Visnia) — {count} unread chats")
        }))
        .map_err(|e| e.to_string())?;
        if let Some(window) = app.get_webview_window("main") {
            window
                .set_overlay_icon(if show_badge && lit {
                    Some(overlay(count))
                } else {
                    None
                })
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "linux")]
    tray.set_title(Some(if show_badge && count > 0 {
        count.to_string()
    } else {
        String::new()
    }))
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn overlay(count: u32) -> Image<'static> {
    let mut rgba = vec![0; 32 * 32 * 4];
    for y in 0i32..32 {
        for x in 0i32..32 {
            if (x - 16).pow(2) + (y - 16).pow(2) <= 15 * 15 {
                let p = ((y * 32 + x) * 4) as usize;
                rgba[p..p + 4].copy_from_slice(&[228, 30, 63, 255]);
            }
        }
    }
    const GLYPHS: [[u8; 5]; 11] = [
        [7, 5, 5, 5, 7],
        [2, 6, 2, 2, 7],
        [7, 1, 7, 4, 7],
        [7, 1, 7, 1, 7],
        [5, 5, 7, 1, 1],
        [7, 4, 7, 1, 7],
        [7, 4, 7, 5, 7],
        [7, 1, 1, 1, 1],
        [7, 5, 7, 5, 7],
        [7, 5, 7, 1, 7],
        [0, 2, 7, 2, 0],
    ];
    let label = if count > 99 {
        "99+".into()
    } else {
        count.to_string()
    };
    let left = (32 - (label.len() * 8 - 2)) / 2;
    for (i, character) in label.bytes().enumerate() {
        let glyph = GLYPHS[if character == b'+' {
            10
        } else {
            (character - b'0') as usize
        }];
        for (y, bits) in glyph.iter().enumerate() {
            for x in 0..3 {
                if bits & (1 << (2 - x)) != 0 {
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let p = ((11 + y * 2 + dy) * 32 + left + i * 8 + x * 2 + dx) * 4;
                            rgba[p..p + 4].copy_from_slice(&[255; 4]);
                        }
                    }
                }
            }
        }
    }
    Image::new_owned(rgba, 32, 32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlay_is_bounded_and_large_counts_use_99_plus() {
        assert_eq!(overlay(1).rgba().len(), 32 * 32 * 4);
        assert_ne!(overlay(1).rgba(), overlay(2).rgba());
        assert_eq!(overlay(100).rgba(), overlay(u32::MAX).rgba());
        assert_ne!(overlay(99).rgba(), overlay(100).rgba());
    }
}
