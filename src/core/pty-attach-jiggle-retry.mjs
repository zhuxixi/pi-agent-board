/** Pure logic for attach jiggle-retry: detect full-clear, schedule backoff retries. */

export const BACKOFF_MS = Object.freeze([120, 500, 1500, 3000]);
export const MAX_RETRIES = BACKOFF_MS.length;

const FULL_CLEAR = "\x1b[2J";
/** Carry enough bytes to catch a split escape sequence at chunk boundary. */
const CARRY_LEN = FULL_CLEAR.length - 1; // 3 bytes: \x1b, \x1b[, \x1b[2

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
 * Returns new state, updated carry buffer, and whether a clear was found.
 * @param {JiggleRetryState} state
 * @param {string} data - New output data chunk.
 * @param {string} carry - Leftover partial escape sequence from previous chunk.
 * @returns {{ state: JiggleRetryState, carry: string, clearFound: boolean }}
 */
export function feedOutput(state, data, carry) {
	const combined = carry + data;
	const clearFound = hasFullClearSequence(combined);
	const newCarry = clearFound ? "" : tailCarry(combined);
	const newState = clearFound ? { ...state, clearDetected: true } : state;
	return { state: newState, carry: newCarry, clearFound };
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

/** Extract the tail carry for cross-chunk boundary detection. */
function tailCarry(data) {
	// We only need to carry up to CARRY_LEN bytes to catch a split \x1b[2J.
	const tail = data.slice(-CARRY_LEN);
	// Find the last \x1b in the tail — everything before it can't be part of
	// a split escape sequence.
	const escIdx = tail.lastIndexOf("\x1b");
	return escIdx >= 0 ? tail.slice(escIdx) : "";
}
