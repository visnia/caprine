import {invoke} from '@tauri-apps/api/core';
import {applyTheme, installStyles} from './styles';
import {startServiceWorkerDiagnostics} from './service-worker-diagnostics';
import {createSettingsClient, zoomUpdate, type Settings} from './settings';
import {initializeSettingsPanel} from './settings-panel';
import {observeUnread} from './unread';
import {installCollector} from './collector';
import {createSpellcheckController, installAutoplayGuard} from './media';

type Bootstrap = {version: string; platform: 'windows' | 'linux'; customCss: string; customCssError: string | null; settings: Settings};

// Navigation can take this script to another origin. The Rust capability
// independently enforces IPC; only Messenger's top frame gets our integration.
if (location.origin === 'https://www.messenger.com' && window === window.top) {
	const collector = installCollector(event => invoke('collect_notification', {event}));
	// Patched at document start, before Messenger can cache HTMLMediaElement.play.
	const autoplay = installAutoplayGuard(window);
	const ready = document.readyState === 'loading'
		? new Promise<void>(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), {once: true}))
		: Promise.resolve();
	const styled = ready.then(() => installStyles(''));
	const bootstrap = invoke<Bootstrap>('bootstrap');
	let debugEnabled = false;
	let stopDiagnostics: (() => void) | undefined;
	const applyDiagnostics = (settings: Settings) => {
		if (debugEnabled === settings.debugNotifications) return;
		debugEnabled = settings.debugNotifications;
		stopDiagnostics?.();
		stopDiagnostics = startServiceWorkerDiagnostics(debugEnabled, sample => invoke('log_service_worker_inventory', {sample}));
	};
	void bootstrap.then(state => {
		applyDiagnostics(state.settings);
	}).catch(error => console.error('[Caprine] Could not initialize notification diagnostics', error));
	void Promise.all([styled, bootstrap])
		.then(async ([, state]) => {
			installStyles(state.customCss);
			const settings = createSettingsClient(state.settings);
			const spellcheck = createSpellcheckController(document);
			const applySettings = (value: Settings) => {
				applyTheme(value.theme); applyDiagnostics(value);
				autoplay.set(value.autoplayVideos); spellcheck.set(value.spellCheck);
			};
			settings.subscribe(applySettings);
			applySettings(settings.get());
			const panel = initializeSettingsPanel(settings, state.version, state.platform);
			observeUnread(document, count => invoke('report_unread', {count}));
			collector.startSidebar();
			document.addEventListener('keydown', event => {
				if (!event.ctrlKey || event.altKey || event.metaKey) return;
				if (event.code === 'Comma' || event.key === ',') {
					event.preventDefault(); event.stopImmediatePropagation(); panel.toggle();
				}
				const direction = event.code === 'Equal' || event.code === 'NumpadAdd' ? 'in'
					: event.code === 'Minus' || event.code === 'NumpadSubtract' ? 'out'
						: event.code === 'Digit0' || event.code === 'Numpad0' ? 'reset' : null;
				if (direction) {
					event.preventDefault(); event.stopImmediatePropagation();
					void settings.update(current => zoomUpdate(current, direction)).catch(error => console.error('[Caprine] Could not change zoom', error));
				}
			}, {capture: true});
			await settings.connect();
			if (state.customCssError) console.error('[Caprine]', state.customCssError);
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
