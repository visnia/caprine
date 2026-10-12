# caprine

A minimal desktop wrapper for **[Messenger](https://www.messenger.com)** on **Windows** and **Linux**, built with Electron. It always loads `https://www.messenger.com`, so it works with Messenger-only accounts. Reliable desktop notifications are the main goal.

This is a fork of [Caprine](https://github.com/sindresorhus/caprine), rewritten from scratch for current Electron. It is not affiliated with Meta. There is no macOS build and no application menu bar; settings live in an in-page drawer.

## Features

- **Notifications** for new messages. Messenger's web app shows none itself, so Caprine detects them from the sidebar (a chat turning unread or its preview changing) and from Messenger's message tone (a repeated preview in a chat that is already unread). If Messenger ever calls `new Notification()`, that is routed through the same path. Notifications are skipped while Caprine is focused or **Desktop notifications** is off. Clicking one opens its chat.
- **Notification sound**: Messenger's own tone (default, silent notifications), the system notification sound (Messenger's tone muted), or none. Off also silences download and update notices.
- **Unread badge**: read/unread tray icon and tooltip, and on Windows the taskbar overlay (up to `99+`). While chats are unread and Caprine is not focused, the tray icon and badge blink.
- **Tray and window**: close to tray, or quit on close with no tray icon; launch at login, launch minimized, always on top, single instance, remembered window size and position.
- **Appearance**: system/light/dark/OLED/Catppuccin (Latte, Mocha) theme, which Caprine's own title bar follows too, code-block and scrollbar styles, your own `custom.css`, text zoom with **Ctrl+=**, **Ctrl+-** and **Ctrl+0**.
- **Links** open in your default browser, with Facebook `l.php` tracking redirects removed.
- **Calls** open in separate windows. Camera, microphone and screen sharing are allowed for `https://www.messenger.com` only. Screen sharing shares the whole primary screen (on Wayland the desktop's own picker appears).
- **Downloads** go to your Downloads folder without overwriting; a notification reveals the file.
- **Offline recovery**: if Messenger cannot load, a retry page appears and Caprine retries with backoff.
- **Spell checking** with suggestions in the context menu: the Windows spell checker, or Hunspell dictionaries for your system languages on Linux (downloaded by Electron on first use).
- **Autoplay videos** and **hardware acceleration** toggles.
- **Automatic updates** from this repository's GitHub releases (NSIS installer and AppImage).

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+, | Settings |
| Ctrl+= / Ctrl+- / Ctrl+0 | Text size |
| Ctrl+R | Reload (applies `custom.css`) |
| F12, Ctrl+Shift+I | Developer tools |

## Files

`<data>` is `%APPDATA%\com.visnia.caprine` on Windows and `~/.config/com.visnia.caprine` on Linux. Development runs (`npm start`) use `com.visnia.caprine.dev` instead, so they keep their own settings, session and autostart entry.

- `settings.json`: settings.
- `custom.css`: your styles (**Open CSS** in settings creates it).
- `window.json`: window size and position.
- Everything else is the Chromium profile, including your Messenger session.

## Code layout

| Path | What |
| --- | --- |
| `src/main/index.ts` | App lifecycle, window, IPC, notifications, shortcuts, offline retry |
| `src/main/settings.ts` | Loading, validating and saving settings; launch at login |
| `src/main/web.ts` | Navigation, popups, permissions, downloads, context menu |
| `src/main/title-bar.ts`, `src/preload/title-bar.ts` | The themed title bar and its window buttons |
| `src/main/tray.ts` | Tray icon, unread badge, blinking |
| `src/main/updates.ts` | `electron-updater` |
| `src/preload/index.ts` | Wires the page integration to the main process |
| `src/preload/main-world.ts` | Runs in Messenger's own world: autoplay/tone guard, `Notification` hook |
| `src/preload/collector.ts`, `unread.ts`, `selectors.ts` | New-message and unread detection from the sidebar |
| `src/preload/settings-panel.ts`, `styles.ts`, `css/` | Settings drawer and styles |

## Building

Requires Node.js 24.

```sh
npm ci
npm start              # build and run
npm test               # type checks and tests
npm run dist:win       # NSIS installer in release/
npm run dist:linux     # AppImage in release/
```

Releases come from pushing a `v<version>` tag that matches `package.json`. The Release workflow builds both platforms and uploads them, with the updater's `latest.yml` / `latest-linux.yml`, to a **draft** GitHub release. Publishing the draft makes it visible to the updater. Builds are not code-signed.

## Not included

macOS; native menus; private mode; typing/seen receipt blocking; emoji style customization; spell-check language selection; Work Chat; inline reply; conversation navigation shortcuts; ringtone muting.

## License

MIT. The original Caprine copyright notices are preserved in [license](license).
