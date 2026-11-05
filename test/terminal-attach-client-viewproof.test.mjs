// Issue #222 step 23b2c1: client-side viewProof facts. The client advertises viewProof:1,
// sanitizes bounded records/state, and adds optional snapshotReady facts without changing
// old-runner event shapes or transport continuity.
import assert from "node:assert/strict";
import test from "node:test";

import { createTerminalAttachClient } from "../src/core/terminal-attach-client.mjs";
import { MAX_VIEW_PROOF_RECORDS, TERMINAL_FRAME_VERSION, VIEW_PROOF_PROTOCOL_VERSION } from "../src/core/terminal-attach-protocol.mjs";

const META = {
	protocol: 1,
	cols: 80,
	rows: 24,
	mode: "fullscreen",
	rendererEpoch: 1,
	sessionEpoch: 1,
	focusPresent: true,
	overlayPresent: false,
	intentId: 0,
	geometryRevision: 0,
};
const SUB = { type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION, viewProof: VIEW_PROOF_PROTOCOL_VERSION };
const SUB_SEQ = (n) => ({ ...SUB, sinceSeq: n });
const begin = (over = {}) => ({ type: "snapshot_begin", snapshotSeq: 5, cols: 80, rows: 24, frameVersion: 1, ...over });
const frame = (data = "\x1b[2J\x1b[3JFRAME") => ({ type: "snapshot_frame", frameVersion: 1, data });
const end = (nextSeq, over = {}) => ({ type: "snapshot_end", nextSeq, ...over });
const out = (seq, data = `chunk${seq}`) => ({ type: "output", seq, data });
const proof = (seq, frameId = 1) => ({ marker: "F", seq, frameId, sessionEpoch: 1, metadata: META });
const covered = (seq, frameId = 1) => ({
	status: "covered",
	reason: "exact-proof",
	proof: proof(seq, frameId),
	throughSeq: seq,
	cursorVisible: true,
});
const unknown = (reason = "reporter-replaced") => ({ status: "unknown", reason, proof: null, throughSeq: null, cursorVisible: null });
const record = (marker, seq, frameId = 1) =>
	marker === "S"
		? { marker, seq, frameId, sessionEpoch: 1, intentId: 0, sampledCols: 80 }
		: marker === "F"
			? proof(seq, frameId)
			: { marker, seq, frameId, sessionEpoch: 1, reason: "stop" };

function harness(opts = {}) {
	const sent = [];
	const events = [];
	const timers = [];
	const client = createTerminalAttachClient({
		send: (msg) => sent.push(msg),
		emit: (event, payload) => events.push({ event, payload }),
		scheduleTimeout: (delayMs, fn) => {
			const entry = { delayMs, fn, cancelled: false };
			timers.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
		...opts,
	});
	return { client, sent, events, timers };
}

const eventsOf = (events, name) => events.filter((event) => event.event === name).map((event) => event.payload);

function live(client, { snapshotSeq = 5, nextSeq = 6 } = {}) {
	client.start();
	client.handleMessage(begin({ snapshotSeq }));
	client.handleMessage(frame());
	client.handleMessage(end(nextSeq));
}

test("23b2c1 client: every non-legacy subscribe advertises viewProof:1", () => {
	const { client, sent } = harness();
	client.start();
	assert.deepEqual(sent.at(-1), SUB);
	client.handleMessage(begin({ snapshotSeq: 5 }));
	client.handleMessage(frame());
	client.handleMessage(end(6));
	client.reconnect(5);
	assert.deepEqual(sent.at(-1), SUB_SEQ(5), "same-generation reconnect keeps the optional capability");
	client.handleMessage({ type: "resnapshot_required" });
	assert.deepEqual(sent.at(-1), SUB, "resync subscribe advertises viewProof:1");
	assert.equal(sent.every((msg) => msg.type !== "subscribe_terminal" || msg.viewProof === 1), true);

	const legacy = harness({ forceLegacy: true });
	legacy.client.start();
	assert.equal(legacy.sent.some((msg) => msg.type === "subscribe_terminal"), false, "forced legacy never subscribes");
});

test("23b2c1 client: old runner proof-less snapshotReady shape is unchanged", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(begin());
	client.handleMessage(frame());
	client.handleMessage(end(6));
	const ready = eventsOf(events, "snapshotReady")[0];
	assert.equal(Object.hasOwn(ready, "viewProof"), false);
	assert.equal(Object.hasOwn(ready, "viewProofRecords"), false);
	assert.deepEqual(ready, { frame: "\x1b[2J\x1b[3JFRAME", empty: undefined, resnapshot: undefined, nextSeq: 6 });
});

