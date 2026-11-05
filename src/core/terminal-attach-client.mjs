/**
 * Client-side terminal attach protocol state machine (issue #91 Phase 4, D2).
 *
 * Pure logic: no sockets, no fs, no timers. `send` (client→runner messages)
 * and `emit` (UI-facing events) are injected; the probe timeout goes through
 * an injected `scheduleTimeout(delayMs, fn) → cancelFn` so tests drive time
 * deterministically. The runner-side counterpart is
 * `src/core/terminal-attach-protocol.mjs` — message shapes and boundary
 * semantics there are authoritative.
 *
 * ## States
 *
 * - `probing` — `subscribe_terminal` sent, awaiting `snapshot_begin`.
 *   - `snapshot_begin` → `collecting` (mode decision: protocol)
 *   - probe timeout → `legacy` (old runner silently ignores the probe)
 *   - `error frame_version_mismatch` → `legacy`
 *   - `error snapshot_failed` / `error invalid_since_seq` → resend fresh
 *     subscribe (same probe window); up to 3 recovery attempts, then
 *     `legacy` fallback
 * - `collecting` — `snapshot_begin` seen; waiting for `snapshot_end`.
 *   - `snapshot_frame` → frame stashed
 *   - `output` WITH seq between frame and end = runner catch-up flush
 *     (tested runner contract): stashed, applied after the frame, never
 *     counted before `snapshotReady`
 *   - `output` WITH seq before any frame = protocol violation → resync
 *   - `snapshot_end` → verify frame present (or empty baseline) and
 *     `nextSeq === stashed tail + 1` (or `begin.snapshotSeq + 1` with no
 *     flush), then emit `snapshotReady` followed by the stashed flush in
 *     order → `live`
 *   - `resnapshot_required` / `snapshot_failed` (interrupted snapshot) →
 *     discard the partial snapshot → resync
 * - `live` — seq-checked consumption against `lastSeq`.
 *   - `seq === lastSeq + 1` → emit `output`, advance
 *   - `seq <= lastSeq` → duplicate/stale, silently ignored
 *   - `seq > lastSeq + 1` → gap → resync (fresh snapshot, never stitched)
 *   - `resnapshot_required` → resync; unsolicited `snapshot_begin` → resync
 * - `resyncing` — a fresh `subscribe_terminal` (no `sinceSeq`: the runner
 *   answers a seq-less request with a fresh snapshot, always; the replay
 *   continuation below is defensive for cursor reconnects only) is in flight.
 *   - `snapshot_begin` → `collecting`
 *   - `output` with `seq === lastSeq + 1` (complete replay) → `live`,
 *     seamless (no `snapshotReady`, UI keeps its buffer)
 *   - stray outputs / duplicate markers → ignored
 *   - `snapshot_failed` / `resnapshot_required` → resend; up to 3 recovery
 *     attempts, then `legacy` fallback
 * - `reconciling` — (phase 5, D4) reconnect gate: `reconcile` sent on the new
 *   socket, awaiting `reconcile_result` (or the reconcile deadline). Spec D4
 *   binds the reconnect order hello → reconcile → snapshot/subscribe. All
 *   runner messages in this state are consumed; outputs are ALSO EMITTED —
 *   they are legacy-broadcast strays that must reach the UI exactly once
 *   (OBSERVED strays cover (cursor, strayHighWater]; the replay starts past
 *   the high-water; in-flight strays are re-sent by the replay and deduped —
 *   see the reconciling output branch). Resolution:
 *   - `reconcile_result` → epoch rule: generation CHANGED since last seen ⇒
 *     discard the cursor (`lastSeq = 0`, `epochReset` event) ⇒ seq-less
 *     subscribe (fresh snapshot — ring replay across runner generations is
 *     structurally impossible); same generation ⇒ subscribe with `sinceSeq`
 *     (seamless replay)
 *   - deadline without an answer (phase-4 runner) ⇒ phase-4 semantics:
 *     subscribe with `sinceSeq` (the runner's resnapshot/empty begin flags
 *     protect correctness)
 *   - `error instance_mismatch` ⇒ adopt `currentInstanceId`, re-reconcile
 * - `legacy` — mode decided against this runner: inert, every message
 *   returns false so the UI legacy path (screen.log replay + live output +
 *   jiggle) owns everything.
 * - `closed` — inert; timers cancelled.
 *
 * `reconnect(lastSeq)` (new socket after a drop, protocol already achieved):
 * subscribe with `sinceSeq: lastSeq`. Ring retained → replay → seamless
 * `live`; evicted / ahead-of-runner / restarted-runner → fresh snapshot
 * (`begin.resnapshot` and/or `begin.empty` set → UI resets its buffer).
 * While still `probing`, `reconnect()` re-issues the probe instead.
 *
 * ## Events (emit)
 *
 * - `mode` — `"protocol"` (first `snapshot_begin`) or `"legacy"` (fallback
 *   decided — including a downgrade after a protocol session, which the UI
 *   must observe to switch paths); each direction fires exactly once.
 * - `snapshotBegin` — `{ cols, rows }` from every `snapshot_begin` (fresh,
 *   reconnect, and empty baselines alike). The UI compares against its own
 *   terminal size and resizes the child when they differ: legacy attach
 *   resized at every connect (jiggle start), the protocol probe carries no
 *   size, so without this sync a full-screen TUI child would keep its
 *   host-creation geometry (CR R1 blocking). Matched sizes send nothing.
 * - `snapshotReady` — `{ frame?, empty?, resnapshot?, nextSeq, scrollbackLines? }`
 *   after continuity is verified at `snapshot_end`. `scrollbackLines` is the
 *   runner's scrollback line count for the frame just delivered; the key is
 *   omitted (never `undefined`) when the runner did not send one. UI:
 *   `term.reset()` + `write(frame)` (the frame is self-contained on dirty
 *   terminals), or loading baseline for `empty`. Empty baselines carry no frame.
 * - `output` — live/replay chunk data (protocol-managed only), including gate
 *   strays emitted during `reconciling`.
 * - `viewProofRecord` — sanitized S/F/A view-proof record from live/catch-up/replay,
 *   in receive order. It is an independent fact, never readiness.
 * - `viewProof` — sanitized current coverage from `view_proof_state` (replay end or
 *   reporter reset). Optional `snapshotReady.viewProof` is the snapshot_end coverage
 *   with begin/state fallback; both are independent of transport validation.
 * - `resubscribing` — the client sent a recovery subscribe itself. The plan
 *   contract originally made resubscribe UI-actionable; it is internal now
 *   (send is injected and socket-scoped) so the UI wiring stays minimal —
 *   the event is informational.
 * - `protocolError` — `{ code, message }` for runner-side protocol failures
 *   (observability/diagnostics; recovery is automatic until the fallback).
 * - `cmdAck` — (phase 5) `{ commandId, type, stage, ... }` for every enveloped
 *   control ack (`applied`/`observed`/`superseded`) and enveloped errors
 *   (`stage: "error"`, `code`). Correlation bookkeeping is internal; the UI
 *   acts only on what it already shows.
 * - `reconciled` — `{ generation, hostRevision, terminalCursor,
 *   stateMaterializedRevision, unresolved }` after a reconnect reconcile.
 * - `epochReset` — `{ previous, current }` when the generation change forced a
 *   cursor discard (structural fix for the phase-4 epoch ambiguity).
 *
 * ## Control commands (phase 5, D4)
 *
 * `sendControl(type, payload)` envelopes `resize`/`interrupt`/`terminate`/
 * `detach` with `{commandId, clientId, seq, viewId, instanceId}` (identity
 * derived from hello/status — the UI passes no identity options). Returns the
 * commandId, or `null` when the host has no instance fence (legacy-mode main):
 * the caller then falls back to the legacy plain message. Keystroke `input`
 * is never enveloped (fire-and-forget by contract — throws). A resize that
 * lands in the runner's starting window answers `host_starting`; the client
 * retries with a fresh commandId (bounded chain, latest-wins) — parity with
 * the legacy runner-side cachedResize.
 *
 * The frame/DTO version axes live in the runner module. This client advertises
 * its `frameVersion` on every `subscribe_terminal` (the runner's mismatch gate
 * is only reachable when the field is present) and treats
 * `frame_version_mismatch` as legacy fallback.
 *
 * `AGENT_BOARD_TERMINAL_SNAPSHOT=0` (read once at factory time, overridable
 * via the `forceLegacy` option) forces the legacy path without probing —
 * escape hatch and deterministic legacy-test switch.
 */

