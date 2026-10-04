import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {parseHTML} from 'linkedom';
import {build} from 'esbuild';

const {outputFiles} = await build({entryPoints: ['src/inject/collector.ts'], bundle: true, write: false, format: 'iife', globalName: 'collector'});
function setup(body = '') {
	const {document, window} = parseHTML(`<html><head></head><body>${body}</body></html>`);
	let permission = 'default';
	const constructed = [];
	const reports = [];
	class NativeNotification {
		static get permission() { assert.equal(this, NativeNotification); return permission; }
		static requestPermission(callback) {
			assert.equal(this, NativeNotification); permission = 'granted'; callback?.(permission); return Promise.resolve(permission);
		}
		constructor(title, options) { if (title === 'fail') throw new Error('native failure'); constructed.push({title, options}); }
	}
	class ServiceWorkerRegistration {
		showNotification(title, options) {
			assert.ok(this instanceof ServiceWorkerRegistration);
			this.args = {title, options}; return title === 'fail' ? Promise.reject(new Error('worker failed')) : Promise.resolve();
		}
	}
	window.Notification = NativeNotification;
	class HTMLMediaElement { loop = false; play() { return Promise.resolve(); } }
	class HTMLVideoElement extends HTMLMediaElement {}
	const timers = [];
	const context = vm.createContext({window, document, ServiceWorkerRegistration, Element: window.Element,
		MutationObserver: window.MutationObserver, URL, queueMicrotask, console,
		HTMLMediaElement, HTMLVideoElement, setTimeout: callback => timers.push(callback),
		crypto: {randomUUID: () => 'document-1'}});
	vm.runInContext(outputFiles[0].text, context);
	const collector = context.collector.installCollector(async event => reports.push(JSON.parse(JSON.stringify(event))));
	return {context, document, window, NativeNotification, ServiceWorkerRegistration, reports, constructed, collector, HTMLMediaElement, HTMLVideoElement, timers};
}

test('Notification retains live permission, native construction/prototype and bound permission callbacks', async () => {
	const {window, reports, constructed, NativeNotification} = setup();
	assert.equal(window.Notification.permission, 'default');
	const request = window.Notification.requestPermission;
	let callback;
	assert.equal(await request(value => { callback = value; }), 'granted');
	assert.equal(callback, 'granted');
	assert.equal(window.Notification.permission, 'granted');
	assert.equal(window.Notification.prototype, NativeNotification.prototype);
	const options = {body: 'same', tag: 'thread:123', data: {thread_id: '123'}};
	for (let i = 0; i < 2; i++) assert.ok(new window.Notification('Alice', options) instanceof NativeNotification);
	assert.equal(constructed.length, 2);
	assert.equal(reports.length, 2);
	assert.notEqual(reports[0].id, reports[1].id);
	assert.equal(reports[0].threadId, '123');
	assert.equal(reports[1].body, 'same');
	assert.throws(() => new window.Notification('fail'), /native failure/);
	assert.equal(reports.length, 2);
});

test('page showNotification preserves receiver, options, result and rejection, and emits metadata only', async () => {
	const {ServiceWorkerRegistration, reports} = setup();
	const registration = new ServiceWorkerRegistration();
	const options = {body: 'message', data: {url: 'https://www.messenger.com/e2ee/t/456/'}};
	assert.equal(await registration.showNotification('Bob', options), undefined);
	assert.equal(registration.args.options, options);
	assert.equal(reports[0].source, 'showNotification');
	assert.equal(reports[0].threadId, '456');
	assert.equal(reports[0].threadUrl, options.data.url);
	await assert.rejects(registration.showNotification('fail'), /worker failed/);
	assert.equal(reports.length, 1);
});

test('unknown tag/data never inherits the active conversation and explicit identities are restricted', () => {
	const {window, reports, context} = setup();
	new window.Notification('Unknown', {tag: '123', data: {message_id: '999'}});
	assert.equal(reports[0].threadId, null);
	assert.equal(reports[0].threadUrl, null);
	assert.equal(context.collector.threadFromMetadata('https://evil.test/t/123', {}), null);
	assert.equal(context.collector.threadFromMetadata('', {threadId: '../login'}), null);
	assert.equal(context.collector.threadFromMetadata('', {threadId: 'abc:123'}).threadId, 'abc:123');
});

test('sidebar baselines virtualized rows and emits only unread transitions or changed unread previews', async () => {
	const row = (id, unread, preview) => `<div role="row"><a href="/t/${id}"><span dir="auto">Alice ${id}</span><span dir="auto">${preview}</span></a><span class="state" aria-label="${unread ? 'Unread' : 'Read'}"></span></div>`;
	const {document, collector, reports} = setup(`<nav role="navigation"><div role="grid">${row('1', true, 'old')}${row('2', false, 'read')}</div></nav>`);
	const stop = collector.startSidebar(0);
	await nextTurn(); assert.equal(reports.length, 0);
	document.querySelectorAll('.state')[1].setAttribute('aria-label', 'Unread');
	await nextTurn(); assert.equal(reports.length, 1); assert.equal(reports[0].threadId, '2');
	document.querySelector('[role="grid"]').insertAdjacentHTML('beforeend', row('3', true, 'virtualized'));
	await nextTurn(); assert.equal(reports.length, 1);
	document.querySelectorAll('[dir="auto"]')[1].textContent = 'new';
	await nextTurn(); assert.equal(reports.length, 2); assert.equal(reports[1].threadId, '1');
	document.querySelectorAll('[dir="auto"]')[1].textContent = 'new';
	await nextTurn(); assert.equal(reports.length, 2);
	stop();
});

