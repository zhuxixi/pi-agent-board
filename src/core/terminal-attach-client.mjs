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
 *     subscribe (same probe window); 3 consecutive → `legacy`
 * - `collecting` — `snapshot_begin` seen; waiting for `snapshot_end`.
 *   - `snapshot_frame` → frame stashed
 *   - `output` WITH seq between frame and end = runner catch-up flush
 *     (tested runner contract): stashed, applied after the frame, never
 *     counted before `snapshotReady`
 *   - `output` WITH seq before any frame = protocol violation → resync
 *   - `snapshot_end` → verify `nextSeq === stashed tail + 1` (or
 *     `begin.snapshotSeq + 1` with no flush), then emit `snapshotReady`
 *     followed by the stashed flush in order → `live`
 *   - `resnapshot_required` / `snapshot_failed` (interrupted snapshot) →
 *     discard the partial snapshot → resync
 * - `live` — seq-checked consumption against `lastSeq`.
 *   - `seq === lastSeq + 1` → emit `output`, advance
 *   - `seq <= lastSeq` → duplicate/stale, silently ignored
 *   - `seq > lastSeq + 1` → gap → resync (fresh snapshot, never stitched)
 *   - `resnapshot_required` → resync; unsolicited `snapshot_begin` → resync
 * - `resyncing` — a fresh `subscribe_terminal` (no `sinceSeq`: the runner
 *   answers with a complete replay or a fresh snapshot; a seq-less request
 *   never produces a partial-tail replay) is in flight.
 *   - `snapshot_begin` → `collecting`
 *   - `output` with `seq === lastSeq + 1` (complete replay) → `live`,
 *     seamless (no `snapshotReady`, UI keeps its buffer)
 *   - stray outputs / duplicate markers → ignored
 *   - `snapshot_failed` / `resnapshot_required` → resend; 3 consecutive
 *     failures → `legacy`
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
 *   decided); exactly once per direction, never both.
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
 *
 * The frame/DTO version axes live in the runner module; this client sends no
 * `frameVersion` (runner default) and treats `frame_version_mismatch` as
 * legacy fallback.
 *
 * `AGENT_BOARD_TERMINAL_SNAPSHOT=0` (read once at factory time, overridable
 * via the `forceLegacy` option) forces the legacy path without probing —
 * escape hatch and deterministic legacy-test switch.
 */

/**
 * @typedef {"probing" | "collecting" | "live" | "resyncing" | "legacy" | "closed"} AttachClientState
 */

/**
 * @typedef {(
 *   event: "mode" | "snapshotReady" | "output" | "resubscribing" | "protocolError",
 *   payload?: any,
 * ) => void} AttachClientEmit
 */

const MAX_SNAPSHOT_FAILURES = 3;

/** @type {NonNullable<import("./terminal-attach-client.mjs").AttachClientOptions["scheduleTimeout"]>} */
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
 * }} opts
 */
