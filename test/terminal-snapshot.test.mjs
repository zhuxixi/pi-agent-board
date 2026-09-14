import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalModel, defaultParserFactory, feedOutput, whenIdle } from "../src/core/terminal-model.mjs";
import {
	DEFAULT_SCROLLBACK_SNAPSHOT_CAP,
	TERMINAL_SNAPSHOT_VERSION,
	assertSnapshotEquivalence,
	captureTerminalSnapshot,
	hydrateTerminalSnapshot,
	synthesizeFullRedrawFrame,
} from "../src/core/terminal-snapshot.mjs";

/**
 * A4/A5b torture corpus. Each fixture is a chunk sequence fed verbatim (chunk
 * boundaries matter: split escape sequences), optional post-feed resize, and
 * optional per-fixture capture options.
 *
 * @type {Array<{
 *   name: string,
 *   cols?: number,
 *   rows?: number,
 *   chunks: string[],
 *   resize?: { cols: number, rows: number },
 *   scrollbackCap?: number,
 * }>}
 */
const FIXTURES = [
	{
		name: "split-csi-osc-across-chunk-boundaries",
		cols: 20,
		rows: 4,
		chunks: ["\x1b[3", "1mRED\x1b[0m plain\r\n\x1b]2;ti", "tle\x07after osc", "\x1b[4", ";m underline"],
	},
	{
		name: "relative-cursor-moves",
		cols: 20,
		rows: 6,
		chunks: ["row1\r\nrow2\r\nrow3\r\nrow4\x1b[1;1H\x1b[2B\x1b[5Cmid\x1b[4Dback\x1b[B\x1b[Cx\x1b[6;10H"],
	},
	{
		name: "scroll-up-scrollback-spillover",
		cols: 20,
		rows: 6,
		scrollbackCap: 5,
		chunks: Array.from({ length: 20 }, (_, i) => `line ${String(i).padStart(2, "0")}\r\n`),
	},
	{
		name: "sgr-attrs-palette-rgb",
		cols: 40,
		rows: 6,
		chunks: [
			"\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m \x1b[3mital\x1b[0m \x1b[4munder\x1b[0m \x1b[5mblink\x1b[0m \x1b[7minv\x1b[0m \x1b[8mhid\x1b[0m \x1b[9mstrike\x1b[0m\r\n",
			"\x1b[31mred\x1b[93mbright-yellow\x1b[0m \x1b[38;5;200mpalette200\x1b[0m \x1b[44mon-blue\x1b[0m \x1b[105mon-bright-magenta\x1b[0m\r\n",
			"\x1b[38;2;255;0;0mrgb-red-fg\x1b[0m \x1b[48;2;0;255;136mrgb-green-bg\x1b[0m \x1b[1;38;2;10;20;30mcombo\x1b[0m default-tail",
		],
	},
	{
		name: "wide-combining-chars",
		cols: 20,
		rows: 4,
		chunks: ["中文日本語\r\ncafé e\u0301\u0327 mix"],
	},
	{
		name: "cursor-park-mid-row",
		cols: 20,
		rows: 4,
		chunks: ["hello\r\nworld\r\n\x1b[2;4H"],
	},
	{
		// F1 fix fixture (task-2 review): modes exercised in their ON forms —
		// origin (?6h), bracketed paste (?2004h), any-event mouse (?1003h),
		// synchronized output (?2026h) — plus overline (SGR 53) content and a
		// cursor parked mid-row under origin mode. headless v6 homes the cursor
		// on DECOM set AND reset, so this fixture pins the park ordering.
		name: "modes-on-origin-bracketed-mouse-sync-overline",
		cols: 20,
		rows: 6,
		chunks: ["\x1b[?6h\x1b[?2004h\x1b[?1003h\x1b[?2026h", "\x1b[53movline\x1b[0m plain\r\n\x1b[4;2Hmarked"],
	},
	{
		name: "resize-after-content",
		cols: 40,
		rows: 4,
		chunks: ["the quick brown fox jumps over the lazy dog\r\nsecond line here\r\nthird"],
		resize: { cols: 30, rows: 5 },
	},
	{
		name: "wrap-pending-mid-viewport",
		chunks: ["A".repeat(80) + "\r\n" + "B".repeat(80)],
	},
	{
		name: "wrap-pending-bottom-right-corner",
		chunks: ["\x1b[24;1H" + "C".repeat(80)],
	},
	{
		name: "wraparound-disabled",
		cols: 10,
		rows: 4,
		chunks: ["\x1b[?7labcdefghij\x1b[?7hplain"],
	},
	{
		name: "scroll-region-content",
		cols: 20,
		rows: 8,
		chunks: ["head\r\n", "\x1b[3;6r", "\x1b[3;1H", "s1\r\ns2\r\ns3\r\ns4\r\ns5\r\ns6\r\ns7\r\ns8", "\x1b[r"],
	},
	{
		name: "empty-model",
		cols: 10,
		rows: 3,
		chunks: [],
	},
];