test("23b2c1 client: snapshot begin/end coverage and bounded records reach snapshotReady", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5, viewProof: covered(5) }));
	client.handleMessage(frame());
	client.handleMessage(out(6, "tail"));
	client.handleMessage({ type: "view_proof", record: record("S", 6, 1) });
	client.handleMessage({ type: "view_proof", record: record("F", 6, 1) });
	client.handleMessage(end(7, { viewProof: covered(6) }));
	const ready = eventsOf(events, "snapshotReady")[0];
	assert.equal(ready.viewProof.status, "covered");
	assert.equal(ready.viewProof.proof.marker, "F");
	assert.deepEqual(ready.viewProofRecords.map((entry) => entry.marker), ["S", "F"]);
	assert.equal(eventsOf(events, "output").length, 1, "frame/flush ordering is unchanged");
});

test("23b2c1 client: missing catch-up output for a record makes coverage UNKNOWN", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5, viewProof: covered(5) }));
	client.handleMessage(frame());
	client.handleMessage({ type: "view_proof", record: record("F", 6, 1) });
	client.handleMessage(end(6, { viewProof: covered(5) }));
	const ready = eventsOf(events, "snapshotReady")[0];
	assert.equal(ready.viewProof.status, "unknown");
	assert.equal(ready.viewProof.reason, "proof-output-gap");
	assert.equal(ready.viewProofRecords.length, 1, "the received record is still reported as a fact");
});

test("23b2c1 client: record overflow makes snapshot coverage UNKNOWN and omits partial records", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5 }));
	client.handleMessage(frame());
	for (let index = 0; index <= MAX_VIEW_PROOF_RECORDS; index += 1) {
		client.handleMessage({ type: "view_proof", record: record("S", 5, index + 1) });
	}
	client.handleMessage(end(6, { viewProof: covered(5) }));
	const ready = eventsOf(events, "snapshotReady")[0];
	assert.equal(ready.viewProof.status, "unknown");
	assert.equal(ready.viewProof.reason, "records-dropped");
	assert.equal(Object.hasOwn(ready, "viewProofRecords"), false);
});

test("23b2c1 client: collecting state coverage is a fallback only when end coverage is absent", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5 }));
	client.handleMessage(frame());
	client.handleMessage({ type: "view_proof_state", viewProof: covered(5) });
	client.handleMessage(end(6));
	assert.equal(eventsOf(events, "snapshotReady")[0].viewProof.status, "covered");
});

test("23b2c1 client: live records emit in receive order and state emits separate coverage", () => {
	const { client, events } = harness();
	live(client);
	client.handleMessage({ type: "view_proof", record: record("S", 5, 1) });
	client.handleMessage({ type: "view_proof", record: record("F", 5, 1) });
	client.handleMessage({ type: "view_proof", record: record("A", 5, 2) });
	client.handleMessage({ type: "view_proof_state", viewProof: covered(5, 1) });
	assert.deepEqual(
		events.filter((event) => event.event === "viewProofRecord").map((event) => event.payload.marker),
		["S", "F", "A"],
	);
	const coverage = eventsOf(events, "viewProof").at(-1);
	assert.equal(coverage.status, "covered");
	assert.equal(coverage.proof.marker, "F");
});

test("23b2c1 client: zero-output replay completes on view_proof_state", () => {
	const { client, events } = harness();
	live(client);
	const readyBefore = eventsOf(events, "snapshotReady").length;
	client.reconnect(5);
	assert.equal(client.getMode(), "protocol");
	client.handleMessage({ type: "view_proof_state", viewProof: covered(5) });
	assert.equal(client.getMode(), "protocol");
	assert.equal(eventsOf(events, "viewProof").at(-1).status, "covered");
	assert.equal(eventsOf(events, "snapshotReady").length, readyBefore, "a replay never fabricates snapshotReady");
});

test("23b2c1 client: live reset state emits UNKNOWN coverage", () => {
	const { client, events } = harness();
	live(client);
	client.handleMessage({ type: "view_proof_state", viewProof: unknown("reporter-replaced") });
	const coverage = eventsOf(events, "viewProof").at(-1);
	assert.equal(coverage.status, "unknown");
	assert.equal(coverage.reason, "reporter-replaced");
	assert.equal(coverage.proof, null);
});

