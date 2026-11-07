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
