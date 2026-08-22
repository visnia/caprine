import {ipcRenderer as ipc} from 'electron-better-ipc';
import {
	SettingsPanelAction,
	SettingsPanelSetting,
	SettingsPanelState,
	SettingsPanelUpdate,
} from './types';

type SettingsPanelCallbacks = {
	setZoom: (zoomFactor: number) => Promise<void>;
	openMessengerSettings: () => Promise<void>;
	logOut: () => Promise<void>;
};

const createElement = <TagName extends keyof HTMLElementTagNameMap>(
	tagName: TagName,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[TagName] => {
	const element = document.createElement(tagName);
	if (className) {
		element.className = className;
	}

	if (text) {
		element.textContent = text;
	}

	return element;
};

const createButton = (label: string, className = 'caprine-settings-action'): HTMLButtonElement => {
	const button = createElement('button', className, label);
	button.type = 'button';
	return button;
};

export function initializeSettingsPanel(callbacks: SettingsPanelCallbacks): void {
	const launcher = createButton('', 'caprine-settings-launcher');
	launcher.id = 'caprine-settings-launcher';
	launcher.title = 'Caprine Settings';
	launcher.setAttribute('aria-label', 'Open Caprine Settings');
	launcher.innerHTML = `
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<path d="M19.14 12.94a7.4 7.4 0 0 0 .05-.94 7.4 7.4 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.2 7.2 0 0 0-1.62-.94L14.39 2.8a.5.5 0 0 0-.49-.4h-3.8a.5.5 0 0 0-.49.4l-.36 2.52c-.58.24-1.12.55-1.62.94L5.24 5.3a.5.5 0 0 0-.61.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.4 7.4 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.61.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.52c.04.24.24.4.49.4h3.8c.25 0 .45-.16.49-.4l.36-2.52c.58-.24 1.12-.55 1.62-.94l2.39.96c.22.1.48.01.61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/>
		</svg>`;

	const backdrop = createElement('div', 'caprine-settings-backdrop');
	backdrop.id = 'caprine-settings-backdrop';
	backdrop.setAttribute('aria-hidden', 'true');

	const panel = createElement('section', 'caprine-settings-panel');
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-modal', 'true');
	panel.setAttribute('aria-labelledby', 'caprine-settings-title');

	const header = createElement('header', 'caprine-settings-header');
	const headingGroup = createElement('div');
	const eyebrow = createElement('span', 'caprine-settings-eyebrow', 'CAPRINE');
	const title = createElement('h1', undefined, 'Settings');
	title.id = 'caprine-settings-title';
	headingGroup.append(eyebrow, title);
	const closeButton = createButton('×', 'caprine-settings-close');
	closeButton.setAttribute('aria-label', 'Close settings');
	header.append(headingGroup, closeButton);

	const restartNotice = createElement('div', 'caprine-settings-restart-notice');
	restartNotice.append(createElement('span', undefined, 'Restart required to apply this change.'));
	const restartNowButton = createButton('Restart now');
	restartNotice.append(restartNowButton);

	const content = createElement('div', 'caprine-settings-content');
	panel.append(header, restartNotice, content);
	backdrop.append(panel);
	document.body.append(launcher, backdrop);

	let state: SettingsPanelState;
	let previouslyFocusedElement: HTMLElement | undefined;
	const applyPanelTheme = (theme: SettingsPanelState['theme']): void => {
		launcher.dataset.caprineTheme = theme;
		backdrop.dataset.caprineTheme = theme;
	};

	const close = (): void => {
		backdrop.classList.remove('is-open');
		backdrop.setAttribute('aria-hidden', 'true');
		document.documentElement.classList.remove('caprine-settings-open');
		previouslyFocusedElement?.focus();
	};

	const run = async (control: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, operation: () => Promise<void>): Promise<void> => {
		control.disabled = true;
		try {
			await operation();
		} catch (error) {
			console.error('Could not update Caprine settings', error);
		} finally {
			control.disabled = false;
		}
	};

	const updateSetting = async (setting: SettingsPanelSetting, value: boolean | string): Promise<void> => {
		await ipc.callMain<SettingsPanelUpdate, void>('update-settings-panel-setting', {setting, value});
	};

	const performAction = async (action: SettingsPanelAction): Promise<void> => {
		await ipc.callMain<SettingsPanelAction, void>('settings-panel-action', action);
	};

	restartNowButton.addEventListener('click', () => {
		void run(restartNowButton, async () => performAction('relaunch'));
	});

	const createSection = (titleText: string, description?: string): HTMLElement => {
		const section = createElement('section', 'caprine-settings-section');
		section.append(createElement('h2', undefined, titleText));
		if (description) {
			section.append(createElement('p', 'caprine-settings-section-description', description));
		}

		return section;
	};

	const createRow = (labelText: string, description?: string): {row: HTMLElement; control: HTMLElement} => {
		const row = createElement('div', 'caprine-settings-row');
		const copy = createElement('div', 'caprine-settings-copy');
		copy.append(createElement('div', 'caprine-settings-label', labelText));
		if (description) {
			copy.append(createElement('div', 'caprine-settings-description', description));
		}

		const control = createElement('div', 'caprine-settings-control');
		row.append(copy, control);
		return {row, control};
	};

	/* eslint-disable max-params */
	const addToggle = (
		section: HTMLElement,
		labelText: string,
		description: string,
		setting: SettingsPanelSetting,
		checked: boolean,
	): void => {
		const {row, control} = createRow(labelText, description);
		const toggle = createElement('label', 'caprine-settings-toggle');
		const input = createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.disabled = setting === 'showTrayIcon' && state.launchMinimized;
		input.dataset.setting = setting;
		input.setAttribute('aria-label', labelText);
		const track = createElement('span');
		toggle.append(input, track);
		control.append(toggle);
		row.addEventListener('click', event => {
			if (event.target instanceof Element && !event.target.closest('.caprine-settings-control')) {
				input.click();
			}
		});
		input.addEventListener('change', () => {
			void run(input, async () => {
				await updateSetting(setting, input.checked);
				if (setting === 'isSpellCheckerEnabled' || setting === 'hardwareAcceleration') {
					restartNotice.classList.add('is-visible');
				}

				if (setting === 'launchMinimized') {
					state.launchMinimized = input.checked;
					const trayIconInput = content.querySelector<HTMLInputElement>('input[data-setting="showTrayIcon"]');
					if (trayIconInput) {
						trayIconInput.checked ||= input.checked;
						trayIconInput.disabled = input.checked;
					}
				}
			});
		});
		section.append(row);
	};

	const addSelect = (
		section: HTMLElement,
		labelText: string,
		description: string,
		setting: SettingsPanelSetting,
		value: string,
		options: Array<{label: string; value: string}>,
	): void => {
		const {row, control} = createRow(labelText, description);
		const select = createElement('select', 'caprine-settings-select');
		select.setAttribute('aria-label', labelText);
		for (const optionData of options) {
			const option = createElement('option', undefined, optionData.label);
			option.value = optionData.value;
			option.selected = optionData.value === value;
			select.append(option);
		}

		select.addEventListener('change', () => {
			void run(select, async () => {
				await updateSetting(setting, select.value);
				if (setting === 'theme') {
					state.theme = select.value as SettingsPanelState['theme'];
					applyPanelTheme(state.theme);
				}

				if (setting === 'emojiStyle') {
					restartNotice.classList.add('is-visible');
				}
			});
		});
		control.append(select);
		section.append(row);
	};

	const addAction = (
		section: HTMLElement,
		labelText: string,
		description: string,
		buttonLabel: string,
		action: () => Promise<void>,
		dangerous = false,
	): void => {
		const {row, control} = createRow(labelText, description);
		const button = createButton(buttonLabel, dangerous ? 'caprine-settings-action is-dangerous' : 'caprine-settings-action');
		button.addEventListener('click', event => {
			event.stopPropagation();
			void run(button, action);
		});
		control.append(button);
		section.append(row);
	};
	/* eslint-enable max-params */

	const render = (): void => {
		content.replaceChildren();

		const appearance = createSection('Appearance', 'Make Caprine comfortable to read and consistent with your desktop.');
		addSelect(appearance, 'Theme', 'Choose how Caprine follows your system appearance.', 'theme', state.theme, [
			{label: 'System', value: 'system'},
			{label: 'Light', value: 'light'},
			{label: 'Dark', value: 'dark'},
		]);

		const {row: zoomRow, control: zoomControl} = createRow('Text size', 'Changes both the chat list and active conversation.');
		const zoomStepper = createElement('div', 'caprine-settings-stepper');
		const decreaseZoom = createButton('−');
		const zoomValue = createElement('span', undefined, `${Math.round(state.zoomFactor * 100)}%`);
		const increaseZoom = createButton('+');
		const updateZoom = (increment: number): void => {
			const nextZoom = Math.min(1.5, Math.max(0.8, Math.round((state.zoomFactor + increment) * 10) / 10));
			void run(increment < 0 ? decreaseZoom : increaseZoom, async () => {
				state.zoomFactor = nextZoom;
				zoomValue.textContent = `${Math.round(nextZoom * 100)}%`;
				decreaseZoom.disabled = nextZoom <= 0.8;
				increaseZoom.disabled = nextZoom >= 1.5;
				await callbacks.setZoom(nextZoom);
			});
		};

		decreaseZoom.disabled = state.zoomFactor <= 0.8;
		increaseZoom.disabled = state.zoomFactor >= 1.5;
		decreaseZoom.setAttribute('aria-label', 'Decrease text size');
		increaseZoom.setAttribute('aria-label', 'Increase text size');
		decreaseZoom.addEventListener('click', () => {
			updateZoom(-0.1);
		});
		increaseZoom.addEventListener('click', () => {
			updateZoom(0.1);
		});
		zoomStepper.append(decreaseZoom, zoomValue, increaseZoom);
		zoomControl.append(zoomStepper);
		appearance.append(zoomRow);
		const {row: emojiRow, control: emojiControl} = createRow('Emoji style', 'Choose a visual style. Requires a restart when changed.');
		const emojiPicker = createElement('details', 'caprine-settings-emoji-picker');
		const emojiSummary = createElement('summary');
		const selectedEmoji = createElement('span', 'caprine-settings-emoji-selected');
		emojiSummary.append(selectedEmoji);
		const emojiMenu = createElement('div', 'caprine-settings-emoji-menu');
		const emojiOptions: Array<{label: string; value: SettingsPanelState['emojiStyle']}> = [
			{label: 'System', value: 'native'},
			{label: 'Facebook 3.0', value: 'facebook-3-0'},
			{label: 'Facebook 2.2', value: 'facebook-2-2'},
		];
		if (state.platform !== 'linux') {
			emojiOptions.splice(2, 0, {label: 'Messenger 1.0', value: 'messenger-1-0'});
		}

		const createEmojiPreview = (emojiOption: typeof emojiOptions[number]): HTMLElement => {
			const optionContent = createElement('span');
			const exampleUrl = emojiOption.value === 'native' ? undefined : state.emojiStyleExamples[emojiOption.value];
			if (exampleUrl) {
				const example = createElement('img');
				example.src = exampleUrl;
				example.alt = '';
				optionContent.append(example);
			} else {
				optionContent.append(createElement('span', 'caprine-settings-system-emoji', '🙂'));
			}

			optionContent.append(createElement('span', 'caprine-settings-emoji-label', emojiOption.label));
			return optionContent;
		};

		const updateEmojiSummary = (): void => {
			const selectedOption = emojiOptions.find(option => option.value === state.emojiStyle) ?? emojiOptions[0];
			selectedEmoji.replaceChildren(createEmojiPreview(selectedOption));
		};

		for (const emojiOption of emojiOptions) {
			const option = createElement('label', 'caprine-settings-emoji-option');
			const input = createElement('input');
			input.type = 'radio';
			input.name = 'caprine-emoji-style';
			input.value = emojiOption.value;
			input.checked = state.emojiStyle === emojiOption.value;
			input.addEventListener('click', () => {
				emojiPicker.open = false;
			});
			input.addEventListener('change', () => {
				void run(input, async () => {
					await updateSetting('emojiStyle', emojiOption.value);
					state.emojiStyle = emojiOption.value;
					updateEmojiSummary();
					restartNotice.classList.add('is-visible');
				});
			});
			option.append(input, createEmojiPreview(emojiOption));
			emojiMenu.append(option);
		}

		updateEmojiSummary();
		emojiPicker.append(emojiSummary, emojiMenu);
		emojiControl.append(emojiPicker);
		appearance.append(emojiRow);
		content.append(appearance);

		const notifications = createSection('Notifications');
		addToggle(notifications, 'Message previews', 'Show message text in desktop notifications.', 'notificationMessagePreview', state.notificationMessagePreview);
		addToggle(notifications, 'Mute notifications', 'Keep notifications from interrupting you.', 'notificationsMuted', state.notificationsMuted);
		addToggle(notifications, 'Mute call ringtone', 'Silence incoming Messenger call sounds.', 'callRingtoneMuted', state.callRingtoneMuted);
		addToggle(notifications, 'Unread badge', 'Show unread counts on the app and tray icons.', 'showUnreadBadge', state.showUnreadBadge);
		if (state.platform === 'darwin') {
			addToggle(notifications, 'Bounce Dock icon', 'Draw attention when a new message arrives.', 'bounceDockOnMessage', state.bounceDockOnMessage);
		}

		content.append(notifications);

		const behavior = createSection('App behavior');
		addToggle(behavior, 'Always on top', 'Keep Caprine above other windows.', 'alwaysOnTop', state.alwaysOnTop);
		if (state.platform !== 'linux') {
			addToggle(behavior, 'Launch at login', 'Start Caprine when you sign in.', 'launchAtLogin', state.launchAtLogin);
		}

		if (state.platform !== 'darwin') {
			addToggle(behavior, 'Show tray icon', 'Keep quick access to Caprine in the system tray.', 'showTrayIcon', state.showTrayIcon);
			addToggle(behavior, 'Launch minimized', 'Start Caprine quietly in the system tray.', 'launchMinimized', state.launchMinimized);
		}

		if (state.platform === 'darwin') {
			addToggle(behavior, 'Show menu bar icon', 'Add Caprine to the macOS menu bar.', 'menuBarMode', state.menuBarMode);
		}

		addToggle(behavior, 'Quit when window closes', 'Exit instead of continuing in the background.', 'quitOnWindowClose', state.quitOnWindowClose);
		addToggle(behavior, 'Automatic updates', 'Check for new Caprine releases automatically.', 'autoUpdate', state.autoUpdate);
		content.append(behavior);

		const language = createSection('Language', 'Spell checking is provided by your operating system.');
		addToggle(language, 'Spell checker', 'Requires a restart when enabled or disabled.', 'isSpellCheckerEnabled', state.isSpellCheckerEnabled);
		if (state.platform !== 'darwin' && state.isSpellCheckerEnabled) {
			const languagePicker = createElement('details', 'caprine-settings-language-picker');
			const selectedLanguageCount = state.spellCheckerLanguages.length;
			const languageSummary = createElement('summary', undefined, selectedLanguageCount === 0 ? 'System default language' : `${selectedLanguageCount} language${selectedLanguageCount === 1 ? '' : 's'} selected`);
			languagePicker.append(languageSummary);
			const languageList = createElement('div', 'caprine-settings-language-list');
			for (const languageOption of state.availableSpellCheckerLanguages) {
				const item = createElement('label', 'caprine-settings-language');
				const checkbox = createElement('input');
				checkbox.type = 'checkbox';
				checkbox.checked = state.spellCheckerLanguages.includes(languageOption.code);
				checkbox.addEventListener('change', () => {
					void run(checkbox, async () => {
						await updateSetting('spellCheckerLanguage', languageOption.code);
						state.spellCheckerLanguages = checkbox.checked
							? [...state.spellCheckerLanguages, languageOption.code]
							: state.spellCheckerLanguages.filter(code => code !== languageOption.code);
						const selectedCount = state.spellCheckerLanguages.length;
						languageSummary.textContent = selectedCount === 0 ? 'System default language' : `${selectedCount} language${selectedCount === 1 ? '' : 's'} selected`;
					});
				});
				item.append(checkbox, createElement('span', undefined, languageOption.label));
				languageList.append(item);
			}

			languagePicker.append(languageList);
			language.append(languagePicker);
		}

		content.append(language);

		const advanced = createSection('Advanced');
		addToggle(advanced, 'Hardware acceleration', 'Requires a restart when changed.', 'hardwareAcceleration', state.hardwareAcceleration);
		addAction(advanced, 'Custom styles', 'Open the CSS file used for personal Caprine customizations.', 'Open CSS', async () => performAction('custom-styles'));
		content.append(advanced);

		const account = createSection('Messenger account');
		addAction(account, 'Messenger settings', 'Open settings provided by Messenger.', 'Open', async () => {
			close();
			await callbacks.openMessengerSettings();
		});
		if (state.useWorkChat) {
			addAction(account, 'Switch to Messenger', 'Leave Work Chat and restart with Messenger.', 'Switch', async () => performAction('switch-to-messenger'));
		}

		addAction(account, 'Log out', 'Sign out of the current Messenger account.', 'Log out', async () => {
			close();
			await callbacks.logOut();
		}, true);
		content.append(account);

		const help = createSection('Help & about', `Caprine ${state.version}`);
		const links = createElement('div', 'caprine-settings-link-grid');
		for (const [label, action] of [
			['Source code', 'source-code'],
			['Report an issue', 'report-issue'],
		] as Array<[string, SettingsPanelAction]>) {
			const button = createButton(label, 'caprine-settings-link');
			button.addEventListener('click', () => {
				void run(button, async () => performAction(action));
			});
			links.append(button);
		}

		help.append(links);
		content.append(help);

		const footer = createElement('footer', 'caprine-settings-footer');
		const relaunchButton = createButton('Relaunch Caprine');
		relaunchButton.addEventListener('click', () => {
			void run(relaunchButton, async () => performAction('relaunch'));
		});
		const quitButton = createButton('Quit', 'caprine-settings-action is-dangerous');
		quitButton.addEventListener('click', () => {
			void run(quitButton, async () => performAction('quit'));
		});
		footer.append(relaunchButton, quitButton);
		content.append(footer);
	};

	const open = async (): Promise<void> => {
		previouslyFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		state = await ipc.callMain<undefined, SettingsPanelState>('get-settings-panel-state');
		applyPanelTheme(state.theme);
		render();
		backdrop.classList.add('is-open');
		backdrop.setAttribute('aria-hidden', 'false');
		document.documentElement.classList.add('caprine-settings-open');
		closeButton.focus();
	};

	launcher.addEventListener('click', () => {
		void open();
	});
	closeButton.addEventListener('click', close);
	backdrop.addEventListener('click', event => {
		if (event.target === backdrop) {
			close();
		}
	});
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape' && backdrop.classList.contains('is-open')) {
			close();
		}
	});
	ipc.answerMain('open-caprine-settings', open);
}