import {
	MAX_VIEW_PROOF_RECORDS,
	TERMINAL_FRAME_VERSION,
	VIEW_PROOF_PROTOCOL_VERSION,
	sanitizeViewProofRecord,
} from "./terminal-attach-protocol.mjs";
import { classifyCommandAck, encodeCommand, CONTROL_ERROR_CODES, TERMINAL_ERROR_CODES } from "./control-protocol.mjs";

/**
 * @typedef {"probing" | "collecting" | "live" | "resyncing" | "reconciling" | "legacy" | "closed"} AttachClientState
 */

/**
 * @typedef {(
 *   event: "mode" | "snapshotBegin" | "snapshotReady" | "output" | "viewProof" | "viewProofRecord" |
 *          "resubscribing" | "protocolError" | "cmdAck" | "reconciled" | "epochReset",
 *   payload?: any,
 * ) => void} AttachClientEmit
 */

const MAX_SNAPSHOT_FAILURES = 3; // up to 3 recovery attempts, then legacy fallback
const MAX_RESIZE_START_RETRIES = 5; // max TOTAL sends per size change (initial + retries; legacy cachedResize parity is "eventually applied", not infinite)
const RESIZE_RETRY_DELAY_MS = 300;

/**
 * @typedef {{
 *   send: (msg: Record<string, unknown>) => void,
 *   emit: AttachClientEmit,
 *   probeTimeoutMs?: number,
 *   scheduleTimeout?: (delayMs: number, fn: () => void) => () => void,
 *   forceLegacy?: boolean,
 * }} AttachClientOptions
 */

const VIEW_PROOF_STATUSES = new Set(["covered", "unavailable", "unknown"]);

function unknownViewProof(reason) {
	return { status: "unknown", reason, proof: null, throughSeq: null, cursorVisible: null };
}

