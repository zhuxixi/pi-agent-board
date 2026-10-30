// Issue #222 step 23a fix1 (task-23a-smoke-fix1-brief.md): pure diagnostic
// candidate-evaluator negatives + replays of the RETAINED actual Pi streams.
//
// Everything here is pure: no PTY, no Pi child, no network. The evaluator is the
// test-support diagnostic from `test-support/pi23a-candidate-evaluator.ts`; the
// streams are exact probe JSONL/result fixtures retained from the initial
// delivery (`task-23a-smoke-artifacts/fullscreen-4-*`, `regular-4-*`). They live
// under test-support so clean checkouts exercise the same bytes; source hashes
// accompany the fixtures. Expected decisions are stated independently per case,
// so a grammar regression turns the case red rather than re-baselining it.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ARTIFACTS = resolve(REPO_ROOT, "test-support/fixtures/pi23a-smoke");
const evaluatorModule = await import(resolve(REPO_ROOT, "test-support/pi23a-candidate-evaluator.ts"));
const { FrameCandidateEvaluator } = evaluatorModule;

const SYNC_OPEN = "\u001b[?2026h";
const SYNC_CLOSE = "\u001b[?2026l";
const CURSOR_HIDE = "\u001b[?25l";

function newEvaluator(mode, extra = {}) {
	return new FrameCandidateEvaluator({ mode, ...extra });
}

function kinds(decisions) {
	return decisions.map((decision) => decision.kind);
}

function has(decisions, kind) {
	return decisions.some((decision) => decision.kind === kind);
}

/**
 * RED witness for the negatives: a naive rule ("any write proves the frame") that
 * a regression would converge to. Each negative asserts the real evaluator rejects
 * what this naive rule accepts, so the case has discriminating power.
 */
function naiveWouldPublish(op) {
	return op.kind === "write" && op.text.length > 0;
}

// ---------------------------------------------------------------------------
// A. Pure negatives (wrong first size, missing focus, non-render read, BOOT,
//    regular plain/hideCursor, premature close, wrong cursor tail, stop,
//    marker recursion)
// ---------------------------------------------------------------------------

test("fix1 negative: a second sampling pair cannot overwrite the first sampled size", () => {
	const evaluator = newEvaluator("regular", { targetCols: 80, targetRows: 24 });
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	evaluator.sizeRead("columns", 132);
	evaluator.sizeRead("rows", 43);
	evaluator.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "regular" });
	const decisions = evaluator.op({ kind: "write", text: `${SYNC_OPEN}content${SYNC_CLOSE}` });
	assert.equal(has(decisions, "S"), true, "the first sampled pair (80x24) matches the intent");
	const candidate = evaluator.log.find((decision) => decision.kind === "candidate");
	assert.equal(candidate.sampledCols, 80);
	assert.equal(candidate.sampledRows, 24);
});

test("fix1 negative: a sampled size that differs from the intent aborts instead of proving", () => {
	const evaluator = newEvaluator("fullscreen", { targetCols: 132, targetRows: 43 });
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	evaluator.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "fullscreen" });
	const decisions = evaluator.op({ kind: "write", text: `${SYNC_OPEN}\u001b[1;1H${SYNC_CLOSE}` });
	assert.equal(has(decisions, "S"), false);
	assert.equal(has(decisions, "A"), false, "no S was emitted, so no A is owed");
	assert.match(decisions.at(-1).reason, /sampled-size-mismatch/);
});

test("fix1 negative: missing focus at sentinel time can never emit S (and the naive rule would)", () => {
	const evaluator = newEvaluator("fullscreen");
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	evaluator.sentinel({ focusPresent: false, focusIdentity: null, mode: "fullscreen" });
	const op = { kind: "write", text: `${SYNC_OPEN}\u001b[1;1H${SYNC_CLOSE}` };
	const decisions = evaluator.op(op);
	assert.equal(naiveWouldPublish(op), true, "RED witness: the naive rule would publish this write");
	assert.equal(has(decisions, "S"), false);
	assert.match(decisions.at(-1).reason, /focus-missing/);
});

