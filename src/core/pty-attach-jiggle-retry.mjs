/** Pure logic for attach jiggle-retry: detect full-clear, schedule backoff retries. */

export const BACKOFF_MS = Object.freeze([120, 500, 1500, 3000, 6000, 10000, 15000, 20000]);
export const MAX_RETRIES = BACKOFF_MS.length;

// Verified empirically in issue #2: a resize jiggle makes the child pi-tui run
// fullRender(true), whose output begins with a full clear — a controlled test
// against a live idle session received 2 clear sequences + ~920KB full repaint
// per jiggle. So \x1b[2J in the socket output is a reliable "jiggle landed"
// signal. If pi-tui ever changes fullRender to skip the clear, the detector
// silently degrades to the old one-shot behavior after MAX_RETRIES.
const FULL_CLEAR = "\x1b[2J";
// pi-tui begins every frame (including differential frames) with a synchronized
// output start sequence; boot-time extension output never contains it, so the
// first occurrence marks "child TUI has started rendering" (issue #10).
const TUI_FRAME_START = "\x1b[?2026h";
/** Carry enough bytes to catch either target sequence split at a chunk boundary. */
const CARRY_LEN = TUI_FRAME_START.length - 1; // 7 bytes

/**
 * @typedef {Object} JiggleRetryState
 * @property {number} retryIndex - Current retry round (0 = initial, not yet retried).
 * @property {boolean} clearDetected - Whether a full-clear sequence was seen.
 * @property {boolean} stopped - Whether the retry chain has been stopped.
 */

/** Create initial retry state. */
export function createJiggleRetryState() {
	return { retryIndex: 0, clearDetected: false, stopped: false };
}

/**
 * Feed PTY output data into the state machine.
 * Returns new state, updated carry buffer, and which target sequences were found.
 * @param {JiggleRetryState} state
 * @param {string} data - New output data chunk.
 * @param {string} carry - Leftover partial escape sequence from previous chunk.
 * @returns {{ state: JiggleRetryState, carry: string, clearFound: boolean, frameStartFound: boolean }}
 */
export function feedOutput(state, data, carry) {
	const combined = carry + data;
	const clearFound = hasFullClearSequence(combined);
	const frameStartFound = hasTuiFrameStart(combined);
	// Always keep the tail carry: a clear hit stops the chain (carry irrelevant), and
	// a frame-start hit must still preserve a trailing half-sequence so an immediately
	// following clear split across the next chunk is not missed.
	const newCarry = tailCarry(combined);
	const newState = clearFound ? { ...state, clearDetected: true } : state;
	return { state: newState, carry: newCarry, clearFound, frameStartFound };
}

/**
 * Get the delay before the next retry, or null if no more retries.
 * @param {JiggleRetryState} state
 * @returns {number | null}
 */
export function nextRetryDelay(state) {
	if (state.stopped || state.clearDetected) return null;
	if (state.retryIndex >= MAX_RETRIES) return null;
	return BACKOFF_MS[state.retryIndex];
}

/**
 * Advance to the next retry round.
 * @param {JiggleRetryState} state
 * @returns {JiggleRetryState}
 */
export function advanceRetry(state) {
	return { ...state, retryIndex: state.retryIndex + 1 };
}

/**
 * Stop the retry chain (attach settled, component closed, etc.).
 * @param {JiggleRetryState} state
 * @returns {JiggleRetryState}
 */
export function stopRetry(state) {
	return { ...state, stopped: true };
}

/**
 * Check if data contains the full-clear escape sequence.
 * @param {string} data
 * @returns {boolean}
 */
export function hasFullClearSequence(data) {
	return data.includes(FULL_CLEAR);
}

/**
 * Check if data contains the TUI frame-start (synchronized output) sequence.
 * pi-tui begins every frame with \x1b[?2026h; boot-time extension output never
 * contains it, so the first occurrence marks "child TUI has started rendering".
 * @param {string} data
 * @returns {boolean}
 */
export function hasTuiFrameStart(data) {
	return data.includes(TUI_FRAME_START);
}

/** Extract the tail carry for cross-chunk boundary detection. */
function tailCarry(data) {
	// We only need to carry up to CARRY_LEN bytes to catch a split \x1b[2J or
	// \x1b[?2026h. Find the last \x1b in the tail — everything before it can't be
	// part of a split escape sequence.
	const tail = data.slice(-CARRY_LEN);
	const escIdx = tail.lastIndexOf("\x1b");
	return escIdx >= 0 ? tail.slice(escIdx) : "";
}
