import {build} from 'esbuild';

const options = {bundle: true, platform: 'node', target: 'node24', external: ['electron', 'electron-updater', '@particle/dbus-next'], legalComments: 'none'};
await build({...options, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.js', format: 'esm'});
// Sandboxed preloads are single CommonJS scripts.
await build({...options, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', format: 'cjs', target: 'chrome140', loader: {'.css': 'text'}});
await build({...options, entryPoints: ['src/preload/title-bar.ts'], outfile: 'dist/title-bar.cjs', format: 'cjs', target: 'chrome140'});
