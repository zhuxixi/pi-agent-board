/** A1 unit tests (issue #178): the echo probe is pure logic with injected I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoProbe } from "../test-support/echo-probe.mjs";

/** A controllable sleep: records the requested interval and resolves on demand. */
function manualSleep() {
	const intervals = [];
	let release = null;
	const sleep = (ms) => {
		intervals.push(ms);
		return new Promise((r) => {
			release = r;
		});
	};
	return { intervals, sleep, release: () => release?.() };
}

test("A1: the first probe fires with N=1 at start, before any interval elapses", () => {
	const sent = [];
	const io = manualSleep();
	const probe = createEchoProbe({ send: (line) => sent.push(line), sleep: io.sleep });
	probe.start();
	assert.deepEqual(sent, ["boot-probe-1\r"], "first probe is synchronous and 1-based");
	assert.deepEqual(io.intervals, [300], "default interval is 300ms");
	probe.stop();
	io.release();
});

test("A1: each interval sends the next probe with an incrementing N", () => {
	const sent = [];
	const io = manualSleep();
	const probe = createEchoProbe({ send: (line) => sent.push(line), sleep: io.sleep });
	probe.start();
	io.release();
	return new Promise((r) => setImmediate(r)).then(() => {
		assert.deepEqual(sent, ["boot-probe-1\r", "boot-probe-2\r"]);
		io.release();
		return new Promise((r) => setImmediate(r));
	}).then(() => {
		assert.deepEqual(sent, ["boot-probe-1\r", "boot-probe-2\r", "boot-probe-3\r"]);
		probe.stop();
		io.release();
	});
});

test("A1: stop() halts sending and is idempotent", async () => {
	const sent = [];
	const io = manualSleep();
	const probe = createEchoProbe({ send: (line) => sent.push(line), sleep: io.sleep });
	probe.start();
	probe.stop();
	probe.stop();
	io.release();
	await new Promise((r) => setImmediate(r));
	assert.equal(sent.length, 1, "no probe after stop()");
});

test("A1: a custom intervalMs is passed to sleep verbatim", () => {
	const io = manualSleep();
	const probe = createEchoProbe({ send: () => {}, intervalMs: 50, sleep: io.sleep });
	probe.start();
	assert.deepEqual(io.intervals, [50]);
	probe.stop();
	io.release();
});

test("A1: line() reports the most recently sent probe", () => {
	const io = manualSleep();
	const probe = createEchoProbe({ send: () => {}, sleep: io.sleep });
	assert.equal(probe.line(), "", "no probe sent yet");
	probe.start();
	assert.equal(probe.line(), "boot-probe-1\r");
	probe.stop();
	io.release();
});

test("A1: a throwing send stops the loop instead of rejecting unhandled", async () => {
	let calls = 0;
	const probe = createEchoProbe({
		send: () => {
			calls += 1;
			if (calls === 2) throw new Error("dead socket");
		},
		sleep: async () => {},
	});
	probe.start();
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	assert.equal(calls, 2, "the throwing send was the last call");
	probe.stop();
});
