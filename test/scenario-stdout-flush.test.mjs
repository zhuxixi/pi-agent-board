import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeThenExit } from "../test-support/stdout-flush.mjs";

/** Minimal stand-in for a writable: records bytes, then either calls back or fails. */
class FakeStream extends EventEmitter {
	constructor({ failSync = false } = {}) {
		super();
		this.written = "";
		this.failSync = failSync;
	}

	write(text, callback) {
		if (this.failSync) throw new Error("write failed synchronously");
		this.written += text;
		this.callback = callback;
		return true;
	}
}

test("stdout-flush: exit runs once after the write callback fires", () => {
	const stream = new FakeStream();
	const exits = [];
	writeThenExit(stream, "payload\n", 0, (code) => exits.push(code));
	assert.equal(stream.written, "payload\n");
	assert.deepEqual(exits, [], "exit must wait for the write callback");
	stream.callback();
	assert.deepEqual(exits, [0]);
});

test("stdout-flush: a broken pipe still exits with the caller's code, exactly once", () => {
	const stream = new FakeStream();
	const exits = [];
	writeThenExit(stream, "payload\n", 3, (code) => exits.push(code));
	stream.emit("error", new Error("EPIPE"));
	stream.callback();
	assert.deepEqual(exits, [3], "the error path exits once and the late callback is ignored");
});

test("stdout-flush: a synchronous write throw still exits with the caller's code", () => {
	const stream = new FakeStream({ failSync: true });
	const exits = [];
	writeThenExit(stream, "payload\n", 1, (code) => exits.push(code));
	assert.deepEqual(exits, [1]);
});

const PROBE = fileURLToPath(new URL("../test-support/stdout-flush-probe.mjs", import.meta.url));

/**
 * Spawn the probe with stdout on a pipe and attach the reader only after
 * `delayMs`. While nobody reads, the kernel pipe buffer (64 KiB) fills and the
 * child's write goes pending — the exact condition that truncated issue #270.
 * The delay is not a timing assertion: the 256 KiB payload cannot fit either way.
 */
function runProbeWithSlowReader(bytes, delayMs = 250) {
	return new Promise((settle, fail) => {
		const child = spawn(process.execPath, [PROBE, "--bytes", String(bytes)], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks = [];
		let stderr = "";
		// No stdout listener yet: the stream stays paused, nobody reads the pipe,
		// and the kernel buffer (64 KiB) fills — the issue #270 condition. Do NOT
		// add `child.stdout.pause()` here: an explicit pause() sets flowing = false
		// and the delayed `.on("data")` below would never resume the stream.
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", fail);
		child.on("close", (code) => settle({ code, stdout: Buffer.concat(chunks).toString("utf8"), stderr }));
		setTimeout(() => child.stdout.on("data", (chunk) => chunks.push(chunk)), delayMs).unref();
	});
}

test("stdout-flush: a 256 KiB result survives a reader that starts late", async () => {
	const result = await runProbeWithSlowReader(262144);
	assert.equal(result.code, 0, `probe must exit 0; stderr:\n${result.stderr}`);
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.payload.length, 262144, "every byte of the payload must reach the reader");
});
