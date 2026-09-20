import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalAttachClient } from "../src/core/terminal-attach-client.mjs";
import { TERMINAL_FRAME_VERSION } from "../src/core/terminal-attach-protocol.mjs";

/**
 * Unit matrix for the client-side terminal attach protocol state machine.
 * Runner-side message shapes/boundaries are pinned by
 * test/terminal-attach-protocol.test.mjs (authoritative counterpart).
 */

/** Deterministic timer fake: armed timers are fired manually by tests. */
function makeTimerFake() {
	/** @type {{ delayMs: number, fn: () => void, cancelled: boolean }[]} */
	const armed = [];
	const schedule = (delayMs, fn) => {
		const entry = { delayMs, fn, cancelled: false };
		armed.push(entry);
		return () => {
			entry.cancelled = true;
		};
	};
	return {
		schedule,
		armed,
		/** Fire every live (non-cancelled) timer in arm order. */
		fireAll() {
			for (const t of armed) {
				if (!t.cancelled) {
					t.cancelled = true;
					t.fn();
				}
			}
		},
		live() {
			return armed.filter((t) => !t.cancelled);
		},
	};
}

function harness(opts = {}) {
	const sent = [];
	const events = [];
	const timers = makeTimerFake();
	const client = createTerminalAttachClient({
		send: (msg) => sent.push(msg),
		emit: (event, payload) => events.push({ event, payload }),
		probeTimeoutMs: opts.probeTimeoutMs ?? 1500,
		scheduleTimeout: timers.schedule,
		...opts,
	});
	return { client, sent, events, timers };
}

const begin = (over = {}) => ({
	type: "snapshot_begin",
	snapshotSeq: 5,
	cols: 80,
	rows: 24,
	frameVersion: 1,
	...over,
});
const frame = (data = "\x1b[2J\x1b[3JREDRAW") => ({ type: "snapshot_frame", frameVersion: 1, data });
const end = (nextSeq) => ({ type: "snapshot_end", nextSeq });
const out = (seq, data = `chunk${seq}`) => ({ type: "output", seq, data });
const err = (code, extra = {}) => ({ type: "error", code, ...extra });
/** Exact wire shape the client must advertise on every subscribe (F1). */
const SUB = { type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION };
const SUB_SEQ = (n) => ({ type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION, sinceSeq: n });
const eventsOf = (events, name) => events.filter((e) => e.event === name).map((e) => e.payload);

/** Drive one clean snapshot cycle into `client` (assumes collecting entry). */
function completeSnapshot(client, { snapshotSeq = 5, nextSeq = 6, data } = {}) {
	client.handleMessage(begin({ snapshotSeq }));
	client.handleMessage(data === undefined ? frame() : frame(data));
	client.handleMessage(end(nextSeq));
}

test("probe → protocol happy path: frame assembly, nextSeq continuity, seq-checked live", () => {
	const { client, sent, events } = harness();
	client.start();
	assert.deepEqual(sent, [SUB]);
	assert.equal(client.getMode(), "probing");

	assert.equal(client.handleMessage(begin({ snapshotSeq: 5 })), true);
	assert.deepEqual(eventsOf(events, "mode"), ["protocol"]);
	// No snapshotReady before continuity is verified at end.
	assert.equal(eventsOf(events, "snapshotReady").length, 0);

	client.handleMessage(frame("FRAME"));
	assert.equal(eventsOf(events, "snapshotReady").length, 0);
	client.handleMessage(end(6));
	assert.deepEqual(eventsOf(events, "snapshotReady"), [
		{ frame: "FRAME", empty: undefined, resnapshot: undefined, nextSeq: 6 },
	]);
	assert.equal(client.getMode(), "protocol");

	// Live: first seq must equal end.nextSeq.
	assert.equal(client.handleMessage(out(6)), true);
	assert.deepEqual(eventsOf(events, "output"), ["chunk6"]);
	client.handleMessage(out(7));
	assert.deepEqual(eventsOf(events, "output"), ["chunk6", "chunk7"]);
	assert.equal(client.getLastSeq(), 7);
});

test("probe timeout → legacy fallback (old runner silently ignores subscribe)", () => {
	const { client, sent, events, timers } = harness();
	client.start();
	assert.equal(timers.live().length, 1, "probe timer armed");
	timers.fireAll();
	assert.deepEqual(eventsOf(events, "mode"), ["legacy"]);
	assert.deepEqual(eventsOf(events, "protocolError"), [
		{ code: "legacy_fallback", message: "probe_timeout" },
	]);
	assert.equal(client.getMode(), "legacy");
	// Inert afterwards: UI owns every message.
	assert.equal(client.handleMessage(out(1, "legacy-bytes")), false);
	const sentBefore = sent.length;
	client.start();
	client.reconnect(0);
	assert.equal(sent.length, sentBefore, "no further protocol sends");
});

