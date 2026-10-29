import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AttachPresentationObserver } from "../test-support/attach-presentation-fixture.ts";

// Issue #222 step 20A (task-20a-brief.md): per-frame matrix oracle, B/Q/L/G
// fixture contracts, retained S/C/T raw-evidence audit and one real-runner
// smoke. The accepted S/C/T batteries are NOT rerun here: the audit reads the
// retained raw evidence and verifies the literal half-frame/oracle assertions
// and cleanup actually exist. Every oracle case below is a pure, deterministic
// negative (a reproduced defect is evidence, never a harness pass).

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const scenarioPath = resolve(REPO_ROOT, "test-support/pty-attach-matrix-scenario.ts");

async function scenario() {
	return import(scenarioPath);
}

function waitFor(predicate, timeoutMs, label) {
	return new Promise((resolveWait, rejectWait) => {
		const start = Date.now();
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolveWait();
			} else if (Date.now() - start > timeoutMs) {
				clearInterval(timer);
				rejectWait(new Error(`timed out waiting for: ${label}`));
			}
		}, 10);
	});
}

function registerOwnedChild(t, child) {
	t.after(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill("SIGKILL");
		} catch {
			/* already exited */
		}
		await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveExit) => setTimeout(resolveExit, 2000))]);
	});
}

function frames(observer) {
	return observer.observations.filter((o) => o.kind === "frame");
}

/** Producer child writes to a 22-row work area with no attach chrome, so the
 *  observer is 22 rows and the body is the whole grid (0..21). */
function producerRows(observation) {
	return observation.grid.map((row) => row.text.replace(/\s+$/u, ""));
}

// ---------------------------------------------------------------------------
// Pure literal + oracle contracts
// ---------------------------------------------------------------------------

test("step 20A: frameIdOf extracts the leading frame-id token and rejects non-id rows", async () => {
	const s = await scenario();
	assert.equal(s.frameIdOf("B3 HEADER busy work area"), "B3");
	assert.equal(s.frameIdOf("LA1 TAIL 中文最终回答 🎯"), "LA1");
	assert.equal(s.frameIdOf("G2 HEADER geometry 80x22....#"), "G2");
	assert.equal(s.frameIdOf(""), null);
	assert.equal(s.frameIdOf("plain history line without an id token"), null);
});

test("step 20A: literal builders produce the declared TAIL/INPUT bottom and consistent ids", async () => {
	const s = await scenario();
	const busy = s.busyRowsText("B3", "busy");
	assert.equal(busy.length, 22);
	assert.equal(busy[19], "B3 TAIL assistant final answer");
	assert.equal(busy[21], "B3 INPUT >");
	assert.ok(busy.every((row) => row === "" || s.frameIdOf(row) === "B3"), "every non-blank row carries the same frame id");
	const longlog = s.longlogRowsText("LA1");
	assert.equal(longlog[19], "LA1 TAIL 中文最终回答 🎯");
	assert.equal(longlog[21], "LA1 INPUT >");
	const geom = s.geometryRowsText("G2", 80, 22);
	assert.equal(geom[0].endsWith("#"), true, "geometry header ends at the right edge");
	assert.equal(geom[21].endsWith("#"), true, "geometry INPUT row ends at the right edge");
	assert.equal(geom[19], "G2 TAIL assistant final answer");
});

test("step 20A: the oracle flags a mixed-frame-id half frame (upper and lower differ)", async () => {
	const s = await scenario();
	const config = {
		caseId: "B",
		bodyCols: 80,
		bodyRows: 22,
		literal: (id) => s.busyRowsText(id, "busy"),
		rankOfId: (id) => (id === "B0" ? 0 : id === "B1" ? 1 : null),
		dectcemCell: { x: 10, y: 21 },
	};
	const half = s.busyRowsText("B0", "busy").slice();
	// Inject a LOWER-half row from a different frame id.
	half[12] = "B1 LOWER reply history four";
	const framesInput = [{ kind: "frame", index: 0, bodyRows: half, inverseCells: [], cursor: { x: 10, y: 21, visible: false } }];
	const result = s.analyzeMatrixFrames(config, framesInput, 1);
	assert.ok(result.frameFailures.some((f) => f.category === "mixed-frame-id"), "mixed upper/lower ids must be flagged");
	assert.ok(result.frameFailures.some((f) => f.category === "row-mismatch"), "the injected lower row must also mismatch the literal");
});

