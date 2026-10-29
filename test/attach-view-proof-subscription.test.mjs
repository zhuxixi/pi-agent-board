// Issue #222 step 23b2b (task-23b2b-brief.md): pure subscription + real model/tracker
// tests for the optional per-socket viewProof capability. Old subscribers stay byte/message
// compatible; opt-in subscribers get live/capture/replay view_proof records and snapshot
// coverage without a second S/A cache.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTerminalModel, feedOutput } from "../src/core/terminal-model.mjs";
import { createTerminalSubscription, MAX_VIEW_PROOF_RECORDS } from "../src/core/terminal-attach-protocol.mjs";
import { createViewProofTracker } from "../src/core/attach-view-proof.mjs";

const META = {
	protocol: 1,
	cols: 20,
	rows: 4,
	mode: "fullscreen",
	rendererEpoch: 1,
	sessionEpoch: 0,
	focusPresent: true,
	overlayPresent: false,
	intentId: 0,
	geometryRevision: 0,
};
const S = (seq, frameId) => ({ marker: "S", seq, frameId, sessionEpoch: 0, intentId: 0, sampledCols: 20 });
const F = (seq, frameId) => ({ marker: "F", seq, frameId, sessionEpoch: 0, metadata: META });
const A = (seq, frameId, reason = "stop") => ({ marker: "A", seq, frameId, sessionEpoch: 0, reason });

function manualParserFactory() {
	/** @type {any} */
	const parser = {
		cols: 20,
		rows: 4,
		buffer: { active: { cursorX: 0, cursorY: 0, baseY: 0, length: 4, getLine: () => null } },
		held: [],
		write(_data, cb) {
			parser.held.push(cb);
		},
		release() {
			const callbacks = parser.held.splice(0);
			for (const cb of callbacks) cb?.();
		},
		resize() {},
		reset() {},
	};
	return () => parser;
}

