// Video autoplay, message tone and spell-check controls. All act only through
// standard web APIs: no Messenger selectors, network interception or script
// modification.

type MediaWindow = Pick<typeof globalThis, 'HTMLMediaElement' | 'HTMLVideoElement' | 'DOMException' | 'performance'> & {
	MediaStream?: typeof MediaStream;
	navigator: {userActivation?: {isActive: boolean}};
	addEventListener: Window['addEventListener'];
	document: Pick<Document, 'addEventListener'>;
};

// Whether a trusted pointer or key gesture happened within the last second.
function trackGestures(window: MediaWindow) {
	let lastGesture = Number.NEGATIVE_INFINITY;
	for (const type of ['pointerdown', 'keydown', 'click'] as const) {
		window.addEventListener(type, event => { if (event.isTrusted) lastGesture = window.performance.now(); }, {capture: true});
	}
	return () => window.performance.now() - lastGesture < 1000;
}

// With autoplay off, a video may only start from a recent user gesture.
// MediaStream videos (calls, camera previews) and audio elements are untouched.
export function installAutoplayGuard(window: MediaWindow) {
	if (typeof window.HTMLMediaElement !== 'function') return {set(_: boolean) {}};
	let allowed = true;
	const recentGesture = trackGestures(window);
	const activated = () => window.navigator.userActivation?.isActive === true || recentGesture();
	const blocked = (media: HTMLMediaElement) => !allowed
		&& media instanceof window.HTMLVideoElement
		&& !(window.MediaStream && media.srcObject instanceof window.MediaStream)
		&& !activated();
	const play = window.HTMLMediaElement.prototype.play;
	window.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
		// Same rejection a browser autoplay policy produces, so the page can
		// show its own paused state.
		if (blocked(this)) return Promise.reject(new window.DOMException('Video autoplay is disabled in Caprine settings', 'NotAllowedError'));
		return Reflect.apply(play, this, []) as Promise<void>;
	};
	// The autoplay attribute starts playback without calling play().
	window.document.addEventListener('play', event => {
		const target = event.target;
		if (target instanceof window.HTMLMediaElement && blocked(target)) target.pause();
	}, {capture: true});
	return {set(value: boolean) { allowed = value; }};
}

// Unless Messenger's sound is chosen, its message tone (an unprompted,
// non-looping audio element) is refused. Voice clips start from a gesture and
// calls ring in a loop, so both still play.
export function installToneGuard(window: MediaWindow) {
	if (typeof window.HTMLMediaElement !== 'function') return {set(_: boolean) {}};
	let allowed = true;
	const recentGesture = trackGestures(window);
	const play = window.HTMLMediaElement.prototype.play;
	window.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
		if (!allowed && !this.loop && !(this instanceof window.HTMLVideoElement)
			&& !(window.MediaStream && this.srcObject instanceof window.MediaStream)
			&& !recentGesture()) {
			return Promise.reject(new window.DOMException('Messenger sound is not selected in Caprine settings', 'NotAllowedError'));
		}
		return Reflect.apply(play, this, []) as Promise<void>;
	};
	return {set(value: boolean) { allowed = value; }};
}

type AudioWindow = Partial<Pick<typeof globalThis, 'AudioContext' | 'AudioScheduledSourceNode' | 'MediaElementAudioSourceNode' | 'MediaStreamAudioSourceNode' | 'AudioWorkletNode'>> & {
	webkitAudioContext?: typeof AudioContext;
	setTimeout: (handler: () => void, ms: number) => number;
	clearTimeout: (id: number | undefined) => void;
};