test("step 20A: the oracle flags a frame missing TAIL+INPUT at the bottom", async () => {
	const s = await scenario();
	const config = {
		caseId: "B",
		bodyCols: 80,
		bodyRows: 22,
		literal: (id) => s.busyRowsText(id, "busy"),
		rankOfId: () => 0,
		dectcemCell: { x: 10, y: 21 },
	};
	const noTail = s.busyRowsText("B0", "busy").slice();
	noTail[19] = ""; // TAIL removed
	noTail[21] = ""; // INPUT removed
	const result = s.analyzeMatrixFrames(config, [{ kind: "frame", index: 0, bodyRows: noTail, inverseCells: [], cursor: { x: 10, y: 21, visible: false } }], 1);
	assert.ok(result.frameFailures.some((f) => f.category === "tail-input-mismatch"), "missing bottom TAIL/INPUT must be flagged");
	assert.equal(result.firstContentHasTailAndInput, false);
});

test("step 20A: the oracle flags a stale frame regression and keeps the earlier frame", async () => {
	const s = await scenario();
	const config = {
		caseId: "G1",
		bodyCols: 80,
		bodyRows: 22,
		literal: (id) => (id === "G2" ? s.geometryRowsText("G2", 80, 22) : s.geometryRowsText(id, 80, 24)),
		rankOfId: (id) => (id === "G1" ? 1 : id === "G2" ? 2 : 0),
		dectcemCell: { x: 23, y: 21 },
	};
	const g2 = s.geometryRowsText("G2", 80, 22);
	const g1Stale = s.geometryRowsText("G1", 80, 24).slice(0, 22); // stale 24-row G1 clipped into a 22-row body
	const result = s.analyzeMatrixFrames(
		config,
		[
			{ kind: "frame", index: 0, bodyRows: g2, inverseCells: [], cursor: { x: 23, y: 21, visible: false } },
			{ kind: "frame", index: 1, bodyRows: g1Stale, inverseCells: [], cursor: { x: 23, y: 21, visible: false } },
		],
		2,
	);
	assert.ok(result.frameFailures.some((f) => f.category === "stale-frame" && f.frameIndex === 1), "a stale G1 after G2 must be flagged");
});

test("step 20A: extra inverse cells are frame failures while the known DECTCEM cell is separate", async () => {
	const s = await scenario();
	const config = {
		caseId: "B",
		bodyCols: 80,
		bodyRows: 22,
		literal: (id) => s.busyRowsText(id, "busy"),
		rankOfId: () => 0,
		dectcemCell: { x: 10, y: 21 },
	};
	const body = s.busyRowsText("B0", "busy");
	const result = s.analyzeMatrixFrames(
		config,
		[
			{ kind: "frame", index: 0, bodyRows: body, inverseCells: [{ x: 10, y: 21 }, { x: 5, y: 5 }], cursor: { x: 10, y: 21, visible: false } },
		],
		1,
	);
	assert.ok(result.dectcemDefects.some((f) => f.category === "dectcem-inverse-cell" && f.frameIndex === 0), "known DECTCEM cell is a separate defect");
	assert.ok(result.frameFailures.some((f) => f.category === "extra-inverse-cell"), "an inverse cell away from the child cursor is a frame failure");
});

test("step 20A: a visible hardware cursor away from the DECTCEM cell is a frame failure", async () => {
	const s = await scenario();
	const config = {
		caseId: "B",
		bodyCols: 80,
		bodyRows: 22,
		literal: (id) => s.busyRowsText(id, "busy"),
		rankOfId: () => 0,
		dectcemCell: { x: 10, y: 21 },
	};
	const body = s.busyRowsText("B0", "busy");
	const result = s.analyzeMatrixFrames(config, [{ kind: "frame", index: 0, bodyRows: body, inverseCells: [], cursor: { x: 2, y: 3, visible: true } }], 1);
	assert.ok(result.frameFailures.some((f) => f.category === "hardware-cursor"), "a visible cursor on a content frame is a frame failure");
});

