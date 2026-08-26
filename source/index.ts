import path from 'node:path';
import {readFileSync, existsSync, writeFileSync} from 'node:fs';
import process from 'node:process';
import {
	app,
	nativeImage,
	screen as electronScreen,
	session,
	shell,
	BrowserWindow,
	Menu,
	Notification,
	systemPreferences,
	nativeTheme,
} from 'electron';
import {ipcMain as ipc} from 'electron-better-ipc';
import {autoUpdater} from 'electron-updater';
import electronDl from 'electron-dl';
import electronContextMenu from 'electron-context-menu';
import electronLocalshortcut from 'electron-localshortcut';
import electronDebug from 'electron-debug';
import {
	is,
	darkMode,
	debugInfo,
	openNewGitHubIssue,
} from 'electron-util';
import {bestFacebookLocaleFor} from 'facebook-locales';
import updateAppMenu from './menu';
import config, {StoreType} from './config';
import tray from './tray';
import {
	sendAction,
	sendBackgroundAction,
	showAndFocusWindow,
	messengerDomain,
	stripTrackingFromUrl,
} from './util';
import {process as processEmojiUrl} from './emoji';
import ensureOnline from './ensure-online';
import {setUpMenuBarMode, toggleMenuBarMode} from './menu-bar-mode';
import {caprineIconPath} from './constants';
import {getSpellCheckerLanguageOptions} from './spell-checker';
import {
	SettingsPanelAction,
	SettingsPanelState,
	SettingsPanelUpdate,
} from './types';

ipc.setMaxListeners(100);

electronDebug({
	isEnabled: true, // TODO: This is only enabled to allow `Command+R` because messenger.com sometimes gets stuck after computer waking up
	showDevTools: false,
});

electronDl();
electronContextMenu({
	showCopyImageAddress: true,
	prepend(defaultActions) {
		/*
		TODO: Use menu option or use replacement of options (https://github.com/sindresorhus/electron-context-menu/issues/70)
		See explanation for this hacky solution here: https://github.com/sindresorhus/caprine/pull/1169
		*/
		defaultActions.copyLink({
			transform: stripTrackingFromUrl,
		});

		return [];
	},
});

app.setAppUserModelId('com.sindresorhus.caprine');

if (!config.get('hardwareAcceleration')) {
	app.disableHardwareAcceleration();
}

if (!is.development && config.get('autoUpdate')) {
	(async () => {
		const FOUR_HOURS = 1000 * 60 * 60 * 4;
		setInterval(async () => {
			await autoUpdater.checkForUpdatesAndNotify();
		}, FOUR_HOURS);

		await autoUpdater.checkForUpdatesAndNotify();
	})();
}

let mainWindow: BrowserWindow;
let isQuitting = false;
let previousMessageCount = 0;
let hasInitializedMessageCount = false;
let badgeUpdateSequence = 0;
let conversationListReady = false;

function getJumpListConversationIndex(commandLine: readonly string[]): number | undefined {
	const argument = commandLine.find(value => /^--jump-to-conversation=\d+$/.test(value));
	if (!argument) {
		return undefined;
	}

	const index = Number.parseInt(argument.split('=')[1], 10);
	return index > 0 ? index : undefined;
}

let pendingConversationIndex = getJumpListConversationIndex(process.argv);

function openPendingConversation(): void {
	if (!conversationListReady || pendingConversationIndex === undefined) {
		return;
	}

	const index = pendingConversationIndex;
	pendingConversationIndex = undefined;
	sendAction('jump-to-conversation', index);
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
}

app.on('second-instance', (_event, commandLine) => {
	if (mainWindow) {
		const conversationIndex = getJumpListConversationIndex(commandLine);
		if (conversationIndex !== undefined) {
			pendingConversationIndex = conversationIndex;
		}

		showAndFocusWindow(mainWindow);
		openPendingConversation();
	}
});

// Preserves the window position when a display is removed and Caprine is moved to a different screen.
app.on('ready', () => {
	electronScreen.on('display-removed', () => {
		const [x, y] = mainWindow.getPosition();
		mainWindow.setPosition(x, y);
	});
});

