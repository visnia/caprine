import process from 'node:process';
import {ipcRenderer as ipc} from 'electron-better-ipc';
import {is} from 'electron-util';
import elementReady from 'element-ready';
import {nativeTheme} from '@electron/remote';
import selectors from './browser/selectors';
import {toggleVideoAutoplay} from './autoplay';
import {sendConversationList} from './browser/conversation-list';
import {IToggleSounds} from './types';

type ThemeSource = typeof nativeTheme.themeSource;

async function withMenu(
	menuButtonElement: HTMLElement,
	callback: () => Promise<void> | void,
): Promise<void> {
	const {classList} = document.documentElement;

	// Prevent the dropdown menu from displaying
	classList.add('hide-dropdowns');

	// Click the menu button
	menuButtonElement.click();

	// Wait for the menu to close before removing the 'hide-dropdowns' class
	await elementReady('.x78zum5.xdt5ytf.x1n2onr6.xat3117.xxzkxad > div:nth-child(2) > div', {stopOnDomReady: false});
	const menuLayer = document.querySelector('.x78zum5.xdt5ytf.x1n2onr6.xat3117.xxzkxad > div:nth-child(2) > div');

	if (menuLayer) {
		const observer = new MutationObserver(() => {
			if (!menuLayer.hasChildNodes()) {
				classList.remove('hide-dropdowns');
				observer.disconnect();
			}
		});
		observer.observe(menuLayer, {childList: true});
	} else {
		// Fallback in case .uiContextualLayerPositioner is missing
		classList.remove('hide-dropdowns');
	}

	await callback();
}

async function isNewSidebar(): Promise<boolean> {
	// TODO: stopOnDomReady might not be needed
	await elementReady(selectors.leftSidebar, {stopOnDomReady: false});

	const sidebars = document.querySelectorAll<HTMLElement>(selectors.leftSidebar);

	return sidebars.length === 2;
}

async function withSettingsMenu(callback: () => Promise<void> | void): Promise<void> {
	// Wait for navigation pane buttons to show up
	const settingsMenu = await elementReady(selectors.userMenuNewSidebar, {stopOnDomReady: false});

	await withMenu(settingsMenu as HTMLElement, callback);
}

async function selectMenuItem(itemNumber: number): Promise<void> {
	let selector;

	// Wait for menu to show up
	await elementReady(selectors.conversationMenuSelectorNewDesign, {stopOnDomReady: false});

	const items = document.querySelectorAll<HTMLElement>(
		`${selectors.conversationMenuSelectorNewDesign} [role=menuitem]`,
	);

	// Negative items will select from the end
	if (itemNumber < 0) {
		selector = -itemNumber <= items.length ? items[items.length + itemNumber] : null;
	} else {
		selector = itemNumber <= items.length ? items[itemNumber - 1] : null;
	}

	if (selector) {
		selector.click();
	}
}

async function selectConversationMenuItem(iconSelector: string): Promise<void> {
	await elementReady(selectors.conversationMenuSelectorNewDesign, {stopOnDomReady: false});

	const icon = document.querySelector(
		`${selectors.conversationMenuSelectorNewDesign} ${iconSelector}`,
	);
	icon?.closest<HTMLElement>('[role=menuitem]')?.click();
}

async function selectOtherListViews(itemNumber: number): Promise<void> {
	// In case one of other views is shown
	clickBackButton();

	const newSidebar = await isNewSidebar();

	if (newSidebar) {
		const items = document.querySelectorAll<HTMLElement>(
			`${selectors.viewsMenu} span > a`,
		);

		const selector = itemNumber <= items.length ? items[itemNumber - 1] : null;

		if (selector) {
			selector.click();
		}
	} else {
		await withSettingsMenu(() => {
			selectMenuItem(itemNumber);
		});
	}
}

function clickBackButton(): void {
	const backButton = document.querySelector<HTMLElement>('._30yy._2oc9');

	if (backButton) {
		backButton.click();
	}
}

ipc.answerMain('show-preferences', async () => {
	if (isPreferencesOpen()) {
		return;
	}

	await openPreferences();
});

ipc.answerMain('new-conversation', async () => {
	document.querySelector<HTMLElement>('[href="/new/"]')!.click();
});

