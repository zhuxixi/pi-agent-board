/**
 * Runner-side DCS frame-marker stream parser (issue #222, step 23b1, FW-03).
 *
 * The child reporter writes FROZEN DCS markers into the same ordered stdout stream as
 * the TUI output (`src/core/attach-frame-proof.mjs` owns the literals and validation).
 * This module splits that stream at exact marker boundaries so marker bytes never reach
 * the canonical xterm model, the screen log, the outer Terminal, user input or legacy
 * replay output.
 *
 * ## Contract
 *
 * - Chunks are arbitrary: a marker may be split across PTY reads or coalesced with
 *   ordinary output. A bounded pending tail (<= `MAX_PENDING_MARKER_TAIL` code units)
 *   carries an incomplete DCS tail into the next chunk.
 * - A complete marker is validated by `decodeFrameMarker` and additionally against the
 *   reporter instance: token match, S -> F/A order, strictly increasing frameId,
 *   one open candidate at a time, no duplicate F/A, no F/A without S. Any violation is a
 *   `protocol-error` — never a proof. Marker bytes are dropped in every case.
 * - Unknown non-marker DCS (`ESC P …`) is ordinary output and keeps legacy behaviour.
 *   A DCS that starts like the marker family but never validates is dropped with a
 *   bounded diagnostic and can never enable modern proof.
 * - `proof.seq` is assigned by the CALLER to the sequence of the preceding ordinary
 *   output SEGMENT (not a child frameId, not socket timing). Multiple proofs at the same
 *   seq keep production order.
 * - A pending partial marker at `finish()` is invalid, never a proof.
 *
 * `seq` values here are placeholders (`seq: null`); `runner/pty-runner.mjs` fills them
 * with the real output sequence of the preceding segment.
 */

import { decodeFrameMarker } from "./attach-frame-proof.mjs";

export const FRAME_STREAM_PROTOCOL = 1;
export const MAX_PENDING_MARKER_TAIL = 4096;
export const MAX_STREAM_DIAGNOSTICS = 64;
export const MAX_PROOF_HISTORY = 256;
export const MAX_FINISHED_FRAME_IDS = 4096;

const DCS_INTRO = "\u001bP";
const MARKER_PREFIX = "\u001bP> agent-board-frame/1 ; ";

function bytes(text) {
	return Buffer.byteLength(text, "utf8");
}

/**
 * @param {{token: string, instanceId: string, sessionEpoch?: number, maxPending?: number}} options
 */
