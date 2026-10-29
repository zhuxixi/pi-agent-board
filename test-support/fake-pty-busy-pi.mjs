#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Issue #222 step 20A (task-20a-brief.md): dedicated BUSY/QUIET fixture child
// for the per-frame matrix cells B and Q. The accepted step-15/16 producer
// (fake-pty-pi.mjs) is byte-pinned by the accepted S battery; this NEW child
// adds exactly the two same-size, zero-resize update topologies those cells
// need, with literal frame ids and independent TAIL/INPUT truth.
//
// Contract (declared here BEFORE any consumer; the scenario and the tests
// define their own independent literal copies):
// - 80x22 work area, alternate screen entered at seed. Every content row of a
//   literal grid carries the frame id token in the declared marker rows:
//   HEADER, UPPER reply history one/two, MIDDLE divider, LOWER reply history
//   three/four, TAIL assistant final answer, INPUT >. All other rows blank.
// - Every screen write uses absolute cursor addressing, clears each touched
//   row, hides the hardware cursor (DECTCEM) and parks it on the cell right
//   after the `<id> INPUT >` prompt (x = prompt length, y = 21).
// - BUSY (FAKE_PTY_BUSY_MODE=busy): seeds one complete B0 frame, then emits
//   one COMPLETE synchronized frame B1, B2, B3, ... every 25ms through actual
//   stdout. The timer is the fixture's own continuous update stream; it is
//   stopped on {"cmd":"exit"} only.
// - QUIET (FAKE_PTY_BUSY_MODE=quiet): seeds one complete Q0 frame, then emits
//   nothing further (quiet after the current complete first frame). The only
//   later output is the exit command's process termination.
// - Commands are RS (0x1E) + JSON + LF (0x0A): {"cmd":"exit"} terminates;
//   any other byte sequence is logged and ignored, never echoed. No resize is
//   ever requested or observed: both cells assert ZERO resize commands.
// - EVERY stdout write is logged to FAKE_PTY_EVENTS_PATH with
//   writeIndex/frame/phase/bytes/sha256. Event times are child-clock facts
//   only (process.hrtime.bigint ns, arbitrary origin, plus Date.now wall ms);
//   no common origin with any parent clock is claimed.
const mode = process.env.FAKE_PTY_BUSY_MODE ?? "";
const eventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
if (mode !== "busy" && mode !== "quiet") {
	process.stderr.write(`busy-fixture: missing or unsupported FAKE_PTY_BUSY_MODE ${JSON.stringify(mode)} (want "busy" or "quiet")\n`);
	process.exit(2);
}
if (!eventsPath) {
	process.stderr.write("busy-fixture: FAKE_PTY_EVENTS_PATH is required\n");
	process.exit(2);
}

const OPEN = "\x1b[?2026h";
const CLOSE = "\x1b[?2026l";
const ROWS = 22;
const seedId = mode === "busy" ? "B0" : "Q0";
const rowsText = (id) => [
	`${id} HEADER ${mode} work area`,
	`${id} UPPER reply history one`,
	`${id} UPPER reply history two`,
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	`${id} MIDDLE divider`,
	`${id} LOWER reply history three`,
	`${id} LOWER reply history four`,
	"",
	"",
	"",
	"",
	"",
	"",
	`${id} TAIL assistant final answer`,
	"",
	`${id} INPUT >`,
];
const cursorFor = (id) => ({ x: `${id} INPUT >`.length, y: ROWS - 1 });
const frameBody = (id) => {
	const rows = rowsText(id);
	let body = "";
	for (let y = 0; y < ROWS; y++) body += `\x1b[${y + 1};1H\x1b[2K${rows[y]}`;
	const cursor = cursorFor(id);
	return `${body}\x1b[?25l\x1b[${cursor.y + 1};${cursor.x + 1}H`;
};

const clockNow = () => ({ monoNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
const logEvent = (event) => {
	appendFileSync(eventsPath, `${JSON.stringify({ mode, ...event })}\n`);
};
logEvent({
	event: "start",
	pid: process.pid,
	cols: 80,
	rows: ROWS,
	protocol: 'RS(0x1E) + JSON + LF(0x0A); commands: {"cmd":"exit"}',
	clock: {
		mono: "process.hrtime.bigint (ns, arbitrary origin)",
		wall: "Date.now (ms)",
		note: "child clock has no proven common origin with any parent clock; timings are emission/write-callback facts only",
	},
	...clockNow(),
});

let writeIndex = 0;
const performWrite = (record) => {
	const data = record.data();
	const index = writeIndex;
	writeIndex += 1;
	logEvent({
		event: "stdout-write",
		frame: record.frame,
		phase: record.phase,
		writeIndex: index,
		bytes: Buffer.byteLength(data, "utf8"),
		sha256: createHash("sha256").update(data, "utf8").digest("hex"),
		...clockNow(),
	});
	process.stdout.write(data, () => {
		logEvent({ event: "stdout-write-flushed", writeIndex: index, ...clockNow() });
	});
};

// Seed the complete frame through actual stdout before any command runs.
performWrite({ frame: seedId, phase: "seed", data: () => `\x1b[?1049h${OPEN}${frameBody(seedId)}${CLOSE}` });

// BUSY: continuous 25ms full synchronized updates. QUIET: no timer at all.
let busyN = 0;
let busyTimer = null;
if (mode === "busy") {
	busyTimer = setInterval(() => {
		busyN += 1;
		performWrite({ frame: `B${busyN}`, phase: "tick", data: () => `${OPEN}${frameBody(`B${busyN}`)}${CLOSE}` });
	}, 25);
}

const handleRawCommand = (raw) => {
	let cmd;
	try {
		cmd = JSON.parse(raw);
	} catch {
		cmd = null;
	}
	const validExit = cmd !== null && typeof cmd === "object" && cmd.cmd === "exit";
	if (validExit) {
		logEvent({ event: "command", raw, ...clockNow() });
		if (busyTimer) clearInterval(busyTimer);
		logEvent({ event: "exit", ...clockNow() });
		process.stdout.write("", () => process.exit(0));
	} else {
		logEvent({ event: "command-rejected", raw, ...clockNow() });
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

process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
setInterval(() => {}, 1000);
