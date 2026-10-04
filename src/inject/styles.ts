import browserCss from '../../css/browser.css';
import codeCss from '../../css/code-blocks.css';
import oledCss from '../../css/oled.css';
import scrollbarCss from '../../css/scrollbar.css';
import panelCss from '../../css/settings-panel.css';
import type {Settings} from './settings';

let theme: Settings['theme'] = 'system';
let scheme: MediaQueryList | undefined;

export function applyTheme(value: Settings['theme']): void {
	theme = value;
	const dark = theme === 'dark' || theme === 'oled' || (theme === 'system' && (scheme?.matches ?? matchMedia('(prefers-color-scheme: dark)').matches));
	// Messenger themes itself from the native preferred color scheme (Rust
	// set_theme), as Electron Caprine did. This class only switches the retained
	// scrollbar/code-block styles; never restyle Messenger's pages or force
	// color-scheme, which washed out the logged-out page. OLED only swaps
	// Messenger's dark-mode color tokens.
	document.documentElement.classList.toggle('dark-mode', dark);
	document.documentElement.classList.toggle('oled-mode', theme === 'oled');
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
	style.textContent = [browserCss, codeCss, scrollbarCss, oledCss, panelCss, customCss].join('\n');
}
