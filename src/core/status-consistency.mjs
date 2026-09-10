/**
 * Reader-side revision consistency for the (state.json, status.json) pair
 * (issue #91, spec D3 — 根治条件 5 read side).
 *
 * The View State Coordinator materializes both artifacts under one shared
 * `materializedRevision` inside a single view lock. Disagreeing stamps
 * therefore mean a coordinator crashed between its paired writes; readers
 * must not combine the mismatched halves into one decision — skip the
 * combination and request coordinator repair (a fresh coordinator's boot
 * replay re-materializes the half-written pair from the journal).
 *
 * Legacy rows (written before revisions existed, or never touched by a
 * command) may lack the field on either side; per the spec's legacy-migration
 * clause the check is skipped for them — a missing stamp is never a desync.
 */
import { readState as readStateImpl, readStatus as readStatusImpl } from "./store.mjs";

/**
 * Whether the (state, status) pair is revision-desynced and must not be
 * combined into one decision.
 * @param {{ materializedRevision?: number|null }|null|undefined} state ViewState as read from state.json.
 * @param {{ materializedRevision?: number|null }|null|undefined} status RunStatus as read from status.json.
 * @returns {boolean}
 */
export function statusRevisionDesynced(state, status) {
	if (state?.materializedRevision == null || status?.materializedRevision == null) return false;
	return state.materializedRevision !== status.materializedRevision;
}

/**
 * Re-read BOTH halves of the pair fresh and re-check the desync verdict.
 *
 * TOCTOU guard for long-lived readers (reconcile iterates a listRows snapshot;
 * earlier rows' awaited commands let the on-disk pair advance past it): a
 * suspicion raised against the snapshot must be confirmed against fresh reads
 * before acting on it. Under the coordinator's view-lock pairing invariant
 * both files move together, so a fresh consistent pair clears the suspicion;
 * the residual window between the two fresh reads is sub-ms.
 *
 * @param {string} root
 * @param {string} viewId
 * @param {string|null} runId
 * @param {{ readState?: typeof readStateImpl, readStatus?: typeof readStatusImpl }} [readers] injection for tests.
 * @returns {{ state: object|null, status: object|null, desynced: boolean }}
 */
export function rereadPair(root, viewId, runId, readers = {}) {
	const readState = readers.readState ?? readStateImpl;
	const readStatus = readers.readStatus ?? readStatusImpl;
	const state = readState(root, viewId);
	const status = readStatus(root, viewId, runId);
	return { state, status, desynced: statusRevisionDesynced(state, status) };
}

/**
 * Per-view episode throttle for desync reporting (issue #111 CR r1).
 *
 * A desync is a persistent CONDITION, not a one-shot event: reconcile runs on
 * every dashboard poll (~700ms), and for unrepairable pairs (a torn transient
 * beat has no journal record; or the coordinator is off) the condition never
 * clears. Logging unthrottled would grow diagnostics.jsonl without bound.
 * The throttle logs each distinct (stateRev:statusRev) pair once per viewer;
 * a changed pair (progression, or a fresh crash at new revisions) logs again,
 * and a repaired pair simply stops firing — no reset bookkeeping needed.
 *
 * Kick-retry tracking (issue #111 CR r2): a failed repair kick must not
 * consume the recovery path — an idle dashboard would otherwise never run
 * boot replay for a repairable pair. `markKickFailed`/`shouldRetryKick`
 * track that independently of the diagnostic episode, so retries stay
 * unbounded while the kick keeps failing while diagnostics stay once per
 * episode. A successful kick clears the flag (the coordinator is up: boot
 * replay already repaired a repairable pair; an unrepairable-torn pair
 * gains nothing from re-kicking).
 *
 * @returns {{ shouldLog(viewId: string, stateRevision: number|null, statusRevision: number|null): boolean, markKickFailed(viewId: string): void, shouldRetryKick(viewId: string): boolean, clearKickFailed(viewId: string): void }}
 */
export function createDesyncEpisodeThrottle() {
	/** @type {Map<string, string>} */
	const lastLogged = new Map();
	/** @type {Set<string>} */
	const kickFailed = new Set();
	return {
		shouldLog(viewId, stateRevision, statusRevision) {
			const pair = `${stateRevision ?? "null"}:${statusRevision ?? "null"}`;
			if (lastLogged.get(viewId) === pair) return false;
			lastLogged.set(viewId, pair);
			return true;
		},
		markKickFailed(viewId) {
			kickFailed.add(viewId);
		},
		shouldRetryKick(viewId) {
			return kickFailed.has(viewId);
		},
		clearKickFailed(viewId) {
			kickFailed.delete(viewId);
		},
	};
}
