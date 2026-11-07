// Issue #284 T3/T4: attach recovery component harness (injected clock).
// The component uses TS parameter properties, so the real harness runs in a
// transform-types child process (same seam as the parser-replacement suite).
// The scenario accepts a JSON step program and reports a readout per step;
// every deadline boundary below is asserted on the injected virtual clock.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = resolve(REPO_ROOT, "test-support/attach-recovery-scenario.ts");

function runScenario(program) {
	const result = spawnSync(process.execPath, ["--experimental-transform-types", SCENARIO, JSON.stringify(program)], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 60_000,
	});
	const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).at(-1);
	const parsed = line ? JSON.parse(line) : null;
	return { status: result.status, parsed, stderr: result.stderr ?? "" };
}

function readouts(parsed) {
	assert.ok(parsed, "scenario produced no result line");
	return parsed.steps.map((step) => step.readout);
}

function assertScenarioOk(name, run) {
	assert.equal(run.status, 0, `${name}: scenario failed: ${run.stderr.slice(-2000)}`);
	assert.equal(run.parsed.ok, true, `${name}: ${JSON.stringify(run.parsed, null, 2)}`);
}

test("T3 smoke: injected clock keeps legacy settle at the ATTACH_SETTLE_MS boundary", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "mode", value: "legacy" },
			{ op: "advance", ms: 249 },
			{ op: "advance", ms: 1 },
		],
	});
	assertScenarioOk("smoke", run);
	const [afterConnect, afterLegacy, at249, at250] = readouts(run.parsed);
	assert.equal(afterConnect.attaching, true, "attach wait starts");
	assert.equal(afterLegacy.timers.settlePending, true, "legacy mode re-arms the settle deadline");
	assert.equal(afterLegacy.timers.settleDeadline, 250, "legacy settle is scheduled from attachStartedAt on the injected clock");
	assert.equal(at249.attaching, true, "249ms of virtual time must not settle");
	assert.equal(at249.timers.settlePending, true);
	assert.equal(at250.attaching, false, "settle fires at exactly the injected 250ms boundary");
	assert.equal(at250.settledAt, 250);
	// No wall-clock bound here (review fix): the virtual-time boundary
	// assertions above already prove the deadline math runs on the injected
	// clock, and a wallMs threshold only added loaded-machine flake.
});

test("T3 primitives: real snapshot/capability path commits a view and reports proof facts", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "PRIMITIVE SCREEN" },
		],
	});
	assertScenarioOk("primitives", run);
	const [afterConnect, afterHello, afterSnapshot] = readouts(run.parsed);
	assert.equal(afterConnect.identity.connectionToken, 1);
	assert.equal(afterHello.frameWitnessAvailable, true, "hello status enables the witness capability");
	assert.equal(afterHello.attachMode, "undecided", "mode is decided by the protocol, not the status line");
	assert.equal(afterSnapshot.attachMode, "protocol", "snapshot_begin decides protocol mode");
	assert.equal(afterSnapshot.frameWitnessAvailable, true);
	assert.equal(afterSnapshot.committedView.present, true, "committed frame hydrates and commits");
	assert.equal(afterSnapshot.committedView.connectionToken, 1);
	assert.equal(afterSnapshot.committedView.generation, "gen-1");
	assert.equal(afterSnapshot.committedViewValid, true);
	assert.equal(afterSnapshot.latestViewProof.status, "unavailable");
	assert.equal(afterSnapshot.latestViewProof.reason, "candidate-open");
	assert.equal(afterSnapshot.lastSeq, 1);
	assert.equal(afterSnapshot.attaching, true, "a candidate-open proof never settles the wait on its own");
});

test("T3 primitives: S/A records drive the real noteViewProofRecord path", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "none", preset: "committed", text: "RECORD SCREEN" },
			{ op: "record", marker: "S", seq: 1, frameId: 1 },
			{ op: "record", marker: "A", seq: 1, frameId: 1 },
		],
	});
	assertScenarioOk("records", run);
	const readoutsAll = readouts(run.parsed);
	const [afterSnapshot, afterS, afterA] = readoutsAll.slice(2);
	assert.equal(afterSnapshot.latestViewProof, null, "a proof-less snapshot leaves no proof facts");
	assert.equal(afterS.latestViewProof.status, "unknown");
	assert.equal(afterS.latestViewProof.reason, "candidate-open", "live S record drives noteViewProofRecord");
	assert.equal(afterS.viewProofRecordCount, 1);
	assert.equal(afterA.latestViewProof.status, "unknown");
	assert.equal(afterA.latestViewProof.reason, "candidate-aborted", "live A record drives noteViewProofRecord");
	assert.equal(afterA.viewProofRecordCount, 2);
});

test("T3 primitives: geometry change advances the revision and invalidates the committed view", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "GEOMETRY SCREEN" },
			{ op: "geometry", cols: 100, rows: 30 },
		],
	});
	assertScenarioOk("geometry", run);
	const [afterSnapshot, afterGeometry] = readouts(run.parsed).slice(2);
	assert.equal(afterSnapshot.identity.geometryRevision, 0);
	assert.equal(afterSnapshot.committedViewValid, true);
	assert.equal(afterGeometry.identity.geometryRevision, 1, "a differing-size render records exactly one intent");
	assert.equal(afterGeometry.identity.resizeIntentRequired, true);
	assert.equal(afterGeometry.committedViewValid, false, "the old-geometry committed view fails the identity fence");
});

test("T4 a) quiet protocol+witness: 249ms still attaching, 250ms records the budget fact", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "QUIET SCREEN" },
			{ op: "advance", ms: 249 },
			{ op: "advance", ms: 1 },
		],
	});
	assertScenarioOk("quiet", run);
	const [afterSnapshot, at249, at250] = readouts(run.parsed).slice(2);
	assert.equal(afterSnapshot.attaching, true);
	assert.equal(afterSnapshot.timers.settlePending, false, "protocol+witness cancels the legacy settle timer");
	assert.equal(afterSnapshot.budget.timerPending, true);
	assert.equal(afterSnapshot.budget.deadline, 250, "budget is armed once at attach start: start+250");
	assert.equal(at249.attaching, true, "249ms must not publish or record the budget fact");
	assert.equal(at249.budget.elapsed, false);
	assert.equal(at249.budget.timerPending, true);
	assert.equal(at250.budget.elapsed, true, "250ms fires the budget callback through the attach-lifetime fence");
	assert.equal(at250.budget.timerPending, false);
	// T6 wiring: the budget fact reaches the policy, which publishes the
	// committed view degraded exactly at the 250ms boundary (no cap involved).
	assert.equal(at250.attaching, false);
	assert.equal(at250.settledAt, 250);
	assert.equal(at250.publishabilityState, "ready");
	assert.equal(at250.notReadyReason, null);
});

