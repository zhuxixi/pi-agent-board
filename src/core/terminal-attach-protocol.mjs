import { ringChunksAfter } from "./terminal-model.mjs";
import {
	captureTerminalSnapshot,
	synthesizeFullRedrawFrame,
	TERMINAL_SNAPSHOT_VERSION,
} from "./terminal-snapshot.mjs";

/**
 * Capture-and-subscribe protocol for one attach socket (issue #91, D2 phase 3).
 *
 * Pure state machine: no sockets, no fs — `send` is injected and the runner
 * feeds `onOutput` for every chunk it broadcasts. Correctness rests on two
 * invariants:
 *
 * 1. Snapshot capture is async (parser idle wait), but output keeps flowing.
 *    Chunks fed during capture are retained in the model ring; the catch-up
 *    flush after the frame replays exactly the chunks past `dto.snapshotSeq`.
 *    The ring therefore IS the gap buffer — nothing is buffered twice.
 * 2. Delivery order per socket is gap-free and duplicate-free: live output is
 *    only forwarded when `seq === lastSeq + 1`; any discontinuity downgrades
 *    the socket to `resnapshot_required` instead of stitching (spec: never
 *    recover from a partial tail).
 */

/**
 * Wire frame version axis: the synthesized full-redraw frame format carried in
 * `snapshot_frame` payloads (Route B). Clients advertising a different
 * `frameVersion` on `subscribe_terminal` are rejected — the wire contract must
 * match exactly; there is no negotiated degradation inside this protocol.
 *
 * This axis is independent from {@link TERMINAL_SNAPSHOT_VERSION} (the DTO
 * capture format, an internal artifact that never crosses the wire in Route B).
 */
export const TERMINAL_FRAME_VERSION = 1;

export { TERMINAL_SNAPSHOT_VERSION };

/**
 * @typedef {ReturnType<typeof createTerminalSubscription>} TerminalSubscription
 */

/**
 * Create the per-socket terminal subscription state.
 *
 * @param {{
 *   model: import("./terminal-model.mjs").TerminalModel,
 *   send: (msg: Record<string, unknown>) => void,
 * }} opts
 */
