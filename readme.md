# Caprine — Tauri migration

The `tauri` branch is an **incomplete development build** for Windows and Linux. It opens **https://www.messenger.com**, uses a persistent platform-webview profile, and injects the retained base, system-theme, code-block and scrollbar styles. Electron account data is left untouched; sign in once in the new profile.

```sh
npm ci
npm start
```

Requires Node.js 24 and stable Rust. Windows requires the Visual Studio C++ workload and WebView2 Runtime 128.0.2739.15 or later. Linux requires GTK 3 / WebKitGTK 4.1 development packages (see the build workflow). `npm run build:app` builds the native executable. GitHub Actions checks and builds Windows and Linux on every push to `tauri`.

The profile is stored in the platform's app-local-data directory under `com.visnia.caprine/webview`. On Windows this is `%LOCALAPPDATA%\com.visnia.caprine\webview`. Custom styles are read from `custom.css` in the app-data directory (`%APPDATA%\com.visnia.caprine\custom.css` on Windows, `$XDG_DATA_HOME/com.visnia.caprine/custom.css` on Linux, defaulting to `~/.local/share`). Restart or press Ctrl+R after changing the file. The user verified Windows restart persistence with the previous test identity on 2026-10-04; this new identity starts with a fresh profile. Linux persistence remains unverified.

This scaffold has no native menu bar. Settings, tray, notification delivery, calls, download handling, offline recovery and updater integration are still being migrated. Closing the scaffold exits it until the tray phase lands. The legacy `source/` files are migration references and are neither compiled nor shipped by Tauri.

The planned tray behavior is **left-click toggle on Windows** and **left-click Show / Quit menu on Linux**, using Tauri's native tray implementation.

Notifications will use native engine hooks first, page metadata second, and the sidebar observer as the final coverage backstop. **WebView2's `NotificationReceived` hook covers non-persistent notifications only.** Page-side interception also misses calls made inside a service worker. The worker gap is **not applicable currently**: the user measured zero registrations and a null controller in logged-in WebView2 at startup and after 10+ minutes (2026-10-04). This is a result for that session, not a claim of worker interception support or Linux coverage. Reopen the investigation if registrations appear. Registration blocking or worker-script interception/modification still requires explicit approval. The sidebar cannot provide a perfect event history from a virtualized or unchanged preview.

To enable notification diagnostics before the settings panel migration, close Caprine and set `"debugNotifications": true` in its app-data `settings.json` (Windows: `%APPDATA%\com.visnia.caprine\settings.json`; Linux: `$XDG_DATA_HOME/com.visnia.caprine/settings.json`, defaulting to `~/.local/share`). The next launch logs service worker registration counts and controller presence at startup and every hour to `notifications.jsonl` alongside that file. Query failures/timeouts are logged distinctly from zero registrations; worker scripts and push-subscription data are not read. Logging defaults off; set the flag to `false` and restart to disable it. Logs rotate at 1 MiB with one backup. Full notification collection/delivery is still a later phase.

See [the migration audit](docs/tauri-migration-audit.md) for the phases, API evidence and outstanding runtime checks. The app identifier is `com.visnia.caprine`; the installed product is **Caprine (Visnia)**. The new profile starts empty: no data is copied from the old identifier or Electron.


MIT licensed; original Caprine copyright notices are preserved in [license](license).
