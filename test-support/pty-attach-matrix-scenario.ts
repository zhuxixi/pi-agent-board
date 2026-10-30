// Issue #222 step 20A (task-20a-brief.md): per-frame matrix cells B / Q / S /
// L-normal / L-alt / G1 / G2 / G3 / C / T. This file OWNS the NEW B/Q/L/G
// deterministic per-frame assertions plus the retained-evidence audit for the
// already-accepted S/C/T raw evidence. It does NOT rerun the accepted S/C/T
// batteries for ceremony: the audit reads the retained raw evidence and checks
// the literal half-frame/oracle assertions and cleanup actually exist, never
// inventing retroactive proof.
//
// Truths stay independent:
// - Child event logs (stdout-write sha256/bytes/dimsUsed, pty-resize,
//   frameComplete markers) are fixture truth.
// - The accepted AttachPresentationObserver grids/cursor are the displayed
//   truth, fed by the REAL runner/pty-runner.mjs + REAL PtyAttachComponent +
//   REAL TuiAltScreen topology through withDiagTrial.
// - The per-frame oracle (analyzeMatrixFrames) is a pure function comparing
//   INDEPENDENT literal expectations (declared here) with the observed grids;
//   it never reads a candidate ready flag, never uses nearest-time attribution
//   and never lets a later good frame erase an earlier failure.
//
// Every cell record carries: caseId, error, times, readyBeforeLegacySettle,
// firstContentHasTailAndInput, frameFailures (product defects) and resizeSizes,
// with each frame failure carrying frameIndex/category/expected/actual. Harness
// success (ok) is separate from frameFailures and the retained DECTCEM defects.
//
// CLI: --case B|Q|L-normal|L-alt|G1|G2|G3 --repeat 1 --clock real
// --artifact-dir <owned path>. Unsupported cases/clocks/repeats fail
// explicitly (stderr + exit 2, no dummy success). A valid invocation prints
// exactly one JSON result line on stdout. Run via
// `node --experimental-transform-types`.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import xtermHeadless from "@xterm/headless";
import { AttachPresentationObserver, type PresentationObservation } from "./attach-presentation-fixture.ts";
import {
	WORK_AREA,
	withDiagTrial,
	makeAttachDims,
	diagOrderedExit,
	type AttachSurfaceDims,
	type DiagTrialHandle,
	HEADER_BY_STATUS,
	s16ThemeRowsText,
	S16_SURFACE_CURSOR,
} from "./pty-attach-ready-scenario.ts";
import { scrollableHistoryLines } from "../src/core/pty-scroll.mjs";
import { formalMeasurementVersion } from "./formal-measurement/version.mjs";
import { holdFormalObservation } from "./formal-measurement/observation.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

const BUSY_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-busy-pi.mjs");
const LONGLOG_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-longlog-pi.mjs");
const GEOMETRY_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-geometry-pi.mjs");

