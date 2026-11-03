#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Issue #222 step 20A (task-20a-brief.md): dedicated LONGLOG fixture child for
// the per-frame matrix cells L-normal and L-alt. The accepted producer
// (fake-pty-pi.mjs) is byte-pinned; this NEW child adds the >60KB real
// history/scrollback topologies with Chinese/emoji content and an explicit
// bottom/cursor contract, separately for the NORMAL and ALTERNATE buffers.
//
// Contract (declared here BEFORE any consumer; the scenario and tests define
// their own independent literal copies):
// - 80x22 work area. History lines are real multi-byte output: every line
//   carries `L-HIST-<n>` plus Chinese text plus emoji, written with absolute
//   row clearing and a newline so it is a REAL >60KB history (measured by the
//   sha256-covered stdout-write byte counts in the event log, never by path or
//   string count alone). The fixture writes enough lines so the cumulative
//   stdout bytes exceed 60000; the exact cumulative byte count is logged.
// - NORMAL (FAKE_PTY_LONGLOG_MODE=normal): the child stays in the normal
//   buffer; history scrolls (real scrollback). ALTERNATE (FAKE_PTY_LONGLOG_MODE
//   =alt): the child enters the alternate screen (CSI ?1049h) first and the
//   history is confined to that buffer.
// - After the history, the child emits ONE complete synchronized frame L<n>
//   whose bottom contract is explicit: TAIL row at row 19 carries the id plus
//   Chinese/emoji content (`<id> TAIL 中文最终回答 🎯`), row 20 is blank, row 21
//   is `<id> INPUT >`. The hardware cursor is hidden and parked right after the
//   INPUT prompt (x = prompt length, y = 21).
// - Commands are RS (0x1E) + JSON + LF (0x0A): {"cmd":"exit"} terminates; any
//   other byte sequence is logged and ignored, never echoed. No resize is ever
//   requested: both cells assert ZERO resize commands.
// - EVERY stdout write is logged to FAKE_PTY_EVENTS_PATH with
//   writeIndex/frame/phase/bytes/sha256. Event times are child-clock facts
//   only; no common origin with any parent clock is claimed.
const mode = process.env.FAKE_PTY_LONGLOG_MODE ?? "";
const eventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
if (mode !== "normal" && mode !== "alt") {
	process.stderr.write(`longlog-fixture: missing or unsupported FAKE_PTY_LONGLOG_MODE ${JSON.stringify(mode)} (want "normal" or "alt")\n`);
	process.exit(2);
}
if (!eventsPath) {
	process.stderr.write("longlog-fixture: FAKE_PTY_EVENTS_PATH is required\n");
	process.exit(2);
}

const OPEN = "\x1b[?2026h";
const CLOSE = "\x1b[?2026l";
const ROWS = 22;
const finalId = mode === "normal" ? "L1" : "LA1";
const finalRowsText = (id) => {
	const rows = Array.from({ length: ROWS }, () => "");
	rows[0] = `${id} HEADER longlog surface`;
	rows[1] = `${id} UPPER reply history one`;
	rows[2] = `${id} UPPER reply history two`;
	rows[10] = `${id} MIDDLE divider`;
	rows[11] = `${id} LOWER reply history three`;
	rows[12] = `${id} LOWER reply history four`;
	rows[19] = `${id} TAIL 中文最终回答 🎯`;
	rows[21] = `${id} INPUT >`;
	return rows;
};
const finalCursor = () => ({ x: `${finalId} INPUT >`.length, y: ROWS - 1 });
const finalBody = (id) => {
	const rows = finalRowsText(id);
	let body = "";
	for (let y = 0; y < ROWS; y++) body += `\x1b[${y + 1};1H\x1b[2K${rows[y]}`;
	const cursor = finalCursor();
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
let totalBytes = 0;
const performWrite = (record) => {
	const data = record.data();
	const index = writeIndex;
	writeIndex += 1;
	totalBytes += Buffer.byteLength(data, "utf8");
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

// Enter the alternate screen for L-alt BEFORE any history, so the history is
// confined to the alternate buffer. L-normal stays in the normal buffer.
if (mode === "alt") performWrite({ frame: "ALT-ENTER", phase: "alt-enter", data: () => "\x1b[?1049h\x1b[?2004h" });

// REAL >60KB history: enough multi-byte lines to exceed 60000 cumulative bytes.
let lineNo = 0;
let historyDone = false;
const HISTORY_TARGET_BYTES = 60000;
const writeHistoryChunk = () => {
	for (let i = 0; i < 40 && totalBytes < HISTORY_TARGET_BYTES; i++) {
		lineNo += 1;
		const n = String(lineNo).padStart(4, "0");
		// Multi-byte history: Chinese text + emoji, one scroll line each.
		const line = `L-HIST-${n} 中文历史滚动内容测试 🚀🚀 ${n}\r\n`;
		performWrite({ frame: "HIST", phase: "history", data: () => `\x1b[2K${line}` });
	}
	if (totalBytes < HISTORY_TARGET_BYTES) {
		setImmediate(writeHistoryChunk);
	} else {
		historyDone = true;
		logEvent({ event: "history-bytes", bytes: totalBytes, lines: lineNo, ...clockNow() });
		// Final complete synchronized frame: current TAIL+INPUT at the bottom.
		performWrite({ frame: finalId, phase: "final", data: () => `${OPEN}${finalBody(finalId)}${CLOSE}` });
	}
};
writeHistoryChunk();

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