/**
 * @param {(typeof FIXTURES)[number]} fixture
 */
async function buildSourceModel(fixture) {
	const model = createTerminalModel({
		cols: fixture.cols ?? 80,
		rows: fixture.rows ?? 24,
		scrollback: 2000,
		parserFactory: defaultParserFactory,
	});
	for (const chunk of fixture.chunks) feedOutput(model, chunk);
	if (fixture.resize) {
		const { resizeTerminalModel } = await import("../src/core/terminal-model.mjs");
		resizeTerminalModel(model, fixture.resize.cols, fixture.resize.rows);
	}
	await whenIdle(model);
	return model;
}

for (const fixture of FIXTURES) {
	test(`snapshot round-trip: ${fixture.name}`, async () => {
		const source = await buildSourceModel(fixture);
		const dto = await captureTerminalSnapshot(source, { scrollbackCap: fixture.scrollbackCap });
		assert.equal(dto.version, TERMINAL_SNAPSHOT_VERSION);
		assert.equal(dto.snapshotSeq, source.lastSeq);
		const hydrated = await hydrateTerminalSnapshot(dto);
		assertSnapshotEquivalence(source, hydrated, {
			scrollbackCap: fixture.scrollbackCap ?? DEFAULT_SCROLLBACK_SNAPSHOT_CAP,
		});
	});
}

test("modes-on fixture: DECOM homing + overline round-trip (task-2 review F1/F2)", async () => {
	const fixture = FIXTURES.find((f) => f.name === "modes-on-origin-bracketed-mouse-sync-overline");
	const source = await buildSourceModel(fixture);
	assert.equal(source.parser.modes.originMode, true, "precondition: origin on");
	assert.equal(source.parser.modes.bracketedPasteMode, true, "precondition: bracketed paste on");
	assert.equal(source.parser.modes.mouseTrackingMode, "any", "precondition: any-event mouse tracking");
	assert.equal(source.parser.modes.synchronizedOutputMode, true, "precondition: synchronized output on");
	const dto = await captureTerminalSnapshot(source);
	const hydrated = await hydrateTerminalSnapshot(dto);
	assertSnapshotEquivalence(source, hydrated);
	// Named regression pin: the parked cursor must survive the origin-mode
	// restore (DECOM homing would otherwise leave the hydrated cursor home).
	const bufS = source.parser.buffer.active;
	const bufH = hydrated.parser.buffer.active;
	assert.equal(bufH.cursorX, bufS.cursorX, "cursor.x lost to DECOM homing");
	assert.equal(bufH.cursorY, bufS.cursorY, "cursor.y lost to DECOM homing");
});

test("wrap-pending cursor is captured faithfully, never clamped", async () => {
	const model = createTerminalModel({ cols: 10, rows: 3, scrollback: 50, parserFactory: defaultParserFactory });
	feedOutput(model, "abcdefghij");
	await whenIdle(model);
	const dto = await captureTerminalSnapshot(model);
	// The parser is wrap-pending: cursorX equals cols (Task-1 review ruling).
	assert.equal(dto.cursor.x, 10);
	assert.equal(dto.cursor.x, model.cols);
	// The synthesized frame reproduces wrap-pending in an independent parser.
	const frame = await synthesizeFullRedrawFrame(dto);
	const fresh = createTerminalModel({ cols: 10, rows: 3, scrollback: 50, parserFactory: defaultParserFactory });
	feedOutput(fresh, frame);
	await whenIdle(fresh);
	const buf = /** @type {any} */ (fresh.parser).buffer.active;
	assert.equal(buf.cursorX, 10);
	assert.equal(buf.cursorY, 0);
	assertSnapshotEquivalence(model, fresh);
});

test("scrollbackTruncated flags capped scrollback; uncapped capture carries all of it", async () => {
	const model = createTerminalModel({ cols: 20, rows: 6, scrollback: 50, parserFactory: defaultParserFactory });
	for (let i = 0; i < 20; i++) feedOutput(model, `line ${String(i).padStart(2, "0")}\r\n`);
	await whenIdle(model);
	const capped = await captureTerminalSnapshot(model, { scrollbackCap: 5 });
	assert.equal(capped.scrollbackTruncated, true);
	assert.equal(capped.scrollback.length, 5);
	// Closest-to-viewport lines are the ones kept (lines 15..19 + the trailing
	// blank row are the viewport; line 19's own CRLF parked the cursor below it).
	assert.match(cellsText(capped.scrollback.at(-1)), /line 14/);
	const full = await captureTerminalSnapshot(model, { scrollbackCap: 256 });
	assert.equal(full.scrollbackTruncated, false);
	assert.equal(full.scrollback.length, 15);
	assert.match(cellsText(full.scrollback[0]), /line 00/);
});

