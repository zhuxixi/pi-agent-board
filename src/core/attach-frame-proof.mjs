/**
 * Pure frame-witness logic for the attach readiness fast path (issue #222, step 23a).
 *
 * Owns exactly three concerns and nothing else: the candidate grammar that decides when
 * an in-stream `S`/`F`/`A` marker is justified, the FROZEN marker literals from the
 * converged contract (`plans/issue-222-attach-ready-signal-implementation.md` §3), and
 * metadata validation. No I/O, no timers, no Terminal: the reporter shell
 * (`attach-frame-reporter.mjs`) owns every side effect.
 *
 * ## Ordered operation grammar (contract §2.1, §3)
 *
 * A write is NOT classified by substring search. Each original write is scanned into an
 * ordered token stream (sync OPEN/CLOSE, cursor position, cursor visibility, erase,
 * other control, plain text, or malformed) with full terminators required; cross-write
 * state is kept by the evaluator. Consequences that the state machine enforces:
 *
 * - Cursor positioning evidence is absolute `H`/`f`/`G`/`d` or relative `A`–`D`.
 *   (`G`/`d` are single-axis absolute positioning; the real renderer's parking write is
 *   `CSI n A` + `CSI m G`, so rejecting `G` would reject the host's own park sequence.)
 *   Cursor visibility evidence is exactly `?25h` / `?25l`. Erase finals (`J`,`K`,`X`) are
 *   NEVER cursor evidence. Any other cursor-relevant control is `unknown` and aborts.
 * - `S` is inserted immediately BEFORE this frame's first OPEN token — even when a
 *   previous frame's CLOSE precedes it in the SAME write. The reporter splits the write
 *   at that exact offset; the marker never precedes a previous frame's CLOSE.
 * - A regular parking write must be OPEN-free and carry a real cursor position or
 *   visibility operation. The next frame's OPEN is not parking: it aborts the candidate.
 *
 * ## Candidate lifecycle
 *
 * - A candidate starts only at a complete `columns` + `rows` pair; the first pair is
 *   locked. A later complete pair invalidates the open candidate (`resampled`) before the
 *   new one opens, so stale geometry can never be proven by a newer frame.
 * - `S` requires a FRESH sentinel fact observed after the pair (any operation before it
 *   invalidates the candidate) plus valid focus, unchanged mode and a size match.
 * - At completion the LATEST sentinel fact is rechecked: same focus identity (reference,
 *   never a name/title/text), present focus, same mode, compatible overlay. A change
 *   aborts instead of publishing.
 * - `frameId` is strictly increasing within one reporter token, carried across
 *   rendererEpoch (mode-switch) changes.
 */
export const FRAME_WITNESS_PROTOCOL = 1;
export const FRAME_REPORTER_CLIENT_ID = "frame-reporter";
export const MAX_FRAME_MARKER_BYTES = 4096;
export const MAX_DECISION_LOG = 256;
export const MAX_ABORT_REASON_LENGTH = 64;

const DCS_INTRO = "\u001bP> ";
const DCS_TERM = "\u001b\\";
const MARKER_FAMILY = "agent-board-frame/1";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,}$/; // >= 128 bits as base64url without padding
const REASON_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ESC = "\u001b";
const MODES = new Set(["fullscreen", "regular"]);

export const MAX_PENDING_TAIL = 4096;

/**
 * Classify a complete CSI body/final that is not sync/cursor/erase. Only the converged
 * §5 no-grid controls are allowed inside a candidate; everything else is `unknown-control`.
 * Plain SGR (`m` without a private prefix) is allowed because it changes rendition only —
 * never the grid, layout or cursor — and the real host emits it inside frame writes.
 */
function classifyCsi(body, final) {
	if (body === "?2004" && (final === "h" || final === "l")) return { kind: "allowed-control", family: "bracketed-paste" };
	if (body === "?2031" && (final === "h" || final === "l")) return { kind: "allowed-control", family: "color-scheme" };
	if (body === "16" && final === "t") return { kind: "allowed-control", family: "cell-size-query" };
	if (body === "" && final === "c") return { kind: "allowed-control", family: "device-attributes" };
	if (body === ">7" && final === "u") return { kind: "allowed-control", family: "keyboard-protocol-push" };
	if (body === "?" && final === "u") return { kind: "allowed-control", family: "keyboard-protocol-query" };
	if ((body === ">4;0" || body === ">4;2") && final === "m") return { kind: "allowed-control", family: "modify-other-keys" };
	if (body === "<" && final === "u") return { kind: "allowed-control", family: "keyboard-protocol-pop" };
	// Rendition attributes only (no private prefix): colours, bold, reverse, reset.
	if (/^[0-9;]*$/.test(body) && final === "m") return { kind: "allowed-control", family: "sgr" };
	return { kind: "unknown-control", family: `csi:${body}${final}` };
}

