import {app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {MESSENGER, zoomStep, type MessageNotice, type Settings} from '../shared';
import {changed, loadSettings, saveSettings, setLaunchAtLogin} from './settings';
import {installTitleBar, titleBarHeight, titleBarOptions} from './title-bar';
import {createTray} from './tray';
import {createUpdater} from './updates';
import {configureSession, guard, isMessenger, openExternal} from './web';

// Development runs keep their own profile, settings, lock and autostart entry.
const id = app.isPackaged ? 'com.visnia.caprine' : 'com.visnia.caprine.dev';
app.setPath('userData', path.join(app.getPath('appData'), id));
// Matches the Start Menu shortcut's AppUserModelID, which Windows notifications need.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? id : process.execPath);
if (!app.requestSingleInstanceLock()) app.exit();

fs.mkdirSync(app.getPath('userData'), {recursive: true});
let settings = loadSettings();
if (!settings.hardwareAcceleration) app.disableHardwareAcceleration();
Menu.setApplicationMenu(null);

const userFile = (name: string) => path.join(app.getPath('userData'), name);
const appIcon = path.join(app.getAppPath(), 'icons', 'icon.png');
let quitting = false;
app.on('before-quit', () => { quitting = true; });

type WindowState = Rectangle & {maximized: boolean};
function savedWindowState(): Partial<WindowState> {
	try {
		const state = JSON.parse(fs.readFileSync(userFile('window.json'), 'utf8')) as WindowState;
		// A window saved on a display that is gone opens at the default position.
		const visible = screen.getAllDisplays().some(({workArea: area}) => state.x < area.x + area.width && state.x + state.width > area.x
			&& state.y < area.y + area.height && state.y + state.height > area.y);
		return visible ? state : {width: state.width, height: state.height, maximized: state.maximized};
	} catch {
		return {};
	}
}

app.whenReady().then(() => {
	const state = savedWindowState();
	const window = new BrowserWindow({
		title: 'caprine',
		width: state.width ?? 1000,
		height: state.height ?? 720,
		x: state.x,
		y: state.y,
		minWidth: 400,
		minHeight: 300,
		show: false,
		icon: appIcon,
		alwaysOnTop: settings.alwaysOnTop,
		...titleBarOptions,
	});
	// Messenger fills the window below the title bar.
	const view = new WebContentsView({
		webPreferences: {
			preload: path.join(import.meta.dirname, 'preload.cjs'),
			sandbox: true,
			contextIsolation: true,
			spellcheck: true,
			// Keep detecting messages while the window is hidden in the tray.
			backgroundThrottling: false,
			zoomFactor: settings.zoomFactor,
		},
	});
	window.contentView.addChildView(view);
	const {webContents: contents} = view;
	const layout = () => {
		const [width = 0, height = 0] = window.getContentSize();
		const top = window.isFullScreen() ? 0 : titleBarHeight;
		view.setBounds({x: 0, y: top, width, height: height - top});
	};
	for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) window.on(event as 'resize', layout);
	layout();
	window.on('focus', () => contents.focus());
	const paintTitleBar = installTitleBar(window, () => settings.theme);
	contents.on('page-title-updated', (_, title) => {
		window.setTitle(title);
		paintTitleBar();
	});
	const send = (channel: string, ...args: unknown[]) => { if (!window.isDestroyed()) contents.send(channel, ...args); };
	const show = () => {
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	};
	const quit = () => { quitting = true; app.quit(); };
	app.on('second-instance', show);
	app.on('web-contents-created', (_, created) => guard(created));
	guard(contents);

	// References keep click handlers alive until the notification is gone.
	const shown = new Set<Notification>();
	const notify = (options: Electron.NotificationConstructorOptions, click: () => void) => {
		const notification = new Notification({icon: appIcon, ...options});
		shown.add(notification);
		notification.on('click', () => { shown.delete(notification); click(); });
		notification.on('close', () => shown.delete(notification));
		notification.show();
	};
	const notice = (title: string, body: string, click: () => void) => notify({title, body, silent: settings.notificationSound === 'off'}, click);

	configureSession(contents.session, (file, name) => {
		if (file) notice('Download complete', name, () => shell.showItemInFolder(file));
		else notice('Download failed', name, show);
	});

	const tray = createTray(window, () => settings, show, quit);
	const updater = createUpdater({
		enabled: () => settings.autoUpdate,
		changed: status => send('update-status', status),
		ready: version => notice('Update ready', `Version ${version} installs when you restart Caprine. Click to restart now.`, () => updater.install()),
		beforeInstall: () => { quitting = true; },
	});

	const apply = () => {
		nativeTheme.themeSource = settings.theme === 'oled' ? 'dark' : settings.theme;
		paintTitleBar();
		window.setAlwaysOnTop(settings.alwaysOnTop);
		contents.setZoomFactor(settings.zoomFactor);
		contents.session.setSpellCheckerEnabled(settings.spellCheck);
		tray.render();
		send('settings', settings);
	};
	const update = (key: keyof Settings, value: unknown) => {
		const next = changed(settings, key, value);
		if (key === 'launchAtLogin') setLaunchAtLogin(next.launchAtLogin);
		saveSettings(next);
		settings = next;
		apply();
		return settings;
	};
	apply();
	// Windows uses its own spell checker; elsewhere, Hunspell dictionaries for
	// the system languages are downloaded on demand.
	if (process.platform !== 'win32') {
		const available = contents.session.availableSpellCheckerLanguages;
		const languages = app.getPreferredSystemLanguages().flatMap(language => [language, language.split('-')[0]!]).filter(language => available.includes(language));
		if (languages.length > 0) contents.session.setSpellCheckerLanguages([...new Set(languages)].slice(0, 3));
	}

	// IPC is only for the main window while it shows Messenger.
	const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === contents && isMessenger(event.senderFrame?.url ?? '');
	const handle = (channel: string, listener: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => {
		if (!trusted(event)) throw new Error('Caprine IPC is only available to Messenger');
		return listener(...args);
	});
	const on = (channel: string, listener: (...args: any[]) => void) => ipcMain.on(channel, (event, ...args) => { if (trusted(event)) listener(...args); });
	// Messenger's call popups load the same preload; only the main window integrates.
	ipcMain.on('is-main-window', event => { event.returnValue = event.sender === contents; });
	handle('bootstrap', () => {
		let customCss = '';
		try { customCss = fs.readFileSync(userFile('custom.css'), 'utf8'); } catch {}
		return {settings, customCss, version: app.getVersion(), platform: process.platform, updateStatus: updater.status()};
	});
	handle('update-setting', update);
	handle('action', (action: string) => {
		if (action === 'customCss') {
			fs.appendFileSync(userFile('custom.css'), '');
			return shell.openPath(userFile('custom.css'));
		}
		if (action === 'relaunch') {
			app.relaunch({args: process.argv.slice(1).filter(arg => arg !== '--autostart')});
			quit();
		}
		if (action === 'quit') quit();
		if (action === 'checkUpdate') updater.check();
		if (action === 'installUpdate') updater.install();
		if (action === 'sourceCode') openExternal('https://github.com/visnia/caprine');
		if (action === 'reportIssue') openExternal('https://github.com/visnia/caprine/issues');
	});
	on('unread', (count: unknown, badge: unknown) => {
		if (!Number.isSafeInteger(count) || (count as number) < 0) return;
		tray.setUnread(count as number, typeof badge === 'string' && badge.startsWith('data:image/png;base64,') ? badge : null);
	});
	on('message', async (message: MessageNotice) => {
		if (!settings.notifications || window.isFocused()) return;
		let icon: Electron.NativeImage | undefined;
		const iconUrl = URL.parse(String(message.iconUrl));
		if (iconUrl?.protocol === 'https:' && iconUrl.hostname.endsWith('.fbcdn.net')) {
			try {
				const response = await contents.session.fetch(iconUrl.href, {signal: AbortSignal.timeout(2000)});
				icon = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
			} catch {} // Never delay delivery for an avatar.
		}
		notify({
			title: String(message.title).slice(0, 256),
			body: settings.notificationPreview ? String(message.body).slice(0, 2048) : 'You have a new message',
			// Only one of Messenger's tone and the platform sound plays.
			silent: settings.notificationSound !== 'system',
			...(icon && !icon.isEmpty() ? {icon} : {}),
		}, () => {
			show();
			if (message.threadUrl && isMessenger(message.threadUrl)) send('open-thread', message.threadUrl);
		});
		if (settings.flashTaskbar) window.flashFrame(true);
	});

	window.on('focus', () => window.flashFrame(false));
	contents.on('before-input-event', (event, input) => {
		if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return;
		if (input.key === 'F12' || (input.control && input.shift && input.code === 'KeyI')) {
			if (contents.isDevToolsOpened()) contents.closeDevTools();
			else contents.openDevTools({mode: 'detach'});
			return event.preventDefault();
		}
		if (!input.control || input.alt || input.meta) return;
		const zoom = {Equal: 'in', NumpadAdd: 'in', Minus: 'out', NumpadSubtract: 'out', Digit0: 'reset', Numpad0: 'reset'}[input.code] as 'in' | 'out' | 'reset' | undefined;
		if (zoom) update('zoomFactor', zoomStep(settings.zoomFactor, zoom));
		else if (input.code === 'Comma') send('toggle-settings');
		else if (input.code === 'KeyR') contents.reload();
		else return;
		event.preventDefault();
	});

	// When Messenger cannot load, show a retry page and retry with backoff.
	let attempt = 0;
	let retry: NodeJS.Timeout | undefined;
	contents.on('did-fail-load', (_, code, description, url, mainFrame) => {
		if (!mainFrame || code === -3 || !isMessenger(url)) return; // -3: aborted by another navigation.
		const delay = [2, 5, 10, 30, 60][Math.min(attempt++, 4)]!;
		void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlinePage(url, description, delay))}`);
		clearTimeout(retry);
		retry = setTimeout(() => void contents.loadURL(url), delay * 1000);
	});
	contents.on('did-navigate', (_, url) => {
		if (!isMessenger(url)) return;
		attempt = 0;
		clearTimeout(retry);
		contents.setZoomFactor(settings.zoomFactor);
	});

	window.on('close', event => {
		try {
			fs.writeFileSync(userFile('window.json'), JSON.stringify({...window.getNormalBounds(), maximized: window.isMaximized()}));
		} catch (error) {
			console.error('Could not save the window state', error);
		}
		if (quitting || settings.quitOnWindowClose) {
			quitting = true;
			return;
		}
		event.preventDefault();
		window.hide();
	});
	// Closing the main window quits, even while a call window is open.
	window.on('closed', () => app.quit());

	if (state.maximized) window.maximize();
	// Only the login entry passes --autostart; a manual launch shows the window.
	// Minimized means hidden in the tray, or on the taskbar when closing quits.
	const minimized = process.argv.includes('--autostart') && settings.launchAtLogin && settings.launchMinimized;
	if (!minimized || settings.quitOnWindowClose) window.show();
	if (minimized && settings.quitOnWindowClose) window.minimize();
	void contents.loadURL(MESSENGER);
});

function offlinePage(url: string, reason: string, delay: number): string {
	const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
	return `<!doctype html><meta charset="utf-8"><title>caprine — offline</title>
<style>:root{color-scheme:light dark;font:15px system-ui,sans-serif}body{margin:0;display:grid;place-items:center;min-height:100vh}
main{max-width:28rem;padding:2rem;text-align:center}p{opacity:.8}button{font:inherit;padding:.5rem 1.2rem;border-radius:999px;border:0;background:#0866ff;color:#fff;cursor:pointer}</style>
<main><h1>Messenger is unreachable</h1><p id="reason"></p><p id="countdown"></p><button id="retry">Retry now</button></main>
<script>
let remaining = ${delay};
document.getElementById('reason').textContent = 'Caprine retries automatically. Last error: ' + ${json(reason)};
const tick = () => { document.getElementById('countdown').textContent = remaining > 0 ? 'Next attempt in ' + remaining-- + ' s.' : 'Retrying…'; };
tick();
setInterval(tick, 1000);
document.getElementById('retry').onclick = () => location.replace(${json(url)});
</script>`;
}