async function waitFor(predicate, label, timeoutMs = 2000) {
	const start = Date.now();
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function harness({ optIn = true, modelOpts = {}, provider = null } = {}) {
	const model = createTerminalModel({ cols: 20, rows: 4, scrollback: 50, ...modelOpts });
	const tracker = createViewProofTracker();
	const messages = [];
	const source =
		provider === null
			? optIn
				? { coverage: (seq) => tracker.coverageFor(seq), replay: (fromSeq, throughSeq) => tracker.replay(fromSeq, throughSeq) }
				: null
			: provider;
	const sub = createTerminalSubscription({ model, send: (msg) => messages.push(msg), generation: "gen-1", viewProof: source });
	function output(data) {
		const seq = feedOutput(model, data);
		tracker.feedOutput(seq, data);
		sub.onOutput(seq, data);
		return seq;
	}
	function record(entry) {
		const result =
			entry.marker === "S"
				? tracker.openCandidate(entry)
				: entry.marker === "F"
					? tracker.completeProof(entry)
					: tracker.abortCandidate(entry);
		assert.equal(result.status, "ok", `tracker ${entry.marker}: ${result.reason}`);
		sub.onViewProofRecord(entry);
	}
	function subscribe(extra = {}) {
		sub.handleMessage({ type: "subscribe_terminal", ...(optIn ? { viewProof: 1 } : {}), ...extra });
	}
	return { model, tracker, messages, sub, output, record, subscribe };
}

const types = (messages) => messages.map((msg) => msg.type).join(",");
const first = (messages, type) => messages.find((msg) => msg.type === type);

test("23b2b subscription: an old subscriber keeps the exact legacy message shape", async () => {
	const h = harness({ optIn: false });
	h.output("hello");
	h.subscribe();
	await waitFor(() => first(h.messages, "snapshot_end"), "snapshot_end");
	assert.equal(types(h.messages), "snapshot_begin,snapshot_frame,snapshot_end");
	for (const msg of h.messages) assert.equal(Object.hasOwn(msg, "viewProof"), false);
	h.output(" world");
	assert.equal(h.messages.filter((msg) => msg.type === "view_proof").length, 0);
	assert.equal(h.messages.filter((msg) => msg.type === "view_proof_state").length, 0);
});

test("23b2b subscription: opt-in snapshot begin/end carry covered viewProof and DECTCEM visibility", async () => {
	const h = harness();
	h.output("A");
	h.record(S(1, 1));
	h.output("BODY");
	h.record(F(2, 1));
	h.output("\u001b[?25l");
	h.subscribe();
	await waitFor(() => first(h.messages, "snapshot_end"), "snapshot_end");
	const begin = first(h.messages, "snapshot_begin");
	const end = first(h.messages, "snapshot_end");
	assert.equal(begin.viewProof.status, "covered");
	assert.equal(begin.viewProof.proof.marker, "F");
	assert.equal(begin.viewProof.proof.seq, 2);
	assert.equal(begin.viewProof.throughSeq, 3);
	assert.equal(begin.viewProof.cursorVisible, false);
	assert.equal(end.viewProof.status, "covered");
	assert.equal(end.viewProof.throughSeq, 3);
});

test("23b2b subscription: unsafe text/cursor/OSC8 trailing never presents a covered snapshot", async () => {
	for (const unsafe of ["text", "\u001b[2A", "\u001b]8;;https://example.test\u0007"]) {
		const h = harness();
		h.output("A");
		h.record(S(1, 1));
		h.output("BODY");
		h.record(F(2, 1));
		h.output(unsafe);
		h.subscribe();
		await waitFor(() => first(h.messages, "snapshot_end"), "snapshot_end");
		assert.equal(first(h.messages, "snapshot_begin").viewProof.status, "unavailable", unsafe);
		assert.equal(first(h.messages, "snapshot_begin").viewProof.reason, "trailing-unsafe");
		assert.equal(first(h.messages, "snapshot_end").viewProof.status, "unavailable");
	}
});

test("23b2b subscription: empty baseline is explicit UNKNOWN, never a fabricated proof", async () => {
	const h = harness();
	h.subscribe();
	await waitFor(() => first(h.messages, "snapshot_end"), "snapshot_end");
	const begin = first(h.messages, "snapshot_begin");
	const end = first(h.messages, "snapshot_end");
	assert.equal(begin.empty, true);
	assert.deepEqual(begin.viewProof, { status: "unknown", reason: "empty-baseline", proof: null, throughSeq: null, cursorVisible: null });
	assert.deepEqual(end.viewProof, begin.viewProof);
	assert.equal(types(h.messages), "snapshot_begin,snapshot_end");
});

test("23b2b subscription: open candidate and abort are visible as UNKNOWN current coverage", async () => {
	const h = harness();
	h.output("A");
	h.record(S(1, 1));
	h.subscribe();
	await waitFor(() => first(h.messages, "snapshot_end"), "snapshot_end");
	assert.equal(first(h.messages, "snapshot_end").viewProof.reason, "candidate-open");
	h.record(A(1, 1));
	const state = h.messages.filter((msg) => msg.type === "view_proof_state").at(-1);
	assert.equal(state, undefined, "live abort does not fabricate a state message");
	assert.deepEqual(
		h.messages.filter((msg) => msg.type === "view_proof").map((msg) => msg.record.marker),
		["A"],
	);
	assert.equal(first(h.messages, "snapshot_frame") !== undefined, true);
});

test("23b2b subscription: live S/F/A records are sent in production order and A is never an F", async () => {
	const h = harness();
	h.output("A");
	h.subscribe();
	await waitFor(() => first(h.messages, "snapshot_end"), "snapshot_end");
	h.output("BODY");
	h.record(S(2, 1));
	h.record(F(2, 1));
	h.output("BODY2");
	h.record(S(3, 2));
	h.record(A(3, 2, "resize"));
	const records = h.messages.filter((msg) => msg.type === "view_proof").map((msg) => msg.record);
	assert.deepEqual(records.map((record) => [record.marker, record.frameId, record.seq]), [
		["S", 1, 2],
		["F", 1, 2],
		["S", 2, 3],
		["A", 2, 3],
	]);
	assert.equal(records.filter((record) => record.frameId === 2 && record.marker === "F").length, 0);
	assert.equal(records[0].token, undefined, "no token is exposed");
	assert.equal(records[1].metadata.protocol, 1);
	assert.equal(records[3].reason, "resize");
});

test("23b2b subscription: same-seq F proofs keep production order on live and replay", async () => {
	const h = harness();
	h.output("A");
	h.subscribe();
	await waitFor(() => first(h.messages, "snapshot_end"), "snapshot_end");
	h.output("BODY");
	h.record(S(2, 1));
	h.record(F(2, 1));
	h.record(S(2, 2));
	h.record(F(2, 2));
	const live = h.messages.filter((msg) => msg.type === "view_proof").map((msg) => msg.record);
	assert.deepEqual(live.map((record) => [record.marker, record.frameId, record.seq]), [
		["S", 1, 2],
		["F", 1, 2],
		["S", 2, 2],
		["F", 2, 2],
	]);

	const r = harness();
	r.output("A");
	r.record(S(1, 1));
	r.output("BODY");
	r.record(F(2, 1));
	r.record(S(2, 2));
	r.record(F(2, 2));
	r.output("\u001b[?25l");
	r.subscribe({ sinceSeq: 1 });
	const replayed = r.messages.filter((msg) => msg.type === "view_proof").map((msg) => msg.record);
	assert.deepEqual(replayed.map((record) => [record.marker, record.frameId, record.seq]), [
		["F", 1, 2],
		["F", 2, 2],
	]);
	assert.equal(types(r.messages).endsWith("view_proof_state"), true);
	assert.equal(first(r.messages, "view_proof_state").viewProof.status, "covered");
});

test("23b2b subscription: replay interleaves output first at equal seq and ends with current coverage", async () => {
	const h = harness();
	h.output("one");
	h.record(S(1, 1));
	h.output("two");
	h.record(F(2, 1));
	h.output("\u001b[?25l");
	h.subscribe({ sinceSeq: 1 });
	assert.deepEqual(
		h.messages.map((msg) => [msg.type, msg.seq]),
		[
			["output", 2],
			["view_proof", undefined],
			["output", 3],
			["view_proof_state", undefined],
		],
	);
	const proof = h.messages.find((msg) => msg.type === "view_proof");
	assert.equal(proof.record.marker, "F");
	assert.equal(proof.record.seq, 2);
	const state = first(h.messages, "view_proof_state");
	assert.equal(state.viewProof.status, "covered");
	assert.equal(state.viewProof.throughSeq, 3);
	assert.equal(state.viewProof.cursorVisible, false);
});

test("23b2b subscription: capture queues S/F records and emits them in seq order after the frame", async () => {
	const h = harness({ modelOpts: { parserFactory: manualParserFactory() } });
	h.output("A");
	h.subscribe();
	// Capture is waiting for parser idle: feed output + records that belong to the snapshot.
	h.output("B");
	h.record(S(2, 1));
	h.record(F(2, 1));
	h.model.parser.release();
	await waitFor(() => first(h.messages, "snapshot_end"), "snapshot_end");
	assert.equal(types(h.messages), "snapshot_begin,snapshot_frame,view_proof,view_proof,snapshot_end");
	const records = h.messages.filter((msg) => msg.type === "view_proof").map((msg) => msg.record);
	assert.deepEqual(records.map((record) => [record.marker, record.frameId, record.seq]), [
		["S", 1, 2],
		["F", 1, 2],
	]);
	assert.equal(h.messages.filter((msg) => msg.type === "output").length, 0, "snapshot output is never duplicated");
	assert.equal(first(h.messages, "snapshot_end").viewProof.status, "covered");
});

test("23b2b subscription: proof-journal eviction marks replay UNKNOWN instead of stitching", async () => {
	const model = createTerminalModel({ cols: 20, rows: 4, scrollback: 50 });
	const tracker = createViewProofTracker({ maxJournal: 2 });
	const messages = [];
	const sub = createTerminalSubscription({
		model,
		send: (msg) => messages.push(msg),
		generation: "gen-1",
		viewProof: { coverage: (seq) => tracker.coverageFor(seq), replay: (a, b) => tracker.replay(a, b) },
	});
	for (let seq = 1; seq <= 5; seq += 1) {
		const assigned = feedOutput(model, `chunk-${seq}`);
		tracker.feedOutput(assigned, `chunk-${seq}`);
		if (seq === 1) {
			assert.equal(tracker.openCandidate(S(1, 1)).status, "ok");
		}
		if (seq === 2) {
			assert.equal(tracker.completeProof(F(2, 1)).status, "ok");
		}
	}
	sub.handleMessage({ type: "subscribe_terminal", viewProof: 1, sinceSeq: 1 });
	assert.equal(messages.filter((msg) => msg.type === "view_proof").length, 0);
	const state = messages.find((msg) => msg.type === "view_proof_state");
	assert.equal(state.viewProof.status, "unknown");
	assert.match(state.viewProof.reason, /proof-replay-evicted/);
});

test("23b2b subscription: range-local proof drops mark replay UNKNOWN; lifetime-only drops do not", async () => {
	const model = createTerminalModel({ cols: 20, rows: 4, scrollback: 50 });
	const tracker = createViewProofTracker();
	feedOutput(model, "one");
	tracker.feedOutput(1, "one");
	assert.equal(tracker.openCandidate(S(1, 1)).status, "ok");
	for (let frameId = 1; frameId <= 19; frameId += 1) {
		if (frameId > 1) assert.equal(tracker.openCandidate(S(1, frameId)).status, "ok");
		assert.equal(tracker.completeProof(F(1, frameId)).status, "ok");
	}
	const messages = [];
	const sub = createTerminalSubscription({
		model,
		send: (msg) => messages.push(msg),
		generation: "gen-1",
		viewProof: { coverage: (seq) => tracker.coverageFor(seq), replay: (a, b) => tracker.replay(a, b) },
	});
	sub.handleMessage({ type: "subscribe_terminal", viewProof: 1, sinceSeq: 0 });
	assert.equal(messages.filter((msg) => msg.type === "view_proof").length, 0);
	assert.equal(messages.find((msg) => msg.type === "view_proof_state").viewProof.reason, "proof-replay-dropped");

	const fakeModel = createTerminalModel({ cols: 20, rows: 4, scrollback: 50 });
	feedOutput(fakeModel, "a");
	feedOutput(fakeModel, "b");
	const fakeMessages = [];
	const fake = createTerminalSubscription({
		model: fakeModel,
		send: (msg) => fakeMessages.push(msg),
		generation: "gen-1",
		viewProof: {
			coverage: () => ({ status: "covered", reason: "exact-proof", proof: { marker: "F", seq: 2 }, throughSeq: 2, cursorVisible: null }),
			replay: () => ({ status: "ok", droppedProofs: 20, droppedEvents: 0, entries: [] }),
		},
	});
	fake.handleMessage({ type: "subscribe_terminal", viewProof: 1, sinceSeq: 0 });
	assert.equal(fakeMessages.find((msg) => msg.type === "view_proof_state").viewProof.status, "covered");
});

test("23b2b subscription: reporter reset clears queued records and forces UNKNOWN", async () => {
	const model = createTerminalModel({ cols: 20, rows: 4, scrollback: 50, parserFactory: manualParserFactory() });
	const tracker = createViewProofTracker();
	const messages = [];
	const sub = createTerminalSubscription({
		model,
		send: (msg) => messages.push(msg),
		generation: "gen-1",
		viewProof: { coverage: (seq) => tracker.coverageFor(seq), replay: (a, b) => tracker.replay(a, b) },
	});
	const seq = feedOutput(model, "A");
	tracker.feedOutput(seq, "A");
	sub.handleMessage({ type: "subscribe_terminal", viewProof: 1 });
	sub.onViewProofRecord(S(1, 1));
	sub.onViewProofReset("reporter-replaced");
	model.parser.release();
	await waitFor(() => messages.some((msg) => msg.type === "snapshot_end"), "snapshot_end");
	assert.equal(messages.filter((msg) => msg.type === "view_proof").length, 0, "queued records are dropped");
	const end = messages.find((msg) => msg.type === "snapshot_end");
	assert.equal(end.viewProof.status, "unknown");
	assert.equal(end.viewProof.reason, "reporter-replaced");

	sub.onViewProofRecord(S(2, 2));
	assert.equal(messages.filter((msg) => msg.type === "view_proof").at(-1).record.frameId, 2);
	sub.onViewProofReset("reporter-close");
	const state = messages.filter((msg) => msg.type === "view_proof_state").at(-1);
	assert.equal(state.viewProof.reason, "reporter-close");
});

test("23b2b subscription: capture queue is bounded and dropped records force UNKNOWN", async () => {
	const model = createTerminalModel({ cols: 20, rows: 4, scrollback: 50, parserFactory: manualParserFactory() });
	const tracker = createViewProofTracker();
	const messages = [];
	const sub = createTerminalSubscription({
		model,
		send: (msg) => messages.push(msg),
		generation: "gen-1",
		viewProof: { coverage: (seq) => tracker.coverageFor(seq), replay: (a, b) => tracker.replay(a, b) },
	});
	const seq = feedOutput(model, "A");
	tracker.feedOutput(seq, "A");
	sub.handleMessage({ type: "subscribe_terminal", viewProof: 1 });
	for (let index = 0; index < MAX_VIEW_PROOF_RECORDS + 1; index += 1) sub.onViewProofRecord(S(1, index + 1));
	model.parser.release();
	await waitFor(() => messages.some((msg) => msg.type === "snapshot_end"), "snapshot_end");
	assert.equal(messages.filter((msg) => msg.type === "view_proof").length, 0);
	assert.equal(messages.find((msg) => msg.type === "snapshot_end").viewProof.reason, "view-proof-records-dropped");
});

test("23b2b subscription: viewProof negotiation fails closed for other versions", () => {
	const h = harness();
	h.sub.handleMessage({ type: "subscribe_terminal", viewProof: 2 });
	assert.deepEqual(
		h.messages.map((msg) => [msg.type, msg.code, msg.supported, msg.received]),
		[["error", "view_proof_version_mismatch", 1, 2]],
	);
	assert.equal(h.sub.subscribed(), true, "the socket is protocol-managed even when rejected");
});

test("23b2b fix1: viewProof negotiation is sticky across a later subscribe without the field", async () => {
	const h = harness();
	h.output("A");
	h.subscribe();
	await waitFor(() => first(h.messages, "snapshot_end"), "first snapshot_end");
	// A later subscribe_terminal omitting viewProof must not downgrade the socket.
	h.sub.handleMessage({ type: "subscribe_terminal" });
	await waitFor(() => h.messages.filter((msg) => msg.type === "snapshot_end").length === 2, "second snapshot_end");
	assert.equal(first(h.messages, "snapshot_end").viewProof !== undefined, true);
	h.output("BODY");
	h.record(S(2, 1));
	h.record(F(2, 1));
	assert.deepEqual(
		h.messages.filter((msg) => msg.type === "view_proof").map((msg) => msg.record.marker),
		["S", "F"],
		"records still flow after the field-less re-subscribe",
	);

	const legacy = harness({ optIn: false });
	legacy.output("A");
	legacy.subscribe();
	await waitFor(() => first(legacy.messages, "snapshot_end"), "legacy snapshot_end");
	legacy.output("BODY");
	legacy.record(S(2, 1));
	legacy.record(F(2, 1));
	assert.equal(legacy.messages.filter((msg) => msg.type === "view_proof").length, 0);
	assert.equal(legacy.messages.filter((msg) => Object.hasOwn(msg, "viewProof")).length, 0);
	legacy.sub.handleMessage({ type: "subscribe_terminal", viewProof: 0 });
	const mismatch = legacy.messages.filter((msg) => msg.type === "error").at(-1);
	assert.equal(mismatch.code, "view_proof_version_mismatch");
	assert.equal(mismatch.supported, 1);
	assert.equal(mismatch.received, 0);
});
