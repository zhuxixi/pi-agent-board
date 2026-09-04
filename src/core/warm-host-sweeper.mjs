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
	// Both-zero = eviction disabled entirely. Callers (service.pruneWarmHosts)
	// may additionally early-return for the same reason.
	if (maxWarm === 0 && ttlMs === 0) return { ttlEvicted: [], excessEvicted: [] };
	const idle = [];
	for (const row of rows) {
		if (keepViewId != null && row.meta.id === keepViewId) continue;
		if (!row.hostAlive) continue;
		if (isAgentBusy(row)) continue;
		if ((row.host?.attachedClients ?? 0) !== 0) continue;
		const startedAt = row.host?.startedAt;
		if (graceMs > 0 && startedAt != null && now - startedAt < graceMs) continue;
		// Host-level idle counts from host start: a stale lastActivityAt from a
		// previous host incarnation must not make a freshly prewarmed host look
		// idle for longer than it has actually been up (issue #75 review #1).
		const idleSince = Math.max(row.state?.lastActivityAt ?? 0, startedAt ?? 0) || row.meta.updatedAt;
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

/**
 * Periodic sweeper for warm hosts. The interval timer is unref'd so it never
 * holds the host pi's event loop open on exit. intervalMs <= 0 disables the
 * periodic part; sweepNow() always works.
 *
 * stop() only stops the periodic timer: sweepNow() stays available afterwards
 * (the lifecycle wiring calls sweepNow() again on shutdown/dispose). start()
 * is idempotent and may restart the timer after a stop.
 * @param {{ sweep: () => void, intervalMs: number }} o
 */
export function createWarmHostSweeper({ sweep, intervalMs }) {
	let timer = null;
	return {
		active: true,
		start() {
			if (timer !== null) return;
			if (intervalMs > 0) {
				timer = setInterval(() => {
					try { sweep(); } catch { /* best-effort */ }
				}, intervalMs);
				if (typeof timer.unref === "function") timer.unref();
			}
		},
		sweepNow() {
			try { sweep(); } catch { /* best-effort */ }
		},
		stop() {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}

/**
 * Wire the sweeper to a host pi extension lifetime: sweep once on attach
 * (reclaims hosts leaked by a previous host that died without cleanup), run
 * periodically, and sweep again on session_shutdown (host pi exiting or the
 * extension instance being reloaded for a session switch).
 *
 * Child pi processes (AGENT_BOARD_CHILD=1 / AGENT_VIEW_CHILD=1) must never
 * sweep: they share the same board root and would terminate their own runner
 * (suicide chain). They get a strict no-op.
 *
 * @param {{ on?: (event: any, fn: () => void) => any }} pi — any, not a narrower
 *   string-keyed signature: pi's ExtensionAPI.on is a union of literal event-name
 *   overloads and would otherwise fail structural assignment from TypeScript
 *   callers (contravariant parameter check).
 * @param {{ isHostedChild: boolean, sweep: () => void, intervalMs: number }} o
 */
export function attachWarmHostSweeper(pi, { isHostedChild, sweep, intervalMs }) {
	// Child pi processes and board-spawned non-host workers must never sweep:
	// children would terminate their own runner (suicide chain); workers
	// (job/state runners set AGENT_BOARD_NO_SWEEP=1) would churn the shared root.
	if (isHostedChild || process.env.AGENT_BOARD_NO_SWEEP === "1") {
		return { active: false, dispose() {} };
	}
	const sweeper = createWarmHostSweeper({ sweep, intervalMs });
	let shutdown = false;
	const onShutdown = () => {
		if (shutdown) return;
		shutdown = true;
		sweeper.sweepNow();
		sweeper.stop();
	};
	pi.on?.("session_shutdown", onShutdown);
	sweeper.start();
	sweeper.sweepNow(); // 回收上一个宿主（可能非正常退出）遗留的 warm hosts
	return {
		active: true,
		dispose() {
			onShutdown();
		},
	};
}
