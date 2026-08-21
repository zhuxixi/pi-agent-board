/**
 * Single-flight debounce for dashboard prewarm.
 *
 * Arrow-key navigation must move the selection and repaint immediately; host
 * prewarm (which may spawn a PTY host and re-scan rows) is deferred so bursts
 * of keypresses trigger exactly one prewarm for the final resting selection.
 */

/**
 * @param {() => void} prewarm Invoked (with errors swallowed) once scheduling
 *   goes quiet for `delayMs`. Re-reads current state at fire time.
 * @param {number} [delayMs=200]
 * @returns {{ schedule: () => void, cancel: () => void }}
 */
export function createPrewarmScheduler(prewarm, delayMs = 200) {
	/** @type {ReturnType<typeof setTimeout> | null} */
	let timer = null;
	const fire = () => {
		timer = null;
		try {
			prewarm();
		} catch {
			/* prewarm is best-effort; never break navigation */
		}
	};
	return {
		schedule() {
			if (timer !== null) clearTimeout(timer);
			const pending = setTimeout(fire, delayMs);
			// Never let a pending debounce hold the event loop open on exit.
			if (typeof pending.unref === "function") pending.unref();
			timer = pending;
		},
		cancel() {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