test("fix1 negative: a non-render size read opens no candidate and never emits S", () => {
	const evaluator = newEvaluator("fullscreen");
	// Only one of the two dimensions is read outside a render: no pair, no candidate.
	evaluator.sizeRead("columns", 80);
	assert.deepEqual(kinds(evaluator.log), []);
	evaluator.fence();
	assert.deepEqual(evaluator.log.map((decision) => decision.kind), [], "no candidate means no decision");
	assert.equal(has(evaluator.log, "S"), false);
});

test("fix1 negative: BOOT/raw/control-only output is not a first or full proof", () => {
	const evaluator = newEvaluator("fullscreen");
	const bootOps = [
		{ kind: "write", text: "\u001b[?1049h\u001b[?25l\u001b[?2004h" },
		{ kind: "write", text: "\u001b]10;?\u0007" },
		{ kind: "write", text: "\u001b[c" },
	];
	for (const op of bootOps) {
		const decisions = evaluator.op(op);
		assert.equal(has(decisions, "S"), false);
		assert.equal(naiveWouldPublish(op), true, "RED witness: the naive rule would publish BOOT bytes");
	}
	assert.equal(has(evaluator.log, "F"), false);
});

test("fix1 negative: regular plain writes and cursor-only operations never prove a frame", () => {
	const evaluator = newEvaluator("regular");
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	evaluator.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "regular" });
	const plainWrite = { kind: "write", text: "\u001b[3A\u001b[1G" };
	const hide = { kind: "hideCursor", text: "" };
	assert.equal(has(evaluator.op(plainWrite), "S"), false);
	assert.equal(has(evaluator.op(hide), "S"), false);
	assert.equal(naiveWouldPublish(plainWrite), true, "RED witness: the naive rule would publish a plain write");
	evaluator.fence();
	assert.equal(has(evaluator.log, "F"), false, "no cursor-only path may create a full proof");
});

test("fix1 negative: a premature CLOSE without OPEN cannot finish a regular frame", () => {
	const evaluator = newEvaluator("regular");
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	evaluator.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "regular" });
	evaluator.op({ kind: "write", text: `${SYNC_CLOSE}` });
	const decisions = evaluator.op({ kind: "write", text: "\u001b[3A\u001b[1G" });
	assert.equal(has(decisions, "F"), false);
	evaluator.op({ kind: "hideCursor", text: "" });
	assert.equal(has(evaluator.log, "F"), false);
});

test("fix1 negative: a regular CLOSE without the cursor parking write and final visibility cannot finish", () => {
	const evaluator = newEvaluator("regular");
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	evaluator.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "regular" });
	evaluator.op({ kind: "write", text: `${SYNC_OPEN}content${SYNC_CLOSE}` });
	evaluator.fence();
	assert.deepEqual(kinds(evaluator.log).filter((kind) => kind === "S" || kind === "F"), ["S"], "S is emitted but F is not");
	assert.equal(has(evaluator.log, "A"), true, "an S that cannot finish must be aborted at the fence");
});

test("fix1 negative: stop aborts an emitted S and never leaves a silent S behind", () => {
	const evaluator = newEvaluator("regular");
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	evaluator.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "regular" });
	evaluator.op({ kind: "write", text: `${SYNC_OPEN}content` });
	evaluator.stop();
	const published = evaluatorModule.publishedDecisions(evaluator.log);
	assert.deepEqual(published.map((decision) => decision.kind), ["S", "A"]);
	assert.equal(published[1].reason, "stop");
	// A candidate that had not emitted S dies silently.
	const quiet = newEvaluator("regular");
	quiet.sizeRead("columns", 80);
	quiet.sizeRead("rows", 24);
	quiet.stop();
	assert.equal(has(quiet.log, "A"), false);
	assert.equal(has(quiet.log, "S"), false);
});

test("fix1 negative: marker writes never re-enter candidate accounting", () => {
	const evaluator = newEvaluator("fullscreen");
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	evaluator.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "fullscreen" });
	const before = evaluator.log.length;
	evaluator.markerWrite("S");
	assert.equal(evaluator.sawMarkerRecursion, false, "a marker outside an op is not recursion");
	const decisions = evaluator.op({ kind: "write", text: `${SYNC_OPEN}\u001b[1;1H${SYNC_CLOSE}` });
	evaluator.markerWrite("F");
	assert.deepEqual(decisions.map((decision) => decision.kind), ["S", "F"], "marker writes add no decisions");
	assert.equal(evaluator.log.filter((decision) => decision.kind === "S").length, 1, "exactly one S for the candidate");
	assert.ok(evaluator.log.length >= before);
});