// WebKitGTK keeps a running AudioContext's sound server stream open even while
// it is silent, so the desktop shows Caprine as playing audio. Messenger leaves
// its contexts running; each is suspended when created and a few idle seconds
// after its last sound, and resumed when a sound starts. A context the page
// suspends itself stays suspended.
export function installAudioIdleGuard(window: AudioWindow, idleMs = 5000) {
	const Context = window.AudioContext;
	if (typeof Context !== 'function') return;
	type State = {active: number; idled: boolean; timer?: number};
	const states = new WeakMap<BaseAudioContext, State>();
	const {suspend, resume} = Context.prototype;
	const idle = (context: BaseAudioContext, state: State) => {
		state.idled = true;
		(Reflect.apply(suspend, context, []) as Promise<void>).catch(() => { state.idled = false; });
	};
	const schedule = (context: BaseAudioContext, state: State) => {
		window.clearTimeout(state.timer);
		state.timer = window.setTimeout(() => {
			if (state.active === 0 && context.state === 'running') idle(context, state);
		}, idleMs);
	};
	// Marks the context as producing sound until the returned release is called.
	const acquire = (context: BaseAudioContext) => {
		const state = states.get(context);
		if (!state) return () => {};
		state.active++;
		window.clearTimeout(state.timer);
		if (state.idled) {
			state.idled = false;
			(Reflect.apply(resume, context, []) as Promise<void>).catch(() => {});
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--state.active === 0 && !state.idled) schedule(context, state);
		};
	};
	// Media elements count while playing; streams until their audio tracks end
	// (calls); worklets synthesize sound on their own, so they keep it awake.
	const media = (context: BaseAudioContext, element: HTMLMediaElement) => {
		let release: (() => void) | undefined;
		const start = () => { release ??= acquire(context); };
		const stop = () => { release?.(); release = undefined; };
		element.addEventListener('play', start);
		for (const type of ['pause', 'ended', 'emptied']) element.addEventListener(type, stop);
		if (!element.paused) start();
	};
	const stream = (context: BaseAudioContext, source: MediaStream) => {
		const release = acquire(context);
		const check = () => { if (source.getAudioTracks().every(track => track.readyState === 'ended')) release(); };
		for (const track of source.getAudioTracks()) track.addEventListener('ended', check);
		source.addEventListener('removetrack', check);
		check();
	};
	const watch = <T extends abstract new (...args: any[]) => object>(name: keyof AudioWindow, track: (instance: InstanceType<T>, args: any[]) => void) => {
		const original = window[name] as T | undefined;
		if (typeof original !== 'function') return;
		(window as Record<string, unknown>)[name] = new Proxy(original, {construct(target, args, newTarget) {
			const instance = Reflect.construct(target, args, newTarget) as InstanceType<T>;
			track(instance, args);
			return instance;
		}});
	};

	for (const name of ['AudioContext', 'webkitAudioContext'] as const) {
		watch<typeof AudioContext>(name, context => {
			const state: State = {active: 0, idled: false};
			states.set(context, state);
			// Before it starts rendering, so no stream opens until a sound plays.
			idle(context, state);
		});
	}
	Context.prototype.suspend = function (this: AudioContext) {
		const state = states.get(this);
		if (state) { state.idled = false; window.clearTimeout(state.timer); }
		return Reflect.apply(suspend, this, []) as Promise<void>;
	};
	Context.prototype.resume = function (this: AudioContext) {
		const state = states.get(this);
		if (state) { state.idled = false; if (state.active === 0) schedule(this, state); }
		return Reflect.apply(resume, this, []) as Promise<void>;
	};
	const Scheduled = window.AudioScheduledSourceNode;
	if (typeof Scheduled === 'function') {
		const start = Scheduled.prototype.start;
		Scheduled.prototype.start = function (this: AudioScheduledSourceNode, ...args: unknown[]) {
			Reflect.apply(start, this, args);
			this.addEventListener('ended', acquire(this.context), {once: true});
		};
	}
	const prototype = Context.prototype as AudioContext & Record<string, unknown>;
	const factory = (name: string, track: (context: AudioContext, arg: any) => void) => {
		const original = prototype[name];
		if (typeof original !== 'function') return;
		prototype[name] = function (this: AudioContext, ...args: unknown[]) {
			const node = Reflect.apply(original, this, args) as unknown;
			track(this, args[0]);
			return node;
		};
	};
	factory('createMediaElementSource', media);
	factory('createMediaStreamSource', stream);
	factory('createScriptProcessor', context => { acquire(context); });
	watch<typeof MediaElementAudioSourceNode>('MediaElementAudioSourceNode', (_, [context, options]) => media(context, options.mediaElement));
	watch<typeof MediaStreamAudioSourceNode>('MediaStreamAudioSourceNode', (_, [context, options]) => stream(context, options.mediaStream));
	watch<typeof AudioWorkletNode>('AudioWorkletNode', (_, [context]) => { acquire(context); });
}

const editable ='textarea, input:not([type]), input[type="text"], input[type="search"], [contenteditable]:not([contenteditable="false"])';

// WebView2 has no native spell-check switch, so "off" sets the standard
// spellcheck attribute on editable fields and restores the originals when on.
export function createSpellcheckController(document: Document) {
	const original = new Map<Element, string | null>();
	let observer: MutationObserver | undefined;
	const disable = (element: Element) => {
		if (!original.has(element)) original.set(element, element.getAttribute('spellcheck'));
		if (element.getAttribute('spellcheck') !== 'false') element.setAttribute('spellcheck', 'false');
	};
	const scan = (root: Element) => {
		if (root.matches(editable)) disable(root);
		for (const element of root.querySelectorAll(editable)) disable(element);
		if (original.size > 500) for (const element of original.keys()) if (!element.isConnected) original.delete(element);
	};
	return {set(enabled: boolean) {
		if (!enabled && !observer) {
			scan(document.documentElement);
			observer = new MutationObserver(records => {
				for (const record of records) {
					if (record.type === 'attributes') scan(record.target as Element);
					else for (const node of record.addedNodes) if (node.nodeType === 1) scan(node as Element);
				}
			});
			observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['spellcheck', 'contenteditable', 'type']});
		} else if (enabled && observer) {
			observer.disconnect();
			observer = undefined;
			for (const [element, value] of original) {
				if (value === null) element.removeAttribute('spellcheck');
				else element.setAttribute('spellcheck', value);
			}
			original.clear();
		}
	}};
}
