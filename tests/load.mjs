import {createRequire} from 'node:module';
import vm from 'node:vm';
import {build} from 'esbuild';

const nodeRequire = createRequire(import.meta.url);

// Bundles a source module and runs it in a fresh context with the given
// globals; `electron` is a stub.
export async function load(entry, {electron = {}, ...globals} = {}) {
	const {outputFiles} = await build({entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['electron'], loader: {'.css': 'text'}});
	const module = {exports: {}};
	const require = name => name === 'electron' ? electron : nodeRequire(name);
	const context = vm.createContext({URL, console, queueMicrotask, setTimeout, clearTimeout, ...globals});
	vm.runInContext(`(function (module, exports, require) {${outputFiles[0].text}\n})`, context)(module, module.exports, require);
	return module.exports;
}
