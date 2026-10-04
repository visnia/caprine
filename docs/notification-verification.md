# Combined badge and notification verification

Windows phase-3 sign-in persistence, settings/theme/zoom, Ctrl+0, close-to-tray, tray toggle and single instance passed the user's manual test on 2026-10-04. Badge and notification acceptance remains pending. Build results do not establish delivery latency or visible toast behavior.

## Setup

Quit any running Tauri Caprine using its tray menu, then open the latest `src-tauri/target/debug/caprine.exe`. Debug startup creates `Visnia/Caprine (Visnia) Debug.lnk` in the current user's Start Menu with AUMID `com.visnia.caprine`. Release installation creates its own required shortcut with that AUMID. Electron Caprine keeps its separate identity.

In **Ctrl+,**, enable **Debug notifications**, **Unread badge**, **Message preview** and **Flash taskbar**; disable **Mute notifications** and **Quit on window close**. Enable Messenger's desktop notifications if its UI offers that option. Keep OS notifications enabled and Do Not Disturb off for timing tests. Quit Electron Caprine and other Messenger apps/tabs that can produce competing desktop toasts. Use two conversations, A and B, with another account/person sending incoming messages. Record send time, toast time, unread count and click destination.

## Checklist

| Check | Action | Expected |
| --- | --- | --- |
| Read baseline | Read all test conversations; reload/restart. | Read tray icon, no overlay. No replay of existing unread rows as new messages. |
| Badge accuracy | Receive in A and B while another app is foreground. Read one, then both. | Count follows Messenger's title count; tray and overlay update without reloading. Multiple messages in one unread chat need not increase the unread-chat count. |
| Focused, other thread | Focus Caprine on A; receive in B. | Exactly one notification; clicking opens B. |
| Focused, same thread | Focus Caprine on A; receive in A. | No toast or flashing for that message. |
| Background window | Keep Caprine behind another app; receive in A. | Exactly one toast within a few seconds. Taskbar flashes when enabled; clicking focuses A. |
| Hidden to tray | Close into the tray; receive in A and B. | Timely notifications with no sidebar copies; unread tray state changes. Clicking restores the correct conversation; overlay is correct when the taskbar entry returns. |
| Repeated content | Send identical text twice within 30 seconds; then several quick messages in A and one in B. | Separate Messenger primary notifications are not swallowed by text dedupe. No extra sidebar copies. Messenger may group messages itself; compare source logs. |
| Action Center | Let a banner time out while Caprine stays running in the tray; click its history entry. Also dismiss an entry manually. | Clicking still opens the correct conversation. Dismissed entries do not reappear. |
| Preview and mute | Disable preview and receive; then enable mute and receive again. | Preview-off body is exactly `You have a new message`. Mute suppresses toast/flashing; badges still update. |
| Flash toggle | Disable/re-enable flashing while receiving with another app focused. | Toasts still arrive; flashing follows the setting. There is no taskbar button to flash while parked in the tray. |
| 30+ minute idle | Leave Caprine in the tray, computer awake and connected, for at least 30 minutes. Receive in A and B without first opening Caprine. | Each primary notification arrives within a few seconds, without duplicates. Click destination and restored badge are correct. Record actual latency. |
| Restart regression | Quit/relaunch, then receive a new message. | Login/settings persist; new messages notify normally without replaying old sidebar unread rows. |

Repeat on a real Linux desktop. Linux left-click opens the Show / Quit tray menu; numeric tray titles depend on the desktop. There is no Windows overlay/flash control. Check popup actions and the desktop's notification history where supported. CI does not exercise a Linux desktop session.

## Logs

Windows: `%APPDATA%\com.visnia.caprine\notifications.jsonl`. Linux: `$XDG_DATA_HOME/com.visnia.caprine/notifications.jsonl`, defaulting to `~/.local/share`. Rotation keeps one `.jsonl.1` backup at 1 MiB.

- `notification` / `showNotification`: page metadata, including bounded actual `tag` and serialized `data`; these records never present another toast.
- `webview2` / `webkitgtk`: native owner. Correlation records include `metadataSource`, `eventId` and `threadId` when known. Investigate `uncorrelated_native` for normal messages.
- `sidebar`: fallback candidate. `recent_primary_for_thread`, `recent_unknown_primary` or `fallback_already_owned_one_event` explains cross-source suppression. Manually marking a chat unread can create a sidebar candidate; report whether that produces a toast. Separate primary events are never deduped by text.
- `show` / `suppress`: backend decision with focused/active-thread evidence. `winrt` / `notify-rust` `submitted` means the API accepted the toast, not proof it appeared on screen. Errors are logged separately.
- `activation`: click and destination. Unknown threads restore the window without guessing a conversation; that does not pass correct-thread acceptance.
- `webview2State`: runtime version and actual controller visibility, sampled on installation, enabling debug logging and tray park/restore. Expect `controllerVisible: true` in the tray. No `TrySuspend` is used.
- `serviceWorkerInventory`: startup/hourly count and controller. Zero/null is the measured result. A nonzero count reopens the worker investigation.

Debug logs may contain conversation titles, IDs and Messenger-provided metadata. Redact private content when sharing diagnostic records. Disable debugging after verification.

## Limits

WebView2's hook is non-persistent-only. With no registered workers in the measured session, the worker gap is currently not applicable. No worker blocking or script interception exists. The sidebar cannot reconstruct identical messages from an unchanged preview or unseen virtualized rows; native coverage remains essential.

Click callbacks are retained while Caprine runs. Opening a historical toast's conversation after quitting/restarting the process is not implemented; the running-in-tray Action Center check above is separate. Linux history behavior depends on the notification server. Calls, downloads, offline recovery and signed updates remain later work.
