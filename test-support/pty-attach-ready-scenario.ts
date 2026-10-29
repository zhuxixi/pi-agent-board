// Issue #222 step 15 integration (task-15-integration-brief.md,
// task-15-integration-recovery1-brief.md): REAL-runner half-frame diagnostic,
// case S. A battery run owns, per trial, an independent temp store root, a
// REAL runner/pty-runner.mjs hosting the accepted controlled-frames child
// (test-support/fake-pty-pi.mjs, FAKE_PTY_STREAM_MODE=controlled-frames), a
// REAL PtyAttachComponent mounted as the layout root of a REAL TuiAltScreen
// whose terminal is the accepted AttachPresentationObserver, and a second raw
// client on the same runner endpoint that speaks the REAL
// subscribe_terminal/capture protocol.
//
// All nine (variant x entry) cells run through ONE shared trial seam
// (runTrial) under the approved CLI; a valid invocation runs the full
// battery (runCaseS). Render-entry attribution uses synchronous receive-call
// identity (P15-CAUSAL-1): the component's real onSocketData is wrapped
// log-and-delegate, and every eligible control consumed in that call is a
// recorded candidate — several stay "ambiguous", a missing context is
// "unknown", and there is no nearest-message time fallback.
//
// Truths are independent: expected screens are literal producer-contract rows
// declared BEFORE each trial; observations come only from the observer;
// chrome rows are accounted for against declared literals; oracle failures
// are append-only diagnostic evidence (a reproduced half-frame is a retained
// counterexample, not a harness failure). Verdicts per hypothesis are one of
// REPRODUCED / NOT_REPRODUCED / INCONCLUSIVE / INFRASTRUCTURE_FAILURE.
//
// CLI (approved surface): --case S --repeat 1 --clock real --artifact-dir
// <owned path>. Unsupported cases/clocks/repeats fail explicitly (stderr +
// exit 2, no dummy success). Prints exactly one JSON result line on stdout.
// Run via `node --experimental-transform-types`.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import xtermHeadless from "@xterm/headless";
import { TuiAltScreen } from "@earendil-works/pi-tui/dist/tui-alt-screen.js";
import {
	AttachPresentationObserver,
	asTerminal,
	validateAttachPresentation,
	type AttachPresentationExpectation,
	type ExpectedPresentationScreen,
	type PresentationFailure,
	type PresentationObservation,
} from "./attach-presentation-fixture.ts";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { claimHost, createView, readHost } from "../src/core/store.mjs";
// PtyAttachComponent uses TS parameter properties, which node's strip-only
// mode rejects: the VALUE is imported lazily inside the trial driver (the
// spawned/eval driver runs with --experimental-transform-types), keeping this
// module importable under plain `node --test` for the pure-helper tests.
import type { PtyAttachComponent as PtyAttachComponentType } from "../src/ui/pty-attach.ts";
import { formalMeasurementVersion } from "./formal-measurement/version.mjs";
import { holdFormalObservation } from "./formal-measurement/observation.mjs";

// ---------------------------------------------------------------------------
// Geometry and literal content contract (producer report, task-15).
// The child owns an 80x22 work area; the observer terminal is 80x24 with one
// header chrome row (screen row 0) and one footer chrome row (screen row 23)
// produced by the REAL PtyAttachComponent render. All texts below are ASCII
// or single-width BMP glyphs, so string length equals terminal cell width.
// ---------------------------------------------------------------------------

export const WORK_AREA = { cols: 80, rows: 22, screenRows: 24, bodyTop: 1, footerRow: 23 } as const;

/**
 * Parameterized attach-surface geometry (step 20A, additive). The accepted
 * S/A4/A5/T/GEN seams keep using WORK_AREA; the G2/G3 matrix cells request a
 * non-default body size so the observer terminal, chrome projection and
 * footer divider follow the same two-chrome-row contract.
 */
export interface AttachSurfaceDims {
	cols: number;
	rows: number;
	screenRows: number;
	bodyTop: number;
	footerRow: number;
}

/** Build the attach-surface geometry for a body of bodyCols x bodyRows.
 *  The observer terminal always adds one header row and one footer row. */
export function makeAttachDims(bodyCols: number, bodyRows: number): AttachSurfaceDims {
	return { cols: bodyCols, rows: bodyRows, screenRows: bodyRows + 2, bodyTop: 1, footerRow: bodyRows + 1 };
}

/** Attach surface title used by every trial (kept short for stable chrome). */
export const TITLE = "s15";

/** Explicit enumeration of the production SPINNER constant (pty-attach.ts). */
export const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Literal loading-banner detail lines the REAL component can produce. */
export const LOADING_DETAILS = {
	starting0: "Starting the session host… 0s",
	starting1: "Starting the session host… 1s",
	attached: "Attached · waiting for the session to render…",
} as const;

/**
 * Declared header chrome literals (identity theme, width never clips at 80).
 * Only these statuses occur in a healthy trial: connecting before the socket
 * connect, attached after, "host exited" after the child's exit broadcast.
 */
export const HEADER_BY_STATUS = {
	connecting: ` ${TITLE} ` + "connecting · opens links · drag selects+copies · Ctrl+←/Ctrl+\\ detach",
	attached: ` ${TITLE} ` + "attached · opens links · drag selects+copies · Ctrl+←/Ctrl+\\ detach",
	hostExited: ` ${TITLE} ` + "host exited · opens links · drag selects+copies · Ctrl+←/Ctrl+\\ detach",
} as const;

/** Footer chrome literal: the component's divider row. */
export const FOOTER_ROW = "─".repeat(WORK_AREA.cols);

/** The producer contract's literal work-area rows for frame `id` (F0/F1/F2). */
export function producerRowsText(id: string): string[] {
	return [
		`${id} HEADER controlled work area`,
		`${id} UPPER reply history one`,
		`${id} UPPER reply history two`,
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		`${id} MIDDLE divider`,
		`${id} LOWER reply history three`,
		`${id} LOWER reply history four`,
		"",
		"",
		"",
		"",
		"",
		"",
		`${id} TAIL assistant final answer`,
		"",
		`${id} INPUT >`,
	];
}

/** The producer contract's logical child cursor (hidden, parked after INPUT). */
export const PRODUCER_CURSOR = { x: 10, y: 21, visible: false } as const;

/**
 * Mechanical left-pad centering, mirroring the documented formula of the
 * component's center(): floor((width - textWidth)/2) spaces. All declared
 * texts are single-width BMP, so length is the cell width. Pinned to literal
 * outputs by the focused integration test.
 */
export function centerPad(text: string, width: number): string {
	return " ".repeat(Math.max(0, Math.floor((width - text.length) / 2))) + text;
}

/**
 * Literal loading-banner body rows (22 work-area rows) for one spinner/detail
 * combination. Layout mirrors renderLoading(): floor((22-3)/2) = 9 blank
 * rows, title, detail, blank, detach hint, then blank padding.
 */
export function loadingBodyRows({ spinner, detail }: { spinner: string; detail: string }): string[] {
	const rows: string[] = [];
	const top = Math.floor((WORK_AREA.rows - 3) / 2); // renderLoading(): 9
	for (let i = 0; i < top; i++) rows.push("");
	rows.push(centerPad(`${spinner} Loading "${TITLE}"…`, WORK_AREA.cols));
	rows.push(centerPad(detail, WORK_AREA.cols));
	rows.push("");
	rows.push(centerPad("Ctrl+←/Ctrl+\\ to detach", WORK_AREA.cols));
	while (rows.length < WORK_AREA.rows) rows.push("");
	return rows.slice(0, WORK_AREA.rows);
}

/**
 * Mechanical body/chrome coordinate projection: drop header row 0 and footer
 * row 23, re-base the cursor into work-area coordinates. Content-independent;
 * the original observation object is never mutated (a new view is returned).
 */
export function projectObservationToWorkArea(observation: PresentationObservation): PresentationObservation {
	return {
		...observation,
		rows: WORK_AREA.rows,
		grid: observation.grid.slice(WORK_AREA.bodyTop, WORK_AREA.footerRow),
		cursor: {
			...observation.cursor,
			y: observation.cursor.y - WORK_AREA.bodyTop,
			absoluteY: observation.cursor.absoluteY - WORK_AREA.bodyTop,
		},
	};
}

/**
 * Chrome accounting for one observation. Returns the violated row roles
 * ([] = clean). A fully blank grid is a bootstrap window (nothing painted
 * yet) and is the ONLY chrome exemption; a blank body WITH chrome painted is
 * still checked by the oracle itself, never suppressed here.
 */
export function checkChromeRows(observation: PresentationObservation): string[] {
	if (observation.grid.every((row) => row.text === "")) return []; // bootstrap window: no chrome painted yet
	const violations: string[] = [];
	const header = observation.grid[0]?.text ?? "";
	if (!Object.values(HEADER_BY_STATUS).includes(header)) violations.push("header");
	if ((observation.grid[WORK_AREA.footerRow]?.text ?? "") !== FOOTER_ROW) violations.push("footer");
	return violations;
}

/** Row indices of producer rows that carry the frame identity token. */
function frameIdRows(id: string): (string | null)[] {
	return producerRowsText(id).map((text) => (text.includes(id) ? id : null));
}

function frameScreen(id: string): ExpectedPresentationScreen {
	return {
		name: `${id.toLowerCase()}-complete`,
		rows: producerRowsText(id),
		rowFrameIds: frameIdRows(id),
		// Outer hardware cursor contract (source-grounded, continuation finding
		// F2): the component always emits CURSOR_MARKER at the projected child
		// cursor cell (lineToAnsi, visibility-independent), and TuiAltScreen's
		// doRender ends every frame by parking the hardware cursor there with
		// ?25l because the TUI runs with showHardwareCursor=false. Work-area
		// (10,21) hidden is therefore the REQUIRED outer state on a complete
		// frame — a visible outer cursor is a defect, not a variation. The
		// child's logical cursor is recorded separately (finalTarget
		// .childLogicalCursor), never equated with this outer fact.
		cursor: { x: 10, y: 21, visible: false },
		// The inverse-cell set IS asserted: no software-cursor block or
		// selection may appear (the hydrate DECTCEM loss is a recorded defect,
		// not an allowed screen).
		inverseCells: [],
	};
}

/**
 * The declared expectation for one variant, built from literal contract rows
 * BEFORE the trial runs. Work-area projected coordinates. Loading/chrome
 * variations are enumerated explicitly (spinner x detail phase); the final
 * teardown screen is the alt-screen exit's restored normal buffer, declared
 * up front so no later invalid blank body is silently suppressed (it is the
 * last screen only because teardown is the trial's last action).
 */
export function buildExpectation(variant: "plain" | "same-write" | "split"): AttachPresentationExpectation {
	// ACTIVE expectation only (continuation finding F1): no teardown escape —
	// the ordered checker must reject an invalid blank once content committed.
	// Loading spinners are a REPEATING set: enumeration order assumes the
	// attaching window stays under one spinner cycle (1200ms), which the trial
	// record asserts explicitly.
	const screens: ExpectedPresentationScreen[] = [{ name: "bootstrap-blank", rows: [], inverseCells: [] }];
	for (const detail of [LOADING_DETAILS.starting0, LOADING_DETAILS.starting1, LOADING_DETAILS.attached]) {
		for (const spinner of SPINNERS) {
			screens.push({ name: `loading-${detail}-${spinner}`, rows: loadingBodyRows({ spinner, detail }), loading: true, inverseCells: [] });
		}
	}
	screens.push(frameScreen("F0"));
	// F1 complete is a legitimate accepted screen even for same-write
	// (CLOSE+OPEN in one write does not make a committed complete F1 invalid).
	screens.push(frameScreen("F1"));
	if (variant === "same-write") screens.push(frameScreen("F2"));
	return { screens, frameIds: ["F0", "F1", "F2"] };
}

/** Active-window validation: the accepted checker over projected observations. */
export function validateActiveObservations(
	observations: readonly PresentationObservation[],
	expectation: AttachPresentationExpectation,
): PresentationFailure[] {
	return validateAttachPresentation(observations, expectation);
}

/**
 * Predeclared teardown contract (continuation finding F4): observations after
 * the analysis boundary (component dispose + tui.stop) may only carry content
 * from the already-committed final target and the declared chrome, or be
 * blank (restored buffer). Cursor visibility is unconstrained at teardown
 * (tui.stop() legitimately calls showCursor). Any content appearing ONLY at
 * teardown is a violation.
 */
export interface TeardownContract {
	finalTargetId: string;
	allowedRowTexts: string[];
}

export function buildTeardownContract(finalTargetId: string): TeardownContract {
	return {
		finalTargetId,
		allowedRowTexts: [...producerRowsText(finalTargetId), ...Object.values(HEADER_BY_STATUS), FOOTER_ROW],
	};
}

export function validateTeardownObservations(
	observations: readonly PresentationObservation[],
	contract: TeardownContract,
): Array<{ index: number; violation: string; text: string }> {
	const allowed = new Set(contract.allowedRowTexts);
	const violations: Array<{ index: number; violation: string; text: string }> = [];
	for (const observation of observations) {
		for (const row of observation.grid) {
			const text = row.text.replace(/\s+$/u, "");
			if (text === "") continue;
			if (!allowed.has(text)) {
				violations.push({ index: observation.index, violation: "teardown-foreign-content", text });
			}
		}
	}
	return violations;
}

// ---------------------------------------------------------------------------
// Runtime: owned runner/child mounting, trace plumbing, the shared trial seam.
// Every spawn/socket/root is owned immediately; every wait is bounded;
// cleanup runs on success AND failure.
// ---------------------------------------------------------------------------

const { Terminal: HeadlessTerminal } = /** @type {any} */ (xtermHeadless);

/** Lazy runtime imports that require --experimental-transform-types. */
async function loadRuntime() {
	try {
		const { PtyAttachComponent } = await import("../src/ui/pty-attach.ts");
		return { PtyAttachComponent };
	} catch (err) {
		throw new Error(
			`runTrial/runCaseS must run under node --experimental-transform-types (the component module uses TS parameter properties): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SYNC_OPEN = "\x1b[?2026h";
const PRODUCER_RS = "\x1e";
const producerCommand = (obj: unknown) => `${PRODUCER_RS}${JSON.stringify(obj)}\n`;
const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const start = now();
	while (now() - start < timeoutMs) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for: ${label}`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** One logged render request: receipt time, force flag, scheduling disposition,
 *  classified entry and the RAW caller stack (retained for audit). */
interface RenderRequestRecord {
	seq: number;
	at: number;
	force: boolean;
	scheduled: boolean;
	entry: string;
	stack: string;
	/** Synchronous receive-call identity (P15-CAUSAL-1): the logged
	 *  onSocketData call this request was made in, or null when the request was
	 *  made outside any receive (e.g. asynchronous output-driven scheduling). */
	receiveId: number | null;
	/** Set by analysis: eligible control message types / candidate entries. */
	messageTypes?: string[];
	candidates?: string[];
}

/**
 * Classify a render request's entry from its raw caller stack. Line-number
 * free: only module names and method names are matched. Anything
 * unrecognised stays "unknown" — never guessed.
 */
function classifyRequest(stack: string, force: boolean, tuiStarted: boolean): string {
	if (stack.includes("pty-attach-render")) return "output-40ms";
	if (force && stack.includes("finishAttachTransition")) return "settle";
	if (force) return tuiStarted ? "force-other" : "first-paint";
	if (stack.includes("onSocketData")) return "socket-control";
	if (stack.includes("handleKeyInput") || stack.includes("handleInput")) return "input-echo";
	if (stack.includes("TuiBase.start")) return "tui-start";
	if (stack.includes("pty-attach.ts") && stack.includes("Timeout")) return "loading-ticker";
	return "unknown";
}

/**
 * Trace wrapper: logs every requestRender call (receipt time, force, whether
 * THIS call actually scheduled a render, caller stack) and delegates the
 * original method unchanged. Never replaces requestRender with rendering.
 */
function wrapRequestRender(tui: TuiAltScreen, log: RenderRequestRecord[], state: { started: boolean }, getReceiveId?: () => number | null): void {
	const anyTui = tui as unknown as {
		requestRender: (force?: boolean) => void;
		renderRequested?: boolean;
		immediateRenderScheduled?: boolean;
	};
	const original = anyTui.requestRender.bind(tui);
	anyTui.requestRender = (force?: boolean) => {
		const at = now();
		const wasRequested = anyTui.renderRequested === true;
		const wasImmediate = anyTui.immediateRenderScheduled === true;
		const stack = new Error().stack ?? "";
		original(force);
		const scheduled = force === true ? !wasImmediate : !wasRequested && anyTui.renderRequested === true;
		log.push({
			seq: log.length,
			at,
			force: force === true,
			scheduled,
			entry: classifyRequest(stack, force === true, state.started),
			stack,
			receiveId: getReceiveId ? getReceiveId() : null,
		});
	};
}

/**
 * Mechanical right-trim of row text, applying the producer contract's
 * documented read convention ("row text is right-trimmed when read") to the
 * OBSERVED side. Required because the runner's synthesized hydrate frame
 * pads rows to full width with SGR-marked space cells that survive
 * translateToString(true). Content-independent; the raw padded rows stay in
 * the untouched observations artifact.
 */
export function rtrimRows(rows: string[]): string[] {
	return rows.map((row) => row.replace(/\s+$/u, ""));
}

/** Projected body rows of one observation (work-area coordinates, contract right-trim). */
function projectedRows(observation: PresentationObservation): string[] {
	return rtrimRows(projectObservationToWorkArea(observation).grid.map((row) => row.text));
}

function rowsEqual(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((text, i) => text === expected[i]);
}

/** Feed one captured snapshot frame into an independent raw terminal. */
async function paintCaptureFrame(frameData: string): Promise<string[]> {
	const raw = new HeadlessTerminal({ cols: WORK_AREA.cols, rows: WORK_AREA.rows, allowProposedApi: true });
	try {
		await new Promise<void>((resolveWrite) => raw.write(frameData, resolveWrite));
		const rows: string[] = [];
		for (let y = 0; y < WORK_AREA.rows; y++) rows.push(raw.buffer.active.getLine(y)?.translateToString(true) ?? "");
		return rows;
	} finally {
		raw.dispose();
	}
}

interface ProbeMessage {
	at: number;
	msg: Record<string, unknown>;
}

/** A raw second client on the runner endpoint speaking the real subscribe/capture protocol. */
interface ProbeClient {
	socket: Socket;
	messages: ProbeMessage[];
	capture: () => Promise<{ begin: Record<string, unknown>; frame: string | null; end: Record<string, unknown>; startedAt: number; endedAt: number }>;
	destroy: () => void;
}

function connectProbe(socketPath: string): Promise<ProbeClient> {
	return new Promise((resolveProbe, rejectProbe) => {
		// Bounded connect (continuation finding F5): a pending connect gets an
		// explicit deadline instead of hanging the trial.
		const connectDeadline = setTimeout(() => {
			try {
				socket.destroy();
			} catch {
				/* best-effort */
			}
			rejectProbe(new Error("probe connect timed out after 5000ms"));
		}, 5000);
		const socket = createConnection(socketPath);
		const messages: ProbeMessage[] = [];
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					messages.push({ at: now(), msg: JSON.parse(line) });
				} catch {
					/* malformed lines are runner errors; leave them out of the protocol log */
				}
			}
		});
		socket.on("error", () => {});
		socket.once("connect", () => {
			clearTimeout(connectDeadline);
			resolveProbe({
				socket,
				messages,
				capture: async () => {
					const startedAt = now();
					const base = messages.length;
					socket.write(JSON.stringify({ type: "subscribe_terminal", frameVersion: 1 }) + "\n");
					await waitFor(() => messages.slice(base).some((m) => m.msg.type === "snapshot_end" || m.msg.type === "error"), 5000, "probe snapshot_end");
					const endedAt = now();
					const slice = messages.slice(base).map((m) => m.msg);
					const begin = slice.find((m) => m.type === "snapshot_begin") ?? {};
					const frameMsg = slice.find((m) => m.type === "snapshot_frame");
					const end = slice.find((m) => m.type === "snapshot_end") ?? slice.find((m) => m.type === "error") ?? {};
					return { begin, frame: typeof frameMsg?.data === "string" ? frameMsg.data : null, end, startedAt, endedAt };
				},
				destroy: () => {
					try {
						socket.destroy();
					} catch {
						/* best-effort teardown */
					}
				},
			});
		});
		socket.once("error", (err) => {
			clearTimeout(connectDeadline);
			rejectProbe(err);
		});
	});
}

interface HoldRecord {
	after: string;
	plannedMs: number;
	actualMs: number;
	openFrame: boolean;
	startAt: number;
	endAt: number;
}

/** One REAL attach topology under observation (primary or fresh-attach secondary). */
interface Side {
	label: string;
	/** Attach-surface geometry this side was mounted at (step 20A). */
	dims: AttachSurfaceDims;
	observer: AttachPresentationObserver;
	tui: TuiAltScreen;
	component: PtyAttachComponentType;
	requests: RenderRequestRecord[];
	tuiState: { started: boolean };
	/** Logged synchronous receive calls (P15-CAUSAL-1), with exact raw text. */
	receiveContexts: ReceiveContextInput[];
	receiveState: ReceiveContextState;
	diagnostics: unknown[];
	doneResult: unknown;
	createdAt: number;
}

interface CaptureRecord {
	label: string;
	startedAt: number;
	endedAt: number;
	performed: boolean;
	snapshotSeq: unknown;
	rows: string[] | null;
}

interface TrialContext {
	variant: "plain" | "same-write" | "split";
	entry: "ticker" | "status" | "capture";
	root: string;
	viewId: string;
	runner: ChildProcess;
	runnerStderr: string[];
	probe: ProbeClient;
	primary: Side;
	secondary: Side | null;
	actions: Array<{ type: string; at: number; detail?: unknown }>;
	holds: HoldRecord[];
	captures: CaptureRecord[];
	/** Raw bytes received on the PRIMARY component's actual socket (extra
	 *  listener only — the component's own handler is untouched). */
	rxLog: Array<{ at: number; data: string }>;
}

// ---- component-socket receive logging (continuation finding F3) ------------

/**
 * Observe the exact bytes arriving on the component's live socket via an
 * ADDITIONAL data listener (never a wrapper; the component's own handler runs
 * unchanged). A poller re-attaches if the component reconnects onto a new
 * socket. Returns a detach function.
 */
function attachSocketRxLogger(component: PtyAttachComponentType, rxLog: Array<{ at: number; data: string }>): () => void {
	let current: Socket | null = null;
	const timer = setInterval(() => {
		const socket = (component as unknown as { socket: Socket | null }).socket;
		if (socket && socket !== current) {
			current = socket;
			socket.on("data", (chunk) => {
				rxLog.push({ at: now(), data: chunk.toString("utf8") });
			});
		}
	}, 5);
	timer.unref?.();
	return () => clearInterval(timer);
}

interface RxMessage {
	at: number;
	type: string;
	msg: Record<string, unknown>;
	/** Index into rxLog of the chunk that completed this message. */
	chunkIndex: number;
}

/** Parse the raw component-socket byte log into protocol messages, keeping the
 *  actual chunk receipt times (and thereby the actual chunking). */
function parseRxMessages(rxLog: Array<{ at: number; data: string }>): RxMessage[] {
	const messages: RxMessage[] = [];
	let carry = "";
	for (let chunkIndex = 0; chunkIndex < rxLog.length; chunkIndex++) {
		const record = rxLog[chunkIndex];
		carry += record.data;
		const lines = carry.split("\n");
		carry = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				messages.push({ at: record.at, type: msg.type ?? "?", msg, chunkIndex });
			} catch {
				/* non-protocol bytes are retained in rxLog itself */
			}
		}
	}
	return messages;
}

// ---- flow primitives -------------------------------------------------------

/** Send one framed child command through the REAL component input path. */
function sendChildCommand(ctx: TrialContext, side: Side, obj: unknown): void {
	const at = now();
	(side.component as unknown as { handleInput: (data: string) => void }).handleInput(producerCommand(obj));
	ctx.actions.push({ type: "child-command", at, detail: obj });
}

/** Ask the runner for status on the ACTUAL component socket (no public API
 *  exists for this; the write targets the component's live socket so the
 *  response arrives through the component's real onSocketData path, and the
 *  rx byte log pins the exact response message identity). */
function sendStatusRequest(ctx: TrialContext): void {
	const at = now();
	const socket = (ctx.primary.component as unknown as { socket: Socket | null }).socket;
	if (!socket) throw new Error("component socket is not connected");
	socket.write(JSON.stringify({ type: "get_status" }) + "\n");
	ctx.actions.push({ type: "get_status", at });
}

async function hold(ctx: TrialContext, after: string, plannedMs: number, openFrame: boolean): Promise<void> {
	const startAt = now();
	await sleep(plannedMs);
	const endAt = now();
	ctx.holds.push({ after, plannedMs, actualMs: endAt - startAt, openFrame, startAt, endAt });
}

