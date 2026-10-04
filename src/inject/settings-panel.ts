// Adapted from source/settings-panel.ts: retain the in-page drawer and controls.
import {invoke} from '@tauri-apps/api/core';
import {zoomUpdate, type Settings, type SettingsClient, type SettingUpdate} from './settings';

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

export function initializeSettingsPanel(client: SettingsClient, version: string) {
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
		try { await operation(); }
		catch (cause) { error.textContent = String(cause); error.hidden = false; }
		finally { control.disabled = false; refresh(client.get()); }
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
		const container = row(parent, label, description);
		const track = element('label', 'caprine-settings-toggle');
		const input = element('input');
		input.type = 'checkbox';
		input.setAttribute('aria-label', label);
		track.append(input, element('span'));
		container.append(track);
		controls.set(setting, input);
		input.addEventListener('change', () => { void run(input, () => client.update({setting, value: input.checked} as SettingUpdate)); });
	};
	const action = (parent: HTMLElement, title: string, description: string, label: string, callback: () => Promise<unknown>) => {
		const control = button(label);
		row(parent, title, description).append(control);
		control.addEventListener('click', () => { void run(control, callback); });
	};
	const appearance = section('Appearance');
	const theme = element('select', 'caprine-settings-select');
	theme.setAttribute('aria-label', 'Theme');
	for (const [value, text] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) {
		const option = element('option', '', text);
		option.value = value!;
		theme.append(option);
	}
	controls.set('theme', theme);
	row(appearance, 'Theme', 'Follow the system or choose a light or dark theme.').append(theme);
	theme.addEventListener('change', () => { void run(theme, () => client.update({setting: 'theme', value: theme.value as Settings['theme']})); });
	const stepper = element('div', 'caprine-settings-stepper');
	const decrease = button('−');
	const increase = button('+');
	decrease.setAttribute('aria-label', 'Decrease text size');
	increase.setAttribute('aria-label', 'Increase text size');
	const zoom = element('span');
	stepper.append(decrease, zoom, increase);
	row(appearance, 'Text size', 'Ctrl+= / Ctrl+- to adjust; Ctrl+0 to reset.').append(stepper);
	for (const [control, direction] of [[decrease, 'out'], [increase, 'in']] as const) {
		control.addEventListener('click', () => { void run(control, () => client.update(settings => zoomUpdate(settings, direction))); });
	}
	toggle(appearance, 'Unread badge', 'Show the unread count on the taskbar icon and supported trays.', 'showUnreadBadge');
	const behavior = section('App behavior');
	toggle(behavior, 'Always on top', 'Keep Caprine above other windows.', 'alwaysOnTop');
	toggle(behavior, 'Launch at login', 'Start Caprine when you sign in to your computer.', 'launchAtLogin');
	toggle(behavior, 'Launch minimized', 'Start in the system tray.', 'launchMinimized');
	toggle(behavior, 'Quit on window close', 'Exit instead of keeping Caprine in the system tray.', 'quitOnWindowClose');
	const advanced = section('Advanced');
	toggle(advanced, 'Debug notifications', 'Record notification diagnostics in the app data folder.', 'debugNotifications');
	action(advanced, 'Custom styles', 'Edit custom.css, then press Ctrl+R to apply changes.', 'Open CSS', () => invoke('panel_action', {action: 'customStyles'}));
	const help = section('Help & about');
	help.append(element('p', 'caprine-settings-section-description', `Caprine (Visnia) ${version}`));
	action(help, 'Source code', 'github.com/visnia/caprine', 'Open', () => invoke('open_external', {url: 'https://github.com/visnia/caprine'}));
	action(help, 'Report an issue', 'Open the issue tracker.', 'Open', () => invoke('open_external', {url: 'https://github.com/visnia/caprine/issues'}));
	const footer = element('footer', 'caprine-settings-footer');
	for (const [label, action] of [['Relaunch Caprine', 'relaunch'], ['Quit', 'quit']]) {
		const control = button(label!);
		control.addEventListener('click', () => { void run(control, () => invoke('panel_action', {action})); });
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
		zoom.textContent = `${Math.round(settings.zoomFactor * 100)}%`;
		decrease.disabled = settings.zoomFactor <= 0.5;
		increase.disabled = settings.zoomFactor >= 2;
	};
	client.subscribe(refresh);
	refresh(client.get());
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
		if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
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
