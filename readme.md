# Caprine (Visnia)

A minimal desktop wrapper for **[Messenger](https://www.messenger.com)** on **Windows** and **Linux**, built with Tauri 2. It always loads `https://www.messenger.com`, so it works with Messenger-only accounts. Reliable desktop notifications are the main goal.

This is a fork of [Caprine](https://github.com/sindresorhus/caprine), rewritten from Electron to Tauri. It is **pre-release software**: download it from [Releases](https://github.com/visnia/caprine/releases). The Electron version is kept on the [`electron-legacy`](https://github.com/visnia/caprine/tree/electron-legacy) branch. It is not affiliated with Meta.

There is no macOS build and no native application menu bar. Settings live in an in-page drawer.

## Features

- **Persistent session** in a dedicated platform-webview profile (WebView2 on Windows, WebKitGTK on Linux). Nothing is imported from Electron Caprine or the upstream app ID.
- **Native notifications** for new messages. Messenger's web app shows none itself, so Caprine detects them from the sidebar's unread marker and preview, plus Messenger's message tone for repeated previews; the engine's notification hook stays in place in case Messenger ever calls it. Notifications are suppressed when **Desktop notifications** is off or Caprine is focused. Clicking one opens its conversation.
- **Unread badge**: read/unread tray icon, Windows taskbar overlay (up to `99+`) and tray tooltip. While chats are unread and Caprine is not focused, the tray icon blinks between colour and grey and the taskbar badge blinks with it. On Linux, a tray count where the desktop supports tray titles.
- **Tray and window lifecycle**: close to tray (or quit on close), launch at login, launch minimized, always on top, single instance, and remembered window size/position.
- **Appearance**: system/light/dark/OLED theme, Caprine's code-block and scrollbar styles, your own `custom.css`, and text zoom with **Ctrl+=**, **Ctrl+-** and **Ctrl+0** (persisted).
- **Links** open in your default browser, with Facebook `l.php` tracking redirects removed.
- **Calls** open in separate windows. Camera, microphone and screen capture are allowed for `https://www.messenger.com` only.
- **Downloads** go to your Downloads folder without overwriting, and a notification reveals the file.
- **Offline recovery**: if Messenger cannot load, a retry page appears and Caprine retries automatically with backoff.
- **Video autoplay**, **spell checking** and **hardware acceleration** toggles.
- **Signed automatic updates** from this repository's GitHub releases.

## Settings

Open the drawer with **Ctrl+,** or the gear button.

| Section | Settings |
| --- | --- |
| Appearance | Theme, text size, unread badge |
| App behavior | Always on top, launch at login, launch minimized, quit on window close |
| Messages & media | Autoplay videos, spell checking |
| Notifications | Desktop notifications on/off, message preview (off shows `You have a new message`), flash taskbar (Windows) |
| Advanced | Debug notifications, hardware acceleration (applies after **Relaunch Caprine**), custom styles |
| Updates | Automatic update checks, check now / install & restart |

Files (`<app data>` is `%APPDATA%\com.visnia.caprine` on Windows, or `$XDG_DATA_HOME/com.visnia.caprine` on Linux, defaulting to `~/.local/share`):

- `settings.json`: settings.
- `custom.css`: your styles. Press **Ctrl+R** to reload after editing.
- `notifications.jsonl`: debug log, only while **Debug notifications** is on. It rotates at 1 MiB and may contain conversation names and IDs.
- Webview profile: `%LOCALAPPDATA%\com.visnia.caprine\webview` on Windows; `com.visnia.caprine/webview` under the local data directory on Linux.

## Platform notes

- **Tray**: on Windows, left-clicking the tray icon toggles the window. On Linux, left-click opens the Show / Quit menu, because Tauri does not deliver Linux tray clicks.
- **Closing to the tray**: Windows minimizes the window and removes its taskbar entry without hiding or suspending WebView2, and uses `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`. Linux hides the window.
- **Spell checking**: WebView2 has no native spell-check switch, so turning it off sets the HTML `spellcheck` attribute on Messenger's text fields. On Linux, WebKitGTK spell checking uses your locale (`LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG`) and needs the matching Enchant/Hunspell dictionaries.
- **Hardware acceleration off**: WebView2 gets `--disable-gpu`; WebKitGTK gets the `NEVER` acceleration policy.
- **Windows notifications** need the Start Menu shortcut created by the installer (AppUserModelID `com.visnia.caprine`). Debug builds create a separate `Caprine (Visnia) Debug` shortcut.

## Notification design and known limits

Native WebView2 `NotificationReceived` / WebKitGTK `show-notification` events are the primary source, and Caprine presents them itself. Page hooks on `Notification` and `showNotification` only supply metadata and always call the real APIs. A backend worker correlates the two by tag/title/time and arbitrates against the sidebar fallback by conversation and time. It never deduplicates by message text.

- WebView2's hook covers **non-persistent** notifications only, and page hooks cannot see a service worker's `showNotification`. In the measured logged-in session, Messenger registered **no** service worker (0 registrations, null controller at startup and after 10+ minutes), so this gap is currently not applicable. Debug mode samples the count hourly. A nonzero count reopens the investigation.
- Clicking a toast works while Caprine is running, including from the Windows Action Center after the banner times out. Clicking an old toast after Caprine has quit and restarted is **not implemented**.
- A conversation whose identity cannot be determined is never guessed: its click only restores the window.

## Updates

Release builds check `https://github.com/visnia/caprine/releases/latest/download/latest.json` 60 seconds after startup and every 6 hours, when enabled. They announce a new version once, and install only after you click. Every download is verified against the minisign public key in `src-tauri/tauri.conf.json`, and its signed version must match the announced version.

| Package | Update path |
| --- | --- |
| Windows NSIS installer | Downloads and runs the installer in passive mode; Caprine exits and restarts. |
| Linux AppImage | Replaces the AppImage, then restarts. |
| Debug builds, raw binaries | Updates are unavailable. |

## Building

Requires Node.js 24 and stable Rust.

- **Windows** also needs the Visual Studio C++ workload and WebView2 Runtime 128.0.2739.15 or later.
- **Linux** needs the GTK 3 / WebKitGTK 4.1 development packages: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.

```sh
npm ci
npm start                         # development run
npm test                          # TypeScript checks and JavaScript tests
npm run build:app -- --debug      # target/debug executable, no installer
npm run dist:win:unsigned         # local NSIS installer without updater signatures
npm run dist:linux:unsigned       # local AppImage without updater signatures
```

Quit a running Caprine from its tray menu before starting another build; closing the window may only park it in the tray.

`npm run dist:win` / `dist:linux` produce updater signatures and need `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Releases come from pushing a `v<version>` tag that matches `tauri.conf.json`. The Release workflow builds Windows NSIS and Linux AppImage, signs them, verifies the signed versions, writes `latest.json` and creates a **draft** GitHub release. Publishing the draft makes it visible to the updater. The workflow needs the two signing secrets above in the repository.

## Verification status

Build success does not prove runtime behavior; the checks below are kept separate.

| Area | Status |
| --- | --- |
| Windows CI and Linux CI (type checks, tests, fmt, clippy, native build) | Passing on every phase pushed so far; see Actions. |
| Fresh sign-in and persistence, settings drawer, theme/zoom persistence, Ctrl+0, close to tray, tray toggle, single instance (Windows) | **Verified by the user** on 2026-10-04. |
| Signed NSIS updater artifact (Windows) | Verified locally: signature checks against the committed key, a tampered file is rejected, and the signed version matches. |
| Unread badge/overlay, notification delivery, duplicates, click destinations, Action Center, mute/preview/flash, 30+ minute idle delivery | **Pending**: [combined checklist](docs/notification-verification.md). |
| Calls, downloads, offline recovery, autoplay, spell checking, hardware acceleration, update installation | **Pending** runtime checks (same document). |
| Autostart and window-geometry persistence | Implemented; not yet checked by the user. |
| Any Linux desktop runtime behavior, Linux release bundles | **Not tested**: no Linux desktop was available; CI only compiles and unit-tests Linux. |

## Not included

macOS; native menus; private mode; typing/seen/delivery-receipt blocking; emoji style customization; spell-check language selection; Work Chat; inline reply; conversation navigation commands and jump lists. **Ringtone muting** is not implemented: Electron Caprine blocked the ringtone by a response header that page scripts cannot see, and no reliable, ringtone-specific target has been measured. See [the migration audit](docs/tauri-migration-audit.md) for the full Electron API inventory, sources and decisions.

## License

MIT. The original Caprine copyright notices are preserved in [license](license).
