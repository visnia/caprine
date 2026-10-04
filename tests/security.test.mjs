import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = await readFile(new URL('../dist/inject.js', import.meta.url), 'utf8');

test('initialization is inert on other origins and child frames', () => {
	for (const origin of ['https://www.facebook.com', 'https://www.messenger.com.evil.test', 'http://www.messenger.com', 'tauri://localhost']) {
		const window = {}; window.top = window;
		vm.runInNewContext(script, {location: {origin}, window});
	}
	vm.runInNewContext(script, {location: {origin: 'https://www.messenger.com'}, window: {top: {}}});
});

test('remote capability has only app commands, exact origin, and no local access', async () => {
	const capability = JSON.parse(await readFile(new URL('../src-tauri/capabilities/messenger.json', import.meta.url), 'utf8'));
	assert.equal(capability.local, false);
	assert.deepEqual(capability.remote.urls, ['https://www.messenger.com']);
	assert.deepEqual(capability.webviews, ['main']);
	assert.deepEqual(capability.permissions, ['allow-bootstrap', 'allow-open-external']);
	const manifest = await readFile(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
	assert.match(manifest, /AppManifest::new\(\)\.commands\(&\["bootstrap", "open_external"\]\)/);
});