test("forceLegacy option: no probe, no subscribe sent, immediate legacy", () => {
	const { client, sent, events } = harness({ forceLegacy: true });
	client.start();
	assert.deepEqual(sent, []);
	assert.deepEqual(eventsOf(events, "mode"), ["legacy"]);
	assert.equal(client.getMode(), "legacy");
});

test("env AGENT_BOARD_TERMINAL_SNAPSHOT=0 forces legacy; explicit forceLegacy:false overrides env", () => {
	process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = "0";
	try {
		const a = harness();
		a.client.start();
		assert.deepEqual(eventsOf(a.events, "mode"), ["legacy"]);
		assert.deepEqual(a.sent, []);

		const b = harness({ forceLegacy: false });
		b.client.start();
		assert.deepEqual(b.sent, [SUB]);
		assert.deepEqual(eventsOf(b.events, "mode"), []);
		assert.equal(b.client.getMode(), "probing");
	} finally {
		delete process.env.AGENT_BOARD_TERMINAL_SNAPSHOT;
	}
});

test("frame_version_mismatch → legacy (runner treated as incompatible)", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(err("frame_version_mismatch", { supported: 2, received: 1 }));
	assert.deepEqual(eventsOf(events, "mode"), ["legacy"]);
	assert.equal(client.getMode(), "legacy");
});

test("live seq gap → internal fresh resubscribe (no sinceSeq, never stitched)", () => {
	const { client, sent, events } = harness();
	client.start();
	completeSnapshot(client, { snapshotSeq: 5, nextSeq: 6 });
	client.handleMessage(out(6));
	client.handleMessage(out(7));
	const sentBefore = sent.length;
	client.handleMessage(out(9)); // gap: 8 missing
	assert.deepEqual(eventsOf(events, "resubscribing"), [{ reason: "seq_gap" }]);
	const subscribe = sent[sentBefore];
	assert.equal(subscribe.type, "subscribe_terminal");
	assert.equal("sinceSeq" in subscribe, false, "recovery subscribe is seq-less (fresh snapshot only)");
	assert.equal(client.getMode(), "protocol", "resyncing is protocol mode");
	// Recovery converges via fresh snapshot.
	completeSnapshot(client, { snapshotSeq: 9, nextSeq: 10 });
	assert.equal(eventsOf(events, "snapshotReady").length, 2);
	client.handleMessage(out(10));
	assert.equal(client.getLastSeq(), 10);
});

test("resnapshot_required in live → resync", () => {
	const { client, sent, events } = harness();
	client.start();
	completeSnapshot(client);
	client.handleMessage(out(6));
	const sentBefore = sent.length;
	client.handleMessage({ type: "resnapshot_required", lastSeq: 5, missing: 7 });
	assert.deepEqual(eventsOf(events, "resubscribing"), [{ reason: "resnapshot_required" }]);
	assert.equal(sent[sentBefore].type, "subscribe_terminal");
});

test("interrupted snapshot (begin+frame, resnapshot_required instead of end) → partial discarded → resync", () => {
	const { client, sent, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5 }));
	client.handleMessage(frame("PARTIAL"));
	client.handleMessage({ type: "resnapshot_required", lastSeq: 5, missing: 6 });
	assert.equal(eventsOf(events, "snapshotReady").length, 0, "partial frame never painted");
	assert.deepEqual(eventsOf(events, "resubscribing"), [{ reason: "resnapshot_required" }]);
	// Fresh cycle completes cleanly (stash from the aborted attempt is gone).
	completeSnapshot(client, { snapshotSeq: 5, nextSeq: 6 });
	const ready = eventsOf(events, "snapshotReady");
	assert.equal(ready.length, 1);
	// The stashed PARTIAL frame must not leak into the recovery snapshot.
	assert.equal(ready[0].frame, frame().data);
});

test("empty baseline: snapshotReady({empty}) + first live seq is 1", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 0, empty: true }));
	client.handleMessage(end(1));
	assert.deepEqual(eventsOf(events, "snapshotReady"), [
		{ frame: undefined, empty: true, resnapshot: undefined, nextSeq: 1 },
	]);
	assert.equal(client.handleMessage(out(1)), true);
	assert.deepEqual(eventsOf(events, "output"), ["chunk1"]);
	assert.equal(client.getLastSeq(), 1);
});

