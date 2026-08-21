/**
 * Injectable orchestration for the attach shrink-and-hold jiggle protocol.
 *
 * Replaces the pulse-pair jiggle (shrink → 200ms → restore) with a
 * shrink-and-hold protocol: on connect we resize the child PTY down one
 * column/row and KEEP it there until the child's own rendering proves it
 * observed the width change (a full clear, \x1b[2J, which pi-tui emits from
 * fullRender(true) whenever widthChanged fires). Because there is no
 * "restore" that can cancel the shrink before a clear is seen, event-loop
 * coalescing on either side (outer dashboard timers or the child's
 * SIGWINCH/render throttle) can no longer collapse a jiggle into a
 * net-zero size change.
 *
 * Cold-start (issue #25): if the child TUI starts rendering AFTER we shrink,
 * its first frame baselines at the shrunk size and never clears. The
 * re-arm — the first \x1b[?2026h frame — therefore restores the original
 * size: the now-rendering child sees a width different from its baseline
 * and fullRenders. Guards:
 *   G1 NO_FRAME_RESTORE_MS — no TUI frame within 6s → restore (no renderer
 *      to trigger; continuing to hold has no purpose).
 *   G2 backoff budget exhausted without a clear → restore (non-pi children,
 *      dead sessions).
 *   G3 restoreAndStop() — component close/detach restores while the socket
 *      is still usable.
 *   G4 notifyExternalResize() — a real user resize cancels the hold and
 *      adopts the new size.
 *   G5 start() restores any previous hold before arming a new one (reconnect).
 *
 * If pi-tui ever drops the 2026h sequence, re-arm degrades to G1: the PTY
 * is restored within 6s — still better than the pre-#10 behavior.
 */
import {
	advanceRetry,
	createJiggleRetryState,
	feedOutput,
	nextRetryDelay,
	stopRetry,
} from "./pty-attach-jiggle-retry.mjs";

/** Restore the held (shrunk) child PTY when no TUI frame arrives this long. */
const NO_FRAME_RESTORE_MS = 6000;

/**
 * @typedef {Object} JiggleRetryControllerDeps
 * @property {(cols: number, rows: number) => void} sendResize - Resize the child PTY.
 * @property {(fn: () => void, ms: number) => unknown} setTimeoutFn - Timer factory.
 * @property {(timer: unknown) => void} clearTimeoutFn - Timer canceller.
 */

/**
 * @param {JiggleRetryControllerDeps} deps
 */
export function createJiggleRetryController(deps) {
	const { sendResize, setTimeoutFn, clearTimeoutFn } = deps;
	let state = createJiggleRetryState();
	let carry = "";
	let tuiFrameSeen = false;
	/** True while the child PTY is parked at the shrunk size. */
	let held = false;
	/** True once the original size has been sent back (restore is one-shot). */
	let restored = false;
	/** @type {[number, number]} */
	let originalCols = 0;
	let originalRows = 0;
	/** @type {unknown | null} */
	let chainTimer = null;
	/** @type {unknown | null} */
	let g1Timer = null;

	function clearChainTimer() {
		if (chainTimer === null) return;
		clearTimeoutFn(chainTimer);
		chainTimer = null;
	}

	function clearG1Timer() {
		if (g1Timer === null) return;
		clearTimeoutFn(g1Timer);
		g1Timer = null;
	}

	function clearAllTimers() {
		clearChainTimer();
		clearG1Timer();
	}

	/**
	 * Restore the child PTY to the original size exactly once. No-op while
	 * not held or after the restore already happened.
	 */
	function restoreIfHeld() {
		if (!held || restored) return;
		sendResize(originalCols, originalRows);
		restored = true;
		held = false;
	}

	/**
	 * Backoff chain is a pure countdown under the hold protocol: firing a
	 * retry schedules the next backoff (no pulse is sent — the shrink is
	 * already held). When the budget runs out, G2 restores the size.
	 */
	function scheduleNextRetry() {
		const delay = nextRetryDelay(state);
		if (delay === null) {
			state = stopRetry(state);
			restoreIfHeld(); // G2
			return;
		}
		chainTimer = setTimeoutFn(() => {
			chainTimer = null;
			state = advanceRetry(state);
			scheduleNextRetry();
		}, delay);
	}

	function armG1() {
		clearG1Timer();
		g1Timer = setTimeoutFn(() => {
			g1Timer = null;
			if (!tuiFrameSeen) restoreIfHeld(); // G1
		}, NO_FRAME_RESTORE_MS);
	}

	/**
	 * Arm a fresh hold for a (re)connected attach at the given PTY size.
	 * Restores any previous hold first (G5), then shrinks and holds.
	 * @param {number} cols
	 * @param {number} rows
	 */
	function start(cols, rows) {
		clearAllTimers();
		if (held) {
			sendResize(originalCols, originalRows); // G5: unwind previous hold
			restored = true;
			held = false;
		}
		state = createJiggleRetryState();
		carry = "";
		tuiFrameSeen = false;
		originalCols = cols;
		originalRows = rows;
		sendResize(cols, rows);
		sendResize(cols - 1, rows - 1);
		held = true;
		restored = false;
		armG1();
		scheduleNextRetry();
	}

	/**
	 * Feed one socket output chunk. A clear wins over the re-arm when both
	 * appear in one chunk. The first TUI frame restores the held size (the
	 * child is now rendering and will fullRender on the width delta) and
	 * does NOT reschedule the chain.
	 * @param {string} data
	 */
	function feed(data) {
		if (state.clearDetected) return; // chain done; nothing left to detect
		const result = feedOutput(state, data, carry);
		state = result.state;
		carry = result.carry;
		if (result.clearFound) {
			clearAllTimers();
			restoreIfHeld();
			state = stopRetry({ ...state, clearDetected: true });
			return;
		}
		if (result.frameStartFound && !tuiFrameSeen) {
			tuiFrameSeen = true;
			clearG1Timer();
			restoreIfHeld(); // re-arm: child is rendering, width delta now lands
		}
	}

	/**
	 * Restore the held size (if any) and stop all chain activity. Used by the
	 * component on close/detach while the socket is still usable (G3).
	 */
	function restoreAndStop() {
		clearAllTimers();
		restoreIfHeld();
		state = stopRetry(state);
	}

	/**
	 * A real user resize supersedes the hold protocol: cancel all timers,
	 * mark the hold void, adopt the new size as the new original, and stop
	 * the chain (G4).
	 * @param {number} cols
	 * @param {number} rows
	 */
	function notifyExternalResize(cols, rows) {
		clearAllTimers();
		held = false;
		restored = false;
		originalCols = cols;
		originalRows = rows;
		state = stopRetry(state);
	}

	return {
		start,
		feed,
		restoreAndStop,
		notifyExternalResize,
		getState: () => ({ ...state, held, tuiFrameSeen, originalCols, originalRows }),
	};
}