test("hydrate rejects unknown snapshot versions and malformed DTOs", async () => {
	const wrongVersion = /** @type {any} */ ({ version: 999, kind: "terminal_snapshot" });
	await assert.rejects(() => hydrateTerminalSnapshot(wrongVersion), /unsupported terminal snapshot/);
	await assert.rejects(() => hydrateTerminalSnapshot(/** @type {any} */ ({ version: 1, kind: "terminal_snapshot" })), TypeError);
	await assert.rejects(
		() => hydrateTerminalSnapshot(/** @type {any} */ ({ version: 1, kind: "terminal_snapshot", cols: 0, rows: 24 })),
		TypeError,
	);
});

test("frame is self-contained on a dirty terminal (wire route B precondition)", async () => {
	const source = createTerminalModel({ cols: 20, rows: 4, scrollback: 50, parserFactory: defaultParserFactory });
	feedOutput(source, "clean source content\r\nsecond line\x1b[2;5H");
	await whenIdle(source);
	const dto = await captureTerminalSnapshot(source);
	// Dirty target: pre-existing content, scroll region set, SGR left active,
	// cursor mid-screen.
	const target = createTerminalModel({ cols: 20, rows: 4, scrollback: 50, parserFactory: defaultParserFactory });
	feedOutput(target, "STALE GARBAGE LINES\r\nMORE STALE\r\nEVEN MORE\r\nSTUFF\x1b[2;10r\x1b[4;4H\x1b[1;31m");
	await whenIdle(target);
	const frame = await synthesizeFullRedrawFrame(dto);
	feedOutput(target, frame);
	await whenIdle(target);
	assertSnapshotEquivalence(source, target);
});

test("route decision evidence: equivalence, payload sizes, latency on a realistic 80x24+256sb state", async () => {
	const model = createTerminalModel({ parserFactory: defaultParserFactory });
	// Deterministic pseudo-random SGR mix: 300 lines in 30 chunks → 276
	// scrollback lines (just past the default cap, exercising truncation).
	let seed = 42;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
	for (let c = 0; c < 30; c++) {
		let chunk = "";
		for (let i = 0; i < 10; i++) {
			const n = c * 10 + i;
			const fg = 30 + Math.floor(rnd() * 8);
			const bg = 40 + Math.floor(rnd() * 8);
			const bold = rnd() < 0.3 ? "1;" : "";
			chunk += `\x1b[${bold}${fg};${bg}mline ${String(n).padStart(4, "0")} ${"x".repeat(40)}\x1b[0m\r\n`;
		}
		feedOutput(model, chunk);
	}
	await whenIdle(model);

	let t0 = performance.now();
	const dto = await captureTerminalSnapshot(model);
	const captureMs = performance.now() - t0;
	const dtoJson = JSON.stringify(dto);
	t0 = performance.now();
	const frame = await synthesizeFullRedrawFrame(dto);
	const synthMs = performance.now() - t0;
	t0 = performance.now();
	const hydrated = await hydrateTerminalSnapshot(dto);
	const hydrateMs = performance.now() - t0;
	assertSnapshotEquivalence(model, hydrated);

	/** @type {Record<string, boolean>} */
	const corpus = {};
	for (const fixture of FIXTURES) {
		const src = await buildSourceModel(fixture);
		const d = await captureTerminalSnapshot(src, { scrollbackCap: fixture.scrollbackCap });
		const h = await hydrateTerminalSnapshot(d);
		try {
			assertSnapshotEquivalence(src, h, { scrollbackCap: fixture.scrollbackCap ?? DEFAULT_SCROLLBACK_SNAPSHOT_CAP });
			corpus[fixture.name] = true;
		} catch (err) {
			corpus[fixture.name] = false;
			console.log(`EVIDENCE corpus failure in ${fixture.name}:`, /** @type {Error} */ (err).message);
		}
	}
	const passCount = Object.values(corpus).filter(Boolean).length;

	const evidence = {
		corpusTotal: FIXTURES.length,
		corpusPass: passCount,
		dtoBytes: Buffer.byteLength(dtoJson),
		frameBytes: Buffer.byteLength(frame),
		captureMs: Number(captureMs.toFixed(2)),
		synthMs: Number(synthMs.toFixed(2)),
		hydrateMs: Number(hydrateMs.toFixed(2)),
		scrollbackLines: dto.scrollback.length,
		scrollbackTruncated: dto.scrollbackTruncated,
	};
	console.log("EVIDENCE " + JSON.stringify(evidence));
	// Loose sanity guards here; hard thresholds are Task 4's (A11) job.
	assert.equal(evidence.corpusPass, evidence.corpusTotal, "every corpus fixture must round-trip");
	assert.ok(evidence.captureMs < 500, `capture latency ${evidence.captureMs}ms`);
	assert.ok(evidence.synthMs < 500, `frame synthesis latency ${evidence.synthMs}ms`);
	assert.ok(evidence.hydrateMs < 1000, `hydrate latency ${evidence.hydrateMs}ms`);
});

/**
 * @param {import("../src/core/terminal-snapshot.mjs").SnapshotCell[]} cells
 */
function cellsText(cells) {
	return cells.map((c) => (Array.isArray(c) ? c[0] : c)).join("");
}