/**
 * Classify a complete OSC body (the part between `ESC ]` and the terminator).
 *
 * Scope clarification (parent-approved, fix2): OSC 8 hyperlinks inside the CURRENT frame
 * are a text ANNOTATION — not a grid/cursor operation. §5 lists OSC 8 as invalidating for
 * the POST-F trailing window (proof.seq < snapshotSeq, FW-06); that rule is unchanged. The
 * annotation kind can never establish or complete a proof, never counts as parking or
 * visibility, and an OSC 8 after this candidate's CLOSE invalidates the frame.
 */
function classifyOsc(body) {
	if (/^8;;/.test(body)) return { kind: "annotation", family: "osc-hyperlink" };
	if (/^8;/.test(body)) return { kind: "unknown-control", family: "osc8-malformed" };
	if (/^0;/.test(body)) return { kind: "allowed-control", family: "osc-title" };
	if (/^9;4;/.test(body)) return { kind: "allowed-control", family: "osc-progress" };
	if (/^7501;/.test(body)) return { kind: "allowed-control", family: "osc-program-status" };
	// Palette / foreground / background queries: 4;<n>;? and 10;? / 11;?.
	if (/^4(;[0-9]+)*;\?$/.test(body) || /^(10|11);\?$/.test(body)) return { kind: "allowed-control", family: "osc-palette-query" };
	return { kind: "unknown-control", family: `osc:${body.slice(0, 16)}` };
}

/**
 * Bounded, grammar-aware scanner with CROSS-WRITE state.
 *
 * `pending` carries an unterminated escape tail (max `MAX_PENDING_TAIL` code units) from
 * one write into the next, so a synchronized CLOSE or an allowed control split by the
 * writer completes normally instead of failing as malformed. A sequence is `malformed`
 * only when it COMPLETES and is still invalid. Tokens that started in a previous write
 * report `offset: null` and `startedEarlier: true` (they cannot be an insertion target).
 *
 * OFFSETS ARE JS UTF-16 CODE-UNIT INDICES used with `text.slice` — NOT byte counts and NOT
 * outputSeq. FW-03 must keep its own byte/outputSeq accounting separately.
 */
export function scanWrite(text, pending = null, { baseOffset = 0 } = {}) {
	const tokens = [];
	if (typeof text !== "string") return { tokens, pending: pending === null ? null : pending, overflow: false };
	const prefix = pending === null ? "" : pending.raw;
	const combined = prefix + text;
	const startedEarlierLength = prefix.length;
	const push = (token) => {
		// Offsets index the CURRENT write's text; a token whose start lies in the carried
		// prefix has no usable insertion offset.
		if (token.offset < startedEarlierLength) tokens.push({ ...token, offset: null, startedEarlier: true, streamOffset: baseOffset - startedEarlierLength + token.offset });
		else tokens.push({ ...token, offset: token.offset - startedEarlierLength, startedEarlier: false, streamOffset: baseOffset + token.offset - startedEarlierLength });
	};
	const paramsEnd = (from) => {
		let index = from;
		while (index < combined.length && /[0-9;?<=>]/.test(combined[index])) index += 1;
		while (index < combined.length && /[ -/]/.test(combined[index])) index += 1;
		if (index >= combined.length) return -1;
		return /[@-~]/.test(combined[index]) ? index : -1;
	};
	let index = 0;
	let textStart = 0;
	const flushText = (end) => {
		if (end > textStart) push({ kind: "text", offset: textStart, raw: combined.slice(textStart, end) });
	};
	let tail = null;
	while (index < combined.length) {
		if (combined[index] !== ESC) {
			index += 1;
			continue;
		}
		flushText(index);
		const at = index;
		const next = combined[index + 1];
		if (next === undefined) {
			tail = { kind: "esc", raw: combined.slice(at), startOffset: baseOffset - startedEarlierLength + at };
			index = combined.length;
			break;
		}
		if (next === "[") {
			const end = paramsEnd(index + 2);
			if (end < 0) {
				// Unterminated CSI: carry the tail into the next write instead of failing.
				if (combined.length - at > MAX_PENDING_TAIL) return { tokens, pending: null, overflow: true };
				tail = { kind: "csi", raw: combined.slice(at), startOffset: baseOffset - startedEarlierLength + at };
				index = combined.length;
				break;
			}
			const body = combined.slice(index + 2, end);
			const final = combined[end];
			const raw = combined.slice(at, end + 1);
			if (body === "?2026" && final === "h") push({ kind: "sync-open", offset: at, raw });
			else if (body === "?2026" && final === "l") push({ kind: "sync-close", offset: at, raw });
			else if (body === "?25" && (final === "h" || final === "l")) push({ kind: "cursor-visibility", offset: at, raw, visible: final === "h" });
			else if (["H", "f", "A", "B", "C", "D", "G", "d"].includes(final)) push({ kind: "cursor-position", offset: at, raw });
			else if (["J", "K", "X"].includes(final)) push({ kind: "erase", offset: at, raw });
			else push({ ...classifyCsi(body, final), offset: at, raw });
			index = end + 1;
			textStart = index;
			continue;
		}
		if (next === "]" || next === "P") {
			let cursor = index + 2;
			let end = -1;
			while (cursor < combined.length) {
				if (combined[cursor] === "\u0007") {
					end = cursor + 1;
					break;
				}
				if (combined[cursor] === ESC && combined[cursor + 1] === "\\") {
					end = cursor + 2;
					break;
				}
				cursor += 1;
			}
			if (end < 0) {
				if (combined.length - at > MAX_PENDING_TAIL) return { tokens, pending: null, overflow: true };
				tail = { kind: next === "]" ? "osc" : "dcs", raw: combined.slice(at), startOffset: baseOffset - startedEarlierLength + at };
				index = combined.length;
				break;
			}
			const body = combined.slice(index + 2, end === cursor + 1 ? end - 1 : end - 2);
			const raw = combined.slice(at, end);
			if (next === "P") push({ kind: "unknown-control", offset: at, raw, family: "dcs" });
			else push({ ...classifyOsc(body), offset: at, raw });
			index = end;
			textStart = index;
			continue;
		}
		// Two-byte escape (ESC M, ESC 7, ESC ( …): cursor/scroll/grid relevant, never allowed.
		push({ kind: "unknown-control", offset: at, raw: combined.slice(at, at + 2), family: `esc:${next}` });
		index += 2;
		textStart = index;
	}
	flushText(combined.length);
	return { tokens, pending: tail, overflow: false };
}

