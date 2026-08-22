import {session, MenuItemConstructorOptions} from 'electron';
import config from './config';
import {SpellCheckerLanguageOption} from './types';

const languageToCode = new Map<string, string>([
	// All languages available in Electron's spellchecker
	['af', 'Afrikaans'],
	['bg', 'Bulgarian'],
	['ca', 'Catalan'],
	['cs', 'Czech'],
	['cy', 'Welsh'],
	['da', 'Danish '],
	['de', 'German'],
	['el', 'Greek'],
	['en', 'English'],
	['en-AU', 'English (Australia)'],
	['en-CA', 'English (Canada)'],
	['en-GB', 'English (United Kingdom)'],
	['en-US', 'English (United States)'],
	['es', 'Spanish'],
	['es-ES', 'Spanish'],
	['es-419', 'Spanish (Central and South America)'],
	['es-AR', 'Spanish (Argentina)'],
	['es-MX', 'Spanish (Mexico)'],
	['es-US', 'Spanish (United States)'],
	['et', 'Estonian'],
	['fa', 'Persian'],
	['fo', 'Faroese'],
	['fr', 'French'],
	['he', 'Hebrew'],
	['hi', 'Hindi'],
	['hr', 'Croatian'],
	['hu', 'Hungarian'],
	['hy', 'Armenian'],
	['id', 'Indonesian'],
	['it', 'Italian'],
	['ko', 'Korean'],
	['lt', 'Lithuanian'],
	['lv', 'Latvian'],
	['nb', 'Norwegian'],
	['nl', 'Dutch'],
	['pl', 'Polish'],
	['pt', 'Portuguese'],
	['pt-BR', 'Portuguese (Brazil)'],
	['pt-PT', 'Portuguese'],
	['ro', 'Moldovan'],
	['ru', 'Russian'],
	['sh', 'Serbo-Croatian'],
	['sk', 'Slovak'],
	['sl', 'Slovenian'],
	['sq', 'Albanian'],
	['sr', 'Serbian'],
	['sv', 'Swedish'],
	['ta', 'Tamil'],
	['tg', 'Tajik'],
	['tr', 'Turkish'],
	['uk', 'Ukrainian'],
	['vi', 'Vietnamese'],
]);

export function getSpellCheckerLanguageOptions(): SpellCheckerLanguageOption[] {
	const availableLanguages = session.defaultSession.availableSpellCheckerLanguages;
	const configuredLanguages = config.get('spellCheckerLanguages');
	const validConfiguredLanguages = configuredLanguages.filter(language => availableLanguages.includes(language));

	if (validConfiguredLanguages.length !== configuredLanguages.length) {
		config.set('spellCheckerLanguages', validConfiguredLanguages);
	}

	return availableLanguages.map(code => ({
		code,
		label: languageToCode.get(code) ?? languageToCode.get(code.split('-')[0]) ?? code,
	}));
}

function getSpellCheckerLanguages(): MenuItemConstructorOptions[] {
	const availableLanguages = getSpellCheckerLanguageOptions();
	const languageItem: MenuItemConstructorOptions[] = [];
	let languagesChecked = config.get('spellCheckerLanguages');
	languagesChecked = languagesChecked.filter(language => availableLanguages.some(({code}) => code === language));

	for (const {code, label} of availableLanguages) {
		languageItem.push(
			{
				label,
				type: 'checkbox',
				checked: languagesChecked.includes(code),
				click() {
					const index = languagesChecked.indexOf(code);
					if (index > -1) {
						// Remove language
						languagesChecked.splice(index, 1);
						config.set('spellCheckerLanguages', languagesChecked);
					} else {
						// Add language
						languagesChecked = [...languagesChecked, code];
						config.set('spellCheckerLanguages', languagesChecked);
					}

					session.defaultSession.setSpellCheckerLanguages(languagesChecked);
				},
			},
		);
	}

	if (languageItem.length === 1) {
		return [
			{
				label: 'System Default',
				type: 'checkbox',
				checked: true,
				enabled: false,
			},
		];
	}

	return languageItem;
}

export default getSpellCheckerLanguages;
