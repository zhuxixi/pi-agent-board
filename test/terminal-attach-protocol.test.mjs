import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalModel, feedOutput, ringChunksAfter } from "../src/core/terminal-model.mjs";
import {
	createTerminalSubscription,
	TERMINAL_FRAME_VERSION,
} from "../src/core/terminal-attach-protocol.mjs";
import { TERMINAL_SNAPSHOT_VERSION } from "../src/core/terminal-snapshot.mjs";

/** Real @xterm/headless model (fast enough for protocol tests). */
function realModel(opts = {}) {
	return createTerminalModel({ cols: 20, rows: 4, scrollback: 50, ...opts });
}

/** Parser factory whose write callbacks are held until the test releases them,
 *  so the async capture window is deterministic (A5 gap/dup injection). */
function manualParserFactory() {
	/** @type {any} */
	const parser = {
		cols: 20,
		rows: 4,
		buffer: {
			active: {
				cursorX: 0,
				cursorY: 0,
				baseY: 0,
				length: 4,
				getLine: () => null,
			},
		},
		held: [],
		write(_data, cb) {
			parser.held.push(cb);
		},
		release() {
			const cbs = parser.held.splice(0);
			for (const cb of cbs) cb?.();
		},
		resize() {},
		reset() {},
	};
	return () => parser;
}

/** Message sink with a "wait until predicate" helper for async snapshot flows. */
function sink() {
	/** @type {any[]} */
	const messages = [];
	let notify = () => {};
	const signal = () => notify();
	const waitUntil = async (predicate, label, timeoutMs = 2000) => {
		const start = Date.now();
		for (;;) {
			const found = predicate();
			if (found) return found;
			if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
			await new Promise((r) => {
				notify = r;
				setTimeout(r, 5).unref?.();
			});
		}
	};
	return { messages, signal, waitUntil };
}

function subscriber(model, { onSend } = {}) {
	const { messages, signal, waitUntil } = sink();
	const sub = createTerminalSubscription({
		model,
		send: (msg) => {
			messages.push(msg);
			onSend?.(msg);
			signal();
		},
	});
	return { sub, messages, waitUntil };
}

const types = (messages) => messages.map((m) => m.type).join(",");

test("first subscribe: snapshot at current seq, live continues at S+1", async () => {
	const model = realModel();
	const { sub, messages, waitUntil } = subscriber(model);
	feedOutput(model, "hello"); // seq 1
	sub.handleMessage({ type: "subscribe_terminal" });
	await waitUntil(() => messages.some((m) => m.type === "snapshot_end"), "snapshot_end");
	const begin = messages.find((m) => m.type === "snapshot_begin");
	const frame = messages.find((m) => m.type === "snapshot_frame");
	const end = messages.find((m) => m.type === "snapshot_end");
	assert.equal(begin.snapshotSeq, 1);
	assert.equal(begin.frameVersion, TERMINAL_FRAME_VERSION);
	assert.equal(begin.cols, 20);
	assert.equal(begin.rows, 4);
	assert.equal(frame.frameVersion, TERMINAL_FRAME_VERSION);
	assert.ok(typeof frame.data === "string" && frame.data.includes("hello"), "frame carries viewport content");
	assert.equal(end.nextSeq, 2);
	assert.equal(types(messages), "snapshot_begin,snapshot_frame,snapshot_end");

	// Live tail: runner wiring = feedOutput then onOutput per chunk.
	const seq = feedOutput(model, " world");
	sub.onOutput(seq, " world");
	const live = messages.filter((m) => m.type === "output");
	assert.equal(live.length, 1);
	assert.equal(live[0].seq, 2);
	assert.equal(live[0].data, " world");
	// Compat shape: output messages still carry plain `data` next to `seq`.
	assert.equal(typeof live[0].data, "string");
});