async function updateBadge(messageCount: number): Promise<void> {
	const updateSequence = ++badgeUpdateSequence;
	const hasNewMessages = hasInitializedMessageCount && messageCount > previousMessageCount;
	previousMessageCount = messageCount;
	hasInitializedMessageCount = true;

	if (!is.windows) {
		app.badgeCount = config.get('showUnreadBadge') ? messageCount : 0;

		if (
			is.macos
			&& config.get('bounceDockOnMessage')
			&& hasNewMessages
		) {
			app.dock?.bounce('informational');
		}
	}

	if (!is.macos) {
		tray.setBadge(config.get('showUnreadBadge') && messageCount > 0);

		if (config.get('flashWindowOnMessage')) {
			if (hasNewMessages) {
				mainWindow.flashFrame(true);
			} else if (messageCount === 0) {
				mainWindow.flashFrame(false);
			}
		}
	}

	tray.update(messageCount);

	if (is.windows) {
		if (!config.get('showUnreadBadge') || messageCount === 0) {
			mainWindow.setOverlayIcon(null, '');
		} else {
			// Delegate drawing of overlay icon to renderer process
			const overlayIcon = await ipc.callRenderer<number, {data: string; data2x: string; text: string}>(
				mainWindow,
				'render-overlay-icon',
				messageCount,
			);
			if (updateSequence === badgeUpdateSequence) {
				updateOverlayIcon(overlayIcon);
			}
		}
	}
}

function updateOverlayIcon({data, data2x, text}: {data: string; data2x: string; text: string}): void {
	const img = nativeImage.createEmpty();
	img.addRepresentation({scaleFactor: 1, dataURL: data});
	img.addRepresentation({scaleFactor: 2, dataURL: data2x});
	mainWindow.setOverlayIcon(img, text);
}

type BeforeSendHeadersResponse = {
	cancel?: boolean;
	requestHeaders?: Record<string, string>;
};

type OnSendHeadersDetails = {
	id: number;
	url: string;
	method: string;
	webContentsId?: number;
	resourceType: string;
	referrer: string;
	timestamp: number;
	requestHeaders: Record<string, string>;
};

function enableHiresResources(): void {
	const scaleFactor = Math.max(
		...electronScreen.getAllDisplays().map(display => display.scaleFactor),
	);

	if (scaleFactor === 1) {
		return;
	}

	const filter = {urls: [`*://*.${messengerDomain}/`]};

	session.defaultSession.webRequest.onBeforeSendHeaders(
		filter,
		(details: OnSendHeadersDetails, callback: (response: BeforeSendHeadersResponse) => void) => {
			let cookie = details.requestHeaders.Cookie;

			if (cookie && details.method === 'GET') {
				cookie = /(?:; )?dpr=\d/.test(cookie) ? cookie.replace(/dpr=\d/, `dpr=${scaleFactor}`) : `${cookie}; dpr=${scaleFactor}`;

				(details.requestHeaders as any).Cookie = cookie;
			}

			callback({
				cancel: false,
				requestHeaders: details.requestHeaders,
			});
		},
	);
}

function initRequestsFiltering(): void {
	const filter = {
		urls: [
			`*://*.${messengerDomain}/*typ.php*`, // Type indicator blocker
			`*://*.${messengerDomain}/*change_read_status.php*`, // Seen indicator blocker
			`*://*.${messengerDomain}/*delivery_receipts*`, // Delivery receipts indicator blocker
			`*://*.${messengerDomain}/*unread_threads*`, // Delivery receipts indicator blocker
			'*://*.fbcdn.net/images/emoji.php/v9/*', // Emoji
			'*://*.facebook.com/images/emoji.php/v9/*', // Emoji
		],
	};

	session.defaultSession.webRequest.onBeforeRequest(filter, async ({url}, callback) => {
		if (url.includes('emoji.php')) {
			callback(await processEmojiUrl(url));
		} else if (url.includes('typ.php')) {
			callback({cancel: config.get('block.typingIndicator' as any)});
		} else if (url.includes('change_read_status.php')) {
			callback({cancel: config.get('block.chatSeen' as any)});
		} else if (url.includes('delivery_receipts') || url.includes('unread_threads')) {
			callback({cancel: config.get('block.deliveryReceipt' as any)});
		}
	});

	session.defaultSession.webRequest.onHeadersReceived({
		urls: ['*://static.xx.fbcdn.net/rsrc.php/*'],
	}, ({responseHeaders}, callback) => {
		if (!config.get('callRingtoneMuted') || !responseHeaders) {
			callback({});
			return;
		}

		const callRingtoneHash = '2NAu/QVqg211BbktgY5GkA==';
		callback({
			cancel: responseHeaders['content-md5'][0] === callRingtoneHash,
		});
	});
}

