import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {load} from './load.mjs';

async function setup(platform) {
	const clock = {now: 0};
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
		Date: {now: () => clock.now},
		setInterval() {},
	});
	const state = {visible: true, focused: false, minimized: false};
	const calls = [];
	const window = new EventEmitter();
	Object.assign(window, {isVisible: () => state.visible, isFocused: () => state.focused, isMinimized: () => state.minimized, isDestroyed: () => false, hide: () => calls.push('hide'), setOverlayIcon() {}});
	createTray(window, () => ({quitOnWindowClose: false, showUnreadBadge: true, trayIconStyle: 'color'}), () => calls.push('show'), () => {});
	const blur = () => { state.focused = false; window.emit('blur'); };
	return {click: () => trays[0].emit('click'), blur, clock, state, calls};
}

test('on Windows a tray click hides a focused window, though the click took its focus', async () => {
	const {click, blur, clock, state, calls} = await setup('win32');
	state.focused = true;
	clock.now = 1000;
	blur();
	clock.now = 1150;
	click();
	assert.deepEqual(calls, ['hide']);
});

test('on Windows a tray click raises a window behind others or minimized', async () => {
	const {click, blur, clock, state, calls} = await setup('win32');
	clock.now = 1000;
	blur();
	clock.now = 5000;
	click();
	state.minimized = true;
	click();
	assert.deepEqual(calls, ['show', 'show']);
});

test('on Linux a tray click hides a focused window and maps one behind others again', async () => {
	const {click, state, calls} = await setup('linux');
	click();
	state.focused = true;
	click();
	state.visible = false;
	click();
	assert.deepEqual(calls, ['hide', 'show', 'hide', 'show']);
});
