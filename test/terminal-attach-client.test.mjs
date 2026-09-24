import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalAttachClient } from "../src/core/terminal-attach-client.mjs";
import { TERMINAL_FRAME_VERSION } from "../src/core/terminal-attach-protocol.mjs";
import { CONTROL_ERROR_CODES } from "../src/core/control-protocol.mjs";

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

// ---------------------------------------------------------------------------
// Phase 5 (D4): control lifecycle — reconnect order, epoch rule, envelopes
// ---------------------------------------------------------------------------

/** Drive the client to protocol-live WITH observed identity (phase-5 runner). */
function liveClient(opts = {}) {
	const h = harness(opts);
	h.client.start();
	// The runner sends hello on connect (identity + generation), before the
	// subscribe's snapshot answer — observeIdentity runs first on the wire.
	h.client.handleMessage({ type: "hello", status: { instanceId: "inst-1", viewId: "v1" }, generation: "gen-1" });
	h.client.handleMessage(begin({ snapshotSeq: 5, generation: "gen-1" }));
	h.client.handleMessage(frame());
	h.client.handleMessage(end(6));
	h.sent.length = 0;
	h.events.length = 0;
	return h;
}

test("first connect sends ONLY the probe — reconcile is a reconnect gate, not a first-connect step", () => {
	const { client, sent } = harness();
	client.start();
	assert.deepEqual(sent, [SUB]);
	// hello answer (with identity) must not add a reconcile on first connect.
	client.handleMessage({ type: "hello", status: { instanceId: "inst-1", viewId: "v1" }, generation: "gen-1" });
	assert.equal(sent.length, 1, "no reconcile before the subscribe decision on first connect");
	assert.equal(client.getMode(), "probing");
});

test("sendControl envelopes carry commandId/clientId/seq/viewId/instanceId; seq increments; ids unique", () => {
	const { client, sent } = liveClient();
	const r1 = client.sendControl("resize", { cols: 100, rows: 30 });
	const r2 = client.sendControl("detach");
	assert.ok(r1 && r2 && r1.commandId !== r2.commandId, "unique commandIds");
	assert.deepEqual(sent, [
		{
			type: "resize", commandId: r1.commandId, clientId: sent[0].clientId, seq: 1,
			viewId: "v1", instanceId: "inst-1", cols: 100, rows: 30,
		},
		{ type: "detach", commandId: r2.commandId, clientId: sent[0].clientId, seq: 2, viewId: "v1", instanceId: "inst-1" },
	]);
	assert.equal(client.getIdentity().generation, "gen-1");
});

test("legacy-mode host (instanceId null): sendControl returns null, never envelopes; the attach probe still runs", () => {
	const { client, sent, timers } = harness();
	client.start();
	assert.deepEqual(sent, [SUB], "probe sent before any hello");
	client.handleMessage({ type: "hello", status: { viewId: "v1" } }); // no instanceId
	assert.equal(client.sendControl("resize", { cols: 80, rows: 24 }), null, "legacy host: no envelope");
	assert.equal(client.sendControl("detach"), null);
	assert.equal(sent.length, 1, "no control messages were sent");
	assert.equal(timers.live().length, 1, "probe deadline still armed — snapshot attach works on legacy mains");
});

test("keystroke input is never enveloped (fire-and-forget contract, pinned)", () => {
	const { client, sent } = liveClient();
	assert.throws(() => client.sendControl("input", { data: "x" }), /never enveloped/);
	assert.equal(sent.length, 0);
});

test("reconnect order hello → reconcile → subscribe; same generation → sinceSeq replay", () => {
	const { client, sent, events } = liveClient();
	client.reconnect(9);
	assert.equal(client.getMode(), "protocol");
	const rec = sent.find((m) => m.type === "reconcile");
	assert.ok(rec, "reconcile sent on the new socket");
	assert.ok(!sent.some((m) => m.type === "subscribe_terminal"), "no subscribe before the reconcile answer");
	assert.equal(rec.instanceId, "inst-1");
	client.handleMessage({ type: "hello", status: { instanceId: "inst-1", viewId: "v1" }, generation: "gen-1" });
	assert.equal(sent.filter((m) => m.type === "reconcile").length, 1, "fresh hello does not double-reconcile");
	client.handleMessage({ type: "reconcile_result", commandId: rec.commandId, generation: "gen-1", hostRevision: 4, terminalCursor: { lastSeq: 12 }, stateMaterializedRevision: 7, unresolved: [] });
	assert.deepEqual(sent.at(-1), SUB_SEQ(9), "same generation: seamless replay from the applied cursor");
	assert.deepEqual(eventsOf(events, "epochReset"), []);
	assert.ok(eventsOf(events, "reconciled")[0].hostRevision === 4);
});

