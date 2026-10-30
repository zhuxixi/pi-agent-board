import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Issue #222 step 22 (task-22-brief.md): the OLD-SOURCE real-entry baseline for
// the two missing cells only — B (25 ms continuous) and Q (nonempty then quiet)
// — through the accepted step-18 real-entry topology and observer. The baseline
// now publishes through the modern complete-frame gate; one trial is a witness,
// never a distribution or P95.

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const scenarioPath = resolve(REPO_ROOT, "test-support/attach-entry-22-scenario.ts");

async function scenario() {
	return import(scenarioPath);
}

function runCli(t, caseId) {
	const artifactDir = mkdtempSync(join(tmpdir(), "s22-cli-"));
	t.after(() => rmSync(artifactDir, { recursive: true, force: true }));
	const child = spawn(process.execPath, ["--experimental-transform-types", scenarioPath, "--case", caseId, "--repeat", "1", "--clock", "real", "--artifact-dir", join(artifactDir, "trial")], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (c) => (stdout += c));
	child.stderr.on("data", (c) => (stderr += c));
	return new Promise((resolveWait) => {
		child.once("exit", (code) => {
			let parsed = null;
			try {
				parsed = JSON.parse(stdout.trim().split("\n").pop());
			} catch {
				/* keep null */
			}
			resolveWait({ code, parsed, stderr });
		});
	});
}

test("step 22: the B/Q literal family is declared independently and validated", async () => {
	const s = await scenario();
	const b0 = s.busyLiteral("B0", "busy");
	assert.equal(b0.length, 22);
	assert.equal(b0[0], "B0 HEADER busy work area");
	assert.equal(b0[19], "B0 TAIL assistant final answer");
	assert.equal(b0[21], "B0 INPUT >");
	assert.equal(s.modeFrameId(b0, "busy"), "B0");
	assert.equal(s.modeFrameId(s.busyLiteral("B17", "busy"), "busy"), "B17", "later busy ids are the same family");
	assert.equal(s.modeFrameId(s.busyLiteral("Q0", "quiet"), "quiet"), "Q0");
	assert.equal(s.modeFrameId(b0, "quiet"), null, "a busy frame is not a quiet frame");
	assert.equal(s.modeFrameId(["B0 HEADER busy work area"], "busy"), null, "a partial grid is not a family frame");
	const tampered = s.busyLiteral("B0", "busy");
	tampered[19] = "B0 TAIL tampered";
	assert.equal(s.modeFrameId(tampered, "busy"), null, "a tampered literal is rejected");
	assert.deepEqual(s.busyCursor("B0"), { x: "B0 INPUT >".length, y: 21, visible: false });
});

