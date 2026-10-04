// Video autoplay and spell-check controls. Both act only through standard web
// APIs: no Messenger selectors, network interception or script modification.

type MediaWindow = Pick<typeof globalThis, 'HTMLMediaElement' | 'HTMLVideoElement' | 'DOMException' | 'performance'> & {
	MediaStream?: typeof MediaStream;
	navigator: {userActivation?: {isActive: boolean}};
	addEventListener: Window['addEventListener'];
	document: Pick<Document, 'addEventListener'>;
};

// With autoplay off, a video may only start from a recent user gesture.
// MediaStream videos (calls, camera previews) and audio elements are untouched.
export function installAutoplayGuard(window: MediaWindow) {
	if (typeof window.HTMLMediaElement !== 'function') return {set(_: boolean) {}};
	let allowed = true;
	let lastGesture = Number.NEGATIVE_INFINITY;
	for (const type of ['pointerdown', 'keydown', 'click'] as const) {
		window.addEventListener(type, event => { if (event.isTrusted) lastGesture = window.performance.now(); }, {capture: true});
	}
	const activated = () => window.navigator.userActivation?.isActive === true || window.performance.now() - lastGesture < 1000;
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

const editable = 'textarea, input:not([type]), input[type="text"], input[type="search"], [contenteditable]:not([contenteditable="false"])';

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
