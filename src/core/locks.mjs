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
 * Age past which an identity-less lock is treated as an orphan candidate.
 * Host-meta holds are millisecond-scale critical sections, so no legitimate
 * holder reaches this (issue #112).
 */
const ORPHAN_LEASE_AGE_MS = 5 * 60_000;
/** Age past which a heartbeating lease with no live proof of ownership is an orphan. */
export const LEASE_HEARTBEAT_STALE_MS = 60_000;
/** Consecutive supervised heartbeat failures after which a holder must vacate. */
export const MAX_CONSECUTIVE_TOUCH_FAILURES = 3;

/**
 * A token-fenced lease over the view-lock directory. Every operation re-reads
 * owner.json and only acts while it still carries this lease's token, so a
 * superseded owner can never touch — heartbeat or delete — the current owner's
 * lock. Unlike withFileLockSync, a held lock is never stolen by age alone; it
 * can only be reclaimed when its recorded owner process is provably dead, or
 * when a heartbeating owner stopped heartbeating (issue #224).
 * @typedef {Object} LeaseReclaimed
 * @property {number} ownerPid
 * @property {number|null} heartbeatAgeMs
 * @property {number} lockAgeMs
 * @property {"declared" | "legacy"} eligibility
 */

/**
 * @typedef {Object} Lease
 * @property {string} token
 * @property {LeaseReclaimed|null} reclaimed metadata when this acquire reclaimed a stale lease
 * @property {() => boolean} touch
 * @property {() => boolean} isOwner
 * @property {() => boolean} release
 */

/**
 * @param {string} root
 * @param {string} viewId
 * @param {string} name
 * @param {{ waitMs?: number, identity?: object|null, heartbeatMs?: number, fs?: Partial<typeof defaultLeaseFs>, clock?: () => number, isProcessDead?: (pid: number) => boolean }} [opts]
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
 * @param {{ identity?: object|null, heartbeatMs?: number, fs?: Partial<typeof defaultLeaseFs>, clock?: () => number, isProcessDead?: (pid: number) => boolean }} [opts]
 * @returns {{ acquired: true, lease: Lease } | { acquired: false, reason: "busy"|"blocked" }}
 */
export function tryAcquireOwnedViewLock(root, viewId, name, opts = {}) {
	const attempt = attemptAcquireLease(P.viewLockPath(root, viewId, name), opts);
	if (typeof attempt === "string") return { acquired: false, reason: attempt };
	return { acquired: true, lease: attempt };
}

/**
 * Whether a publish-rename failure means "the lock path already exists"
 * (contention) rather than a genuine filesystem error.
 *
 * POSIX reports EEXIST/ENOTEMPTY when renaming a directory onto an existing
 * one; Windows reports EPERM (errno -4048) for the same situation — this op's
 * platform equivalent of EEXIST (issue #114: a crashed owner's lease could
 * never be reclaimed because EPERM was rethrown before reclaimOrBlock).
 * Routing a genuine permission error here stays safe: reclaimability is still
 * decided solely by `classifyLeaseOwner`, so it resolves `blocked`/`busy`.
 * @param {string|undefined|null} code
 * @returns {boolean}
 */
export function isPublishConflictCode(code) {
	return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}

/**
 * Single-shot acquire round: publish a complete candidate lock (owner.json
 * written BEFORE the lock path exists) via atomic rename, and on contention
 * either reclaim a provably-dead owner's lock via quarantine or report.
 * @param {string} lockPath
 * @param {{ identity?: object|null, heartbeatMs?: number, fs?: Partial<typeof defaultLeaseFs>, clock?: () => number, isProcessDead?: (pid: number) => boolean }} opts
 * @returns {Lease | "busy" | "blocked"}
 */
function attemptAcquireLease(lockPath, opts) {
	const fs = { ...defaultLeaseFs, ...(opts.fs ?? {}) };
	const now = opts.clock ?? Date.now;
	const isProcessDead = opts.isProcessDead ?? ((pid) => !isAlive(pid));
	const identity = opts.identity ?? null;
	const heartbeatMs = Number(opts.heartbeatMs ?? 0);
	// Declaring the period is what makes this lease reclaimable on staleness
	// alone (issue #224 D2); unset keeps the pre-#224 record shape.
	const declaresHeartbeat = Number.isFinite(heartbeatMs) && heartbeatMs > 0;
	let reclaimed = null;
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
				JSON.stringify({
					token, pid: process.pid, identity, startedAt: now(),
					...(declaresHeartbeat ? { heartbeatMs } : {}),
				}),
				"utf8",
			);
			fs.renameSync(candidate, lockPath);
			return makeLease(lockPath, token, fs, now, reclaimed);
		} catch (err) {
			try { fs.rmSync(candidate, { recursive: true, force: true }); } catch { /* best effort */ }
			const code = /** @type {NodeJS.ErrnoException|undefined} */ (err)?.code;
			if (!isPublishConflictCode(code)) throw err;
			const outcome = reclaimOrBlock(lockPath, token, fs, isProcessDead, now);
			if (typeof outcome === "string") return outcome;
			reclaimed = outcome.reclaimed;
			// Reclaimed a stale owner's lock — retry the publish on the next round.
		}
	}
	return "busy";
}

