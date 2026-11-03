// Independent terminal presentation observer for issue #222 (spec A10; plan
// step 12: replaceable Terminal + metadata, plan step 13: visibility boundary
// semantics). A drop-in replacement for the pi-tui `Terminal` interface that
// can be handed to the REAL Tui/TuiAltScreen: every caller `Terminal.write()`
// byte is forwarded UNCHANGED and in receipt order into an independent
// @xterm/headless terminal, and the resulting grid is observed — never
// `component.render()` calls, never candidate ready flags, and never a
// `requestRender()` shim.
//
// Boundary contract (all times are parent-process monotonic `now()` values;
// write indices refer to the caller-only `writes` list):
//
// - "frame": one matched `CSI ? 2026 h` … `CSI ? 2026 l` synchronized-update
//   block, detected through the xterm PUBLIC parser hooks
//   (`parser.registerCsiHandler({ prefix: "?", final: "h" | "l" })`). The grid
//   snapshot is taken INSIDE the close hook, i.e. the moment the closing
//   delimiter is parsed and before any later byte (same write or not) can
//   overwrite the buffer. Blocks spanning multiple writes, delimiters split
//   across writes, two complete blocks in one write, and close-then-open in
//   one write all fall out of the parser's own sequence tracking — this
//   fixture deliberately adds NO competing ANSI/regex parser. Every decoded
//   numeric private-mode parameter is honored in parameter order (e.g.
//   `CSI ? 25 ; 2026 h` both shows the cursor and opens a block). Both hooks
//   return false so xterm's default handlers keep running unchanged.
// - "unframed" potential-visibility windows, explicitly conservative:
//   (a) ENTRY window — every outside→inside open transition snapshots the grid
//       at the open boundary (note "sync-entry"): the last state that could be
//       visible before the block's bytes land, including an unframed prefix
//       earlier in the same write. For a bare OPEN write this duplicates the
//       prior state; that duplicate is deliberate because exact byte positions
//       belong to the parser, not to this observer.
//   (b) WRITE-END window — a caller write that ends OUTSIDE a block and either
//       started outside or contained a matched close snapshots the grid when
//       that write finishes parsing. A write ending INSIDE a block leaves no
//       window: bytes of an unfinished block are never advertised as a
//       visible state.
//   (c) An unmatched close (no open block) is an idempotent reset, never a
//       frame: it is attributed to its write's window via note
//       "unmatched-close". A repeated OPEN is a mode set and never resets a
//       frame's opening identity.
//
// Frames and windows are append-only and deeply frozen: a later correct frame
// can never mutate or erase an earlier (anomalous) record, which is what the
// separately gated step-14 five-case negative-oracle battery will consume.
// The observer records cursor position (viewport-relative and absolute) and
// DECTCEM visibility as DATA together with per-cell attributes (including
// inverse); it never interprets inverse-video cells as a software cursor —
// any cursor expectation belongs to an explicit oracle that can allow active
// selection semantics. Capture truth is independent of attach readiness: this
// fixture knows nothing about PtyAttachComponent state.
//
// Cursor controls: ProcessTerminal.hideCursor()/showCursor() emit
// `\x1b[?25l`/`\x1b[?25h` (terminal.js:440-445) and the real TUI calls them
// (tui.js:487/565/612), so those two controls enqueue the same bytes as
// CONTROL-DERIVED parser entries, ordered with pending caller writes: the
// effect lands in stream order (never retroactively on an earlier queued
// frame), is identified in `controls` via `emitted`, and never masquerades as
// a caller write in `writes`. The real TUI calls no other control method with
// a presentation effect, so the remaining controls are recorded only.

import xtermHeadless from "@xterm/headless";
import type { IBufferCell, IDisposable } from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui/dist/terminal.js";

// @xterm/headless is CommonJS; named import from ESM fails, so destructure
// (same pattern as src/core/terminal-model.mjs).
const { Terminal: HeadlessTerminal } = /** @type {any} */ (xtermHeadless);

