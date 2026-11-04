import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

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
