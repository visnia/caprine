import assert from 'node:assert/strict';
import test from 'node:test';
import {load} from './load.mjs';

const {installMainWorld} = await load('src/preload/main-world.ts');

// Runs the serialized function the way contextBridge.executeInMainWorld does.
function setup(media = {autoplay: true, tone: true}) {
	class HTMLMediaElement {
		loop = false;
		srcObject = null;
		plays = 0;
		play() { this.plays++; return Promise.resolve(); }
		pause() { this.paused = true; }
	}
	class HTMLVideoElement extends HTMLMediaElement {}
	class MediaStream {}
	const listeners = {};
	let clock = 10_000;
	const calls = {tone: 0, notify: []};
	const globals = {
		HTMLMediaElement, HTMLVideoElement, MediaStream, DOMException, EventTarget, Promise, Reflect, Object, String, Number,
		performance: {now: () => clock},
		navigator: {},
		addEventListener: (type, listener) => { listeners[type] = listener; },
		document: {addEventListener: (type, listener) => { listeners[`document:${type}`] = listener; }},
	};
	globals.window = globals;
	const run = new Function(...Object.keys(globals), `(${installMainWorld.toString()})(arguments[arguments.length - 1]);`);
	run(...Object.values(globals), {media: () => media, tone: () => calls.tone++, notify: (title, body) => calls.notify.push([title, body])});
	const gesture = () => listeners.pointerdown({isTrusted: true});
	return {globals, media, calls, gesture, listeners, advance: ms => { clock += ms; }, HTMLMediaElement, HTMLVideoElement, MediaStream};
}

test('disabled autoplay blocks unprompted videos but not gestures or calls', async () => {
	const {media, gesture, advance, listeners, HTMLVideoElement, MediaStream} = setup();
	await new HTMLVideoElement().play();
	media.autoplay = false;
	await assert.rejects(new HTMLVideoElement().play(), {name: 'NotAllowedError'});
	const call = Object.assign(new HTMLVideoElement(), {srcObject: new MediaStream()});
	await call.play();
	gesture();
	await new HTMLVideoElement().play();
	advance(2000);
	const autoplaying = new HTMLVideoElement();
	listeners['document:play']({target: autoplaying});
	assert.equal(autoplaying.paused, true);
});

test('an unprompted, non-looping sound is the message tone and is refused unless Messenger sound is chosen', async () => {
	const {media, calls, gesture, HTMLMediaElement} = setup();
	await new HTMLMediaElement().play();
	assert.equal(calls.tone, 1);
	media.tone = false;
	await assert.rejects(new HTMLMediaElement().play(), {name: 'NotAllowedError'});
	assert.equal(calls.tone, 2);
	// Ringing loops; a voice clip starts from a gesture.
	await Object.assign(new HTMLMediaElement(), {loop: true}).play();
	gesture();
	await new HTMLMediaElement().play();
	assert.equal(calls.tone, 2);
});

test('typing does not let the message tone through', async () => {
	const {media, calls, listeners, advance, globals, HTMLMediaElement} = setup({autoplay: true, tone: false});
	listeners.keydown({isTrusted: true});
	globals.navigator.userActivation = {isActive: true};
	await assert.rejects(new HTMLMediaElement().play(), {name: 'NotAllowedError'});
	assert.equal(calls.tone, 1);
	listeners.click({isTrusted: true});
	await new HTMLMediaElement().play();
	assert.equal(calls.tone, 1);
	advance(2000);
	await assert.rejects(new HTMLMediaElement().play(), {name: 'NotAllowedError'});
	media.tone = true;
	await new HTMLMediaElement().play();
	assert.equal(calls.tone, 3);
});

test('Messenger notifications are reported instead of shown', async () => {
	const {globals, calls} = setup();
	const {Notification} = globals;
	assert.equal(Notification.permission, 'granted');
	let callback;
	assert.equal(await Notification.requestPermission(value => { callback = value; }), 'granted');
	assert.equal(callback, 'granted');
	const notification = new Notification('Alice', {body: 'hi', tag: 't'});
	assert.equal(notification.title, 'Alice');
	notification.close();
	assert.deepEqual(calls.notify, [['Alice', 'hi']]);
});