test("reconnect with retained ring → seamless replay (no snapshotReady, no reset)", () => {
	const { client, sent, events } = harness();
	client.start();
	completeSnapshot(client, { snapshotSeq: 5, nextSeq: 6 });
	client.handleMessage(out(6));
	client.handleMessage(out(7)); // lastSeq 7
	const sentBefore = sent.length;
	client.reconnect(7);
	assert.deepEqual(sent[sentBefore], SUB_SEQ(7));
	assert.equal(client.handleMessage(out(8)), true);
	assert.deepEqual(eventsOf(events, "output").slice(-1), ["chunk8"]);
	assert.equal(eventsOf(events, "snapshotReady").length, 1, "replay only — no re-hydrate");
	assert.equal(client.getLastSeq(), 8);
});

test("reconnect with evicted cursor → fresh snapshot flagged resnapshot (UI resets)", () => {
	const { client, sent, events } = harness();
	client.start();
	completeSnapshot(client, { snapshotSeq: 5, nextSeq: 6 });
	client.handleMessage(out(6));
	client.reconnect(2);
	client.handleMessage(begin({ snapshotSeq: 9, resnapshot: true }));
	client.handleMessage(frame("FRESH"));
	client.handleMessage(end(10));
	assert.deepEqual(eventsOf(events, "snapshotReady"), [
		{ frame: "\x1b[2J\x1b[3JREDRAW", empty: undefined, resnapshot: undefined, nextSeq: 6 }, // initial
		{ frame: "FRESH", empty: undefined, resnapshot: true, nextSeq: 10 },
	]);
});

test("reconnect against restarted runner → empty resnapshot baseline (new child, no old screen)", () => {
	const { client, events } = harness();
	client.start();
	completeSnapshot(client, { snapshotSeq: 5, nextSeq: 6 });
	client.handleMessage(out(6));
	client.reconnect(6);
	client.handleMessage(begin({ snapshotSeq: 0, empty: true, resnapshot: true }));
	client.handleMessage(end(1));
	assert.deepEqual(eventsOf(events, "snapshotReady").slice(-1), [
		{ frame: undefined, empty: true, resnapshot: true, nextSeq: 1 },
	]);
	client.handleMessage(out(1));
	assert.deepEqual(eventsOf(events, "output").slice(-1), ["chunk1"]);
});

test("reconnect while still probing re-issues the probe (not a cursor subscribe)", () => {
	const { client, sent } = harness();
	client.start();
	const sentBefore = sent.length;
	client.reconnect(0);
	assert.deepEqual(sent[sentBefore], SUB);
	assert.equal("sinceSeq" in sent[sentBefore], false);
	assert.equal(client.getMode(), "probing");
});

test("duplicate/stale seq silently ignored in live (no emit, no resync)", () => {
	const { client, events } = harness();
	client.start();
	completeSnapshot(client, { snapshotSeq: 5, nextSeq: 6 });
	client.handleMessage(out(6));
	client.handleMessage(out(7));
	const outputsBefore = eventsOf(events, "output").length;
	assert.equal(client.handleMessage(out(7)), true, "duplicate consumed");
	assert.equal(client.handleMessage(out(6)), true, "stale consumed");
	assert.equal(client.handleMessage(out(1)), true);
	assert.equal(eventsOf(events, "output").length, outputsBefore, "nothing re-emitted");
	assert.equal(eventsOf(events, "resubscribing").length, 0);
	assert.equal(client.getLastSeq(), 7);
});

test("output (with seq) between begin and frame = protocol violation → resync (pinned)", () => {
	const { client, sent, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5 }));
	const sentBefore = sent.length;
	assert.equal(client.handleMessage(out(6)), true);
	assert.deepEqual(eventsOf(events, "resubscribing"), [{ reason: "output_before_snapshot_frame" }]);
	assert.equal(eventsOf(events, "snapshotReady").length, 0);
	assert.equal(sent[sentBefore].type, "subscribe_terminal");
});

test("catch-up flush between frame and end: stashed, applied after snapshotReady in order", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5 }));
	client.handleMessage(frame("FRAME"));
	client.handleMessage(out(6));
	client.handleMessage(out(7));
	assert.equal(eventsOf(events, "output").length, 0, "flush not applied before the frame");
	client.handleMessage(end(8));
	const names = events.map((e) => e.event);
	const readyIdx = names.indexOf("snapshotReady");
	assert.deepEqual(names.slice(readyIdx, readyIdx + 3), ["snapshotReady", "output", "output"]);
	assert.deepEqual(eventsOf(events, "output"), ["chunk6", "chunk7"]);
	assert.equal(client.getLastSeq(), 7);
	client.handleMessage(out(8)); // continuity holds
	assert.deepEqual(eventsOf(events, "output").slice(-1), ["chunk8"]);
});