/** One immutable grid cell: the character plus every attribute an oracle may need. */
export interface ObservedCell {
	readonly chars: string;
	readonly width: number;
	readonly fgColorMode: number;
	readonly fgColor: number;
	readonly bgColorMode: number;
	readonly bgColor: number;
	readonly bold: boolean;
	readonly italic: boolean;
	readonly dim: boolean;
	readonly underline: boolean;
	readonly blink: boolean;
	readonly inverse: boolean;
	readonly invisible: boolean;
	readonly strikethrough: boolean;
	readonly overline: boolean;
}

/** One immutable viewport row: trimmed text plus the full-width cell copy. */
export interface ObservedRow {
	readonly text: string;
	readonly cells: readonly ObservedCell[];
}

/** Hardware-cursor data at a boundary; visibility tracks observed DECTCEM (?25h/l). */
export interface ObservedCursor {
	readonly x: number;
	readonly y: number;
	readonly absoluteY: number;
	readonly visible: boolean;
}

/** One exact caller `Terminal.write()` call, in receipt order. */
export interface ObservedWrite {
	readonly index: number;
	readonly data: string;
	readonly receivedAt: number;
}

/**
 * One non-write Terminal control call, in receipt order. `emitted` holds the
 * bytes the control enqueues into the parser stream (only hideCursor/showCursor
 * have a demonstrated presentation effect); null for record-only controls.
 */
export interface ObservedControl {
	readonly index: number;
	readonly method: string;
	readonly at: number;
	readonly emitted: string | null;
}

export type ObservationKind = "frame" | "unframed";

/**
 * One observed presentation state. For "frame": the immutable grid/cursor at
 * a MATCHED synchronized-update closing boundary; `openWriteIndex`/
 * `closeWriteIndex` attribute the block to entries of `writes` (equal when the
 * block fit in one write). For "unframed": a potential-visibility window;
 * `openWriteIndex` is -1 and `closeWriteIndex` is the write being parsed
 * (`note` is "sync-entry", "unmatched-close", or null for ordinary windows).
 */
export interface PresentationObservation {
	readonly index: number;
	readonly kind: ObservationKind;
	readonly openWriteIndex: number;
	readonly closeWriteIndex: number;
	readonly openParsedAt: number;
	readonly boundaryParsedAt: number;
	readonly note: string | null;
	readonly cols: number;
	readonly rows: number;
	readonly baseY: number;
	readonly cursor: ObservedCursor;
	readonly grid: readonly ObservedRow[];
}

/**
 * Compile-time conformance guard: proves `AttachPresentationObserver` satisfies
 * pi-tui's `Terminal` under the strict standalone typecheck (the repository
 * tsconfig excludes test-support, so this assignment is part of the checked
 * evidence alongside the explicit tsc command in the task-2a report).
 */
export function asTerminal(observer: AttachPresentationObserver): Terminal {
	return observer;
}

export interface AttachPresentationObserverOptions {
	cols: number;
	rows: number;
	scrollback?: number;
	/** Monotonic clock; defaults to performance.now. Injectable for determinism. */
	now?: () => number;
}

/**
 * Internal FIFO parse entry. Caller writes and control-derived byte injections
 * share one queue so their parser effects interleave in exact call order.
 */
type PendingEntry =
	| { kind: "write"; index: number; sawClose: boolean; unmatchedClose: boolean }
	| { kind: "control"; index: number };

export class AttachPresentationObserver implements Terminal {
	private readonly headless: InstanceType<typeof HeadlessTerminal>;
	private readonly now: () => number;
	private readonly termCols: number;
	private readonly termRows: number;
	private readonly writesList: ObservedWrite[] = [];
	private readonly observationsList: PresentationObservation[] = [];
	private readonly controlsList: ObservedControl[] = [];
	private readonly pending: PendingEntry[] = [];
	private readonly csiDisposables: IDisposable[] = [];
	private readonly idleWaiters: Array<() => void> = [];
	private pendingCount = 0;
	private syncOpen = false;
	private syncStateAtLastEntryEnd = false;
	private openWriteIndex = -1;
	private openParsedAt = -1;
	private cursorVisible = true;
	private disposed = false;
	private inputCallback: ((data: string) => void) | undefined;
	private resizeCallback: (() => void) | undefined;

