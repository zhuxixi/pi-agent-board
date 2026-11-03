/**
 * Pure attach view-proof coverage and safe-trailing classification (issue #222, step 23b2a).
 *
 * This module is deliberately inert: no sockets, files, timers, terminals, fs or full
 * scrollback. It owns the FW-06 decisions that a future runner/subscription (23b2b) and
 * attach consumer (23b2c) must share, so both can be unit-tested without a PTY:
 *
 * 1. `createSafeTrailingClassifier()` — a streaming, bounded, grammar-aware classifier for
 *    the EXHAUSTIVE §5 post-F allowlist. Ordinary output is split arbitrarily; incomplete
 *    CSI/OSC tails are carried across `push()` calls, and unknown, malformed or oversize
 *    input becomes sticky `unsafe`. A complete safe sequence remains an ordinary control
 *    fact (title/progress/query/keyboard mode/DECTCEM): it never becomes a proof and never
 *    erases what the control meant.
 * 2. `createViewProofTracker()` — records ordered output segments (`feedOutput`), producer
 *    candidate boundaries (`openCandidate`/`abortCandidate`) and completed proofs
 *    (`completeProof`), then answers `coverageFor(snapshotSeq)` and bounded `replay()`.
 *
 * Coverage uses `proof.seq`, the preceding ORDINARY output segment sequence — never a
 * child frameId, wall clock or socket arrival order. Exact coverage requires
 * `proof.seq === snapshotSeq`. An older proof is accepted only while every segment after it
 * (through the snapshot) is completely classified safe. Unsafe or pending output,
 * an open/aborted producer candidate, gaps, malformed identity and evicted history stay
 * unavailable/UNKNOWN; they are never stitched into a proof.
 *
 * The journal stores only bounded classification/proof metadata and dropped counts. It
 * never stores output text, raw frames or a copied scrollback. Replay drop counts are
 * deliberately split: aggregate counts are LIFETIME, per-entry counts are RANGE-LOCAL, and
 * range completeness comes from the entries plus explicit gap/evicted status — never from a
 * lifetime count alone.
 *
 * `snapshot().currentProof` is the last COMPLETED proof only. It is not coverage: output may
 * have arrived after it, a candidate may be open, or the journal may be truncated. Callers
 * that need a display decision must use `coverageFor(snapshotSeq)`.
 */
import { validateFrameMetadata } from "./attach-frame-proof.mjs";

export const VIEW_PROOF_PROTOCOL = 1;
/** Maximum carried/incomplete escape tail and complete classifiable sequence size, in UTF-8 BYTES. */
export const MAX_TRAILING_PENDING = 4096;
export const MAX_VIEW_PROOF_JOURNAL = 256;
export const MAX_VIEW_PROOF_DIAGNOSTICS = 64;
export const MAX_PROOFS_PER_SEQ = 16;
export const MAX_EVENTS_PER_SEQ = 16;

const ESC = "\u001b";
const BEL = "\u0007";
const CSI_FINAL = /[@-~]/;
const CSI_PARAM_OR_INTERMEDIATE = /[\x20-\x3f]/;
const DCS_INTRO = "\u001bP";
const SOS_INTRO = "\u001bX";
const PM_INTRO = "\u001b^";
const APC_INTRO = "\u001b_";

function utf8Bytes(text) {
	return Buffer.byteLength(text, "utf8");
}

function defaultMetadata() {
	return {
		bracketedPaste: null,
		colorSchemeNotifications: null,
		keyboardProtocolPushes: 0,
		keyboardProtocolPops: 0,
		keyboardProtocolQueries: 0,
		modifyOtherKeys: null,
		cellSizeQueries: 0,
		deviceAttributesQueries: 0,
		paletteQueries: 0,
		titles: 0,
		progress: null,
		programStatuses: 0,
	};
}

function cloneMetadata(metadata) {
	return { ...metadata, progress: metadata.progress === null ? null : { ...metadata.progress } };
}

function cloneEvent(event) {
	return event.progress === undefined ? { ...event } : { ...event, progress: { ...event.progress } };
}