test("step 20A: post-close content frames are reported separately from active frame failures", async () => {
	const s = await scenario();
	const config = {
		caseId: "Q",
		bodyCols: 80,
		bodyRows: 22,
		literal: (id) => s.busyRowsText(id, "quiet"),
		rankOfId: () => 0,
		dectcemCell: { x: 10, y: 21 },
	};
	const body = s.busyRowsText("Q0", "quiet");
	const result = s.analyzeMatrixFrames(
		config,
		[
			{ kind: "frame", index: 0, bodyRows: body, inverseCells: [], cursor: { x: 10, y: 21, visible: false } },
			{ kind: "frame", index: 1, bodyRows: s.busyRowsText("Q0", "quiet"), inverseCells: [], cursor: { x: 10, y: 21, visible: false } },
		],
		1,
	);
	assert.deepEqual(result.postCloseContentFrames, [1], "a content frame after the active boundary is post-close evidence");
	assert.equal(result.frameFailures.length, 0, "post-close frames are not active-window frame failures");
});

test("step 20A: a blank/content-lost frame after first content is a frame failure (loading skip stays pre-content)", async () => {
	const s = await scenario();
	const config = {
		caseId: "Q",
		bodyCols: 80,
		bodyRows: 22,
		literal: (id) => s.busyRowsText(id, "quiet"),
		rankOfId: () => 0,
		dectcemCell: { x: 10, y: 21 },
	};
	const blank = Array.from({ length: 22 }, () => "");
	const result = s.analyzeMatrixFrames(
		config,
		[
			{ kind: "frame", index: 0, bodyRows: s.busyRowsText("Q0", "quiet"), inverseCells: [], cursor: { x: 10, y: 21, visible: false } },
			{ kind: "frame", index: 1, bodyRows: blank, inverseCells: [], cursor: { x: 0, y: 0, visible: false } },
		],
		2,
	);
	assert.ok(result.frameFailures.some((f) => f.category === "content-lost" && f.frameIndex === 1), "a blank frame after content is a content-lost failure");
	assert.deepEqual(result.contentLostFrames, [1]);
	// A blank frame BEFORE first content is still skipped (loading/bootstrap).
	const preContent = s.analyzeMatrixFrames(config, [
		{ kind: "frame", index: 0, bodyRows: blank, inverseCells: [], cursor: { x: 0, y: 0, visible: false } },
		{ kind: "frame", index: 1, bodyRows: s.busyRowsText("Q0", "quiet"), inverseCells: [], cursor: { x: 10, y: 21, visible: false } },
	], 2);
	assert.equal(preContent.frameFailures.length, 0, "a pre-content blank is not content-lost");
	assert.equal(preContent.firstContentFrameIndex, 1);
});

test("step 20A: exactlyOneResize gate counts ALL commands/applied acks/child live resizes (multiple/zero/stale fail)", async () => {
	const s = await scenario();
	const good = s.exactlyOneResizeGate({
		resizeCommands: [{ cols: 80, rows: 22 }],
		appliedAcks: [{ cols: 80, rows: 22 }],
		childResizeEvents: [{ cols: 80, rows: 22 }],
		target: { cols: 80, rows: 22 },
	});
	assert.equal(good.ok, true, good.note);
	const twoCommands = s.exactlyOneResizeGate({
		resizeCommands: [{ cols: 80, rows: 22 }, { cols: 80, rows: 22 }],
		appliedAcks: [{ cols: 80, rows: 22 }],
		childResizeEvents: [{ cols: 80, rows: 22 }],
		target: { cols: 80, rows: 22 },
	});
	assert.equal(twoCommands.ok, false, "more than one command fails");
	const zeroAcks = s.exactlyOneResizeGate({
		resizeCommands: [{ cols: 80, rows: 22 }],
		appliedAcks: [],
		childResizeEvents: [{ cols: 80, rows: 22 }],
		target: { cols: 80, rows: 22 },
	});
	assert.equal(zeroAcks.ok, false, "missing applied ack fails");
	const twoAcks = s.exactlyOneResizeGate({
		resizeCommands: [{ cols: 80, rows: 22 }],
		appliedAcks: [{ cols: 80, rows: 22 }, { cols: 80, rows: 22 }],
		childResizeEvents: [{ cols: 80, rows: 22 }],
		target: { cols: 80, rows: 22 },
	});
	assert.equal(twoAcks.ok, false, "more than one applied ack fails");
	const staleChild = s.exactlyOneResizeGate({
		resizeCommands: [{ cols: 80, rows: 22 }],
		appliedAcks: [{ cols: 80, rows: 22 }],
		childResizeEvents: [{ cols: 160, rows: 22 }],
		target: { cols: 80, rows: 22 },
	});
	assert.equal(staleChild.ok, false, "a stale (non-target) child live dims fails");
	const zeroChild = s.exactlyOneResizeGate({
		resizeCommands: [{ cols: 80, rows: 22 }],
		appliedAcks: [{ cols: 80, rows: 22 }],
		childResizeEvents: [],
		target: { cols: 80, rows: 22 },
	});
	assert.equal(zeroChild.ok, false, "zero child live resize events fail");
});

