// Release helper for .github/workflows/release.yml.
//   collect <windows|linux>  copy bundles to release/ with URL-safe names; sign
//                            any bundle the CLI did not sign (requires
//                            TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]).
//   manifest <tag>           verify every signature names the release version
//                            and write release/latest.json for the updater.
import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const {version} = config;
const repository = 'visnia/caprine';
const output = 'release';
const name = suffix => `Caprine-Visnia_${version}_${suffix}`;
// Updater target keys: {os}-{arch}-{bundle} first, then {os}-{arch}.
const artifacts = {
	windows: [{directory: 'nsis', extension: '.exe', file: name('x64-setup.exe'), targets: ['windows-x86_64-nsis', 'windows-x86_64']}],
	// No bare linux-x86_64 key: a .deb install would fall back to it and
	// try to dpkg-install the AppImage.
	linux: [
		{directory: 'appimage', extension: '.AppImage', file: name('amd64.AppImage'), targets: ['linux-x86_64-appimage']},
	],
};

const fail = message => { console.error(message); process.exit(1); };

async function signedVersion(file) {
	const signature = Buffer.from((await readFile(`${file}.sig`, 'utf8')).trim(), 'base64').toString('utf8');
	const trusted = signature.split('\n').find(line => line.startsWith('trusted comment: '));
	return trusted?.slice('trusted comment: '.length).split('\t').find(field => field.startsWith('version:'))?.slice('version:'.length);
}

async function collect(platform) {
	if (!artifacts[platform]) fail(`Unknown platform ${platform}`);
	await mkdir(output, {recursive: true});
	const bundle = 'src-tauri/target/release/bundle';
	for (const artifact of artifacts[platform]) {
		const directory = path.join(bundle, artifact.directory);
		const matches = (await readdir(directory)).filter(file => file.endsWith(artifact.extension));
		if (matches.length !== 1) fail(`Expected one ${artifact.extension} in ${directory}, found ${matches.join(', ') || 'none'}`);
		const source = path.join(directory, matches[0]);
		const signature = (await readdir(directory)).includes(`${matches[0]}.sig`);
		if (!signature) {
			// The bundler signs only formats it treats as updater artifacts.
			console.log(`Signing ${source} for ${version}`);
			execFileSync('npx', ['tauri', 'signer', 'sign', '--app-version', version, source], {stdio: 'inherit', shell: process.platform === 'win32'});
		}
		const destination = path.join(output, artifact.file);
		await copyFile(source, destination);
		await copyFile(`${source}.sig`, `${destination}.sig`);
		if (await signedVersion(destination) !== version) fail(`${destination}.sig is not bound to version ${version}`);
	}
}

async function manifest(tag) {
	if (tag !== `v${version}`) fail(`Tag ${tag} does not match tauri.conf.json version ${version}`);
	const platforms = {};
	for (const artifact of [...artifacts.windows, ...artifacts.linux]) {
		const file = path.join(output, artifact.file);
		if (await signedVersion(file) !== version) fail(`${file}.sig is missing or not bound to version ${version}`);
		const signature = (await readFile(`${file}.sig`, 'utf8')).trim();
		const url = `https://github.com/${repository}/releases/download/${tag}/${artifact.file}`;
		for (const target of artifact.targets) platforms[target] = {signature, url};
	}
	await writeFile(path.join(output, 'latest.json'), `${JSON.stringify({
		version,
		notes: `See https://github.com/${repository}/releases/tag/${tag}`,
		pub_date: new Date().toISOString(),
		platforms,
	}, null, '\t')}\n`);
}

const [command, argument] = process.argv.slice(2);
if (command === 'collect') await collect(argument);
else if (command === 'manifest') await manifest(argument);
else fail('Usage: release-artifacts.mjs collect <windows|linux> | manifest <tag>');
