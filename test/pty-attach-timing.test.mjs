import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Issue #222 step 21A (task-21a-brief.md): fake-clock readiness harness.
// Pure fake-clock/drain/oracle negatives plus real-runner integration cases for
// UNDECIDED / B(same-size) / S(split, incl. close+open in one chunk) /
// DELAYED B+S / LATE-STALE timers. Contract assertions stay TRUE-DIRECTION: the
// current source is expected to FAIL the modern-before-settle and
// no-publish-before-complete contracts (named timing REDs, kept separate from
// the existing D1-dispose RED). No production fast path is enabled.

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const scenarioPath = resolve(REPO_ROOT, "test-support/pty-attach-timing-scenario.ts");

async function scenario() {
	return import(scenarioPath);
}

function runCli(t, caseId) {
	const artifactDir = mkdtempSync(join(tmpdir(), "s21a-cli-"));
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

// ---------------------------------------------------------------------------
// Pure fake clock (advance ONLY on explicit tick)
// ---------------------------------------------------------------------------

test("step 21A: the fake clock advances only on tick, flushes zero-delay work without passing time", async () => {
	const s = await scenario();
	const clock = s.createFakeClock(0);
	clock.install();
	try {
		const fired = [];
		globalThis.setTimeout(() => fired.push({ what: "zero", at: clock.now() }), 0);
		globalThis.setTimeout(() => fired.push({ what: "settle250", at: clock.now() }), 250);
		globalThis.setTimeout(() => fired.push({ what: "hard2500", at: clock.now() }), 2500);
		// Flushing zero-delay work must NOT advance time or fire the 250/2500 timers.
		clock.fireDueNow();
		assert.deepEqual(fired, [{ what: "zero", at: 0 }], "only the zero-delay task fired; virtual time unchanged");
		assert.equal(clock.now(), 0);
		// A tick with no due timer still ADVANCES virtual time (no-op ticks are a bug).
		clock.tick(50);
		assert.equal(clock.now(), 50);
		clock.tick(199);
		assert.equal(fired.length, 1, "the 250 ms timer has not fired at 249 ms");
		clock.tick(1);
		assert.deepEqual(fired[1], { what: "settle250", at: 250 }, "the settle timer fires exactly at its virtual due time");
		assert.equal(fired.length, 2);
		clock.tick(2250);
		assert.equal(fired[2]?.what, "hard2500");
		assert.equal(fired[2]?.at, 2500);
		// Intervals re-arm; clear() prevents firing.
		let ticks = 0;
		const interval = globalThis.setInterval(() => {
			ticks += 1;
		}, 120);
		clock.tick(360);
		assert.ok(ticks >= 2, `interval re-armed (${ticks} ticks)`);
		globalThis.clearInterval(interval);
		const before = ticks;
		clock.tick(500);
		assert.equal(ticks, before, "a cleared interval never fires again");
	} finally {
		clock.uninstall();
	}
});

// ---------------------------------------------------------------------------
// Pure oracle negatives
// ---------------------------------------------------------------------------

const LITERAL = ["F0 HEADER controlled work area", "F0 UPPER x", "F0 TAIL assistant final answer", "", "F0 INPUT >"];

test("step 21A: classifyCommit rejects half frames and arbitrary chunk-close commits", async () => {
	const s = await scenario();
	assert.equal(s.classifyCommit(LITERAL, LITERAL), "complete");
	assert.equal(s.classifyCommit(["", "", ""], LITERAL), "blank");
	assert.equal(s.classifyCommit(["   ⠋ Loading \"s21a\"…"], LITERAL), "loading");
	assert.equal(s.classifyCommit(["F0 HEADER controlled work area", "F0 TAIL assistant final answer"], LITERAL), "half-frame", "TAIL without the complete literal is a half frame");
	assert.equal(s.classifyCommit(["F0 HEADER controlled work area", "", "F0 INPUT >"], LITERAL), "half-frame", "INPUT without the rest is a half frame");
	assert.equal(s.classifyCommit(["F0 HEADER controlled work area", "F0 UPPER x", "F0 TAIL assistant final answer", "", "F0 INPUT >", "extra"], LITERAL), "half-frame", "an over-long frame is not the declared literal");
	// An arbitrary chunk close (a commit right after a close fragment) must never
	// be classified complete unless the DECLARED literal really matches.
	const arbitraryClose = { index: 0, at: 10, kind: "frame", note: null, rows: ["F0 HEADER controlled work area", "F0 UPPER x"], cursor: { x: 0, y: 0, visible: false } };
	assert.equal(s.classifyCommit(arbitraryClose.rows, LITERAL), "other", "marker-less partial content is not a frame");
	assert.equal(s.firstCompleteCommit([arbitraryClose], LITERAL), null, "an arbitrary chunk close is never a publish");
	const chunkCloseWithPrompt = { ...arbitraryClose, rows: ["F0 HEADER controlled work area", "F0 INPUT >"] };
	assert.equal(s.halfFrameCommits([chunkCloseWithPrompt], LITERAL).length, 1, "a chunk close that already shows the prompt is a half frame");
	assert.equal(s.firstCompleteCommit([chunkCloseWithPrompt], LITERAL), null);
});

test("step 21A: evaluateModernBeforeSettle requires the publish at the complete boundary (settle-boundary publish FAILS)", async () => {
	const s = await scenario();
	const modern = s.evaluateModernBeforeSettle({ completeFrameAt: 0, publishAt: 5 });
	assert.equal(modern.ok, true);
	assert.equal(modern.publishedBeforeSettle, true);
	const settlePublish = s.evaluateModernBeforeSettle({ completeFrameAt: 0, publishAt: 250 });
	assert.equal(settlePublish.publishedBeforeSettle, false);
	assert.equal(settlePublish.ok, false, "waiting for the 250 ms settle window is NOT the modern contract");
	const missing = s.evaluateModernBeforeSettle({ completeFrameAt: 0, publishAt: null });
	assert.equal(missing.ok, false, "no publish observed is a failure, never success");
	assert.equal(missing.note, "no complete publish observed");
});

test("step 21A: evaluateDelayed rejects early content and a settle-only publish", async () => {
	const s = await scenario();
	const bootCommit = { index: 0, at: 10, kind: "unframed", note: null, rows: ["fake pi boot: core ready"], cursor: { x: 0, y: 0, visible: false } };
	const early = s.evaluateDelayed({ commitsBeforeBoundary: [bootCommit], literal: LITERAL, completeFrameAt: 500, boundaryPublishAt: 505 });
	assert.equal(early.noEarlyPublish, false, "BOOT/partial content before the complete frame fails");
	assert.equal(early.ok, false);
	const settleOnly = s.evaluateDelayed({ commitsBeforeBoundary: [], literal: LITERAL, completeFrameAt: 500, boundaryPublishAt: null, settlePublishAt: 750 });
	assert.equal(settleOnly.noEarlyPublish, true);
	assert.equal(settleOnly.publishedAtCompleteBoundary, false);
	assert.equal(settleOnly.settlePublishBeforeHardTimeout, true, "the old settle publish is before the hard cap but NOT at the boundary");
	assert.equal(settleOnly.ok, false, "a settle-only publish is a named delayed RED");
	const clean = s.evaluateDelayed({ commitsBeforeBoundary: [], literal: LITERAL, completeFrameAt: 500, boundaryPublishAt: 505 });
	assert.equal(clean.ok, true);
	const late = s.evaluateDelayed({ commitsBeforeBoundary: [], literal: LITERAL, completeFrameAt: 500, boundaryPublishAt: 900 });
	assert.equal(late.ok, false, "publishing beyond the boundary budget fails");
});

test("step 21A: evaluateLateTimers rejects repeated hooks, a second first view and post-dispose renders", async () => {
	const s = await scenario();
	const base = {
		hooksBefore: { colorProbe: 1, schemeBridge: 1 },
		hooksAfter: { colorProbe: 1, schemeBridge: 1 },
		completeCommitsBefore: 1,
		completeCommitsAfter: 1,
		halfFramesAfter: 0,
		postDisposeWrites: 0,
	};
	assert.equal(s.evaluateLateTimers(base).ok, true);
	assert.equal(s.evaluateLateTimers({ ...base, hooksAfter: { colorProbe: 2, schemeBridge: 1 } }).hooksNotRepeated, false, "a repeated probe hook fails");
	assert.equal(s.evaluateLateTimers({ ...base, hooksAfter: { colorProbe: 1, schemeBridge: 2 } }).ok, false, "a repeated bridge hook fails");
	assert.equal(s.evaluateLateTimers({ ...base, completeCommitsAfter: 2 }).noSecondFirstView, false, "a second first view fails");
	assert.equal(s.evaluateLateTimers({ ...base, halfFramesAfter: 1 }).ok, false, "a half frame after the publish fails");
	assert.equal(s.evaluateLateTimers({ ...base, postDisposeWrites: 1 }).noPostDisposeRender, false, "a post-dispose render fails");
});

test("step 21A: evaluateUndecided and evaluatePublishIdentity reject premature readiness and stale identity", async () => {
	const s = await scenario();
	const clean = { loadingObserved: true, commitsDuringWindow: 0, hooksDuringWindow: { colorProbe: 0, schemeBridge: 0 }, firedTimerOwners: [], ok: false };
	assert.equal(s.evaluateUndecided(clean).ok, true);
	assert.equal(s.evaluateUndecided({ ...clean, loadingObserved: false }).ok, false, "a missing loading state is not clean");
	assert.equal(s.evaluateUndecided({ ...clean, commitsDuringWindow: 1 }).ok, false, "any publish before the baseline fails");
	assert.equal(s.evaluateUndecided({ ...clean, hooksDuringWindow: { colorProbe: 1, schemeBridge: 0 } }).ok, false, "first hooks before the baseline fail");
	assert.equal(s.evaluatePublishIdentity({ publishIdentity: "gen-a:1", qualifiedIdentity: "gen-a:1" }).ok, true);
	assert.equal(s.evaluatePublishIdentity({ publishIdentity: "gen-old:9", qualifiedIdentity: "gen-a:1" }).ok, false, "a stale baseline identity fails");
	assert.equal(s.evaluatePublishIdentity({ publishIdentity: null, qualifiedIdentity: "gen-a:1" }).ok, false, "an UNKNOWN identity is never clean");
});

test("step 21A: the publish cursor is compared against the PROJECTED screen cursor (logical + bodyTop)", async () => {
	const s = await scenario();
	const dims = { bodyTop: 1 };
	const logical = { x: 10, y: 21, visible: false };
	assert.deepEqual(s.projectCursorToScreen(logical, dims), { x: 10, y: 22, visible: false }, "logical 21 projects to screen 22 with bodyTop 1");
	// The observer's raw SCREEN cursor (22) matches the projection, not the logical value.
	const screenCommit = { index: 3, at: 10, kind: "frame", note: null, rows: [], cursor: { x: 10, y: 22, visible: false } };
	assert.equal(s.cursorMatches(screenCommit.cursor, s.projectCursorToScreen(logical, dims)), true);
	assert.equal(s.cursorMatches(screenCommit.cursor, logical), false, "comparing a screen cursor to the LOGICAL value is the old defect");
	// Wrong bodyTop and wrong coordinates are rejected.
	assert.equal(s.cursorMatches(screenCommit.cursor, s.projectCursorToScreen(logical, { bodyTop: 0 })), false, "wrong bodyTop rejected");
	assert.equal(s.cursorMatches(screenCommit.cursor, s.projectCursorToScreen({ ...logical, x: 11 }, dims)), false, "wrong x rejected");
	assert.equal(s.cursorMatches(screenCommit.cursor, s.projectCursorToScreen({ ...logical, visible: true }, dims)), false, "wrong visibility rejected");
	assert.equal(s.cursorMatches(null, s.projectCursorToScreen(logical, dims)), false, "a missing publish cursor is never a match");
	const evidence = s.evaluatePublishCursor(screenCommit, logical, dims);
	assert.deepEqual(evidence.rawScreenCursor, { x: 10, y: 22, visible: false }, "raw screen cursor preserved");
	assert.deepEqual(evidence.logicalExpected, logical, "logical expectation retained");
	assert.deepEqual(evidence.projectedExpectedScreen, { x: 10, y: 22, visible: false }, "projected screen expectation retained");
	assert.equal(evidence.bodyTop, 1);
	assert.equal(evidence.matched, true);
	assert.equal(s.evaluatePublishCursor(null, logical, dims).matched, false);
});

test("step 21A: publish ordering is derived from drain/render event indices, not timestamps", async () => {
	const s = await scenario();
	const publish = { index: 5, at: 10, kind: "frame", note: null, rows: [], cursor: { x: 0, y: 0, visible: false } };
	const parserLog = [
		{ kind: "write", at: 10, observationCount: 2 },
		{ kind: "drain", at: 10, observationCount: 3 },
	];
	const requestRenders = [{ at: 9, observationCount: 3 }];
	const ok = s.evaluatePublishOrdering({ publish, parserLog, requestRenders });
	assert.equal(ok.drainAtOrBeforePublish, true, "the drain that produced the publish precedes it by observation count");
	assert.equal(ok.renderAtOrBeforePublish, true);
	assert.equal(ok.ok, true);
	// SAME virtual timestamp is allowed only with the sequence; a drain observed
	// AFTER the publish index must fail even at the same timestamp.
	const lateDrain = s.evaluatePublishOrdering({ publish, parserLog: [{ kind: "drain", at: 10, observationCount: 6 }], requestRenders });
	assert.equal(lateDrain.drainAtOrBeforePublish, false, "a drain observed after the publish is not an ordering pass");
	assert.equal(lateDrain.ok, false);
	const lateRender = s.evaluatePublishOrdering({ publish, parserLog, requestRenders: [{ at: 10, observationCount: 7 }] });
	assert.equal(lateRender.renderAtOrBeforePublish, false);
	assert.equal(lateRender.ok, false);
	// A same-time drain/render logged AFTER the publish must not hide the real
	// preceding pair. Node 24 exposed this ordering in the A5 fake-clock trial.
	const sameTimeInterleaving = s.evaluatePublishOrdering({
		publish,
		parserLog: [...parserLog, { kind: "drain", at: 10, observationCount: 6 }],
		requestRenders: [...requestRenders, { at: 10, observationCount: 6 }],
	});
	assert.equal(sameTimeInterleaving.lastDrain.observationCount, 3);
	assert.equal(sameTimeInterleaving.lastRenderRequest.observationCount, 3);
	assert.equal(sameTimeInterleaving.ok, true, "event sequence, not same-time log position, selects the preceding pair");
	assert.equal(s.evaluatePublishOrdering({ publish: null, parserLog, requestRenders }).ok, false, "no publish is never an ordering pass");
});

// ---------------------------------------------------------------------------
// Real integration (real runner/child/component/TUI/parser, VIRTUAL timers)
// ---------------------------------------------------------------------------

test("step 21A undecided: loading/hooks0/no publish before the baseline, then exactly one transition", async (t) => {
	const r = await runCli(t, "undecided");
	assert.equal(r.code, 0, `undecided must run (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr?.ok, true, JSON.stringify(tr?.error ?? tr));
	const ev = tr.evidence;
	assert.equal(ev.undecided.ok, true, "the pre-baseline window is loading-only with zero hooks and no publish");
	assert.equal(ev.undecided.loadingObserved, true);
	assert.equal(ev.undecided.commitsDuringWindow, 0);
	assert.deepEqual(ev.undecided.hooksDuringWindow, { colorProbe: 0, schemeBridge: 0 });
	assert.ok(ev.undecided.firedTimerOwners.length > 0, "stale/legacy timers really fired in the window");
	assert.deepEqual(ev.windowClasses.filter((kind) => kind !== "loading" && kind !== "blank"), [], "no content in the undecided window");
	assert.equal(ev.publishedDuringWindow, 0);
	assert.notEqual(ev.publishAt, null, "the qualified baseline completes after the window");
	assert.ok(["snapshot", "empty-live"].includes(ev.baselineKind), "the baseline kind is recorded (non-empty snapshot frame or empty baseline completed through producer steps)");
	assert.equal(ev.targetFrameId, "F0", "the modern gate targets the live current complete frame");
	assert.equal(ev.distinctCompleteContent, 1, "the new identity completes exactly once (repaints are not transitions)");
	assert.equal(ev.completeBeforeTransitionLoop, true, "the qualified live complete frame existed before the bounded evidence loop (truthful event semantics)");
	assert.ok(ev.parserDrains >= 1, "the undecided path records its parser drain milestone like B");
	assert.equal(ev.cursor.matched, true, "the publish cursor matches the PROJECTED screen cursor");
	assert.deepEqual(ev.cursor.rawScreenCursor, ev.cursor.projectedExpectedScreen, "raw screen cursor equals the projected expectation");
	assert.equal(ev.cursor.logicalExpected.y + ev.cursor.bodyTop, ev.cursor.projectedExpectedScreen.y, "logical + bodyTop is the projected screen value");
	assert.equal(ev.ordering.ok, true, "the drain/render sequence precedes the publish by event index");
	assert.deepEqual(ev.hooksAfter, { colorProbe: 1, schemeBridge: 1 });
	assert.equal(ev.identity.ok, true);
	assert.equal(ev.cleanup.ok, true);
	assert.deepEqual(ev.cleanup.forcedKills, []);
});

test("step 21A B(same-size) CONTRACT: the complete frame publishes before the 250 ms settle (modern GREEN)", async (t) => {
	const r = await runCli(t, "B");
	assert.equal(r.code, 0, `B must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const ev = r.parsed.trials[0].evidence;
	assert.equal(ev.resizes, 0, "same-size attach sends zero resize");
	assert.ok(ev.parserDrains > 0, "the local parser really drained");
	assert.equal(ev.halfFrames, 0, "no half frame is ever published");
	assert.deepEqual(ev.hooksAfter, { colorProbe: 1, schemeBridge: 1 }, "the qualified complete boundary installs the first hooks exactly once");
	assert.deepEqual(ev.oldSettleHooks, { colorProbe: 1, schemeBridge: 1 }, "no later settle fires the hooks again");
	t.diagnostic(`B: modern publish at ${JSON.stringify(ev.publishAt)} (complete frame at ${ev.completeFrameAt}); old settle publish at ${ev.oldSettlePublishAt}`);
	// CONTRACT (true direction): publish within the modern budget of the complete
	// frame. Current source waits for the 250 ms settle -> named timing RED.
	assert.equal(ev.oldSettleCursor.matched, true, "the SAME projected-cursor assertion passes on a real publish: the cursor oracle is not the reason for this RED");
	assert.equal(ev.oldSettleOrdering.ok, true, "the same event-index ordering passes on that real publish");
	assert.equal(ev.cursor.projectedExpectedScreen.y, ev.cursor.logicalExpected.y + ev.cursor.bodyTop, "cursor projection is explicit (logical + bodyTop)");
	assert.equal(ev.modern.ok, true, `CONTRACT: publish at the complete boundary (old source publishes at ${ev.oldSettlePublishAt} after the settle)`);
	assert.ok(ev.publishAt !== null, "CONTRACT: the complete literal is committed at the boundary");
});

test("step 21A S(split) CONTRACT: first qualified frame publishes before the settle; later split frames are step25 projection", async (t) => {
	const r = await runCli(t, "S");
	assert.equal(r.code, 0, `S must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const ev = r.parsed.trials[0].evidence;
	assert.equal(ev.midCompleteAt, null, "the F1 target literal is still incomplete at the upper half");
	assert.equal(ev.initialModern.ok, true, "the current complete seed frame publishes at its complete boundary");
	assert.equal(ev.initialPublishAt, 0);
	assert.equal(ev.initialHalfFrames, 0, "no half frame is committed before the first qualified publish");
	assert.equal(ev.postInitialHalfFrames, 0, "no target half frame is committed after the first qualified publish");
	assert.equal(ev.mixedFrameNumbers, 0, "no commit mixes two synchronized frame numbers");
	assert.equal(ev.midComponentFacts.committedView !== null, true, "the open block keeps the previous committed view");
	assert.equal(ev.midComponentFacts.committedView.rows > 0, true);
	assert.equal(ev.midComponentFacts.committedView.firstRow.includes("F0"), true, "status/ticker control renders stay on the previous complete grid");
	assert.deepEqual(ev.hooksAfter, { colorProbe: 1, schemeBridge: 1 }, "first hooks fire once at the qualified initial publish");
	assert.deepEqual(ev.oldSettleHooks, { colorProbe: 1, schemeBridge: 1 }, "later settle callbacks do not repeat the hooks");
	assert.equal(ev.oldSettleCursor.matched, true, "projected cursor matches on a later real publish");
	assert.equal(ev.oldSettleOrdering.ok, true);
	assert.equal(ev.cursor.projectedExpectedScreen.y, ev.cursor.logicalExpected.y + ev.cursor.bodyTop);
	t.diagnostic(`S: initial publish at ${JSON.stringify(ev.initialPublishAt)}; later F1 complete at ${JSON.stringify(ev.publishAt)} (post-transition, step25 projection boundary)`);
});

test("step 21A S-close-open CONTRACT: first qualified frame publishes before the settle; later close+open render stays step25", async (t) => {
	const r = await runCli(t, "S-close-open");
	assert.equal(r.code, 0, `S-close-open must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const ev = r.parsed.trials[0].evidence;
	assert.equal(ev.splitFrameId, "F2");
	assert.equal(ev.initialModern.ok, true, "the current complete seed frame publishes at its complete boundary");
	assert.equal(ev.initialPublishAt, 0);
	assert.equal(ev.initialHalfFrames, 0, "no half frame is committed before the first qualified publish");
	assert.equal(ev.postInitialHalfFrames, 0, "no target half frame is committed after the first qualified publish");
	assert.equal(ev.mixedFrameNumbers, 0, "no commit mixes two synchronized frame numbers");
	assert.equal(ev.midComponentFacts.committedView.firstRow.includes("F1"), true, "close→open commits the F1 close state before F2 mutation");
	assert.equal(ev.midComponentFacts.committedView.firstRow.includes("F2"), false);
	assert.equal(ev.oldSettleCursor.matched, true, "projected cursor matches on a later real publish");
	assert.equal(ev.oldSettleOrdering.ok, true);
	assert.equal(ev.cursor.projectedExpectedScreen.y, ev.cursor.logicalExpected.y + ev.cursor.bodyTop);
	t.diagnostic(`S-close-open: initial publish at ${JSON.stringify(ev.initialPublishAt)}; later F2 complete at ${JSON.stringify(ev.publishAt)} (post-transition, step25 projection boundary)`);
});

test("step 21A delayed-B CONTRACT: a complete frame delayed past 250 ms publishes at ITS boundary, not after the settle (modern GREEN)", async (t) => {
	const r = await runCli(t, "delayed-B");
	assert.equal(r.code, 0, `delayed-B must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const ev = r.parsed.trials[0].evidence;
	assert.equal(ev.virtualNowBeforeHost, 300, "the host (and therefore the complete frame) was held past the settle window");
	assert.equal(ev.delayed.noEarlyPublish, true, "nothing content-like publishes before the complete frame");
	assert.deepEqual(ev.beforeHooks, { colorProbe: 0, schemeBridge: 0 }, "no first hooks before the complete frame");
	assert.equal(ev.delayed.settlePublishBeforeHardTimeout, true, "the complete publish is before the 2500 ms cap");
	assert.deepEqual(ev.hooksAfter, { colorProbe: 1, schemeBridge: 1 }, "hooks fire exactly once at the complete boundary");
	assert.deepEqual(ev.oldSettleHooks, { colorProbe: 1, schemeBridge: 1 }, "no later settle repeats the hooks");
	assert.equal(ev.oldSettleCursor.matched, true, "projected cursor matches on the real settle publish (no cursor harness RED)");
	assert.equal(ev.oldSettleOrdering.ok, true);
	assert.match(ev.completeFrameAtNote, /pump-tick boundary/, "the late-host complete boundary is a pump tick, not an exact arrival instant");
	t.diagnostic(`delayed-B: boundary publish ${JSON.stringify(ev.delayed.boundaryPublishAt)}; old settle publish ${JSON.stringify(ev.delayed.settlePublishAt)} after complete frame at ${ev.completeFrameAt}`);
	assert.equal(ev.delayed.publishedAtCompleteBoundary, true, `CONTRACT: publish at the real complete boundary (old source publishes at ${ev.delayed.settlePublishAt})`);
});

test("step 21A delayed-S CONTRACT: no BOOT/partial publish and no first hooks before the complete frame (modern GREEN)", async (t) => {
	const r = await runCli(t, "delayed-S");
	assert.equal(r.code, 0, `delayed-S must record valid evidence (stderr: ${r.stderr.slice(-400)})`);
	const ev = r.parsed.trials[0].evidence;
	assert.equal(ev.midHalfFrames, 0, "the incomplete upper half is never a publish target");
	assert.equal(ev.midCompleteAt, null, "no complete frame before the lower half");
	t.diagnostic(`delayed-S: content commits before the complete frame=${ev.midContentCommits}; hooks before=${JSON.stringify(ev.midHooks)}; boundary publish ${JSON.stringify(ev.delayed.boundaryPublishAt)} vs settle ${JSON.stringify(ev.delayed.settlePublishAt)}`);
	// CONTRACT (true direction): the legacy settle must not release BOOT/unframed
	// content or the first hooks while the authoritative frame is incomplete.
	assert.equal(ev.delayedSubverdictConditional, true, "the boundary sub-verdict is conditional, NOT independent modern-budget evidence");
	assert.match(ev.delayedSubverdictNote, /conditional/);
	assert.match(ev.settleChronology, /250/, "the settle fired at 250 BEFORE the boot text/halves");
	assert.match(ev.settleChronology, /post-transition live output/);
	assert.equal(ev.cursor.matched, true, "the E1 publish cursor matches the projected screen cursor");
	assert.deepEqual(ev.cursor.rawScreenCursor, ev.cursor.projectedExpectedScreen);
	assert.equal(ev.ordering.ok, true);
	assert.equal(ev.midContentCommits, 0, "CONTRACT: no BOOT/partial content before the complete frame (old source releases it at the 250 ms settle)");
	assert.deepEqual(ev.midHooks, { colorProbe: 0, schemeBridge: 0 }, "CONTRACT: first hooks only at the complete frame");
});

test("step 21A late-timers: late/stale callbacks never repeat hooks or render after dispose", async (t) => {
	const r = await runCli(t, "late-timers");
	assert.equal(r.code, 0, `late-timers must run (stderr: ${r.stderr.slice(-400)})`);
	const tr = r.parsed?.trials?.[0];
	assert.equal(tr?.ok, true, JSON.stringify(tr?.error ?? tr));
	const ev = tr.evidence;
	assert.equal(ev.late.ok, true);
	assert.deepEqual(ev.hooksBefore, { colorProbe: 1, schemeBridge: 1 }, "a qualified publish really happened first");
	assert.equal(ev.late.hooksNotRepeated, true, "late settle/hard-timeout callbacks do not repeat first hooks");
	assert.equal(ev.late.noSecondFirstView, true, "no second first view is published");
	assert.equal(ev.late.halfFramesAfter, 0);
	assert.equal(ev.late.postDisposeWrites, 0, "no render after dispose");
	assert.equal(ev.cursor.matched, true, "the qualified publish cursor matches the projected screen cursor");
	assert.equal(ev.ordering.ok, true);
	assert.equal(ev.cleanup.ok, true);
});

test("step 21A CLI: an unsupported case fails with exit 2 and no stdout", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "s21a-cli-reject-"));
	const child = spawn(process.execPath, ["--experimental-transform-types", scenarioPath, "--case", "A4", "--artifact-dir", join(artifactDir, "a")], {
		stdio: ["ignore", "pipe", "pipe"],
	});
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