function boundEvents(events) {
	const stored = events.slice(0, MAX_EVENTS_PER_SEQ).map(cloneEvent);
	return { events: stored, droppedEvents: Math.max(0, events.length - stored.length) };
}

/**
 * Classify one complete CSI body/final. Returns an event for an exact §5 allowlist item,
 * otherwise `null` (caller marks the sequence unsafe). Plain SGR is intentionally absent:
 * inside a producer frame rendition is annotation, but after F the allowlist is exhaustive.
 */
function classifyCsi(body, final) {
	if (body === "?2004" && (final === "h" || final === "l")) return { family: "bracketed-paste", enabled: final === "h" };
	if (body === "?2031" && (final === "h" || final === "l")) return { family: "color-scheme", enabled: final === "h" };
	if (body === "16" && final === "t") return { family: "cell-size-query" };
	if (body === "" && final === "c") return { family: "device-attributes" };
	if (body === ">7" && final === "u") return { family: "keyboard-protocol-push" };
	if (body === "?" && final === "u") return { family: "keyboard-protocol-query" };
	if ((body === ">4;0" || body === ">4;2") && final === "m") return { family: "modify-other-keys", mode: body === ">4;0" ? 0 : 2 };
	if (body === "<" && final === "u") return { family: "keyboard-protocol-pop" };
	if (body === "?25" && (final === "h" || final === "l")) return { family: "dectcem", visible: final === "h" };
	return null;
}

/**
 * Classify one complete OSC body (bytes between `ESC ]` and BEL/ST). OSC 8, OSC 52 and
 * palette SETTERS are deliberately absent; only the literal §5 queries are accepted.
 * Content-bearing controls retain bounded meaning (title/status byte counts, progress
 * numbers, palette query text) so the caller can still act on them.
 */
function classifyOsc(body) {
	if (body.startsWith("0;")) return { family: "osc-title", bytes: Buffer.byteLength(body.slice(2), "utf8") };
	if (/^9;4;[0-9]+(?:;[0-9]+)?$/.test(body)) {
		const parts = body.split(";");
		const state = Number(parts[2]);
		const percent = parts.length === 4 ? Number(parts[3]) : null;
		return { family: "osc-progress", progress: { state, percent } };
	}
	if (body.startsWith("7501;")) return { family: "osc-program-status", bytes: Buffer.byteLength(body.slice(5), "utf8") };
	if (/^4(;[0-9]+)*;\?$/.test(body) || /^(10|11);\?$/.test(body)) {
		return { family: "osc-palette-query", query: body.slice(0, 64) };
	}
	return null;
}

function applyEvent(metadata, event) {
	switch (event.family) {
		case "bracketed-paste":
			metadata.bracketedPaste = event.enabled;
			return;
		case "color-scheme":
			metadata.colorSchemeNotifications = event.enabled;
			return;
		case "keyboard-protocol-push":
			metadata.keyboardProtocolPushes += 1;
			return;
		case "keyboard-protocol-pop":
			metadata.keyboardProtocolPops += 1;
			return;
		case "keyboard-protocol-query":
			metadata.keyboardProtocolQueries += 1;
			return;
		case "modify-other-keys":
			metadata.modifyOtherKeys = event.mode;
			return;
		case "cell-size-query":
			metadata.cellSizeQueries += 1;
			return;
		case "device-attributes":
			metadata.deviceAttributesQueries += 1;
			return;
		case "osc-title":
			metadata.titles += 1;
			return;
		case "osc-progress":
			metadata.progress = { ...event.progress };
			return;
		case "osc-program-status":
			metadata.programStatuses += 1;
			return;
		case "osc-palette-query":
			metadata.paletteQueries += 1;
			return;
		default:
			return;
	}
}