function setUserLocale(): void {
	const userLocale = bestFacebookLocaleFor(app.getLocale().replace('-', '_'));
	const cookie = {
		url: 'https://www.messenger.com/',
		name: 'locale',
		secure: true,
		value: userLocale,
	};

	session.defaultSession.cookies.set(cookie);
}

function getWindowIconPath(): string | undefined {
	if (is.linux) {
		return caprineIconPath;
	}

	if (is.windows && is.development) {
		return path.join(__dirname, '..', 'build', 'icon.ico');
	}

	return undefined;
}

function createMainWindow(): BrowserWindow {
	const lastWindowState = config.get('lastWindowState');

	// Messenger or Work Chat
	const mainURL = config.get('useWorkChat')
		? 'https://work.facebook.com/chat'
		: 'https://www.messenger.com/t/';

	const win = new BrowserWindow({
		title: app.name,
		show: false,
		x: lastWindowState.x,
		y: lastWindowState.y,
		width: lastWindowState.width,
		height: lastWindowState.height,
		// Packaged Windows builds use the multi-resolution icon embedded in the EXE.
		// Supplying the large PNG here makes Windows downscale it for the taskbar.
		icon: getWindowIconPath(),
		minWidth: 400,
		minHeight: 200,
		alwaysOnTop: config.get('alwaysOnTop'),
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: {
			x: 80,
			y: 20,
		},
		autoHideMenuBar: !is.macos,
		webPreferences: {
			preload: path.join(__dirname, 'browser.js'),
			contextIsolation: true,
			nodeIntegration: true,
			spellcheck: config.get('isSpellCheckerEnabled'),
			plugins: true,
		},
	});

	require('@electron/remote/main').initialize();
	require('@electron/remote/main').enable(win.webContents);

	setUserLocale();
	initRequestsFiltering();

	let previousDarkMode = darkMode.isEnabled;
	darkMode.onChange(() => {
		if (darkMode.isEnabled !== previousDarkMode) {
			previousDarkMode = darkMode.isEnabled;
			win.webContents.send('set-theme');
		}
	});

	if (is.macos) {
		win.setSheetOffset(40);
	}

	win.loadURL(mainURL);

	win.on('close', event => {
		if (config.get('quitOnWindowClose')) {
			app.quit();
			return;
		}

		// Workaround for https://github.com/electron/electron/issues/20263
		// Closing the app window when on full screen leaves a black screen
		// Exit fullscreen before closing
		if (is.macos && mainWindow.isFullScreen()) {
			mainWindow.once('leave-full-screen', () => {
				mainWindow.hide();
			});
			mainWindow.setFullScreen(false);
		}

		if (!isQuitting) {
			event.preventDefault();

			// Workaround for https://github.com/electron/electron/issues/10023
			win.blur();
			if (is.macos) {
				// On macOS we're using `app.hide()` in order to focus the previous window correctly
				app.hide();
			} else {
				win.hide();
			}
		}
	});

	win.on('focus', () => {
		if (config.get('flashWindowOnMessage')) {
			// This is a security in the case where messageCount is not reset by page title update
			win.flashFrame(false);
		}
	});

	win.on('resize', () => {
		const {isMaximized} = config.get('lastWindowState');
		config.set('lastWindowState', {...win.getNormalBounds(), isMaximized});
	});

	win.on('maximize', () => {
		config.set('lastWindowState.isMaximized', true);
	});

	win.on('unmaximize', () => {
		config.set('lastWindowState.isMaximized', false);
	});

	return win;
}

