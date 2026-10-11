//! Linux window frame: the Wayland app ID, a desktop entry the compositor can
//! take the window icon from, and KWin's per-window decoration palette.

use gtk::prelude::*;
use std::{cell::Cell, cell::OnceCell, cell::RefCell, fs, path::Path, path::PathBuf};
use tauri::Manager;
use wayland_client::{
    backend::{Backend, ObjectId},
    globals::{registry_queue_init, GlobalListContents},
    protocol::{wl_registry::WlRegistry, wl_surface::WlSurface},
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
};
use wayland_protocols_plasma::server_decoration::client::{
    org_kde_kwin_server_decoration::{Mode, OrgKdeKwinServerDecoration as Decoration},
    org_kde_kwin_server_decoration_manager::OrgKdeKwinServerDecorationManager as DecorationManager,
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

/// GStreamer keys its plugin cache to each plugin's path, and the AppImage
/// mounts at a new /tmp/.mount_* path on every launch, so each start rescanned
/// the bundled plugins (~0.7 s) and overwrote the system GStreamer's cache. A
/// fixed symlink to the mount keeps the paths, and so the cache, valid. While
/// another instance still runs (a hand-off or an update restart) its symlink
/// stays and this one takes the next slot. Must run before any thread starts.
pub fn stabilize_gstreamer_cache(identifier: &str) {
    let (Some(appdir), Some(runtime)) = (
        std::env::var_os("APPDIR"),
        std::env::var_os("XDG_RUNTIME_DIR"),
    ) else {
        return;
    };
    let plugins = Path::new(&appdir).join("usr/lib/gstreamer-1.0");
    let Some(cache) = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".cache")))
    else {
        return;
    };
    let cache = cache.join(identifier);
    if !plugins.is_dir() || fs::create_dir_all(&cache).is_err() {
        return;
    }
    for slot in 0..4 {
        let link = Path::new(&runtime).join(format!("{identifier}-gstreamer-{slot}"));
        // A live target is another running instance's mount.
        if fs::read_link(&link).is_ok_and(|target| target != plugins && target.exists()) {
            continue;
        }
        let staging = link.with_extension(std::process::id().to_string());
        let _ = fs::remove_file(&staging);
        if std::os::unix::fs::symlink(&plugins, &staging)
            .and_then(|()| fs::rename(&staging, &link))
            .is_err()
        {
            let _ = fs::remove_file(&staging);
            return;
        }
        std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &link);
        std::env::set_var("GST_PLUGIN_PATH_1_0", &link);
        std::env::set_var(
            "GST_REGISTRY_1_0",
            cache.join(format!("gstreamer-registry-{slot}.bin")),
        );
        return;
    }
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
    let data_dirs =
        std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    if data_dirs
        .split(':')
        .any(|dir| Path::new(dir).join("applications").join(&file).exists())
    {
        return Ok(());
    }
    let entry_path = data_home.join("applications").join(&file);
    if let Ok(existing) = fs::read_to_string(&entry_path) {
        if !existing.lines().any(|line| line == GENERATED) {
            return Ok(());
        }
    }
    let icon = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("icon.png");
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
            '"' | '`' | '$' => {
                exec.push_str("\\\\");
                exec.push(c);
            }
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
fn palette_colors(
    theme: Theme,
    dark: bool,
) -> (&'static str, &'static str, &'static str, &'static str) {
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
    decorations: Option<DecorationManager>,
    /// The palette, a handle on the decoration once it has been rebuilt, and
    /// the wl_surface they belong to; GTK replaces the surface whenever the
    /// window is hidden to the tray and shown again.
    palette: Option<(Palette, Option<Decoration>, WlSurface)>,
    directory: PathBuf,
    wanted: String,
}

