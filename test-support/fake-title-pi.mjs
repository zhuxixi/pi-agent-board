#!/usr/bin/env node
/**
 * Hermetic stand-in for `pi --mode json -p` in title-runner smoke tests
 * (issue #295). Prints one assistant message_end whose text echoes the task
 * from the titlePrompt payload ("T: <task>"), writes a marker file when
 * invoked, then exits 0.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const payload = argv[argv.length - 1] ?? "";
const match = /Task: (.*)$/m.exec(payload);
const task = match ? match[1].trim() : "unknown";
if (process.env.FAKE_TITLE_PI_MARKER) {
	try { appendFileSync(process.env.FAKE_TITLE_PI_MARKER, "called\n"); } catch { /* best effort */ }
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `T: ${task}` }] } }));