test("T4 b) reconnect before 250ms keeps the original budget deadline and settles on schedule", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "SCREEN-1" },
			{ op: "advance", ms: 100 },
			{ op: "reconnect" },
			{ op: "advance", ms: 150 },
			{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "SCREEN-2" },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("reconnect-deadline", run);
	const readoutsAll = readouts(run.parsed);
	const afterReconnect = readoutsAll[4];
	const at250 = readoutsAll[5];
	const afterSnapshot2 = readoutsAll[6];
	const at2500 = readoutsAll[7];
	assert.equal(afterReconnect.identity.connectionToken, 2, "reconnect bumps the connection identity");
	assert.equal(afterReconnect.committedView, null, "the connect path drops the old connection's view");
	assert.equal(afterReconnect.attachWaitToken, 2, "startAttachSettle re-entered");
	assert.equal(afterReconnect.budget.deadline, 250, "reconnect re-entry must NOT re-arm or extend the budget");
	assert.equal(afterReconnect.budget.timerPending, true);
	assert.equal(at250.budget.elapsed, true, "budget expires at the ORIGINAL 250ms deadline");
	assert.equal(at250.budget.deadline, null);
	assert.equal(at250.attaching, true, "expiry alone publishes nothing (no valid view for the new connection yet)");
	assert.equal(afterSnapshot2.committedView.present, true);
	assert.equal(afterSnapshot2.committedView.connectionToken, 2, "the new connection rebuilds on a fresh baseline");
	assert.equal(afterSnapshot2.attaching, false, "T6: a late snapshot after budget expiry re-evaluates immediately (D4 commit hook)");
	assert.equal(afterSnapshot2.settledAt, 250);
	assert.equal(at2500.attaching, false);
	assert.equal(at2500.settledAt, 250, "settled at the budget deadline, not the cap");
	assert.equal(at2500.deadlineState, "pending", "the cap timer never fired");
});

test("T4 b) an old-connection write callback cannot publish after reconnect (I3 identity fence)", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "BASE" },
			{ op: "holdWrites" },
			// Plain (unclosed) chunk: only its fenced write callback — not a sync
			// close — could drive convergence, so the identity fence is what stands
			// between the stale callback and any publish effect.
			{ op: "output", text: "LATE-OLD-CONNECTION", syncClose: false },
			{ op: "reconnect" },
			{ op: "releaseWrites" },
			{ op: "advance", ms: 250 },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("stale-callback", run);
	const readoutsAll = readouts(run.parsed);
	const beforeRelease = readoutsAll[5];
	const afterRelease = readoutsAll[6];
	const final = run.parsed.final;
	assert.equal(beforeRelease.callbacks.evaluateAttachReady, afterRelease.callbacks.evaluateAttachReady, "stale callback runs no convergence point");
	assert.equal(beforeRelease.callbacks.deferAttachSettle, afterRelease.callbacks.deferAttachSettle, "stale callback reschedules nothing");
	assert.equal(afterRelease.committedView, null, "reconnect dropped the view; the stale callback cannot restore it");
	assert.equal(final.budget.elapsed, true, "budget fired at its deadline");
	assert.equal(final.attaching, true, "budget and cap both elapsed: the stale callback still cannot publish");
	assert.equal(final.settledAt, null);
});

test("T4 c) repeated startAttachSettle re-entry arms the budget exactly once", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "RE-ARM" },
			{ op: "advance", ms: 100 },
			{ op: "reconnect" },
			{ op: "advance", ms: 50 },
			{ op: "reconnect" },
			{ op: "advance", ms: 100 },
			{ op: "reconnect" },
			{ op: "advance", ms: 500 },
		],
	});
	assertScenarioOk("re-arm", run);
	const readoutsAll = readouts(run.parsed);
	const afterFirstReconnect = readoutsAll[4];
	const afterSecondReconnect = readoutsAll[6];
	const at250 = readoutsAll[7];
	const afterThirdReconnect = readoutsAll[8];
	const at750 = readoutsAll[9];
	assert.equal(afterFirstReconnect.attachWaitToken, 2);
	assert.equal(afterFirstReconnect.budget.deadline, 250, "first re-entry keeps the original deadline");
	assert.equal(afterSecondReconnect.attachWaitToken, 3);
	assert.equal(afterSecondReconnect.budget.deadline, 250, "second re-entry still keeps the original deadline");
	assert.equal(afterSecondReconnect.budget.timerPending, true);
	assert.equal(at250.budget.elapsed, true, "budget fires once at the original deadline");
	assert.equal(at250.budget.timerPending, false);
	assert.equal(afterThirdReconnect.budget.timerPending, false, "post-expiry re-entry does not re-arm");
	assert.equal(at750.budget.elapsed, true);
	assert.equal(at750.budget.timerPending, false, "budget stays fired exactly once");
	assert.equal(at750.budget.armed, true, "armed-once is an attach-lifetime fact");
});

test("T4 d) finishing before the budget clears the timer; dispose and detach clear it too", () => {
	const finishRun = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "covered", preset: "committed", text: "PROVEN" },
			{ op: "advance", ms: 400 },
		],
	});
	assertScenarioOk("finish", finishRun);
	const [afterSnapshot, at400] = readouts(finishRun.parsed).slice(2);
	assert.equal(afterSnapshot.attaching, false, "a covered F proof settles before the budget");
	assert.equal(afterSnapshot.settledAt, 0);
	assert.equal(afterSnapshot.publishabilityState, "ready");
	assert.equal(afterSnapshot.budget.timerPending, false, "finishAttachTransition clears the budget timer");
	assert.equal(at400.budget.elapsed, false, "no budget callback after the transition finished");

	const disposeRun = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "PENDING" },
			{ op: "advance", ms: 100 },
			{ op: "dispose" },
			{ op: "advance", ms: 1000 },
		],
	});
	assertScenarioOk("dispose", disposeRun);
	const [afterDispose, at1100] = readouts(disposeRun.parsed).slice(4);
	assert.equal(afterDispose.closed, true);
	assert.equal(afterDispose.budget.timerPending, false, "dispose clears the budget timer");
	assert.equal(at1100.budget.elapsed, false, "no budget callback after dispose even when the clock advances");

	const detachRun = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "PENDING-DETACH" },
			{ op: "advance", ms: 100 },
			{ op: "detach" },
			{ op: "advance", ms: 1000 },
		],
	});
	assertScenarioOk("detach", detachRun);
	const detachReadouts = readouts(detachRun.parsed);
	assert.equal(detachReadouts[4].closed, true);
	assert.equal(detachReadouts[4].budget.timerPending, false, "detach clears the budget timer");
	assert.equal(detachRun.parsed.final.budget.elapsed, false, "no budget callback after detach");
});

test("T4 e) continuous complete frames every 25ms never reset or extend the budget", () => {
	const steps = [
		{ op: "connect" },
		{ op: "hello", witness: true, generation: "gen-1" },
		{ op: "snapshot", proof: "unavailable-candidate-open", preset: "committed", text: "STREAM-0" },
	];
	for (let index = 1; index <= 12; index += 1) {
		steps.push({ op: "advance", ms: 25 });
		steps.push({ op: "output", text: `CHUNK-${index}`, syncClose: true });
	}
	const run = runScenario({ steps });
	assertScenarioOk("stream", run);
	const readoutsAll = readouts(run.parsed);
	// Steps 3.. are advance/output pairs; each advance lands at t = 25*n.
	for (let index = 1; index <= 12; index += 1) {
		const afterAdvance = readoutsAll[2 + (index - 1) * 2 + 1];
		const afterOutput = readoutsAll[2 + (index - 1) * 2 + 2];
		const elapsedAt = index * 25;
		if (elapsedAt < 250) {
			assert.equal(afterAdvance.budget.timerPending, true, `budget timer pending at ${elapsedAt}ms`);
			assert.equal(afterAdvance.budget.deadline, 250, `budget deadline stays at attach start +250 at ${elapsedAt}ms`);
			assert.equal(afterOutput.budget.deadline, 250, `output chunk at ${elapsedAt}ms does not defer the budget`);
		} else {
			assert.equal(afterAdvance.budget.elapsed, true, `budget elapsed at ${elapsedAt}ms`);
			assert.equal(afterAdvance.budget.timerPending, false, `no re-arm after expiry at ${elapsedAt}ms`);
			assert.equal(afterOutput.budget.timerPending, false, `post-expiry output does not re-arm the budget`);
		}
	}
	const final = run.parsed.final;
	assert.equal(final.budget.elapsed, true);
	assert.equal(final.budget.timerPending, false);
	assert.equal(final.attaching, false, "T6: once the budget elapses mid-stream, the latest closed frame publishes");
	assert.equal(final.settledAt, 250);
	assert.equal(final.committedView.present, true, "streamed complete frames keep committing views");
});

