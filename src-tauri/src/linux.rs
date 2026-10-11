//! Linux window frame: the Wayland app ID, a desktop entry the compositor can
//! take the window icon from, and KWin's per-window decoration palette.

use std::{cell::RefCell, fs, path::Path, path::PathBuf};
use gtk::prelude::*;
use tauri::Manager;
use wayland_client::{
    backend::{Backend, ObjectId},
    globals::{registry_queue_init, GlobalListContents},
    protocol::{wl_registry::WlRegistry, wl_surface::WlSurface},
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
};
use wayland_protocols_plasma::server_decoration_palette::client::{
    org_kde_kwin_server_decoration_palette::OrgKdeKwinServerDecorationPalette as Palette,
    org_kde_kwin_server_decoration_palette_manager::OrgKdeKwinServerDecorationPaletteManager as PaletteManager,
};

use crate::settings::Theme;

const ICON: &[u8] = include_bytes!("../icons/256x256.png");
const GENERATED: &str = "X-Caprine-Generated=true";

/// Wayland compositors find the window icon through the desktop entry named
/// after the app ID, and AppImage integrators rename the bundled entry, so
/// the app ID becomes the identifier. Must run before GTK initializes.
pub fn set_app_id(identifier: &str) {
    gtk::glib::set_prgname(Some(identifier));
}

