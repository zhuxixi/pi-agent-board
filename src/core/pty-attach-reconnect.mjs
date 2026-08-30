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
 * Detach-key policy: while the socket is down a key can never reach the child,
 * so treat ← / ctrl+] as "leave the view" unconditionally; otherwise keep the
 * existing empty-input-line gate (issue #48 comment 1).
 * @param {boolean} connected
 * @param {boolean} childInputLooksEmpty
 * @returns {boolean}
 */
export function shouldEscapeAttach(connected, childInputLooksEmpty) {
	return !connected || childInputLooksEmpty;
}