(async () => {
	await Promise.all([ensureOnline(), app.whenReady()]);
	await updateAppMenu();
	mainWindow = createMainWindow();

	// Workaround for https://github.com/electron/electron/issues/5256
	electronLocalshortcut.register(mainWindow, 'CommandOrControl+=', () => {
		sendAction('zoom-in');
	});

	mainWindow.webContents.on('before-input-event', (event, input) => {
		if (input.type !== 'keyDown') {
			return;
		}

		let hasZoomModifier = input.modifiers.includes('control');
		if (is.macos) {
			hasZoomModifier = input.modifiers.includes('meta');
		} else if (is.linux) {
			hasZoomModifier = input.modifiers.includes('alt');
		}

		if (!hasZoomModifier) {
			return;
		}

		const actions: Partial<Record<string, string>> = {
			Numpad0: 'zoom-reset',
			NumpadAdd: 'zoom-in',
			NumpadEqual: 'zoom-in',
			NumpadSubtract: 'zoom-out',
		};
		const action = actions[input.code];

		if (action) {
			event.preventDefault();
			sendAction(action);
		}
	});

	// Start in menu bar mode if enabled, otherwise start normally
	setUpMenuBarMode(mainWindow);

	if (is.macos) {
		// Dock icon is hidden initially on macOS
		if (config.get('showDockIcon')) {
			app.dock?.show();
		}

		ipc.once('conversations', () => {
			// Messenger sorts the conversations by unread state.
			// We select the first conversation from the list.
			sendAction('jump-to-conversation', 1);
		});

		ipc.answerRenderer('conversations', (conversations: Conversation[]) => {
			conversationListReady = true;
			openPendingConversation();

			if (conversations.length === 0) {
				return;
			}

			const items = conversations.slice(0, 10).map(({label, icon}, index) => ({
				label: `${label}`,
				icon: nativeImage.createFromDataURL(icon),
				click() {
					mainWindow.show();
					sendAction('jump-to-conversation', index + 1);
				},
			}));

			app.dock?.setMenu(Menu.buildFromTemplate(items));
		});
	}

	if (is.windows) {
		ipc.answerRenderer('conversations', (conversations: Conversation[]) => {
			conversationListReady = true;

			if (conversations.length === 0) {
				app.setJumpList([]);
				openPendingConversation();
				return;
			}

			const tasks = conversations.slice(0, 10).map(({label}, index) => ({
				type: 'task' as const,
				title: label,
				program: process.execPath,
				args: `--jump-to-conversation=${index + 1}`,
				iconPath: getWindowIconPath() ?? process.execPath,
				iconIndex: 0,
				description: `Open ${label}`,
			}));

			app.setJumpList([
				{
					// Windows can disable custom categories through its privacy settings.
					// The standard Tasks category remains available in that configuration.
					type: 'tasks',
					items: tasks,
				},
			]);

			openPendingConversation();
		});
	}

	// Update badge on conversations change
	ipc.answerRenderer('update-tray-icon', async (messageCount: number) => {
		await updateBadge(messageCount);
	});

	enableHiresResources();

	const {webContents} = mainWindow;

	webContents.on('dom-ready', async () => {
		// Set window title to Caprine
		mainWindow.setTitle(app.name);

		await updateAppMenu();

		const files = ['browser.css', 'settings-panel.css', 'vibrancy.css', 'code-blocks.css', 'autoplay.css', 'scrollbar.css'];

		const cssPath = path.join(__dirname, '..', 'css');

		for (const file of files) {
			if (existsSync(path.join(cssPath, file))) {
				webContents.insertCSS(readFileSync(path.join(cssPath, file), 'utf8'));
			}
		}

		if (config.get('useWorkChat') && existsSync(path.join(cssPath, 'workchat.css'))) {
			webContents.insertCSS(
				readFileSync(path.join(cssPath, 'workchat.css'), 'utf8'),
			);
		}

		if (existsSync(path.join(app.getPath('userData'), 'custom.css'))) {
			webContents.insertCSS(readFileSync(path.join(app.getPath('userData'), 'custom.css'), 'utf8'));
		}

		if (config.get('launchMinimized') || app.getLoginItemSettings().wasOpenedAsHidden) {
			mainWindow.hide();
			tray.create(mainWindow);
		} else {
			if (config.get('lastWindowState').isMaximized) {
				mainWindow.maximize();
			}

			mainWindow.show();
		}

		ipc.callRenderer(mainWindow, 'toggle-message-buttons', config.get('showMessageButtons'));

		if (is.macos) {
			await import('./touch-bar.js');
		}
	});

	webContents.setWindowOpenHandler(details => {
		if (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') {
			const url = stripTrackingFromUrl(details.url);
			shell.openExternal(url);
			return {action: 'deny'};
		}

		if (details.disposition === 'new-window') {
			if (details.url === 'about:blank' || details.url === 'about:blank#blocked') {
				if (details.frameName !== 'about:blank') {
					// Voice/video call popup
					return {
						action: 'allow',
						overrideBrowserWindowOptions: {
							show: true,
							titleBarStyle: 'default',
							webPreferences: {
								nodeIntegration: false,
								preload: path.join(__dirname, 'browser-call.js'),
							},
						},
					};
				}
			} else {
				const url = stripTrackingFromUrl(details.url);
				shell.openExternal(url);
			}

			return {action: 'deny'};
		}

		return {action: 'allow'};
	});

	webContents.on('will-navigate', async (event, url) => {
		const destinationUrl = new URL(url);
		const currentUrl = new URL(webContents.getURL());
		const isConversationPath = (pathname: string): boolean => /(?:^|\/)t\/[^/]+/.test(pathname);
		const isConversationSwitchNavigation = destinationUrl.origin === currentUrl.origin
			&& isConversationPath(currentUrl.pathname)
			&& isConversationPath(destinationUrl.pathname);

		// Once Messenger is displaying a conversation, switching conversations is
		// handled by its SPA router. Cancel the anchor's native navigation so an
		// ordering race between the router and Electron cannot reload the document.
		// The initial /t/ route, login and cross-origin redirects remain untouched.
		if (isConversationSwitchNavigation) {
			event.preventDefault();
			return;
		}

		const isMessengerDotCom = (url: string): boolean => {
			const {hostname} = new URL(url);
			return hostname.endsWith('.messenger.com');
		};

		const isTwoFactorAuth = (url: string): boolean => {
			const {hostname, pathname} = new URL(url);
			const isFacebookAuthHost = hostname === 'www.facebook.com' || hostname === 'web.facebook.com';

			return isFacebookAuthHost && [
				'/checkpoint',
				'/two_factor',
				'/two_step_verification',
			].some(path => pathname.startsWith(path));
		};

		const isWorkChat = (url: string): boolean => {
			const {hostname, pathname} = new URL(url);

			if (hostname === 'work.facebook.com' || hostname === 'work.workplace.com') {
				return true;
			}

			if (
				// Example: https://company-name.facebook.com/login or
				//   		https://company-name.workplace.com/login
				(hostname.endsWith('.facebook.com') || hostname.endsWith('.workplace.com'))
				&& (pathname.startsWith('/login') || pathname.startsWith('/chat'))
			) {
				return true;
			}

			if (hostname === 'login.microsoftonline.com') {
				return true;
			}

			return false;
		};

		if (isMessengerDotCom(url) || isTwoFactorAuth(url) || isWorkChat(url)) {
			return;
		}

		event.preventDefault();
		await shell.openExternal(url);
	});
})();

