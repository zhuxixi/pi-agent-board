#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Issue #222 step 20A (task-20a-brief.md): dedicated GEOMETRY fixture child for
// the per-frame matrix cells G1/G2/G3. The accepted producer (fake-pty-pi.mjs)
// is byte-pinned; this NEW child owns the actual-PTY-dimension geometry
// contract with seed/stale/target frames whose rows/edges/cursor are
// geometry-sensitive. A stale frame composed at the seed size must never be
// usable as target proof; the target frame must use the ACTUAL post-SIGWINCH
// dims, never an echoed request.
//
// Contract (declared here BEFORE any consumer; the scenario and tests define
// their own independent literal copies):
// - Work area = ACTUAL PTY dims read from process.stdout.columns/rows at
//   composition time — never an echo of a commanded target. The child refuses
//   to start without observable dims (exit 3) and asserts the actual seed dims
//   equal the mode's declared seed dims (exit 4 otherwise).
// - Seed G0 at the start size (basis "live-pty-start"). Step 1 opens G1's
//   upper half at the STALE seed dims; step 2 closes G1's lower half at the
//   STALE seed dims (basis "stale-seed"); step 3 emits G2 as ONE complete
//   synchronized frame at the LIVE post-resize dims (basis "live-pty").
// - Every REAL PTY resize (SIGWINCH) is logged as a "pty-resize" event with
//   the dims the OS actually reports afterwards.
// - Geometry-sensitive content: header row padded with "." to cols-1 ending in
//   "#" at the last column; last row `${id} BOTTOM edge INPUT >` plus "#" at
//   the last column; hidden cursor parked right after the INPUT prompt.
// - Commands are RS (0x1E) + JSON + LF (0x0A): {"cmd":"step","step":N}
//   strictly in order, {"cmd":"exit"} terminates; any other byte sequence is
//   logged and ignored, never echoed.
// - EVERY stdout write is logged to FAKE_PTY_EVENTS_PATH with
//   writeIndex/frame/phase/bytes/sha256/dimsUsed{basis}. Event times are
//   child-clock facts only; no common origin with any parent clock is claimed.
const mode = process.env.FAKE_PTY_GEOMETRY_MODE ?? "";
const eventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
const MODES = {
	g1: { seed: { cols: 80, rows: 24 }, target: { cols: 80, rows: 22 } },
	g2: { seed: { cols: 300, rows: 65 }, target: { cols: 300, rows: 38 } },
	g3: { seed: { cols: 160, rows: 22 }, target: { cols: 80, rows: 22 } },
};
const spec = Object.hasOwn(MODES, mode) ? MODES[mode] : undefined;
if (!spec) {
	process.stderr.write(`geometry-fixture: missing or unsupported FAKE_PTY_GEOMETRY_MODE ${JSON.stringify(mode)} (want g1, g2 or g3)\n`);
	process.exit(2);
}
if (!eventsPath) {
	process.stderr.write("geometry-fixture: FAKE_PTY_EVENTS_PATH is required\n");
	process.exit(2);
}
const livePtyDims = () => ({
	cols: typeof process.stdout.columns === "number" ? process.stdout.columns : null,
	rows: typeof process.stdout.rows === "number" ? process.stdout.rows : null,
});
if (typeof process.stdout.columns !== "number" || typeof process.stdout.rows !== "number") {
	process.stderr.write("geometry-fixture: requires a real PTY with observable dimensions (process.stdout.columns/rows missing)\n");
	process.exit(3);
}
const seedDims = livePtyDims();
if (seedDims.cols !== spec.seed.cols || seedDims.rows !== spec.seed.rows) {
	process.stderr.write(
		`geometry-fixture: host spawn dims ${seedDims.cols}x${seedDims.rows} do not match declared seed ${spec.seed.cols}x${spec.seed.rows} for ${mode}\n`,
	);
	process.exit(4);
}

const OPEN = "\x1b[?2026h";
const CLOSE = "\x1b[?2026l";
const geometryCursor = (id, rows) => ({ x: `${id} BOTTOM edge INPUT >`.length, y: rows - 1 });
const geometryRowsText = (id, cols, rows) => {
	const out = Array.from({ length: rows }, () => "");
	out[0] = `${id} HEADER geometry ${cols}x${rows}`.padEnd(cols - 1, ".") + "#";
	out[1] = `${id} UPPER reply history one`;
	out[2] = `${id} UPPER reply history two`;
	const mid = Math.floor(rows / 2) - 1;
	out[mid] = `${id} MIDDLE divider`;
	out[mid + 1] = `${id} LOWER reply history three`;
	out[mid + 2] = `${id} LOWER reply history four`;
	out[rows - 3] = `${id} TAIL assistant final answer`;
	out[rows - 1] = `${id} BOTTOM edge INPUT >`.padEnd(cols - 1, " ") + "#";
	return out;
};
const geometryRegionBody = (id, cols, rows, from, to) => {
	const rowsText = geometryRowsText(id, cols, rows);
	let body = "";
	for (let y = from; y <= to; y++) body += `\x1b[${y + 1};1H\x1b[2K${rowsText[y]}`;
	const cursor = geometryCursor(id, rows);
	return `${body}\x1b[?25l\x1b[${cursor.y + 1};${cursor.x + 1}H`;
};

