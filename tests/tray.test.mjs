import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {load} from './load.mjs';

async function setup(platform) {
	const trays = [];
	class Tray extends EventEmitter {
		constructor() { super(); trays.push(this); }
		setContextMenu() {}
		setImage() {}
		setToolTip() {}
		destroy() {}
	}
	const image = {getSize: () => ({width: 4, height: 4}), toBitmap: () => Buffer.alloc(64), resize: () => image};
	const {createTray} = await load('src/main/tray.ts', {
		electron: {
			app: {getAppPath: () => '/app'},
			Menu: {buildFromTemplate: template => template},
			Tray,
			nativeImage: {createFromPath: () => image, createFromBitmap: () => image, createFromDataURL: () => image},
			screen: {getPrimaryDisplay: () => ({scaleFactor: 1})},
		},
		process: {platform},
		Buffer,
		setInterval() {},
	});
	const state = {visible: true, focused: false, minimized: false};
	const calls = [];
	const window = {isVisible: () => state.visible, isFocused: () => state.focused, isMinimized: () => state.minimized, isDestroyed: () => false, hide: () => calls.push('hide'), setOverlayIcon() {}};
	createTray(window, () => ({quitOnWindowClose: false, showUnreadBadge: true, trayIconStyle: 'color'}), () => calls.push('show'), () => {});
	return {click: () => trays[0].emit('click'), state, calls};
}

test('on Windows a tray click hides a shown window, though the click took its focus', async () => {
	const {click, state, calls} = await setup('win32');
	click();
	state.minimized = true;
	click();
	state.visible = false;
	state.minimized = false;
	click();
	assert.deepEqual(calls, ['hide', 'show', 'show']);
});

test('on Linux a tray click hides a focused window and raises one behind others', async () => {
	const {click, state, calls} = await setup('linux');
	click();
	state.focused = true;
	click();
	state.visible = false;
	click();
	assert.deepEqual(calls, ['show', 'hide', 'show']);
});