/** Convenience wrapper for a single complete write (tests/diagnostics). */
export function scanTerminalOps(text) {
	return scanWrite(text, null).tokens;
}

export function isValidFrameWitnessToken(token) {
	return typeof token === "string" && TOKEN_PATTERN.test(token);
}

function requireToken(token) {
	if (!isValidFrameWitnessToken(token)) throw new Error("frame marker requires a valid base64url token (>=128 bits)");
	return token;
}

/** frameId and sampledCols must be >= 1; intentId/geometryRevision may be 0. */
function requirePositiveId(name, value) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`frame marker requires ${name} >= 1`);
	return value;
}

function requireNonNegativeInt(name, value) {
	if (!Number.isInteger(value) || value < 0) throw new Error(`frame marker requires an integer ${name} >= 0`);
	return value;
}

function markerBytes(text) {
	return Buffer.byteLength(text, "utf8");
}

function assertMarkerSize(text) {
	if (markerBytes(text) > MAX_FRAME_MARKER_BYTES) throw new Error(`frame marker exceeds ${MAX_FRAME_MARKER_BYTES} bytes`);
	return text;
}

export function encodeFrameMarkerS({ token, frameId, intentId = 0, sampledCols }) {
	const text = `${DCS_INTRO}${MARKER_FAMILY} ; ${requireToken(token)} ; S ; ${requirePositiveId("frameId", frameId)} ; ${requireNonNegativeInt("intentId", intentId)} ; ${requirePositiveId("sampledCols", sampledCols)}${DCS_TERM}`;
	return assertMarkerSize(text);
}

export function encodeFrameMetadataBase64(metadata) {
	const validation = validateFrameMetadata(metadata);
	if (!validation.ok) throw new Error(`invalid frame metadata: ${validation.reason}`);
	return Buffer.from(JSON.stringify(validation.value), "utf8").toString("base64url");
}

export function encodeFrameMarkerF({ token, frameId, metadata }) {
	const text = `${DCS_INTRO}${MARKER_FAMILY} ; ${requireToken(token)} ; F ; ${requirePositiveId("frameId", frameId)} ; ${encodeFrameMetadataBase64(metadata)}${DCS_TERM}`;
	return assertMarkerSize(text);
}

export function encodeFrameMarkerA({ token, frameId, reason }) {
	if (typeof reason !== "string" || !REASON_PATTERN.test(reason) || reason.length > MAX_ABORT_REASON_LENGTH) {
		throw new Error("frame abort reason must be bounded lowercase-kebab");
	}
	const text = `${DCS_INTRO}${MARKER_FAMILY} ; ${requireToken(token)} ; A ; ${requirePositiveId("frameId", frameId)} ; ${reason}${DCS_TERM}`;
	return assertMarkerSize(text);
}

/**
 * Parse a complete marker (tests and the future runner parser). Fails closed: oversize
 * complete markers, non-positive ids/cols and overlong reasons are all rejected.
 */
