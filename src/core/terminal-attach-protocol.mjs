import { validateFrameMetadata } from "./attach-frame-proof.mjs";
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
 *
 * Ownership contract (runner seam): once a socket speaks `subscribe_terminal`,
 * its output stream is owned by this state machine — the runner must exclude it
 * from the legacy fire-and-forget output broadcast (`subscribed()` is the
 * sticky marker for that exclusion). Delivering both streams would duplicate
 * every chunk.
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
/** Optional per-socket view-proof capability (issue #222 FW-06, step 23b2b). */
export const VIEW_PROOF_PROTOCOL_VERSION = 1;
/** Bounded per-socket capture queue for S/F/A marker records. */
export const MAX_VIEW_PROOF_RECORDS = 256;

export { TERMINAL_SNAPSHOT_VERSION };

function unknownCoverage(reason) {
	return { status: "unknown", reason, proof: null, throughSeq: null, cursorVisible: null };
}

function emptyBaselineCoverage() {
	return unknownCoverage("empty-baseline");
}

/** Strip everything except the bounded view-proof record fields (never token/user text). */
export function sanitizeViewProofRecord(record) {
	if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
	if (record.marker !== "S" && record.marker !== "F" && record.marker !== "A") return null;
	if (!Number.isInteger(record.seq) || record.seq < 1) return null;
	if (!Number.isInteger(record.frameId) || record.frameId < 1) return null;
	if (record.sessionEpoch !== undefined && (!Number.isInteger(record.sessionEpoch) || record.sessionEpoch < 0)) return null;
	const base = {
		marker: record.marker,
		seq: record.seq,
		frameId: record.frameId,
		...(record.sessionEpoch === undefined ? {} : { sessionEpoch: record.sessionEpoch }),
	};
	if (record.marker === "S") {
		return {
			...base,
			...(Number.isInteger(record.intentId) ? { intentId: record.intentId } : {}),
			...(Number.isInteger(record.sampledCols) ? { sampledCols: record.sampledCols } : {}),
		};
	}
	if (record.marker === "F") {
		const metadata = validateFrameMetadata(record.metadata);
		if (!metadata.ok) return null;
		if (record.sessionEpoch !== undefined && record.sessionEpoch !== metadata.value.sessionEpoch) return null;
		return { ...base, metadata: metadata.value };
	}
	return { ...base, ...(typeof record.reason === "string" ? { reason: record.reason } : {}) };
}

/**
 * @typedef {ReturnType<typeof createTerminalSubscription>} TerminalSubscription
 */

/**
 * Create the per-socket terminal subscription state.
 *
 * @param {{
 *   model: import("./terminal-model.mjs").TerminalModel,
 *   send: (msg: Record<string, unknown>) => void,
 *   viewProof?: { coverage: (seq: number) => any, replay: (fromSeq: number, throughSeq: number) => any },
 * }} opts
 */