ipc.answerMain('new-room', async () => {
	document.querySelector<HTMLElement>('.x16n37ib .x1i10hfl.x6umtig.x1b1mbwd.xaqea5y.xav7gou.x1ypdohk.xe8uvvx.xdj266r.x11i5rnm.xat24cr.x1mh8g0r.x16tdsg8.x1hl2dhg.xggy1nq.x87ps6o.x1lku1pv.x1a2a7pz.x6s0dn4.x14yjl9h.xudhj91.x18nykt9.xww2gxu.x972fbf.xcfux6l.x1qhh985.xm0m39n.x9f619.x78zum5.xl56j7k.xexx8yu.x4uap5.x18d9i69.xkhd6sd.x1n2onr6.xc9qbxq.x14qfxbe.x1qhmfi1')!.click();
});

ipc.answerMain('log-out', async () => {
	const useWorkChat = await ipc.callMain<undefined, boolean>('get-config-useWorkChat');
	if (useWorkChat) {
		document.querySelector<HTMLElement>('._5lxs._3qct._p')!.click();

		// Menu creation is slow
		setTimeout(() => {
			const nodes = document.querySelectorAll<HTMLElement>(
				'._54nq._9jo._558b._2n_z li:last-child a',
			);

			nodes[nodes.length - 1].click();
		}, 250);
	} else {
		await withSettingsMenu(() => {
			selectMenuItem(-1);
		});
	}
});

ipc.answerMain('find', () => {
	document.querySelector<HTMLElement>('[type="search"]')!.focus();
});

async function openSearchInConversation() {
	const mainView = document.querySelector('.x9f619.x1ja2u2z.x78zum5.x1n2onr6.x1r8uery.x1iyjqo2.xs83m0k.xeuugli.x1qughib.x1qjc9v5.xozqiw3.x1q0g3np.xexx8yu.x85a59c')!;
	const rightSidebarIsClosed = Boolean(mainView.querySelector<HTMLElement>(':scope > div:only-child'));

	if (rightSidebarIsClosed) {
		document.querySelector<HTMLElement>(selectors.rightSidebarMenu)?.click();
	}

	await elementReady(selectors.rightSidebarButtons, {stopOnDomReady: false});
	const buttonList = document.querySelectorAll<HTMLElement>(selectors.rightSidebarButtons);

	// Search in conversation is the last button
	buttonList[buttonList.length - 1].click();
}

ipc.answerMain('search', () => {
	openSearchInConversation();
});

ipc.answerMain('insert-gif', () => {
	document.querySelector<HTMLElement>('.x1n2onr6.x1iyjqo2.xw2csxc > div:nth-child(3) > span > div')!.click();
});

ipc.answerMain('insert-emoji', async () => {
	document.querySelector<HTMLElement>('.x1n2onr6.x1iyjqo2.xw2csxc > div:nth-child(5) > span > div')!.click();
});

ipc.answerMain('insert-sticker', () => {
	document.querySelector<HTMLElement>('.x1n2onr6.x1iyjqo2.xw2csxc > div:nth-child(2) > span > div')!.click();
});

ipc.answerMain('attach-files', () => {
	document.querySelector<HTMLElement>('.x1n2onr6.x1iyjqo2.xw2csxc > div:nth-child(1) > span > div')!.click();
});

ipc.answerMain('focus-text-input', () => {
	document.querySelector<HTMLElement>('[role=textbox][contenteditable=true]')!.focus();
});

ipc.answerMain('next-conversation', nextConversation);

ipc.answerMain('previous-conversation', previousConversation);

ipc.answerMain('mute-conversation', async () => {
	await openMuteModal();
});

ipc.answerMain('delete-conversation', async () => {
	const index = selectedConversationIndex();

	if (index !== -1) {
		await deleteSelectedConversation();

		const key = index + 1;
		await jumpToConversation(key);
	}
});

ipc.answerMain('archive-conversation', async () => {
	const index = selectedConversationIndex();

	if (index !== -1) {
		await archiveSelectedConversation();

		const key = index + 1;
		await jumpToConversation(key);
	}
});

async function openHiddenPreferences(): Promise<boolean> {
	if (!isPreferencesOpen()) {
		document.documentElement.classList.add('hide-preferences-window');

		await openPreferences();

		return true;
	}

	return false;
}

