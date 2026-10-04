type Snapshot =
	| {status: 'ok'; registrationCount: number; controlled: boolean}
	| {status: 'unavailable' | 'error' | 'timeout'};
export type WorkerSample = Snapshot & {trigger: 'startup' | 'hourly'};

export function startServiceWorkerDiagnostics(
	enabled: boolean,
	report: (sample: WorkerSample) => Promise<void>,
): () => void {
	if (!enabled) return () => {};
	let stopped = false;
	let pending = false;
	const sample = async (trigger: WorkerSample['trigger']) => {
		if (stopped || pending) return;
		pending = true;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let snapshot: Snapshot;
		try {
			if (!('serviceWorker' in navigator)) {
				snapshot = {status: 'unavailable'};
			} else {
				// Never await serviceWorker.ready: it stays pending when no worker exists.
				snapshot = await Promise.race([
					navigator.serviceWorker.getRegistrations().then(registrations => ({
						status: 'ok' as const,
						registrationCount: registrations.length,
						controlled: navigator.serviceWorker.controller !== null,
					})),
					new Promise<Snapshot>(resolve => {
						timeout = setTimeout(() => resolve({status: 'timeout'}), 10_000);
					}),
				]);
			}
		} catch {
			snapshot = {status: 'error'};
		} finally {
			clearTimeout(timeout);
		}
		try {
			if (!stopped) await report({trigger, ...snapshot});
		} catch (error) {
			console.error('[Caprine] Could not log service worker inventory', error);
		} finally {
			pending = false;
		}
	};
	void sample('startup');
	const interval = setInterval(() => { void sample('hourly'); }, 60 * 60 * 1000);
	return () => {
		stopped = true;
		clearInterval(interval);
	};
}