test("generation CHANGED across reconnect: cursor discarded, seq-less subscribe (fresh snapshot), epochReset emitted", () => {
	const { client, sent, events } = liveClient();
	client.reconnect(9);
	const rec = sent.find((m) => m.type === "reconcile");
	client.handleMessage({ type: "hello", status: { instanceId: "inst-2", viewId: "v1" }, generation: "gen-2" });
	client.handleMessage({ type: "reconcile_result", commandId: rec.commandId, generation: "gen-2", hostRevision: 1, terminalCursor: { lastSeq: 0 }, stateMaterializedRevision: null, unresolved: [] });
	assert.deepEqual(sent.at(-1), SUB, "runner replaced: seq-less subscribe — fresh snapshot, ring replay across generations impossible");
	assert.equal(client.getLastSeq(), 0, "stale cursor discarded");
	const resets = eventsOf(events, "epochReset");
	assert.deepEqual(resets, [{ previous: "gen-1", current: "gen-2" }]);
	// The fresh snapshot flow works from zero: begin+frame+end paints and lives at 1.
	client.handleMessage(begin({ snapshotSeq: 0, resnapshot: true }));
	client.handleMessage(frame("NEW"));
	client.handleMessage(end(1));
	assert.deepEqual(eventsOf(events, "snapshotReady"), [{ frame: "NEW", empty: undefined, resnapshot: true, nextSeq: 1 }]);
});

test("reconcile deadline without an answer (phase-4 runner): reconnect falls back to sinceSeq subscribe", () => {
	const { client, sent, timers } = liveClient();
	client.reconnect(9);
	timers.fireAll(); // reconcile deadline
	assert.deepEqual(sent.at(-1), SUB_SEQ(9), "phase-4 semantics: runner begin flags protect correctness");
	assert.equal(client.getMode(), "protocol");
});

test("instance_mismatch during reconnect reconcile: adopt currentInstanceId and re-reconcile", () => {
	const { client, sent } = liveClient();
	client.reconnect(9);
	client.handleMessage(err("instance_mismatch", { commandId: sent.find((m) => m.type === "reconcile").commandId, currentInstanceId: "inst-9" }));
	const reconciles = sent.filter((m) => m.type === "reconcile");
	assert.equal(reconciles.length, 2);
	assert.equal(reconciles[1].instanceId, "inst-9", "re-reconcile carries the adopted instance fence");
});

test("cmdAck correlation: resize applied carries real dims and clears pending; superseded drops the wait", () => {
	const { client, sent, events } = liveClient();
	const { commandId } = client.sendControl("resize", { cols: 100, rows: 30 });
	client.handleMessage({ type: "cmd_ack", commandId, stage: "applied", cols: 100, rows: 30 });
	assert.deepEqual(eventsOf(events, "cmdAck"), [{ commandId, type: "resize", stage: "applied", cols: 100, rows: 30, byCommandId: undefined, value: undefined, exitConfirmed: undefined, runnerFinalizing: undefined }]);
	// A late duplicate ack for a cleared command is still consumed, never UI-fed.
	assert.equal(client.handleMessage({ type: "cmd_ack", commandId, stage: "applied", cols: 100, rows: 30 }), true);
	assert.equal(eventsOf(events, "cmdAck").length, 2);

	const r2 = client.sendControl("resize", { cols: 120, rows: 40 });
	const r3 = client.sendControl("resize", { cols: 130, rows: 41 });
	client.handleMessage({ type: "cmd_ack", commandId: r2.commandId, stage: "superseded", byCommandId: r3.commandId });
	assert.deepEqual(eventsOf(events, "cmdAck").at(-1).stage, "superseded");
});

test("terminate observed: runnerFinalizing OR exitConfirmed both classify as terminal evidence (ruling 6)", () => {
	const { client, events } = liveClient();
	const a = client.sendControl("terminate");
	client.handleMessage({ type: "cmd_ack", commandId: a.commandId, stage: "observed", runnerFinalizing: true });
	assert.equal(eventsOf(events, "cmdAck").at(-1).stage, "observed");
	const b = client.sendControl("terminate");
	client.handleMessage({ type: "cmd_ack", commandId: b.commandId, stage: "observed", exitConfirmed: true, exitCode: 0 });
	assert.equal(eventsOf(events, "cmdAck").at(-1).stage, "observed");
	// An observed WITHOUT evidence is invalid and never surfaces as terminal.
	const c = client.sendControl("terminate");
	client.handleMessage({ type: "cmd_ack", commandId: c.commandId, stage: "observed" });
	assert.equal(eventsOf(events, "cmdAck").at(-1).stage, "observed", "raw stage surfaces");
	assert.ok(eventsOf(events, "protocolError").some((p) => p.code === "ack_invalid"), "evidence-less observed is flagged");
});

