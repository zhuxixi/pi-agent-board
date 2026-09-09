/**
 * Pre-coordinator direct write for host-failure row finalization (issue #91).
 *
 * Only reachable via `AGENT_BOARD_COORDINATOR=off` — the documented escape
 * hatch. The normal path routes `host_run_failed` through the View State
 * Coordinator (`runner/state-coordinator.mjs`), whose manual_fence / stale_run
 * guards own the decision; this direct write has NO manual-completion fence,
 * which is exactly why it must stay unreachable in the default configuration.
 *
 * Lives in its own module so `runner/pty-runner.mjs` itself never imports the
 * state materializers (writer-boundary test, spec D3). `writeHost` is a
 * different artifact: host.json is owned by the pty-runner per spec D3.
 */
import { readState, writeState } from "../src/core/store.mjs";

/**
 * Legacy direct write of the view-failed row (pre-coordinator markRowFailed).
 * @param {string} root
 * @param {string} viewId
 * @param {string} message
 */
export function markRowFailedDirect(root, viewId, message) {
	const now = Date.now();
	const state = readState(root, viewId) ?? {
		version: 1,
		viewId,
		currentRunId: null,
		semanticState: "queued",
		processState: "exited",
		summary: "Queued",
		lastActivityAt: now,
		updatedAt: now,
		needsInput: false,
		hasError: false,
		latestAssistantPreview: "",
		latestTool: null,
		question: null,
		pendingQuestions: [],
		error: null,
	};
	state.semanticState = "failed";
	state.processState = "exited";
	state.summary = message;
	state.hasError = true;
	state.needsInput = false;
	state.error = message;
	state.updatedAt = now;
	state.lastActivityAt = now;
	writeState(root, state);
}
