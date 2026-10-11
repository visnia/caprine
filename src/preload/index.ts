import {contextBridge, ipcRenderer} from 'electron';
import {MESSENGER, type Settings, type UpdateStatus} from '../shared';
import {createCollector, openThread} from './collector';
import {installMainWorld} from './main-world';
import {observePageKind} from './page';
import {initializeSettingsPanel} from './settings-panel';
import {applyTheme, installStyles} from './styles';
import {observeUnread} from './unread';

type Bootstrap = {settings: Settings; customCss: string; version: string; platform: string; updateStatus: UpdateStatus};

// The Windows taskbar overlay: a red disc with the count, up to 99+.
function badge(count: number): string | null {
	if (count === 0) return null;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 32;
	const context = canvas.getContext('2d')!;
	context.fillStyle = '#e41e3f';
	context.beginPath();
	context.arc(16, 16, 16, 0, 2 * Math.PI);
	context.fill();
	const text = count > 99 ? '99+' : String(count);
	context.fillStyle = '#fff';
	context.font = `bold ${text.length > 2 ? 13 : 18}px system-ui, sans-serif`;
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	context.fillText(text, 16, 17);
	return canvas.toDataURL('image/png');
}

// Messenger's call popups get this preload too; only the main window integrates.
if (location.origin === MESSENGER && ipcRenderer.sendSync('is-main-window') === true) {
	let settings: Settings | undefined;
	const listeners = new Set<(settings: Settings) => void>();
	const collector = createCollector(document, message => ipcRenderer.send('message', message));
	// Before Messenger's scripts, so it cannot keep the original APIs.
	contextBridge.executeInMainWorld({func: installMainWorld, args: [{
		media: () => ({autoplay: settings?.autoplayVideos ?? true, tone: (settings?.notificationSound ?? 'messenger') === 'messenger'}),
		tone: () => collector.tone(),
		notify: (title: string, body: string) => collector.notification(String(title), String(body)),
	}]});
	const accept = (next: Settings) => {
		settings = next;
		applyTheme(next.theme);
		for (const listener of listeners) listener(next);
	};
	ipcRenderer.on('settings', (_, next: Settings) => accept(next));
	ipcRenderer.on('open-thread', (_, url: string) => openThread(document, url));

	const bootstrap = ipcRenderer.invoke('bootstrap') as Promise<Bootstrap>;
	void bootstrap.then(state => { settings ??= state.settings; });
	document.addEventListener('DOMContentLoaded', async () => {
		const state = await bootstrap;
		installStyles(state.customCss);
		accept(settings ?? state.settings);
		observePageKind(document);
		const updateListeners = new Set<(status: UpdateStatus) => void>();
		ipcRenderer.on('update-status', (_, status: UpdateStatus) => { for (const listener of updateListeners) listener(status); });
		const panel = initializeSettingsPanel({
			settings: () => settings!,
			subscribe: listener => listeners.add(listener),
			update: (key, value) => ipcRenderer.invoke('update-setting', key, value),
			action: name => ipcRenderer.invoke('action', name),
			onUpdateStatus: listener => updateListeners.add(listener),
			updateStatus: state.updateStatus,
			version: state.version,
			platform: state.platform,
		});
		ipcRenderer.on('toggle-settings', () => panel.toggle());
		observeUnread(document, count => ipcRenderer.send('unread', count, state.platform === 'win32' ? badge(count) : null));
		collector.start();
		document.documentElement.dataset.caprineVersion = state.version;
	}, {once: true});
}