/**
 * Decide what to do with an inspected lease owner. Pure: the caller supplies
 * `now`, a pid-liveness probe and the observed heartbeat age.
 *
 * Heartbeat eligibility comes first, because a reused pid looks alive while the
 * recorded owner is long gone (issue #224). Two mutually exclusive paths:
 * - declared: the owner wrote `heartbeatMs` into owner.json. Threshold is
 *   `max(heartbeatStaleMs, 3 × heartbeatMs)`; a missing heartbeat falls back to
 *   the lock age. This path applies to identity and identity-less owners and
 *   bypasses the identity-less age gate, or a crash would take 5 minutes to heal.
 * - legacy: a `heartbeat.<token>` file exists (hence `heartbeatAgeMs != null`)
 *   and the lock is past `orphanAgeMs`. The age gate keeps millisecond-scale
 *   short-hold leases (`host-meta`, `host-start`) out of this path.
 *
 * Without heartbeat evidence the pre-#224 liveness rules apply unchanged: a
 * full identity (pid + startToken) reclaims exactly when its pid is dead; an
 * identity-less owner is only reclaimable past `orphanAgeMs` with a provably
 * dead pid, so fresh identity-less locks stay blocked (issue #112).
 * @param {any} owner parsed owner.json
 * @param {number} now
 * @param {(pid: number) => boolean} isProcessDead
 * @param {{ orphanAgeMs?: number, heartbeatAgeMs?: number|null, heartbeatMs?: number, heartbeatStaleMs?: number }} [opts]
 * @returns {"reclaim" | "busy" | "blocked"}
 */
export function classifyLeaseOwner(owner, now, isProcessDead, opts = {}) {
	if (!owner || typeof owner !== "object") return "blocked";
	const identityPid = Number(owner?.identity?.pid ?? 0);
	const hasIdentity = Number.isFinite(identityPid) && identityPid > 0 && typeof owner?.identity?.startToken === "string";
	const pid = Number(owner?.identity?.pid ?? owner?.pid ?? 0);
	if (!Number.isFinite(pid) || pid <= 0) return "blocked";
	// Quarantine-mode reclaim verifies by token that it renamed the lock it
	// inspected — without one nothing may be deleted.
	const reclaimable = typeof owner.token === "string";
	const orphanAgeMs = Number(opts.orphanAgeMs ?? ORPHAN_LEASE_AGE_MS);
	// The declared period may arrive via opts (I/O shell) or already be on the
	// parsed owner record (pure callers); opts wins.
	const heartbeatMs = Number(opts.heartbeatMs ?? owner?.heartbeatMs ?? 0);
	const declared = Number.isFinite(heartbeatMs) && heartbeatMs > 0;
	const heartbeatStaleMs = Number(opts.heartbeatStaleMs ?? LEASE_HEARTBEAT_STALE_MS);
	const lockAgeMs = Number(now) - Number(owner?.startedAt ?? 0);
	if (declared) {
		const heartbeatAgeMs = Math.max(0, Number(opts.heartbeatAgeMs ?? lockAgeMs));
		if (heartbeatAgeMs >= Math.max(heartbeatStaleMs, 3 * heartbeatMs)) return reclaimable ? "reclaim" : "blocked";
	} else if (opts.heartbeatAgeMs != null && lockAgeMs >= orphanAgeMs) {
		const heartbeatAgeMs = Math.max(0, Number(opts.heartbeatAgeMs));
		if (heartbeatAgeMs >= heartbeatStaleMs) return reclaimable ? "reclaim" : "blocked";
	}
	if (hasIdentity) {
		if (!isProcessDead(pid)) return "busy";
		return reclaimable ? "reclaim" : "blocked";
	}
	if (!declared && lockAgeMs < orphanAgeMs) return "blocked";
	if (!isProcessDead(pid)) return "busy";
	return reclaimable ? "reclaim" : "blocked";
}

/**
 * Read the owner-written heartbeat and return its age in ms. A future `at`
 * (clock skew) clamps to 0: a heartbeat must never look older than it is.
 * @param {string} lockPath
 * @param {any} token the recorded owner token (names the heartbeat file)
 * @param {{ readFileSync: (path: string, encoding: string) => string }} [fs]
 * @param {number} [now]
 * @returns {number|null} null when the file is missing or its `at` is unusable
 */
export function readLeaseHeartbeat(lockPath, token, fs = defaultLocksFs, now = Date.now()) {
	if (typeof token !== "string" || token.length === 0) return null;
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(lockPath, `heartbeat.${token}`), "utf8"));
	} catch {
		return null;
	}
	const at = Number(parsed?.at);
	return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/**
 * Decide whether an existing lock may be reclaimed. Verdicts come from the
 * pure `classifyLeaseOwner`; reclaim itself quarantines via rename first so a
 * concurrent winner can only ever delete the directory it itself renamed.
 *
 * The observed heartbeat age is the only I/O this adds: a missing or broken
 * heartbeat file resolves to null, which grants no eligibility to an
 * undeclared lease (fail closed) and falls back to the lock age for a declared
 * one (issue #224 D3).
 * @param {string} lockPath
 * @param {string} token the caller's own token (names the quarantine dir)
 * @param {typeof defaultLeaseFs} fs
 * @param {(pid: number) => boolean} isProcessDead
 * @param {() => number} now clock (matching the caller's candidate timestamps)
 * @returns {{ reclaimed: LeaseReclaimed } | "busy" | "blocked"}
 */