export function decodeFrameMarker(text) {
	if (typeof text !== "string" || !text.startsWith(DCS_INTRO) || !text.endsWith(DCS_TERM)) return null;
	if (markerBytes(text) > MAX_FRAME_MARKER_BYTES) return null;
	const body = text.slice(DCS_INTRO.length, text.length - DCS_TERM.length);
	const parts = body.split(" ; ");
	if (parts.length < 4 || parts[0] !== MARKER_FAMILY) return null;
	const token = parts[1];
	if (!isValidFrameWitnessToken(token)) return null;
	const kind = parts[2];
	if (kind === "S") {
		if (parts.length !== 6) return null;
		const frameId = Number(parts[3]);
		const intentId = Number(parts[4]);
		const sampledCols = Number(parts[5]);
		if (!Number.isInteger(frameId) || frameId < 1) return null;
		if (!Number.isInteger(intentId) || intentId < 0) return null;
		if (!Number.isInteger(sampledCols) || sampledCols < 1) return null;
		return { token, kind, frameId, intentId, sampledCols };
	}
	if (kind === "F") {
		if (parts.length !== 5) return null;
		const frameId = Number(parts[3]);
		if (!Number.isInteger(frameId) || frameId < 1) return null;
		let metadata;
		try {
			metadata = JSON.parse(Buffer.from(parts[4], "base64url").toString("utf8"));
		} catch {
			return null;
		}
		const validation = validateFrameMetadata(metadata);
		if (!validation.ok) return null;
		return { token, kind, frameId, metadata: validation.value };
	}
	if (kind === "A") {
		if (parts.length !== 5) return null;
		const frameId = Number(parts[3]);
		if (!Number.isInteger(frameId) || frameId < 1) return null;
		if (!REASON_PATTERN.test(parts[4]) || parts[4].length > MAX_ABORT_REASON_LENGTH) return null;
		return { token, kind, frameId, reason: parts[4] };
	}
	return null;
}

/**
 * Metadata must contain exactly the converged contract fields with validated values.
 * Unknown/extra fields fail closed rather than being silently published.
 */
export function validateFrameMetadata(metadata) {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return { ok: false, reason: "not-an-object" };
	const allowed = ["protocol", "cols", "rows", "mode", "rendererEpoch", "sessionEpoch", "focusPresent", "overlayPresent", "intentId", "geometryRevision"];
	for (const key of Object.keys(metadata)) if (!allowed.includes(key)) return { ok: false, reason: `unexpected-field:${key}` };
	if (metadata.protocol !== FRAME_WITNESS_PROTOCOL) return { ok: false, reason: "protocol" };
	if (!Number.isInteger(metadata.cols) || metadata.cols < 1) return { ok: false, reason: "cols" };
	if (!Number.isInteger(metadata.rows) || metadata.rows < 1) return { ok: false, reason: "rows" };
	if (!MODES.has(metadata.mode)) return { ok: false, reason: "mode" };
	if (!Number.isInteger(metadata.rendererEpoch) || metadata.rendererEpoch < 0) return { ok: false, reason: "rendererEpoch" };
	if (!Number.isInteger(metadata.sessionEpoch) || metadata.sessionEpoch < 0) return { ok: false, reason: "sessionEpoch" };
	if (typeof metadata.focusPresent !== "boolean") return { ok: false, reason: "focusPresent" };
	if (typeof metadata.overlayPresent !== "boolean") return { ok: false, reason: "overlayPresent" };
	if (!Number.isInteger(metadata.intentId) || metadata.intentId < 0) return { ok: false, reason: "intentId" };
	if (!Number.isInteger(metadata.geometryRevision) || metadata.geometryRevision < 0) return { ok: false, reason: "geometryRevision" };
	return {
		ok: true,
		value: {
			protocol: FRAME_WITNESS_PROTOCOL,
			cols: metadata.cols,
			rows: metadata.rows,
			mode: metadata.mode,
			rendererEpoch: metadata.rendererEpoch,
			sessionEpoch: metadata.sessionEpoch,
			focusPresent: metadata.focusPresent,
			overlayPresent: metadata.overlayPresent,
			intentId: metadata.intentId,
			geometryRevision: metadata.geometryRevision,
		},
	};
}

const NO_INTENT = Object.freeze({ intentId: 0, geometryRevision: 0, cols: null, rows: null });

/**
 * Diagnostic candidate evaluator (the production grammar; the accepted smoke's
 * test-support evaluator stays the independent oracle).
 *
 * `op()` returns `{decisions, insertions}`. `insertions` carries the exact write offset
 * and frameId where `S` must be inserted, so the reporter can split the write at the
 * boundary immediately before THIS frame's OPEN token.
 */
export class FrameCandidateEvaluator {
	#mode;
	#rendererEpoch;
	#sessionEpoch;
	#frameIdCounter;
	#pendingCols = null;
	#pendingRows = null;
	#candidate = null;
	#decisions = [];
	#markerFailures = 0;
	#intent = NO_INTENT;
	#intentRefused = false;
	#latestSentinel = null;
	#stopped = false;
	#inOp = false;
	#pending = null;
	#streamOffset = 0;

	constructor({ mode, rendererEpoch = 1, sessionEpoch = 0, frameIdCounter = { value: 0 } }) {
		if (!MODES.has(mode)) throw new Error(`unknown renderer mode: ${mode}`);
		this.#mode = mode;
		this.#rendererEpoch = rendererEpoch;
		this.#sessionEpoch = sessionEpoch;
		this.#frameIdCounter = frameIdCounter;
	}

	get mode() {
		return this.#mode;
	}

	get frameIdCounter() {
		return this.#frameIdCounter;
	}

	get lastFrameId() {
		return this.#frameIdCounter.value;
	}

	get openFrameId() {
		return this.#candidate === null ? null : this.#candidate.frameId;
	}

	get intentRefused() {
		return this.#intentRefused;
	}

	get decisions() {
		return this.#decisions.slice();
	}

