// What Messenger's pages may do: navigation, popups, permissions, downloads
// and the context menu.
import {app, clipboard, desktopCapturer, Menu, shell, type MenuItemConstructorOptions, type Session, type WebContents} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {MESSENGER} from '../shared';

const parse = (input: string) => { try { return new URL(input); } catch { return null; } };

export const isMessenger = (input: string) => parse(input)?.origin === MESSENGER;

// Account login and checkpoints stay in the app; Facebook itself does not.
export function isAuthentication(input: string): boolean {
	const url = parse(input);
	return url?.protocol === 'https:' && url.port === '' && ['www.facebook.com', 'web.facebook.com'].includes(url.hostname)
		&& ['/login', '/checkpoint', '/two_factor', '/two_step_verification'].some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

// An http(s) URL without credentials, with Facebook's l.php redirects removed.
export function externalUrl(input: string): string | null {
	let url = parse(input);
	for (let hops = 0; url && hops < 5; hops++) {
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
		if (!['l.facebook.com', 'lm.facebook.com', 'l.messenger.com'].includes(url.hostname) || url.pathname !== '/l.php') return url.href;
		url = parse(url.searchParams.get('u') ?? '');
	}
	return null;
}

export function openExternal(url: string) {
	const target = externalUrl(url);
	if (target) shell.openExternal(target).catch(error => console.error('Could not open link', error));
}

// Applied to every window: the main one and Messenger's call popups.
export function guard(contents: WebContents) {
	contents.setWindowOpenHandler(({url}) => {
		// Calls open about:blank or a Messenger URL in a popup.
		if (isMessenger(url) || url === 'about:blank') {
			return {action: 'allow', overrideBrowserWindowOptions: {width: 960, height: 720, autoHideMenuBar: true}};
		}
		openExternal(url);
		return {action: 'deny'};
	});
	contents.on('will-navigate', event => {
		if (isMessenger(event.url) || isAuthentication(event.url)) return;
		event.preventDefault();
		openExternal(event.url);
	});
	contents.on('context-menu', (_, params) => {
		const items: MenuItemConstructorOptions[] = params.dictionarySuggestions.map(word => ({label: word, click: () => contents.replaceMisspelling(word)}));
		if (params.misspelledWord) {
			items.push({label: 'Add to dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)}, {type: 'separator'});
		}
		if (params.isEditable) {
			items.push({role: 'cut', enabled: params.editFlags.canCut}, {role: 'copy', enabled: params.editFlags.canCopy},
				{role: 'paste', enabled: params.editFlags.canPaste}, {role: 'selectAll'});
		} else if (params.selectionText) {
			items.push({role: 'copy'});
		}
		const link = externalUrl(params.linkURL);
		if (link) items.push({label: 'Copy link', click: () => clipboard.writeText(link)});
		if (params.mediaType === 'image') {
			items.push({label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y)},
				{label: 'Save image', click: () => contents.downloadURL(params.srcURL)});
		}
		if (items.length > 0) Menu.buildFromTemplate(items).popup();
	});
}

const allowed = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);

export function configureSession(session: Session, downloaded: (file: string | null, name: string) => void) {
	session.setPermissionRequestHandler((_, permission, callback, details) => callback(allowed.has(permission) && isMessenger(details.requestingUrl)));
	session.setPermissionCheckHandler((_, permission, origin) => allowed.has(permission) && origin === MESSENGER);
	// Screen sharing shares the whole primary screen. On Wayland the desktop
	// portal shows its own picker.
	session.setDisplayMediaRequestHandler((request, callback) => {
		if (!isMessenger(request.securityOrigin)) return callback({});
		desktopCapturer.getSources({types: ['screen']}).then(([screen]) => {
			callback(screen ? {video: screen, ...(process.platform === 'win32' ? {audio: 'loopback' as const} : {})} : {});
		}, () => callback({}));
	});
	session.on('will-download', (_, item) => {
		const file = uniquePath(app.getPath('downloads'), item.getFilename());
		item.setSavePath(file);
		item.once('done', (__, state) => downloaded(state === 'completed' ? file : null, path.basename(file)));
	});
}

// The first free `name`, `name (1)`, … in `directory`.
export function uniquePath(directory: string, suggested: string): string {
	const name = path.basename(suggested.replace(/\\/g, '/')).replace(/[\p{Cc}<>:"|?*]/gu, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 200) || 'download';
	const {name: stem, ext} = path.parse(name);
	let file = path.join(directory, name);
	for (let counter = 1; fs.existsSync(file); counter++) file = path.join(directory, `${stem} (${counter})${ext}`);
	return file;
}
