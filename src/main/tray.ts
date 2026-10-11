// Tray icon, unread badge and the unread blink.
import {app, Menu, nativeImage, screen, Tray, type BrowserWindow, type NativeImage} from 'electron';
import path from 'node:path';
import type {Settings} from '../shared';

let tray: Tray | undefined;
let unread = 0;
let badge: NativeImage | null = null;
// The off phase of the blink: grey tray icon, no taskbar badge.
let dim = false;

function trayImage(lit: boolean, style: Settings['trayIconStyle']): NativeImage {
	const name = style === 'color' ? (lit ? 'tray-unread' : 'tray-read') : (lit ? 'tray-outline-unread' : 'tray-outline-read');
	let image = nativeImage.createFromPath(path.join(app.getAppPath(), 'icons', `${name}.png`));
	const {width} = image.getSize();
	let bitmap = image.toBitmap();
	// Outline icons are white masks; black recolours them for light panels.
	if (style === 'black') for (let i = 0; i < bitmap.length; i += 4) bitmap.fill(0, i, i + 3);
	if (process.platform === 'linux') {
		// Status notifier hosts scale the icon to the whole slot, while theme
		// icons leave a margin around their glyph.
		const size = Math.round(width * 7 / 6);
		const offset = Math.floor((size - width) / 2);
		const padded = Buffer.alloc(size * size * 4);
		for (let y = 0; y < width; y++) bitmap.copy(padded, ((y + offset) * size + offset) * 4, y * width * 4, (y + 1) * width * 4);
		return nativeImage.createFromBitmap(padded, {width: size, height: size});
	}
	image = nativeImage.createFromBitmap(bitmap, {width, height: width});
	// The Windows shell shrinks large tray icons with a crude filter.
	const size = Math.round(16 * screen.getPrimaryDisplay().scaleFactor);
	return image.resize({width: size, height: size, quality: 'best'});
}

export function createTray(window: BrowserWindow, settings: () => Settings, show: () => void, quit: () => void) {
	const render = () => {
		const {quitOnWindowClose, showUnreadBadge, trayIconStyle} = settings();
		// The tray is how a closed window comes back, so it shows only then.
		const showTrayIcon = !quitOnWindowClose;
		const lit = unread > 0 && !dim;
		if (showTrayIcon && !tray) {
			tray = new Tray(trayImage(false, trayIconStyle));
			tray.setContextMenu(Menu.buildFromTemplate([{label: 'Show', click: show}, {label: 'Quit', click: quit}]));
			tray.on('click', () => {
				if (window.isVisible() && window.isFocused()) window.hide();
				else show();
			});
		} else if (!showTrayIcon && tray) {
			tray.destroy();
			tray = undefined;
		}
		tray?.setImage(trayImage(lit, trayIconStyle));
		tray?.setToolTip(unread === 0 ? 'caprine — no unread chats' : `caprine — ${unread} unread chats`);
		// Linux has no taskbar badge: launchers show one only for an installed
		// desktop entry, which an AppImage does not have.
		if (process.platform === 'win32') window.setOverlayIcon(showUnreadBadge && lit ? badge : null, lit ? `${unread} unread chats` : '');
	};
	// While chats are unread and the window is not focused, the icon and badge
	// blink; a focused window shows them steadily.
	setInterval(() => {
		if (window.isDestroyed()) return;
		const next = unread > 0 && !window.isFocused() && !dim;
		if (next !== dim) {
			dim = next;
			render();
		}
	}, 800);
	render();
	return {
		render,
		setUnread(count: number, badgeDataUrl: string | null) {
			unread = count;
			badge = badgeDataUrl ? nativeImage.createFromDataURL(badgeDataUrl) : null;
			render();
		},
	};
}
