// The in-page settings drawer, opened with Ctrl+, or the gear button.
import {zoomStep, type Settings, type UpdateStatus} from '../shared';

export type PanelHost = {
	settings(): Settings;
	subscribe(listener: (settings: Settings) => void): void;
	update(key: keyof Settings, value: unknown): Promise<unknown>;
	action(name: string): Promise<unknown>;
	onUpdateStatus(listener: (status: UpdateStatus) => void): void;
	updateStatus: UpdateStatus;
	version: string;
	platform: string;
};

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
	const node = document.createElement(tag);
	node.className = className;
	node.textContent = text;
	return node;
};
const button = (text: string, className = 'caprine-settings-action') => {
	const node = element('button', className, text);
	node.type = 'button';
	return node;
};

export function initializeSettingsPanel(host: PanelHost) {
	const launcher = button('', 'caprine-settings-launcher');
	launcher.id = 'caprine-settings-launcher';
	launcher.title = 'Caprine Settings (Ctrl+,)';
	launcher.setAttribute('aria-label', 'Open Caprine Settings');
	launcher.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94a7.4 7.4 0 0 0 .05-.94 7.4 7.4 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.2 7.2 0 0 0-1.62-.94L14.39 2.8a.5.5 0 0 0-.49-.4h-3.8a.5.5 0 0 0-.49.4l-.36 2.52c-.58.24-1.12.55-1.62.94L5.24 5.3a.5.5 0 0 0-.61.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.4 7.4 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.61.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.52c.04.24.24.4.49.4h3.8c.25 0 .45-.16.49-.4l.36-2.52c.58-.24 1.12-.55 1.62-.94l2.39.96c.22.1.48.01.61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>';
	const backdrop = element('div', 'caprine-settings-backdrop');
	backdrop.id = 'caprine-settings-backdrop';
	backdrop.setAttribute('aria-hidden', 'true');
	backdrop.inert = true;
	const panel = element('section', 'caprine-settings-panel');
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-modal', 'true');
	panel.setAttribute('aria-labelledby', 'caprine-settings-title');
	const header = element('header', 'caprine-settings-header');
	const heading = element('div');
	const title = element('h1', '', 'Settings');
	title.id = 'caprine-settings-title';
	heading.append(element('span', 'caprine-settings-eyebrow', 'CAPRINE'), title);
	const closeButton = button('×', 'caprine-settings-close');
	closeButton.setAttribute('aria-label', 'Close settings');
	header.append(heading, closeButton);
	const error = element('div', 'caprine-settings-error');
	error.setAttribute('role', 'alert');
	error.hidden = true;
	const content = element('div', 'caprine-settings-content');
	panel.append(header, error, content);
	backdrop.append(panel);
	document.body.append(launcher, backdrop);
	let previousFocus: HTMLElement | null = null;
	let open = false;
	const controls = new Map<keyof Settings, HTMLInputElement | HTMLSelectElement>();
	const run = async (control: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, operation: () => Promise<unknown>) => {
		control.disabled = true;
		error.hidden = true;
		try {
			await operation();
		} catch (cause) {
			error.textContent = String(cause).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, '');
			error.hidden = false;
		} finally {
			control.disabled = false;
			refresh(host.settings());
		}
	};
	const section = (text: string) => {
		const node = element('section', 'caprine-settings-section');
		node.append(element('h2', '', text));
		content.append(node);
		return node;
	};
	const row = (parent: HTMLElement, title: string, description: string) => {
		const node = element('div', 'caprine-settings-row');
		const copy = element('div', 'caprine-settings-copy');
		copy.append(element('div', 'caprine-settings-label', title), element('div', 'caprine-settings-description', description));
		const control = element('div', 'caprine-settings-control');
		node.append(copy, control);
		parent.append(node);
		return control;
	};
	type BooleanKey = {[K in keyof Settings]: Settings[K] extends boolean ? K : never}[keyof Settings];
	const toggle = (parent: HTMLElement, label: string, description: string, setting: BooleanKey) => {
		const track = element('label', 'caprine-settings-toggle');
		const input = element('input');
		input.type = 'checkbox';
		input.setAttribute('aria-label', label);
		track.append(input, element('span'));
		row(parent, label, description).append(track);
		controls.set(setting, input);
		input.addEventListener('change', () => { void run(input, () => host.update(setting, input.checked)); });
	};
	const select = (parent: HTMLElement, label: string, description: string, setting: 'theme' | 'trayIconStyle' | 'notificationSound', choices: Array<[string, string]>) => {
		const input = element('select', 'caprine-settings-select');
		input.setAttribute('aria-label', label);
		for (const [value, text] of choices) {
			const option = element('option', '', text);
			option.value = value;
			input.append(option);
		}
		controls.set(setting, input);
		row(parent, label, description).append(input);
		input.addEventListener('change', () => { void run(input, () => host.update(setting, input.value)); });
	};
	const action = (parent: HTMLElement, title: string, description: string, label: string, name: string) => {
		const control = button(label);
		row(parent, title, description).append(control);
		control.addEventListener('click', () => { void run(control, () => host.action(name)); });
	};

	const appearance = section('Appearance');
	select(appearance, 'Theme', 'Follow the system or choose a light, dark or OLED theme.', 'theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark'], ['oled', 'OLED']]);
	select(appearance, 'Tray icon style', 'Use the Messenger logo or a monochrome outline that matches the panel. The tray icon shows while Quit on window close is off.', 'trayIconStyle', [['color', 'Color'], ['white', 'White outline'], ['black', 'Black outline']]);
	const stepper = element('div', 'caprine-settings-stepper');
	const decrease = button('−');
	const increase = button('+');
	decrease.setAttribute('aria-label', 'Decrease text size');
	increase.setAttribute('aria-label', 'Increase text size');
	const zoom = element('span');
	stepper.append(decrease, zoom, increase);
	row(appearance, 'Text size', 'Ctrl+= / Ctrl+- to adjust; Ctrl+0 to reset.').append(stepper);
	for (const [control, direction] of [[decrease, 'out'], [increase, 'in']] as const) {
		control.addEventListener('click', () => { void run(control, () => host.update('zoomFactor', zoomStep(host.settings().zoomFactor, direction))); });
	}
	if (host.platform === 'win32') toggle(appearance, 'Unread badge', 'Show the unread count on the taskbar icon.', 'showUnreadBadge');

	const behavior = section('App behavior');
	toggle(behavior, 'Always on top', 'Keep Caprine above other windows.', 'alwaysOnTop');
	toggle(behavior, 'Launch at login', 'Start Caprine when you sign in to your computer.', 'launchAtLogin');
	toggle(behavior, 'Launch minimized', 'Start in the system tray (or minimized, while Quit on window close is on) when launched at login. Available only while Launch at login is on.', 'launchMinimized');
	toggle(behavior, 'Quit on window close', 'Exit when the window is closed. Off keeps Caprine running in the system tray.', 'quitOnWindowClose');

	const media = section('Messages & media');
	toggle(media, 'Autoplay videos', 'Let videos and animated clips start on their own. Calls are not affected.', 'autoplayVideos');
	toggle(media, 'Spell checking', host.platform === 'win32' ? 'Underline misspellings using the Windows spell checker.' : 'Underline misspellings using dictionaries for your system languages.', 'spellCheck');

	const notifications = section('Notifications');
	toggle(notifications, 'Desktop notifications', 'Show a notification for new messages while Caprine is not focused.', 'notifications');
	toggle(notifications, 'Message preview', 'Include message text in desktop notifications.', 'notificationPreview');
	select(notifications, 'Notification sound', 'Play Messenger\'s message tone or the system notification sound. System plays only when a notification is shown.', 'notificationSound', [['messenger', 'Messenger'], ['system', 'System'], ['off', 'Off']]);
	toggle(notifications, 'Flash taskbar', 'Flash the taskbar when a message notification arrives.', 'flashTaskbar');

	const advanced = section('Advanced');
	toggle(advanced, 'Hardware acceleration', 'Use the GPU for rendering. Takes effect after Relaunch Caprine.', 'hardwareAcceleration');
	action(advanced, 'Custom styles', 'Edit custom.css, then press Ctrl+R to apply changes.', 'Open CSS', 'customCss');

	const updates = section('Updates');
	toggle(updates, 'Automatic update checks', 'Check GitHub releases every few hours and download new versions.', 'autoUpdate');
	const updateControl = row(updates, 'Version', '');
	const updateDescription = updateControl.previousElementSibling!.lastElementChild!;
	const updateButton = button('Check now');
	updateControl.append(updateButton);
	let updateStatus = host.updateStatus;
	const showUpdate = (status: UpdateStatus) => {
		updateStatus = status;
		updateDescription.textContent = {
			unsupported: 'Updates are unavailable in this build.', idle: 'Not checked yet.', checking: 'Checking…',
			upToDate: 'Caprine is up to date.', downloading: `Downloading ${status.version}…`,
			ready: `Version ${status.version} is ready to install.`, error: `Update failed: ${status.message}`,
		}[status.state];
		updateButton.textContent = status.state === 'ready' ? 'Install & restart' : 'Check now';
		updateButton.disabled = ['unsupported', 'checking', 'downloading'].includes(status.state);
	};
	updateButton.addEventListener('click', () => {
		void run(updateButton, () => host.action(updateStatus.state === 'ready' ? 'installUpdate' : 'checkUpdate')).then(() => showUpdate(updateStatus));
	});
	host.onUpdateStatus(showUpdate);
	showUpdate(updateStatus);

	const help = section('Help & about');
	help.append(element('p', 'caprine-settings-section-description', `caprine ${host.version}`));
	action(help, 'Source code', 'github.com/visnia/caprine', 'Open', 'sourceCode');
	action(help, 'Report an issue', 'Open the issue tracker.', 'Open', 'reportIssue');
	const footer = element('footer', 'caprine-settings-footer');
	for (const [label, name] of [['Relaunch Caprine', 'relaunch'], ['Quit', 'quit']] as const) {
		const control = button(label);
		control.addEventListener('click', () => { void run(control, () => host.action(name)); });
		footer.append(control);
	}
	content.append(footer);

	const refresh = (settings: Settings) => {
		launcher.dataset.caprineTheme = settings.theme;
		backdrop.dataset.caprineTheme = settings.theme;
		for (const [key, control] of controls) {
			if (control instanceof HTMLInputElement) control.checked = Boolean(settings[key]);
			else control.value = String(settings[key]);
		}
		controls.get('launchMinimized')!.disabled = !settings.launchAtLogin;
		zoom.textContent = `${Math.round(settings.zoomFactor * 100)}%`;
		decrease.disabled = settings.zoomFactor <= 0.5;
		increase.disabled = settings.zoomFactor >= 2;
	};
	host.subscribe(refresh);
	refresh(host.settings());

	const close = () => {
		open = false;
		const target = previousFocus?.isConnected && previousFocus !== document.body ? previousFocus : launcher;
		target.focus({preventScroll: true});
		if (backdrop.contains(document.activeElement)) launcher.focus({preventScroll: true});
		backdrop.classList.remove('is-open');
		backdrop.setAttribute('aria-hidden', 'true');
		backdrop.inert = true;
		document.documentElement.classList.remove('caprine-settings-open');
	};
	const show = () => {
		previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		open = true;
		backdrop.inert = false;
		backdrop.setAttribute('aria-hidden', 'false');
		backdrop.classList.add('is-open');
		document.documentElement.classList.add('caprine-settings-open');
		closeButton.focus({preventScroll: true});
	};
	launcher.addEventListener('click', show);
	closeButton.addEventListener('click', close);
	backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
	document.addEventListener('keydown', event => {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			close();
		}
		if (event.key === 'Tab') {
			const targets = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
			const index = targets.indexOf(document.activeElement as HTMLElement);
			event.preventDefault();
			event.stopImmediatePropagation();
			targets[(index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length]?.focus();
		}
	}, {capture: true});
	return {toggle: () => { if (open) close(); else show(); }};
}