test('sidebar reads the hidden unread marker and sends only the preview as the body', async () => {
	const row = (id, unread, preview) => `<div role="row"><a href="/e2ee/t/${id}/"><span dir="auto"><span>Beata ${id}</span></span><div><span>${unread ? '<div>Nieprzeczytana wiadomość:</div>' : ''}<span dir="auto"><span>${preview}</span></span></span><span dir="auto"><span aria-hidden="true">·</span></span><span><span dir="auto"><abbr aria-label="2 min temu"><span>2 min</span></abbr></span></span></div></a></div>`;
	const {document, collector, reports} = setup(`<nav role="navigation"><div role="grid">${row('1', false, 'old')}${row('2', true, 'unread')}</div></nav>`);
	const stop = collector.startSidebar(0);
	await nextTurn(); assert.equal(reports.length, 0);
	// A message saying "nieprzeczytana" is message text, not the marker.
	document.querySelectorAll('[dir="auto"] span')[1].textContent = 'nieprzeczytana';
	await nextTurn(); assert.equal(reports.length, 0);
	document.querySelector('[role="row"]').outerHTML = row('1', true, 'new message');
	await nextTurn(); assert.equal(reports.length, 1);
	assert.equal(reports[0].threadId, '1'); assert.equal(reports[0].title, 'Beata 1'); assert.equal(reports[0].body, 'new message');
	stop();
});

test('the message tone reports a repeated preview the sidebar cannot see, once, and ignores calls, video and sending', async () => {
	const row = (id, unread, preview) => `<div role="row"><a href="/e2ee/t/${id}/"><span dir="auto"><span>Teresa ${id}</span></span>${unread ? '<div>Nieprzeczytana wiadomość:</div>' : ''}<span dir="auto"><span>${preview}</span></span></a></div>`;
	const {document, collector, reports, HTMLMediaElement, HTMLVideoElement, timers} = setup(`<nav role="navigation"><div role="grid">${row('1', false, 'mine')}${row('2', true, 'a')}</div></nav>`);
	const stop = collector.startSidebar(0);
	await nextTurn();
	const tone = new HTMLMediaElement();
	const ring = Object.assign(new HTMLMediaElement(), {loop: true});
	await tone.play(); await ring.play(); await new HTMLVideoElement().play();
	assert.equal(timers.length, 1);
	timers.shift()();
	// The second identical "a": topmost unread row, not the read chat above it.
	assert.equal(reports.length, 1); assert.equal(reports[0].threadId, '2'); assert.equal(reports[0].body, 'a');
	// A changed preview already reported this tone's message.
	await tone.play();
	document.querySelectorAll('[role="row"]')[1].outerHTML = row('2', true, 'b');
	await nextTurn(); assert.equal(reports.length, 2);
	timers.shift()(); assert.equal(reports.length, 2);
	// No unread chat: the tone was not an incoming message.
	document.querySelectorAll('[role="row"]')[1].outerHTML = row('2', false, 'b');
	await nextTurn(); await tone.play(); timers.shift()();
	assert.equal(reports.length, 2);
	stop();
	await tone.play(); assert.equal(timers.length, 0);
});

test('rows and tones settling right after a load are baseline, not new messages', async () => {
	const row = (id, unread, preview) => `<div role="row"><a href="/e2ee/t/${id}/"><span dir="auto">Teresa</span>${unread ? '<div>Nieprzeczytana wiadomość:</div>' : ''}<span dir="auto">${preview}</span></a></div>`;
	const {document, collector, reports, HTMLMediaElement, timers} = setup(`<nav role="navigation"><div role="grid">${row('1', false, 'a')}</div></nav>`);
	const stop = collector.startSidebar(60_000);
	await nextTurn();
	document.querySelector('[role="row"]').outerHTML = row('1', true, 'a');
	await nextTurn(); await new HTMLMediaElement().play();
	assert.equal(timers.length, 0); assert.equal(reports.length, 0);
	stop();
});

test('notification clicks switch threads through the sidebar link, falling back to a page load', () => {
	const {document, context} = setup('<nav role="navigation"><div role="grid"><div role="row"><a href="/e2ee/t/1/">One</a></div></div></nav><main><a href="/e2ee/t/2/">In message</a></main>');
	const clicked = [];
	document.querySelector('a').addEventListener('click', event => { event.preventDefault(); clicked.push('1'); });
	const assigned = [];
	Object.defineProperty(document, 'location', {value: {assign: url => assigned.push(url)}});
	context.collector.openThread(document, 'https://www.messenger.com/e2ee/t/1/');
	context.collector.openThread(document, 'https://www.messenger.com/e2ee/t/2/');
	context.collector.openThread(document, 'https://example.com/t/3/');
	assert.deepEqual(clicked, ['1']);
	assert.deepEqual(assigned, ['https://www.messenger.com/e2ee/t/2/']);
});
