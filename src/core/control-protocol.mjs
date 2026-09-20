/**
 * Pure decision layer for the control-command lifecycle (issue #91 Phase 5, spec D4).
 *
 * Single source of truth for the command envelope shape, per-type ack-stage
 * legality, retry/dedup rules, the resize latest-wins tracker, and the durable
 * command journal's record shapes/GC/unresolved derivation. The runner shell
 * (runner/pty-runner.mjs) owns all side effects — sockets, files, child writes,
 * process lifecycle — and calls into this module for every decision; the UI
 * client and the service's durable follow-up path consume the same table so
 * both ends agree on semantics by construction.
 *
 * No fs, no net, no timers, no Date.now(): every timestamp is an explicit
 * argument, so decisions are deterministic and exhaustively unit-testable
 * (same pattern as state-commands.mjs from Phase 2).
 *
 * ## Envelope
 *
 * Reliable commands (`input` durable follow-up, `terminate`, `reconcile`) and
 * transient controls (`resize`, keystroke `input`, `interrupt`, `detach`) all
 * carry `{commandId, clientId, seq, viewId, instanceId}`. `seq` is a
 * connection-scoped ordering aid ONLY — dedup and retry decisions key on the
 * stable `commandId`, never on `seq` (spec D4, binding). A message without a
 * `commandId` marker is a legacy message: `validateCommandEnvelope` reports it
 * as passthrough, never as an error, so pre-phase-5 UIs keep working verbatim.
 *
 * ## Ack stages
 *
 * - `accepted` — durable commands only: the command is recorded in the durable
 *   command journal. Never emitted for transient controls.
 * - `applied` — the underlying action ran; carries the ACTUAL applied value
 *   (resize: real PTY cols/rows post-clamp).
 * - `observed` — structured observation evidence only. For terminate on the
 *   owned main the evidence is `runnerFinalizing: true` (the finishHost ladder
 *   destroys client sockets before the child exits, so a post-exit
 *   `exitConfirmed` ack would be undeliverable there); the legacy main sends
 *   `exitConfirmed` after the child exit is confirmed. Either field is
 *   terminal evidence for terminate. `resize` is NEVER observed (calling
 *   child.resize() does not mean the child finished rendering); `input` is
 *   never observed either (no stage may claim the child processed the bytes);
 *   `detach` has no observed
 *   stage (socket write success is not a child state change).
 * - `superseded` — resize latest-wins terminal state, carries `byCommandId`.
 */

/** Control command types governed by this lifecycle (spec D4 table). */
export const CONTROL_COMMAND_TYPES = Object.freeze([
	"input",
	"resize",
	"interrupt",
	"terminate",
	"detach",
	"reconcile",
]);

/** Ack stages (spec D4). `superseded` is a terminal state, not a delivery stage. */
export const ACK_STAGES = Object.freeze(["accepted", "applied", "observed", "superseded"]);

/**
 * Error taxonomy for `{type:"error", code, commandId?}` replies to enveloped
 * control commands (spec D4; ruling 2 enumeration). Every code is terminal for
 * the correlating client EXCEPT `host_starting` (bounded retry with fresh
 * commandIds is the runner's documented starting-window contract). Clients
 * must consume a taxonomy error carrying a commandId: clear the pending
 * correlation and surface `cmdAck {stage:"error", code}` — a swallowed error
 * leaves the command pending forever.
 *
 * - `envelope_invalid` — the envelope failed validation (missing/ill-typed
 *   fields, listed in `errors`). The command had NO effect. Retrying the same
 *   bytes is futile; this is a caller bug.
 * - `instance_mismatch` — the command's instanceId is a foreign fence. The
 *   command had NO effect on this runner. `currentInstanceId` is the recovery
 *   signal (re-reconcile against it).
 * - `host_starting` — the child is not ready (starting window). The command
 *   had NO effect. Retry with a FRESH commandId is the documented contract
 *   (the same commandId is not journaled, so reuse would also be safe, but
 *   fresh ids keep ack correlation unambiguous).
 * - `journal_unavailable` — a durable accept was REFUSED because the command
 *   journal could not be written. Nothing was journaled, nothing applied;
 *   the accepted stage would have been a lie. Retry is safe (fresh accept).
 * - `command_failed` — the runner-side action failed after (or without) an
 *   accept. Reconcile by commandId BEFORE retrying: if the command was
 *   journaled, a blind re-send returns only the cached stage and never
 *   re-applies — the honest resolution is reconcile-then-decide.
 *
 * Not listed here: an out-of-order `seq` is dropped REPLY-LESS (diagnostic
 * only, `checkSeq` contract) — it is an ordering aid, never a command
 * rejection, and carries no commandId to correlate.
 */