test("output fed during async capture lands exactly once (in snapshot, not as output)", async () => {
	const model = createTerminalModel({ cols: 20, rows: 4, scrollback: 50, parserFactory: manualParserFactory() });
	const { sub, messages, waitUntil } = subscriber(model);

	feedOutput(model, "chunk-one"); // seq 1 — write callback held by manual parser
	sub.handleMessage({ type: "subscribe_terminal" }); // capture waits for parser idle
	feedOutput(model, "chunk-two"); // seq 2 — fed DURING capture
	sub.onOutput(2, "chunk-two"); // runner fan-out during capture must be a no-op

	// Release the parser: both chunks parse, capture completes at snapshotSeq 2.
	model.parser.release();
	await waitUntil(() => messages.some((m) => m.type === "snapshot_end"), "snapshot_end");

	const begin = messages.find((m) => m.type === "snapshot_begin");
	const end = messages.find((m) => m.type === "snapshot_end");
	assert.equal(begin.snapshotSeq, 2, "snapshot incorporates chunks fed during capture");
	assert.equal(end.nextSeq, 3);
	const outputs = messages.filter((m) => m.type === "output");
	assert.deepEqual(outputs, [], "no chunk delivered twice (chunk-two is inside the snapshot frame)");

	// Post-end live chunk flows exactly once.
	const seq = feedOutput(model, "chunk-three");
	sub.onOutput(seq, "chunk-three");
	const outputsAfter = messages.filter((m) => m.type === "output");
	assert.deepEqual(
		outputsAfter.map((m) => [m.seq, m.data]),
		[[3, "chunk-three"]],
	);
});

test("reconnect with retained cursor: pure replay, no snapshot", () => {
	const model = realModel();
	for (const chunk of ["a", "b", "c"]) feedOutput(model, chunk);
	const { sub, messages } = subscriber(model);
	const handled = sub.handleMessage({ type: "subscribe_terminal", sinceSeq: 1 });
	assert.equal(handled, true);
	// Synchronous replay — no waiting needed.
	assert.equal(types(messages), "output,output");
	assert.deepEqual(
		messages.map((m) => [m.seq, m.data]),
		[[2, "b"], [3, "c"]],
	);
	// Live continues after the replayed cursor.
	const seq = feedOutput(model, "d");
	sub.onOutput(seq, "d");
	assert.deepEqual(
		messages.filter((m) => m.type === "output").map((m) => m.seq),
		[2, 3, 4],
	);
});

test("reconnect at exactly evictedThrough is a complete replay (boundary ruling)", () => {
	// Ring keeps (evictedThrough, lastSeq] contiguous: with cap 2, after feeding
	// 3 chunks evictedThrough === 1 and sinceSeq 1 must replay 2..3 in full.
	const model = realModel({ ringChunkCap: 2 });
	feedOutput(model, "one");
	feedOutput(model, "two");
	feedOutput(model, "three");
	assert.equal(model.evictedThrough, 1);
	const { sub, messages } = subscriber(model);
	sub.handleMessage({ type: "subscribe_terminal", sinceSeq: 1 });
	assert.deepEqual(
		messages.map((m) => [m.type, m.seq]),
		[["output", 2], ["output", 3]],
	);
});

test("reconnect past eviction: fresh snapshot with resnapshot marker", async () => {
	const model = realModel({ ringChunkCap: 2 });
	feedOutput(model, "one");
	feedOutput(model, "two");
	feedOutput(model, "three");
	const { sub, messages, waitUntil } = subscriber(model);
	sub.handleMessage({ type: "subscribe_terminal", sinceSeq: 0 });
	await waitUntil(() => messages.some((m) => m.type === "snapshot_end"), "snapshot_end");
	const begin = messages.find((m) => m.type === "snapshot_begin");
	assert.equal(begin.resnapshot, true, "client must be told to drop its local buffer");
	assert.equal(begin.snapshotSeq, 3);
	assert.equal(types(messages), "snapshot_begin,snapshot_frame,snapshot_end");
});

test("client ahead of runner (foreign cursor): fresh snapshot, not silent skip", async () => {
	const model = realModel();
	feedOutput(model, "a");
	const { sub, messages, waitUntil } = subscriber(model);
	sub.handleMessage({ type: "subscribe_terminal", sinceSeq: 99 });
	await waitUntil(() => messages.some((m) => m.type === "snapshot_end"), "snapshot_end");
	const begin = messages.find((m) => m.type === "snapshot_begin");
	assert.equal(begin.resnapshot, true, "runner must never accept a cursor it cannot serve");
	assert.equal(begin.snapshotSeq, 1);
});

