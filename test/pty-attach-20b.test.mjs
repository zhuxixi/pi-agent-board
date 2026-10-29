import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Issue #222 step 20B-RU fix2 (task-20b-ru-fix2-brief.md): R/U cells. Pure
// oracle negatives (vacuous reset, 0->0 initial hooks, missing restore,
// F0-after-F1/mixed halves/foreign generation) plus real-runner CLI smokes with
// a named assertion for every claimed field. No D30 rerun, no old 20A/S/T/A4/A5
// trials, no formal1660/U1-U3/verify/perf.

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const scenarioPath = resolve(REPO_ROOT, "test-support/pty-attach-20b-scenario.ts");

async function scenario() {
	return import(scenarioPath);
}

function runCli(t, args) {
	const artifactDir = mkdtempSync(join(tmpdir(), "s20b-cli-"));
	t.after(() => rmSync(artifactDir, { recursive: true, force: true }));
	const child = spawn(process.execPath, ["--experimental-transform-types", scenarioPath, ...args, "--artifact-dir", join(artifactDir, "trial")], {
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

// ---------------------------------------------------------------------------
// Pure helpers and pure negatives (RED/GREEN)
// ---------------------------------------------------------------------------

test("step 20B: syncMarkerPresence detects any synchronized marker (unframed requires none)", async () => {
	const s = await scenario();
	assert.equal(s.syncMarkerPresence("plain text\r\n").allUnframed, true);
	assert.equal(s.syncMarkerPresence("plain \u001b[?2026h sync").allUnframed, false);
	assert.equal(s.syncMarkerPresence("plain \u001b[?2026l sync").allUnframed, false);
	const both = s.syncMarkerPresence("\u001b[?2026h frame \u001b[?2026l");
	assert.equal(both.hasOpen, true);
	assert.equal(both.hasClose, true);
});

test("step 20B: generationRowsContain matches the whole generation token, never a substring prefix", async () => {
	const s = await scenario();
	assert.equal(s.generationRowsContain(["gen-1 F0 HEADER controlled generation surface"], "gen-1"), true);
	assert.equal(s.generationRowsContain(["gen-10 F0 HEADER"], "gen-1"), false, "gen-10 must not match gen-1");
	assert.equal(s.generationRowsContain(["gen-2 F0 TAIL"], "gen-2"), true);
});

test("step 20B: classifyWindowRows separates content halves from loading/blank/chrome/foreign windows", async () => {
	const s = await scenario();
	const gen = { generation: "gen-1" };
	assert.equal(s.classifyWindowRows(["gen-1 F0 HEADER x"], gen), "content-f0");
	assert.equal(s.classifyWindowRows(["gen-1 F1 HEADER x"], gen), "content-f1");
	assert.equal(s.classifyWindowRows(["gen-1 F0 HEADER x", "gen-1 F1 TAIL y"], gen), "content-mixed");
	assert.equal(s.classifyWindowRows(["gen-2 F0 HEADER x"], gen), "content-foreign");
	assert.equal(s.classifyWindowRows(["", "", ""], gen), "blank");
	assert.equal(s.classifyWindowRows(["⠋ Loading \"s15\"…"], gen), "loading");
	assert.equal(s.classifyWindowRows([" s15 attached · opens links · Ctrl+←/Ctrl+\\ detach"], gen), "chrome");
});

test("step 20B: analyzeGenerationWindow fails on F0-after-F1, mixed halves and foreign content (pure negatives)", async () => {
	const s = await scenario();
	const gen = { generation: "gen-1" };
	const seed = [{ at: 1, rows: ["gen-1 F0 HEADER x"] }];
	const target = [{ at: 2, rows: ["gen-1 F1 HEADER x"] }];
	const ok = s.analyzeGenerationWindow([...seed, { at: 2, rows: [] }, ...target], gen);
	assert.equal(ok.ok, true, "seed before target, blank in between");
	assert.equal(ok.f1AfterF0, true);
	assert.equal(ok.f0AfterF1, false);

	const f0AfterF1 = s.analyzeGenerationWindow([...seed, ...target, { at: 3, rows: ["gen-1 F0 HEADER x"] }], gen);
	assert.equal(f0AfterF1.f0AfterF1, true);
	assert.equal(f0AfterF1.ok, false, "a seed frame AFTER the continuation must fail");

	const mixed = s.analyzeGenerationWindow([...seed, ...target, { at: 3, rows: ["gen-1 F1 UPPER x", "gen-1 F0 TAIL y"] }], gen);
	assert.equal(mixed.mixedHalves, true);
	assert.equal(mixed.ok, false, "a mixed F0/F1 half must fail");

	const foreign = s.analyzeGenerationWindow([...seed, ...target, { at: 3, rows: ["gen-2 F1 HEADER x"] }], gen);
	assert.equal(foreign.foreignContent, true);
	assert.equal(foreign.ok, false, "another generation must fail");

	const outOfOrder = s.analyzeGenerationWindow([...target, ...seed], gen);
	assert.equal(outOfOrder.f1AfterF0, false);
	assert.equal(outOfOrder.ok, false, "target before seed is out of order");
});

test("step 20B: analyzeRestartWindow fails when no reset/loading observation exists (anti-vacuous)", async () => {
	const s = await scenario();
	const input = { emptyEndAt: 10, staleGeneration: "gen-1", gen2Generation: "gen-2", poisonMarker: "s20b-poison", poisonPlanted: true };
	// Old content is visible before the baseline (non-vacuity) but NOTHING
	// resets afterwards: the scan must FAIL instead of passing vacuously.
	const noReset = s.analyzeRestartWindow(
		[
			{ at: 5, rows: ["gen-1 F0 HEADER x"] },
			{ at: 11, rows: ["gen-1 F0 HEADER x"] },
			{ at: 12, rows: ["gen-2 F0 HEADER x"] },
		],
		input,
	);
	assert.equal(noReset.recoveryKind, "missing");
	assert.equal(noReset.recoveryIndex, -1);
	assert.equal(noReset.ok, false, "missing reset must fail");

	// A reset followed by gen-2 content is the only passing shape.
	const withReset = s.analyzeRestartWindow(
		[
			{ at: 5, rows: ["gen-1 F0 HEADER x"] },
			{ at: 11, rows: ["gen-1 F0 HEADER x"] },
			{ at: 12, rows: ["", ""] },
			{ at: 13, rows: ["gen-2 F0 HEADER x"] },
		],
		input,
	);
	assert.equal(withReset.recoveryKind, "blank");
	assert.equal(withReset.ok, true);
	assert.deepEqual(withReset.newStaleRowsAfterBaseline, [], "the pre-existing gen-1 frame is not NEW stale content");

	// NEW stale content after the baseline, or stale content after the reset, fails.
	const newStale = s.analyzeRestartWindow(
		[
			{ at: 5, rows: ["gen-1 F0 HEADER x"] },
			{ at: 11, rows: ["", ""] },
			{ at: 12, rows: ["gen-1 NEW-FRAME HEADER x"] },
			{ at: 13, rows: ["gen-2 F0 HEADER x"] },
		],
		input,
	);
	assert.equal(newStale.ok, false, "new stale content after the baseline must fail");

	const staleAfterReset = s.analyzeRestartWindow(
		[
			{ at: 5, rows: ["gen-1 F0 HEADER x"] },
			{ at: 11, rows: ["", ""] },
			{ at: 12, rows: ["gen-1 F0 HEADER x"] },
			{ at: 13, rows: ["gen-2 F0 HEADER x"] },
		],
		input,
	);
	assert.equal(staleAfterReset.oldGenRowsAfterRecovery.length > 0, true);
	assert.equal(staleAfterReset.ok, false, "stale content after the reset must fail");
});

test("step 20B: analyzeRestartWindow poison gates are non-vacuous (unplanted fails, planted poison row fails)", async () => {
	const s = await scenario();
	const base = [
		{ at: 5, rows: ["gen-1 F0 HEADER x"] },
		{ at: 12, rows: ["", ""] },
		{ at: 13, rows: ["gen-2 F0 HEADER x"] },
	];
	const unplanted = s.analyzeRestartWindow(base, {
		emptyEndAt: 10,
		staleGeneration: "gen-1",
		gen2Generation: "gen-2",
		poisonMarker: "s20b-poison",
		poisonPlanted: false,
	});
	assert.deepEqual(unplanted.postEmptyPoisonObservations, []);
	assert.equal(unplanted.poisonObservationGateOk, false, "empty poison arrays without a plant must fail");
	assert.equal(unplanted.ok, false, "an unplanted marker makes the poison gate vacuous, so the analysis fails");

	const plantedPoison = s.analyzeRestartWindow(
		[
			{ at: 5, rows: ["gen-1 F0 HEADER x"] },
			{ at: 12, rows: ["s20b-poison poisoned stale retained screen.log line"] },
			{ at: 13, rows: ["", ""] },
			{ at: 14, rows: ["gen-2 F0 HEADER x"] },
		],
		{ emptyEndAt: 10, staleGeneration: "gen-1", gen2Generation: "gen-2", poisonMarker: "s20b-poison", poisonPlanted: true },
	);
	assert.equal(plantedPoison.postEmptyPoisonObservations.length, 1, "the planted marker is detected in a post-empty observation");
	assert.equal(plantedPoison.postEmptyPoisonObservations[0].index, 0);
	assert.equal(plantedPoison.poisonObservationGateOk, false);
	assert.equal(plantedPoison.ok, false, "poison after the baseline must fail");

	const plantedClean = s.analyzeRestartWindow(base, {
		emptyEndAt: 10,
		staleGeneration: "gen-1",
		gen2Generation: "gen-2",
		poisonMarker: "s20b-poison",
		poisonPlanted: true,
	});
	assert.deepEqual(plantedClean.postEmptyPoisonObservations, []);
	assert.equal(plantedClean.poisonObservationGateOk, true);
	assert.equal(plantedClean.ok, true);
});

test("step 20B: analyzeRestartWindow reports postEmptyStaleObservations strictly and keeps it OUT of ok", async () => {
	const s = await scenario();
	const input = { emptyEndAt: 10, staleGeneration: "gen-1", gen2Generation: "gen-2", poisonMarker: "s20b-poison", poisonPlanted: true };
	// The current baseline: the old grid persists for a moment through
	// baseline-consumption latency, recorded once by an observer sync-entry
	// snapshot, while no NEW stale content and no post-reset stale content exist.
	const persistence = s.analyzeRestartWindow(
		[
			{ at: 5, rows: ["gen-1 F0 HEADER x"] },
			{ at: 11, rows: ["gen-1 F0 HEADER x"], kind: "unframed", note: "sync-entry" },
			{ at: 12, rows: ["", ""] },
			{ at: 13, rows: ["gen-2 F0 HEADER x"] },
		],
		input,
	);
	assert.equal(persistence.postEmptyStaleObservations.length, 1, "the strict array records the persistence window");
	assert.equal(persistence.postEmptyStaleObservations[0].kind, "unframed");
	assert.equal(persistence.postEmptyStaleObservations[0].note, "sync-entry");
	assert.equal(persistence.postEmptyStaleObservations[0].poisonRows.length, 0);
	assert.equal(persistence.strictPostEmptyPresentationClean, false, "strict presentation is NOT clean and is never forced");
	assert.equal(persistence.stalePixelPersistenceObservations.length, 1);
	assert.equal(persistence.stalePixelPersistenceLatencyMs, 2);
	assert.deepEqual(persistence.newStaleRowsAfterBaseline, [], "persistence is not NEW stale content");
	assert.deepEqual(persistence.oldGenRowsAfterRecovery, []);
	assert.equal(persistence.ok, true, "harness/evidence validity is independent of the strict presentation gate");

	const clean = s.analyzeRestartWindow(
		[
			{ at: 5, rows: ["gen-1 F0 HEADER x"] },
			{ at: 12, rows: ["", ""] },
			{ at: 13, rows: ["gen-2 F0 HEADER x"] },
		],
		input,
	);
	assert.deepEqual(clean.postEmptyStaleObservations, []);
	assert.equal(clean.strictPostEmptyPresentationClean, true);
	assert.equal(clean.ok, true);

	// Strict is derived, never asserted independently of the array.
	assert.equal(persistence.strictPostEmptyPresentationClean, persistence.postEmptyStaleObservations.length === 0);
});

test("step 20B: analyzePostEmptyWrites gates stale and poison bytes after the empty baseline (pure negatives)", async () => {
	const s = await scenario();
	const input = { emptyEndAt: 10, staleGeneration: "gen-1", poisonMarker: "s20b-poison" };
	// Pre-baseline stale bytes are allowed and recorded (non-vacuity).
	const clean = s.analyzePostEmptyWrites(
		[
			{ index: 8, receivedAt: 5, data: "gen-1 F0 HEADER x" },
			{ index: 9, receivedAt: 9, data: "gen-1 F0 TAIL y" },
			{ index: 12, receivedAt: 11, data: "\u001b[2J\u001b[1;1H" },
		],
		input,
	);
	assert.deepEqual(clean.staleWrites, []);
	assert.deepEqual(clean.poisonWrites, []);
	assert.deepEqual(clean.lastStaleWrite, { index: 9, receivedAt: 9 }, "the last pre-baseline stale write is retained");
	assert.equal(clean.ok, true);

	const staleAfter = s.analyzePostEmptyWrites(
		[
			{ index: 9, receivedAt: 9, data: "gen-1 F0 TAIL y" },
			{ index: 12, receivedAt: 11, data: "gen-1 F0 HEADER x" },
		],
		input,
	);
	assert.equal(staleAfter.staleWrites.length, 1, "a stale write at/after the empty end is detected");
	assert.equal(staleAfter.staleWrites[0].index, 12);
	assert.equal(staleAfter.ok, false, "a post-empty stale write must fail");

	const poisonAfter = s.analyzePostEmptyWrites(
		[
			{ index: 9, receivedAt: 9, data: "gen-1 F0 TAIL y" },
			{ index: 12, receivedAt: 11, data: "s20b-poison poisoned stale retained screen.log line" },
		],
		input,
	);
	assert.equal(poisonAfter.poisonWrites.length, 1, "a post-empty poison write is detected");
	assert.equal(poisonAfter.ok, false, "a post-empty poison write must fail");
});

test("step 20B: analyzeGenerationWindow fails live post-F1 content loss and allows it at the teardown boundary", async () => {
	const s = await scenario();
	const gen = { generation: "gen-1" };
	const seed = { at: 1, rows: ["gen-1 F0 HEADER x"] };
	const f1 = { at: 2, rows: ["gen-1 F1 HEADER x"] };
	const blank = { at: 3, rows: ["", ""] };
	const loading = { at: 4, rows: ["⠋ Loading \"s15\"…"] };

	// Live blank/loading AFTER the first F1 inside the ACTIVE window = content loss.
	for (const loss of [blank, loading]) {
		const active = s.analyzeGenerationWindow([seed, f1, loss], gen);
		assert.equal(active.postF1ContentLost, true, `${loss.rows.join("")} after F1 must be detected`);
		assert.equal(active.postF1ContentLostAt, loss.at);
		assert.equal(active.ok, false, "live post-F1 content loss must fail");
	}

	// Teardown-boundary control: the SAME blanks at/after the recorded boundary are
	// teardown chrome, not content loss.
	const teardown = s.analyzeGenerationWindow([seed, f1, blank, loading], { generation: "gen-1", activeObservationCount: 2 });
	assert.equal(teardown.activeObservationCount, 2);
	assert.equal(teardown.teardownObservationCount, 2);
	assert.equal(teardown.teardownBlankOrLoading, 2, "teardown blanks/loadings are counted, not hidden");
	assert.equal(teardown.teardownStaleClaims.length, 0);
	assert.equal(teardown.postF1ContentLost, false);
	assert.equal(teardown.ok, true, "teardown chrome is allowed at/after the boundary");

	// Teardown may re-render committed F1 content, but never stale/foreign content.
	const teardownF1 = s.analyzeGenerationWindow([seed, f1, f1], { generation: "gen-1", activeObservationCount: 2 });
	assert.deepEqual(teardownF1.teardownContentKinds, ["content-f1"]);
	assert.deepEqual(teardownF1.teardownStaleClaims, []);
	assert.equal(teardownF1.ok, true);
	const teardownStale = s.analyzeGenerationWindow([seed, f1, seed], { generation: "gen-1", activeObservationCount: 2 });
	assert.deepEqual(teardownStale.teardownStaleClaims, ["content-f0"], "a teardown repaint of the seed is stale");
	assert.equal(teardownStale.ok, false);

	// A blank BEFORE the first F1 is legitimate (attach/recovery chrome).
	const preF1Blank = s.analyzeGenerationWindow([seed, blank, f1], gen);
	assert.equal(preF1Blank.postF1ContentLost, false);
	assert.equal(preF1Blank.ok, true);
});

test("step 20B: compareInitialHooks rejects 0-to-0 and repeated initial side effects (pure negatives)", async () => {
	const s = await scenario();
	assert.equal(s.compareInitialHooks({ colorProbe: 1, schemeBridge: 1 }, { colorProbe: 1, schemeBridge: 1 }).ok, true);
	const zero = s.compareInitialHooks({ colorProbe: 0, schemeBridge: 1 }, { colorProbe: 0, schemeBridge: 1 });
	assert.equal(zero.probeObservedBeforeRestart, false);
	assert.equal(zero.ok, false, "0 -> 0 proves nothing and must fail");
	const repeatedProbe = s.compareInitialHooks({ colorProbe: 1, schemeBridge: 1 }, { colorProbe: 2, schemeBridge: 1 });
	assert.equal(repeatedProbe.probeNotRepeated, false);
	assert.equal(repeatedProbe.ok, false, "a repeated color probe must fail");
	const repeatedBridge = s.compareInitialHooks({ colorProbe: 1, schemeBridge: 1 }, { colorProbe: 1, schemeBridge: 2 });
	assert.equal(repeatedBridge.bridgeNotRepeated, false);
	assert.equal(repeatedBridge.ok, false, "a repeated bridge registration must fail");
	assert.equal(s.compareInitialHooks({ colorProbe: 1, schemeBridge: 0 }, { colorProbe: 1, schemeBridge: 0 }).ok, false, "0 -> 0 bridge fails");
});

test("step 20B: analyzeLegacyResizeSequence requires shrink THEN restore in order (pure negatives)", async () => {
	const s = await scenario();
	const expected = { cols: 80, rows: 22, shrinkCols: 79, shrinkRows: 21 };
	const complete = s.analyzeLegacyResizeSequence(
		[
			{ cols: 80, rows: 22, at: 1 },
			{ cols: 79, rows: 21, at: 2 },
			{ cols: 80, rows: 22, at: 3 },
		],
		expected,
	);
	assert.equal(complete.ok, true);
	assert.equal(complete.restoreTrigger, "natural");
	const detachRestore = s.analyzeLegacyResizeSequence(
		[
			{ cols: 80, rows: 22, at: 1 },
			{ cols: 79, rows: 21, at: 2 },
			{ cols: 80, rows: 22, at: 3 },
		],
		{ ...expected, detachAt: 2.5 },
	);
	assert.equal(detachRestore.restoreTrigger, "detach");

	const noRestore = s.analyzeLegacyResizeSequence(
		[
			{ cols: 80, rows: 22, at: 1 },
			{ cols: 79, rows: 21, at: 2 },
		],
		expected,
	);
	assert.equal(noRestore.restore, null);
	assert.equal(noRestore.restoreTrigger, "missing");
	assert.equal(noRestore.ok, false, "a missing restore must fail");

	const restoreBeforeShrink = s.analyzeLegacyResizeSequence(
		[
			{ cols: 80, rows: 22, at: 1 },
			{ cols: 80, rows: 22, at: 2 },
			{ cols: 79, rows: 21, at: 3 },
		],
		expected,
	);
	assert.equal(restoreBeforeShrink.restore, null);
	assert.equal(restoreBeforeShrink.ok, false, "restore before shrink is not the jiggle");
});

// ---------------------------------------------------------------------------
// Real-runner CLI smokes (guarded exclusive dirs)
// ---------------------------------------------------------------------------

test("step 20B R-reconnect: full-window same-generation gate, resume path and ordered cleanup", async (t) => {
	const r = await runCli(t, ["--case", "R-reconnect", "--repeat", "1", "--clock", "real"]);
	assert.equal(r.code, 0, `R-reconnect must run (stderr: ${r.stderr.slice(-400)})`);
	assert.equal(r.parsed?.caseId, "R-reconnect");
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr?.ok, true, JSON.stringify(tr?.error ?? tr));
	const ev = tr.reconnectEvidence;
	assert.equal(ev.f0Committed, true, "same-generation F0 before disconnect");
	assert.equal(ev.f1Committed, true, "same-generation F1 after reconnect");
	assert.ok(ev.subscribeCount > ev.subscribeBefore, "an additional subscribe after disconnect");
	assert.equal(ev.resumePath, "sinceSeq", "resume path is the retained sinceSeq path");
	assert.equal(typeof ev.sinceSeq, "number", "modern reconnect retained a numeric sinceSeq cursor");
	assert.ok(ev.sinceSeq >= 1, `modern reconnect cursor is positive (${ev.sinceSeq})`);
	assert.equal(ev.allSameGeneration, true, "every child event stayed within the same generation");
	assert.equal(ev.modernFrameWitness, true, "the component observed the reporter-enabled modern path");
	assert.equal(ev.recoveryDuringDown, true, "same-generation recovery view retained while down");
	assert.match(ev.recoveryStatusWhileDown ?? "", /reconnect|disconnect/i, "reconnecting status remains visible");
	assert.equal(ev.recoveryActiveRow?.startsWith("gen-1 F0"), true, "the displayed recovery row is the complete F0 view");
	assert.equal(ev.recoveryClearedAfterF1, true, "new F1 committed content replaces recovery");
	assert.equal(ev.resnapshotPreserved, true, "same-generation nonempty resnapshot captures recovery before replacement");
	assert.match(ev.resnapshotRow ?? "", /^gen-1 F0/, "resnapshot recovery row is the complete F0 view");
	const win = ev.windowAnalysis;
	assert.equal(win.firstF0Index >= 0, true, "the seed window is classified");
	assert.equal(win.firstF1Index > win.firstF0Index, true, "the continuation window follows the seed");
	assert.equal(win.f1AfterF0, true);
	assert.equal(win.f0AfterF1, false, "no F0-only frame after the first F1 commit");
	assert.equal(win.mixedHalves, false, "no mixed F0/F1 half");
	assert.equal(win.foreignContent, false, "no other generation may publish");
	assert.ok(win.counts.loading + win.counts.blank > 0, "loading/reconnecting windows are explicitly classified");
	assert.equal(win.ok, true);
	// RU fix3 (Q4): ACTIVE vs teardown boundary split and content-loss gate.
	assert.ok(ev.activeWindowObservationCount > 0, "the active-window boundary was recorded before dispose");
	assert.equal(win.activeObservationCount, ev.activeWindowObservationCount);
	assert.equal(win.teardownObservationCount, ev.teardownObservationCount);
	assert.equal(win.postF1ContentLost, false, "no blank/loading after F1 inside the ACTIVE window");
	assert.equal(win.postF1ContentLostAt, null);
	assert.deepEqual(win.teardownStaleClaims, [], "teardown may re-render committed content, never stale/foreign content");
	assert.equal(typeof win.teardownBlankOrLoading, "number", "teardown blanks/loadings are counted, not hidden");
	t.diagnostic(`R-reconnect boundaries: active=${ev.activeWindowObservationCount} teardown=${ev.teardownObservationCount} teardownKinds=${JSON.stringify(win.teardownKinds)} teardownBlankOrLoading=${win.teardownBlankOrLoading}`);
	assert.equal(ev.cleanup.ok, true, "cleanup.ok requires real exits + rootRemoved");
	assert.deepEqual(ev.cleanup.forcedKills, [], "no unrecorded/forced kill on the ordered path");
	assert.equal(ev.cleanup.childExited, true, "ordered child exit");
	assert.equal(ev.cleanup.runnerExited, true, "ordered runner exit");
});

test("step 20B R-restart: correlated empty baseline, real initial hooks, reset before gen-2 and ordered cleanup", async (t) => {
	const r = await runCli(t, ["--case", "R-restart", "--repeat", "1", "--clock", "real"]);
	assert.equal(r.code, 0, `R-restart must run (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr?.ok, true, JSON.stringify(tr?.error ?? tr));
	const ev = tr.evidence;
	assert.equal(ev.gen1Committed, true);
	assert.equal(ev.gen2Committed, true);
	assert.equal(ev.modernFrameWitness, true, "real reporter-enabled modern recovery topology");
	assert.equal(ev.oldViewsClearedAtEmpty, true, "new-generation empty baseline clears current + recovery");
	assert.equal(ev.recoveryClearedAfterGen2, true, "only new gen-2 complete content remains after replacement");
	assert.equal(ev.resetAnalysis.strictPostEmptyPresentationClean, true, "zero post-empty old observations after the pre-empty drain");
	assert.deepEqual(ev.resetAnalysis.postEmptyStaleObservations, [], "no old-generation observation after the empty baseline");
	// Correlated EMPTY baseline: begin + ITS OWN end on the component's socket.
	assert.equal(ev.emptyBaseline.begin.msg.type, "snapshot_begin");
	assert.equal(ev.emptyBaseline.begin.msg.empty, true, "authoritative empty baseline witness");
	assert.equal(ev.emptyBaseline.end.msg.type, "snapshot_end");
	assert.equal(ev.emptyBaseline.end.socketId, ev.emptyBaseline.socketId, "the end belongs to the same client socket");
	assert.equal(ev.emptyBaseline.nextSeqMatches, true, "end.nextSeq === begin.snapshotSeq + 1");
	assert.equal(ev.emptyBaseline.correlated, true);
	assert.equal(typeof ev.emptyBaseline.beginGeneration, "string", "runner boot identity retained");
	// Real initial public hooks: really observed once before, never repeated.
	assert.ok(ev.hooks.probeBefore >= 1, `initial color probe really ran (${ev.hooks.probeBefore})`);
	assert.ok(ev.hooks.bridgeBefore >= 1, `initial scheme bridge really registered (${ev.hooks.bridgeBefore})`);
	assert.equal(ev.hooks.probeAfter, ev.hooks.probeBefore, "the color probe is not repeated after restart");
	assert.equal(ev.hooks.bridgeAfter, ev.hooks.bridgeBefore, "the scheme bridge is not re-registered after restart");
	assert.equal(ev.hooks.ok, true);
	// RU fix3 (Q2): a REAL poison plant in the retained screen.log, retained at
	// teardown, with non-vacuous observation AND write-level gates.
	const plant = ev.poisonPlant;
	assert.equal(plant.marker, "s20b-poison");
	assert.match(plant.path, /screen\.log$/, "planted into the view's actual retained screen.log");
	assert.equal(plant.plantReadbackContained, true, "plant proof: the marker is read back from the log");
	assert.equal(typeof plant.beforeBytes, "number");
	assert.equal(typeof plant.afterBytes, "number");
	assert.ok(plant.afterBytes >= plant.beforeBytes + plant.appendedBytes, "the plant grew the retained log");
	assert.match(plant.appendedSha256, /^[0-9a-f]{64}$/);
	assert.equal(ev.poisonRetainedAtTeardown, true, "the planted marker is still in the retained log at teardown");
	assert.ok(ev.screenLogArtifactBytes > 0, "the retained screen.log is copied as an artifact");
	assert.equal(ev.writeAnalysis.ok, true, "no outer write at/after the empty end carries gen-1 or poison bytes");
	assert.deepEqual(ev.writeAnalysis.staleWrites, []);
	assert.deepEqual(ev.writeAnalysis.poisonWrites, []);
	assert.ok(ev.writeAnalysis.writeCount > 0, "post-empty writes really exist (non-vacuous write gate)");
	assert.ok(ev.writeAnalysis.lastStaleWrite !== null, "stale bytes really existed before the baseline");
	assert.ok(ev.writeAnalysis.lastStaleWrite.receivedAt < ev.emptyBaseline.end.at, "the last stale write is PRE-baseline");
	// Pre-restart runner boot identities are retained and really differ.
	assert.ok(ev.preRestartGenerations.length >= 1, "pre-restart generation(s) retained in the summary");
	assert.equal(ev.preRestartGenerations.includes(ev.emptyBaseline.beginGeneration), false);
	assert.equal(ev.preRestartGenerationsDiffer, true, "the replacement boot generation differs from every pre-restart generation");
	// Actual reset BEFORE gen-2, with a non-vacuous full-window stale scan.
	assert.equal(ev.resetAnalysis.recoveryKind, "blank", "an actual outer reset is observed");
	assert.equal(ev.resetAnalysis.recoveryIndex >= 0, true);
	assert.equal(ev.resetAnalysis.gen2AfterRecovery, true, "gen-2 content only AFTER the reset");
	assert.ok(ev.resetAnalysis.staleRowsBeforeBaseline > 0, "the stale scanner is non-vacuous");
	assert.deepEqual(ev.resetAnalysis.newStaleRowsAfterBaseline, [], "no NEW old-generation content after the baseline");
	assert.deepEqual(ev.resetAnalysis.oldGenRowsAfterRecovery, [], "old generation absent across the full post-reset window");
	assert.deepEqual(ev.resetAnalysis.poisonRowsAfterRecovery, []);
	assert.deepEqual(ev.resetAnalysis.postEmptyPoisonObservations, [], "no planted poison ever reaches the outer surface");
	assert.equal(ev.resetAnalysis.poisonObservationGateOk, true);
	assert.equal(ev.resetAnalysis.poisonPlanted, true);
	assert.equal(ev.resetAnalysis.ok, true);
	// RU fix3 (Q1): the strict presentation result is reported SEPARATELY and is
	// never forced. The current baseline persists the old grid for a few ms
	// through baseline-consumption latency; that is a P4 presentation finding,
	// not a harness failure and not a desirable result.
	const strict = ev.resetAnalysis.strictPostEmptyPresentationClean;
	assert.equal(typeof strict, "boolean");
	assert.equal(strict, ev.resetAnalysis.postEmptyStaleObservations.length === 0, "strict is derived from the array, never asserted independently");
	for (const entry of ev.resetAnalysis.postEmptyStaleObservations) {
		assert.ok(entry.index < ev.resetAnalysis.recoveryIndex, "recorded stale observations are PRE-reset persistence");
		assert.ok(entry.gen1Rows.length > 0);
		assert.deepEqual(entry.poisonRows, []);
	}
	assert.equal(
		ev.resetAnalysis.stalePixelPersistenceObservations.length,
		ev.resetAnalysis.postEmptyStaleObservations.length,
		"in the current baseline the whole strict array is the persistence window",
	);
	if (ev.resetAnalysis.postEmptyStaleObservations.length > 0) {
		assert.equal(ev.resetAnalysis.stalePixelPersistenceLatencyMs !== null, true, "persistence latency through baseline consumption is recorded");
	}
	t.diagnostic(
		`R-restart strict presentation: strictClean=${strict} postEmptyStale=${ev.resetAnalysis.postEmptyStaleObservations.length} persistenceLatencyMs=${ev.resetAnalysis.stalePixelPersistenceLatencyMs} writeGate=${ev.writeAnalysis.ok}`,
	);
	// Independent gen-2 literal/grid/cursor proof.
	assert.equal(ev.gen2Proof.literalMatched, true);
	assert.equal(ev.gen2Proof.kind, "frame");
	assert.equal(ev.gen2Proof.cursorMatched, true, "gen-2 cursor contract matched");
	assert.match(ev.gen2Proof.gridSha256, /^[0-9a-f]{64}$/);
	// Detach completion is separate from the initial hooks.
	assert.deepEqual(ev.doneResults.map((result) => result.action), ["closed"], "the child-exit completion is not a first-attach hook");
	assert.ok(ev.scenarioKills.length > 0, "the OLD owned runner/child kill is a scenario action");
	assert.deepEqual(ev.cleanup.forcedKills, [], "no unrecorded/forced kill for the replacement");
	assert.equal(ev.cleanup.ok, true);
	assert.equal(ev.cleanup.childExited, true);
	assert.equal(ev.cleanup.runnerExited, true);
});

test("step 20B U-unframed: required full literal after real echo, unframed raw bytes and ordered exit", async (t) => {
	const r = await runCli(t, ["--case", "U-unframed", "--repeat", "1", "--clock", "real"]);
	assert.equal(r.code, 0, `U-unframed must run (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr?.ok, true, JSON.stringify(tr?.error ?? tr));
	const ev = tr.evidence;
	assert.equal(ev.fullLiteralMatched, true, "the REQUIRED full literal matched");
	assert.equal(ev.inputEchoObserved, true, "the real echo input reached the work area");
	assert.equal(ev.echoWriteCount >= 1, true, "the child really wrote the echo");
	assert.equal(typeof ev.fullLiteralAt, "number", "the literal match is timestamped after the wait");
	assert.equal(ev.childInputReadyObserved, true, "live bracketed-paste input readiness was observed");
	assert.equal(ev.hasSyncOpen, false, "no ?2026h in raw child bytes");
	assert.equal(ev.hasSyncClose, false, "no ?2026l in raw child bytes");
	assert.equal(ev.rawObserverAllUnframed, true, "raw observer records only unframed windows");
	assert.match(ev.rawBytesSha256, /^[0-9a-f]{64}$/);
	assert.equal(ev.orderedExit.childExited, true, "ordered child exit");
	assert.equal(ev.orderedExit.runnerExited, true, "ordered runner exit");
	assert.equal(tr.cleanup.ok, true, "cleanup.ok gated");
	assert.deepEqual(tr.cleanup.forcedKills, [], "no forced child kill is the normal exit");
});

test("step 20B U-legacy: required full literal + echo, zero subscribe/snapshot, shrink-then-restore jiggle, public detach", async (t) => {
	const r = await runCli(t, ["--case", "U-legacy", "--repeat", "1", "--clock", "real"]);
	assert.equal(r.code, 0, `U-legacy must run (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr?.ok, true, JSON.stringify(tr?.error ?? tr));
	const ev = tr.evidence;
	assert.equal(ev.fullLiteralMatched, true, "the REQUIRED full literal matched after the echo");
	assert.equal(ev.inputEchoObserved, true, "the legacy path really forwarded the echo");
	assert.equal(ev.echoWriteCount >= 1, true, "the child really wrote the echo");
	assert.equal(ev.childInputReadyObserved, true);
	assert.equal(ev.legacyForced, true);
	assert.equal(ev.noSubscribe, true, "legacy path sent no subscribe");
	assert.equal(ev.subscribeCount, 0);
	assert.equal(ev.snapshotMessageCount, 0, "no snapshot_begin/end/frame in legacy");
	assert.equal(typeof ev.settleEvidence.probeQueryAt, "number", "the settle color probe really ran");
	assert.equal(ev.detach.doneResult.action, "detached", "the PUBLIC detach completed with done(detached)");
	// The COMPLETE sequence is captured at teardown (after dispose/stop).
	const ta = tr.teardownAnalysis;
	assert.equal(ta.initial.cols, 80);
	assert.equal(ta.initial.rows, 22);
	assert.equal(ta.shrink.cols, 79, "the real jiggle shrink");
	assert.equal(ta.shrink.rows, 21);
	assert.equal(ta.restore.cols, 80, "the restore is really present");
	assert.equal(ta.restore.rows, 22);
	assert.equal(ta.restore.at > ta.shrink.at, true, "shrink then restore, in order");
	assert.ok(["natural", "detach"].includes(ta.restoreTrigger), "the restore trigger is classified");
	assert.equal(ta.ok, true);
	assert.equal(ev.orderedExit.childExited, true, "ordered child exit via the public runner input");
	assert.equal(ev.orderedExit.runnerExited, true, "ordered runner exit");
	assert.equal(tr.cleanup.ok, true, "cleanup.ok gated");
	assert.deepEqual(tr.cleanup.forcedKills, [], "no forced child kill is the normal exit");
	assert.equal(tr.envRestored, true, "AGENT_BOARD_TERMINAL_SNAPSHOT restored after the scenario");
});

test("step 20B D1: instrumented single iteration separates harness validity from product cleanliness", async (t) => {
	const r = await runCli(t, ["--case", "D", "--repeat", "1", "--clock", "real"]);
	// Valid evidence MUST exit 0 even when productClean is false (a product RED is
	// a separate asserted result, never an infrastructure failure).
	assert.equal(r.code, 0, `D repeat1 must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr?.ok, true, JSON.stringify(tr ?? {}));
	assert.equal(tr.iterationsRun, 1);
	assert.equal(tr.iterationValidAll, true);
	assert.equal(tr.infrastructureErrors.length, 0);
	assert.equal(tr.quietProductCleanAll, true, "the quiet dispose shape is product-CLEAN after the resource correction (contract)");
	assert.equal(tr.quiet.productCleanCount, 1);
	assert.equal(tr.quiet.iterations, 1);
	const it = tr.iterations[0];
	assert.equal(it.iterationValid, true, "the iteration is harness-valid");
	assert.equal(it.productClean, true, "quiet-dispose shape: zero post-close publish, no residual, contract holds");
	assert.equal(it.resourceGates.ok, true, "named resource gates hold for the quiet shape");
	assert.equal(it.resourceGates.intervalsLive, 0);
	assert.equal(it.resourceGates.oneShotsLive, 0, "owned one-shots are drained before the snapshot");
	assert.equal(it.resourceGates.socketsOpen, 0);
	assert.equal(it.resourceGates.bridgeUnsubscribes >= 1, true, "expected TUI unsubscribe");
	assert.ok(it.doneCount <= 1, "completion hooks at most once");
	assert.equal(it.endpoint.ok, true, "the trial endpoint stays below the measured path-length margin");
	assert.equal(typeof it.ownedTimersLiveAfterDispose, "number");
	assert.equal(it.cleanup.ok, true, "ordered cleanup with rootRemoved");
	assert.deepEqual(it.cleanup.forcedKills, [], "no routine SIGKILL on the ordered path");
	t.diagnostic(`D1 iteration: productClean=${it.productClean} postClose=${it.postCloseWrites}/${it.postCloseFrames} cause=${JSON.stringify(it.postCloseCause?.classification)} gates=${JSON.stringify(it.resourceGates)}`);
});

// ---------------------------------------------------------------------------
// D1 pure oracles and real-run cases
// ---------------------------------------------------------------------------

test("step 20B D1: checkEndpointPath fails fast above the measured margin", async () => {
	const s = await scenario();
	assert.equal(s.checkEndpointPath("/tmp/s20b-d1-x/endpoint.sock").ok, true);
	const tooLong = `/tmp/${"d".repeat(120)}/endpoint.sock`;
	const check = s.checkEndpointPath(tooLong);
	assert.ok(check.length > check.safeLength);
	assert.equal(check.ok, false, "a path beyond the measured margin must fail fast");
	assert.match(check.note, /EADDRINUSE/);
});

test("step 20B D1: classifyLiveTimers separates owned intervals from bounded one-shots", async () => {
	const s = await scenario();
	const c = s.classifyLiveTimers([
		{ id: 1, kind: "interval", ms: 20 },
		{ id: 2, kind: "timeout", ms: 500 },
		{ id: 3, kind: "timeout", ms: 15000 },
	]);
	assert.deepEqual(c.intervals, [{ id: 1, ms: 20 }], "a live owned interval is a leak candidate");
	assert.deepEqual(c.oneShotBounded, [{ id: 2, ms: 500 }], "a bounded one-shot will fire on its own (recorded)");
	assert.deepEqual(c.oneShotLong, [{ id: 3, ms: 15000 }], "a long one-shot stays UNKNOWN");
	assert.deepEqual(s.classifyLiveTimers([]), { intervals: [], oneShotBounded: [], oneShotLong: [] });
});

test("step 20B D1: postCloseProductClean is a real assertion, never masked by harness ok", async () => {
	const s = await scenario();
	const pendingOneShots = s.postCloseProductClean({
		postCloseWrites: 0,
		postCloseFrames: 0,
		duplicatePublishes: 0,
		stalePublishes: 0,
		doneCount: 0,
		hookRegistrations: 1,
		ownedTimerIntervalsLive: 0,
		ownedTimerOneShotsLive: 2,
		socketsOpenAfterDispose: 0,
		bridgeUnsubscribes: 1,
		requiredBridgeUnsubscribes: 1,
	});
	assert.equal(pendingOneShots.zeroPostClose, true);
	assert.equal(pendingOneShots.boundedTimersPending, true);
	assert.equal(pendingOneShots.noOwnedResidual, false, "a live owned one-shot after the bounded drain is NOT clean");
	assert.equal(pendingOneShots.productClean, false, "pending bounded timers are not automatically clean");

	const clean = s.postCloseProductClean({
		postCloseWrites: 0,
		postCloseFrames: 0,
		duplicatePublishes: 0,
		stalePublishes: 0,
		doneCount: 0,
		hookRegistrations: 1,
		ownedTimerIntervalsLive: 0,
		ownedTimerOneShotsLive: 0,
		socketsOpenAfterDispose: 0,
		bridgeUnsubscribes: 1,
		requiredBridgeUnsubscribes: 1,
	});
	assert.equal(clean.productClean, true, "fully drained resources are clean");
	assert.equal(clean.bridgeUnsubscribed, true);
	const noUnsub = s.postCloseProductClean({
		postCloseWrites: 0, postCloseFrames: 0, duplicatePublishes: 0, stalePublishes: 0,
		doneCount: 0, hookRegistrations: 1, ownedTimerIntervalsLive: 0, ownedTimerOneShotsLive: 0,
		socketsOpenAfterDispose: 0, bridgeUnsubscribes: 0, requiredBridgeUnsubscribes: 1,
	});
	assert.equal(noUnsub.bridgeUnsubscribed, false, "a missing TUI unsubscribe is not clean");
	assert.equal(noUnsub.productClean, false);

	const publish = s.postCloseProductClean({
		postCloseWrites: 1, postCloseFrames: 1, duplicatePublishes: 0, stalePublishes: 0,
		doneCount: 0, hookRegistrations: 1, ownedTimerIntervalsLive: 0, ownedTimerOneShotsLive: 0, socketsOpenAfterDispose: 0,
	});
	assert.equal(publish.zeroPostClose, false);
	assert.equal(publish.productClean, false, "a post-close publish fails productClean even though the iteration is valid");

	const interval = s.postCloseProductClean({
		postCloseWrites: 0, postCloseFrames: 0, duplicatePublishes: 0, stalePublishes: 0,
		doneCount: 0, hookRegistrations: 1, ownedTimerIntervalsLive: 1, ownedTimerOneShotsLive: 0, socketsOpenAfterDispose: 0,
	});
	assert.equal(interval.noOwnedResidual, false, "a live owned interval is a residual");
	assert.equal(interval.productClean, false);

	const duplicate = s.postCloseProductClean({
		postCloseWrites: 0, postCloseFrames: 0, duplicatePublishes: 1, stalePublishes: 0,
		doneCount: 0, hookRegistrations: 1, ownedTimerIntervalsLive: 0, ownedTimerOneShotsLive: 0, socketsOpenAfterDispose: 0,
	});
	assert.equal(duplicate.noDuplicatePublish, false);
	const hooks = s.postCloseProductClean({
		postCloseWrites: 0, postCloseFrames: 0, duplicatePublishes: 0, stalePublishes: 0,
		doneCount: 2, hookRegistrations: 2, ownedTimerIntervalsLive: 0, ownedTimerOneShotsLive: 0, socketsOpenAfterDispose: 0,
	});
	assert.equal(hooks.hooksAtMostOnce, false, "duplicate completion / repeated hooks fail");
});

test("step 20B D1: resourceGates require zero intervals, zero drained one-shots, zero sockets and the unsubscribe", async () => {
	const s = await scenario();
	const snapshot = (over) => ({
		label: "after-teardown",
		at: 1,
		ownedTimersLive: 0,
		ownedTimersLiveDetail: [],
		ownedTimerClassification: { intervals: [], oneShotBounded: [], oneShotLong: [] },
		ownedTimerIntervalsLive: 0,
		ownedTimersCreated: 1,
		ownedTimersCleared: 1,
		harnessTimersLive: 0,
		harnessTimersLiveDetail: [],
		sockets: [],
		socketsOpen: 0,
		hookLifecycle: { bridgeRegistrations: 1, bridgeUnsubscribes: 1 },
		socketCloseWaitedMs: 0,
		unattributable: "timers created before instrumentation stay UNKNOWN",
		...over,
	});
	const hooks = { bridgeRegistrations: 1, bridgeUnsubscribes: 1 };
	assert.equal(s.resourceGates(snapshot({}), hooks).ok, true);
	assert.equal(s.resourceGates(snapshot({ ownedTimerIntervalsLive: 1 }), hooks).intervalsZero, false);
	assert.equal(s.resourceGates(snapshot({ ownedTimerClassification: { intervals: [], oneShotBounded: [{ id: 1, ms: 500 }], oneShotLong: [] } }), hooks).oneShotsZero, false);
	assert.equal(s.resourceGates(snapshot({ socketsOpen: 1 }), hooks).socketsZero, false);
	assert.equal(s.resourceGates(snapshot({}), { bridgeRegistrations: 1, bridgeUnsubscribes: 0 }).bridgeUnsubscribed, false);
	assert.equal(s.resourceGates(snapshot({}), hooks).harnessTimersLive, 0, "harness timers are reported separately, never residual");
	assert.equal(s.resourceGates(null, hooks).ok, false, "a missing snapshot is UNKNOWN, never clean");
	assert.equal(s.resourceGates(snapshot({}), null).ok, false, "missing hook lifecycle is UNKNOWN, never clean");
});

test("step 20B D1: classifyPostCloseCause attributes a post-close write from raw evidence", async () => {
	const s = await scenario();
	const write = (over) => ({ index: 10, receivedAt: 20, bytes: 30, sha256: "x", head: "h", kind: null, containsNewContent: false, preCloseRequestRenderSeq: 9, postCloseRequestRenderSeq: null, ...over });
	const requests = [{ seq: 9, at: 10, force: false }];
	assert.equal(s.classifyPostCloseCause([], requests, 15).classification, "zero");
	const late = s.classifyPostCloseCause([write({})], requests, 15);
	assert.equal(late.classification, "latePaintOfPreDisposeRender");
	assert.equal(late.newContentWrites, 0);
	assert.equal(late.preDisposeRenderRequestSeq, 9);
	const newContent = s.classifyPostCloseCause([write({ containsNewContent: true })], requests, 15);
	assert.equal(newContent.classification, "postCloseNewContent", "content produced after dispose is a real stale publish");
	const postRequest = s.classifyPostCloseCause([write({})], [...requests, { seq: 10, at: 18, force: true }], 15);
	assert.equal(postRequest.classification, "postCloseRenderRequest");
	assert.equal(postRequest.postDisposeRenderRequests, 1);
});

test("step 20B D1: countDuplicatePublishes detects repeated snapshot identities", async () => {
	const s = await scenario();
	assert.deepEqual(s.countDuplicatePublishes(["a", "b", "c"]), { duplicates: 0, unique: 3 });
	assert.deepEqual(s.countDuplicatePublishes(["a", "a", "b", "a"]), { duplicates: 2, unique: 2 });
});

test("step 20B D1-dispose CONTRACT: zero post-close publish is required (old source FAILS, P4 must PASS)", async (t) => {
	const r = await runCli(t, ["--case", "D1-dispose", "--repeat", "1", "--clock", "real"]);
	assert.equal(r.code, 0, `D1-dispose must record valid evidence (stderr: ${r.stderr.slice(-500)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr.iterationValid, true, JSON.stringify(tr.error ?? tr));
	assert.equal(tr.infrastructureError, null);
	const ev = tr.evidence;
	assert.equal(ev.childWritesAfterDispose >= 1, true, "REAL remaining child output arrived after dispose");
	assert.equal(ev.stepCommandAcceptedByChild, true, "the child really accepted the in-flight step command");
	// Supporting evidence for the CURRENT defect (kept, never used as the verdict):
	// the post-close write/frame is retained raw with its cause classification.
	for (const write of ev.postCloseWrites) {
		assert.ok(write.bytes > 0);
		assert.match(write.sha256, /^[0-9a-f]{64}$/);
		assert.ok(write.receivedAt > ev.disposeAt);
	}
	if (ev.postCloseWrites.length > 0) {
		assert.ok(["latePaintOfPreDisposeRender", "postCloseNewContent", "postCloseRenderRequest"].includes(ev.postCloseCause.classification));
		assert.ok(ev.postCloseCause.note.length > 0, "the cause is explained from raw evidence");
		t.diagnostic(`D1-dispose retained counterexample: ${ev.postCloseWrites.length} write(s), cause=${ev.postCloseCause.classification}`);
	}
	assert.deepEqual(ev.hooks, { colorProbe: 1, schemeBridge: 1 }, "first-attach hooks ran once");
	assert.equal(ev.hookLifecycle.bridgeRegistrations, 1);
	assert.equal(ev.hookLifecycle.bridgeUnsubscribes, 1, "the bridge is unsubscribed at teardown");
	assert.equal(ev.doneCount, 0, "dispose is not a detach completion");
	// Resource gates (D1 fix1 C1): the snapshot is strictly post-dispose/post-exit.
	assert.equal(ev.resourceGates.ok, true, `resource gates: ${JSON.stringify(ev.resourceGates)}`);
	assert.equal(ev.resourceGates.intervalsLive, 0, "no owned interval survives teardown");
	assert.equal(ev.resourceGates.oneShotsLive, 0, "owned one-shots are drained before the snapshot");
	assert.equal(ev.resourceGates.socketsOpen, 0, "no owned socket stays open");
	assert.equal(ev.resourceGates.bridgeUnsubscribes >= 1, true, "the TUI bridge is unsubscribed");
	assert.equal(ev.resourceGates.harnessTimersLive, 0, "harness timers are stopped/attributed, never residual");
	assert.equal(ev.cleanup.ok, true);
	assert.deepEqual(ev.cleanup.forcedKills, [], "ordered exit, no routine SIGKILL");
	// Stale-parser dimension (I1): observe-only instrumentation of the REAL parser.
	assert.equal(ev.staleParserDimension.parserInstrumentationInstalled, true, `parser instrumentation: ${ev.staleParserDimension.parserInstrumentationError}`);
	assert.equal(typeof ev.staleParserDimension.postDisposeParserWrites, "number");
	assert.equal(typeof ev.staleParserDimension.postDisposeSocketDeliveries, "number");
	assert.ok(["latePaintOfPreDisposeRender", "postCloseNewContent", "postCloseRenderRequest", "zero"].includes(ev.postCloseCause.classification));
	// CONTRACT ASSERTION (D1 fix1 C2): zero post-close publish is REQUIRED. This
	// FAILS on current source (the retained late paint) and the SAME assertion
	// passes once P4 fixes it. It is not a characterization of the defect.
	assert.equal(ev.product.zeroPostClose, true, "CONTRACT: zero post-close write/frame after dispose (currently RED: see retained counterexample)");
	assert.equal(tr.productClean, true, "CONTRACT: productClean===true (zero post-close, no residual, hooks<=1)");
});

test("step 20B D1-duplicate: a documented duplicate subscribe repeats no first-attach side effect", async (t) => {
	const r = await runCli(t, ["--case", "D1-duplicate", "--repeat", "1", "--clock", "real"]);
	assert.equal(r.code, 0, `D1-duplicate must record valid evidence (stderr: ${r.stderr.slice(-500)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr.iterationValid, true, JSON.stringify(tr.error ?? tr));
	assert.notEqual(tr.evidence.duplicateBeginIdentity, null, "the duplicate answer is identified");
	assert.deepEqual(tr.evidence.hooksAfterDuplicate, { colorProbe: 1, schemeBridge: 1 }, "hooks are not repeated");
	assert.equal(tr.evidence.hookLifecycle.bridgeRegistrations, 1);
	assert.equal(tr.evidence.doneCount, 0, "the attach is not completed by a duplicate");
	assert.equal(tr.evidence.blankWindowsAfterDuplicate, 0, "no buffer wipe from the duplicate");
	assert.equal(tr.evidence.hooksAtMostOnce, true);
	assert.equal(tr.duplicateObservableClean, true);
	assert.equal(tr.duplicatePublishIdentityCount, null, "per-identity publish count is UNKNOWN, never claimed clean");
	assert.match(tr.duplicatePublishIdentityNote, /UNKNOWN/);
	assert.deepEqual(tr.evidence.resourceGates.ok, true, "resource gates hold for the duplicate case");
	assert.equal(tr.evidence.resourceGates.intervalsLive, 0);
	assert.equal(tr.evidence.resourceGates.oneShotsLive, 0);
	assert.equal(tr.evidence.resourceGates.socketsOpen, 0);
	assert.equal(tr.evidence.resourceGates.bridgeUnsubscribes >= 1, true);
	const dupIds = tr.evidence.duplicateIdentityCount;
	assert.equal(typeof dupIds.duplicates, "number", "the wire-identity duplicate count is recorded explicitly");
	assert.equal(dupIds.duplicates >= 1, true, "the duplicate snapshot_begin identity IS a wire duplicate");
	assert.equal(dupIds.unique, 1, "all duplicate answers share one wire identity (snapshotSeq reuse)");
	assert.equal(tr.evidence.cleanup.ok, true);
	assert.deepEqual(tr.evidence.cleanup.forcedKills, []);
});

test("step 20B D1-stale-epoch: a stale baseline cannot publish after the newer epoch", async (t) => {
	const r = await runCli(t, ["--case", "D1-stale-epoch", "--repeat", "1", "--clock", "real"]);
	assert.equal(r.code, 0, `D1-stale-epoch must record valid evidence (stderr: ${r.stderr.slice(-500)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr.iterationValid, true, JSON.stringify(tr.error ?? tr));
	const ev = tr.evidence;
	assert.notEqual(ev.gen1Generation, null);
	assert.notEqual(ev.gen2Generation, null);
	assert.notEqual(ev.gen1Generation, ev.gen2Generation, "the replacement runner is a NEW epoch");
	assert.equal(ev.epochResetObserved, true);
	assert.equal(ev.subscribeAfterEpoch.sinceSeq, null, "the stale cursor is rejected (fresh snapshot)");
	assert.equal(ev.staleCursorRejected, true);
	assert.equal(ev.staleGenerationMessagesAfterEpoch, 0, "no old-epoch protocol message after the new epoch");
	assert.equal(ev.recoveryAt !== null, true, "a real recovery window precedes any content claim");
	assert.deepEqual(ev.stalePublishesAfterEpoch, [], "no old-generation write after the recovery");
	assert.equal(tr.staleClean, true);
	assert.ok(ev.scenarioKills.length >= 1, "the old owned kill is a scenario action");
	assert.equal(ev.resourceGates.ok, true, "resource gates hold for the stale-epoch case");
	assert.equal(ev.resourceGates.intervalsLive, 0);
	assert.equal(ev.resourceGates.oneShotsLive, 0);
	assert.equal(ev.resourceGates.socketsOpen, 0);
	assert.equal(ev.resourceGates.bridgeUnsubscribes >= 1, true);
	assert.equal(ev.staleParserDimension.status, "OBSERVED", "the managed-parser identity seam is actually observed");
	assert.match(ev.staleParserDimension.reason, /re-instrumented|parser identity/i);
	assert.ok(ev.staleParserDimension.parserIdentities.length >= 1, "at least one real parser identity was recorded");
	assert.equal(typeof ev.staleParserDimension.staleParserWritesObserved, "number");
	assert.equal(ev.cleanup.ok, true);
	assert.deepEqual(ev.cleanup.forcedKills, [], "ordered exit for the replacement");
	t.diagnostic(`D1-stale epoch ${ev.gen1Generation.slice(0,8)}->${ev.gen2Generation.slice(0,8)} persistenceWrites=${ev.persistenceWritesBeforeRecovery.length}`);
});

test("step 20B D2: new30 batch measures BOTH dispose shapes with per-shape counts and the same contract", async (t) => {
	const r = await runCli(t, ["--case", "D", "--repeat", "30", "--clock", "real"]);
	assert.equal(r.code, 0, `D2 new30 must record valid evidence with no infrastructure failure (stderr: ${r.stderr.slice(-500)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr.iterationsRun, 30, "all 30 iterations ran (no blind continuation, no early stop)");
	assert.equal(tr.stoppedAfterInfrastructureFailure, false);
	assert.deepEqual(tr.infrastructureErrors, [], "no infrastructure failure in the new30");
	assert.equal(tr.iterationValidAll, true, "every iteration is harness-valid");
	assert.deepEqual(tr.complianceFailures, [], "no compliance/resource failure");

	// Per-shape counts are kept separate (never aggregated away).
	const quiet = tr.quiet;
	const rp = tr.renderPending;
	assert.equal(quiet.shape, "quiet");
	assert.equal(quiet.iterations, 15);
	assert.equal(quiet.iterationValidCount, 15);
	assert.equal(quiet.shapeValidCount, 15, "quiet iterations really had no in-flight output after dispose");
	assert.equal(quiet.resourceGatesOkCount, 15, "quiet resource gates hold");
	assert.equal(quiet.cleanupOkCount, 15);
	assert.equal(quiet.postCloseWritesMax, 0, "quiet shape: zero post-close writes");
	assert.equal(quiet.postCloseFramesMax, 0);
	assert.equal(quiet.productCleanCount, 15, "quiet shape is product-CLEAN (contract holds)");
	assert.equal(quiet.productFailureCount, 0);

	assert.equal(rp.shape, "render-pending");
	assert.equal(rp.iterations, 15);
	assert.equal(rp.iterationValidCount, 15, "render-pending iterations are VALID (a product failure is not infra-invalid)");
	assert.equal(rp.shapeValidCount, 15, "render-pending iterations really had in-flight child output");
	assert.equal(rp.resourceGatesOkCount, 15);
	assert.equal(rp.cleanupOkCount, 15);
	assert.equal(rp.ownedTimersLiveMax, 0);
	assert.equal(rp.socketsOpenMax, 0);
	assert.equal(rp.harnessTimersLiveMax, 0);

	// The SAME zero-post-close contract is evaluated for every iteration; product
	// failures are counted, never expected/forced. The verdict follows the
	// contract in the true direction (no defect enshrining).
	for (const it of tr.iterations) {
		assert.equal(typeof it.zeroPostClose, "boolean");
		assert.equal(it.productClean, it.zeroPostClose === true && it.resourceGates?.ok === true, `iteration ${it.iteration} verdict follows the contract`);
		if (it.shape === "quiet") assert.equal(it.productClean, true, `quiet iteration ${it.iteration} must be clean`);
	}
	assert.equal(tr.renderPendingProductFailureCount, rp.iterations - rp.productCleanCount, "render-pending failures are counted honestly");

	// Coverage boundary is explicit: D2 is not full D coverage.
	assert.equal(tr.fullyCovered, false);
	assert.match(tr.coverageBoundary, /STOPPED_UNKNOWN|P4|zero-post-close/i);
	t.diagnostic(`D2 new30: quiet ${quiet.productCleanCount}/${quiet.iterations} clean; render-pending product failures ${tr.renderPendingProductFailureCount}/${rp.iterations} (contract RED, valid iterations); max post-close ${tr.maxPostCloseWrites}/${tr.maxPostCloseFrames}; max timers ${tr.maxOwnedTimersLive}`);
});

test("step 20B CLI: unsupported case and non-integer D repeat fail explicitly with exit 2 and no stdout", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "s20b-cli-reject-"));
	for (const args of [
		["--case", "A4", "--repeat", "1", "--clock", "real", "--artifact-dir", join(artifactDir, "a")],
		["--case", "D", "--repeat", "0", "--clock", "real", "--artifact-dir", join(artifactDir, "b")],
		["--case", "R-reconnect", "--repeat", "2", "--clock", "real", "--artifact-dir", join(artifactDir, "c")],
	]) {
		const child = spawn(process.execPath, ["--experimental-transform-types", scenarioPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
		assert.equal(code, 2, `args ${args.join(" ")} must exit 2`);
		assert.equal(stdout, "", "no stdout on CLI rejection");
		assert.ok(stderr.length > 0);
	}
	rmSync(artifactDir, { recursive: true, force: true });
});