// Issue #284 T5: witness latch + three-layer invalidation (spec §3.3/I6).
// Latch layer — the latch survives capability loss and same-component
// reconnects, and clears only on detach/dispose; view layer — old views/proofs
// are invalidated and rebuilt from the new identity without touching the
// latch. Failure-fact layer (sticky invalid) is T6 and deliberately absent.

test("T5 a) latched capability loss keeps the committed path: no legacy restore, no settle re-arm, latch retained", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "LATCHED SCREEN" },
			{ op: "status", witness: false },
			{ op: "output", text: "POST-LOSS", syncClose: true },
			{ op: "advance", ms: 250 },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("latched-loss", run);
	const [afterHello, afterSnapshot, afterLoss, afterOutput, atBudget, atCap] = readouts(run.parsed).slice(1);
	assert.equal(afterHello.witnessLatched, true, "the first capability observation latches");
	assert.equal(afterSnapshot.witnessLatched, true);
	assert.equal(afterLoss.witnessLatched, true, "capability loss never clears the latch (I6 latch layer)");
	assert.equal(afterLoss.frameWitnessAvailable, false);
	assert.equal(afterLoss.callbacks.restoreLegacyDeadlines, 0, "a latched loss must not restore legacy deadlines");
	assert.equal(afterLoss.timers.settlePending, false, "the loss re-arms no legacy settle timer");
	assert.equal(afterLoss.committedPath, true, "the committed presentation path continues after loss");
	assert.equal(afterLoss.committedViewValid, true, "the committed view survives the loss");
	assert.equal(afterLoss.notReadyReason, "witness-capability-lost", "the loss is recorded as a wait reason");
	assert.equal(afterOutput.timers.settlePending, false, "post-loss output must not re-arm the legacy settle either");
	assert.equal(afterOutput.callbacks.restoreLegacyDeadlines, 0);
	assert.equal(afterOutput.committedPreview, "LATCHED SCREENPOST-LOSS", "a closed frame after loss still commits (view updates continue)");
	assert.equal(afterOutput.committedViewValid, true);
	assert.equal(atBudget.witnessLatched, true, "the latch survives past the budget");
	assert.equal(atBudget.callbacks.restoreLegacyDeadlines, 0);
	// T6: the latched loss keeps the policy path alive; the budget reveals the
	// committed view long before the cap (settledAt 250 < 2500).
	assert.equal(atBudget.attaching, false);
	assert.equal(atBudget.settledAt, 250);
	assert.equal(atCap.attaching, false);
	assert.equal(atCap.witnessLatched, true);
});

test("T5 b) loss then resnapshot rebuilds the view from the new identity while the latch survives", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "OLD SCREEN" },
			{ op: "status", witness: false },
			{ op: "snapshot", resnapshot: true, proof: "unavailable-candidate-open", generation: "gen-2", text: "NEW SCREEN" },
		],
	});
	assertScenarioOk("loss-resnapshot", run);
	const [afterSnapshot1, afterLoss, afterSnapshot2] = readouts(run.parsed).slice(2);
	assert.equal(afterSnapshot1.committedView.baselineToken, 1);
	assert.equal(afterSnapshot1.committedView.generation, "gen-1");
	assert.equal(afterLoss.committedView.baselineToken, 1, "no new frame arrived: the old committed view is retained");
	assert.equal(afterLoss.committedPreview, "OLD SCREEN");
	assert.equal(afterLoss.witnessLatched, true);
	assert.equal(afterLoss.callbacks.restoreLegacyDeadlines, 0);
	assert.equal(afterSnapshot2.witnessLatched, true, "the view-layer rebuild does not clear the latch (I6 layers are independent)");
	assert.equal(afterSnapshot2.committedView.present, true);
	assert.equal(afterSnapshot2.committedView.baselineToken, 2, "the rebuild carries the new baseline identity");
	assert.equal(afterSnapshot2.committedView.generation, "gen-2");
	assert.equal(afterSnapshot2.committedView.connectionToken, 1, "same component, same connection");
	assert.equal(afterSnapshot2.committedPreview, "NEW SCREEN", "committed updates continue from the new identity");
	assert.equal(afterSnapshot2.committedViewValid, true);
	assert.equal(afterSnapshot2.attaching, true, "the rebuild waits for the budget — the policy is the sole decider");
});

test("T5 c) loss with no closed frame keeps the old committed view (no fake refresh)", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "RETAINED SCREEN" },
			{ op: "status", witness: false },
			{ op: "output", text: "UNCLOSED CHUNK", syncClose: false },
			{ op: "advance", ms: 250 },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("loss-no-close", run);
	const [afterLoss, afterOutput, atBudget, atCap] = readouts(run.parsed).slice(3);
	assert.equal(afterLoss.committedPreview, "RETAINED SCREEN");
	assert.equal(afterLoss.witnessLatched, true);
	assert.equal(afterOutput.committedPreview, "RETAINED SCREEN", "an unclosed chunk never commits a view");
	assert.equal(afterOutput.committedViewValid, true);
	assert.equal(atBudget.committedPreview, "RETAINED SCREEN", "the budget reveals the retained view, not a fake refresh");
	assert.equal(atBudget.attaching, false);
	assert.equal(atBudget.settledAt, 250, "the retained committed view publishes at the budget, not the cap");
	assert.equal(atCap.attaching, false);
	assert.equal(atCap.witnessLatched, true);
});

test("T5 d) same-component reconnect keeps the latch; old view/proof invalidated until a new snapshot rebuilds", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "SCREEN-1" },
			{ op: "status", witness: false },
			{ op: "reconnect" },
			{ op: "advance", ms: 250 },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "SCREEN-2" },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("reconnect-latch", run);
	const [afterLoss, afterReconnect, at250, afterSnapshot2, atCap] = readouts(run.parsed).slice(3);
	assert.equal(afterLoss.witnessLatched, true);
	assert.equal(afterReconnect.witnessLatched, true, "a same-component reconnect keeps the latch (I6 latch layer)");
	assert.equal(afterReconnect.identity.connectionToken, 2);
	assert.equal(afterReconnect.committedView, null, "the old connection's view is invalidated");
	assert.equal(afterReconnect.committedViewValid, false);
	assert.equal(afterReconnect.latestViewProof, null, "the old connection's proof facts are invalidated (I6 view layer)");
	assert.equal(afterReconnect.timers.settlePending, false, "reconnect re-entry arms no legacy settle while latched");
	assert.equal(afterReconnect.callbacks.restoreLegacyDeadlines, 0);
	assert.equal(afterReconnect.budget.deadline, 250, "the reconnect keeps the original budget deadline (T4 fact, unchanged)");
	assert.equal(at250.budget.elapsed, true);
	assert.equal(at250.attaching, true, "the budget fact alone publishes nothing without a valid new view");
	assert.equal(at250.committedView, null);
	assert.equal(afterSnapshot2.committedView.present, true);
	assert.equal(afterSnapshot2.committedView.connectionToken, 2, "the rebuild is bound to the new connection identity");
	assert.equal(afterSnapshot2.committedView.baselineToken, 2);
	assert.equal(afterSnapshot2.committedPreview, "SCREEN-2");
	assert.equal(afterSnapshot2.committedViewValid, true);
	assert.equal(afterSnapshot2.witnessLatched, true);
	assert.equal(afterSnapshot2.attaching, false, "T6: the rebuilt view publishes immediately — the budget already elapsed");
	assert.equal(afterSnapshot2.settledAt, 250);
	assert.equal(atCap.attaching, false);
});