if (is.macos) {
	ipc.answerRenderer('set-vibrancy', () => {
		mainWindow.setBackgroundColor('#80FFFFFF'); // Transparent, workaround for vibrancy issue.
		mainWindow.setVibrancy('sidebar');
	});
}

function toggleMaximized(): void {
	if (mainWindow.isMaximized()) {
		mainWindow.unmaximize();
	} else {
		mainWindow.maximize();
	}
}

ipc.answerRenderer('titlebar-doubleclick', () => {
	if (is.macos) {
		const doubleClickAction = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');

		if (doubleClickAction === 'Minimize') {
			mainWindow.minimize();
		} else if (doubleClickAction === 'Maximize') {
			toggleMaximized();
		}
	} else {
		toggleMaximized();
	}
});

ipc.answerRenderer('open-external', async (url: string) => {
	try {
		const externalUrl = stripTrackingFromUrl(url);
		const {protocol} = new URL(externalUrl);

		if (protocol === 'http:' || protocol === 'https:') {
			await shell.openExternal(externalUrl);
		}
	} catch {
		// Ignore malformed URLs received from page content.
	}
});

ipc.answerRenderer<undefined, SettingsPanelState>('get-settings-panel-state', async () => {
	const availableSpellCheckerLanguages = getSpellCheckerLanguageOptions();
	return {
		version: app.getVersion(),
		platform: process.platform,
		theme: config.get('theme'),
		zoomFactor: config.get('zoomFactor'),
		emojiStyle: config.get('emojiStyle'),
		emojiStyleExamples: {
			'facebook-3-0': nativeImage.createFromPath(path.join(__dirname, '..', 'static', 'emoji-facebook-3-0@2x.png')).toDataURL(),
			'messenger-1-0': nativeImage.createFromPath(path.join(__dirname, '..', 'static', 'emoji-messenger-1-0@2x.png')).toDataURL(),
			'facebook-2-2': nativeImage.createFromPath(path.join(__dirname, '..', 'static', 'emoji-facebook-2-2@2x.png')).toDataURL(),
		},
		notificationMessagePreview: config.get('notificationMessagePreview'),
		notificationsMuted: config.get('notificationsMuted'),
		callRingtoneMuted: config.get('callRingtoneMuted'),
		showUnreadBadge: config.get('showUnreadBadge'),
		alwaysOnTop: config.get('alwaysOnTop'),
		launchAtLogin: app.getLoginItemSettings().openAtLogin,
		showTrayIcon: config.get('showTrayIcon'),
		launchMinimized: config.get('launchMinimized'),
		quitOnWindowClose: config.get('quitOnWindowClose'),
		autoUpdate: config.get('autoUpdate'),
		bounceDockOnMessage: config.get('bounceDockOnMessage'),
		menuBarMode: config.get('menuBarMode'),
		isSpellCheckerEnabled: config.get('isSpellCheckerEnabled'),
		hardwareAcceleration: config.get('hardwareAcceleration'),
		useWorkChat: config.get('useWorkChat'),
		spellCheckerLanguages: config.get('spellCheckerLanguages'),
		availableSpellCheckerLanguages,
	};
});

