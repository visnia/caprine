import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {load} from './load.mjs';

const web = await load('src/main/web.ts');

test('only the exact Messenger origin counts as Messenger', () => {
	assert.ok(web.isMessenger('https://www.messenger.com/t/123'));
	for (const url of ['http://www.messenger.com', 'https://messenger.com', 'https://www.messenger.com.evil.test', 'https://www.messenger.com:8443', 'https://www.facebook.com/messages', 'nonsense']) {
		assert.ok(!web.isMessenger(url), url);
	}
});

test('external links lose tracking redirects and must be plain http(s)', () => {
	assert.equal(web.externalUrl('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fx%3Fa%3D1&h=tracking'), 'https://example.com/x?a=1');
	assert.equal(web.externalUrl('https://l.messenger.com/l.php?u=javascript%3Aalert(1)'), null);
	assert.equal(web.externalUrl('file:///C:/secret'), null);
	assert.equal(web.externalUrl('https://user:password@example.com'), null);
	assert.equal(web.externalUrl('https://example.com/l.php?u=other'), 'https://example.com/l.php?u=other');
});

test('authentication pages stay in the app; the rest of Facebook does not', () => {
	assert.ok(web.isAuthentication('https://www.facebook.com/checkpoint/123'));
	for (const url of ['https://www.facebook.com/messages', 'https://www.facebook.com/login.evil', 'http://www.facebook.com/login', 'https://www.facebook.com.evil.test/login']) {
		assert.ok(!web.isAuthentication(url), url);
	}
});

test('downloads cannot escape the folder or overwrite files', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caprine-'));
	try {
		assert.equal(web.uniquePath(directory, '../../etc/passwd'), path.join(directory, 'passwd'));
		assert.equal(web.uniquePath(directory, String.raw`C:\Windows\x.dll`), path.join(directory, 'x.dll'));
		assert.equal(web.uniquePath(directory, 'a<b>?.png'), path.join(directory, 'a_b__.png'));
		assert.equal(web.uniquePath(directory, '..'), path.join(directory, 'download'));
		fs.writeFileSync(path.join(directory, 'photo.jpg'), '');
		fs.writeFileSync(path.join(directory, 'photo (1).jpg'), '');
		assert.equal(web.uniquePath(directory, 'photo.jpg'), path.join(directory, 'photo (2).jpg'));
	} finally {
		fs.rmSync(directory, {recursive: true});
	}
});

test('permission checks grant calls and clipboard to Messenger only', () => {
	const handlers = {};
	web.configureSession({
		setPermissionRequestHandler: handler => { handlers.request = handler; },
		setPermissionCheckHandler: handler => { handlers.check = handler; },
		setDisplayMediaRequestHandler() {},
		on() {},
	}, () => {});
	// Electron passes the origin as a URL, with a trailing slash.
	for (const permission of ['media', 'clipboard-sanitized-write']) assert.ok(handlers.check(null, permission, 'https://www.messenger.com/'), permission);
	assert.ok(!handlers.check(null, 'notifications', 'https://www.messenger.com/'));
	assert.ok(!handlers.check(null, 'media', 'https://www.messenger.com.evil.test/'));
	const requested = (permission, requestingUrl) => {
		let granted;
		handlers.request(null, permission, value => { granted = value; }, {requestingUrl});
		return granted;
	};
	assert.ok(requested('media', 'https://www.messenger.com/groupcall/1'));
	assert.ok(!requested('media', 'https://www.fbsbx.com/maw_proxy_page/'));
});

test('a blank popup sent to an external link opens it in the browser and closes', async () => {
	const {EventEmitter} = await import('node:events');
	const opened = [];
	const closed = [];
	const windows = new Map();
	const {guard} = await load('src/main/web.ts', {
		electron: {shell: {openExternal: async url => { opened.push(url); }}, BrowserWindow: {fromWebContents: contents => windows.get(contents)}},
		setImmediate: callback => callback(),
	});
	const popup = (url, ownWindow = true) => {
		const contents = Object.assign(new EventEmitter(), {setWindowOpenHandler() {}, getURL: () => url});
		windows.set(contents, {webContents: ownWindow ? contents : {}, close: () => closed.push(url)});
		guard(contents);
		return contents;
	};
	const navigate = (contents, url) => {
		let prevented = false;
		contents.emit('will-navigate', {url, preventDefault: () => { prevented = true; }});
		return prevented;
	};
	assert.ok(navigate(popup('about:blank'), 'https://example.com/a'));
	// A call that loaded Messenger, and Messenger in the main window's view, stay open.
	assert.ok(navigate(popup('https://www.messenger.com/groupcall/1'), 'https://example.com/b'));
	assert.ok(navigate(popup('', false), 'https://example.com/c'));
	assert.ok(!navigate(popup('about:blank'), 'https://www.messenger.com/groupcall/2'));
	assert.deepEqual(opened, ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
	assert.deepEqual(closed, ['about:blank']);
});
