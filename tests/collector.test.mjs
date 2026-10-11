import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {parseHTML} from 'linkedom';
import {load} from './load.mjs';

async function setup(body = '') {
	const {document, window} = parseHTML(`<html><head></head><body>${body}</body></html>`);
	const timers = [];
	const clock = {now: 1_000_000};
	const api = await load('src/preload/collector.ts', {document, Element: window.Element, MutationObserver: window.MutationObserver,
		setTimeout: callback => timers.push(callback), Date: {now: () => clock.now}});
	const sent = [];
	const collector = api.createCollector(document, message => sent.push(message), 0);
	return {api, document, collector, sent, timers, clock};
}
const list = rows => `<nav role="navigation"><div role="grid">${rows}</div></nav>`;

test('sidebar baselines virtualized rows and reports only unread transitions or changed unread previews', async () => {
	const row = (id, unread, preview) => `<div role="row"><a href="/t/${id}"><span dir="auto">Alice ${id}</span><span dir="auto">${preview}</span></a><span class="state" aria-label="${unread ? 'Unread' : 'Read'}"></span></div>`;
	const {document, collector, sent} = await setup(list(row('1', true, 'old') + row('2', false, 'read')));
	collector.start();
	await nextTurn(); assert.equal(sent.length, 0);
	document.querySelectorAll('.state')[1].setAttribute('aria-label', 'Unread');
	await nextTurn(); assert.equal(sent.length, 1); assert.equal(sent[0].threadUrl, 'https://www.messenger.com/t/2');
	document.querySelector('[role="grid"]').insertAdjacentHTML('beforeend', row('3', true, 'virtualized'));
	await nextTurn(); assert.equal(sent.length, 1);
	document.querySelectorAll('[dir="auto"]')[1].textContent = 'new';
	await nextTurn(); assert.equal(sent.length, 2); assert.equal(sent[1].title, 'Alice 1'); assert.equal(sent[1].body, 'new');
});

test('sidebar reads the hidden unread marker and sends only the preview as the body', async () => {
	const row = (id, unread, preview) => `<div role="row"><a href="/e2ee/t/${id}/"><span dir="auto"><span>Beata ${id}</span></span><div><span>${unread ? '<div>Nieprzeczytana wiadomość:</div>' : ''}<span dir="auto"><span>${preview}</span></span></span><span dir="auto"><span aria-hidden="true">·</span></span><span><span dir="auto"><abbr aria-label="2 min temu"><span>2 min</span></abbr></span></span></div></a></div>`;
	const {document, collector, sent} = await setup(list(row('1', false, 'old') + row('2', true, 'unread')));
	collector.start();
	await nextTurn(); assert.equal(sent.length, 0);
	// A message saying "nieprzeczytana" is message text, not the marker.
	document.querySelectorAll('[dir="auto"] span')[1].textContent = 'nieprzeczytana';
	await nextTurn(); assert.equal(sent.length, 0);
	document.querySelector('[role="row"]').outerHTML = row('1', true, 'new message');
	await nextTurn();
	assert.deepEqual(sent.map(({title, body, threadUrl}) => ({title, body, threadUrl})),
		[{title: 'Beata 1', body: 'new message', threadUrl: 'https://www.messenger.com/e2ee/t/1/'}]);
});

test('the message tone reports a repeated preview in the newest unread chat only', async () => {
	const row = (id, unread, preview) => `<div role="row"><a href="/e2ee/t/${id}/"><span dir="auto"><span>Teresa ${id}</span></span>${unread ? '<div>Nieprzeczytana wiadomość:</div>' : ''}<span dir="auto"><span>${preview}</span></span></a></div>`;
	const {document, collector, sent, timers, clock} = await setup(list(row('2', true, 'a') + row('1', false, 'mine')));
	collector.start();
	await nextTurn();
	collector.tone();
	timers.shift()();
	assert.equal(sent.length, 1); assert.equal(sent[0].body, 'a');
	// A changed preview already reported this tone's message.
	clock.now += 5000; // Past the per-chat repeat window.
	collector.tone();
	document.querySelectorAll('[role="row"]')[0].outerHTML = row('2', true, 'b');
	await nextTurn(); assert.equal(sent.length, 2);
	timers.shift()(); assert.equal(sent.length, 2);
	// A read chat on top (the open chat, or sending): not this tone's message.
	document.querySelector('[role="grid"]').insertAdjacentHTML('afterbegin', row('3', false, 'open chat'));
	await nextTurn(); collector.tone(); timers.shift()();
	assert.equal(sent.length, 2);
});

test('nothing is reported while the sidebar settles after a load', async () => {
	const {document, window} = parseHTML(`<html><body>${list('<div role="row"><a href="/t/1"><span dir="auto">A</span></a><span aria-label="Read"></span></div>')}</body></html>`);
	const timers = [];
	const api = await load('src/preload/collector.ts', {document, Element: window.Element, MutationObserver: window.MutationObserver, setTimeout: callback => timers.push(callback)});
	const sent = [];
	const collector = api.createCollector(document, message => sent.push(message), 60_000);
	collector.start();
	await nextTurn();
	document.querySelector('[aria-label]').setAttribute('aria-label', 'Unread');
	await nextTurn(); collector.tone();
	assert.equal(timers.length, 0); assert.equal(sent.length, 0);
});

test('Messenger notifications find their chat by a unique sidebar title and are not repeated by the sidebar', async () => {
	const row = (id, name, unread) => `<div role="row"><a href="/t/${id}"><span dir="auto">${name}</span><span dir="auto">hi</span></a><span class="state" aria-label="${unread ? 'Unread' : 'Read'}"></span></div>`;
	const {document, collector, sent} = await setup(list(row('1', 'Ann', false) + row('2', 'Bo', false) + row('3', 'Bo', false)));
	collector.start();
	await nextTurn();
	collector.notification('Ann', 'hi');
	document.querySelector('.state').setAttribute('aria-label', 'Unread');
	await nextTurn();
	collector.notification('Bo', 'ambiguous');
	assert.deepEqual(sent.map(message => message.threadUrl), ['https://www.messenger.com/t/1', null]);
});

test('notification clicks switch chats through the sidebar link, falling back to a page load', async () => {
	const {api, document} = await setup('<nav role="navigation"><div role="grid"><div role="row"><a href="/e2ee/t/1/">One</a></div></div></nav><main><a href="/e2ee/t/2/">In message</a></main>');
	const clicked = [];
	document.querySelector('a').addEventListener('click', event => { event.preventDefault(); clicked.push('1'); });
	const assigned = [];
	Object.defineProperty(document, 'location', {value: {assign: url => assigned.push(url)}});
	api.openThread(document, 'https://www.messenger.com/e2ee/t/1/');
	api.openThread(document, 'https://www.messenger.com/e2ee/t/2/');
	api.openThread(document, 'https://example.com/t/3/');
	assert.deepEqual(clicked, ['1']);
	assert.deepEqual(assigned, ['https://www.messenger.com/e2ee/t/2/']);
});
