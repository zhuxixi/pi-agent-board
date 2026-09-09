/**
 * Pre-coordinator direct-write helpers for job-runner (issue #91, PR #2).
 *
 * The View State Coordinator is the single logical writer of state.json /
 * status.json. The ONLY legitimate direct-write path left in the JSON runner
 * is the explicit `AGENT_BOARD_COORDINATOR=off` escape hatch (a documented
 * designed exception in the writer-boundary test): a user who switches the
 * coordinator off keeps the exact pre-coordinator persistence semantics.
 *
 * This module exists so `runner/job-runner.mjs` itself never imports the
 * state materializers — the boundary test allowlists THIS file (disabled
 * escape hatch), not the runner.
 */
import { projectViewState } from "../src/core/events.mjs";
import { readState, writeState, writeStatus } from "../src/core/store.mjs";

/**
 * Direct-write the run status and its projected view state (the boot +
 * throttled-persist tail of the pre-coordinator persist, minus the evidence
 * artifacts which stay runner-owned in both modes).
 * @param {{ root: string, viewId: string, runId: string, status: object }} ctx
 */
export function legacyPersistState({ root, viewId, runId, status }) {
	void runId;
	writeStatus(root, status);
	writeState(root, projectViewState(status, Date.now(), readState(root, viewId)));
}

/** @param {string} root @param {string} viewId @param {string} runId @param {object} status */
export function legacyWriteStatus(root, viewId, runId, status) {
	void viewId;
	void runId;
	writeStatus(root, status);
}

/** @param {string} root @param {string} viewId @param {object} state */
export function legacyWriteState(root, viewId, state) {
	void viewId;
	writeState(root, state);
}

/**
 * Direct-write the plan-ready row state ("Approve this plan?") — exact legacy
 * parity with the pre-coordinator finalizeSteeringIfNeeded write.
 * @param {string} root @param {string} viewId @param {string} runId
 */
export function legacyPlanReadyStateWrite(root, viewId, runId) {
	const prev = readState(root, viewId);
	if (!prev) return;
	prev.semanticState = "needs_input";
	prev.processState = "exited";
	prev.needsInput = true;
	prev.question = "Approve this plan?";
	prev.summary = "Plan ready for approval";
	prev.currentRunId = runId;
	prev.updatedAt = Date.now();
	writeState(root, prev);
}

/**
 * Direct-write the queued follow-up's bootstrap status + projected state —
 * exact legacy parity with drainQueuedFollowUp.
 * @param {string} root @param {string} viewId @param {object} nextStatus
 */
export function legacyFollowupBootstrap(root, viewId, nextStatus) {
	writeStatus(root, nextStatus);
	writeState(root, projectViewState(nextStatus, Date.now(), readState(root, viewId)));
}
