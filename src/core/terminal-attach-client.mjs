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
 *   runner messages in this state are consumed-and-ignored (the socket is not
 *   subscribed yet). Resolution:
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
 * - `snapshotReady` — `{ frame?, empty?, resnapshot?, nextSeq }` after
 *   continuity is verified at `snapshot_end`. UI: `term.reset()` +
 *   `write(frame)` (the frame is self-contained on dirty terminals), or
 *   loading baseline for `empty`. Empty baselines carry no frame.
 * - `output` — live/replay chunk data (protocol-managed only).
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

import { TERMINAL_FRAME_VERSION } from "./terminal-attach-protocol.mjs";
import { classifyCommandAck, encodeCommand, CONTROL_ERROR_CODES, TERMINAL_ERROR_CODES } from "./control-protocol.mjs";

/**
 * @typedef {"probing" | "collecting" | "live" | "resyncing" | "reconciling" | "legacy" | "closed"} AttachClientState
 */

/**
 * @typedef {(
 *   event: "mode" | "snapshotBegin" | "snapshotReady" | "output" | "resubscribing" | "protocolError" |
 *          "cmdAck" | "reconciled" | "epochReset",
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
	// exact order after snapshotReady.
	/** @type {{ frame: string | null, empty: boolean, resnapshot: boolean, beginSeq: number, flush: { seq: number, data: string }[] }} */
	let partial = { frame: null, empty: false, resnapshot: false, beginSeq: 0, flush: [] };

	const send = (msg) => {
		rawSend(msg);
	};

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
		partial = { frame: null, empty: false, resnapshot: false, beginSeq: 0, flush: [] };
		state = "resyncing";
		send({ type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION });
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
		// delivered to this socket during the gate (wire-level no-dup).
		const effective = Math.max(sinceSeq, strayHighWater);
		strayHighWater = 0;
		const cursor = reconnectCursor;
		reconnectCursor = null;
		reconcileInFlight = false;
		reconnectFromGeneration = null;
		cancelReconcileTimer();
		lastSeq = effective;
		partial = { frame: null, empty: false, resnapshot: false, beginSeq: 0, flush: [] };
		state = "resyncing";
		send(
			effective > 0
				? { type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION, sinceSeq: effective }
				: { type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION },
		);
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
			emit("snapshotBegin", { cols: msg.cols, rows: msg.rows });
		}
		partial = {
			frame: null,
			empty: msg.empty === true,
			resnapshot: msg.resnapshot === true,
			beginSeq: typeof msg.snapshotSeq === "number" ? msg.snapshotSeq : 0,
			flush: [],
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
		emit("snapshotReady", {
			frame: partial.frame ?? undefined,
			empty: partial.empty || undefined,
			resnapshot: partial.resnapshot || undefined,
			nextSeq,
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
					// double-feed bytes the coming snapshot/replay will cover — but
					// REMEMBER the high-water seq: the runner's legacy broadcast and
					// the replay stream overlap on the wire, so the subscribe cursor
					// must start past every stray the broadcast already delivered
					// (otherwise the replay re-sends them — a wire-level duplicate
					// that widens from sub-ms to the reconcile RTT under the phase-5
					// gate).
					if (typeof msg.seq === "number" && msg.seq > strayHighWater) strayHighWater = msg.seq;
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
		send({ type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION });
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
			send({ type: "subscribe_terminal", frameVersion: TERMINAL_FRAME_VERSION });
			fireProbeTimer();
			return;
		}
		seq = 0; // per-connection ordering resets with the socket (spec D4)
		snapshotFailures = 0; // fresh connection, fresh recovery budget
		partial = { frame: null, empty: false, resnapshot: false, beginSeq: 0, flush: [] };
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
	}

	return {
		start,
		reconnect,
		onDisconnect,
		handleMessage,
		close,
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