// Step 20A G3 closing: a REAL soft-wrap reflow line. One 160-column ASCII
// line; the boundary sentinel "W" sits at 0-based col 79 (1-based col 80, the
// wrap point when the viewport shrinks 160→80) and the distinct end sentinel
// "E" sits at 0-based col 159 (1-based col 160). "R" at 0-based col 80 is the
// first column of the second wrapped row. Everything else is the filler "L".
const reflowLine = () => "L".repeat(79) + "W" + "R" + "L".repeat(78) + "E";
// The G2W frame body at 80×22: the single 160-col line is written to row 1 and
// wraps into rows 1..2 (0-based); TAIL at row 19, INPUT at row 21, hidden
// cursor parked after INPUT.
const reflowRowsText = (id) => {
	const rows = Array.from({ length: 22 }, () => "");
	rows[0] = `${id} HEADER reflow surface`;
	rows[1] = reflowLine().slice(0, 80);
	rows[2] = reflowLine().slice(80, 160);
	rows[19] = `${id} TAIL assistant final answer`;
	rows[21] = `${id} INPUT >`;
	return rows;
};
const reflowRegionBody = (id) => {
	const rows = reflowRowsText(id);
	// Full clear first so leftover stale-G1 (wrapped 160-col) content can never
	// pollute the reflow frame; then write the whole 22-row body.
	let body = "\x1b[2J\x1b[H";
	body += `\x1b[1;1H${rows[0]}`;
	// Write the FULL 160-col line at row 1 (0-based) and let the 80-col PTY wrap
	// it into rows 1..2 (the whole line, never a fixture-printed two-row pair).
	body += `\x1b[2;1H${reflowLine()}`;
	body += `\x1b[20;1H${rows[19]}`;
	body += `\x1b[22;1H${rows[21]}`;
	const cursor = { x: `${id} INPUT >`.length, y: 21 };
	return `${body}\x1b[?25l\x1b[${cursor.y + 1};${cursor.x + 1}H`;
};
// G3 seed: the ORIGINAL single-line form of the reflow line at 160 cols (one
// row, no wrap), so the G2W frame is a true reflow of seed content.
const g3SeedRowsText = () => {
	const rows = geometryRowsText("G0", 160, 22);
	rows[1] = reflowLine();
	return rows;
};
const g3SeedRegionBody = () => {
	const rows = g3SeedRowsText();
	let body = "";
	for (let y = 0; y < 22; y++) body += `\x1b[${y + 1};1H\x1b[2K${rows[y]}`;
	const cursor = geometryCursor("G0", 22);
	return `${body}\x1b[?25l\x1b[${cursor.y + 1};${cursor.x + 1}H`;
};

