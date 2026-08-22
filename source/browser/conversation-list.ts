import {ipcRenderer as ipc} from 'electron-better-ipc';
import elementReady from 'element-ready';
import selectors from './selectors';

const icon = {
	read: 'data-caprine-icon',
	unread: 'data-caprine-icon-unread',
};

const padding = {
	top: 3,
	right: 0,
	bottom: 3,
	left: 0,
};

const lastNotifiedMessage = new Map<string, {content: string; timestamp: number}>();
const conversationPreviews = new Map<string, string>();
const duplicateNotificationWindow = 30_000;

function drawIcon(size: number, img?: HTMLImageElement): HTMLCanvasElement {
	const canvas = document.createElement('canvas');

	if (img) {
		canvas.width = size + padding.left + padding.right;
		canvas.height = size + padding.top + padding.bottom;

		const context = canvas.getContext('2d')!;
		context.beginPath();
		context.arc((size / 2) + padding.left, (size / 2) + padding.top, (size / 2), 0, Math.PI * 2, true);
		context.closePath();
		context.clip();

		context.drawImage(img, padding.left, padding.top, size, size);
	} else {
		canvas.width = 0;
		canvas.height = 0;
	}

	return canvas;
}

// Return canvas with rounded image
async function urlToCanvas(url: string, size: number): Promise<HTMLCanvasElement> {
	return new Promise(resolve => {
		const img = new Image();

		img.setAttribute('crossorigin', 'anonymous');

		img.addEventListener('load', () => {
			resolve(drawIcon(size, img));
		});

		img.addEventListener('error', () => {
			console.error('Image not found', url);
			resolve(drawIcon(size));
		});

		img.src = url;
	});
}

async function createIcons(element: HTMLElement, url: string): Promise<void> {
	const canvas = await urlToCanvas(url, 50);

	element.setAttribute(icon.read, canvas.toDataURL());

	const markerSize = 8;
	const context = canvas.getContext('2d')!;

	context.fillStyle = '#f42020';
	context.beginPath();
	context.ellipse(canvas.width - markerSize, markerSize, markerSize, markerSize, 0, 0, 2 * Math.PI);
	context.closePath();
	context.fill();

	element.setAttribute(icon.unread, canvas.toDataURL());
}

async function discoverIcons(element: HTMLElement): Promise<void> {
	const url = element.getAttribute('src');
	if (url) {
		await createIcons(element, url);
	}
}

async function getIcon(element: HTMLElement | undefined, unread: boolean): Promise<string> {
	if (!element) {
		return '';
	}

	if (!element.getAttribute(icon.read)) {
		await discoverIcons(element);
	}

	return element.getAttribute(unread ? icon.unread : icon.read)!;
}

async function getLabel(element: HTMLElement | undefined): Promise<string> {
	if (!element) {
		return '';
	}

	const textLabel = element.textContent?.trim();
	if (textLabel) {
		return textLabel;
	}

	const ariaLabel = element.getAttribute('aria-label')?.trim();
	if (ariaLabel) {
		return ariaLabel;
	}

	const clone = element.cloneNode(true) as HTMLElement;
	for (const image of clone.querySelectorAll('img')) {
		image.replaceWith(document.createTextNode(image.getAttribute('alt') ?? ''));
	}

	return clone.textContent?.trim() ?? '';
}

async function createConversationNewDesign(element: HTMLElement): Promise<Conversation> {
	const conversation: Partial<Conversation> = {};
	// TODO: Exclude muted conversations
	/*
	const muted = Boolean(element.querySelector(selectors.muteIconNewDesign));
	*/

	conversation.selected = Boolean(element.querySelector('[role=link][aria-current=page]'));
	conversation.unread = isUnreadConversation(element);

	let unparsedLabel: HTMLElement | undefined;
	for (const selector of selectors.conversationLabelSelectors) {
		const candidate = element.querySelector<HTMLElement>(selector);
		if (candidate) {
			unparsedLabel = candidate;
			break;
		}
	}

	conversation.label = await getLabel(unparsedLabel);

	const iconElement = element.querySelector<HTMLElement>('img') ?? undefined;
	conversation.icon = await getIcon(iconElement, conversation.unread);

	return conversation as Conversation;
}

