import browserCss from '../../css/browser.css';
import darkCss from '../../css/dark-mode.css';
import codeCss from '../../css/code-blocks.css';
import scrollbarCss from '../../css/scrollbar.css';

export function installStyles(customCss: string): void {
	let style = document.getElementById('caprine-styles') as HTMLStyleElement | null;
	if (!style) {
		style = document.createElement('style');
		style.id = 'caprine-styles';
		(document.head ?? document.documentElement).append(style);
		const scheme = matchMedia('(prefers-color-scheme: dark)');
		const update = () => document.documentElement.classList.toggle('dark-mode', scheme.matches);
		update();
		scheme.addEventListener('change', update);
	}
	style.textContent = [browserCss, darkCss, codeCss, scrollbarCss, customCss].join('\n');
}