// ---------------------------------------------------------------------------
// B. Replays of the RETAINED actual Pi streams
// ---------------------------------------------------------------------------

function readProbeEvents(dirName) {
	const dir = join(ARTIFACTS, dirName);
	return readFileSync(join(dir, "probe.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function latestCell(prefix) {
	const match = readdirSync(ARTIFACTS)
		.filter((name) => name.startsWith(prefix))
		.sort()
		.at(-1);
	return match === undefined ? null : match;
}

/** Reconstruct the operation text from the RECORDED flags and head only. */
function recordedOp(op) {
	return {
		kind: op.key,
		text: `${op.hasSyncOpen === true ? SYNC_OPEN : ""}${op.head ?? ""}${op.hasSyncClose === true ? SYNC_CLOSE : ""}`,
	};
}

/**
 * Replay a retained stream: `size-read` feeds sampling, `sentinel-render` feeds
 * the sentinel fact, `terminal-op` feeds operations. The replay is deliberately
 * independent of the probe's own decisions (the retained streams have none).
 */
function geometryFrom(events) {
	const geometry = events.find((event) => event.event === "non-render-size-reads");
	return { columns: geometry?.columns ?? null, rows: geometry?.rows ?? null };
}

function replay(events, { mode, from = 0, to = events.length, onDecision } = {}) {
	const evaluator = newEvaluator(mode);
	const geometry = geometryFrom(events);
	let previousOp = null;
	let writesSinceOpen = 0;
	const pairs = [];
	for (let index = from; index < to; index += 1) {
		const event = events[index];
		if (event.event === "size-read") {
			// The initial delivery's probe logged no `value` on size-read events. The
			// actual geometry of that same run IS recorded (`non-render-size-reads`),
			// so the replay supplies it and says so instead of inventing a size.
			const value = typeof event.value === "number" ? event.value : event.key === "columns" ? geometry.columns : geometry.rows;
			if (typeof value !== "number") continue;
			// A new sampling pair after this candidate already produced output starts
			// the next render cycle: fence the previous candidate here (the live probe
			// fences on process.nextTick for the same boundary).
			if (writesSinceOpen > 0) {
				const beforeFence = evaluator.log.length;
				evaluator.fence();
				for (const decision of evaluator.log.slice(beforeFence)) pairs.push({ decision, previousOp });
				writesSinceOpen = 0;
			}
			const before = evaluator.log.length;
			evaluator.sizeRead(event.key, value);
			for (const decision of evaluator.log.slice(before)) {
				if (onDecision !== undefined) onDecision(decision, { previousOp, event });
				pairs.push({ decision, previousOp });
				if (decision.kind === "candidate") writesSinceOpen = 0;
			}
		} else if (event.event === "sentinel-render") {
			evaluator.sentinel({ focusPresent: event.focusPresent === true, focusIdentity: event.focusPresent === true ? "focus" : null, mode: event.mode ?? mode });
		} else if (event.event === "terminal-op") {
			previousOp = { event, op: recordedOp(event) };
			writesSinceOpen += 1;
			const before = evaluator.log.length;
			evaluator.op(previousOp.op);
			for (const decision of evaluator.log.slice(before)) {
				if (onDecision !== undefined) onDecision(decision, { previousOp, event });
				pairs.push({ decision, previousOp });
			}
		}
	}
	evaluator.fence();
	return { evaluator, decisions: evaluator.log, pairs };
}

const fullscreenCell = latestCell("fullscreen-4-");
const regularCell = latestCell("regular-4-");

test("fix1 replay (fullscreen): non-render read window emits no S", { skip: fullscreenCell === null }, () => {
	const events = readProbeEvents(fullscreenCell);
	const readIndex = events.findIndex((event) => event.event === "non-render-size-reads");
	assert.ok(readIndex > 0);
	// Window: from just before the explicit read command to the next terminal op.
	let end = readIndex + 1;
	while (end < events.length && events[end].event !== "terminal-op") end += 1;
	const window = replay(events, { mode: "fullscreen", from: readIndex - 4, to: end });
	assert.equal(has(window.decisions, "S"), false, "non-render size reads must not emit S");
	assert.equal(has(window.decisions, "F"), false);
});

test("fix1 replay (fullscreen): BOOT window has no first/full proof", { skip: fullscreenCell === null }, () => {
	const events = readProbeEvents(fullscreenCell);
	const firstOp = events.findIndex((event) => event.event === "terminal-op");
	assert.ok(firstOp > 0, "the retained stream has a pre-output window");
	const boot = replay(events, { mode: "fullscreen", from: 0, to: firstOp });
	assert.equal(has(boot.decisions, "S"), false, "BOOT output cannot be a first proof");
	assert.equal(has(boot.decisions, "F"), false, "BOOT output cannot be a full proof");
	// The raw BOOT prefix of this run is retained separately and is not proof.
	const result = JSON.parse(readFileSync(join(ARTIFACTS, fullscreenCell, "result.json"), "utf8"));
	assert.ok(result.steps.bootAndEditor.bootBytesBeforeFirstSync > 0, "the run recorded a real BOOT prefix before the first synchronized frame");
});

test("fix1 replay (fullscreen): a complete editor frame is proven only after sentinel + focus + real output", { skip: fullscreenCell === null }, () => {
	const events = readProbeEvents(fullscreenCell);
	const result = replay(events, { mode: "fullscreen" });
	const published = result.decisions.filter((decision) => decision.kind === "S" || decision.kind === "F" || decision.kind === "A");
	assert.ok(published.length > 0, "the actual fullscreen stream contains provable frames");
	for (const pair of result.pairs.filter((entry) => entry.decision.kind === "S")) {
		const op = pair.previousOp?.op;
		assert.ok(op !== undefined, "S is emitted immediately before a real output operation");
		assert.equal(op.kind, "write");
		assert.match(op.text, /\u001b\[\?2026h/, "S precedes a synchronized frame write");
	}
	// Every S must be paired with an F for the same frameId in this mode.
	const publishedKinds = published.map((decision) => decision.kind);
	assert.equal(publishedKinds.filter((kind) => kind === "S").length, publishedKinds.filter((kind) => kind === "F").length);
	assert.equal(has(published, "A"), false, "a complete fullscreen write always finishes");
});

test("fix1 replay (fullscreen): the overlay window is proven only through composition + output, not the mount", { skip: fullscreenCell === null }, () => {
	const events = readProbeEvents(fullscreenCell);
	const mount = events.findIndex((event) => event.event === "overlay-mounted");
	const close = events.findIndex((event) => event.event === "overlay-closed");
	assert.ok(mount > 0 && close > mount, "the retained stream contains a real overlay window");
	const beforeMount = replay(events, { mode: "fullscreen", from: 0, to: mount });
	const window = replay(events, { mode: "fullscreen", from: mount, to: close });
	// Mounting alone contributes no decision: only the real writes inside the
	// window can carry S/F, and each such S is followed by an actual write.
	const mountS = window.pairs.filter((pair) => pair.decision.kind === "S");
	for (const pair of mountS) {
		assert.ok(pair.previousOp !== undefined, "every overlay S is attached to a real output operation");
		assert.equal(pair.previousOp.event.event, "terminal-op");
	}
	assert.ok(beforeMount.decisions.length > 0, "the pre-overlay editor frames were judged");
});

test("fix1 replay (regular): plain writes and cursor-only operations never create a first/full proof", { skip: regularCell === null }, () => {
	const events = readProbeEvents(regularCell);
	const result = replay(events, { mode: "regular" });
	const plainOps = events.filter((event) => event.event === "terminal-op" && event.key === "write" && event.hasSyncOpen !== true);
	const cursorOps = events.filter((event) => event.event === "terminal-op" && (event.key === "hideCursor" || event.key === "showCursor"));
	assert.ok(plainOps.length > 0, "the retained regular stream has non-synchronized writes");
	assert.ok(cursorOps.length > 0, "the retained regular stream has cursor-visibility operations");
	for (const pair of result.pairs.filter((entry) => entry.decision.kind === "S")) {
		const op = pair.previousOp?.event;
		assert.ok(op !== undefined, "every S points at a real operation");
		assert.equal(op.key, "write", "a regular S precedes a write, never a cursor-only operation");
		assert.equal(op.hasSyncOpen, true, "a regular S precedes a real sync OPEN");
	}
	for (const pair of result.pairs.filter((entry) => entry.decision.kind === "F")) {
		// F may legitimately be emitted after the final visibility operation; what
		// matters is that the frame had a real sync block and a cursor tail.
		const frameDecisions = result.decisions.filter((entry) => entry.frameId === pair.decision.frameId && entry.kind === "S");
		assert.equal(frameDecisions.length, 1, "every regular F belongs to a frame whose S preceded a sync write");
	}
});

test("fix1 replay (regular): a complete regular frame needs OPEN, CLOSE, parking write and final visibility", { skip: regularCell === null }, () => {
	const events = readProbeEvents(regularCell);
	const result = replay(events, { mode: "regular" });
	const finals = result.decisions.filter((decision) => decision.kind === "F");
	assert.ok(finals.length > 0, "the actual regular stream contains at least one complete frame under the converged rule");
	for (const decision of finals) {
		const index = result.decisions.indexOf(decision);
		const priorDecisions = result.decisions.slice(0, index).filter((entry) => entry.frameId === decision.frameId);
		assert.equal(priorDecisions.filter((entry) => entry.kind === "S").length, 1, "exactly one S per proven frame");
	}
	// Every S that the fence could not finish is aborted, never silently kept.
	const sFrames = new Set(result.decisions.filter((decision) => decision.kind === "S").map((decision) => decision.frameId));
	const finished = new Set(result.decisions.filter((decision) => decision.kind === "F" || decision.kind === "A").map((decision) => decision.frameId));
	for (const frameId of sFrames) assert.ok(finished.has(frameId), `frame ${frameId} with S must end in F or A`);
});

test("fix1 replay (regular): the retained stream never turns cursor-only output into an S", { skip: regularCell === null }, () => {
	const events = readProbeEvents(regularCell);
	const result = replay(events, { mode: "regular" });
	const sBeforeCursorOnly = result.pairs.filter(
		(entry) => entry.decision.kind === "S" && (entry.previousOp?.event?.key === "hideCursor" || entry.previousOp?.event?.key === "showCursor"),
	);
	assert.deepEqual(sBeforeCursorOnly, [], "no S may be attributed to a cursor-visibility-only operation");
});

// ---------------------------------------------------------------------------
// C. fix2 parent decisions: frameId carry, strict candidate-origin rule, and a
//    real open-stop invalidation (pure RED→GREEN)
// ---------------------------------------------------------------------------

const FULL_WRITE = `${SYNC_OPEN}\u001b[1;1H${SYNC_CLOSE}`;

test("fix2: frameId is strictly increasing across a rendererEpoch rebind (carried counter)", () => {
	const counter = { value: 0 };
	const first = newEvaluator("fullscreen", { frameIdCounter: counter });
	first.sizeRead("columns", 80);
	first.sizeRead("rows", 24);
	first.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "fullscreen" });
	first.op({ kind: "write", text: FULL_WRITE });
	first.stop();
	// A mode switch rebinds the evaluator with a different mode but the SAME token
	// counter: the id domain must not restart.
	const second = newEvaluator("regular", { frameIdCounter: counter });
	second.sizeRead("columns", 80);
	second.sizeRead("rows", 24);
	second.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "regular" });
	second.op({ kind: "write", text: `${SYNC_OPEN}content` });
	const ids = [...first.log, ...second.log].filter((decision) => decision.kind === "candidate").map((decision) => decision.frameId);
	assert.deepEqual(ids, [1, 2], "no reuse and no regression on rebind");
	assert.equal(second.lastFrameId, 2);
	// RED witness: a rebind that forgot to carry the counter restarts at 1.
	const forgetful = newEvaluator("regular");
	forgetful.sizeRead("columns", 80);
	forgetful.sizeRead("rows", 24);
	const reused = forgetful.log.find((decision) => decision.kind === "candidate").frameId;
	assert.equal(reused, 1, "without the carried counter the id domain would be reused");
	assert.notEqual(reused, 2, "the carried counter is what prevents the regression");
});