	constructor(options: AttachPresentationObserverOptions) {
		this.termCols = options.cols;
		this.termRows = options.rows;
		this.now = options.now ?? (() => performance.now());
		this.headless = new HeadlessTerminal({
			cols: options.cols,
			rows: options.rows,
			scrollback: options.scrollback ?? 0,
			allowProposedApi: true,
		});
		// Observational hooks only: returning false hands every sequence back to
		// xterm's default handlers, so SGR/CUP/DECSET behavior is untouched.
		this.csiDisposables.push(
			this.headless.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params: (number | number[])[]) => {
				this.observePrivateModes(params, true);
				return false;
			}),
			this.headless.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params: (number | number[])[]) => {
				this.observePrivateModes(params, false);
				return false;
			}),
		);
	}

	// ---- observation surface ------------------------------------------------

	/** Exact caller writes in receipt order (frozen entries; frozen list copy). */
	get writes(): readonly ObservedWrite[] {
		return Object.freeze(this.writesList.slice());
	}

	/** Append-only frames and unframed windows in stream order (deeply frozen). */
	get observations(): readonly PresentationObservation[] {
		return Object.freeze(this.observationsList.slice());
	}

	/** Non-write control calls in receipt order, with any control-derived bytes. */
	get controls(): readonly ObservedControl[] {
		return Object.freeze(this.controlsList.slice());
	}

	/** Input callback captured by start(), exposed so consumers can inject input. */
	get inputHandler(): ((data: string) => void) | undefined {
		return this.inputCallback;
	}

	/** Resize callback captured by start(), exposed so consumers can inject resizes. */
	get resizeHandler(): (() => void) | undefined {
		return this.resizeCallback;
	}

	/** Resolve once every queued entry received so far has been fully parsed. */
	whenIdle(): Promise<void> {
		if (this.pendingCount === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const disposable of this.csiDisposables) disposable.dispose();
		try {
			this.headless.dispose();
		} catch {
			/* best-effort teardown */
		}
		const waiters = this.idleWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	// ---- Terminal interface -------------------------------------------------

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputCallback = onInput;
		this.resizeCallback = onResize;
	}

	stop(): void {}

	drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		const index = this.writesList.length;
		this.writesList.push(Object.freeze({ index, data, receivedAt: this.now() }));
		this.enqueue({ kind: "write", index, sawClose: false, unmatchedClose: false }, data);
	}

	get columns(): number {
		return this.termCols;
	}

	get rows(): number {
		return this.termRows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(lines: number): void {
		this.recordControl(`moveBy(${lines})`, null);
	}

	hideCursor(): void {
		// ProcessTerminal emits the DECTCEM reset; queue the same bytes so the
		// effect lands in stream order with pending caller writes.
		this.recordControl("hideCursor", "\x1b[?25l");
	}

	showCursor(): void {
		this.recordControl("showCursor", "\x1b[?25h");
	}

	clearLine(): void {
		this.recordControl("clearLine", null);
	}

	clearFromCursor(): void {
		this.recordControl("clearFromCursor", null);
	}

	clearScreen(): void {
		this.recordControl("clearScreen", null);
	}

	setTitle(title: string): void {
		this.recordControl(`setTitle(${JSON.stringify(title)})`, null);
	}

	setProgress(active: boolean): void {
		this.recordControl(`setProgress(${active})`, null);
	}

	setProgramStatus(status: unknown): void {
		this.recordControl("setProgramStatus", null);
	}

	// ---- internals ------------------------------------------------------------

	private enqueue(entry: PendingEntry, data: string): void {
		this.pending.push(entry);
		this.pendingCount += 1;
		this.headless.write(data, () => this.onEntryParsed());
	}

	private recordControl(method: string, emitted: string | null): void {
		const index = this.controlsList.length;
		this.controlsList.push(Object.freeze({ index, method, at: this.now(), emitted }));
		if (emitted !== null) {
			this.enqueue({ kind: "control", index }, emitted);
		}
	}

	/**
	 * Parser hook: observe EVERY decoded numeric private-mode parameter in
	 * parameter order (xterm applies them all after we return false). Only 2026
	 * (synchronized output) and 25 (DECTCEM cursor visibility) have
	 * observational meaning here; anything else is left to the default handler.
	 */
	private observePrivateModes(params: (number | number[])[], set: boolean): void {
		for (const param of params) {
			if (typeof param !== "number") continue;
			if (param === 2026) {
				if (set) this.onSyncOpen();
				else this.onSyncClose();
			} else if (param === 25) {
				this.cursorVisible = set;
			}
		}
	}

	/**
	 * Parser hook: a `?2026h` was just parsed. A genuine outside→inside
	 * transition takes over frame identity and snapshots the entry boundary:
	 * the last state that could be visible before this block's bytes land
	 * (including an unframed prefix earlier in the same write). A repeated OPEN
	 * inside a block is a mode set and keeps the original opening identity.
	 */
	private onSyncOpen(): void {
		if (this.syncOpen) return;
		this.syncOpen = true;
		const entry = this.pending[0];
		this.openWriteIndex = entry && entry.kind === "write" ? entry.index : -1;
		this.openParsedAt = this.now();
		this.pushObservation("unframed", -1, this.openWriteIndex, -1, "sync-entry");
	}

	/**
	 * Parser hook: a `?2026l` was just parsed. Only a MATCHED close commits a
	 * frame, snapshotting now — the buffer still reflects every byte of the
	 * closing block and none of the bytes after the delimiter. An unmatched
	 * close is an idempotent reset, attributed to its write's window.
	 */
	private onSyncClose(): void {
		const entry = this.pending[0];
		if (!this.syncOpen) {
			if (entry && entry.kind === "write") entry.unmatchedClose = true;
			return;
		}
		const closeWriteIndex = entry && entry.kind === "write" ? entry.index : -1;
		this.pushObservation("frame", this.openWriteIndex, closeWriteIndex, this.openParsedAt, null);
		if (entry && entry.kind === "write") entry.sawClose = true;
		this.syncOpen = false;
	}

	/** Parse-entry callback: one entry is fully parsed, in strict FIFO order. */
	private onEntryParsed(): void {
		const entry = this.pending.shift();
		if (!entry) return;
		if (entry.kind === "write") {
			const startedOutside = !this.syncStateAtLastEntryEnd;
			const endedOutside = !this.syncOpen;
			const write = this.writesList[entry.index];
			if (write.data.length > 0 && endedOutside && (startedOutside || entry.sawClose)) {
				this.pushObservation("unframed", -1, entry.index, -1, entry.unmatchedClose ? "unmatched-close" : null);
			}
		}
		this.syncStateAtLastEntryEnd = this.syncOpen;
		this.pendingCount -= 1;
		if (this.pendingCount === 0 && this.idleWaiters.length > 0) {
			const waiters = this.idleWaiters.splice(0);
			for (const resolve of waiters) resolve();
		}
	}

	private pushObservation(kind: ObservationKind, openWriteIndex: number, closeWriteIndex: number, openParsedAt: number, note: string | null): void {
		const buffer = this.headless.buffer.active;
		const grid: ObservedRow[] = [];
		for (let y = 0; y < this.termRows; y++) {
			const line = buffer.getLine(buffer.baseY + y);
			const cells: ObservedCell[] = [];
			if (line) {
				const cell: IBufferCell = this.headless.buffer.active.getNullCell();
				for (let x = 0; x < this.termCols; x++) {
					if (!line.getCell(x, cell)) break;
					cells.push(
						Object.freeze({
							chars: cell.getChars(),
							width: cell.getWidth(),
							fgColorMode: cell.getFgColorMode(),
							fgColor: cell.getFgColor(),
							bgColorMode: cell.getBgColorMode(),
							bgColor: cell.getBgColor(),
							bold: cell.isBold() !== 0,
							italic: cell.isItalic() !== 0,
							dim: cell.isDim() !== 0,
							underline: cell.isUnderline() !== 0,
							blink: cell.isBlink() !== 0,
							inverse: cell.isInverse() !== 0,
							invisible: cell.isInvisible() !== 0,
							strikethrough: cell.isStrikethrough() !== 0,
							overline: cell.isOverline() !== 0,
						}),
					);
				}
			}
			grid.push(
				Object.freeze({
					text: line ? line.translateToString(true) : "",
					cells: Object.freeze(cells),
				}),
			);
		}
		const cursor: ObservedCursor = Object.freeze({
			x: buffer.cursorX,
			y: buffer.cursorY,
			absoluteY: buffer.baseY + buffer.cursorY,
			visible: this.cursorVisible,
		});
		this.observationsList.push(
			Object.freeze({
				index: this.observationsList.length,
				kind,
				openWriteIndex,
				closeWriteIndex,
				openParsedAt,
				boundaryParsedAt: this.now(),
				note,
				cols: this.termCols,
				rows: this.termRows,
				baseY: buffer.baseY,
				cursor,
				grid: Object.freeze(grid),
			}),
		);
	}
}