async function toggleSounds({checked}: IToggleSounds): Promise<void> {
	const shouldClosePreferences = await openHiddenPreferences();

	const soundsCheckbox = document.querySelector<HTMLInputElement>(`${selectors.preferencesSelector} ${selectors.messengerSoundsSelector}`)!;
	if (checked === undefined || checked !== soundsCheckbox.checked) {
		soundsCheckbox.click();
	}

	if (shouldClosePreferences) {
		await closePreferences();
	}
}

ipc.answerMain('toggle-sounds', toggleSounds);

ipc.answerMain('toggle-mute-notifications', async () => {
	const shouldClosePreferences = await openHiddenPreferences();

	const notificationCheckbox = document.querySelector<HTMLInputElement>(
		selectors.notificationCheckbox,
	)!;

	if (shouldClosePreferences) {
		await closePreferences();
	}

	// TODO: Fix notifications
	if (notificationCheckbox === null) {
		return false;
	}

	return !notificationCheckbox.checked;
});

ipc.answerMain('toggle-message-buttons', async () => {
	const showMessageButtons = await ipc.callMain<undefined, boolean>('get-config-showMessageButtons');
	document.body.classList.toggle('show-message-buttons', !showMessageButtons);
});

ipc.answerMain('show-chats-view', async () => {
	await selectOtherListViews(1);
});

ipc.answerMain('show-marketplace-view', async () => {
	await selectOtherListViews(2);
});

ipc.answerMain('show-requests-view', async () => {
	await selectOtherListViews(3);
});

ipc.answerMain('show-archive-view', async () => {
	await selectOtherListViews(4);
});

ipc.answerMain('toggle-video-autoplay', () => {
	toggleVideoAutoplay();
});

ipc.answerMain('reload', () => {
	location.reload();
});

async function setTheme(): Promise<void> {
	const theme = await ipc.callMain<undefined, ThemeSource>('get-config-theme');

	if (nativeTheme.themeSource !== theme) {
		nativeTheme.themeSource = theme;
	}

	updateVibrancy();
}

function observeTheme(): void {
	nativeTheme.on('updated', () => {
		void updateVibrancy();
	});
}

async function setPrivateMode(): Promise<void> {
	const privateMode = await ipc.callMain<undefined, boolean>('get-config-privateMode');
	document.documentElement.classList.toggle('private-mode', privateMode);

	if (is.macos) {
		sendConversationList();
	}
}

async function updateVibrancy(): Promise<void> {
	const {classList} = document.documentElement;

	classList.remove('sidebar-vibrancy', 'full-vibrancy');

	const vibrancy = await ipc.callMain<undefined, 'sidebar' | 'none' | 'full'>('get-config-vibrancy');

	switch (vibrancy) {
		case 'sidebar': {
			classList.add('sidebar-vibrancy');
			break;
		}

		case 'full': {
			classList.add('full-vibrancy');
			break;
		}

		default:
	}

	ipc.callMain('set-vibrancy');
}

async function updateSidebar(): Promise<void> {
	const {classList} = document.documentElement;

	classList.remove('sidebar-hidden', 'sidebar-force-narrow', 'sidebar-force-wide');

	const sidebar = await ipc.callMain<undefined, 'default' | 'hidden' | 'narrow' | 'wide'>('get-config-sidebar');

	switch (sidebar) {
		case 'hidden': {
			classList.add('sidebar-hidden');
			break;
		}

		case 'narrow': {
			classList.add('sidebar-force-narrow');
			break;
		}

		case 'wide': {
			classList.add('sidebar-force-wide');
			break;
		}

		default:
	}
}

async function updateDoNotDisturb(): Promise<void> {
	/* TODO: Implement this function
	const shouldClosePreferences = await openHiddenPreferences();

	if (shouldClosePreferences) {
		await closePreferences();
	}
	*/
}

function renderOverlayIcon(messageCount: number): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.height = 128;
	canvas.width = 128;
	canvas.style.letterSpacing = '-5px';

	const context = canvas.getContext('2d')!;
	context.fillStyle = '#f42020';
	context.beginPath();
	context.ellipse(64, 64, 64, 64, 0, 0, 2 * Math.PI);
	context.fill();
	context.textAlign = 'center';
	context.fillStyle = 'white';
	context.font = '90px sans-serif';
	context.fillText(String(Math.min(99, messageCount)), 64, 96);

	return canvas;
}