test("step 20A: g3 reflow wrapped rows require the boundary/end sentinels at exactly col 80/160 (col79/81 fail)", async () => {
	const s = await scenario();
	const line = s.g3ReflowLine();
	assert.equal(line.length, 160);
	assert.equal(line[79], "W", "boundary sentinel at 0-based col 79 (1-based col 80)");
	assert.equal(line[159], "E", "end sentinel at 0-based col 159 (1-based col 160)");
	const expected = s.g3ExpectedWrappedRows(line);
	assert.deepEqual(expected, [line.slice(0, 80), line.slice(80, 160)]);
	// A boundary sentinel displaced to col 79 (0-based 78) or col 81 (0-based
	// 80) must NOT produce a valid wrapped pair (null).
	const col79 = s.g3ExpectedWrappedRows("L".repeat(78) + "W" + "L".repeat(80) + "E");
	assert.equal(col79, null, "boundary at col 79 fails");
	const col81 = s.g3ExpectedWrappedRows("L".repeat(80) + "W" + "L".repeat(78) + "E");
	assert.equal(col81, null, "boundary at col 81 fails");
});

test("step 20A: matrixCellRecord carries the required per-cell fields", async () => {
	const s = await scenario();
	const analysis = {
		frameFailures: [{ frameIndex: 3, category: "stale-frame", expected: { id: "G1", rank: 1 }, actual: { maxRankSeen: 2 } }],
		dectcemDefects: [],
		firstContentFrameIndex: 1,
		firstContentHasTailAndInput: true,
		tailAndInputAtBottom: true,
		postCloseContentFrames: [],
	};
	const record = s.matrixCellRecord({
		caseId: "G1",
		error: null,
		times: { childResizeEvents: [{ cols: 80, rows: 22 }] },
		readyBeforeLegacySettle: false,
		analysis,
		resizeSizes: [{ cols: 80, rows: 22, at: 1.5 }],
		ok: true,
	});
	for (const key of ["caseId", "error", "times", "readyBeforeLegacySettle", "firstContentHasTailAndInput", "frameFailures", "resizeSizes"]) {
		assert.ok(key in record, `missing ${key}`);
	}
	assert.ok(!("firstContentFrameIndex" in record) || record.firstContentFrameIndex === undefined);
	assert.equal(record.ok, true);
});

// ---------------------------------------------------------------------------
// Busy/longlog fixture producer contracts (real child under pipes)
// ---------------------------------------------------------------------------

test("step 20A busy fixture: continuous 25ms full synchronized frames with TAIL+INPUT and consistent ids", async (t) => {
	const s = await scenario();
	const dir = mkdtempSync(join(tmpdir(), "step20a-busy-"));
	const eventsPath = join(dir, "events.jsonl");
	const child = spawn(process.execPath, [resolve(REPO_ROOT, "test-support/fake-pty-busy-pi.mjs")], {
		env: { ...process.env, FAKE_PTY_BUSY_MODE: "busy", FAKE_PTY_EVENTS_PATH: eventsPath },
		stdio: ["pipe", "pipe", "pipe"],
	});
	registerOwnedChild(t, child);
	const observer = new AttachPresentationObserver({ cols: 80, rows: 22 });
	let stdoutAll = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutAll += chunk;
		observer.write(chunk);
	});
	t.after(() => {
		observer.dispose();
		rmSync(dir, { recursive: true, force: true });
	});
	await waitFor(() => frames(observer).length >= 3, 5000, "busy frames");
	await waitFor(() => stdoutAll.length > 0, 5000, "busy stdout");
	const seen = frames(observer);
	// Every committed frame must be complete: TAIL+INPUT at bottom, one id.
	for (const f of seen.slice(1)) {
		const rows = producerRows(f);
		assert.ok(rows[19].includes("TAIL assistant final answer"), `frame ${f.index} has TAIL`);
		assert.ok(rows[21].endsWith("INPUT >"), `frame ${f.index} has INPUT`);
		const ids = rows.map((r) => s.frameIdOf(r)).filter((id) => id !== null);
		assert.ok(ids.length > 0 && ids.every((id) => id === ids[0]), `frame ${f.index} has one consistent id`);
	}
	child.stdin.write("\x1e" + JSON.stringify({ cmd: "exit" }) + "\n");
	await new Promise((resolveExit) => child.once("exit", resolveExit));
});