	get markerFailures() {
		return this.#markerFailures;
	}

	/**
	 * Runner intent plumbing (adapter boundary only; real runner intent is FW-04/23b).
	 * An INVALID object enters a refusing state — it is never coerced to the ordinary
	 * `intentId 0`, because 0 is the "ordinary frame" sentinel and coercion would fail
	 * open. `null`/`undefined` explicitly clears back to the ordinary intent.
	 */
	setIntent(intent) {
		if (intent === null || intent === undefined) {
			this.#intent = NO_INTENT;
			this.#intentRefused = false;
			return { ok: true, cleared: true };
		}
		const problems = [];
		if (typeof intent !== "object" || Array.isArray(intent)) problems.push("not-an-object");
		else {
			const allowed = ["intentId", "geometryRevision", "cols", "rows"];
			for (const key of Object.keys(intent)) if (!allowed.includes(key)) problems.push(`unexpected-field:${key}`);
			if (!Number.isInteger(intent.intentId) || intent.intentId < 0) problems.push("intentId");
			if (!Number.isInteger(intent.geometryRevision) || intent.geometryRevision < 0) problems.push("geometryRevision");
			const hasCols = intent.cols !== undefined && intent.cols !== null;
			const hasRows = intent.rows !== undefined && intent.rows !== null;
			if (hasCols !== hasRows) problems.push("one-sided-dims");
			else if (hasCols && (!Number.isInteger(intent.cols) || intent.cols < 1 || !Number.isInteger(intent.rows) || intent.rows < 1)) problems.push("dims");
		}
		if (problems.length > 0) {
			this.#intent = null;
			this.#intentRefused = true;
			this.#abortCandidate("intent-invalid");
			return { ok: false, reason: problems.join(",") };
		}
		const next = {
			intentId: intent.intentId,
			geometryRevision: intent.geometryRevision,
			cols: intent.cols ?? null,
			rows: intent.rows ?? null,
		};
		const current = this.#intent;
		if (this.#candidate !== null && (current === null || next.geometryRevision !== current.geometryRevision || next.intentId !== current.intentId)) {
			// A newer intent supersedes the open candidate: abort before any S/F instead of
			// retroactively stamping the new identity onto an existing frame.
			this.#abortCandidate("intent-superseded");
		}
		this.#intent = next;
		this.#intentRefused = false;
		return { ok: true, cleared: false };
	}

