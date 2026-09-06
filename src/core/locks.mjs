/**
 * Tiny dependency-free synchronous file lock helpers for local agent-board artifacts.
 * Locks use atomic mkdir on a sibling .lock directory and are cleaned up in finally.
 *
 * Failure model (issue #33): acquisition failures are classified.
 * - EEXIST (contention): wait in 20ms ticks until the stale window passes, then
 *   force-steal (bounded to MAX_STEAL_ATTEMPTS). This preserves the original
 *   wait/steal contract (see test/locks.test.mjs).
 * - Anything else (deleted parent, read-only fs, permissions, disk full, ...):
 *   MAX_ENV_ATTEMPTS quick retries — each retry re-runs ensureDir so a parent
 *   deleted mid-acquisition self-heals — then throw LOCK_TIMEOUT. Never spin.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { ensureDir } from "./atomic.mjs";
import { isAlive } from "./pid.mjs";
import * as P from "./paths.mjs";

const DEFAULT_STALE_MS = 30_000;
/** Minimum contention window before a fresh lock can be force-stolen. */
const MIN_WINDOW_MS = 250;
const WAIT_TICK_MS = 20;
/** Max stale-lock steal attempts before giving up. */
const MAX_STEAL_ATTEMPTS = 2;
/** Max quick retries for environmental failures before giving up. */
const MAX_ENV_ATTEMPTS = 3;

export const defaultLocksFs = Object.freeze({ existsSync, mkdirSync, readFileSync, rmSync, writeFileSync });

/**
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{ staleMs?: number, fs?: typeof defaultLocksFs }} [opts]
 * @returns {T}
 */
export function withFileLockSync(lockPath, fn, opts = {}) {
	const fs = opts.fs ?? defaultLocksFs;
	acquireLock(lockPath, opts.staleMs ?? DEFAULT_STALE_MS, fs);
	let result;
	try {
		result = fn();
	} finally {
		releaseLock(lockPath, fs);
	}
	return result;
}

/**
 * @template T
 * @param {string} root
 * @param {string} viewId
 * @param {string} name
 * @param {() => T} fn
 * @param {{ staleMs?: number, fs?: typeof defaultLocksFs }} [opts]
 * @returns {T}
 */
export function withViewLockSync(root, viewId, name, fn, opts = {}) {
	return withFileLockSync(P.viewLockPath(root, viewId, name), fn, opts);
}

/** @param {string} lockPath @param {number} staleMs @param {typeof defaultLocksFs} fs */
function acquireLock(lockPath, staleMs, fs) {
	const deadline = Date.now() + Math.max(MIN_WINDOW_MS, staleMs);
	let steals = 0;
	let envAttempts = 0;
	for (;;) {
		let created = false;
		try {
			// Re-run every attempt: a parent deleted mid-acquisition self-heals here.
			ensureDir(path.dirname(lockPath));
			fs.mkdirSync(lockPath);
			created = true;
			fs.writeFileSync(
				path.join(lockPath, "owner.json"),
				JSON.stringify({ pid: process.pid, at: Date.now() }),
				"utf8",
			);
			return;
		} catch (err) {
			if (err && err.code === "EEXIST") {
				const expired = Date.now() >= deadline;
				if (isLockStale(lockPath, staleMs, fs) || expired) {
					if (steals >= MAX_STEAL_ATTEMPTS) {
						throw lockError(lockPath, `stale lock could not be stolen after ${steals} attempts`);
					}
					steals += 1;
					releaseLock(lockPath, fs);
					continue;
				}
				sleep(WAIT_TICK_MS);
				continue;
			}
			// Environmental failure: bounded quick retries, then fail fast.
			if (created) releaseLock(lockPath, fs);
			envAttempts += 1;
			if (envAttempts >= MAX_ENV_ATTEMPTS) {
				const reason = (err && (err.code || err.message)) || "unknown error";
				throw lockError(lockPath, `lock path unusable (${reason})`);
			}
			sleep(WAIT_TICK_MS);
		}
	}
}

/** @param {string} lockPath @param {string} reason */
function lockError(lockPath, reason) {
	const err = new Error(`file lock unavailable: ${lockPath} (${reason})`);
	err.code = "LOCK_TIMEOUT";
	return err;
}

