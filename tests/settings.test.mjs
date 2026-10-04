import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';

const {outputFiles} = await build({entryPoints: ['src/inject/settings.ts'], bundle: true, write: false, format: 'iife', globalName: 'settings'});
const initial = {theme: 'system', zoomFactor: 1, alwaysOnTop: false, launchAtLogin: false,
	launchMinimized: false, quitOnWindowClose: false, showUnreadBadge: true, debugNotifications: false};

test('rapid zoom shortcuts are serialized against the last saved value', async () => {
	let stored = {...initial};
	const context = vm.createContext({window: {__TAURI_INTERNALS__: {invoke: async (command, {update} = {}) => {
		if (command === 'update_setting') stored = {...stored, [update.setting]: update.value};
		return stored;
	}}}});
	vm.runInContext(outputFiles[0].text, context);
	const client = context.settings.createSettingsClient(initial);
	await Promise.all(Array.from({length: 3}, () => client.update(value => context.settings.zoomUpdate(value, 'in'))));
	assert.equal(stored.zoomFactor, 1.3);
	await client.update(value => context.settings.zoomUpdate(value, 'reset'));
	assert.equal(stored.zoomFactor, 1);
});

test('failed setting writes restore backend state and do not block the next update', async () => {
	let stored = {...initial};
	const context = vm.createContext({window: {__TAURI_INTERNALS__: {invoke: async (command, {update} = {}) => {
		if (command === 'update_setting') {
			if (update.setting === 'launchAtLogin') throw new Error('autostart unavailable');
			stored = {...stored, [update.setting]: update.value};
		}
		return stored;
	}}}});
	vm.runInContext(outputFiles[0].text, context);
	const client = context.settings.createSettingsClient(initial);
	await assert.rejects(client.update({setting: 'launchAtLogin', value: true}), /autostart unavailable/);
	assert.equal(client.get().launchAtLogin, false);
	await client.update({setting: 'theme', value: 'dark'});
	assert.equal(client.get().theme, 'dark');
});
