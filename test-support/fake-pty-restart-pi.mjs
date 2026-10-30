#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Issue #222 step 20B (task-20b-review-dispositions.md, C2/I1): a NEW recovery
// child for R-restart. It starts with an EMPTY authoritative baseline (no seed
// output at all — the runner answers snapshot_begin/end with empty:true), then
// releases ONE complete synchronized generation frame only on the framed
// command {"cmd":"go"}; {"cmd":"exit"} terminates. The accepted
// fake-pty-generation-pi.mjs (which seeds F0 immediately) is byte-pinned and
// not mutated.
//
// Contract: 80x22 work area; every content row carries `<generation> <id>` in
// the declared marker rows; hidden cursor parked after `<generation> <id>
// INPUT >`; alternate screen entered only with the go frame. Every stdout write
// is logged to FAKE_PTY_EVENTS_PATH with writeIndex/frame/phase/bytes/sha256.
const generation = process.env.FAKE_PTY_RESTART_GENERATION ?? "";
const eventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
if (!/^[a-z0-9][a-z0-9-]*$/.test(generation)) {
	process.stderr.write(`restart-fixture: missing/malformed FAKE_PTY_RESTART_GENERATION ${JSON.stringify(generation)}\n`);
	process.exit(2);
}
if (!eventsPath) {
	process.stderr.write("restart-fixture: FAKE_PTY_EVENTS_PATH is required\n");
	process.exit(2);
}

const OPEN = "\x1b[?2026h";
const CLOSE = "\x1b[?2026l";
const ROWS = 22;
const rowsText = (id) => [
	`${generation} ${id} HEADER controlled restart surface`,
	`${generation} ${id} UPPER reply history one`,
	`${generation} ${id} UPPER reply history two`,
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	`${generation} ${id} MIDDLE divider`,
	`${generation} ${id} LOWER reply history three`,
	`${generation} ${id} LOWER reply history four`,
	"",
	"",
	"",
	"",
	"",
	"",
	`${generation} ${id} TAIL assistant final answer`,
	"",
	`${generation} ${id} INPUT >`,
];
const cursorFor = (id) => ({ x: `${generation} ${id} INPUT >`.length, y: ROWS - 1 });
const frameBody = (id) => {
	const rows = rowsText(id);
	let body = "";
	for (let y = 0; y < ROWS; y++) body += `\x1b[${y + 1};1H\x1b[2K${rows[y]}`;
	const cursor = cursorFor(id);
	return `${body}\x1b[?25l\x1b[${cursor.y + 1};${cursor.x + 1}H`;
};

const clockNow = () => ({ monoNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
const logEvent = (event) => appendFileSync(eventsPath, `${JSON.stringify({ generation, ...event })}\n`);
logEvent({ event: "start", pid: process.pid, cols: 80, rows: ROWS, emptyBaseline: true, protocol: 'RS+JSON+LF; {"cmd":"go"} releases the frame, {"cmd":"exit"}', ...clockNow() });

let writeIndex = 0;
let goSent = false;
const performWrite = (record, done) => {
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
		done();
	});
};

const handleRawCommand = (raw) => {
	let cmd;
	try {
		cmd = JSON.parse(raw);
	} catch {
		cmd = null;
	}
	if (cmd && cmd.cmd === "go" && !goSent) {
		goSent = true;
		logEvent({ event: "command", raw, ...clockNow() });
		performWrite({ frame: "F0", phase: "go", data: () => `\x1b[?1049h${OPEN}${frameBody("F0")}${CLOSE}` }, () => {});
	} else if (cmd && cmd.cmd === "exit") {
		logEvent({ event: "command", raw, ...clockNow() });
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
