// Issue #222 step 23a fix1 (task-23a-smoke-fix1-brief.md): focused REAL-Pi
// provider smoke for FW-08 (load proof), FW-02 (belowEditor/focus/selection/
// stop/mode switch/non-render reads with candidate semantics) and the 23a half of
// FW-05 (BOOT vs complete editor; regular no-sync/cursor-only is not a proof).
//
// The suite spawns the ACTUAL managed Pi launcher in a real PTY with an owned,
// isolated PI_CODING_AGENT_DIR, loads the repo-local probe (which embeds the pure
// diagnostic candidate evaluator) and drives only documented public controls. It
// makes NO model/network request, reads no credentials and changes no global
// config, so it is opt-in:
//
//   PI23A_SMOKE=1 node --test test/pi23a-smoke.test.mjs
//
// FACT BOUNDARY: headless PTY is not physical-pixel evidence, one run per cell is
// a witness (not a distribution), and passing this smoke is NOT A4/A5 acceptance.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = resolve(REPO_ROOT, "test-support/pi23a-smoke-runner.mjs");
const EVALUATOR = resolve(REPO_ROOT, "test-support/pi23a-candidate-evaluator.ts");
const enabled = process.env.PI23A_SMOKE === "1";
const smoke = enabled ? test : test.skip;
const reason = "set PI23A_SMOKE=1 to run the real-Pi provider smoke";