test("step 20A quiet fixture: same-size baseline then no later output", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "step20a-quiet-"));
	const eventsPath = join(dir, "events.jsonl");
	const child = spawn(process.execPath, [resolve(REPO_ROOT, "test-support/fake-pty-busy-pi.mjs")], {
		env: { ...process.env, FAKE_PTY_BUSY_MODE: "quiet", FAKE_PTY_EVENTS_PATH: eventsPath },
		stdio: ["pipe", "pipe", "pipe"],
	});
	registerOwnedChild(t, child);
	const observer = new AttachPresentationObserver({ cols: 80, rows: 22 });
	let stdoutAll = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutAll += chunk;
		observer.write(chunk);
	});
	t.after(() => {
		observer.dispose();
		rmSync(dir, { recursive: true, force: true });
	});
	await waitFor(() => frames(observer).length >= 1, 5000, "quiet seed frame");
	const before = stdoutAll.length;
	await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
	assert.equal(stdoutAll.length, before, "no output after the quiet seed");
	const events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	assert.equal(events.filter((e) => e.event === "stdout-write").length, 1, "quiet child writes exactly the seed");
	child.stdin.write("\x1e" + JSON.stringify({ cmd: "exit" }) + "\n");
	await new Promise((resolveExit) => child.once("exit", resolveExit));
});

test("step 20A longlog fixture: >60KB real history and a bottom TAIL+INPUT with Chinese/emoji", async (t) => {
	const s = await scenario();
	const dir = mkdtempSync(join(tmpdir(), "step20a-longlog-"));
	const eventsPath = join(dir, "events.jsonl");
	const child = spawn(process.execPath, [resolve(REPO_ROOT, "test-support/fake-pty-longlog-pi.mjs")], {
		env: { ...process.env, FAKE_PTY_LONGLOG_MODE: "normal", FAKE_PTY_EVENTS_PATH: eventsPath },
		stdio: ["pipe", "pipe", "pipe"],
	});
	registerOwnedChild(t, child);
	const observer = new AttachPresentationObserver({ cols: 80, rows: 22 });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => observer.write(chunk));
	t.after(() => {
		observer.dispose();
		rmSync(dir, { recursive: true, force: true });
	});
	await waitFor(() => frames(observer).some((f) => producerRows(f)[19].includes("中文最终回答")), 10000, "longlog final frame");
	const events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const bytes = events.filter((e) => e.event === "stdout-write" && typeof e.bytes === "number").reduce((sum, e) => sum + e.bytes, 0);
	assert.ok(bytes > 60000, `history must exceed 60KB (got ${bytes})`);
	const final = frames(observer).find((f) => producerRows(f)[19].includes("中文最终回答"));
	const rows = producerRows(final);
	assert.equal(rows[19], "L1 TAIL 中文最终回答 🎯");
	assert.equal(rows[21], "L1 INPUT >");
	assert.equal(s.frameIdOf(rows[19]), "L1");
	child.stdin.write("\x1e" + JSON.stringify({ cmd: "exit" }) + "\n");
	await new Promise((resolveExit) => child.once("exit", resolveExit));
});

test("step 20A geometry fixture: refuses without observable PTY dims and validates mode", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "step20a-geom-refuse-"));
	const eventsPath = join(dir, "events.jsonl");
	for (const env of [{ FAKE_PTY_GEOMETRY_MODE: "g1" }, { FAKE_PTY_GEOMETRY_MODE: "BAD" }]) {
		const child = spawn(process.execPath, [resolve(REPO_ROOT, "test-support/fake-pty-geometry-pi.mjs")], {
			env: { ...process.env, ...env, FAKE_PTY_EVENTS_PATH: eventsPath },
			stdio: ["pipe", "pipe", "pipe"],
		});
		registerOwnedChild(t, child);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
		assert.notEqual(code, 0, "geometry fixture under pipes (no PTY dims) or bad mode must exit nonzero");
		assert.equal(stdout, "", "no stdout on refusal");
	}
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Retained S/C/T raw-evidence audit (reads retained evidence; never reruns)
// ---------------------------------------------------------------------------