async function createConversationList(): Promise<Conversation[]> {
	const conversationListSelector = selectors.conversationList;

	const list = await elementReady(conversationListSelector, {
		stopOnDomReady: false,
	});

	if (!list) {
		console.error('Could not find conversation list', conversationListSelector);
		return [];
	}

	const elements = [...list.querySelectorAll<HTMLElement>('[role=row]')]
		.filter(element => Boolean(element.querySelector('[role=link][href]')));

	const conversationResults = await Promise.all(elements.map(async element => createConversationNewDesign(element)));
	const conversations = conversationResults.filter(conversation => Boolean(conversation.label));

	return conversations;
}

export async function sendConversationList(): Promise<void> {
	const conversationsToRender: Conversation[] = await createConversationList();
	ipc.callMain('conversations', conversationsToRender);
}

function generateStringFromNode(element: Element): string | undefined {
	const cloneElement = element.cloneNode(true) as Element;
	let emojiString;

	const images = cloneElement.querySelectorAll('img');
	for (const image of images) {
		emojiString = image.alt;
		// Replace facebook's thumbs up with emoji
		if (emojiString === '(Y)' || emojiString === '(y)') {
			emojiString = '👍';
		}

		image.replaceWith(document.createTextNode(emojiString));
	}

	return cloneElement.textContent ?? undefined;
}

function isConversationRow(element: Element): element is HTMLElement {
	return element.matches('[role=row]')
		&& Boolean(element.closest('[role=navigation] [role=grid]'))
		&& Boolean(element.querySelector('[role=link][href]'));
}

function isUnreadConversation(element: Element): boolean {
	const unreadDotSelector = '.' + selectors.conversationSidebarUnreadDot.replaceAll(' ', '.');
	if (
		element.querySelector(unreadDotSelector)
		?? element.querySelector('[aria-label="Mark as Read"]')
	) {
		return true;
	}

	const textElements = element.querySelectorAll<HTMLElement>(
		`${selectors.conversationSidebarTextSelector}, [role=link] span`,
	);

	return [...textElements].some(textElement => {
		if (!textElement.textContent?.trim() || textElement.children.length > 0) {
			return false;
		}

		const {fontWeight} = getComputedStyle(textElement);
		return fontWeight === 'bold' || Number.parseInt(fontWeight, 10) >= 600;
	});
}

function getConversationText(element: Element): string[] {
	const preferredElements = [...element.querySelectorAll(selectors.conversationSidebarTextSelector)];
	const link = element.querySelector('[role=link]') ?? element;
	const textElements = preferredElements.length >= 2
		? preferredElements
		: [...link.querySelectorAll('span')].filter(textElement => textElement.children.length === 0);
	const result: string[] = [];

	for (const textElement of textElements) {
		const text = generateStringFromNode(textElement)?.trim();
		if (text && !result.includes(text)) {
			result.push(text);
		}
	}

	return result;
}

function getConversationRows(mutationsList: MutationRecord[]): HTMLElement[] {
	const rows = new Set<HTMLElement>();

	const addRow = (node: Node): void => {
		const element = node instanceof Element ? node : node.parentElement;
		const closestRow = element?.closest('[role=row]');
		if (closestRow && isConversationRow(closestRow)) {
			rows.add(closestRow);
		}

		if (element instanceof Element) {
			for (const row of element.querySelectorAll('[role=row]')) {
				if (isConversationRow(row)) {
					rows.add(row);
				}
			}
		}
	};

	for (const mutation of mutationsList) {
		addRow(mutation.target);
		for (const node of mutation.addedNodes) {
			addRow(node);
		}
	}

	return [...rows];
}

function rememberConversationPreview(element: Element): {
	href: string;
	titleText: string;
	bodyText: string;
	changed: boolean;
} | undefined {
	const href = element.querySelector('[role=link][href]')?.getAttribute('href');
	if (!href) {
		return undefined;
	}

	const [titleText = '', bodyText = ''] = getConversationText(element);
	const previousBodyText = conversationPreviews.get(href);
	conversationPreviews.set(href, bodyText);

	return {
		href,
		titleText,
		bodyText,
		changed: previousBodyText !== undefined && previousBodyText !== bodyText,
	};
}

