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
	assert.ok(run.parsed.wallMs < 200, `settle ran on virtual, not wall, clock (wall ${run.parsed.wallMs}ms)`);
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
	// T4 scope: evaluateAttachReady does not consume the budget fact yet (T6
	// wires it); the callback ran and recorded the fact without publishing.
	assert.equal(at250.attaching, true);
	assert.equal(at250.publishabilityState, "wait");
	assert.ok(at250.notReadyReason, "the wait keeps a named reason");
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
	assert.equal(afterSnapshot2.attaching, true, "T4: the policy has no budget input yet, so the wait holds");
	assert.equal(at2500.attaching, false, "the hard cap reveals the committed view on schedule");
	assert.equal(at2500.settledAt, 2500);
	assert.equal(at2500.deadlineState, "expired");
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
	assert.equal(final.attaching, true, "streaming output alone settles nothing in T4 (policy wiring is T6)");
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
			{ op: "advance", ms: 2500 },
		],
	});
	assertScenarioOk("latched-loss", run);
	const [afterHello, afterSnapshot, afterLoss, afterOutput, atCap] = readouts(run.parsed).slice(1);
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
	assert.equal(atCap.witnessLatched, true, "the latch survives to the cap");
	assert.equal(atCap.callbacks.restoreLegacyDeadlines, 0);
	// T5 scope: the cap may still reveal (budget wiring is T6); assert the
	// latch facts, not the settle timing.
	assert.equal(atCap.attaching, false);
	assert.equal(atCap.settledAt, 2500);
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
	assert.equal(afterSnapshot2.attaching, true, "T5 rebuilds views; the publish wiring is T6");
});

test("T5 c) loss with no closed frame keeps the old committed view (no fake refresh)", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "RETAINED SCREEN" },
			{ op: "status", witness: false },
			{ op: "output", text: "UNCLOSED CHUNK", syncClose: false },
			{ op: "advance", ms: 2500 },
		],
	});
	assertScenarioOk("loss-no-close", run);
	const [afterLoss, afterOutput, atCap] = readouts(run.parsed).slice(3);
	assert.equal(afterLoss.committedPreview, "RETAINED SCREEN");
	assert.equal(afterLoss.witnessLatched, true);
	assert.equal(afterOutput.committedPreview, "RETAINED SCREEN", "an unclosed chunk never commits a view");
	assert.equal(afterOutput.committedViewValid, true);
	assert.equal(atCap.committedPreview, "RETAINED SCREEN", "the cap reveals the retained view, not a fake refresh");
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
	assert.equal(atCap.attaching, false, "settles via the cap in T5 (budget wiring is T6)");
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
