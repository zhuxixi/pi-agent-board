// Issue #222 step 23a fix1 (task-23a-smoke-fix1-brief.md): PURE diagnostic
// candidate evaluator for the converged in-stream frame grammar
// (plans/issue-222-attach-ready-signal-implementation.md §2.1).
//
// This is a TEST-SUPPORT diagnostic, not production: it decides, for one
// candidate, whether an S (frame about to be proven), an F (complete view) or an
// A (abort) is justified, and records the exact reason. It performs no I/O and
// owns no timers; the host (probe or replay) supplies facts in stream order and
// calls `fence()` at the synchronous-lifecycle boundary.
//
// Grammar encoded here (no more, no less):
//  - A candidate may only start at a `columns` + `rows` sampling pair; the FIRST
//    sampled pair wins and later reads inside the candidate cannot overwrite it.
//    Reads that never reach a pair (scattered mouse/hover/scrollbar reads) open
//    nothing and can never emit S on their own.
//  - S is only emitted immediately BEFORE a real synchronized output operation,
//    and only when the belowEditor sentinel confirmed workspace participation in
//    this render AND focus was valid at sentinel time AND the renderer mode is
//    unchanged. Nothing is emitted at getter time.
//  - fullscreen: F needs the single write that carries the complete synchronized
//    frame plus the cursor operation.
//  - regular: F needs this candidate's ordered sync OPEN -> CLOSE (CLOSE may be
//    split across several writes, so state is kept across writes) followed by a
//    cursor-parking write and the final cursor visibility operation.
//  - No-sync cursor-only operations cannot establish a first/full proof.
//  - BOOT / raw / bracketed-paste / control-only bytes are not proof.
//  - Missing or changed focus at candidate end, a mode change, `stop`, an
//    unsupported operation or an exception aborts (A only if S was emitted).
//  - Marker writes must not re-enter candidate accounting (no decision, no
//    write accounting); violations are reported as `marker-recursion`.
export type CandidateMode = "fullscreen" | "regular";

export type DecisionKind = "candidate" | "S" | "F" | "A" | "none" | "unsupported";

export interface CandidateDecision {
	kind: DecisionKind;
	frameId: number | null;
	reason: string;
	sampledCols: number | null;
	sampledRows: number | null;
	mode: CandidateMode | null;
}

export interface SentinelFact {
	focusPresent: boolean;
	/** Opaque focus identity for equality only; never a name, title or text. */
	focusIdentity: unknown;
	mode: CandidateMode;
}

export interface TerminalOp {
	kind: "write" | "hideCursor" | "showCursor";
	text: string;
}

export interface EvaluatorOptions {
	mode: CandidateMode;
	/** Target geometry from the frame-witness intent, when one is in flight. */
	targetCols?: number | null;
	targetRows?: number | null;
	/**
	 * Shared frameId counter. The contract (§3) makes frameId strictly increasing
	 * WITHIN one reporter token, and a rendererEpoch change (mode switch) does not
	 * mint a new token, so a rebind MUST pass the same counter object instead of
	 * restarting at 1. rendererEpoch stays an extra identity dimension, not a
	 * reset domain.
	 */
	frameIdCounter?: { value: number };
}

interface Candidate {
	frameId: number;
	sampledCols: number;
	sampledRows: number;
	sentinel: SentinelFact | null;
	sEmitted: boolean;
	syncOpenSeen: boolean;
	syncCloseSeen: boolean;
	closeWriteIndex: number | null;
	writeCount: number;
	cursorParkingAfterClose: boolean;
	fVisibilityAfterClose: boolean;
}