test("T5 e) never-latched protocol attach keeps the capability-absent legacy settle unchanged", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "snapshot", empty: true },
			{ op: "advance", ms: 249 },
			{ op: "advance", ms: 1 },
		],
	});
	assertScenarioOk("never-latched", run);
	const [afterSnapshot, at249, at250] = readouts(run.parsed).slice(1);
	assert.equal(afterSnapshot.attachMode, "protocol", "an empty snapshot still decides protocol mode");
	assert.equal(afterSnapshot.witnessLatched, false, "no capability was ever observed");
	assert.equal(afterSnapshot.committedPath, false);
	assert.equal(at249.attaching, true);
	assert.equal(at249.witnessLatched, false);
	assert.equal(at250.attaching, false, "the capability-absent settle reveals at the unchanged 250ms boundary");
	assert.equal(at250.settledAt, 250);
	assert.equal(at250.witnessLatched, false);
});

test("T5 f) post-publish loss/resnapshot: single settle, input gates not advanced by the latch", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "covered", text: "F SCREEN" },
			{ op: "advance", ms: 300 },
			{ op: "status", witness: false },
			{ op: "snapshot", resnapshot: true, proof: "unavailable-candidate-open", generation: "gen-2", text: "POST-LOSS SCREEN" },
			{ op: "output", text: "TAIL", syncClose: true },
			{ op: "advance", ms: 2200 },
		],
	});
	assertScenarioOk("post-publish", run);
	const [afterSnapshot, at300, afterLoss, afterResnapshot, afterOutput, finalStep] = readouts(run.parsed).slice(2);
	assert.equal(afterSnapshot.attaching, false, "the covered F proof settled before the budget");
	assert.equal(afterSnapshot.settledAt, 0);
	assert.equal(afterSnapshot.callbacks.finishAttachTransition, 1, "first-attach side effects fired exactly once");
	assert.equal(afterSnapshot.firstAttachSideEffectsApplied, true);
	assert.equal(at300.childInputReady, false, "no real child input mode was ever signaled");
	assert.equal(afterLoss.attaching, false, "a post-settle loss cannot re-enter the transition");
	assert.equal(afterLoss.witnessLatched, true);
	assert.equal(afterLoss.callbacks.finishAttachTransition, 1);
	assert.equal(afterLoss.childInputReady, false, "the latch never advances the input gate (I4)");
	assert.equal(afterLoss.committedPath, true, "selection/copy and display stay on the committed source");
	assert.equal(afterResnapshot.committedPreview, "POST-LOSS SCREEN", "committed updates continue after the publish");
	assert.equal(afterResnapshot.witnessLatched, true);
	assert.equal(afterResnapshot.callbacks.finishAttachTransition, 1, "no second settle across loss+resnapshot");
	assert.equal(afterOutput.committedViewValid, true);
	assert.equal(afterOutput.callbacks.finishAttachTransition, 1);
	assert.equal(finalStep.callbacks.finishAttachTransition, 1, "first-attach side effects fire at most once across the sequence");
	assert.equal(finalStep.childInputReady, false);
	assert.equal(finalStep.witnessLatched, true);
});

test("T5 g) detach and dispose clear the latch: a new attach re-observes the capability", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "LATCH SOURCE" },
			{ op: "detach" },
			{ op: "advance", ms: 1000 },
		],
	});
	assertScenarioOk("detach-clears-latch", run);
	const [afterSnapshot, afterDetach] = readouts(run.parsed).slice(2);
	assert.equal(afterSnapshot.witnessLatched, true);
	assert.equal(afterDetach.closed, true);
	assert.equal(afterDetach.witnessLatched, false, "detach ends this attach: the latch is attach-scoped (I6 latch layer)");
	assert.equal(run.parsed.final.witnessLatched, false, "no later status line can re-latch a closed component");

	const disposeRun = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "LATCH SOURCE 2" },
			{ op: "dispose" },
		],
	});
	assertScenarioOk("dispose-clears-latch", disposeRun);
	assert.equal(readouts(disposeRun.parsed)[3].witnessLatched, false, "dispose clears the latch too");
	assert.equal(disposeRun.parsed.final.witnessLatched, false);
});

// Issue #284 T6: recovery-fact assembly + sticky invalid wiring (spec §3.1,
// §3.1.1, D4). The policy alone decides the committed-degraded publish; the
// deleted #265 idle-downgrade cap special case is asserted dead.

test("T6 a) A07 quiet: budget expiry publishes the sync-closed committed view without the cap", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "none", text: "QUIET BASE" },
			{ op: "output", text: "SYNC FRAME", syncClose: true },
			{ op: "record", marker: "S" },
			{ op: "advance", ms: 249 },
			{ op: "advance", ms: 1 },
		],
	});
	assertScenarioOk("t6-quiet", run);
	const [afterOutput, afterS, at249, at250] = readouts(run.parsed).slice(3);
	assert.equal(afterOutput.committedView.source, "sync-close", "the live sync-closed frame is the commit source");
	assert.equal(afterOutput.committedView.contentKind, "complete", "a locally parsed closed frame is locally complete");
	assert.equal(afterOutput.committedView.sourceCols, 80, "the actual source grid columns are recorded at commit");
	assert.equal(afterOutput.committedView.sourceRows, 24, "the actual source grid rows are recorded at commit");
	assert.equal(afterS.proofStatus, "missing", "a live S record classifies as missing evidence");
	assert.equal(afterS.stickyInvalid, false);
	assert.equal(afterS.attaching, true);
	assert.equal(afterS.notReadyReason, "recovery-budget-pending", "the only failing degraded predicate is the budget");
	assert.equal(at249.attaching, true, "249ms must not publish");
	assert.equal(at249.budget.elapsed, false);
	assert.equal(at250.attaching, false, "250ms budget expiry publishes the committed view degraded");
	assert.equal(at250.settledAt, 250);
	assert.equal(at250.publishabilityState, "ready");
	assert.equal(at250.notReadyReason, null);
	assert.equal(at250.deadlineState, "pending", "the settle happened without the 2500ms cap");
	assert.equal(at250.proofStatus, "missing");
	assert.equal(at250.budget.deadlineAt, 250, "the budget deadline is an attach-lifetime timestamp");
	assert.equal(at250.witnessLatched, true);
});

