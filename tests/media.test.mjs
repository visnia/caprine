import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

const {outputFiles} = await build({entryPoints: ['src/inject/media.ts'], bundle: true, write: false, format: 'iife', globalName: 'media'});
const load = globals => {
	const context = vm.createContext({console, ...globals});
	vm.runInContext(outputFiles[0].text, context);
	return context.media;
};

function fakeWindow() {
	class HTMLMediaElement {
		constructor() { this.plays = 0; this.paused = true; this.srcObject = null; }
		play() { this.plays++; this.paused = false; return Promise.resolve(); }
		pause() { this.paused = true; }
	}
	class HTMLVideoElement extends HTMLMediaElement {}
	class HTMLAudioElement extends HTMLMediaElement {}
	class MediaStream {}
	const listeners = {};
	let clock = 10_000;
	const window = {
		HTMLMediaElement, HTMLVideoElement, MediaStream, DOMException,
		performance: {now: () => clock},
		navigator: {},
		addEventListener: (type, listener) => { listeners[type] = listener; },
		document: {addEventListener: (type, listener) => { listeners[`document:${type}`] = listener; }},
	};
	return {window, listeners, HTMLVideoElement, HTMLAudioElement, MediaStream, advance: ms => { clock += ms; }};
}

test('disabled autoplay blocks unprompted videos but not gestures, calls or audio', async () => {
	const fake = fakeWindow();
	const guard = load({}).installAutoplayGuard(fake.window);
	const video = new fake.HTMLVideoElement();
	await video.play();
	assert.equal(video.plays, 1, 'autoplay stays allowed by default');

	guard.set(false);
	await assert.rejects(video.play(), {name: 'NotAllowedError'});
	assert.equal(video.plays, 1);

	const call = new fake.HTMLVideoElement();
	call.srcObject = new fake.MediaStream();
	await call.play();
	assert.equal(call.plays, 1, 'MediaStream video is never blocked');
	const voice = new fake.HTMLAudioElement();
	await voice.play();
	assert.equal(voice.plays, 1, 'audio is never blocked');

	fake.listeners.click({isTrusted: true});
	await video.play();
	assert.equal(video.plays, 2, 'a recent trusted gesture permits playback');
	fake.advance(1500);
	await assert.rejects(video.play(), {name: 'NotAllowedError'});
	fake.listeners.click({isTrusted: false});
	await assert.rejects(video.play(), {name: 'NotAllowedError'}, 'synthetic clicks do not count');

	const autoplaying = new fake.HTMLVideoElement();
	autoplaying.paused = false;
	fake.listeners['document:play']({target: autoplaying});
	assert.equal(autoplaying.paused, true, 'autoplay attribute playback is paused');
	guard.set(true);
	await video.play();
	assert.equal(video.plays, 3);
});

test('spell-check off overrides editable fields and on restores their originals', async () => {
	const {document, window} = parseHTML('<html><body><div contenteditable="true" spellcheck="true" id="composer"></div><textarea id="plain"></textarea><div contenteditable="false" id="fixed"></div></body></html>');
	const controller = load({MutationObserver: window.MutationObserver}).createSpellcheckController(document);
	controller.set(false);
	assert.equal(document.getElementById('composer').getAttribute('spellcheck'), 'false');
	assert.equal(document.getElementById('plain').getAttribute('spellcheck'), 'false');
	assert.equal(document.getElementById('fixed').hasAttribute('spellcheck'), false);

	const added = document.createElement('div');
	added.setAttribute('contenteditable', 'true');
	document.body.append(added);
	await nextTurn();
	assert.equal(added.getAttribute('spellcheck'), 'false', 'new composers are covered');
	document.getElementById('composer').setAttribute('spellcheck', 'true');
	await nextTurn();
	assert.equal(document.getElementById('composer').getAttribute('spellcheck'), 'false', 'page resets are reapplied');

	controller.set(true);
	assert.equal(document.getElementById('composer').getAttribute('spellcheck'), 'true');
	assert.equal(document.getElementById('plain').hasAttribute('spellcheck'), false);
	assert.equal(added.hasAttribute('spellcheck'), false);
});