	setEpoch({ rendererEpoch = this.#rendererEpoch, sessionEpoch = this.#sessionEpoch } = {}) {
		this.#rendererEpoch = rendererEpoch;
		this.#sessionEpoch = sessionEpoch;
	}

	/** Sampling read of a shared-Terminal size getter. */
	sizeRead(key, value) {
		if (this.#stopped || typeof value !== "number") return [];
		const before = this.#decisions.length;
		if (key === "columns") this.#pendingCols = value;
		else if (key === "rows") this.#pendingRows = value;
		else return [];
		if (this.#pendingCols === null || this.#pendingRows === null) return [];
		// A complete NEW pair invalidates the open candidate BEFORE the new one opens:
		// stale sampled geometry can never be completed by a newer frame.
		if (this.#candidate !== null) this.#abortCandidate("resampled", before);
		this.#frameIdCounter.value += 1;
		this.#candidate = {
			frameId: this.#frameIdCounter.value,
			sampledCols: this.#pendingCols,
			sampledRows: this.#pendingRows,
			sentinel: null,
			sEmitted: false,
			syncOpenSeen: false,
			syncCloseSeen: false,
			closeWriteIndex: null,
			writeCount: 0,
			cursorParkingAfterClose: false,
			fVisibilityAfterClose: false,
			annotationDepth: 0,
			// Intent is snapshotted AT CREATION: a later intent can never be stamped onto
			// this frame, and S/F of one frame always carry the same intent identity.
			intentId: this.#intent?.intentId ?? 0,
			geometryRevision: this.#intent?.geometryRevision ?? 0,
			intentCols: this.#intent?.cols ?? null,
			intentRows: this.#intent?.rows ?? null,
		};
		this.#pendingCols = null;
		this.#pendingRows = null;
		this.#push({ kind: "candidate", frameId: this.#candidate.frameId, reason: "size-pair-sampled" });
		return this.#decisions.slice(before);
	}

	/** The post-pair sentinel fact. The LATEST fact wins (focus is rechecked later). */
	sentinel(fact) {
		if (this.#stopped) return [];
		const before = this.#decisions.length;
		if (this.#candidate === null) {
			this.#push({ kind: "none", frameId: null, reason: "sentinel-without-candidate" });
			return this.#decisions.slice(before);
		}
		this.#latestSentinel = fact;
		if (this.#candidate.sentinel === null) this.#candidate.sentinel = fact;
		return this.#decisions.slice(before);
	}

	/**
	 * A shared-Terminal operation. Returns the decisions produced by this operation plus
	 * the exact insertion offsets where `S` must be written (immediately before this
	 * frame's OPEN token).
	 */
	op(op) {
		if (this.#stopped) return { decisions: [], insertions: [] };
		const before = this.#decisions.length;
		const insertions = [];
		this.#inOp = true;
		try {
			this.#handleOp(op, insertions);
		} finally {
			this.#inOp = false;
		}
		return { decisions: this.#decisions.slice(before), insertions };
	}

	/** Marker accounting hook: never counted as a terminal operation. */
	markerWrite(kind) {
		if (this.#inOp || this.#stopped) {
			this.#markerFailures += 1;
			return false;
		}
		return typeof kind === "string";
	}

	/**
	 * Completion check, called by the reporter AFTER an operation returned (or threw).
	 * Rechecks the LATEST focus identity reference, presence, mode and overlay compatibility
	 * before any F could be written; returns the decisions produced by this check.
	 */
	finishWrite(fact) {
		const candidate = this.#candidate;
		if (candidate === null) return [];
		const before = this.#decisions.length;
		if (!this.#completed(candidate)) return [];
		if (fact === null || typeof fact !== "object" || fact.focusPresent !== true) {
			this.#abortCandidate("focus-missing-at-completion", before);
			return this.#decisions.slice(before);
		}
		const sFact = candidate.sentinel;
		if (sFact === null || !Object.is(sFact.focusIdentity, fact.focusIdentity)) {
			this.#abortCandidate("focus-changed-at-completion", before);
			return this.#decisions.slice(before);
		}
		if (fact.mode !== this.#mode) {
			this.#abortCandidate("mode-changed-at-completion", before);
			return this.#decisions.slice(before);
		}
		if (Boolean(fact.overlayPresent) !== Boolean(sFact.overlayPresent)) {
			this.#abortCandidate("overlay-changed-at-completion", before);
			return this.#decisions.slice(before);
		}
		if (candidate.annotationDepth !== 0) {
			this.#abortCandidate("unclosed-annotation", before);
			return this.#decisions.slice(before);
		}
		this.#push({ kind: "F", frameId: candidate.frameId, reason: this.#mode === "fullscreen" ? "complete-fullscreen-sync-write-with-cursor" : "regular-open-close-park-and-visibility" });
		this.#candidate = null;
		return this.#decisions.slice(before);
	}

	fence() {
		if (this.#stopped) return [];
		const before = this.#decisions.length;
		const candidate = this.#candidate;
		if (candidate === null) {
			this.#pending = null;
			return [];
		}
		if (this.#pending !== null) {
			this.#abortCandidate("pending-escape-abandoned", before);
			this.#pending = null;
			return this.#decisions.slice(before);
		}
		if (!candidate.sEmitted) this.#push({ kind: "none", frameId: candidate.frameId, reason: "expired-without-sync-output" });
		else if (!this.#completed(candidate)) this.#push({ kind: "A", frameId: candidate.frameId, reason: "incomplete-at-fence" });
		this.#candidate = null;
		return this.#decisions.slice(before);
	}

	abort(reason) {
		const before = this.#decisions.length;
		this.#abortCandidate(reason, before);
		return this.#decisions.slice(before);
	}

	stop() {
		const produced = this.abort(this.#pending === null ? "stop" : "pending-escape-abandoned");
		this.#pending = null;
		this.#stopped = true;
		return produced;
	}

	/** Metadata for a proof decision produced by this evaluator. */
	metadataFor(decision) {
		return {
			protocol: FRAME_WITNESS_PROTOCOL,
			cols: decision.cols,
			rows: decision.rows,
			mode: this.#mode,
			rendererEpoch: decision.rendererEpoch ?? this.#rendererEpoch,
			sessionEpoch: this.#sessionEpoch,
			focusPresent: decision.focusPresent === true,
			overlayPresent: decision.overlayPresent === true,
			intentId: decision.intentId ?? 0,
			geometryRevision: decision.geometryRevision ?? 0,
		};
	}

	#abortCandidate(reason, before = this.#decisions.length) {
		const candidate = this.#candidate;
		if (candidate === null) return;
		if (candidate.sEmitted) this.#push({ kind: "A", frameId: candidate.frameId, reason });
		else this.#push({ kind: "none", frameId: candidate.frameId, reason: `${reason}-before-s` });
		this.#candidate = null;
		void before;
	}

	#handleOp(op, insertions) {
		const candidate = this.#candidate;
		const text = op.text ?? "";
		const scanned = scanWrite(text, this.#pending, { baseOffset: this.#streamOffset });
		this.#streamOffset += typeof text === "string" ? text.length : 0;
		this.#pending = scanned.pending;
		const tokens = scanned.tokens;
		if (candidate === null) {
			this.#push({ kind: "none", frameId: null, reason: `op-${op.kind}-without-candidate` });
			return;
		}
		// Candidate-origin rule: until a fresh sentinel fact exists, any operation means
		// the pair did not come from this frame's renderer entry.
		if (candidate.sentinel === null) {
			this.#push({ kind: "none", frameId: candidate.frameId, reason: `op-${op.kind}-before-fresh-sentinel` });
			this.#candidate = null;
			return;
		}
		if (scanned.overflow) {
			this.#abortCandidate("pending-escape-overflow");
			return;
		}
		if (tokens.some((token) => token.kind === "malformed")) {
			this.#abortCandidate("malformed-control");
			return;
		}
		// Inside a candidate only the §5 no-grid controls are tolerated; every other
		// control (grid/scroll/unknown private modes, unclassified DCS) fails closed.
		if (tokens.some((token) => token.kind === "unknown-control")) {
			this.#abortCandidate("unknown-control");
			return;
		}
		// A synchronized OPEN split across writes escaped its first bytes before S could
		// be inserted, so it can never be proven: no retroactive S.
		if (tokens.some((token) => token.kind === "sync-open" && token.startedEarlier)) {
			this.#abortCandidate("split-sync-open-unsupported");
			return;
		}
		if (this.#intentRefused) {
			this.#abortCandidate("intent-invalid");
			return;
		}
		if (tokens.some((token) => token.kind === "annotation" && token.startedEarlier && candidate.syncCloseSeen)) {
			this.#abortCandidate("annotation-after-close");
			return;
		}
		if (op.kind !== "write") {
			this.#handleNonWrite(candidate, op);
			return;
		}
		candidate.writeCount += 1;
		const writeIndex = candidate.writeCount;
		if (this.#applyAnnotations(candidate, tokens, writeIndex)) return;
		this.#handleWrite(candidate, tokens, writeIndex, insertions);
	}

	/**
	 * OSC 8 annotations are metadata only: they can never establish or complete a proof,
	 * never count as parking/visibility, and one that appears AFTER this candidate's CLOSE
	 * invalidates the frame per §5. Returns true when the candidate was aborted.
	 */
	#applyAnnotations(candidate, tokens, writeIndex) {
		const openToken = tokens.find((token) => token.kind === "sync-open");
		const closeToken = tokens.find((token) => token.kind === "sync-close");
		for (const token of tokens) {
			if (token.kind !== "annotation") continue;
			const raw = token.raw ?? "";
			const body = raw.slice(2, raw.endsWith("\u0007") ? raw.length - 1 : raw.length - 2);
			const uri = body.slice(3); // after "8;;"
			const closeOffsetHere = closeToken === undefined ? null : closeToken.offset;
			const afterCloseInThisWrite = closeOffsetHere !== null && token.offset !== null && token.offset > closeOffsetHere;
			const afterCloseFromEarlier = candidate.syncCloseSeen && candidate.closeWriteIndex !== writeIndex;
			if (afterCloseFromEarlier || afterCloseInThisWrite) {
				this.#abortCandidate("annotation-after-close");
				return true;
			}
			// Annotations that appear BEFORE this frame's OPEN belong to the previous frame.
			if (!candidate.syncOpenSeen && (openToken === undefined || token.offset === null || token.offset < openToken.offset)) continue;
			if (uri === "") candidate.annotationDepth = Math.max(0, candidate.annotationDepth - 1);
			else candidate.annotationDepth += 1;
		}
		return false;
	}

	#handleNonWrite(candidate, op) {
		// Cursor visibility alone can never establish a first/full proof, but after this
		// candidate's CLOSE it is the required final visibility step.
		if (!candidate.sEmitted) {
			this.#push({ kind: "none", frameId: candidate.frameId, reason: `${op.kind}-cursor-only-no-proof` });
			return;
		}
		if (!candidate.syncCloseSeen) {
			this.#abortCandidate(`${op.kind}-before-sync-close`);
			return;
		}
		if (candidate.cursorParkingAfterClose) candidate.fVisibilityAfterClose = true;
	}

	/**
	 * Classify one write's ORDERED token stream against the candidate. Nothing here is a
	 * substring test: the candidate's own OPEN is the first `sync-open` token of the write
	 * that opens it, its CLOSE is the first `sync-close` AFTER that OPEN, and the S marker
	 * insertion offset is exactly that OPEN's byte offset (so a previous frame's CLOSE,
	 * even in the same write, never precedes S).
	 */
	#handleWrite(candidate, tokens, writeIndex, insertions) {
		const openIndex = tokens.findIndex((token) => token.kind === "sync-open");
		if (!candidate.syncOpenSeen) {
			if (openIndex < 0) {
				this.#push({ kind: "none", frameId: candidate.frameId, reason: "no-sync-block" });
				return;
			}
			const ownOpen = tokens[openIndex];
			let closeIndex = -1;
			let cursorIndex = -1;
			for (let index = openIndex + 1; index < tokens.length; index += 1) {
				const kind = tokens[index].kind;
				if (closeIndex < 0 && kind === "sync-close") closeIndex = index;
				if (cursorIndex < 0 && (kind === "cursor-position" || kind === "cursor-visibility")) cursorIndex = index;
			}
			if (this.#mode === "fullscreen") {
				if (closeIndex < 0) {
					this.#push({ kind: "none", frameId: candidate.frameId, reason: "fullscreen-sync-block-not-closed" });
					return;
				}
				if (cursorIndex < 0) {
					this.#push({ kind: "none", frameId: candidate.frameId, reason: "fullscreen-frame-without-cursor" });
					return;
				}
			}
			const eligibility = this.#sEligibility(candidate);
			if (eligibility !== "ok") {
				this.#push({ kind: "none", frameId: candidate.frameId, reason: eligibility });
				return;
			}
			candidate.syncOpenSeen = true;
			candidate.sEmitted = true;
			candidate.openWriteIndex = writeIndex;
			insertions.push({ offset: ownOpen.offset, frameId: candidate.frameId });
			this.#push({ kind: "S", frameId: candidate.frameId, reason: this.#mode === "fullscreen" ? "before-complete-fullscreen-sync-write" : "before-sync-open" });
			if (closeIndex > openIndex) {
				candidate.syncCloseSeen = true;
				candidate.closeWriteIndex = writeIndex;
				candidate.closeTokenOffset = tokens[closeIndex].offset;
			}
			if (cursorIndex > openIndex) candidate.cursorEvidenceSeen = true;
			return;
		}
		if (openIndex >= 0) {
			// A later OPEN in the same candidate's lifetime is either a nested open or the
			// next frame's OPEN used as a fake "parking" write. Neither may complete a frame.
			this.#abortCandidate(candidate.syncCloseSeen ? "park-open-crossed" : "nested-sync-open");
			return;
		}
		let closeIndex = -1;
		for (let index = 0; index < tokens.length; index += 1) {
			if (tokens[index].kind === "sync-close") {
				closeIndex = index;
				break;
			}
		}
		let closeThisWrite = false;
		if (!candidate.syncCloseSeen && closeIndex >= 0) {
			candidate.syncCloseSeen = true;
			candidate.closeWriteIndex = writeIndex;
			// A CLOSE completed from a carried tail occupies the start of this write, so any
			// cursor token here is after it; use -1 to mean "before every offset in the write".
			candidate.closeTokenOffset = tokens[closeIndex].offset === null ? -1 : tokens[closeIndex].offset;
			closeThisWrite = true;
		}
		const cursorTokens = tokens.filter((token) => token.kind === "cursor-position" || token.kind === "cursor-visibility");
		if (cursorTokens.length > 0) candidate.cursorEvidenceSeen = true;
		if (candidate.syncCloseSeen) {
			for (const token of cursorTokens) {
				// Parking must be STRICTLY AFTER the CLOSE: a cursor operation before the
				// CLOSE in the same write is not parking.
				const afterClose = candidate.closeWriteIndex !== writeIndex || (token.offset !== null && token.offset > (candidate.closeTokenOffset ?? -1));
				if (!afterClose) continue;
				if (token.kind === "cursor-position") candidate.cursorParkingAfterClose = true;
				if (token.kind === "cursor-visibility") {
					candidate.cursorParkingAfterClose = true;
					candidate.fVisibilityAfterClose = true;
				}
			}
		}
		void closeThisWrite;
	}

	#sEligibility(candidate) {
		if (!candidate.sentinel.focusPresent) return "focus-missing-at-sentinel";
		if (candidate.sentinel.mode !== this.#mode) return "mode-changed";
		if (candidate.intentCols !== null && candidate.intentRows !== null) {
			if (candidate.sampledCols !== candidate.intentCols || candidate.sampledRows !== candidate.intentRows) return "sampled-size-mismatch";
		}
		return "ok";
	}

	#completed(candidate) {
		if (this.#mode === "fullscreen") {
			return Boolean(candidate.sEmitted && candidate.syncCloseSeen && candidate.cursorEvidenceSeen);
		}
		return Boolean(candidate.sEmitted && candidate.syncOpenSeen && candidate.syncCloseSeen && candidate.cursorParkingAfterClose && candidate.fVisibilityAfterClose);
	}

	#push(decision) {
		const candidate = this.#candidate;
		const isProof = decision.kind === "S" || decision.kind === "F";
		this.#decisions.push({
			kind: decision.kind,
			frameId: decision.frameId === null || decision.frameId === undefined ? null : decision.frameId,
			reason: decision.reason,
			mode: this.#mode,
			rendererEpoch: this.#rendererEpoch,
			cols: isProof && candidate !== null ? candidate.sampledCols : null,
			rows: isProof && candidate !== null ? candidate.sampledRows : null,
			focusPresent: isProof && candidate !== null && candidate.sentinel !== null ? Boolean(candidate.sentinel.focusPresent) : null,
			overlayPresent: isProof && candidate !== null && candidate.sentinel !== null ? Boolean(candidate.sentinel.overlayPresent) : null,
			intentId: isProof && candidate !== null ? candidate.intentId : null,
			geometryRevision: isProof && candidate !== null ? candidate.geometryRevision : null,
		});
		if (this.#decisions.length > MAX_DECISION_LOG) this.#decisions.splice(0, this.#decisions.length - MAX_DECISION_LOG);
	}
}

/** Decisions a consumer may publish (S/F/A); `candidate`/`none` are diagnostics. */
export function publishedFrameDecisions(decisions) {
	return decisions.filter((decision) => decision.kind === "S" || decision.kind === "F" || decision.kind === "A");
}