// ---------------------------------------------------------------------------
// Step 14: independent presentation oracle
//
// `validateAttachPresentation()` compares the observer's immutable history with
// complete screens specified LITERALLY by the scenario (row text,
// frame/source IDs, hardware cursor, inverse-video cells). Nothing here
// consults PtyAttachComponent state, candidate readiness flags, or
// component.render(), and no expected grid is derived from captured bytes.
//
// Semantics:
// - `screens` are complete, ordered accepted states. An observation may repeat
//   the current state or advance to a later one; a state that was already
//   passed and reappears is a `stale-screen` failure (history never regresses).
//   The oracle does not require every accepted screen to occur — scenario
//   consumers assert the specific captured frames their case needs.
// - EVERY observation is validated, including unframed windows whose note is
//   "sync-entry" or "unmatched-close": those notes are diagnostic context,
//   never proof that the bytes were invisible.
// - A shorter `rows` list means the remaining viewport rows must be blank.
//   A loading screen is an allowed complete screen only as the literal grid
//   declared here; extra content is reported as `loading-artifact`.
// - `inverseCells` is the complete expected inverse-cell set: legitimate
//   selection cells and any software cursor are declared the same way, and
//   extra/missing cells are reported by coordinate. The oracle never treats a
//   bare inverse attribute as a cursor verdict on its own.
// - All observations are evaluated, so a later good state never removes an
//   earlier failure. Failures are plain JSON-serializable
//   `{ index, category, expected, actual }` objects.
// ---------------------------------------------------------------------------