ipc.answerMain('update-sidebar', () => {
	updateSidebar();
});

ipc.answerMain('set-theme', setTheme);

ipc.answerMain('set-private-mode', setPrivateMode);

ipc.answerMain('update-vibrancy', () => {
	updateVibrancy();
});

ipc.answerMain('render-overlay-icon', (messageCount: number): {data: string; text: string} => ({
	data: renderOverlayIcon(messageCount).toDataURL(),
	text: String(messageCount),
}));

ipc.answerMain('render-native-emoji', (emoji: string): string => {
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d')!;
	const systemFont = is.linux ? 'emoji, system-ui' : 'system-ui';
	canvas.width = 256;
	canvas.height = 256;
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	if (is.macos) {
		context.font = `256px ${systemFont}`;
		context.fillText(emoji, 128, 154);
	} else {
		context.textBaseline = 'bottom';
		context.font = `225px ${systemFont}`;
		context.fillText(emoji, 128, 256);
	}

	const dataUrl = canvas.toDataURL();
	return dataUrl;
});

ipc.answerMain('zoom-reset', async () => {
	await setZoom(1);
});

ipc.answerMain('zoom-in', async () => {
	let zoomFactor = await ipc.callMain<undefined, number>('get-config-zoomFactor');
	zoomFactor += 0.1;

	if (zoomFactor < 1.6) {
		await setZoom(zoomFactor);
	}
});

ipc.answerMain('zoom-out', async () => {
	let zoomFactor = await ipc.callMain<undefined, number>('get-config-zoomFactor');
	zoomFactor -= 0.1;

	if (zoomFactor >= 0.8) {
		await setZoom(zoomFactor);
	}
});

ipc.answerMain('jump-to-conversation', async (key: number) => {
	await jumpToConversation(key);
});

async function nextConversation(): Promise<void> {
	const index = selectedConversationIndex(1);

	if (index !== -1) {
		await selectConversation(index);
	}
}

async function previousConversation(): Promise<void> {
	const index = selectedConversationIndex(-1);

	if (index !== -1) {
		await selectConversation(index);
	}
}

async function jumpToConversation(key: number): Promise<void> {
	const index = key - 1;
	await selectConversation(index);
}

function getConversationEntries(list: Element): HTMLElement[] {
	return [...list.querySelectorAll<HTMLElement>('[role=row]')]
		.filter(element => Boolean(element.querySelector('[role=link]')));
}

// Focus on the conversation with the given index
async function selectConversation(index: number): Promise<void> {
	const list = await elementReady(selectors.conversationList, {stopOnDomReady: false});

	if (!list) {
		console.error('Could not find conversations list', selectors.conversationList);
		return;
	}

	const conversation = getConversationEntries(list)[index];

	if (!conversation) {
		console.error('Could not find conversation', index);
		return;
	}

	conversation.querySelector<HTMLElement>('[role=link]')!.click();
}

function selectedConversationIndex(offset = 0): number {
	const selected = document.querySelector<HTMLElement>(selectors.selectedConversation);

	if (!selected) {
		return -1;
	}

	const conversationList = document.querySelector(selectors.conversationList);
	const newSelected = selected.closest<HTMLElement>('[role=row]');
	if (!conversationList || !newSelected || !conversationList.contains(newSelected)) {
		return -1;
	}

	const list = getConversationEntries(conversationList);
	const selectedIndex = list.indexOf(newSelected);
	if (selectedIndex === -1 || list.length === 0) {
		return -1;
	}

	const index = selectedIndex + offset;

	return ((index % list.length) + list.length) % list.length;
}

async function setZoom(zoomFactor: number): Promise<void> {
	const node = document.querySelector<HTMLElement>('#zoomFactor')!;
	node.textContent = `
		${selectors.conversationList} {zoom: ${zoomFactor} !important;}
		${selectors.conversationSelector} {zoom: ${zoomFactor} !important;}
	`;
	await ipc.callMain<number, void>('set-config-zoomFactor', zoomFactor);
}

