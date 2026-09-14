/** Process liveness checks and process identity capture. */
import { readFileSync } from "node:fs";

/**
 * Whether `pid` refers to a live process.
 * `process.kill(pid, 0)` throws ESRCH when the process is gone, and EPERM when it
 * exists but we lack permission to signal it — EPERM still means "alive".
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
	}
}

/**
 * Try to terminate a process tree gently, then force after `graceMs`.
 * Safe no-op if already dead.
 * @param {number|null|undefined} pid
 * @param {number} [graceMs]
 */
export function killProcess(pid, graceMs = 4000) {
	if (!isAlive(pid)) return;
	try {
		process.kill(/** @type {number} */ (pid), "SIGTERM");
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		if (isAlive(pid)) {
			try {
				process.kill(/** @type {number} */ (pid), "SIGKILL");
			} catch {
				/* ignore */
			}
		}
	}, graceMs).unref?.();
}

/**
 * POSIX process start token — /proc/<pid>/stat field 22 (starttime), stable
 * across exec(2). Distinguishes an owned-live pid from a reused one; null on
 * failure or non-Linux platforms. Mirrors the runner's captureStartToken
 * (issue #70); shared here for host-meta lease identity (issue #112).
 * @param {number|null|undefined} pid
 * @returns {string|null}
 */
export function captureStartToken(pid) {
	if (process.platform !== "linux" || !pid) return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) may contain spaces and parens — fields resume AFTER the
		// last ')'. fields[0] is state (field 3) → starttime (field 22) is [19].
		const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trimStart();
		return afterComm.split(/\s+/)[19] ?? null;
	} catch {
		return null;
	}
}

/**
 * Launch-time identity for the current process, as stamped on host-meta
 * acquisitions (issue #112).
 * @returns {{pid: number, startToken: string|null}}
 */
export function currentProcessIdentity() {
	return { pid: process.pid, startToken: captureStartToken(process.pid) };
}
