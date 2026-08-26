export type SpellCheckerLanguageOption = {
	code: string;
	label: string;
};

export type SettingsPanelState = {
	version: string;
	platform: NodeJS.Platform;
	theme: 'system' | 'light' | 'dark';
	zoomFactor: number;
	emojiStyle: 'native' | 'facebook-3-0' | 'messenger-1-0' | 'facebook-2-2';
	emojiStyleExamples: Partial<Record<'facebook-3-0' | 'messenger-1-0' | 'facebook-2-2', string>>;
	notificationMessagePreview: boolean;
	notificationsMuted: boolean;
	callRingtoneMuted: boolean;
	showUnreadBadge: boolean;
	alwaysOnTop: boolean;
	launchAtLogin: boolean;
	showTrayIcon: boolean;
	launchMinimized: boolean;
	quitOnWindowClose: boolean;
	autoUpdate: boolean;
	bounceDockOnMessage: boolean;
	menuBarMode: boolean;
	isSpellCheckerEnabled: boolean;
	hardwareAcceleration: boolean;
	useWorkChat: boolean;
	spellCheckerLanguages: string[];
	availableSpellCheckerLanguages: SpellCheckerLanguageOption[];
};

export type SettingsPanelSetting =
	| 'theme'
	| 'emojiStyle'
	| 'notificationMessagePreview'
	| 'notificationsMuted'
	| 'callRingtoneMuted'
	| 'showUnreadBadge'
	| 'alwaysOnTop'
	| 'launchAtLogin'
	| 'showTrayIcon'
	| 'launchMinimized'
	| 'quitOnWindowClose'
	| 'autoUpdate'
	| 'bounceDockOnMessage'
	| 'menuBarMode'
	| 'isSpellCheckerEnabled'
	| 'hardwareAcceleration'
	| 'spellCheckerLanguage';

export type SettingsPanelUpdate = {
	setting: SettingsPanelSetting;
	value: boolean | string;
};

export type SettingsPanelAction =
	| 'custom-styles'
	| 'source-code'
	| 'report-issue'
	| 'switch-to-messenger'
	| 'relaunch'
	| 'quit';