/** A 0-based viewport cell coordinate. */
export interface PresentationCellPoint {
	readonly x: number;
	readonly y: number;
}

/** Literal expected hardware-cursor state at a complete boundary (viewport coordinates). */
export interface ExpectedPresentationCursor {
	readonly x: number;
	readonly y: number;
	readonly visible: boolean;
}

/**
 * One complete presentation state, specified independently of the capture:
 * literal row text, optional declared frame/source IDs, hardware cursor, and
 * the complete set of inverse-video cells. A shorter `rows` list means the
 * remaining viewport rows must be blank.
 */
export interface ExpectedPresentationScreen {
	readonly name: string;
	readonly rows: readonly string[];
	/**
	 * Frame/source ID per row (null = no ID). IDs are distinct literal tokens
	 * used for categorization; full row text is still compared literally.
	 */
	readonly rowFrameIds?: readonly (string | null)[];
	readonly cursor?: ExpectedPresentationCursor;
	/** Complete expected inverse-video cell set; omit to skip the check, [] to require none. */
	readonly inverseCells?: readonly PresentationCellPoint[];
	readonly loading?: boolean;
}

/** Ordered accepted screens plus the controlled child's known frame/source IDs. */
export interface AttachPresentationExpectation {
	readonly screens: readonly ExpectedPresentationScreen[];
	readonly frameIds?: readonly string[];
}