/** Scan a CSI from its ESC byte. Returns `{end, body, final}`, `{pending}` or `{unsafe}`. */
function scanCsi(text, start, maxPending) {
	let index = start + 2;
	while (index < text.length) {
		const character = text[index];
		if (CSI_FINAL.test(character)) {
			const body = text.slice(start + 2, index);
			if (utf8Bytes(body) > maxPending) return { unsafe: "sequence-oversize" };
			return { end: index + 1, body, final: character };
		}
		if (!CSI_PARAM_OR_INTERMEDIATE.test(character)) return { unsafe: "csi-malformed" };
		index += 1;
	}
	const tail = text.slice(start);
	if (utf8Bytes(tail) > maxPending) return { unsafe: "pending-overflow" };
	return { pending: tail };
}

/** Scan an OSC from its ESC byte, accepting only BEL or ST terminators. */
function scanOsc(text, start, maxPending) {
	let index = start + 2;
	while (index < text.length) {
		const character = text[index];
		if (character === BEL) {
			const body = text.slice(start + 2, index);
			if (utf8Bytes(body) > maxPending) return { unsafe: "sequence-oversize" };
			return { end: index + 1, body };
		}
		if (character === ESC) {
			const next = text[index + 1];
			if (next === undefined) {
				const tail = text.slice(start);
				if (utf8Bytes(tail) > maxPending) return { unsafe: "pending-overflow" };
				return { pending: tail };
			}
			if (next !== "\\") return { unsafe: "osc-malformed" };
			const body = text.slice(start + 2, index);
			if (utf8Bytes(body) > maxPending) return { unsafe: "sequence-oversize" };
			return { end: index + 2, body };
		}
		if (character < " " || character === "\u007f") return { unsafe: "osc-malformed" };
		index += 1;
	}
	const tail = text.slice(start);
	if (utf8Bytes(tail) > maxPending) return { unsafe: "pending-overflow" };
	return { pending: tail };
}

/**
 * Streaming exporter for the post-F no-grid control window.
 *
 * `push(chunk)` returns `{status, reason, events, droppedEvents, pendingBytes,
 * cursorVisible, metadata}` where status is exactly `safe`, `pending` or `unsafe`, and
 * `pendingBytes` is a UTF-8 byte count. `pending` is NOT safe: an incomplete escape tail has
 * not been classified yet. Once `unsafe`, the classifier stays unsafe until `reset()` (the
 * caller resets only on a new complete producer proof).
 */
export function createSafeTrailingClassifier({ maxPending = MAX_TRAILING_PENDING } = {}) {
	if (!Number.isInteger(maxPending) || maxPending < 16) throw new Error("safe trailing classifier requires maxPending >= 16");
	let pending = "";
	let unsafeReason = null;
	let cursorVisible = null;
	let metadata = defaultMetadata();

	const result = (status, events) => {
		const bounded = boundEvents(events);
		return {
			status,
			reason: unsafeReason,
			events: bounded.events,
			droppedEvents: bounded.droppedEvents,
			pendingBytes: utf8Bytes(pending),
			cursorVisible,
			metadata: cloneMetadata(metadata),
		};
	};
	const markUnsafe = (reason) => {
		unsafeReason = reason;
		pending = "";
	};

	function push(chunk) {
		if (unsafeReason !== null) return result("unsafe", []);
		if (typeof chunk !== "string") {
			markUnsafe("invalid-input");
			return result("unsafe", []);
		}
		const text = pending + chunk;
		pending = "";
		const events = [];
		let index = 0;
		while (index < text.length) {
			if (text[index] !== ESC) {
				markUnsafe("bare-byte");
				break;
			}
			const next = text[index + 1];
			if (next === undefined) {
				pending = text.slice(index);
				break;
			}
			if (next === "[") {
				const scanned = scanCsi(text, index, maxPending);
				if (scanned.unsafe !== undefined) {
					markUnsafe(scanned.unsafe);
					break;
				}
				if (scanned.pending !== undefined) {
					pending = scanned.pending;
					break;
				}
				const event = classifyCsi(scanned.body, scanned.final);
				if (event === null) {
					markUnsafe("csi-unknown");
					break;
				}
				events.push(event);
				applyEvent(metadata, event);
				if (event.family === "dectcem") cursorVisible = event.visible;
				index = scanned.end;
				continue;
			}
			if (next === "]") {
				const scanned = scanOsc(text, index, maxPending);
				if (scanned.unsafe !== undefined) {
					markUnsafe(scanned.unsafe);
					break;
				}
				if (scanned.pending !== undefined) {
					pending = scanned.pending;
					break;
				}
				const event = classifyOsc(scanned.body);
				if (event === null) {
					markUnsafe("osc-unknown");
					break;
				}
				events.push(event);
				applyEvent(metadata, event);
				index = scanned.end;
				continue;
			}
			if (text.startsWith(DCS_INTRO, index)) markUnsafe("dcs");
			else if (text.startsWith(SOS_INTRO, index) || text.startsWith(PM_INTRO, index) || text.startsWith(APC_INTRO, index)) markUnsafe("string-control");
			else markUnsafe("escape-unknown");
			break;
		}
		if (unsafeReason !== null) return result("unsafe", events);
		if (utf8Bytes(pending) > maxPending) {
			markUnsafe("pending-overflow");
			return result("unsafe", events);
		}
		return result(pending.length > 0 ? "pending" : "safe", events);
	}

	/**
	 * Start a new trailing window after a complete proof. The sticky unsafe/pending state is
	 * cleared and cursor visibility comes from the new proof (null means UNKNOWN); terminal
	 * metadata such as an already-set title or keyboard mode is retained because a later
	 * frame does not erase what those controls meant.
	 */
	/** @param {{ cursorVisible?: boolean }} [options] */
	function reset({ cursorVisible: initialCursor = null } = {}) {
		pending = "";
		unsafeReason = null;
		cursorVisible = typeof initialCursor === "boolean" ? initialCursor : null;
	}

	function state() {
		return {
			status: unsafeReason !== null ? "unsafe" : pending.length > 0 ? "pending" : "safe",
			reason: unsafeReason,
			pendingBytes: utf8Bytes(pending),
			cursorVisible,
			metadata: cloneMetadata(metadata),
		};
	}

	return { push, reset, state };
}

