// Messenger's web app shows no notifications of its own, so new messages are
// detected from the sidebar: a chat turning unread or its preview changing,
// plus Messenger's message tone for a repeated preview in an unread chat.
import type {MessageNotice} from '../shared';
import {selectors, threadIdFromHref} from './selectors';
import {sidebarUnreadThreads} from './unread';

type Thread = {threadId: string; threadUrl: string; title: string; body: string; iconUrl: string | null};

function visibleText(element: Element): string {
	const clone = element.cloneNode(true) as Element;
	for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
	return clone.textContent?.trim() ?? '';
}

// Sidebar chats in display order, which is most recent first.
export function sidebarThreads(document: Document): Map<string, Thread> {
	const threads = new Map<string, Thread>();
	for (const list of document.querySelectorAll(selectors.conversationLists)) {
		for (const row of list.querySelectorAll(selectors.conversationRows)) {
			const link = row.querySelector<HTMLAnchorElement>(selectors.threadLinks);
			const threadId = link && threadIdFromHref(link.getAttribute('href') ?? '');
			if (!threadId || !link) continue;
			// Separators are aria-hidden and the age is an <abbr>; neither is message text.
			const text = [...row.querySelectorAll(selectors.threadText)]
				.filter(element => !element.closest(selectors.actionElements) && !element.querySelector('abbr'))
				.map(visibleText).filter(Boolean);
			threads.set(threadId, {
				threadId,
				threadUrl: new URL(link.getAttribute('href')!, 'https://www.messenger.com').href,
				title: text[0] || link.getAttribute('aria-label') || link.textContent?.trim() || 'Messenger',
				body: text.slice(1).join(' · ') || row.getAttribute('aria-label') || '',
				iconUrl: row.querySelector<HTMLImageElement>(selectors.avatar)?.src || null,
			});
		}
	}
	return threads;
}

// Switch chats the way a sidebar click does. A full page load of an end-to-end
// encrypted chat leaves its messages unloaded, so that is the last resort.
export function openThread(document: Document, url: string) {
	const target = threadIdFromHref(url);
	if (!target) return;
	const link = [...document.querySelectorAll(selectors.conversationLists)]
		.flatMap(list => [...list.querySelectorAll<HTMLAnchorElement>(selectors.threadLinks)])
		.find(candidate => threadIdFromHref(candidate.getAttribute('href') ?? '') === target);
	if (link) link.click();
	else document.location.assign(url);
}

export function createCollector(document: Document, send: (message: MessageNotice) => void, settleMs = 5000) {
	// A message can be seen twice (its tone and its row, or Messenger's own
	// notification call); one notification per chat within this window.
	const recent = new Map<string, number>();
	let lastSubmit = 0;
	const submit = (title: string, body: string, thread?: Thread) => {
		const now = Date.now();
		if (thread) {
			if (now - (recent.get(thread.threadId) ?? 0) < 2000) return;
			recent.set(thread.threadId, now);
		}
		lastSubmit = now;
		send({title, body, threadUrl: thread?.threadUrl ?? null, iconUrl: thread?.iconUrl ?? null});
	};
	// Rows and the message tone settle for a few seconds after a load (the
	// unread marker and a tone can arrive late); that is the baseline.
	let started = Number.POSITIVE_INFINITY;
	const settled = () => Date.now() - started >= settleMs;
	const known = new Map<string, {unread: boolean; preview: string}>();
	let queued = false;
	const scan = () => {
		queued = false;
		const unread = sidebarUnreadThreads(document);
		for (const [id, thread] of sidebarThreads(document)) {
			const state = {unread: unread.has(id), preview: thread.body};
			const previous = known.get(id);
			// Rows seen for the first time (initial or virtualized) are baselines.
			if (settled() && previous && state.unread && (!previous.unread || previous.preview !== state.preview)) {
				submit(thread.title, thread.body, thread);
			}
			known.set(id, state);
		}
		while (known.size > 2000) known.delete(known.keys().next().value!);
	};
	const observer = new MutationObserver(records => {
		if (queued || records.every(record => record.target instanceof Element && record.target.closest(selectors.caprineUi))) return;
		queued = true;
		queueMicrotask(scan);
	});
	return {
		start() {
			started = Date.now();
			observer.observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'href', 'role']});
			scan();
		},
		// Messenger's message tone.
		tone() {
			const heard = Date.now();
			if (!settled()) return;
			// The tone plays just before Messenger re-renders the row, and a
			// changed preview reports itself; only an unchanged one needs it.
			setTimeout(() => {
				if (lastSubmit >= heard) return;
				// Only the top (most recent) chat can be the tone's. A read top row
				// means the tone was for something else, such as a reaction.
				const thread = sidebarThreads(document).values().next().value;
				if (thread && sidebarUnreadThreads(document).has(thread.threadId)) submit(thread.title, thread.body, thread);
			}, 1000);
		},
		// Messenger calling the Notification constructor.
		notification(title: string, body: string) {
			// A unique sidebar title identifies the chat for the click.
			const matches = [...sidebarThreads(document).values()].filter(thread => thread.title === title);
			submit(title, body, matches.length === 1 ? matches[0] : undefined);
		},
	};
}
