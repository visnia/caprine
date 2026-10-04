import {selectors, threadIdFromHref} from './selectors';
import {sidebarUnreadThreads} from './unread';

export type CollectorEvent = {
	id: string;
	threadId: string | null;
	threadUrl: string | null;
	source: 'notification' | 'showNotification' | 'sidebar';
	title: string;
	body: string;
	iconDataUrl: string | null;
	timestamp: number;
	tag: string;
	data: string;
};
type Thread = {threadId: string; threadUrl: string; title: string; body: string; icon: HTMLImageElement | null};
const bound = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';

function visibleText(element: Element): string {
	const clone = element.cloneNode(true) as Element;
	for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
	return clone.textContent?.trim() ?? '';
}

export function sidebarThreads(document: Document): Map<string, Thread> {
	const threads = new Map<string, Thread>();
	for (const list of document.querySelectorAll(selectors.conversationLists)) {
		for (const row of list.querySelectorAll(selectors.conversationRows)) {
			const link = row.querySelector<HTMLAnchorElement>(selectors.threadLinks);
			const threadId = link && threadIdFromHref(link.getAttribute('href') ?? '');
			if (!threadId || !link) continue;
			// Separators are aria-hidden and the age is an <abbr>; neither is message text.
			const text = [...row.querySelectorAll(selectors.threadText)]
				.filter(el => !el.closest(selectors.actionElements) && !el.querySelector('abbr'))
				.map(visibleText).filter(Boolean);
			const title = text[0] || link.getAttribute('aria-label') || link.textContent?.trim() || 'Messenger';
			threads.set(threadId, {threadId, threadUrl: new URL(link.getAttribute('href')!, 'https://www.messenger.com').href,
				title: bound(title, 256), body: bound(text.slice(1).join(' · ') || row.getAttribute('aria-label') || '', 2048),
				icon: row.querySelector<HTMLImageElement>(selectors.avatar)});
		}
	}
	return threads;
}

// Only explicit thread fields, thread URLs, or recognized thread tags. A generic
// numeric tag is not assumed to be a thread ID. Unknown data stays diagnostic.
export function threadFromMetadata(tag: unknown, data: unknown): {threadId: string; threadUrl: string} | null {
	const from = (value: unknown, explicitId = false) => {
		if (typeof value !== 'string' && typeof value !== 'number') return null;
		const text = String(value);
		const id = threadIdFromHref(text) || (explicitId && /^[A-Za-z0-9._:-]{1,200}$/.test(text) ? text : null);
		if (!id) return null;
		return {threadId: id, threadUrl: threadIdFromHref(text) ? new URL(text, 'https://www.messenger.com').href : `https://www.messenger.com/t/${encodeURIComponent(id)}/`};
	};
	const visit = (value: unknown, depth: number): ReturnType<typeof from> => {
		if (!value || typeof value !== 'object' || depth > 3) return null;
		for (const [key, item] of Object.entries(value)) {
			if (/^(thread_?id|conversation_?id)$/i.test(key)) { const result = from(item, true); if (result) return result; }
			if (/^(url|href|link|target_url)$/i.test(key)) { const result = from(item); if (result) return result; }
			if (item && typeof item === 'object') { const result = visit(item, depth + 1); if (result) return result; }
		}
		return null;
	};
	const tagged = typeof tag === 'string' && /^(?:thread|conversation)[:=_-]([A-Za-z0-9._:-]{1,200})$/i.exec(tag);
	return visit(data, 0) || from(tag) || (tagged ? from(tagged[1], true) : null);
}

function diagnosticData(data: unknown): string {
	try { return bound(JSON.stringify(data), 2048); } catch { return '[unserializable]'; }
}

function imageData(image: HTMLImageElement | null): string | null {
	if (!image?.complete || !image.naturalWidth) return null;
	try {
		const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
		canvas.getContext('2d')?.drawImage(image, 0, 0, 64, 64);
		return canvas.toDataURL('image/png');
	} catch { return null; } // Cross-origin avatars may be unreadable; never delay delivery.
}

// Switch threads the way a sidebar click does. A full page load of an end-to-end
// encrypted thread leaves its messages unloaded, so that is only the last resort.
export function openThread(document: Document, url: string) {
	const target = threadIdFromHref(url);
	if (!target) return;
	const link = [...document.querySelectorAll(selectors.conversationLists)]
		.flatMap(list => [...list.querySelectorAll<HTMLAnchorElement>(selectors.threadLinks)])
		.find(candidate => threadIdFromHref(candidate.getAttribute('href') ?? '') === target);
	if (link) link.click();
	else document.location.assign(url);
}