test("host_starting on enveloped resize: bounded client-side retry with fresh commandIds (legacy cachedResize parity)", () => {
	const { client, sent, timers } = liveClient();
	const first = client.sendControl("resize", { cols: 100, rows: 30 });
	client.handleMessage(err("host_starting", { commandId: first.commandId }));
	// attempts 2..5 fire on the fake timer; each host_starting re-arms.
	for (let i = 0; i < 4; i++) {
		timers.fireAll();
		const resend = sent.filter((m) => m.type === "resize").at(-1);
		client.handleMessage(err("host_starting", { commandId: resend.commandId }));
	}
	const resizeCount = sent.filter((m) => m.type === "resize").length;
	assert.equal(resizeCount, 5, "initial + 4 retries (chain capped at MAX)");
	// The cap engaged: the 5th host_starting disarmed the chain, so firing the
	// timers cannot produce a 6th resize.
	timers.fireAll();
	assert.equal(sent.filter((m) => m.type === "resize").length, 5, "bounded: no 6th attempt");
	// An applied resize stops the chain.
	const last = sent.filter((m) => m.type === "resize").at(-1);
	client.handleMessage({ type: "cmd_ack", commandId: last.commandId, stage: "applied", cols: 100, rows: 30 });
	const before = sent.filter((m) => m.type === "resize").length;
	timers.fireAll();
	assert.equal(sent.filter((m) => m.type === "resize").length, before, "chain cancelled on applied");
});

test("snapshot_begin.generation refreshes the identity baseline (ruling 5 pin)", () => {
	const { client } = harness();
	client.start();
	client.handleMessage({ type: "hello", status: { instanceId: "inst-1", viewId: "v1" }, generation: "gen-1" });
	client.handleMessage(begin({ snapshotSeq: 5, generation: "gen-1b" }));
	assert.equal(client.getIdentity().generation, "gen-1b", "begin is a generation source too");
});

test("reconciling consumes stray broadcast output/begin without corrupting the gate", () => {
	const { client, sent, events } = liveClient();
	client.reconnect(9);
	assert.equal(client.handleMessage(out(10, "stray")), true, "broadcast stray consumed");
	assert.equal(client.handleMessage(begin({ snapshotSeq: 99 })), true, "pre-subscribe begin consumed");
	assert.deepEqual(eventsOf(events, "output"), ["stray"], "strays ARE emitted — exactly-once delivery (task-5 review P0 fix)");
	assert.equal(client.getLastSeq(), 5, "applied cursor unchanged while reconciling (the subscribe cursor carries the high-water)");
	const rec = sent.find((m) => m.type === "reconcile");
	client.handleMessage({ type: "hello", status: { instanceId: "inst-1", viewId: "v1" }, generation: "gen-1" });
	client.handleMessage({ type: "reconcile_result", commandId: rec.commandId, generation: "gen-1", hostRevision: 5, terminalCursor: { lastSeq: 12 }, stateMaterializedRevision: null, unresolved: [] });
	// Stray high-water advances the subscribe cursor: the legacy broadcast and
	// the replay stream overlap on the wire, so the cursor must start PAST every
	// stray already delivered (no dup for OBSERVED strays; in-flight strays are
	// re-sent by the replay and deduped — UI-level exactly-once, #140).
	assert.deepEqual(sent.at(-1), SUB_SEQ(10), "subscribe cursor clears the stray high-water (no wire duplicate)");
});

