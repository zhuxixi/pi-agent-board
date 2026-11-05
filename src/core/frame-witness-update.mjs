/**
 * Coalesce host.json frame-witness summary writes only. S/F/A protocol records
 * stay synchronous; this scheduler controls only the secondary host summary.
 */
export function createFrameWitnessSummaryScheduler({
	delayMs = 100,
	publish,
	setTimeoutFn = globalThis.setTimeout,
	clearTimeoutFn = globalThis.clearTimeout,
}) {
	if (typeof publish !== "function") throw new TypeError("publish is required");
	let timer = null;
	const cancel = () => {
		if (timer === null) return;
		clearTimeoutFn(timer);
		timer = null;
	};
	const flush = () => {
		cancel();
		publish();
	};
	const schedule = () => {
		if (timer !== null) return;
		if (delayMs <= 0) {
			publish();
			return;
		}
		timer = setTimeoutFn(() => {
			timer = null;
			publish();
		}, delayMs);
		timer.unref?.();
	};
	return { schedule, flush, cancel };
}