function reclaimOrBlock(lockPath, token, fs, isProcessDead, now) {
	let owner;
	try {
		owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
	} catch {
		return "blocked";
	}
	const at = now();
	const heartbeatAgeMs = readLeaseHeartbeat(lockPath, owner?.token, fs, at);
	const declaredHeartbeatMs = Number(owner?.heartbeatMs ?? 0);
	const declared = Number.isFinite(declaredHeartbeatMs) && declaredHeartbeatMs > 0;
	const verdict = classifyLeaseOwner(owner, at, isProcessDead, {
		heartbeatAgeMs,
		heartbeatMs: declared ? declaredHeartbeatMs : undefined,
		heartbeatStaleMs: LEASE_HEARTBEAT_STALE_MS,
	});
	if (verdict !== "reclaim") return verdict;
	// classifyLeaseOwner only returns "reclaim" when owner.token is a string.
	const inspectedToken = owner.token;
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
	return {
		reclaimed: {
			ownerPid: Number(owner?.identity?.pid ?? owner?.pid ?? 0),
			heartbeatAgeMs,
			lockAgeMs: at - Number(owner?.startedAt ?? 0),
			eligibility: declared ? "declared" : "legacy",
		},
	};
}

/**
 * Summarize why an existing lock is not acquirable, so the coordinator can
 * record a diagnostic instead of exiting silently (issue #224 D6).
 *
 * Returns exactly the six keys that become the `coordinator_lease_unavailable`
 * details — no more, no less. `reason` is the raw `classifyLeaseOwner` verdict
 * at call time, so on the acquisition-failure path it is `"busy"` or
 * `"blocked"`.
 * @param {string} root
 * @param {string} viewId
 * @param {string} name
 * @param {{ fs?: Partial<typeof defaultLeaseFs>, clock?: () => number, isProcessDead?: (pid: number) => boolean }} [opts]
 * @returns {{ reason: "reclaim"|"busy"|"blocked", ownerPid: number, hasIdentity: boolean, lockAgeMs: number, heartbeatAgeMs: number|null, heartbeatMs: number|null } | null}
 */
export function describeLeaseConflict(root, viewId, name, opts = {}) {
	const fs = { ...defaultLeaseFs, ...(opts.fs ?? {}) };
	const lockPath = P.viewLockPath(root, viewId, name);
	let owner;
	try {
		owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
	} catch {
		return null;
	}
	if (!owner || typeof owner !== "object") return null;
	const at = (opts.clock ?? Date.now)();
	const isProcessDead = opts.isProcessDead ?? ((pid) => !isAlive(pid));
	const identityPid = Number(owner?.identity?.pid ?? 0);
	const heartbeatAgeMs = readLeaseHeartbeat(lockPath, owner?.token, fs, at);
	const declaredHeartbeatMs = Number(owner?.heartbeatMs ?? 0);
	const heartbeatMs = Number.isFinite(declaredHeartbeatMs) && declaredHeartbeatMs > 0 ? declaredHeartbeatMs : null;
	return {
		reason: classifyLeaseOwner(owner, at, isProcessDead, {
			heartbeatAgeMs,
			heartbeatMs: heartbeatMs ?? undefined,
			heartbeatStaleMs: LEASE_HEARTBEAT_STALE_MS,
		}),
		ownerPid: Number(owner?.identity?.pid ?? owner?.pid ?? 0),
		hasIdentity: Number.isFinite(identityPid) && identityPid > 0 && typeof owner?.identity?.startToken === "string",
		lockAgeMs: at - Number(owner?.startedAt ?? 0),
		heartbeatAgeMs,
		heartbeatMs,
	};
}

/**
 * Supervised heartbeat failure policy: a holder that cannot prove liveness for
 * `maxFailures` consecutive ticks must vacate rather than be preempted later.
 * @param {number} consecutiveFailures
 * @param {number} [maxFailures]
 * @returns {"continue" | "abandon"}
 */
export function heartbeatFailureAction(consecutiveFailures, maxFailures = MAX_CONSECUTIVE_TOUCH_FAILURES) {
	return Number(consecutiveFailures) >= Number(maxFailures) ? "abandon" : "continue";
}

/**
 * @param {string} lockPath
 * @param {string} token
 * @param {typeof defaultLeaseFs} fs
 * @param {() => number} now
 * @param {LeaseReclaimed|null} [reclaimed]
 * @returns {Lease}
 */
function makeLease(lockPath, token, fs, now, reclaimed = null) {
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
		reclaimed,
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
