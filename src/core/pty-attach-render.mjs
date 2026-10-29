import { validateFrameMetadata } from "./attach-frame-proof.mjs";

/**
 * Decide whether the next attach repaint should force a full clear.
 *
 * The first attach paint always forces once so the previous dashboard/session surface
 * cannot ghost behind the overlay. Later paints stay differential unless a caller
 * explicitly requests a hard reset.
 */
export function nextAttachRender(firstPaint, force = false) {
	return {
		force: Boolean(force || firstPaint),
		firstPaint: false,
	};
}

/**
 * Attach output should repaint only after @xterm/headless finishes parsing the chunk.
 * Status/control messages can repaint immediately because they mutate header/overlay state.
 */
export function shouldScheduleAttachRenderForMessage(type) {
	return type === "hello" || type === "status" || type === "exit" || type === "error";
}

export const ATTACH_OUTPUT_RENDER_INTERVAL_MS = 40;

/**
 * Resolve the PTY cursor to an ABSOLUTE buffer row for the projected window
 * [start, start + height). xterm's buffer cursorY is relative to baseY (the child
 * terminal's viewport top when scrolled to bottom), so the absolute row is
 * baseY + cursorY. Returns null when the cursor is outside the projected window
 * (e.g. the user scrolled up into history).
 *
 * The returned row must stay absolute: projection loops pass absolute buffer
 * indices (buf.getLine(i) for i in [start, end)) and mouse selection points are
 * absolute too. Returning a start-relative row only matches while start === 0;
 * once scrollback exists the cursor cell never matches, which silently drops the
 * visible PTY-cursor block AND the CURSOR_MARKER used to position the hardware
 * cursor for IME candidate windows.
 */
export function projectPtyCursor(buf, start, height) {
	if (typeof buf.cursorX !== "number" || typeof buf.cursorY !== "number" || buf.cursorX < 0 || buf.cursorY < 0) return null;
	const row = buf.baseY + buf.cursorY;
	if (row < start || row >= start + height) return null;
	return { row, col: buf.cursorX };
}

/**
 * Duck-typed read of the child terminal's DECTCEM visibility state.
 *
 * pi-tui hides the hardware cursor (ESC[?25l) on essentially every frame and
 * still parks it for IME positioning, so the xterm cursor position outlives its
 * visibility: it is a rendering byproduct, not a request to show a cursor. The
 * attach projection must not resurrect that parked cell as a visible block, and
 * must equally not hide a cursor the child wants shown (shells, vim,
 * PI_HARDWARE_CURSOR=1). Only an explicit `true` from xterm's cursor service
 * counts as hidden; anything unknown (renamed internals, another @xterm build)
 * falls back to visible, which is the pre-#102 behavior.
 */
export function isPtyCursorHidden(term) {
	try {
		return term?._core?.coreService?.isCursorHidden === true;
	} catch {
		return false;
	}
}

/**
 * Coalesce PTY parser callbacks into a bounded stream of repaint requests.
 *
 * node-pty commonly splits one child-TUI update across many small chunks. Rendering
 * after each @xterm/headless write callback exposes those intermediate frames and can
 * drive the outer TUI near its 60 fps limit. A trailing throttle keeps output live
 * while presenting only parsed snapshots at roughly 25 fps.
 */