export function createTerminalSubscription({ model, send: rawSend, generation, viewProof = null }) {
	/** @type {"idle" | "capturing" | "live"} */
	let state = "idle";
	let lastSeq = 0;
	// Optional FW-06 capability: negotiated per socket, never downgraded by a later
	// subscribe_terminal without the field. Queued only while a capture is in flight.
	let viewProofEnabled = false;
	/** @type {any[]} */
	let viewProofQueue = [];
	let viewProofQueueDropped = false;
	let captureViewProofReset = null;
	// Sticky protocol-ownership marker: set the moment a socket speaks
	// subscribe_terminal, never reset (not even by gap downgrade or snapshot
	// failure). The runner excludes subscribed sockets from the legacy output
	// broadcast; delivery then belongs to this state machine alone.
	let subscribed = false;

	// Choke-point guard (CR R1 blocking): every protocol write funnels through
	// this wrapper, so a synchronous socket.write throw can never escape into
	// the runner's uncaughtException crash path (a runner crash kills the
	// hosted child). Pinned semantics (tested): a send-throw is treated like
	// socket death — the subscription downgrades to "idle" silently, further
	// sends are swallowed no-ops, live fan-out stops, and the runner's socket
	// error/close handler owns the actual cleanup. "live" transitions are
	// gated on sendBroken so a throw mid-replay or mid-snapshot cannot
	// resurrect a dead socket into live state.
	let sendBroken = false;
	const send = (msg) => {
		if (sendBroken) return;
		try {
			rawSend(msg);
		} catch {
			sendBroken = true;
			state = "idle";
		}
	};

	const fail = (code, extra = {}) => {
		send({ type: "error", code, ...extra });
	};

	function coverageAt(seq, overrideReason = null) {
		if (overrideReason !== null) return unknownCoverage(overrideReason);
		if (seq === 0) return emptyBaselineCoverage();
		const coverage = viewProof?.coverage?.(seq);
		return coverage && typeof coverage === "object" ? coverage : unknownCoverage("no-frame-witness");
	}

	function clearCaptureViewProof(reason = null) {
		viewProofQueue = [];
		viewProofQueueDropped = false;
		captureViewProofReset = reason;
	}

	function queueViewProofRecord(record) {
		if (viewProofQueue.length >= MAX_VIEW_PROOF_RECORDS) {
			viewProofQueueDropped = true;
			return;
		}
		viewProofQueue.push(record);
	}

	/**
	 * Emit queued S/F/A records in seq order around the ring catch-up. Output at
	 * an equal seq is either already in the snapshot frame (seq <= snapshotSeq)
	 * or emitted first by the caller (seq > snapshotSeq).
	 */
	function flushCaptureViewProofRecords(chunks, snapshotSeq) {
		if (!viewProofEnabled) {
			for (const chunk of chunks) {
				send({ type: "output", seq: chunk.seq, data: chunk.data });
				lastSeq = chunk.seq;
			}
			return;
		}
		if (viewProofQueueDropped) {
			viewProofQueue = [];
			for (const chunk of chunks) {
				send({ type: "output", seq: chunk.seq, data: chunk.data });
				lastSeq = chunk.seq;
			}
			return;
		}
		const records = viewProofQueue.slice();
		viewProofQueue = [];
		const beforeChunks = [];
		const bySeq = new Map();
		const afterChunks = [];
		for (const record of records) {
			if (record.seq <= snapshotSeq) beforeChunks.push(record);
			else {
				const list = bySeq.get(record.seq) ?? [];
				list.push(record);
				bySeq.set(record.seq, list);
			}
		}
		for (const record of beforeChunks) send({ type: "view_proof", record });
		const sentSeqs = new Set();
		for (const chunk of chunks) {
			send({ type: "output", seq: chunk.seq, data: chunk.data });
			lastSeq = chunk.seq;
			sentSeqs.add(chunk.seq);
			for (const record of bySeq.get(chunk.seq) ?? []) send({ type: "view_proof", record });
		}
		for (const [seq, list] of bySeq) {
			if (sentSeqs.has(seq)) continue;
			for (const record of list) afterChunks.push(record);
		}
		// A record can only be missing its catch-up chunk if the ring lost data;
		// do not pretend it was stitched. The end-state coverage marks UNKNOWN.
		if (afterChunks.length > 0) viewProofQueueDropped = true;
	}

	/**
	 * Fresh-snapshot path (first subscribe or unrecoverable cursor). Frame
	 * metadata comes from the captured DTO, so a resize racing the async
	 * capture cannot produce a half-old header.
	 * @param {{ resnapshot?: boolean }} [marks]
	 */
	async function startSnapshot({ resnapshot = false } = {}) {
		state = "capturing";
		clearCaptureViewProof(null);
		try {
			const empty = model.lastSeq === 0;
			const begin = /** @type {Record<string, unknown>} */ ({
				type: "snapshot_begin",
				snapshotSeq: 0,
				cols: model.cols,
				rows: model.rows,
				frameVersion: TERMINAL_FRAME_VERSION,
				// Runner boot identity (issue #91 phase 5): lets a reconnecting
				// client detect a runner replacement from the snapshot answer alone.
				...(generation ? { generation } : {}),
			});
			if (empty) {
				// Runner (re)started and the new child has produced no output yet:
				// the "host starting" baseline. No frame; live output starts at seq 1.
				// The resnapshot marker applies here too: a client presenting a stale
				// cursor must discard its local buffer either way (whole-branch review:
				// marker contract must be consistent across resnapshot paths).
				begin.empty = true;
				if (resnapshot) begin.resnapshot = true;
				if (viewProofEnabled) begin.viewProof = emptyBaselineCoverage();
				send(begin);
				lastSeq = 0;
				send({
					type: "snapshot_end",
					nextSeq: lastSeq + 1,
					scrollbackLines: 0,
					...(viewProofEnabled ? { viewProof: emptyBaselineCoverage() } : {}),
				});
				if (!sendBroken) state = "live";
				return;
			}
			const dto = await captureTerminalSnapshot(model);
			begin.snapshotSeq = dto.snapshotSeq;
			begin.cols = dto.cols;
			begin.rows = dto.rows;
			if (resnapshot) begin.resnapshot = true;
			if (viewProofEnabled) begin.viewProof = coverageAt(dto.snapshotSeq, captureViewProofReset);
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
				clearCaptureViewProof(null);
				send({ type: "resnapshot_required", lastSeq, missing: dto.snapshotSeq + 1 });
				return;
			}
			flushCaptureViewProofRecords(after.chunks, dto.snapshotSeq);
			if (after.chunks.length === 0) lastSeq = dto.snapshotSeq;
			// scrollbackLines is the runner-authoritative history count for the very
			// frame just sent (same capture): the client needs it to tell real history
			// from rows its local hydration scrolled out of the viewport (issue #205).
			const endCoverageReason = captureViewProofReset ?? (viewProofQueueDropped ? "view-proof-records-dropped" : null);
			send({
				type: "snapshot_end",
				nextSeq: lastSeq + 1,
				scrollbackLines: dto.scrollback.length,
				...(viewProofEnabled ? { viewProof: coverageAt(lastSeq, endCoverageReason) } : {}),
			});
			clearCaptureViewProof(null);
			if (!sendBroken) state = "live";
		} catch (err) {
			state = "idle";
			clearCaptureViewProof(null);
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
		if (after.evicted) {
			state = "idle";
			send({ type: "resnapshot_required", lastSeq, missing: sinceSeq + 1 });
			return;
		}
		const hasRange = model.lastSeq > sinceSeq;
		const replayResult = viewProofEnabled && hasRange ? viewProof?.replay?.(sinceSeq + 1, model.lastSeq) : null;
		let proofBySeq = null;
		let proofProblem = null;
		if (viewProofEnabled && hasRange) {
			if (replayResult === null || replayResult === undefined) proofProblem = "no-frame-witness";
			else if (replayResult.status !== "ok") proofProblem = `proof-replay-${replayResult.reason ?? replayResult.status}`;
			else if (replayResult.entries.some((entry) => entry.droppedProofs > 0 || entry.droppedEvents > 0)) proofProblem = "proof-replay-dropped";
			else {
				const chunkSeqs = new Set(after.chunks.map((chunk) => chunk.seq));
				const map = new Map();
				for (const entry of replayResult.entries) {
					if (entry.proofs.length === 0) continue;
					if (!chunkSeqs.has(entry.seq)) {
						proofProblem = "proof-replay-gap";
						break;
					}
					map.set(entry.seq, entry.proofs);
				}
				if (proofProblem === null) proofBySeq = map;
			}
		}
		for (const chunk of after.chunks) {
			send({ type: "output", seq: chunk.seq, data: chunk.data });
			if (proofBySeq !== null) {
				for (const proof of proofBySeq.get(chunk.seq) ?? []) {
					const record = sanitizeViewProofRecord(proof);
					if (record !== null) send({ type: "view_proof", record });
				}
			}
		}
		lastSeq = model.lastSeq;
		if (viewProofEnabled) send({ type: "view_proof_state", viewProof: coverageAt(lastSeq, proofProblem) });
		if (!sendBroken) state = "live";
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
		// Every subscribe_terminal speaker is protocol-managed from here on,
		// including rejected ones (frameVersion mismatch, invalid cursor): the
		// legacy broadcast stream must never interleave with this protocol.
		subscribed = true;
		if (msg.frameVersion !== undefined && msg.frameVersion !== TERMINAL_FRAME_VERSION) {
			fail("frame_version_mismatch", { supported: TERMINAL_FRAME_VERSION, received: msg.frameVersion });
			return true;
		}
		if (msg.viewProof !== undefined) {
			if (msg.viewProof !== VIEW_PROOF_PROTOCOL_VERSION) {
				fail("view_proof_version_mismatch", { supported: VIEW_PROOF_PROTOCOL_VERSION, received: msg.viewProof });
				return true;
			}
			viewProofEnabled = true;
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
			// .catch belt-and-braces (CR R1): the snapshot flow already funnels
			// failures into fail() — which is now throw-safe via the choke point —
			// but a stray rejection must never surface as an unhandledRejection
			// crash (the runner treats that as fatal).
			void startSnapshot().catch(() => {});
		} else if (msg.sinceSeq > model.lastSeq || msg.sinceSeq < model.evictedThrough) {
			// Client ahead of the runner (foreign cursor) or needs an evicted
			// range: both mean "no shared baseline" — fresh snapshot, marked so
			// the client discards its local buffer first.
			void startSnapshot({ resnapshot: true }).catch(() => {});
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
		clearCaptureViewProof(null);
		send({ type: "resnapshot_required", lastSeq, missing: seq });
	}

	/** Live/capture delivery of one accepted S/F/A record (opt-in sockets only). */
	function onViewProofRecord(record) {
		if (!viewProofEnabled) return;
		const clean = sanitizeViewProofRecord(record);
		if (clean === null) return;
		if (state === "live") send({ type: "view_proof", record: clean });
		else if (state === "capturing") queueViewProofRecord(clean);
	}

	/**
	 * Reporter replacement/close: drop queued old-token records and force current
	 * view-proof state UNKNOWN. Never carries old proofs into a new reporter.
	 */
	function onViewProofReset(reason) {
		viewProofQueue = [];
		viewProofQueueDropped = false;
		if (!viewProofEnabled) return;
		if (state === "capturing") {
			captureViewProofReset = reason;
			return;
		}
		if (state === "live") send({ type: "view_proof_state", viewProof: unknownCoverage(reason) });
	}

	return {
		handleMessage,
		onOutput,
		onViewProofRecord,
		onViewProofReset,
		/** Sticky: true once the socket sent subscribe_terminal. The runner uses
		 *  this to keep the socket out of the legacy output broadcast. */
		subscribed: () => subscribed,
		/** Socket went away; the runner drops its reference. */
		detach() {
			state = "idle";
			clearCaptureViewProof(null);
		},
	};
}