/** Flow control only: never an expectation source. */
async function waitReceivedOutput(ctx: TrialContext, side: Side): Promise<void> {
	await waitFor(() => (side.component as unknown as { receivedOutput: boolean }).receivedOutput === true, 8000, `${side.label} receivedOutput`);
}

async function waitCommit(ctx: TrialContext, side: Side, frameId: string): Promise<void> {
	const literal = producerRowsText(frameId);
	await waitFor(
		() => side.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o), literal)),
		8000,
		`${side.label} outer ${frameId} commit frame`,
	);
	ctx.actions.push({ type: `${side.label}-${frameId}-commit-observed`, at: now() });
}

async function captureNow(ctx: TrialContext, label: string): Promise<void> {
	const capture = await ctx.probe.capture();
	const rows = capture.frame !== null ? rtrimRows(await paintCaptureFrame(capture.frame)) : null;
	ctx.captures.push({
		label,
		startedAt: capture.startedAt,
		endedAt: capture.endedAt,
		performed: true,
		snapshotSeq: capture.begin.snapshotSeq,
		rows,
	});
	ctx.actions.push({ type: `capture-${label}`, at: now() });
}

// ---- socket-control request attribution -----------------------------------

/** One logged synchronous receive call on the component's socket handler. */
export interface ReceiveContextInput {
	receiveId: number;
	at: number;
	text: string;
}

/** One complete protocol line consumed by a receive call (analysis bookkeeping). */
export interface ReceiveMessage {
	type: string;
	raw: string;
	/** The line began in an earlier receive call (split across data events). */
	fragmented: boolean;
}

/**
 * Analysis-side bookkeeping over the logged raw receive texts: which complete
 * protocol lines each receive call consumed, mirroring the production
 * parserBuffer split (a line is consumed by the call whose LF completes it;
 * a partial line carries into the next call). Never touches production parsing.
 */
export function receiveContextMessages(contexts: readonly ReceiveContextInput[]): Map<number, ReceiveMessage[]> {
	const byId = new Map<number, ReceiveMessage[]>();
	let carry = "";
	for (const context of contexts) {
		const hadCarry = carry.length > 0;
		const combined = carry + context.text;
		const lines = combined.split("\n");
		carry = lines.pop() ?? "";
		const messages: ReceiveMessage[] = [];
		let first = true;
		for (const line of lines) {
			if (!line.trim()) {
				first = false;
				continue;
			}
			let type = "?";
			try {
				const msg = JSON.parse(line);
				if (typeof msg.type === "string") type = msg.type;
			} catch {
				/* malformed lines are ignored by production too */
			}
			messages.push({ type, raw: line, fragmented: first && hadCarry });
			first = false;
		}
		byId.set(context.receiveId, messages);
	}
	return byId;
}

const SOCKET_CONTROL_ENTRY_BY_TYPE: Record<string, string> = {
	hello: "hello",
	status: "status",
	exit: "exit-broadcast",
	error: "error-broadcast",
};

/**
 * Shared state between the receive-context logger and the requestRender
 * tracer: which receive call is executing synchronously RIGHT NOW.
 */
export interface ReceiveContextState {
	currentId: number | null;
}

/**
 * P15-CAUSAL-1: log-and-delegate wrapper around the component's REAL
 * onSocketData. Production connect() dispatches through `this.onSocketData`,
 * so wrapping the instance method observes every receive call with an explicit
 * context identity while preserving the original arguments/this/return/throw
 * and all scheduling behavior. The receive's exact raw text is logged per
 * call; message boundaries are computed analysis-side by
 * receiveContextMessages (which mirrors the production line split).
 */
export function installReceiveContextLogger(
	component: unknown,
	contexts: ReceiveContextInput[],
	state?: ReceiveContextState,
): ReceiveContextState {
	const target = component as { onSocketData?: (text: string) => unknown };
	if (!target || typeof target.onSocketData !== "function") {
		throw new Error("component has no onSocketData handler to observe");
	}
	const original = target.onSocketData;
	const shared = state ?? { currentId: null };
	let nextId = contexts.length;
	target.onSocketData = function (this: unknown, text: string) {
		const receiveId = ++nextId;
		contexts.push({ receiveId, at: now(), text });
		const previous = shared.currentId;
		shared.currentId = receiveId;
		try {
			return original.call(this, text);
		} finally {
			shared.currentId = previous;
		}
	};
	return shared;
}

/**
 * Attribute socket-control render requests to the control messages that caused
 * them, by SYNCHRONOUS RECEIVE-CALL IDENTITY (P15-CAUSAL-1): every eligible
 * control consumed in that onSocketData call is a candidate; several eligible
 * controls (or several coalesced requests) stay "ambiguous" with the full
 * candidate set; a missing context or a receive without eligible controls is
 * "unknown". There is deliberately NO nearest-message time fallback.
 */
export function attributeSocketRequests<T extends { entry: string; at: number; receiveId?: number | null; candidates?: string[]; messageTypes?: string[] }>(
	requests: T[],
	evidence: { receiveContexts?: readonly ReceiveContextInput[]; rxMessages: RxMessage[] },
): T[] {
	const contexts = evidence.receiveContexts ?? [];
	const messagesById = receiveContextMessages(contexts);
	const contextsById = new Map(contexts.map((c) => [c.receiveId, c]));
	for (const request of requests) {
		if (request.entry !== "socket-control") continue;
		if (request.receiveId != null) {
			const context = contextsById.get(request.receiveId);
			const messages = context ? (messagesById.get(request.receiveId) ?? []) : [];
			const eligible = messages.filter((m) => SOCKET_CONTROL_ENTRY_BY_TYPE[m.type]);
			request.messageTypes = eligible.map((m) => m.type);
			if (!context) {
				request.entry = "unknown"; // logged receiveId without a context: harness gap
			} else if (eligible.length === 1) {
				request.entry = SOCKET_CONTROL_ENTRY_BY_TYPE[eligible[0].type];
			} else if (eligible.length > 1) {
				request.entry = "ambiguous";
				request.candidates = [...new Set(eligible.map((m) => SOCKET_CONTROL_ENTRY_BY_TYPE[m.type]))];
			} else {
				request.entry = "unknown"; // this receive consumed no render-eligible control
			}
			continue;
		}
		// No receive-call identity: unknown, never a nearest-message guess.
		request.entry = "unknown";
	}
	return requests;
}

// ---- trace analysis (continuation finding F3) ------------------------------

/**
 * Attribute every render submission to its competing request window. Message
 * identity for socket-control requests comes from the ACTUAL component-socket
 * receive log (the parsed message in the same synchronous data-event window),
 * never from a timing heuristic alone. A submission with several candidate
 * requests stays "ambiguous" — no sole cause is selected from the coalescing
 * disposition; one with zero candidates is "untraced".
 */
function analyzeTrace(side: Side, failures: PresentationFailure[], rxMessages: RxMessage[]) {
	attributeSocketRequests(side.requests, { receiveContexts: side.receiveContexts, rxMessages });
	const writes = side.observer.writes;
	const renderSubmissions = writes.filter((w) => w.data.startsWith(SYNC_OPEN)).map((w) => ({ writeIndex: w.index, at: w.receivedAt }));
	const submissionAttribution = new Map<number, { entry: string; candidates: string[]; scheduled: string[] }>();
	for (let i = 0; i < renderSubmissions.length; i++) {
		const sub = renderSubmissions[i];
		const prevAt = i > 0 ? renderSubmissions[i - 1].at : -1;
		const windowRequests = side.requests.filter((r) => r.at <= sub.at && r.at > prevAt);
		// Flatten a receive-ambiguous request's own candidates into the window's
		// candidate set: a coalesced status+error request must donate BOTH causes.
		const candidates = [...new Set(windowRequests.flatMap((r) => (r.entry === "ambiguous" && r.candidates ? r.candidates : [r.entry])))];
		const scheduled = [...new Set(windowRequests.filter((r) => r.scheduled).map((r) => r.entry))];
		const entry = candidates.length === 0 ? "untraced" : candidates.length === 1 ? candidates[0] : "ambiguous";
		submissionAttribution.set(sub.writeIndex, { entry, candidates, scheduled });
	}
	const badIndices = new Set(failures.map((f) => f.index));
	const observationAttribution = side.observer.observations.map((observation) => {
		const writeIndex = observation.closeWriteIndex;
		const attributed = submissionAttribution.get(writeIndex);
		return {
			index: observation.index,
			writeIndex,
			entry: attributed ? attributed.entry : "direct-terminal-write",
			candidates: attributed ? attributed.candidates : [],
			bad: badIndices.has(observation.index),
		};
	});
	return { renderSubmissions, submissionAttribution: Object.fromEntries(submissionAttribution), observationAttribution };
}

/** Content-identity failure categories drive the half-frame verdicts;
 *  inverse-cells/hardware-cursor findings are recorded separately (the known
 *  hydrate DECTCEM loss is a distinct recorded defect, not this hypothesis). */
const CONTENT_BAD_CATEGORIES = new Set(["mixed-frame-id", "frame-id", "row-mismatch", "blank-screen", "stale-screen", "unexpected-screen", "loading-artifact"]);

type TraceAnalysis = ReturnType<typeof analyzeTrace>;

/** Verdict for one render-entry hypothesis over the open-frame hold windows. */
function entryVerdict(
	entry: string,
	windows: Array<{ start: number; end: number }>,
	requests: RenderRequestRecord[],
	trace: TraceAnalysis,
	contentBadWrites: Set<number>,
): { verdict: string; requestsDuringHold: number; submissionsDuringHold: number; badSubmissions: number; note?: string } {
	const inWindow = (t: number) => windows.some((w) => t >= w.start && t <= w.end);
	const reqs = requests.filter((r) => r.entry === entry && inWindow(r.at));
	const subs = trace.renderSubmissions.filter((s) => {
		if (!inWindow(s.at)) return false;
		const attribution = trace.submissionAttribution[s.writeIndex];
		return attribution?.entry === entry || (attribution?.entry === "ambiguous" && attribution.candidates.includes(entry));
	});
	const soleBad = subs.filter((s) => trace.submissionAttribution[s.writeIndex]?.entry === entry && contentBadWrites.has(s.writeIndex));
	const ambiguousBad = subs.filter((s) => {
		const attribution = trace.submissionAttribution[s.writeIndex];
		return attribution?.entry === "ambiguous" && attribution.candidates.includes(entry) && contentBadWrites.has(s.writeIndex);
	});
	if (soleBad.length > 0) {
		return { verdict: "REPRODUCED", requestsDuringHold: reqs.length, submissionsDuringHold: subs.length, badSubmissions: soleBad.length };
	}
	if (ambiguousBad.length > 0) {
		return {
			verdict: "INCONCLUSIVE",
			requestsDuringHold: reqs.length,
			submissionsDuringHold: subs.length,
			badSubmissions: 0,
			note: "a bad submission's attribution is ambiguous and involves this entry — not causally proved either way",
		};
	}
	if (reqs.length === 0 && subs.length === 0) {
		return { verdict: "INCONCLUSIVE", requestsDuringHold: 0, submissionsDuringHold: 0, badSubmissions: 0, note: "entry never fired during an open hold" };
	}
	return { verdict: "NOT_REPRODUCED", requestsDuringHold: reqs.length, submissionsDuringHold: subs.length, badSubmissions: 0 };
}

// ---- close-ordering / stream identity per variant --------------------------

function expectedPhases(variant: string): string[] {
	if (variant === "same-write") return ["seed", "open", "close-open", "closed"];
	if (variant === "split") return ["seed", "open-fragment-1", "open", "close-fragment-1", "closed"];
	return ["seed", "open", "closed"];
}

/** Evidence that the component's socket actually received the CLOSE+OPEN
 *  bytes, with the ACTUAL delivery chunking. The socket carries JSON-encoded
 *  protocol lines, so the search runs over the DECODED output/snapshot
 *  payloads in receipt order and reports which receive chunk(s) delivered the
 *  marker. */
function componentRxEvidence(rxMessages: RxMessage[]) {
	const marker = "\x1b[?2026l\x1b[?2026h";
	let offset = 0;
	const spans: Array<{ start: number; end: number; messageIndex: number; chunkIndex: number; at: number }> = [];
	for (let messageIndex = 0; messageIndex < rxMessages.length; messageIndex++) {
		const m = rxMessages[messageIndex];
		if ((m.type !== "output" && m.type !== "snapshot_frame") || typeof m.msg.data !== "string") continue;
		spans.push({ start: offset, end: offset + m.msg.data.length, messageIndex, chunkIndex: m.chunkIndex, at: m.at });
		offset += m.msg.data.length;
	}
	const all = rxMessages.map((m) => (typeof m.msg.data === "string" ? m.msg.data : "")).join("");
	const index = all.indexOf(marker);
	if (index === -1) return { found: false as const };
	const startSpan = spans.find((s) => index >= s.start && index < s.end);
	const endSpan = spans.find((s) => index + marker.length - 1 >= s.start && index + marker.length - 1 < s.end);
	return {
		found: true as const,
		inOneMessage: startSpan?.messageIndex === endSpan?.messageIndex,
		inOneChunk: startSpan?.chunkIndex === endSpan?.chunkIndex,
		messageIndex: startSpan?.messageIndex,
		chunkIndex: startSpan?.chunkIndex,
		chunkAt: startSpan?.at,
	};
}

function closeOrderingFor(
	variant: "plain" | "same-write" | "split",
	writeEvents: Array<{ step: number; phase: string }>,
	slices: string[],
	commandOrder: string[],
	rxEvidence: unknown,
) {
	const stepCount = writeEvents.length - 1; // seed excluded
	const expectedOrder: string[] = ["stdout-write:0"];
	for (let step = 1; step <= stepCount; step++) expectedOrder.push(`command:${step}`, `stdout-write:${step}`);
	expectedOrder.push("command:", "exit:");
	const result: Record<string, unknown> = {
		ok: JSON.stringify(writeEvents.map((w) => w.phase)) === JSON.stringify(expectedPhases(variant)) && JSON.stringify(commandOrder) === JSON.stringify(expectedOrder),
		phases: writeEvents.map((w) => w.phase),
		commandOrder,
		expectedOrder,
		detail: "child phases and command/write ordering from the child event log",
	};
	if (variant === "same-write") {
		const closeOpenSlice = slices[2] ?? "";
		result.closeOpenAdjacency =
			closeOpenSlice.includes("\x1b[?2026l\x1b[?2026h") &&
			closeOpenSlice.indexOf("F1 LOWER reply history three") < closeOpenSlice.indexOf("\x1b[?2026l\x1b[?2026h") &&
			closeOpenSlice.indexOf("\x1b[?2026l\x1b[?2026h") < closeOpenSlice.indexOf("F2 HEADER controlled work area");
		result.componentRxChunkEvidence = rxEvidence;
		result.ok = result.ok && result.closeOpenAdjacency === true && (rxEvidence as { found?: boolean })?.found === true;
	}
	if (variant === "split") {
		result.fragmentIdentity =
			slices[1] === "\x1b[?202" && typeof slices[2] === "string" && slices[2].startsWith("6h") &&
			typeof slices[3] === "string" && slices[3].endsWith("\x1b[?202") && slices[4] === "6l";
		result.ok = result.ok && result.fragmentIdentity === true;
	}
	return result;
}

// ---- the shared trial seam --------------------------------------------------

type FlowStep =
	| { op: "waitReceivedOutput" }
	| { op: "waitCommit"; frameId: string }
	| { op: "step"; step: number }
	| { op: "hold"; ms: number; label: string; openFrame: boolean }
	| { op: "status" }
	| { op: "capture"; label: string }
	| { op: "attachSecondary" }
	| { op: "waitSecondaryTarget"; frameId: string };

/** One flow per (variant, entry); every open-frame hold is >40ms by design and
 *  measured on the parent-local monotonic clock. Ticker flows drive the REAL
 *  attaching lifecycle (no synthetic attaching/readiness assignment). */
const FLOWS: Record<string, FlowStep[]> = {
	"plain/ticker": [
		{ op: "waitReceivedOutput" },
		{ op: "step", step: 1 },
		{ op: "hold", ms: 400, label: "open-hold", openFrame: true },
		{ op: "step", step: 2 },
		{ op: "waitCommit", frameId: "F1" },
	],
	"plain/status": [
		{ op: "waitCommit", frameId: "F0" },
		{ op: "step", step: 1 },
		{ op: "hold", ms: 150, label: "open-hold-1", openFrame: true },
		{ op: "status" },
		{ op: "hold", ms: 150, label: "open-hold-2", openFrame: true },
		{ op: "step", step: 2 },
		{ op: "waitCommit", frameId: "F1" },
	],
	"plain/capture": [
		{ op: "waitCommit", frameId: "F0" },
		{ op: "step", step: 1 },
		{ op: "hold", ms: 120, label: "open-hold-1", openFrame: true },
		{ op: "capture", label: "mid-open" },
		{ op: "attachSecondary" },
		{ op: "hold", ms: 400, label: "open-hold-2", openFrame: true },
		{ op: "step", step: 2 },
		{ op: "waitCommit", frameId: "F1" },
		{ op: "waitSecondaryTarget", frameId: "F1" },
	],
	"same-write/ticker": [
		{ op: "waitReceivedOutput" },
		{ op: "step", step: 1 },
		{ op: "hold", ms: 150, label: "f1-open-hold", openFrame: true },
		{ op: "step", step: 2 },
		{ op: "hold", ms: 350, label: "closeopen-hold", openFrame: true },
		{ op: "step", step: 3 },
		{ op: "waitCommit", frameId: "F2" },
	],
	"same-write/status": [
		{ op: "waitCommit", frameId: "F0" },
		{ op: "step", step: 1 },
		{ op: "hold", ms: 120, label: "f1-open-hold", openFrame: true },
		{ op: "step", step: 2 },
		{ op: "hold", ms: 120, label: "closeopen-hold-1", openFrame: true },
		{ op: "status" },
		{ op: "hold", ms: 150, label: "closeopen-hold-2", openFrame: true },
		{ op: "step", step: 3 },
		{ op: "waitCommit", frameId: "F2" },
	],
	"same-write/capture": [
		{ op: "waitCommit", frameId: "F0" },
		{ op: "step", step: 1 },
		{ op: "hold", ms: 120, label: "f1-open-hold", openFrame: true },
		{ op: "step", step: 2 },
		{ op: "hold", ms: 120, label: "closeopen-hold-1", openFrame: true },
		{ op: "capture", label: "mid-open-closeopen" },
		{ op: "attachSecondary" },
		{ op: "hold", ms: 350, label: "closeopen-hold-2", openFrame: true },
		{ op: "step", step: 3 },
		{ op: "waitCommit", frameId: "F2" },
		{ op: "waitSecondaryTarget", frameId: "F2" },
	],
	"split/ticker": [
		{ op: "waitReceivedOutput" },
		{ op: "step", step: 1 },
		{ op: "hold", ms: 100, label: "open-frag-hold", openFrame: false },
		{ op: "step", step: 2 },
		{ op: "hold", ms: 350, label: "open-hold", openFrame: true },
		{ op: "step", step: 3 },
		{ op: "hold", ms: 200, label: "close-frag-hold", openFrame: true },
		{ op: "step", step: 4 },
		{ op: "waitCommit", frameId: "F1" },
	],
	"split/status": [
		{ op: "waitCommit", frameId: "F0" },
		{ op: "step", step: 1 },
		{ op: "hold", ms: 100, label: "open-frag-hold", openFrame: false },
		{ op: "step", step: 2 },
		{ op: "hold", ms: 150, label: "open-hold-1", openFrame: true },
		{ op: "status" },
		{ op: "hold", ms: 120, label: "open-hold-2", openFrame: true },
		{ op: "step", step: 3 },
		{ op: "hold", ms: 120, label: "close-frag-hold-1", openFrame: true },
		{ op: "status" },
		{ op: "hold", ms: 120, label: "close-frag-hold-2", openFrame: true },
		{ op: "step", step: 4 },
		{ op: "waitCommit", frameId: "F1" },
	],
	"split/capture": [
		{ op: "waitCommit", frameId: "F0" },
		{ op: "step", step: 1 },
		{ op: "hold", ms: 100, label: "open-frag-hold", openFrame: false },
		{ op: "step", step: 2 },
		{ op: "hold", ms: 150, label: "open-hold", openFrame: true },
		{ op: "capture", label: "mid-open" },
		{ op: "attachSecondary" },
		{ op: "hold", ms: 300, label: "open-hold-2", openFrame: true },
		{ op: "step", step: 3 },
		{ op: "hold", ms: 150, label: "close-frag-hold", openFrame: true },
		{ op: "capture", label: "grid-complete-unclosed" },
		{ op: "step", step: 4 },
		{ op: "waitCommit", frameId: "F1" },
		{ op: "waitSecondaryTarget", frameId: "F1" },
	],
};

const HYPOTHESES: Record<string, string[]> = {
	ticker: ["loading-ticker", "settle", "output-40ms"],
	status: ["status", "output-40ms"],
	capture: ["capture-readonly", "capture-hydrate", "output-40ms"],
};

function targetFrameId(variant: string): string {
	return variant === "same-write" ? "F2" : "F1";
}

/** Create and mount one real attach side (component + TuiAltScreen + observer). */
async function connectFrameReporter(socketPath: string, tokenPath: string): Promise<import("node:net").Socket> {
	const { createConnection } = await import("node:net");
	const socket = createConnection(socketPath);
	const messages: Array<Record<string, unknown>> = [];
	let buffer = "";
	socket.on("data", (chunk: Buffer | string) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try { messages.push(JSON.parse(line)); } catch { /* runner line */ }
		}
	});
	socket.on("error", () => {});
	await new Promise<void>((resolveConnect, rejectConnect) => {
		socket.once("connect", () => resolveConnect());
		socket.once("error", rejectConnect);
		setTimeout(() => rejectConnect(new Error("S15 frame reporter connect timeout")), 4000).unref?.();
	});
	socket.write(`${JSON.stringify({ type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 1 } })}\n`);
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		const enable = messages.find((message) => message.type === "frame_witness_enable");
		if (enable && typeof enable.token === "string") {
			writeFileSync(tokenPath, enable.token);
			return socket;
		}
		await sleep(15);
	}
	socket.destroy();
	throw new Error("S15 frame reporter enable timeout");
}

async function attachSide(
	label: string,
	opts: { socketPath: string; screenLogPath?: string; onDiagnostic: (event: unknown) => void; onDone: (result: unknown) => void; dims?: AttachSurfaceDims },
): Promise<Side> {
	const dims = opts.dims ?? WORK_AREA;
	const { PtyAttachComponent } = await loadRuntime();
	const observer = new AttachPresentationObserver({ cols: dims.cols, rows: dims.screenRows, now });
	const tui = new TuiAltScreen(asTerminal(observer), false, undefined, {});
	const requests: RenderRequestRecord[] = [];
	const tuiState = { started: false };
	const receiveContexts: ReceiveContextInput[] = [];
	const receiveState: ReceiveContextState = { currentId: null };
	wrapRequestRender(tui, requests, tuiState, () => receiveState.currentId);
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
	let side!: Side;
	const component = new PtyAttachComponent(tui as never, theme as never, {} as never, ((result: unknown) => {
		side.doneResult = result;
		opts.onDone(result);
	}) as never, {
		socketPath: opts.socketPath,
		screenLogPath: opts.screenLogPath,
		title: TITLE,
		onDiagnostic: (event: unknown) => {
			side.diagnostics.push(event);
			opts.onDiagnostic(event);
		},
	} as never);
	side = { label, dims, observer, tui, component, requests, tuiState, receiveContexts, receiveState, diagnostics: [], doneResult: null, createdAt: now() };
	// P15-CAUSAL-1: install AFTER construction (constructor connects; the
	// instrumented handler is dispatched dynamically on every receive).
	installReceiveContextLogger(component, receiveContexts, receiveState);
	tui.setLayoutRoot(component);
	tui.start();
	tuiState.started = true;
	return side;
}