test("epoch reset zeroes the stray high-water — generation change always takes a seq-less subscribe", () => {
	const { client, sent, events } = liveClient();
	client.reconnect(9);
	assert.equal(client.handleMessage(out(12, "new-gen stray")), true, "gate stray consumed+emitted");
	const rec = sent.find((m) => m.type === "reconcile");
	client.handleMessage({ type: "hello", status: { instanceId: "inst-1", viewId: "v1" }, generation: "gen-2" });
	// generation differs from the at-disconnect baseline (liveClient's gen-1)
	client.handleMessage({ type: "reconcile_result", commandId: rec.commandId, generation: "gen-2", hostRevision: 5, terminalCursor: { lastSeq: 12 }, stateMaterializedRevision: null, unresolved: [] });
	assert.ok(eventsOf(events, "epochReset").length === 1, "epoch reset fired");
	const sub = [...sent].reverse().find((m) => m.type === "subscribe_terminal");
	assert.equal(sub.sinceSeq, undefined, "fresh snapshot after an epoch change even with gate strays — never a tail replay onto the stale buffer");
});

test("taxonomy errors correlated by commandId consume the pending entry and surface cmdAck error (task 4, review P2)", () => {
	for (const code of ["command_failed", "journal_unavailable", "envelope_invalid", "instance_mismatch"]) {
		const { client, events } = liveClient();
		const resize = client.sendControl("resize", { cols: 100, rows: 30 });
		const handled = client.handleMessage(err(code, { commandId: resize.commandId, currentInstanceId: "inst-9" }));
		assert.equal(handled, true, `${code} is consumed`);
		const ack = eventsOf(events, "cmdAck").at(-1);
		assert.equal(ack.stage, "error", `${code} surfaces as cmdAck stage error`);
		assert.equal(ack.code, code);
		assert.equal(ack.type, "resize");
		if (code === "instance_mismatch") assert.equal(ack.currentInstanceId, "inst-9", "recovery signal carried");
		// Terminal code: the pending entry is gone — a late duplicate error for
		// the same commandId is consumed as a stale reply without a second ack.
		assert.equal(client.handleMessage(err(code, { commandId: resize.commandId })), true);
	}
});

test("terminal taxonomy codes cancel the resize starting-window retry chain", () => {
	const { client, sent, timers } = liveClient();
	const first = client.sendControl("resize", { cols: 100, rows: 30 });
	client.handleMessage(err("command_failed", { commandId: first.commandId }));
	timers.fireAll();
	assert.equal(sent.filter((m) => m.type === "resize").length, 1, "terminal error cancels the retry chain");
	// Contrast: host_starting keeps the chain armed (covered in detail above).
});

test("taxonomy error for an unknown commandId is consumed without a fabricated ack type", () => {
	const { client, events } = liveClient();
	assert.equal(client.handleMessage(err("command_failed", { commandId: "never-sent" })), true);
	const ack = eventsOf(events, "cmdAck").at(-1);
	assert.equal(ack.stage, "error");
	assert.equal(ack.type, undefined, "no pending correlation — type is honestly undefined");
});

test("CONTROL_ERROR_CODES enumeration is complete (ruling 2)", () => {
	for (const code of ["envelope_invalid", "instance_mismatch", "host_starting", "journal_unavailable", "command_failed"]) {
		assert.ok(CONTROL_ERROR_CODES[code], `${code} documented`);
	}
});

test("pendingCommands are cleared on disconnect and close (CR R1 advisory 2 — no cross-socket correlation leak)", () => {
	const { client, events } = liveClient();
	const resize = client.sendControl("resize", { cols: 100, rows: 30 });
	assert.ok(resize?.commandId, "pending entry created");
	client.onDisconnect();
	// A late ack for the dead socket's commandId arrives UNCORRELATED: the
	// pending entry is gone, so the surfaced cmdAck carries no type and no
	// resize retry-cancel side effect can fire for a dead correlation.
	client.handleMessage({ type: "cmd_ack", commandId: resize.commandId, stage: "applied" });
	const late = eventsOf(events, "cmdAck").at(-1);
	assert.equal(late.type, undefined, "late ack after disconnect is uncorrelated (pending cleared)");
	// A FRESH commandId on the new connection works normally.
	const next = client.sendControl("resize", { cols: 101, rows: 31 });
	assert.ok(next?.commandId && next.commandId !== resize.commandId);
	const errEvents = eventsOf(events, "cmdAck").length;
	client.handleMessage(err("command_failed", { commandId: next.commandId }));
	assert.equal(eventsOf(events, "cmdAck").length, errEvents + 1, "new connection correlation unaffected");
	// close() clears too.
	const { client: c2, events: ev2 } = liveClient();
	const r2 = c2.sendControl("resize", { cols: 80, rows: 24 });
	c2.close();
	c2.handleMessage({ type: "cmd_ack", commandId: r2.commandId, stage: "applied" });
	assert.equal(eventsOf(ev2, "cmdAck").length, 0, "close() clears pending entries (state closed — no surface at all)");
});
