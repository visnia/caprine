import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';

const {outputFiles} = await build({
	entryPoints: ['src/inject/service-worker-diagnostics.ts'],
	bundle: true,
	write: false,
	format: 'iife',
	globalName: 'diagnostics',
});
const hour = 60 * 60 * 1000;

function harness(t, navigator) {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
	const events = [];
	const errors = [];
	const context = vm.createContext({
		navigator,
		setTimeout, clearTimeout, setInterval, clearInterval,
		console: {error: (...args) => errors.push(args)},
	});
	vm.runInContext(outputFiles[0].text, context);
	return {
		events, errors,
		start: (enabled = true) => context.diagnostics.startServiceWorkerDiagnostics(enabled, async sample => {
			events.push(JSON.parse(JSON.stringify(sample)));
		}),
	};
}

test('debug-off performs no registration queries or logging', async t => {
	const {start, events} = harness(t, {get serviceWorker() { assert.fail('must not inspect workers'); }});
	start(false);
	t.mock.timers.tick(2 * hour);
	await nextTurn();
	assert.deepEqual(events, []);
});

test('records zero at startup, detects a new registration hourly, and stops cleanly', async t => {
	let registrations = [];
	const serviceWorker = {getRegistrations: async () => registrations, controller: null};
	const {start, events} = harness(t, {serviceWorker});
	const stop = start();
	await nextTurn();
	assert.deepEqual(events, [{trigger: 'startup', status: 'ok', registrationCount: 0, controlled: false}]);
	t.mock.timers.tick(hour - 1);
	await nextTurn();
	assert.equal(events.length, 1);
	// Only length is used: no scope, script URL, or push subscription is read.
	registrations = [{get pushManager() { assert.fail('must not access subscription'); }}];
	serviceWorker.controller = {};
	t.mock.timers.tick(1);
	await nextTurn();
	assert.deepEqual(events[1], {trigger: 'hourly', status: 'ok', registrationCount: 1, controlled: true});
	t.mock.timers.tick(hour);
	await nextTurn();
	assert.equal(events.length, 3);
	stop();
	t.mock.timers.tick(hour);
	await nextTurn();
	assert.equal(events.length, 3);
});

test('failed queries are recorded as errors, never as zero registrations', async t => {
	const serviceWorker = {getRegistrations: async () => { throw new Error('denied'); }, controller: null};
	const {start, events} = harness(t, {serviceWorker});
	start();
	await nextTurn();
	assert.deepEqual(events, [{trigger: 'startup', status: 'error'}]);
	serviceWorker.getRegistrations = async () => [];
	t.mock.timers.tick(hour);
	await nextTurn();
	assert.equal(events[1].registrationCount, 0);
});

test('unavailable API has a distinct status', async t => {
	const {start, events} = harness(t, {});
	start();
	await nextTurn();
	assert.deepEqual(events, [{trigger: 'startup', status: 'unavailable'}]);
});

test('a stalled query times out and does not prevent the next hourly sample', async t => {
	const serviceWorker = {getRegistrations: () => new Promise(() => {}), controller: null};
	const {start, events} = harness(t, {serviceWorker});
	start();
	t.mock.timers.tick(10_000);
	await nextTurn();
	assert.deepEqual(events, [{trigger: 'startup', status: 'timeout'}]);
	serviceWorker.getRegistrations = async () => [];
	t.mock.timers.tick(hour - 10_000);
	await nextTurn();
	assert.deepEqual(events[1], {trigger: 'hourly', status: 'ok', registrationCount: 0, controlled: false});
});
