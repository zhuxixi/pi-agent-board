/**
 * Warm-host sweep reclaim (issue #75).
 *
 * Idle PTY hosts must not live forever: after detach the runner is a detached
 * orphan that nothing else will reap (Windows has no parent-death cascade, and
 * the dashboard host may exit without a cleanup hook). The design intent
 * (AGENT_BOARD_WARM_HOST_TTL_MS / MAX_WARM_HOSTS) already exists in
 * service.mjs pruneWarmHosts but only fires lazily on attach/prewarm/dispatch.
 * This module extracts the pure eviction decision plus a periodic sweeper so
 * the TTL actually runs.
 */

/** @param {import("./store.mjs").Row} row */
export function hasPendingQuestions(row) {
	return Array.isArray(row.state?.pendingQuestions) && row.state.pendingQuestions.length > 0;
}

/**
 * Busy = an agent run is active (queued/working) or the session is waiting on
 * user questions. Idle/completed/failed/stopped are never busy.
 * @param {import("./store.mjs").Row} row
 */
export function isAgentBusy(row) {
	const st = row.state?.semanticState;
	return Boolean(row.alive && (st === "queued" || st === "working" || hasPendingQuestions(row)));
}

/**
 * Pure eviction decision for warm PTY hosts. No IO, no env: every threshold is
 * passed in so the logic is directly unit-testable.
 *
 * idle = host alive && !busy && no attached clients && not keepViewId.
 * graceMs exempts freshly started hosts (attach handoff race: ensureHost has
 * started a host but the client has not connected yet).
 * TTL eviction runs first; survivors over maxWarm are evicted oldest-first by
 * idleSince (state.lastActivityAt ?? host.startedAt ?? meta.updatedAt).
 *
 * @param {Array<import("./store.mjs").Row>} rows
 * @param {{ now: number, maxWarm: number, ttlMs: number, graceMs?: number, keepViewId?: string|null }} o
 * @returns {{ ttlEvicted: string[], excessEvicted: string[] }} viewIds, ttl group first
 */
export function selectIdleHostsToEvict(rows, { now, maxWarm, ttlMs, graceMs = 0, keepViewId = null }) {
	const idle = [];
	for (const row of rows) {
		if (keepViewId != null && row.meta.id === keepViewId) continue;
		if (!row.hostAlive) continue;
		if (isAgentBusy(row)) continue;
		if ((row.host?.attachedClients ?? 0) !== 0) continue;
		const startedAt = row.host?.startedAt;
		if (graceMs > 0 && startedAt != null && now - startedAt < graceMs) continue;
		const idleSince = row.state?.lastActivityAt ?? startedAt ?? row.meta.updatedAt;
		idle.push({ id: row.meta.id, idleSince });
	}
	const ttlEvicted = [];
	const survivors = [];
	for (const it of idle) {
		// Keep the historical semantics: ttlMs === 0 disables the ttl branch
		// (only the maxWarm cap applies); both zero disables eviction entirely.
		if (ttlMs > 0 && now - it.idleSince > ttlMs) ttlEvicted.push(it.id);
		else survivors.push(it);
	}
	survivors.sort((a, b) => a.idleSince - b.idleSince);
	const excess = Math.max(0, survivors.length - maxWarm);
	return { ttlEvicted, excessEvicted: survivors.slice(0, excess).map((it) => it.id) };
}