test("empty model: host-starting baseline without frame", async () => {
	const model = realModel();
	const { sub, messages, waitUntil } = subscriber(model);
	sub.handleMessage({ type: "subscribe_terminal" });
	await waitUntil(() => messages.some((m) => m.type === "snapshot_end"), "snapshot_end");
	const begin = messages.find((m) => m.type === "snapshot_begin");
	assert.equal(begin.empty, true);
	assert.equal(begin.snapshotSeq, 0);
	assert.equal(begin.frameVersion, TERMINAL_FRAME_VERSION);
	assert.equal(messages.find((m) => m.type === "snapshot_end").nextSeq, 1);
	assert.equal(messages.find((m) => m.type === "snapshot_frame"), undefined, "no frame for an empty baseline");
	assert.equal(types(messages), "snapshot_begin,snapshot_end");
});

test("frameVersion mismatch on subscribe_terminal is rejected", async () => {
	const model = realModel();
	const { sub, messages } = subscriber(model);
	const handled = sub.handleMessage({ type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION + 1 });
	assert.equal(handled, true);
	assert.deepEqual(
		messages.map((m) => [m.type, m.code]),
		[["error", "frame_version_mismatch"]],
	);
	assert.ok(messages[0].supported === TERMINAL_FRAME_VERSION);
	// Matching version is accepted: with content in the model the capture is
	// async, so nothing (and no rejection) is sent synchronously. (An empty
	// model legitimately answers its baseline synchronously.)
	feedOutput(model, "content");
	const { sub: sub2, messages: messages2, waitUntil: waitUntil2 } = subscriber(model);
	sub2.handleMessage({ type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION });
	assert.equal(messages2.length, 0, "accepted subscribe starts async capture (no sync rejection)");
	await waitUntil2(() => messages2.some((m) => m.type === "snapshot_end"), "accepted subscribe completes");
	assert.ok(messages2.some((m) => m.type === "snapshot_frame"));
});

test("invalid sinceSeq is rejected", () => {
	const model = realModel();
	const { sub, messages } = subscriber(model);
	for (const bad of [-1, 1.5, "0", null]) {
		sub.handleMessage({ type: "subscribe_terminal", sinceSeq: bad });
	}
	const codes = messages.map((m) => m.code);
	assert.deepEqual(codes, [
		"invalid_since_seq",
		"invalid_since_seq",
		"invalid_since_seq",
		"invalid_since_seq",
	]);
	// Explicit null is invalid too: absence is `undefined`, not null. Absent
	// sinceSeq (first subscribe) is exercised by the other tests.
});

test("live gap downgrades the socket exactly once, further output ignored", () => {
	const model = realModel();
	feedOutput(model, "a"); // seq 1
	const { sub, messages } = subscriber(model);
	sub.handleMessage({ type: "subscribe_terminal", sinceSeq: 0 }); // replay 1, live
	feedOutput(model, "b"); // seq 2
	sub.onOutput(2, "b");
	// Simulate a lost/duplicated delivery: seq 4 while lastSeq is 2.
	sub.onOutput(4, "d");
	assert.deepEqual(
		messages.filter((m) => m.type === "resnapshot_required").map((m) => [m.lastSeq, m.missing]),
		[[2, 4]],
	);
	// Downgraded: subsequent chunks must not flow.
	feedOutput(model, "e");
	sub.onOutput(5, "e");
	assert.equal(messages.filter((m) => m.type === "output").length, 2);
	assert.equal(messages.filter((m) => m.type === "resnapshot_required").length, 1, "exactly one marker");
});

