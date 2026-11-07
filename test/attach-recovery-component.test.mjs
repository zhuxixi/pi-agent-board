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