function sha256(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const start = now();
	while (now() - start < timeoutMs) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for: ${label}`);
}

function readEventsSafe(eventsPath: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(eventsPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function makeArtifactWriter(artifactDir: string, errors: string[]) {
	return (name: string, value: unknown) => {
		try {
			writeFileSync(join(artifactDir, name), JSON.stringify(value, null, 2));
		} catch (err) {
			errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
}

// ---------------------------------------------------------------------------
// Independent literal builders (declared BEFORE any consumption). These mirror
// the three NEW fixture children byte-for-byte; they are never derived from
// captured bytes.
// ---------------------------------------------------------------------------

export function rtrimRows(rows: readonly string[]): string[] {
	return rows.map((row) => row.replace(/\s+$/u, ""));
}

export function rowsEqual(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((text, i) => text === expected[i]);
}

/** Busy/quiet literal work-area rows (mirror of fake-pty-busy-pi.mjs). */
export function busyRowsText(id: string, label: "busy" | "quiet"): string[] {
	const rows = Array.from({ length: 22 }, () => "");
	rows[0] = `${id} HEADER ${label} work area`;
	rows[1] = `${id} UPPER reply history one`;
	rows[2] = `${id} UPPER reply history two`;
	rows[10] = `${id} MIDDLE divider`;
	rows[11] = `${id} LOWER reply history three`;
	rows[12] = `${id} LOWER reply history four`;
	rows[19] = `${id} TAIL assistant final answer`;
	rows[21] = `${id} INPUT >`;
	return rows;
}

/** Longlog final-frame literal rows (mirror of fake-pty-longlog-pi.mjs). */
export function longlogRowsText(id: string): string[] {
	const rows = Array.from({ length: 22 }, () => "");
	rows[0] = `${id} HEADER longlog surface`;
	rows[1] = `${id} UPPER reply history one`;
	rows[2] = `${id} UPPER reply history two`;
	rows[10] = `${id} MIDDLE divider`;
	rows[11] = `${id} LOWER reply history three`;
	rows[12] = `${id} LOWER reply history four`;
	rows[19] = `${id} TAIL 中文最终回答 🎯`;
	rows[21] = `${id} INPUT >`;
	return rows;
}

/** Geometry literal rows (mirror of fake-pty-geometry-pi.mjs). */
export function geometryRowsText(id: string, cols: number, rows: number): string[] {
	const out = Array.from({ length: rows }, () => "");
	out[0] = `${id} HEADER geometry ${cols}x${rows}`.padEnd(cols - 1, ".") + "#";
	out[1] = `${id} UPPER reply history one`;
	out[2] = `${id} UPPER reply history two`;
	const mid = Math.floor(rows / 2) - 1;
	out[mid] = `${id} MIDDLE divider`;
	out[mid + 1] = `${id} LOWER reply history three`;
	out[mid + 2] = `${id} LOWER reply history four`;
	out[rows - 3] = `${id} TAIL assistant final answer`;
	out[rows - 1] = `${id} BOTTOM edge INPUT >`.padEnd(cols - 1, " ") + "#";
	return out;
}

/** Busy/longlog cursor: hidden, parked right after `<id> INPUT >`. */
export function promptCursor(prompt: string): { x: number; y: number; visible: boolean } {
	return { x: prompt.length, y: 21, visible: false };
}

/** Geometry cursor: hidden, parked right after `<id> BOTTOM edge INPUT >`. */
export function geometryCursor(id: string, rows: number): { x: number; y: number; visible: boolean } {
	return { x: `${id} BOTTOM edge INPUT >`.length, y: rows - 1, visible: false };
}

/** Extract the leading frame-id token (`B3`, `Q0`, `L1`, `LA1`, `G2`, ...). */
export function frameIdOf(row: string): string | null {
	const match = /^([A-Za-z][A-Za-z0-9]*) /.exec(row);
	if (!match) return null;
	return /[0-9]/.test(match[1]) ? match[1] : null;
}

// ---------------------------------------------------------------------------
// G3 soft-wrap reflow contract (step 20A G3 closing). Independently declared
// BEFORE any consumption; mirrors fake-pty-geometry-pi.mjs byte-for-byte and is
// never derived from captured bytes.
// ---------------------------------------------------------------------------

/** The original single 160-col line. Boundary sentinel "W" at 0-based col 79
 *  (1-based col 80, the wrap point at 80 cols), first-wrapped-row-start "R" at
 *  0-based col 80, end sentinel "E" at 0-based col 159 (1-based col 160). */
export function g3ReflowLine(): string {
	return "L".repeat(79) + "W" + "R" + "L".repeat(78) + "E";
}

/** The expected wrapped row pair for one 160-col line at 80 cols. Returns null
 *  when the boundary/end sentinels are not at their declared columns (so a
 *  col-79 or col-81 boundary is a hard failure, never a silent wrap). */
export function g3ExpectedWrappedRows(line: string): string[] | null {
	if (line.length !== 160 || line[79] !== "W" || line[80] !== "R" || line[159] !== "E") return null;
	return [line.slice(0, 80), line.slice(80, 160)];
}

/** G2W literal body rows (22 rows at 80 cols): the single line wraps into rows
 *  1..2; TAIL at row 19, INPUT at row 21, hidden cursor after INPUT. */
export function g3ReflowRowsText(id: string): string[] {
	const rows = Array.from({ length: 22 }, () => "");
	rows[0] = `${id} HEADER reflow surface`;
	rows[1] = g3ReflowLine().slice(0, 80);
	rows[2] = g3ReflowLine().slice(80, 160);
	rows[19] = `${id} TAIL assistant final answer`;
	rows[21] = `${id} INPUT >`;
	return rows;
}

/** G3 seed literal (160 cols): the ORIGINAL single-line form of the reflow
 *  line at row 1 (one row, no wrap). */
export function g3SeedRowsText(): string[] {
	const rows = geometryRowsText("G0", 160, 22);
	rows[1] = g3ReflowLine();
	return rows;
}

// ---------------------------------------------------------------------------
// The pure per-frame matrix oracle. No candidate ready flag, no nearest-time
// attribution, no later-good-erases-earlier.
// ---------------------------------------------------------------------------

/** One projected body frame consumed by the oracle. */
export interface MatrixFrameInput {
	kind: "frame" | "unframed";
	index: number;
	bodyRows: string[];
	inverseCells: Array<{ x: number; y: number }>;
	cursor: { x: number; y: number; visible: boolean };
}

export interface MatrixFailure {
	frameIndex: number;
	category: string;
	expected: unknown;
	actual: unknown;
}

export interface MatrixCellConfig {
	caseId: string;
	bodyCols: number;
	bodyRows: number;
	/** Literal body rows for a frame id. */
	literal: (id: string) => string[];
	/** Monotonic rank of a frame id (higher = later); unknown ids rank null. */
	rankOfId: (id: string) => number | null;
	/** Known DECTCEM defect cell (extra inverse cell at the child cursor). */
	dectcemCell: { x: number; y: number } | null;
}

/** Project one full-screen observation into body coordinates. */
export function toMatrixFrame(observation: PresentationObservation, dims: AttachSurfaceDims): MatrixFrameInput {
	const bodyRows = rtrimRows(observation.grid.slice(dims.bodyTop, dims.footerRow).map((row) => row.text));
	const inverseCells: Array<{ x: number; y: number }> = [];
	for (let y = dims.bodyTop; y < dims.footerRow; y++) {
		const cells = observation.grid[y].cells;
		for (let x = 0; x < cells.length; x++) {
			if (cells[x].inverse && cells[x].width !== 0) inverseCells.push({ x, y: y - dims.bodyTop });
		}
	}
	return {
		kind: observation.kind,
		index: observation.index,
		bodyRows,
		inverseCells,
		cursor: { x: observation.cursor.x, y: observation.cursor.y - dims.bodyTop, visible: observation.cursor.visible },
	};
}

function blankFrame(frame: MatrixFrameInput): boolean {
	return frame.bodyRows.every((text) => text === "");
}

function primaryId(frame: MatrixFrameInput, bodyRows: number): string | null {
	// Source truth is the bottom: TAIL row first, then INPUT, then any row.
	return frameIdOf(frame.bodyRows[bodyRows - 3] ?? "") ?? frameIdOf(frame.bodyRows[bodyRows - 1] ?? "") ?? (frame.bodyRows.map(frameIdOf).find((id) => id !== null) ?? null);
}

/**
 * Classify every body frame of a cell. Returns:
 * - frameFailures: product defects (content/geometry/stale/post-close), each
 *   with frameIndex/category/expected/actual.
 * - dectcemDefects: the KNOWN extra-inverse-cell DECTCEM loss, recorded
 *   separately (existing defects are evidence, not something to edit away).
 * - firstContentFrameIndex / firstContentHasTailAndInput / tailAndInputAtBottom.
 */
export function analyzeMatrixFrames(
	config: MatrixCellConfig,
	frames: readonly MatrixFrameInput[],
	activeBoundary: number,
): {
	frameFailures: MatrixFailure[];
	dectcemDefects: MatrixFailure[];
	firstContentFrameIndex: number | null;
	firstContentHasTailAndInput: boolean | null;
	tailAndInputAtBottom: boolean;
	postCloseContentFrames: number[];
	contentLostFrames: number[];
} {
	const frameFailures: MatrixFailure[] = [];
	const dectcemDefects: MatrixFailure[] = [];
	const postCloseContentFrames: number[] = [];
	const contentLostFrames: number[] = [];
	let firstContentFrameIndex: number | null = null;
	let firstContentHasTailAndInput: boolean | null = null;
	let firstContentSeen = false;
	let maxRank = -Infinity;

	const tailInputOk = (frame: MatrixFrameInput): boolean => {
		const tailRow = frame.bodyRows[config.bodyRows - 3] ?? "";
		const inputRow = frame.bodyRows[config.bodyRows - 1] ?? "";
		const tailId = frameIdOf(tailRow);
		const inputId = frameIdOf(inputRow);
		if (!tailId || !inputId || tailId !== inputId) return false;
		const expected = config.literal(tailId);
		return tailRow === expected[config.bodyRows - 3] && inputRow === expected[config.bodyRows - 1];
	};

	for (const frame of frames) {
		if (frame.kind !== "frame") continue;
		// Only frames carrying a recognizable frame-id token are matrix CONTENT.
		// Loading/blank/boot frames BEFORE first content are the attach
		// transition, not this cell's content, and are never mislabeled as a
		// missing bottom or a partial frame. AFTER first content, an id-less
		// (blank or loading/unknown) ACTIVE frame is a content-lost regression:
		// committed content must not vanish or fall back to loading.
		const id = primaryId(frame, config.bodyRows);
		if (frame.index >= activeBoundary) {
			if (id !== null) postCloseContentFrames.push(frame.index);
			continue;
		}
		if (id === null) {
			if (firstContentSeen) {
				contentLostFrames.push(frame.index);
				frameFailures.push({
					frameIndex: frame.index,
					category: "content-lost",
					expected: { contentPresent: true },
					actual: { bodyRows: frame.bodyRows, cursor: frame.cursor },
				});
			}
			continue;
		}
		firstContentSeen = true;
		if (firstContentFrameIndex === null) {
			firstContentFrameIndex = frame.index;
			firstContentHasTailAndInput = tailInputOk(frame);
		}
		const upperIds = frame.bodyRows.slice(0, Math.floor(config.bodyRows / 2)).map(frameIdOf).filter((v) => v !== null) as string[];
		const lowerIds = frame.bodyRows.slice(Math.floor(config.bodyRows / 2)).map(frameIdOf).filter((v) => v !== null) as string[];
		const upperSet = new Set(upperIds);
		const lowerSet = new Set(lowerIds);
		// Upper/lower halves must carry one consistent frame id (no
		// mixed-frame-id half frame).
		const mixed = [...upperSet].filter((v) => !lowerSet.has(v)).concat([...lowerSet].filter((v) => !upperSet.has(v)));
		if (upperSet.size > 0 && lowerSet.size > 0 && mixed.length > 0) {
			frameFailures.push({
				frameIndex: frame.index,
				category: "mixed-frame-id",
				expected: { sameFrameIdAcrossHalves: true },
				actual: { upperIds: [...upperSet], lowerIds: [...lowerSet], mixed },
			});
		}
		// Bottom source: TAIL+INPUT must be present, consistent and literal.
		if (!tailInputOk(frame)) {
			frameFailures.push({
				frameIndex: frame.index,
				category: "tail-input-mismatch",
				expected: {
					tail: config.literal(id)[config.bodyRows - 3] ?? null,
					input: config.literal(id)[config.bodyRows - 1] ?? null,
				},
				actual: {
					tail: frame.bodyRows[config.bodyRows - 3] ?? null,
					input: frame.bodyRows[config.bodyRows - 1] ?? null,
					id,
				},
			});
		}
		// Geometry/literal: one full-row comparison catches wrong geometry,
		// partial frames and stale-content frames without a per-row flood.
		const expectedRows = config.literal(id);
		if (!rowsEqual(frame.bodyRows, expectedRows)) {
			frameFailures.push({
				frameIndex: frame.index,
				category: "row-mismatch",
				expected: { rows: expectedRows },
				actual: { rows: frame.bodyRows },
			});
		}
		// Stale callback publication: a frame id that regresses below the
		// highest already-committed rank is a stale screen.
		const rank = config.rankOfId(id);
		if (rank !== null) {
			if (rank < maxRank) {
				frameFailures.push({
					frameIndex: frame.index,
					category: "stale-frame",
					expected: { id, rank },
					actual: { maxRankSeen: maxRank },
				});
			} else {
				maxRank = rank;
			}
		}
		// Inverse cells: the KNOWN DECTCEM cell is a separate defect; any
		// OTHER extra inverse cell is a frame failure.
		for (const cell of frame.inverseCells) {
			if (config.dectcemCell && cell.x === config.dectcemCell.x && cell.y === config.dectcemCell.y) {
				dectcemDefects.push({
					frameIndex: frame.index,
					category: "dectcem-inverse-cell",
					expected: { noInverseCellAt: config.dectcemCell },
					actual: { ...cell },
				});
			} else {
				frameFailures.push({
					frameIndex: frame.index,
					category: "extra-inverse-cell",
					expected: { noExtraInverseCells: true },
					actual: { ...cell },
				});
			}
		}
		// Hardware cursor: content frames must park hidden. A visible
		// cursor at the child cursor cell is the KNOWN DECTCEM loss
		// (recorded separately); a visible cursor elsewhere is a frame
		// failure. Position is recorded as data, never a pass/fail gate
		// (ids can vary the prompt width across busy ticks).
		if (frame.cursor.visible !== false) {
			if (config.dectcemCell && frame.cursor.x === config.dectcemCell.x && frame.cursor.y === config.dectcemCell.y) {
				dectcemDefects.push({
					frameIndex: frame.index,
					category: "dectcem-visible-cursor",
					expected: { cursorVisible: false },
					actual: { ...frame.cursor },
				});
			} else {
				frameFailures.push({
					frameIndex: frame.index,
					category: "hardware-cursor",
					expected: { cursorVisible: false },
					actual: { ...frame.cursor },
				});
			}
		}
	}

	return {
		frameFailures,
		dectcemDefects,
		firstContentFrameIndex,
		firstContentHasTailAndInput,
		tailAndInputAtBottom: firstContentHasTailAndInput ?? false,
		postCloseContentFrames,
		contentLostFrames,
	};
}

/** Summarize a matrix cell into the required per-cell record shape. */
export function matrixCellRecord(input: {
	caseId: string;
	error: string | null;
	times: Record<string, unknown>;
	readyBeforeLegacySettle: boolean | null;
	analysis?: ReturnType<typeof analyzeMatrixFrames> | null;
	resizeSizes: Array<{ cols: number; rows: number; at: number }>;
	ok: boolean;
	/** Step 20A fix1 (review I4): harness ok AND cleanup.ok must both hold. */
	cleanupOk?: boolean | null;
	extra?: Record<string, unknown>;
}): Record<string, unknown> {
	const analysis = input.analysis ?? {
		frameFailures: [],
		dectcemDefects: [],
		firstContentFrameIndex: null,
		firstContentHasTailAndInput: null,
		tailAndInputAtBottom: false,
		postCloseContentFrames: [],
		contentLostFrames: [],
	};
	const ok = input.ok === true && input.cleanupOk !== false;
	return {
		caseId: input.caseId,
		ok,
		cleanupOk: input.cleanupOk ?? null,
		error: input.ok === true && input.cleanupOk === false ? (input.error ?? "cleanup.ok=false after ordered exit") : input.error,
		times: input.times,
		readyBeforeLegacySettle: input.readyBeforeLegacySettle,
		firstContentHasTailAndInput: analysis.firstContentHasTailAndInput,
		frameFailures: analysis.frameFailures,
		dectcemDefects: analysis.dectcemDefects,
		resizeSizes: input.resizeSizes,
		postCloseContentFrames: analysis.postCloseContentFrames,
		contentLostFrames: analysis.contentLostFrames,
		...input.extra,
	};
}

/**
 * Step 20A fix1 (review M4): exactly one real resize gate. True only when the
 * attach sent exactly one resize command, the runner applied it at the target
 * dims, and the child observed exactly one real PTY resize to those dims.
 */
export function exactlyOneResizeGate(input: {
	resizeCommands: Array<{ cols?: unknown; rows?: unknown }>;
	appliedAcks: Array<{ cols?: unknown; rows?: unknown }>;
	childResizeEvents: Array<{ cols?: unknown; rows?: unknown }>;
	target: { cols: number; rows: number };
}): { ok: boolean; note: string } {
	const atTarget = (v: { cols?: unknown; rows?: unknown }) => v.cols === input.target.cols && v.rows === input.target.rows;
	const commandCount = input.resizeCommands.length;
	const targetCommandCount = input.resizeCommands.filter(atTarget).length;
	const ackCount = input.appliedAcks.length;
	const targetAckCount = input.appliedAcks.filter(atTarget).length;
	const childCount = input.childResizeEvents.length;
	const targetChildCount = input.childResizeEvents.filter(atTarget).length;
	const ok = commandCount === 1 && targetCommandCount === 1 && ackCount === 1 && targetAckCount === 1 && childCount === 1 && targetChildCount === 1;
	return {
		ok,
		note: ok
			? "exactly one target resize command, one target applied ack, and exactly one target child live resize event (all counted)"
			: `commandCount=${commandCount} targetCommandCount=${targetCommandCount} ackCount=${ackCount} targetAckCount=${targetAckCount} childCount=${childCount} targetChildCount=${targetChildCount}`,
	};
}

// ---------------------------------------------------------------------------
// case B / Q: busy 25ms updates and quiet same-size baseline
// ---------------------------------------------------------------------------

function busyOrQuietConfig(caseId: "B" | "Q", label: "busy" | "quiet"): MatrixCellConfig {
	return {
		caseId,
		bodyCols: WORK_AREA.cols,
		bodyRows: WORK_AREA.rows,
		literal: (id) => busyRowsText(id, label),
		rankOfId: (id) => (/^[A-Za-z]+([0-9]+)$/.exec(id) ? Number(/^[A-Za-z]+([0-9]+)$/.exec(id)![1]) : null),
		dectcemCell: { x: 10, y: 21 },
	};
}

async function runBusyQuiet(caseId: "B" | "Q", artifactDir: string): Promise<Record<string, unknown>> {
	const label: "busy" | "quiet" = caseId === "B" ? "busy" : "quiet";
	const seedId = caseId === "B" ? "B0" : "Q0";
	const config = busyOrQuietConfig(caseId, label);
	const seedLiteral = busyRowsText(seedId, label);
	const declared = {
		caseId,
		fixture: "test-support/fake-pty-busy-pi.mjs",
		mode: label,
		hostSize: { cols: WORK_AREA.cols, rows: WORK_AREA.rows },
		seedFrame: { id: seedId, rows: seedLiteral },
		note: caseId === "B"
			? "continuous 25ms full synchronized updates after the seed; zero resize; the oracle checks every committed outer frame is complete (upper/lower same id, TAIL+INPUT at bottom, no extra cursor, no stale, no post-close render)"
			: "same-size nonempty baseline then quiet; no later output; zero resize; quietness is not readiness proof by itself",
	};
	const result = await withDiagTrial(
		{
			caseId,
			childPath: BUSY_CHILD,
			childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_BUSY_MODE: label, FAKE_PTY_EVENTS_PATH: eventsPath }),
			hostCols: WORK_AREA.cols,
			hostRows: WORK_AREA.rows,
			artifactDir,
			attachScreenLog: true,
			declared,
		},
		async (h) => {
			// Same-size control: zero resize commands.
			const resizeCommands = h.txMessages().filter((m) => m.type === "resize");
			const zeroResize = { ok: resizeCommands.length === 0, resizeCommands };
			// Wait for the first outer content commit (seed or busy tick).
			const firstContent = await waitForFirstContent(h, config);
			// Busy: also observe at least one later full tick beyond the seed.
			let tickEvidence: Record<string, unknown> = { observed: false };
			if (caseId === "B") {
				await waitFor(
					() => h.primary.observer.observations.some((o) => o.kind === "frame" && primaryId(toMatrixFrame(o, h.attachDims), config.bodyRows) !== null && primaryId(toMatrixFrame(o, h.attachDims), config.bodyRows) !== seedId),
					4000,
					"B later busy tick commit",
				);
				tickEvidence = {
					observed: true,
					childWrites: h.readChildEvents().filter((e) => e.event === "stdout-write").length,
					note: "later busy ticks beyond the seed were committed on the outer terminal",
				};
			}
			const childEvents = h.readChildEvents();
			const settleAt = h.primary.requests.find((r) => r.entry === "settle")?.at ?? null;
			const activeBoundary = h.primary.observer.observations.length;
			const analysis = analyzeMatrixFrames(config, h.primary.observer.observations.map((o) => toMatrixFrame(o, h.attachDims)), activeBoundary);
			const readyBeforeLegacySettle = analysis.firstContentFrameIndex !== null && settleAt !== null
				? (h.primary.observer.observations[analysis.firstContentFrameIndex]?.boundaryParsedAt ?? Infinity) < settleAt
				: null;
			const observation = await holdFormalObservation(now, sleep, `${caseId}-post-content`);
			await diagOrderedExit(h);
			return {
				observation,
				zeroResize,
				firstContent: analysis.firstContentFrameIndex,
				readyBeforeLegacySettle,
				settleAt,
				tickEvidence,
				childWriteCount: childEvents.filter((e) => e.event === "stdout-write").length,
				teardownAllowedRowTexts: [...seedLiteral, ...Object.values(HEADER_BY_STATUS), "─".repeat(config.bodyCols)],
				analysis,
			};
		},
	);
	return matrixCellRecord({
		caseId,
		error: (result.error as string | null) ?? null,
		ok: result.ok === true,
		cleanupOk: (result.cleanup as { ok?: boolean } | undefined)?.ok === true,
		times: { childWrites: result.childWriteCount, settleAt: result.settleAt },
		readyBeforeLegacySettle: (result.readyBeforeLegacySettle as boolean | null) ?? null,
		analysis: result.analysis as ReturnType<typeof analyzeMatrixFrames>,
		resizeSizes: [],
		extra: { zeroResize: result.zeroResize, tickEvidence: result.tickEvidence, artifactDir, measurementPath: result.measurementPath, observation: result.observation },
	});
}

async function waitForFirstContent(h: DiagTrialHandle, config: MatrixCellConfig): Promise<number | null> {
	let idx: number | null = null;
	await waitFor(
		() => {
			for (const o of h.primary.observer.observations) {
				if (o.kind !== "frame") continue;
				const f = toMatrixFrame(o, h.attachDims);
				if (blankFrame(f)) continue;
				const id = primaryId(f, config.bodyRows);
				if (id === null) continue;
				if (rowsEqual(f.bodyRows, config.literal(id))) {
					idx = o.index;
					return true;
				}
			}
			return false;
		},
		10_000,
		"first outer content frame",
	);
	return idx;
}

// ---------------------------------------------------------------------------
// case L-normal / L-alt: >60KB real history with Chinese/emoji bottom
// ---------------------------------------------------------------------------

async function runLonglog(caseId: "L-normal" | "L-alt", artifactDir: string): Promise<Record<string, unknown>> {
	const mode = caseId === "L-alt" ? "alt" : "normal";
	const finalId = caseId === "L-alt" ? "LA1" : "L1";
	const finalLiteral = longlogRowsText(finalId);
	const config: MatrixCellConfig = {
		caseId,
		bodyCols: WORK_AREA.cols,
		bodyRows: WORK_AREA.rows,
		literal: (id) => longlogRowsText(id),
		rankOfId: () => 0,
		dectcemCell: { x: `${finalId} INPUT >`.length, y: 21 },
	};
	const declared = {
		caseId,
		fixture: "test-support/fake-pty-longlog-pi.mjs",
		mode,
		hostSize: { cols: WORK_AREA.cols, rows: WORK_AREA.rows },
		finalFrame: { id: finalId, rows: finalLiteral, cursor: promptCursor(`${finalId} INPUT >`) },
		historyContract: ">60KB real multi-byte history (Chinese/emoji), measured by sha256-covered stdout-write byte counts; normal = real scrollback, alt = alternate buffer",
		bottomContract: "TAIL at row 19, INPUT at row 21, hidden cursor parked after INPUT; first content must be at the bottom, not a historical position followed by a jump",
	};
	const result = await withDiagTrial(
		{
			caseId,
			childPath: LONGLOG_CHILD,
			childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_LONGLOG_MODE: mode, FAKE_PTY_EVENTS_PATH: eventsPath }),
			hostCols: WORK_AREA.cols,
			hostRows: WORK_AREA.rows,
			artifactDir,
			attachScreenLog: true,
			frameWitness: formalMeasurementVersion() === "candidate",
			declared,
		},
		async (h) => {
			const resizeCommands = h.txMessages().filter((m) => m.type === "resize");
			const zeroResize = { ok: resizeCommands.length === 0, resizeCommands };
			await waitForFirstContent(h, config);
			const childEvents = h.readChildEvents();
			const historyBytes = childEvents
				.filter((e) => e.event === "stdout-write" && typeof e.bytes === "number")
				.reduce((sum, e) => sum + (e.bytes as number), 0);
			const historyBytesProof = {
				ok: historyBytes > 60000,
				bytes: historyBytes,
				note: "cumulative sha256-covered stdout-write byte counts from the child event log (never a path or string count)",
			};
			const settleAt = h.primary.requests.find((r) => r.entry === "settle")?.at ?? null;
			const activeBoundary = h.primary.observer.observations.length;
			const analysis = analyzeMatrixFrames(config, h.primary.observer.observations.map((o) => toMatrixFrame(o, h.attachDims)), activeBoundary);
			const readyBeforeLegacySettle = analysis.firstContentFrameIndex !== null && settleAt !== null
				? (h.primary.observer.observations[analysis.firstContentFrameIndex]?.boundaryParsedAt ?? Infinity) < settleAt
				: null;
			const observation = await holdFormalObservation(now, sleep, `${caseId}-post-content`);
			await diagOrderedExit(h);
			return {
				observation,
				zeroResize,
				historyBytesProof,
				settleAt,
				readyBeforeLegacySettle,
				teardownAllowedRowTexts: [...finalLiteral, ...Object.values(HEADER_BY_STATUS), "─".repeat(config.bodyCols)],
				analysis,
			};
		},
	);
	return matrixCellRecord({
		caseId,
		error: (result.error as string | null) ?? null,
		ok: result.ok === true,
		cleanupOk: (result.cleanup as { ok?: boolean } | undefined)?.ok === true,
		times: { historyBytes: (result.historyBytesProof as { bytes?: number } | undefined)?.bytes },
		readyBeforeLegacySettle: (result.readyBeforeLegacySettle as boolean | null) ?? null,
		analysis: result.analysis as ReturnType<typeof analyzeMatrixFrames>,
		resizeSizes: [],
		extra: { zeroResize: result.zeroResize, historyBytesProof: result.historyBytesProof, artifactDir, measurementPath: result.measurementPath, observation: result.observation },
	});
}

// ---------------------------------------------------------------------------
// cases G1 / G2 / G3: geometry (actual PTY dims, seed/stale/target)
// ---------------------------------------------------------------------------

const GEOMETRY = {
	g1: { seed: { cols: 80, rows: 24 }, target: { cols: 80, rows: 22 } },
	g2: { seed: { cols: 300, rows: 65 }, target: { cols: 300, rows: 38 } },
	g3: { seed: { cols: 160, rows: 22 }, target: { cols: 80, rows: 22 } },
} as const;

/** Wait until an outer frame commits the literal body rows; return its index. */
async function waitForCommitRows(h: DiagTrialHandle, literalRows: string[], label: string): Promise<number> {
	let idx = -1;
	await waitFor(
		() => {
			idx = h.primary.observer.observations.findIndex((o) => o.kind === "frame" && rowsEqual(toMatrixFrame(o, h.attachDims).bodyRows, literalRows));
			return idx >= 0;
		},
		10_000,
		label,
	);
	return idx;
}

/** Capture the G3 G2W reflow frame and report the ACTUAL wrapped row pair vs
 *  the independently-declared expected pair. Whole-frame compare, never a
 *  substring; INPUT row must stay intact. */
async function captureG3Reflow(h: DiagTrialHandle): Promise<Record<string, unknown>> {
	const literal = g3ReflowRowsText("G2W");
	const idx = await waitForCommitRows(h, literal, "G3 G2W reflow frame");
	const obs = h.primary.observer.observations[idx];
	const bodyRows = toMatrixFrame(obs, h.attachDims).bodyRows;
	const expectedWrappedRows = g3ExpectedWrappedRows(g3ReflowLine());
	const actualWrappedRows = [bodyRows[1], bodyRows[2]];
	const inputRowIntact = bodyRows[21] === "G2W INPUT >";
	return {
		measured: true,
		frameId: "G2W",
		actualWrappedRows,
		expectedWrappedRows,
		inputRowIntact,
		wrappedRowsMatch: expectedWrappedRows !== null && rowsEqual(actualWrappedRows, expectedWrappedRows),
		wholeFrameMatches: rowsEqual(bodyRows, literal),
		note: "the single 160-col seed line wrapped into body rows 1..2 at the 80-col live size; INPUT row 21 intact; whole-frame compare, not substring",
	};
}

async function runGeometry(caseId: "G1" | "G2" | "G3", artifactDir: string): Promise<Record<string, unknown>> {
	const mode = caseId.toLowerCase() as "g1" | "g2" | "g3";
	const G = GEOMETRY[mode];
	const isG3 = mode === "g3";
	const seedLiteral = isG3 ? g3SeedRowsText() : geometryRowsText("G0", G.seed.cols, G.seed.rows);
	const targetLiteral = geometryRowsText("G2", G.target.cols, G.target.rows);
	const targetCursor = geometryCursor("G2", G.target.rows);
	const config: MatrixCellConfig = {
		caseId,
		bodyCols: G.target.cols,
		bodyRows: G.target.rows,
		literal: (id) => {
			if (id === "G2") return geometryRowsText("G2", G.target.cols, G.target.rows);
			if (id === "G2W") return g3ReflowRowsText("G2W");
			return geometryRowsText(id, G.seed.cols, G.seed.rows);
		},
		rankOfId: isG3
			? (id) => (id === "G0" ? 0 : id === "G1" ? 1 : id === "G2W" ? 2 : id === "G2" ? 3 : null)
			: (id) => (id === "G0" ? 0 : id === "G1" ? 1 : id === "G2" ? 2 : null),
		dectcemCell: { x: targetCursor.x, y: targetCursor.y },
	};
	const declared = {
		caseId,
		fixture: "test-support/fake-pty-geometry-pi.mjs",
		seedSize: { ...G.seed },
		attachSurface: { bodyCols: G.target.cols, bodyRows: G.target.rows, screenRows: G.target.rows + 2 },
		seedFrame: { id: "G0", basis: "live-pty-start", rows: seedLiteral, ...(isG3 ? { note: "carries the original single 160-col reflow line at row 1" } : {}) },
		staleFrame: { id: "G1", basis: "stale-seed", note: "composed at the seed size; its CLOSE drains after the applied resize; must never qualify as target proof" },
		...(isG3 ? { reflowFrame: { id: "G2W", basis: "live-pty", rows: g3ReflowRowsText("G2W"), note: "the single 160-col seed line wrapped into rows 1..2 at 80 cols" } } : {}),
		targetFrame: { id: "G2", basis: "live-pty", rows: targetLiteral, cursor: targetCursor },
		note: "one real resize; the target frame must use the ACTUAL post-SIGWINCH dims (child pty-resize event), never an echoed request",
	};
	const result = await withDiagTrial(
		{
			caseId,
			childPath: GEOMETRY_CHILD,
			childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_GEOMETRY_MODE: mode, FAKE_PTY_EVENTS_PATH: eventsPath }),
			hostCols: G.seed.cols,
			hostRows: G.seed.rows,
			bodyCols: G.target.cols,
			bodyRows: G.target.rows,
			artifactDir,
			attachScreenLog: true,
			frameWitness: formalMeasurementVersion() === "candidate",
			frameWitnessGeometry: formalMeasurementVersion() === "candidate",
			deferFrameReporter: formalMeasurementVersion() === "candidate",
			declared,
			beforeMount: async (pre) => {
				if (formalMeasurementVersion() === "candidate") {
					const seedDeadline = now() + 8000;
					let seedEvent: Record<string, unknown> | null = null;
					while (now() < seedDeadline) {
						seedEvent = pre.readChildEvents().find((event) => event.event === "stdout-write" && event.frame === "G0" && event.phase === "seed") ?? null;
						if (seedEvent !== null) break;
						await sleep(50);
					}
					const seedProof = {
						ok: seedEvent !== null,
						method: "child-owned G0 seed write event before reporter enablement (separate from the probe snapshot)",
						frame: "G0",
						seedEvent,
						literalRows: seedLiteral,
					};
					if (!seedProof.ok) throw new Error(`${caseId} pre-mount child seed proof failed`);
					return { seedProof };
				}
				let seedRows: string[] | null = null;
				const seedDeadline = now() + 8000;
				while (now() < seedDeadline) {
					const capture = await pre.probe.capture();
					if (capture.frame !== null) {
						seedRows = rtrimRows(await paintFrameAt(capture.frame, G.seed.cols, G.seed.rows));
						break;
					}
					await sleep(200);
				}
				const seedProof = {
					ok: seedRows !== null && rowsEqual(seedRows, seedLiteral),
					method: "runner-capture-replay at the seed size (independent raw terminal), BEFORE the attach was mounted",
					rows: seedRows,
					literalRows: seedLiteral,
				};
				if (!seedProof.ok) throw new Error(`${caseId} seed proof failed`);
				return { seedProof };
			},
		},
		async (h) => {
			await waitFor(
				() => h.txMessages().some((m) => m.type === "resize") && h.rxMessages().some((m) => m.type === "cmd_ack" && m.msg.stage === "applied"),
				8000,
				`${caseId} resize sent and applied`,
			);
			const resizeCommands = h.txMessages().filter((m) => m.type === "resize");
			const resizeSizes = resizeCommands.map((m) => ({ cols: m.msg.cols as number, rows: m.msg.rows as number, at: m.at }));
			await waitFor(() => h.readChildEvents().some((e) => e.event === "pty-resize"), 8000, `${caseId} child pty-resize observed`);
			const childResizeEvents = h.readChildEvents().filter((e) => e.event === "pty-resize").map((e) => ({ cols: e.cols as number, rows: e.rows as number }));
			const appliedAcks = h.rxMessages().filter((m) => m.type === "cmd_ack" && m.msg.stage === "applied").map((m) => ({ cols: m.msg.cols as number, rows: m.msg.rows as number }));
			// Stale frame open/close around the applied resize.
			h.sendChild({ cmd: "step", step: 1 });
			await h.holdMs("g1-open-stale", 200);
			h.sendChild({ cmd: "step", step: 2 });
			await h.holdMs("g1-closed-stale", 200);
			let reflowEvidence: Record<string, unknown> | undefined;
			if (isG3) {
				h.sendChild({ cmd: "step", step: 3 }); // G2W reflow frame
				reflowEvidence = await captureG3Reflow(h);
				h.sendChild({ cmd: "step", step: 4 }); // G2 final target
			} else {
				h.sendChild({ cmd: "step", step: 3 }); // G2 final target
			}
			await waitForCommitRows(h, targetLiteral, `${caseId} G2 target commit`);
			const settleAt = h.primary.requests.find((r) => r.entry === "settle")?.at ?? null;
			const activeBoundary = h.primary.observer.observations.length;
			const analysis = analyzeMatrixFrames(config, h.primary.observer.observations.map((o) => toMatrixFrame(o, h.attachDims)), activeBoundary);
			const readyBeforeLegacySettle = analysis.firstContentFrameIndex !== null && settleAt !== null
				? (h.primary.observer.observations[analysis.firstContentFrameIndex]?.boundaryParsedAt ?? Infinity) < settleAt
				: null;
			const targetDimsUsed = h.readChildEvents().find((e) => e.event === "stdout-write" && e.frame === "G2")?.dimsUsed ?? null;
			// Step 20A fix1 (review M3/M2): overflow/rewrap are NOT claimed from a
			// final-target-only screen. G2 records a post-resize overflow observation
			// as DATA (authoritative #205 overflow is the existing
			// test/pty-attach-frame-overflow.test.mjs, exact 65→38 topology); G3
			// records reflow as UNMEASURED (the fixture proves one resize + edge
			// repaint, not soft-wrap reflow of a long line).
			const term = (h.primary.component as unknown as { term?: { buffer?: { active?: { baseY?: number } } } }).term;
			const baseY = term?.buffer?.active?.baseY ?? null;
			const historyFloor = (h.primary.component as unknown as { historyFloor?: number }).historyFloor ?? null;
			const overflowEvidence = caseId === "G2"
				? {
						measuredInCell: false,
						postResizeObservation: { baseY, historyFloor, scrollableHistoryLines: baseY !== null && historyFloor !== null ? scrollableHistoryLines(baseY, historyFloor) : null },
						coveredBy: "test/pty-attach-frame-overflow.test.mjs (issue #205, 65→38 topology: baseY=27, historyFloor===baseY, scrollableHistoryLines=0)",
						note: "the G2 matrix cell verifies one resize + target geometry; the overflowing-hydrate history-floor expectation is pinned by the existing #205 test, not re-derived here",
					}
				: undefined;
			const observation = await holdFormalObservation(now, sleep, `${caseId}-post-content`);
			await diagOrderedExit(h);
			return {
				observation,
				resizeSizes,
				resizeCommands: resizeCommands.map((m) => ({ cols: m.msg.cols as number, rows: m.msg.rows as number })),
				appliedAcks,
				childResizeEvents,
				targetDimsUsed,
				...(overflowEvidence ? { overflowEvidence } : {}),
				...(reflowEvidence ? { reflowEvidence } : {}),
				settleAt,
				readyBeforeLegacySettle,
				teardownAllowedRowTexts: [...targetLiteral, ...Object.values(HEADER_BY_STATUS), "─".repeat(config.bodyCols)],
				analysis,
			};
		},
	);
	// Step 20A G3 closing: evaluate the resize gate at RECORD time over the FULL
	// collected arrays (all commands, all applied acks, all child live resize
	// events), never a mid-trial or first-only snapshot.
	const exactlyOneResize = exactlyOneResizeGate({
		resizeCommands: (result.resizeCommands as Array<{ cols: number; rows: number }>) ?? [],
		appliedAcks: (result.appliedAcks as Array<{ cols: number; rows: number }>) ?? [],
		childResizeEvents: (result.childResizeEvents as Array<{ cols: number; rows: number }>) ?? [],
		target: G.target,
	});
	return matrixCellRecord({
		caseId,
		error: (result.error as string | null) ?? null,
		ok: result.ok === true,
		cleanupOk: (result.cleanup as { ok?: boolean } | undefined)?.ok === true,
		times: { childResizeEvents: result.childResizeEvents, targetDimsUsed: result.targetDimsUsed },
		readyBeforeLegacySettle: (result.readyBeforeLegacySettle as boolean | null) ?? null,
		analysis: result.analysis as ReturnType<typeof analyzeMatrixFrames>,
		resizeSizes: (result.resizeSizes as Array<{ cols: number; rows: number; at: number }>) ?? [],
		extra: { seedProof: result.seedProof, exactlyOneResize, ...(result.overflowEvidence ? { overflowEvidence: result.overflowEvidence } : {}), ...(result.reflowEvidence ? { reflowEvidence: result.reflowEvidence } : {}), artifactDir, measurementPath: result.measurementPath, observation: result.observation },
	});
}

/** Paint one captured snapshot frame on an independent raw terminal. */
async function paintFrameAt(frameData: string, cols: number, rows: number): Promise<string[]> {
	const { Terminal: HeadlessTerminal } = /** @type {any} */ (xtermHeadless);
	const raw = new HeadlessTerminal({ cols, rows, allowProposedApi: true });
	try {
		await new Promise<void>((resolveWrite) => raw.write(frameData, resolveWrite));
		const painted: string[] = [];
		for (let y = 0; y < rows; y++) painted.push(raw.buffer.active.getLine(y)?.translateToString(true) ?? "");
		return painted;
	} finally {
		raw.dispose();
	}
}

// ---------------------------------------------------------------------------
// Retained S/C/T raw evidence audit (no ceremonial rerun). Reads the retained
// raw evidence and verifies the literal half-frame/oracle assertions, source
// hashes and cleanup actually exist. Missing evidence is identified precisely,
// never invented.
// ---------------------------------------------------------------------------

export interface RetainedCheck {
	name: string;
	ok: boolean | null;
	note: string;
}

export interface RetainedAuditResult {
	caseId: string;
	cell?: string;
	evidenceRoot: string | null;
	present: boolean;
	checks: RetainedCheck[];
}

/**
 * Audit ONE retained evidence dir with per-Named-check assertions read from the
 * ACTUAL retained fields. A missing assertion is `false`, never invented.
 * `opts.cell` (S: `<variant>-<entry>`) and `opts.timing` (T) select the
 * per-cell literals. No trial is rerun.
 */
export function auditRetainedEvidence(
	evidenceDir: string | null,
	caseId: "S" | "C" | "T",
	opts?: { cell?: string; timing?: "on-time" | "late" },
): RetainedAuditResult {
	const checks: RetainedCheck[] = [];
	if (evidenceDir === null) {
		return { caseId, evidenceRoot: null, present: false, checks: [{ name: "evidence-root", ok: false, note: "no retained evidence directory supplied" }] };
	}
	let present = true;
	const readJson = (rel: string): unknown | null => {
		try {
			return JSON.parse(readFileSync(join(evidenceDir, rel), "utf8"));
		} catch {
			present = false;
			checks.push({ name: rel, ok: false, note: "missing or unreadable" });
			return null;
		}
	};
	const summary = readJson("summary.json") as Record<string, unknown> | null;
	const observations = readJson("observations.json") as { observations?: Array<Record<string, unknown>> } | null;
	const cleanup = readJson("cleanup.json") as Record<string, unknown> | null;
	const innerParser = caseId === "T" ? (readJson("inner-parser.json") as Array<Record<string, unknown>> | null) : null;
	const childEvents = (() => {
		try {
			return readFileSync(join(evidenceDir, "child-events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		} catch {
			present = false;
			checks.push({ name: "child-events.jsonl", ok: false, note: "missing or unreadable" });
			return [];
		}
	})();

	checks.push({ name: "summary.json present", ok: summary !== null, note: summary === null ? "missing summary" : "summary loaded" });
	checks.push({ name: "observations.json present", ok: observations !== null, note: observations === null ? "missing observations" : `observations: ${observations?.observations?.length ?? 0}` });
	checks.push({ name: "cleanup.json present", ok: cleanup !== null, note: cleanup === null ? "missing cleanup" : `cleanup.ok=${cleanup?.ok}` });
	checks.push({ name: "child-events.jsonl present", ok: childEvents.length > 0, note: `events: ${childEvents.length}` });

	const childWrites = childEvents.filter((e) => e.event === "stdout-write");
	checks.push({
		name: "child stdout-write sha256 evidence present",
		ok: childWrites.length > 0 && childWrites.every((e) => typeof e.sha256 === "string" && e.sha256.length === 64),
		note: `child writes: ${childWrites.length}; every write carries a 64-hex sha256`,
	});

	// Case-specific retained assertions, read from the ACTUAL summary fields
	// (never invented retroactively; a missing field is reported as false).
	const field = (path: string): unknown => {
		let v: unknown = summary;
		for (const key of path.split(".")) {
			if (v && typeof v === "object") v = (v as Record<string, unknown>)[key];
			else return undefined;
		}
		return v;
	};
	if (caseId === "S") {
		const cell = opts?.cell ?? "unknown";
		const isSameWrite = cell.startsWith("same-write");
		const expectedTarget = isSameWrite ? "F2" : "F1";
		const finalTarget = field("finalTarget") as { committed?: boolean; frameId?: string } | undefined;
		const f0SeedProof = field("f0SeedProof") as { ok?: boolean } | undefined;
		const streamAudit = field("streamAudit") as { ok?: boolean } | undefined;
		const closeOrdering = field("closeOrdering") as { ok?: boolean } | undefined;
		const teardownViolations = field("teardownViolations") as unknown[] | undefined;
		checks.push({
			name: `S ${cell} final literal target committed (${expectedTarget})`,
			ok: finalTarget?.committed === true && finalTarget?.frameId === expectedTarget,
			note: finalTarget?.committed === true ? `finalTarget.frameId=${finalTarget.frameId}` : "missing or uncommitted final target",
		});
		checks.push({ name: `S ${cell} f0SeedProof.ok`, ok: f0SeedProof?.ok === true, note: `f0SeedProof.ok=${f0SeedProof?.ok}` });
		checks.push({ name: `S ${cell} streamAudit.ok`, ok: streamAudit?.ok === true, note: `streamAudit.ok=${streamAudit?.ok}` });
		checks.push({ name: `S ${cell} closeOrdering.ok`, ok: closeOrdering?.ok === true, note: `closeOrdering.ok=${closeOrdering?.ok}` });
		checks.push({ name: `S ${cell} no teardown violations`, ok: Array.isArray(teardownViolations) && teardownViolations.length === 0, note: `teardownViolations=${teardownViolations?.length ?? "missing"}` });
		checks.push({ name: `S ${cell} cleanup.ok`, ok: cleanup?.ok === true, note: `cleanup.ok=${cleanup?.ok}` });
		// Layout-specific half-frame counterexample (review M5: the upper/lower
		// split at row 11 is specific to this 80x22 battery; it is not a general
		// half-frame definition).
		const halfFrameEvidence = observations?.observations?.some((o) => {
			const grid = (o as { grid?: Array<{ text?: string }> }).grid ?? [];
			const texts = grid.map((r) => r.text ?? "");
			const upper = texts.slice(0, 11).filter((t) => t.includes("UPPER") || t.includes("HEADER")).map((t) => /^([A-Za-z]+[0-9]+) /.exec(t)?.[1]).filter(Boolean);
			const lower = texts.slice(11).filter((t) => t.includes("LOWER") || t.includes("TAIL") || t.includes("INPUT")).map((t) => /^([A-Za-z]+[0-9]+) /.exec(t)?.[1]).filter(Boolean);
			return upper.length > 0 && lower.length > 0 && upper.some((u) => !lower.includes(u)) && lower.some((l) => !upper.includes(l));
		});
		checks.push({
			name: `S ${cell} mixed upper/lower half-frame counterexample present`,
			ok: halfFrameEvidence ?? false,
			note: halfFrameEvidence ? "a retained observation carries different upper/lower frame ids (the half-frame counterexample)" : "no retained observation with mixed upper/lower frame ids",
		});
	} else if (caseId === "C") {
		const emptyBaseline = field("emptyBaselineProof") as { ok?: boolean } | undefined;
		const editorCommit = field("editorCommit") as { committed?: boolean; rows?: string[] } | undefined;
		const exposure = field("incompleteEditorExposure") as { verdict?: string } | undefined;
		const poison = field("postTeardownAnalysis.poison.neverVisibleOnOuter") as boolean | undefined;
		checks.push({ name: "C empty authoritative baseline proven before mount", ok: emptyBaseline?.ok === true, note: emptyBaseline?.ok === true ? "emptyBaselineProof.ok=true" : "missing or failed empty baseline proof" });
		checks.push({ name: "C partial editor exposure recorded", ok: typeof exposure?.verdict === "string", note: `incompleteEditorExposure.verdict=${exposure?.verdict ?? "missing"}` });
		checks.push({
			name: "C final literal E1 editor committed",
			ok: editorCommit?.committed === true && Array.isArray(editorCommit.rows) && editorCommit.rows[0] === "E1 HEADER controlled cold editor" && editorCommit.rows[19] === "E1 TAIL assistant final answer",
			note: editorCommit?.committed === true ? `E1 rows=${editorCommit.rows?.length ?? 0}` : "missing or uncommitted E1 editor",
		});
		checks.push({ name: "C poisoned log never visible on the outer terminal", ok: poison === true, note: poison === true ? "neverVisibleOnOuter=true" : "missing or visible poison (recorded as a retained defect, not an edit)" });
		checks.push({ name: "C cleanup.ok", ok: cleanup?.ok === true, note: `cleanup.ok=${cleanup?.ok}` });
	} else if (caseId === "T") {
		const timing = opts?.timing ?? "on-time";
		const scheme = timing === "late" ? "light" : "dark";
		const expectedReport = timing === "late" ? "997;2" : "997;1";
		const zeroResize = field("zeroResize") as { ok?: boolean } | undefined;
		const themeRedraw = field("themeRedraw") as { committed?: boolean; rows?: string[]; outerCursor?: { x?: number; y?: number; visible?: boolean }; childLogicalCursor?: { x?: number; y?: number; visible?: boolean }; childRepaintWrites?: Array<{ frame?: string; sha256?: string }> } | undefined;
		const delivery = field("delivery") as { messages?: Array<{ dataHas997?: boolean; report?: string }> } | undefined;
		const reply = field("reply") as { timing?: string } | undefined;
		const timeoutWait = field("timeoutWait") as { timeoutDiagnosticReceiptAt?: number } | undefined;
		const expectedRows = s16ThemeRowsText("T1", `${scheme} applied`);
		checks.push({ name: `T-${timing} zero resize control`, ok: zeroResize?.ok === true, note: zeroResize?.ok === true ? "zeroResize.ok=true" : "missing or a resize was sent" });
		checks.push({
			name: `T-${timing} full target grid literal (22 rows, ${scheme} applied)`,
			ok: themeRedraw?.committed === true && Array.isArray(themeRedraw.rows) && themeRedraw.rows.length === 22 && rowsEqual(themeRedraw.rows, expectedRows),
			note: themeRedraw?.committed === true ? `T1 rows=${themeRedraw.rows?.length ?? 0}` : "missing or uncommitted theme redraw",
		});
		checks.push({
			name: `T-${timing} outer cursor hidden and child logical cursor pinned`,
			ok: themeRedraw?.outerCursor?.visible === false && themeRedraw?.childLogicalCursor?.x === S16_SURFACE_CURSOR.x && themeRedraw?.childLogicalCursor?.y === S16_SURFACE_CURSOR.y,
			note: `outerCursor=${JSON.stringify(themeRedraw?.outerCursor)} childLogicalCursor=${JSON.stringify(themeRedraw?.childLogicalCursor)}`,
		});
		checks.push({
			name: `T-${timing} real ${expectedReport} report delivered`,
			ok: Array.isArray(delivery?.messages) && delivery!.messages!.some((m) => m.dataHas997 === true && m.report === expectedReport),
			note: `delivery report=${delivery?.messages?.map((m) => m.report).join(",") ?? "missing"}`,
		});
		const repaintShas = themeRedraw?.childRepaintWrites?.map((w) => w.sha256).filter((s): s is string => typeof s === "string") ?? [];
		const enqueueShas = new Set((innerParser ?? []).filter((e) => e.kind === "enqueue").map((e) => e.sha256).filter((s): s is string => typeof s === "string"));
		checks.push({
			name: `T-${timing} child repaint hash matches an inner-parser enqueue`,
			ok: repaintShas.length > 0 && repaintShas.every((s) => enqueueShas.has(s)),
			note: `repaintShas=${repaintShas.length} enqueueShas=${enqueueShas.size}`,
		});
		if (timing === "late") {
			checks.push({
				name: "T-late actual production timeout then late reply",
				ok: reply?.timing === "late" && typeof timeoutWait?.timeoutDiagnosticReceiptAt === "number",
				note: `reply.timing=${reply?.timing} timeoutDiagnosticReceiptAt=${timeoutWait?.timeoutDiagnosticReceiptAt ?? "missing"}`,
			});
		} else {
			checks.push({ name: "T-on-time reply without a late timeout", ok: reply?.timing === "on-time" && (timeoutWait === null || timeoutWait === undefined), note: `reply.timing=${reply?.timing} timeoutWait=${timeoutWait == null ? "absent" : "present (unexpected)"}` });
		}
		checks.push({ name: `T-${timing} cleanup.ok`, ok: cleanup?.ok === true, note: `cleanup.ok=${cleanup?.ok}` });
	}

	return { caseId, ...(opts?.cell ? { cell: opts.cell } : {}), ...(opts?.timing ? { cell: `T-${opts.timing}` } : {}), evidenceRoot: evidenceDir, present, checks };
}

/** Audit all nine S battery cells with per-cell named checks (no rerun). */
export function auditRetainedSCells(batteryRoot: string): RetainedAuditResult[] {
	const results: RetainedAuditResult[] = [];
	for (const variant of ["plain", "same-write", "split"] as const) {
		for (const entry of ["ticker", "status", "capture"] as const) {
			results.push(auditRetainedEvidence(join(batteryRoot, `trial-${variant}-${entry}`), "S", { cell: `${variant}-${entry}` }));
		}
	}
	return results;
}

/** Audit both retained theme trials (on-time and late) with full per-cell checks. */
export function auditRetainedTTrials(onTimeDir: string, lateDir: string): RetainedAuditResult[] {
	return [auditRetainedEvidence(onTimeDir, "T", { timing: "on-time" }), auditRetainedEvidence(lateDir, "T", { timing: "late" })];
}

// ---------------------------------------------------------------------------
// Case dispatcher + CLI
// ---------------------------------------------------------------------------

const MATRIX_CASES = new Set(["B", "Q", "L-normal", "L-alt", "G1", "G2", "G3"]);

export async function runCase20A(options: { caseId: string; artifactDir: string }): Promise<Record<string, unknown>> {
	const { caseId, artifactDir } = options;
	mkdirSync(artifactDir, { recursive: true });
	const invocationId = `inv-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
	const appendInvocation = (record: Record<string, unknown>) => appendFileSync(join(artifactDir, "invocations.jsonl"), JSON.stringify(record) + "\n");
	appendInvocation({ kind: "begin", invocationId, at: new Date().toISOString(), caseId, repeat: 1, clock: "real", pid: process.pid });
	const trialDir = join(artifactDir, `trial-${caseId.toLowerCase()}`);
	appendInvocation({ kind: "trial-begin", invocationId, at: new Date().toISOString(), caseId, trialDir });
	let record: Record<string, unknown>;
	try {
		if (caseId === "B") record = await runBusyQuiet("B", trialDir);
		else if (caseId === "Q") record = await runBusyQuiet("Q", trialDir);
		else if (caseId === "L-normal" || caseId === "L-alt") record = await runLonglog(caseId, trialDir);
		else record = await runGeometry(caseId as "G1" | "G2" | "G3", trialDir);
	} catch (err) {
		record = { caseId, ok: false, artifactDir: trialDir, error: err instanceof Error ? (err.stack ?? err.message) : String(err), frameFailures: [], resizeSizes: [] };
	}
	appendInvocation({ kind: "trial-end", invocationId, at: new Date().toISOString(), caseId, ok: record.ok });
	const result: Record<string, unknown> = {
		ok: record.error === null || record.error === undefined,
		measurementPath: record.measurementPath ?? null,
		caseId,
		repeat: 1,
		clock: "real",
		invocationId,
		trials: [record],
		artifactRoot: artifactDir,
	};
	appendInvocation({ kind: "end", invocationId, at: new Date().toISOString(), ok: result.ok });
	writeFileSync(join(artifactDir, `result-${invocationId}.json`), JSON.stringify(result, null, 2));
	return result;
}

