import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';

export type Settings = {
	theme: 'system' | 'light' | 'dark';
	zoomFactor: number;
	alwaysOnTop: boolean;
	launchAtLogin: boolean;
	launchMinimized: boolean;
	quitOnWindowClose: boolean;
	showUnreadBadge: boolean;
	debugNotifications: boolean;
};
export type SettingUpdate = {[K in keyof Settings]: {setting: K; value: Settings[K]}}[keyof Settings];
export type SettingsClient = ReturnType<typeof createSettingsClient>;

export function createSettingsClient(initial: Settings) {
	let current = initial;
	let queue = Promise.resolve();
	const listeners = new Set<(settings: Settings) => void>();
	const accept = (settings: Settings) => {
		current = settings;
		for (const listener of listeners) listener(settings);
	};
	return {
		get: () => current,
		accept,
		subscribe(listener: (settings: Settings) => void) { listeners.add(listener); return () => listeners.delete(listener); },
		async connect() {
			await listen<Settings>('settings-changed', event => accept(event.payload));
			accept(await invoke<Settings>('get_settings'));
		},
		update(change: SettingUpdate | ((settings: Settings) => SettingUpdate)): Promise<void> {
			const result = queue.then(async () => {
				const update = typeof change === 'function' ? change(current) : change;
				try {
					accept(await invoke<Settings>('update_setting', {update}));
				} catch (error) {
					// A persistence/native error must restore the visible control to
					// the backend's actual state, not leave an optimistic checkbox.
					accept(await invoke<Settings>('get_settings'));
					throw error;
				}
			});
			queue = result.catch(() => {});
			return result;
		},
	};
}

export function zoomUpdate(settings: Settings, direction: 'in' | 'out' | 'reset'): SettingUpdate {
	return {setting: 'zoomFactor', value: direction === 'reset' ? 1 : Math.min(2, Math.max(0.5,
		Math.round((settings.zoomFactor + (direction === 'in' ? 0.1 : -0.1)) * 10) / 10))};
}