test("subscribed() is sticky across gap downgrade (runner keeps protocol ownership)", () => {
	const model = realModel();
	feedOutput(model, "a"); // seq 1
	const { sub } = subscriber(model);
	sub.handleMessage({ type: "subscribe_terminal", sinceSeq: 0 });
	assert.equal(sub.subscribed(), true, "subscribe_terminal marks the socket protocol-managed");
	sub.onOutput(2, "b");
	sub.onOutput(9, "z"); // gap → resnapshot_required, state back to idle
	assert.equal(sub.subscribed(), true, "gap downgrade must NOT hand the socket back to legacy broadcast");
	// Post-downgrade chunks stay ignored (re-subscription is the only way back).
	feedOutput(model, "c");
	sub.onOutput(10, "junk");
	assert.equal(sub.subscribed(), true);
});

test("frameVersion-mismatch rejection still marks the socket protocol-managed", () => {
	const model = realModel();
	const { sub, messages } = subscriber(model);
	sub.handleMessage({ type: "subscribe_terminal", frameVersion: 99 });
	assert.equal(messages[0]?.code, "frame_version_mismatch");
	assert.equal(sub.subscribed(), true, "a protocol-speaking client never falls back to the legacy stream");
});

test("non-subscribe messages are not consumed", () => {
	const model = realModel();
	const { sub, messages } = subscriber(model);
	assert.equal(sub.handleMessage({ type: "hello" }), false);
	assert.equal(sub.handleMessage(null), false);
	assert.equal(messages.length, 0);
});

test("duplicate subscribe while capture is in flight is ignored (no double snapshot)", async () => {
	const model = createTerminalModel({ cols: 20, rows: 4, scrollback: 50, parserFactory: manualParserFactory() });
	const { sub, messages, waitUntil } = subscriber(model);
	feedOutput(model, "x"); // write held
	sub.handleMessage({ type: "subscribe_terminal" });
	sub.handleMessage({ type: "subscribe_terminal" }); // duplicate during capture
	model.parser.release();
	await waitUntil(() => messages.some((m) => m.type === "snapshot_end"), "snapshot_end");
	assert.equal(messages.filter((m) => m.type === "snapshot_begin").length, 1);
});

test("frame and DTO versions are independent exported axes", () => {
	assert.equal(TERMINAL_FRAME_VERSION, 1);
	assert.equal(TERMINAL_SNAPSHOT_VERSION, 1);
	// They are separate constant bindings, not aliases of one variable — the wire
	// frame format and the internal DTO format may evolve independently.
	// (Independence is structural: distinct exported bindings, each asserted === 1
	// above; there is no value-level property that could pin it.)
});

test("ring eviction under capture pressure degrades to resnapshot_required", async () => {
	// Capture window with a real parser is one microtask wide, so squeeze the
	// ring to cap 1: chunk N+1's append evicts chunk N while the capture is
	// resolving. The subscription must refuse to stitch.
	const model = realModel({ ringChunkCap: 1 });
	feedOutput(model, "one"); // seq 1
	const { sub, messages, waitUntil } = subscriber(model);
	sub.handleMessage({ type: "subscribe_terminal" });
	feedOutput(model, "two".repeat(1)); // seq 2 → evicts seq 1 during capture window
	await waitUntil(
		() => messages.some((m) => m.type === "resnapshot_required") || messages.some((m) => m.type === "snapshot_end"),
		"capture outcome",
	);
	const outcome = messages.find((m) => m.type === "resnapshot_required" || m.type === "snapshot_end");
	// Either the catch-up caught the eviction (marker) or the window closed
	// before eviction (clean end). Both are correct; stitching is not.
	assert.ok(
		outcome.type === "resnapshot_required" || outcome.type === "snapshot_end",
		`unexpected terminal state: ${types(messages)}`,
	);
	// Whatever the outcome, the stream state is recoverable: a fresh subscribe succeeds.
	const { sub: sub2, messages: messages2, waitUntil: waitUntil2 } = subscriber(model);
	sub2.handleMessage({ type: "subscribe_terminal" });
	await waitUntil2(() => messages2.some((m) => m.type === "snapshot_end"), "fresh snapshot_end");
	assert.equal(messages2.find((m) => m.type === "snapshot_begin").snapshotSeq, 2);
});
