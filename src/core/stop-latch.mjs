/**
 * Minimal stop-intent latch for detached runners (issue #153).
 *
 * A runner installs signal handlers as early as module scope — before its
 * config is even read — but the real stop path (kill worker, finalize the
 * run) only exists once the worker is spawned and the close handlers are
 * wired. A stop signal that lands in between must not die with Node's
 * default action (that would leave the run without a terminal state); the
 * latch records it and the runner replays it once the real stop path exists.
 *
 * Pure state: no signal wiring, no timers, no I/O.
 */

/**
 * @returns {{
 * 	note(signal: string): void,
 * 	pending(): string | null,
 * 	take(): string | null,
 * }} A latch object. `note` is idempotent (the first signal wins, later ones
 * collapse); `take` returns the recorded signal once, then null.
 */
export function createStopLatch() {
	/** @type {string | null} */
	let noted = null;
	return {
		/** Record a stop signal. @param {string} signal */
		note(signal) {
			if (noted == null) noted = signal;
		},
		/** The first recorded signal, or null. */
		pending() {
			return noted;
		},
		/** Read-and-clear: returns the recorded signal once, then null. */
		take() {
			const signal = noted;
			noted = null;
			return signal;
		},
	};
}
