import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

const {outputFiles} = await build({entryPoints: ['src/inject/page.ts'], bundle: true, write: false, format: 'iife', globalName: 'page'});

test('page kind follows the login form and the signed-in conversation list', async () => {
	const {document, window} = parseHTML('<html><body><main></main></body></html>');
	const context = vm.createContext({document, MutationObserver: window.MutationObserver, queueMicrotask});
	vm.runInContext(outputFiles[0].text, context);
	context.page.observePageKind(document);
	assert.equal(document.documentElement.dataset.caprinePage, 'other', 'loading is neither login nor app');

	document.body.innerHTML = '<form><input name="email"><input type="password"></form>';
	await nextTurn();
	assert.equal(document.documentElement.dataset.caprinePage, 'login');

	document.body.innerHTML = '<div role="navigation"><div role="grid"><div role="row"><a href="/t/1/">A</a></div></div></div>';
	await nextTurn();
	assert.equal(document.documentElement.dataset.caprinePage, 'app');
});
