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
 * This cache restores read-your-writes for the two fields whose only legitimate
 * transitions are "empty → non-empty" and "old non-empty → new non-empty":
 * a non-empty value is always remembered, an empty value never overwrites a
 * known non-empty one, and a disk rebuild backfills only empty fields (the
 * materialized file stays authoritative whenever it has a value).
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
		if (hasPreview) entry.latestAssistantPreview = preview;
		if (hasActivity) entry.lastAgentActivityAt = activityAt;
		known.set(viewId, entry);
	}

	function backfill(viewId, status) {
		if (!viewId || !status) return false;
		const entry = known.get(viewId);
		if (!entry) return false;
		let changed = false;
		if (entry.latestAssistantPreview && !status.latestAssistantPreview) {
			status.latestAssistantPreview = entry.latestAssistantPreview;
			changed = true;
		}
		if (entry.lastAgentActivityAt != null && status.lastAgentActivityAt == null) {
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