test("flush gap inside snapshot window → resync (pinned)", () => {
	const { client, sent, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5 }));
	client.handleMessage(frame("FRAME"));
	client.handleMessage(out(6));
	const sentBefore = sent.length;
	client.handleMessage(out(8)); // 7 missing inside flush
	assert.deepEqual(eventsOf(events, "resubscribing"), [{ reason: "snapshot_flush_gap" }]);
	assert.equal(sent[sentBefore].type, "subscribe_terminal");
});

test("snapshot_end nextSeq mismatch → resync, frame never painted (pinned)", () => {
	const { client, sent, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5 }));
	client.handleMessage(frame("FRAME"));
	const sentBefore = sent.length;
	client.handleMessage(end(9)); // expected 6 (no flush)
	assert.deepEqual(eventsOf(events, "resubscribing"), [{ reason: "snapshot_end_mismatch" }]);
	assert.equal(eventsOf(events, "snapshotReady").length, 0);
	assert.equal(sent[sentBefore].type, "subscribe_terminal");
});

test("unsolicited snapshot_begin in live → resync (pinned)", () => {
	const { client, events } = harness();
	client.start();
	completeSnapshot(client);
	client.handleMessage(out(6));
	client.handleMessage(begin({ snapshotSeq: 9 }));
	assert.deepEqual(eventsOf(events, "resubscribing"), [{ reason: "unexpected_snapshot_begin" }]);
});

test("persistent structural inconsistency is bounded: 4th failure → legacy, no infinite loop (F2)", () => {
	const { client, sent, events } = harness();
	client.start();
	completeSnapshot(client); // live
	const sentBefore = sent.length;
	// Three structural failures still recover (each resyncs)…
	client.handleMessage(begin({ snapshotSeq: 20 })); // unexpected begin in live
	client.handleMessage(frame("F")); // frame while resyncing
	client.handleMessage(end(99)); // end while resyncing
	assert.equal(client.getMode(), "protocol", "3 failures still recovering");
	assert.equal(sent.length - sentBefore, 3, "one recovery subscribe per failure");
	// …the 4th crosses the cap instead of looping forever. A begin alone is
	// NOT a reset point (the counter persists across begins — F2); the next
	// unverified end trips it.
	client.handleMessage(begin({ snapshotSeq: 30 }));
	assert.equal(client.getMode(), "protocol");
	client.handleMessage(end(99)); // snapshot_frame_missing → 4th failure
	assert.deepEqual(eventsOf(events, "mode"), ["protocol", "legacy"]);
	assert.equal(client.getMode(), "legacy");
});

test("snapshot_end without frame (and not empty) → bounded recovery, nothing painted (F3)", () => {
	const { client, sent, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5 }));
	const sentBefore = sent.length;
	client.handleMessage(end(6)); // no snapshot_frame arrived; nextSeq even matches
	assert.deepEqual(eventsOf(events, "resubscribing"), [{ reason: "snapshot_frame_missing" }]);
	assert.equal(eventsOf(events, "snapshotReady").length, 0, "unverified window never painted");
	assert.deepEqual(sent[sentBefore], SUB);
});

test("legacy output (no seq field) in protocol mode: consumed, ignored, never counted (pinned)", () => {
	const { client, events } = harness();
	client.start();
	completeSnapshot(client, { snapshotSeq: 5, nextSeq: 6 });
	client.handleMessage(out(6));
	assert.equal(client.handleMessage({ type: "output", data: "unsequenced-bytes" }), true);
	assert.equal(eventsOf(events, "output").length, 1, "unsequenced bytes never applied");
	// Sequenced stream still contiguous afterwards.
	assert.equal(client.handleMessage(out(7)), true);
	assert.deepEqual(eventsOf(events, "output").slice(-1), ["chunk7"]);
});

test("output during probing is not consumed (UI legacy path owns it)", () => {
	const { client, events } = harness();
	client.start();
	assert.equal(client.handleMessage({ type: "output", data: "pre-decision" }), false);
	assert.equal(eventsOf(events, "output").length, 0);
	// With seq too — still the legacy window before mode decision.
	assert.equal(client.handleMessage(out(1)), false);
});

test("snapshot_failed during probe resends subscribe; probe deadline still governs fallback", () => {
	const { client, sent, events, timers } = harness();
	client.start();
	client.handleMessage(err("snapshot_failed", { message: "capture blew up" }));
	assert.equal(eventsOf(events, "resubscribing").length, 1);
	assert.equal(client.getMode(), "protocol", "resyncing");
	// Runner goes silent afterwards: the probe deadline must still fire.
	timers.fireAll();
	assert.deepEqual(eventsOf(events, "mode"), ["legacy"]);
	assert.equal(client.getMode(), "legacy");
});

