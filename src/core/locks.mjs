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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { ensureDir } from "./atomic.mjs";
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
