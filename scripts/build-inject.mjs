import {build} from 'esbuild';
import {mkdir, writeFile} from 'node:fs/promises';

await mkdir('dist', {recursive: true});
await build({
	entryPoints: ['src/inject/index.ts'],
	outfile: 'dist/inject.js',
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: ['chrome128', 'safari17'],
	loader: {'.css': 'text'},
	legalComments: 'none',
});
// Main loads an external URL. This bundled page has no IPC capability.
await writeFile('dist/index.html', '<!doctype html><meta charset="utf-8"><title>Caprine</title><p>Caprine opens Messenger in its main window.</p>\n');