test("repeated snapshot failures fall back to legacy after the cap", () => {
	const { client, events } = harness();
	client.start();
	for (let i = 0; i < 3; i++) client.handleMessage(err("snapshot_failed", { message: "x" }));
	assert.equal(eventsOf(events, "mode").length, 0, "3 failures still resyncing");
	client.handleMessage(err("snapshot_failed", { message: "x" })); // 4th crosses the cap
	assert.deepEqual(eventsOf(events, "mode"), ["legacy"]);
});

test("UI-owned messages pass through unconsumed in every protocol state", () => {
	const { client } = harness();
	client.start();
	completeSnapshot(client);
	client.handleMessage(out(6));
	for (const msg of [
		{ type: "hello", status: {} },
		{ type: "status", status: {} },
		{ type: "editor_state", empty: true },
		{ type: "exit", exitCode: 0 },
		{ type: "error", message: "generic status error" },
	]) {
		assert.equal(client.handleMessage(msg), false, `${msg.type} not consumed`);
	}
});

test("close() cancels timers and goes fully inert", () => {
	const { client, sent, events, timers } = harness();
	client.start();
	assert.equal(timers.live().length, 1);
	client.close();
	assert.equal(timers.live().length, 0, "probe timer cancelled");
	assert.equal(client.handleMessage(begin()), false);
	assert.equal(client.getMode(), "closed");
	const sentBefore = sent.length;
	client.reconnect(0);
	client.start();
	assert.equal(sent.length, sentBefore);
});

test("invalid_since_seq and resnapshot_required in probing keep the recovery bounded", () => {
	const { client, sent, events } = harness();
	client.start();
	client.handleMessage(err("invalid_since_seq", { sinceSeq: -1 }));
	assert.equal(eventsOf(events, "resubscribing").length, 1);
	assert.equal(sent[1].type, "subscribe_terminal");
	client.handleMessage({ type: "resnapshot_required", lastSeq: 0, missing: 1 });
	assert.equal(eventsOf(events, "resubscribing").length, 2);
	assert.deepEqual(eventsOf(events, "mode"), []);
});

test("snapshotBegin event carries begin geometry (size-sync hook, CR R1 blocking)", () => {
	const { client, events } = harness();
	client.start();
	client.handleMessage(begin({ snapshotSeq: 5 })); // cols 80, rows 24
	assert.deepEqual(eventsOf(events, "snapshotBegin"), [{ cols: 80, rows: 24 }]);
	// Empty baselines carry geometry too: a child that has not produced output
	// yet must be corrected BEFORE its first bytes land.
	const { client: c2, events: e2 } = harness();
	c2.start();
	c2.handleMessage(begin({ snapshotSeq: 0, empty: true }));
	assert.deepEqual(eventsOf(e2, "snapshotBegin"), [{ cols: 80, rows: 24 }]);
});

test("onDisconnect cancels the probe deadline — a dead window cannot downgrade (CR R1 advisory)", () => {
	const { client, sent, events, timers } = harness();
	client.start();
	assert.equal(timers.live().length, 1, "probe timer armed");
	// Socket drops inside the probe window.
	client.onDisconnect();
	assert.equal(timers.live().length, 0, "probe timer cancelled on disconnect");
	timers.fireAll(); // the old deadline would have fired here
	assert.deepEqual(eventsOf(events, "mode"), [], "no legacy downgrade from the dead window");
	assert.deepEqual(eventsOf(events, "protocolError"), []);
	assert.equal(client.getMode(), "probing", "still undecided — the new socket re-probes");
	// New socket: start() re-arms and a protocol-capable runner answers.
	client.start();
	assert.equal(timers.live().length, 1, "probe re-armed on reconnect");
	assert.equal(sent.filter((m) => m.type === "subscribe_terminal").length, 2, "probe re-sent");
	client.handleMessage(begin());
	client.handleMessage(frame());
	client.handleMessage(end(6));
	assert.deepEqual(eventsOf(events, "mode"), ["protocol"]);
	assert.equal(client.getMode(), "protocol");
});

test("onDisconnect after a decided mode is a no-op (decision stands)", () => {
	const { client, events, timers } = harness();
	client.start();
	client.handleMessage(begin());
	// Probe timer is already cancelled by the begin; disconnect changes nothing.
	client.onDisconnect();
	timers.fireAll();
	assert.deepEqual(eventsOf(events, "mode"), ["protocol"]);
	assert.equal(client.getMode(), "protocol");
});