// The switch keeps side effects explicit for each user-facing setting.
// eslint-disable-next-line complexity
ipc.answerRenderer<SettingsPanelUpdate, void>('update-settings-panel-setting', async ({setting, value}) => {
	const booleanValue = value as boolean;

	// Every SettingsPanelSetting is handled below.
	// eslint-disable-next-line default-case
	switch (setting) {
		case 'theme': {
			config.set('theme', value as StoreType['theme']);
			sendAction('set-theme');
			break;
		}

		case 'emojiStyle': {
			const emojiStyle = value as StoreType['emojiStyle'];
			if (config.get('emojiStyle') !== emojiStyle) {
				config.set('emojiStyle', emojiStyle);
			}

			break;
		}

		case 'notificationMessagePreview':
		case 'notificationsMuted':
		case 'callRingtoneMuted':
		case 'quitOnWindowClose':
		case 'autoUpdate':
		case 'bounceDockOnMessage': {
			config.set(setting, booleanValue);
			break;
		}

		case 'showUnreadBadge': {
			config.set('showUnreadBadge', booleanValue);
			await updateBadge(previousMessageCount);
			break;
		}

		case 'alwaysOnTop': {
			config.set('alwaysOnTop', booleanValue);
			mainWindow.setAlwaysOnTop(booleanValue);
			break;
		}

		case 'launchAtLogin': {
			app.setLoginItemSettings({
				openAtLogin: booleanValue,
				openAsHidden: booleanValue,
			});
			break;
		}

		case 'showTrayIcon': {
			if (!booleanValue && config.get('launchMinimized')) {
				break;
			}

			config.set('showTrayIcon', booleanValue);
			if (booleanValue) {
				tray.create(mainWindow);
			} else {
				tray.destroy();
			}

			break;
		}

		case 'launchMinimized': {
			config.set('launchMinimized', booleanValue);
			if (booleanValue && !config.get('showTrayIcon')) {
				config.set('showTrayIcon', true);
				tray.create(mainWindow);
			}

			break;
		}

		case 'menuBarMode': {
			config.set('menuBarMode', booleanValue);
			toggleMenuBarMode(mainWindow);
			break;
		}

		case 'isSpellCheckerEnabled': {
			config.set('isSpellCheckerEnabled', booleanValue);
			break;
		}

		case 'hardwareAcceleration': {
			config.set('hardwareAcceleration', booleanValue);
			break;
		}

		case 'spellCheckerLanguage': {
			const language = value as string;
			const languages = config.get('spellCheckerLanguages');
			const updatedLanguages = languages.includes(language)
				? languages.filter(currentLanguage => currentLanguage !== language)
				: [...languages, language];
			config.set('spellCheckerLanguages', updatedLanguages);
			session.defaultSession.setSpellCheckerLanguages(updatedLanguages);
			break;
		}
	}

	if (setting === 'theme') {
		await updateAppMenu();
	}
});

