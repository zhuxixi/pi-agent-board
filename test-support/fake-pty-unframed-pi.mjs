#!/usr/bin/env node
import { appendFileSync } from "node:fs";

// Issue #222 step 20B (task-20b-review-dispositions.md, I2/I3): a dedicated
// UNFRAMED compatibility child for U-unframed/U-legacy. It mirrors the
// documented default-child boot/echo behavior of the accepted fake-pty-pi.mjs
// (which is byte-pinned and emits NO bracketed-paste byte), PLUS a single
// `CSI ? 2004 h` bracketed-paste enable so the attach's live-bytes input-
// readiness scan forwards real echo input. It emits NO synchronized-update
// markers (?2026h/?2026l) — the stream is genuinely unframed.
//
// Contract: writes "fake pi ready" then enables bracketed paste; echoes each
// non-empty stdin chunk as `echo:<visible>` (same transformation as the default
// child); exits on input containing "exit". Every stdout write is logged to
// FAKE_PTY_EVENTS_PATH with writeIndex/phase/bytes/sha256.
const eventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
if (!eventsPath) {
	process.stderr.write("unframed-fixture: FAKE_PTY_EVENTS_PATH is required\n");
	process.exit(2);
}
const { createHash } = await import("node:crypto");
let writeIndex = 0;
const performWrite = (phase, data) => {
	const index = writeIndex;
	writeIndex += 1;
	appendFileSync(eventsPath, `${JSON.stringify({ event: "stdout-write", phase, writeIndex: index, bytes: Buffer.byteLength(data, "utf8"), sha256: createHash("sha256").update(data, "utf8").digest("hex"), monoNs: process.hrtime.bigint().toString(), wallMs: Date.now() })}\n`);
	process.stdout.write(data);
};
performWrite("ready", "fake pi ready\n");
performWrite("input-mode", "\x1b[?2004h"); // bracketed paste enable (NOT a sync marker)
// The attach's input-readiness scan only honors LIVE bytes (not warm-start
// history), so keep emitting the bracketed-paste enable periodically so a real
// attach always observes it live.
setInterval(() => process.stdout.write("\x1b[?2004h"), 100);

process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.on("data", (chunk) => {
	const text = chunk.toString();
	const visible = text
		.replace(/\x1b\[200~/g, "<BP>")
		.replace(/\x1b\[201~/g, "<EP>")
		.replace(/\r/g, "<CR>")
		.replace(/\n/g, "<NL>");
	performWrite("echo", `echo:${visible}\n`);
	if (text.includes("exit")) process.exit(0);
});
setInterval(() => {}, 1000);