export function createFrameStreamParser({ token, instanceId, sessionEpoch = 0, maxPending = MAX_PENDING_MARKER_TAIL }) {
	if (typeof token !== "string" || token.length === 0) throw new Error("frame stream parser requires a reporter token");
	const state = {
		token,
		instanceId,
		sessionEpoch,
		pending: "",
		pendingBytes: 0,
		lastFrameId: 0,
		openFrameId: null,
		finishedFrameIds: new Set(),
		proofs: [],
		diagnostics: [],
		segments: 0,
		markers: 0,
		droppedProofs: 0,
		droppedFinishedIds: 0,
	};
	const diagnostic = (reason, extra = {}) => {
		state.diagnostics.push({ reason, ...extra });
		if (state.diagnostics.length > MAX_STREAM_DIAGNOSTICS) state.diagnostics.splice(0, state.diagnostics.length - MAX_STREAM_DIAGNOSTICS);
	};

	/** Accept one marker literal; returns a proof part or null (with a diagnostic). */
	function acceptMarker(literal) {
		if (bytes(literal) > maxPending) {
			diagnostic("marker-oversize", { bytes: bytes(literal) });
			return null;
		}
		let decoded = null;
		try {
			decoded = decodeFrameMarker(literal);
		} catch {
			decoded = null;
		}
		if (decoded === null) {
			diagnostic("marker-invalid");
			return null;
		}
		if (decoded.token !== state.token) {
			diagnostic("marker-wrong-token");
			return null;
		}
		if (decoded.kind === "S") {
			if (state.openFrameId !== null) {
				diagnostic("marker-s-with-open-candidate", { openFrameId: state.openFrameId, frameId: decoded.frameId });
				return null;
			}
			if (state.finishedFrameIds.has(decoded.frameId)) {
				diagnostic("marker-duplicate-s", { frameId: decoded.frameId });
				return null;
			}
			if (decoded.frameId <= state.lastFrameId) {
				diagnostic("marker-frameid-regression", { frameId: decoded.frameId, lastFrameId: state.lastFrameId });
				return null;
			}
			state.lastFrameId = decoded.frameId;
			state.openFrameId = decoded.frameId;
			state.markers += 1;
			// Additive S/candidate part: F/A proofs and `state.proofs` semantics stay
			// unchanged; the runner routes this record separately.
			return {
				kind: "candidate",
				candidate: {
					marker: "S",
					frameId: decoded.frameId,
					seq: null,
					sessionEpoch: state.sessionEpoch,
					intentId: decoded.intentId,
					sampledCols: decoded.sampledCols,
				},
			};
		}
		if (state.openFrameId === null || state.openFrameId !== decoded.frameId) {
			diagnostic("marker-close-without-open-s", { frameId: decoded.frameId, openFrameId: state.openFrameId });
			return null;
		}
		state.openFrameId = null;
		state.finishedFrameIds.add(decoded.frameId);
		if (state.finishedFrameIds.size > MAX_FINISHED_FRAME_IDS) {
			const oldest = state.finishedFrameIds.values().next().value;
			state.finishedFrameIds.delete(oldest);
			state.droppedFinishedIds += 1;
		}
		state.markers += 1;
		// F5/F8: the ACCEPTED proof is stored here and the SAME object is returned, so the
		// runner can assign `proof.seq` and snapshot/finish report the real proofs (no
		// second divergent list).
		const proof = {
			marker: decoded.kind,
			frameId: decoded.frameId,
			seq: null,
			sessionEpoch: state.sessionEpoch,
			...(decoded.kind === "F" ? { metadata: decoded.metadata } : { reason: decoded.reason }),
		};
		state.proofs.push(proof);
		if (state.proofs.length > MAX_PROOF_HISTORY) {
			state.proofs.shift();
			state.droppedProofs += 1;
		}
		return { kind: "proof", proof };
	}

	/**
	 * Feed one arbitrary chunk. Returns ordered parts:
	 * `{kind:"output", data}` for ordinary bytes, `{kind:"candidate", candidate}` for an
	 * accepted S boundary, and `{kind:"proof", proof}` for a completed F/A witness.
	 * S/F/A `seq` is filled by the caller.
	 */
	function push(chunk) {
		const parts = [];
		if (typeof chunk !== "string" || chunk.length === 0) return parts;
		let text = state.pending + chunk;
		state.pending = "";
		state.pendingBytes = 0;
		let index = 0;
		const emitOutput = (data) => {
			if (data.length === 0) return;
			state.segments += 1;
			parts.push({ kind: "output", data });
		};
		while (index < text.length) {
			const intro = text.indexOf(DCS_INTRO, index);
			if (intro < 0) {
				// A trailing lone ESC may be the first byte of a split introducer: carry it.
				if (text.endsWith("\u001b")) {
					emitOutput(text.slice(index, text.length - 1));
					state.pending = "\u001b";
					state.pendingBytes = 1;
				} else {
					emitOutput(text.slice(index));
				}
				index = text.length;
				break;
			}
			if (intro > index) emitOutput(text.slice(index, intro));
			const terminator = text.indexOf("\u001b\\", intro + 2);
			const prefixLookalike = text.startsWith(MARKER_PREFIX, intro);
			if (terminator < 0) {
				// Incomplete DCS tail: ALWAYS carry it into the next chunk (bounded), so a
				// marker split character-by-character never leaks bytes. Only a tail that
				// exceeds the bound is resolved here: a marker-family tail is dropped with a
				// diagnostic, any other DCS keeps legacy behaviour and is emitted as output.
				const tail = text.slice(intro);
				if (bytes(tail) > maxPending) {
					if (prefixLookalike || tail.startsWith(MARKER_PREFIX.slice(0, Math.min(tail.length, MARKER_PREFIX.length)))) {
						diagnostic("marker-tail-oversize", { bytes: bytes(tail) });
					} else {
						emitOutput(tail);
					}
					index = text.length;
					break;
				}
				state.pending = tail;
				state.pendingBytes = bytes(tail);
				index = text.length;
				break;
			}
			const literal = text.slice(intro, terminator + 2);
			if (prefixLookalike) {
				const accepted = acceptMarker(literal);
				if (accepted !== null) parts.push(accepted);
			} else {
				// Unknown DCS is ordinary output (legacy behaviour).
				emitOutput(literal);
			}
			index = terminator + 2;
		}
		text = "";
		return parts;
	}

	/**
	 * End of stream. A pending marker-family tail or an open candidate is invalid (never a
	 * proof); a trailing ORDINARY byte (e.g. a lone ESC or a non-marker partial DCS) is
	 * returned as `trailing` so the caller can forward it to the normal output path
	 * instead of dropping legitimate child output.
	 */
	function finish(reason = "stream-end") {
		let trailing = "";
		if (state.pending.length > 0) {
			// Only an actual marker-family prefix is invalid at end; a lone ESC or any
			// other partial DCS is ordinary child output and must be forwarded.
			const markerFamily = state.pending.startsWith(MARKER_PREFIX) || (state.pending.startsWith("\u001bP") && MARKER_PREFIX.startsWith(state.pending));
			if (markerFamily) {
				diagnostic("pending-marker-at-end", { at: reason, bytes: state.pendingBytes });
			} else {
				trailing = state.pending;
			}
			state.pending = "";
			state.pendingBytes = 0;
		}
		if (state.openFrameId !== null) {
			diagnostic("open-candidate-at-end", { frameId: state.openFrameId, at: reason });
			state.openFrameId = null;
		}
		return { diagnostics: state.diagnostics.slice(), proofs: state.proofs.slice(), trailing };
	}

	function snapshot() {
		return {
			protocol: FRAME_STREAM_PROTOCOL,
			instanceId: state.instanceId,
			sessionEpoch: state.sessionEpoch,
			segments: state.segments,
			markers: state.markers,
			lastFrameId: state.lastFrameId,
			openFrameId: state.openFrameId,
			pendingBytes: state.pendingBytes,
			proofs: state.proofs.slice(),
			diagnostics: state.diagnostics.slice(),
			droppedProofs: state.droppedProofs,
			droppedFinishedIds: state.droppedFinishedIds,
		};
	}

	return { push, finish, snapshot, state };
}