test("T6 b) sticky invalid survives live S, no-proof, and capability loss; only covered or a new baseline recovers", () => {
	const washSteps = [
		{ op: "connect" },
		{ op: "hello", witness: true, generation: "gen-1" },
		{ op: "snapshot", proof: "output-gap", text: "WASH SCREEN" },
		{ op: "advance", ms: 250 },
		{ op: "record", marker: "S" },
		{ op: "proofState", proof: "no-proof" },
		{ op: "status", witness: false },
		{ op: "advance", ms: 2250 },
	];
	const coveredRun = runScenario({ steps: [...washSteps, { op: "record", marker: "F" }] });
	assertScenarioOk("t6-sticky-covered", coveredRun);
	const [afterSnapshot, at250, afterS, afterNoProof, afterLoss, atCap, afterF] = readouts(coveredRun.parsed).slice(2);
	assert.equal(afterSnapshot.proofStatus, "invalid", "an output-gap coverage classifies invalid (fail-closed)");
	assert.equal(afterSnapshot.stickyInvalid, true, "the invalid fact is sticky on the current baseline");
	assert.equal(afterSnapshot.lastProofStickyInvalid, true, "the diagnostic field records the invalidation transition (false→true) post-update");
	assert.equal(afterSnapshot.attaching, true);
	assert.equal(at250.attaching, true, "budget expiry cannot publish over a sticky invalid fact");
	assert.equal(at250.budget.elapsed, true);
	assert.equal(at250.proofStatus, "invalid");
	assert.equal(afterS.attaching, true, "a live S record does not wash the sticky fact");
	assert.equal(afterS.proofStatus, "invalid");
	assert.equal(afterS.stickyInvalid, true);
	assert.equal(afterS.latestViewProof.reason, "candidate-open");
	assert.equal(afterNoProof.attaching, true, "a no-proof coverage does not wash the sticky fact");
	assert.equal(afterNoProof.proofStatus, "invalid");
	assert.equal(afterNoProof.latestViewProof.reason, "no-proof");
	assert.equal(afterLoss.frameWitnessAvailable, false);
	assert.equal(afterLoss.latestViewProof, null, "capability loss nulls the proof object");
	assert.equal(afterLoss.witnessLatched, true);
	assert.equal(afterLoss.stickyInvalid, true, "capability loss keeps the recorded failure fact (I6)");
	assert.equal(atCap.attaching, true, "budget AND cap elapsed: neither publishes over sticky invalid");
	assert.equal(atCap.settledAt, null);
	assert.equal(atCap.deadlineState, "expired");
	assert.equal(atCap.notReadyReason, "deadline-expired:proof-status-invalid");
	assert.equal(afterF.attaching, false, "a real F record on the current baseline recovers the block");
	assert.equal(afterF.proofStatus, "covered");
	assert.equal(afterF.stickyInvalid, false);
	assert.equal(afterF.lastProofStickyInvalid, false, "the diagnostic field records the covered recovery (true→false) through the publish path");
	assert.equal(afterF.stickyBaseline, null, "covered is the only in-baseline clear of the sticky fact");
	assert.equal(afterF.settledAt, 2500);

	const resnapshotRun = runScenario({ steps: [...washSteps, { op: "snapshot", resnapshot: true, proof: "unavailable-candidate-open", generation: "gen-2", text: "FRESH BASE" }] });
	assertScenarioOk("t6-sticky-resnapshot", resnapshotRun);
	const afterResnapshot = readouts(resnapshotRun.parsed).at(-1);
	assert.equal(afterResnapshot.attaching, false, "a baseline identity change rebinds the sticky fact; the degraded path proceeds");
	assert.equal(afterResnapshot.proofStatus, "missing");
	assert.equal(afterResnapshot.stickyInvalid, false, "the stale binding (baseline 1) is inactive on baseline 2");
	assert.equal(afterResnapshot.stickyBaseline, 1);
	assert.equal(afterResnapshot.settledAt, 2500);
});

test("T6 c) an empty baseline waits past budget and cap (never publishes)", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", empty: true },
			{ op: "advance", ms: 250 },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("t6-empty", run);
	const [at250, atCap] = readouts(run.parsed).slice(3);
	assert.equal(at250.budget.elapsed, true);
	assert.equal(at250.attaching, true, "no committed view means nothing to degrade to");
	assert.equal(at250.notReadyReason, "committed-view-missing");
	assert.equal(atCap.attaching, true, "the cap alone publishes nothing either");
	assert.equal(atCap.settledAt, null);
	assert.equal(atCap.deadlineState, "expired");
	assert.equal(atCap.committedView, null);
});

test("T6 d) covered then invalidated never bypasses through the degraded path", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "none", text: "GATE SCREEN" },
			{ op: "record", marker: "F", mismatchCols: true },
			{ op: "advance", ms: 250 },
			{ op: "proofState", proof: "output-gap" },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("t6-covered-invalidated", run);
	const [afterF, at250, afterGap, atCap] = readouts(run.parsed).slice(3);
	assert.equal(afterF.latestViewProof.status, "covered", "a real F record covers");
	assert.equal(afterF.attaching, true, "a geometry-mismatched proof keeps the F path waiting");
	assert.equal(afterF.proofStatus, "covered");
	assert.equal(at250.attaching, true, "proofStatus covered is not degradable");
	assert.equal(at250.notReadyReason, "proof-status-covered");
	assert.equal(afterGap.proofStatus, "invalid", "the gap invalidates the covered proof and sticks");
	assert.equal(afterGap.stickyInvalid, true);
	assert.equal(atCap.attaching, true, "no degraded bypass even with budget and cap elapsed");
	assert.equal(atCap.settledAt, null);
	assert.equal(atCap.notReadyReason, "deadline-expired:proof-status-invalid");
});

test("T6 e) producer-unfinished but locally-closed snapshot settles degraded; a later F keeps updating the view", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "HALF FRAME" },
			{ op: "advance", ms: 250 },
			{ op: "record", marker: "F" },
			{ op: "output", text: "DONE", syncClose: true },
		],
	});
	assertScenarioOk("t6-unfinished", run);
	const [at250, afterF, afterOutput] = readouts(run.parsed).slice(3);
	assert.equal(at250.attaching, false, "the locally closed synthetic snapshot settles via the budget");
	assert.equal(at250.settledAt, 250);
	assert.equal(at250.committedView.source, "snapshot");
	assert.equal(at250.committedView.contentKind, "complete", "local closure is the completeness fact, not proof readiness");
	assert.equal(at250.proofStatus, "missing");
	assert.equal(afterF.latestViewProof.status, "covered", "the real F updates the proof channel after the degraded settle");
	assert.equal(afterF.attaching, false);
	assert.equal(afterF.callbacks.finishAttachTransition, 1, "no second settle for the late F");
	assert.equal(afterOutput.committedPreview, "HALF FRAMEDONE", "the view keeps updating after the F");
	assert.equal(afterOutput.callbacks.finishAttachTransition, 1);
});

test("T6 f) the cap alone no longer publishes: an open sync frame keeps waiting past the cap", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "CAP GATE" },
			{ op: "output", text: "OPEN FRAME", openFrame: true },
			{ op: "advance", ms: 250 },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("t6-cap-open-frame", run);
	const [at250, atCap] = readouts(run.parsed).slice(4);
	assert.equal(at250.attaching, true, "an open local sync frame is never degradable");
	assert.equal(at250.notReadyReason, "sync-open");
	assert.equal(atCap.attaching, true, "the deleted #265 cap special case must not reveal an unclosed frame");
	assert.equal(atCap.settledAt, null);
	assert.equal(atCap.deadlineState, "expired");
	assert.equal(atCap.notReadyReason, "deadline-expired:sync-open");
	assert.equal(atCap.committedViewValid, true, "a committed view exists — only the policy blocks the reveal");
});