export function createTerminalSubscription({ model, send }) {
	/** @type {"idle" | "capturing" | "live"} */
	let state = "idle";
	let lastSeq = 0;

	const fail = (code, extra = {}) => {
		send({ type: "error", code, ...extra });
	};

	/**
	 * Fresh-snapshot path (first subscribe or unrecoverable cursor). Frame
	 * metadata comes from the captured DTO, so a resize racing the async
	 * capture cannot produce a half-old header.
	 * @param {{ resnapshot?: boolean }} [marks]
	 */
	async function startSnapshot({ resnapshot = false } = {}) {
		state = "capturing";
		try {
			const empty = model.lastSeq === 0;
			const begin = /** @type {Record<string, unknown>} */ ({
				type: "snapshot_begin",
				snapshotSeq: 0,
				cols: model.cols,
				rows: model.rows,
				frameVersion: TERMINAL_FRAME_VERSION,
			});
			if (empty) {
				// Runner (re)started and the new child has produced no output yet:
				// the "host starting" baseline. No frame; live output starts at seq 1.
				begin.empty = true;
				send(begin);
				lastSeq = 0;
				send({ type: "snapshot_end", nextSeq: lastSeq + 1 });
				state = "live";
				return;
			}
			const dto = await captureTerminalSnapshot(model);
			begin.snapshotSeq = dto.snapshotSeq;
			begin.cols = dto.cols;
			begin.rows = dto.rows;
			if (resnapshot) begin.resnapshot = true;
			send(begin);
			send({
				type: "snapshot_frame",
				frameVersion: TERMINAL_FRAME_VERSION,
				data: await synthesizeFullRedrawFrame(dto),
			});
			// Catch-up flush: chunks fed while the capture was in flight (they are
			// already part of the parser state past dto.snapshotSeq, so replaying
			// the ring past that cursor is exact — no gap, no duplicate).
			const after = ringChunksAfter(model, dto.snapshotSeq);
			if (after.evicted) {
				// Ring pressure during capture: refuse to stitch, ask for a redo.
				state = "idle";
				send({ type: "resnapshot_required", lastSeq, missing: dto.snapshotSeq + 1 });
				return;
			}
			for (const chunk of after.chunks) {
				send({ type: "output", seq: chunk.seq, data: chunk.data });
				lastSeq = chunk.seq;
			}
			if (after.chunks.length === 0) lastSeq = dto.snapshotSeq;
			send({ type: "snapshot_end", nextSeq: lastSeq + 1 });
			state = "live";
		} catch (err) {
			state = "idle";
			fail("snapshot_failed", { message: err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * Reconnect path with a still-retained cursor. Fully synchronous: the ring
	 * read and the replay writes cannot interleave with feedOutput, so the
	 * subscription lands in live state with lastSeq === model.lastSeq.
	 * @param {number} sinceSeq
	 */
	function startReplay(sinceSeq) {
		const after = ringChunksAfter(model, sinceSeq);
		for (const chunk of after.chunks) {
			send({ type: "output", seq: chunk.seq, data: chunk.data });
		}
		lastSeq = model.lastSeq;
		state = "live";
	}

	/**
	 * Handle one client→runner terminal message. Returns true when consumed.
	 *
	 * `subscribe_terminal` is the only message of this protocol. Defensive
	 * frameVersion gate: a client that carries a `frameVersion` we do not emit
	 * is rejected up front instead of receiving a frame it cannot parse.
	 *
	 * @param {any} msg
	 * @returns {boolean}
	 */
	function handleMessage(msg) {
		if (!msg || msg.type !== "subscribe_terminal") return false;
		if (msg.frameVersion !== undefined && msg.frameVersion !== TERMINAL_FRAME_VERSION) {
			fail("frame_version_mismatch", { supported: TERMINAL_FRAME_VERSION, received: msg.frameVersion });
			return true;
		}
		if (
			msg.sinceSeq !== undefined &&
			(!Number.isInteger(msg.sinceSeq) || msg.sinceSeq < 0)
		) {
			fail("invalid_since_seq", { sinceSeq: msg.sinceSeq });
			return true;
		}
		if (state === "capturing") return true; // snapshot already in flight; ignore duplicates
		if (msg.sinceSeq === undefined) {
			void startSnapshot();
		} else if (msg.sinceSeq > model.lastSeq || msg.sinceSeq < model.evictedThrough) {
			// Client ahead of the runner (foreign cursor) or needs an evicted
			// range: both mean "no shared baseline" — fresh snapshot, marked so
			// the client discards its local buffer first.
			void startSnapshot({ resnapshot: true });
		} else {
			// Ring invariant: (evictedThrough, lastSeq] is always contiguous, so
			// sinceSeq === evictedThrough is a COMPLETE replay, not a partial tail.
			startReplay(msg.sinceSeq);
		}
		return true;
	}

	/**
	 * Live fan-out for one chunk. Called by the runner for every chunk it
	 * broadcasts, in feed order. No-op while a snapshot is in flight (the
	 * catch-up flush owns delivery for that window).
	 *
	 * @param {number} seq
	 * @param {string} data
	 */
	function onOutput(seq, data) {
		if (state !== "live") return;
		if (seq === lastSeq + 1) {
			lastSeq = seq;
			send({ type: "output", seq, data });
			return;
		}
		// Gap: never skip silently, never fabricate. One marker, then the client
		// must re-subscribe (fresh snapshot or replay from its real cursor).
		state = "idle";
		send({ type: "resnapshot_required", lastSeq, missing: seq });
	}

	return {
		handleMessage,
		onOutput,
		/** Socket went away; the runner drops its reference. */
		detach() {
			state = "idle";
		},
	};
}