// ---------------------------------------------------------------------------
// Proof tracker
// ---------------------------------------------------------------------------

const PROOF_FIELDS = new Set(["marker", "kind", "frameId", "seq", "sessionEpoch", "metadata", "cursorVisible"]);

function validateCandidate(record) {
	if (record === null || typeof record !== "object" || Array.isArray(record)) return { ok: false, reason: "candidate-not-object" };
	if (!Number.isInteger(record.seq) || record.seq < 1) return { ok: false, reason: "candidate-seq" };
	if (!Number.isInteger(record.frameId) || record.frameId < 1) return { ok: false, reason: "candidate-frame-id" };
	if (record.sessionEpoch !== undefined && (!Number.isInteger(record.sessionEpoch) || record.sessionEpoch < 0)) return { ok: false, reason: "candidate-session-epoch" };
	return { ok: true, seq: record.seq, frameId: record.frameId, sessionEpoch: record.sessionEpoch ?? 0 };
}

function validateProof(record) {
	if (record === null || typeof record !== "object" || Array.isArray(record)) return { ok: false, reason: "proof-not-object" };
	if (record.reason !== undefined) return { ok: false, reason: "proof-reason" };
	for (const key of Object.keys(record)) {
		if (!PROOF_FIELDS.has(key)) return { ok: false, reason: `proof-unexpected-field:${key}` };
	}
	if (record.marker !== undefined && record.marker !== "F") return { ok: false, reason: "proof-marker" };
	if (record.kind !== undefined && record.kind !== "F") return { ok: false, reason: "proof-kind" };
	if (!Number.isInteger(record.seq) || record.seq < 1) return { ok: false, reason: "proof-seq" };
	if (!Number.isInteger(record.frameId) || record.frameId < 1) return { ok: false, reason: "proof-frame-id" };
	if (record.sessionEpoch !== undefined && (!Number.isInteger(record.sessionEpoch) || record.sessionEpoch < 0)) return { ok: false, reason: "proof-session-epoch" };
	if (record.cursorVisible !== undefined && typeof record.cursorVisible !== "boolean") return { ok: false, reason: "proof-cursor-visible" };
	if (record.metadata === undefined || record.metadata === null) return { ok: false, reason: "proof-metadata-missing" };
	const validation = validateFrameMetadata(record.metadata);
	if (!validation.ok) return { ok: false, reason: `proof-metadata:${validation.reason}` };
	const sessionEpoch = record.sessionEpoch === undefined ? validation.value.sessionEpoch : record.sessionEpoch;
	if (sessionEpoch !== validation.value.sessionEpoch) return { ok: false, reason: "proof-session-epoch-conflict" };
	return {
		ok: true,
		marker: "F",
		seq: record.seq,
		frameId: record.frameId,
		sessionEpoch,
		cursorVisible: record.cursorVisible ?? null,
		metadata: validation.value,
	};
}