async function withConversationMenu(callback: () => Promise<void> | void): Promise<void> {
	const selectedConversation = document.querySelector<HTMLElement>(selectors.selectedConversation);
	const conversation = selectedConversation?.closest<HTMLElement>('[role=row]');
	const conversationList = document.querySelector(selectors.conversationList);

	if (!conversation || !conversationList?.contains(conversation)) {
		return;
	}

	const menuButton = conversation.querySelector<HTMLElement>('[role=button][aria-haspopup=menu]');

	if (menuButton) {
		await withMenu(menuButton, callback);
	}
}

async function openMuteModal(): Promise<void> {
	await withConversationMenu(async () => {
		await selectConversationMenuItem(selectors.conversationMenuMuteIcon);
	});
}

async function archiveSelectedConversation(): Promise<void> {
	await withConversationMenu(async () => {
		await selectConversationMenuItem(selectors.conversationMenuArchiveIcon);
	});
}

async function deleteSelectedConversation(): Promise<void> {
	await withConversationMenu(async () => {
		await selectConversationMenuItem(selectors.conversationMenuDeleteIcon);
	});
}

async function openPreferences(): Promise<void> {
	await withSettingsMenu(() => {
		selectMenuItem(1);
	});

	await elementReady(selectors.preferencesSelector, {stopOnDomReady: false});
}

function isPreferencesOpen(): boolean {
	return Boolean(document.querySelector<HTMLElement>(selectors.preferencesSelector));
}

async function closePreferences(): Promise<void> {
	// Wait for the preferences window to be closed, then remove the class from the document
	const preferencesOverlayObserver = new MutationObserver(records => {
		const removedRecords = records.filter(({removedNodes}) => removedNodes.length > 0 && (removedNodes[0] as HTMLElement).tagName === 'DIV');

		// In case there is a div removed, hide utility class and stop observing
		if (removedRecords.length > 0) {
			document.documentElement.classList.remove('hide-preferences-window');
			preferencesOverlayObserver.disconnect();
		}
	});

	const preferencesOverlay = document.querySelector(selectors.preferencesSelector)!;

	// Get the parent of preferences, that's not getting deleted
	const preferencesParent = preferencesOverlay.closest('div:not([class])')!;

	preferencesOverlayObserver.observe(preferencesParent, {childList: true});

	const closeButton = preferencesOverlay.querySelector(selectors.closePreferencesButton)!;
	(closeButton as HTMLElement)?.click();
}

function insertionListener(event: AnimationEvent): void {
	if (event.animationName === 'nodeInserted' && event.target) {
		event.target.dispatchEvent(new Event('mouseover', {bubbles: true}));
	}
}

async function observeAutoscroll(): Promise<void> {
	const mainElement = await elementReady('._4sp8', {stopOnDomReady: false});
	if (!mainElement) {
		return;
	}

	const scrollToBottom = (): void => {
		// eslint-disable-next-line @typescript-eslint/ban-types
		const scrollableElement: HTMLElement | null = document.querySelector('[role=presentation] .scrollable');
		if (scrollableElement) {
			scrollableElement.scroll({
				top: Number.MAX_SAFE_INTEGER,
				behavior: 'smooth',
			});
		}
	};

	const hookMessageObserver = async (): Promise<void> => {
		const chatElement = await elementReady(
			'[role=presentation] .scrollable [role = region] > div[id ^= "js_"]', {stopOnDomReady: false},
		);

		if (chatElement) {
			// Scroll to the bottom when opening different conversation
			scrollToBottom();

			const messageObserver = new MutationObserver((record: MutationRecord[]) => {
				const newMessages: MutationRecord[] = record.filter(record =>
					// The mutation is an addition
					record.addedNodes.length > 0
						// ... of a div       (skip the "seen" status change)
						&& (record.addedNodes[0] as HTMLElement).tagName === 'DIV'
						// ... on the last child       (skip previous messages added when scrolling up)
						&& chatElement.lastChild!.contains(record.target),
				);

				if (newMessages.length > 0) {
					// Scroll to the bottom when there are new messages
					scrollToBottom();
				}
			});

			messageObserver.observe(chatElement, {childList: true, subtree: true});
		}
	};

	hookMessageObserver();

	// Hook it again if conversation changes
	const conversationObserver = new MutationObserver(hookMessageObserver);
	conversationObserver.observe(mainElement, {childList: true});
}

// Listen for emoji element dom insertion
document.addEventListener('animationstart', insertionListener, false);