function analyzeSide(side: Side, expectation: AttachPresentationExpectation, teardownContract: TeardownContract, rxMessages: RxMessage[]) {
	const analysisBoundary = side.observer.observations.length;
	const active = side.observer.observations.slice(0, analysisBoundary);
	const chromeViolations: Array<{ index: number; violations: string[] }> = [];
	const projected: PresentationObservation[] = [];
	for (const observation of active) {
		const violations = checkChromeRows(observation);
		if (violations.length > 0) chromeViolations.push({ index: observation.index, violations });
		const projectedObservation = projectObservationToWorkArea(observation);
		projected.push({
			...projectedObservation,
			grid: projectedObservation.grid.map((row) => ({ ...row, text: row.text.replace(/\s+$/u, "") })),
		});
	}
	const failures = validateActiveObservations(projected, expectation);
	const trace = analyzeTrace(side, failures, rxMessages);
	const attributedFailures = failures.map((failure) => {
		const attribution = trace.observationAttribution[failure.index];
		return { ...failure, attribution: attribution?.entry ?? "unknown", candidates: attribution?.candidates ?? [] };
	});
	const contentBad = attributedFailures.filter((f) => CONTENT_BAD_CATEGORIES.has(f.category));
	// Verdict causality counts COMMITS (closed frames) only: a sync-entry or
	// write-end window conservatively re-records the pre-write state, so a bad
	// window on the recovery frame's write must not convict that render entry.
	const contentBadFrameIndices = new Set(
		contentBad.filter((f) => projected[f.index].kind === "frame").map((f) => f.index),
	);
	const firstBad =
		attributedFailures.length === 0
			? null
			: {
					observationIndex: attributedFailures[0].index,
					category: attributedFailures[0].category,
					attribution: attributedFailures[0].attribution,
					candidates: attributedFailures[0].candidates,
				};
	const contentBadWrites = new Set(contentBad.filter((f) => contentBadFrameIndices.has(f.index)).map((f) => projected[f.index].closeWriteIndex));
	return { analysisBoundary, chromeViolations, projected, failures: attributedFailures, trace, firstBad, contentBadWrites };
}

/**
 * The ONE shared trial seam for every (variant, entry) cell. Independent temp
 * root, owned REAL runner + accepted controlled child, F0 seed proof through a
 * real subscribe/capture, primary real attach, the variant/entry flow, ordered
 * exit, analysis against the predeclared active expectation and teardown
 * contract, exclusive artifact dir, and owned cleanup on success AND failure.
 * Trial-level failures are preserved and returned as records with
 * INFRASTRUCTURE_FAILURE verdicts — never thrown away, never faked.
 */
