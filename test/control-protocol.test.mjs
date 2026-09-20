/**
 * A1 unit matrix for the control-command lifecycle pure layer (issue #91
 * Phase 5, spec D4 + §9). Every row of the spec's per-type semantics table is
 * pinned here; the binding rules (accepted durable-only, applied carries the
 * real value, observed structural-evidence-only, resize never observed,
 * superseded with byCommandId, dedup keys on commandId never seq) get explicit
 * cases so a table edit cannot silently weaken them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CONTROL_COMMAND_TYPES,
	COMMAND_SEMANTICS,
	JOURNAL_KEEP_DEFAULT,
	ACK_STAGES,
	validateCommandEnvelope,
	encodeCommand,
	classifyCommandAck,
	retryPolicy,
	dedupKey,
	createResizeTracker,
	journalAppendRecord,
	journalGc,
	journalUnresolved,
} from "../src/core/control-protocol.mjs";

const ENV = { commandId: "c1", clientId: "ui-1", seq: 1, viewId: "v1", instanceId: "inst-1" };
const envelope = (over = {}) => ({ ...ENV, ...over });

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

test("envelope: message without commandId marker is legacy passthrough, never an error", () => {
	for (const type of ["input", "resize", "hello", "subscribe_terminal", "editor_state"]) {
		const verdict = validateCommandEnvelope({ type, data: "x" });
		assert.deepEqual(verdict, { enveloped: false, errors: [] }, type);
	}
	assert.deepEqual(validateCommandEnvelope({ type: "input", commandId: "" }), { enveloped: false, errors: [] });
	assert.deepEqual(validateCommandEnvelope(null), { enveloped: false, errors: ["msg_not_object"] });
});

test("envelope: complete valid envelope has zero errors", () => {
	const verdict = validateCommandEnvelope({ type: "resize", cols: 80, rows: 24, ...ENV });
	assert.deepEqual(verdict, { enveloped: true, errors: [] });
});

test("envelope: each missing/invalid field is reported individually", () => {
	const base = { type: "terminate", commandId: "c1" };
	assert.deepEqual(validateCommandEnvelope(base).errors.sort(), [
		"clientid_missing",
		"instanceid_missing",
		"seq_invalid",
		"viewid_missing",
	]);
	assert.ok(validateCommandEnvelope({ ...base, clientId: "ui", seq: 0, viewId: "v", instanceId: "i" }).errors.includes("seq_invalid"));
	assert.ok(validateCommandEnvelope({ ...base, clientId: "ui", seq: 2.5, viewId: "v", instanceId: "i" }).errors.includes("seq_invalid"));
	assert.ok(validateCommandEnvelope({ ...base, clientId: "ui", seq: 1, viewId: "", instanceId: "i" }).errors.includes("viewid_missing"));
});

test("envelope: enveloped message with a non-control type is an error (client bug surfaced)", () => {
	const verdict = validateCommandEnvelope({ type: "subscribe_terminal", ...ENV });
	assert.deepEqual(verdict, { enveloped: true, errors: ["type_not_control"] });
});

test("encodeCommand: builds the full envelope and merges payload", () => {
	const cmd = encodeCommand("resize", { cols: 100, rows: 30 }, ENV);
	assert.deepEqual(cmd, { type: "resize", ...ENV, cols: 100, rows: 30 });
});

test("encodeCommand: throws on missing envelope fields, bad seq, or non-control type", () => {
	assert.throws(() => encodeCommand("resize", {}, { ...ENV, commandId: undefined }), /commandId/);
	assert.throws(() => encodeCommand("resize", {}, { ...ENV, seq: 0 }), /seq/);
	assert.throws(() => encodeCommand("subscribe_terminal", {}, ENV), /unknown control type/);
});

// ---------------------------------------------------------------------------
// Ack classification — the spec D4 table row by row
// ---------------------------------------------------------------------------

test("semantics table: input — accepted durable-only; applied ok; never observed; never superseded", () => {
	assert.equal(classifyCommandAck("input", { stage: "accepted", commandId: "c", durable: true }).ok, true);
	assert.equal(classifyCommandAck("input", { stage: "accepted", commandId: "c" }).ok, false, "accepted without durable flag must be rejected");
	assert.equal(classifyCommandAck("input", { stage: "accepted", commandId: "c", durable: false }).reason, "accepted_requires_durable");
	assert.equal(classifyCommandAck("input", { stage: "applied", commandId: "c" }).ok, true);
	assert.equal(classifyCommandAck("input", { stage: "observed", commandId: "c" }).reason, "observed_not_applicable", "no stage may claim the child processed the bytes");
	assert.equal(classifyCommandAck("input", { stage: "superseded", commandId: "c", byCommandId: "d" }).reason, "superseded_not_applicable");
});

test("semantics table: resize — applied carries real dims; NEVER observed; superseded with byCommandId", () => {
	assert.equal(classifyCommandAck("resize", { stage: "accepted", commandId: "c" }).reason, "accepted_not_applicable", "transient controls have no accepted stage");
	const applied = classifyCommandAck("resize", { stage: "applied", commandId: "c", cols: 80, rows: 24 });
	assert.deepEqual(applied, { ok: true, stage: "applied", commandId: "c", value: { cols: 80, rows: 24 } });
	assert.equal(classifyCommandAck("resize", { stage: "applied", commandId: "c" }).reason, "applied_requires_dims");
	assert.equal(classifyCommandAck("resize", { stage: "applied", commandId: "c", cols: "80", rows: 24 }).reason, "applied_requires_dims");
	assert.equal(classifyCommandAck("resize", { stage: "observed", commandId: "c" }).reason, "observed_not_applicable", "calling child.resize() is not a render proof");
	const sup = classifyCommandAck("resize", { stage: "superseded", commandId: "old", byCommandId: "new" });
	assert.deepEqual(sup, { ok: true, stage: "superseded", commandId: "old", byCommandId: "new" });
	assert.equal(classifyCommandAck("resize", { stage: "superseded", commandId: "old" }).reason, "superseded_requires_by");
	assert.equal(classifyCommandAck("resize", { stage: "superseded", commandId: "old", byCommandId: "old" }).reason, "superseded_self");
});

test("semantics table: interrupt — applied only", () => {
	assert.equal(classifyCommandAck("interrupt", { stage: "applied", commandId: "c" }).ok, true);
	assert.equal(classifyCommandAck("interrupt", { stage: "accepted", commandId: "c" }).reason, "accepted_not_applicable");
	assert.equal(classifyCommandAck("interrupt", { stage: "observed", commandId: "c" }).reason, "observed_not_applicable");
});

test("semantics table: terminate — applied = started; observed requires exit confirmation", () => {
	assert.equal(classifyCommandAck("terminate", { stage: "applied", commandId: "c" }).ok, true);
	assert.equal(classifyCommandAck("terminate", { stage: "observed", commandId: "c" }).reason, "observed_requires_exit_confirmation");
	assert.equal(classifyCommandAck("terminate", { stage: "observed", commandId: "c", exitConfirmed: true }).ok, true);
	assert.equal(classifyCommandAck("terminate", { stage: "accepted", commandId: "c" }).reason, "accepted_not_applicable");
});

test("semantics table: detach — applied only; socket write success is not a child state change", () => {
	assert.equal(classifyCommandAck("detach", { stage: "applied", commandId: "c" }).ok, true);
	assert.equal(classifyCommandAck("detach", { stage: "observed", commandId: "c" }).reason, "observed_not_applicable");
});

test("semantics table: reconcile — answers reconcile_result, has no ack stages", () => {
	for (const stage of ACK_STAGES) {
		assert.equal(classifyCommandAck("reconcile", { stage, commandId: "c" }).ok, false, stage);
	}
});

test("classify: unknown type / unknown stage / non-object ack rejected", () => {
	assert.equal(classifyCommandAck("hello", { stage: "applied" }).reason, "unknown_type");
	assert.equal(classifyCommandAck("resize", { stage: "done" }).reason, "unknown_stage");
	assert.equal(classifyCommandAck("resize", null).reason, "ack_not_object");
});

test("semantics table and classifier agree on stage legality for every type", () => {
	for (const type of CONTROL_COMMAND_TYPES) {
		const sem = COMMAND_SEMANTICS[type];
		for (const stage of ACK_STAGES) {
			const ack = { stage, commandId: "c", durable: true, cols: 1, rows: 1, exitConfirmed: true, byCommandId: "other" };
			const expected = sem.stages[stage];
			const verdict = classifyCommandAck(type, ack);
			// For input, `durable: true` makes accepted legal; without it the
			// dedicated test above pins the rejection.
			assert.equal(verdict.ok, expected, `${type}/${stage}: classifier must match the binding table`);
		}
	}
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test("retry: keystroke input never replays (durable flag absent)", () => {
	assert.deepEqual(retryPolicy("input", { disconnected: true }), { action: "never", reason: "keystroke_never_replays" });
	assert.deepEqual(retryPolicy("input", {}), { action: "never", reason: "keystroke_never_replays" });
});

test("retry: durable input — timeout cannot assume failure: reconcile first", () => {
	assert.deepEqual(retryPolicy("input", { durable: true, timedOut: true }), {
		action: "query_then_decide",
		reason: "timeout_cannot_assume_failure",
	});
});

test("retry: durable input — query outcomes decide, accepted_unknown is never auto-replayed (§10)", () => {
	assert.deepEqual(retryPolicy("input", { durable: true, query: "applied" }), { action: "done", reason: "already_applied" });
	assert.deepEqual(retryPolicy("input", { durable: true, query: "accepted_unknown" }), {
		action: "ambiguous",
		reason: "accepted_write_window_lost",
	});
	assert.deepEqual(retryPolicy("input", { durable: true, query: "unknown" }), {
		action: "retry_same_command",
		reason: "dedup_protects",
	});
});

test("retry: resize latest-wins via new command; interrupt never; terminate/detach/reconcile same-command", () => {
	assert.deepEqual(retryPolicy("resize", { timedOut: true }), { action: "new_command", reason: "latest_wins" });
	assert.deepEqual(retryPolicy("interrupt", { disconnected: true }), { action: "never", reason: "transient_lost_interrupt_not_replayed" });
	assert.deepEqual(retryPolicy("terminate", { timedOut: true }), { action: "retry_same_command", reason: "idempotent" });
	assert.deepEqual(retryPolicy("detach", { disconnected: true }), { action: "retry_same_command", reason: "idempotent" });
	assert.deepEqual(retryPolicy("reconcile", { timedOut: true }), { action: "retry_same_command", reason: "readonly_baseline_read" });
});

// ---------------------------------------------------------------------------
// Dedup key rule: commandId ONLY, seq never
// ---------------------------------------------------------------------------

test("dedup key pin: same commandId different seq is the SAME command; different commandId same seq is DISTINCT", () => {
	assert.equal(dedupKey({ commandId: "c1", seq: 1 }), "c1");
	assert.equal(dedupKey({ commandId: "c1", seq: 99 }), "c1", "seq must never participate in dedup");
	assert.notEqual(dedupKey({ commandId: "c1", seq: 1 }), dedupKey({ commandId: "c2", seq: 1 }));
	assert.equal(dedupKey({ type: "input", data: "x" }), null, "legacy envelope-less messages are not deduped");
});

// ---------------------------------------------------------------------------
// Resize tracker (latest-wins mirror)
// ---------------------------------------------------------------------------

test("resize tracker: newer size supersedes the client's un-applied pending resize with byCommandId", () => {
	const t = createResizeTracker();
	const first = t.track({ commandId: "r1", clientId: "ui-1", cols: 80, rows: 24 });
	assert.deepEqual(first, { superseded: [], duplicate: false });
	const second = t.track({ commandId: "r2", clientId: "ui-1", cols: 100, rows: 30 });
	assert.deepEqual(second.superseded, [{ commandId: "r1", byCommandId: "r2" }]);
});

test("resize tracker: supersede chain A→B→C and no cross-client supersession", () => {
	const t = createResizeTracker();
	t.track({ commandId: "a", clientId: "ui-1", cols: 80, rows: 24 });
	t.track({ commandId: "b", clientId: "ui-1", cols: 90, rows: 28 });
	const third = t.track({ commandId: "c", clientId: "ui-1", cols: 120, rows: 40 });
	assert.deepEqual(third.superseded, [{ commandId: "b", byCommandId: "c" }], "only the newest pending dies");
	const other = t.track({ commandId: "d", clientId: "ui-2", cols: 70, rows: 20 });
	assert.deepEqual(other.superseded, [], "a different client's pending resize is not mine to supersede");
});

test("resize tracker: re-tracking the same commandId (send retry) is a duplicate, supersedes nothing", () => {
	const t = createResizeTracker();
	t.track({ commandId: "r1", clientId: "ui-1", cols: 80, rows: 24 });
	const again = t.track({ commandId: "r1", clientId: "ui-1", cols: 80, rows: 24 });
	assert.deepEqual(again, { superseded: [], duplicate: true });
});

test("resize tracker: applied caches dims; same commandId re-request returns the cached result", () => {
	const t = createResizeTracker();
	t.track({ commandId: "r1", clientId: "ui-1", cols: 80, rows: 24 });
	t.applied("r1", 80, 24);
	assert.deepEqual(t.resultFor("r1"), { cols: 80, rows: 24 });
	assert.equal(t.resultFor("nope"), undefined);
});

test("resize tracker: applied clears the pending slot so the next resize starts clean", () => {
	const t = createResizeTracker();
	t.track({ commandId: "r1", clientId: "ui-1", cols: 80, rows: 24 });
	t.applied("r1", 80, 24);
	const next = t.track({ commandId: "r2", clientId: "ui-1", cols: 100, rows: 30 });
	assert.deepEqual(next.superseded, [], "an applied resize is no longer pending, nothing to supersede");
});

// ---------------------------------------------------------------------------
// Durable command journal: shapes, whole-lifecycle GC, unresolved derivation
// ---------------------------------------------------------------------------

const acc = (id, at, command = "prompt\r") => ({ kind: "accepted", commandId: id, command, acceptedAt: at });
const app = (id, at) => ({ kind: "applied", commandId: id, appliedAt: at });

test("journal append: valid accepted/applied records; malformed records throw (runner bug, not input)", () => {
	let records = journalAppendRecord([], acc("c1", 100));
	records = journalAppendRecord(records, app("c1", 110));
	assert.equal(records.length, 2);
	assert.throws(() => journalAppendRecord([], { kind: "seen", commandId: "x" }), /kind/);
	assert.throws(() => journalAppendRecord([], { kind: "accepted", commandId: "", acceptedAt: 1, command: "x" }), /commandId/);
	assert.throws(() => journalAppendRecord([], { kind: "accepted", commandId: "x", acceptedAt: "now", command: "x" }), /acceptedAt/);
	assert.throws(() => journalAppendRecord([], { kind: "accepted", commandId: "x", acceptedAt: 1 }), /command/);
	assert.throws(() => journalAppendRecord([], { kind: "applied", commandId: "x" }), /appliedAt/);
});

test("journal unresolved: accepted-without-applied in accept order — the §10 accepted_unknown set", () => {
	const records = [acc("c1", 1), app("c1", 2), acc("c2", 3), acc("c3", 4), app("c2", 5)];
	assert.deepEqual(journalUnresolved(records), [{ commandId: "c3", command: "prompt\r", acceptedAt: 4 }]);
});

test("journal unresolved: duplicate accepts of one commandId collapse to a single entry (commandId-keyed, not seq-keyed)", () => {
	// Same command re-sent on a new connection gets a NEW seq but the SAME
	// commandId; the dedup rule says this is one command.
	const records = [{ ...acc("c1", 1), seq: 1 }, { ...acc("c1", 2), seq: 2 }];
	assert.equal(journalUnresolved(records).length, 1);
});

test("journal GC: keeps the newest N distinct commandIds as WHOLE lifecycles", () => {
	const records = [acc("c1", 1), app("c1", 2), acc("c2", 3), app("c2", 4), acc("c3", 5), app("c3", 6)];
	const kept = journalGc(records, 2);
	assert.deepEqual(
		kept.map((r) => `${r.commandId}:${r.kind}`),
		["c2:accepted", "c2:applied", "c3:accepted", "c3:applied"],
		"oldest lifecycle dropped whole; a dropped applied can never leave its accepted behind",
	);
});

test("journal GC: default keep bound is 256 (exported constant)", () => {
	assert.equal(JOURNAL_KEEP_DEFAULT, 256);
	const records = [];
	for (let i = 1; i <= 300; i++) records.push(acc(`c${i}`, i), app(`c${i}`, i + 0.5));
	const kept = journalGc(records);
	const ids = new Set(kept.map((r) => r.commandId));
	assert.equal(ids.size, 256);
	assert.ok(!ids.has("c1"));
	assert.ok(ids.has("c300"));
	assert.equal(kept.length, 512);
});

test("journal GC on a restart-shaped journal: unresolved set derives from the KEPT records only", () => {
	const records = [acc("c1", 1), app("c1", 2), acc("c2", 3)];
	const kept = journalGc(records, 1);
	assert.deepEqual(journalUnresolved(kept), [{ commandId: "c2", command: "prompt\r", acceptedAt: 3 }]);
});