impl Dispatch<WlRegistry, GlobalListContents> for Frame {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: <WlRegistry as Proxy>::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
wayland_client::delegate_noop!(Frame: ignore PaletteManager);
wayland_client::delegate_noop!(Frame: ignore Palette);
wayland_client::delegate_noop!(Frame: ignore DecorationManager);
wayland_client::delegate_noop!(Frame: ignore Decoration);

thread_local! {
    static FRAME: RefCell<Option<Frame>> = const { RefCell::new(None) };
    /// Whether Messenger should see a dark preferred color scheme.
    static WEB_DARK: Cell<Option<bool>> = const { Cell::new(None) };
    /// The window and theme last applied, so System can follow the desktop.
    static THEME: RefCell<Option<(tauri::WebviewWindow, Theme)>> = const { RefCell::new(None) };
    /// The session's GTK theme, restored when Light no longer swaps it.
    static SESSION_THEME: OnceCell<Option<String>> = const { OnceCell::new() };
}

/// Binds KWin's decoration palette on GDK's Wayland connection and repaints
/// the title bar each time the window maps. Other compositors and X11 keep
/// their own decoration. Runs on the GTK thread.
pub fn install_frame(window: &tauri::WebviewWindow) -> Result<(), String> {
    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
    let display = gtk_window.display();
    if display.type_().name() != "GdkWaylandDisplay" {
        return Ok(());
    }
    let directory = window
        .app_handle()
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    // SAFETY: GDK owns the wl_display for the life of the process.
    let connection = unsafe {
        let display =
            gdk_wayland_sys::gdk_wayland_display_get_wl_display(display.as_ptr() as *mut _);
        Connection::from_backend(Backend::from_foreign_display(display as *mut _))
    };
    let (globals, queue) = registry_queue_init::<Frame>(&connection).map_err(|e| e.to_string())?;
    let Ok(manager) = globals.bind::<PaletteManager, _, _>(&queue.handle(), 1..=1, ()) else {
        return Ok(());
    };
    let decorations = globals
        .bind::<DecorationManager, _, _>(&queue.handle(), 1..=1, ())
        .ok();
    FRAME.with_borrow_mut(|frame| {
        *frame = Some(Frame {
            connection,
            queue,
            manager,
            decorations,
            palette: None,
            directory,
            wanted: String::new(),
        });
    });
    let mapped = window.clone();
    // A mapped window gets a new decoration, which reads the palette.
    gtk_window.connect_map(move |_| apply(&mapped, false));
    Ok(())
}

/// Chooses the palette for the theme and applies it on the GTK thread.
pub fn set_theme(window: &tauri::WebviewWindow, theme: Theme) {
    let dark = system_is_dark(window);
    let (name, background, foreground, inactive) = palette_colors(theme, dark);
    let applied = window.clone();
    let scheme = color_scheme(name, background, foreground, inactive);
    let file = format!("decoration-{name}.colors");
    let web_dark = name != "light";
    let _ = window.run_on_main_thread(move || {
        THEME.set(Some((applied.clone(), theme)));
        set_web_scheme(web_dark);
        let ready = FRAME.with_borrow_mut(|frame| {
            let Some(frame) = frame else { return None };
            // KWin caches a scheme by path, so each theme has its own file.
            let path = frame.directory.join(&file);
            if fs::read_to_string(&path).ok().as_deref() != Some(scheme.as_str()) {
                if let Err(error) =
                    fs::create_dir_all(&frame.directory).and_then(|_| fs::write(&path, &scheme))
                {
                    eprintln!("Could not write the title bar palette: {error}");
                    return None;
                }
            }
            let wanted = path.to_string_lossy().into_owned();
            let changed = frame.wanted != wanted;
            frame.wanted = wanted;
            Some(changed)
        });
        if let Some(changed) = ready {
            apply(&applied, changed);
        }
    });
}

/// Tao reads the portal's color scheme while no theme is forced.
fn system_is_dark(window: &tauri::WebviewWindow) -> bool {
    window.theme().is_ok_and(|t| t == tauri::Theme::Dark)
}

/// WebKitGTK reports a dark preferred color scheme when GTK prefers a dark
/// theme or the theme name ends in -dark, and tao only sets the former, so
/// Messenger stayed dark under Light with a dark GTK theme. Light swaps in
/// Adwaita instead. Tao also resets the preference on its own theme updates,
/// so it is held here until the next set_theme. When the desktop scheme
/// changes tao rewrites it too, but its ThemeChanged event carries a dummy
/// window ID and never reaches the window, so System reapplies from here.
fn set_web_scheme(dark: bool) {
    let Some(settings) = gtk::Settings::default() else {
        return;
    };
    if WEB_DARK.replace(Some(dark)).is_none() {
        SESSION_THEME.with(|theme| theme.set(settings.gtk_theme_name().map(Into::into)).ok());
        settings.connect_gtk_application_prefer_dark_theme_notify(|settings| {
            let Some((window, theme)) = THEME.with_borrow(Clone::clone) else {
                return;
            };
            if theme == Theme::System && WEB_DARK.get() != Some(system_is_dark(&window)) {
                set_theme(&window, theme);
            } else if let Some(dark) = WEB_DARK.get() {
                if settings.is_gtk_application_prefer_dark_theme() != dark {
                    settings.set_gtk_application_prefer_dark_theme(dark);
                }
            }
        });
    }
    if settings.is_gtk_application_prefer_dark_theme() != dark {
        settings.set_gtk_application_prefer_dark_theme(dark);
    }
    let theme = SESSION_THEME.with(|theme| theme.get().cloned().flatten());
    let theme = match theme {
        Some(name) if !dark && name.to_lowercase().contains("dark") => Some("Adwaita".into()),
        other => other,
    };
    if settings.gtk_theme_name().as_deref() != theme.as_deref() {
        settings.set_gtk_theme_name(theme.as_deref());
    }
}

/// Sends the wanted palette to the window's decoration. Breeze paints the
/// window outline only when the decoration is created or the window changes
/// state, so `rebuild` has KWin drop the decoration and create it again.
fn apply(window: &tauri::WebviewWindow, rebuild: bool) {
    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let Some(gdk_window) = gtk_window.window() else {
        return;
    };
    // SAFETY: the window is mapped, so GDK keeps its wl_surface alive.
    let surface = unsafe {
        gdk_wayland_sys::gdk_wayland_window_get_wl_surface(gdk_window.as_ptr() as *mut _)
    };
    if surface.is_null() {
        return;
    }
    FRAME.with_borrow_mut(|frame| {
        let Some(frame) = frame else { return };
        if frame.wanted.is_empty() {
            return;
        }
        if frame
            .palette
            .as_ref()
            .is_none_or(|(_, _, current)| current.id().as_ptr() != surface as *mut _)
        {
            if let Some((old, decoration, _)) = frame.palette.take() {
                old.release();
                if let Some(decoration) = decoration {
                    decoration.release();
                }
            }
            // SAFETY: the pointer is GDK's live wl_surface proxy.
            let Ok(id) = (unsafe { ObjectId::from_ptr(WlSurface::interface(), surface as *mut _) })
            else {
                return;
            };
            let Ok(surface) = WlSurface::from_id(&frame.connection, id) else {
                return;
            };
            let palette = frame.manager.create(&surface, &frame.queue.handle(), ());
            frame.palette = Some((palette, None, surface));
        }
        let Some((palette, decoration, surface)) = &mut frame.palette else {
            return;
        };
        palette.set_palette(frame.wanted.clone());
        if let Err(error) = frame.connection.flush() {
            eprintln!("Could not send the title bar palette: {error}");
        }
        let (true, Some(manager)) = (rebuild, &frame.decorations) else {
            return;
        };
        let decoration = decoration
            .get_or_insert_with(|| manager.create(surface, &frame.queue.handle(), ()))
            .clone();
        decoration.request_mode(Mode::None as u32);
        if let Err(error) = frame.connection.flush() {
            eprintln!("Could not rebuild the title bar: {error}");
        }
        let connection = frame.connection.clone();
        gtk::glib::idle_add_local_once(move || {
            decoration.request_mode(Mode::Server as u32);
            if let Err(error) = connection.flush() {
                eprintln!("Could not rebuild the title bar: {error}");
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_entry_quotes_exec() {
        let entry = desktop_entry(
            "com.visnia.caprine",
            Path::new("/opt/my $app/caprine"),
            Path::new("/x/icon.png"),
        );
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