export async function runTrial(options: {
	variant: "plain" | "same-write" | "split";
	entry: "ticker" | "status" | "capture";
	artifactDir: string;
}): Promise<Record<string, unknown>> {
	const { variant, entry, artifactDir } = options;
	// Continuation finding F4: exclusive per-attempt path, refuse overwrite.
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists (overwrite refused): ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const artifactErrors: string[] = [];
	const writeArtifact = (name: string, value: unknown) => {
		try {
			writeFileSync(join(artifactDir, name), JSON.stringify(value, null, 2));
		} catch (err) {
			artifactErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const copyArtifact = (name: string, source: string) => {
		try {
			copyFileSync(source, join(artifactDir, name));
		} catch (err) {
			artifactErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const expectation = buildExpectation(variant);
	const targetId = targetFrameId(variant);
	const teardownContract = buildTeardownContract(targetId);
	const declared = {
		variant,
		entry,
		screens: expectation.screens.map((s) => s.name),
		preconditions: [
			"runner model holds the complete literal F0 seed (proven via a real subscribe/capture on a second client before any step command)",
			entry === "ticker"
				? "the real attaching lifecycle is still active when step 1 is commanded (receivedOutput observed; settle pending) — if settle wins the race the ticker verdict is honestly INCONCLUSIVE"
				: "an outer F0 commit is observed on the primary terminal before step 1 (post-settle live-entry trial)",
			"every open-frame hold exceeds 40ms on the parent-local monotonic clock",
			...(entry === "capture" ? ["the mid-open capture is read-only on the primary terminal; the fresh-attach hydrate subcase separates capture data origin from the later render trigger"] : []),
		],
		requiredScreens: entry === "ticker" ? [`${targetId.toLowerCase()}-complete`] : ["f0-complete", `${targetId.toLowerCase()}-complete`],
		teardownContract,
	};
	writeArtifact("expectation.json", { declared, expectation });

	const root = mkdtempSync(join(tmpdir(), `s15-${variant}-${entry}-`));
	const viewId = `s15-${variant}-${entry}`;
	const eventsPath = join(root, "child-events.jsonl");
	const frameTokenPath = join(root, "frame-token.txt");
	const actions: TrialContext["actions"] = [];
	const holds: HoldRecord[] = [];
	const captures: CaptureRecord[] = [];
	const rxLog: TrialContext["rxLog"] = [];
	const runnerStderr: string[] = [];
	// Step 17 fix1 (review disposition I-2): the S seam reuses the corrected
	// shared cleanup record/helper (UNKNOWN missing-pid semantics, known-pid
	// records, exit status/signal, forced-kill and root-disposition evidence).
	// childExitCode remains as the S-specific field (never set by the current
	// flow; preserved shape).
	const cleanup = { ...createDiagCleanup(), childExitCode: null as number | null };
	let runner: ChildProcess | null = null;
	let probe: ProbeClient | null = null;
	let frameReporter: import("node:net").Socket | null = null;
	let primary: Side | null = null;
	let secondary: Side | null = null;
	let detachRxLogger: (() => void) | null = null;
	let trialError: string | null = null;
	let teardownViolationsPrimary: unknown[] = [];
	let teardownViolationsSecondary: unknown[] = [];
	let analysisPrimary: ReturnType<typeof analyzeSide> | null = null;
	let analysisSecondary: ReturnType<typeof analyzeSide> | null = null;
	let verdicts: Record<string, unknown> = {};
	let f0SeedProof: Record<string, unknown> = { ok: false, method: "runner-capture-replay", detail: "not reached" };
	let finalTarget: Record<string, unknown> = { frameId: targetId, committed: false };
	let closeOrdering: Record<string, unknown> = { ok: false, detail: "not reached" };
	let streamAuditOk = false;
	let noControlEcho = false;
	let doneResult: unknown = null;
	let attachingWindowMs: number | null = null;
	let observation: Awaited<ReturnType<typeof holdFormalObservation>> = null;
	const measurementPath = formalMeasurementVersion() === "baseline" ? "legacy-no-reporter" : "modern-reporter-viewproof";
	const baselineControlledChild = resolve(REPO_ROOT, "test-support/formal-measurement/fake-pty-controlled-pi.mjs");

	// Step 17 fix1 (I-2): delegate to the corrected shared helper — no local
	// copy of the old missing-pid-to-false defect remains in the S seam.
	const killOwned = async () => {
		await killOwnedDiagProcesses(runner, root, viewId, cleanup);
	};

	try {
		// --- owned runner + controlled child -------------------------------
		const meta = createView(root, { id: viewId, name: `s15 ${variant}/${entry}`, cwd: root });
		const configPath = P.hostConfigPath(root, viewId);
		atomicWriteJson(configPath, {
			root,
			viewId,
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [measurementPath === "modern-reporter-viewproof" ? resolve(REPO_ROOT, "test-support/fake-pty-frame-wrapper.mjs") : baselineControlledChild],
			model: null,
			tools: null,
			env: {
				AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1",
				FAKE_PTY_STREAM_MODE: "controlled-frames",
				FAKE_PTY_CONTROLLED_SCRIPT: variant,
				FAKE_PTY_EVENTS_PATH: eventsPath,
				...(measurementPath === "modern-reporter-viewproof" ? {
					FAKE_PTY_FRAME_CHILD_PATH: resolve(REPO_ROOT, "test-support/fake-pty-pi.mjs"),
					FAKE_PTY_FRAME_TOKEN: frameTokenPath,
				} : {}),
			},
			cols: WORK_AREA.cols,
			rows: WORK_AREA.rows,
		});
		runner = spawn(process.execPath, [resolve(REPO_ROOT, "runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		runner.stderr?.setEncoding("utf8");
		runner.stderr?.on("data", (chunk) => runnerStderr.push(String(chunk)));
		runner.stdout?.resume();
		runner.on("error", (err) => runnerStderr.push(`spawn-error: ${err.message}`)); // F5: spawn errors observed
		await waitFor(() => {
			const host = readHost(root, viewId);
			return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid;
		}, 10_000, "runner host alive with child");
		const socketPath = readHost(root, viewId)!.socketPath!;
		if (measurementPath === "modern-reporter-viewproof") frameReporter = await connectFrameReporter(socketPath, frameTokenPath);

		// --- F0 seed proof: real subscribe/capture on a second client ------
		probe = await connectProbe(socketPath);
		let f0Rows: string[] | null = null;
		let f0RawRows: string[] | null = null;
		let f0Seq: unknown = null;
		const seedDeadline = now() + 8000;
		while (now() < seedDeadline) {
			const capture = await probe.capture();
			if (capture.frame !== null) {
				f0RawRows = await paintCaptureFrame(capture.frame);
				f0Rows = rtrimRows(f0RawRows);
				f0Seq = capture.begin.snapshotSeq;
				break;
			}
			await sleep(200); // empty baseline: child seed has not arrived yet
		}
		f0SeedProof = {
			ok: f0Rows !== null && rowsEqual(f0Rows, producerRowsText("F0")),
			method: "runner-capture-replay",
			rawRows: f0RawRows,
			rows: f0Rows,
			snapshotSeq: f0Seq,
			detail:
				f0Rows === null
					? "runner never served a non-empty snapshot"
					: rowsEqual(f0Rows, producerRowsText("F0"))
						? "captured frame paints the literal F0 screen (right-trimmed per the producer contract)"
						: "captured frame rows differ from the literal F0 screen",
		};

		// --- primary attach (real component + TuiAltScreen + observer) -----
		primary = await attachSide("primary", {
			socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			onDiagnostic: (event) => primary?.diagnostics.push(event),
			onDone: (result) => {
				doneResult = result;
			},
		});
		detachRxLogger = attachSocketRxLogger(primary.component, rxLog);
		const ctx: TrialContext = {
			variant,
			entry,
			root,
			viewId,
			runner,
			runnerStderr,
			probe,
			primary,
			secondary,
			actions,
			holds,
			captures,
			rxLog,
		};

		// --- the declared flow ---------------------------------------------
		for (const flowStep of FLOWS[`${variant}/${entry}`]) {
			switch (flowStep.op) {
				case "waitReceivedOutput":
					await waitReceivedOutput(ctx, primary);
					break;
				case "waitCommit":
					await waitCommit(ctx, primary, flowStep.frameId);
					break;
				case "step":
					sendChildCommand(ctx, primary, { cmd: "step", step: flowStep.step });
					break;
				case "hold":
					await hold(ctx, flowStep.label, flowStep.ms, flowStep.openFrame);
					break;
				case "status":
					sendStatusRequest(ctx);
					break;
				case "capture":
					await captureNow(ctx, flowStep.label);
					break;
				case "attachSecondary":
					// The fresh-attach hydrate subcase: no screenLogPath, so the ONLY
					// content origin is the mid-open protocol capture (data origin
					// separated from the later render trigger).
					secondary = await attachSide("secondary", {
						socketPath,
						onDiagnostic: (event) => secondary?.diagnostics.push(event),
						onDone: () => {},
					});
					ctx.secondary = secondary;
					actions.push({ type: "attach-secondary", at: now() });
					break;
				case "waitSecondaryTarget":
					if (!secondary) throw new Error("secondary attach missing");
					await waitCommit(ctx, secondary, flowStep.frameId);
					break;
			}
		}

		// --- real post-content observation window (formal measurement only) ----
		observation = await holdFormalObservation(now, sleep, `S-${variant}-${entry}`);

		// --- ordered exit through the real input path ----------------------
		sendChildCommand(ctx, primary, { cmd: "exit" });
		await waitFor(() => readHost(root, viewId)?.state === "exited", 5000, "host state exited");
		cleanup.childExited = true;
		await Promise.race([new Promise((r) => runner!.once("exit", r)), sleep(5000)]);
		cleanup.runnerExited = runner.exitCode !== null || runner.signalCode !== null;
		cleanup.runnerExitCode = runner.exitCode;

		// --- analysis (active window; teardown validated separately) -------
		const settleRequest = primary.requests.find((r) => r.entry === "settle");
		attachingWindowMs = settleRequest ? settleRequest.at - primary.createdAt : null;
		const rxMessages = parseRxMessages(rxLog);
		analysisPrimary = analyzeSide(primary, expectation, teardownContract, rxMessages);
		if (secondary) analysisSecondary = analyzeSide(secondary, expectation, teardownContract, []);

		const windows = holds.filter((h) => h.openFrame).map((h) => ({ start: h.startAt, end: h.endAt }));
		const hypotheses = HYPOTHESES[entry];
		for (const hypothesis of hypotheses) {
			if (hypothesis === "capture-readonly") {
				const unexplained = analysisPrimary.trace.renderSubmissions.filter((s) => {
					const inCapture = captures.some((c) => s.at >= c.startedAt && s.at <= c.endedAt);
					return inCapture && analysisPrimary!.trace.submissionAttribution[s.writeIndex]?.entry === "untraced";
				});
				verdicts[hypothesis] =
					captures.length === 0
						? { verdict: "INCONCLUSIVE", note: "no capture was performed" }
						: unexplained.length > 0
							? { verdict: "REPRODUCED", note: `${unexplained.length} untraced submission(s) during the capture window`, badSubmissions: unexplained.length }
							: { verdict: "NOT_REPRODUCED", note: "the read-only capture never submitted terminal bytes; every in-window submission traces to a logged render request", badSubmissions: 0 };
				continue;
			}
			if (hypothesis === "capture-hydrate") {
				if (!secondary || !analysisSecondary) {
					verdicts[hypothesis] = { verdict: "INCONCLUSIVE", note: "fresh-attach subcase never ran" };
					continue;
				}
				const secondaryContentBad = analysisSecondary.failures.filter(
					(f) => CONTENT_BAD_CATEGORIES.has(f.category) && analysisSecondary!.projected[f.index].kind === "frame",
				);
				const secondaryCommittedContent = analysisSecondary.projected.some((o) => o.kind === "frame" && !o.grid.every((r) => r.text === ""));
				verdicts[hypothesis] =
					secondaryContentBad.length > 0
						? { verdict: "REPRODUCED", note: `fresh attach committed ${secondaryContentBad.length} non-contract state(s) hydrated from the mid-open capture`, firstBadIndex: secondaryContentBad[0].index }
						: secondaryCommittedContent
							? { verdict: "NOT_REPRODUCED", note: "fresh attach committed only contract states" }
							: { verdict: "INCONCLUSIVE", note: "fresh attach never committed a content frame" };
				continue;
			}
			verdicts[hypothesis] = entryVerdict(hypothesis, windows, primary.requests, analysisPrimary.trace, analysisPrimary.contentBadWrites);
		}

		// Required final target on the primary terminal.
		const targetObservation = analysisPrimary.projected.find((o) => o.kind === "frame" && rowsEqual(o.grid.map((r) => r.text), producerRowsText(targetId)));
		finalTarget = {
			frameId: targetId,
			committed: !!targetObservation,
			rows: targetObservation ? targetObservation.grid.map((r) => r.text) : null,
			// The ACTUAL outer hardware cursor at the commit boundary, recorded as
			// data; the child's logical cursor is the producer contract, separate.
			outerCursor: targetObservation ? { ...targetObservation.cursor } : null,
			childLogicalCursor: PRODUCER_CURSOR,
		};

		// Stream identity audit: the runner's screen.log is the exact received
		// byte stream; slice it at the child-logged write boundaries.
		const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
		// The opt-in frame wrapper adds S/F DCS markers to the child stream. The
		// runner strips them before the canonical screen.log; strip any residual
		// marker bytes here too so the stream audit remains the child-payload audit.
		const screenLogWithoutMarkers = screenLog.replace(/\x1bP> agent-board-frame\/1 ; [^\x1b]*\x1b\\/g, "");
		const childEvents = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const writeEvents = childEvents.filter((e) => e.event === "stdout-write");
		const streamBuffer = Buffer.from(screenLogWithoutMarkers, "utf8");
		let streamOffset = 0;
		streamAuditOk = true;
		const slices: string[] = [];
		for (const write of writeEvents) {
			const slice = streamBuffer.subarray(streamOffset, streamOffset + write.bytes);
			if (createHash("sha256").update(slice).digest("hex") !== write.sha256) streamAuditOk = false;
			slices.push(slice.toString("utf8"));
			streamOffset += write.bytes;
		}
		if (streamOffset !== streamBuffer.length) streamAuditOk = false;
		const commandOrder = childEvents
			.filter((e) => ["command", "stdout-write", "exit"].includes(e.event))
			.map((e) => `${e.event}:${e.step ?? ""}`);
		closeOrdering = closeOrderingFor(variant, writeEvents, slices, commandOrder, componentRxEvidence(rxMessages));
		noControlEcho = !screenLog.includes(PRODUCER_RS) && !screenLog.includes('"cmd"');
	} catch (err) {
		trialError = err instanceof Error ? err.stack ?? err.message : String(err);
		// A trial-level failure is retained evidence: every exercised hypothesis
		// becomes INFRASTRUCTURE_FAILURE (or keeps its computed verdict), never a
		// discarded attempt.
		for (const hypothesis of HYPOTHESES[entry]) {
			verdicts[hypothesis] ??= { verdict: "INFRASTRUCTURE_FAILURE", note: trialError };
		}
	} finally {
		// Owned teardown on success AND failure; raw truth is written BEFORE the
		// temp root is removed, and copy/write failures keep the root as evidence.
		const teardownObservations: { primary: number; secondary: number } = { primary: 0, secondary: 0 };
		try {
			primary?.component.dispose();
		} catch {
			/* best-effort teardown */
		}
		try {
			secondary?.component.dispose();
		} catch {
			/* best-effort teardown */
		}
		try {
			primary?.tui.stop();
		} catch {
			/* best-effort teardown */
		}
		try {
			secondary?.tui.stop();
		} catch {
			/* best-effort teardown */
		}
		if (primary) {
			try {
				await Promise.race([primary.observer.whenIdle(), sleep(2000)]);
			} catch {
				/* best-effort drain */
			}
		}
		if (secondary) {
			try {
				await Promise.race([secondary.observer.whenIdle(), sleep(2000)]);
			} catch {
				/* best-effort drain */
			}
		}
		if (primary) {
			const all = primary.observer.observations;
			const boundary = analysisPrimary?.analysisBoundary ?? all.length;
			teardownObservations.primary = all.length - boundary;
			writeArtifact("observations.json", { analysisBoundary: boundary, observations: all });
			writeArtifact("writes.json", primary.observer.writes);
			writeArtifact("controls.json", primary.observer.controls);
			writeArtifact("requests.json", primary.requests);
			writeArtifact("receive-contexts.json", {
				contexts: primary.receiveContexts,
				messageBoundaries: Object.fromEntries(receiveContextMessages(primary.receiveContexts)),
			});
			// Teardown windows are CHECKED under their own predeclared contract
			// (continuation findings F1/F4): never excluded, never an active escape.
			teardownViolationsPrimary = validateTeardownObservations(
				all.slice(boundary).map((o) => ({
					...o,
					grid: o.grid.map((row) => ({ ...row, text: row.text.replace(/\s+$/u, "") })),
				})),
				teardownContract,
			);
			writeArtifact("teardown-validation.json", { boundary, observationCount: teardownObservations.primary, violations: teardownViolationsPrimary });
		}
		if (secondary) {
			const all = secondary.observer.observations;
			const boundary = analysisSecondary?.analysisBoundary ?? all.length;
			teardownObservations.secondary = all.length - boundary;
			writeArtifact("observations-secondary.json", { analysisBoundary: boundary, observations: all });
			writeArtifact("requests-secondary.json", secondary.requests);
			writeArtifact("receive-contexts-secondary.json", {
				contexts: secondary.receiveContexts,
				messageBoundaries: Object.fromEntries(receiveContextMessages(secondary.receiveContexts)),
			});
			const projectedTeardown = all.slice(boundary).map((o) => ({ ...o, grid: o.grid.map((row) => ({ ...row, text: row.text.replace(/\s+$/u, "") })) }));
			teardownViolationsSecondary = validateTeardownObservations(projectedTeardown, teardownContract);
			writeArtifact("teardown-validation-secondary.json", { boundary, observationCount: teardownObservations.secondary, violations: teardownViolationsSecondary });
		}
		writeArtifact("rx-socket.json", rxLog);
		writeArtifact("rx-messages.json", parseRxMessages(rxLog));
		if (probe) writeArtifact("probe-messages.json", probe.messages);
		copyArtifact("child-events.jsonl", eventsPath);
		copyArtifact("screen.log", P.screenLogPath(root, viewId));
		writeArtifact("analysis.json", {
			trialError,
			holds,
			actions,
			captures,
			attachingWindowMs,
			verdicts,
			f0SeedProof,
			finalTarget,
			closeOrdering,
			streamAudit: { ok: streamAuditOk },
			noControlEcho,
			primary: analysisPrimary
				? {
						chromeViolations: analysisPrimary.chromeViolations,
						oracleFailures: analysisPrimary.failures,
						firstBad: analysisPrimary.firstBad,
						trace: analysisPrimary.trace,
					}
				: null,
			secondary: analysisSecondary
				? {
						chromeViolations: analysisSecondary.chromeViolations,
						oracleFailures: analysisSecondary.failures,
						firstBad: analysisSecondary.firstBad,
					}
				: null,
			diagnostics: { primary: primary?.diagnostics ?? [], secondary: secondary?.diagnostics ?? [] },
			doneResult,
			runnerStderr,
		});
		detachRxLogger?.();
		try {
			primary?.observer.dispose();
		} catch {
			/* best-effort teardown */
		}
		try {
			secondary?.observer.dispose();
		} catch {
			/* best-effort teardown */
		}
		try {
			probe?.destroy();
			frameReporter?.destroy();
		} catch {
			/* best-effort teardown */
		}
		await killOwned();
		if (artifactErrors.length > 0) {
			// Never delete the only evidence after a copy/write failure (F4/F5).
			cleanup.rootRetainedForEvidence = true;
		} else {
			try {
				rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
				cleanup.rootRemoved = true;
			} catch {
				/* recorded below */
			}
		}
		cleanup.ok = diagCleanupOk(cleanup);
		writeArtifact("cleanup.json", cleanup);
	}
	const record = buildTrialRecord();
	writeArtifact("summary.json", record);
	return record;

	function buildTrialRecord(): Record<string, unknown> {
		return {
			ok: trialError === null,
			measurementPath,
			observationStartMs: observation?.observationStartMs ?? "UNKNOWN",
			observationEndMs: observation?.observationEndMs ?? "UNKNOWN",
			observationActualMs: observation?.observationActualMs ?? "UNKNOWN",
			observationCompletion: observation?.observationCompletion ?? "UNKNOWN",
			themeCompletion: "not-applicable",
			recoveryCompletion: "not-applicable",
			variant,
			entry,
			declared,
			f0SeedProof,
			finalTarget,
			closeOrdering,
			streamAudit: { ok: streamAuditOk },
			noControlEcho,
			holds,
			attachingWindowMs,
			chromeViolations: analysisPrimary?.chromeViolations ?? [],
			teardownViolations: teardownViolationsPrimary,
			oracleFailures: analysisPrimary?.failures ?? [],
			firstBad: analysisPrimary?.firstBad ?? null,
			verdicts,
			capture: entry === "capture" ? { performed: captures.length > 0, rows: captures[0]?.rows ?? null, captures } : undefined,
			captureHydrate: entry === "capture" ? { attempted: secondary !== null, verdict: (verdicts["capture-hydrate"] as { verdict?: string })?.verdict ?? null } : undefined,
			cleanup,
			artifactErrors,
			error: trialError,
			artifactDir,
		};
	}
}

// ---- battery driver ---------------------------------------------------------

function environmentInfo(scenarioHash: string) {
	return {
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		piTui: JSON.parse(readFileSync(join(REPO_ROOT, "node_modules/@earendil-works/pi-tui/package.json"), "utf8")).version,
		xtermHeadless: JSON.parse(readFileSync(join(REPO_ROOT, "node_modules/@xterm/headless/package.json"), "utf8")).version,
		head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
		scenarioHash,
		hashes: {
			fakePtyChild: sha256File(join(REPO_ROOT, "test-support/fake-pty-pi.mjs")),
			observerFixture: sha256File(join(REPO_ROOT, "test-support/attach-presentation-fixture.ts")),
		},
	};
}

function appendInvocation(artifactRoot: string, record: Record<string, unknown>): void {
	appendFileSync(join(artifactRoot, "invocations.jsonl"), JSON.stringify(record) + "\n");
}

/**
 * The approved case-S battery: all nine (variant x entry) trials through the
 * shared seam, one exclusive artifact root with an append-only invocation
 * index. Exit 0 means the battery RAN with complete evidence; reproduction
 * verdicts are data, never exit-code signals.
 */
export async function runCaseS(options: {
	artifactDir: string;
	variant?: "plain" | "same-write" | "split";
	entry?: "ticker" | "status" | "capture";
}): Promise<Record<string, unknown>> {
	const artifactRoot = options.artifactDir;
	const measurementPath = formalMeasurementVersion() === "baseline" ? "legacy-no-reporter" : "modern-reporter-viewproof";
	mkdirSync(artifactRoot, { recursive: true });
	const scenarioHash = sha256File(join(REPO_ROOT, "test-support/pty-attach-ready-scenario.ts"));
	const invocationId = `inv-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
	appendInvocation(artifactRoot, {
		kind: "begin",
		invocationId,
		at: new Date().toISOString(),
		caseId: "S",
		repeat: 1,
		clock: "real",
		pid: process.pid,
		scenarioHash,
		environment: environmentInfo(scenarioHash),
	});
	const trials: Array<Record<string, unknown>> = [];
	const selectedShapes = options.variant !== undefined && options.entry !== undefined
		? [{ variant: options.variant, entry: options.entry }]
		: (["plain", "same-write", "split"] as const).flatMap((variant) => (["ticker", "status", "capture"] as const).map((entry) => ({ variant, entry })));
	for (const { variant, entry } of selectedShapes) {
		{
			const trialDir = join(artifactRoot, `trial-${variant}-${entry}`);
			appendInvocation(artifactRoot, { kind: "trial-begin", invocationId, at: new Date().toISOString(), variant, entry, trialDir });
			let record: Record<string, unknown>;
			try {
				record = await runTrial({ variant, entry, artifactDir: trialDir });
			} catch (err) {
				// runTrial preserves its own failure artifacts; a throw here means the
				// attempt dir could not even be created — record it without losing it.
				record = {
					ok: false,
					variant,
					entry,
					artifactDir: trialDir,
					error: err instanceof Error ? err.stack ?? err.message : String(err),
					verdicts: Object.fromEntries(HYPOTHESES[entry].map((h) => [h, { verdict: "INFRASTRUCTURE_FAILURE", note: "trial threw before completing" }])),
				};
			}
			appendInvocation(artifactRoot, {
				kind: "trial-end",
				invocationId,
				at: new Date().toISOString(),
				variant,
				entry,
				ok: record.ok,
				verdicts: Object.fromEntries(Object.entries(record.verdicts as Record<string, { verdict: string }>).map(([h, v]) => [h, v.verdict])),
			});
			trials.push(record);
		}
	}
	const result: Record<string, unknown> = {
		ok: trials.every((t) => t.error === null || t.error === undefined),
		measurementPath,
		caseId: "S",
		repeat: 1,
		clock: "real",
		invocationId,
		environment: environmentInfo(scenarioHash),
		trials,
		artifactRoot,
	};
	appendInvocation(artifactRoot, { kind: "end", invocationId, at: new Date().toISOString(), ok: result.ok });
	// Per-invocation result file: nothing in the artifact root is overwritten.
	writeFileSync(join(artifactRoot, `result-${invocationId}.json`), JSON.stringify(result, null, 2));
	return result;
}

// ---------------------------------------------------------------------------
// Issue #222 step 16 (task-16-brief.md): A4 resize-geometry, A5
// cold/empty-baseline and T timely/late theme-reply diagnostics on the SAME
// real runner/component/TuiAltScreen/observer topology as case S. The
// accepted observer/oracle, the case-S seam and every S behavior above are
// untouched; this section only ADDS bounded cases consuming the step-16
// producer scripts "resize"/"cold"/"theme" of the controlled-frames child
// (an additive evolution: the plain/same-write/split bytes/commands/events
// are pinned unchanged by the retained producer tests).
//
// Producer contract (declared BEFORE consumption; the child-side literal
// builders live in test-support/fake-pty-pi.mjs and are mirrored here as
// INDEPENDENT literals — never derived from captured bytes):
// - "resize": work area = ACTUAL PTY dims (process.stdout.columns/rows).
//   G0 seed at the start size (basis "live-pty-start"), G1 composed at the
//   stale seed dims (basis "stale-seed": open step 1, close step 2 — an
//   old/in-flight frame closing AFTER the applied resize), G2 one complete
//   frame at the live post-resize dims (basis "live-pty", step 3). Every
//   frame write logs dimsUsed; every real SIGWINCH logs a pty-resize event
//   with the dims the OS actually reports. Content is dimension-sensitive:
//   header row padded with "." to cols-1 ending in "#" at the last column;
//   last row `${id} BOTTOM edge INPUT >` + "#" at the last column; hidden
//   cursor parked right after the INPUT prompt.
// - "cold": NO seed (empty authoritative baseline). Step 1 unframed boot
//   text, step 2 alternate-screen + bracketed-paste enable (no editor
//   content), step 3 opens a framed E1 editor upper half only, step 4
//   completes and closes E1 (literal 80x22 editor, cursor (10,21) hidden).
// - "theme": T0 seed at 80x22 WITH alternate screen and bracketed paste in
//   the same write; each real CSI ? 997 ; 1|2 n report on stdin logs a
//   theme-report event and triggers one complete synchronized repaint T<n>
//   whose row 18 is `${id} THEME <scheme> applied`.
//
// Four timing layers are recorded separately: child clock (monoNs/wallMs,
// no common origin with the parent), parent-monotonic socket tx/rx and
// receive-call identity, the component's REAL inner parser (log-and-delegate
// term.write + public CSI observers returning false) and the REAL TUI
// requestRender/Terminal.write/outer-observer commits. Child fixture
// markers/events are independent test truth, never production readiness.
// ---------------------------------------------------------------------------

/** A4 geometry contract: host spawns the child at 120x28; the attach surface
 *  body is 80x22 (observer terminal 80x24 with two chrome rows). */
export const S16_GEOMETRY = { hostCols: 120, hostRows: 28, bodyCols: 80, bodyRows: 22 } as const;

/** Literal geometry-frame rows (mirror of the producer contract). */
export function s16GeometryRowsText(id: string, cols: number, rows: number): string[] {
	const out = Array.from({ length: rows }, () => "");
	out[0] = `${id} HEADER geometry ${cols}x${rows}`.padEnd(cols - 1, ".") + "#";
	out[1] = `${id} UPPER reply history one`;
	out[2] = `${id} UPPER reply history two`;
	out[rows - 3] = `${id} TAIL assistant final answer`;
	out[rows - 1] = `${id} BOTTOM edge INPUT >`.padEnd(cols - 1, " ") + "#";
	return out;
}

/** Logical child cursor of a geometry frame (hidden, after the INPUT prompt). */
export function s16GeometryCursor(id: string, rows: number): { x: number; y: number; visible: boolean } {
	return { x: `${id} BOTTOM edge INPUT >`.length, y: rows - 1, visible: false };
}

/** Literal cold-editor rows (E1, 80x22; mirror of the producer contract). */
export function s16EditorRowsText(id: string): string[] {
	const rows = producerRowsText(id);
	rows[0] = `${id} HEADER controlled cold editor`;
	return rows;
}

/** Literal boot-text lines emitted by the cold script's step 1. */
export const S16_BOOT_LINES = ["fake pi boot: core ready", "fake pi boot: extensions loaded"] as const;

/** Poisoned historical screen.log content planted before an A5 attach. */
export const S16_POISON_TEXT = "OLD-LOG-POISON line one\r\nOLD-LOG-POISON line two\r\n";

/**
 * Step 17 fix1 (review M3): the plant-readback match rule, shared by the
 * plant-time action record and evaluatePoisonPlant. The plant write replaces
 * the file (writeFileSync), and the runner can only APPEND child output
 * afterwards (appendBoundedScreenLog; front-truncation only above the 100 KB
 * bound), so a readback carrying the plant as a PREFIX proves the plant
 * landed even when later output was already appended. Exact equality would
 * falsely report NOT_PROVEN on that append race. A readback missing the
 * prefix (garbage, replaced, or front-truncated) is NOT a matched plant.
 * null readback = missing evidence (UNKNOWN), never a match.
 */
export function poisonPlantPrefixMatch(plantedText: string, plantReadback: string | null): boolean | null {
	if (plantReadback === null) return null;
	return plantReadback.startsWith(plantedText);
}

/**
 * Step 17 foundation: non-vacuity evidence for a planted poisoned screen.log.
 * A "poison never visible on the outer terminal" scan is meaningful ONLY when
 * the poison is proven to have been in the log the attach warm replay read.
 * The runner persists child output with appendBoundedScreenLog, which is
 * append + front-truncate (reconcile keeps the TAIL): content dropped from
 * the front can never come back, so planted text still present in the
 * RETAINED log at teardown was present continuously since planting — in
 * particular at attach-mount time. Verdicts: PROVEN (the plant readback
 * matched under the prefix rule AND the planted text survives in the
 * retained log), NOT_PROVEN (the plant readback did not carry the plant as a
 * prefix — the plant failed or was truncated/replaced, and any never-visible
 * scan is vacuous), UNKNOWN (the readback was not taken, the retained log is
 * missing, or the bounded window moved past the planted text; mount-time
 * presence can then neither be proven nor disproven).
 */
export function evaluatePoisonPlant(input: { plantedText: string; plantReadback: string | null; retainedLog: string | null }): {
	plantReadbackMatched: boolean | null;
	presentInRetainedLog: boolean | null;
	retainedLogBytes: number | null;
	retainedLogSha256: string | null;
	verdict: "PROVEN" | "NOT_PROVEN" | "UNKNOWN";
	note: string;
} {
	const plantReadbackMatched = poisonPlantPrefixMatch(input.plantedText, input.plantReadback);
	const presentInRetainedLog = input.retainedLog === null ? null : input.retainedLog.includes(input.plantedText);
	const verdict =
		plantReadbackMatched === false ? "NOT_PROVEN" : plantReadbackMatched === true && presentInRetainedLog === true ? "PROVEN" : "UNKNOWN";
	return {
		plantReadbackMatched,
		presentInRetainedLog,
		retainedLogBytes: input.retainedLog === null ? null : Buffer.byteLength(input.retainedLog, "utf8"),
		retainedLogSha256: input.retainedLog === null ? null : createHash("sha256").update(input.retainedLog, "utf8").digest("hex"),
		verdict,
		note:
			verdict === "PROVEN"
				? "the plant readback carried the plant as a prefix (append-race tolerant) and the planted text survives in the retained log; append+front-truncate semantics make presence continuous since planting, so the attach warm replay read the poison — a never-visible scan is non-vacuous"
				: verdict === "NOT_PROVEN"
					? "the plant readback did not carry the plant as a prefix (plant failed, replaced or front-truncated); any never-visible scan is vacuous"
					: "plant/readback/retention evidence is incomplete; mount-time presence cannot be proven from the retained evidence",
	};
}

/** Literal theme-surface rows (T<n>; mirror of the producer contract). */
export function s16ThemeRowsText(id: string, label: string): string[] {
	const rows = producerRowsText(id);
	rows[0] = `${id} HEADER theme surface`;
	rows[18] = `${id} THEME ${label}`;
	return rows;
}

/** Work-area cursor shared by the cold editor and theme surfaces. */
export const S16_SURFACE_CURSOR = { x: 10, y: 21, visible: false } as const;

// ---- step-17 fix1: session-generation fixture contract (ruling I-1) -------

/**
 * Literal work-area rows of the dedicated session-generation fixture child
 * (test-support/fake-pty-generation-pi.mjs). Independently declared here for
 * the trial expectations — the fixture owns its own copy and the producer
 * tests a third. Every content row carries BOTH the session-generation token
 * and the frame id in the declared HISTORY/TAIL/INPUT marker rows; the token
 * is VISIBLE content, so old-generation content is detectable from the grid
 * alone and can never masquerade as the current generation.
 */
export function s17GenerationRowsText(generation: string, id: string): string[] {
	return [
		`${generation} ${id} HEADER controlled generation surface`,
		`${generation} ${id} UPPER reply history one`,
		`${generation} ${id} UPPER reply history two`,
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		`${generation} ${id} MIDDLE divider`,
		`${generation} ${id} LOWER reply history three`,
		`${generation} ${id} LOWER reply history four`,
		"",
		"",
		"",
		"",
		"",
		"",
		`${generation} ${id} TAIL assistant final answer`,
		"",
		`${generation} ${id} INPUT >`,
	];
}

/** Explicit cursor contract of the generation fixture: hidden, parked on the
 *  cell right after the `<generation> <id> INPUT >` prompt (0-based). */
export function s17GenerationCursor(generation: string, id: string): { x: number; y: number; visible: boolean } {
	return { x: `${generation} ${id} INPUT >`.length, y: 21, visible: false };
}

/** Poison text for one generation trial: the OTHER generation's complete
 *  literal F1 content as plain lines — a plausible stale-generation log. */
export function s17GenerationPoisonText(poisonGeneration: string): string {
	return (
		s17GenerationRowsText(poisonGeneration, "F1")
			.filter((row) => row !== "")
			.join("\r\n") + "\r\n"
	);
}

// ---- step-16 instrumentation (new-case seams; S instrumentation untouched) --

/** One logged outgoing write on the component's live socket. */
interface TxRecord {
	at: number;
	data: string;
}

/**
 * Log-and-delegate wrapper around the live socket's public write(): every
 * outgoing protocol byte string is logged with a parent-monotonic receipt
 * time and the ORIGINAL arguments/this/return/throw pass through unchanged
 * (the write callback is never wrapped or rescheduled). A poller re-wraps if
 * the component reconnects onto a new socket. Returns a detach function.
 */
export function attachSocketTxLogger(component: PtyAttachComponentType, txLog: TxRecord[]): () => void {
	let current: Socket | null = null;
	let original: Socket["write"] | null = null;
	const install = () => {
		const socket = (component as unknown as { socket: Socket | null }).socket;
		if (socket && socket !== current) {
			// Restore the socket we are leaving before wrapping the new one.
			if (current && original) {
				(current as unknown as { write: unknown }).write = original;
			}
			current = socket;
			original = socket.write;
			const wrapped = original;
			(socket as unknown as { write: unknown }).write = function (this: Socket, ...args: unknown[]) {
				txLog.push({ at: now(), data: String(args[0]) });
				return (wrapped as (...a: unknown[]) => unknown).apply(this, args);
			};
		}
	};
	// P16-DRAFT-TRACE: install on the ALREADY-connected socket immediately —
	// the attach's first resize command can be sent before any 5ms poll would
	// fire. The interval remains only for reconnects onto a new socket.
	install();
	const timer = setInterval(install, 5);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		if (current && original) {
			(current as unknown as { write: unknown }).write = original;
			current = null;
			original = null;
		}
	};
}

/** One observed event on the component's REAL inner xterm parser. */
export interface InnerParserEvent {
	kind: "parser-attach" | "parser-detach" | "enqueue" | "drain" | "csi-open" | "csi-close";
	at: number;
	bytes?: number;
	sha256?: string;
	/** Identity captured for this parser/connection at instrumentation time. */
	connectionToken?: number | null;
	baselineToken?: number | null;
	parserEpoch?: number | null;
	/** True when a callback/CSI hook ran after the component moved to a newer parser. */
	stale?: boolean;
	/** csi-open: a block was already open (repeated mode set, not a new frame). */
	alreadyOpen?: boolean;
	/** csi-close: a block was open when the close parsed (matched close). */
	matched?: boolean;
}

/**
 * Observe the component's REAL inner parser: a log-and-delegate wrapper on
 * term.write (the original callback runs after the drain record, scheduling
 * preserved) plus PUBLIC parser CSI hooks for ?2026 h/l that return false so
 * xterm's default handling continues unchanged. Returns a restore/dispose
 * function. Never an oracle truth source — flow/timing evidence only.
 */
export function instrumentInnerParser(component: PtyAttachComponentType, log: InnerParserEvent[]): () => void {
	const componentState = component as unknown as {
		term: InstanceType<typeof HeadlessTerminal>;
		connectionToken?: number;
		baselineToken?: number;
		parserEpoch?: number;
	};
	/** @type {InstanceType<typeof HeadlessTerminal> | null} */
	let currentTerm: InstanceType<typeof HeadlessTerminal> | null = null;
	let originalWrite: ((data: string, callback?: () => void) => void) | null = null;
	let disposables: Array<{ dispose(): void }> = [];
	let syncOpen = false;
	let identity = { connectionToken: null as number | null, baselineToken: null as number | null, parserEpoch: null as number | null };

	const detachCurrent = (reason: string) => {
		if (currentTerm === null) return;
		log.push({ kind: "parser-detach", at: now(), ...identity, stale: componentState.term !== currentTerm, bytes: 0, sha256: "" });
		if (originalWrite !== null) (currentTerm as unknown as { write: unknown }).write = originalWrite;
		for (const disposable of disposables) disposable.dispose();
		disposables = [];
		originalWrite = null;
		currentTerm = null;
		void reason;
	};

	const attach = (term: InstanceType<typeof HeadlessTerminal>) => {
		detachCurrent("replacement");
		currentTerm = term;
		syncOpen = false;
		identity = {
			connectionToken: typeof componentState.connectionToken === "number" ? componentState.connectionToken : null,
			baselineToken: typeof componentState.baselineToken === "number" ? componentState.baselineToken : null,
			parserEpoch: typeof componentState.parserEpoch === "number" ? componentState.parserEpoch : null,
		};
		log.push({ kind: "parser-attach", at: now(), ...identity, bytes: 0, sha256: "" });
		const original = term.write.bind(term);
		originalWrite = original;
		(term as unknown as { write: unknown }).write = (data: string, callback?: () => void) => {
			const sha256 = createHash("sha256").update(data, "utf8").digest("hex");
			log.push({ kind: "enqueue", at: now(), bytes: Buffer.byteLength(data, "utf8"), sha256, ...identity, stale: componentState.term !== term });
			return original(data, () => {
				log.push({ kind: "drain", at: now(), sha256, ...identity, stale: componentState.term !== term });
				callback?.();
			});
		};
		const has2026 = (params: readonly (number | number[])[]) => params.some((p) => p === 2026 || (Array.isArray(p) && p.includes(2026)));
		disposables = [
			term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params: (number | number[])[]) => {
				if (componentState.term !== term) {
					log.push({ kind: "csi-open", at: now(), ...identity, stale: true });
					return false;
				}
				if (has2026(params)) {
					log.push({ kind: "csi-open", at: now(), alreadyOpen: syncOpen, ...identity, stale: false });
					syncOpen = true;
				}
				return false;
			}),
			term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params: (number | number[])[]) => {
				if (componentState.term !== term) {
					log.push({ kind: "csi-close", at: now(), ...identity, stale: true });
					return false;
				}
				if (has2026(params)) {
					log.push({ kind: "csi-close", at: now(), matched: syncOpen, ...identity, stale: false });
					syncOpen = false;
				}
				return false;
			}),
		];
	};

	const install = () => {
		const term = componentState.term;
		if (term && term !== currentTerm) attach(term);
	};
	const replaceTarget = componentState as unknown as { replaceParser?: () => boolean };
	const originalReplace = replaceTarget.replaceParser;
	if (typeof originalReplace === "function") {
		replaceTarget.replaceParser = function (this: unknown) {
			const replaced = originalReplace.call(this);
			if (replaced) install();
			return replaced;
		};
	}
	install();
	const timer = setInterval(install, 5);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		if (typeof originalReplace === "function") replaceTarget.replaceParser = originalReplace;
		detachCurrent("detach");
	};
}

// ---- step-16 shared bounded-trial scaffold (fixed topology, new cases only) --

/**
 * Immediate-install rx observer for the diag shell (P16 prerequisite): the
 * additional data listener is attached to the ALREADY-present socket
 * synchronously — the initial hello/snapshot bytes must not be lost to a
 * poll interval (the 5ms-only attachSocketRxLogger above stays the accepted
 * S-seam behavior and is untouched). Extra listeners never modify the
 * component's own handler; reconnects onto a new socket are re-attached by
 * the poller; detach removes the listener. The accepted synchronous
 * receive-context logger remains the independent exact-text record.
 */
function attachSocketRxLoggerImmediate(component: PtyAttachComponentType, rxLog: Array<{ at: number; data: string }>): () => void {
	let current: Socket | null = null;
	const onData = (chunk: Buffer | string) => {
		rxLog.push({ at: now(), data: chunk.toString("utf8") });
	};
	const install = () => {
		const socket = (component as unknown as { socket: Socket | null }).socket;
		if (socket && socket !== current) {
			if (current) current.off("data", onData);
			current = socket;
			socket.on("data", onData);
		}
	};
	install();
	const timer = setInterval(install, 5);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		if (current) current.off("data", onData);
	};
}

export interface DiagCleanup {
	childExited: boolean;
	runnerExited: boolean;
	runnerExitCode: number | null;
	/** Step 17: the runner's exit signal when one terminated it (else null). */
	runnerExitSignal: string | null;
	forcedKills: string[];
	/** Step 17: the child pid read from the owned host record, null = UNKNOWN. */
	childPid: number | null;
	/** Step 17: the owned runner handle's pid, null = UNKNOWN (no handle / spawn failure). */
	runnerPid: number | null;
	childAliveAfter: boolean | null;
	runnerAliveAfter: boolean | null;
	rootRemoved: boolean;
	rootRetainedForEvidence: boolean;
	ok: boolean;
}

/** Fresh cleanup record for one diag trial (step 17 export: the focused
 *  cleanup tests build their own records through the same shape). */
export function createDiagCleanup(): DiagCleanup {
	return {
		childExited: false,
		runnerExited: false,
		runnerExitCode: null,
		runnerExitSignal: null,
		forcedKills: [],
		childPid: null,
		runnerPid: null,
		childAliveAfter: null,
		runnerAliveAfter: null,
		rootRemoved: false,
		rootRetainedForEvidence: false,
		ok: false,
	};
}

/** Injected liveness/process seams for killOwnedDiagProcesses tests. Every
 *  seam defaults to the real owned-process behavior; the seams exist so the
 *  focused tests never signal (or even probe) a real pid. */
export interface DiagKillSeams {
	isAlive: (pid: number) => boolean;
	kill: (pid: number, signal: "SIGKILL") => void;
	readChildPid: (root: string, viewId: string) => number | null;
	sleep: (ms: number) => Promise<void>;
}

const defaultDiagKillSeams: DiagKillSeams = {
	isAlive,
	kill: (pid, signal) => process.kill(pid, signal),
	readChildPid: (root, viewId) => {
		try {
			return readHost(root, viewId)?.childPid ?? null;
		} catch {
			return null; /* host.json may not exist yet: the pid is UNKNOWN */
		}
	},
	sleep,
};

/** The pre-mount phase handle: everything EXCEPT the attach side, so a
 *  beforeMount hook can prove child state (e.g. the A4 120x28 seed) before
 *  the attach exists and can resize the real runner (P16-DRAFT-ORDER). */
export interface DiagPreMountHandle {
	root: string;
	viewId: string;
	eventsPath: string;
	/** Step 20A (additive): the attach-surface geometry the mount will use. */
	attachDims: AttachSurfaceDims;
	probe: ProbeClient;
	actions: Array<{ type: string; at: number; detail?: unknown }>;
	holds: HoldRecord[];
	holdMs(label: string, ms: number): Promise<void>;
	readChildEvents(): Array<Record<string, unknown>>;
	attachLog(label: string): void;
}

export interface DiagTrialHandle extends DiagPreMountHandle {
	runner: ChildProcess;
	runnerStderr: string[];
	primary: Side;
	/** Step 20A (additive): alias for the mount's actual geometry. */
	attachDims: AttachSurfaceDims;
	cleanup: DiagCleanup;
	rxLog: Array<{ at: number; data: string }>;
	txLog: TxRecord[];
	innerLog: InnerParserEvent[];
	actions: Array<{ type: string; at: number; detail?: unknown }>;
	holds: HoldRecord[];
	sendChild(obj: unknown): void;
	holdMs(label: string, ms: number): Promise<void>;
	readChildEvents(): Array<Record<string, unknown>>;
	rxMessages(): RxMessage[];
	txMessages(): Array<{ at: number; type: string; msg: Record<string, unknown> }>;
	attachLog(label: string): void;
}

/** Parse the outgoing component-socket byte log into protocol messages. */
function parseTxMessages(txLog: readonly TxRecord[]): Array<{ at: number; type: string; msg: Record<string, unknown> }> {
	const out: Array<{ at: number; type: string; msg: Record<string, unknown> }> = [];
	for (const record of txLog) {
		for (const line of record.data.split("\n")) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				out.push({ at: record.at, type: typeof msg.type === "string" ? msg.type : "?", msg });
			} catch {
				/* non-protocol bytes stay in the raw tx log */
			}
		}
	}
	return out;
}

/** Read the child's append-only event log (missing/partial file = no events). */
function readChildEventsSafe(eventsPath: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(eventsPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/**
 * Owned teardown for one diag trial's runner + child (bounded, recorded).
 *
 * Step-17 UNKNOWN fix (task-16 acceptance "cleanup corner", task-17 brief):
 * a MISSING or UNKNOWN pid is UNKNOWN (null), never known-dead — the previous
 * childAliveAfter=false / runnerAliveAfter=false for unknown pids was false
 * known-dead evidence. Only an owned handle with a KNOWN pid is ever probed
 * or signalled: a spawn-failed runner (no pid) is never signalled and stays
 * UNKNOWN, and no bogus "runner:undefined" forced-kill is recorded. The
 * record distinguishes the known pid (childPid/runnerPid), the exit
 * status/signal (runnerExited/runnerExitCode/runnerExitSignal), forced
 * cleanup (forcedKills) and — through diagCleanupOk — root ownership
 * (rootRemoved/rootRetainedForEvidence). Retained known-pid/natural-exit
 * behavior is unchanged: a known live child is SIGKILLed and awaited, an
 * already-exited runner is never signalled and records aliveAfter=false.
 */
export async function killOwnedDiagProcesses(
	runner: ChildProcess | null,
	root: string,
	viewId: string,
	cleanup: DiagCleanup,
	seams?: Partial<DiagKillSeams>,
): Promise<void> {
	const seam: DiagKillSeams = { ...defaultDiagKillSeams, ...seams };
	const childPid = seam.readChildPid(root, viewId);
	cleanup.childPid = typeof childPid === "number" && Number.isInteger(childPid) && childPid > 0 ? childPid : null;
	if (cleanup.childPid !== null && seam.isAlive(cleanup.childPid)) {
		cleanup.forcedKills.push(`child:${cleanup.childPid}`);
		try {
			seam.kill(cleanup.childPid, "SIGKILL");
		} catch {
			/* already exited */
		}
		const deadline = now() + 2000;
		while (seam.isAlive(cleanup.childPid) && now() < deadline) await seam.sleep(25);
	}
	// UNKNOWN stays UNKNOWN: without a known pid no liveness claim is made.
	cleanup.childAliveAfter = cleanup.childPid === null ? null : seam.isAlive(cleanup.childPid);
	cleanup.runnerPid = runner !== null && typeof runner.pid === "number" ? runner.pid : null;
	if (runner !== null && cleanup.runnerPid !== null && runner.exitCode === null && runner.signalCode === null) {
		const owned = runner;
		cleanup.forcedKills.push(`runner:${cleanup.runnerPid}`);
		try {
			owned.kill("SIGKILL");
		} catch {
			/* already exited */
		}
		await Promise.race([new Promise((r) => owned.once("exit", r)), seam.sleep(2000)]);
	}
	if (runner !== null) {
		if (runner.exitCode !== null || runner.signalCode !== null) cleanup.runnerExited = true;
		if (cleanup.runnerExitCode === null) cleanup.runnerExitCode = runner.exitCode;
		cleanup.runnerExitSignal = runner.signalCode;
		// A real exit status is provably not alive; a pidless handle is UNKNOWN
		// (the liveness probe is never called without a known pid).
		cleanup.runnerAliveAfter =
			cleanup.runnerPid === null ? null : runner.exitCode === null && runner.signalCode === null && seam.isAlive(cleanup.runnerPid);
	} else {
		cleanup.runnerAliveAfter = null;
	}
}

/**
 * Step 17: cleanup is OK only when termination is PROVEN for both owned
 * processes (a host-observed exit, or a post-cleanup known-dead check on a
 * KNOWN pid) AND the owned root has an explicit disposition (removed or
 * deliberately retained for evidence). UNKNOWN liveness (null) never counts
 * as terminated — a missing pid can no longer launder into a clean cleanup.
 */
export function diagCleanupOk(cleanup: DiagCleanup): boolean {
	const childTerminated = cleanup.childExited || cleanup.childAliveAfter === false;
	const runnerTerminated = cleanup.runnerExited || cleanup.runnerAliveAfter === false;
	return childTerminated && runnerTerminated && (cleanup.rootRemoved || cleanup.rootRetainedForEvidence);
}

/**
 * One bounded step-16 diagnostic trial: exclusive artifact dir (overwrite
 * refused), owned REAL runner + controlled child at the requested host size,
 * a raw probe client, a REAL primary attach (component + TuiAltScreen +
 * accepted observer) with rx/tx socket loggers and inner-parser observation,
 * the case-specific flow/analysis body, and owned cleanup on success AND
 * failure. Trial-level failures are retained evidence, never discarded.
 *
 * Step 19 (task-19 brief): exported so the interactions scenario reuses this
 * accepted real-runner shell rather than duplicating the runner/socket/root
 * topology. Additive export only; the accepted S/A4/A5/T/GEN behaviors and
 * assertions are unchanged.
 */
export async function withDiagTrial(
	options: {
		caseId: string;
		/** Script of the ACCEPTED controlled-frames child (default child).
		 *  Optional since step 17 fix1: a dedicated child (childPath+childEnv)
		 *  replaces it; exactly one of the two configurations must be given. */
		script?: "resize" | "cold" | "theme";
		/** Step 17 fix1: dedicated fixture child path (e.g. the session
		 *  generation fixture). The accepted fake-pty-pi.mjs stays the default. */
		childPath?: string;
		/** Step 17 fix1: full child env for a dedicated child (replaces the
		 *  controlled-frames env below); receives the per-trial events path. */
		childEnv?: (eventsPath: string) => Record<string, string>;
		hostCols: number;
		hostRows: number;
		/** Step 20A (additive): non-default attach-surface body size for the
		 *  G2/G3 geometry cells. Defaults to the accepted 80x22 body (observer
		 *  80x24) when omitted, so every existing trial keeps its exact size. */
		bodyCols?: number;
		bodyRows?: number;
		artifactDir: string;
		attachScreenLog: boolean;
		forceLegacy?: boolean;
		frameWitness?: boolean;
		frameWitnessGeometry?: boolean;
		deferFrameReporter?: boolean;
		poisonScreenLog?: string;
		declared: Record<string, unknown>;
		/** Runs after the runner/probe exist but BEFORE the attach is mounted,
		 *  so the mount (which may resize the child) cannot race the proof. */
		beforeMount?: (h: DiagPreMountHandle) => Promise<Record<string, unknown>>;
		/** Runs in the scaffold's finally AFTER dispose/stop and observer drain,
		 *  so oracle/chrome/poison checks cover EVERY observation through child
		 *  exit and disposal, with the active/teardown boundary explicit. */
		postTeardown?: (side: Side, activeBoundary: number) => Record<string, unknown>;
	},
	body: (h: DiagTrialHandle) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
	const { artifactDir } = options;
	// Step 20A (additive): default 80x22 body keeps every accepted trial
	// byte/behavior identical; G2/G3 request a larger/shrinking body.
	const attachDims = makeAttachDims(options.bodyCols ?? WORK_AREA.cols, options.bodyRows ?? WORK_AREA.rows);
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists (overwrite refused): ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const artifactErrors: string[] = [];
	const writeArtifact = (name: string, value: unknown) => {
		try {
			writeFileSync(join(artifactDir, name), JSON.stringify(value, null, 2));
		} catch (err) {
			artifactErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const copyArtifact = (name: string, source: string) => {
		try {
			copyFileSync(source, join(artifactDir, name));
		} catch (err) {
			artifactErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	writeArtifact("expectation.json", { declared: options.declared });

	const root = mkdtempSync(join(tmpdir(), `s16-${options.caseId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-`));
	const viewId = `s16-${options.caseId.toLowerCase()}`;
	const eventsPath = join(root, "child-events.jsonl");
	const frameTokenPath = join(root, "frame-token.txt");
	const cleanup: DiagCleanup = createDiagCleanup();
	const rxLog: Array<{ at: number; data: string }> = [];
	const txLog: TxRecord[] = [];
	const innerLog: InnerParserEvent[] = [];
	const actions: Array<{ type: string; at: number; detail?: unknown }> = [];
	const holds: HoldRecord[] = [];
	const runnerStderr: string[] = [];
	let runner: ChildProcess | null = null;
	let probe: ProbeClient | null = null;
	let frameReporter: import("node:net").Socket | null = null;
	let primary: Side | null = null;
	const detachers: Array<() => void> = [];
	let trialError: string | null = null;
	let bodyResult: Record<string, unknown> = {};
	let teardownViolations: unknown[] = [];
	let postTeardownResult: Record<string, unknown> | null = null;
	// Step 17 poison non-vacuity: the plant readback is taken at plant time;
	// the evaluated evidence is computed in the finally before root removal.
	let poisonPlantReadback: string | null = null;
	let poisonEvidence: Record<string, unknown> | null = null;

	try {
		// --- owned runner + controlled child at the requested host size ------
		// Production shape (issue #91 phase 5): an instance-scoped claim, config
		// path and endpoint, so the attach client's resize is enveloped with a
		// commandId and the runner answers with a REAL applied cmd_ack — the
		// legacy no-instance fallback would apply the resize but ack nothing.
		if (!options.childEnv && !options.script) throw new Error("withDiagTrial requires either script (accepted controlled-frames child) or childEnv (dedicated child)");
		// Guarded above: the default env is used only when a script was given.
		const childEnv: Record<string, string> = options.childEnv
			? options.childEnv(eventsPath)
			: {
					AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1",
					FAKE_PTY_STREAM_MODE: "controlled-frames",
					FAKE_PTY_CONTROLLED_SCRIPT: options.script as string,
					FAKE_PTY_EVENTS_PATH: eventsPath,
				};
		const childPath = options.childPath ?? (formalMeasurementVersion() === "baseline"
			? resolve(REPO_ROOT, "test-support/formal-measurement/fake-pty-controlled-pi.mjs")
			: resolve(REPO_ROOT, "test-support/fake-pty-pi.mjs"));
		const piArgsPrefix = options.frameWitness === true ? [resolve(REPO_ROOT, "test-support/fake-pty-frame-wrapper.mjs")] : [childPath];
		if (options.frameWitness === true) {
			childEnv.FAKE_PTY_FRAME_CHILD_PATH = childPath;
			childEnv.FAKE_PTY_FRAME_TOKEN = frameTokenPath;
			if (options.frameWitnessGeometry === true) childEnv.FAKE_PTY_FRAME_GEOMETRY = "1";
		}
		const meta = createView(root, { id: viewId, name: `s16 ${options.caseId}`, cwd: root });
		const instanceId = `inst-${viewId}-${process.pid}`;
		const diagPlatform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
		const socketPath = P.hostEndpointPathFor(diagPlatform, root, viewId, instanceId);
		const configPath = P.hostConfigPathFor(root, viewId, instanceId);
		const claimed = claimHost(root, {
			viewId,
			instanceId,
			configPath,
			socketPath,
			claimAt: Date.now(),
			claimPid: process.pid,
			claimIdentity: null,
			cols: options.hostCols,
			rows: options.hostRows,
		});
		if (!claimed.claimed) throw new Error(`claim lost for ${viewId}/${instanceId}`);
		atomicWriteJson(configPath, {
			root,
			viewId,
			instanceId,
			socketPath,
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix,
			model: null,
			tools: null,
			env: childEnv,
			cols: options.hostCols,
			rows: options.hostRows,
		});
		runner = spawn(process.execPath, [resolve(REPO_ROOT, "runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		runner.stderr?.setEncoding("utf8");
		runner.stderr?.on("data", (chunk) => runnerStderr.push(String(chunk)));
		runner.stdout?.resume();
		runner.on("error", (err) => runnerStderr.push(`spawn-error: ${err.message}`));
		await waitFor(() => {
			const host = readHost(root, viewId);
			return !!host && host.state === "alive" && !!host.childPid;
		}, 10_000, "diag runner host alive with child");
		if (options.frameWitness === true && options.deferFrameReporter !== true) {
			frameReporter = await connectFrameReporter(socketPath, frameTokenPath);
		}
		actions.push({ type: "runner-alive", at: now(), detail: { instanceId, socketPath } });

		// A5: poison the historical log AFTER the runner is alive (the runner
		// appends child output with appendBoundedScreenLog, so the poison stays
		// in the file) and BEFORE the attach's warm-start replay reads it.
		if (options.poisonScreenLog !== undefined) {
			writeFileSync(P.screenLogPath(root, viewId), options.poisonScreenLog);
			// Step 17: read the plant back immediately so a later "poison never
			// visible" scan is non-vacuous — the plant itself is evidenced, with
			// the planted bytes hashed for comparison against the retained log.
			try {
				poisonPlantReadback = readFileSync(P.screenLogPath(root, viewId), "utf8");
			} catch {
				poisonPlantReadback = null; // recorded as missing evidence (UNKNOWN)
			}
			actions.push({
				type: "poison-screen-log",
				at: now(),
				detail: {
					bytes: Buffer.byteLength(options.poisonScreenLog, "utf8"),
					sha256: createHash("sha256").update(options.poisonScreenLog, "utf8").digest("hex"),
					// Prefix rule (M3): the runner may have appended child output
					// between the plant write and this readback.
					plantReadbackMatched: poisonPlantPrefixMatch(options.poisonScreenLog, poisonPlantReadback),
				},
			});
		}

		probe = await connectProbe(socketPath);

		const preHandle: DiagPreMountHandle = {
			root,
			viewId,
			eventsPath,
			attachDims,
			probe,
			actions,
			holds,
			async holdMs(label, ms) {
				const startAt = now();
				await sleep(ms);
				const endAt = now();
				holds.push({ after: label, plannedMs: ms, actualMs: endAt - startAt, openFrame: false, startAt, endAt });
			},
			readChildEvents: () => readChildEventsSafe(eventsPath),
			attachLog(label) {
				actions.push({ type: label, at: now() });
			},
		};
		// P16-DRAFT-ORDER: the case's before-mount phase (e.g. the A4 seed
		// proof through the real probe) completes BEFORE the attach exists.
		const preResult: Record<string, unknown> = options.beforeMount ? await options.beforeMount(preHandle) : {};
		if (options.frameWitness === true && options.deferFrameReporter === true) {
			frameReporter = await connectFrameReporter(socketPath, frameTokenPath);
			actions.push({ type: "frame-reporter-enabled-after-premount", at: now() });
		}

		const previousSnapshotEnv = process.env.AGENT_BOARD_TERMINAL_SNAPSHOT;
		if (options.forceLegacy === true) process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = "0";
		primary = await attachSide("primary", {
			socketPath,
			screenLogPath: options.attachScreenLog ? P.screenLogPath(root, viewId) : undefined,
			dims: attachDims,
			// Log-and-delegate: the REAL component diagnostics are recorded with
			// their actual parent-monotonic receipt times (a read-for-wait sampling
			// time is only an upper bound; this log is the exact callback receipt).
			// attachSide's own side.diagnostics record is unchanged.
			onDiagnostic: (event) => {
				actions.push({ type: "diagnostic", at: now(), detail: event });
			},
			onDone: () => {},
		});
		if (previousSnapshotEnv === undefined) delete process.env.AGENT_BOARD_TERMINAL_SNAPSHOT;
		else process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = previousSnapshotEnv;
		// P16-DRAFT-TRACE: no await between the mount and the trace
		// installation — socket data events are I/O macrotasks and cannot
		// interleave this microtask chain, so the rx/tx loggers and the inner
		// parser observer are all in place before the first receive callback
		// can run. The tx logger additionally wraps the already-present socket
		// synchronously (not after a poll interval).
		detachers.push(attachSocketRxLoggerImmediate(primary.component, rxLog));
		detachers.push(attachSocketTxLogger(primary.component, txLog));
		detachers.push(instrumentInnerParser(primary.component, innerLog));
		actions.push({ type: "attach-mounted", at: now() });

		const handle: DiagTrialHandle = {
			...preHandle,
			runner,
			runnerStderr,
			primary,
			attachDims,
			cleanup,
			rxLog,
			txLog,
			innerLog,
			sendChild(obj) {
				const at = now();
				(primary!.component as unknown as { handleInput: (data: string) => void }).handleInput(producerCommand(obj));
				actions.push({ type: "child-command", at, detail: obj });
			},
			rxMessages: () => parseRxMessages(rxLog),
			txMessages: () => parseTxMessages(txLog),
		};
		bodyResult = { ...preResult, ...(await body(handle)) };
	} catch (err) {
		trialError = err instanceof Error ? err.stack ?? err.message : String(err);
	} finally {
		// Owned teardown on success AND failure; raw truth is written BEFORE the
		// temp root is removed, and copy/write failures keep the root as evidence.
		// The active-window boundary is fixed BEFORE dispose/stop so teardown
		// observations are validated under their own contract, never mixed into
		// the active window or vice versa.
		const activeBoundary = primary ? primary.observer.observations.length : 0;
		try {
			primary?.component.dispose();
		} catch {
			/* best-effort teardown */
		}
		try {
			primary?.tui.stop();
		} catch {
			/* best-effort teardown */
		}
		if (primary) {
			try {
				await Promise.race([primary.observer.whenIdle(), sleep(2000)]);
			} catch {
				/* best-effort drain */
			}
			if (options.postTeardown) {
				try {
					postTeardownResult = options.postTeardown(primary, activeBoundary);
				} catch (err) {
					postTeardownResult = { analysisError: err instanceof Error ? err.stack ?? err.message : String(err) };
				}
				writeArtifact("post-teardown-analysis.json", postTeardownResult);
			}
			const all = primary.observer.observations;
			writeArtifact("observations.json", { analysisBoundary: activeBoundary, observations: all });
			if (typeof bodyResult.teardownAllowedRowTexts === "object" && Array.isArray(bodyResult.teardownAllowedRowTexts)) {
				const teardownObs = all.slice(activeBoundary).map((o) => ({ ...o, grid: o.grid.map((row) => ({ ...row, text: row.text.replace(/\s+$/u, "") })) }));
				teardownViolations = validateTeardownObservations(teardownObs, {
					finalTargetId: "diag",
					allowedRowTexts: bodyResult.teardownAllowedRowTexts as string[],
				});
				writeArtifact("teardown-validation.json", { boundary: activeBoundary, observationCount: teardownObs.length, violations: teardownViolations });
			}
			writeArtifact("writes.json", primary.observer.writes);
			writeArtifact("controls.json", primary.observer.controls);
			writeArtifact("requests.json", primary.requests);
			writeArtifact("receive-contexts.json", {
				contexts: primary.receiveContexts,
				messageBoundaries: Object.fromEntries(receiveContextMessages(primary.receiveContexts)),
			});
			writeArtifact("diagnostics.json", primary.diagnostics);
		}
		writeArtifact("inner-parser.json", innerLog);
		writeArtifact("tx-socket.json", txLog);
		writeArtifact("rx-socket.json", rxLog);
		writeArtifact("rx-messages.json", parseRxMessages(rxLog));
		writeArtifact("tx-messages.json", parseTxMessages(txLog));
		if (probe) writeArtifact("probe-messages.json", probe.messages);
		copyArtifact("child-events.jsonl", eventsPath);
		try {
			copyArtifact("screen.log", P.screenLogPath(root, viewId));
		} catch {
			/* a silent cold child may never create a screen.log */
		}
		// Step 17: evaluate the poison plant against the RETAINED log before the
		// root can be removed; the verdict makes any never-visible poison scan
		// non-vacuous (or honestly UNKNOWN/NOT_PROVEN). Evidence computation
		// never throws into cleanup.
		if (options.poisonScreenLog !== undefined) {
			let retainedLog: string | null = null;
			try {
				retainedLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
			} catch {
				/* no retained log: recorded as null below */
			}
			poisonEvidence = evaluatePoisonPlant({ plantedText: options.poisonScreenLog, plantReadback: poisonPlantReadback, retainedLog });
			writeArtifact("poison-evidence.json", poisonEvidence);
		}
		writeArtifact("analysis.json", { trialError, actions, holds, ...bodyResult, runnerStderr, ...(poisonEvidence !== null ? { poisonEvidence } : {}) });
		for (const detach of detachers) {
			try {
				detach();
			} catch {
				/* best-effort teardown */
			}
		}
		try {
			primary?.observer.dispose();
		} catch {
			/* best-effort teardown */
		}
		try {
			probe?.destroy();
			frameReporter?.destroy();
		} catch {
			/* best-effort teardown */
		}
		await killOwnedDiagProcesses(runner, root, viewId, cleanup);
		if (artifactErrors.length > 0) {
			cleanup.rootRetainedForEvidence = true;
		} else {
			try {
				rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
				cleanup.rootRemoved = true;
			} catch {
				/* recorded below */
			}
		}
		cleanup.ok = diagCleanupOk(cleanup);
		writeArtifact("cleanup.json", cleanup);
	}
	const record: Record<string, unknown> = {
		ok: trialError === null,
		measurementPath: options.frameWitness === true ? "modern-reporter-viewproof" : "legacy-no-reporter",
		caseId: options.caseId,
		declared: options.declared,
		...bodyResult,
		teardownViolations,
		...(postTeardownResult !== null ? { postTeardownAnalysis: postTeardownResult } : {}),
		...(poisonEvidence !== null ? { poisonEvidence } : {}),
		holds,
		cleanup,
		artifactErrors,
		error: trialError,
		artifactDir,
	};
	writeArtifact("summary.json", record);
	return record;
}

/** Ordered exit through the real input path + bounded host/runner waits.
 *  Step 20A fix1 (review I4): exported so the matrix scenario reuses the SAME
 *  accepted ordered-exit helper instead of a bare child exit command. */
export async function diagOrderedExit(h: DiagTrialHandle): Promise<void> {
	h.sendChild({ cmd: "exit" });
	await waitFor(() => readHost(h.root, h.viewId)?.state === "exited", 5000, "diag host state exited");
	h.cleanup.childExited = true;
	// Minor exit-helper fix: do not register once('exit') after the event may
	// already have fired (that would idle the full 5s bound every time).
	if (h.runner.exitCode === null && h.runner.signalCode === null) {
		await Promise.race([new Promise((r) => h.runner.once("exit", r)), sleep(5000)]);
	}
	h.cleanup.runnerExited = h.runner.exitCode !== null || h.runner.signalCode !== null;
	h.cleanup.runnerExitCode = h.runner.exitCode;
}

/** Wait until an outer frame commits the literal work-area rows; return it. */
async function waitCommitRows(side: Side, literalRows: string[], label: string): Promise<PresentationObservation> {
	let found: PresentationObservation | null = null;
	await waitFor(
		() => {
			found = side.observer.observations.find((o) => o.kind === "frame" && rowsEqual(projectedRows(o), literalRows)) ?? null;
			return found !== null;
		},
		10_000,
		label,
	);
	return found!;
}

/** Paint one captured snapshot frame on an independent raw terminal of the given size. */
async function paintFrameAt(frameData: string, cols: number, rows: number): Promise<string[]> {
	const raw = new HeadlessTerminal({ cols, rows, allowProposedApi: true });
	try {
		await new Promise<void>((resolveWrite) => raw.write(frameData, resolveWrite));
		// P16-DRAFT-TSC: the collected row array must not shadow the numeric
		// rows parameter (the shadowing made y < rows a number<string[] compare
		// that silently painted zero rows).
		const painted: string[] = [];
		for (let y = 0; y < rows; y++) painted.push(raw.buffer.active.getLine(y)?.translateToString(true) ?? "");
		return painted;
	} finally {
		raw.dispose();
	}
}

/** Ordered oracle expectation for a step-16 case: bootstrap blank, every
 *  declared loading spinner/detail variant, then the declared content screens. */
export function s16Expectation(contentScreens: ExpectedPresentationScreen[], frameIds: string[]): AttachPresentationExpectation {
	const screens: ExpectedPresentationScreen[] = [{ name: "bootstrap-blank", rows: [], inverseCells: [] }];
	for (const detail of [LOADING_DETAILS.starting0, LOADING_DETAILS.starting1, LOADING_DETAILS.attached]) {
		for (const spinner of SPINNERS) {
			screens.push({ name: `loading-${detail}-${spinner}`, rows: loadingBodyRows({ spinner, detail }), loading: true, inverseCells: [] });
		}
	}
	screens.push(...contentScreens);
	return { screens, frameIds };
}

/** One literal content screen for the step-16 oracle (work-area coordinates). */
export function s16ContentScreen(name: string, rows: string[], frameIds: string[], cursor?: { x: number; y: number; visible: boolean }): ExpectedPresentationScreen {
	return {
		name,
		rows,
		rowFrameIds: rows.map((text) => frameIds.find((id) => text.includes(id)) ?? null),
		...(cursor ? { cursor } : {}),
		inverseCells: [],
	};
}

/** Projected-oracle + chrome analysis over a diag trial's active window
 *  (observations present at body end, BEFORE dispose/stop). Teardown windows
 *  are validated separately in the scaffold's finally against the case's
 *  declared allowed texts — never mislabeled active-window content. */
function analyzeDiagSide(side: Side, expectation: AttachPresentationExpectation) {
	const observations = side.observer.observations;
	const chromeViolations: Array<{ index: number; violations: string[] }> = [];
	const projected: PresentationObservation[] = [];
	for (const observation of observations) {
		const violations = checkChromeRows(observation);
		if (violations.length > 0) chromeViolations.push({ index: observation.index, violations });
		const projectedObservation = projectObservationToWorkArea(observation);
		projected.push({
			...projectedObservation,
			grid: projectedObservation.grid.map((row) => ({ ...row, text: row.text.replace(/\s+$/u, "") })),
		});
	}
	const failures = validateAttachPresentation(projected, expectation);
	return { projected, failures, chromeViolations, activeWindowSize: observations.length };
}

/** Scan every observation (active AND teardown) for a forbidden marker. */
function observationsContain(projected: readonly PresentationObservation[], marker: string): boolean {
	return projected.some((o) => o.grid.some((row) => row.text.includes(marker)));
}

const EXIT_ALT_SCREEN = "\x1b[?1049l";

/**
 * Stage-correct full-coverage analysis (P16 final, source-grounded in the
 * parent's teardown proof): stage boundaries come from EXACT observer write
 * identity — the first caller write containing EXIT_ALT_SCREEN (pi-tui
 * TuiAltScreen.afterTerminalStop, dist/tui-alt-screen.js:209-228, default
 * preserveScreen=false: exit alt buffer, render the 24 document rows
 * (header + 22 body + footer) into the normal buffer, then a final CRLF
 * scrolls the document up one row and shows the cursor). Pre-stop
 * observations keep the ACTIVE attach contract (chrome + work-area
 * projection + ordered oracle). Stop-stage observations are validated as
 * FULL 24-row grids: literal 22 final content rows + footer at row 22 +
 * blank row 23, with a VISIBLE cursor at (0,23). Uncertainty is recorded as
 * unknown/violation — never donated a pass; the shifted stop layout is never
 * permitted while attached because the active oracle covers those frames.
 */
export function analyzeStagedObservations(input: {
	observations: readonly PresentationObservation[];
	writes: readonly { index: number; data: string }[];
	finalContentRows: readonly string[];
	activeExpectation: AttachPresentationExpectation;
	forbiddenMarker?: string;
}): Record<string, unknown> {
	const stopWriteIndices = input.writes.filter((w) => w.data.includes(EXIT_ALT_SCREEN)).map((w) => w.index);
	const firstStopWrite = stopWriteIndices.length > 0 ? stopWriteIndices[0] : null;
	// Three stages, by EXACT write identity only:
	// - active: parsed entirely before the stop write.
	// - stop-entry: the sync-entry window OF the stop write — it snapshots the
	//   pre-block (still active-layout) content, but the stop sequence's own
	//   showCursor control is already queued in stream order, so its cursor is
	//   recorded as data, not judged by the active hardware-cursor contract.
	// - stop: frames parsed from the stop write and any later write-end state.
	const stageOf = (o: PresentationObservation): "active" | "stop-entry" | "stop" => {
		if (firstStopWrite === null) return "active";
		if (o.kind === "frame") return o.openWriteIndex >= firstStopWrite ? "stop" : "active";
		if (o.note === "sync-entry") {
			if (o.closeWriteIndex === firstStopWrite) return "stop-entry";
			return o.closeWriteIndex > firstStopWrite ? "stop" : "active";
		}
		return o.closeWriteIndex >= firstStopWrite ? "stop" : "active";
	};
	const active: PresentationObservation[] = [];
	const stopEntry: PresentationObservation[] = [];
	const stopStage: PresentationObservation[] = [];
	for (const o of input.observations) {
		const stage = stageOf(o);
		if (stage === "stop") stopStage.push(o);
		else if (stage === "stop-entry") stopEntry.push(o);
		else active.push(o);
	}

	// Active window: projected work-area rows + chrome + ordered oracle.
	const projectedActive = active.map((o) => {
		const p = projectObservationToWorkArea(o);
		return { ...p, grid: p.grid.map((row) => ({ ...row, text: row.text.replace(/\s+$/u, "") })) };
	});
	const activeFailures = validateAttachPresentation(projectedActive, input.activeExpectation);
	const chromeViolations: Array<{ index: number; violations: string[] }> = [];
	for (const o of active) {
		const violations = checkChromeRows(o);
		if (violations.length > 0) chromeViolations.push({ index: o.index, violations });
	}

	// Stop-entry windows: pre-stop content must still satisfy the ACTIVE
	// content contract (rows + chrome); the cursor is stop-sequence data.
	const stopEntryResults = stopEntry.map((o) => {
		const projected = projectObservationToWorkArea(o);
		const rows = projected.grid.map((r) => r.text.replace(/\s+$/u, ""));
		const chrome = checkChromeRows(o);
		return {
			index: o.index,
			closeWriteIndex: o.closeWriteIndex,
			rowsMatchFinalContent: rowsEqual(rows, input.finalContentRows),
			chromeViolations: chrome,
			actualCursor: { ...o.cursor },
			note: "pre-stop content with the stop sequence's showCursor already queued; cursor visibility is stop-contract data here",
		};
	});
	const stopEntryViolations = stopEntryResults.filter((r) => !r.rowsMatchFinalContent || r.chromeViolations.length > 0);

	// Stop stage: full 24-row grid + cursor, source-grounded exact layout.
	const expectedStopRows = [...input.finalContentRows, FOOTER_ROW, ""];
	const stopResults = stopStage.map((o) => {
		const rows = o.grid.map((r) => r.text.replace(/\s+$/u, ""));
		const rowsMatch = rowsEqual(rows, expectedStopRows);
		const cursorMatch = o.cursor.x === 0 && o.cursor.y === 23 && o.cursor.visible === true;
		return {
			index: o.index,
			kind: o.kind,
			closeWriteIndex: o.closeWriteIndex,
			rowsMatch,
			cursorMatch,
			actualRows: rows,
			actualCursor: { ...o.cursor },
		};
	});
	const stopViolations = stopResults.filter((r) => !r.rowsMatch || !r.cursorMatch);

	const poison = input.forbiddenMarker
		? { neverVisibleOnOuter: !input.observations.some((o) => o.grid.some((row) => row.text.includes(input.forbiddenMarker!))), scanScope: "EVERY observation (bootstrap, active, exit, stop stage)" }
		: undefined;
	return {
		stageRule: "exact observer write identity: first write containing EXIT_ALT_SCREEN; stop-entry = the stop write's sync-entry window (pre-stop content, stop-sequence cursor); stop stage = full 24-row source-grounded layout (tui-alt-screen.js:209-228), cursor (0,23) visible",
		stopWriteIndices,
		activeBoundary: active.length,
		observationCounts: { total: input.observations.length, active: active.length, stopEntry: stopEntry.length, stopStage: stopStage.length },
		activeFailures,
		chromeViolations,
		stopEntry: { results: stopEntryResults, violations: stopEntryViolations },
		stopStage: {
			expectedRows: expectedStopRows,
			expectedCursor: { x: 0, y: 23, visible: true },
			results: stopResults,
			violations: stopViolations,
		},
		...(poison ? { poison } : {}),
	};
}

// ---- A4 predicate analysis seam (P16-COND-1/P16-CAUSE-1) --------------------

/** One child stdout write fact (from the child event log). */
export interface A4ChildWriteFact {
	writeIndex: number;
	frame?: unknown;
	phase?: unknown;
	bytes?: unknown;
	sha256?: unknown;
	dimsUsed?: { cols?: unknown; rows?: unknown; basis?: unknown } | null;
}

/** Plain-data input for the pure A4 predicate analysis. Child emission, parent
 *  receive, inner parse and outer commit fields stay separate; no clock
 *  conversion between domains is performed. */
export interface A4PredicateInput {
	ack: { at: number; commandId?: unknown; cols?: unknown; rows?: unknown } | null;
	innerLog: readonly InnerParserEvent[];
	childWrites: readonly A4ChildWriteFact[];
	targetGeometry: { cols: number; rows: number };
	targetFrameId: string;
	outerFrames: readonly { index: number; boundaryParsedAt: number; rows: string[] }[];
	targetLiteralRows: readonly string[];
	targetCommitIndex: number | null;
}

export interface A4PredicateVerdict {
	id: string;
	proposed: string;
	/** Tri-state: REFUTED (a retained counterexample witness), CONSISTENT (the
	 *  observed witnesses do not refute — never a sufficiency proof), UNKNOWN
	 *  (missing/ambiguous evidence is neither success nor failure). */
	verdict: "REFUTED" | "CONSISTENT" | "UNKNOWN";
	evidence: Record<string, unknown>;
}

/** One reconstructed inner-parser write record (FIFO ordered parse). */
interface InnerWriteRecord {
	sha256: string | null;
	enqueueAt: number;
	bytes?: number;
	drainAt: number | null;
	opens: InnerParserEvent[];
	closes: InnerParserEvent[];
	/** Actual ordered observed sync state at this write's drain (P16-EDGE-1
	 *  guard 3): tracked across writes from every observed boundary, NOT from
	 *  per-write open/close counts. The initial state is the xterm default
	 *  (sync mode off at fresh construction); boundaries observed before the
	 *  first instrumented enqueue still update the state honestly. */
	syncOpenAtDrain: boolean;
}

/**
 * Reconstruct which enqueued write each inner CSI boundary was parsed from,
 * using ONLY the retained ordered enqueue/drain records (FIFO). A boundary
 * observed while no enqueue is pending belongs to an UNINSTRUMENTED write
 * (e.g. the constructor screen.log replay) and stays unknown; a drain whose
 * sha does not match the front enqueue marks the log inconsistent and all
 * identity-based verdicts become UNKNOWN. No nearest-time fallback exists.
 */
function buildInnerWriteRecords(innerLog: readonly InnerParserEvent[]): {
	records: InnerWriteRecord[];
	logConsistent: boolean;
	unknownBoundaryCount: number;
} {
	const records: InnerWriteRecord[] = [];
	const queue: InnerWriteRecord[] = [];
	let logConsistent = true;
	let unknownBoundaryCount = 0;
	let syncOpen = false;
	for (const event of innerLog) {
		if (event.kind === "parser-attach" || event.kind === "parser-detach") continue;
		if (event.kind === "enqueue") {
			const record: InnerWriteRecord = { sha256: event.sha256 ?? null, enqueueAt: event.at, bytes: event.bytes, drainAt: null, opens: [], closes: [], syncOpenAtDrain: false };
			records.push(record);
			queue.push(record);
		} else if (event.kind === "drain") {
			const front = queue.shift();
			if (!front || front.sha256 !== (event.sha256 ?? null)) {
				logConsistent = false;
				continue;
			}
			front.drainAt = event.at;
			front.syncOpenAtDrain = syncOpen;
		} else {
			// csi-open / csi-close: update the ACTUAL ordered observed state first
			// (a close-then-open in one write leaves the parser open at drain),
			// then attribute the boundary to the front pending write if any.
			if (event.kind === "csi-open") syncOpen = true;
			else syncOpen = false;
			const front = queue[0];
			if (!front) {
				unknownBoundaryCount += 1;
				continue;
			}
			if (event.kind === "csi-open") front.opens.push(event);
			else front.closes.push(event);
		}
	}
	return { records, logConsistent, unknownBoundaryCount };
}

/** Find the write record (if any) whose parse produced the given boundary. */
function recordOfBoundary(records: readonly InnerWriteRecord[], boundary: InnerParserEvent): InnerWriteRecord | null {
	for (const record of records) {
		if (record.opens.includes(boundary) || record.closes.includes(boundary)) return record;
	}
	return null;
}

/**
 * The pure A4 predicate analysis seam (P16-COND-1/P16-CAUSE-1 corrected).
 *
 * Verdicts are tri-state and evidence-bound: REFUTED only when a retained
 * counterexample witness is uniquely identified (ordered FIFO enqueue/drain
 * parse attribution + retained write sha matched to the child event log);
 * CONSISTENT when every resolved witness is non-refuting (explicitly never a
 * sufficiency proof for a universal production predicate); UNKNOWN when
 * evidence is missing, the boundary is uninstrumented (e.g. the constructor
 * screen.log replay predates instrumentation), the source write matches no
 * retained child write, or the inner log is inconsistent. Geometry
 * (dimsUsed vs the target size) and frame-ID occurrence are separate checks;
 * a target-geometry frame with a different frame ID is never rejected. Outer
 * commit grids are reported as separate factual records with their own
 * commit timestamps and causalIdentity "unknown" — no temporal succession is
 * ever promoted to a causal link (the corrected P16-CAUSE-1 rule).
 */
export function analyzeA4Predicates(input: A4PredicateInput): {
	predicates: A4PredicateVerdict[];
	counterexample: Record<string, unknown>;
	outerCommitFacts: Array<{ index: number; boundaryParsedAt: number; matchesTargetLiteral: boolean; causalIdentity: string }>;
	innerIdentity: { logConsistent: boolean; unknownBoundaryCount: number };
} {
	const { ack, innerLog, childWrites, targetGeometry, outerFrames, targetLiteralRows, targetCommitIndex } = input;
	const { records, logConsistent, unknownBoundaryCount } = buildInnerWriteRecords(innerLog);
	const innerIdentity = { logConsistent, unknownBoundaryCount };
	const rowsEqualLocal = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

	// Factual outer-commit records BEFORE the declared target commit. Their
	// timestamps are outer-observer parse/commit times; nothing here names an
	// inner close or render request as their cause.
	const outerCommitFacts = outerFrames
		.filter((o) => targetCommitIndex === null || o.index < targetCommitIndex)
		.map((o) => ({
			index: o.index,
			boundaryParsedAt: o.boundaryParsedAt,
			matchesTargetLiteral: rowsEqualLocal(o.rows, targetLiteralRows),
			causalIdentity: "unknown",
		}));

	const g2Write = childWrites.find((e) => e.frame === input.targetFrameId) ?? null;
	const counterexample: Record<string, unknown> = {
		frame: "G1",
		basis: "stale-seed",
		childWriteDims: childWrites.map((e) => ({ writeIndex: e.writeIndex, frame: e.frame, phase: e.phase, sha256: e.sha256 ?? null, dimsUsed: e.dimsUsed ?? null })),
		g2ComposedAt: g2Write?.dimsUsed ?? null,
		refutedPredicates: [] as string[],
	};

	const PROPOSED = [
		"the first matched inner synchronized-close (?2026l) after the applied resize ack attests a complete target-size child redraw",
		"an inner synchronized-open (?2026h) received after the applied resize ack was composed at post-resize geometry",
		"any inner parser drain after the applied resize ack attests a complete target-size child redraw",
	];
	const unknown = (id: string, proposed: string, reason: string, extra: Record<string, unknown> = {}): A4PredicateVerdict => ({
		id,
		proposed,
		verdict: "UNKNOWN",
		evidence: { reason, ...extra },
	});
	if (!ack) {
		return {
			predicates: PROPOSED.map((proposed, i) => unknown(`A4-P${i + 1}`, proposed, "no-applied-ack-anchor")),
			counterexample,
			outerCommitFacts,
			innerIdentity,
		};
	}
	if (!logConsistent) {
		return {
			predicates: PROPOSED.map((proposed, i) => unknown(`A4-P${i + 1}`, proposed, "inner-log-inconsistent")),
			counterexample,
			outerCommitFacts,
			innerIdentity,
		};
	}
	const ackAt = ack.at;
	// P16-EDGE-1 guard 1: a sha with MULTIPLE conflicting child writes is
	// ambiguous — never silently last-wins. Identical duplicates keep their
	// single identity; conflicting metadata (frame/phase/dimsUsed) makes every
	// identity-based witness unresolved and the affected predicates UNKNOWN.
	const childByShaList = new Map<string, A4ChildWriteFact[]>();
	for (const w of childWrites) {
		if (typeof w.sha256 !== "string") continue;
		const list = childByShaList.get(w.sha256) ?? [];
		list.push(w);
		childByShaList.set(w.sha256, list);
	}
	const resolveChild = (
		sha: string | null,
	): { status: "unique"; write: A4ChildWriteFact } | { status: "no-child-write-match" } | { status: "ambiguous-hash"; candidates: A4ChildWriteFact[] } => {
		if (sha === null) return { status: "no-child-write-match" };
		const list = childByShaList.get(sha) ?? [];
		if (list.length === 0) return { status: "no-child-write-match" };
		if (list.length > 1) {
			const identityOf = (w: A4ChildWriteFact) => JSON.stringify([w.frame ?? null, w.phase ?? null, w.dimsUsed ?? null]);
			if (list.some((w) => identityOf(w) !== identityOf(list[0]))) return { status: "ambiguous-hash", candidates: list };
		}
		return { status: "unique", write: list[0] };
	};

	/** Resolve one boundary/drain's write record to a witness. Geometry comes
	 *  from the child-logged dimsUsed only; frame ID is evidence, never a
	 *  rejection reason. */
	const witnessFor = (record: InnerWriteRecord | null, at: number, kind: "open" | "close" | "drain"): Record<string, unknown> => {
		if (!record) return { kind, at, role: "unresolved", identityStatus: "unknown-uninstrumented" };
		const resolved = resolveChild(record.sha256);
		if (resolved.status === "ambiguous-hash") {
			return {
				kind,
				at,
				role: "unresolved",
				identityStatus: "ambiguous-hash",
				writeSha256: record.sha256,
				candidates: resolved.candidates.map((w) => ({ writeIndex: w.writeIndex, frame: w.frame ?? null, phase: w.phase ?? null, dimsUsed: w.dimsUsed ?? null })),
			};
		}
		if (resolved.status === "no-child-write-match") {
			return { kind, at, role: "unresolved", identityStatus: "no-child-write-match", writeSha256: record.sha256 };
		}
		const childWrite = resolved.write;
		const dims = childWrite.dimsUsed;
		const dimsValid = dims && typeof dims.cols === "number" && typeof dims.rows === "number";
		const geometryMatch = dimsValid ? dims!.cols === targetGeometry.cols && dims!.rows === targetGeometry.rows : null;
		return {
			kind,
			at,
			role: geometryMatch === null ? "unresolved" : geometryMatch ? "consistent" : "counterexample",
			identityStatus: "unique",
			writeSha256: record.sha256,
			frame: childWrite.frame ?? null,
			phase: childWrite.phase ?? null,
			dimsUsed: dims ?? null,
			geometryMatch,
			...(geometryMatch === false
				? { geometryMismatch: { expected: { ...targetGeometry }, actual: { cols: dims!.cols, rows: dims!.rows } } }
				: {}),
		};
	};

	const consistentNote = "every resolved witness is non-refuting; a consistent individual witness is not a sufficiency proof for the universal production predicate";

	// P1: the FIRST matched inner close after the ack.
	const matchedCloses = innerLog.filter((e) => e.kind === "csi-close" && e.matched === true && e.at > ackAt);
	let p1: A4PredicateVerdict;
	if (matchedCloses.length === 0) {
		p1 = unknown("A4-P1", PROPOSED[0], "no-matched-close-after-ack");
	} else {
		const witnesses = matchedCloses.map((close) => witnessFor(recordOfBoundary(records, close), close.at, "close"));
		const first = witnesses[0];
		if (first.role === "counterexample") {
			p1 = {
				id: "A4-P1",
				proposed: PROPOSED[0],
				verdict: "REFUTED",
				evidence: {
					counterexample: { ...first, closeAt: first.at },
					witnesses,
					note: "the first matched inner close after the applied ack completed a frame composed at non-target geometry (retained write-sha identity); geometry mismatch, not frame-ID difference, is the refutation",
				},
			};
		} else if (first.role === "consistent") {
			p1 = {
				id: "A4-P1",
				proposed: PROPOSED[0],
				verdict: "CONSISTENT",
				evidence: { witnesses, note: consistentNote },
			};
		} else {
			p1 = unknown("A4-P1", PROPOSED[0], "close-identity-unresolved", { identityStatus: first.identityStatus, witnesses });
		}
	}

	// P2: post-ack inner opens (an existential claim: one stale open refutes).
	const opensAfterAck = innerLog.filter((e) => e.kind === "csi-open" && !e.alreadyOpen && e.at > ackAt);
	let p2: A4PredicateVerdict;
	if (opensAfterAck.length === 0) {
		p2 = unknown("A4-P2", PROPOSED[1], "no-open-after-ack");
	} else {
		const witnesses = opensAfterAck.map((open) => witnessFor(recordOfBoundary(records, open), open.at, "open"));
		const refuting = witnesses.find((w) => w.role === "counterexample");
		if (refuting) {
			p2 = {
				id: "A4-P2",
				proposed: PROPOSED[1],
				verdict: "REFUTED",
				evidence: {
					counterexample: { ...refuting, openAt: refuting.at },
					witnesses,
					note: "a post-ack open was parsed from a write the child composed at non-target (stale) geometry; a post-applied open is not a post-resize-layout proof",
				},
			};
		} else if (witnesses.some((w) => w.role === "unresolved")) {
			p2 = unknown("A4-P2", PROPOSED[1], "open-identity-unresolved", { witnesses });
		} else {
			p2 = { id: "A4-P2", proposed: PROPOSED[1], verdict: "CONSISTENT", evidence: { witnesses, note: consistentNote } };
		}
	}

	// P3: post-ack drains of CHILD-ORIGINATED writes (the predicate is about
	// child redraws). Guards (P16-EDGE-1): geometry participates (a closed
	// STALE frame is a counterexample, not CONSISTENT), and syncOpenAtDrain is
	// the actual ordered observed state across writes (a close-then-open write
	// drains while the parser is open). A drain that completed no matched close
	// inside its write cannot attest a complete redraw either.
	const childDrainsAfterAck = records.filter((r) => r.drainAt !== null && r.drainAt > ackAt && r.sha256 !== null && resolveChild(r.sha256).status !== "no-child-write-match");
	let p3: A4PredicateVerdict;
	if (childDrainsAfterAck.length === 0) {
		p3 = unknown("A4-P3", PROPOSED[2], "no-child-write-drain-after-ack");
	} else {
		const witnesses = childDrainsAfterAck.map((record) => {
			const resolved = resolveChild(record.sha256);
			if (resolved.status === "ambiguous-hash") {
				return {
					kind: "drain" as const,
					at: record.drainAt!,
					role: "unresolved" as const,
					identityStatus: "ambiguous-hash",
					writeSha256: record.sha256,
					candidates: resolved.candidates.map((w) => ({ writeIndex: w.writeIndex, frame: w.frame ?? null, phase: w.phase ?? null, dimsUsed: w.dimsUsed ?? null })),
					syncOpenAtDrain: record.syncOpenAtDrain,
				};
			}
			if (resolved.status !== "unique") {
				// Unreachable (the filter above excludes no-match), but narrow honestly.
				return { kind: "drain" as const, at: record.drainAt!, role: "unresolved" as const, identityStatus: resolved.status, writeSha256: record.sha256, syncOpenAtDrain: record.syncOpenAtDrain };
			}
			const childWrite = resolved.write;
			const matchedClosesInWrite = record.closes.filter((c) => c.matched === true).length;
			const dims = childWrite.dimsUsed;
			const dimsValid = dims && typeof dims.cols === "number" && typeof dims.rows === "number";
			const geometryMatch = dimsValid ? dims!.cols === targetGeometry.cols && dims!.rows === targetGeometry.rows : null;
			let role: "counterexample" | "consistent" | "unresolved";
			let refuteReason: string | null = null;
			if (matchedClosesInWrite === 0) {
				role = "counterexample";
				refuteReason = "no matched synchronized close completed in this write";
			} else if (record.syncOpenAtDrain) {
				role = "counterexample";
				refuteReason = "the parser was still inside a synchronized block at drain (ordered cross-write state)";
			} else if (geometryMatch === false) {
				role = "counterexample";
				refuteReason = "the closed frame was composed at non-target geometry";
			} else if (geometryMatch === null) {
				role = "unresolved";
			} else {
				role = "consistent";
			}
			return {
				kind: "drain" as const,
				at: record.drainAt!,
				role,
				refuteReason,
				identityStatus: "unique",
				writeSha256: record.sha256,
				frame: childWrite.frame ?? null,
				phase: childWrite.phase ?? null,
				dimsUsed: dims ?? null,
				syncOpenAtDrain: record.syncOpenAtDrain,
				matchedClosesInWrite,
				geometryMatch,
				...(geometryMatch === false
					? { geometryMismatch: { expected: { ...targetGeometry }, actual: { cols: dims!.cols, rows: dims!.rows } } }
					: {}),
			};
		});
		const refuting = witnesses.find((w) => w.role === "counterexample");
		if (refuting) {
			p3 = {
				id: "A4-P3",
				proposed: PROPOSED[2],
				verdict: "REFUTED",
				evidence: {
					counterexample: { ...refuting, drainAt: refuting.at },
					witnesses,
					note: "a child-originated post-ack drain completed no matched close, drained while the parser was still inside a synchronized block, or closed a frame at non-target geometry; drain completion carries no frame-completeness or geometry identity",
				},
			};
		} else if (witnesses.some((w) => w.role === "unresolved")) {
			p3 = unknown("A4-P3", PROPOSED[2], "drain-identity-unresolved", { witnesses });
		} else {
			p3 = { id: "A4-P3", proposed: PROPOSED[2], verdict: "CONSISTENT", evidence: { witnesses, note: consistentNote } };
		}
	}

	const predicates = [p1, p2, p3];
	counterexample.refutedPredicates = predicates.filter((p) => p.verdict === "REFUTED").map((p) => p.id);
	return { predicates, counterexample, outerCommitFacts, innerIdentity };
}

// ---- case A4: resize geometry --------------------------------------------

/**
 * A4 (spec §5.2 gate): complete old-size seed at the REAL host size
 * (120x28), a real attach-time mismatch to the 80x22 body, exactly one real
 * resize command with an applied ack, the child's ACTUAL observed PTY
 * resize, a deliberately stale old-geometry frame whose OPEN is emitted and
 * whose CLOSE drains AFTER the applied ack (counterexample), and finally a
 * complete literal target frame at 80x22. The challenged predicates below
 * are evaluated from parent-monotonic socket/inner-parser/outer-observer
 * facts; the child's dimsUsed/pty-resize events are independent test truth.
 */
export async function runCaseA4Trial(options: { artifactDir: string }): Promise<Record<string, unknown>> {
	const G = S16_GEOMETRY;
	const seedLiteral = s16GeometryRowsText("G0", G.hostCols, G.hostRows);
	const targetLiteral = s16GeometryRowsText("G2", G.bodyCols, G.bodyRows);
	const targetCursor = s16GeometryCursor("G2", G.bodyRows);
	const declared = {
		caseId: "A4",
		producerScript: "resize",
		hostSize: { cols: G.hostCols, rows: G.hostRows },
		attachSurface: { terminalCols: 80, terminalRows: 24, bodyCols: G.bodyCols, bodyRows: G.bodyRows },
		seedFrame: { id: "G0", basis: "live-pty-start", rows: seedLiteral },
		counterexampleFrame: {
			id: "G1",
			basis: "stale-seed",
			note: "composed at the stale 120x28 seed geometry; its OPEN is emitted and its CLOSE drains AFTER the applied resize ack but BEFORE any live-size redraw",
		},
		targetFrame: { id: "G2", basis: "live-pty", rows: targetLiteral, cursorWorkArea: targetCursor },
		challengedPredicates: [
			{ id: "A4-P1", proposed: "the first matched inner synchronized-close (?2026l) after the applied resize ack attests a complete target-size child redraw" },
			{ id: "A4-P2", proposed: "an inner synchronized-open (?2026h) received after the applied resize ack was composed at post-resize geometry" },
			{ id: "A4-P3", proposed: "any inner parser drain after the applied resize ack attests a complete target-size child redraw" },
		],
	};
	return withDiagTrial(
		{
			caseId: "A4",
			script: "resize",
			hostCols: G.hostCols,
			hostRows: G.hostRows,
			artifactDir: options.artifactDir,
			attachScreenLog: true,
			declared,
			// P16-DRAFT-ORDER: the G0 seed proof runs BEFORE the attach exists —
			// the mount's snapshotBegin resize cannot race the 120x28 capture.
			beforeMount: async (pre) => {
				let seedRows: string[] | null = null;
				let seedSeq: unknown = null;
				let seedBegin: Record<string, unknown> = {};
				const seedDeadline = now() + 8000;
				while (now() < seedDeadline) {
					const capture = await pre.probe.capture();
					if (capture.frame !== null) {
						seedRows = rtrimRows(await paintFrameAt(capture.frame, G.hostCols, G.hostRows));
						seedSeq = capture.begin.snapshotSeq;
						seedBegin = capture.begin;
						break;
					}
					await sleep(200);
				}
				pre.attachLog("seed-proof-captured-before-mount");
				const seedProof = {
					ok: seedRows !== null && rowsEqual(seedRows, seedLiteral),
					method: "runner-capture-replay at 120x28 (independent raw terminal), BEFORE the attach was mounted",
					begin: seedBegin,
					snapshotSeq: seedSeq,
					rows: seedRows,
					literalRows: seedLiteral,
				};
				if (!seedProof.ok) throw new Error(`A4 seed proof failed: ${JSON.stringify(seedProof.rows)}`);
				return { seedProof };
			},
		},
		async (h) => {
			// The REAL attach: snapshotBegin(120x28) mismatches the 80x22 body, so
			// the component sends ONE resize; the runner applies it synchronously.
			h.attachLog("a4-flow-begin");
			await waitFor(
				() => h.txMessages().some((m) => m.type === "resize") && h.rxMessages().some((m) => m.type === "cmd_ack" && m.msg.stage === "applied"),
				8000,
				"A4 resize command sent and applied ack received",
			);
			const resizeCommands = h.txMessages().filter((m) => m.type === "resize");
			const resizeAcks = h.rxMessages().filter((m) => m.type === "cmd_ack" && resizeCommands.some((c) => c.msg.commandId === m.msg.commandId));
			await waitFor(
				() => h.readChildEvents().some((e) => e.event === "pty-resize"),
				8000,
				"A4 child observed the real PTY resize",
			);
			const childResizeEvents = h.readChildEvents().filter((e) => e.event === "pty-resize");
			const resizeCommand = resizeCommands[0];
			const appliedAck = resizeAcks.find((m) => m.msg.stage === "applied") ?? null;
			const ackAt = appliedAck?.at ?? null;
			const resizeEvidence = {
				commands: resizeCommands.map((m) => ({ at: m.at, commandId: m.msg.commandId ?? null, cols: m.msg.cols, rows: m.msg.rows })),
				acks: resizeAcks.map((m) => ({ at: m.at, commandId: m.msg.commandId ?? null, stage: m.msg.stage, cols: m.msg.cols, rows: m.msg.rows })),
				childObserved: childResizeEvents.map((e) => ({ cols: e.cols, rows: e.rows, monoNs: e.monoNs, wallMs: e.wallMs })),
				exactlyOneTargetResize:
					resizeCommands.length === 1 &&
					appliedAck !== null &&
					appliedAck.msg.cols === G.bodyCols &&
					appliedAck.msg.rows === G.bodyRows &&
					childResizeEvents.some((e) => e.cols === G.bodyCols && e.rows === G.bodyRows),
				note: "command send and ack receipt are parent-monotonic socket facts with commandId identity; childObserved is the child's ACTUAL post-SIGWINCH dims (child clock, no common origin)",
			};

			// G1: an old-geometry frame whose OPEN is emitted and whose CLOSE
			// drains AFTER the applied ack, BEFORE any live-size redraw.
			h.sendChild({ cmd: "step", step: 1 });
			await h.holdMs("g1-open-stale", 250);
			h.sendChild({ cmd: "step", step: 2 });
			await h.holdMs("g1-closed-stale", 250);
			h.sendChild({ cmd: "step", step: 3 });
			const commit = await waitCommitRows(h.primary, targetLiteral, "A4 outer G2 (80x22 target) commit");
			const targetCommit = {
				committed: true,
				observationIndex: commit.index,
				boundaryParsedAt: commit.boundaryParsedAt,
				rows: projectedRows(commit),
				outerCursor: { ...commit.cursor },
				childLogicalCursor: targetCursor,
			};

			// --- counterexample + predicate evaluation through the SAME exported
			// pure seam the conditionfix tests pin (P16-COND-1/P16-CAUSE-1). ------
			const frames = h.primary.observer.observations.filter((o) => o.kind === "frame");
			const childWrites = h.readChildEvents().filter((e) => e.event === "stdout-write");
			const predicateAnalysis = analyzeA4Predicates({
				ack: appliedAck ? { at: appliedAck.at, commandId: appliedAck.msg.commandId, cols: appliedAck.msg.cols, rows: appliedAck.msg.rows } : null,
				innerLog: h.innerLog,
				childWrites: childWrites.map((e) => ({ writeIndex: e.writeIndex as number, frame: e.frame, phase: e.phase, bytes: e.bytes, sha256: e.sha256, dimsUsed: (e.dimsUsed as A4ChildWriteFact["dimsUsed"]) ?? null })),
				targetGeometry: { cols: G.bodyCols, rows: G.bodyRows },
				targetFrameId: "G2",
				outerFrames: frames.map((o) => ({ index: o.index, boundaryParsedAt: o.boundaryParsedAt, rows: projectedRows(o) })),
				targetLiteralRows: targetLiteral,
				targetCommitIndex: commit.index,
			});
			const predicates = predicateAnalysis.predicates.map((p, i) => ({ ...p, proposed: declared.challengedPredicates[i]?.proposed ?? p.proposed }));

			// Oracle/chrome evidence over the active window (teardown windows are
			// validated by the scaffold against teardownAllowedRowTexts below).
			const expectation = s16Expectation([s16ContentScreen("g2-complete", targetLiteral, ["G0", "G1", "G2"], targetCursor)], ["G0", "G1", "G2"]);
			const analysis = analyzeDiagSide(h.primary, expectation);

			await diagOrderedExit(h);
				// seedProof comes from the before-mount phase (merged by withDiagTrial).
			return {
				resizeEvidence,
				targetCommit,
				counterexample: predicateAnalysis.counterexample,
				predicates,
				oracle: {
					failures: analysis.failures,
					chromeViolations: analysis.chromeViolations,
					note: "intermediate non-contract frames (120x28 hydrate at 80x22, stale G1 partials) are EXPECTED oracle failures — they are the diagnostic evidence, not harness defects",
				},
				teardownAllowedRowTexts: [...targetLiteral, ...Object.values(HEADER_BY_STATUS), FOOTER_ROW],
			};
		},
	);
}

// ---- case A5: cold start with an empty authoritative baseline -------------

/**
 * A5 (spec §5.2 gate): empty authoritative baseline with a poisoned
 * historical screen.log, then explicit controlled release phases: unframed
 * boot text, alternate-screen + bracketed-paste enable (no editor content),
 * an INCOMPLETE framed editor held open >40ms, and finally the complete
 * literal E1 editor. Every production-observable candidate signal (first
 * committed content, raw-mode enable, any complete outer synchronized frame,
 * any inner drain) is evaluated against the independent literals.
 */
export async function runCaseA5Trial(options: { artifactDir: string }): Promise<Record<string, unknown>> {
	const editorLiteral = s16EditorRowsText("E1");
	const bootRowsLiteral: string[] = [...S16_BOOT_LINES];
	const loadingRowKeys = new Set(
		[LOADING_DETAILS.starting0, LOADING_DETAILS.starting1, LOADING_DETAILS.attached].flatMap((detail) =>
			SPINNERS.map((spinner) => JSON.stringify(loadingBodyRows({ spinner, detail }))),
		),
	);
	const declared = {
		caseId: "A5",
		producerScript: "cold",
		hostSize: { cols: 80, rows: 22 },
		poisonedScreenLog: S16_POISON_TEXT,
		phases: [
			{ step: 1, phase: "boot", kind: "unframed text", lines: [...S16_BOOT_LINES] },
			{ step: 2, phase: "input-mode", kind: "alt-screen enter + bracketed paste enable (no editor content, NOT an OS raw transition)" },
			{ step: 3, phase: "open", kind: "incomplete framed editor (upper half only, held >40ms)" },
			{ step: 4, phase: "closed", kind: "complete literal E1 editor" },
		],
		rawModeTruth: "the shared fixture footer sets stdin raw mode AT STARTUP; a cold-only stdin-raw-at-start event records the actual post-call state (null under non-TTY). Step 2 emits alt-screen/bracketed-paste bytes only.",
		targetFrame: { id: "E1", rows: editorLiteral, cursorWorkArea: S16_SURFACE_CURSOR },
		challengedPredicates: [
			{ id: "A5-P1", proposed: "the first committed outer content frame after an empty baseline is the session's editor working area" },
			{ id: "A5-P2", proposed: "the child's raw/bracketed-paste enable (childInputReady) attests a complete editor frame" },
			{ id: "A5-P3", proposed: "a complete outer synchronized frame attests the child completed a frame of its own" },
		],
	};
	return withDiagTrial(
		{
			caseId: "A5",
			script: "cold",
			hostCols: 80,
			hostRows: 22,
			artifactDir: options.artifactDir,
			attachScreenLog: true,
			poisonScreenLog: S16_POISON_TEXT,
			declared,
			// The empty authoritative baseline is proven by the REAL probe BEFORE
			// the attach exists (a capture cannot be a first-screen oracle; it is
			// the protocol-baseline fact only).
			beforeMount: async (pre) => {
				const capture = await pre.probe.capture();
				const emptyBaselineProof = {
					ok: capture.frame === null && capture.begin.empty === true,
					method: "real probe subscribe/capture BEFORE the attach was mounted",
					begin: capture.begin,
					end: capture.end,
					frame: capture.frame,
				};
				if (!emptyBaselineProof.ok) throw new Error(`A5 empty baseline proof failed: ${JSON.stringify(emptyBaselineProof)}`);
				pre.attachLog("empty-baseline-proven-before-mount");
				return { emptyBaselineProof };
			},
			// Active + teardown checks cover EVERY observation through child exit
			// and disposal; teardown uses a whole-grid rule (blank restored buffer
			// OR the exact literal E1 grid), not row membership. The poison scan
			// spans bootstrap, active, exit and teardown observations alike.
			postTeardown: (side, activeBoundary) => {
				const projectedAll = side.observer.observations.map((o) => {
					const p = projectObservationToWorkArea(o);
					return { ...p, grid: p.grid.map((row) => ({ ...row, text: row.text.replace(/\s+$/u, "") })) };
				});
				const active = projectedAll.slice(0, activeBoundary);
				const teardown = projectedAll.slice(activeBoundary);
				const expectation = s16Expectation(
					[s16ContentScreen("boot", bootRowsLiteral, []), s16ContentScreen("e1-complete", editorLiteral, ["E1"], S16_SURFACE_CURSOR)],
					["E1"],
				);
				const activeFailures = validateAttachPresentation(active, expectation);
				const chromeViolations: Array<{ index: number; violations: string[] }> = [];
				for (const o of side.observer.observations) {
					const violations = checkChromeRows(o);
					if (violations.length > 0) chromeViolations.push({ index: o.index, violations });
				}
				const teardownViolations: Array<Record<string, unknown>> = [];
				for (const o of teardown) {
					const rows = o.grid.map((r) => r.text);
					const blank = rows.every((t) => t === "");
					if (blank || rowsEqual(rows, editorLiteral)) continue;
					teardownViolations.push({ index: o.index, violation: "teardown-non-target-content", rows });
				}
				const poisonVisible = side.observer.observations.some((o) => o.grid.some((row) => row.text.includes("OLD-LOG-POISON")));
				return {
					activeBoundary,
					observationCounts: { total: projectedAll.length, active: active.length, teardown: teardown.length },
					activeFailures,
					chromeViolations,
					teardownViolations,
					teardownRule: "each post-dispose observation must be fully blank OR the exact literal E1 grid (whole-grid, not row membership); cursor visibility unconstrained at teardown",
					poison: {
						neverVisibleOnOuter: !poisonVisible,
						scanScope: "EVERY observation including bootstrap, active, exit and teardown windows",
					},
				};
			},
		},
		async (h) => {
			// The component's OWN view of the empty authoritative baseline — the
			// immediate rx observer retains the initial handshake/snapshot bytes.
			await waitFor(
				() => h.rxMessages().some((m) => m.type === "snapshot_begin" && m.msg.empty === true),
				8000,
				"A5 empty snapshot_begin on the component socket",
			);
			const componentBaseline = {
				snapshotBegin: h.rxMessages().find((m) => m.type === "snapshot_begin")?.msg ?? null,
				snapshotEnd: h.rxMessages().find((m) => m.type === "snapshot_end")?.msg ?? null,
				initialRxTypes: h.rxMessages().slice(0, 6).map((m) => m.type),
				note: "actual component-observed protocol identity (immediate rx observer; the accepted receive-context records independently retain the same initial messages)",
			};
			h.attachLog("empty-snapshot-begin-observed");

			// Phase 1: unframed boot text. The settle transition commits it as a
			// complete OUTER frame even though the child never emitted a frame.
			h.sendChild({ cmd: "step", step: 1 });
			await waitFor(
				() => h.primary.observer.observations.some((o) => o.kind === "frame" && o.grid.some((row) => row.text.includes(S16_BOOT_LINES[0]))),
				8000,
				"A5 boot text committed on the outer terminal",
			);
			const bootFrame = h.primary.observer.observations.find((o) => o.kind === "frame" && o.grid.some((row) => row.text.includes(S16_BOOT_LINES[0])))!;
			const bootCommit = {
				observationIndex: bootFrame.index,
				boundaryParsedAt: bootFrame.boundaryParsedAt,
				rows: projectedRows(bootFrame),
				isCompleteOuterSyncFrame: true,
				// Parent-received child byte history up to the boot commit: did ANY
				// output/snapshot payload carry a child sync-open delimiter?
				childSyncDelimiterBeforeCommit: h.rxMessages().some(
					(m) => (m.type === "output" || m.type === "snapshot_frame") && typeof m.msg.data === "string" && m.at <= bootFrame.boundaryParsedAt && (m.msg.data as string).includes("\x1b[?2026h"),
				),
			};

			// Phase 2: alt-screen + bracketed-paste enable. Record the flag's
			// ACTUAL state before the step — an already-true flag is recorded as
			// already true, never as 'became true due to step 2'.
			const readyBeforeStep2 = (h.primary.component as unknown as { childInputReady: boolean }).childInputReady === true;
			h.sendChild({ cmd: "step", step: 2 });
			let inputReadyAt: number | null = null;
			try {
				await waitFor(
					() => (h.primary.component as unknown as { childInputReady: boolean }).childInputReady === true,
					8000,
					"A5 childInputReady observed from live bracketed-paste enable",
				);
				inputReadyAt = now();
			} catch {
				inputReadyAt = null; // honest UNKNOWN — the flag never became true
			}
			const rawAtStartEvent = h.readChildEvents().find((e) => e.event === "stdin-raw-at-start") ?? null;
			const inputMode = {
				readyBeforeStep2,
				inputReadyAt,
				rawAtStart: rawAtStartEvent ? { isRaw: rawAtStartEvent.isRaw ?? null, monoNs: rawAtStartEvent.monoNs, wallMs: rawAtStartEvent.wallMs } : null,
				note: "private component flag read for flow/logging only — never oracle truth; rawAtStart is the child's actual stdin.isRaw observation after the shared footer's startup setRawMode (raw precedes boot/editor; step 2 is alt-screen/bracketed-paste bytes, not an OS raw transition)",
			};
			await h.holdMs("after-input-mode", 200);

			// Phase 3: incomplete framed editor, held open >40ms.
			h.sendChild({ cmd: "step", step: 3 });
			const openHoldStart = now();
			await h.holdMs("editor-open-hold", 400);
			const openHoldEnd = now();
			const partialExposure = h.primary.observer.observations.filter(
				(o) =>
					o.kind === "frame" &&
					o.boundaryParsedAt >= openHoldStart &&
					o.boundaryParsedAt <= openHoldEnd &&
					o.grid.some((row) => row.text.includes("E1 UPPER")) &&
					!o.grid.some((row) => row.text.includes("E1 TAIL")),
			);
			const incompleteEditorExposure = {
				verdict: partialExposure.length > 0 ? "REPRODUCED" : "NOT_REPRODUCED",
				exposedObservationIndices: partialExposure.map((o) => o.index),
				note:
					partialExposure.length > 0
						? "an output-driven outer render committed the partial open editor frame during the hold"
						: "no outer commit carried the partial editor during the open hold (missing exposure is NOT reproduced, not fabricated success)",
			};

			// Phase 4: complete literal editor.
			h.sendChild({ cmd: "step", step: 4 });
			const commit = await waitCommitRows(h.primary, editorLiteral, "A5 outer E1 editor commit");
			const editorCommit = {
				committed: true,
				observationIndex: commit.index,
				boundaryParsedAt: commit.boundaryParsedAt,
				rows: projectedRows(commit),
				outerCursor: { ...commit.cursor },
				childLogicalCursor: S16_SURFACE_CURSOR,
			};

			// Tri-state predicates from the observed facts only (no hardcoding):
			const allFrames = h.primary.observer.observations.filter((o) => o.kind === "frame");
			const firstContentFrame =
				allFrames.find((o) => {
					const rows = projectedRows(o);
					if (rows.every((t) => t === "")) return false;
					if (loadingRowKeys.has(JSON.stringify(rows))) return false;
					return true;
				}) ?? null;
			const firstContentRows = firstContentFrame ? projectedRows(firstContentFrame) : null;
			const firstContentIdentity =
				firstContentRows === null
					? null
					: rowsEqual(firstContentRows, editorLiteral)
						? "editor"
						: firstContentRows[0] === S16_BOOT_LINES[0] && firstContentRows[1] === S16_BOOT_LINES[1] && firstContentRows.slice(2).every((t) => t === "")
							? "boot"
							: "other";
			const predicates = [
				{
					id: "A5-P1",
					proposed: declared.challengedPredicates[0].proposed,
					verdict:
						firstContentIdentity === null
							? "UNKNOWN"
							: firstContentIdentity === "editor"
								? "CONSISTENT"
								: "REFUTED",
					evidence: {
						reason: firstContentIdentity === null ? "no-content-frame-observed" : undefined,
						firstContentFrameIndex: firstContentFrame?.index ?? null,
						firstContentIdentity,
						firstContentRows,
						note:
							firstContentIdentity === "boot"
									? "the first committed content is the declared BOOT text, not the editor — first content cannot attest editor readiness"
									: firstContentIdentity === "editor"
										? "the first content was the editor here; a single consistent witness is not a sufficiency proof"
										: "the first content was neither the declared boot nor the editor (actual rows retained)",
					},
				},
				{
					id: "A5-P2",
					proposed: declared.challengedPredicates[1].proposed,
					verdict:
						inputReadyAt === null
							? "UNKNOWN"
							: readyBeforeStep2 || inputReadyAt < editorCommit.boundaryParsedAt
								? "REFUTED"
								: "CONSISTENT",
					evidence: {
						reason: inputReadyAt === null ? "childInputReady-never-observed" : undefined,
						readyBeforeStep2,
						inputReadyAt,
						editorCommitAt: editorCommit.boundaryParsedAt,
						rawAtStart: inputMode.rawAtStart,
						note: readyBeforeStep2
							? "the flag was ALREADY true before the mode-enable step (recorded as already true); it cannot attest a later editor frame"
							: "the flag became true at the bracketed-paste enable, strictly BEFORE the editor frame existed; the outer surface still showed boot text at that moment",
					},
				},
				{
					id: "A5-P3",
					proposed: declared.challengedPredicates[2].proposed,
					verdict:
						bootCommit.childSyncDelimiterBeforeCommit === false
							? "REFUTED"
							: bootCommit.childSyncDelimiterBeforeCommit === true
								? "CONSISTENT"
								: "UNKNOWN",
					evidence: {
						bootFrameIndex: bootCommit.observationIndex,
						childSyncDelimiterBeforeCommit: bootCommit.childSyncDelimiterBeforeCommit,
						partialEditorExposure: incompleteEditorExposure,
						note:
							bootCommit.childSyncDelimiterBeforeCommit === false
									? "the boot commit is a complete OUTER synchronized frame produced by the outer TUI's own render scheduling while the parent-received child byte history carried NO sync-open delimiter; an outer close boundary cannot attest child frame completeness"
									: "the child byte history is inconclusive for this witness here; CONSISTENT/UNKNOWN as recorded, never a sufficiency proof",
					},
				},
			];

			await diagOrderedExit(h);
			return {
				componentBaseline,
				bootCommit,
				inputMode,
				incompleteEditorExposure,
				editorCommit,
				predicates,
			};
		},
	);
}

// ---- case T: timely / late real color replies -------------------------------

const TERMINAL_QUERY_MARKER = "\x1b]11;?";
const DA1_REPLY = "\x1b[?1;2c";
const OSC11_DARK_REPLY = "\x1b]11;rgb:0000/0000/0000\x07";
const OSC11_LIGHT_REPLY = "\x1b]11;rgb:ffff/ffff/ffff\x07";

/**
 * T (spec A9/T matrix row): same-size complete baseline (zero-resize
 * control), the REAL 500ms settle color probe on the outer terminal, and a
 * terminal-emulator reply injected through the REAL TUI input callback
 * (observer.inputHandler — the callback TUI.start() registered). On-time:
 * background+DA1 complete the query before the timeout. Late: the reply
 * arrives only AFTER the ACTUAL 500ms query timeout and completes through
 * the same real parser via onLateReply. The component's 997 report delivery
 * to the fixture child and the child-originated theme redraw are recorded
 * across all four timing layers.
 */
export async function runCaseTTrial(options: { artifactDir: string; timing: "on-time" | "late" }): Promise<Record<string, unknown>> {
	const timing = options.timing;
	const seedLiteral = s16ThemeRowsText("T0", "pending");
	const scheme = timing === "late" ? "light" : "dark";
	const report = timing === "late" ? "997;2" : "997;1";
	const replyBytes = timing === "late" ? OSC11_LIGHT_REPLY : OSC11_DARK_REPLY;
	const redrawLiteral = s16ThemeRowsText("T1", `${scheme} applied`);
	const loadingRowKeys = new Set(
		[LOADING_DETAILS.starting0, LOADING_DETAILS.starting1, LOADING_DETAILS.attached].flatMap((detail) =>
			SPINNERS.map((spinner) => JSON.stringify(loadingBodyRows({ spinner, detail }))),
		),
	);
	const declared = {
		caseId: `T-${timing}`,
		producerScript: "theme",
		hostSize: { cols: 80, rows: 22 },
		seedFrame: { id: "T0", rows: seedLiteral, note: "seed enables the alternate screen AND bracketed paste in the same write; the authoritative hydrate scan sets the component's input-readiness flag (pty-attach.ts:1803)" },
		reply: { timing, backgroundReplyHex: Buffer.from(replyBytes, "utf8").toString("hex"), da1Hex: Buffer.from(DA1_REPLY, "utf8").toString("hex") },
		expectedReport: report,
		redrawFrame: { id: "T1", rows: redrawLiteral, cursorWorkArea: S16_SURFACE_CURSOR },
		probeTimeoutMs: 500,
		classification: "full literal rows + cursor via the accepted oracle; loading only by exact loading literals; unrecognized states are unknown, never 'other means loading'",
	};
	return withDiagTrial(
		{
			caseId: `T-${timing}`,
			script: "theme",
			hostCols: 80,
			hostRows: 22,
			artifactDir: options.artifactDir,
			attachScreenLog: true,
			frameWitness: formalMeasurementVersion() === "candidate",
			declared,
			// Seed proof through the REAL subscribe/capture path BEFORE the attach
			// exists (mount-time facts cannot race it).
			beforeMount: async (pre) => {
				let seedRows: string[] | null = null;
				const seedDeadline = now() + 8000;
				while (now() < seedDeadline) {
					const capture = await pre.probe.capture();
					if (capture.frame !== null) {
						seedRows = rtrimRows(await paintFrameAt(capture.frame, 80, 22));
						break;
					}
					await sleep(200);
				}
				const seedProof = {
					ok: seedRows !== null && rowsEqual(seedRows, seedLiteral),
					method: "runner-capture-replay at 80x22 (independent raw terminal), BEFORE the attach was mounted",
					rows: seedRows,
					literalRows: seedLiteral,
				};
				if (!seedProof.ok) throw new Error(`T-${timing} seed proof failed: ${JSON.stringify(seedProof.rows)}`);
				pre.attachLog("seed-proof-captured-before-mount");
				return { seedProof };
			},
			// Stage-correct coverage through exit and disposal: active oracle over
			// the full chrome/work-area contract, then the source-grounded stop
			// stage (exact EXIT_ALT_SCREEN write identity; full 24-row document
			// layout with the cursor part of the stop contract).
			postTeardown: (side) =>
				analyzeStagedObservations({
					observations: side.observer.observations,
					writes: side.observer.writes,
					finalContentRows: redrawLiteral,
					activeExpectation: s16Expectation(
						[s16ContentScreen("t0-complete", seedLiteral, ["T0"], S16_SURFACE_CURSOR), s16ContentScreen("t1-complete", redrawLiteral, ["T1"], S16_SURFACE_CURSOR)],
						["T0", "T1"],
					),
				}),
		},
		async (h) => {
			// Same-size control: the attach must send ZERO resize commands.
			const seedCommit = await waitCommitRows(h.primary, seedLiteral, `T-${timing} outer T0 commit`);
			const zeroResize = {
				ok: h.txMessages().every((m) => m.type !== "resize"),
				resizeCommands: h.txMessages().filter((m) => m.type === "resize"),
			};
			// The component's own protocol identity for the seed baseline.
			const componentBaseline = {
				snapshotBegin: h.rxMessages().find((m) => m.type === "snapshot_begin")?.msg ?? null,
				snapshotEnd: h.rxMessages().find((m) => m.type === "snapshot_end")?.msg ?? null,
				initialRxTypes: h.rxMessages().slice(0, 6).map((m) => m.type),
			};
			// Actual input-readiness flag facts (read-only, never written).
			const inputReadyBeforeReply = (h.primary.component as unknown as { childInputReady: boolean }).childInputReady === true;

			// The settle transition runs the REAL color probe: the query bytes
			// leave through tui.terminal.write (the observer's write log). Record
			// ALL candidate query writes; with exactly one the identity is the
			// attach probe, with several it stays explicitly ambiguous.
			await waitFor(
				() => h.primary.observer.writes.some((w) => w.data.includes(TERMINAL_QUERY_MARKER)),
				8000,
				`T-${timing} real color query written to the outer terminal`,
			);
			const queryWrites = h.primary.observer.writes.filter((w) => w.data.includes(TERMINAL_QUERY_MARKER));
			const colorQuery = {
				candidates: queryWrites.map((w) => ({ writeIndex: w.index, at: w.receivedAt })),
				identity: queryWrites.length === 1 ? "attach-settle-probe (sole candidate)" : "ambiguous-multiple-candidates",
			};

			// Inject the terminal-emulator reply through the REAL TUI input
			// callback (never a fabricated late callback, never a resolved stub).
			const inputHandler = h.primary.observer.inputHandler;
			if (!inputHandler) throw new Error("observer captured no real TUI input handler");
			const schemeDiagAt = () =>
				h.actions
					.filter((a) => a.type === "diagnostic" && (a.detail as { code?: string })?.code === "attach_settle_scheme")
					.map((a) => ({ receiptAt: a.at, details: (a.detail as { details?: Record<string, unknown> }).details ?? {} }));
			let timeoutWait: Record<string, unknown> | null = null;
			if (timing === "late") {
				// Wait out the ACTUAL 500ms production query timeout; the timeout
				// outcome diagnostic's CALLBACK RECEIPT time is the exact
				// log-and-delegate fact (the sampling wait is only an upper bound).
				const waitStart = now();
				await waitFor(() => schemeDiagAt().some((d) => d.details.outcome === "timeout"), 4000, "T-late actual 500ms query timeout diagnostic");
				const timeoutDiag = schemeDiagAt().find((d) => d.details.outcome === "timeout")!;
				timeoutWait = {
					waitedMsUpperBound: now() - waitStart,
					timeoutDiagnosticReceiptAt: timeoutDiag.receiptAt,
					note: "the diagnostic receipt timestamp is the exact log-and-delegate callback fact; waitedMs is a polling upper bound",
				};
			}
			const injectAt = now();
			inputHandler(replyBytes);
			inputHandler(DA1_REPLY);
			h.attachLog("terminal-reply-injected");

			// The 997 report must reach the fixture child through the real
			// component socket and trigger the child-originated complete redraw.
			await waitFor(
				() => h.txMessages().some((m) => m.type === "input" && typeof m.msg.data === "string" && (m.msg.data as string).includes("997;")),
				8000,
				`T-${timing} 997 report delivered on the component socket`,
			);
			const deliveryMessages = h.txMessages().filter((m) => m.type === "input" && typeof m.msg.data === "string" && (m.msg.data as string).includes("997;"));
			await waitFor(
				() => h.readChildEvents().some((e) => e.event === "theme-report"),
				8000,
				`T-${timing} child theme-report event`,
			);
			const themeReports = h.readChildEvents().filter((e) => e.event === "theme-report");
			const redrawCommit = await waitCommitRows(h.primary, redrawLiteral, `T-${timing} outer T1 theme redraw commit`);
			// Bounded post-redraw watch (diagnostic coverage, not the later formal
			// 3s matrix window).
			await h.holdMs("post-redraw-watch", 300);
			const observation = await holdFormalObservation(now, sleep, `T-${timing}`);

			// Full-literal classification of every observation after first
			// content: t0/t1 only on EXACT literal row matches, loading only on
			// exact loading literals, blank when blank, otherwise unknown.
			const classify = (o: (typeof h.primary.observer.observations)[number]) => {
				const rows = projectedRows(o);
				if (rowsEqual(rows, redrawLiteral)) return "t1-complete";
				if (rowsEqual(rows, seedLiteral)) return "t0-complete";
				if (loadingRowKeys.has(JSON.stringify(rows))) return "loading";
				if (rows.every((t) => t === "")) return "blank";
				return "unknown";
			};
			const framesAfterSeedCommit = h.primary.observer.observations
				.filter((o) => o.index > seedCommit.index)
				.map((o) => ({ index: o.index, kind: o.kind, boundaryParsedAt: o.boundaryParsedAt, cursor: { ...o.cursor }, identity: classify(o) }));
			const childRepaintWrites = h.readChildEvents().filter((e) => e.event === "stdout-write" && e.phase === "theme-repaint");
			const schemeDiagnostics = schemeDiagAt();

			await diagOrderedExit(h);
			const t1Commits = framesAfterSeedCommit.filter((f) => f.kind === "frame" && f.identity === "t1-complete");
			const anomalous = framesAfterSeedCommit.filter((f) => f.identity === "loading" || f.identity === "unknown");
			const predicates = [
				{
					id: `T-${timing}-P1`,
					proposed: "a (timely or late) real color reply is followed by a child-originated complete synchronized theme redraw committed on the outer terminal",
					verdict:
						themeReports.length === 0 && deliveryMessages.length === 0
							? "UNKNOWN"
							: themeReports.length >= 1 && t1Commits.length >= 1
								? "CONSISTENT"
								: "REFUTED",
					evidence: {
						deliveryCount: deliveryMessages.length,
						themeReportCount: themeReports.length,
						childRepaintWriteCount: childRepaintWrites.length,
						t1CommitCount: t1Commits.length,
						totalCommitsAfterFirstContent: framesAfterSeedCommit.filter((f) => f.kind === "frame").length,
						note: "counts are reported separately; exactly-one outer render is NOT a product requirement (status/ticker/input scheduling may repaint an identical valid view). A single consistent witness is not a sufficiency proof.",
					},
				},
				{
					id: `T-${timing}-P2`,
					proposed: "the color reply path re-opens the loading state or commits an unidentified frame after first content",
					verdict: anomalous.length > 0 ? "CONSISTENT" : "REFUTED",
					evidence: {
						anomalousFrames: anomalous,
						note:
							anomalous.length > 0
								? "the reply path produced loading/unidentified post-content frames (recorded with raw observations)"
								: "no loading reappearance and no unidentified frame after first content (REFUTED = the bad behavior was not observed)",
					},
				},
			];
			return {
				componentBaseline,
				zeroResize,
				inputReadyFacts: { childInputReadyBeforeReply: inputReadyBeforeReply, note: "authoritative hydrate scan sets the flag (pty-attach.ts:1803); read-only observation, never written" },
				colorQuery,
				timeoutWait,
				reply: { timing, injectedAt: injectAt, backgroundReplyHex: declared.reply.backgroundReplyHex, da1Hex: declared.reply.da1Hex },
				delivery: {
					messages: deliveryMessages.map((m) => ({ at: m.at, dataHas997: (m.msg.data as string).includes("997;"), report: (m.msg.data as string).includes(report) ? report : `UNEXPECTED:${JSON.stringify(m.msg.data)}` })),
					childThemeReports: themeReports.map((e) => ({ scheme: e.scheme, monoNs: e.monoNs, wallMs: e.wallMs })),
				},
				themeRedraw: {
					committed: true,
					observationIndex: redrawCommit.index,
					boundaryParsedAt: redrawCommit.boundaryParsedAt,
					rows: projectedRows(redrawCommit),
					outerCursor: { ...redrawCommit.cursor },
					childLogicalCursor: S16_SURFACE_CURSOR,
					childRepaintWrites: childRepaintWrites.map((e) => ({ writeIndex: e.writeIndex, frame: e.frame, bytes: e.bytes, sha256: e.sha256, monoNs: e.monoNs, wallMs: e.wallMs })),
				},
				postFirstContentCommits: framesAfterSeedCommit,
				schemeDiagnostics,
				predicates,
				observation: observation ?? null,
				themeCompletion: observation === null ? "not-applicable" : "completed",
			};
		},
	);
}

// ---- step-17 fix1 cases: two independent session-generation instances ------

/**
 * GEN-<n> (step 17 fix1, ruling I-1): one INDEPENDENT generation instance —
 * an owned real runner hosting the dedicated session-generation fixture child
 * at 80x22, its own per-trial root/socket/artifacts, a screen.log poisoned
 * with the OTHER generation's complete literal F1 content, and a real primary
 * attach. The trial proves, independently of any other case: the CURRENT
 * generation baseline (literal gen F0 seed) through the real probe BEFORE the
 * attach exists; the first displayed content frame belongs to the current
 * generation/baseline (never the poisoned old generation); the eventual F1
 * commit is the literal current-generation target; no observation ever shows
 * the old-generation token (active AND teardown/stop stages); the poison
 * plant is non-vacuous (evaluatePoisonPlant over plant readback + retained
 * log); and owned cleanup records known pids/exit status/forced kills/root
 * disposition. No candidate ready flag is read as truth; oracle/chrome/cursor
 * checks are the unchanged accepted ones. If old product behavior surfaces
 * the poison, that is RETAINED evidence — the oracle is never weakened.
 */
export async function runCaseGenerationTrial(options: { caseId: string; generation: string; poisonGeneration: string; artifactDir: string }): Promise<Record<string, unknown>> {
	const gen = options.generation;
	const oldGen = options.poisonGeneration;
	const seedLiteral = s17GenerationRowsText(gen, "F0");
	const targetLiteral = s17GenerationRowsText(gen, "F1");
	const poisonText = s17GenerationPoisonText(oldGen);
	const loadingRowKeys = new Set(
		[LOADING_DETAILS.starting0, LOADING_DETAILS.starting1, LOADING_DETAILS.attached].flatMap((detail) =>
			SPINNERS.map((spinner) => JSON.stringify(loadingBodyRows({ spinner, detail }))),
		),
	);
	const declared = {
		caseId: options.caseId,
		producerFixture: "test-support/fake-pty-generation-pi.mjs",
		sessionGeneration: gen,
		poisonGeneration: oldGen,
		hostSize: { cols: 80, rows: 22 },
		seedFrame: { id: "F0", rows: seedLiteral, cursorWorkArea: s17GenerationCursor(gen, "F0") },
		targetFrame: { id: "F1", rows: targetLiteral, cursorWorkArea: s17GenerationCursor(gen, "F1") },
		poisonedScreenLog: { generation: oldGen, note: "the OTHER generation's complete literal F1 content; the old generation must never be displayed" },
		note: "generation identity is visible content (`<generation> <frame-id>` marker rows) plus the child event log's per-event generation stamp; no candidate ready flag is used as truth",
	};
	return withDiagTrial(
		{
			caseId: options.caseId,
			hostCols: 80,
			hostRows: 22,
			artifactDir: options.artifactDir,
			attachScreenLog: true,
			poisonScreenLog: poisonText,
			childPath: resolve(REPO_ROOT, "test-support/fake-pty-generation-pi.mjs"),
			childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_GENERATION: gen, FAKE_PTY_EVENTS_PATH: eventsPath }),
			declared,
			// Current-generation baseline proof BEFORE the attach exists.
			beforeMount: async (pre) => {
				let seedRows: string[] | null = null;
				const seedDeadline = now() + 8000;
				while (now() < seedDeadline) {
					const capture = await pre.probe.capture();
					if (capture.frame !== null) {
						seedRows = rtrimRows(await paintFrameAt(capture.frame, 80, 22));
						break;
					}
					await sleep(200);
				}
				const seedProof = {
					ok: seedRows !== null && rowsEqual(seedRows, seedLiteral),
					method: "runner-capture-replay at 80x22 (independent raw terminal), BEFORE the attach was mounted",
					generation: gen,
					rows: seedRows,
					literalRows: seedLiteral,
				};
				if (!seedProof.ok) throw new Error(`${options.caseId} current-generation seed proof failed: ${JSON.stringify(seedProof.rows)}`);
				pre.attachLog("current-generation-baseline-proven-before-mount");
				return { seedProof };
			},
			postTeardown: (side) =>
				analyzeStagedObservations({
					observations: side.observer.observations,
					writes: side.observer.writes,
					finalContentRows: targetLiteral,
					activeExpectation: s16Expectation(
						[
							s16ContentScreen("f0-current-generation", seedLiteral, ["F0"], s17GenerationCursor(gen, "F0")),
							s16ContentScreen("f1-current-generation", targetLiteral, ["F1"], s17GenerationCursor(gen, "F1")),
						],
						["F0", "F1"],
					),
					// The OLD generation token must never appear on the outer
					// terminal — in ANY observation (bootstrap, active, exit, stop).
					forbiddenMarker: `${oldGen} `,
				}),
		},
		async (h) => {
			// First displayed content must belong to the CURRENT generation
			// baseline — checked independently of the eventual F1 commit.
			const seedCommit = await waitCommitRows(h.primary, seedLiteral, `${options.caseId} outer current-generation F0 commit`);
			const firstContentFrame =
				h.primary.observer.observations.find((o) => {
					if (o.kind !== "frame") return false;
					const rows = projectedRows(o);
					if (rows.every((text) => text === "")) return false;
					if (loadingRowKeys.has(JSON.stringify(rows))) return false;
					return true;
				}) ?? null;
			const firstContentRows = firstContentFrame ? projectedRows(firstContentFrame) : null;
			const firstContent = {
				observationIndex: firstContentFrame?.index ?? null,
				rows: firstContentRows,
				belongsToCurrentGeneration: firstContentRows !== null && rowsEqual(firstContentRows, seedLiteral),
				containsOldGeneration: firstContentRows !== null && firstContentRows.some((text) => text.includes(`${oldGen} `)),
				note: "the FIRST non-loading non-blank content frame is checked against the declared current-generation baseline literal — not the eventual target and not any ready flag",
			};

			// Advance to the current-generation F1 target through the real input path.
			h.sendChild({ cmd: "step", step: 1 });
			const commit = await waitCommitRows(h.primary, targetLiteral, `${options.caseId} outer current-generation F1 commit`);
			const targetCommit = {
				committed: true,
				observationIndex: commit.index,
				boundaryParsedAt: commit.boundaryParsedAt,
				rows: projectedRows(commit),
				outerCursor: { ...commit.cursor },
				childLogicalCursor: s17GenerationCursor(gen, "F1"),
			};

			// Generation identity in the child's OWN event evidence: every event
			// carries this generation's token; write shas match the received stream.
			const childEvents = h.readChildEvents();
			const generationEvidence = {
				childEvents: childEvents.length,
				allEventsCarryGeneration: childEvents.length > 0 && childEvents.every((e) => e.generation === gen),
				seedEvent: childEvents.find((e) => e.event === "stdout-write" && e.phase === "seed") ?? null,
				note: "child-clock emission facts; frame ids (F0/F1) are frame-local, the generation token is the separate session dimension",
			};

			await diagOrderedExit(h);
			return {
				seedCommit: { observationIndex: seedCommit.index, boundaryParsedAt: seedCommit.boundaryParsedAt },
				firstContent,
				targetCommit,
				generationEvidence,
				teardownAllowedRowTexts: [...targetLiteral, ...Object.values(HEADER_BY_STATUS), FOOTER_ROW],
			};
		},
	);
}

// ---- step-16 case dispatcher --------------------------------------------------

const S16_CASES = new Set(["A4", "A5", "T-on-time", "T-late"]);
// Step 17 fix1: two independent generation instances (GEN-1 poisoned with the
// gen-2 literal, GEN-2 poisoned with the gen-1 literal).
const S17_GEN_CASES = new Map([
	["GEN-1", { generation: "gen-1", poisonGeneration: "gen-2" }],
	["GEN-2", { generation: "gen-2", poisonGeneration: "gen-1" }],
]);

/** One bounded step-16 diagnostic invocation: exclusive per-trial artifact
 *  dir, append-only invocation index, per-invocation result file. */
export async function runCaseDiag(options: { caseId: string; artifactDir: string }): Promise<Record<string, unknown>> {
	const { caseId, artifactDir } = options;
	mkdirSync(artifactDir, { recursive: true });
	const scenarioHash = sha256File(join(REPO_ROOT, "test-support/pty-attach-ready-scenario.ts"));
	const invocationId = `inv-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
	appendInvocation(artifactDir, {
		kind: "begin",
		invocationId,
		at: new Date().toISOString(),
		caseId,
		repeat: 1,
		clock: "real",
		pid: process.pid,
		scenarioHash,
		environment: environmentInfo(scenarioHash),
	});
	const trialDir = join(artifactDir, `trial-${caseId.toLowerCase()}`);
	appendInvocation(artifactDir, { kind: "trial-begin", invocationId, at: new Date().toISOString(), caseId, trialDir });
	let record: Record<string, unknown>;
	try {
		const genCase = S17_GEN_CASES.get(caseId);
		if (caseId === "A4") record = await runCaseA4Trial({ artifactDir: trialDir });
		else if (caseId === "A5") record = await runCaseA5Trial({ artifactDir: trialDir });
		else if (genCase) record = await runCaseGenerationTrial({ caseId, artifactDir: trialDir, ...genCase });
		else record = await runCaseTTrial({ artifactDir: trialDir, timing: caseId === "T-late" ? "late" : "on-time" });
	} catch (err) {
		// The trial preserves its own failure artifacts; a throw here means the
		// attempt dir could not even be created — record it without losing it.
		record = { ok: false, caseId, artifactDir: trialDir, error: err instanceof Error ? err.stack ?? err.message : String(err) };
	}
	appendInvocation(artifactDir, { kind: "trial-end", invocationId, at: new Date().toISOString(), caseId, ok: record.ok });
	const result: Record<string, unknown> = {
		ok: record.error === null || record.error === undefined,
		caseId,
		repeat: 1,
		clock: "real",
		invocationId,
		environment: environmentInfo(scenarioHash),
		trials: [record],
		artifactRoot: artifactDir,
	};
	appendInvocation(artifactDir, { kind: "end", invocationId, at: new Date().toISOString(), ok: result.ok });
	writeFileSync(join(artifactDir, `result-${invocationId}.json`), JSON.stringify(result, null, 2));
	return result;
}

// ---------------------------------------------------------------------------
// CLI surface (approved): --case <S|A4|A5|T-on-time|T-late|GEN-1|GEN-2>
// --repeat 1 --clock real --artifact-dir <owned path>. Anything else fails
// explicitly (stderr + exit 2, no dummy success). A valid invocation runs the
// case through the real-runner seam and prints exactly one JSON result line.
// ---------------------------------------------------------------------------

function cliError(message: string): never {
	process.stderr.write(`pty-attach-ready-scenario: ${message}\n`);
	process.exit(2);
}

export function parseCli(argv: string[]): {
	caseId: string;
	repeat: number;
	clock: string;
	artifactDir: string;
	variant?: "plain" | "same-write" | "split";
	entry?: "ticker" | "status" | "capture";
} {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith("--") || i + 1 >= argv.length) cliError(`malformed arguments: ${argv.join(" ")}`);
		args.set(argv[i].slice(2), argv[i + 1]);
	}
	const caseId = args.get("case") ?? cliError("missing --case");
	// Step-16 final theme checkpoint wired S, A4, A5, T-on-time and T-late;
	// step 17 fix1 adds the two generation instances GEN-1/GEN-2.
	// Bare "T" and any other ID remain unsupported.
	if (caseId !== "S" && !S16_CASES.has(caseId) && !S17_GEN_CASES.has(caseId)) {
		cliError(`unsupported --case ${JSON.stringify(caseId)} (only S, A4, A5, T-on-time, T-late, GEN-1 and GEN-2 are implemented)`);
	}
	const repeat = Number(args.get("repeat") ?? cliError("missing --repeat"));
	if (repeat !== 1) cliError(`unsupported --repeat ${JSON.stringify(args.get("repeat"))} (only 1 is implemented)`);
	const clock = args.get("clock") ?? cliError("missing --clock");
	if (clock !== "real") cliError(`unsupported --clock ${JSON.stringify(clock)} (only "real" is implemented)`);
	const artifactDir = args.get("artifact-dir") ?? cliError("missing --artifact-dir");
	const variant = args.get("variant");
	const entry = args.get("entry");
	if ((variant === undefined) !== (entry === undefined)) cliError("--variant and --entry must be supplied together");
	if (variant !== undefined && caseId !== "S") cliError("--variant/--entry are only supported with --case S");
	if (variant !== undefined && !["plain", "same-write", "split"].includes(variant)) cliError(`unsupported --variant ${JSON.stringify(variant)}`);
	if (entry !== undefined && !["ticker", "status", "capture"].includes(entry)) cliError(`unsupported --entry ${JSON.stringify(entry)}`);
	return { caseId, repeat, clock, artifactDir, ...(variant !== undefined ? { variant: variant as "plain" | "same-write" | "split", entry: entry as "ticker" | "status" | "capture" } : {}) };
}

const isMain = (() => {
	try {
		return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
	} catch {
		return false;
	}
})();

if (isMain) {
	const cli = parseCli(process.argv.slice(2));
	const run = cli.caseId === "S"
		? runCaseS({ artifactDir: cli.artifactDir, ...(cli.variant !== undefined ? { variant: cli.variant, entry: cli.entry } : {}) })
		: runCaseDiag({ caseId: cli.caseId, artifactDir: cli.artifactDir });
	run
		.then((result) => {
			process.stdout.write(JSON.stringify(result) + "\n");
			process.exit(0);
		})
		.catch((err) => {
			process.stderr.write(`pty-attach-ready-scenario: battery harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exit(1);
		});
}
