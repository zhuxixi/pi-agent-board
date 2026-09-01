/**
 * Injectable orchestration for the attach shrink-and-hold jiggle protocol.
 *
 * Replaces the pulse-pair jiggle (shrink → 200ms → restore) with a
 * shrink-and-hold protocol: on connect we resize the child PTY to a safe
 * alternate size and KEEP it there until the child's own rendering proves it
 * observed the size change (a full clear, \x1b[2J, which pi-tui emits from
 * fullRender(true) whenever widthChanged fires). At normal sizes the alternate
 * size is one column/row smaller; near the minimum it changes only a safe
 * dimension, and at 20x5 no jiggle is attempted. Because there is no
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
 *      to trigger; continuing to hold has no purpose). If the TUI boots even
 *      later, its first frame re-arms a fresh hold (F1 slow-boot probe), so
 *      healing still fires the moment the child actually starts rendering.
 *   G2 backoff budget exhausted without a clear → restore (non-pi children,
 *      dead sessions).
 *   G3 restoreAndStop() — component close/detach restores while the socket
 *      is still usable.
 *   G4 notifyExternalResize() — a real user resize cancels the hold and
 *      adopts the new size.
 *   G5 start() restores any previous hold before arming a new one (reconnect).
 *   G6 post-restore verify (issue #42): the frameStart fast path restores the
 *      hold on the FIRST frame, which may predate the shrink — if the restore
 *      then collapses both resizes into a net-zero change at the child, the
 *      child renders nothing and never clears. While a frame has been seen
 *      and no clear followed, each backoff tick re-arms the shrink (which
 *      lands alone and cannot collapse), bounded by the same retry budget.
 *
 * If pi-tui ever drops the 2026h sequence, re-arm degrades to G1: the PTY
 * is restored within 6s — still better than the pre-#10 behavior. At the
 * minimum supported PTY size (20x5), jiggle is disabled because the runner's
 * clamp leaves no valid alternate size.
 */
import { resizeJiggleSize } from "./pty-scroll.mjs";
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
 * Grace window after the frameStart fast-path restore before the chain may
 * re-poke (issue #42). A healthy child proves the restore landed with a
 * fullRender clear within a few hundred ms even on large screens; without the
 * grace a slow-but-healthy clear would trigger a pointless re-shrink flicker.
 */
const POST_RESTORE_VERIFY_MS = 900;

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
	/** The safe alternate size used while a jiggle hold is active, or null when unsupported. */
	let holdSize = null;
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
	 * One chain tick: advance the backoff budget, then re-arm the hold if the
	 * child has a renderer (a TUI frame was seen) but no clear ever proved the
	 * last size delta landed and the hold is currently inactive (issue #42:
	 * the frameStart fast-path restore can race the shrink into a net-zero
	 * size change at the child — its throttled renderer reads back the
	 * original size and stays silent forever — so a clear-less restore must
	 * be followed by a fresh shrink, which lands alone and cannot collapse).
	 * Children that never rendered a frame (shells, cold boots) keep the old
	 * pure-countdown behavior and are handled by G1/G2 only.
	 */
	function tickChain() {
		chainTimer = null;
		state = advanceRetry(state);
		ensureHold();
		if (state.clearDetected || state.stopped) return;
		scheduleNextRetry();
	}

	function ensureHold() {
		if (!tuiFrameSeen || held || state.clearDetected || state.stopped || !holdSize) return;
		sendResize(holdSize.cols, holdSize.rows);
		held = true;
		restored = false;
	}

	function scheduleNextRetry() {
		const delay = nextRetryDelay(state);
		if (delay === null) {
			state = stopRetry(state);
			restoreIfHeld(); // G2
			return;
		}
		chainTimer = setTimeoutFn(tickChain, delay);
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
		holdSize = resizeJiggleSize(cols, rows);
		sendResize(cols, rows);
		if (!holdSize) {
			// The runner clamps below 20x5, so a smaller request would be a
			// net-zero resize and cannot trigger a redraw. Leave the child at the
			// requested original size and disable this attach's jiggle chain.
			state = stopRetry(state);
			held = false;
			restored = true;
			return;
		}
		sendResize(holdSize.cols, holdSize.rows);
		held = true;
		restored = false;
		armG1();
		scheduleNextRetry();
	}

	/**
	 * Feed one socket output chunk. A clear wins over the re-arm when both
	 * appear in one chunk. The first TUI frame restores the held size (the
	 * child is now rendering and will fullRender on the width delta) and
	 * does NOT reschedule the chain; if G1 already released the hold before
	 * the TUI booted, the frame instead re-arms a fresh hold so the running
	 * child still sees a width delta (F1 slow-boot probe).
	 * @param {string} data
	 */
	function feed(data) {
		if (state.clearDetected) return; // chain done; nothing left to detect
		if (state.stopped) return; // chain ended (G2/G3/G4); output is inert
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
			if (held) {
				restoreIfHeld(); // fast path: child is rendering, width delta now lands
				// …unless that frame was in flight BEFORE the shrink and the restore
				// collapses both into a net-zero change at the child (issue #42).
				// Restart the chain on the post-restore grace window: no clear within
				// POST_RESTORE_VERIFY_MS → tickChain re-arms the hold (ensureHold).
				clearChainTimer();
				chainTimer = setTimeoutFn(tickChain, POST_RESTORE_VERIFY_MS);
			} else {
				// Slow boot: G1 released the hold before the TUI came up, so the
				// child baselined at the original size. Re-arm a fresh hold — its
				// next frame then sees a width delta and fullRenders. Guards: the
				// clear path (primary) and G2 budget exhaustion (chain still
				// ticking). G1 is NOT re-armed: frames are now flowing.
				if (holdSize) sendResize(holdSize.cols, holdSize.rows);
				held = holdSize !== null;
				restored = false;
			}
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
		holdSize = null;
		state = stopRetry(state);
	}

	return {
		start,
		feed,
		restoreAndStop,
		notifyExternalResize,
		getState: () => ({ ...state, held, tuiFrameSeen, originalCols, originalRows, holdSize }),
	};
}
