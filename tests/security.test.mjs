import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {setImmediate as nextTurn} from 'node:timers/promises';

const script = await readFile(new URL('../dist/inject.js', import.meta.url), 'utf8');

test('initialization is inert on other origins and child frames', () => {
	for (const origin of ['https://www.facebook.com', 'https://www.messenger.com.evil.test', 'http://www.messenger.com', 'tauri://localhost']) {
		const window = {}; window.top = window;
		vm.runInNewContext(script, {location: {origin}, window});
	}
	vm.runInNewContext(script, {location: {origin: 'https://www.messenger.com'}, window: {top: {}}});
});

test('startup inventory reaches the narrow IPC command before DOM readiness', async () => {
	const calls = [];
	const intervals = [];
	const window = {
		__TAURI_INTERNALS__: {
			invoke: async (command, args) => {
				calls.push({command, args});
				if (command === 'bootstrap') return {settings: {debugNotifications: true}};
			},
		},
	};
	window.top = window;
	vm.runInNewContext(script, {
		window,
		location: {origin: 'https://www.messenger.com'},
		document: {readyState: 'loading', addEventListener() {}},
		navigator: {serviceWorker: {getRegistrations: async () => [], controller: null}},
		setTimeout, clearTimeout,
		setInterval: (_, delay) => { intervals.push(delay); return 1; },
		clearInterval() {},
		console: {error: (...args) => assert.fail(args.join(' '))},
	});
	await nextTurn();
	assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
		{command: 'bootstrap', args: {}},
		{command: 'log_service_worker_inventory', args: {
			sample: {trigger: 'startup', status: 'ok', registrationCount: 0, controlled: false},
		}},
	]);
	assert.deepEqual(intervals, [3_600_000]);
});

test('remote capability has only app commands, exact origin, and no local access', async () => {
	const capability = JSON.parse(await readFile(new URL('../src-tauri/capabilities/messenger.json', import.meta.url), 'utf8'));
	assert.equal(capability.local, false);
	assert.deepEqual(capability.remote.urls, ['https://www.messenger.com']);
	assert.deepEqual(capability.webviews, ['main']);
	assert.deepEqual(capability.permissions, ['allow-bootstrap', 'allow-open-external', 'allow-log-service-worker-inventory', 'allow-get-settings', 'allow-update-setting', 'allow-panel-action', 'allow-report-unread', 'core:event:allow-listen', 'core:event:allow-unlisten']);
	const manifest = await readFile(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
	for (const command of ['bootstrap', 'open_external', 'log_service_worker_inventory', 'get_settings', 'update_setting', 'panel_action', 'report_unread']) {
		assert.ok(manifest.includes(`"${command}"`), `${command} must be registered in the app ACL`);
	}
});