export const CONTROL_ERROR_CODES = Object.freeze({
	envelope_invalid: "envelope failed validation; command had no effect; caller bug",
	instance_mismatch: "foreign instance fence; command had no effect; currentInstanceId is the recovery signal",
	host_starting: "child not ready; command had no effect; bounded retry with fresh commandIds",
	journal_unavailable: "durable accept refused (journal write failed); nothing journaled or applied; retry safe",
	command_failed: "runner-side action failed; reconcile by commandId before retry",
});

/** Error codes after which a client-side retry chain must NOT continue. */
export const TERMINAL_ERROR_CODES = Object.freeze([
	"envelope_invalid",
	"instance_mismatch",
	"journal_unavailable",
	"command_failed",
]);

/**
 * Per-type delivery semantics — BINDING for runner (Task 2), UI client (Task 3)
 * and service follow-up (Task 4). Stage legality is what classifyCommandAck
 * enforces; `retry` names the rule retryPolicy implements.
 */
export const COMMAND_SEMANTICS = Object.freeze({
	input: Object.freeze({
		durable: "conditional", // requestId/commandId-tagged = durable follow-up; bare = keystroke
		stages: Object.freeze({ accepted: true, applied: true, observed: false, superseded: false }),
		appliedValue: null, // child.write ran; no stage may claim the child processed the bytes
		retry: "conditional", // keystroke: never replays; durable: reconcile-query-first, then dedup-protected
	}),
	resize: Object.freeze({
		durable: "no",
		stages: Object.freeze({ accepted: false, applied: true, observed: false, superseded: true }),
		appliedValue: "pty_dims", // real PTY cols/rows post-clamp; never a render claim
		retry: "latest_wins", // same commandId → cached result; new size → new commandId
	}),
	interrupt: Object.freeze({
		durable: "no",
		stages: Object.freeze({ accepted: false, applied: true, observed: false, superseded: false }),
		appliedValue: null,
		retry: "transient", // never after disconnect; a lost ESC is not worth a replay risk
	}),
	terminate: Object.freeze({
		durable: "no",
		stages: Object.freeze({ accepted: false, applied: true, observed: true, superseded: false }),
		appliedValue: "termination_started",
		retry: "idempotent", // repeats return current lifecycle state
	}),
	detach: Object.freeze({
		durable: "no",
		stages: Object.freeze({ accepted: false, applied: true, observed: false, superseded: false }),
		appliedValue: "detach_accepted",
		retry: "idempotent",
	}),
	reconcile: Object.freeze({
		durable: "no",
		stages: Object.freeze({ accepted: false, applied: false, observed: false, superseded: false }),
		appliedValue: null, // reconcile answers with reconcile_result, not cmd_ack stages
		retry: "readonly", // idempotent baseline read; retrying it is safe
	}),
});

/**
 * Classify a message's envelope status. The passthrough rule is absolute: a
 * message WITHOUT a non-empty `commandId` is legacy — reported as
 * `{enveloped: false}` with NO errors, never validated further, never errored,
 * so pre-phase-5 clients are untouched regardless of what other fields they
 * carry. Only a message that DOES carry a `commandId` is held to the full
 * envelope contract; any gap there is a client bug worth surfacing.
 */
export function validateCommandEnvelope(msg) {
	if (!msg || typeof msg !== "object") return { enveloped: false, errors: ["msg_not_object"] };
	if (typeof msg.commandId !== "string" || msg.commandId.length === 0) {
		return { enveloped: false, errors: [] };
	}
	const errors = [];
	if (!Number.isInteger(msg.seq) || msg.seq < 1) errors.push("seq_invalid");
	if (typeof msg.clientId !== "string" || msg.clientId.length === 0) errors.push("clientid_missing");
	if (typeof msg.viewId !== "string" || msg.viewId.length === 0) errors.push("viewid_missing");
	if (typeof msg.instanceId !== "string" || msg.instanceId.length === 0) errors.push("instanceid_missing");
	if (!CONTROL_COMMAND_TYPES.includes(msg.type)) errors.push("type_not_control");
	return { enveloped: true, errors };
}

