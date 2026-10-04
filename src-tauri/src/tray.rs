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
        .icon(tray_icon(false)?)
        .tooltip("caprine")
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
    let tray = builder.build(app)?;
    let settings = app.state::<crate::settings::SettingsState>().get();
    tray.set_visible(settings.show_tray_icon)?;
    Ok(())
}

pub fn set_visible(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    app.tray_by_id("main-tray")
        .ok_or("Tray is unavailable")?
        .set_visible(visible)
        .map_err(|e| e.to_string())
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
    // Without a tray icon there is nothing to restore a parked window from,
    // so Launch minimized keeps it on the taskbar instead.
    if !app
        .state::<crate::settings::SettingsState>()
        .get()
        .show_tray_icon
    {
        return window.minimize().map_err(|e| e.to_string());
    }
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
    tray.set_icon(Some(tray_icon(lit).map_err(|e| e.to_string())?))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        tray.set_tooltip(Some(if count == 0 {
            "caprine — no unread chats".into()
        } else {
            format!("caprine — {count} unread chats")
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

fn tray_icon(lit: bool) -> tauri::Result<Image<'static>> {
    let image = Image::from_bytes(if lit {
        include_bytes!("../icons/tray-unread.png").as_slice()
    } else {
        include_bytes!("../icons/tray-read.png").as_slice()
    })?;
    // The shell shrinks oversized tray icons with a crude filter that leaves
    // jagged edges, so hand it one at exactly the small-icon size.
    #[cfg(target_os = "windows")]
    let image = {
        use windows_sys::Win32::UI::{
            HiDpi::{GetDpiForSystem, GetSystemMetricsForDpi},
            WindowsAndMessaging::SM_CXSMICON,
        };
        let size = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, GetDpiForSystem()) };
        downscale(&image, size.max(1) as u32)
    };
    Ok(image)
}

/// Box-filters a square image down to `size`, averaging colour weighted by
/// alpha so transparent pixels do not darken the edges.
#[cfg(any(target_os = "windows", test))]
fn downscale(image: &Image<'_>, size: u32) -> Image<'static> {
    let (width, src) = (image.width(), image.rgba());
    let scale = width as f32 / size as f32;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for oy in 0..size {
        let (y0, y1) = (oy as f32 * scale, (oy + 1) as f32 * scale);
        for ox in 0..size {
            let (x0, x1) = (ox as f32 * scale, (ox + 1) as f32 * scale);
            let mut sum = [0f32; 4];
            for y in y0 as u32..(y1.ceil() as u32).min(width) {
                let wy = y1.min(y as f32 + 1.0) - y0.max(y as f32);
                for x in x0 as u32..(x1.ceil() as u32).min(width) {
                    let weight = wy * (x1.min(x as f32 + 1.0) - x0.max(x as f32));
                    let p = ((y * width + x) * 4) as usize;
                    let alpha = src[p + 3] as f32 * weight;
                    for c in 0..3 {
                        sum[c] += src[p + c] as f32 * alpha;
                    }
                    sum[3] += alpha;
                }
            }
            for c in 0..3 {
                rgba.push(if sum[3] > 0.0 {
                    (sum[c] / sum[3]).round() as u8
                } else {
                    0
                });
            }
            rgba.push((sum[3] / (scale * scale)).round().min(255.0) as u8);
        }
    }
    Image::new_owned(rgba, size, size)
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

    #[test]
    fn downscale_averages_colour_and_coverage() {
        // Left half opaque red, right half transparent black.
        let mut rgba = Vec::new();
        for _ in 0..96 {
            for x in 0..96 {
                rgba.extend_from_slice(if x < 48 { &[255, 0, 0, 255] } else { &[0; 4] });
            }
        }
        let small = downscale(&Image::new_owned(rgba, 96, 96), 15);
        assert_eq!((small.width(), small.height()), (15, 15));
        let px = |x: usize| &small.rgba()[x * 4..x * 4 + 4];
        assert_eq!(px(0), [255, 0, 0, 255]);
        assert_eq!(px(14), [0, 0, 0, 0]);
        // The column straddling the edge is partially covered, not darkened.
        let edge = px(7);
        assert_eq!(&edge[..3], [255, 0, 0]);
        assert!(edge[3] > 0 && edge[3] < 255);
        assert_eq!(
            downscale(&tray_icon(true).unwrap(), 16).rgba().len(),
            16 * 16 * 4
        );
    }
}