function addMacosDragBar(): void {
	if (!is.macos) {
		return;
	}

	const dragBarHeight = 24;
	const dragBar = document.createElement('div');
	dragBar.id = 'caprine-drag-bar';
	dragBar.style.position = 'fixed';
	dragBar.style.inset = '0 0 auto';
	dragBar.style.height = `${dragBarHeight}px`;
	dragBar.style.zIndex = '99999';
	dragBar.style.setProperty('-webkit-app-region', 'drag');
	document.body.append(dragBar);

	const interactiveSelector = 'button, a[href], input, select, textarea, [role=button], [role=link], [role=search], [contenteditable=true]';
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let lastMouseX = 0;
	let lastMouseY = 0;

	document.addEventListener('mousemove', event => {
		lastMouseX = event.clientX;
		lastMouseY = event.clientY;

		if (debounceTimer) {
			return;
		}

		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;

			if (lastMouseY >= dragBarHeight) {
				dragBar.style.pointerEvents = '';
				return;
			}

			dragBar.style.pointerEvents = 'none';
			const target = document.elementFromPoint(lastMouseX, lastMouseY);

			if (!target?.closest(interactiveSelector)) {
				dragBar.style.pointerEvents = '';
			}
		}, 100);
	}, {passive: true});
}

// Inject a global style node to maintain custom appearance after conversation change or startup
document.addEventListener('DOMContentLoaded', async () => {
	const style = document.createElement('style');
	style.id = 'zoomFactor';
	document.body.append(style);

	// Set the zoom factor if it was set before quitting
	const zoomFactor = await ipc.callMain<undefined, number>('get-config-zoomFactor');
	setZoom(zoomFactor);

	// Enable OS specific styles
	document.documentElement.classList.add(`os-${process.platform}`);

	// Restore sidebar view state to what is was set before quitting
	updateSidebar();

	// Apply the preferred color scheme to Electron. Messenger handles its own theme.
	setTheme();
	// Keep native effects in sync with system theme changes.
	observeTheme();

	// Activate Private Mode if it was set before quitting
	setPrivateMode();

	// Configure do not disturb
	if (is.macos) {
		await updateDoNotDisturb();
	}

	// Disable autoplay if set in settings
	toggleVideoAutoplay();

	// Hook auto-scroll observer
	observeAutoscroll();

	addMacosDragBar();
});

// Handle title bar double-click.
window.addEventListener('dblclick', (event: Event) => {
	const target = event.target as HTMLElement;
	const titleBar = target.closest('._36ic._5l-3,._5742,._6-xk,._673w');

	if (!titleBar) {
		return;
	}

	ipc.callMain('titlebar-doubleclick');
}, {
	passive: true,
});

function isInternalChatUrl(url: URL): boolean {
	return url.hostname === location.hostname
		|| url.hostname.endsWith('.messenger.com')
		|| url.hostname === 'work.facebook.com'
		|| url.hostname === 'work.workplace.com'
		|| url.hostname.endsWith('.workplace.com');
}

// Messenger sometimes handles chat links entirely in its renderer, bypassing
// Electron's navigation handlers. Keep internal Messenger links in the app and
// send actual external links to the user's default browser.
document.addEventListener('click', event => {
	const target = event.target as HTMLElement;
	const link = target.closest<HTMLAnchorElement>('a[href]');
	const mainElement = document.querySelector('[role=main]');

	if (
		location.pathname.startsWith('/login')
		|| !link
		|| !mainElement?.contains(link)
		|| link.hasAttribute('download')
	) {
		return;
	}

	const href = link.getAttribute('href');
	if (!href || href.startsWith('#')) {
		return;
	}

	let url: URL;
	try {
		url = new URL(href, location.href);
	} catch {
		return;
	}

	if (!['http:', 'https:'].includes(url.protocol) || isInternalChatUrl(url)) {
		return;
	}

	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation();
	void ipc.callMain('open-external', url.href);
}, {capture: true});

window.addEventListener('load', async () => {
	if (location.pathname.startsWith('/login')) {
		const keepMeSignedInCheckbox = document.querySelector<HTMLInputElement>('[id^="u_0_0"]')!;
		const keepMeSignedInConfig = await ipc.callMain<undefined, boolean>('get-config-keepMeSignedIn');
		keepMeSignedInCheckbox.checked = keepMeSignedInConfig;
		keepMeSignedInCheckbox.addEventListener('change', async () => {
			const keepMeSignedIn = await ipc.callMain<undefined, boolean>('get-config-keepMeSignedIn');
			await ipc.callMain('set-config-keepMeSignedIn', keepMeSignedIn);
		});
	}
});

