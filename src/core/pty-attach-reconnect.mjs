/**
 * Attach reconnect policy (issue #48). The pty-runner can die without sending
 * an exit message (uncaught crash), which previously left the attach view in a
 * 150 ms reconnect loop forever with no way out. Two regimes:
 *  - ever connected: a crashed host is unrecoverable quickly — give up after a
 *    short window and report "host exited";
 *  - never connected: the host may still be cold-starting (service launches it
 *    right before attach) — allow a long window before declaring it unreachable.
 */

/** Give-up delay after a previously-established connection drops (ms). */
export const ATTACH_RECONNECT_TIMEOUT_MS = 15_000;
/** Give-up delay while waiting for the initial host connection (ms). */
export const ATTACH_HOST_START_TIMEOUT_MS = 120_000;

/**
 * @param {{ everConnected: boolean, disconnectedAt: number|null, connectStartedAt: number, now: number }} input
 * @returns {{ giveUp: boolean, status: string | null }}
 */
export function evaluateAttachReconnect({ everConnected, disconnectedAt, connectStartedAt, now }) {
	if (everConnected && disconnectedAt !== null) {
		const elapsed = now - disconnectedAt;
		return elapsed >= ATTACH_RECONNECT_TIMEOUT_MS
			? { giveUp: true, status: "host exited" }
			: { giveUp: false, status: null };
	}
	const elapsed = now - connectStartedAt;
	return elapsed >= ATTACH_HOST_START_TIMEOUT_MS
		? { giveUp: true, status: "host not reachable" }
		: { giveUp: false, status: null };
}

/**
 * Detach-key policy (issue #91 Phase 6, spec §D1): while the socket is down a
 * key can never reach the child, so treat ← as "leave the view"
 * unconditionally; otherwise detach only when the pushed editorEmpty side
 * channel is exactly true. false and null/undefined mean "forward" — the
 * explicit conservative policy; callers pass `editorEmpty === true` so an
 * unknown state can never arm the detach, and no terminal-buffer heuristic is
 * consulted (the deleted terminal-buffer heuristic family — issues
 * #42/#66/#69/#103 — stays deleted).
 * @param {boolean} connected
 * @param {boolean} editorEmpty
 * @returns {boolean}
 */
export function shouldEscapeAttach(connected, editorEmpty) {
	// Normalize to a strict boolean: a null/undefined editorEmpty (unknown)
	// forwards — never escapes — and must not leak through the return value.
	return !connected || editorEmpty === true;
}