/**
 * Build an enveloped control command. Throws on missing envelope fields, a
 * non-control type, or payload keys colliding with envelope fields (`type`,
 * `commandId`, `clientId`, `seq`, `viewId`, `instanceId`): all are programmer
 * errors at the call site, not runtime input handling — a collision would
 * silently corrupt the envelope, so it fails loud instead.
 */
const ENVELOPE_OWNED_KEYS = Object.freeze([
	"type",
	"commandId",
	"clientId",
	"seq",
	"viewId",
	"instanceId",
]);

export function encodeCommand(type, payload, envelope) {
	if (!CONTROL_COMMAND_TYPES.includes(type)) {
		throw new TypeError(`encodeCommand: unknown control type ${JSON.stringify(type)}`);
	}
	for (const field of ["commandId", "clientId", "viewId", "instanceId"]) {
		if (typeof envelope?.[field] !== "string" || envelope[field].length === 0) {
			throw new TypeError(`encodeCommand: ${field} must be a non-empty string`);
		}
	}
	if (!Number.isInteger(envelope?.seq) || envelope.seq < 1) {
		throw new TypeError("encodeCommand: seq must be an integer >= 1");
	}
	if (payload != null) {
		const collisions = Object.keys(payload).filter((key) => ENVELOPE_OWNED_KEYS.includes(key));
		if (collisions.length > 0) {
			throw new TypeError(`encodeCommand: payload collides with envelope-owned keys: ${collisions.join(", ")}`);
		}
	}
	return Object.freeze({
		type,
		commandId: envelope.commandId,
		clientId: envelope.clientId,
		seq: envelope.seq,
		viewId: envelope.viewId,
		instanceId: envelope.instanceId,
		...(payload ?? {}),
	});
}

/**
 * Validate/classify an ack record against the command type's stage semantics.
 * Returns `{ok: true, stage, ...}` or `{ok: false, reason}` — the runner emits
 * only classified acks; the client classifies before trusting one.
 */
export function classifyCommandAck(type, ack) {
	const sem = COMMAND_SEMANTICS[type];
	if (!sem) return { ok: false, reason: "unknown_type" };
	if (!ack || typeof ack !== "object") return { ok: false, reason: "ack_not_object" };
	const commandId = typeof ack.commandId === "string" && ack.commandId ? ack.commandId : null;
	switch (ack.stage) {
		case "accepted": {
			if (!sem.stages.accepted) return { ok: false, reason: "accepted_not_applicable" };
			// `accepted` exists only for durable delivery: it means "recorded in
			// the durable journal". A bare keystroke input must never produce it.
			if (type === "input" && ack.durable !== true) {
				return { ok: false, reason: "accepted_requires_durable" };
			}
			return { ok: true, stage: "accepted", commandId };
		}
		case "applied": {
			if (!sem.stages.applied) return { ok: false, reason: "applied_not_applicable" };
			if (sem.appliedValue === "pty_dims") {
				if (!Number.isInteger(ack.cols) || !Number.isInteger(ack.rows)) {
					return { ok: false, reason: "applied_requires_dims" };
				}
				return { ok: true, stage: "applied", commandId, value: { cols: ack.cols, rows: ack.rows } };
			}
			return { ok: true, stage: "applied", commandId };
		}
		case "observed": {
			if (!sem.stages.observed) return { ok: false, reason: "observed_not_applicable" };
			// Structured evidence only (spec D4), never a timer or an assumption.
			// Terminate accepts TWO evidence forms: a confirmed child exit, or the
			// runner's own lifecycle-state confirmation — an owned runner finalizes
			// in lockstep with the child and structurally cannot send after the
			// exit lands, so its finalizing state is the best deliverable evidence.
			if (type === "terminate" && ack.exitConfirmed !== true && ack.runnerFinalizing !== true) {
				return { ok: false, reason: "observed_requires_exit_confirmation" };
			}
			return { ok: true, stage: "observed", commandId };
		}
		case "superseded": {
			if (!sem.stages.superseded) return { ok: false, reason: "superseded_not_applicable" };
			if (typeof ack.byCommandId !== "string" || ack.byCommandId.length === 0) {
				return { ok: false, reason: "superseded_requires_by" };
			}
			if (ack.byCommandId === ack.commandId) return { ok: false, reason: "superseded_self" };
			return { ok: true, stage: "superseded", commandId, byCommandId: ack.byCommandId };
		}
		default:
			return { ok: false, reason: "unknown_stage" };
	}
}

