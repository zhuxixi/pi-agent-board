/**
 * Crash-time finalization for PTY hosts (used by pty-runner's uncaughtException
 * handler). Pure enough to unit-test: writes a failed host.json + a diagnostic.
 * Never throws — this runs on the crash path.
 */
import { appendDiagnostic } from "./diagnostics.mjs";
import { writeHost } from "./store.mjs";

/**
 * @param {string} root
 * @param {string} viewId
 * @param {object|null} host
 * @param {unknown} error
 * @returns {object}
 */
export function finalizeHostCrash(root, viewId, host, error) {
	const message = error instanceof Error ? error.message : String(error);
	const failed = {
		...(host ?? { version: 1, viewId, mode: "pty", socketPath: null, startedAt: Date.now() }),
		state: "failed",
		endedAt: Date.now(),
		lastSeenAt: Date.now(),
		exitCode: 1,
		error: message,
	};
	try {
		writeHost(root, failed);
	} catch { /* best effort */ }
	try {
		appendDiagnostic(root, viewId, {
			source: "runner",
			level: "error",
			code: "host_crashed",
			message: `PTY host crashed: ${message}`,
			details: { error: message },
		});
	} catch { /* best effort */ }
	return failed;
}
