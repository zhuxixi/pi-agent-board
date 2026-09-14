/**
 * Process-local read-your-writes cache for foreground state projections
 * (issue #113).
 *
 * Foreground turns are mirrored into state.json through the detached View
 * State Coordinator: `message_end` sets `latestAssistantPreview` /
 * `lastAgentActivityAt` and fires a fire-and-forget `sync_foreground` command;
 * the coordinator journals + fsyncs before materializing the file. The next
 * event (`agent_end`, ~7ms later) rebuilds its in-memory status from the
 * still-stale state.json, derives the "Needs instructions" fallback summary and
 * overwrites the fresher projection that was still in flight.
 *
 * This cache restores read-your-writes for the two fields whose legitimate
 * transitions are "empty → non-empty" and "old non-empty → new non-empty",
 * keyed on `lastAgentActivityAt` as the freshness signal (message_end stamps
 * it with `now`):
 *
 * - `remember` keeps the strictly-freshest projection: an entry whose
 *   timestamp is older than the stored one never degrades it (the stale
 *   agent_end rebuild must not clobber a newer in-flight message_end value);
 *   an older or timestampless projection only fills gaps.
 * - `backfill` adopts BOTH cached fields when the cached timestamp is strictly
 *   newer than the rebuilt status's (including a timestampless/legacy
 *   rebuild) — the disk snapshot is stale. Otherwise it fills only empty
 *   fields: the materialized file stays authoritative when it is newer or
 *   equally aged, so a value another writer persisted is never resurrected
 *   over by an older cached one.
 *
 * Module-level by necessity: `serviceFor()` creates a new service instance per
 * call (src/index.ts), so a per-instance cache would be discarded between
 * events.
 */

/** @typedef {{ latestAssistantPreview: string, lastAgentActivityAt: number|null }} KnownForegroundFields */

/**
 * @returns {{
 *   remember: (viewId: string, projection: { latestAssistantPreview?: unknown, lastAgentActivityAt?: unknown }) => void,
 *   backfill: (viewId: string, status: { latestAssistantPreview?: unknown, lastAgentActivityAt?: unknown }) => boolean,
 *   forget: (viewId: string) => boolean,
 *   clear: () => void,
 *   size: () => number,
 * }}
 */
export function createForegroundPreviewCache() {
	/** @type {Map<string, KnownForegroundFields>} */
	const known = new Map();

	function remember(viewId, projection) {
		if (!viewId || !projection) return;
		const preview = projection.latestAssistantPreview;
		const activityAt = projection.lastAgentActivityAt;
		const hasPreview = typeof preview === "string" && preview.length > 0;
		const hasActivity = activityAt != null;
		if (!hasPreview && !hasActivity) return;
		const entry = known.get(viewId) ?? { latestAssistantPreview: "", lastAgentActivityAt: null };
		const isNewer = hasActivity && (entry.lastAgentActivityAt == null || activityAt > entry.lastAgentActivityAt);
		if (isNewer) {
			// A strictly fresher projection wins wholesale; an empty preview still
			// never overwrites a known non-empty one.
			if (hasPreview) entry.latestAssistantPreview = preview;
			entry.lastAgentActivityAt = activityAt;
		} else {
			// Older or timestampless: gap-fill only, never degrade the entry.
			if (hasPreview && !entry.latestAssistantPreview) entry.latestAssistantPreview = preview;
			if (hasActivity && entry.lastAgentActivityAt == null) entry.lastAgentActivityAt = activityAt;
		}
		known.set(viewId, entry);
	}

	function backfill(viewId, status) {
		if (!viewId || !status) return false;
		const entry = known.get(viewId);
		if (!entry) return false;
		const statusAt = status.lastAgentActivityAt ?? null;
		let changed = false;
		if (entry.lastAgentActivityAt != null && (statusAt == null || entry.lastAgentActivityAt > statusAt)) {
			// The disk rebuild is a stale snapshot (or a timestampless legacy row):
			// the freshest value this process projected wins wholesale.
			if (entry.latestAssistantPreview && status.latestAssistantPreview !== entry.latestAssistantPreview) {
				status.latestAssistantPreview = entry.latestAssistantPreview;
				changed = true;
			}
			if (statusAt !== entry.lastAgentActivityAt) {
				status.lastAgentActivityAt = entry.lastAgentActivityAt;
				changed = true;
			}
			return changed;
		}
		if (entry.latestAssistantPreview && !status.latestAssistantPreview) {
			status.latestAssistantPreview = entry.latestAssistantPreview;
			changed = true;
		}
		if (entry.lastAgentActivityAt != null && statusAt == null) {
			status.lastAgentActivityAt = entry.lastAgentActivityAt;
			changed = true;
		}
		return changed;
	}

	function forget(viewId) {
		return known.delete(viewId);
	}

	function clear() {
		known.clear();
	}

	function size() {
		return known.size;
	}

	return { remember, backfill, forget, clear, size };
}

/** Shared cache used by the runtime service (module-level: see module doc). */
export const foregroundPreviewCache = createForegroundPreviewCache();
