import {app} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {choices, defaults, type Settings} from '../shared';

const file = () => path.join(app.getPath('userData'), 'settings.json');

function valid(key: keyof Settings, value: unknown): boolean {
	if (typeof value !== typeof defaults[key]) return false;
	if (key === 'zoomFactor') return Number.isFinite(value) && (value as number) >= 0.5 && (value as number) <= 2;
	return !choices[key] || choices[key].includes(value as string);
}

// Unknown keys and invalid values are dropped, so any older or hand-edited
// file still loads.
export function sanitize(input: Record<string, unknown>): Settings {
	const settings = {...defaults} as Record<keyof Settings, unknown>;
	for (const key of Object.keys(defaults) as Array<keyof Settings>) {
		if (valid(key, input[key])) settings[key] = input[key];
	}
	return settings as Settings;
}

export function loadSettings(): Settings {
	let stored: Record<string, unknown> = {};
	try {
		stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not read settings.json; using defaults', error);
	}
	const enabled = launchAtLogin();
	// Rewritten at startup so it points at this build, even after the AppImage
	// has moved or been renamed.
	if (enabled && process.platform === 'linux') {
		try { setLaunchAtLogin(true); } catch (error) { console.error('Could not refresh the autostart entry', error); }
	}
	return {...sanitize(stored), launchAtLogin: enabled};
}

export function saveSettings(settings: Settings) {
	const temporary = `${file()}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(settings, null, '\t'));
	fs.renameSync(temporary, file());
}

export function changed<K extends keyof Settings>(settings: Settings, key: K, value: unknown): Settings {
	if (!Object.hasOwn(defaults, key) || !valid(key, value)) throw new Error(`Invalid value for ${key}`);
	return {...settings, [key]: value};
}

// Electron has no login items on Linux, so it gets an XDG autostart entry.
const autostartFile = () => path.join(app.getPath('appData'), 'autostart', `${path.basename(app.getPath('userData'))}.desktop`);
const autostartArgs = ['--autostart'];

function launchAtLogin(): boolean {
	if (process.platform !== 'linux') return app.getLoginItemSettings({args: autostartArgs}).openAtLogin;
	return fs.existsSync(autostartFile());
}

export function setLaunchAtLogin(enabled: boolean) {
	if (process.platform !== 'linux') {
		app.setLoginItemSettings({openAtLogin: enabled, args: autostartArgs});
		return;
	}
	if (!enabled) {
		fs.rmSync(autostartFile(), {force: true});
		return;
	}
	const command = [process.env.APPIMAGE ?? process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()]), ...autostartArgs]
		// Quoted Exec arguments escape these with a backslash, itself escaped once
		// more by the desktop entry string rules.
		.map(arg => `"${arg.replace(/(["`$\\])/g, '\\\\$1')}"`).join(' ');
	fs.mkdirSync(path.dirname(autostartFile()), {recursive: true});
	fs.writeFileSync(autostartFile(), `[Desktop Entry]\nType=Application\nName=caprine\nExec=${command}\nX-GNOME-Autostart-enabled=true\n`);
}