/** @param {number} ms */
function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {string} lockPath @param {number} staleMs @param {typeof defaultLocksFs} fs */
function isLockStale(lockPath, staleMs, fs) {
	try {
		if (!fs.existsSync(lockPath)) return false;
		const raw = fs.readFileSync(path.join(lockPath, "owner.json"), "utf8");
		const owner = JSON.parse(raw);
		return Date.now() - Number(owner.at ?? 0) > staleMs;
	} catch {
		return true;
	}
}

/** @param {string} lockPath @param {typeof defaultLocksFs} fs */
function releaseLock(lockPath, fs) {
	try {
		fs.rmSync(lockPath, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

// ---- owner-safe leases (issue #70) ----------------------------------------

/** Lease fs = lock fs + rename (candidate publish + quarantine reclaim). */
const defaultLeaseFs = Object.freeze({ ...defaultLocksFs, renameSync });
/** Max stale-reclaim → republish rounds inside a single acquire attempt. */
const MAX_LEASE_RECLAIM_ATTEMPTS = 3;

/**
 * A token-fenced lease over the view-lock directory. Every operation re-reads
 * owner.json and only acts while it still carries this lease's token, so a
 * superseded owner can never touch — heartbeat or delete — the current owner's
 * lock. Unlike withFileLockSync, a held lock is never stolen by age alone; it
 * can only be reclaimed when its recorded owner process is provably dead.
 * @typedef {Object} Lease
 * @property {string} token
 * @property {() => boolean} touch
 * @property {() => boolean} isOwner
 * @property {() => boolean} release
 */

/**
 * @param {string} root
 * @param {string} viewId
 * @param {string} name
 * @param {{ waitMs?: number, identity?: object|null, fs?: Partial<typeof defaultLeaseFs>, clock?: () => number, isProcessDead?: (pid: number) => boolean }} [opts]
 * @returns {Lease}
 * @throws {Error & { code: "LOCK_TIMEOUT" }} when the lock is still held after waitMs
 */
export function acquireOwnedViewLock(root, viewId, name, opts = {}) {
	const lockPath = P.viewLockPath(root, viewId, name);
	const deadline = Date.now() + Math.max(0, Number(opts.waitMs ?? 0));
	for (;;) {
		const attempt = attemptAcquireLease(lockPath, opts);
		if (typeof attempt !== "string") return attempt;
		if (Date.now() >= deadline) throw lockError(lockPath, `lease not acquired (${attempt})`);
		sleep(WAIT_TICK_MS);
	}
}

/**
 * @param {string} root
 * @param {string} viewId
 * @param {string} name
 * @param {{ identity?: object|null, fs?: Partial<typeof defaultLeaseFs>, clock?: () => number, isProcessDead?: (pid: number) => boolean }} [opts]
 * @returns {{ acquired: true, lease: Lease } | { acquired: false, reason: "busy"|"blocked" }}
 */
export function tryAcquireOwnedViewLock(root, viewId, name, opts = {}) {
	const attempt = attemptAcquireLease(P.viewLockPath(root, viewId, name), opts);
	if (typeof attempt === "string") return { acquired: false, reason: attempt };
	return { acquired: true, lease: attempt };
}

/**
 * Single-shot acquire round: publish a complete candidate lock (owner.json
 * written BEFORE the lock path exists) via atomic rename, and on contention
 * either reclaim a provably-dead owner's lock via quarantine or report.
 * @param {string} lockPath
 * @param {{ identity?: object|null, fs?: Partial<typeof defaultLeaseFs>, clock?: () => number, isProcessDead?: (pid: number) => boolean }} opts
 * @returns {Lease | "busy" | "blocked"}
 */
function attemptAcquireLease(lockPath, opts) {
	const fs = { ...defaultLeaseFs, ...(opts.fs ?? {}) };
	const now = opts.clock ?? Date.now;
	const isProcessDead = opts.isProcessDead ?? ((pid) => !isAlive(pid));
	const identity = opts.identity ?? null;
	for (let attempt = 0; attempt < MAX_LEASE_RECLAIM_ATTEMPTS; attempt++) {
		const token = randomBytes(16).toString("hex");
		const candidate = `${lockPath}.candidate.${token}`;
		ensureDir(path.dirname(lockPath));
		try {
			// Candidate dir is unique per token; a rename publishes the COMPLETE
			// record atomically — no observer can see a lock without owner.json.
			fs.mkdirSync(candidate);
			fs.writeFileSync(
				path.join(candidate, "owner.json"),
				JSON.stringify({ token, pid: process.pid, identity, startedAt: now() }),
				"utf8",
			);
			fs.renameSync(candidate, lockPath);
			return makeLease(lockPath, token, fs, now);
		} catch (err) {
			try { fs.rmSync(candidate, { recursive: true, force: true }); } catch { /* best effort */ }
			const code = err && err.code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") throw err;
			const verdict = reclaimOrBlock(lockPath, token, fs, isProcessDead);
			if (verdict !== true) return verdict;
			// Reclaimed a dead owner's lock — retry the publish on the next round.
		}
	}
	return "busy";
}

/**
 * Decide whether an existing lock may be reclaimed. Only a lock whose
 * owner.json carries a usable identity (pid + startToken) AND whose pid is
 * provably dead is reclaimable; anything corrupt, unreadable, or live is
 * never deleted. Reclaim quarantines via rename first so a concurrent winner
 * can only ever delete the directory it itself renamed.
 * @param {string} lockPath
 * @param {string} token the caller's own token (names the quarantine dir)
 * @param {typeof defaultLeaseFs} fs
 * @param {(pid: number) => boolean} isProcessDead
 * @returns {true | "busy" | "blocked"}
 */
function reclaimOrBlock(lockPath, token, fs, isProcessDead) {
	let owner;
	try {
		owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
	} catch {
		return "blocked";
	}
	const pid = Number(owner?.identity?.pid ?? 0);
	if (!Number.isFinite(pid) || pid <= 0 || typeof owner?.identity?.startToken !== "string") return "blocked";
	if (!isProcessDead(pid)) return "busy";
	const inspectedToken = typeof owner?.token === "string" ? owner.token : null;
	if (inspectedToken === null) return "blocked";
	const quarantine = `${lockPath}.reclaim.${token}`;
	try {
		fs.renameSync(lockPath, quarantine);
	} catch {
		// Someone else released/reclaimed concurrently — plain contention.
		return "busy";
	}
	// Verify we quarantined exactly the lock we inspected: a concurrent winner
	// may have reclaimed the dead owner and published a fresh lock at lockPath
	// between our read and this rename. If so, restore it and report contention
	// instead of deleting a successor's lock.
	let quarantinedToken = null;
	try {
		quarantinedToken = JSON.parse(fs.readFileSync(path.join(quarantine, "owner.json"), "utf8"))?.token ?? null;
	} catch { /* unreadable quarantine content */ }
	if (quarantinedToken !== inspectedToken) {
		try { fs.renameSync(quarantine, lockPath); } catch { /* best effort restore */ }
		return "busy";
	}
	try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch { /* best effort */ }
	return true;
}

/**
 * @param {string} lockPath
 * @param {string} token
 * @param {typeof defaultLeaseFs} fs
 * @param {() => number} now
 * @returns {Lease}
 */
function makeLease(lockPath, token, fs, now) {
	const ownerPath = path.join(lockPath, "owner.json");
	const heartbeatPath = path.join(lockPath, `heartbeat.${token}`);
	const stillOwns = () => {
		try {
			return JSON.parse(fs.readFileSync(ownerPath, "utf8"))?.token === token;
		} catch {
			return false;
		}
	};
	return {
		token,
		isOwner: () => stillOwns(),
		touch() {
			if (!stillOwns()) return false;
			try {
				// Heartbeat lives in a token-named file: old tokens can never
				// overwrite the canonical owner record or a successor's heartbeat.
				fs.writeFileSync(heartbeatPath, JSON.stringify({ at: now() }), "utf8");
				return true;
			} catch {
				return false;
			}
		},
		release() {
			if (!stillOwns()) return false;
			try {
				fs.rmSync(lockPath, { recursive: true, force: true });
				return true;
			} catch {
				return false;
			}
		},
	};
}

/**
 * Simulates a late release() from a superseded token. Exported so tests can
 * prove old tokens can never delete a successor's lock.
 * @visibleForTesting
 * @param {string} root @param {string} viewId @param {string} name @param {string} token
 * @returns {boolean}
 */
export function releaseWithToken(root, viewId, name, token) {
	return makeLease(P.viewLockPath(root, viewId, name), token, defaultLeaseFs, Date.now).release();
}