const clockNow = () => ({ monoNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
const logEvent = (event) => {
	appendFileSync(eventsPath, `${JSON.stringify({ mode, ...event })}\n`);
};
logEvent({
	event: "start",
	pid: process.pid,
	ptyDims: seedDims,
	ptyDimsSource: "process.stdout.columns/rows at child start",
	declaredSeed: spec.seed,
	declaredTarget: spec.target,
	protocol: 'RS(0x1E) + JSON + LF(0x0A); commands: {"cmd":"step","step":N} strictly in order, {"cmd":"exit"}',
	clock: {
		mono: "process.hrtime.bigint (ns, arbitrary origin)",
		wall: "Date.now (ms)",
		note: "child clock has no proven common origin with any parent clock; timings are emission/write-callback facts only",
	},
	...clockNow(),
});
// Every REAL PTY resize is the child's own observation of the post-SIGWINCH
// dims the OS reports — never the attach's commanded value.
process.stdout.on("resize", () => {
	logEvent({ event: "pty-resize", cols: process.stdout.columns ?? null, rows: process.stdout.rows ?? null, ...clockNow() });
});

let writeIndex = 0;
let g2Dims = null;
const performWrite = (record, done) => {
	const data = record.data();
	const index = writeIndex;
	writeIndex += 1;
	const event = {
		event: "stdout-write",
		frame: record.frame,
		phase: record.phase,
		writeIndex: index,
		bytes: Buffer.byteLength(data, "utf8"),
		sha256: createHash("sha256").update(data, "utf8").digest("hex"),
		...clockNow(),
	};
	if (record.dimsUsed) event.dimsUsed = record.dimsUsed();
	logEvent(event);
	process.stdout.write(data, () => {
		logEvent({ event: "stdout-write-flushed", writeIndex: index, ...clockNow() });
		done();
	});
};

const STEPS = mode === "g3"
	? [
		{ step: 1, frame: "G1", phase: "open-stale", data: () => `${OPEN}${geometryRegionBody("G1", seedDims.cols, seedDims.rows, 0, Math.floor(seedDims.rows / 2) - 1)}`, dimsUsed: () => ({ cols: seedDims.cols, rows: seedDims.rows, basis: "stale-seed" }) },
		{ step: 2, frame: "G1", phase: "closed-stale", data: () => `${geometryRegionBody("G1", seedDims.cols, seedDims.rows, Math.floor(seedDims.rows / 2), seedDims.rows - 1)}${CLOSE}`, dimsUsed: () => ({ cols: seedDims.cols, rows: seedDims.rows, basis: "stale-seed" }) },
		{ step: 3, frame: "G2W", phase: "reflow", data: () => `${OPEN}${reflowRegionBody("G2W")}${CLOSE}`, dimsUsed: () => { const d = livePtyDims(); return { cols: d.cols, rows: d.rows, basis: "live-pty" }; } },
		{ step: 4, frame: "G2", phase: "closed-live", data: () => { g2Dims = livePtyDims(); return `${OPEN}${geometryRegionBody("G2", g2Dims.cols, g2Dims.rows, 0, g2Dims.rows - 1)}${CLOSE}`; }, dimsUsed: () => ({ cols: g2Dims.cols, rows: g2Dims.rows, basis: "live-pty" }) },
	]
	: [
		{ step: 1, frame: "G1", phase: "open-stale", data: () => `${OPEN}${geometryRegionBody("G1", seedDims.cols, seedDims.rows, 0, Math.floor(seedDims.rows / 2) - 1)}`, dimsUsed: () => ({ cols: seedDims.cols, rows: seedDims.rows, basis: "stale-seed" }) },
		{ step: 2, frame: "G1", phase: "closed-stale", data: () => `${geometryRegionBody("G1", seedDims.cols, seedDims.rows, Math.floor(seedDims.rows / 2), seedDims.rows - 1)}${CLOSE}`, dimsUsed: () => ({ cols: seedDims.cols, rows: seedDims.rows, basis: "stale-seed" }) },
		{ step: 3, frame: "G2", phase: "closed-live", data: () => { g2Dims = livePtyDims(); return `${OPEN}${geometryRegionBody("G2", g2Dims.cols, g2Dims.rows, 0, g2Dims.rows - 1)}${CLOSE}`; }, dimsUsed: () => ({ cols: g2Dims.cols, rows: g2Dims.rows, basis: "live-pty" }) },
	];

// Commands execute one at a time.
const queue = [];
let busy = false;
let nextStep = 1;
const drain = () => {
	if (busy) return;
	const cmd = queue.shift();
	if (!cmd) return;
	busy = true;
	if (cmd.cmd === "exit") {
		logEvent({ event: "exit", ...clockNow() });
		process.stdout.write("", () => process.exit(0));
		return;
	}
	performWrite(STEPS[cmd.step - 1], () => {
		busy = false;
		drain();
	});
};
const handleRawCommand = (raw) => {
	let cmd;
	try {
		cmd = JSON.parse(raw);
	} catch {
		cmd = null;
	}
	const validStep = cmd !== null && typeof cmd === "object" && cmd.cmd === "step" && Number.isInteger(cmd.step);
	const validExit = cmd !== null && typeof cmd === "object" && cmd.cmd === "exit";
	if ((validStep && cmd.step === nextStep && cmd.step <= STEPS.length) || validExit) {
		if (validStep) nextStep += 1;
		logEvent({ event: "command", ...(validStep ? { step: cmd.step } : {}), raw, ...clockNow() });
		queue.push(cmd);
		drain();
	} else {
		logEvent({ event: "command-rejected", raw, expectedStep: nextStep, ...clockNow() });
	}
};
let inputBuffer = "";
process.stdin.on("data", (chunk) => {
	inputBuffer += chunk.toString();
	for (;;) {
		const start = inputBuffer.indexOf("\x1e");
		if (start === -1) {
			if (inputBuffer.length > 0) {
				logEvent({ event: "input-ignored", bytes: Buffer.byteLength(inputBuffer, "utf8"), sha256: createHash("sha256").update(inputBuffer, "utf8").digest("hex"), ...clockNow() });
				inputBuffer = "";
			}
			break;
		}
		if (start > 0) {
			const noise = inputBuffer.slice(0, start);
			logEvent({ event: "input-ignored", bytes: Buffer.byteLength(noise, "utf8"), sha256: createHash("sha256").update(noise, "utf8").digest("hex"), ...clockNow() });
			inputBuffer = inputBuffer.slice(start);
		}
		const end = inputBuffer.indexOf("\n", 1);
		if (end === -1) break;
		const raw = inputBuffer.slice(1, end);
		inputBuffer = inputBuffer.slice(end + 1);
		handleRawCommand(raw);
	}
});

// Seed the complete G0 frame at the ACTUAL start size before any command.
busy = true;
performWrite(
	{
		step: 0,
		frame: "G0",
		phase: "seed",
		data: () => (mode === "g3"
			? `\x1b[?1049h${OPEN}${g3SeedRegionBody()}${CLOSE}`
			: `\x1b[?1049h${OPEN}${geometryRegionBody("G0", seedDims.cols, seedDims.rows, 0, seedDims.rows - 1)}${CLOSE}`),
		dimsUsed: () => ({ cols: seedDims.cols, rows: seedDims.rows, basis: "live-pty-start" }),
	},
	() => {
		busy = false;
		drain();
	},
);

process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
setInterval(() => {}, 1000);