/** One serializable oracle failure, attributed to an observed state index. */
export interface PresentationFailure {
	readonly index: number;
	readonly category: string;
	readonly expected: unknown;
	readonly actual: unknown;
}

function expectedRowText(screen: ExpectedPresentationScreen, y: number): string {
	return screen.rows[y] ?? "";
}

function rowTexts(observation: PresentationObservation): string[] {
	return observation.grid.map((row) => row.text);
}

function rowMismatch(
	observation: PresentationObservation,
	screen: ExpectedPresentationScreen,
): { row: number; expected: string; actual: string } | null {
	const height = Math.max(screen.rows.length, observation.grid.length);
	for (let y = 0; y < height; y++) {
		const expected = expectedRowText(screen, y);
		const actual = observation.grid[y]?.text ?? "";
		if (expected !== actual) return { row: y, expected, actual };
	}
	return null;
}

function rowFrameIdsSatisfied(observation: PresentationObservation, screen: ExpectedPresentationScreen): boolean {
	if (!screen.rowFrameIds) return true;
	for (let y = 0; y < screen.rowFrameIds.length; y++) {
		const frameId = screen.rowFrameIds[y];
		if (frameId === null || frameId === undefined) continue;
		if (!(observation.grid[y]?.text ?? "").includes(frameId)) return false;
	}
	return true;
}

function cursorMatches(observed: ObservedCursor, expected: ExpectedPresentationCursor): boolean {
	return observed.x === expected.x && observed.y === expected.y && observed.visible === expected.visible;
}

function observedInverseCells(observation: PresentationObservation): PresentationCellPoint[] {
	const points: PresentationCellPoint[] = [];
	for (let y = 0; y < observation.grid.length; y++) {
		const cells = observation.grid[y].cells;
		for (let x = 0; x < cells.length; x++) {
			// Width-0 cells continue a wide character and would double-count one
			// painted column.
			if (cells[x].inverse && cells[x].width !== 0) points.push({ x, y });
		}
	}
	return points;
}

function cellKey(point: PresentationCellPoint): string {
	return `${point.x},${point.y}`;
}

function compareCells(a: PresentationCellPoint, b: PresentationCellPoint): number {
	return a.y - b.y || a.x - b.x;
}

function inverseCellDiff(
	observation: PresentationObservation,
	expectedCells: readonly PresentationCellPoint[],
): { extraInverseCells: PresentationCellPoint[]; missingInverseCells: PresentationCellPoint[] } {
	const actualCells = observedInverseCells(observation);
	const actualKeys = new Set(actualCells.map(cellKey));
	const expectedKeys = new Set(expectedCells.map(cellKey));
	return {
		extraInverseCells: actualCells.filter((cell) => !expectedKeys.has(cellKey(cell))).sort(compareCells),
		missingInverseCells: expectedCells
			.filter((cell) => !actualKeys.has(cellKey(cell)))
			.map((cell) => ({ x: cell.x, y: cell.y }))
			.sort(compareCells),
	};
}

function inverseCellsMatch(observation: PresentationObservation, expectedCells: readonly PresentationCellPoint[]): boolean {
	const diff = inverseCellDiff(observation, expectedCells);
	return diff.extraInverseCells.length === 0 && diff.missingInverseCells.length === 0;
}

