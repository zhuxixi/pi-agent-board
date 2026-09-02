import assert from "node:assert/strict";
import { test } from "node:test";
import { createEditorStateReporter } from "../src/core/editor-state-reporter.mjs";

/** Manual-clock scheduler: interval/timeout register callbacks at `now + ms`;
 * fireOne(at) advances the clock and runs the oldest due callback. Repeating
 * intervals re-arm under the SAME handle so the reporter can clear them. */
function fakeScheduler() {
	const pending = []; // { handle, fn, ms, repeat, due }
	let nextId = 1;
	let now = 0;
	return {
		pending,
		interval(fn, ms) { return this._push(fn, ms, true); },
		timeout(fn, ms) { return this._push(fn, ms, false); },
		_push(fn, ms, repeat) {
			const handle = nextId++;
			pending.push({ handle, fn, ms, repeat, due: now + ms });
			return handle;
		},
		clear(handle) {
			const i = pending.findIndex((p) => p.handle === handle);
			if (i >= 0) pending.splice(i, 1);
		},
		/** Run the callback whose cadence is due now; returns it or null. */
		fireOne(at) {
			now = at;
			const due = pending.filter((p) => p.due <= at).sort((a, b) => a.due - b.due)[0];
			if (!due) return null;
			const { handle, fn, ms, repeat } = due;
			this.clear(handle);
			fn();
			if (repeat) pending.push({ handle, fn, ms, repeat, due: now + ms });
			return due;
		},
	};
}

function fakeSocket() {
	const sent = [];
	const handlers = {};
	return {
		sent,
		write(jsonLine) { sent.push(jsonLine); },
		on(event, fn) { handlers[event] = fn; },
		emit(event) { handlers[event]?.(); },
	};
}

test("reporter polls and sends only on text change (A1)", () => {
	const sched = fakeScheduler();
	let text = "";
	const socket = fakeSocket();
	const reporter = createEditorStateReporter({
		getEditorText: () => text,
		connect: () => socket,
		scheduler: sched,
		intervalMs: 100,
	});
	reporter.start();
	assert.equal(socket.sent.length, 0); // no send before the first poll
	sched.fireOne(100); // first poll: "" → lastText was null → change → send empty:true
	assert.deepEqual(socket.sent.map((l) => JSON.parse(l)), [{ type: "editor_state", empty: true }]);
	text = "draft";
	sched.fireOne(200);
	assert.equal(socket.sent.length, 2);
	assert.deepEqual(JSON.parse(socket.sent[1]), { type: "editor_state", empty: false });
	sched.fireOne(300); // unchanged text → no send (dedupe)
	assert.equal(socket.sent.length, 2);
	text = "";
	sched.fireOne(400);
	assert.equal(socket.sent.length, 3);
	assert.deepEqual(JSON.parse(socket.sent[2]), { type: "editor_state", empty: true });
	reporter.stop();
});

test("reporter stop is idempotent and ends polling (A1)", () => {
	const sched = fakeScheduler();
	const socket = fakeSocket();
	const reporter = createEditorStateReporter({ getEditorText: () => "", connect: () => socket, scheduler: sched, intervalMs: 100 });
	reporter.start();
	sched.fireOne(100);
	reporter.stop();
	reporter.stop();
	assert.equal(sched.pending.length, 0); // poll + reconnect timers all cleared
	assert.equal(socket.sent.length, 1);
});

test("reporter retries connect with capped backoff then recovers (A2)", () => {
	const sched = fakeScheduler();
	const socket = fakeSocket();
	let attempts = 0;
	let connect = () => { attempts++; throw new Error("not up yet"); };
	const reporter = createEditorStateReporter({ getEditorText: () => "", connect: () => connect(), scheduler: sched, intervalMs: 100 });
	reporter.start();
	assert.equal(attempts, 1); // immediate try
	// Backoff sequence: 1s, 2s, 4s, 5s, 5s …
	let t = 0;
	for (const expectedGap of [1000, 2000, 4000, 5000, 5000]) {
		const before = attempts;
		const fired = sched.fireOne(t + expectedGap);
		assert.ok(fired, "reconnect timer must fire");
		assert.equal(attempts, before + 1);
		t += expectedGap;
	}
	// Now the server is up — next reconnect succeeds and polling begins, backoff resets.
	connect = () => { attempts++; return socket; };
	sched.fireOne(t + 5000);
	assert.equal(attempts, 7);
	sched.fireOne(t + 5000 + 100); // first poll after connect
	assert.equal(socket.sent.length, 1);
	assert.deepEqual(JSON.parse(socket.sent[0]), { type: "editor_state", empty: true });
	reporter.stop();
});

test("reporter reconnects after socket close (A2)", () => {
	const sched = fakeScheduler();
	const first = fakeSocket();
	const second = fakeSocket();
	let call = 0;
	const reporter = createEditorStateReporter({
		getEditorText: () => "",
		connect: () => (++call === 1 ? first : second),
		scheduler: sched,
		intervalMs: 100,
	});
	reporter.start();
	sched.fireOne(100); // poll on first socket
	assert.equal(first.sent.length, 1);
	first.emit("close");
	assert.equal(sched.pending.length, 1); // reconnect timer scheduled (backoff 1s)
	sched.fireOne(1100); // reconnect succeeds on second socket
	sched.fireOne(1200); // poll resumes
	assert.equal(second.sent.length, 1);
	reporter.stop();
});