export function installCollector(report: (event: CollectorEvent) => Promise<unknown>) {
	let sequence = 0;
	const documentId = crypto.randomUUID();
	const submit = (source: CollectorEvent['source'], title: string, options: NotificationOptions = {}, thread?: Thread) => {
		const threads = sidebarThreads(document);
		let identity = thread ?? threadFromMetadata(options.tag, options.data);
		if (!identity) {
			// A unique accessible conversation title can supply its href. This is
			// metadata correlation, never suppression/deduplication by text.
			const matches = [...threads.values()].filter(candidate => candidate.title === title);
			if (matches.length === 1) identity = matches[0]!;
		}
		const row = identity && threads.get(identity.threadId);
		const inlineIcon = typeof options.icon === 'string' && options.icon.startsWith('data:image/png;base64,') && options.icon.length < 100_000 ? options.icon : null;
		const event: CollectorEvent = {id: `${documentId}:${++sequence}`, source, threadId: identity?.threadId ?? null,
			threadUrl: identity?.threadUrl ?? null, title: bound(title, 256), body: bound(options.body, 2048),
			iconDataUrl: inlineIcon || imageData(thread?.icon ?? row?.icon ?? null), timestamp: Date.now(),
			tag: bound(options.tag, 512), data: diagnosticData(options.data)};
		void report(event).catch(error => console.error('[Caprine] Collector IPC failed', error));
	};
	const NativeNotification = window.Notification;
	if (typeof NativeNotification === 'function') {
		const permissionRequest = NativeNotification.requestPermission.bind(NativeNotification);
		window.Notification = new Proxy(NativeNotification, {
			construct(target, args, newTarget) {
				// The hook returns immediately; the backend holds native events for
				// 250 ms to correlate this metadata. Failed constructors emit none.
				const notification = Reflect.construct(target, args, newTarget);
				try { submit('notification', String(args[0]), args[1]); } catch (error) { console.error('[Caprine] Notification metadata failed', error); }
				return notification;
			},
			get(target, property) {
				if (property === 'requestPermission') return permissionRequest;
				return Reflect.get(target, property, target); // permission remains a live getter.
			},
		});
	}
	if (typeof ServiceWorkerRegistration !== 'undefined') {
		const original = ServiceWorkerRegistration.prototype.showNotification;
		if (original) ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
			const result = Reflect.apply(original, this, [title, options]);
			void result.then(() => {
				try { submit('showNotification', title, options); } catch (error) { console.error('[Caprine] showNotification metadata failed', error); }
			}, () => {});
			return result;
		};
	}
	// Messenger plays its message tone for every incoming message, including one
	// whose preview repeats in an already-unread chat (no sidebar change at all).
	// Patched at document start, before Messenger can cache the prototype method.
	let onMessageSound: (() => void) | undefined;
	if (typeof HTMLMediaElement !== 'undefined') {
		const play = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
			// Calls ring in a loop and videos are media, not message tones.
			if (!this.loop && !(this instanceof HTMLVideoElement)) {
				try { onMessageSound?.(); } catch (error) { console.error('[Caprine] Message sound hook failed', error); }
			}
			return Reflect.apply(play, this, []);
		};
	}
	// Rows and the message tone settle for a few seconds after a load (the unread
	// marker and a tone can arrive late); that is the baseline, not new messages.
	return {startSidebar(settleMs = 5000) {
		const settled = Date.now() + settleMs;
		const known = new Map<string, {unread: boolean; preview: string}>();
		let initialized = false;
		let queued = false;
		let lastSubmit = 0;
		const scan = () => {
			queued = false;
			const unread = sidebarUnreadThreads(document);
			for (const [id, row] of sidebarThreads(document)) {
				const state = {unread: unread.has(id), preview: row.body};
				const previous = known.get(id);
				// Initial/unseen virtualized rows are baselines, not new messages.
				// Preview comparison detects a DOM change; backend dedupe uses IDs/time.
				if (initialized && Date.now() >= settled && previous && state.unread && (!previous.unread || previous.preview !== state.preview)) {
					submit('sidebar', row.title, {body: row.body}, row);
					lastSubmit = Date.now();
				}
				known.set(id, state);
			}
			while (known.size > 2000) known.delete(known.keys().next().value!);
			initialized = true;
		};
		const observer = new MutationObserver(records => {
			if (queued || records.every(record => record.target instanceof Element && record.target.closest(selectors.caprineUi))) return;
			queued = true; queueMicrotask(scan);
		});
		observer.observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true,
			attributeFilter: ['aria-label', 'href', 'role']});
		scan();
		onMessageSound = () => {
			const heard = Date.now();
			if (heard < settled) return;
			// The tone plays just before Messenger re-renders the row. A changed
			// preview reports itself; only an unchanged one needs the tone.
			setTimeout(() => {
				if (lastSubmit >= heard) return;
				const unread = sidebarUnreadThreads(document);
				// Rows are ordered by recency: the newest message's chat comes first.
				// No unread row means the tone was for something else (e.g. sending).
				const row = [...sidebarThreads(document).values()].find(candidate => unread.has(candidate.threadId));
				if (!row) return;
				submit('sidebar', row.title, {body: row.body}, row);
				lastSubmit = Date.now();
			}, 1000);
		};
		return () => { observer.disconnect(); onMessageSound = undefined; };
	}};
}
