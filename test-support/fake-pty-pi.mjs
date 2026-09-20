#!/usr/bin/env node
import { appendFileSync } from "node:fs";

// Env-driven stream modes (phase 4 e2e: terminal-snapshot.integration.test.mjs).
// All modes are additive — default behavior (boot banner + echo) is untouched
// when the env vars are absent, so the existing fixture consumers are unaffected.
const hold = process.env.FAKE_PTY_HOLD === "1";
if (!hold) process.stdout.write("fake pi ready\n");

// "steady": a tick line every 25ms — continuous moderate output so a test can
// subscribe mid-stream with the model guaranteed non-empty.
if (process.env.FAKE_PTY_STREAM_MODE === "steady") {
	let n = 0;
	const timer = setInterval(() => {
		n += 1;
		process.stdout.write(`steady-${n}\n`);
	}, 25);
	timer.unref?.();
}

// "firehose": ~1.1KB mixed chunks (printable + SGR runs + escape noise) every 1ms
// for FAKE_PTY_STREAM_MS (default 3000) — sustained multi-MB/s stress, then a
// done marker so tests know the flood ended.
if (process.env.FAKE_PTY_STREAM_MODE === "firehose") {
	const durationMs = Number(process.env.FAKE_PTY_STREAM_MS ?? 3000);
	const startedAt = Date.now();
	let row = 0;
	const chunk = () => {
		row += 1;
		let s = "";
		for (let i = 0; i < 12; i++) {
			s += `fh-${row}-${i} \x1b[1;32m${"x".repeat(48)}\x1b[0m \x1b[2K\x1b[7m rev \x1b[27m \x1b[1A`;
		}
		return s;
	};
	const timer = setInterval(() => {
		if (Date.now() - startedAt > durationMs) {
			clearInterval(timer);
			process.stdout.write("firehose-done\n");
			return;
		}
		process.stdout.write(chunk());
	}, 1);
	timer.unref?.();
}

// "malformed": broken/partial CSI, dangling OSC, truncated UTF-8, control
// bytes and a stray CSI-intro byte — parser containment probe. Buffers are
// written raw so invalid UTF-8 actually reaches the PTY.
if (process.env.FAKE_PTY_STREAM_MODE === "malformed") {
	const durationMs = Number(process.env.FAKE_PTY_STREAM_MS ?? 2000);
	const startedAt = Date.now();
	const pieces = [
		Buffer.from("\x1b[12;34", "latin1"), // partial CSI, no final byte
		Buffer.from("\x1b]0;dangling-title", "latin1"), // unterminated OSC
		Buffer.from([0xe4, 0xb8]), // truncated 3-byte UTF-8
		Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x9b]), // C0 controls + binary + stray CSI intro
		Buffer.from([0xf0, 0x9f, 0x92]), // truncated 4-byte emoji
		Buffer.from("\x1b[38;2;200;100;", "latin1"), // partial SGR argument
		Buffer.from("\x1bP1;2|~", "latin1"), // partial DCS
	];
	const timer = setInterval(() => {
		if (Date.now() - startedAt > durationMs) {
			clearInterval(timer);
			process.stdout.write(Buffer.from("malformed-done\n"));
			return;
		}
		for (let k = 0; k < 16; k++) process.stdout.write(pieces[(Math.random() * pieces.length) | 0]);
	}, 1);
	timer.unref?.();
}

if (process.env.FAKE_PTY_ARGV_CAPTURE_PATH) {
	try {
		appendFileSync(process.env.FAKE_PTY_ARGV_CAPTURE_PATH, `${process.argv.at(-1) ?? ""}`);
	} catch {}
}
if (process.env.FAKE_PTY_ENV_CAPTURE_PATH) {
	try {
		appendFileSync(process.env.FAKE_PTY_ENV_CAPTURE_PATH, `${process.env.AGENT_BOARD_CONTROL_SOCKET ?? ""}\n`);
	} catch {}
}
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.on("data", (chunk) => {
	const text = chunk.toString();
	const visible = text
		.replace(/\x1b\[200~/g, "<BP>")
		.replace(/\x1b\[201~/g, "<EP>")
		.replace(/\r/g, "<CR>")
		.replace(/\n/g, "<NL>");
	process.stdout.write(`echo:${visible}\n`);
	// "burst": emit FAKE_PTY_BURST_LINES numbered lines through a setImmediate
	// chain — a multi-chunk stream arriving over several ms, so a snapshot
	// capture started mid-burst has chunks land inside its window.
	if (text.includes("burst")) {
		const burstLines = Number(process.env.FAKE_PTY_BURST_LINES ?? 200);
		let i = 0;
		const step = () => {
			if (i >= burstLines) return;
			i += 1;
			process.stdout.write(`burstline-${String(i).padStart(4, "0")}-${"p".repeat(28)}\n`);
			setImmediate(step);
		};
		step();
	}
	if (text.includes("exit")) process.exit(0);
});
setInterval(() => {}, 1000);