export function createTerminalAttachClient({
	send: rawSend,
	emit,
	probeTimeoutMs = 1500,
	scheduleTimeout = defaultScheduleTimeout,
	forceLegacy,
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

	const decideProtocol = () => {
		if (!modeDecided) {
			modeDecided = true;
			emit("mode", "protocol");
		}
	};

	const fallbackToLegacy = (reason) => {
		cancelProbeTimer();
		state = "legacy";
		if (!modeDecided) {
			modeDecided = true;
			emit("mode", "legacy");
		}
		emit("protocolError", { code: "legacy_fallback", message: reason });
	};

	/**
	 * Recovery subscribe: a fresh full snapshot. Deliberately WITHOUT
	 * `sinceSeq` — a seq-less request can only be answered by a complete
	 * replay or a fresh snapshot, never by a partial tail (spec: never stitch).
	 */
	const resync = (reason) => {
		// Before the mode is decided the probe deadline still governs the legacy
		// fallback: a runner that fails the snapshot and then goes silent must
		// not strand the client outside both paths. Once protocol is decided the
		// timer is meaningless and gets cancelled.
		if (modeDecided) cancelProbeTimer();
		partial = { frame: null, empty: false, resnapshot: false, beginSeq: 0, flush: [] };
		state = "resyncing";
		send({ type: "subscribe_terminal" });
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

	/** Enter collecting from a begin message (both probing and resyncing). */
	const beginCollecting = (msg) => {
		decideProtocol();
		cancelProbeTimer();
		snapshotFailures = 0;
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
		const expected = partial.flush.length
			? partial.flush[partial.flush.length - 1].seq + 1
			: (partial.empty ? 0 : partial.beginSeq) + 1;
		if (nextSeq !== expected) {
			// Continuity broken inside the snapshot window: never paint a
			// partially-verified frame. Recovery: fresh snapshot.
			resync("snapshot_end_mismatch");
			return;
		}
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
			case "snapshot_begin": {
				if (state === "probing" || state === "resyncing") {
					beginCollecting(msg);
					return true;
				}
				// Unsolicited begin in collecting (duplicate) or live: protocol
				// violation — strictness surfaces runner bugs; a fresh subscribe
				// converges either way.
				resync("unexpected_snapshot_begin");
				return true;
			}
			case "snapshot_frame": {
				if (state !== "collecting" || partial.empty || typeof msg.data !== "string") {
					resync("unexpected_snapshot_frame");
					return true;
				}
				partial.frame = msg.data;
				return true;
			}
			case "snapshot_end": {
				if (state !== "collecting") {
					resync("unexpected_snapshot_end");
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
					resync("seq_gap");
					return true;
				}
				if (state === "collecting") {
					if (typeof msg.seq !== "number") return true; // consume+ignore, see live branch
					if (!partial.frame) {
						// Output before the frame: the runner never emits this
						// (its catch-up flush is frame → outputs → end). Violation.
						resync("output_before_snapshot_frame");
						return true;
					}
					const expected = partial.flush.length
						? partial.flush[partial.flush.length - 1].seq + 1
						: partial.beginSeq + 1;
					if (msg.seq !== expected) {
						resync("snapshot_flush_gap");
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
						return true;
					}
					return true; // strays (pre-resync in-flight chunks): ignored
				}
				// probing: outputs belong to the legacy broadcast window (old
				// runner, or new runner before subscribe processing). Not ours.
				return false;
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
				return false; // UI-owned status errors
			}
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
		send({ type: "subscribe_terminal" });
		fireProbeTimer();
	}

	/**
	 * New socket after a drop. Protocol mode: subscribe with the last applied
	 * cursor (replay → seamless live; otherwise fresh snapshot). Still
	 * probing: re-issue the probe on the new socket. Legacy: nothing — the UI
	 * legacy path reconnects on its own.
	 *
	 * @param {number} cursorSeq last applied protocol seq (getLastSeq())
	 */
	function reconnect(cursorSeq) {
		if (state === "closed" || state === "legacy") return;
		if (state === "probing") {
			send({ type: "subscribe_terminal" });
			fireProbeTimer();
			return;
		}
		lastSeq = cursorSeq;
		partial = { frame: null, empty: false, resnapshot: false, beginSeq: 0, flush: [] };
		state = "resyncing";
		send({ type: "subscribe_terminal", sinceSeq: cursorSeq });
	}

	/** Tear down: cancel timers, go inert. */
	function close() {
		cancelProbeTimer();
		state = "closed";
	}

	return {
		start,
		reconnect,
		handleMessage,
		close,
		/** @returns {"probing" | "protocol" | "legacy" | "closed"} UI-facing mode */
		getMode() {
			if (state === "collecting" || state === "live" || state === "resyncing") return "protocol";
			return state;
		},
		/** Last applied protocol seq (reconnect cursor). */
		getLastSeq() {
			return lastSeq;
		},
	};
}

/**
 * @typedef {ReturnType<typeof createTerminalAttachClient>} TerminalAttachClient
 */