test("23b2c1 client: malformed and future proof records fail closed without resync", () => {
	const { client, events } = harness();
	live(client);
	assert.equal(client.handleMessage({ type: "view_proof", record: { marker: "F", seq: 0 } }), true);
	assert.equal(eventsOf(events, "protocolError").at(-1).code, "view_proof_invalid");
	assert.equal(eventsOf(events, "viewProofRecord").length, 0);
	assert.equal(client.handleMessage({ type: "view_proof", record: { marker: "F", seq: 5, frameId: 1, sessionEpoch: 1, metadata: {} } }), true);
	assert.equal(eventsOf(events, "protocolError").at(-1).code, "view_proof_invalid", "F requires full §3 metadata");
	assert.equal(client.handleMessage({ type: "view_proof", record: record("F", 6, 1) }), true);
	assert.equal(eventsOf(events, "protocolError").at(-1).code, "view_proof_future");
	assert.equal(eventsOf(events, "viewProofRecord").length, 0);
	assert.equal(client.handleMessage({ type: "view_proof_state", viewProof: { status: "covered" } }), true);
	assert.equal(eventsOf(events, "protocolError").at(-1).code, "view_proof_invalid");
	assert.equal(eventsOf(events, "viewProof").at(-1).status, "unknown");
	assert.equal(client.getMode(), "protocol");
});

test("23b2c1 client: view_proof_version_mismatch fails conservatively to legacy", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage({ type: "error", code: "view_proof_version_mismatch", supported: 1, received: 2 });
	assert.equal(client.getMode(), "legacy");
	assert.equal(eventsOf(events, "protocolError").at(-1).code, "legacy_fallback");
});

test("23b2c1 fix1 RED: F sessionEpoch conflicting with nested metadata is invalid", () => {
	const { client, events } = harness();
	live(client);
	const conflicting = { ...record("F", 5, 1), sessionEpoch: 2 };
	assert.equal(client.handleMessage({ type: "view_proof", record: conflicting }), true);
	assert.equal(eventsOf(events, "protocolError").at(-1).code, "view_proof_invalid");
	assert.equal(eventsOf(events, "viewProofRecord").length, 0);
});

test("23b2c1 fix1 RED: snapshot coverage beyond nextSeq-1 becomes UNKNOWN", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5, viewProof: { ...covered(5), throughSeq: 12 } }));
	client.handleMessage(frame());
	client.handleMessage(end(6));
	const ready = eventsOf(events, "snapshotReady")[0];
	assert.equal(ready.viewProof.status, "unknown");
	assert.equal(ready.viewProof.reason, "view-proof-future");
});

test("23b2c1 fix1 RED: live view_proof_state beyond lastSeq is a diagnostic UNKNOWN", () => {
	const { client, events } = harness();
	live(client);
	client.handleMessage({ type: "view_proof_state", viewProof: { ...covered(5), throughSeq: 6 } });
	assert.equal(eventsOf(events, "protocolError").at(-1).code, "view_proof_future");
	const coverage = eventsOf(events, "viewProof").at(-1);
	assert.equal(coverage.status, "unknown");
	assert.equal(coverage.reason, "view-proof-future");
	assert.equal(client.getMode(), "protocol");
});

test("23b2c1 fix1 RED: replay transport completes even when state coverage is future", () => {
	const { client, events } = harness();
	live(client);
	client.reconnect(5);
	client.handleMessage({ type: "view_proof_state", viewProof: { ...covered(5), throughSeq: 6 } });
	assert.equal(client.getMode(), "protocol");
	assert.equal(eventsOf(events, "protocolError").at(-1).code, "view_proof_future");
	assert.equal(eventsOf(events, "viewProof").at(-1).reason, "view-proof-future");
});

test("23b2c2 fix1 client: requestResync is fresh/seq-less and forceLegacy is a bounded public wrapper", () => {
	const { client, sent, events } = harness();
	client.start();
	assert.equal(client.requestResync("parser_replacement_failed"), true);
	const resync = sent.at(-1);
	assert.equal(resync.type, "subscribe_terminal");
	assert.equal(resync.viewProof, 1);
	assert.equal("sinceSeq" in resync, false, "requestResync is always a fresh seq-less snapshot");
	assert.equal(eventsOf(events, "resubscribing").at(-1).reason, "parser_replacement_failed");
	assert.equal(client.forceLegacy("parser_observation_unavailable"), true);
	assert.equal(client.getMode(), "legacy");
	assert.equal(eventsOf(events, "mode").at(-1), "legacy");
	assert.equal(client.requestResync("after_legacy"), false, "no resync after legacy");
	assert.equal(client.forceLegacy("again"), true, "idempotent legacy wrapper");
});