/**
 * Retry/dedup decision per command type given the observed history.
 *
 * `history` fields: `{durable?, disconnected?, timedOut?, query?}` where
 * `query` is a reconcile/query outcome for a durable command: `"applied"`
 * (already applied — done), `"accepted_unknown"` (accepted but the applying
 * runner died before `applied` — the spec §10 window; NEVER auto-replay),
 * `"unknown"` (the runner never saw this commandId — retry is safe because
 * commandId dedup protects against double delivery).
 */
export function retryPolicy(type, history = {}) {
	switch (type) {
		case "input": {
			if (history.durable !== true) return { action: "never", reason: "keystroke_never_replays" };
			if (history.query === "applied") return { action: "done", reason: "already_applied" };
			if (history.query === "accepted_unknown") {
				return { action: "ambiguous", reason: "accepted_write_window_lost" };
			}
			if (history.query === "unknown") return { action: "retry_same_command", reason: "dedup_protects" };
			// Timeout or disconnect without a query result: the client cannot
			// assume failure (spec D4) — reconcile first.
			return { action: "query_then_decide", reason: "timeout_cannot_assume_failure" };
		}
		case "resize":
			// The user asked for a size; a retry of the OLD command is pointless —
			// send the current size as a NEW command (latest-wins supersedes).
			return { action: "new_command", reason: "latest_wins" };
		case "interrupt":
			return { action: "never", reason: "transient_lost_interrupt_not_replayed" };
		case "terminate":
		case "detach":
			return { action: "retry_same_command", reason: "idempotent" };
		case "reconcile":
			return { action: "retry_same_command", reason: "readonly_baseline_read" };
		default:
			return { action: "never", reason: "unknown_type" };
	}
}

/**
 * Dedup key for control commands: the stable `commandId`, nothing else.
 * `seq` is connection-scoped ordering and must never participate (spec D4).
 * Returns null for legacy (envelope-less) messages — they are not deduped.
 */
export function dedupKey(msg) {
	return typeof msg?.commandId === "string" && msg.commandId.length > 0 ? msg.commandId : null;
}

/**
 * Client-side resize latest-wins mirror. The runner is authoritative for
 * supersession (receipt order on the socket); this tracker lets the UI know
 * which of its own resizes are dead (superseded) and reuse results when the
 * same commandId is re-requested.
 *
 * - `track({commandId, clientId, cols, rows})` → `{superseded: [{commandId,
 *   byCommandId}], duplicate}` — a NEW size from a client supersedes that
 *   client's still-unapplied pending resize; re-tracking the same commandId
 *   (send retry) is a duplicate, superseding nothing.
 * - `applied(commandId, cols, rows)` → cache the runner's actual applied dims.
 * - `resultFor(commandId)` → cached `{cols, rows}` for same-commandId
 *   re-requests, or undefined.
 */
export function createResizeTracker() {
	/** clientId → the single newest pending command (latest-wins). */
	const pendingByClient = new Map();
	/** every commandId ever tracked (duplicate detection across clients) */
	const knownIds = new Set();
	/** commandId → applied dims */
	const results = new Map();
	return {
		track({ commandId, clientId, cols, rows }) {
			if (typeof commandId !== "string" || commandId.length === 0) {
				throw new TypeError("resizeTracker.track: commandId required");
			}
			if (knownIds.has(commandId)) return { superseded: [], duplicate: true };
			knownIds.add(commandId);
			const superseded = [];
			const prev = pendingByClient.get(clientId);
			if (prev) superseded.push({ commandId: prev.commandId, byCommandId: commandId });
			pendingByClient.set(clientId, { commandId, cols, rows });
			return { superseded, duplicate: false };
		},
		applied(commandId, cols, rows) {
			results.set(commandId, { cols, rows });
			for (const [clientId, pending] of pendingByClient) {
				if (pending.commandId === commandId) pendingByClient.delete(clientId);
			}
			return { ok: true };
		},
		resultFor(commandId) {
			return results.get(commandId);
		},
	};
}

