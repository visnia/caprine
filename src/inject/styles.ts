import browserCss from '../../css/browser.css';
import darkCss from '../../css/dark-mode.css';
import codeCss from '../../css/code-blocks.css';
import scrollbarCss from '../../css/scrollbar.css';
import panelCss from '../../css/settings-panel.css';
import type {Settings} from './settings';

let theme: Settings['theme'] = 'system';
let scheme: MediaQueryList | undefined;

export function applyTheme(value: Settings['theme']): void {
	theme = value;
	const dark = theme === 'dark' || (theme === 'system' && (scheme?.matches ?? matchMedia('(prefers-color-scheme: dark)').matches));
	document.documentElement.classList.toggle('dark-mode', dark);
	document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function installStyles(customCss: string): void {
	let style = document.getElementById('caprine-styles') as HTMLStyleElement | null;
	if (!style) {
		style = document.createElement('style');
		style.id = 'caprine-styles';
		(document.head ?? document.documentElement).append(style);
		scheme = matchMedia('(prefers-color-scheme: dark)');
		applyTheme(theme);
		scheme.addEventListener('change', () => applyTheme(theme));
	}
	style.textContent = [browserCss, darkCss, codeCss, scrollbarCss, panelCss, customCss].join('\n');
}
