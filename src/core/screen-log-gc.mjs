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
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { readJson } from "./atomic.mjs";
import * as P from "./paths.mjs";

export const DEFAULT_SCREEN_LOG_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize the `screenLogRetentionDays` pref.
 * @param {unknown} value
 * @returns {number|null} days, or null when GC is disabled (pref = 0)
 */
export function normalizeRetentionDays(value) {
	if (value === 0 || value === "0") return null;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_SCREEN_LOG_RETENTION_DAYS;
	return Math.floor(n);
}

/**
 * Normalize the `screenLogMaxSize` pref.
 * @param {unknown} value
 * @returns {number|null} bytes, or null to keep the runner's built-in default
 */
export function normalizeScreenLogMaxBytes(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Delete screen.log of ended views older than the retention window.
 * Best-effort: a per-file failure is counted and skipped, never thrown.
 * @param {string} root
 * @param {{ retentionDays?: number|null, now?: number }} [opts]
 * @returns {{ scanned: number, removed: number, skippedActive: number, skippedFresh: number, bytesReclaimed: number, errors: number }}
 */
export function pruneScreenLogs(root, opts = {}) {
	const stats = { scanned: 0, removed: 0, skippedActive: 0, skippedFresh: 0, bytesReclaimed: 0, errors: 0 };
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
		const basis = ageBasisMs(root, entry.name, logFile);
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
		} catch {
			stats.errors++;
		}
	}
	return stats;
}

/**
 * Age basis for one view's log: host endedAt when known, else the log's mtime.
 * @param {string} root @param {string} viewId @param {string} logFile
 * @returns {number|null|"active"} epoch ms, "active" for live views, null when unknown
 */
function ageBasisMs(root, viewId, logFile) {
	const host = readJson(P.hostPath(root, viewId), null);
	if (host && host.endedAt == null && (host.state === "alive" || host.state === "starting")) return "active";
	if (host && Number.isFinite(host.endedAt)) return host.endedAt;
	try {
		return statSync(logFile).mtimeMs;
	} catch {
		return null;
	}
}
