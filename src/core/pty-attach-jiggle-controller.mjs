/**
 * Injectable orchestration for the attach jiggle-retry chain.
 *
 * Owns the retry state machine, backoff timers, cross-chunk scanning, and the
 * one-shot re-arm on the child TUI's first frame (\x1b[?2026h). The attach
 * component (and the cold-start E2E) drive it through injected callbacks, so
 * the whole choreography is testable without a TUI or socket.
 *
 * Cold-start design (issue #10): the chain starts at socket connect, but a cold
 * child pi-tui installs its SIGWINCH listener only ~5s in — every early jiggle
 * is lost. When the first TUI frame arrives we re-arm once with a fresh budget,
 * so the next jiggle lands on a live TUI and its fullRender emits \x1b[2J,
 * which stops the chain. If pi-tui ever drops the 2026h sequence, this degrades
 * to the plain connect-time chain (still better than the old one-shot).
 */
import {
	advanceRetry,
	createJiggleRetryState,
	feedOutput,
	nextRetryDelay,
	stopRetry,
} from "./pty-attach-jiggle-retry.mjs";

/**
 * @typedef {Object} JiggleRetryControllerDeps
 * @property {() => void} sendJiggle - Fire one resize jiggle at the child.
 * @property {(fn: () => void, ms: number) => unknown} setTimeoutFn - Timer factory.
 * @property {(timer: unknown) => void} clearTimeoutFn - Timer canceller.
 * @property {() => boolean} [shouldFire] - Guard on retry fire; false stops the chain without firing.
 */

/**
 * @param {JiggleRetryControllerDeps} deps
 */
export function createJiggleRetryController(deps) {
	const { sendJiggle, setTimeoutFn, clearTimeoutFn, shouldFire } = deps;
	let state = createJiggleRetryState();
	let carry = "";
	let tuiFrameSeen = false;
	/** @type {unknown | null} */
	let timer = null;

	function clearTimer() {
		if (timer === null) return;
		clearTimeoutFn(timer);
		timer = null;
	}

	function scheduleNext() {
		const delay = nextRetryDelay(state);
		if (delay === null) {
			state = stopRetry(state);
			return;
		}
		timer = setTimeoutFn(() => {
			timer = null;
			if (shouldFire && !shouldFire()) {
				state = stopRetry(state);
				return;
			}
			sendJiggle();
			state = advanceRetry(state);
			scheduleNext();
		}, delay);
	}

	/** Reset everything (fresh connection) and schedule the first retry. */
	function start() {
		clearTimer();
		state = createJiggleRetryState();
		carry = "";
		tuiFrameSeen = false;
		scheduleNext();
	}

	/**
	 * Feed one socket output chunk. Clear detection wins over re-arm when both
	 * sequences appear in one chunk (a hot attach's first frame is often the
	 * fullRender we were waiting for). Re-arm fires at most once per start().
	 * @param {string} data
	 */
	function feed(data) {
		if (state.clearDetected) return; // chain done; nothing left to detect
		const result = feedOutput(state, data, carry);
		state = result.state;
		carry = result.carry;
		if (result.clearFound) {
			clearTimer();
			state = stopRetry({ ...state, clearDetected: true });
			return;
		}
		if (result.frameStartFound && !tuiFrameSeen && !state.clearDetected) {
			tuiFrameSeen = true;
			clearTimer();
			state = createJiggleRetryState();
			scheduleNext();
		}
	}

	/** Stop the chain (component closed, etc.). */
	function stop() {
		clearTimer();
		state = stopRetry(state);
	}

	return {
		start,
		feed,
		stop,
		getState: () => ({ ...state, tuiFrameSeen }),
	};
}