// Toggles styles for inactive window
window.addEventListener('blur', () => {
	document.documentElement.classList.add('is-window-inactive');
});
window.addEventListener('focus', () => {
	document.documentElement.classList.remove('is-window-inactive');
});

// It's not possible to add multiple accelerators
// so this needs to be done the old-school way
document.addEventListener('keydown', async event => {
	// The `!event.altKey` part is a workaround for https://github.com/electron/electron/issues/13895
	const combineKey = is.macos ? event.metaKey : event.ctrlKey && !event.altKey;

	if (!combineKey) {
		return;
	}

	if (event.key === ']') {
		await nextConversation();
	}

	if (event.key === '[') {
		await previousConversation();
	}

	const number = Number.parseInt(event.code.slice(-1), 10);

	if (number >= 1 && number <= 9) {
		await jumpToConversation(number);
	}
});

// Pass events sent via `window.postMessage` on to the main process
window.addEventListener('message', async ({data: {type, data}}) => {
	if (type === 'notification') {
		showNotification(data as NotificationEvent);
	}

	if (type === 'notification-reply') {
		await sendReply(data.reply as string);

		if (data.previousConversation) {
			await selectConversation(data.previousConversation as number);
		}
	}
});

function showNotification({id, href, title, body, icon, silent}: NotificationEvent): void {
	let sent = false;
	const sendNotification = (iconData: string): void => {
		if (sent) {
			return;
		}

		sent = true;
		ipc.callMain('notification', {
			id,
			href,
			source: 'messenger',
			title,
			body,
			icon: iconData,
			silent,
		});
	};

	const image = new Image();
	image.crossOrigin = 'anonymous';

	image.addEventListener('load', () => {
		const canvas = document.createElement('canvas');
		const context = canvas.getContext('2d')!;

		canvas.width = image.width;
		canvas.height = image.height;

		context.drawImage(image, 0, 0, image.width, image.height);

		sendNotification(canvas.toDataURL());
	}, {once: true});

	image.addEventListener('error', () => {
		sendNotification('');
	}, {once: true});

	if (icon) {
		image.src = icon;
	} else {
		sendNotification('');
	}
}

async function sendReply(message: string): Promise<void> {
	const inputField = document.querySelector<HTMLElement>('[contenteditable="true"]');
	if (!inputField) {
		return;
	}

	const previousMessage = inputField.textContent;

	// Send message
	inputField.focus();
	insertMessageText(message, inputField);

	const sendButton = await elementReady<HTMLElement>('._30yy._38lh', {stopOnDomReady: false});
	if (!sendButton) {
		console.error('Could not find send button');
		return;
	}

	sendButton.click();

	// Restore (possible) previous message
	if (previousMessage) {
		insertMessageText(previousMessage, inputField);
	}
}

function insertMessageText(text: string, inputField: HTMLElement): void {
	// Workaround: insert placeholder value to get execCommand working
	if (!inputField.textContent) {
		const event = new InputEvent('textInput', {
			bubbles: true,
			cancelable: true,
			data: '_',
			view: window,
		});
		inputField.dispatchEvent(event);
	}

	document.execCommand('selectAll', false, undefined);
	document.execCommand('insertText', false, text);
}

ipc.answerMain('notification-callback', async (data: NotificationCallback) => {
	window.postMessage({type: 'notification-callback', data}, '*');

	if (data.href) {
		const list = await elementReady(selectors.conversationList, {stopOnDomReady: false});
		const links = list ? [...list.querySelectorAll<HTMLElement>('[role=link]')] : [];
		const conversationLink = links
			.find(link => {
				const href = link.getAttribute('href');
				if (!href) {
					return false;
				}

				return new URL(href, location.href).href === new URL(data.href!, location.href).href;
			});
		conversationLink?.click();
	}
});

ipc.answerMain('notification-reply-callback', async (data: any) => {
	const previousConversation = selectedConversationIndex();
	data.previousConversation = previousConversation;
	window.postMessage({type: 'notification-reply-callback', data}, '*');
});
