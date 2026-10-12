import browserCss from '../../css/browser.css';
import catppuccinCss from '../../css/catppuccin.css';
import codeCss from '../../css/code-blocks.css';
import oledCss from '../../css/oled.css';
import scrollbarCss from '../../css/scrollbar.css';
import panelCss from '../../css/settings-panel.css';
import {themeScheme, type Settings} from '../shared';

let theme: Settings['theme'] = 'system';
let scheme: MediaQueryList | undefined;

export function applyTheme(value: Settings['theme']): void {
	theme = value;
	const forced = themeScheme(theme);
	const dark = forced === 'dark' || (forced === 'system' && (scheme?.matches ?? matchMedia('(prefers-color-scheme: dark)').matches));
	// Messenger themes itself from the preferred color scheme (nativeTheme in
	// the main process). These classes only switch Caprine's scrollbar and
	// code-block styles; OLED and Catppuccin only swap Messenger's color tokens.
	const root = document.documentElement.classList;
	root.toggle('dark-mode', dark);
	root.toggle('oled-mode', theme === 'oled');
	root.toggle('catppuccin', theme === 'latte' || theme === 'mocha');
	root.toggle('catppuccin-latte', theme === 'latte');
	root.toggle('catppuccin-mocha', theme === 'mocha');
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
	style.textContent = [browserCss, codeCss, scrollbarCss, oledCss, catppuccinCss, panelCss, customCss].join('\n');
}