test("T6 g) sticky invalid survives a covered but non-publishable F (recovery is publish-only)", () => {
	// Review fix (issue #284, CRITICAL): the old classifier cleared the sticky
	// failure fact on ANY covered classification — but noteViewProofRecord(F)
	// builds covered/safe-trailing coverage BEFORE the full-view policy
	// validates geometry, so the wrong-geometry F below washed the sticky fact
	// and the later live S re-classified as missing evidence, letting budget
	// expiry publish degraded (safety bypass). Recovery is publish-only now:
	// only the policy's "publish" action on the current baseline clears it.
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			// Real gap coverage through the real client path: invalid sticks.
			{ op: "snapshot", proof: "output-gap", text: "STICKY BASE" },
			// Wrong-geometry F (real record): stays covered, the F path waits —
			// and the sticky fact must NOT be cleared by the classification.
			{ op: "record", marker: "F", mismatchCols: true },
			// Live S (real noteViewProofRecord): candidate-open — with the sticky
			// fact retained this classifies invalid, not missing.
			{ op: "record", marker: "S" },
			// Budget AND cap elapsed: no degraded publish may happen.
			{ op: "advance", ms: 250 },
			{ op: "advance", ms: 2250 },
			// The only recovery: a VALID target-geometry F publishing through the
			// full-view policy.
			{ op: "record", marker: "F" },
		],
	});
	assertScenarioOk("t6-sticky-covered-f", run);
	const [afterSnapshot, afterWrongF, afterS, atBudget, atCap, afterRealF] = readouts(run.parsed).slice(2);
	assert.equal(afterSnapshot.proofStatus, "invalid", "the real gap coverage classifies invalid");
	assert.equal(afterSnapshot.stickyInvalid, true, "the invalid fact is bound to the baseline");
	assert.equal(afterSnapshot.attaching, true);
	assert.equal(afterWrongF.latestViewProof.status, "covered", "the wrong-geometry F still covers the proof channel");
	assert.equal(afterWrongF.proofStatus, "covered", "the classifier reports covered (pure contract unchanged)");
	assert.equal(afterWrongF.stickyInvalid, true, "a covered but non-publishable F must NOT clear the sticky fact");
	assert.equal(afterWrongF.stickyBaseline, 1, "the binding stays on the current baseline");
	assert.equal(afterWrongF.attaching, true, "the F path waits on proof-geometry-mismatch");
	assert.equal(afterWrongF.notReadyReason, "proof-status-covered", "a covered proof status is not degradable");
	assert.equal(afterS.latestViewProof.status, "unknown");
	assert.equal(afterS.latestViewProof.reason, "candidate-open", "the live S drives the real record path");
	assert.equal(afterS.proofStatus, "invalid", "candidate-open under a retained sticky fact classifies invalid");
	assert.equal(afterS.stickyInvalid, true);
	assert.equal(atBudget.budget.elapsed, true);
	assert.equal(atBudget.attaching, true, "budget expiry cannot publish over the retained sticky fact");
	assert.equal(atCap.attaching, true, "budget AND cap elapsed: still no degraded publish");
	assert.equal(atCap.settledAt, null);
	assert.equal(atCap.publishabilityState, "unknown", "the attach never reached the ready state");
	assert.equal(atCap.notReadyReason, "deadline-expired:proof-status-invalid");
	assert.equal(afterRealF.attaching, false, "the valid target-geometry F publishes through the full-view policy");
	assert.equal(afterRealF.readyReason, "complete");
	assert.equal(afterRealF.settledAt, 2500);
	assert.equal(afterRealF.proofStatus, "covered");
	assert.equal(afterRealF.stickyInvalid, false, "the policy publish is what clears the sticky fact");
	assert.equal(afterRealF.stickyBaseline, null);
	const settle = run.parsed.diagnostics.filter((event) => event.code === "attach_settle_ready");
	assert.equal(settle.length, 1);
	assert.equal(settle[0].details.readyReason, "complete");
	assert.equal(settle[0].details.proofStickyInvalid, false, "the settle record reports the post-publish sticky state");
});

// Issue #284 T7: readyReason recording + settle diagnostics (spec §3.4/D5).
// Every settle records which path revealed the surface; the diagnostic record
// carries numbers and finite enums only — never tokens, screen text, keys, or
// raw terminal data.

test("T7 a) readyReason complete: a covered F settle records the policy publish", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "covered", text: "F SETTLE" },
			{ op: "noop" },
		],
	});
	assertScenarioOk("t7-complete", run);
	const afterSnapshot = readouts(run.parsed)[2];
	assert.equal(afterSnapshot.attaching, false, "the covered F settles before the budget");
	assert.equal(afterSnapshot.settledAt, 0);
	assert.equal(afterSnapshot.readyReason, "complete");
	assert.equal(run.parsed.final.readyReason, "complete");
	const settle = run.parsed.diagnostics.filter((event) => event.code === "attach_settle_ready");
	assert.equal(settle.length, 1, "exactly one settle diagnostic");
	assert.equal(settle[0].level, "info");
	assert.equal(settle[0].details.readyReason, "complete");
	assert.equal(settle[0].details.witnessLatched, true);
	assert.equal(settle[0].details.budgetDeadline, 250, "the budget deadline is recorded as a timestamp");
	assert.equal(settle[0].details.budgetElapsed, false);
	assert.equal(settle[0].details.proofStatus, "covered");
	assert.equal(settle[0].details.committedView.source, "snapshot");
	assert.equal(settle[0].details.latestViewProof.status, "covered");
	assert.equal(settle[0].details.latestViewProof.reason, "exact-proof");
});

test("T7 b) readyReason committed-degraded: the budget settle records the recovery facts", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "none", text: "QUIET BASE" },
			{ op: "output", text: "SYNC FRAME", syncClose: true },
			{ op: "record", marker: "S" },
			{ op: "advance", ms: 250 },
		],
	});
	assertScenarioOk("t7-degraded", run);
	const at250 = readouts(run.parsed).at(-1);
	assert.equal(at250.attaching, false);
	assert.equal(at250.settledAt, 250);
	assert.equal(at250.readyReason, "committed-degraded");
	const settle = run.parsed.diagnostics.filter((event) => event.code === "attach_settle_ready");
	assert.equal(settle.length, 1);
	const details = settle[0].details;
	assert.equal(details.readyReason, "committed-degraded");
	assert.equal(details.notReadyReason, null, "notReadyReason keeps its post-settle null semantics");
	assert.equal(details.publishabilityState, "ready");
	assert.equal(details.deadlineState, "pending");
	assert.equal(details.witnessLatched, true);
	assert.equal(details.budgetDeadline, 250);
	assert.equal(details.budgetElapsed, true);
	assert.equal(details.proofStatus, "missing");
	assert.equal(details.proofStickyInvalid, false);
	// Review hardening (token/enum hygiene): the settle payload records numeric
	// identity facts only — the parser generation and geometry revision — and
	// never the connection/baseline tokens.
	assert.equal(details.committedView.generation, 2, "the numeric parser generation is the recorded identity fact (the snapshot's replaceParser advanced the epoch to 2)");
	assert.equal(Object.hasOwn(details.committedView, "connectionToken"), false, "connectionToken never reaches the diagnostic payload");
	assert.equal(Object.hasOwn(details.committedView, "baselineToken"), false, "baselineToken never reaches the diagnostic payload");
	assert.equal(details.committedView.geometryRevision, 0);
	assert.equal(details.committedView.source, "sync-close");
	assert.equal(details.committedView.sourceCols, 80);
	assert.equal(details.committedView.sourceRows, 24);
	assert.equal(details.committedView.contentKind, "complete");
	assert.equal(details.latestViewProof.status, "unknown");
	assert.equal(details.latestViewProof.reason, "candidate-open");
});

