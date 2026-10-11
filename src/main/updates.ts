// Updates from this repository's GitHub releases (NSIS installer, AppImage).
import electronUpdater from 'electron-updater';
import type {UpdateStatus} from '../shared';

const {autoUpdater} = electronUpdater;

export function createUpdater(options: {enabled: () => boolean; changed: (status: UpdateStatus) => void; ready: (version: string) => void; beforeInstall: () => void}) {
	// Development runs, raw binaries and non-AppImage Linux runs cannot update.
	let status: UpdateStatus = autoUpdater.isUpdaterActive() ? {state: 'idle'} : {state: 'unsupported'};
	const set = (next: UpdateStatus) => { status = next; options.changed(next); };
	autoUpdater.on('checking-for-update', () => set({state: 'checking'}));
	autoUpdater.on('update-not-available', () => set({state: 'upToDate'}));
	autoUpdater.on('update-available', info => set({state: 'downloading', version: info.version}));
	autoUpdater.on('update-downloaded', info => {
		set({state: 'ready', version: info.version});
		options.ready(info.version);
	});
	autoUpdater.on('error', error => set({state: 'error', message: error.message}));
	const check = () => {
		if (status.state === 'unsupported' || status.state === 'ready') return;
		autoUpdater.checkForUpdates().catch(() => {}); // Reported by the error event.
	};
	if (status.state !== 'unsupported') {
		const scheduled = () => { if (options.enabled()) check(); };
		setTimeout(scheduled, 60_000);
		setInterval(scheduled, 6 * 60 * 60_000);
	}
	return {
		status: () => status,
		check,
		install() {
			if (status.state !== 'ready') return;
			options.beforeInstall();
			autoUpdater.quitAndInstall();
		},
	};
}
