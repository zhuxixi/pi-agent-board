/**
 * Crash-time finalization for PTY hosts (used by pty-runner's uncaughtException
 * handler). Pure enough to unit-test: writes a failed host.json + a diagnostic.
 * Never throws — this runs on the crash path.
 */
import { appendDiagnostic } from "./diagnostics.mjs";
import { updateOwnedHost, writeHost } from "./store.mjs";

/**
 * @param {string} root
 * @param {string} viewId
 * @param {object|null} host
 * @param {unknown} error
 * @param {{ expectedInstanceId?: string|null }} [opts] When `expectedInstanceId`
 *   is set (new ownership protocol, issue #70), the failed state is written via
 *   the owner-fenced `updateOwnedHost` — a superseded instance can never
 *   clobber the replacement's live record; the skip is recorded as a
 *   `host_crash_owner_changed` diagnostic. Without it the legacy wholesale
 *   `writeHost` behavior is preserved exactly.
 * @returns {object}
 */
export function finalizeHostCrash(root, viewId, host, error, opts = {}) {
	const message = error instanceof Error ? error.message : String(error);
	const failed = {
		...(host ?? { version: 1, viewId, mode: "pty", socketPath: null, startedAt: Date.now() }),
		state: "failed",
		endedAt: Date.now(),
		lastSeenAt: Date.now(),
		exitCode: 1,
		error: message,
	};
	if (opts.expectedInstanceId != null) {
		try {
			// Build the terminal state from the LIVE record inside the host-meta
			// lock — never from the possibly-stale `host` snapshot.
			const result = updateOwnedHost(root, viewId, opts.expectedInstanceId, (cur) => ({
				...cur,
				state: "failed",
				endedAt: Date.now(),
				lastSeenAt: Date.now(),
				exitCode: 1,
				error: message,
			}));
			if (result.updated && result.host) {
				appendCrashDiagnostic(root, viewId, message);
				return result.host;
			}
			// ownerChanged, or the meta lock was briefly busy: never write unfenced.
			try {
				appendDiagnostic(root, viewId, {
					source: "runner",
					level: "warn",
					code: "host_crash_owner_changed",
					message: `Skipped crash finalize: host record no longer belongs to this instance (${message})`,
					details: { error: message, ownerChanged: result.ownerChanged },
				});
			} catch { /* best effort */ }
		} catch { /* best effort */ }
		return failed;
	}
	try {
		writeHost(root, failed);
	} catch { /* best effort */ }
	appendCrashDiagnostic(root, viewId, message);
	return failed;
}

/** @param {string} root @param {string} viewId @param {string} message */
function appendCrashDiagnostic(root, viewId, message) {
	try {
		appendDiagnostic(root, viewId, {
			source: "runner",
			level: "error",
			code: "host_crashed",
			message: `PTY host crashed: ${message}`,
			details: { error: message },
		});
	} catch { /* best effort */ }
}
