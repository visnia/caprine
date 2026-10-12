import assert from 'node:assert/strict';
import test from 'node:test';
import {load} from './load.mjs';

const {sanitize, changed} = await load('src/main/settings.ts', {electron: {app: {}}});
const defaults = sanitize({});

test('stored settings keep valid values and drop unknown or invalid ones', () => {
	const settings = sanitize({theme: 'oled', zoomFactor: 3, alwaysOnTop: 'yes', debugNotifications: true, trayIconStyle: 'red', autoUpdate: false});
	assert.equal(settings.theme, 'oled');
	assert.equal(settings.zoomFactor, 1);
	assert.equal(settings.alwaysOnTop, false);
	assert.equal(settings.trayIconStyle, 'color');
	assert.equal(settings.autoUpdate, false);
	assert.equal('debugNotifications' in settings, false);
});

test('updates reject unknown settings, wrong types and invalid zoom', () => {
	for (const [key, value] of [['privateMode', true], ['__proto__', {}], ['theme', 'vibrant'], ['launchMinimized', 'false'], ['zoomFactor', 2.1], ['zoomFactor', Number.NaN]]) {
		assert.throws(() => changed(defaults, key, value), /Invalid value/, key);
	}
	assert.equal(changed(defaults, 'zoomFactor', 1.5).zoomFactor, 1.5);
});

test('the removed tray icon switch is ignored and cannot be set', () => {
	assert.equal('showTrayIcon' in sanitize({showTrayIcon: false}), false);
	assert.throws(() => changed(defaults, 'showTrayIcon', false), /Invalid value/);
	assert.equal(changed(defaults, 'quitOnWindowClose', true).quitOnWindowClose, true);
});

test('Catppuccin themes are stored and render Messenger in their own scheme', async () => {
	const {themeScheme} = await load('src/shared.ts');
	assert.equal(sanitize({theme: 'latte'}).theme, 'latte');
	assert.equal(changed(defaults, 'theme', 'mocha').theme, 'mocha');
	assert.deepEqual(['system', 'light', 'dark', 'oled', 'latte', 'mocha'].map(themeScheme), ['system', 'light', 'dark', 'dark', 'light', 'dark']);
});
