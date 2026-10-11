// Desktop notifications. On Linux they go to the notification server over
// D-Bus: Electron sends no sound hints there, so it can neither silence a
// notification nor ask for a sound, which servers such as Plasma play only
// when a hint names one.
import dbus, {type ClientInterface, type MessageBus, type Variant} from '@particle/dbus-next';
import {app, Notification, type NativeImage} from 'electron';
import {pathToFileURL} from 'node:url';

// A sound theme name, or null for a silent notification.
export type Notice = {title: string; body: string; icon?: NativeImage; sound: 'message-new-instant' | 'message' | null};
// Linux servers pass the click's activation token, which a Wayland window
// needs to take focus.
export type Click = (token?: string) => void;

export function createNotifier(appIcon: string) {
	// References keep click handlers alive until the notification is gone.
	const shown = new Set<Notification>();
	const electron = (notice: Notice, click: Click) => {
		const notification = new Notification({title: notice.title, body: notice.body, icon: notice.icon ?? appIcon, silent: !notice.sound});
		shown.add(notification);
		notification.on('click', () => { shown.delete(notification); click(); });
		// A Windows toast that timed out waits in the Action Center, where it can
		// still be clicked.
		notification.on('close', event => { if (event.reason !== 'timedOut') shown.delete(notification); });
		while (shown.size > 100) shown.delete(shown.values().next().value!);
		notification.show();
	};
	return process.platform === 'linux' ? freedesktop(appIcon, electron) : electron;
}

type Notifications = ClientInterface & {
	GetCapabilities(): Promise<string[]>;
	Notify(app: string, replaces: number, icon: string, title: string, body: string, actions: string[], hints: Record<string, Variant>, timeout: number): Promise<number>;
};
const name = 'org.freedesktop.Notifications';
const introspection = `<node><interface name="${name}">
	<method name="GetCapabilities"><arg type="as" direction="out"/></method>
	<method name="Notify">
		<arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>
		<arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/>
		<arg type="u" direction="out"/>
	</method>
	<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
	<signal name="ActivationToken"><arg type="u"/><arg type="s"/></signal>
	<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
</interface></node>`;

// Electron's bitmaps are BGRA; the image-data hint is RGBA.
function imageData(icon: NativeImage): Variant {
	const image = icon.getSize().width > 96 ? icon.resize({width: 96, quality: 'best'}) : icon;
	const {width, height} = image.getSize();
	const pixels = image.toBitmap();
	for (let index = 0; index < pixels.length; index += 4) [pixels[index], pixels[index + 2]] = [pixels[index + 2]!, pixels[index]!];
	return new dbus.Variant('(iiibiiay)', [width, height, pixels.length / height, true, 8, 4, pixels]);
}

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function freedesktop(appIcon: string, fallback: (notice: Notice, click: Click) => void) {
	const clicks = new Map<number, {click: Click; token?: string}>();
	let bus: MessageBus | undefined;
	let server: Promise<{notifications: Notifications; markup: boolean}> | undefined;
	// A failed connection is opened again for the next notification.
	const reset = () => {
		bus?.disconnect();
		bus = server = undefined;
	};
	const connect = async () => {
		const connection = bus = dbus.sessionBus();
		connection.on('error', () => { if (bus === connection) reset(); });
		const notifications = (await connection.getProxyObject(name, '/org/freedesktop/Notifications', introspection)).getInterface<Notifications>(name);
		// The token arrives just before the click.
		notifications.on('ActivationToken', (id: number, token: string) => { const entry = clicks.get(id); if (entry) entry.token = token; });
		notifications.on('ActionInvoked', (id: number, action: string) => {
			const entry = clicks.get(id);
			if (action !== 'default' || !entry) return;
			clicks.delete(id);
			entry.click(entry.token);
		});
		notifications.on('NotificationClosed', (id: number) => clicks.delete(id));
		const capabilities = await notifications.GetCapabilities();
		return {notifications, markup: capabilities.includes('body-markup')};
	};
	return async (notice: Notice, click: Click) => {
		try {
			const {notifications, markup} = await (server ??= connect());
			const hints: Record<string, Variant> = {
				'desktop-entry': new dbus.Variant('s', (process.env.CHROME_DESKTOP ?? app.getName()).replace(/\.desktop$/, '')),
				urgency: new dbus.Variant('y', 1),
				'sender-pid': new dbus.Variant('x', BigInt(process.pid)),
				...(notice.sound ? {'sound-name': new dbus.Variant('s', notice.sound)} : {'suppress-sound': new dbus.Variant('b', true)}),
				...(notice.icon ? {'image-data': imageData(notice.icon)} : {}),
			};
			const id = await notifications.Notify(app.getName(), 0, pathToFileURL(appIcon).href, notice.title, markup ? escape(notice.body) : notice.body, ['default', 'Open'], hints, -1);
			clicks.set(id, {click});
			// Servers that keep notifications without reporting them closed.
			while (clicks.size > 100) clicks.delete(clicks.keys().next().value!);
		} catch (error) {
			console.error('Could not show a notification over D-Bus', error);
			reset();
			fallback(notice, click);
		}
	};
}