const SYNC_OPEN = "\u001b[?2026h";
const SYNC_CLOSE = "\u001b[?2026l";
// Cursor evidence: a visibility toggle anywhere in the write (`?25h/l`) or, as
// the real fullscreen renderer emits, a cursor positioning sequence (CUP/move).
const CURSOR_VISIBILITY = /\u001b\[\?25[hl]/;
const CURSOR_POSITION = /\u001b\[(\d+(;\d+)?[HfA-Za-d]|\?25[hl])/;

export class FrameCandidateEvaluator {
	private readonly modeValue: CandidateMode;
	private readonly targetCols: number | null;
	private readonly targetRows: number | null;
	private readonly frameIdCounter: { value: number };
	private pendingCols: number | null = null;
	private pendingRows: number | null = null;
	private candidate: Candidate | null = null;
	private decisions: CandidateDecision[] = [];
	private markerRecursion = false;
	private inOp = false;
	private stopped = false;

	constructor(options: EvaluatorOptions) {
		this.modeValue = options.mode;
		this.frameIdCounter = options.frameIdCounter ?? { value: 0 };
		this.targetCols = options.targetCols ?? null;
		this.targetRows = options.targetRows ?? null;
	}

	/** All decisions in stream order (the caller persists them). */
	get log(): CandidateDecision[] {
		return this.decisions;
	}

	get mode(): CandidateMode {
		return this.modeValue;
	}

	/** Highest frameId issued so far within this counter/token domain. */
	get lastFrameId(): number {
		return this.frameIdCounter.value;
	}

	get openFrameId(): number | null {
		return this.candidate === null ? null : this.candidate.frameId;
	}

	/** Sampling read of a shared-Terminal size getter. */
	sizeRead(key: "columns" | "rows", value: number): void {
		if (this.stopped) return;
		if (this.candidate !== null) {
			// First sampling of this candidate wins; later reads never overwrite.
			return;
		}
		if (key === "columns") {
			if (this.pendingCols !== null) return;
			this.pendingCols = value;
		} else {
			if (this.pendingRows !== null) return;
			this.pendingRows = value;
		}
		if (this.pendingCols === null || this.pendingRows === null) return;
		this.frameIdCounter.value += 1;
		this.candidate = {
			frameId: this.frameIdCounter.value,
			sampledCols: this.pendingCols,
			sampledRows: this.pendingRows,
			sentinel: null,
			sEmitted: false,
			syncOpenSeen: false,
			syncCloseSeen: false,
			closeWriteIndex: null,
			writeCount: 0,
			cursorParkingAfterClose: false,
			fVisibilityAfterClose: false,
		};
		const candidate = this.candidate;
		this.pendingCols = null;
		this.pendingRows = null;
		this.push({ kind: "candidate", frameId: candidate.frameId, reason: "size-pair-sampled", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
	}

	/** Facts observed by the zero-height belowEditor sentinel during this render. */
	sentinel(fact: SentinelFact): void {
		if (this.stopped) return;
		if (this.candidate === null) {
			this.push({ kind: "none", frameId: null, reason: "sentinel-without-candidate", sampledCols: null, sampledRows: null, mode: this.modeValue });
			return;
		}
		if (this.candidate.sentinel === null) this.candidate.sentinel = fact;
	}

	/** A shared-Terminal operation observed on the instance. */
	op(op: TerminalOp): CandidateDecision[] {
		if (this.stopped) return [];
		const before = this.decisions.length;
		this.inOp = true;
		try {
			this.handleOp(op);
		} finally {
			this.inOp = false;
		}
		return this.decisions.slice(before);
	}

	/**
	 * Marker emission through the raw/unwrapped reference. Must never be counted
	 * as a terminal write and must never create or change a decision.
	 */
	markerWrite(kind: "S" | "F" | "A"): void {
		if (this.inOp) {
			this.markerRecursion = true;
			return;
		}
		this.push({ kind: "unsupported", frameId: this.candidate === null ? null : this.candidate.frameId, reason: `marker-write-${kind}-not-counted`, sampledCols: null, sampledRows: null, mode: this.modeValue });
	}

	get sawMarkerRecursion(): boolean {
		return this.markerRecursion;
	}

	/** Synchronous-lifecycle fence: an unresolved candidate never lingers. */
	fence(): void {
		if (this.stopped) return;
		const candidate = this.candidate;
		if (candidate === null) return;
		if (!candidate.sEmitted) {
			this.push({ kind: "none", frameId: candidate.frameId, reason: "expired-without-sync-output", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
			this.candidate = null;
			return;
		}
		if (!this.completed(candidate)) {
			this.push({ kind: "A", frameId: candidate.frameId, reason: "incomplete-at-fence", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
		}
		this.candidate = null;
	}

	/** A lifecycle or ordering event that invalidates the open candidate. */
	abort(reason: string): void {
		const candidate = this.candidate;
		if (candidate === null) return;
		if (candidate.sEmitted) {
			this.push({ kind: "A", frameId: candidate.frameId, reason, sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
		} else {
			this.push({ kind: "none", frameId: candidate.frameId, reason: `${reason}-before-s`, sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
		}
		this.candidate = null;
	}

	stop(): void {
		this.abort("stop");
		this.stopped = true;
	}

	private handleOp(op: TerminalOp): void {
		const candidate = this.candidate;
		if (candidate === null) {
			// (no candidate: this output belongs to no sampling pair)
			this.push({ kind: "none", frameId: null, reason: `op-${op.kind}-without-candidate`, sampledCols: null, sampledRows: null, mode: this.modeValue });
			return;
		}
		// Candidate-origin rule (parent decision, fix2): the sentinel fact must be
		// observed AFTER this sampling pair and BEFORE any real output. A terminal
		// operation arriving first means the pair did not come from the renderer
		// entry for this frame (e.g. a mouse/hover read), so it can never be
		// retroactively completed by a later render's sentinel.
		if (candidate.sentinel === null) {
			this.push({ kind: "none", frameId: candidate.frameId, reason: `op-${op.kind}-before-fresh-sentinel`, sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
			this.candidate = null;
			return;
		}
		if (op.kind !== "write") {
			// Cursor visibility alone can never establish a first/full proof, but
			// after this candidate's CLOSE it is the required final visibility step.
			if (!candidate.sEmitted) {
				this.push({ kind: "none", frameId: candidate.frameId, reason: `${op.kind}-cursor-only-no-proof`, sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
				return;
			}
			if (!candidate.syncCloseSeen) {
				this.abort(`${op.kind}-before-sync-close`);
				return;
			}
			candidate.fVisibilityAfterClose = true;
			this.maybeCompleteRegular(candidate);
			return;
		}
		const text = op.text;
		const hasOpen = text.includes(SYNC_OPEN);
		const hasClose = text.includes(SYNC_CLOSE);
		candidate.writeCount += 1;
		const writeIndex = candidate.writeCount;
		if (!candidate.sEmitted) {
			if (this.modeValue === "fullscreen") {
				if (!hasOpen || !hasClose || !CURSOR_POSITION.test(text)) {
					this.push({ kind: "none", frameId: candidate.frameId, reason: hasOpen ? (hasClose ? "fullscreen-frame-without-cursor" : "fullscreen-sync-block-not-closed") : "no-sync-block", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
					return;
				}
			} else if (!hasOpen) {
				this.push({ kind: "none", frameId: candidate.frameId, reason: "no-sync-open", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
				return;
			}
			// S requires the sentinel fact of THIS render plus valid, unchanged focus.
			if (candidate.sentinel === null) {
				this.push({ kind: "none", frameId: candidate.frameId, reason: "sentinel-missing-at-sync-output", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
				return;
			}
			if (!candidate.sentinel.focusPresent) {
				this.push({ kind: "none", frameId: candidate.frameId, reason: "focus-missing-at-sentinel", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
				return;
			}
			if (candidate.sentinel.mode !== this.modeValue) {
				this.abort("mode-changed");
				return;
			}
			if (this.targetCols !== null && this.targetRows !== null && (candidate.sampledCols !== this.targetCols || candidate.sampledRows !== this.targetRows)) {
				this.abort("sampled-size-mismatch");
				return;
			}
			candidate.sEmitted = true;
			this.push({ kind: "S", frameId: candidate.frameId, reason: this.modeValue === "fullscreen" ? "before-complete-fullscreen-sync-write" : "before-sync-open", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
			if (this.modeValue === "fullscreen") {
				this.push({ kind: "F", frameId: candidate.frameId, reason: "complete-fullscreen-sync-write-with-cursor", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
				this.candidate = null;
				return;
			}
		}
		if (this.modeValue === "regular") {
			// Cross-write state: OPEN and CLOSE may land in different writes.
			if (hasOpen) candidate.syncOpenSeen = true;
			if (hasClose && candidate.syncOpenSeen && !candidate.syncCloseSeen) {
				candidate.syncCloseSeen = true;
				candidate.closeWriteIndex = writeIndex;
			} else if (candidate.syncCloseSeen && writeIndex > (candidate.closeWriteIndex ?? 0)) {
				// A write after the completed sync block is the cursor parking write.
				candidate.cursorParkingAfterClose = true;
			}
			this.maybeCompleteRegular(candidate);
		}
	}

	private maybeCompleteRegular(candidate: Candidate): void {
		if (this.modeValue !== "regular") return;
		if (candidate.syncCloseSeen && candidate.cursorParkingAfterClose && candidate.fVisibilityAfterClose) {
			this.push({ kind: "F", frameId: candidate.frameId, reason: "regular-open-close-park-and-visibility", sampledCols: candidate.sampledCols, sampledRows: candidate.sampledRows, mode: this.modeValue });
			this.candidate = null;
		}
	}

	private completed(candidate: Candidate): boolean {
		if (this.modeValue === "fullscreen") return candidate.sEmitted;
		return candidate.sEmitted && candidate.syncOpenSeen && candidate.syncCloseSeen && candidate.cursorParkingAfterClose && candidate.fVisibilityAfterClose;
	}

	private push(decision: CandidateDecision): void {
		this.decisions.push(decision);
	}
}

/** Convenience: decisions that would be published to the runner. */
export function publishedDecisions(decisions: readonly CandidateDecision[]): CandidateDecision[] {
	return decisions.filter((decision) => decision.kind === "S" || decision.kind === "F" || decision.kind === "A");
}

/** Convenience: candidate identities in stream order. */
export function candidateFrameIds(decisions: readonly CandidateDecision[]): number[] {
	return decisions.filter((decision) => decision.kind === "candidate").map((decision) => decision.frameId as number);
}