export function createAttachOutputRenderScheduler(requestRender, delayMs = ATTACH_OUTPUT_RENDER_INTERVAL_MS) {
	let timer = null;
	let disposed = false;
	return {
		request() {
			if (disposed || timer) return;
			timer = setTimeout(() => {
				timer = null;
				if (!disposed) requestRender();
			}, delayMs);
			timer.unref?.();
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = null;
		},
		dispose() {
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}

/**
 * Classify the PTY cursor's alignment for runtime desync detection (issue #11).
 *
 * Healthy idle pi: the child pi-tui parks the hardware cursor on the editor
 * marker, whose cell is the inverse-video "fake cursor" — so the cursor cell
 * itself is inverse. A desynced buffer leaves the cursor parked elsewhere
 * (typically where the last differential write ended), on a non-inverse cell.
 * Width-0 cells are CJK continuation cells and out-of-range columns sit past
 * the line's cells; in both cases the meaningful attribute lives on the
 * preceding cell, so we look left. Returns:
 *   "aligned"    — cursor resolves to an inverse cell (healthy);
 *   "misaligned" — cursor resolves to a non-inverse cell (candidate desync;
 *                  callers gate this with an output-quietness window);
 *   "unknown"    — no cursor (scrolled out of the projected viewport) or no
 *                  buffer line (defensive); never treat these as desync.
 */
export function detectCursorDesync(buf, cursor) {
	if (!cursor) return "unknown";
	const line = buf.getLine(cursor.row);
	if (!line) return "unknown";
	let x = cursor.col;
	let cell = line.getCell(x);
	while ((!cell || cell.getWidth() === 0) && x > 0) {
		x--;
		cell = line.getCell(x);
	}
	if (!cell) return "misaligned";
	return cell.isInverse() ? "aligned" : "misaligned";
}

/**
 * Source-comparison gate for a committed view projection (spec §4.2/§4.3).
 * A projection may be shown only while every identity axis still matches the
 * current connection/baseline/parser/geometry target. Missing/unknown facts and
 * a closed component always fail closed.
 */
export function canPublishAttachView(viewIdentity, currentIdentity) {
	if (viewIdentity === null || typeof viewIdentity !== "object" || Array.isArray(viewIdentity)) return false;
	if (currentIdentity === null || typeof currentIdentity !== "object" || Array.isArray(currentIdentity)) return false;
	if (viewIdentity.closed === true || currentIdentity.closed === true) return false;
	const known = (value) => value !== null && value !== undefined && !(typeof value === "string" && value.length === 0) && !(typeof value === "number" && !Number.isFinite(value));
	for (const key of ["connectionToken", "baselineToken", "generation", "parser", "geometryRevision", "targetCols", "targetRows"]) {
		if (!known(viewIdentity[key]) || !known(currentIdentity[key])) return false;
		if (viewIdentity[key] !== currentIdentity[key]) return false;
	}
	if (!Number.isInteger(viewIdentity.targetCols) || viewIdentity.targetCols < 1) return false;
	if (!Number.isInteger(viewIdentity.targetRows) || viewIdentity.targetRows < 1) return false;
	if (!Number.isInteger(viewIdentity.geometryRevision) || viewIdentity.geometryRevision < 0) return false;
	return true;
}

/**
 * Pure §4 presentation decision. It consumes only immutable facts — no clock,
 * timer, terminal or I/O. `deadlineState:"expired"` can only change a WAIT
 * reason; it can never upgrade an incomplete view to publish. Legacy decisions
 * stay independent of proof facts.
 *
 * @param {{
 *   closed?: boolean,
 *   mode?: "undecided" | "protocol" | "legacy" | "raw" | string,
 *   baselineState?: "unverified" | "hydrating" | "valid-empty" | "valid-content" | "undecided" | string,
 *   localParseComplete?: boolean,
 *   frameState?: "unknown" | "open" | "complete" | string,
 *   openSyncBlock?: boolean,
 *   openCandidate?: boolean,
 *   contentAvailable?: boolean,
 *   contentKind?: "complete" | "boot" | "raw" | string,
 *   localSeq?: number,
 *   viewProof?: any,
 *   viewIdentity?: any,
 *   currentIdentity?: any,
 *   targetCols?: number,
 *   targetRows?: number,
 *   geometryRevision?: number,
 *   requiredGeometryRevision?: number,
 *   resizeIntentRequired?: boolean,
 *   resizeIntentSatisfied?: boolean,
 *   intentId?: number,
 *   deadlineState?: "pending" | "expired",
 * }} state
 * @returns {{ action: "closed" | "legacy" | "wait" | "publish", reason: string }}
 */
export function decideAttachPresentation(state) {
	if (state === null || typeof state !== "object" || Array.isArray(state)) return { action: "wait", reason: "state-missing" };
	if (state.closed === true) return { action: "closed", reason: "closed" };
	if (state.mode === "closed") return { action: "closed", reason: "closed" };
	if (state.mode === "legacy") return { action: "legacy", reason: "legacy-mode" };
	const wait = (reason) => ({
		action: "wait",
		reason: state.deadlineState === "expired" ? `deadline-expired:${reason}` : reason,
	});
	if (state.mode !== "protocol") return wait(`mode-${state.mode ?? "unknown"}`);
	if (state.baselineState !== "valid-content" && state.baselineState !== "valid-empty") {
		if (state.baselineState === "hydrating") return wait("baseline-hydrating");
		if (state.baselineState === "unverified") return wait("baseline-unverified");
		return wait("baseline-unknown");
	}
	if (state.localParseComplete !== true) return wait("local-parse-incomplete");
	if (state.frameState === "open") return wait("sync-open");
	if (state.frameState !== "complete") return wait("frame-incomplete");
	if (state.openSyncBlock === true) return wait("sync-open");
	if (state.openCandidate === true) return wait("candidate-open");
	if (state.baselineState === "valid-empty") {
		if (!Number.isInteger(state.localSeq) || state.localSeq < 1) return wait("empty-baseline-needs-live-complete");
	}
	if (state.contentKind === "boot") return wait("boot-content");
	if (state.contentKind === "raw") return wait("raw-content");
	if (state.contentKind !== "complete") return wait("content-kind-unknown");
	if (state.contentAvailable !== true) return wait("content-missing");
	if (!Number.isInteger(state.targetCols) || state.targetCols < 1) return wait("geometry-unknown");
	if (!Number.isInteger(state.targetRows) || state.targetRows < 1) return wait("geometry-unknown");
	const coverage = state.viewProof;
	if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) return wait("view-proof-missing");
	if (coverage.status !== "covered") return wait(`view-proof-${coverage.status ?? "unknown"}`);
	if (!Number.isInteger(coverage.throughSeq)) return wait("view-proof-invalid");
	if (!Number.isInteger(state.localSeq) || coverage.throughSeq < state.localSeq) return wait("view-proof-behind");
	if (coverage.throughSeq > state.localSeq) return wait("view-proof-future");
	if (coverage.proof === null || typeof coverage.proof !== "object" || Array.isArray(coverage.proof)) return wait("view-proof-missing");
	if (coverage.proof.marker !== "F" || !Number.isInteger(coverage.proof.seq) || coverage.proof.seq > coverage.throughSeq) return wait("view-proof-invalid");
	const metadata = validateFrameMetadata(coverage.proof.metadata);
	if (!metadata.ok) return wait("view-proof-invalid");
	if (metadata.value.cols !== state.targetCols || metadata.value.rows !== state.targetRows) return wait("proof-geometry-mismatch");
	if (state.requiredGeometryRevision !== undefined && metadata.value.geometryRevision !== state.requiredGeometryRevision) return wait("geometry-revision");
	if (state.resizeIntentRequired === true) {
		if (state.resizeIntentSatisfied !== true) return wait("resize-intent");
		if (metadata.value.intentId !== state.intentId || metadata.value.intentId === 0) return wait("resize-intent");
	}
	if (!canPublishAttachView(state.viewIdentity, state.currentIdentity)) return wait("identity-mismatch");
	return { action: "publish", reason: "complete" };
}