test("step 22/24 B: 25 ms continuous real-entry modern publish (correct content within budget)", async (t) => {
	const r = await runCli(t, "B");
	assert.equal(r.code, 0, `B must run (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed;
	assert.equal(tr.caseId, "B");
	assert.equal(tr.mode, "busy");
	assert.equal(tr.measured, true, "the real entry was measured");
	assert.equal(typeof tr.totalEntryMs, "number");
	// Milestone chain: select → resolver → overlay → connected → validated → parsed → committed.
	const tl = tr.timeline;
	assert.ok(tl.select !== null && tl.overlayMounted !== null && tl.connected !== null && tl.snapshotValidated !== null && tl.snapshotParsed !== null && tl.terminalCommitted !== null);
	assert.ok(tl.select <= tl.snapshotValidated && tl.snapshotValidated <= tl.terminalCommitted, "protocol validation precedes the outer commit");
	assert.equal(tr.ordering["overlayFactoryStart<=overlayMounted"], true);
	assert.equal(tr.ordering["overlayMounted<=terminalCommitted"], true);
	assert.equal(tr.childFrameComplete.state, "observed", "the child complete-frame write is attributable (frame id + sha + bytes)");
	assert.equal(tr.childFrameComplete.frameId, "B0");
	assert.match(tr.childFrameComplete.sha256, /^[0-9a-f]{64}$/);
	// Witness identity: four DIFFERENT frames are labelled distinctly, and the
	// measured anchor is the first complete CURRENT-generation outer commit.
	assert.match(tr.firstContentFrameId, /^B\d+$/, "the measured anchor is a current-generation B<n> frame");
	assert.equal(tr.firstContentWitnessKind, "first-complete-current-generation-outer-commit");
	assert.equal(tr.witnesses.fixtureSeed.frameId, "B0");
	assert.equal(tr.witnesses.fixtureSeed.kind, "fixture-seed-contract");
	assert.match(tr.witnesses.prewarmCurrentFrame.frameId, /^B\d+$/);
	assert.equal(tr.witnesses.prewarmCurrentFrame.kind, "prewarm-current-frame");
	assert.equal(tr.witnesses.childFirstCompleteFrame.frameId, "B0");
	assert.equal(tr.witnesses.childFirstCompleteFrame.kind, "child-authored-complete-write");
	assert.equal(tr.witnesses.measuredFirstContent.frameId, tr.firstContentFrameId);
	assert.match(tr.declared.measuredTo, /CURRENT generation/i, "measuredTo names the current generation, not the seed literal");
	assert.equal(tr.cursorOwnership.expectedFor, tr.firstContentFrameId, "the cursor expectation belongs to the actual first-content frame");
	assert.deepEqual(tr.cursorOwnership.projectedScreenExpected, { x: tr.cursorOwnership.logicalExpected.x, y: tr.cursorOwnership.logicalExpected.y + 1, visible: tr.cursorOwnership.logicalExpected.visible });
	// Continuity: 25 ms updates for the ENTIRE ≥3 s post-first-content window.
	assert.equal(tr.continuity.continuous, true);
	assert.ok(tr.continuity.childFramesAfterSeed >= 100, `continuous child frames: ${tr.continuity.childFramesAfterSeed}`);
	assert.ok(tr.continuity.windowMs >= 2950, `window: ${tr.continuity.windowMs}`);
	assert.ok(tr.hardCapOpportunityMs >= 2500, "the attach got its full 2500 ms opportunity");
	// Correctness gates.
	assert.equal(tr.correctness.completeLiteralGrid, true);
	assert.equal(tr.correctness.cursor.matched, true, `raw ${JSON.stringify(tr.correctness.cursor.rawOuterScreenCursor)} vs projected ${JSON.stringify(tr.correctness.cursor.projectedScreenExpected)}`);
	assert.equal(tr.correctness.zeroResize, true);
	assert.equal(tr.correctness.noHalfOrStaleFrame, true);
	assert.equal(tr.correctness.all, true);
	assert.equal(tr.detach.result.action, "detached", "real detach through the public input path");
	// ORDERED cleanup: documented runner `input` exit, host+runner exits, no forced kill.
	assert.equal(tr.orderedExit.inputDelivered, true, "the documented exit command was delivered on the real runner socket");
	assert.equal(tr.orderedExit.hostExited, true);
	assert.equal(tr.orderedExit.runnerExited, true);
	assert.equal(tr.cleanup.childKilled, false, "no forced child kill");
	assert.equal(tr.cleanup.runnerKilled, false, "no forced runner kill");
	assert.equal(tr.cleanup.runnerExitedByOrderedInput, true);
	assert.equal(tr.cleanup.ok, true, "cleanup.ok reflects the ordered sequence");
	assert.equal(tr.cleanup.rootRemoved, true, "the owned root was removed after evidence copy");
	// HONEST baseline: correct content is NOT fast.
	assert.equal(tr.fastAndCorrect, true, "the qualified complete frame publishes within the 200 ms hot-attach target");
	assert.equal(tr.target200ms.met, true);
	t.diagnostic(`B: total=${tr.totalEntryMs.toFixed(1)}ms component=${tr.componentMs.toFixed(1)}ms overlay=${tr.overlayMs.toFixed(2)}ms childFrames=${tr.continuity.childFramesAfterSeed} outerCommits=${tr.continuity.outerCommitsAfterFirst} fastAndCorrect=${tr.fastAndCorrect}`);
});

test("step 22/24 Q: nonempty-then-quiet real-entry modern publish (correct content within budget)", async (t) => {
	const r = await runCli(t, "Q");
	assert.equal(r.code, 0, `Q must run (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed;
	assert.equal(tr.caseId, "Q");
	assert.equal(tr.mode, "quiet");
	assert.equal(tr.measured, true);
	const tl = tr.timeline;
	assert.ok(tl.select !== null && tl.snapshotValidated !== null && tl.snapshotParsed !== null && tl.terminalCommitted !== null);
	assert.equal(tr.childFrameComplete.state, "observed");
	assert.equal(tr.childFrameComplete.frameId, "Q0");
	assert.equal(tr.continuity.quiet, true, "no child frame writes after the seed and no different-id commit");
	assert.equal(tr.continuity.childFramesAfterSeed, 0);
	assert.ok(tr.continuity.windowMs >= 950);
	assert.equal(tr.correctness.completeLiteralGrid, true);
	assert.equal(tr.correctness.cursor.matched, true);
	assert.equal(tr.correctness.zeroResize, true);
	assert.equal(tr.correctness.noHalfOrStaleFrame, true);
	assert.equal(tr.correctness.all, true);
	// Q witnesses coincide by construction and need no semantic change.
	assert.equal(tr.firstContentFrameId, "Q0");
	assert.equal(tr.witnesses.fixtureSeed.frameId, tr.witnesses.childFirstCompleteFrame.frameId);
	assert.equal(tr.witnesses.measuredFirstContent.frameId, "Q0");
	assert.equal(tr.cursorOwnership.expectedFor, "Q0");
	// ORDERED cleanup (same documented runner `input` exit; no forced kill).
	assert.equal(tr.orderedExit.inputDelivered, true);
	assert.equal(tr.orderedExit.hostExited, true);
	assert.equal(tr.orderedExit.runnerExited, true);
	assert.equal(tr.cleanup.childKilled, false);
	assert.equal(tr.cleanup.runnerKilled, false);
	assert.equal(tr.cleanup.runnerExitedByOrderedInput, true);
	assert.equal(tr.cleanup.ok, true, "cleanup.ok reflects the ordered sequence");
	assert.equal(tr.cleanup.rootRemoved, true);
	assert.equal(tr.fastAndCorrect, true, "the qualified complete frame publishes within the 200 ms target");
	assert.equal(tr.target200ms.met, true);
	t.diagnostic(`Q: total=${tr.totalEntryMs.toFixed(1)}ms component=${tr.componentMs.toFixed(1)}ms quiet=${tr.continuity.quiet} fastAndCorrect=${tr.fastAndCorrect}`);
});

test("step 22 CLI: an unsupported case fails with exit 2 and no stdout", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "s22-cli-reject-"));
	const child = spawn(process.execPath, ["--experimental-transform-types", scenarioPath, "--case", "S", "--repeat", "1", "--clock", "real", "--artifact-dir", join(artifactDir, "a")], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (c) => (stdout += c));
	child.stderr.on("data", (c) => (stderr += c));
	const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
	assert.equal(code, 2);
	assert.equal(stdout, "");
	assert.ok(stderr.length > 0);
	rmSync(artifactDir, { recursive: true, force: true });
});
