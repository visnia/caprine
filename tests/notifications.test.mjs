import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {load} from './load.mjs';

class Variant {
	constructor(signature, value) { Object.assign(this, {signature, value}); }
}

async function setup({capabilities = ['body', 'body-markup'], fail = false} = {}) {
	const buses = [];
	const sent = [];
	const shown = [];
	let nextId = 1;
	const dbus = {
		Variant,
		sessionBus() {
			const bus = Object.assign(new EventEmitter(), {disconnected: false, disconnect() { this.disconnected = true; }});
			bus.notifications = Object.assign(new EventEmitter(), {
				GetCapabilities: async () => capabilities,
				async Notify(...args) {
					if (fail) throw new Error('No server');
					sent.push(args);
					return nextId++;
				},
			});
			bus.getProxyObject = async () => ({getInterface: () => bus.notifications});
			buses.push(bus);
			return bus;
		},
	};
	class Notification extends EventEmitter {
		constructor(options) { super(); this.options = options; }
		show() { shown.push(this); }
	}
	const {createNotifier} = await load('src/main/notifications.ts', {
		electron: {app: {getName: () => 'caprine'}, Notification},
		modules: {'@particle/dbus-next': dbus},
		process: {platform: 'linux', pid: 42, env: {CHROME_DESKTOP: 'caprine.desktop'}},
		BigInt,
		console: {error() {}},
	});
	return {notify: createNotifier('/app/icons/icon.png'), buses, sent, shown};
}
const hints = args => Object.fromEntries(Object.entries(args[6]).map(([key, variant]) => [key, variant.value]));
// Values built in the module's context have that context's prototypes.
const plain = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? `${item}n` : item));

test('a sound is named for the server, and a silent notification suppresses one', async () => {
	const {notify, sent} = await setup();
	await notify({title: 'Ann', body: 'a < b & c', sound: 'message-new-instant'}, () => {});
	await notify({title: 'Download complete', body: 'file.zip', sound: null}, () => {});
	const [message, download] = sent;
	// Windows resolves the path onto the current drive.
	assert.deepEqual(plain(message.slice(0, 6)), ['caprine', 0, pathToFileURL('/app/icons/icon.png').href, 'Ann', 'a &lt; b &amp; c', ['default', 'Open']]);
	assert.equal(message[7], -1);
	assert.deepEqual(plain(hints(message)), {'desktop-entry': 'caprine', urgency: 1, 'sender-pid': '42n', 'sound-name': 'message-new-instant'});
	assert.deepEqual(plain(hints(download)), {'desktop-entry': 'caprine', urgency: 1, 'sender-pid': '42n', 'suppress-sound': true});
});

test('the body is plain text for servers without markup, and avatars are sent as RGBA', async () => {
	const {notify, sent} = await setup({capabilities: ['body']});
	const icon = {getSize: () => ({width: 1, height: 2}), toBitmap: () => Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])};
	await notify({title: 'Ann', body: 'a < b', icon, sound: null}, () => {});
	assert.equal(sent[0][4], 'a < b');
	const image = hints(sent[0])['image-data'];
	assert.deepEqual(plain(image.slice(0, 6)), [1, 2, 4, true, 8, 4]);
	assert.deepEqual([...image[6]], [3, 2, 1, 4, 7, 6, 5, 8]);
});

test('a click passes on its activation token once', async () => {
	const {notify, buses} = await setup();
	const clicks = [];
	await notify({title: 'Ann', body: 'hi', sound: null}, token => clicks.push(token));
	await notify({title: 'Bo', body: 'hi', sound: null}, token => clicks.push(token));
	const {notifications} = buses[0];
	notifications.emit('ActivationToken', 1, 'token-1');
	notifications.emit('ActionInvoked', 1, 'default');
	notifications.emit('ActionInvoked', 1, 'default');
	notifications.emit('NotificationClosed', 2, 2);
	notifications.emit('ActionInvoked', 2, 'default');
	assert.deepEqual(clicks, ['token-1']);
});

test('without a notification server, Electron shows it and the next one connects again', async () => {
	const {notify, buses, shown} = await setup({fail: true});
	let clicked = 0;
	await notify({title: 'Ann', body: 'hi', sound: 'message-new-instant'}, () => clicked++);
	assert.equal(shown.length, 1);
	assert.deepEqual(plain(shown[0].options), {title: 'Ann', body: 'hi', icon: '/app/icons/icon.png', silent: false});
	shown[0].emit('click');
	assert.equal(clicked, 1);
	assert.equal(buses[0].disconnected, true);
	await notify({title: 'Ann', body: 'hi', sound: null}, () => {});
	assert.equal(buses.length, 2);
	assert.equal(shown[1].options.silent, true);
	await nextTurn();
});