/// Writes a hidden desktop entry named after the app ID unless a package
/// already installed one. Without it KWin shows the generic Wayland icon.
pub fn install_desktop_entry(app: &tauri::AppHandle) -> Result<(), String> {
    let identifier = &app.config().identifier;
    let file = format!("{identifier}.desktop");
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".local/share")))
        .ok_or("No XDG data directory")?;
    let data_dirs = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    if data_dirs.split(':').any(|dir| Path::new(dir).join("applications").join(&file).exists()) {
        return Ok(());
    }
    let entry_path = data_home.join("applications").join(&file);
    if let Ok(existing) = fs::read_to_string(&entry_path) {
        if !existing.lines().any(|line| line == GENERATED) { return Ok(()); }
    }
    let icon = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("icon.png");
    if fs::read(&icon).ok().as_deref() != Some(ICON) {
        fs::create_dir_all(icon.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&icon, ICON).map_err(|e| e.to_string())?;
    }
    // An AppImage runs from a temporary mount; launch the image itself.
    let exe = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .map_or_else(std::env::current_exe, Ok)
        .map_err(|e| e.to_string())?;
    let entry = desktop_entry(identifier, &exe, &icon);
    if fs::read_to_string(&entry_path).ok().as_deref() != Some(entry.as_str()) {
        fs::create_dir_all(entry_path.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&entry_path, entry).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn desktop_entry(identifier: &str, exe: &Path, icon: &Path) -> String {
    // Exec quoting escapes ", `, $ and \ inside double quotes, and the
    // key file format escapes backslashes once more.
    let mut exec = String::from("\"");
    for c in exe.to_string_lossy().chars() {
        match c {
            '\\' => exec.push_str("\\\\\\\\"),
            '"' | '`' | '$' => { exec.push_str("\\\\"); exec.push(c); }
            _ => exec.push(c),
        }
    }
    exec.push('"');
    // The menu entry comes from the package or AppImage integration.
    format!(
        "[Desktop Entry]\nType=Application\nName=Caprine\nComment=Minimal Messenger wrapper\nExec={exec}\nIcon={}\nStartupWMClass={identifier}\nNoDisplay=true\n{GENERATED}\n",
        icon.display()
    )
}

/// Messenger's frame behind the panels (--web-wash) and its primary and
/// secondary text, as KDE color scheme RGB triples.
fn palette_colors(theme: Theme, dark: bool) -> (&'static str, &'static str, &'static str, &'static str) {
    match theme {
        Theme::Oled => ("oled", "0,0,0", "228,230,235", "176,179,184"),
        Theme::Dark => ("dark", "26,26,26", "228,230,235", "176,179,184"),
        Theme::System if dark => ("dark", "26,26,26", "228,230,235", "176,179,184"),
        Theme::System | Theme::Light => ("light", "255,255,255", "5,5,5", "101,103,107"),
    }
}

fn color_scheme(name: &str, background: &str, foreground: &str, inactive: &str) -> String {
    // KDecoration reads Colors:Header when present and [WM] otherwise.
    let header = format!("BackgroundNormal={background}\nBackgroundAlternate={background}\nForegroundNormal={foreground}\nForegroundInactive={inactive}\n");
    format!(
        "[General]\nName=Caprine {name}\n\n[Colors:Header]\n{header}\n[Colors:Header][Inactive]\nBackgroundNormal={background}\nBackgroundAlternate={background}\nForegroundNormal={inactive}\nForegroundInactive={inactive}\n\n[Colors:Window]\n{header}\n[WM]\nactiveBackground={background}\nactiveBlend={background}\nactiveForeground={foreground}\ninactiveBackground={background}\ninactiveBlend={background}\ninactiveForeground={inactive}\n"
    )
}

struct Frame {
    connection: Connection,
    queue: EventQueue<Frame>,
    manager: PaletteManager,
    /// The palette and the wl_surface it decorates; GTK replaces the
    /// surface whenever the window is hidden to the tray and shown again.
    palette: Option<(Palette, usize)>,
    directory: PathBuf,
    wanted: String,
}

impl Dispatch<WlRegistry, GlobalListContents> for Frame {
    fn event(_: &mut Self, _: &WlRegistry, _: <WlRegistry as Proxy>::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}
wayland_client::delegate_noop!(Frame: ignore PaletteManager);
wayland_client::delegate_noop!(Frame: ignore Palette);

thread_local! {
    static FRAME: RefCell<Option<Frame>> = const { RefCell::new(None) };
}

/// Binds KWin's decoration palette on GDK's Wayland connection and repaints
/// the title bar each time the window maps. Other compositors and X11 keep
/// their own decoration. Runs on the GTK thread.
pub fn install_frame(window: &tauri::WebviewWindow) -> Result<(), String> {
    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
    let display = gtk_window.display();
    if display.type_().name() != "GdkWaylandDisplay" { return Ok(()); }
    let directory = window.app_handle().path().app_local_data_dir().map_err(|e| e.to_string())?;
    // SAFETY: GDK owns the wl_display for the life of the process.
    let connection = unsafe {
        let display = gdk_wayland_sys::gdk_wayland_display_get_wl_display(display.as_ptr() as *mut _);
        Connection::from_backend(Backend::from_foreign_display(display as *mut _))
    };
    let (globals, queue) = registry_queue_init::<Frame>(&connection).map_err(|e| e.to_string())?;
    let Ok(manager) = globals.bind::<PaletteManager, _, _>(&queue.handle(), 1..=1, ()) else {
        return Ok(());
    };
    FRAME.with_borrow_mut(|frame| {
        *frame = Some(Frame { connection, queue, manager, palette: None, directory, wanted: String::new() });
    });
    let mapped = window.clone();
    gtk_window.connect_map(move |_| apply(&mapped));
    Ok(())
}

/// Chooses the palette for the theme and applies it on the GTK thread.
pub fn set_theme(window: &tauri::WebviewWindow, theme: Theme) {
    let dark = window.theme().is_ok_and(|t| t == tauri::Theme::Dark);
    let (name, background, foreground, inactive) = palette_colors(theme, dark);
    let applied = window.clone();
    let scheme = color_scheme(name, background, foreground, inactive);
    let file = format!("decoration-{name}.colors");
    let _ = window.run_on_main_thread(move || {
        let ready = FRAME.with_borrow_mut(|frame| {
            let Some(frame) = frame else { return false };
            // KWin caches a scheme by path, so each theme has its own file.
            let path = frame.directory.join(&file);
            if fs::read_to_string(&path).ok().as_deref() != Some(scheme.as_str()) {
                if let Err(error) = fs::create_dir_all(&frame.directory).and_then(|_| fs::write(&path, &scheme)) {
                    eprintln!("Could not write the title bar palette: {error}");
                    return false;
                }
            }
            frame.wanted = path.to_string_lossy().into_owned();
            true
        });
        if ready { apply(&applied); }
    });
}

fn apply(window: &tauri::WebviewWindow) {
    let Ok(gtk_window) = window.gtk_window() else { return };
    let Some(gdk_window) = gtk_window.window() else { return };
    // SAFETY: the window is mapped, so GDK keeps its wl_surface alive.
    let surface = unsafe { gdk_wayland_sys::gdk_wayland_window_get_wl_surface(gdk_window.as_ptr() as *mut _) };
    if surface.is_null() { return; }
    FRAME.with_borrow_mut(|frame| {
        let Some(frame) = frame else { return };
        if frame.wanted.is_empty() { return; }
        let palette = match &frame.palette {
            Some((palette, current)) if *current == surface as usize => palette.clone(),
            _ => {
                if let Some((old, _)) = frame.palette.take() { old.release(); }
                // SAFETY: the pointer is GDK's live wl_surface proxy.
                let Ok(id) = (unsafe { ObjectId::from_ptr(WlSurface::interface(), surface as *mut _) }) else { return };
                let Ok(surface_proxy) = WlSurface::from_id(&frame.connection, id) else { return };
                let palette = frame.manager.create(&surface_proxy, &frame.queue.handle(), ());
                frame.palette = Some((palette.clone(), surface as usize));
                palette
            }
        };
        palette.set_palette(frame.wanted.clone());
        if let Err(error) = frame.connection.flush() {
            eprintln!("Could not send the title bar palette: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_entry_quotes_exec() {
        let entry = desktop_entry("com.visnia.caprine", Path::new("/opt/my $app/caprine"), Path::new("/x/icon.png"));
        assert!(entry.contains("Exec=\"/opt/my \\\\$app/caprine\"\n"));
        assert!(entry.contains("NoDisplay=true\n"));
        assert!(entry.contains(GENERATED));
    }

    #[test]
    fn system_theme_follows_the_native_scheme() {
        assert_eq!(palette_colors(Theme::System, true).0, "dark");
        assert_eq!(palette_colors(Theme::System, false).0, "light");
        assert_eq!(palette_colors(Theme::Oled, false).1, "0,0,0");
    }
}