/** Bounded coverage sanitizer: accepts only tracker-shaped fields and a valid F proof. */
export function sanitizeViewProofCoverage(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	if (!VIEW_PROOF_STATUSES.has(value.status)) return null;
	if (value.reason !== null && value.reason !== undefined && typeof value.reason !== "string") return null;
	if (value.throughSeq !== null && value.throughSeq !== undefined && (!Number.isInteger(value.throughSeq) || value.throughSeq < 0)) return null;
	if (value.cursorVisible !== null && value.cursorVisible !== undefined && typeof value.cursorVisible !== "boolean") return null;
	const status = value.status;
	let proof = null;
	if (value.proof !== null && value.proof !== undefined) {
		proof = sanitizeViewProofRecord(value.proof);
		if (proof === null || proof.marker !== "F") return null;
	}
	if (status === "covered" && (proof === null || !Number.isInteger(value.throughSeq))) return null;
	if (status === "covered" && proof.seq > value.throughSeq) return null;
	let previousComplete = null;
	if (value.previousComplete !== null && value.previousComplete !== undefined) {
		previousComplete = sanitizeViewProofRecord(value.previousComplete);
		if (previousComplete === null || previousComplete.marker !== "F") return null;
	}
	return {
		status,
		reason: typeof value.reason === "string" ? value.reason : null,
		proof,
		throughSeq: Number.isInteger(value.throughSeq) ? value.throughSeq : null,
		cursorVisible: typeof value.cursorVisible === "boolean" ? value.cursorVisible : null,
		...(previousComplete === null ? {} : { previousComplete }),
	};
}

/** @type {NonNullable<AttachClientOptions["scheduleTimeout"]>} */
const defaultScheduleTimeout = (delayMs, fn) => {
	const t = setTimeout(fn, delayMs);
	// Never hold the runner/UI process open for a probe deadline.
	t.unref?.();
	return () => clearTimeout(t);
};

/**
 * @param {{
 *   send: (msg: Record<string, unknown>) => void,
 *   emit: AttachClientEmit,
 *   probeTimeoutMs?: number,
 *   scheduleTimeout?: (delayMs: number, fn: () => void) => () => void,
 *   forceLegacy?: boolean,
 *   clientId?: string,
 *   reconcileTimeoutMs?: number,
 * }} opts
 */
