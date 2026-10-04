import {selectors} from './selectors';

export type PageKind = 'login' | 'app' | 'other';

// Login: a password field is shown. App: Messenger's signed-in conversation
// list exists. Everything else (loading, interstitials) is left alone.
export function pageKind(document: Document): PageKind {
	if (document.querySelector('input[type="password"]')) return 'login';
	if (document.querySelector(selectors.conversationLists)) return 'app';
	return 'other';
}

// Publishes the kind as html[data-caprine-page] for CSS: launcher placement,
// and no document scrollbar in the viewport-fitted app shell, where Messenger's
// off-screen 1px live region otherwise overflows the root by a pixel.
export function observePageKind(document: Document): () => void {
	let queued = false;
	const update = () => {
		queued = false;
		const kind = pageKind(document);
		if (document.documentElement.dataset.caprinePage !== kind) document.documentElement.dataset.caprinePage = kind;
	};
	const observer = new MutationObserver(() => {
		if (!queued) { queued = true; queueMicrotask(update); }
	});
	observer.observe(document.body, {subtree: true, childList: true});
	update();
	return () => observer.disconnect();
}