test("fix2: stop-and-restart cycles cannot reuse a frameId, and rendererEpoch is only metadata", () => {
	const counter = { value: 0 };
	const issued = [];
	for (const mode of ["fullscreen", "regular", "fullscreen", "regular"]) {
		const evaluator = newEvaluator(mode, { frameIdCounter: counter });
		evaluator.sizeRead("columns", 80);
		evaluator.sizeRead("rows", 24);
		issued.push(evaluator.log.find((decision) => decision.kind === "candidate").frameId);
		evaluator.stop();
	}
	assert.deepEqual(issued, [1, 2, 3, 4]);
	assert.equal(new Set(issued).size, issued.length, "no frameId is ever reused across stop/start/rebind");
});

test("fix2: an output op between the pair and the fresh sentinel invalidates the candidate (no retroactive completion)", () => {
	const evaluator = newEvaluator("fullscreen");
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	// A scattered (mouse/hover) pair is followed by unrelated real output BEFORE the
	// renderer pass that would supply the sentinel fact.
	const stray = evaluator.op({ kind: "write", text: "\u001b[?1049h" });
	assert.equal(has(stray, "S"), false);
	assert.equal(evaluator.openFrameId, null, "the pair is invalidated by the earlier output");
	const invalidated = evaluator.log.find((decision) => decision.kind === "none" && decision.reason.endsWith("before-fresh-sentinel"));
	assert.ok(invalidated !== undefined, "the invalidation is explicit, not silent");
	assert.equal(invalidated.frameId, 1);
	// A later render's sentinel must NOT revive it, and the real write must not prove it.
	evaluator.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "fullscreen" });
	const afterSentinel = evaluator.op({ kind: "write", text: FULL_WRITE });
	assert.equal(has(afterSentinel, "S"), false, "a stale pair cannot be completed by a later render");
	assert.equal(has(evaluator.log, "S"), false);
	// RED witness: with the sentinel BEFORE the stray output the same write publishes.
	const gated = newEvaluator("fullscreen");
	gated.sizeRead("columns", 80);
	gated.sizeRead("rows", 24);
	gated.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "fullscreen" });
	assert.equal(has(gated.op({ kind: "write", text: FULL_WRITE }), "S"), true);
	// The next genuine pair (fresh sentinel then write) still proves, with a new id.
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	evaluator.sentinel({ focusPresent: true, focusIdentity: "focus-a", mode: "fullscreen" });
	const proven = evaluator.op({ kind: "write", text: FULL_WRITE });
	assert.deepEqual(proven.map((decision) => decision.kind), ["S", "F"]);
	assert.equal(proven[0].frameId, 2, "the invalidated id is never reused");
});

test("fix2: a real stop invalidates an open candidate silently (no S, no A) and the counter keeps increasing", () => {
	const counter = { value: 0 };
	const evaluator = newEvaluator("regular", { frameIdCounter: counter });
	evaluator.sizeRead("columns", 80);
	evaluator.sizeRead("rows", 24);
	const openFrameId = evaluator.openFrameId;
	assert.equal(openFrameId, 1, "the candidate exists before the stop");
	evaluator.stop();
	const last = evaluator.log.at(-1);
	assert.equal(last.kind, "none", "no S was emitted, so the invalidation is silent");
	assert.match(last.reason, /^stop-before-s$/);
	assert.equal(last.frameId, openFrameId, "the invalidation carries the candidate identity");
	assert.equal(has(evaluator.log, "A"), false, "A is only owed when S was emitted");
	assert.equal(has(evaluator.log, "S"), false);
	assert.equal(has(evaluator.log, "F"), false);
	// A rebound evaluator after the stop continues the id domain instead of reusing 1.
	const resumed = newEvaluator("regular", { frameIdCounter: counter });
	resumed.sizeRead("columns", 80);
	resumed.sizeRead("rows", 24);
	assert.equal(resumed.log.find((decision) => decision.kind === "candidate").frameId, 2);
});
