import {build} from 'esbuild';
import {mkdir, writeFile} from 'node:fs/promises';

await mkdir('dist', {recursive: true});
const options = {
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: ['chrome128', 'safari17'],
	loader: {'.css': 'text'},
	legalComments: 'none',
};
await build({...options, entryPoints: ['src/inject/index.ts'], outfile: 'dist/inject.js'});
// Injected into every frame, including Messenger's sandbox frame.
await build({...options, entryPoints: ['src/inject/frames.ts'], outfile: 'dist/frames.js'});
// Main loads an external URL. This bundled page has no IPC capability.
await writeFile('dist/index.html', '<!doctype html><meta charset="utf-8"><title>Caprine</title><p>Caprine opens Messenger in its main window.</p>\n');
