import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Issue #222 step 21B (task-21b-brief.md): A4 target geometry, A5 empty/cold
// startup, C poison+boot-before-editor (all DELAYED >250/<2500), plus the
// SEPARATE legacy contracts (unframed settle/hard-cap; forced legacy jiggle).
// Modern contract assertions are TRUE-DIRECTION (the current source is expected
// to FAIL them: named 21B REDs). Legacy compatibility cases must PASS where the
// old behavior is correct, and are never described as modern readiness.

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const scenarioPath = resolve(REPO_ROOT, "test-support/pty-attach-21b-scenario.ts");

async function scenario() {
	return import(scenarioPath);
}

function runCli(t, caseId) {
	const artifactDir = mkdtempSync(join(tmpdir(), "s21b-cli-"));
	t.after(() => rmSync(artifactDir, { recursive: true, force: true }));
	const child = spawn(process.execPath, ["--experimental-transform-types", scenarioPath, "--case", caseId, "--artifact-dir", join(artifactDir, "trial")], {
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

const commit = (rows, at = 0, kind = "frame") => ({ index: 0, at, kind, note: null, rows, cursor: { x: 0, y: 0, visible: false } });

// ---------------------------------------------------------------------------
// Pure oracle negatives
// ---------------------------------------------------------------------------

test("step 21B: geometry gate requires exactly one applied target resize and real child dims", async () => {
	const s = await scenario();
	const target = { cols: 80, rows: 22 };
	const clean = s.evaluateGeometryGate({
		resizeCommands: [{ cols: 80, rows: 22, at: 0 }],
		appliedAcks: [{ at: 1, value: "resize_applied" }],
		childLiveDims: [{ cols: 80, rows: 22, at: 2 }],
		expectedTarget: target,
		targetFrameAt: 5,
	});
	assert.equal(clean.ok, true);
	const zero = s.evaluateGeometryGate({ resizeCommands: [], appliedAcks: [], childLiveDims: [], expectedTarget: target, targetFrameAt: 5 });
	assert.equal(zero.exactlyOneResize, false, "no resize is not the target geometry");
	const two = s.evaluateGeometryGate({
		resizeCommands: [{ cols: 80, rows: 22, at: 0 }, { cols: 80, rows: 22, at: 1 }],
		appliedAcks: [{ at: 2, value: null }],
		childLiveDims: [{ cols: 80, rows: 22, at: 3 }],
		expectedTarget: target,
		targetFrameAt: 5,
	});
	assert.equal(two.exactlyOneResize, false, "two resizes fail the exactly-one gate");
	const wrongTarget = s.evaluateGeometryGate({
		resizeCommands: [{ cols: 100, rows: 28, at: 0 }],
		appliedAcks: [{ at: 1, value: null }],
		childLiveDims: [{ cols: 80, rows: 22, at: 2 }],
		expectedTarget: target,
		targetFrameAt: 5,
	});
	assert.equal(wrongTarget.resizeTargetsCorrectly, false);
	assert.equal(wrongTarget.ok, false);
	const noAck = s.evaluateGeometryGate({ resizeCommands: [{ cols: 80, rows: 22, at: 0 }], appliedAcks: [], childLiveDims: [{ cols: 80, rows: 22, at: 1 }], expectedTarget: target, targetFrameAt: 5 });
	assert.equal(noAck.appliedBeforeTargetFrame, false, "no applied ack fails");
	const noLive = s.evaluateGeometryGate({ resizeCommands: [{ cols: 80, rows: 22, at: 0 }], appliedAcks: [{ at: 1, value: null }], childLiveDims: [], expectedTarget: target, targetFrameAt: 5 });
	assert.equal(noLive.ok, false, "no real child pty-resize fails");
	const ackAfterFrame = s.evaluateGeometryGate({
		resizeCommands: [{ cols: 80, rows: 22, at: 0 }],
		appliedAcks: [{ at: 9, value: null }],
		childLiveDims: [{ cols: 80, rows: 22, at: 1 }],
		expectedTarget: target,
		targetFrameAt: 5,
	});
	assert.equal(ackAfterFrame.appliedBeforeTargetFrame, false, "an ack after the target frame is not ordering");
});

test("step 21B: pre-boundary gate rejects old-geometry, boot, partial-editor and early-hook releases", async () => {
	const s = await scenario();
	const literal = ["E1 HEADER", "E1 TAIL assistant final answer", "", "E1 INPUT >"];
	assert.equal(s.evaluatePreBoundary([commit(["", ""]), commit(["  ⠋ Loading \"s21b\"…"])], literal, { colorProbe: 0, schemeBridge: 0 }).ok, true);
	// Old-geometry / boot / partial editor content before the target frame fails.
	assert.equal(s.evaluatePreBoundary([commit(["G1 HEADER geometry 100x28"])], literal, { colorProbe: 0, schemeBridge: 0 }).ok, false, "old geometry content fails");
	assert.equal(s.evaluatePreBoundary([commit(["fake pi boot: core ready"])], literal, { colorProbe: 0, schemeBridge: 0 }).ok, false, "boot text fails");
	assert.equal(s.evaluatePreBoundary([commit(["E1 HEADER", "E1 INPUT >"])], literal, { colorProbe: 0, schemeBridge: 0 }).ok, false, "a partial editor (half frame) fails");
	// First hooks before the complete frame fail even with only loading commits.
	const earlyHook = s.evaluatePreBoundary([commit(["  ⠋ Loading \"s21b\"…"])], literal, { colorProbe: 1, schemeBridge: 0 });
	assert.equal(earlyHook.ok, false);
	assert.equal(earlyHook.firstHook.colorProbe, 1);
});

test("step 21B: poison gate requires a real plant and zero observation/write hits", async () => {
	const s = await scenario();
	const marker = "OLD-LOG-POISON";
	const planted = s.evaluatePoison({ marker, plantReadbackContained: true, commits: [commit(["", ""])], writes: [{ data: "ordinary" }] });
	assert.equal(planted.ok, true);
	assert.equal(s.evaluatePoison({ marker, plantReadbackContained: false, commits: [], writes: [] }).ok, false, "an unplanted marker is vacuous");
	assert.equal(s.evaluatePoison({ marker, plantReadbackContained: true, commits: [commit([`${marker} line one`])], writes: [] }).observationHits, 1);
	assert.equal(s.evaluatePoison({ marker, plantReadbackContained: true, commits: [], writes: [{ data: marker }] }).writeHits, 1);
	assert.equal(s.evaluatePoison({ marker, plantReadbackContained: true, commits: [commit([`${marker} line one`])], writes: [] }).ok, false, "poison visible fails");
	// Old-identity scan: only the current editor identity may appear.
	assert.deepEqual(s.oldIdentityCommits([commit(["E1 HEADER"]), commit(["G1 HEADER"])], ["E1"]).length, 1);
	assert.deepEqual(s.oldIdentityCommits([commit(["E1 HEADER"])], ["E1"]).length, 0);
});

test("step 21B: a MODERN fast path on the legacy shape fails; settle/hard-cap deadlines pass", async () => {
	const s = await scenario();
	// The modern budget must never be used to judge the legacy path.
	const modernOnly = s.evaluateLegacyReveal({ firstHookAt: 20, parserWrites: [{ at: 0 }] });
	assert.equal(modernOnly.modernFastPath, true, "a reveal inside the modern budget on the legacy path is a modern-fast-path violation");
	assert.equal(modernOnly.ok, false, "modern-before-settle misuse must fail on the legacy shape");
	// The 250 ms settle after the last output is the legacy deadline.
	const settle = s.evaluateLegacyReveal({ firstHookAt: 300, parserWrites: [{ at: 0 }] });
	assert.equal(settle.revealedBySettle, true);
	assert.equal(settle.ok, true);
	// Continuous output deferring the settle to the 2500 ms hard cap is also legacy-legal.
	const hardCap = s.evaluateLegacyReveal({ firstHookAt: 2500, parserWrites: [{ at: 2450 }] });
	assert.equal(hardCap.revealedByHardCap, true);
	assert.equal(hardCap.ok, true);
	assert.equal(hardCap.modernFastPath, false);
	// A reveal between the mount settle and the hard cap is legacy-legal (real
	// output can defer the settle); the per-output delay is evidence only.
	const inBetween = s.evaluateLegacyReveal({ firstHookAt: 1200, parserWrites: [{ at: 1100 }] });
	assert.equal(inBetween.ok, true, "a settle-deferred legacy reveal is legal");
	assert.equal(inBetween.revealDelayMs, 100, "the per-output delay is still recorded as evidence");
	// Beyond the hard cap (+tolerance) fails.
	assert.equal(s.evaluateLegacyReveal({ firstHookAt: 3000, parserWrites: [{ at: 2900 }] }).ok, false, "a reveal beyond the hard cap fails");
	// Legacy constants must stay untouched.
	const timers = s.evaluateLegacyTimers({ settlePublishedAt: 250, hardCapAt: 2500 });
	assert.equal(timers.ok, true);
	assert.equal(timers.settle, 250);
	assert.equal(timers.hardCap, 2500);
	assert.equal(timers.modernBudget, 30);
});

// ---------------------------------------------------------------------------
// Real integration (real pipeline, virtual attach timers)
// ---------------------------------------------------------------------------

test("step 26 A4 CONTRACT: target-geometry redraw publishes at its boundary; stale geometry stays masked (modern reporter GREEN)", async (t) => {
	const r = await runCli(t, "A4");
	assert.equal(r.code, 0, `A4 must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed?.trials?.[0];
	const ev = tr.evidence;
	assert.equal(ev.geometry.ok, true, "exactly one real target resize, applied, with a real child pty-resize");
	assert.equal(ev.geometry.exactlyOneResize, true);
	assert.deepEqual(ev.geometry.expectedTarget, { cols: 80, rows: 22 });
	t.diagnostic(`A4: pre-boundary classes=${JSON.stringify(ev.preGate.classes)} publish@${ev.publishAt} complete@${ev.completeFrameAt} conditional=${ev.publishedInBudgetConditional}`);
	assert.equal(ev.cursor.projectedExpectedScreen.y, ev.cursor.logicalExpected.y + ev.cursor.bodyTop);
	// CONTRACT (true direction): nothing but loading/blank may publish and no first
	// hook may fire before the independently complete CURRENT target frame.
	assert.equal(ev.preGate.ok, true, `CONTRACT: stale-geometry/arbitrary-close content must stay masked (old source published ${JSON.stringify(ev.preGate.classes.filter((k) => k !== "loading" && k !== "blank"))})`);
	assert.equal(ev.publishedInBudget, true, "CONTRACT: the target frame publishes within the modern budget");
	assert.equal(ev.cursor.matched, true, "CONTRACT: the publish cursor matches the projected target-geometry cursor");
	assert.equal(ev.ordering.ok, true, "CONTRACT: drain/render sequence precedes the publish");
	assert.deepEqual(ev.hooksAfter, { colorProbe: 1, schemeBridge: 1 }, "CONTRACT: first hooks exactly once at the target publish");
});

test("step 29 A5 CONTRACT: modern reporter cold startup publishes only the complete editor", async (t) => {
	const r = await runCli(t, "A5");
	assert.equal(r.code, 0, `A5 must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const ev = r.parsed.trials[0].evidence;
	assert.equal(ev.emptyBaseline, true, "the authoritative baseline really was empty before the mount");
	t.diagnostic(`A5: bootGate=${ev.bootGate.ok} partialGate=${ev.partialGate.ok} publish@${ev.publishAt} complete@${ev.completeFrameAt}`);
	assert.equal(ev.bootGate.ok, true, `CONTRACT: boot/raw-mode/paste stages must not publish or fire hooks (old source classes ${JSON.stringify(ev.bootGate.classes.filter((k) => k !== "loading" && k !== "blank"))}, firstHook ${JSON.stringify(ev.bootGate.firstHook)})`);
	assert.equal(ev.partialGate.ok, true, `CONTRACT: the partial editor upper half must not publish (old source classes ${JSON.stringify(ev.partialGate.classes.filter((k) => k !== "loading" && k !== "blank"))})`);
	assert.equal(ev.partialHalfFrames, 0, "no half editor is ever a publish target");
	assert.equal(ev.publishedInBudget, true, "CONTRACT: the complete editor publishes within the modern budget");
	assert.equal(ev.cursor.matched, true);
	assert.equal(ev.ordering.ok, true, `drain/render ordering: ${JSON.stringify(ev.ordering)}`);
	assert.deepEqual(ev.hooksAfter, { colorProbe: 1, schemeBridge: 1 });
	assert.equal(ev.oldContentHits, 0, "no old content");
	assert.equal(ev.frameWitness?.ok, true, "A5 has a real reporter/current-child proof witness");
	assert.equal(ev.frameWitness?.records?.length, 2);
	assert.equal(ev.frameWitness?.fRecords, 1);
	assert.equal(ev.frameWitness?.component?.committedView !== null, true);
	assert.equal(ev.frameWitness?.component?.publishabilityState, "ready");
});

test("step 21B C CONTRACT: planted poison never surfaces; boot-before-editor is not readiness (modern GREEN)", async (t) => {
	const r = await runCli(t, "C");
	assert.equal(r.code, 0, `C must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const ev = r.parsed.trials[0].evidence;
	assert.equal(ev.emptyBaseline, true);
	assert.equal(ev.poisonGate.plantReadbackContained, true, "the poison plant really landed in the retained screen.log");
	assert.equal(ev.poisonGate.observationHits, 0, "no observation ever carried the poison");
	assert.equal(ev.poisonGate.writeHits, 0, "no outer write ever carried the poison");
	assert.equal(ev.poisonGate.ok, true);
	t.diagnostic(`C: bootGate=${ev.bootGate.ok} partialGate=${ev.partialGate.ok} poison=${ev.poisonGate.ok} publish@${ev.publishAt}`);
	assert.equal(ev.bootGate.ok, true, `CONTRACT: boot text before the editor must not publish or fire hooks (old source classes ${JSON.stringify(ev.bootGate.classes.filter((k) => k !== "loading" && k !== "blank"))}, firstHook ${JSON.stringify(ev.bootGate.firstHook)})`);
	assert.equal(ev.partialGate.ok, true, "CONTRACT: the partial editor must not publish");
	assert.equal(ev.publishedInBudget, true, "CONTRACT: the complete editor publishes within the modern budget");
	assert.equal(ev.cursor.matched, true);
	assert.deepEqual(ev.hooksAfter, { colorProbe: 1, schemeBridge: 1 }, "first hooks only at the complete editor");
	assert.equal(ev.oldContentHits, 0);
});

test("step 23b2c3b/24 C fixture: empty → boot/partial no proof → complete current editor publishes", async (t) => {
	const r = await runCli(t, "C");
	assert.equal(r.code, 0, `C diagnostic must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const ev = r.parsed?.trials?.[0]?.evidence;
	const fw = ev?.frameWitness;
	assert.equal(fw?.ok, true, JSON.stringify(fw));
	assert.equal(ev.emptyBaseline, true);
	assert.equal(fw.snapshotBeginViewProof.status, "unknown", "empty baseline has explicit UNKNOWN coverage");
	assert.equal(fw.snapshotBeginViewProof.reason, "empty-baseline");
	assert.equal(fw.snapshotEndViewProof.status, "unknown");
	assert.equal(fw.proofBeforeComplete.length, 0, "BOOT/raw/partial stages emit no viewProof records");
	assert.equal(fw.completedBeforeComplete, 0, "no completed F before the complete editor");
	assert.equal(fw.records.length, 2);
	assert.deepEqual(fw.records.map((record) => record.marker), ["S", "F"]);
	assert.equal(fw.records.every((record) => record.frameId === 1), true);
	assert.equal(fw.fSeqIsPrecedingOutput, true, "F.seq is the exact preceding ordinary output seq");
	assert.deepEqual(fw.fMetadata, {
		protocol: 1,
		cols: 80,
		rows: 22,
		mode: "fullscreen",
		rendererEpoch: 1,
		sessionEpoch: 1,
		focusPresent: true,
		overlayPresent: false,
		intentId: 0,
		geometryRevision: 0,
	});
	assert.equal(fw.lateSnapshotEndViewProof.status, "covered");
	assert.equal(fw.lateSnapshotEndViewProof.proof.marker, "F");
	assert.equal(fw.lateSnapshotEndViewProof.proof.seq <= fw.lateSnapshotEndViewProof.throughSeq, true);
	assert.equal(fw.lateSnapshotEndViewProof.cursorVisible, false, "DECTCEM-only trailing updates visibility, not readiness");
	assert.equal(fw.component.latestViewProof.status, "covered");
	assert.equal(Array.isArray(fw.component.viewProofRecords), true, "component stores the baseline record list as a protocol fact");
	assert.equal(fw.component.viewProofRecords.length >= 2, true, "live S/F records reached the component");
	assert.equal(fw.component.viewProofRecordCount >= 2, true);
	assert.equal(fw.component.firstAttachSideEffectsApplied, true);
	assert.equal(fw.component.publishabilityState, "ready", "ready follows the actual qualified publish, not the proof flag alone");
	assert.equal(fw.component.committedView !== null, true, "hydration commits a complete visible view only after the internal frame closes");
	assert.equal(fw.component.committedView.rows > 0, true);
	assert.equal(fw.component.committedView.cursor !== null, true);
	assert.equal(ev.bootGate.ok, true, "BOOT/raw-mode never releases the attach");
	assert.equal(ev.partialGate.ok, true, "the partial editor never releases the attach");
	assert.equal(ev.publishedInBudget, true);
	assert.equal(ev.publishedInBudgetConditional, false, "the complete-editor publish is independent of an earlier release");
	assert.deepEqual(ev.hooksAfter, { colorProbe: 1, schemeBridge: 1 });
	assert.equal(ev.poisonGate.ok, true);
	assert.equal(ev.cursor.matched, true);
	assert.equal(ev.cleanup.ok, true);
	assert.equal(ev.cleanup.childExited, true);
	assert.equal(ev.cleanup.runnerExitCode, 0);
	assert.deepEqual(ev.cleanup.forcedKills, []);
	assert.equal(ev.cleanup.rootRemoved, true);
});

test("step 21B legacy unframed: no modern fast path; the legacy deadlines still govern (compatible PASS)", async (t) => {
	const r = await runCli(t, "L-unframed");
	assert.equal(r.code, 0, `L-unframed must run (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr?.ok, true, JSON.stringify(tr?.error ?? tr));
	const ev = tr.evidence;
	assert.equal(ev.timers.ok, true, "legacy constants untouched (settle 250 / hard cap 2500 / modern 30)");
	assert.equal(ev.reveal.modernFastPath, false, "no modern fast path on the unframed shape");
	assert.equal(ev.reveal.revealedAtLegacyDeadline, true, "the reveal happens at a legacy deadline only");
	assert.equal(ev.reveal.revealedBySettle || ev.reveal.revealedByHardCap, true, "the reveal follows the original settle or hard-cap deadline (continuous output may defer to the cap)");
	assert.deepEqual(ev.hooksAfter, { colorProbe: 1, schemeBridge: 1 }, "hooks exactly once");
	t.diagnostic(`L-unframed: reveal@${ev.reveal.firstContentAt} settleDelay=${ev.reveal.revealDelayMs} hardCapDelay=${ev.reveal.hardCapDelayMs}`);
});

test("step 21B forced legacy: no subscribe/snapshot, real jiggle, public detach, env restored (compatible PASS)", async (t) => {
	const r = await runCli(t, "L-forced");
	assert.equal(r.code, 0, `L-forced must run (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr?.ok, true, JSON.stringify(tr?.error ?? tr));
	const ev = tr.evidence;
	assert.equal(ev.subscribeCount, 0, "forced legacy sends no subscribe_terminal");
	assert.equal(ev.snapshotMessageCount, 0, "forced legacy sees no snapshot messages");
	assert.equal(ev.jiggleOrderOk, true, "shrink then restore, in order");
	assert.ok(ev.resizeCommands.length >= 2);
	assert.equal(ev.reveal.revealedAtLegacyDeadline, true);
	assert.equal(ev.reveal.modernFastPath, false);
	assert.equal(ev.detachDone.action, "detached", "public detach through the real input path");
	assert.equal(ev.envRestored, true, "AGENT_BOARD_TERMINAL_SNAPSHOT restored");
	assert.equal(ev.timers.ok, true);
});

test("step 21B CLI: an unsupported case fails with exit 2 and no stdout", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "s21b-cli-reject-"));
	const child = spawn(process.execPath, ["--experimental-transform-types", scenarioPath, "--case", "A6", "--artifact-dir", join(artifactDir, "a")], { stdio: ["ignore", "pipe", "pipe"] });
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
