/**
 * Attach decision tables for the agent-board attach flow (issue #70).
 *
 * Pure mapping functions extracted from the two near-duplicate attach()
 * implementations (src/commands/attach-flow.ts and the private copy in
 * src/commands/agent-board.ts) so the branching contract is node-testable.
 * Both TS files consume these for their prelude and resolver-result
 * branching; they must stay free of I/O, service calls, and UI.
 */

/** Default message surfaced when the resolver reports pending without a reason. */
export const ATTACH_PENDING_DEFAULT_MESSAGE = "Session host is starting — try again shortly.";

/**
 * Prelude facts as observed from a dashboard row.
 * @typedef {{ rowAlive: boolean, rowHostActive: boolean, stopFirst: boolean }} AttachPreludeFacts
 */

/**
 * Map the attach prelude guards to a plan.
 *
 * The prelude only guards live JSON-runner rows (alive with no host claim):
 * a row with an active host (starting/alive/stopping) passes straight
 * through to the async resolver — attaching must not block or warn while a
 * host is starting (issue #70).
 *
 * @param {AttachPreludeFacts} facts
 * @returns {{ plan: "warn-running" } | { plan: "stop-first" } | { plan: "proceed" }}
 */
export function planAttachPrelude({ rowAlive, rowHostActive, stopFirst }) {
	if (rowAlive && !rowHostActive) {
		return stopFirst ? { plan: "stop-first" } : { plan: "warn-running" };
	}
	return { plan: "proceed" };
}

/**
 * Map a `resolveAttachTarget()` result to the attach action plan.
 *
 * `socketPath` is typed `string | null` upstream; a pty resolution without a
 * usable path is a transient resolver inconsistency and maps to
 * notify-pending (retry later) rather than a misleading "missing".
 *
 * @param {{ kind: "pty", socketPath: string | null, sessionFile?: string, instanceId?: string | null } |
 *          { kind: "session", sessionFile: string } |
 *          { kind: "pending", sessionFile?: string, reason?: string } |
 *          { kind: "missing" }} resolved
 * @returns {{ plan: "open-pty", socketPath: string } |
 *           { plan: "session-switch", sessionFile: string } |
 *           { plan: "notify-pending", reason: string } |
 *           { plan: "notify-missing" }}
 */
export function planAttachResolved(resolved) {
	switch (resolved?.kind) {
		case "pty":
			return resolved.socketPath != null
				? { plan: "open-pty", socketPath: resolved.socketPath }
				: { plan: "notify-pending", reason: ATTACH_PENDING_DEFAULT_MESSAGE };
		case "session":
			return { plan: "session-switch", sessionFile: resolved.sessionFile };
		case "pending":
			return { plan: "notify-pending", reason: resolved.reason ?? ATTACH_PENDING_DEFAULT_MESSAGE };
		default:
			return { plan: "notify-missing" };
	}
}
