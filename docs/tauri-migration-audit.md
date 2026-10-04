# Tauri migration audit

Phase 1, 2026-10-04. Baseline: `0826641` on `main`; working branch: `tauri`.

## Fork identity (before phase 3)

The user requested a fresh identity, **`com.visnia.caprine`**, without migrating the old identifier's data. Tauri app-data/config/cache paths and the explicit `app_local_data_dir()/webview` profile now derive from this identifier. No old-directory lookup, copy or cookie import is implemented. The earlier login-persistence result applies to the old test profile; a fresh sign-in is expected after this change.

The Windows process calls `SetCurrentProcessExplicitAppUserModelID` with the configured identifier before creating any windows. The inspected NSIS 2.10.1 `SetLnkAppUserModelId` macro writes `${BUNDLEID}` to the shortcut property store, so the generated shortcut shares that identity. Its installer/uninstall keys and shortcut filenames also use `productName`; this fork therefore installs as **Caprine (Visnia)**, published by `visnia`, with its Start Menu shortcut under `Visnia`. The window title remains Caprine. `tauri-plugin-autostart` 2.7.0 is configured with `app_name(config.identifier)` and `--autostart`; its new entry is separate from Electron's. An NSIS uninstall hook cleans up that identifier-named entry only on uninstall, preserving it on updates.

Package/Cargo homepage, repository, issue links and the configured updater endpoint point to `visnia/caprine`. The updater has no separate app-identifier field; it uses the application's configured identity and installer. Only its endpoint and signed-version requirement are configured here: registration and the real signing public key remain phase 5. No fake key or unsigned updater was added. Obsolete upstream README download instructions and Electron RPM/APT packaging were removed; original MIT copyright notices and historical source citations remain.

