/**
 * Persistent cwd usage stats for the launch dialog's directory favorites.
 *
 * Counts every successfully dispatched session per cwd, independent of the
 * view lifecycle (deleting a view does not decrement). The dashboard reads
 * the ranked list for the cwd picker's favorites mode. Pure node, no Pi imports.
 */
import { existsSync } from "node:fs";
import * as os from "node:os";
import { atomicWriteJson, readJson } from "./atomic.mjs";
import * as P from "./paths.mjs";
import { readMeta, readRoster } from "./store.mjs";

/**
 * @typedef {Object} CwdStatsEntry
 * @property {number} count
 * @property {number} lastUsed  epoch ms, like meta.updatedAt
 */

/** @returns {{version: number, entries: Record<string, CwdStatsEntry>}} */
function emptyStats() {
	return { version: 1, entries: {} };
}

/** @param {string} root @returns {{version: number, entries: Record<string, CwdStatsEntry>}} */
export function readCwdStats(root) {
	const raw = readJson(P.cwdStatsPath(root), null);
	if (!raw || typeof raw !== "object" || typeof raw.entries !== "object" || raw.entries === null) return emptyStats();
	/** @type {Record<string, CwdStatsEntry>} */
	const entries = {};
	for (const [dir, entry] of Object.entries(raw.entries)) {
		if (!entry || typeof entry.count !== "number") continue;
		entries[dir] = {
			count: Math.max(0, Math.floor(entry.count)),
			lastUsed: typeof entry.lastUsed === "number" ? entry.lastUsed : 0,
		};
	}
	return { version: 1, entries };
}

/**
 * One-time seed: aggregate cwd counts from every roster view's meta.json.
 * No-op when cwd-stats.json already exists.
 * @param {string} root
 */
export function seedCwdStatsFromViews(root) {
	if (existsSync(P.cwdStatsPath(root))) return;
	/** @type {Record<string, CwdStatsEntry>} */
	const entries = {};
	for (const viewId of readRoster(root).views ?? []) {
		const meta = readMeta(root, viewId);
		const cwd = meta?.cwd;
		if (!cwd) continue;
		const lastUsed = typeof meta.updatedAt === "number" ? meta.updatedAt : Date.now();
		const existing = entries[cwd];
		if (existing) {
			existing.count += 1;
			existing.lastUsed = Math.max(existing.lastUsed, lastUsed);
		} else {
			entries[cwd] = { count: 1, lastUsed };
		}
	}
	atomicWriteJson(P.cwdStatsPath(root), { version: 1, entries });
}

/**
 * Seed when the stats file is missing; tolerate every failure (dashboard UX
 * must never break because of stats bookkeeping).
 * @param {string} root
 */
export function ensureCwdStatsSeeded(root) {
	if (existsSync(P.cwdStatsPath(root))) return;
	try {
		seedCwdStatsFromViews(root);
	} catch {
		/* best effort */
	}
}

/**
 * Record one successful dispatch for `cwd`. Invalid dirs are ignored.
 * @param {string} root @param {string} cwd
 */
export function recordCwdLaunch(root, cwd) {
	if (!cwd || !existsSync(cwd)) return;
	const stats = readCwdStats(root);
	const existing = stats.entries[cwd] ?? { count: 0, lastUsed: 0 };
	stats.entries[cwd] = { count: existing.count + 1, lastUsed: Date.now() };
	atomicWriteJson(P.cwdStatsPath(root), stats);
}

/**
 * Ranked candidates: count desc, then lastUsed desc; home appended at the
 * end when absent so the user's home dir is always one keystroke away.
 * @param {string} root @param {number=} limit
 * @returns {Array<{path: string, count: number}>}
 */
export function rankedCwdCandidates(root, limit = 8) {
	const stats = readCwdStats(root);
	const rows = Object.entries(stats.entries).map(([dir, entry]) => ({
		path: dir,
		count: entry.count,
		lastUsed: entry.lastUsed,
	}));
	rows.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);
	const out = rows.map(({ path, count }) => ({ path, count }));
	const home = os.homedir();
	if (!out.some((entry) => entry.path === home)) out.push({ path: home, count: 0 });
	return out.slice(0, Math.max(1, limit));
}