function runCell(tuiMode, { witness = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi23a-test-"));
	const artifactDir = join(root, "artifacts");
	const run = spawnSync(process.execPath, [RUNNER, artifactDir], {
		encoding: "utf8",
		timeout: 300_000,
		env: { ...process.env, PI23A_TUI_MODE: tuiMode, ...(witness ? { PI23A_WITNESS: "1" } : {}) },
	});
	return {
		run,
		artifactDir,
		result: existsSync(join(artifactDir, "result.json")) ? JSON.parse(readFileSync(join(artifactDir, "result.json"), "utf8")) : null,
		root,
	};
}

function assertCell(cell, tuiMode) {
	assert.equal(cell.run.status, 0, `runner exit for ${tuiMode}: ${cell.run.stdout}${cell.run.stderr}`);
	const result = cell.result;
	assert.ok(result !== null, `result.json written for ${tuiMode}`);
	assert.equal(result.status, "completed");

	// FW-08: the extension proves from INSIDE that Pi loaded it, byte-identically.
	const load = result.steps.load;
	assert.equal(load.loadCount, 1, "extension loaded exactly once");
	assert.equal(load.realpathMatches, true, "loaded probe is the owned copy");
	assert.equal(load.repoCopyByteIdentical, true, "loaded probe bytes equal the repo-authored probe");
	assert.equal(load.evaluatorSha256, load.expectedEvaluatorSha256, "the loaded diagnostic evaluator is byte-identical to the repo module");
	assert.equal(load.packages["@earendil-works/pi-coding-agent"]?.version, "1.4.0");
	assert.equal(load.packages["@earendil-works/pi-tui"]?.version, "1.4.0");

	// FW-02: public belowEditor sentinel, runtime focus accessor, real overlay.
	const boot = result.steps.bootAndEditor;
	assert.equal(boot.sessionStart.hasUI, true);
	assert.equal(boot.focusApi, "present");
	assert.equal(boot.mode, tuiMode);
	assert.ok(boot.sentinelRenderCount >= 1, "belowEditor sentinel rendered");
	assert.equal(result.steps.overlay.mounted, true, "public ctx.ui.custom overlay mounted");
	assert.ok(result.steps.overlay.rendered >= 1, "overlay rendered through the real renderer");
	assert.equal(result.steps.overlay.closed, true, "overlay closed through its documented done()");

	// FW-02: non-render size reads emit NO terminal operation and no candidate S.
	assert.equal(result.steps.nonRenderReads.terminalOpsDelta, 0, "non-render size reads emit no terminal op");
	assert.ok(result.steps.nonRenderReads.commandReads >= 2, "both columns and rows were read outside a pass");

	// FW-02 (fix1): the documented in-session mode switch works and keeps the
	// shared Terminal instance; the mode returns to the startup mode.
	const modeSwitch = result.steps.modeSwitch;
	assert.equal(modeSwitch.attempts.length, 2, "both switch directions were attempted");
	assert.equal(modeSwitch.allSwitchesChangedMode, true, "the documented /settings path changed the observed renderer mode");
	assert.equal(modeSwitch.sharedTerminalPreserved, true, "the shared Terminal instance survived the switch");
	assert.equal(modeSwitch.returnedToStartupMode, true, "the second switch returned to the startup mode");
	assert.equal(modeSwitch.verdict, "supported-by-documented-ui-control");

	// FW-02/FW-05 (fix1): candidate decisions with identity and exact pairing.
	const candidates = result.steps.candidates;
	assert.ok(candidates.counts.candidate >= 1, "sampling pairs opened candidates");
	assert.deepEqual(candidates.sWithoutF, [], "no S is left without F/A");
	const published = candidates.published;
	if (tuiMode === "fullscreen") {
		assert.ok(published.some((entry) => entry.kind === "S"), "a complete fullscreen editor frame is proven");
		assert.equal(published.filter((entry) => entry.kind === "A").length, 0, "a complete fullscreen write always finishes");
	} else {
		// Regular mode: every published S ends in F or A, and cursor-only/plain
		// output never publishes S (asserted from the reasons on the probe log).
		for (const entry of published.filter((item) => item.kind === "S")) {
			assert.equal(entry.reason, "before-sync-open", "a regular S precedes a real sync OPEN");
		}
	}
	assert.equal(published.filter((entry) => entry.kind === "S").length, published.filter((entry) => entry.kind === "F" || entry.kind === "A").length, "every S is closed by F or A");

	// FW-02/FW-07 (fix1): lifecycle evidence recorded INSIDE the extension.
	const stop = result.steps.stop;
	assert.equal(stop.probeStop, true);
	assert.equal(stop.shadowRestores.length, 7, "all seven instance-own shadows are restored on stop");
	assert.equal(stop.stopVerified.restored, 7);
	assert.deepEqual(stop.stopVerified.ownPropertiesRemaining, [], "no wrapper survives stop");
	assert.equal(stop.stopVerified.markerRecursionSeen, false);
	assert.equal(stop.shutdownAfterStop, true, "the actual session_shutdown event is recorded, not inferred");
	assert.equal(result.steps.exit.shutdownReason, "quit");
	assert.equal(result.steps.exit.exited, true);
	assert.equal(result.steps.exit.exitCode, 0);
	assert.equal(result.isolation.rootRemoved, true, "owned isolated root removed");
	// fix2 parent decision 1: frameId is one token-wide domain, strictly increasing
	// across rendererEpoch (mode-switch) changes.
	assert.equal(candidates.frameIdStrictlyIncreasingAcrossEpochs, true, "frameIds never reset or regress across mode switches");
	assert.ok(new Set(candidates.epochsAlongFrameIds).size >= 2, "the run really crossed a rendererEpoch boundary");
	assert.equal(new Set(candidates.frameIds).size, candidates.frameIds.length, "no frameId is reused within the token");
	// The open-stop witness runs in its own cell (a real terminal.stop() removes
	// stdin listeners), so the two main cells record it as skipped, not UNKNOWN.
	assert.equal(result.steps.openStopWitness.skipped, true);
	assert.deepEqual(result.unknown, [], "no subcase is left UNKNOWN in this run");
	return result;
}

smoke(`real Pi FW-08/FW-02/FW-05 fix1 smoke (fullscreen) [${reason}]`, () => {
	const cell = runCell("fullscreen");
	try {
		const result = assertCell(cell, "fullscreen");
		assert.equal(result.raw.altScreenEntered, true, "fullscreen uses the alternate screen");
	} finally {
		rmSync(cell.root, { recursive: true, force: true });
	}
});

smoke(`real Pi FW-08/FW-02/FW-05 fix1 smoke (regular) [${reason}]`, () => {
	const cell = runCell("regular");
	try {
		const result = assertCell(cell, "regular");
		// The regular STARTUP cell deliberately visits fullscreen during the switch,
		// so the alternate screen appears mid-stream; what matters is that the
		// startup mode was regular and the first switch reached fullscreen.
		assert.equal(result.steps.bootAndEditor.mode, "regular");
		assert.equal(result.steps.modeSwitch.attempts[0].after.mode, "fullscreen");
		assert.ok(result.probeEventCounts["terminal-op"] >= 1, "regular mode still emits outer terminal operations");
	} finally {
		rmSync(cell.root, { recursive: true, force: true });
	}
});

smoke(`real Pi fix2 open-stop witness cell (real terminal.stop) [${reason}]`, () => {
	const cell = runCell("fullscreen", { witness: true });
	try {
		assert.equal(cell.run.status, 0, `witness runner exit: ${cell.run.stdout}${cell.run.stderr}`);
		const result = cell.result;
		assert.equal(result.status, "completed");
		assert.equal(result.cell, "witness");
		// Real public Terminal lifecycle: pair -> terminal.stop() -> silent invalidation.
		const step = result.steps.openStopWitness;
		assert.equal(step.satisfied, true, "the real stop invalidated an open candidate");
		assert.ok(step.witness.openFrameId !== null, "the witness carries a candidate identity");
		assert.equal(step.witness.sEmittedBeforeStop, false);
		assert.equal(step.witness.stopDecisionKind, "none", "no S was emitted, so the invalidation is silent");
		assert.equal(step.witness.stopDecisionFrameId, step.witness.openFrameId, "the invalidation matches the candidate id");
		assert.equal(step.witness.finishForFrame, 0, "no F ever arrives for the invalidated frame");
		assert.equal(step.witness.stopDecisionReason, "terminal-stop-before-s");
		// The real stop removes stdin listeners, so the cell is honest about it.
		assert.equal(step.resumed.resumed, false);
		assert.match(step.resumed.reason, /removed stdin listeners/);
		// Restore-after-real-stop is still evidenced inside the extension.
		assert.equal(result.steps.stop.probeStop, false, "this cell never needed the control-channel stop");
		assert.equal(result.steps.stop.shadowRestores.length, 7);
		assert.equal(result.steps.stop.stopVerified.restored, 7);
		assert.deepEqual(result.steps.stop.stopVerified.ownPropertiesRemaining, []);
		assert.equal(result.steps.stop.stopVerified.reason, "open-stop-witness");
		// Frame ids stay strictly increasing across the one switch this cell performs.
		const ids = result.steps.candidates.frameIds;
		assert.equal(result.steps.candidates.frameIdStrictlyIncreasingAcrossEpochs, true);
		assert.ok(ids.includes(step.witness.openFrameId), "the witnessed frame id is part of the token-wide sequence");
		// Exit: stdin is gone, so the cell ends through Pi's real graceful SIGTERM.
		assert.equal(result.steps.exit.exitCode, 0);
		assert.equal(result.steps.exit.exitPath[0].input, "SIGTERM");
		// The only UNKNOWN is the structural one, and it is stated.
		assert.deepEqual(result.unknown.map((entry) => entry.what), ["session_shutdown event"]);
	} finally {
		rmSync(cell.root, { recursive: true, force: true });
	}
});