ipc.answerRenderer<SettingsPanelAction, void>('settings-panel-action', async action => {
	const urls: Partial<Record<SettingsPanelAction, string>> = {
		'source-code': 'https://github.com/visnia/caprine',
	};
	const url = urls[action];
	if (url) {
		await shell.openExternal(url);
		return;
	}

	switch (action) {
		case 'custom-styles': {
			const filePath = path.join(app.getPath('userData'), 'custom.css');
			if (!existsSync(filePath)) {
				writeFileSync(filePath, `/*
This is the custom styles file where you can add anything you want.
The styles here will be injected into Caprine and will override default styles.

Press Command/Ctrl+R in Caprine to see your changes.
*/
`, 'utf8');
			}

			await shell.openPath(filePath);
			break;
		}

		case 'report-issue': {
			openNewGitHubIssue({
				user: 'visnia',
				repo: 'caprine',
				body: `
<!-- Please succinctly describe your issue and steps to reproduce it. -->


---

${debugInfo()}`,
			});
			break;
		}

		case 'switch-to-messenger': {
			config.set('useWorkChat', false);
			app.relaunch();
			app.quit();
			break;
		}

		case 'relaunch': {
			app.relaunch();
			app.quit();
			break;
		}

		case 'quit': {
			app.quit();
			break;
		}

		default:
	}
});

app.on('activate', () => {
	if (mainWindow) {
		mainWindow.show();
	}
});

app.on('before-quit', () => {
	isQuitting = true;

	// Checking whether the window exists to work around an Electron race issue:
	// https://github.com/sindresorhus/caprine/issues/809
	if (mainWindow) {
		const {isMaximized} = config.get('lastWindowState');
		config.set('lastWindowState', {...mainWindow.getNormalBounds(), isMaximized});
	}
});

const notifications = new Map<number, Notification>();
type NotificationSource = 'messenger' | 'conversation-list';
const recentNotifications = new Map<string, {source: NotificationSource; timestamp: number}>();
const duplicateNotificationWindow = 5000;

