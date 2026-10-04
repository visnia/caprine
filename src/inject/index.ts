import {invoke} from '@tauri-apps/api/core';
import {installStyles} from './styles';

type Bootstrap = {version: string; customCss: string};

// Navigation can take this script to another origin. The Rust capability
// independently enforces IPC; only Messenger's top frame gets our integration.
if (location.origin === 'https://www.messenger.com' && window === window.top) {
	const ready = document.readyState === 'loading'
		? new Promise<void>(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), {once: true}))
		: Promise.resolve();
	const styled = ready.then(() => installStyles(''));
	void Promise.all([styled, invoke<Bootstrap>('bootstrap')])
		.then(([, state]) => {
			installStyles(state.customCss);
			document.documentElement.dataset.caprineVersion = state.version;
			console.info('[Caprine] Messenger initialization complete');
		})
		.catch(error => console.error('[Caprine] Initialization failed', error));

	document.addEventListener('click', event => {
		const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
		if (!link || link.hasAttribute('download')) return;
		const url = new URL(link.href, location.href);
		if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) return;
		// Leave account authentication navigation to the native URL policy.
		if (location.pathname.startsWith('/login')) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		void invoke('open_external', {url: url.href})
			.catch(error => console.error('[Caprine] Could not open link', error));
	}, {capture: true});

	document.addEventListener('keydown', event => {
		if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'r') {
			event.preventDefault();
			location.reload();
		}
	});
}