function snapshotConversationPreviews(sidebar: Element): void {
	for (const row of sidebar.querySelectorAll('[role=row]')) {
		if (isConversationRow(row)) {
			rememberConversationPreview(row);
		}
	}
}

function notifyUnreadConversations(mutationsList: MutationRecord[]): void {
	for (const current of getConversationRows(mutationsList)) {
		const preview = rememberConversationPreview(current);
		if (!preview?.changed || !preview.bodyText || !preview.titleText) {
			continue;
		}

		const {href, titleText, bodyText} = preview;

		// The preview must both change and be unread. Messenger's own Notification
		// event remains the primary signal; this observer is only a conservative fallback.
		if (!isUnreadConversation(current)) {
			lastNotifiedMessage.delete(href);
			continue;
		}

		if (current.querySelector(selectors.muteIconNewDesign)) {
			continue;
		}

		const now = Date.now();
		const previousNotification = lastNotifiedMessage.get(href);
		if (
			previousNotification?.content === bodyText
			&& (now - previousNotification.timestamp) < duplicateNotificationWindow
		) {
			continue;
		}

		lastNotifiedMessage.set(href, {content: bodyText, timestamp: now});
		const id = [...href].reduce((hash, character) => ((hash * 31) + character.codePointAt(0)!) % 2_147_483_647, 0);

		ipc.callMain('notification', {
			id,
			href,
			source: 'conversation-list',
			title: titleText,
			body: bodyText,
			icon: current.querySelector('img')?.getAttribute(icon.read) ?? '',
			silent: false,
		});
	}
}

function parseUnreadCount(value: string | undefined): number | undefined {
	const match = value?.match(/\d[\d\s,.]*/);
	if (!match) {
		return undefined;
	}

	const count = Number.parseInt(match[0].replaceAll(/\D/g, ''), 10);
	return Number.isNaN(count) ? undefined : count;
}

function getUnreadCount(): number {
	const titleCount = parseUnreadCount(/^\(([^)]+)\)/.exec(document.title)?.[1]);
	if (titleCount !== undefined) {
		return titleCount;
	}

	const navigationCounts = [...document.querySelectorAll<HTMLElement>('[role=navigation] [aria-label]')]
		.filter(element => !element.closest('[role=grid]'))
		.map(element => parseUnreadCount(element.ariaLabel ?? undefined))
		.filter((count): count is number => count !== undefined);
	if (navigationCounts.length > 0) {
		return Math.max(...navigationCounts);
	}

	return [...document.querySelectorAll<HTMLElement>('[role=navigation] [role=grid] [role=row]')]
		.filter(element => isUnreadConversation(element)).length;
}

async function updateTrayIcon(): Promise<void> {
	ipc.callMain('update-tray-icon', getUnreadCount());
}

ipc.answerMain('refresh-unread-badge', updateTrayIcon);

window.addEventListener('load', async () => {
	const sidebar = await elementReady('[role=navigation]:has([role=grid])', {stopOnDomReady: false});

	if (sidebar) {
		snapshotConversationPreviews(sidebar);

		const conversationListObserver = new MutationObserver(async () => sendConversationList());
		const conversationCountObserver = new MutationObserver(async mutationsList => {
			notifyUnreadConversations(mutationsList);
			await updateTrayIcon();
		});

		conversationListObserver.observe(sidebar, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['class'],
		});

		conversationCountObserver.observe(sidebar, {
			characterData: true,
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['src', 'alt', 'class', 'aria-label', 'aria-current'],
		});
	}

	const titleElement = document.querySelector('title');
	if (titleElement) {
		const titleObserver = new MutationObserver(async () => updateTrayIcon());
		titleObserver.observe(titleElement, {subtree: true, childList: true, characterData: true});
	}

	await updateTrayIcon();
	window.setInterval(updateTrayIcon, 2000);
});
