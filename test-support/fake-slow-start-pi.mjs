#!/usr/bin/env node
/** Test child for the starting-protocol window (issue #70 Task 8).
 *  Same echo/exit contract as fake-pty-pi.mjs, plus a SIGWINCH handler that
 *  reports the pty size — so tests can observe a cached resize actually being
 *  applied to the child when the host publishes ready. The SIGWINCH listener
 *  is registered BEFORE the ready banner: the runner applies a cached resize
 *  on first child output, so a post-banner signal must already be hooked. */
import { appendFileSync } from "node:fs";

const reportSize = () => {
	try {
		process.stdout.write(`size:${process.stdout.columns}x${process.stdout.rows}\n`);
	} catch { /* not a tty */ }
};
process.on("SIGWINCH", reportSize);

process.stdout.write("slow-start ready\n");
if (process.env.FAKE_PTY_ARGV_CAPTURE_PATH) {
	try {
		appendFileSync(process.env.FAKE_PTY_ARGV_CAPTURE_PATH, `${process.argv.at(-1) ?? ""}`);
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
	if (text.includes("exit")) process.exit(0);
});
setInterval(() => {}, 1000);
