// The title bar's window buttons (not on Windows, which keeps native ones).
import {ipcRenderer} from 'electron';

document.addEventListener('click', event => {
	const action = event.target instanceof Element && event.target.closest<HTMLElement>('[data-action]')?.dataset.action;
	if (action) ipcRenderer.send('window-control', action);
});
