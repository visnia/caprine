# Caprine — Tauri migration

The `tauri` branch is an **incomplete development build** for Windows and Linux. It opens **https://www.messenger.com**, uses a persistent platform-webview profile, and injects the retained theme, code-block and scrollbar styles. Electron account data is left untouched; sign in once in the new profile. There is no macOS build or native application menu bar.

```sh
npm ci
npm start
```

Requires Node.js 24 and stable Rust. Windows requires the Visual Studio C++ workload and WebView2 Runtime 128.0.2739.15 or later. Linux requires GTK 3 / WebKitGTK 4.1 development packages (see the build workflow). `npm run build:app` builds the release executable; `npm run build:app -- --debug` builds `src-tauri/target/debug/caprine.exe` on Windows. Quit the running Tauri instance before opening a different build. GitHub Actions checks and builds Windows and Linux on every push to `tauri`.

The profile is stored in the platform's app-local-data directory under `com.visnia.caprine/webview`. On Windows this is `%LOCALAPPDATA%\com.visnia.caprine\webview`. Custom styles are read from `custom.css` in the app-data directory (`%APPDATA%\com.visnia.caprine\custom.css` on Windows, `$XDG_DATA_HOME/com.visnia.caprine/custom.css` on Linux, defaulting to `~/.local/share`). Restart or press Ctrl+R after changing the file. On 2026-10-04 the user verified fresh sign-in and persistence after quit/relaunch with `com.visnia.caprine`, plus settings/theme/zoom persistence, tray toggling and single instance. Badge verification is pending with the notification phase. Linux persistence remains unverified.

Open the in-page settings panel with **Ctrl+,** or the gear button. Settings persist through `tauri-plugin-store`: system/light/dark theme, zoom, unread badge, always on top, launch at login, launch minimized, quit on close and notification debugging. Zoom shortcuts are **Ctrl+=**, **Ctrl+-** and **Ctrl+0** (50–200%). The panel also opens the custom CSS file. Window size, position and maximized state persist separately. The old Electron source, menus, settings and obsolete platform assets have been removed.

Closing defaults to keeping Caprine in the tray; enable **Quit on window close** to exit instead. The tray has Show / Quit actions. **Windows left-click toggles the window; Linux left-click opens the Show / Quit menu**, using Tauri's native tray implementation. Windows parks the window by minimizing it and removing its taskbar entry, without explicitly hiding or suspending the WebView2 controller. Linux hides the native window. Delivery latency during long idle periods still needs runtime measurement.

The tray changes between read/unread icons. Windows shows the count in its tooltip and a taskbar overlay (up to `99+`); Linux shows a tray count where the desktop supports tray titles. The **Unread badge** setting controls the numeric badge, while the tray icon still indicates unread chats. Mutation observers use Messenger's title count first and semantic sidebar unread labels second, with no polling interval. A virtualized sidebar only exposes a subset of conversations; real Messenger badge accuracy remains a runtime acceptance check.

Notification delivery, calls, attachment downloads, offline recovery, autoplay controls and signed updater integration are still being migrated. Taskbar flashing belongs to the notification phase. Hardware acceleration, spell-checking and ringtone controls remain subject to platform verification. These are not yet a complete replacement for Electron Caprine.

Notifications will use native engine hooks first, page metadata second, and the sidebar observer as the final coverage backstop. **WebView2's `NotificationReceived` hook covers non-persistent notifications only.** Page-side interception also misses calls made inside a service worker. The worker gap is **not applicable currently**: the user measured zero registrations and a null controller in logged-in WebView2 at startup and after 10+ minutes (2026-10-04). This is a result for that session, not a claim of worker interception support or Linux coverage. Reopen the investigation if registrations appear. Registration blocking or worker-script interception/modification still requires explicit approval. The sidebar cannot provide a perfect event history from a virtualized or unchanged preview.

Enable **Debug notifications** in the settings panel to log service worker registration counts and controller presence immediately, at each document startup, and every hour while enabled. Settings live in the app-data `settings.json` (Windows: `%APPDATA%\com.visnia.caprine\settings.json`; Linux: `$XDG_DATA_HOME/com.visnia.caprine/settings.json`, defaulting to `~/.local/share`). Logs go to `notifications.jsonl` alongside that file. Query failures/timeouts are logged distinctly from zero registrations; worker scripts and push-subscription data are not read. Logging defaults off and the panel toggle applies immediately. Logs rotate at 1 MiB with one backup. Full notification collection/delivery is still a later phase.

See [the migration audit](docs/tauri-migration-audit.md) for the phases, API evidence and outstanding runtime checks. The app identifier is `com.visnia.caprine`; the installed product is **Caprine (Visnia)**. The new profile starts empty: no data is copied from the old identifier or Electron.


MIT licensed; original Caprine copyright notices are preserved in [license](license).
