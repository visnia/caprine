import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

const {outputFiles} = await build({entryPoints: ['src/inject/unread.ts'], bundle: true, write: false, format: 'iife', globalName: 'unread'});
function page(body, title = 'Messenger') {
	const {document, window} = parseHTML(`<html><head><title>${title}</title></head><body>${body}</body></html>`);
	const context = vm.createContext({document, Element: window.Element, MutationObserver: window.MutationObserver, URL, queueMicrotask, console});
	vm.runInContext(outputFiles[0].text, context);
	return {document, api: context.unread};
}
const row = (id, label) => `<div role="row"><a href="/t/${id}">Chat</a><span aria-label="${label}"></span></div>`;
const list = rows => `<nav role="navigation"><div role="grid">${rows}</div></nav>`;

test('title count takes precedence over a virtualized sidebar', () => {
	const {document, api} = page(list(row('1', 'Unread')), '(32) Messenger');
	assert.equal(api.unreadCount(document), 32);
	document.title = '(0) Messenger';
	assert.equal(api.unreadCount(document), 0);
	assert.equal(api.titleUnreadCount('Project 123 | Messenger'), null);
});

test('semantic fallback deduplicates thread IDs and excludes action labels and foreign links', () => {
	const {document, api} = page(list(row('1', 'Unread') + row('1', 'Unread') + row('2', 'Nieprzeczytana wiadomość')
		+ row('3', 'Mark as unread') + '<div role="row"><a href="/t/4">Read chat</a><button aria-label="Unread"></button></div>'
		+ '<div role="row"><a href="https://example.com/t/5" aria-label="Unread">Other site</a></div>')
		+ '<main><div role="row" aria-label="Unread"><a href="/t/6">Message body</a></div></main>');
	assert.equal(api.unreadCount(document), 2);
});

test('title and sidebar mutations update badges without an interval and suppress unchanged counts', async () => {
	const {document, api} = page(list(row('1', 'Unread')));
	const reports = [];
	const stop = api.observeUnread(document, async count => { reports.push(count); });
	await nextTurn();
	assert.deepEqual(reports, [1]);
	document.querySelector('span').setAttribute('aria-label', 'Read');
	await nextTurn();
	assert.deepEqual(reports, [1, 0]);
	document.title = '(8) Messenger';
	await nextTurn();
	assert.deepEqual(reports, [1, 0, 8]);
	document.querySelector('[role="grid"]').insertAdjacentHTML('beforeend', row('2', 'Unread'));
	await nextTurn();
	assert.deepEqual(reports, [1, 0, 8]);
	stop();
	document.title = 'Messenger';
	await nextTurn();
	assert.deepEqual(reports, [1, 0, 8]);
});