// ---------------------------------------------------------------------------
// Durable command journal (record shapes + GC + unresolved derivation)
//
// The runner appends one JSONL line per lifecycle transition of a durable
// command: `{kind:"accepted", commandId, command, acceptedAt}` on accept and
// `{kind:"applied", commandId, appliedAt}` once `child.write` ran. On restart
// the journal is loaded and `journalUnresolved` derives the spec §10
// "accepted_unknown" set — commands the PREVIOUS runner accepted but whose
// applied outcome is unknown. These are NEVER auto-replayed (spec §10 binding
// rule); the service decides per its own queue semantics via reconcile.
// ---------------------------------------------------------------------------

export const JOURNAL_KEEP_DEFAULT = 256;

/**
 * Per-connection sequence check (runner-side ordering aid, spec D4). `seq` must
 * be an integer strictly greater than the last accepted seq on the connection;
 * gaps are legal (clients may batch), repeats/regressions are not. Ordering
 * ONLY — dedup keys on `commandId` and never on `seq`.
 *
 * @returns {{ok: true} | {ok: false, reason: "seq_invalid" | "seq_not_monotonic"}}
 */
export function checkSeq(lastSeq, seq) {
	if (!Number.isInteger(seq) || seq < 1) return { ok: false, reason: "seq_invalid" };
	if (seq <= lastSeq) return { ok: false, reason: "seq_not_monotonic" };
	return { ok: true };
}

/**
 * Validate and append a journal record (pure: returns a new array). Throws on
 * malformed records — a malformed journal line is a runner bug, not input.
 */
export function journalAppendRecord(records, record) {
	if (!record || typeof record !== "object") throw new TypeError("journal record must be an object");
	if (record.kind !== "accepted" && record.kind !== "applied") {
		throw new TypeError(`journal record kind must be "accepted"|"applied", got ${JSON.stringify(record.kind)}`);
	}
	if (typeof record.commandId !== "string" || record.commandId.length === 0) {
		throw new TypeError("journal record requires a non-empty commandId");
	}
	if (record.kind === "accepted") {
		if (typeof record.acceptedAt !== "number") throw new TypeError("accepted record requires numeric acceptedAt");
		if (typeof record.command !== "string") throw new TypeError("accepted record requires a command string");
	} else if (typeof record.appliedAt !== "number") {
		throw new TypeError("applied record requires numeric appliedAt");
	}
	return [...records, record];
}

/**
 * GC to the newest `keep` distinct commandIds, dropping WHOLE lifecycles.
 * Invariant: every `commandId` in the result keeps ALL of its records or none.
 * Record-count GC cannot give this guarantee — duplicate accepted records may
 * legitimately follow a command's applied record, so which records survive a
 * trim would depend on append order, and a surviving `accepted` beside a
dropped `applied` would resurrect a phantom "accepted_unknown" after restart.
 * Group GC removes that dependence entirely.
 */
export function journalGc(records, keep = JOURNAL_KEEP_DEFAULT) {
	const lastIndexById = new Map();
	records.forEach((record, index) => lastIndexById.set(record.commandId, index));
	const keepIds = new Set(
		[...lastIndexById.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, keep)
			.map(([id]) => id),
	);
	return records.filter((record) => keepIds.has(record.commandId));
}

/**
 * Derive the unresolved set: commands with an `accepted` but no `applied`
 * record, in accept order, deduped by commandId. This is exactly the
 * "accepted_unknown" set reconcile reports after a runner restart.
 */
export function journalUnresolved(records) {
	const applied = new Set(records.filter((r) => r.kind === "applied").map((r) => r.commandId));
	const seen = new Set();
	const out = [];
	for (const record of records) {
		if (record.kind !== "accepted") continue;
		if (applied.has(record.commandId) || seen.has(record.commandId)) continue;
		seen.add(record.commandId);
		out.push({ commandId: record.commandId, command: record.command, acceptedAt: record.acceptedAt });
	}
	return out;
}