function screenMatches(observation: PresentationObservation, screen: ExpectedPresentationScreen): boolean {
	return (
		rowMismatch(observation, screen) === null &&
		rowFrameIdsSatisfied(observation, screen) &&
		(!screen.cursor || cursorMatches(observation.cursor, screen.cursor)) &&
		(!screen.inverseCells || inverseCellsMatch(observation, screen.inverseCells))
	);
}

function isBlankObservation(observation: PresentationObservation): boolean {
	return observation.grid.every((row) => row.text.length === 0);
}

/** Non-blank equal rows identify a screen; shared blank padding does not. */
function rowIdentityScore(observation: PresentationObservation, screen: ExpectedPresentationScreen): number {
	let score = 0;
	const height = Math.max(screen.rows.length, observation.grid.length);
	for (let y = 0; y < height; y++) {
		const expected = expectedRowText(screen, y);
		if (expected === "") continue;
		if ((observation.grid[y]?.text ?? "") === expected) score += 1;
	}
	return score;
}

/**
 * Pick the screen an observation most plausibly attempted, so a frame with the
 * target rows but a wrong cursor is categorized as a cursor failure instead of
 * a generic row mismatch. Ties keep the current expected screen.
 */
function bestScreen(
	observation: PresentationObservation,
	screens: readonly ExpectedPresentationScreen[],
	position: number,
): ExpectedPresentationScreen {
	let bestIndex = position;
	let bestScore = rowIdentityScore(observation, screens[position]);
	for (let step = 1; step < screens.length; step++) {
		const index = (position + step) % screens.length;
		const score = rowIdentityScore(observation, screens[index]);
		if (score > bestScore) {
			bestIndex = index;
			bestScore = score;
		}
	}
	return screens[bestIndex];
}

function frameIdFailure(
	observation: PresentationObservation,
	screen: ExpectedPresentationScreen,
	expectation: AttachPresentationExpectation,
): PresentationFailure | null {
	const knownFrameIds = expectation.frameIds;
	if (!screen.rowFrameIds || !knownFrameIds || knownFrameIds.length === 0) return null;
	let matchedRows = 0;
	const mismatchedRows: Array<{ row: number; expectedId: string; actualId: string }> = [];
	const height = Math.max(screen.rowFrameIds.length, observation.grid.length);
	for (let y = 0; y < height; y++) {
		const expectedId = screen.rowFrameIds[y];
		if (expectedId === null || expectedId === undefined) continue;
		const text = observation.grid[y]?.text ?? "";
		const actualId = knownFrameIds.find((id) => text.includes(id)) ?? null;
		if (actualId === expectedId) {
			matchedRows += 1;
		} else if (actualId !== null) {
			mismatchedRows.push({ row: y, expectedId, actualId });
		}
	}
	if (mismatchedRows.length === 0) return null;
	const first = mismatchedRows[0];
	return {
		index: observation.index,
		category: matchedRows > 0 ? "mixed-frame-id" : "frame-id",
		expected: { screen: screen.name, row: first.row, frameId: first.expectedId, text: expectedRowText(screen, first.row) },
		actual: {
			row: first.row,
			frameId: first.actualId,
			text: observation.grid[first.row]?.text ?? "",
			kind: observation.kind,
			note: observation.note,
		},
	};
}