test("T7 c) readyReason legacy-settle: the legacy settle timeout records its reveal", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "mode", value: "legacy" },
			{ op: "advance", ms: 249 },
			{ op: "advance", ms: 1 },
		],
	});
	assertScenarioOk("t7-legacy-settle", run);
	const at250 = readouts(run.parsed).at(-1);
	assert.equal(at250.attaching, false);
	assert.equal(at250.settledAt, 250);
	assert.equal(at250.readyReason, "legacy-settle");
	const settle = run.parsed.diagnostics.filter((event) => event.code === "attach_settle_ready");
	assert.equal(settle.length, 1);
	assert.equal(settle[0].details.readyReason, "legacy-settle");
	assert.equal(settle[0].details.witnessLatched, false, "a legacy settle has no witness facts");
	assert.equal(settle[0].details.proofStatus, null);
	assert.equal(settle[0].details.committedView, null);
	assert.equal(typeof settle[0].details.budgetDeadline, "number");
});

test("T7 d) readyReason legacy-cap: output-deferred legacy settle reveals at the cap", () => {
	const steps = [
		{ op: "connect" },
		{ op: "mode", value: "legacy" },
	];
	// Each output re-defers the 250ms settle window; the 2500ms cap fires while
	// a settle timer is still pending, so only the cap can reveal.
	for (let index = 1; index <= 12; index += 1) {
		steps.push({ op: "advance", ms: 200 });
		steps.push({ op: "output", text: `KEEP-${index}` });
	}
	steps.push({ op: "advance", ms: 100 });
	const run = runScenario({ steps });
	assertScenarioOk("t7-legacy-cap", run);
	const final = readouts(run.parsed).at(-1);
	assert.equal(final.attaching, false);
	assert.equal(final.settledAt, 2500);
	assert.equal(final.readyReason, "legacy-cap");
	const settle = run.parsed.diagnostics.filter((event) => event.code === "attach_settle_ready");
	assert.equal(settle.length, 1);
	assert.equal(settle[0].details.readyReason, "legacy-cap");
});

test("T7 e) settle diagnostics contain numbers and finite enums only", () => {
	const runs = [
		runScenario({
			steps: [
				{ op: "connect" },
				{ op: "hello", witness: true, generation: "gen-1" },
				{ op: "snapshot", proof: "covered", text: "SCREEN TEXT MUST NOT LEAK" },
				{ op: "noop" },
			],
		}),
		runScenario({
			steps: [
				{ op: "connect" },
				{ op: "hello", witness: true, generation: "gen-1" },
				{ op: "snapshot", proof: "none", text: "DEGRADED SCREEN TEXT" },
				{ op: "advance", ms: 250 },
			],
		}),
		runScenario({
			steps: [
				{ op: "connect" },
				{ op: "mode", value: "legacy" },
				{ op: "advance", ms: 250 },
			],
		}),
	];
	for (const run of runs) {
		assertScenarioOk("t7-enum-only", run);
		// The recovery settle records are the T7 scope; the pre-existing settle
		// scheme probe patches (probeApi outcomes, color reports) keep their own
		// shape and are filtered out here.
		const settleEvents = run.parsed.diagnostics.filter((event) => event.code === "attach_settle_ready");
		assert.ok(settleEvents.length >= 1, "each settling scenario recorded a recovery diagnostic");
		for (const event of settleEvents) {
			assert.equal(event.source, "attach");
			const strings = [];
			const walk = (value) => {
				if (value === null || typeof value === "boolean") return;
				if (typeof value === "number") {
					assert.ok(Number.isFinite(value), "diagnostic numbers are finite");
					return;
				}
				if (typeof value === "string") {
					strings.push(value);
					return;
				}
				if (Array.isArray(value)) {
					for (const item of value) walk(item);
					return;
				}
				if (value && typeof value === "object") {
					for (const item of Object.values(value)) walk(item);
					return;
				}
				assert.fail(`unsupported diagnostic leaf: ${String(value)}`);
			};
			walk(event.details);
			for (const text of strings) {
				// Finite enums and policy reason strings are lowercase identifier
				// shapes — screen text, terminal data, and tokens never are.
				assert.match(text, /^[a-z][a-z0-9:.-]*$/, `non-enum string leaked into diagnostics: ${text}`);
			}
		}
	}
});

test("T7 f) unrecognized wire proof pairs map to the finite unrecognized enum", () => {
	// Review hardening (settle-diagnostics hygiene): the attach client's
	// sanitizer accepts arbitrary reason strings, so the settle record must
	// whitelist the (status, reason) pair before it reaches onDiagnostic
	// consumers. The real path: an empty never-latched attach (client live, no
	// witness → capability-absent legacy settle), a live view_proof_state
	// carrying a wire-garbage pair, and the 250ms settle whose diagnostic must
	// show only the finite "unrecognized" enum.
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "snapshot", empty: true },
			{ op: "proofState", proof: { status: "unknown", reason: "WIRE GARBAGE † SCREEN TEXT" } },
			{ op: "advance", ms: 250 },
		],
	});
	assertScenarioOk("t7-unrecognized", run);
	const at250 = readouts(run.parsed).at(-1);
	assert.equal(at250.attaching, false, "the capability-absent settle reveals at the 250ms boundary");
	assert.equal(at250.latestViewProof.reason, "WIRE GARBAGE † SCREEN TEXT", "the garbage pair survived the client sanitizer (the premise of the whitelist)");
	const settle = run.parsed.diagnostics.filter((event) => event.code === "attach_settle_ready");
	assert.equal(settle.length, 1);
	assert.equal(settle[0].details.readyReason, "legacy-settle");
	assert.equal(settle[0].details.latestViewProof.status, "unrecognized", "an unrecognized status maps to the finite enum");
	assert.equal(settle[0].details.latestViewProof.reason, "unrecognized", "arbitrary wire reason strings never reach the diagnostic payload");
	assert.equal(JSON.stringify(settle[0]).includes("WIRE GARBAGE"), false, "the raw wire string never leaks into the settle record");
});

// Issue #284 T8: A09 geometry coverage on the component entry (spec §3.1
// predicate 4 + the F-chain geometry gates). The integration entry carries the
// same-size/zero-intent contract end-to-end; the fine-grained gate semantics
// live here where the injected clock can drive every timer deterministically.

