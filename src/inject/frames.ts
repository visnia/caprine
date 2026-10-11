import {installAudioIdleGuard} from './media';

// Runs at document start in every frame, without IPC. Messenger's page and its
// fbsbx.com sandbox frame each leave an AudioContext running (a polyfill's
// feature probe), which keeps a silent sound server stream open.
if (location.origin === 'https://www.messenger.com' || location.origin === 'https://www.fbsbx.com') {
	installAudioIdleGuard(window);
}