function classifyFailure(
	observation: PresentationObservation,
	screen: ExpectedPresentationScreen,
	expectation: AttachPresentationExpectation,
): PresentationFailure {
	const mismatch = rowMismatch(observation, screen);
	if (mismatch) {
		const frameFailure = frameIdFailure(observation, screen, expectation);
		if (frameFailure) return frameFailure;
		return {
			index: observation.index,
			category: screen.loading ? "loading-artifact" : "row-mismatch",
			expected: { screen: screen.name, row: mismatch.row, text: mismatch.expected },
			actual: { row: mismatch.row, text: mismatch.actual, kind: observation.kind, note: observation.note },
		};
	}
	if (!rowFrameIdsSatisfied(observation, screen)) {
		return {
			index: observation.index,
			category: "frame-id",
			expected: { screen: screen.name, rowFrameIds: screen.rowFrameIds ?? [] },
			actual: { kind: observation.kind, note: observation.note, rows: rowTexts(observation) },
		};
	}
	if (screen.cursor && !cursorMatches(observation.cursor, screen.cursor)) {
		return {
			index: observation.index,
			category: "hardware-cursor",
			expected: { cursor: screen.cursor },
			actual: {
				cursor: { x: observation.cursor.x, y: observation.cursor.y, visible: observation.cursor.visible },
				kind: observation.kind,
				note: observation.note,
			},
		};
	}
	if (screen.inverseCells) {
		const diff = inverseCellDiff(observation, screen.inverseCells);
		if (diff.extraInverseCells.length > 0 || diff.missingInverseCells.length > 0) {
			return {
				index: observation.index,
				category: "inverse-cells",
				expected: { screen: screen.name, inverseCells: [...screen.inverseCells].sort(compareCells) },
				actual: { ...diff, kind: observation.kind, note: observation.note },
			};
		}
	}
	// Unreachable for a well-formed screen; kept so a mismatch cannot vanish.
	return {
		index: observation.index,
		category: "unexpected-screen",
		expected: { screen: screen.name },
		actual: { kind: observation.kind, note: observation.note, rows: rowTexts(observation) },
	};
}

function blankScreenFailure(observation: PresentationObservation, screen: ExpectedPresentationScreen): PresentationFailure {
	return {
		index: observation.index,
		category: "blank-screen",
		expected: { screen: screen.name, rows: [...screen.rows] },
		actual: { kind: observation.kind, note: observation.note, rows: rowTexts(observation) },
	};
}

function staleScreenFailure(
	observation: PresentationObservation,
	current: ExpectedPresentationScreen,
	earlier: ExpectedPresentationScreen,
	position: number,
): PresentationFailure {
	return {
		index: observation.index,
		category: "stale-screen",
		expected: { screen: current.name, position },
		actual: { screen: earlier.name, kind: observation.kind, note: observation.note, rows: rowTexts(observation) },
	};
}

function unexpectedScreenFailure(
	observation: PresentationObservation,
	expectation: AttachPresentationExpectation,
): PresentationFailure {
	return {
		index: observation.index,
		category: "unexpected-screen",
		expected: { screens: expectation.screens.map((screen) => screen.name) },
		actual: {
			kind: observation.kind,
			note: observation.note,
			rows: rowTexts(observation),
			cursor: { x: observation.cursor.x, y: observation.cursor.y, visible: observation.cursor.visible },
		},
	};
}

/**
 * Validate every observed presentation state against an ordered expectation.
 * The full supplied history is evaluated: a later good state never removes an
 * earlier failure, and `index` always identifies the observed state.
 */
export function validateAttachPresentation(
	observations: readonly PresentationObservation[],
	expectation: AttachPresentationExpectation,
): PresentationFailure[] {
	const screens = expectation.screens;
	const failures: PresentationFailure[] = [];
	let position = 0;
	for (const observation of observations) {
		if (screens.length === 0) {
			failures.push(unexpectedScreenFailure(observation, expectation));
			continue;
		}
		let matched = -1;
		for (let i = position; i < screens.length; i++) {
			if (screenMatches(observation, screens[i])) {
				matched = i;
				break;
			}
		}
		if (matched >= 0) {
			position = matched;
			continue;
		}
		if (isBlankObservation(observation)) {
			failures.push(blankScreenFailure(observation, screens[position]));
			continue;
		}
		let stale = -1;
		for (let i = 0; i < position; i++) {
			if (screenMatches(observation, screens[i])) {
				stale = i;
				break;
			}
		}
		if (stale >= 0) {
			failures.push(staleScreenFailure(observation, screens[position], screens[stale], position));
			continue;
		}
		failures.push(classifyFailure(observation, bestScreen(observation, screens, position), expectation));
	}
	return failures;
}