export function createTerminalAttachClient({
	send: rawSend,
	emit,
	probeTimeoutMs = 1500,
	scheduleTimeout = defaultScheduleTimeout,
	forceLegacy,
	clientId = `ui-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
	reconcileTimeoutMs = 1500,
}) {
	// Env is read once at factory time (plan contract); the explicit option
	// wins so tests and embedders can pin behavior regardless of environment.
	const forced =
		forceLegacy !== undefined ? forceLegacy : process.env.AGENT_BOARD_TERMINAL_SNAPSHOT === "0";

	/** @type {AttachClientState} */
	let state = forced ? "legacy" : "probing";
	let modeDecided = false; // "mode" fires once per direction, never both
	let lastSeq = 0;
	let probeTimer = null;
	let snapshotFailures = 0;

	// --- Control lifecycle (issue #91 phase 5, D4) ---
	// Identity is DERIVED from hello/status (review ruling 1): the UI passes no
	// viewId/instanceId options. `instanceId === null` means a legacy-mode host
	// (instance fence does not exist): envelopes are NEVER sent to it — control
	// commands fall back to the legacy plain messages; the attach snapshot
	// protocol itself still works there (the legacy main serves subscribe).
	let instanceId = null;
	let viewId = null;
	let generation = null; // last seen generation token (epoch detection)
	let seq = 0; // per-connection envelope ordering (resets on reconnect)
	let commandCounter = 0;
	/** @type {Map<string, { type: string }>} */
	const pendingCommands = new Map(); // commandId → correlation record
	let reconcileTimer = null;
	/** Pending reconnect gate: reconcile must resolve (or time out) before the
	 *  subscribe decision — spec D4 binds hello → reconcile → snapshot/subscribe. */
	let reconnectCursor = null;
	/** Generation baseline AT reconnect time — the fresh socket's hello must
	 *  not clobber it before the epoch comparison (that comparison is the whole
	 *  point of the gate). */
	let reconnectFromGeneration = null;
	/** Highest seq seen in legacy-broadcast strays during a reconnect gate. The
	 * subscribe cursor must start past these or the runner's replay re-sends
	 * them (wire-level duplicate — see the reconciling output branch). */
	let strayHighWater = 0;
	/** Generation observed at disconnect time — the epoch baseline. The live
	 * `generation` field is refreshed by every hello/status/snapshot_begin,
	 * INCLUDING the replacement runner's hello that precedes reconnect(), so
	 * comparing against it can never detect a generation change. */
	let generationAtDisconnect = null;
	/** Guards against a double reconcile within one reconnect gate (reconnect()
	 *  sends with the remembered identity; the fresh hello would otherwise send
	 *  a second one). */
	let reconcileInFlight = false;
	/** Active starting-window resize retry chain (latest-wins: a new user
	 *  resize replaces it). { commandId, cols, rows, attempt } | null */
	let resizeStartRetry = null;

	// Partial-snapshot stash (collecting): the runner sends frame, then its
	// catch-up flush outputs, then end — one microtask batch, tiny by contract
	// (ring pressure during capture yields resnapshot_required, not an
	// unbounded flush). Buffered here so the UI applies frame-then-flush in
	// exact order after snapshotReady. View-proof facts are bounded and cleared
	// with every new capture/resync.
	const emptyPartial = () => ({
		frame: null,
		empty: false,
		resnapshot: false,
		beginSeq: 0,
		flush: [],
		viewProofBegin: null,
		viewProofState: null,
		viewProofRecords: [],
		viewProofRecordsDropped: false,
	});
	/** @type {ReturnType<typeof emptyPartial>} */
	let partial = emptyPartial();

	const send = (msg) => {
		rawSend(msg);
	};

	const subscribeMessage = (extra = {}) => ({
		type: "subscribe_terminal",
		frameVersion: TERMINAL_FRAME_VERSION,
		viewProof: VIEW_PROOF_PROTOCOL_VERSION,
		...extra,
	});

	const fireProbeTimer = () => {
		cancelProbeTimer();
		probeTimer = scheduleTimeout(probeTimeoutMs, () => {
			probeTimer = null;
			if (modeDecided) return; // begin already decided protocol (timer would be cancelled anyway)
			fallbackToLegacy("probe_timeout");
		});
	};

	const cancelProbeTimer = () => {
		if (probeTimer) {
			probeTimer();
			probeTimer = null;
		}
	};

	const cancelReconcileTimer = () => {
		if (reconcileTimer) {
			reconcileTimer();
			reconcileTimer = null;
		}
	};

	const decideProtocol = () => {
		if (!modeDecided) {
			modeDecided = true;
			emit("mode", "protocol");
		}
	};

	const fallbackToLegacy = (reason) => {
		cancelProbeTimer();
		state = "legacy";
		// The legacy decision is ALWAYS reported, including after a protocol
		// session: the UI switched to the snapshot path at "protocol" and must
		// observe the downgrade to switch back (jiggle, raw output). A silent
		// protocol→legacy transition would leave the UI frozen on a stale frame.
		modeDecided = true;
		emit("mode", "legacy");
		emit("protocolError", { code: "legacy_fallback", message: reason });
	};

	/**
	 * Recovery subscribe: a fresh full snapshot. Deliberately WITHOUT
	 * `sinceSeq` — the runner answers a seq-less request with a fresh snapshot,
	 * always (its replay branch exists only for cursor reconnects), so this can
	 * never receive a partial tail (spec: never stitch).
	 */
	const resync = (reason) => {
		// Before the mode is decided the probe deadline still governs the legacy
		// fallback: a runner that fails the snapshot and then goes silent must
		// not strand the client outside both paths. Once protocol is decided the
		// timer is meaningless and gets cancelled.
		if (modeDecided) cancelProbeTimer();
		partial = emptyPartial();
		state = "resyncing";
		send(subscribeMessage());
		emit("resubscribing", { reason });
	};

	const resyncOrFail = (reason) => {
		snapshotFailures += 1;
		if (snapshotFailures > MAX_SNAPSHOT_FAILURES) {
			fallbackToLegacy(reason);
			return;
		}
		resync(reason);
	};

	// --- Control lifecycle helpers (phase 5, D4) ---

	/** Capture identity + generation from hello/status (UI-owned messages the
	 *  client only peeks at; they remain false/non-consumed). */
	const observeIdentity = (msg) => {
		const status = msg.status ?? {};
		// Normalize: an owned host carries a non-empty instanceId; a legacy-mode
		// host has none (undefined) — both mean "no envelope possible".
		instanceId = typeof status.instanceId === "string" && status.instanceId ? status.instanceId : null;
		viewId = typeof status.viewId === "string" && status.viewId ? status.viewId : viewId;
		if (typeof msg.generation === "string" && msg.generation) generation = msg.generation;
		// A reconnect waiting for identity on the fresh socket can now reconcile.
		if (state === "reconciling" && instanceId && reconnectCursor !== null && !reconcileInFlight) sendReconcile();
	};

	const sendReconcile = () => {
		reconcileInFlight = true;
		const commandId = `${clientId}-rec-${++commandCounter}`;
		seq += 1;
		send(encodeCommand("reconcile", {}, { commandId, clientId, seq, viewId: viewId ?? "unknown", instanceId }));
	};

	const issueReconnectSubscribe = (sinceSeq) => {
		// The cursor must clear every stray the legacy broadcast already
		// DELIVERED to this socket during the gate. Strays still in flight when
		// the subscribe is written cannot be folded in: the ring replay re-sends
		// them and seq-checked consumption dedups — the guarantee is UI-level
		// exactly-once; a wire-level repeat at the broadcast→replay handoff is
		// expected (#140).
		const effective = Math.max(sinceSeq, strayHighWater);
		strayHighWater = 0;
		const cursor = reconnectCursor;
		reconnectCursor = null;
		reconcileInFlight = false;
		reconnectFromGeneration = null;
		cancelReconcileTimer();
		lastSeq = effective;
		partial = emptyPartial();
		state = "resyncing";
		send(effective > 0 ? subscribeMessage({ sinceSeq: effective }) : subscribeMessage());
		return cursor;
	};

	/** Epoch rule (spec D4 + phase-4 residual fix): a generation CHANGE versus
	 *  the baseline captured at reconnect() means the runner (and its child)
	 *  was replaced — the remembered cursor describes a dead stream, so ring
	 *  replay across generations is structurally impossible: discard the cursor
	 *  and take a fresh snapshot. Same generation → seamless replay from the
	 *  applied cursor. No generation (unreachable: reconcile needs an
	 *  instanceId) or an unanswered reconcile (phase-4 runner) → phase-4
	 *  semantics: the runner's resnapshot/empty begin flags protect correctness. */
	const resolveReconnect = (result) => {
		const nextGeneration = typeof result?.generation === "string" && result.generation ? result.generation : null;
		generation = nextGeneration ?? generation;
		emit("reconciled", {
			generation,
			hostRevision: result?.hostRevision,
			terminalCursor: result?.terminalCursor,
			stateMaterializedRevision: result?.stateMaterializedRevision,
			unresolved: result?.unresolved,
		});
		if (nextGeneration && reconnectFromGeneration && nextGeneration !== reconnectFromGeneration) {
			lastSeq = 0;
			emit("epochReset", { previous: reconnectFromGeneration, current: nextGeneration });
			// Epoch reset demands a seq-less subscribe (fresh snapshot). Gate strays
			// from the NEW runner must not turn it into a tail replay onto the stale
			// buffer — the max() in issueReconnectSubscribe is for the SAME-generation
			// continuity path only. The fresh frame subsumes any emitted strays.
			strayHighWater = 0;
			issueReconnectSubscribe(0);
			return;
		}
		issueReconnectSubscribe(reconnectCursor ?? 0);
	};

	const cancelResizeStartRetry = () => {
		resizeStartRetry = null;
	};

	/** Re-arm the starting-window retry chain (bounded, latest-wins). Object
	 *  identity is the liveness marker: a newer resize replaces the chain, a
	 *  terminal ack cancels it, and a stale timer is a no-op. */
	const scheduleResizeStartRetry = (chain) => {
		if (chain.attempt + 1 >= MAX_RESIZE_START_RETRIES) {
			resizeStartRetry = null;
			return;
		}
		const next = { ...chain, attempt: chain.attempt + 1 };
		resizeStartRetry = next;
		scheduleTimeout(RESIZE_RETRY_DELAY_MS, () => {
			if (resizeStartRetry !== next) return; // superseded or cancelled
			sendControl("resize", { cols: next.cols, rows: next.rows }, { isRetry: true });
		});
	};

	/**
	 * Send a control command with the phase-5 envelope (spec D4). Returns the
	 * commandId, or null when no instance fence is known (legacy-mode host):
	 * the caller falls back to the legacy plain message. Keystroke `input` is
	 * deliberately NOT sendable here — plain keyboard input is fire-and-forget
	 * by contract (never enveloped, never acked, never replayed).
	 *
	 * @param {"resize" | "interrupt" | "terminate" | "detach"} type
	 * @param {Record<string, unknown>} payload
	 * @param {{ isRetry?: boolean }} [opts] internal: retry sends keep the chain
	 */
	function sendControl(type, payload = {}, opts = {}) {
		if (type === "input") throw new TypeError("sendControl: keystroke input is never enveloped (fire-and-forget contract)");
		if (state === "closed" || state === "legacy" || !instanceId || !viewId) return null;
		const commandId = `${clientId}-${++commandCounter}`;
		seq += 1;
		send(encodeCommand(type, payload, { commandId, clientId, seq, viewId, instanceId }));
		pendingCommands.set(commandId, { type });
		if (type === "resize" && !opts.isRetry) {
			// latest-wins: a new user resize replaces any retry chain
			resizeStartRetry = { cols: payload.cols, rows: payload.rows, attempt: 0 };
		}
		return { commandId };
	}

	/** Enter collecting from a begin message (both probing and resyncing).
	 *  Deliberately does NOT reset the failure budget: a runner that keeps
	 *  sending begins interleaved with garbage must still trip the cap — only
	 *  a VERIFIED snapshot (or verified replay) pays the budget back. */
	const beginCollecting = (msg) => {
		decideProtocol();
		cancelProbeTimer();
		// Size-sync hook (CR R1 blocking): every begin carries the runner's
		// captured geometry — empty baselines included, so a child that has not
		// produced output yet still gets corrected BEFORE its first bytes land.
		if (typeof msg.cols === "number" && typeof msg.rows === "number") {
			emit("snapshotBegin", {
				cols: msg.cols,
				rows: msg.rows,
				...(msg.empty === true ? { empty: true } : {}),
				...(typeof msg.generation === "string" ? { generation: msg.generation } : {}),
			});
		}
		let beginCoverage = null;
		if (msg.viewProof !== undefined) {
			beginCoverage = sanitizeViewProofCoverage(msg.viewProof);
			if (beginCoverage === null) {
				emit("protocolError", { code: "view_proof_invalid", message: "snapshot_begin.viewProof" });
				beginCoverage = unknownViewProof("invalid-view-proof");
			}
		}
		partial = {
			...emptyPartial(),
			empty: msg.empty === true,
			resnapshot: msg.resnapshot === true,
			beginSeq: typeof msg.snapshotSeq === "number" ? msg.snapshotSeq : 0,
			viewProofBegin: beginCoverage,
		};
		state = "collecting";
		if (partial.empty) {
			// Empty baselines carry no frame and no flush; the end message is
			// already in the runner's send batch.
			return;
		}
	};

	const finishCollecting = (msg) => {
		const nextSeq = msg.nextSeq;
		if (!partial.frame && !partial.empty) {
			// begin (non-empty) + end with no frame in between: never paint from
			// an unverified window. Bounded recovery: fresh snapshot.
			resyncOrFail("snapshot_frame_missing");
			return;
		}
		const expected = partial.flush.length
			? partial.flush[partial.flush.length - 1].seq + 1
			: (partial.empty ? 0 : partial.beginSeq) + 1;
		if (nextSeq !== expected) {
			// Continuity broken inside the snapshot window: never paint a
			// partially-verified frame. Recovery: fresh snapshot.
			resyncOrFail("snapshot_end_mismatch");
			return;
		}
		snapshotFailures = 0; // a verified snapshot pays back the recovery budget
		let endCoverage = null;
		if (msg.viewProof !== undefined) {
			endCoverage = sanitizeViewProofCoverage(msg.viewProof);
			if (endCoverage === null) {
				emit("protocolError", { code: "view_proof_invalid", message: "snapshot_end.viewProof" });
				endCoverage = unknownViewProof("invalid-view-proof");
			}
		}
		let viewProof = endCoverage ?? partial.viewProofState ?? partial.viewProofBegin;
		let viewProofRecords = partial.viewProofRecords;
		if (viewProof !== null && viewProof.status === "covered" && viewProof.throughSeq > nextSeq - 1) {
			viewProof = unknownViewProof("view-proof-future");
		}
		if (partial.viewProofRecordsDropped) {
			viewProof = unknownViewProof("records-dropped");
			viewProofRecords = [];
		} else if (viewProofRecords.length > 0) {
			// A record after the baseline needs its catch-up output segment. Missing it
			// means the client cannot prove the receipt order; never keep "covered".
			const flushSeqs = new Set(partial.flush.map((chunk) => chunk.seq));
			const missing = viewProofRecords.some((record) => record.seq > partial.beginSeq && !flushSeqs.has(record.seq));
			if (missing && (viewProof === null || viewProof.status === "covered")) viewProof = unknownViewProof("proof-output-gap");
		}
		emit("snapshotReady", {
			frame: partial.frame ?? undefined,
			empty: partial.empty || undefined,
			resnapshot: partial.resnapshot || undefined,
			nextSeq,
			// Optional field: omit the key for a runner that predates it, so the
			// event shape stays exactly what old consumers assert on.
			...(typeof msg.scrollbackLines === "number" ? { scrollbackLines: msg.scrollbackLines } : {}),
			...(viewProof === null ? {} : { viewProof }),
			...(viewProofRecords.length > 0 ? { viewProofRecords } : {}),
		});
		for (const chunk of partial.flush) emit("output", chunk.data);
		lastSeq = nextSeq - 1;
		state = "live";
	};

	/**
	 * Handle one runner→client message. Returns true when the message is
	 * protocol-managed (consumed); false means the caller (UI) should process
	 * it through its existing path.
	 *
	 * @param {any} msg
	 * @returns {boolean}
	 */
	function handleMessage(msg) {
		if (!msg || typeof msg !== "object" || state === "closed" || state === "legacy") return false;
		switch (msg.type) {
			case "hello":
			case "status": {
				// Identity/generation peek (UI-owned message, not consumed).
				observeIdentity(msg);
				return false;
			}
			case "cmd_ack": {
				// Control-lifecycle correlation (spec D4). The ack is consumed even
				// for unknown commandIds (a late ack after internal retry cleanup is
				// not a UI message).
				const pending = pendingCommands.get(msg.commandId);
				if (pending) {
					const verdict = classifyCommandAck(pending.type, msg);
					if (verdict.ok) {
						if (verdict.stage === "applied" || verdict.stage === "observed" || verdict.stage === "superseded") {
							pendingCommands.delete(msg.commandId);
							if (pending.type === "resize") cancelResizeStartRetry();
						}
					} else {
						emit("protocolError", { code: "ack_invalid", message: verdict.reason, commandId: msg.commandId });
					}
				}
				emit("cmdAck", { commandId: msg.commandId, type: pending?.type, stage: msg.stage, cols: msg.cols, rows: msg.rows, byCommandId: msg.byCommandId, value: msg.value, exitConfirmed: msg.exitConfirmed, runnerFinalizing: msg.runnerFinalizing });
				return true;
			}
			case "reconcile_result": {
				if (state === "reconciling") resolveReconnect(msg);
				return true;
			}
			case "error": {
				if (msg.code === "frame_version_mismatch") {
					// Wire contract mismatch: treat this runner as incompatible.
					fallbackToLegacy("frame_version_mismatch");
					return true;
				}
				if (msg.code === "view_proof_version_mismatch") {
					// Conservative: never fake modern proof for an incompatible runner.
					fallbackToLegacy("view_proof_version_mismatch");
					return true;
				}
				if (msg.code === "snapshot_failed" || msg.code === "invalid_since_seq") {
					if (state === "probing" || state === "resyncing" || state === "collecting") {
						resyncOrFail(msg.code);
						return true;
					}
					return false;
				}
				if (msg.code === "instance_mismatch" && state === "reconciling" && typeof msg.currentInstanceId === "string" && msg.currentInstanceId) {
					// Recovery signal (review ruling 1): the host was replaced with a
					// new instance fence — adopt and re-reconcile (same deadline).
					instanceId = msg.currentInstanceId;
					sendReconcile();
					return true;
				}
				if (msg.code === "host_starting" && msg.commandId) {
					const pending = pendingCommands.get(msg.commandId);
					pendingCommands.delete(msg.commandId);
					emit("cmdAck", { commandId: msg.commandId, type: pending?.type, stage: "error", code: msg.code });
					if (pending?.type === "resize" && resizeStartRetry) {
						scheduleResizeStartRetry(resizeStartRetry);
					}
					return true;
				}
				if (msg.code && CONTROL_ERROR_CODES[msg.code] && msg.commandId) {
					// Task 4 (review P2): a taxonomy error correlated by commandId must
					// consume the pending entry and surface as a cmdAck error — a
					// swallowed error leaves the command pending forever. Terminal codes
					// also cancel the resize starting-window retry chain (retrying into
					// a moved fence or a caller-bug rejection is futile; host_starting
					// above keeps its bounded-retry semantics).
					const pending = pendingCommands.get(msg.commandId);
					pendingCommands.delete(msg.commandId);
					if (pending?.type === "resize" && TERMINAL_ERROR_CODES.includes(msg.code)) {
						cancelResizeStartRetry();
					}
					emit("cmdAck", { commandId: msg.commandId, type: pending?.type, stage: "error", code: msg.code, currentInstanceId: msg.currentInstanceId });
					return true;
				}
				return false; // UI-owned status errors
			}
			case "view_proof": {
				const record = sanitizeViewProofRecord(msg.record);
				if (record === null) {
					emit("protocolError", { code: "view_proof_invalid", message: "view_proof.record" });
					return true;
				}
				if (state === "collecting") {
					if (partial.viewProofRecords.length >= MAX_VIEW_PROOF_RECORDS) partial.viewProofRecordsDropped = true;
					else partial.viewProofRecords.push(record);
					return true;
				}
				if (state === "live" || state === "resyncing") {
					if (record.seq > lastSeq) {
						emit("protocolError", { code: "view_proof_future", message: `seq ${record.seq} > ${lastSeq}` });
						return true;
					}
					emit("viewProofRecord", record);
					return true;
				}
				return true; // probing/reconciling: pre-subscribe stray
			}
			case "view_proof_state": {
				let coverage = sanitizeViewProofCoverage(msg.viewProof);
				if (coverage === null) {
					emit("protocolError", { code: "view_proof_invalid", message: "view_proof_state.viewProof" });
					coverage = unknownViewProof("invalid-view-proof");
				}
				if ((state === "live" || state === "resyncing") && coverage.status === "covered" && coverage.throughSeq > lastSeq) {
					emit("protocolError", { code: "view_proof_future", message: `throughSeq ${coverage.throughSeq} > ${lastSeq}` });
					coverage = unknownViewProof("view-proof-future");
				}
				if (state === "collecting") {
					partial.viewProofState = coverage;
					return true;
				}
				if (state === "resyncing") {
					// Zero-output replay completion: the state message is the only
					// proof-bearing completion signal. Normal replay completes on output.
					decideProtocol();
					snapshotFailures = 0;
					state = "live";
					emit("viewProof", coverage);
					return true;
				}
				if (state === "live") {
					emit("viewProof", coverage);
					return true;
				}
				return true; // probing/reconciling: pre-subscribe stray
			}
			case "snapshot_begin": {
				if (typeof msg.generation === "string" && msg.generation) generation = msg.generation;
				if (state === "probing" || state === "resyncing") {
					beginCollecting(msg);
					return true;
				}
				if (state === "reconciling") return true; // pre-subscribe stray: consume
				// Unsolicited begin in collecting (duplicate) or live: protocol
				// violation — strictness surfaces runner bugs; a fresh subscribe
				// converges either way.
				resyncOrFail("unexpected_snapshot_begin");
				return true;
			}
			case "snapshot_frame": {
				if (state === "reconciling") return true; // pre-subscribe stray: consume
				if (state !== "collecting" || partial.empty || typeof msg.data !== "string") {
					resyncOrFail("unexpected_snapshot_frame");
					return true;
				}
				partial.frame = msg.data;
				return true;
			}
			case "snapshot_end": {
				if (state === "reconciling") return true; // pre-subscribe stray: consume
				if (state !== "collecting") {
					resyncOrFail("unexpected_snapshot_end");
					return true;
				}
				finishCollecting(msg);
				return true;
			}
			case "resnapshot_required": {
				if (state === "live" || state === "collecting" || state === "resyncing") {
					resyncOrFail("resnapshot_required");
					return true;
				}
				if (state === "reconciling") return true; // pre-subscribe stray: consume
				return false;
			}
			case "output": {
				if (state === "live") {
					if (typeof msg.seq !== "number") {
						// A protocol-owned socket must never receive seq-less
						// output; consume and ignore so unsequenced bytes can
						// never corrupt the canonical-state buffer.
						return true;
					}
					if (msg.seq === lastSeq + 1) {
						lastSeq = msg.seq;
						emit("output", msg.data);
						return true;
					}
					if (msg.seq <= lastSeq) return true; // duplicate/stale
					resyncOrFail("seq_gap");
					return true;
				}
				if (state === "collecting") {
					if (typeof msg.seq !== "number") return true; // consume+ignore, see live branch
					if (!partial.frame) {
						// Output before the frame: the runner never emits this
						// (its catch-up flush is frame → outputs → end). Violation.
						resyncOrFail("output_before_snapshot_frame");
						return true;
					}
					const expected = partial.flush.length
						? partial.flush[partial.flush.length - 1].seq + 1
						: partial.beginSeq + 1;
					if (msg.seq !== expected) {
						resyncOrFail("snapshot_flush_gap");
						return true;
					}
					partial.flush.push({ seq: msg.seq, data: msg.data });
					return true;
				}
				if (state === "resyncing") {
					// Complete-replay continuation is the only accepted output:
					// it proves the runner answered with the full retained range.
					if (typeof msg.seq === "number" && msg.seq === lastSeq + 1) {
						decideProtocol();
						lastSeq = msg.seq;
						emit("output", msg.data);
						state = "live";
						snapshotFailures = 0; // verified complete replay pays the budget back
						return true;
					}
					return true; // strays (pre-resync in-flight chunks): ignored
				}
				if (state === "reconciling") {
					// The fresh socket is not subscribed yet: everything here is
					// broadcast stray. Consume so the UI legacy path can never
					// double-feed — and EMIT it: these bytes must reach the UI exactly
					// once (OBSERVED strays cover (cursor, strayHighWater]; the replay
					// starts past the high-water; in-flight strays are re-sent by the
					// replay and deduped). Consuming WITHOUT emitting would silently
					// drop them from the rendered output — a data-loss regression the
					// task-5 review caught. lastSeq deliberately does NOT advance here:
					// the subscribe cursor (max(cursor, strayHighWater)) carries the
					// applied position once the replay/stream resumes.
					if (typeof msg.seq === "number" && msg.seq > strayHighWater) strayHighWater = msg.seq;
					emit("output", msg.data);
					return true;
				}
				// probing: outputs belong to the legacy broadcast window (old
				// runner, or new runner before subscribe processing). Not ours.
				return false;
			}
			// (A duplicate dead `case "error":` block that survived the phase-5
			// insertion was removed here — task 3 review P2: the live error case
			// above returns on every path, so a second label was unreachable.)
			default:
				return false;
		}
	}

	/** Arm the probe. Sends only `subscribe_terminal` — the UI keeps ownership
	 *  of `hello` (it carries UI-specific fields) and sends it itself. */
	function start() {
		if (state === "legacy") {
			if (!modeDecided) {
				modeDecided = true;
				emit("mode", "legacy");
			}
			return;
		}
		if (state !== "probing") return;
		send(subscribeMessage());
		fireProbeTimer();
	}

	/**
	 * New socket after a drop. Protocol mode: spec D4 binds the reconnect order
	 * `hello → reconcile → snapshot/subscribe` — the reconcile answer's
	 * generation drives the epoch rule (changed ⇒ discard cursor ⇒ fresh
	 * snapshot; same ⇒ replay from the applied cursor). Still probing: re-issue
	 * the probe on the new socket. Legacy: nothing — the UI legacy path
	 * reconnects on its own. A legacy-mode HOST (instanceId null) cannot be
	 * reconciled by contract (envelopes are never sent there) → phase-4
	 * semantics directly (the runner's resnapshot/empty flags protect).
	 *
	 * @param {number} cursorSeq last applied protocol seq (getLastSeq())
	 */
	function reconnect(cursorSeq) {
		if (state === "closed" || state === "legacy") return;
		if (state === "probing") {
			send(subscribeMessage());
			fireProbeTimer();
			return;
		}
		seq = 0; // per-connection ordering resets with the socket (spec D4)
		snapshotFailures = 0; // fresh connection, fresh recovery budget
		partial = emptyPartial();
		if (!instanceId) {
			issueReconnectSubscribe(cursorSeq);
			return;
		}
		reconnectCursor = cursorSeq;
		reconnectFromGeneration = generationAtDisconnect ?? generation;
		state = "reconciling";
		cancelReconcileTimer();
		reconcileTimer = scheduleTimeout(reconcileTimeoutMs, () => {
			reconcileTimer = null;
			if (state !== "reconciling") return;
			// Unanswered reconcile (phase-4 runner or dead window): fall back to
			// the phase-4 reconnect (sinceSeq; the runner's begin flags protect).
			issueReconnectSubscribe(reconnectCursor ?? 0);
		});
		if (instanceId && viewId) sendReconcile();
		// else: wait for the fresh hello (observeIdentity triggers sendReconcile).
	}

	/** Tear down: cancel timers, go inert. */
	function close() {
		cancelProbeTimer();
		cancelReconcileTimer();
		// CR R1 advisory: undeliverable correlation entries must not outlive the
		// client — a new connection issues fresh commandIds, so a stale entry can
		// never be consumed by a late ack.
		pendingCommands.clear();
		state = "closed";
	}

	/** Socket dropped (CR R1 advisory): cancel the probe deadline so a dead
	 *  window can never downgrade a protocol-capable runner. The timer is
	 *  absolute — a reconnect landing after the 1500ms deadline would otherwise
	 *  inherit the stale "no snapshot" verdict for the whole session. The next
	 *  `start()`/`reconnect()` on the new socket re-arms everything; decided
	 *  modes (legacy) and closed stay inert. */
	function onDisconnect() {
		if (state === "closed" || state === "legacy") return;
		// Epoch baseline: snapshot the generation AS OF THE DISCONNECT. The live
		// `generation` field will be refreshed by the replacement runner's hello
		// before reconnect() runs, so only this capture can detect a change.
		if (generation) generationAtDisconnect = generation;
		cancelProbeTimer();
		cancelReconcileTimer();
		// CR R1 advisory: pending correlation entries cannot be acked through a
		// dead socket; a reconnect uses fresh commandIds. Clearing here means a
		// half-open late ack is treated as uncorrelated — fine, the socket died.
		pendingCommands.clear();
	}

	return {
		start,
		reconnect,
		onDisconnect,
		handleMessage,
		close,
		/** Bounded fresh seq-less resync request (no timer/retry loop here). */
		requestResync(reason = "requested") {
			if (state === "closed" || state === "legacy") return false;
			resync(reason);
			return true;
		},
		/** Conservative public legacy decision (used for observer-unavailable). */
		forceLegacy(reason = "forced") {
			if (state === "closed") return false;
			if (state === "legacy") return true;
			fallbackToLegacy(reason);
			return true;
		},
		/** @returns {"probing" | "protocol" | "legacy" | "closed"} UI-facing mode */
		getMode() {
			if (state === "collecting" || state === "live" || state === "resyncing" || state === "reconciling") return "protocol";
			return state;
		},
		/** Last applied protocol seq (reconnect cursor). */
		getLastSeq() {
			return lastSeq;
		},
		sendControl,
		/** Identity snapshot (test/diagnostics aid). */
		getIdentity() {
			return { instanceId, viewId, generation };
		},
	};
}

/**
 * @typedef {ReturnType<typeof createTerminalAttachClient>} TerminalAttachClient
 */
