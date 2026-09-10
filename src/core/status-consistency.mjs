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