test("T8 A09 a) same-size geometry is a no-op: no revision, no intent, no gate; the budget degrade publishes through it", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "SAME SIZE" },
			{ op: "geometry", cols: 80, rows: 24 },
			{ op: "advance", ms: 250 },
		],
	});
	assertScenarioOk("t8-same-size", run);
	const [afterSnapshot, afterSameSize, at250] = readouts(run.parsed).slice(2);
	assert.equal(afterSnapshot.identity.geometryRevision, 0);
	assert.equal(afterSnapshot.committedView.present, true);
	assert.equal(afterSameSize.identity.geometryRevision, 0, "a same-size render mints no geometry revision");
	assert.equal(afterSameSize.identity.resizeIntentRequired, false, "a same-size render raises no resize intent");
	assert.equal(afterSameSize.committedView.present, true, "a same-size render does not invalidate the committed view");
	assert.equal(afterSameSize.committedViewValid, true);
	assert.equal(afterSameSize.committedView.sourceCols, 80);
	assert.equal(afterSameSize.committedView.sourceRows, 24);
	assert.equal(at250.attaching, false, "no geometry gate blocks the budget degrade on a same-size attach");
	assert.equal(at250.settledAt, 250);
	assert.equal(at250.readyReason, "committed-degraded");
	assert.equal(at250.notReadyReason, null);
});

test("T8 A09 b) the geometry gate survives wrong F/A/loss and every timer; only a real target F clears it", () => {
	// The one real target after a differing resize: cols 100 x rows 30, the
	// intent's own revision (1) and intent id (1).
	const target = { protocol: 1, cols: 100, rows: 30, mode: "fullscreen", rendererEpoch: 1, sessionEpoch: 1, focusPresent: true, overlayPresent: false, intentId: 1, geometryRevision: 1 };
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "GATE 80" },
			{ op: "geometry", cols: 100, rows: 30 },
			{ op: "snapshot", resnapshot: true, proof: "unavailable-candidate-open", generation: "gen-2", text: "GATE 100" },
			// Wrong-size F: right revision/intent, geometry the target can never accept.
			{ op: "record", marker: "F", metadata: { ...target, cols: 140 } },
			// Wrong-revision F: belongs to the superseded geometry.
			{ op: "record", marker: "F", metadata: { ...target, geometryRevision: 0 } },
			// Wrong-intent F: the applied intent is not the proof's intent.
			{ op: "record", marker: "F", metadata: { ...target, intentId: 0 } },
			// An abort is no geometry evidence either.
			{ op: "record", marker: "A", frameId: 9, reason: "stop" },
			{ op: "advance", ms: 250 },
			// Capability loss must not clear the gate (and must not leave the committed
			// path). The generation matches the resnapshot baseline — a wrong generation
			// would trip the separate generation-change fence instead.
			{ op: "status", witness: false, generation: "gen-2" },
			{ op: "advance", ms: 2250 },
			// The real target F is the only key.
			{ op: "record", marker: "F", metadata: target },
		],
	});
	assertScenarioOk("t8-geometry-gate", run);
	const readoutsAll = readouts(run.parsed);
	const [afterGeometry, afterResnapshot, afterWrongSize, afterWrongRevision, afterWrongIntent, afterA, atBudget, afterLoss, atCap, afterRealF] = readoutsAll.slice(3);
	assert.equal(afterGeometry.identity.geometryRevision, 1, "one differing resize = exactly one revision");
	assert.equal(afterGeometry.identity.resizeIntentRequired, true, "the differing resize raises the intent gate");
	assert.equal(afterGeometry.committedView, null, "the differing resize invalidates the old-geometry view");
	assert.equal(afterResnapshot.committedView.present, true, "a resnapshot at the target rebuilds a committed view");
	assert.equal(afterResnapshot.committedView.sourceCols, 100);
	assert.equal(afterResnapshot.committedView.sourceRows, 30);
	assert.equal(afterResnapshot.committedViewValid, true);
	assert.equal(afterResnapshot.attaching, true, "the fresh view waits: the intent gate is not satisfied by the snapshot");
	assert.equal(afterResnapshot.notReadyReason, "resize-intent");
	assert.equal(afterWrongSize.attaching, true, "a wrong-size F does not clear the gate");
	assert.equal(afterWrongSize.notReadyReason, "resize-intent");
	assert.equal(afterWrongSize.latestViewProof.status, "covered", "the wrong-size F still covers the proof channel — the gate is geometric");
	assert.equal(afterWrongRevision.attaching, true, "a wrong-revision F does not clear the gate");
	assert.equal(afterWrongRevision.notReadyReason, "resize-intent");
	assert.equal(afterWrongIntent.attaching, true, "a wrong-intent F does not clear the gate");
	assert.equal(afterWrongIntent.notReadyReason, "resize-intent");
	assert.equal(afterA.attaching, true, "an abort is not geometry evidence");
	assert.equal(afterA.notReadyReason, "resize-intent");
	assert.equal(afterA.proofStatus, "missing");
	assert.equal(atBudget.budget.elapsed, true, "the recovery budget elapsed under the gate");
	assert.equal(atBudget.attaching, true, "the budget never clears a geometry gate");
	assert.equal(atBudget.notReadyReason, "resize-intent");
	assert.equal(afterLoss.witnessLatched, true, "capability loss keeps the committed path");
	assert.equal(afterLoss.callbacks.restoreLegacyDeadlines, 0);
	assert.equal(afterLoss.attaching, true, "capability loss does not clear the gate");
	assert.equal(atCap.attaching, true, "the 2500ms cap does not clear the gate either");
	assert.equal(atCap.settledAt, null);
	assert.equal(atCap.deadlineState, "expired");
	assert.equal(atCap.notReadyReason, "deadline-expired:resize-intent");
	assert.equal(afterRealF.attaching, false, "the real target F clears the gate");
	assert.equal(afterRealF.readyReason, "complete");
	assert.equal(afterRealF.settledAt, 2500);
	assert.equal(afterRealF.proofStatus, "covered");
	assert.equal(afterRealF.identity.resizeIntentRequired, true, "the intent flag stays recorded; the matching F satisfied it");
});

test("T8 A09 c) an old-size source grid with identity marked current never publishes (I3 alone is not enough)", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "OLD GRID" },
			// The §8.5 counterexample: the committed view's identity is already
			// marked with the current target (I3 passes), but the captured grid
			// fact stays at the old size — only predicate 4 can refuse it.
			{ op: "divergeSourceFromTarget" },
			{ op: "advance", ms: 250 },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("t8-source-geometry", run);
	const [afterDiverge, atBudget, atCap] = readouts(run.parsed).slice(3);
	assert.equal(afterDiverge.committedView.sourceCols, 80, "the captured grid keeps its old size");
	assert.equal(afterDiverge.committedView.sourceRows, 24);
	assert.equal(afterDiverge.committedView.identityTargetCols, 100, "the identity is marked with the current target");
	assert.equal(afterDiverge.committedView.identityTargetRows, 30);
	assert.equal(afterDiverge.committedViewValid, true, "the identity fence alone (I3) blesses this view");
	assert.equal(afterDiverge.attaching, true);
	assert.equal(atBudget.budget.elapsed, true);
	assert.equal(atBudget.attaching, true, "the budget must not publish an old-size source grid");
	assert.equal(atBudget.notReadyReason, "committed-geometry-mismatch", "predicate 4 names the source-geometry mismatch");
	assert.equal(atCap.attaching, true, "the cap does not publish it either");
	assert.equal(atCap.settledAt, null);
	assert.equal(atCap.notReadyReason, "deadline-expired:committed-geometry-mismatch");
});