Identity commit `6c65f80` passed both Windows and Linux [CI jobs](https://github.com/visnia/caprine/actions/runs/37192714805). A Windows NSIS package built successfully during phase 3. Its generated `installer.nsi` defines `BUNDLEID "com.visnia.caprine"`, `PRODUCTNAME "Caprine (Visnia)"` and `STARTMENUFOLDER "Visnia"`, includes the identifier-specific uninstall hook, and uses `SetLnkAppUserModelId` for Start Menu and desktop shortcuts. The generated macro writes `${BUNDLEID}`. Fresh-profile runtime checks remain pending; no installer has been run against the user's installed Electron application.

**The Linux tray decision is resolved.** Use Tauri's normal menu behavior on Linux (left-click opens Show / Quit), and retain left-click window toggling on Windows. No separate tray backend; `ksni` is a possible later follow-up. Document the platform difference in the rewritten README. Tauri does not expose Linux tray click events to implement a custom toggle.

**The worker gap is closed as “not applicable currently”, based on the user's in-app WebView2 measurement below.** It no longer blocks the notification phase. Microsoft still documents `ICoreWebView2_24::NotificationReceived` for non-persistent notifications only; this is not evidence of persistent/service-worker interception support. A document-start patch of `ServiceWorkerRegistration.prototype.showNotification` cannot patch the worker's separate JavaScript context. No worker coverage or absence of worker notifications may be inferred from an empty native-hook log.

Accepted notification design: native WebView2/WebKitGTK events are the primary source; the page patches supply metadata and must call the original APIs so native events still occur. The sidebar is the last-resort fallback, including coverage for events missed by the first two sources. Each notification has one owner; metadata correlation by tag/title/time does not become text-only event dedupe. Log source, correlation failures and decisions in debug mode. Document the known worker gap in the README.

The original plan included separate Edge and in-app measurements. The user's subsequent in-app result resolves the current blocker without waiting for Edge tooling. Reopen the investigation if diagnostics detect a registration or normal use shows worker-originated notifications. Report measurements before proposing worker-specific mitigation. Do not await `navigator.serviceWorker.ready` when no worker is registered, or log subscription endpoints/keys and message content when counts/source evidence suffice.

Only if ordinary use shows worker-originated notifications, evaluate (a) registration blocking with login/E2EE/media/call regression tests, then (b) Windows `AddWebResourceRequestedFilterWithRequestSourceKinds` worker-script observation. Both require asking before implementation; no modification of Meta's script without approval. No worker registration blocking or worker-script interception is part of phase 2.

## Worker verification record — 2026-10-04

User-reported, in the Tauri app's **WebView2** context, logged in to `https://www.messenger.com`:

| Observation | Registration count (`navigator.serviceWorker.getRegistrations()`) | `navigator.serviceWorker.controller` |
| --- | --- | --- |
| Startup | 0 | `null` |
| After 10+ minutes of use | 0 | `null` |

Disposition requested by the user: **not applicable currently**. No registered service worker was present at either observation, so no worker-specific mitigation is warranted for this measured session. This does not establish behavior in Edge, WebKitGTK, other accounts or a future Messenger version, nor does it prove page notification delivery or native interception. No push-subscription endpoint was collected.

With `debugNotifications` enabled, the injection now queries registrations at document startup and every hour. The backend appends `serviceWorkerInventory` JSON records to `notifications.jsonl` in app data, with a backend timestamp, trigger, registration count and controller-presence boolean. Unsupported APIs, failures and ten-second query timeouts get distinct statuses rather than a false zero. Logging defaults off and is gated in both JavaScript and Rust. Only the existing exact-origin main Messenger capability receives the narrow logging command; it accepts no arbitrary text or file path. The file rotates at 1 MiB with one backup. This timer is diagnostic only; unread badges still must use observers.

The debug flag is persisted by `tauri-plugin-store` 2.5.0 in `settings.json`; phase 3 adds a live settings-panel toggle. Published store source was checked before use: paths resolve under app data, `StoreBuilder::default` supplies a default, and `Store::get/save` read/write the JSON store. The builder ignores initial load errors, so the settings file is validated before loading/saving to avoid replacing malformed configuration with defaults. No direct frontend store permissions are granted.

Diagnostic validation: eight JavaScript tests and six Rust tests pass, as do TypeScript compilation and Rust clippy with warnings denied. Tests cover no work when debug is off, startup IPC before DOM readiness, hourly discovery of a newly registered worker, query error/timeout recovery, fixed IPC fields and bounded file rotation. Hourly scheduling uses a simulated clock in tests; a real one-hour in-app run has not been claimed or performed by the agent.

## Repository coverage and original Electron architecture

Reviewed the application TypeScript and declarations, every stylesheet, manifests, workflows, packaging scripts, patches, and documentation. Parsed the generated lockfile (1,158 package records, lockfile format 2) and inventoried all 53 binary assets, including image dimensions where applicable. There are 104 tracked files at the baseline. Binary design files and screenshots were inventoried, not treated as application source. No applicable `AGENTS.md` was found in the workspace or the checked parent locations.

| Area | Current behavior |
| --- | --- |
| `source/index.ts` | Electron main process. Configures app identity, hardware acceleration, updates, single instance, windows, cookies, request filtering, tray/badges, navigation, downloads, notification delivery, settings IPC, and lifecycle. Loads `https://www.messenger.com/t/`, or Work Chat when configured. |
| `source/browser.ts` | Electron preload. Uses Node imports, isolated-world IPC, `@electron/remote`, and an early main-world notification proxy. Manages theme, zoom, settings, links, login checkbox, DOM manipulation, menu-driven commands, conversation navigation, notification icons/callbacks and inline replies. |
| `source/notifications-isolated.ts` | Serialized main-world replacement of `window.Notification`. Sends page messages to the preload, keeps callback objects, and forwards click/close/reply callbacks. Does not intercept `showNotification`. |
| `source/browser/conversation-list.ts` | Sidebar discovery, avatar rendering, unread heuristics, preview-change fallback notifications, title/navigation/sidebar unread counts, and conversation lists for Dock/Jump List/Touch Bar. Uses observers plus a two-second badge interval. |
| `source/browser/selectors.ts` | Mixes semantic roles with obfuscated class strings and hard-coded SVG paths. Some selectors are centralized, while others remain inline in `browser.ts`. |
| `source/config.ts`, `source/types.ts` | `electron-store` schema, defaults and historical migrations; settings panel contracts. Settings include many features outside the new scope. |
| `source/settings-panel.ts`, `css/settings-panel.css` | Existing injected settings drawer and floating gear button. Reads/writes Electron IPC. Includes emoji, language selection, Work Chat and macOS settings. |
| `source/tray.ts` | Native tray icon, tooltip count, Toggle / Quit menu and platform branches; macOS menu-bar and Dock controls. |
| `source/menu.ts`, `source/menu-bar-mode.ts`, `source/touch-bar.ts` | Native application menu, global macOS menu-bar shortcut, Dock integrations and Touch Bar. |
| `source/autoplay.ts`, `source/browser-call.ts` | Autoplay disabling by replacing video DOM ancestors; call preload clicks an old class-based start-call button. Both are brittle and must be reworked or removed as appropriate. |
| `source/emoji.ts`, `source/spell-checker.ts` | Network emoji rewriting and native emoji rendering; Electron spell-check language enumeration/configuration. |
| `source/ensure-online.ts`, `source/util.ts`, `source/constants.ts` | Startup connectivity polling/dialog; window helpers, IPC helpers, custom-style/restart utilities, tracking removal and ASAR icon path. |
| `css/` | Browser modifications, settings, legacy dark mode, code blocks, scrollbar, autoplay, Work Chat and vibrancy. `dark-mode.css` exists but is absent from the current `dom-ready` injection list. |
| Build and releases | TypeScript compiles to `dist-js`; Electron 43.4.1 and electron-builder 24.12.0 are locked. GitHub Actions build Windows/Linux/macOS. Separate RPM packaging and an external APT-repository installation script remain. The package repository field and much of the README still point upstream. |

The current notification path is:

`Messenger Notification -> main-world proxy -> window.postMessage -> preload/icon conversion -> electron-better-ipc -> Electron Notification`

The sidebar observer is a second source. Main-process cross-source dedupe uses `title + '\n' + body` for five seconds. The sidebar separately compares preview text and suppresses identical content for 30 seconds. All notifications are suppressed whenever the main window is focused. No active-thread comparison exists. Avatars have a one-second timeout on the primary path, but sidebar avatar rendering has no matching timeout. Debug decision logging does not exist.

## Electron API replacement inventory

Grouped rows enumerate the directly used APIs, options and events, including currently unreachable legacy helpers. Replacements below are proposed, not implemented or runtime-verified. Platform constraints and source references follow the table.

| Electron surface in this repository | Replacement or disposition |
| --- | --- |
| `app.whenReady()`, `app.on('ready')` | Tauri builder `setup` and application event loop. |
| `app.requestSingleInstanceLock()`, `app.on('second-instance')` | `tauri-plugin-single-instance`; show/focus the existing main window. Conversation-index command-line tasks are dropped. |
| `app.on('before-quit')`, `app.quit()` | Rust shutdown state, Tauri exit handling and `AppHandle::exit`; save settings/window state before exit. |
| `app.relaunch()` | `AppHandle::restart`. |
| `app.name`, `app.getVersion()` | Tauri product configuration and package metadata, returned through a narrow settings command. |
| `app.getPath('userData')` | Tauri app data/config paths. Rust owns store files, custom CSS, notification log and a persistent webview profile. |
| `app.setAppUserModelId()` | Windows process identity aligned with the Tauri identifier, NSIS shortcut AppUserModelID and native toast app ID. Preserve a consistent identity across upgrades. |
| `app.disableHardwareAcceleration()` | Windows `additional_browser_args`, adding the verified engine argument for disabling GPU acceleration after testing. Restart required. Do not pretend a browser argument configures WebKitGTK. |
| `app.getLoginItemSettings().openAtLogin`, `app.setLoginItemSettings({openAtLogin, openAsHidden})` | Rust `tauri-plugin-autostart` enable/disable/state plus an explicit startup argument and persisted launch-minimized setting. |
| `app.getLoginItemSettings().wasOpenedAsHidden` | Explicit autostart argument and settings; no macOS hidden-login behavior. |
| `app.getLocale()`, `session.defaultSession.cookies.set(locale)` | Remove the injected Facebook locale cookie; use the webview/browser locale and Messenger's own preference. This helper is outside the requested retained scope. |
| `app.badgeCount` | Windows overlay icon and tray unread state/count. No macOS Dock badge. Linux tray count rendering must account for shell support. |
| `app.setJumpList()` | Dropped: conversation-navigation tasks are outside the minimal wrapper scope. |
| `app.dock.show/hide/bounce/setMenu`, `app.hide()`, `app.on('activate')` | Dropped with all macOS support. Windows/Linux activation comes from tray, single instance and notifications. |
| `new BrowserWindow`, `loadURL`, title/show/x/y/width/height/minWidth/minHeight/icon/alwaysOnTop options | `WebviewWindowBuilder` and `WebviewUrl::External` for `https://www.messenger.com`; stable labels, dimensions, retained Windows/Linux icon, native decorations and persistent profile. |
| `BrowserWindow.getAllWindows()` | Look up the explicit `main` label through Tauri's manager, avoiding ordering assumptions. |
| `webPreferences.preload`, `contextIsolation`, `nodeIntegration` | One bundled initialization script under `src/inject/`, with exact-origin and top-frame guards. No Node integration or Electron remote bridge. Native access uses narrow Tauri commands. |
| `webPreferences.plugins` | Dropped; use the platform webview's media implementation. |
| `webPreferences.spellcheck` | Conditional native engine setting only after verifying Windows/WebKitGTK support; not replaced by spell-check language selection or an unverified Chromium flag. |
| `titleBarStyle`, `trafficLightPosition`, `setSheetOffset`, `setVibrancy`, `setBackgroundColor` for vibrancy | Dropped. Standard Windows/Linux title bars. |
| `autoHideMenuBar`, `Menu.setApplicationMenu()` | Dropped. No native menu bar is installed. |
| Window `on('close')`, `event.preventDefault()` | Tauri `WindowEvent::CloseRequested` and `prevent_close`; close-to-tray by default, or explicit quit setting. Background visibility strategy must pass notification tests. |
| Window `show/hide/blur/focus`, `isVisible/isFocused/isDestroyed` | Rust window show/focus/state handling. Tauri `show`, `hide`, `set_focus`, `is_visible`, `is_focused`, and explicit window lifetime. The old blur/focus hacks are not copied without evidence. |
| Window `minimize/restore/isMinimized` | Tauri `minimize`, `unminimize`, `is_minimized`; evaluate minimizing versus hiding with native webview visibility measurements. |
| Window `maximize/unmaximize/isMaximized`, `on('maximize'/'unmaximize')` | Tauri maximize state and `tauri-plugin-window-state`. |
| Window `getNormalBounds/getPosition/setPosition`, `on('resize')` | `tauri-plugin-window-state`, appropriate position/size events and monitor-aware restore. |
| Window `on('focus')`, `flashFrame()` | Focus events and `request_user_attention`, controlled by the flash-on-message setting. Clear attention when focused/read. |
| Window `setAlwaysOnTop/isAlwaysOnTop` | Tauri `set_always_on_top` and validated persisted setting. |
| Window `isFullScreen/setFullScreen/once('leave-full-screen')` | Drop the macOS close workaround and tray fullscreen special case. Native window controls retain ordinary window behavior. |
| Window `setVisibleOnAllWorkspaces` | Dropped with menu-bar mode. |
| Window `setOverlayIcon` | Tauri Windows `set_overlay_icon` with an unread-count image created by trusted backend code. No round trip to Messenger to render a taskbar badge. |
| `webContents.on('dom-ready')`, `insertCSS()` | Bundled CSS and document-start initialization, with DOM-ready attachment where needed; fixed-path custom CSS is read by Rust. |
| `webContents.send()`, `ipcMain/ipcRenderer.callRenderer/callMain/answerRenderer/answerMain/once`, `setMaxListeners()` | Typed `invoke` commands and scoped Tauri `emit_to`/`listen` events. Remove listener-limit workaround. Settings side effects, notification decisions and native UI remain in Rust. |
| `contextBridge.executeInMainWorld()` | Tauri `initialization_script` in the document's context, before Messenger scripts. The browser engine boundary replaces Electron's isolated preload bridge. |
| `webFrame.setZoomFactor()` | Rust webview `set_zoom` plus store persistence. Ctrl+=, Ctrl+-, Ctrl+0 handled in the injected script. |
| `webContents.on('before-input-event')`, `electronLocalshortcut.register()` | Injected key handling for retained shortcuts only, including numpad variants. Drop conversation/menu command shortcuts. |
| `webContents.setWindowOpenHandler()`, disposition/frame-name handling and child preload options | `on_new_window`, `NewWindowResponse::Create` and `window_features`; preserve the native popup relationship for calls. Calls need camera/mic permission handling and actual testing. Do not replace a call popup with an unrelated navigated window. |
| `webContents.on('will-navigate')`, `getURL()` | `on_navigation` and parsed URL/origin checks. Messenger stays inside; validated external links go to the browser. Inspect actual account authentication redirects without granting those origins IPC. |
| `session.defaultSession.webRequest.onBeforeSendHeaders()`, `screen.getAllDisplays().scaleFactor` | Dropped with the `dpr` cookie hack. |
| `session.defaultSession.webRequest.onBeforeRequest()` | Drop typing/seen/delivery blocking and emoji request rewriting. |
| `session.defaultSession.webRequest.onHeadersReceived()` | Drop the MD5-based ringtone request cancellation. Retain ringtone muting only if a safe injected-JS audio target is actually found; otherwise drop the setting and report it. |
| `session.defaultSession.availableSpellCheckerLanguages`, `setSpellCheckerLanguages()` | Dropped with spell-check language selection. |
| `screen.on('display-removed')` | Monitor-aware window restoration; investigate any required runtime relocation in the window-state implementation rather than carrying the Electron workaround unchanged. |
| `shell.openExternal()` | Rust opener API after HTTP(S) validation and exact-host `l.php` unwrapping for Facebook/Messenger tracking links. Do not grant general opener access to Messenger. |
| `shell.openPath()` | Rust opens only the app-owned `custom.css` path through the opener API. |
| `dialog.showMessageBoxSync/showMessageBox()` | Remove the offline blocking dialog and obsolete feature prompts. Retry/error/restart messages live in the page panel or dedicated offline state. |
| `Menu.buildFromTemplate/getApplicationMenu/getMenuItemById`, item `checked/enabled/visible`, menu role/accelerator handling | Drop application-menu code. Use a Rust tray menu containing Show / Quit only; panel controls own settings. |
| `new Tray`, `setContextMenu/popUpContextMenu`, click/double-click/right-click events | Tauri `TrayIconBuilder`, Show / Quit menu and Windows left-click toggle. **Accepted Linux behavior: left-click opens the menu; no custom click handler/backend.** Avoid double-click toggling twice on Windows. |
| Tray `setImage/setToolTip/destroy` | Tauri tray `set_icon`, tooltip on Windows, owned tray lifetime. Linux tooltip is unsupported; use unread-count icon rendering rather than depending on tooltip support. |
| `nativeImage.createEmpty/createFromDataURL/createFromPath`, `addRepresentation`, `resize`, `toDataURL` | Tauri `Image`/Rust image decoding for retained app/tray/overlay/notification images. Drop emoji, Dock, Touch Bar and emoji-preview rendering. Bound and validate collector icon data. |
| `new Notification`, `isSupported/show/close`, events `click/close/failed/reply` | Native Windows toast and Linux D-Bus notification backends with activation callbacks and error handling. `reply` is dropped. Rust applies mute/preview/active-thread rules. |
| `nativeTheme.themeSource`, `nativeTheme.on('updated')`, `electron-util.darkMode.isEnabled/onChange` | Tauri theme setting/events, web `matchMedia` and retained CSS. Verify the native preference reaches Messenger and the panel; remove vibrancy effects. |
| `systemPreferences.getUserDefault('AppleActionOnDoubleClick')` | Dropped with macOS title-bar double-click handling. |
| `globalShortcut.register/unregister` | Dropped with menu-bar-mode shortcut. No global-shortcut plugin needed for the retained local keys. |
| `new TouchBar`, `TouchBarButton`, `setTouchBar` | Dropped, along with conversation avatars/labels generated exclusively for native navigation integrations. |
| `@electron/remote/main.initialize/enable`, renderer `@electron/remote.nativeTheme` | Deleted. Typed Rust commands and theme handling replace the bridge. |
| Patched `session.defaultSession.extensions.getAllExtensions/loadExtension` in `electron-debug` | Drop development-extension loading and all `patch-package` patches. |
| Electron-only types (`MenuItemConstructorOptions`, `CallbackResponse`, `NativeImage`, `Electron.*`) | Delete or replace with app-owned TypeScript/Rust contracts; no runtime compatibility layer. |

## Electron-dependent packages

| Package/helper | Disposition |
| --- | --- |
| `electron`, `electron-builder`, `electron-publish`, `@electron/remote`, Electron typings and transitive tooling | Remove from manifest and regenerate the lockfile. Tauri CLI/Cargo build and bundle Windows NSIS and Linux AppImage/deb. |
| `electron-better-ipc` | Tauri invoke/events as above. |
| `electron-store` | Rust-side `tauri-plugin-store`; validate the retained settings. The later user decision requires a fresh profile, with no legacy config import. |
| `electron-updater.checkForUpdatesAndNotify()` | Rust-side `tauri-plugin-updater`, GitHub release metadata, signed artifacts and a real embedded public key. |
| `electron-dl()` | Tauri native download handling (`on_download`) with user-selected destination/error reporting; exercise authenticated attachments and blob URLs. |
| `electron-context-menu()` and transformed copy-link helper | Native webview context menu; retained external-link handling strips tracking. Any custom copy-link behavior needs separate verification if retained. |
| `electron-debug()` | Drop Electron extension/reload machinery; keep explicit reload behavior useful for Messenger/offline recovery and development tools only in development. |
| `electron-localshortcut` | Local injected keyboard handling. |
| `electron-util.is` | Rust target configuration and a small platform value returned to the settings panel. |
| `electron-util.fixPathForAsarUnpack` | Removed; icons/styles are bundled Tauri resources or compile-time assets. |
| `electron-util.appMenu/aboutMenuItem/openUrlMenuItem` | Drop native menus; use panel about/help actions. |
| `electron-util.debugInfo/openNewGitHubIssue` | App-owned version/platform diagnostics and an explicit browser-opening panel action. |
| `facebook-locales`, `lodash.memoize` for emoji | Remove with the locale-cookie and emoji helpers. |
| `is-online`, `p-wait-for`, `element-ready` | Replace startup polling and brittle waits with native load-failure handling and scoped DOM observers. Connectivity retry timers must not depend on a suspended page. |
| `np`, `patch-package`, Electron-specific lint/config dependencies | Replace release tooling and remove obsolete patches/config as the Tauri scaffold lands. Retain useful TypeScript/CSS checking. |

## Verified upstream behavior

Checked published crate source rather than assuming behavior from API names. Versions reported by crates.io during this audit:

| Component | Version | Evidence and result |
| --- | --- | --- |
| Tauri | 2.12.1 | [Tray source](https://docs.rs/crate/tauri/2.12.1/source/src/tray/mod.rs): `TrayIconEvent` explicitly says Linux is unsupported and events are not emitted. Linux tooltip and left-click-menu configuration are also unsupported. |
| Tauri | 2.12.1 | [Webview-window source](https://docs.rs/crate/tauri/2.12.1/source/src/webview/webview_window.rs): document initialization, additional Windows browser args, data directory, downloads, new-window handling and native webview access exist. `background_throttling` explicitly does **not** support Windows or Linux. |
| Tauri runtime / Wry | 2.12.1 / 0.57.0 | [Runtime source](https://docs.rs/crate/tauri-runtime-wry/2.12.1/source/src/lib.rs) and [WebView2 implementation](https://docs.rs/crate/wry/0.57.0/source/src/webview2/mod.rs): native-window hide and webview hide are separate paths. Wry webview hide calls `SetIsVisible(false)`. No `TrySuspend` call was found in the inspected WebView2 module. Parent-window hide alone must not be described as explicit suspension without runtime evidence. |
| Wry | 0.57.0 | [WebKitGTK implementation](https://docs.rs/crate/wry/0.57.0/source/src/webkitgtk/mod.rs): webview visibility maps to GTK show/hide; user scripts are injected at document start. No equivalent supported cross-platform background-throttling switch was established. |
| Notification plugin | 2.5.1 | [Desktop source](https://docs.rs/crate/tauri-plugin-notification/2.5.1/source/src/desktop.rs): desktop action options are ignored; `show()` dispatches and discards the native handle. It does not wire desktop notification activation callbacks. Use the requested native alternatives. |
| Windows notifications | 0.8.1 | [tauri-winrt-notification source](https://docs.rs/crate/tauri-winrt-notification/0.8.1/source/src/lib.rs): `Toast::on_activated` registers an activation handler in `show`. Need to verify installed-app Action Center behavior and notification lifetime; this is not proof of activation after process termination. |
| Linux notifications | 4.18.1 | [notify-rust source](https://docs.rs/crate/notify-rust/4.18.1/source/src/xdg/mod.rs): notification handles expose action waiting. Register the default action, retain the handle and process actions outside the UI thread. Desktop notification server capabilities still matter. |
| Store | 2.5.0 | [Store source](https://docs.rs/crate/tauri-plugin-store/2.5.0/source/src/store.rs): Rust get/set/save APIs exist. Prefer a narrow app settings command to direct remote store permissions. |
| Autostart / single instance / window state | 2.7.0 / 2.5.2 / 2.5.0 | Published sources expose enable/disable/state, second-instance callback and window-state save/restore, respectively. Use Rust access rather than broad frontend permissions. |
| Opener | 2.7.0 | [Source](https://docs.rs/crate/tauri-plugin-opener/2.7.0/source/src/lib.rs): Rust `open_url` and `open_path` exist. Validate before calling them. |
| Updater | 2.13.1 | [Updater source](https://docs.rs/crate/tauri-plugin-updater/2.13.1/source/src/updater.rs): check/download/install and signature verification exist. Release signing/key setup remains required; no placeholder public key or unsigned updater is acceptable. |
| Tauri bundler | 2.10.1 | [Published NSIS template](https://docs.rs/crate/tauri-bundler/2.10.1/source/src/bundle/windows/nsis/installer.nsi): Start Menu shortcuts use `SetLnkAppUserModelId`. Verify shortcut creation is mandatory for notification identity and matches the toast/process ID in the final installer. |

[Tauri capabilities documentation](https://v2.tauri.app/security/capabilities/) explicitly notes that app commands registered with `invoke_handler` are available by default unless an app command manifest is used to constrain them. A `remote.urls` entry by itself is insufficient evidence that every custom command is restricted. Register command permissions explicitly, use `local: false`, exact `https://www.messenger.com` remote scope and the main webview label, and check the invoking webview/origin in sensitive Rust handlers. Do not grant wildcard core, filesystem, shell, opener, store, updater or window-creation permissions to remote content. Test denial from local pages, other origins, subdomains and call windows.

[MDN's service-worker global documentation](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope) identifies the worker's separate global execution context. [showNotification](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification) is available inside that context too. Patching the page prototype cannot affect it. Do not replace worker scripts or claim page interception covers push handlers.

### Native notification hook verification after the user's decisions

| Requirement | Verified behavior and implication |
| --- | --- |
| Windows native interface | [`ICoreWebView2_24`](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_24) introduces `add_NotificationReceived`. Stable since SDK **1.0.2739.15**. The current Win32 and .NET documentation both explicitly say **non-persistent notifications**. It is not a persistent/service-worker notification hook. |
| Runtime minimum | [SDK 1.0.2739.15 release notes](https://learn.microsoft.com/en-us/microsoft-edge/webview2/release-notes/sdk/1-0-2739-15) require **WebView2 Runtime 128.0.2739.15 or later** for full API compatibility. Set at least this installer minimum when implementing the hook and still query/cast the interface at startup. The installed Evergreen runtime directory is **154.0.4258.53**, above that floor. Actual COM interface registration remains untested. |
| Suppress the WebView2 toast | [`ICoreWebView2NotificationReceivedEventArgs::put_Handled(TRUE)`](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2notificationreceivedeventargs#put_handled) suppresses the default UI. The host must also report shown/clicked/closed through the native notification object; mark handled before calling those methods. Capture the native object and subscription lifetime on the appropriate thread. |
| Avoid blocking Messenger | Microsoft documents that scripts following `new Notification()` remain blocked until the handler returns, or a deferral completes. Capture/route quickly; do not wait in this handler for frontend metadata, avatar downloads or user interaction. |
| Linux signal | [`WebKitWebView::show-notification`](https://webkitgtk.org/reference/webkit2gtk/stable/signal.WebView.show-notification.html) has existed since WebKitGTK **2.8**. The default libnotify handler runs after connected handlers. Returning **TRUE** stops subsequent handlers, allowing Caprine to own presentation. These signal docs do not establish persistent/service-worker coverage; that remains a source/runtime verification item. |
| Metadata and diagnostics | The page constructor patch must record metadata and then call the real constructor; the page `showNotification` patch must record metadata and call the real method. Native events correlate with recent metadata by tag/title/time. A title match alone never deduplicates messages. Native events without metadata are logged as uncorrelated, not assigned to the current conversation. Absence of such events cannot prove no worker notifications occurred. |

The Windows hook is usable for the documented non-persistent path, but **it cannot fulfill the proposed service-worker coverage diagnostic on its own**. The user's subsequent registration/controller measurement closes the current gap as not applicable; it does not broaden the native API's coverage. No worker workaround has been implemented.

## Proposed retained architecture

`src-tauri/` owns settings validation/store, window lifecycle, native notifications, tray/overlay, URL validation, downloads, permission decisions, connectivity retry, logging and updater. It creates a main external webview for `https://www.messenger.com`, with a persistent non-incognito profile. New Tauri sessions will need their own login; copying Electron cookie files into WebView2/WebKitGTK is not a supported session migration. Existing Electron profile data must remain untouched.

`src/inject/` bundles to one document-start script. It contains the collector, centralized semantic selectors, title/sidebar unread observers, active-thread reporting, retained shortcuts, settings drawer, style injection, link handling and video behavior. The existing panel is adapted, not replaced by a native menu. Its dropped settings and corresponding CSS are deleted.

The collector should forward current native `Notification.permission` through a getter and bind `requestPermission` to the real constructor. Observe both page APIs before Messenger caches them, preserve their native behavior, and log the actual bounded `tag`/`data` shapes when debug logging is enabled. Page patches supply metadata; native engine hooks own primary presentation. Do not invent a thread ID from the currently open thread when the event does not identify its conversation.

Primary events must never be suppressed merely because their body matches earlier text. Cross-source arbitration needs a short thread-based window and tests for primary-first and fallback-first ordering, two real identical messages, several rapid messages in one thread, and overlapping threads. Unknown thread IDs are an explicit diagnostic state, not a text-based dedupe escape hatch. A sidebar that does not expose a stable message identifier cannot perfectly distinguish a repeated identical message from a rerender; primary event coverage remains essential.

Rust suppresses only when notifications are muted, or the main window is focused and the event's known thread is the active thread. Preview-off body is exactly `You have a new message`. Activation restores/focuses main and navigates to a validated Messenger thread URL; it must work for conversations absent from the currently virtualized sidebar. A single notification should have one owner throughout delivery and activation.

Title changes and sidebar state feed one unread-count reducer; title counts take priority over the visible subset of a virtualized sidebar. Do not count arbitrary numbers in navigation aria-labels as unread messages. No badge polling interval. Avoid replaying initial unread rows as new messages after login or reload.

On Windows, use the requested `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` arguments and instrument controller visibility. Avoid `Webview::hide` for tray behavior if it makes the controller invisible. Whether native-window hide/minimize meets delivery latency remains a runtime test, including Messenger's own use of page visibility. On Linux, native GTK/WebKit policy and Messenger behavior require the same measurements; a generic Tauri throttling flag is not a solution.

Debug notifications defaults off. When on, append bounded structured records in app data for source, thread ID, event time, decision/reason, native delivery errors and activation. Log normalization/dedupe decisions as well as backend suppression. Do not delay dispatch while waiting for an avatar.

## Deletion and settings plan

Delete the Electron entry points and IPC code after each replacement lands; delete `source/menu.ts`, `menu-bar-mode.ts`, `touch-bar.ts`, `emoji.ts`, spell-check language selection and related types. Remove Work Chat, private mode, receipt/typing blocking, message-button toggles, inline reply, menu commands, conversation-navigation integrations and `dpr` interception.

Delete `css/vibrancy.css` and `css/workchat.css`, private-mode/sidebar-command/message-button/macOS rules in remaining styles, vibrancy code-block overrides, emoji/language-picker settings CSS and obsolete autoplay placeholder styles if the implementation changes. Preserve/adapt theme, code-block, scrollbar and settings styles.

Delete macOS entitlements, `.icns`, DMG backgrounds, `IconMenuBar*`, emoji assets and screenshots documenting removed/macOS features. Review the remaining old screenshots before using them in the new README. Keep the MIT license and retained Windows/Linux branding. Remove old Electron patches, RPM packaging, external APT installer, macOS release jobs and obsolete scripts. Regenerate the dependency lockfile after the scaffold.

Retained config: theme, zoom, window state, always-on-top, launch-at-login, launch-minimized, quit-on-close, notification mute/preview, unread badge, flash-on-message, autoplay and auto-update. Add debug-notifications. Hardware acceleration is conditional on verified platform implementation. Spell checking and ringtone mute are conditional and have not been claimed supported or silently replaced. Tray availability must not be switchable off while the window can close into it. Session persistence comes from the webview profile rather than a fragile login-checkbox selector.

## Build environment and acceptance status

Node 24.19.0, npm 12.0.2, Git and Python are available. After the user's installation, rustup reports a default stable `x86_64-pc-windows-msvc` toolchain, with **rustc 1.99.0**. The C++ workload is found by `vswhere` in **Visual Studio 2022 Community**. Cargo/rustc are available under the user's `.cargo/bin`; this existing agent process has not inherited that directory in PATH, so commands must add it per process or use absolute paths. The earlier missing-Windows-toolchain blocker is resolved. Linux runtime testing still needs another host.

The phase-2 scaffold replaced the Electron build with Tauri 2.12.1, one document-start injection bundle, an exact-origin remote capability, registered app-command ACLs and a non-incognito profile under the platform app-local-data directory. `bootstrap`, `open_external` and the subsequent `log_service_worker_inventory` diagnostic were exposed. Account-authentication routes may navigate inside the webview, but receive no Caprine IPC. The retained CSS and custom.css are injected; a custom.css read error is reported without blocking base styling or diagnostics. Single-instance handling and validated external links were included. At phase 2, closing exited the app; phase 3 changes this as documented below.

`.github/workflows/build.yml` checks TypeScript/injection security, Rust formatting, tests and clippy, then builds native binaries on Windows and Ubuntu 24.04 for every push to `tauri`. Cargo flags require a separate argument delimiter with this Tauri CLI: `npm run build:app -- -- --locked`. Installer and signed release jobs remain phase 5.

The first push of scaffold commit `200b670` passed **both Windows and Linux CI jobs**, including all checks, native release builds and artifact uploads: [GitHub Actions run 37190754694](https://github.com/visnia/caprine/actions/runs/37190754694). CI compiles and tests Linux; it does not exercise an authenticated Linux desktop session.

Scaffold verification at `200b670`: `npm test` passed two injection/capability checks; `cargo test` passed three URL-policy tests; `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` passed. `npm run build:app -- -- --locked` succeeded on Windows and produced `src-tauri/target/release/caprine.exe` (10,190,848 bytes). These checks do not establish runtime IPC denial or account persistence. The Windows UI helper was unavailable (`failed to connect native pipe`, OS error 2, reproduced on retry), and browser tools reported `Browser is not available: edge`. Subsequent user verification establishes login persistence and the zero-registration/null-controller observations recorded above. Actual notification-source tracing remains unmeasured. No worker blocking, interception or script modification has been implemented.

The release executable was launched successfully; its process reported a responding Caprine window and the configured WebView2 profile directory was created. On 2026-10-04 the user completed the requested sign-in/close/reopen check and reported **“I stay signed in”**. Windows authenticated restart persistence is therefore user-verified. CSS appearance and Linux runtime/persistence remain unverified. Other runtime completion criteria also remain open: matching badges, no duplicate notifications, timely tray/30+ minute idle delivery, correct activation and working calls. Build results are recorded separately from these acceptance checks.

## Phase 3 — settings, tray and unread badge

Implemented the retained settings drawer in `src/inject/settings-panel.ts` with its original layout and gear asset, using narrow Tauri commands. Ctrl+, opens it; Ctrl+= / Ctrl+- / Ctrl+0 persist zoom. The Rust settings model validates theme, zoom bounds and boolean values and rejects dropped/unknown settings. `tauri-plugin-store` owns `settings.json` under the new identifier. Native settings changes precede persistence; failed saves attempt native/store rollback and the panel reloads the backend state. The OS autostart entry is queried on startup to reflect external changes. Debug diagnostics can be enabled or disabled live.

Phase 3 exposes only implemented settings: theme, zoom, always on top, launch at login, launch minimized, quit on close, numeric unread badge and debug notifications. Notification mute/preview/flash, autoplay, updater and conditionally feasible platform controls belong to later phases. The panel can open only the fixed custom.css path, relaunch, quit, or open validated web links. The main Messenger capability gains four allowlisted commands and core event listen/unlisten; no remote store, filesystem, opener, autostart or window permissions are granted.

Native tray actions are Show / Quit. Windows left-click toggles; Linux follows its native menu behavior. Closing defaults to parking the window. On Windows this saves geometry, minimizes the native HWND and removes its taskbar entry; it never calls `Webview::hide` or `TrySuspend`. Wry 0.57.0's `WM_SIZE` handler ignores `SIZE_MINIMIZED` for resize and does not call `SetIsVisible(false)` on that path. The initial builder's `visible(false)` affects the native window, not the child webview. Linux hides the native window; no unsupported throttling override was invented. Actual visibility behavior and notification latency remain runtime checks.

Window-state 2.5.0 restores/saves main-window size, position and maximization, excluding visibility and minimization so a saved hidden state cannot trap startup. Its published source resolves the file under app_config_dir, saves on exit and excludes minimized geometry updates. Tauri's native theme setter and zoom setter were verified in 2.12.1 source; Windows ThemeChanged reaches Wry's preferred color scheme. Built-in zoom hotkeys are disabled so the injected shortcuts own persistence. The window is restored by Show, tray toggle and single-instance activation.

Unread state comes from title/sidebar MutationObservers without an interval. Title counts take precedence over the visible sidebar subset. Centralized selectors use navigation/grid/list roles and accessible English/Polish unread labels, excluding menu/button actions; they do not use obfuscated classes, font weight or SVG paths. Distinct thread hrefs are counted once. Windows uses a generated taskbar overlay capped at `99+` and a full-count tray tooltip. Linux uses a tray title where supported; tooltip and custom click handling are unsupported by Tauri on Linux. The read/unread icon remains active when the numeric badge setting is off.

Deleted the legacy Electron `source/`, native menus, macOS/emoji/Work Chat assets, packaging patches and obsolete screenshots/styles. Retained Windows/Linux icons were copied into `src-tauri/icons`. The historical audit above describes the removed baseline; it is not a list of current runtime modules.

Validation on 2026-10-04: 13 JavaScript tests and eight Rust tests passed, along with TypeScript checking, Rust formatting and clippy with warnings denied. Tests exercise queued settings writes, recovery after failed writes, virtualized title/sidebar counts, accessible-label exclusions and observer-driven updates. Windows debug and release/NSIS builds succeeded. A local browser fixture using the real panel modules confirmed light/dark layout, zoom/toggle updates, visible action errors and Escape/focus restoration; native actions in that fixture are explicitly simulated. The preview exposed an opening-animation focus issue and an aria-hidden warning; focus ordering and the visibility transition were corrected before the phase commit.

The native Windows UI helper remained unavailable (`OS error 2`). The user manually tested the phase-3 Windows debug build and reported **PASS** for fresh-profile sign-in and persistence after quit/relaunch, Ctrl+, and the trimmed settings panel, theme and zoom persistence across restart, Ctrl+0 reset, close-to-tray, Windows tray left-click restore/toggle, and single instance. **Unread taskbar overlay and tray badge remain PENDING**, to be checked together with phase-4 notifications. Autostart and window geometry persistence were not included in that report. Linux desktop acceptance needs a Linux host. No notification delivery, calls or 30-minute idle acceptance is claimed for phase 3.

## Phase 4 — native notification ownership

Implemented `src/inject/collector.ts` at document start, before DOM readiness. Its Notification proxy keeps the native prototype, live permission getter and bound requestPermission callback/promise behavior. Construction is native; successful invocations submit metadata after the native handler returns. The page showNotification wrapper preserves its receiver, result and rejection and submits metadata on success. Neither page hook presents a toast. Thread IDs come from explicit data/tag fields, thread URLs, or a unique matching sidebar title's href; unknown identities remain unknown. Bounded actual tag/data values are recorded only with debug logging enabled. Sidebar snapshots baseline initial/unseen virtualized rows and emit unread transitions or changed unread previews.

The main webview starts at about:blank with no IPC permission, installs native hooks, then navigates to Messenger. Windows casts to `ICoreWebView2_24`, calls SetHandled(true), and keeps notification objects on the UI thread for ReportShown/ReportClicked/ReportClosed and CloseRequested handling. It records runtime version and controller visibility. Linux connects `WebKitWebView::show-notification`, retains its Notification and returns true to stop the default handler. Tauri 2.12.1/Wry 0.57.0 permission-handler sources were checked: notification permission requests on the main Messenger page are granted natively; the JS permission API is not spoofed. Other permission types remain for the later calls phase.

A Rust worker owns correlation, scheduling and decisions, so its 250 ms metadata grace period and 1.2 s sidebar fallback delay are independent of page timers. Metadata is consumed once by tag/title and a three-second arrival window; title-only ambiguity between different known threads remains uncorrelated. Cross-source arbitration uses a four-second thread window. A fallback that already presented gets only one credit against a late primary; additional real primary events remain eligible even if their content is identical. Suppressed fallback candidates never claim presentation. Unknown native threads are displayed rather than incorrectly suppressed as the current chat. Post-phase review fix: a primary with an unknown thread could previously be followed by a sidebar fallback for the same message, because it recorded no thread. Any unknown-thread primary now blocks sidebar fallbacks for the four-second window (`recent_unknown_primary`); it never suppresses another primary and does not compare text.

At delivery, native window focus and its current validated Messenger URL determine the active thread. Only global mute or focused-same-known-thread suppresses an otherwise eligible message. Preview-off body is exactly `You have a new message`. Windows flashing follows its setting when unfocused; parked windows have no taskbar button. Activation restores/focuses the window and navigates to the validated stored /t/ or /e2ee/t/ URL, including virtualized conversations. Unknown destinations restore only and are an explicit acceptance failure to investigate, not a guessed navigation.

Desktop delivery uses tauri-winrt-notification 0.8.1 and notify-rust 4.18.1, after checking their published source. The Windows crate has a documented local `show_with_handle` extension because upstream discards ToastNotification; this retains callbacks/handles and permits native closure. Its existing XML/event implementation is unchanged. Banner timeout does not discard activation state; user cancellation or engine CloseRequested retires it. Live ownership is capped at 256 entries. Linux retains the notification handle while awaiting its default action or a close request asynchronously, off the UI thread. Click-after-process-exit activation is not implemented; running-in-tray Action Center activation is the acceptance target. Native submission success is logged separately from actual user-observed display.

NSIS now creates a mandatory fork Start Menu shortcut even when optional shortcut creation is disabled. Debug builds create `Visnia/Caprine (Visnia) Debug.lnk` using IShellLinkW/IPropertyStore, with the configured AUMID, so an uninstalled debug executable can be tested without borrowing Electron's identity. No old profile data is migrated. PNG avatars are accepted only as bounded data URLs and decoded/dimension-checked before writing app-owned cache files; avatars never gate event collection. Unavailable/cross-origin avatars fall back to the app's icon.

Validation so far: 17 JavaScript tests, 12 Rust tests, TypeScript checking and Windows clippy with warnings denied pass. Windows debug and release/NSIS builds succeed. Tests cover live permission and prototype behavior, native exceptions, showNotification receiver/rejection behavior, repeated identical primary events, cross-source order, different threads, ambiguous metadata, invalid destinations, focused-other-thread policy and virtualized sidebar baselines. The native Windows UI helper was retried and still returns OS error 2. Real Messenger metadata, visible toast/click behavior, matching badges, hidden-to-tray latency, 30+ minute idle delivery and Linux runtime remain pending. Use [the single combined checklist](notification-verification.md) for those checks; do not infer them from build success. The measured worker gap remains not applicable currently; no worker-specific workaround was added.

Continue with the requested commit sequence; the worker constraint does not block phases 2–3:

1. This audit commit.
2. Scaffold and verify Messenger loading, CSS injection and persistent login.
3. Tray, badge, Windows overlay, settings/config.
4. Collector, native notification backends and focused-thread delivery policy.
5. Remaining retained features, signed updater, Windows NSIS/Linux AppImage/deb release workflow.
6. Rewrite README for the implemented and tested scope.

Tests must cover collector ordering and permission forwarding, unknown IDs, repeated identical messages, unread virtualized lists, active-versus-other conversation focus, IPC origin denial, URL unwrapping, persisted settings and invalid settings. Installed Windows and real Linux desktop tests must cover Action Center/D-Bus activation, real attachments, calls and device permission denial, offline startup/recovery, restart login, single instance, and timed delivery after at least 30 minutes idle. Build success alone cannot establish these acceptance criteria.
