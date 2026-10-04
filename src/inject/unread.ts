import {selectors, threadIdFromHref} from './selectors';

export function titleUnreadCount(title: string): number | null {
	const match = /^(?:\((\d+)\)|\[(\d+)\])\s*/.exec(title.trim());
	return match ? Math.min(Number(match[1] ?? match[2]), 1_000_000) : null;
}

export function sidebarUnreadThreads(document: Document): Set<string> {
	const threads = new Set<string>();
	for (const list of document.querySelectorAll(selectors.conversationLists)) {
		for (const row of list.querySelectorAll(selectors.conversationRows)) {
			const link = row.querySelector<HTMLAnchorElement>(selectors.threadLinks);
			const threadId = link && threadIdFromHref(link.getAttribute('href') ?? '');
			if (!threadId) continue;
			const labelled = [row, ...row.querySelectorAll(selectors.unreadLabels)];
			if (labelled.some(element => {
				if (element.closest(selectors.actionElements)) return false;
				const label = element.getAttribute('aria-label') ?? '';
				return selectors.unreadLabel.test(label) && !selectors.markUnreadAction.test(label);
			})) threads.add(threadId);
		}
	}
	return threads;
}

export function unreadCount(document: Document): number {
	// The title covers off-screen/virtualized conversations; the sidebar can only
	// be a lower-bound fallback when Messenger doesn't publish a title count.
	return titleUnreadCount(document.title) ?? sidebarUnreadThreads(document).size;
}

export function observeUnread(document: Document, report: (count: number) => Promise<void>): () => void {
	let last: number | undefined;
	let queued = false;
	let stopped = false;
	let sending = false;
	let next: number | undefined;
	const flush = async () => {
		if (sending || stopped) return;
		sending = true;
		try {
			while (next !== undefined && !stopped) {
				const count = next;
				next = undefined;
				if (count !== last) { await report(count); last = count; }
			}
		} catch (error) { console.error('[Caprine] Could not update unread badge', error); }
		finally { sending = false; }
	};
	const schedule = () => {
		if (queued || stopped) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			if (stopped) return;
			next = unreadCount(document);
			void flush();
		});
	};
	const titleObserver = new MutationObserver(schedule);
	titleObserver.observe(document.head, {subtree: true, childList: true, characterData: true});
	const sidebarObserver = new MutationObserver(records => {
		if (records.some(record => !(record.target instanceof Element && record.target.closest(selectors.caprineUi)))) schedule();
	});
	sidebarObserver.observe(document.body, {subtree: true, childList: true, attributes: true,
		attributeFilter: ['aria-label', 'aria-current', 'aria-selected', 'href', 'role']});
	schedule();
	return () => { stopped = true; titleObserver.disconnect(); sidebarObserver.disconnect(); };
}