function cliError(message: string): never {
	process.stderr.write(`pty-attach-matrix-scenario: ${message}\n`);
	process.exit(2);
}

export function parseMatrixCli(argv: string[]): { caseId: string; repeat: number; clock: string; artifactDir: string } {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith("--") || i + 1 >= argv.length) cliError(`malformed arguments: ${argv.join(" ")}`);
		args.set(argv[i].slice(2), argv[i + 1]);
	}
	const caseId = args.get("case") ?? cliError("missing --case");
	if (!MATRIX_CASES.has(caseId)) {
		cliError(`unsupported --case ${JSON.stringify(caseId)} (only ${[...MATRIX_CASES].join(", ")} are implemented)`);
	}
	const repeat = Number(args.get("repeat") ?? cliError("missing --repeat"));
	if (repeat !== 1) cliError(`unsupported --repeat ${JSON.stringify(args.get("repeat"))} (only 1 is implemented)`);
	const clock = args.get("clock") ?? cliError("missing --clock");
	if (clock !== "real") cliError(`unsupported --clock ${JSON.stringify(clock)} (only "real" is implemented)`);
	const artifactDir = args.get("artifact-dir") ?? cliError("missing --artifact-dir");
	return { caseId, repeat, clock, artifactDir };
}

const isMain = (() => {
	try {
		return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
	} catch {
		return false;
	}
})();

if (isMain) {
	const cli = parseMatrixCli(process.argv.slice(2));
	runCase20A({ caseId: cli.caseId, artifactDir: cli.artifactDir })
		.then((result) => {
			process.stdout.write(JSON.stringify(result) + "\n");
			process.exit(0);
		})
		.catch((err) => {
			process.stderr.write(`pty-attach-matrix-scenario: harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exit(1);
		});
}
