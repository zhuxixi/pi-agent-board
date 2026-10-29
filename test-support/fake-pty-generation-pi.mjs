#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Issue #222 step 17 fix1 (task-17-review-dispositions.md, ruling I-1): a
// dedicated SESSION-GENERATION fixture child for the attach-ready foundation.
// The accepted step-15/16 producer (fake-pty-pi.mjs) is byte-pinned by the
// accepted S battery and carries no session-generation identity; this NEW,
// separate child adds exactly one new dimension: a session-GENERATION token
// (FAKE_PTY_GENERATION, e.g. "gen-1") that is independent of the frame id.
//
// Contract (declared here BEFORE any consumer; the scenario and the producer
// tests define their own independent copies):
// - 80x22 work area; every content row of the literal grid carries
//   `<generation> <frame-id>` in the declared marker rows: HEADER, UPPER
//   reply history one/two, MIDDLE divider, LOWER reply history three/four,
//   TAIL assistant final answer, INPUT >. All other rows are blank.
// - Every screen write uses absolute cursor addressing, clears each touched
//   row, hides the hardware cursor (DECTCEM) and parks it on the cell right
//   after the `<generation> <frame-id> INPUT >` prompt (explicit 0-based
//   coordinates: x = that prompt's length, y = 21).
// - Startup seeds one complete synchronized F0 frame through actual stdout
//   (alternate screen enter + ?2026h ... ?2026l). The only advance is the
//   framed stdin command {"cmd":"step","step":1} which emits the complete
//   synchronized F1 frame; {"cmd":"exit"} terminates. Commands are RS (0x1E)
//   + JSON + LF (0x0A), strictly in order; out-of-order/duplicate commands
//   and non-command bytes are logged and ignored, never echoed. No child-side
//   timer can complete a frame — the integration owner controls every hold.
// - EVERY event in the FAKE_PTY_EVENTS_PATH JSONL log is stamped with
//   `generation`; stdout writes additionally carry writeIndex/frame/phase/
//   bytes/sha256, so byte identity and generation identity are separately
//   auditable. Event times are child-clock facts only (process.hrtime.bigint
//   ns with an arbitrary origin, plus Date.now wall ms); no common origin
//   with any parent clock is claimed.
const generation = process.env.FAKE_PTY_GENERATION ?? "";
const eventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
if (!/^[a-z0-9][a-z0-9-]*$/.test(generation)) {
	process.stderr.write(`generation-fixture: missing or malformed FAKE_PTY_GENERATION ${JSON.stringify(generation)} (want [a-z0-9][a-z0-9-]*)\n`);
	process.exit(2);
}
if (!eventsPath) {
	process.stderr.write("generation-fixture: FAKE_PTY_EVENTS_PATH is required\n");
	process.exit(2);
}

const OPEN = "\x1b[?2026h";
const CLOSE = "\x1b[?2026l";
const ROWS = 22;
const rowsText = (id) => [
	`${generation} ${id} HEADER controlled generation surface`,
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
// 0-based park position: the cell right after `<generation> <id> INPUT >`.
const cursorFor = (id) => ({ x: `${generation} ${id} INPUT >`.length, y: ROWS - 1 });
const frameBody = (id) => {
	const rows = rowsText(id);
	let body = "";
	for (let y = 0; y < ROWS; y++) body += `\x1b[${y + 1};1H\x1b[2K${rows[y]}`;
	const cursor = cursorFor(id);
	return `${body}\x1b[?25l\x1b[${cursor.y + 1};${cursor.x + 1}H`;
};

const clockNow = () => ({ monoNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
const logEvent = (event) => {
	appendFileSync(eventsPath, `${JSON.stringify({ generation, ...event })}\n`);
};
logEvent({
	event: "start",
	pid: process.pid,
	cols: 80,
	rows: ROWS,
	protocol: 'RS(0x1E) + JSON + LF(0x0A); commands: {"cmd":"step","step":1} then {"cmd":"exit"}',
	clock: {
		mono: "process.hrtime.bigint (ns, arbitrary origin)",
		wall: "Date.now (ms)",
		note: "child clock has no proven common origin with any parent clock; timings are emission/write-callback facts only",
	},
	...clockNow(),
});

let writeIndex = 0;
const performWrite = (record, done) => {
	const data = record.data();
	const index = writeIndex;
	writeIndex += 1;
	logEvent({
		event: "stdout-write",
		step: record.step,
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

// Commands execute one at a time; the next command is handled only after the
// previous write's callback fired, so writes never overlap and the event log
// stays ordered.
const queue = [];
let busy = false;
let stepped = false;
const drain = () => {
	if (busy) return;
	const cmd = queue.shift();
	if (!cmd) return;
	busy = true;
	if (cmd.cmd === "exit") {
		logEvent({ event: "exit", ...clockNow() });
		// Flush pending stdout before exiting so the byte stream and the event
		// log stay complete and ordered even for coalesced input.
		process.stdout.write("", () => process.exit(0));
		return;
	}
	performWrite({ step: 1, frame: "F1", phase: "closed", data: () => `${OPEN}${frameBody("F1")}${CLOSE}` }, () => {
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
	const validStep = cmd !== null && typeof cmd === "object" && cmd.cmd === "step" && cmd.step === 1;
	const validExit = cmd !== null && typeof cmd === "object" && cmd.cmd === "exit";
	if ((validStep && !stepped) || validExit) {
		if (validStep) stepped = true;
		logEvent({ event: "command", ...(validStep ? { step: 1 } : {}), raw, ...clockNow() });
		queue.push(cmd);
		drain();
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

// Seed the complete F0 frame through actual stdout before any command runs;
// commands received while the seed flush is pending stay queued.
busy = true;
performWrite({ step: 0, frame: "F0", phase: "seed", data: () => `\x1b[?1049h${OPEN}${frameBody("F0")}${CLOSE}` }, () => {
	busy = false;
	drain();
});

process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
setInterval(() => {}, 1000);
