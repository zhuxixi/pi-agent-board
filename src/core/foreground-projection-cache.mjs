/**
 * Process-local read-your-writes cache for foreground status projections
 * (issue #225).
 *
 * `syncRowEvent` rebuilds its status from `state.json` on every event, while
 * `writeForegroundState` is fire-and-forget: two events can have two
 * `sync_foreground` commands in flight, and an older projection can materialize
 * last. Because the rebuilt status carries no freshness signal, the next event
 * reduces onto the stale state and writes it back — a cleared question comes
 * back as `needs_input` until a terminal event lands.
 *
 * This cache stores the freshest whitelisted status fields with a strictly
 * increasing per-view stamp (`nextStamp`), so a disk rebuild that is older than
 * the last write is corrected before the new event is reduced.
 *
 * Module-level by necessity: `serviceFor()` creates a new service instance per
 * call (src/index.ts), so a per-instance cache would be discarded between
 * events.
 */

/** Fields a cached snapshot may restore on a stale rebuild. */
const CACHED_FIELDS = [
	"semanticState",
	"processState",
	"summary",
	"currentTool",
	"question",
	"pendingQuestions",
	"error",
	"lastActivityAt",
	"latestAssistantPreview",
	"lastAgentActivityAt",
];

/** @param {any} value */
function cloneValue(value) {
	if (value === null || typeof value !== "object") return value;
	return JSON.parse(JSON.stringify(value));
}

/** @param {any} status */
function snapshot(status) {
	/** @type {Record<string, unknown>} */
	const fields = {};
	for (const key of CACHED_FIELDS) fields[key] = cloneValue(status?.[key]);
	return fields;
}

export function createForegroundProjectionCache() {
	/** @type {Map<string, { stamp: number, fields: Record<string, unknown> }>} */
	const known = new Map();
	/** @type {Map<string, number>} */
	const stamps = new Map();

	function nextStamp(viewId) {
		const stamp = Math.max(Date.now(), (stamps.get(viewId) ?? 0) + 1);
		stamps.set(viewId, stamp);
		return stamp;
	}

	function remember(viewId, status, stamp) {
		if (!viewId || !status || typeof stamp !== "number" || !Number.isFinite(stamp)) return;
		known.set(viewId, { stamp, fields: snapshot(status) });
	}

	function adopt(viewId, status) {
		if (!viewId || !status) return false;
		const entry = known.get(viewId);
		if (!entry) return false;
		const at = typeof status.updatedAt === "number" ? status.updatedAt : 0;
		if (entry.stamp <= at) return false;
		for (const key of CACHED_FIELDS) status[key] = cloneValue(entry.fields[key]);
		status.updatedAt = entry.stamp;
		return true;
	}

	function forget(viewId) {
		stamps.delete(viewId);
		return known.delete(viewId);
	}

	function clear() {
		known.clear();
		stamps.clear();
	}

	function size() {
		return known.size;
	}

	return { nextStamp, remember, adopt, forget, clear, size };
}

/**
 * Shared cache used by the runtime service (module-level: see module doc).
 * Keyed by view id only, matching the preview cache: production view ids are generated
 * and never reused, and tests clear the cache per case.
 */
export const foregroundProjectionCache = createForegroundProjectionCache();