ipc.answerRenderer(
	'notification',
	({id, href, source, title, body, icon, silent}: {id: number; href?: string; source: NotificationSource; title: string; body: string; icon: string; silent: boolean}) => {
		// Don't send notifications when the window is focused
		if (!Notification.isSupported() || mainWindow.isFocused() || config.get('notificationsMuted')) {
			return;
		}

		const now = Date.now();
		const fingerprint = `${title}\n${body}`;
		const duplicate = recentNotifications.get(fingerprint);
		if (
			duplicate
			&& duplicate.source !== source
			&& (now - duplicate.timestamp) < duplicateNotificationWindow
		) {
			return;
		}

		recentNotifications.set(fingerprint, {source, timestamp: now});
		for (const [key, value] of recentNotifications) {
			if ((now - value.timestamp) >= duplicateNotificationWindow) {
				recentNotifications.delete(key);
			}
		}

		if (notifications.has(id)) {
			const previousNotification = notifications.get(id)!;
			notifications.delete(id);
			previousNotification.close();
		}

		const notification = new Notification({
			title,
			body: config.get('notificationMessagePreview') ? body : 'You have a new message',
			hasReply: href === undefined,
			...(icon ? {icon: nativeImage.createFromDataURL(icon)} : {}),
			silent,
		});

		notifications.set(id, notification);

		notification.on('click', () => {
			showAndFocusWindow(mainWindow);
			sendAction('notification-callback', {callbackName: 'onclick', id, href});

			if (notifications.get(id) === notification) {
				notifications.delete(id);
			}
		});

		notification.on('reply', (_event, reply: string) => {
			// We use onclick event used by messenger to go to the right convo
			sendBackgroundAction('notification-reply-callback', {
				callbackName: 'onclick',
				id,
				reply,
				href,
			});

			if (notifications.get(id) === notification) {
				notifications.delete(id);
			}
		});

		notification.on('close', () => {
			sendBackgroundAction('notification-callback', {callbackName: 'onclose', id});
			if (notifications.get(id) === notification) {
				notifications.delete(id);
			}
		});

		notification.on('failed', (_event, error) => {
			console.error('Could not show desktop notification:', error);
			if (notifications.get(id) === notification) {
				notifications.delete(id);
			}
		});

		notification.show();
	},
);

type ThemeSource = typeof nativeTheme.themeSource;

ipc.answerRenderer<undefined, StoreType['useWorkChat']>('get-config-useWorkChat', async () => config.get('useWorkChat'));
ipc.answerRenderer<undefined, StoreType['showMessageButtons']>('get-config-showMessageButtons', async () => config.get('showMessageButtons'));
ipc.answerRenderer<undefined, ThemeSource>('get-config-theme', async () => config.get('theme'));
ipc.answerRenderer<undefined, StoreType['privateMode']>('get-config-privateMode', async () => config.get('privateMode'));
ipc.answerRenderer<undefined, StoreType['vibrancy']>('get-config-vibrancy', async () => config.get('vibrancy'));
ipc.answerRenderer<undefined, StoreType['sidebar']>('get-config-sidebar', async () => config.get('sidebar'));
ipc.answerRenderer<undefined, StoreType['zoomFactor']>('get-config-zoomFactor', async () => config.get('zoomFactor'));
ipc.answerRenderer<StoreType['zoomFactor'], void>('set-config-zoomFactor', async zoomFactor => {
	config.set('zoomFactor', zoomFactor);
});
ipc.answerRenderer<undefined, StoreType['keepMeSignedIn']>('get-config-keepMeSignedIn', async () => config.get('keepMeSignedIn'));
ipc.answerRenderer<StoreType['keepMeSignedIn'], void>('set-config-keepMeSignedIn', async keepMeSignedIn => {
	config.set('keepMeSignedIn', keepMeSignedIn);
});
ipc.answerRenderer<undefined, StoreType['autoplayVideos']>('get-config-autoplayVideos', async () => config.get('autoplayVideos'));
ipc.answerRenderer<undefined, StoreType['emojiStyle']>('get-config-emojiStyle', async () => config.get('emojiStyle'));
ipc.answerRenderer<StoreType['emojiStyle'], void>('set-config-emojiStyle', async emojiStyle => {
	config.set('emojiStyle', emojiStyle);
});
