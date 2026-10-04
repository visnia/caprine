// Messenger semantic selectors and accessible unread labels live here. Do not
// reintroduce obfuscated class names, font-weight guesses, or SVG path matching.
export const selectors = {
	conversationLists: '[role="navigation"] [role="grid"], nav [role="grid"], [role="navigation"] [role="list"]',
	conversationRows: '[role="row"], [role="listitem"]',
	threadLinks: 'a[href*="/t/"]',
	unreadLabels: '[aria-label]',
	actionElements: 'button, [role="button"], [role="menu"], [role="tooltip"]',
	caprineUi: '#caprine-settings-launcher, #caprine-settings-backdrop',
	unreadLabel: /\bunread\b|\bnieprzeczytan\p{L}*/iu,
	markUnreadAction: /\bmark\b.*\bunread\b|\boznacz\b.*\bnieprzeczytan\p{L}*/iu,
};

export function threadIdFromHref(href: string): string | null {
	try {
		const url = new URL(href, 'https://www.messenger.com');
		if (url.origin !== 'https://www.messenger.com') return null;
		const match = /^\/(?:e2ee\/)?t\/([^/]+)\/?$/.exec(url.pathname);
		return match?.[1] ? decodeURIComponent(match[1]) : null;
	} catch { return null; }
}
