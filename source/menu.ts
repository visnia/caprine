import {
	app,
	Menu,
	MenuItemConstructorOptions,
} from 'electron';
import {
	is,
	appMenu,
	openUrlMenuItem,
	aboutMenuItem,
	openNewGitHubIssue,
	debugInfo,
} from 'electron-util';
import config from './config';
import {sendAction} from './util';
import {caprineIconPath} from './constants';

export default async function updateMenu(): Promise<Menu> {
	const caprineSettingsItem: MenuItemConstructorOptions = {
		label: 'Caprine Settings…',
		accelerator: 'CommandOrControl+,',
		click() {
			sendAction('open-caprine-settings');
		},
	};

	const messengerSettingsItem: MenuItemConstructorOptions = {
		label: 'Messenger Settings…',
		click() {
			sendAction('show-preferences');
		},
	};

	const logOutItem: MenuItemConstructorOptions = {
		label: 'Log Out',
		click() {
			sendAction('log-out');
		},
	};

	const relaunchItem: MenuItemConstructorOptions = {
		label: 'Relaunch Caprine',
		click() {
			app.relaunch();
			app.quit();
		},
	};

	const themeSubmenu: MenuItemConstructorOptions[] = [
		{
			label: 'Follow System Appearance',
			type: 'checkbox',
			checked: config.get('theme') === 'system',
			async click() {
				config.set('theme', 'system');
				sendAction('set-theme');
				await updateMenu();
			},
		},
		{
			label: 'Light Mode',
			type: 'checkbox',
			checked: config.get('theme') === 'light',
			async click() {
				config.set('theme', 'light');
				sendAction('set-theme');
				await updateMenu();
			},
		},
		{
			label: 'Dark Mode',
			type: 'checkbox',
			checked: config.get('theme') === 'dark',
			async click() {
				config.set('theme', 'dark');
				sendAction('set-theme');
				await updateMenu();
			},
		},
	];

	const viewSubmenu: MenuItemConstructorOptions[] = [
		{
			label: 'Reset Text Size',
			accelerator: 'CommandOrControl+0',
			click() {
				sendAction('zoom-reset');
			},
		},
		{
			label: 'Increase Text Size',
			accelerator: 'CommandOrControl+Plus',
			click() {
				sendAction('zoom-in');
			},
		},
		{
			label: 'Decrease Text Size',
			accelerator: 'CommandOrControl+-',
			click() {
				sendAction('zoom-out');
			},
		},
		{
			type: 'separator',
		},
		{
			label: 'Theme',
			submenu: themeSubmenu,
		},
	];

	const helpSubmenu: MenuItemConstructorOptions[] = [
		openUrlMenuItem({
			label: 'Website',
			url: 'https://github.com/visnia/caprine',
		}),
		openUrlMenuItem({
			label: 'Source Code',
			url: 'https://github.com/visnia/caprine',
		}),
		openUrlMenuItem({
			label: 'Donate…',
			url: 'https://github.com/visnia/caprine?sponsor=1',
		}),
		{
			label: 'Report an Issue…',
			click() {
				openNewGitHubIssue({
					user: 'visnia',
					repo: 'caprine',
					body: `
<!-- Please succinctly describe your issue and steps to reproduce it. -->


---

${debugInfo()}`,
				});
			},
		},
	];

	if (!is.macos) {
		helpSubmenu.push(
			{
				type: 'separator',
			},
			aboutMenuItem({
				icon: caprineIconPath,
				copyright: 'Created by Sindre Sorhus',
				text: 'Caprine is an unofficial Messenger desktop app.',
				website: 'https://github.com/visnia/caprine',
			}),
		);
	}

	const macosTemplate: MenuItemConstructorOptions[] = [
		appMenu([
			caprineSettingsItem,
			messengerSettingsItem,
			{
				type: 'separator',
			},
			logOutItem,
			{
				type: 'separator',
			},
			relaunchItem,
		]),
		{
			role: 'fileMenu',
			submenu: [
				{
					role: 'close',
				},
			],
		},
		{
			role: 'editMenu',
		},
		{
			role: 'viewMenu',
			submenu: viewSubmenu,
		},
		{
			role: 'windowMenu',
		},
		{
			role: 'help',
			submenu: helpSubmenu,
		},
	];

	const linuxWindowsTemplate: MenuItemConstructorOptions[] = [
		{
			role: 'fileMenu',
			submenu: [
				caprineSettingsItem,
				messengerSettingsItem,
				{
					type: 'separator',
				},
				logOutItem,
				{
					type: 'separator',
				},
				relaunchItem,
				{
					role: 'quit',
				},
			],
		},
		{
			role: 'editMenu',
		},
		{
			role: 'viewMenu',
			submenu: viewSubmenu,
		},
		{
			role: 'help',
			submenu: helpSubmenu,
		},
	];

	const menu = Menu.buildFromTemplate(is.macos ? macosTemplate : linuxWindowsTemplate);
	Menu.setApplicationMenu(menu);
	return menu;
}
