// Messenger semantic selectors and accessible unread markers live here. Do not
// reintroduce obfuscated class names, font-weight guesses, or SVG path matching.
// As of 2026-10-04 an unread row has no unread aria-label; it carries visually
// hidden text ("Nieprzeczytana wiadomość:") before the preview. Bold text was
// tried: it is applied after the rows render, so loading replayed every
// already-unread chat as a new message.
export const selectors = {
	conversationLists: '[role="navigation"] [role="grid"], nav [role="grid"], [role="navigation"] [role="list"]',
	conversationRows: '[role="row"], [role="listitem"]',
	threadLinks: 'a[href*="/t/"]',
	threadText: '[dir="auto"]',
	avatar: 'img',
	unreadLabels: '[aria-label]',
	actionElements: 'button, [role="button"], [role="menu"], [role="tooltip"]',
	caprineUi: '#caprine-settings-launcher, #caprine-settings-backdrop',
	unreadLabel: /\bunread\b|\bnieprzeczytan\p{L}*/iu,
	markUnreadAction: /\bmark\b.*\bunread\b|\boznacz\b.*\bnieprzeczytan\p{L}*/iu,
	// Whole-text match outside message text, so a preview saying "unread" never counts.
	unreadMarker: /^(?:unread|nieprzeczytan\p{L}*)(?:\s+\p{L}+)?\s*:?$/iu,
};

export function threadIdFromHref(href: string): string | null {
	try {
		const url = new URL(href, 'https://www.messenger.com');
		if (url.origin !== 'https://www.messenger.com') return null;
		const match = /^\/(?:e2ee\/)?t\/([^/]+)\/?$/.exec(url.pathname);
		return match?.[1] ? decodeURIComponent(match[1]) : null;
	} catch { return null; }
}
