/**
 * Startup GC for per-view PTY replay logs.
 *
 * screen.log write-path growth is already bounded by screen-log.mjs (cap + tail
 * compaction inside pty-runner). This module reclaims the other half: logs of
 * views whose session ENDED long ago — no runner will ever touch them again,
 * so without a sweep they sit on disk forever.
 *
 * Safety rules:
 * - Only screen.log is removed; meta/state/evidence stay so the dashboard row survives.
 * - Views with a live host (state alive/starting, endedAt null) are never touched:
 *   pty-runner holds an in-memory byte counter for its log and external mutation
 *   would race with it. Live logs are bounded by the runner's own cap.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { readJson } from "./atomic.mjs";
import * as P from "./paths.mjs";
import { isAlive } from "./pid.mjs";

export const DEFAULT_SCREEN_LOG_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A live pty-runner heartbeat-persists host.json every second, and a booting runner
 * persists state "starting" before the service's own writeHost lands. A host.json
 * modified within this window therefore means a runner is live or mid-launch.
 */
const HOST_FRESH_GRACE_MS = 10_000;

/**
 * An "alive"/"starting" claim older than this is not trusted: heartbeat-persisted
 * lastSeenAt goes stale when a runner dies, and a dead pid can later be recycled by
 * an unrelated process — pid liveness alone must not exempt a view forever.
 */
const ALIVE_CLAIM_MAX_AGE_MS = 3 * DAY_MS;

/**
 * Shared input gate for the prefs normalizers: only finite numbers and non-blank
 * numeric strings are meaningful. Anything else (booleans, arrays, "", "  ",
 * objects) is a hand-edit accident, not a value.
 * @param {unknown} value
 * @returns {number|null} the coerced finite number, or null when not usable
 */
function coerceUsableNumber(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/**
 * Normalize the `screenLogRetentionDays` pref.
 * @param {unknown} value
 * @returns {number|null} days, or null when GC is disabled (pref = 0)
 */
export function normalizeRetentionDays(value) {
	const n = coerceUsableNumber(value);
	if (n === null || n < 0) return DEFAULT_SCREEN_LOG_RETENTION_DAYS;
	const days = Math.floor(n);
	// Anything flooring to 0 (0, "0", "0.0", fractions in (0,1)) means "disabled".
	// A 0-day retention would otherwise compute cutoff=now and delete EVERY ended log.
	return days === 0 ? null : days;
}

/**
 * Normalize the `screenLogMaxSize` pref.
 * @param {unknown} value
 * @returns {number|null} bytes, or null to keep the runner's built-in default
 */
export function normalizeScreenLogMaxBytes(value) {
	const n = coerceUsableNumber(value);
	if (n === null) return null;
	const bytes = Math.floor(n);
	return bytes > 0 ? bytes : null;
}

/**
 * Delete screen.log of ended views older than the retention window.
 * Best-effort: a per-file failure is counted and skipped, never thrown.
 * @param {string} root
 * @param {{ retentionDays?: number|null, now?: number }} [opts]
 * @returns {{ scanned: number, removed: number, skippedActive: number, skippedFresh: number, skippedForeign: number, bytesReclaimed: number, errors: number }}
 */
export function pruneScreenLogs(root, opts = {}) {
	const stats = { scanned: 0, removed: 0, skippedActive: 0, skippedFresh: 0, skippedForeign: 0, bytesReclaimed: 0, errors: 0 };
	const retentionDays = normalizeRetentionDays(opts.retentionDays);
	if (retentionDays === null) return stats;
	const now = Number.isFinite(opts.now) ? opts.now : Date.now();
	const cutoff = now - retentionDays * DAY_MS;
	/** @type {import("node:fs").Dirent[]} */
	let entries;
	try {
		entries = readdirSync(P.viewsDir(root), { withFileTypes: true });
	} catch {
		return stats; // no views dir yet — nothing to do
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!isViewDir(root, entry.name)) {
			// Foreign dirs must never lose a file; count the ones holding a screen.log
			// so the skip is visible in stats.
			try {
				if (statSync(P.screenLogPath(root, entry.name)).size > 0) stats.skippedForeign++;
			} catch {}
			continue;
		}
		const logFile = P.screenLogPath(root, entry.name);
		/** @type {number} */
		let size;
		try {
			size = statSync(logFile).size;
		} catch {
			continue; // no screen.log (job-runner views never have one)
		}
		if (size <= 0) continue;
		stats.scanned++;
		const basis = ageBasisMs(root, entry.name, logFile, now);
		if (basis === "active") {
			stats.skippedActive++;
			continue;
		}
		if (basis === null || basis > cutoff) {
			stats.skippedFresh++;
			continue;
		}
		try {
			unlinkSync(logFile);
			stats.removed++;
			stats.bytesReclaimed += size;
		} catch (err) {
			// A concurrent sweep (a second dashboard sharing the root) may have won the
			// unlink after our stat: the reclaim goal is achieved — count it as removed
			// (without the bytes, which the winner already accounted for), not an error.
			if (err && err.code === "ENOENT") stats.removed++;
			else stats.errors++;
		}
	}
	return stats;
}

/**
 * Age basis for one view's log: host endedAt when known, else the log's mtime.
 * @param {string} root @param {string} viewId @param {string} logFile @param {number} now
 * @returns {number|null|"active"} epoch ms, "active" for live views, null when unknown
 */
function ageBasisMs(root, viewId, logFile, now) {
	const hostFile = P.hostPath(root, viewId);
	const host = readJson(hostFile, null);
	if (host) {
		// Fresh host.json = a runner is heartbeating or mid-launch. Checking mtime first
		// closes the launch TOCTOU window (runner boots and opens the log before the
		// service's writeHost records "starting"): a stale read can never delete the
		// log of a runner that just started.
		try {
			if (now - statSync(hostFile).mtimeMs < HOST_FRESH_GRACE_MS) return "active";
		} catch {}
		if (host.endedAt == null && (host.state === "alive" || host.state === "starting")) {
			// A runner killed by SIGKILL/OOM leaves state "alive" on disk forever, and its
			// pid may later be recycled by an unrelated long-lived process (isAlive also
			// treats EPERM as alive). Trust the claim only when the heartbeat refreshed
			// lastSeenAt recently AND the pid is actually alive.
			const claimFresh = Number.isFinite(host.lastSeenAt) && now - host.lastSeenAt < ALIVE_CLAIM_MAX_AGE_MS;
			if (claimFresh && Number.isInteger(host.runnerPid) && isAlive(host.runnerPid)) return "active";
		}
		if (Number.isFinite(host.endedAt)) return host.endedAt;
	}
	try {
		return statSync(logFile).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * A sweep-eligible directory is a real view: it carries meta.json, or — when
 * meta.json was externally deleted — a host.json that is parseable AND names this
 * directory as its view. A stray/garbage host.json in a foreign directory must not
 * make that directory's screen.log a deletion candidate.
 * @param {string} root @param {string} viewId
 */
function isViewDir(root, viewId) {
	if (existsSync(P.metaPath(root, viewId))) return true;
	const host = readJson(P.hostPath(root, viewId), null);
	return Boolean(host && host.viewId === viewId);
}