test("step 20A retained evidence: all nine S cells and both T trials pass every named case-specific check (no rerun)", async () => {
	const s = await scenario();
	const sddRoot = join(REPO_ROOT, ".superpowers", "sdd", "2026-10-23-issue-222-attach-ready");
	// C1: all nine S battery-1 cells (per-cell named assertions).
	const batteryRoot = join(sddRoot, "task-15-integration-parentfix2-artifacts", "battery-1");
	const sResults = s.auditRetainedSCells(batteryRoot);
	assert.equal(sResults.length, 9, "all nine S cells audited");
	for (const audit of sResults) {
		assert.equal(audit.present, true, `S ${audit.cell}: retained evidence root readable`);
		const failures = audit.checks.filter((c) => c.ok !== true);
		assert.deepEqual(failures, [], `S ${audit.cell}: every named check must pass (failures: ${failures.map((f) => f.name).join(", ")})`);
	}
	// C2: both retained theme trials with full grid/cursor/repaint-hash and
	// late timing/997;2.
	const themeRoot = join(sddRoot, "task-16-theme-artifacts");
	const tResults = s.auditRetainedTTrials(join(themeRoot, "t-on-time-attempt-1", "trial-t-on-time"), join(themeRoot, "t-late-attempt-1", "trial-t-late"));
	assert.equal(tResults.length, 2, "both T trials audited");
	for (const audit of tResults) {
		assert.equal(audit.present, true, `T ${audit.cell}: retained evidence root readable`);
		const failures = audit.checks.filter((c) => c.ok !== true);
		assert.deepEqual(failures, [], `T ${audit.cell}: every named check must pass (failures: ${failures.map((f) => f.name).join(", ")})`);
	}
	// C (cold) retained cell.
	const cAudit = s.auditRetainedEvidence(join(sddRoot, "task-16-a5-artifacts", "a5-attempt-1", "trial-a5"), "C");
	assert.equal(cAudit.present, true, "C retained evidence root readable");
	const cFailures = cAudit.checks.filter((c) => c.ok !== true);
	assert.deepEqual(cFailures, [], `C every named check must pass (failures: ${cFailures.map((f) => f.name).join(", ")})`);
});

// ---------------------------------------------------------------------------
// CLI + one real-runner smoke through the guarded exclusive CLI
// ---------------------------------------------------------------------------

test("step 20A CLI: unsupported case/clock/repeat fails explicitly with exit 2 and no stdout", async () => {
	const artifactDir = join(mkdtempSync(join(tmpdir(), "step20a-cli-")), "artifact");
	for (const args of [
		["--case", "A4", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir],
		["--case", "B", "--repeat", "2", "--clock", "real", "--artifact-dir", artifactDir],
		["--case", "B", "--repeat", "1", "--clock", "fake", "--artifact-dir", artifactDir],
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
		assert.ok(stderr.length > 0, "explicit stderr on CLI rejection");
	}
});

test("step 20A B cell: real-runner per-frame matrix smoke (exclusive artifact dir, JSON stdout)", async (t) => {
	const artifactDir = mkdtempSync(join(tmpdir(), "step20a-b-smoke-"));
	t.after(() => rmSync(artifactDir, { recursive: true, force: true }));
	const child = spawn(process.execPath, ["--experimental-transform-types", scenarioPath, "--case", "B", "--repeat", "1", "--clock", "real", "--artifact-dir", join(artifactDir, "trial")], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (c) => (stdout += c));
	child.stderr.on("data", (c) => (stderr += c));
	const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
	assert.equal(code, 0, `B cell must run to completion (stderr: ${stderr.slice(-500)})`);
	const result = JSON.parse(stdout.trim().split("\n").pop());
	assert.equal(result.caseId, "B");
	const trial = result.trials[0];
	assert.equal(typeof trial.ok, "boolean");
	assert.ok("frameFailures" in trial, "the per-cell record carries frameFailures");
	assert.ok("resizeSizes" in trial, "the per-cell record carries resizeSizes");
	assert.ok(Array.isArray(trial.frameFailures), "frameFailures is an array (product defects are data, not harness failures)");
});
