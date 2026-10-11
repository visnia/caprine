import {createRequire} from 'node:module';
import vm from 'node:vm';
import {build} from 'esbuild';

const nodeRequire = createRequire(import.meta.url);

// Bundles a source module and runs it in a fresh context with the given
// globals; `electron` and any `modules` are stubs.
export async function load(entry, {electron = {}, modules = {}, ...globals} = {}) {
	const stubs = {electron, ...modules};
	const {outputFiles} = await build({entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', external: Object.keys(stubs), loader: {'.css': 'text'}});
	const module = {exports: {}};
	const require = name => Object.hasOwn(stubs, name) ? stubs[name] : nodeRequire(name);
	const context = vm.createContext({URL, console, queueMicrotask, setTimeout, clearTimeout, ...globals});
	vm.runInContext(`(function (module, exports, require) {${outputFiles[0].text}\n})`, context)(module, module.exports, require);
	return module.exports;
}
