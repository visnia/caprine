// Caprine draws its own title bar so it follows the theme: KWin and older
// Windows paint the native one in the system colours.
import {app, ipcMain, nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions} from 'electron';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {Settings} from '../shared';

export const titleBarHeight = 32;
// Windows keeps its native caption buttons (and snap layouts). Elsewhere the
// buttons are drawn here in the same plain style; Electron's own look out of
// place on Linux desktops.
const nativeButtons = process.platform === 'win32';

export const titleBarOptions: BrowserWindowConstructorOptions = {
	titleBarStyle: 'hidden',
	...(nativeButtons ? {titleBarOverlay: {height: titleBarHeight}} : {}),
	webPreferences: {sandbox: true, ...(nativeButtons ? {} : {preload: path.join(import.meta.dirname, 'title-bar.cjs')})},
};

const buttons = `<button data-action="minimize" title="Minimize"><svg viewBox="0 0 16 16"><path d="M3.5 11.5h9"/></svg></button>
<button data-action="maximize" title="Maximize"><svg viewBox="0 0 16 16"><path class="maximize" d="M3.5 3.5h9v9h-9z"/><path class="restore" d="M3.5 5.5h7v7h-7zM5.5 5.5v-2h7v7h-2"/></svg></button>
<button data-action="close" id="close" title="Close"><svg viewBox="0 0 16 16"><path d="M3.5 3.5l9 9m0-9-9 9"/></svg></button>`;

// The desktop's window title font: KDE's, then GNOME's. Elsewhere, and on
// Windows, the system UI font at the Windows caption size.
function titleFont(): string {
	const css = (family: string, points: number, bold = false) => `${bold ? 'bold ' : ''}${points * 4 / 3}px ${JSON.stringify(family)}, system-ui, sans-serif`;
	if (process.platform === 'linux') {
		try {
			const kde = fs.readFileSync(path.join(app.getPath('appData'), 'kdeglobals'), 'utf8');
			const [, family, points] = /^activeFont=([^,\n]+),([\d.]+)/m.exec(kde) ?? /^font=([^,\n]+),([\d.]+)/m.exec(kde) ?? [];
			if (family && points) return css(family, Number(points));
		} catch {}
		try {
			const gnome = execFileSync('gsettings', ['get', 'org.gnome.desktop.wm.preferences', 'titlebar-font'], {encoding: 'utf8', timeout: 1000});
			const [, family, bold, points] = /^'(.+?)( Bold)?\s+([\d.]+)'$/.exec(gnome.trim()) ?? [];
			if (family && points) return css(family, Number(points), Boolean(bold));
		} catch {}
	}
	return '12px system-ui, sans-serif';
}

const page = () => `<!doctype html><meta charset="utf-8"><style>
html{height:${titleBarHeight}px;display:flex;align-items:center;padding-left:12px;box-sizing:border-box;font:${titleFont()};
	background:var(--background);color:var(--foreground);user-select:none;cursor:default;-webkit-app-region:drag}
body{margin:0;flex:1;display:flex;align-items:center;min-width:0}
#title{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:env(titlebar-area-width,100%)}
[data-inactive] body{opacity:.6}
button{-webkit-app-region:no-drag;width:40px;height:${titleBarHeight}px;padding:0;border:0;background:none;color:inherit;display:grid;place-items:center}
button:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
button:active{background:color-mix(in srgb,currentColor 20%,transparent)}
#close:hover{background:#e81123;color:#fff}
svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.3}
.restore,[data-maximized] .maximize{display:none}
[data-maximized] .restore{display:inline}
</style><div id="title"></div>${nativeButtons ? '' : buttons}`;

export function installTitleBar(window: BrowserWindow, theme: () => Settings['theme']) {
	void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page())}`);
	const paint = () => {
		if (window.isDestroyed()) return;
		const [background, foreground] = theme() === 'oled' ? ['#000000', '#e4e6eb']
			: nativeTheme.shouldUseDarkColors ? ['#1a1a1a', '#e4e6eb'] : ['#ffffff', '#050505'];
		window.setBackgroundColor(background);
		if (nativeButtons) window.setTitleBarOverlay({color: background, symbolColor: foreground, height: titleBarHeight});
		const state = {background, foreground, title: window.getTitle(), maximized: window.isMaximized(), inactive: !window.isFocused()};
		window.webContents.executeJavaScript(`(${(({background, foreground, title, maximized, inactive}: typeof state) => {
			const root = document.documentElement;
			root.style.setProperty('--background', background);
			root.style.setProperty('--foreground', foreground);
			root.toggleAttribute('data-maximized', maximized);
			root.toggleAttribute('data-inactive', inactive);
			document.getElementById('title')!.textContent = title;
		}).toString()})(${JSON.stringify(state)})`).catch(() => {});
	};
	window.webContents.on('did-finish-load', paint);
	nativeTheme.on('updated', paint);
	for (const event of ['focus', 'blur', 'maximize', 'unmaximize']) window.on(event as 'focus', paint);
	ipcMain.on('window-control', (event, action) => {
		if (event.sender !== window.webContents) return;
		if (action === 'minimize') window.minimize();
		if (action === 'maximize') {
			if (window.isMaximized()) window.unmaximize();
			else window.maximize();
		}
		if (action === 'close') window.close();
	});
	return paint;
}
