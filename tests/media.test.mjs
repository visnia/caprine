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

test('the tone guard refuses unprompted tones but not gestures, calls or videos', async () => {
	const fake = fakeWindow();
	const guard = load({}).installToneGuard(fake.window);
	const tone = new fake.HTMLAudioElement();
	await tone.play();
	assert.equal(tone.plays, 1, 'the tone plays by default');

	guard.set(false);
	await assert.rejects(tone.play(), {name: 'NotAllowedError'});
	assert.equal(tone.plays, 1);
	const ring = new fake.HTMLAudioElement();
	ring.loop = true;
	await ring.play();
	assert.equal(ring.plays, 1, 'looping ringtones still play');
	const video = new fake.HTMLVideoElement();
	await video.play();
	assert.equal(video.plays, 1, 'videos are left to the autoplay setting');

	fake.listeners.click({isTrusted: true});
	await tone.play();
	assert.equal(tone.plays, 2, 'a voice clip started by a gesture plays');
	fake.advance(1500);
	await assert.rejects(tone.play(), {name: 'NotAllowedError'});
	guard.set(true);
	await tone.play();
	assert.equal(tone.plays, 3);
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

function fakeAudio() {
	class Target {
		constructor() { this.listeners = {}; }
		addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
		emit(type) { for (const listener of this.listeners[type] ?? []) listener(); }
	}
	class AudioContext {
		constructor() { this.state = 'running'; this.calls = []; }
		suspend() { this.calls.push('suspend'); this.state = 'suspended'; return Promise.resolve(); }
		resume() { this.calls.push('resume'); this.state = 'running'; return Promise.resolve(); }
		createMediaElementSource() { return {}; }
		createMediaStreamSource() { return {}; }
	}
	class AudioScheduledSourceNode extends Target {
		constructor(context) { super(); this.context = context; }
		start() {}
	}
	const timers = new Map();
	let next = 0;
	const window = {
		AudioContext, AudioScheduledSourceNode,
		setTimeout: handler => { timers.set(++next, handler); return next; },
		clearTimeout: id => timers.delete(id),
	};
	const elapse = () => { const pending = [...timers.values()]; timers.clear(); for (const handler of pending) handler(); };
	return {window, Target, AudioScheduledSourceNode, elapse};
}

test('idle audio contexts are suspended and resumed when a sound starts', async () => {
	const fake = fakeAudio();
	load({}).installAudioIdleGuard(fake.window);
	const context = new fake.window.AudioContext();
	assert.ok(context instanceof fake.window.AudioContext);
	assert.deepEqual(context.calls, ['suspend'], 'a new context is suspended at once');

	const tone = new fake.AudioScheduledSourceNode(context);
	tone.start();
	assert.deepEqual(context.calls, ['suspend', 'resume']);
	fake.elapse();
	assert.equal(context.calls.length, 2, 'not suspended while the tone plays');
	tone.emit('ended');
	fake.elapse();
	assert.deepEqual(context.calls, ['suspend', 'resume', 'suspend']);

	const element = new fake.Target();
	element.paused = true;
	context.createMediaElementSource(element);
	element.emit('play');
	fake.elapse();
	assert.equal(context.calls.at(-1), 'resume', 'a playing media element keeps it awake');
	element.emit('pause');
	fake.elapse();
	assert.equal(context.calls.at(-1), 'suspend');

	const track = new fake.Target();
	track.readyState = 'live';
	const stream = new fake.Target();
	stream.getAudioTracks = () => [track];
	context.createMediaStreamSource(stream);
	fake.elapse();
	assert.equal(context.calls.at(-1), 'resume', 'a live call stream keeps it awake');
	track.readyState = 'ended';
	track.emit('ended');
	fake.elapse();
	assert.equal(context.calls.at(-1), 'suspend');
});

test('a context the page suspends is not resumed by the idle guard', async () => {
	const fake = fakeAudio();
	load({}).installAudioIdleGuard(fake.window);
	const context = new fake.window.AudioContext();
	await context.suspend();
	const tone = new fake.AudioScheduledSourceNode(context);
	tone.start();
	fake.elapse();
	assert.deepEqual(context.calls, ['suspend', 'suspend'], 'the guard\'s suspend, then the page\'s');
	await context.resume();
	tone.emit('ended');
	fake.elapse();
	assert.deepEqual(context.calls, ['suspend', 'suspend', 'resume', 'suspend'], 'resumed by the page, then idled again');
});
