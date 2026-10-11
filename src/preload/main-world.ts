export type Bridge = {
	media(): {autoplay: boolean; tone: boolean};
	tone(): void;
	notify(title: string, body: string): void;
};

// Runs in Messenger's own JavaScript world before its scripts, through
// contextBridge.executeInMainWorld. It is serialized, so it must not use
// anything from outside its body.
export function installMainWorld(bridge: Bridge) {
	let lastKey = Number.NEGATIVE_INFINITY;
	let lastClick = Number.NEGATIVE_INFINITY;
	addEventListener('keydown', event => { if (event.isTrusted) lastKey = performance.now(); }, {capture: true});
	// Pressing Enter or Space on a button also clicks it.
	for (const type of ['pointerdown', 'click']) {
		addEventListener(type, event => { if (event.isTrusted) lastClick = performance.now(); }, {capture: true});
	}
	const recent = (time: number) => performance.now() - time < 1000;
	const gesture = () => navigator.userActivation?.isActive === true || recent(lastKey) || recent(lastClick);
	// Calls and camera previews play MediaStreams; those are never blocked.
	const blocked = (media: HTMLMediaElement) => {
		if (media.srcObject instanceof MediaStream) return false;
		if (media instanceof HTMLVideoElement) return !gesture() && !bridge.media().autoplay;
		// An unprompted, non-looping sound is Messenger's message tone. Calls
		// ring in a loop and voice clips start from a click. Typing does not
		// count, as the tone for another chat plays while typing.
		if (media.loop || recent(lastClick)) return false;
		bridge.tone();
		return !bridge.media().tone;
	};
	const play = HTMLMediaElement.prototype.play;
	HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
		// The same rejection a browser autoplay policy produces.
		if (blocked(this)) return Promise.reject(new DOMException('Blocked by Caprine settings', 'NotAllowedError'));
		return Reflect.apply(play, this, []) as Promise<void>;
	};
	// The autoplay attribute starts videos without calling play().
	document.addEventListener('play', event => {
		const media = event.target;
		if (media instanceof HTMLVideoElement && !media.srcObject && !gesture() && !bridge.media().autoplay) media.pause();
	}, {capture: true});

	// Messenger's notifications are reported to Caprine, which shows its own.
	class CaprineNotification extends EventTarget {
		static readonly permission = 'granted';
		static requestPermission(callback?: (permission: string) => void) {
			callback?.('granted');
			return Promise.resolve('granted');
		}
		onclick = null;
		onclose = null;
		onerror = null;
		onshow = null;
		readonly title: string;
		readonly body: string;
		readonly tag: string;
		readonly data: unknown;
		constructor(title: string, options: NotificationOptions = {}) {
			super();
			this.title = String(title);
			this.body = String(options.body ?? '');
			this.tag = String(options.tag ?? '');
			this.data = options.data;
			bridge.notify(this.title, this.body);
		}
		close() {}
	}
	Object.defineProperty(window, 'Notification', {value: CaprineNotification, configurable: true, writable: true});
}