function validateAbort(record) {
	const candidate = validateCandidate(record);
	if (!candidate.ok) return candidate;
	if (record.reason !== undefined && typeof record.reason !== "string") return { ok: false, reason: "abort-reason" };
	return { ...candidate, reason: record.reason ?? null };
}

function cloneProof(proof) {
	if (proof === null) return null;
	return { ...proof, metadata: proof.metadata === null ? null : { ...proof.metadata } };
}

function cloneEntry(entry) {
	return {
		seq: entry.seq,
		status: entry.status,
		reason: entry.reason,
		events: entry.events.map(cloneEvent),
		droppedEvents: entry.droppedEvents,
		droppedProofs: entry.droppedProofs,
		pendingBytes: entry.pendingBytes,
		cursorVisible: entry.cursorVisible,
		proofs: entry.proofs.map(cloneProof),
	};
}

/**
 * Create the ordered view-proof tracker. `feedOutput` must receive contiguous output
 * segment sequence numbers (a first arbitrary number is accepted as the tracker's
 * baseline); one missing number is a protocol error and keeps coverage UNKNOWN.
 */
export function createViewProofTracker({ maxJournal = MAX_VIEW_PROOF_JOURNAL, maxPending = MAX_TRAILING_PENDING, maxDiagnostics = MAX_VIEW_PROOF_DIAGNOSTICS } = {}) {
	if (!Number.isInteger(maxJournal) || maxJournal < 1) throw new Error("view proof tracker requires maxJournal >= 1");
	if (!Number.isInteger(maxDiagnostics) || maxDiagnostics < 1) throw new Error("view proof tracker requires maxDiagnostics >= 1");
	const classifier = createSafeTrailingClassifier({ maxPending });
	const journal = new Map();
	const diagnostics = [];
	let firstSeq = null;
	let lastOutputSeq = 0;
	let lastProofSeq = 0;
	let lastFrameId = 0;
	let candidate = null;
	let candidateState = "idle"; // idle | open | aborted
	let currentProof = null;
	let previousComplete = null;
	let gap = false;
	let pendingSinceSeq = null;
	let droppedSegments = 0;
	let droppedProofs = 0;
	let droppedEvents = 0;

	const diagnostic = (reason, extra = {}) => {
		diagnostics.push({ reason, ...extra });
		if (diagnostics.length > maxDiagnostics) diagnostics.splice(0, diagnostics.length - maxDiagnostics);
	};

	const protocolError = (reason, extra = {}) => {
		diagnostic(reason, extra);
		return { status: "protocol-error", reason, ...extra };
	};

	const earliestRetainedSeq = () => (journal.size === 0 ? null : journal.keys().next().value);

	function insertEntry(entry) {
		journal.set(entry.seq, entry);
		if (journal.size > maxJournal) {
			const oldest = journal.keys().next().value;
			const evicted = journal.get(oldest);
			journal.delete(oldest);
			droppedSegments += 1;
			// Per-entry drops were already counted at truncation time; eviction adds only the
			// proofs still retained in the evicted entry. Adding entry.droppedProofs here would
			// double count the lifetime aggregate.
			droppedProofs += evicted.proofs.length;
		}
	}

	function findNewestProofAtOrBefore(snapshotSeq) {
		let found = null;
		for (const entry of journal.values()) {
			for (const proof of entry.proofs) if (proof.seq <= snapshotSeq) found = proof;
		}
		if (found === null && currentProof !== null && currentProof.seq <= snapshotSeq) return { proof: currentProof, evicted: true };
		return { proof: found, evicted: false };
	}

	function setPendingEntriesStatus(fromSeq, throughSeq, status, reason) {
		for (const entry of journal.values()) {
			if (entry.seq >= fromSeq && entry.seq <= throughSeq && entry.status === "pending") {
				entry.status = status;
				entry.reason = reason;
			}
		}
	}

	/**
	 * Feed one ordinary output segment. `seq` is the ordered output segment number, not a
	 * child frame id. The text is classified only; no copy of it is retained.
	 */
	function feedOutput(seq, data) {
		if (!Number.isInteger(seq) || seq < 1) return protocolError("invalid-output-seq", { seq });
		if (typeof data !== "string") return protocolError("invalid-output-data", { seq });
		if (firstSeq === null) {
			firstSeq = seq;
			lastOutputSeq = seq;
		} else if (seq <= lastOutputSeq) {
			return protocolError("output-seq-regressed", { seq, lastOutputSeq });
		} else if (seq !== lastOutputSeq + 1) {
			gap = true;
			const expected = lastOutputSeq + 1;
			lastOutputSeq = seq;
			insertEntry({ seq, status: "unknown", reason: "output-gap", events: [], droppedEvents: 0, droppedProofs: 0, pendingBytes: 0, cursorVisible: null, proofs: [] });
			return protocolError("output-gap", { seq, expected });
		} else {
			lastOutputSeq = seq;
		}
		const wasPending = classifier.state().status === "pending";
		const pendingFrom = wasPending ? pendingSinceSeq : null;
		const classified = classifier.push(data);
		if (pendingFrom !== null) {
			if (classified.status === "safe") setPendingEntriesStatus(pendingFrom, seq - 1, "safe", null);
			else if (classified.status === "unsafe") setPendingEntriesStatus(pendingFrom, seq - 1, "unsafe", classified.reason);
		}
		if (classified.status === "pending") {
			if (pendingSinceSeq === null) pendingSinceSeq = seq;
		} else {
			pendingSinceSeq = null;
		}
		insertEntry({
			seq,
			status: classified.status,
			reason: classified.reason,
			events: classified.events,
			droppedEvents: classified.droppedEvents,
			droppedProofs: 0,
			pendingBytes: classified.pendingBytes,
			cursorVisible: classified.cursorVisible,
			proofs: [],
		});
		droppedEvents += classified.droppedEvents;
		return {
			status: classified.status,
			reason: classified.reason,
			seq,
			events: classified.events,
			droppedEvents: classified.droppedEvents,
			cursorVisible: classified.cursorVisible,
			metadata: classified.metadata,
		};
	}

	/** Record the S boundary of a producer candidate (preceding output segment seq). */
	function openCandidate(record) {
		const validation = validateCandidate(record);
		if (!validation.ok) return protocolError(validation.reason);
		const { seq, frameId, sessionEpoch } = validation;
		if (firstSeq === null || seq > lastOutputSeq) return protocolError("candidate-seq-future", { seq, lastOutputSeq });
		if (candidateState === "open") return protocolError("candidate-already-open", { openFrameId: candidate.frameId, frameId });
		if (seq < lastProofSeq) return protocolError("candidate-seq-regressed", { seq, lastProofSeq });
		if (frameId <= lastFrameId) return protocolError("frame-id-regressed", { frameId, lastFrameId });
		lastFrameId = frameId;
		previousComplete = cloneProof(currentProof);
		candidate = { seq, frameId, sessionEpoch };
		candidateState = "open";
		return { status: "ok", candidate: { ...candidate } };
	}

	/** Abort an open candidate. The aborted frame can never become a proof. */
	function abortCandidate(record) {
		const validation = validateAbort(record);
		if (!validation.ok) return protocolError(validation.reason);
		const { seq, frameId, reason } = validation;
		if (candidateState !== "open" || candidate === null) return protocolError("abort-without-candidate", { frameId });
		if (candidate.frameId !== frameId) return protocolError("abort-frame-mismatch", { frameId, openFrameId: candidate.frameId });
		if (seq < candidate.seq || seq > lastOutputSeq) return protocolError("abort-seq", { seq, candidateSeq: candidate.seq, lastOutputSeq });
		candidate = null;
		candidateState = "aborted";
		diagnostic("candidate-aborted", { seq, frameId, reason });
		return { status: "ok", candidateState };
	}

	/**
	 * Complete the open candidate. The accepted proof's `seq` is the preceding ordinary
	 * output segment. A new complete proof resets the trailing classifier and supersedes
	 * any same-seq proof already recorded for current coverage.
	 */
	function completeProof(record) {
		const validation = validateProof(record);
		if (!validation.ok) return protocolError(validation.reason);
		const { seq, frameId, sessionEpoch, cursorVisible, metadata } = validation;
		if (candidateState !== "open" || candidate === null) return protocolError("proof-without-candidate", { seq, frameId });
		if (candidate.frameId !== frameId) return protocolError("proof-frame-mismatch", { frameId, openFrameId: candidate.frameId });
		if (candidate.sessionEpoch !== sessionEpoch) return protocolError("proof-session-epoch-mismatch", { sessionEpoch, candidateSessionEpoch: candidate.sessionEpoch });
		if (seq < candidate.seq) return protocolError("proof-seq-before-candidate", { seq, candidateSeq: candidate.seq });
		if (seq > lastOutputSeq) return protocolError("proof-seq-future", { seq, lastOutputSeq });
		if (seq < lastProofSeq) return protocolError("proof-seq-regressed", { seq, lastProofSeq });
		const entry = journal.get(seq);
		if (entry === undefined) return protocolError("proof-seq-not-observed", { seq });
		const proof = { marker: "F", seq, frameId, sessionEpoch, metadata, cursorVisible };
		entry.proofs.push(proof);
		if (entry.proofs.length > MAX_PROOFS_PER_SEQ) {
			entry.proofs.shift();
			entry.droppedProofs += 1;
			droppedProofs += 1;
		}
		lastProofSeq = seq;
		currentProof = proof;
		previousComplete = null;
		candidate = null;
		candidateState = "idle";
		pendingSinceSeq = null;
		classifier.reset({ cursorVisible });
		return { status: "ok", proof: cloneProof(proof) };
	}

	/**
	 * Answer whether `snapshotSeq` is backed by a complete view proof plus only explicitly
	 * classified no-grid trailing controls. Returns `covered`, `unavailable` or `unknown`.
	 */
	function coverageFor(snapshotSeq) {
		if (!Number.isInteger(snapshotSeq) || snapshotSeq < 1) return { status: "unknown", reason: "invalid-snapshot-seq", proof: null, throughSeq: null, cursorVisible: null };
		if (firstSeq === null) return { status: "unknown", reason: "no-output", proof: null, throughSeq: null, cursorVisible: null };
		if (gap) return { status: "unknown", reason: "output-gap", proof: null, throughSeq: null, cursorVisible: null };
		if (snapshotSeq > lastOutputSeq) return { status: "unknown", reason: "snapshot-seq-future", proof: null, throughSeq: null, cursorVisible: null };
		if (snapshotSeq < firstSeq) return { status: "unknown", reason: "snapshot-before-window", proof: null, throughSeq: null, cursorVisible: null };
		if (candidateState === "open") {
			return { status: "unavailable", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null, previousComplete: cloneProof(previousComplete) };
		}
		if (candidateState === "aborted") {
			return { status: "unavailable", reason: "candidate-aborted", proof: null, throughSeq: null, cursorVisible: null, previousComplete: cloneProof(previousComplete) };
		}
		const found = findNewestProofAtOrBefore(snapshotSeq);
		if (found.proof === null) return { status: "unknown", reason: "no-proof", proof: null, throughSeq: null, cursorVisible: null };
		const proof = found.proof;
		if (proof.seq === snapshotSeq) {
			return { status: "covered", reason: "exact-proof", proof: cloneProof(proof), throughSeq: snapshotSeq, cursorVisible: proof.cursorVisible };
		}
		const retained = earliestRetainedSeq();
		let throughSeq = proof.seq;
		let cursorVisible = proof.cursorVisible;
		for (let seq = proof.seq + 1; seq <= snapshotSeq; seq += 1) {
			const entry = journal.get(seq);
			if (entry === undefined) {
				const reason = retained !== null && seq < retained ? "journal-evicted" : found.evicted ? "proof-evicted" : "journal-gap";
				return { status: "unknown", reason, proof: null, throughSeq, cursorVisible };
			}
			if (entry.status === "pending") {
				return { status: "unavailable", reason: "trailing-pending", proof: null, throughSeq, cursorVisible, detail: "incomplete-escape", pendingBytes: entry.pendingBytes };
			}
			if (entry.status !== "safe") {
				return { status: "unavailable", reason: "trailing-unsafe", proof: null, throughSeq, cursorVisible, detail: entry.reason };
			}
			if (entry.cursorVisible !== null) cursorVisible = entry.cursorVisible;
			throughSeq = seq;
		}
		return { status: "covered", reason: "safe-trailing", proof: cloneProof(proof), throughSeq: snapshotSeq, cursorVisible };
	}

	/**
	 * Bounded replay/catch-up query. Returns `ok` entries in seq order, or an explicit
	 * `evicted`/`gap`/`unknown` result — never a stitched or guessed history. Per-entry and
	 * aggregate `droppedProofs`/`droppedEvents` are surfaced on every result. Aggregate counts
	 * are LIFETIME totals; per-entry counts are RANGE-LOCAL. A fully retained range can still
	 * have a nonzero lifetime count, so range-completeness decisions must use the entries plus
	 * explicit gap/evicted status, not lifetime nonzero alone.
	 */
	function replay(fromSeq, throughSeq = lastOutputSeq) {
		const drops = () => ({ droppedProofs, droppedEvents });
		if (!Number.isInteger(fromSeq) || fromSeq < 1 || !Number.isInteger(throughSeq) || throughSeq < fromSeq) {
			return { status: "unknown", reason: "invalid-range", ...drops(), entries: [] };
		}
		if (firstSeq === null) return { status: "unknown", reason: "no-output", ...drops(), entries: [] };
		if (fromSeq < firstSeq) return { status: "unknown", reason: "before-window", ...drops(), entries: [] };
		if (throughSeq > lastOutputSeq) return { status: "unknown", reason: "future-range", ...drops(), entries: [] };
		const earliest = earliestRetainedSeq();
		if (earliest === null || fromSeq < earliest) {
			return { status: "evicted", earliestSeq: earliest, droppedSegments, ...drops(), entries: [] };
		}
		const entries = [];
		for (let seq = fromSeq; seq <= throughSeq; seq += 1) {
			const entry = journal.get(seq);
			if (entry === undefined) return { status: "gap", missingSeq: seq, ...drops(), entries: [] };
			if (entry.status === "unknown" && entry.reason === "output-gap") return { status: "gap", missingSeq: seq, ...drops(), entries: [] };
			entries.push(cloneEntry(entry));
		}
		return { status: "ok", ...drops(), entries };
	}

	function snapshot() {
		const earliest = earliestRetainedSeq();
		return {
			protocol: VIEW_PROOF_PROTOCOL,
			firstSeq,
			lastOutputSeq,
			lastProofSeq,
			lastFrameId,
			gap,
			candidateState,
			candidate: candidate === null ? null : { ...candidate },
			// Last COMPLETED proof only. This is not coverage: use coverageFor(snapshotSeq)
			// to decide whether the current snapshot is proven.
			currentProof: candidateState === "idle" ? cloneProof(currentProof) : null,
			previousComplete: cloneProof(previousComplete),
			journal: {
				size: journal.size,
				earliestSeq: earliest,
				droppedSegments,
				droppedProofs,
				droppedEvents,
			},
			classifier: classifier.state(),
			diagnostics: diagnostics.slice(),
		};
	}

	return { feedOutput, openCandidate, abortCandidate, completeProof, coverageFor, replay, snapshot };
}
