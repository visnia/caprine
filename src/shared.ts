// Shared by the main process and the preload.
export const MESSENGER = 'https://www.messenger.com';

export const defaults = {
	theme: 'system' as 'system' | 'light' | 'dark' | 'oled',
	zoomFactor: 1,
	alwaysOnTop: false,
	launchAtLogin: false,
	launchMinimized: false,
	// Off: closing the window keeps Caprine running in the tray.
	quitOnWindowClose: false,
	trayIconStyle: 'color' as 'color' | 'white' | 'black',
	showUnreadBadge: true,
	muteNotifications: false,
	notificationPreview: true,
	// Messenger: its in-page tone, silent notifications. System: the platform
	// notification sound, Messenger's tone muted. Off: neither.
	notificationSound: 'messenger' as 'messenger' | 'system' | 'off',
	flashTaskbar: true,
	autoplayVideos: true,
	spellCheck: true,
	hardwareAcceleration: true,
	autoUpdate: true,
};
export type Settings = typeof defaults;

export const choices: Partial<Record<keyof Settings, readonly string[]>> = {
	theme: ['system', 'light', 'dark', 'oled'],
	trayIconStyle: ['color', 'white', 'black'],
	notificationSound: ['messenger', 'system', 'off'],
};

export type UpdateStatus = {
	state: 'unsupported' | 'idle' | 'checking' | 'upToDate' | 'downloading' | 'ready' | 'error';
	version?: string;
	message?: string;
};

// What the preload sends for a new message.
export type MessageNotice = {title: string; body: string; threadUrl: string | null; iconUrl: string | null};

export function zoomStep(zoom: number, direction: 'in' | 'out' | 'reset'): number {
	if (direction === 'reset') return 1;
	return Math.min(2, Math.max(0.5, Math.round((zoom + (direction === 'in' ? 0.1 : -0.1)) * 10) / 10));
}
