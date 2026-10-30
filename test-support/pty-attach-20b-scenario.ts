// Issue #222 step 20B (task-20b-brief.md): R-reconnect / R-restart / U-unframed
// / U-legacy / D deterministic+30-leak. This file ADDS the 20B cells on top of
// the accepted 20A matrix; it never reruns or weakens 20A. All cases use the
// REAL runner/pty-runner.mjs + REAL PtyAttachComponent + REAL TuiAltScreen +
// the accepted AttachPresentationObserver. Truth is independent: child
// generation/event logs and observer grids/cursor, never a private ready flag.
//
// Cells:
// - R-reconnect: same generation, real short socket disconnect + automatic
//   reconnect to the SAME owned runner/child.
// - R-restart: intentional OLD owned runner/child kill (a scenario action,
//   separate from cleanup.forcedKills) then a FRESH generation runner on the
//   same socket path; empty new baseline invalidates the old generation.
// - U-unframed: real runner/child with live output containing NO synchronized
//   markers; prove raw bytes have no ?2026h/l and a raw observer records only
//   `unframed`; eventual content/cursor checked, no whole-frame guarantee.
// - U-legacy: force legacy via AGENT_BOARD_TERMINAL_SNAPSHOT=0 ONLY inside this
//   process; record the setting and the actual legacy jiggle resize; restore.
// - D: deterministic lifecycle + opt-in `--repeat 30` leak check with per-trial
//   before/after resources and zero post-close publish.
//
// CLI: --case R-reconnect|R-restart|U-unframed|U-legacy|D --repeat N --clock
// real --artifact-dir <owned path>. Unsupported cases fail explicitly (exit 2).
// Run via `node --experimental-transform-types`.
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Socket, createConnection } from "node:net";
import xtermHeadless from "@xterm/headless";
import { TuiAltScreen } from "@earendil-works/pi-tui/dist/tui-alt-screen.js";
import { AttachPresentationObserver, asTerminal, type PresentationObservation } from "./attach-presentation-fixture.ts";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { claimHost, createView, readHost } from "../src/core/store.mjs";
import {
	WORK_AREA,
	makeAttachDims,
	diagOrderedExit,
	createDiagCleanup,
	diagCleanupOk,
	killOwnedDiagProcesses,
	HEADER_BY_STATUS,
	s17GenerationRowsText,
	s17GenerationCursor,
	type AttachSurfaceDims,
	type DiagCleanup,
	type DiagTrialHandle,
	withDiagTrial,
} from "./pty-attach-ready-scenario.ts";
import { formalMeasurementVersion } from "./formal-measurement/version.mjs";
import { holdFormalObservation } from "./formal-measurement/observation.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
const SYNC_OPEN = "\x1b[?2026h";
const SYNC_CLOSE = "\x1b[?2026l";
const PRODUCER_RS = "\x1e";
const producerCommand = (obj: unknown) => `${PRODUCER_RS}${JSON.stringify(obj)}\n`;

const GENERATION_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-generation-pi.mjs");
const FRAME_WRAPPER = resolve(REPO_ROOT, "test-support/fake-pty-frame-wrapper.mjs");
const DEFAULT_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-pi.mjs");
const RESTART_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-restart-pi.mjs");
const UNFRAMED_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-unframed-pi.mjs");

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

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readEventsSafe(eventsPath: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

/** Copy a child's raw event log into the retained artifact dir BEFORE the temp
 *  root is removed (missing file = empty list, recorded, never silent data
 *  loss). */
function copyChildEvents(eventsPath: string, artifactDir: string, rawName: string): Array<Record<string, unknown>> {
	const events = readEventsSafe(eventsPath);
	try {
		copyFileSync(eventsPath, join(artifactDir, rawName));
	} catch {
		/* a silent child may never create the log; the parsed array is still retained */
	}
	return events;
}

export function rtrimRows(rows: readonly string[]): string[] {
	return rows.map((row) => row.replace(/\s+$/u, ""));
}

export function rowsEqual(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((text, i) => text === expected[i]);
}

/** Pure sync-marker presence check (RED/GREEN target): a raw byte stream with
 *  any ?2026h/?2026l is NOT all-unframed. */
export function syncMarkerPresence(bytes: string): { hasOpen: boolean; hasClose: boolean; allUnframed: boolean } {
	return { hasOpen: bytes.includes(SYNC_OPEN), hasClose: bytes.includes(SYNC_CLOSE), allUnframed: !bytes.includes(SYNC_OPEN) && !bytes.includes(SYNC_CLOSE) };
}

/** Pure generation-visibility check: true when any row carries `<generation> `. */
export function generationRowsContain(rows: readonly string[], generation: string): boolean {
	return rows.some((r) => r.includes(`${generation} `));
}

/** R-restart gen-2 literal (mirror of fake-pty-restart-pi.mjs rowsText). */
export function s20bRestartRowsText(generation: string, id: string): string[] {
	const rows = s17GenerationRowsText(generation, id).slice();
	rows[0] = `${generation} ${id} HEADER controlled restart surface`;
	return rows;
}

function projectedRows(observation: PresentationObservation, dims: AttachSurfaceDims): string[] {
	return rtrimRows(observation.grid.slice(dims.bodyTop, dims.footerRow).map((row) => row.text));
}

function activeHandleCount(): number {
	const anyProcess = process as unknown as { _getActiveHandles?: () => unknown[] };
	try {
		return anyProcess._getActiveHandles?.().length ?? -1;
	} catch {
		return -1;
	}
}

// ---------------------------------------------------------------------------
// Pure oracles (RED/GREEN targets; no I/O)
// ---------------------------------------------------------------------------

/** One outer observation projected to work-area rows, the pure-oracle input.
 *  `kind`/`note` are the observer's own classification, carried through as
 *  evidence only (never consulted by the oracle logic). */
export interface WindowObservation {
	at: number;
	rows: string[];
	kind?: string;
	note?: string | null;
}

export type WindowFrameKind =
	| "content-f0"
	| "content-f1"
	| "content-mixed"
	| "content-foreign"
	| "loading"
	| "blank"
	| "chrome";

const GENERATION_TOKEN = /^(gen[a-z0-9-]*) /u;
const LOADING_ROW = /Loading|Starting the session host|Attached · waiting/u;

/** Classify ONE outer work-area window (pure). Loading/blank/chrome windows
 *  carry no content claim; a foreign generation token is any `gen…` token that
 *  is not the declared generation; a window holding BOTH the seed and the
 *  target id is a mixed half. */
export function classifyWindowRows(rows: readonly string[], input: { generation: string }): WindowFrameKind {
	const hasF0 = rows.some((row) => row.includes(`${input.generation} F0 `));
	const hasF1 = rows.some((row) => row.includes(`${input.generation} F1 `));
	if (hasF0 && hasF1) return "content-mixed";
	if (hasF0) return "content-f0";
	if (hasF1) return "content-f1";
	const foreign = rows.some((row) => {
		const token = GENERATION_TOKEN.exec(row)?.[1];
		return token !== undefined && token !== input.generation;
	});
	if (foreign) return "content-foreign";
	if (rows.every((row) => row === "")) return "blank";
	if (rows.some((row) => LOADING_ROW.test(row))) return "loading";
	return "chrome";
}

export interface GenerationWindowAnalysis {
	counts: Record<WindowFrameKind, number>;
	firstF0Index: number;
	firstF1Index: number;
	f1AfterF0: boolean;
	f0AfterF1: boolean;
	mixedHalves: boolean;
	foreignContent: boolean;
	/** Observation count fixed at the live/teardown boundary: everything
	 *  before it is the ACTIVE window, everything at/after it is teardown-only. */
	activeObservationCount: number;
	teardownObservationCount: number;
	teardownKinds: WindowFrameKind[];
	/** Teardown-only content windows (recorded: the closing surface legitimately
	 *  re-renders the already-committed frame). */
	teardownContentKinds: WindowFrameKind[];
	/** STALE content in the teardown-only window (seed/mixed/foreign): a teardown
	 *  repaint of old or foreign content is a real anomaly and must be none. */
	teardownStaleClaims: WindowFrameKind[];
	/** Blank/loading windows in the teardown-only bucket (allowed there, counted
	 *  so an active/teardown boundary mix-up is visible). */
	teardownBlankOrLoading: number;
	/** Any blank/loading window AFTER the first F1 INSIDE the active window: the
	 *  live view lost committed content. */
	postF1ContentLost: boolean;
	postF1ContentLostAt: number | null;
	ok: boolean;
}

/** R-reconnect full-window oracle (pure): the seed (F0) must be visible before
 *  the reconnect, the continuation (F1) only after it, and once F1 has been
 *  observed NO seed-only window, mixed F0/F1 half or foreign generation may
 *  appear. Blank/loading/chrome windows are classified, not ignored; a
 *  blank/loading window after the first F1 INSIDE the active window is a
 *  content loss, while the same window at/after the recorded teardown boundary
 *  is teardown chrome and allowed. */
export function analyzeGenerationWindow(
	observations: readonly WindowObservation[],
	input: { generation: string; activeObservationCount?: number },
): GenerationWindowAnalysis {
	const activeObservationCount = Math.max(0, Math.min(input.activeObservationCount ?? observations.length, observations.length));
	const active = observations.slice(0, activeObservationCount);
	const teardown = observations.slice(activeObservationCount);
	const kinds = active.map((observation) => classifyWindowRows(observation.rows, input));
	const counts: Record<WindowFrameKind, number> = { "content-f0": 0, "content-f1": 0, "content-mixed": 0, "content-foreign": 0, loading: 0, blank: 0, chrome: 0 };
	for (const kind of kinds) counts[kind] += 1;
	const firstF0Index = kinds.indexOf("content-f0");
	const firstF1Index = kinds.indexOf("content-f1");
	const f1AfterF0 = firstF0Index >= 0 && firstF1Index > firstF0Index;
	const afterF1 = firstF1Index < 0 ? [] : kinds.slice(firstF1Index);
	const f0AfterF1 = afterF1.includes("content-f0");
	const mixedHalves = counts["content-mixed"] > 0;
	const foreignContent = counts["content-foreign"] > 0;
	const lossIndex = firstF1Index < 0 ? -1 : afterF1.findIndex((kind) => kind === "blank" || kind === "loading");
	const postF1ContentLost = lossIndex >= 0;
	const teardownKinds = teardown.map((observation) => classifyWindowRows(observation.rows, input));
	const teardownContentKinds = teardownKinds.filter((kind) => kind.startsWith("content-"));
	const teardownStaleClaims = teardownKinds.filter((kind) => kind === "content-f0" || kind === "content-mixed" || kind === "content-foreign");
	const teardownBlankOrLoading = teardownKinds.filter((kind) => kind === "blank" || kind === "loading").length;
	return {
		counts,
		firstF0Index,
		firstF1Index,
		f1AfterF0,
		f0AfterF1,
		mixedHalves,
		foreignContent,
		activeObservationCount,
		teardownObservationCount: teardown.length,
		teardownKinds,
		teardownContentKinds,
		teardownStaleClaims,
		teardownBlankOrLoading,
		postF1ContentLost,
		postF1ContentLostAt: lossIndex < 0 ? null : active[firstF1Index + lossIndex].at,
		ok: f1AfterF0 && !f0AfterF1 && !mixedHalves && !foreignContent && !postF1ContentLost && teardownStaleClaims.length === 0,
	};
}

/** One post-empty observation that still carries stale-generation or poison
 *  rows, with the observer's own classification retained. */
export interface PostEmptyStaleObservation {
	/** Index within the post-empty window. */
	index: number;
	at: number;
	kind: string | null;
	note: string | null;
	gen1Rows: string[];
	poisonRows: string[];
}

export interface RestartWindowAnalysis {
	observationCount: number;
	recoveryIndex: number;
	recoveryAt: number | null;
	recoveryKind: "blank" | "loading" | "missing";
	firstGen2Index: number;
	gen2AfterRecovery: boolean;
	/** Parent-required: EVERY post-empty observation whose rows still carry
	 *  gen-1 or poison rows. The strict presentation gate reads
	 *  `length === 0` (see `strictPostEmptyPresentationClean`). */
	postEmptyStaleObservations: PostEmptyStaleObservation[];
	/** Derived STRICT presentation gate: `postEmptyStaleObservations.length === 0`.
	 *  Recorded separately from `ok` and never forced true. */
	strictPostEmptyPresentationClean: boolean;
	/** Pre-reset subset: stale pixels persisting through baseline-consumption
	 *  latency (an observer sync-entry snapshot of the still-stale grid taken
	 *  while the clearing write is being consumed). NOT a new stale publish. */
	stalePixelPersistenceObservations: PostEmptyStaleObservation[];
	stalePixelPersistenceLatencyMs: number | null;
	/** Post-empty observations carrying the PLANTED poison marker. */
	postEmptyPoisonObservations: PostEmptyStaleObservation[];
	poisonObservationGateOk: boolean;
	poisonPlanted: boolean;
	/** Stale gen-1 rows that were NOT already visible before the baseline. */
	newStaleRowsAfterBaseline: string[];
	/** Stale gen-1 rows anywhere after the recovery window (must be none). */
	oldGenRowsAfterRecovery: string[];
	poisonRowsAfterRecovery: string[];
	staleRowsBeforeBaseline: number;
	ok: boolean;
}

const toStaleObservation = (
	observation: WindowObservation,
	index: number,
	isStale: (row: string) => boolean,
	poisonMarker: string,
): PostEmptyStaleObservation | null => {
	const gen1Rows = observation.rows.filter(isStale);
	const poisonRows = observation.rows.filter((row) => row.includes(poisonMarker));
	if (gen1Rows.length === 0 && poisonRows.length === 0) return null;
	return {
		index,
		at: observation.at,
		kind: observation.kind ?? null,
		note: observation.note ?? null,
		gen1Rows,
		poisonRows,
	};
};

/** R-restart recovery oracle (pure). The window starts at the CORRELATED empty
 *  `snapshot_end` and must contain a real outer reset/loading observation
 *  BEFORE the first gen-2 content window; a missing recovery observes nothing
 *  and therefore FAILS (it never yields a vacuous empty scan). Stale scans are
 *  non-vacuous only when the old generation was really visible before the
 *  baseline. `ok` is HARNESS/EVIDENCE validity (no NEW stale content, nothing
 *  stale or poison after the reset, a real plant for the poison gates, gen-2
 *  after the reset). The stricter observation-level result
 *  (`strictPostEmptyPresentationClean`) is reported SEPARATELY and is never
 *  folded into `ok`: the current baseline legitimately persists old pixels for
 *  ~10 ms through the baseline-consumption window, which is a P4 presentation
 *  finding, not a harness failure and not a desirable outcome. */
export function analyzeRestartWindow(
	observations: readonly WindowObservation[],
	input: { emptyEndAt: number; staleGeneration: string; gen2Generation: string; poisonMarker: string; poisonPlanted: boolean },
): RestartWindowAnalysis {
	const window = observations.filter((observation) => observation.at >= input.emptyEndAt);
	const kinds = window.map((observation): "blank" | "loading" | "other" => {
		if (observation.rows.every((row) => row === "")) return "blank";
		if (observation.rows.some((row) => LOADING_ROW.test(row))) return "loading";
		return "other";
	});
	const recoveryIndex = kinds.findIndex((kind) => kind !== "other");
	const firstGen2Index = window.findIndex((observation) => observation.rows.some((row) => row.startsWith(`${input.gen2Generation} `)));
	const isStale = (row: string) => row.startsWith(`${input.staleGeneration} `);
	const before = observations.filter((observation) => observation.at < input.emptyEndAt);
	const baselineStaleRows = new Set(
		[...before].reverse().find((observation) => observation.rows.some(isStale))?.rows.filter(isStale) ?? [],
	);
	const staleRowsBeforeBaseline = before.flatMap((observation) => observation.rows.filter(isStale)).length;
	const newStaleRowsAfterBaseline = window.flatMap((observation) => observation.rows.filter((row) => isStale(row) && !baselineStaleRows.has(row)));
	const postEmptyStaleObservations = window
		.map((observation, index) => toStaleObservation(observation, index, isStale, input.poisonMarker))
		.filter((entry): entry is PostEmptyStaleObservation => entry !== null);
	const afterRecovery = recoveryIndex < 0 ? [] : window.slice(recoveryIndex);
	const oldGenRowsAfterRecovery = afterRecovery.flatMap((observation) => observation.rows.filter(isStale));
	const poisonRowsAfterRecovery = afterRecovery.flatMap((observation) => observation.rows.filter((row) => row.includes(input.poisonMarker)));
	const postEmptyPoisonObservations = postEmptyStaleObservations.filter((entry) => entry.poisonRows.length > 0);
	const stalePixelPersistenceObservations =
		recoveryIndex < 0 ? postEmptyStaleObservations : postEmptyStaleObservations.filter((entry) => entry.index < recoveryIndex);
	const recoveryAt = recoveryIndex < 0 ? null : window[recoveryIndex].at;
	const recoveryKind: "blank" | "loading" | "missing" = recoveryIndex < 0 ? "missing" : (kinds[recoveryIndex] as "blank" | "loading");
	const gen2AfterRecovery = recoveryIndex >= 0 && firstGen2Index > recoveryIndex;
	// An unplanted marker makes every "no poison observed" result vacuous: the
	// gate FAILS instead of passing on empty arrays.
	const poisonObservationGateOk = input.poisonPlanted && postEmptyPoisonObservations.length === 0;
	return {
		observationCount: window.length,
		recoveryIndex,
		recoveryAt,
		recoveryKind,
		firstGen2Index,
		gen2AfterRecovery,
		postEmptyStaleObservations,
		strictPostEmptyPresentationClean: postEmptyStaleObservations.length === 0,
		stalePixelPersistenceObservations,
		stalePixelPersistenceLatencyMs:
			recoveryAt === null || stalePixelPersistenceObservations.length === 0 ? null : recoveryAt - input.emptyEndAt,
		postEmptyPoisonObservations,
		poisonObservationGateOk,
		poisonPlanted: input.poisonPlanted,
		newStaleRowsAfterBaseline,
		oldGenRowsAfterRecovery,
		poisonRowsAfterRecovery,
		staleRowsBeforeBaseline,
		ok:
			gen2AfterRecovery &&
			newStaleRowsAfterBaseline.length === 0 &&
			oldGenRowsAfterRecovery.length === 0 &&
			poisonRowsAfterRecovery.length === 0 &&
			poisonObservationGateOk &&
			staleRowsBeforeBaseline > 0,
	};
}

/** One retained outer write (the observer's receipt record). */
export interface WriteRecord {
	index: number;
	receivedAt: number;
	data: string;
}

export interface PostEmptyWriteAnalysis {
	/** Writes at/after the correlated empty end, in receipt order. */
	writeCount: number;
	/** Consecutive write index/timestamp pairs that still carried stale bytes. */
	staleWrites: Array<{ index: number; receivedAt: number }>;
	poisonWrites: Array<{ index: number; receivedAt: number }>;
	/** Last write carrying stale-generation bytes overall (pre-baseline allowed). */
	lastStaleWrite: { index: number; receivedAt: number } | null;
	ok: boolean;
}

/** R-restart WRITE-level gate (pure): NO outer write received at/after the
 *  correlated empty end may carry gen-1 or planted-poison bytes. Pre-baseline
 *  writes are recorded (non-vacuity) but allowed. */
export function analyzePostEmptyWrites(
	writes: readonly WriteRecord[],
	input: { emptyEndAt: number; staleGeneration: string; poisonMarker: string },
): PostEmptyWriteAnalysis {
	const staleToken = `${input.staleGeneration} `;
	const postEmpty = writes.filter((write) => write.receivedAt >= input.emptyEndAt);
	const staleWrites = postEmpty.filter((write) => write.data.includes(staleToken)).map((write) => ({ index: write.index, receivedAt: write.receivedAt }));
	const poisonWrites = postEmpty.filter((write) => write.data.includes(input.poisonMarker)).map((write) => ({ index: write.index, receivedAt: write.receivedAt }));
	const staleAnywhere = writes.filter((write) => write.data.includes(staleToken));
	const lastStaleWrite = staleAnywhere.length === 0 ? null : { index: staleAnywhere[staleAnywhere.length - 1].index, receivedAt: staleAnywhere[staleAnywhere.length - 1].receivedAt };
	return {
		writeCount: postEmpty.length,
		staleWrites,
		poisonWrites,
		lastStaleWrite,
		ok: staleWrites.length === 0 && poisonWrites.length === 0,
	};
}

export interface InitialHookCounts {
	colorProbe: number;
	schemeBridge: number;
}

export interface InitialHookAnalysis {
	probeBefore: number;
	probeAfter: number;
	bridgeBefore: number;
	bridgeAfter: number;
	probeObservedBeforeRestart: boolean;
	probeNotRepeated: boolean;
	bridgeRegisteredBeforeRestart: boolean;
	bridgeNotRepeated: boolean;
	ok: boolean;
}

/** R-restart initial-side-effect oracle (pure): the settle color probe and the
 *  color-scheme bridge registration must REALLY happen before the restart
 *  (count >= 1 — 0→0 proves nothing) and must not be repeated after it. */
export function compareInitialHooks(before: InitialHookCounts, after: InitialHookCounts): InitialHookAnalysis {
	const probeObservedBeforeRestart = before.colorProbe >= 1;
	const probeNotRepeated = probeObservedBeforeRestart && after.colorProbe === before.colorProbe;
	const bridgeRegisteredBeforeRestart = before.schemeBridge >= 1;
	const bridgeNotRepeated = bridgeRegisteredBeforeRestart && after.schemeBridge === before.schemeBridge;
	return {
		probeBefore: before.colorProbe,
		probeAfter: after.colorProbe,
		bridgeBefore: before.schemeBridge,
		bridgeAfter: after.schemeBridge,
		probeObservedBeforeRestart,
		probeNotRepeated,
		bridgeRegisteredBeforeRestart,
		bridgeNotRepeated,
		ok: probeObservedBeforeRestart && probeNotRepeated && bridgeRegisteredBeforeRestart && bridgeNotRepeated,
	};
}

export interface ResizeEntry {
	cols: number;
	rows: number;
	at: number;
}

export interface LegacyResizeAnalysis {
	initial: ResizeEntry | null;
	shrink: ResizeEntry | null;
	restore: ResizeEntry | null;
	initialIndex: number;
	shrinkIndex: number;
	restoreIndex: number;
	restoreTrigger: "natural" | "detach" | "missing";
	ok: boolean;
}

/** U-legacy jiggle oracle (pure): the attach's own initial resize at the mount
 *  size, then the shrink-and-hold size, then a restore back to the mount size —
 *  in that order. A resize count > 0 is NOT enough, and a missing restore fails. */
export function analyzeLegacyResizeSequence(
	sequence: readonly ResizeEntry[],
	expected: { cols: number; rows: number; shrinkCols: number; shrinkRows: number; detachAt?: number | null },
): LegacyResizeAnalysis {
	const matchesOriginal = (entry: ResizeEntry) => entry.cols === expected.cols && entry.rows === expected.rows;
	const matchesShrink = (entry: ResizeEntry) => entry.cols === expected.shrinkCols && entry.rows === expected.shrinkRows;
	const initialIndex = sequence.findIndex(matchesOriginal);
	const shrinkIndex = initialIndex < 0 ? -1 : sequence.findIndex((entry, index) => index > initialIndex && matchesShrink(entry));
	const restoreIndex = shrinkIndex < 0 ? -1 : sequence.findIndex((entry, index) => index > shrinkIndex && matchesOriginal(entry));
	const initial = initialIndex < 0 ? null : sequence[initialIndex];
	const shrink = shrinkIndex < 0 ? null : sequence[shrinkIndex];
	const restore = restoreIndex < 0 ? null : sequence[restoreIndex];
	const restoreTrigger: "natural" | "detach" | "missing" =
		restore === null ? "missing" : expected.detachAt !== null && expected.detachAt !== undefined && restore.at >= expected.detachAt ? "detach" : "natural";
	return { initial, shrink, restore, initialIndex, shrinkIndex, restoreIndex, restoreTrigger, ok: initial !== null && shrink !== null && restore !== null };
}

/** Public transport observation seam (C2/I1): capture every in-process client
 *  Socket via Socket.prototype.write interception and record its outgoing
 *  protocol lines PLUS the incoming lines of the same socket, tagged with a
 *  per-socket id. The COMPONENT's client is the socket that wrote `hello`; a
 *  real disconnect is `.destroy()` on that owned socket. Close/reconnect and
 *  empty-baseline correlation are derived from these recorded lines only, never
 *  from a private `connected` flag. */
interface TransportLine {
	at: number;
	socketId: number;
	msg: Record<string, unknown>;
}

interface TransportCapture {
	sockets: Map<number, Socket>;
	txLines: TransportLine[];
	rxLines: TransportLine[];
	restore: () => void;
}

function captureClientSockets(): TransportCapture {
	const ids = new WeakMap<Socket, number>();
	const sockets = new Map<number, Socket>();
	const txLines: TransportLine[] = [];
	const rxLines: TransportLine[] = [];
	let nextSocketId = 1;
	const idFor = (socket: Socket): number => {
		const existing = ids.get(socket);
		if (existing !== undefined) return existing;
		const id = nextSocketId;
		nextSocketId += 1;
		ids.set(socket, id);
		sockets.set(id, socket);
		return id;
	};
	const record = (sink: TransportLine[], socketId: number, text: string): void => {
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				sink.push({ at: now(), socketId, msg: JSON.parse(line) as Record<string, unknown> });
			} catch {
				/* non-protocol bytes stay in the raw tx/rx logs */
			}
		}
	};
	const origWrite = Socket.prototype.write;
	// stdio is not a client transport: process.stdout/stderr/stdin are Socket
	// instances in a piped child, and a late warning write must never be
	// attributed to the component's connections (exact resource attribution).
	const isStdio = (socket: Socket) => socket === (process.stdout as unknown) || socket === (process.stderr as unknown) || socket === (process.stdin as unknown);
	(Socket.prototype as unknown as { write: (data: string, ...rest: unknown[]) => unknown }).write = function (data: string, ...rest: unknown[]) {
		const socket = this as unknown as Socket;
		if (isStdio(socket)) return (origWrite as unknown as (...args: unknown[]) => unknown).apply(this, [data, ...rest]);
		const socketId = idFor(socket);
		if (!(socket as unknown as { _rxAttached?: boolean })._rxAttached) {
			(socket as unknown as { _rxAttached?: boolean })._rxAttached = true;
			socket.on("data", (chunk: Buffer | string) => record(rxLines, socketId, chunk.toString("utf8")));
		}
		if (typeof data === "string") {
			for (const line of data.split("\n")) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line) as Record<string, unknown>;
					if (msg.type === "hello") (socket as unknown as { _helloSeen?: boolean })._helloSeen = true;
					txLines.push({ at: now(), socketId, msg });
				} catch {
					/* non-protocol bytes stay in the raw tx log */
				}
			}
		}
		return (origWrite as unknown as (...args: unknown[]) => unknown).apply(this, [data, ...rest]);
	};
	return {
		sockets,
		txLines,
		rxLines,
		restore: () => {
			Socket.prototype.write = origWrite;
		},
	};
}

/** The component's client socket: the one whose outgoing stream wrote hello. */
function componentClientSocket(capture: TransportCapture): Socket | null {
	const hello = capture.txLines.find((line) => line.msg.type === "hello" && typeof line.msg.clientId === "string" && line.msg.clientId.startsWith("ui-"));
	if (hello !== undefined) return capture.sockets.get(hello.socketId) ?? null;
	for (const socket of capture.sockets.values()) {
		if ((socket as unknown as { _helloSeen?: boolean })._helloSeen) return socket;
	}
	return null;
}

interface EmptyBaselineWitness {
	begin: TransportLine;
	end: TransportLine;
	socketId: number;
	nextSeqMatches: boolean;
	correlated: boolean;
}

/** Correlate an EMPTY `snapshot_begin` with ITS OWN `snapshot_end` on the SAME
 *  socket (never the first arbitrary end): the end must be the next snapshot
 *  boundary on that socket and must carry `nextSeq === snapshotSeq + 1`. Only
 *  component-client sockets (they wrote hello) and only baselines observed at or
 *  after `notBefore` are considered, so the initial attach's empty baseline can
 *  never be mistaken for the post-restart one. */
function correlateEmptyBaseline(capture: TransportCapture, notBefore: number): EmptyBaselineWitness | null {
	const helloFds = new Set(capture.txLines.filter((line) => line.msg.type === "hello").map((line) => line.socketId));
	const bySocket = new Map<number, TransportLine[]>();
	for (const line of capture.rxLines) {
		if (!helloFds.has(line.socketId)) continue;
		const lines = bySocket.get(line.socketId) ?? [];
		lines.push(line);
		bySocket.set(line.socketId, lines);
	}
	for (const [socketId, lines] of bySocket) {
		const beginIndex = lines.findIndex((line) => line.msg.type === "snapshot_begin" && line.msg.empty === true && line.at >= notBefore);
		if (beginIndex < 0) continue;
		const begin = lines[beginIndex];
		let endIndex = -1;
		for (let i = beginIndex + 1; i < lines.length; i += 1) {
			if (lines[i].msg.type === "snapshot_end") {
				endIndex = i;
				break;
			}
			if (lines[i].msg.type === "snapshot_begin") break;
		}
		if (endIndex < 0) continue;
		const end = lines[endIndex];
		const beginSeq = typeof begin.msg.snapshotSeq === "number" ? begin.msg.snapshotSeq : 0;
		const nextSeqMatches = end.msg.nextSeq === beginSeq + 1;
		return { begin, end, socketId, nextSeqMatches, correlated: nextSeqMatches };
	}
	return null;
}

// ---------------------------------------------------------------------------
// R-reconnect: same generation, real short disconnect + reconnect
// ---------------------------------------------------------------------------

/** Ordered exit through the attach's REAL input path for the custom mounts
 *  (the same observations and bounded waits as the accepted `diagOrderedExit`,
 *  which needs a withDiagTrial handle): the child's documented `exit` command,
 *  then the host's own exited state, then the runner's exit. */
async function orderedExitThroughComponent(input: {
	component: unknown;
	runner: ChildProcess | null;
	root: string;
	viewId: string;
	cleanup: DiagCleanup;
	label: string;
}): Promise<void> {
	(input.component as { handleInput: (data: string) => void }).handleInput(producerCommand({ cmd: "exit" }));
	await waitFor(() => readHost(input.root, input.viewId)?.state === "exited", 5000, `${input.label} host state exited`);
	input.cleanup.childExited = true;
	if (input.runner && input.runner.exitCode === null && input.runner.signalCode === null) {
		const runner = input.runner;
		// Bounded wait with an explicitly cleared timer (no dangling race timer
		// can be mis-attributed to the component in the resource snapshot).
		await new Promise<void>((resolveExit) => {
			const timer = setTimeout(() => resolveExit(), 5000);
			runner.once("exit", () => {
				clearTimeout(timer);
				resolveExit();
			});
		});
	}
	if (input.runner) {
		input.cleanup.runnerExited = input.runner.exitCode !== null || input.runner.signalCode !== null;
		input.cleanup.runnerExitCode = input.runner.exitCode;
	}
}

async function runReconnect(artifactDir: string): Promise<Record<string, unknown>> {
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists: ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const writeArtifact = makeArtifactWriter(artifactDir, []);
	const gen = "gen-1";
	const seedLiteral = s17GenerationRowsText(gen, "F0");
	const targetLiteral = s17GenerationRowsText(gen, "F1");
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	const root = join(tmpdir(), `s20b-reconnect-${process.pid}-${Date.now()}`);
	mkdirSync(root, { recursive: true });
	const viewId = "s20b-reconnect";
	const socketPath = join(root, "reconnect.sock");
	const configPath = join(root, "host-config.json");
	const eventsPath = join(root, "child-events.jsonl");
	const frameTokenPath = join(root, "frame-token.txt");
	let frameReporter: Socket | null = null;
	const capture = captureClientSockets();
	const cleanup = createDiagCleanup();
	let error: string | null = null;
	let side: RestartSide | null = null;
	let runner: ChildProcess | null = null;
	let f0Committed = false;
	let f1Committed = false;
	let subscribeBefore = 0;
	let subscribeCount = 0;
	let sinceSeq: unknown = null;
	let resumePath: "sinceSeq" | "snapshot" | "unknown" = "unknown";
	let allSameGeneration = false;
	let windowAnalysis: GenerationWindowAnalysis | null = null;
	let modernFrameWitness = false;
	const measurementPath = formalMeasurementVersion() === "baseline" ? "legacy-no-reporter" : "modern-reporter-viewproof";
	let observation: Awaited<ReturnType<typeof holdFormalObservation>> = null;
	let recoveryDuringDown = false;
	let recoveryStatusWhileDown: string | null = null;
	let recoveryActiveRow: string | null = null;
	let recoveryClearedAfterF1 = false;
	let resnapshotPreserved = false;
	let resnapshotRow: string | null = null;
	let activeWindowObservationCount = 0;
	let teardownObservationCount = 0;
	try {
		const meta = createView(root, { id: viewId, name: "s20b reconnect", cwd: root });
		claimHost(root, { viewId, instanceId: viewId, configPath, socketPath, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: WORK_AREA.cols, rows: WORK_AREA.rows });
		atomicWriteJson(configPath, {
			root, viewId, instanceId: viewId, socketPath, sessionFile: meta.sessionFile, cwd: process.cwd(), initialPrompt: null,
			piCommand: process.execPath, piArgsPrefix: [measurementPath === "modern-reporter-viewproof" ? FRAME_WRAPPER : GENERATION_CHILD], model: null, tools: null,
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_GENERATION: gen, FAKE_PTY_EVENTS_PATH: eventsPath, ...(measurementPath === "modern-reporter-viewproof" ? { FAKE_PTY_FRAME_CHILD_PATH: GENERATION_CHILD, FAKE_PTY_FRAME_TOKEN: frameTokenPath } : {}) },
			cols: WORK_AREA.cols, rows: WORK_AREA.rows,
		});
		runner = spawn(process.execPath, [resolve(REPO_ROOT, "runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		runner.stderr?.resume();
		runner.stdout?.resume();
		await waitFor(() => { const host = readHost(root, viewId); return !!host && host.state === "alive" && !!host.childPid; }, 10_000, "reconnect host alive");
		if (measurementPath === "modern-reporter-viewproof") frameReporter = await connectModernFrameReporter(socketPath, frameTokenPath);
		side = await mountRestartSide(socketPath, dims);
		await waitFor(() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), seedLiteral)), 10_000, "gen-1 F0 commit");
		f0Committed = true;
		// Real same-generation nonempty resnapshot: instrument replacement only,
		// request a fresh snapshot, and verify recovery A is captured before B commits.
		const resnapComponent = side.component as unknown as {
			replaceParser: () => boolean;
			committedView?: { rows: Array<{ cells: { translateToString: (trim?: boolean) => string } }> } | null;
			recoveryView?: { rows: Array<{ cells: { translateToString: (trim?: boolean) => string } }> } | null;
			attachClient: { requestResync: (reason: string) => boolean };
		};
		let resnapshotWitness: { recoveryRow: string | null; currentNull: boolean } | null = null;
		if (typeof resnapComponent.replaceParser === "function") {
			const originalReplace = resnapComponent.replaceParser.bind(resnapComponent);
			resnapComponent.replaceParser = function (this: unknown) {
				const replaced = originalReplace();
				if (replaced) {
					resnapshotWitness = {
						recoveryRow: resnapComponent.recoveryView?.rows[0]?.cells.translateToString(true) ?? null,
						currentNull: resnapComponent.committedView === null,
					};
				}
				return replaced;
			};
			resnapComponent.attachClient.requestResync("step27-nonempty-resnapshot");
			await waitFor(() => resnapshotWitness !== null, 8000, "same-gen nonempty resnapshot replacement");
			resnapComponent.replaceParser = originalReplace;
		}
		const resnapshotFacts = resnapshotWitness as unknown as { recoveryRow: string | null; currentNull: boolean } | null;
		resnapshotPreserved = resnapshotFacts?.recoveryRow?.startsWith("gen-1 F0") === true && resnapshotFacts?.currentNull === true;
		resnapshotRow = resnapshotFacts?.recoveryRow ?? null;
		await waitFor(() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), seedLiteral)), 8000, "resnapshot F0 commit");
		// Public transport: find the component client socket (the one that wrote hello).
		const clientSocket = componentClientSocket(capture);
		if (!clientSocket) throw new Error("no component client socket captured via the public transport seam");
		subscribeBefore = capture.txLines.filter((l) => l.msg.type === "subscribe_terminal").length;
		// Real disconnect of the owned client socket (not a private component field).
		clientSocket.destroy();
		const recoveryProbe = side.component as unknown as {
			recoveryView?: { rows: Array<{ cells: { translateToString: (trim?: boolean) => string } }> } | null;
			activeCommittedView?: () => { rows: Array<{ cells: { translateToString: (trim?: boolean) => string } }> } | null;
			status?: string;
			frameWitnessAvailable?: boolean;
		};
		await waitFor(() => recoveryProbe.recoveryView !== null && recoveryProbe.recoveryView !== undefined, 5000, "recovery view retained while down").catch(() => {});
		recoveryDuringDown = recoveryProbe.recoveryView !== null && recoveryProbe.recoveryView !== undefined;
		recoveryStatusWhileDown = recoveryProbe.status ?? null;
		recoveryActiveRow = recoveryProbe.activeCommittedView?.()?.rows[0]?.cells.translateToString(true) ?? null;
		// Reconnect is derived from a NEW subscribe_terminal in the public tx log.
		await waitFor(() => capture.txLines.filter((l) => l.msg.type === "subscribe_terminal").length > subscribeBefore, 10_000, "reconnect re-subscribe");
		const subs = capture.txLines.filter((l) => l.msg.type === "subscribe_terminal");
		subscribeCount = subs.length;
		const lastSub = subs[subs.length - 1]?.msg;
		if (typeof lastSub?.sinceSeq === "number") { resumePath = "sinceSeq"; sinceSeq = lastSub.sinceSeq; }
		else if (capture.rxLines.some((l) => l.msg.type === "snapshot_begin")) resumePath = "snapshot";
		else resumePath = "unknown";
		// Same-generation continuation after reconnect.
		(side.component as unknown as { handleInput: (d: string) => void }).handleInput(producerCommand({ cmd: "step", step: 1 }));
		await waitFor(() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), targetLiteral)), 10_000, "gen-1 F1 after reconnect");
		f1Committed = true;
		modernFrameWitness = recoveryProbe.frameWitnessAvailable === true;
		recoveryClearedAfterF1 = recoveryProbe.recoveryView === null || recoveryProbe.recoveryView === undefined;
		const genEvents = readEventsSafe(eventsPath).filter((e) => e.generation !== undefined);
		allSameGeneration = genEvents.length > 0 && genEvents.every((e) => e.generation === gen);
		// The FULL-window oracle runs in the finally, once the ACTIVE/teardown
		// boundary is fixed right before dispose (see there).
		observation = await holdFormalObservation(now, sleep, "R-reconnect");
		// Ordered exit + owned cleanup (no forced kill is the normal exit).
		await orderedExitThroughComponent({ component: side.component, runner, root, viewId, cleanup, label: "reconnect" });
	} catch (err) {
		error = err instanceof Error ? (err.stack ?? err.message) : String(err);
	} finally {
		capture.restore();
		try { frameReporter?.destroy(); } catch { /* best-effort */ }
		// RU fix3 / Q4: fix the ACTIVE-window boundary BEFORE dispose/teardown, so a
		// teardown blank/header can never be mistaken for live content loss and a
		// live post-F1 blank/loading can never hide in the teardown bucket.
		activeWindowObservationCount = side ? side.observer.observations.length : 0;
		try { side?.component && (side.component as unknown as { dispose: () => void }).dispose(); } catch { /* best-effort */ }
		try { side?.tui.stop(); } catch { /* best-effort */ }
		if (side) {
			try { await Promise.race([side.observer.whenIdle(), sleep(2000)]); } catch { /* best-effort */ }
			windowAnalysis = analyzeGenerationWindow(
				side.observer.observations.map((o) => ({ at: o.boundaryParsedAt, rows: projectedRows(o, dims), kind: o.kind, note: o.note })),
				{ generation: gen, activeObservationCount: activeWindowObservationCount },
			);
			teardownObservationCount = windowAnalysis.teardownObservationCount;
		}
		const childEventsArtifact = copyChildEvents(eventsPath, artifactDir, "child-events-raw.jsonl");
		await killOwnedDiagProcesses(runner, root, viewId, cleanup);
		try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); cleanup.rootRemoved = true; } catch { /* recorded below */ }
		cleanup.ok = diagCleanupOk(cleanup);
		try { side?.observer.dispose(); } catch { /* best-effort */ }
		writeArtifact("observations.json", { observations: side?.observer.observations ?? [] });
		writeArtifact("writes.json", side?.observer.writes ?? []);
		writeArtifact("diagnostics.json", side?.diagnostics ?? []);
		writeArtifact("tx-lines.json", capture.txLines);
		writeArtifact("rx-lines.json", capture.rxLines);
		writeArtifact("cleanup.json", cleanup);
		writeArtifact("child-events.jsonl", childEventsArtifact);
		writeArtifact("summary.json", {
			caseId: "R-reconnect",
			error,
			f0Committed,
			f1Committed,
			subscribeBefore,
			subscribeCount,
			sinceSeq,
			resumePath,
			allSameGeneration,
			modernFrameWitness,
			recoveryDuringDown,
			recoveryStatusWhileDown,
			recoveryActiveRow,
			recoveryClearedAfterF1,
			resnapshotPreserved,
			resnapshotRow,
			activeWindowObservationCount,
			teardownObservationCount,
			windowAnalysis,
			doneResults: side?.doneResults ?? [],
			cleanup,
			transportPatch: { target: "Socket.prototype.write", restoredInFinally: true },
		});
	}
	const reconnectEvidence = {
		f0Committed,
		f1Committed,
		subscribeBefore,
		subscribeCount,
		sinceSeq,
		resumePath,
		allSameGeneration,
		modernFrameWitness,
		recoveryDuringDown,
		recoveryStatusWhileDown,
		recoveryActiveRow,
		recoveryClearedAfterF1,
		resnapshotPreserved,
		resnapshotRow,
		activeWindowObservationCount,
		teardownObservationCount,
		windowAnalysis,
		doneResults: side?.doneResults ?? [],
		cleanup,
		transportPatch: { target: "Socket.prototype.write", restoredInFinally: true },
	};
	return {
		caseId: "R-reconnect",
		ok:
			error === null &&
			f0Committed &&
			f1Committed &&
			allSameGeneration &&
			windowAnalysis?.ok === true &&
			cleanup.ok &&
			cleanup.forcedKills.length === 0,
		measurementPath,
		observation: observation ?? null,
		recoveryCompletion: observation === null ? "not-applicable" : "completed",
		error,
		reconnectEvidence,
		artifactDir,
	};
}

// ---------------------------------------------------------------------------
// R-restart: intentional OLD owned runner kill + fresh generation restart
// ---------------------------------------------------------------------------

interface RequestRenderEntry {
	seq: number;
	at: number;
	force: boolean;
}

interface HookLifecycle {
	/** Color-scheme bridge registrations (public TUI hook). */
	bridgeRegistrations: number;
	/** Unsubscribe invocations of those registrations (exact attribution). */
	bridgeUnsubscribes: number;
}

async function connectModernFrameReporter(socketPath: string, tokenPath: string): Promise<Socket> {
	const socket = createConnection(socketPath);
	const messages: Array<Record<string, unknown>> = [];
	let buffer = "";
	socket.on("data", (chunk) => {
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
		setTimeout(() => rejectConnect(new Error("20B frame reporter connect timeout")), 4000).unref?.();
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
	throw new Error("20B frame reporter enable timeout");
}

interface RestartSide {
	observer: AttachPresentationObserver;
	tui: TuiAltScreen;
	component: unknown;
	/** DETACH/close completion results — NOT first-attach hooks (kept separate). */
	doneResults: unknown[];
	/** Real public TUI side-effect counters (settle color probe, scheme bridge). */
	hooks: InitialHookCounts;
	hookLifecycle: HookLifecycle;
	/** Public `tui.requestRender` calls in call order (D1 ordering evidence). */
	requestRenderLog: RequestRenderEntry[];
	diagnostics: unknown[];
}

async function mountRestartSide(
	socketPath: string,
	dims: AttachSurfaceDims,
	extra?: { trackRequestRender?: boolean; trackHookLifecycle?: boolean },
): Promise<RestartSide> {
	const { PtyAttachComponent } = await import("../src/ui/pty-attach.ts");
	const observer = new AttachPresentationObserver({ cols: dims.cols, rows: dims.screenRows, now });
	const tui = new TuiAltScreen(asTerminal(observer), false, undefined, {});
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
	const hooks: InitialHookCounts = { colorProbe: 0, schemeBridge: 0 };
	const hookLifecycle: HookLifecycle = { bridgeRegistrations: 0, bridgeUnsubscribes: 0 };
	const requestRenderLog: RequestRenderEntry[] = [];
	if (extra?.trackRequestRender) {
		// Public TUI method, wrapped-and-delegated: records the CALL ORDER the
		// component drives, so a post-dispose write can be attributed to a
		// request made before or after dispose (never inferred from timing).
		const anyTui = tui as unknown as { requestRender: (force?: boolean) => void };
		const originalRequestRender = anyTui.requestRender.bind(tui);
		anyTui.requestRender = (force?: boolean) => {
			requestRenderLog.push({ seq: requestRenderLog.length, at: now(), force: force === true });
			originalRequestRender(force);
		};
	}
	// Real public TUI seams as first-attach witnesses: the settle color probe
	// (TUI.queryTerminalColors) and the color-scheme bridge registration
	// (TUI.onTerminalColorSchemeChange). Both wrappers delegate unchanged.
	const seams = tui as unknown as {
		queryTerminalColors: (options: { timeoutMs: number; onLateReply?: (colors: never) => void }) => Promise<unknown>;
		onTerminalColorSchemeChange: (listener: (scheme: never) => void) => () => void;
	};
	const realProbe = seams.queryTerminalColors.bind(tui);
	seams.queryTerminalColors = (options) => {
		hooks.colorProbe += 1;
		return realProbe(options);
	};
	const realBridge = seams.onTerminalColorSchemeChange.bind(tui);
	seams.onTerminalColorSchemeChange = (listener) => {
		hooks.schemeBridge += 1;
		hookLifecycle.bridgeRegistrations += 1;
		const unsubscribe = realBridge(listener);
		if (!extra?.trackHookLifecycle) return unsubscribe;
		return () => {
			hookLifecycle.bridgeUnsubscribes += 1;
			return unsubscribe();
		};
	};
	const side: RestartSide = { observer, tui, component: null, doneResults: [], hooks, hookLifecycle, requestRenderLog, diagnostics: [] };
	const component = new PtyAttachComponent(
		tui as never,
		theme as never,
		{} as never,
		((result: unknown) => {
			side.doneResults.push(result);
		}) as never,
		{
			socketPath,
			title: "s20b",
			onDiagnostic: (event: unknown) => side.diagnostics.push(event),
		} as never,
	);
	side.component = component;
	tui.setLayoutRoot(component);
	tui.start();
	return side;
}

/** Poison marker for the post-empty scans (RU fix3 / parent Q2). It is PLANTED
 *  into the view's actual retained `screen.log` after the gen-1 commit and
 *  before the intentional old kill (accepted A5 plant technique), so the
 *  "no poison after the baseline" gates are non-vacuous: an unplanted marker
 *  makes the poison gates FAIL instead of passing on empty arrays. */
const RESTART_POISON_MARKER = "s20b-poison";
const RESTART_POISON_TEXT = `${RESTART_POISON_MARKER} poisoned stale retained screen.log line\n`;

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

async function drainObserver(side: RestartSide): Promise<void> {
	let last = -1;
	for (let attempt = 0; attempt < 12; attempt += 1) {
		await Promise.race([side.observer.whenIdle(), sleep(1000)]);
		await sleep(25);
		const count = side.observer.observations.length;
		if (count === last) return;
		last = count;
	}
}

async function runRestart(artifactDir: string): Promise<Record<string, unknown>> {
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists: ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const artifactErrors: string[] = [];
	const writeArtifact = makeArtifactWriter(artifactDir, artifactErrors);
	const gen1 = "gen-1";
	const gen2 = "gen-2";
	const gen1Seed = s17GenerationRowsText(gen1, "F0");
	const gen2Seed = s20bRestartRowsText(gen2, "F0");
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	const capture = captureClientSockets();
	const cleanup = createDiagCleanup();

	const root = join(tmpdir(), `s20b-restart-${process.pid}-${Date.now()}`);
	mkdirSync(root, { recursive: true });
	const viewId = "s20b-restart";
	const socketPath = join(root, "restart.sock");
	const configPath = join(root, "host-config.json");
	const eventsPath1 = join(root, "child-events-gen1.jsonl");
	const eventsPath2 = join(root, "child-events-gen2.jsonl");
	const frameTokenPath1 = join(root, "frame-token-gen1.txt");
	const frameTokenPath2 = join(root, "frame-token-gen2.txt");
	let frameReporter: Socket | null = null;

	const spawnRunner = (gen: string, eventsPath: string, socket: string, restart: boolean): ChildProcess => {
		// Remove a stale unix socket left by a SIGKILLed prior runner so the
		// replacement can bind the same path (restart keeps the SAME endpoint).
		try {
			rmSync(socket, { force: true });
		} catch {
			/* no stale socket */
		}
		const meta = createView(root, { id: viewId, name: "s20b restart", cwd: root });
		claimHost(root, { viewId, instanceId: viewId, configPath, socketPath: socket, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: WORK_AREA.cols, rows: WORK_AREA.rows });
		atomicWriteJson(configPath, {
			root,
			viewId,
			instanceId: viewId,
			socketPath: socket,
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [measurementPath === "modern-reporter-viewproof" ? FRAME_WRAPPER : (restart ? RESTART_CHILD : GENERATION_CHILD)],
			model: null,
			tools: null,
			env: {
				...(restart
					? { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_RESTART_GENERATION: gen, FAKE_PTY_EVENTS_PATH: eventsPath }
					: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_GENERATION: gen, FAKE_PTY_EVENTS_PATH: eventsPath }),
				...(measurementPath === "modern-reporter-viewproof" ? {
					FAKE_PTY_FRAME_CHILD_PATH: restart ? RESTART_CHILD : GENERATION_CHILD,
					FAKE_PTY_FRAME_TOKEN: gen === "gen-1" ? frameTokenPath1 : frameTokenPath2,
				} : {}),
			},
			cols: WORK_AREA.cols,
			rows: WORK_AREA.rows,
		});
		const runner = spawn(process.execPath, [resolve(REPO_ROOT, "runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		runner.stderr?.resume();
		runner.stdout?.resume();
		return runner;
	};

	let runner: ChildProcess | null = null;
	let side: RestartSide | null = null;
	const scenarioKills: string[] = [];
	const measurementPath = formalMeasurementVersion() === "baseline" ? "legacy-no-reporter" : "modern-reporter-viewproof";
	let observation: Awaited<ReturnType<typeof holdFormalObservation>> = null;
	let error: string | null = null;
	let gen1Committed = false;
	let gen2Committed = false;
	let emptyBaseline: (EmptyBaselineWitness & { beginGeneration: string | null }) | null = null;
	let resetAnalysis: RestartWindowAnalysis | null = null;
	let writeAnalysis: PostEmptyWriteAnalysis | null = null;
	let poisonPlant: Record<string, unknown> | null = null;
	let poisonRetainedAtTeardown: boolean | null = null;
	let screenLogArtifactBytes: number | null = null;
	let preRestartGenerations: string[] = [];
	let preRestartBaselineGenerations: string[] = [];
	let preRestartGenerationsDiffer = false;
	let hooks: InitialHookAnalysis | null = null;
	let gen2Proof: { observedAt: number; kind: string; literalMatched: boolean; gridSha256: string; cursor: unknown; expectedCursor: { x: number; y: number; visible: boolean }; cursorMatched: boolean } | null = null;
	let modernFrameWitness = false;
	let oldViewsClearedAtEmpty = false;
	let recoveryClearedAfterGen2 = false;
	let preEmptyDrain: { writes: number; observations: number; afterWrites: number; afterObservations: number } | null = null;
	const attachEvents: Array<Record<string, unknown>> = [];
	try {
		runner = spawnRunner(gen1, eventsPath1, socketPath, false);
		await waitFor(() => {
			const host = readHost(root, viewId);
			return !!host && host.state === "alive" && !!host.childPid;
		}, 10_000, "gen-1 host alive");
		if (measurementPath === "modern-reporter-viewproof") frameReporter = await connectModernFrameReporter(socketPath, frameTokenPath1);
		side = await mountRestartSide(socketPath, dims);
		{
			const comp = side.component as unknown as { handleAttachEvent: (event: string, payload: unknown) => void };
			const originalHandle = comp.handleAttachEvent.bind(side.component);
			comp.handleAttachEvent = function (this: unknown, event: string, payload: unknown) {
				const result = originalHandle(event, payload);
				const c = side!.component as unknown as { committedView?: unknown; recoveryView?: unknown; status?: string; currentWireGeneration?: string | null };
				if (event === "snapshotBegin" || event === "snapshotReady" || event === "mode") {
					attachEvents.push({ event, payload, committed: c.committedView !== null && c.committedView !== undefined, recovery: c.recoveryView !== null && c.recoveryView !== undefined, status: c.status ?? null, wireGeneration: c.currentWireGeneration ?? null });
				}
				return result;
			};
		}
		// Prove gen-1 content on the outer observer.
		await waitFor(
			() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), gen1Seed)),
			10_000,
			"gen-1 F0 commit",
		);
		gen1Committed = true;
		// RU fix3 / parent Q2: REAL poison plant into the view's ACTUAL retained
		// screen.log, after the gen-1 commit and BEFORE the intentional old owned
		// kill, using the accepted A5 plant technique (append, then read back).
		// The gen-1 runner keeps appending after the plant, so the marker survives
		// in real retained state and any stale replay/leak would be observable.
		const poisonPath = P.screenLogPath(root, viewId);
		const poisonBefore = readTextOrNull(poisonPath);
		appendFileSync(poisonPath, RESTART_POISON_TEXT);
		const poisonAfter = readTextOrNull(poisonPath) ?? "";
		const plantReadbackContained = poisonAfter.includes(RESTART_POISON_MARKER);
		poisonPlant = {
			marker: RESTART_POISON_MARKER,
			text: RESTART_POISON_TEXT,
			path: poisonPath,
			method: "appendFileSync into the view's retained screen.log (accepted A5 poison technique)",
			plantedAt: now(),
			beforeBytes: poisonBefore === null ? null : Buffer.byteLength(poisonBefore, "utf8"),
			beforeSha256: poisonBefore === null ? null : sha256(poisonBefore),
			appendedBytes: Buffer.byteLength(RESTART_POISON_TEXT, "utf8"),
			appendedSha256: sha256(RESTART_POISON_TEXT),
			afterBytes: Buffer.byteLength(poisonAfter, "utf8"),
			afterSha256: sha256(poisonAfter),
			plantReadbackContained,
			readbackTail: poisonAfter.slice(-Math.max(RESTART_POISON_TEXT.length, 120)),
		};
		if (!plantReadbackContained) throw new Error(`poison plant readback does not contain ${RESTART_POISON_MARKER}`);
		// REAL initial-attach side effects on public seams: wait until the settle
		// color probe ran AND the color-scheme bridge registered (count >= 1).
		await waitFor(
			() => side!.hooks.colorProbe >= 1 && side!.hooks.schemeBridge >= 1,
			10_000,
			"initial settle color probe + scheme bridge registration",
		);
		const hooksBefore: InitialHookCounts = { ...side.hooks };

		// Drain the REAL outer observer BEFORE the empty baseline is triggered so
		// every pre-empty old write is presented and recorded pre-baseline. This
		// changes fixture timing only; the zero-post-empty-old oracle is unchanged.
		const drainWrites = side?.observer.writes.length ?? 0;
		const drainObservations = side?.observer.observations.length ?? 0;
		side?.tui.requestRender(true);
		await drainObserver(side!);
		await sleep(250);
		await drainObserver(side!);
		preEmptyDrain = {
			writes: drainWrites,
			observations: drainObservations,
			afterWrites: side?.observer.writes.length ?? 0,
			afterObservations: side?.observer.observations.length ?? 0,
		};
		// Intentional OLD owned restart kill (a scenario action, NOT cleanup).
		const oldChildPid = readHost(root, viewId)?.childPid ?? null;
		if (oldChildPid) {
			try {
				process.kill(oldChildPid, "SIGKILL");
				scenarioKills.push(`child:${oldChildPid}`);
			} catch {
				/* already exited */
			}
		}
		if (runner?.pid) {
			try {
				runner.kill("SIGKILL");
				scenarioKills.push(`runner:${runner.pid}`);
			} catch {
				/* already exited */
			}
		}
		await new Promise((resolveExit) => runner!.once("exit", resolveExit));
		const downComponent = side!.component as unknown as { status?: string; recoveryView?: unknown };
		await waitFor(() => downComponent.status === "disconnected" || downComponent.status === "host exited", 5000, "component observed disconnect");
		if (measurementPath === "modern-reporter-viewproof") {
			await waitFor(() => downComponent.recoveryView !== null && downComponent.recoveryView !== undefined, 5000, "recovery view presented before restart").catch(() => {});
		}
		await sleep(250);
		// The child may write until the kill; force a final render barrier and drain
		// BEFORE the gen-2 empty baseline so those final pre-empty presents are
		// recorded first.
		side?.tui.requestRender(true);
		await drainObserver(side!);
		await sleep(250);
		await drainObserver(side!);

		// Snapshot pre-restart identities BEFORE the replacement runner can write
		// any status/snapshot generation.
		const preRestartProtocolGenerationsBeforeSpawn = capture.rxLines
			.filter((line) => typeof line.msg.generation === "string")
			.map((line) => line.msg.generation as string);
		const preRestartBaselineGenerationsBeforeSpawn = capture.rxLines
			.filter((line) => line.msg.type === "snapshot_begin" && line.msg.empty === true && typeof line.msg.generation === "string")
			.map((line) => line.msg.generation as string);
		// Fresh generation runner on the SAME socket path (empty baseline first).
		const gen2SpawnAt = now();
		runner = spawnRunner(gen2, eventsPath2, socketPath, true);
		await waitFor(() => {
			const host = readHost(root, viewId);
			return !!host && host.state === "alive" && !!host.childPid;
		}, 10_000, "gen-2 host alive");
		await waitFor(() => existsSync(socketPath), 8000, "gen-2 socket bound");
		const gen2AliveAt = now();
		try { frameReporter?.destroy(); } catch { /* old runner gone */ }
		if (measurementPath === "modern-reporter-viewproof") frameReporter = await connectModernFrameReporter(socketPath, frameTokenPath2);
		// Correlate THIS runner boot's EMPTY authoritative baseline: the empty
		// snapshot_begin and ITS OWN snapshot_end on the same component-client
		// socket, with nextSeq === snapshotSeq + 1. Never the first arbitrary end.
		await waitFor(() => correlateEmptyBaseline(capture, gen2SpawnAt) !== null, 10_000, "correlated empty snapshot_begin/snapshot_end");
		const witness = correlateEmptyBaseline(capture, gen2SpawnAt)!;
		const beginGeneration = typeof witness.begin.msg.generation === "string" ? witness.begin.msg.generation : null;
		emptyBaseline = { ...witness, beginGeneration };
		if (!witness.correlated) throw new Error(`empty baseline begin/end not correlated: nextSeq=${JSON.stringify(witness.end.msg)}`);
		const restartComponent = side.component as unknown as {
			committedView?: unknown;
			recoveryView?: unknown;
			frameWitnessAvailable?: boolean;
		};
		modernFrameWitness = restartComponent.frameWitnessAvailable === true;
		oldViewsClearedAtEmpty = restartComponent.committedView === null && restartComponent.recoveryView === null;
		// A NEW runner boot identity is the protocol-level proof that this empty
		// baseline belongs to the replacement runner, not the initial attach.
		// Pre-restart identities are taken from EVERY pre-restart protocol message
		// that carries the runner boot `generation` (hello/status/snapshot_begin),
		// not only from an empty baseline: the initial baseline may be non-empty
		// when the gen-1 child wins the mount race, and an empty list would make
		// "differs from every pre-restart generation" vacuously true.
		preRestartGenerations = [...new Set(preRestartProtocolGenerationsBeforeSpawn)];
		preRestartBaselineGenerations = [...new Set(preRestartBaselineGenerationsBeforeSpawn)];
		preRestartGenerationsDiffer = beginGeneration !== null && preRestartGenerations.length > 0 && !preRestartGenerations.includes(beginGeneration);
		if (beginGeneration !== null && preRestartGenerations.includes(beginGeneration)) {
			throw new Error(`empty baseline carries a pre-restart runner generation ${beginGeneration}`);
		}
		// Release the complete gen-2 frame only AFTER the empty baseline.
		(side.component as unknown as { handleInput: (d: string) => void }).handleInput(producerCommand({ cmd: "go" }));
		await waitFor(
			() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), gen2Seed)),
			15_000,
			"gen-2 F0 commit",
		);
		gen2Committed = true;
		recoveryClearedAfterGen2 = (side.component as unknown as { recoveryView?: unknown }).recoveryView === null;
		const gen2Observation = side.observer.observations.find((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), gen2Seed))!;
		// The fixture cursor contract is body-relative; the observer records the
		// SCREEN cursor, so the work-area bodyTop offset applies.
		const fixtureCursor = s17GenerationCursor(gen2, "F0");
		const expectedCursor = { x: fixtureCursor.x, y: dims.bodyTop + fixtureCursor.y, visible: fixtureCursor.visible };
		gen2Proof = {
			observedAt: gen2Observation.boundaryParsedAt,
			kind: gen2Observation.kind,
			literalMatched: true,
			gridSha256: sha256(gen2Observation.grid.map((row) => row.text).join("\n")),
			cursor: gen2Observation.cursor,
			expectedCursor,
			cursorMatched:
				gen2Observation.cursor.x === expectedCursor.x &&
				gen2Observation.cursor.y === expectedCursor.y &&
				gen2Observation.cursor.visible === expectedCursor.visible,
		};
		observation = await holdFormalObservation(now, sleep, "R-restart");
		// Initial side effects: REALLY observed before, not repeated after.
		hooks = compareInitialHooks(hooksBefore, { ...side.hooks });
		// FULL post-empty window: real reset/loading observation BEFORE gen-2, no
		// old generation or poison anywhere after the correlated empty end.
		resetAnalysis = analyzeRestartWindow(
			side.observer.observations.map((o) => ({ at: o.boundaryParsedAt, rows: projectedRows(o, dims), kind: o.kind, note: o.note })),
			{
				emptyEndAt: witness.end.at,
				staleGeneration: gen1,
				gen2Generation: gen2,
				poisonMarker: RESTART_POISON_MARKER,
				poisonPlanted: poisonPlant?.plantReadbackContained === true,
			},
		);
		if (resetAnalysis.recoveryKind === "missing" && measurementPath === "modern-reporter-viewproof") {
			throw new Error(`no outer reset/loading observation after the correlated empty baseline (window observations=${resetAnalysis.observationCount})`);
		}

		// Ordered cleanup of the CURRENT (gen-2) runner.
		await orderedExitThroughComponent({ component: side.component, runner, root, viewId, cleanup, label: "gen-2" });
	} catch (err) {
		error = err instanceof Error ? (err.stack ?? err.message) : String(err);
	} finally {
		capture.restore();
		try { frameReporter?.destroy(); } catch { /* best-effort */ }
		try {
			side?.component && (side.component as unknown as { dispose: () => void }).dispose();
		} catch {
			/* best-effort */
		}
		try {
			side?.tui.stop();
		} catch {
			/* best-effort */
		}
		if (side) {
			try {
				await Promise.race([side.observer.whenIdle(), sleep(2000)]);
			} catch {
				/* best-effort */
			}
		}
		// RU fix3: WRITE-level stale/poison gate over the FINAL write list (all
		// receipts through the ordered exit and dispose) and the retained
		// screen.log copy that proves the plant really existed in raw state.
		writeAnalysis =
			side !== null && emptyBaseline !== null
				? analyzePostEmptyWrites(
						side.observer.writes.map((write) => ({ index: write.index, receivedAt: write.receivedAt, data: write.data })),
						{ emptyEndAt: emptyBaseline.end.at, staleGeneration: gen1, poisonMarker: RESTART_POISON_MARKER },
					)
				: null;
		const retainedScreenLog = readTextOrNull(P.screenLogPath(root, viewId));
		poisonRetainedAtTeardown = retainedScreenLog === null ? null : retainedScreenLog.includes(RESTART_POISON_MARKER);
		if (retainedScreenLog !== null) {
			try {
				writeFileSync(join(artifactDir, "screen.log"), retainedScreenLog);
				screenLogArtifactBytes = Buffer.byteLength(retainedScreenLog, "utf8");
			} catch {
				/* recorded through artifactErrors */
				artifactErrors.push("screen.log: copy failed");
			}
		}
		const gen1EventsArtifact = copyChildEvents(eventsPath1, artifactDir, "child-events-gen1-raw.jsonl");
		const gen2EventsArtifact = copyChildEvents(eventsPath2, artifactDir, "child-events-gen2-raw.jsonl");
		await killOwnedDiagProcesses(runner, root, viewId, cleanup);
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
			cleanup.rootRemoved = true;
		} catch {
			/* recorded below */
		}
		cleanup.ok = diagCleanupOk(cleanup);
		try {
			side?.observer.dispose();
		} catch {
			/* best-effort */
		}
		writeArtifact("observations.json", { observations: side?.observer.observations ?? [] });
		writeArtifact("writes.json", side?.observer.writes ?? []);
		writeArtifact("controls.json", side?.observer.controls ?? []);
		writeArtifact("diagnostics.json", side?.diagnostics ?? []);
		writeArtifact("tx-lines.json", capture.txLines);
		writeArtifact("rx-lines.json", capture.rxLines);
		writeArtifact("child-events-gen1.jsonl", gen1EventsArtifact);
		writeArtifact("child-events-gen2.jsonl", gen2EventsArtifact);
		writeArtifact("cleanup.json", cleanup);
		writeArtifact("summary.json", {
			caseId: "R-restart",
			error,
			gen1Committed,
			gen2Committed,
			modernFrameWitness,
			oldViewsClearedAtEmpty,
			recoveryClearedAfterGen2,
			preEmptyDrain,
			attachEvents,
			emptyBaseline,
			preRestartGenerations,
			preRestartBaselineGenerations,
			preRestartGenerationsDiffer,
			poisonPlant,
			poisonRetainedAtTeardown,
			screenLogArtifactBytes,
			resetAnalysis,
			writeAnalysis,
			hooks,
			gen2Proof,
			hooksObserved: side ? { ...side.hooks } : null,
			doneResults: side?.doneResults ?? [],
			scenarioKills,
			cleanup,
			transportPatch: { target: "Socket.prototype.write", restoredInFinally: true },
			artifactErrors,
		});
	}
	const evidence = {
		gen1Committed,
		gen2Committed,
		modernFrameWitness,
		recoveryView: measurementPath === "legacy-no-reporter" ? "not-applicable" : "modern-recovery-window",
		oldViewsClearedAtEmpty,
		recoveryClearedAfterGen2,
		preEmptyDrain,
		attachEvents,
		emptyBaseline,
		preRestartGenerations,
		preRestartBaselineGenerations,
		preRestartGenerationsDiffer,
		poisonPlant,
		poisonRetainedAtTeardown,
		screenLogArtifactBytes,
		resetAnalysis,
		writeAnalysis,
		hooks,
		gen2Proof,
		hooksObserved: side ? { ...side.hooks } : null,
		doneResults: side?.doneResults ?? [],
		scenarioKills,
		cleanup,
		transportPatch: { target: "Socket.prototype.write", restoredInFinally: true },
	};
	return {
		caseId: "R-restart",
		ok:
			error === null &&
			gen1Committed &&
			gen2Committed &&
			emptyBaseline?.correlated === true &&
			preRestartGenerationsDiffer === true &&
			poisonPlant?.plantReadbackContained === true &&
			poisonRetainedAtTeardown === true &&
			(measurementPath === "legacy-no-reporter" || (writeAnalysis?.ok === true && resetAnalysis?.ok === true && hooks?.ok === true)) &&
			gen2Proof?.literalMatched === true &&
			gen2Proof?.cursorMatched === true &&
			cleanup.ok &&
			cleanup.forcedKills.length === 0,
		measurementPath,
		observation: observation ?? null,
		recoveryCompletion: observation === null ? "not-applicable" : "completed",
		recoveryView: measurementPath === "legacy-no-reporter" ? "not-applicable" : "modern-recovery-window",
		error,
		evidence,
		artifactDir,
	};
}

// ---------------------------------------------------------------------------
// U-unframed / U-legacy
// ---------------------------------------------------------------------------

/** Indeclared FULL unframed literal: the complete 80x22 work area after the
 *  documented echo input (`fake pi ready` + `echo:hello` + blank rows). */
const U_UNFRAMED_LITERAL = ["fake pi ready", "echo:hello", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];

const U_SHRINK = { cols: WORK_AREA.cols - 1, rows: WORK_AREA.rows - 1 } as const;

/** Declared legacy jiggle expectations: mount size, shrink-and-hold size. */
const U_SHRINK_EXPECTED = { cols: WORK_AREA.cols, rows: WORK_AREA.rows, shrinkCols: U_SHRINK.cols, shrinkRows: U_SHRINK.rows } as const;

function readChildInputReady(component: unknown): boolean {
	return (component as { childInputReady?: boolean } | null)?.childInputReady === true;
}

/** Wait (bounded) for the attach's LIVE input-readiness proof: the real outer
 *  TUI input handler exists and the child's bracketed-paste enable was observed
 *  in live bytes, so real input is not dropped by the readiness gate. */
async function waitChildInputReady(h: DiagTrialHandle, label: string): Promise<void> {
	await waitFor(
		() => h.primary.observer.inputHandler !== undefined && readChildInputReady(h.primary.component),
		10_000,
		`${label} live bracketed-paste input readiness`,
	);
}

interface FullLiteralEvidence {
	fullLiteralMatched: boolean;
	fullLiteralAt: number | null;
	inputEchoObserved: boolean;
	inputEchoAt: number | null;
	echoWriteCount: number;
}

/** REQUIRED bounded wait for the independently declared FULL literal. There is
 *  no partial (`rows[0] === "fake pi ready"`) success: the wait only completes
 *  on the complete literal, so the evidence snapshot below is taken AFTER the
 *  echo is really on screen. */
async function waitFullUnframedLiteral(h: DiagTrialHandle, label: string): Promise<FullLiteralEvidence> {
	let fullLiteralAt: number | null = null;
	let inputEchoAt: number | null = null;
	await waitFor(
		() => {
			for (const observation of h.primary.observer.observations) {
				const rows = projectedRows(observation, h.attachDims);
				if (inputEchoAt === null && rows.some((row) => row.includes("echo:hello"))) inputEchoAt = observation.boundaryParsedAt;
				if (rowsEqual(rows, U_UNFRAMED_LITERAL)) {
					fullLiteralAt = observation.boundaryParsedAt;
					return true;
				}
			}
			return false;
		},
		15_000,
		`${label} FULL literal (visible area) after real echo input`,
	);
	const echoWriteCount = h.readChildEvents().filter((event) => event.event === "stdout-write" && event.phase === "echo").length;
	return {
		fullLiteralMatched: fullLiteralAt !== null,
		fullLiteralAt,
		inputEchoObserved: inputEchoAt !== null,
		inputEchoAt,
		echoWriteCount,
	};
}

/** The resize commands the attach sent, in send order (full sequence so far). */
function resizeSequenceOf(h: DiagTrialHandle): ResizeEntry[] {
	return h
		.txMessages()
		.filter((message) => message.type === "resize")
		.map((message) => ({ cols: Number(message.msg.cols), rows: Number(message.msg.rows), at: message.at }));
}

/** Ordered child exit through the REAL public runner socket protocol. Needed
 *  after a PUBLIC detach (which closes the component's own input channel by
 *  design): `input` is the documented child stdin message, the unframed child
 *  exits on it, and the observations are the same ones diagOrderedExit makes
 *  (host state exited, runner exit). No process is killed. */
async function orderedExitViaPublicSocket(input: {
	socketPath: string;
	root: string;
	viewId: string;
	runner: ChildProcess | null;
	cleanup: DiagCleanup;
	label: string;
}): Promise<{ exitSent: boolean; childExited: boolean; runnerExited: boolean; rx: Record<string, unknown>[] }> {
	const socket = createConnection(input.socketPath);
	const rx: Record<string, unknown>[] = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				rx.push(JSON.parse(line) as Record<string, unknown>);
			} catch {
				/* non-protocol bytes ignored */
			}
		}
	});
	await new Promise<void>((resolveConnect, rejectConnect) => {
		socket.once("connect", () => resolveConnect());
		socket.once("error", rejectConnect);
	});
	socket.write(`${JSON.stringify({ type: "hello", clientId: `exit-${process.pid}`, wantOutput: false })}\n`);
	socket.write(`${JSON.stringify({ type: "input", data: producerCommand({ cmd: "exit" }) })}\n`);
	await waitFor(() => readHost(input.root, input.viewId)?.state === "exited", 5000, `${input.label} host state exited after public-socket input`);
	input.cleanup.childExited = true;
	if (input.runner && input.runner.exitCode === null && input.runner.signalCode === null) {
		const runner = input.runner;
		// Bounded wait with an explicitly cleared timer (no dangling race timer
		// can be mis-attributed to the component in the resource snapshot).
		await new Promise<void>((resolveExit) => {
			const timer = setTimeout(() => resolveExit(), 5000);
			runner.once("exit", () => {
				clearTimeout(timer);
				resolveExit();
			});
		});
	}
	if (input.runner) {
		input.cleanup.runnerExited = input.runner.exitCode !== null || input.runner.signalCode !== null;
		input.cleanup.runnerExitCode = input.runner.exitCode;
	}
	socket.destroy();
	return { exitSent: true, childExited: input.cleanup.childExited, runnerExited: input.cleanup.runnerExited, rx };
}

async function runUnframed(artifactDir: string): Promise<Record<string, unknown>> {
	const declared = {
		caseId: "U-unframed",
		fixture: "test-support/fake-pty-unframed-pi.mjs (documented default-child boot/echo + bracketed-paste enable)",
		literal: U_UNFRAMED_LITERAL,
		note: "real documented echo input; REQUIRED full literal visible area/source AFTER the echo; raw child bytes have no ?2026h/l; ordered child exit; no whole-frame guarantee",
	};
	const result = await withDiagTrial(
		{
			caseId: "U-unframed",
			childPath: UNFRAMED_CHILD,
			childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_EVENTS_PATH: eventsPath }),
			hostCols: WORK_AREA.cols,
			hostRows: WORK_AREA.rows,
			artifactDir,
			attachScreenLog: true,
			declared,
		},
		async (h) => {
			await h.holdMs("u-input-readiness", 500);
			await waitChildInputReady(h, "U-unframed");
			const childInputReadyObserved = readChildInputReady(h.primary.component);
			(h.primary.component as unknown as { handleInput: (d: string) => void }).handleInput("hello");
			// Evidence is snapshotted only AFTER the required FULL literal wait.
			const literal = await waitFullUnframedLiteral(h, "U-unframed");
			// Retained raw child stream (hash-equivalent; no sync markers).
			const screenLog = readFileSync(P.screenLogPath(h.root, h.viewId), "utf8");
			const markers = syncMarkerPresence(screenLog);
			const rawObserver = new AttachPresentationObserver({ cols: WORK_AREA.cols, rows: WORK_AREA.rows, now });
			rawObserver.write(screenLog);
			await rawObserver.whenIdle();
			const kinds = rawObserver.observations.map((o) => o.kind);
			const rawObserverAllUnframed = kinds.length > 0 && kinds.every((k) => k === "unframed");
			rawObserver.dispose();
			const observation = await holdFormalObservation(now, sleep, "U-unframed");
			// Ordered exit through the accepted helper, then the teardown facts.
			await diagOrderedExit(h);
			const evidence = {
				...literal,
				observation,
				hasSyncOpen: markers.hasOpen,
				hasSyncClose: markers.hasClose,
				allUnframed: markers.allUnframed,
				rawObserverKinds: kinds,
				rawObserverAllUnframed,
				childInputReadyObserved,
				orderedExit: {
					childExited: h.cleanup.childExited,
					runnerExited: h.cleanup.runnerExited,
					runnerExitCode: h.cleanup.runnerExitCode,
				},
				rawBytesSha256: sha256(screenLog),
				note: "raw child bytes carry no ?2026h/l and the raw observer records only unframed windows; the REQUIRED full literal matched after the real echo; child/runner exited in order; no whole-frame guarantee inferred",
			};
			return { evidence, teardownAllowedRowTexts: [...Object.values(HEADER_BY_STATUS), "─".repeat(WORK_AREA.cols)] };
		},
	);
	const evidence = result.evidence as
		| (FullLiteralEvidence & {
				hasSyncOpen: boolean;
				hasSyncClose: boolean;
				rawObserverAllUnframed: boolean;
				childInputReadyObserved: boolean;
				orderedExit: { childExited: boolean; runnerExited: boolean; runnerExitCode: number | null };
		  })
		| undefined;
	const cleanup = result.cleanup as DiagCleanup | undefined;
	const observation = (result.evidence as { observation?: unknown } | undefined)?.observation ?? null;
	return {
		caseId: "U-unframed",
		measurementPath: "legacy-no-reporter",
		observation,
		recoveryCompletion: "not-applicable",
		ok:
			result.ok === true &&
			cleanup?.ok === true &&
			cleanup.forcedKills.length === 0 &&
			evidence?.fullLiteralMatched === true &&
			evidence.inputEchoObserved === true &&
			evidence.childInputReadyObserved === true &&
			evidence.hasSyncOpen === false &&
			evidence.hasSyncClose === false &&
			evidence.rawObserverAllUnframed === true &&
			evidence.orderedExit?.childExited === true &&
			evidence.orderedExit?.runnerExited === true,
		error: (result.error as string | null) ?? null,
		cleanup: result.cleanup,
		evidence: result.evidence,
		artifactDir,
	};
}

async function runLegacy(artifactDir: string): Promise<Record<string, unknown>> {
	const declared = {
		caseId: "U-legacy",
		fixture: "test-support/fake-pty-unframed-pi.mjs (documented default-child boot/echo + bracketed-paste enable)",
		literal: U_UNFRAMED_LITERAL,
		note: "force legacy via AGENT_BOARD_TERMINAL_SNAPSHOT=0 only inside this process; zero subscribe/snapshot; REQUIRED full literal after the real echo; real shrink-then-restore jiggle; PUBLIC detach; ordered child exit; env restored",
	};
	const previous = process.env.AGENT_BOARD_TERMINAL_SNAPSHOT;
	const restoreEnv = previous === undefined ? () => delete process.env.AGENT_BOARD_TERMINAL_SNAPSHOT : () => { process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = previous; };
	process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = "0";
	let result: Record<string, unknown> | null = null;
	let envRestoredFlag = false;
	let trial: DiagTrialHandle | null = null;
	// Detach timestamp for the restore-trigger classification (postTeardown runs
	// after the body, so the value must survive the body scope).
	const legacyState: { detachAt: number | null } = { detachAt: null };
	try {
		result = await withDiagTrial(
			{
				caseId: "U-legacy",
				childPath: UNFRAMED_CHILD,
				childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_EVENTS_PATH: eventsPath }),
				hostCols: WORK_AREA.cols,
				hostRows: WORK_AREA.rows,
				artifactDir,
				attachScreenLog: true,
				declared,
				// COMPLETE resize sequence at real teardown (after dispose/stop and
				// the observer drain), so a restore emitted during the public detach
				// or close is always part of the captured sequence.
				postTeardown: () => {
					const sequence = trial === null ? [] : resizeSequenceOf(trial);
					return { resizeSequence: sequence, analysis: analyzeLegacyResizeSequence(sequence, { ...U_SHRINK_EXPECTED, detachAt: legacyState.detachAt }) };
				},
			},
			async (h) => {
				trial = h;
				await h.holdMs("u-input-readiness", 500);
				await waitChildInputReady(h, "U-legacy");
				const childInputReadyObserved = readChildInputReady(h.primary.component);
				(h.primary.component as unknown as { handleInput: (d: string) => void }).handleInput("hello");
				// Evidence is snapshotted only AFTER the required FULL literal wait.
				const literal = await waitFullUnframedLiteral(h, "U-legacy");
				const observationStartMs = now();
				// Settle/probe evidence on the real public seams (retained writes).
				const writes = h.primary.observer.writes;
				const probeQuery = writes.find((write) => write.data.includes("\x1b]11;?")) ?? null;
				const settleWrite = writes.find((write) => write.data.includes("attached · opens links")) ?? null;
				const settleOutcomes = (h.primary.diagnostics as Array<{ code?: string; details?: { outcome?: string } }>)
					.filter((event) => event.code === "attach_settle_scheme")
					.map((event) => event.details?.outcome ?? "unknown");
				// Bounded wait for the legacy hold's OWN restore BEFORE detaching
				// (the child never renders a TUI frame/clear, so G1 at ~6s restores).
				// If it does not arrive, the documented G3 detach restore below is the
				// restore witness and the trigger is recorded truthfully.
				try {
					await waitFor(
						() => analyzeLegacyResizeSequence(resizeSequenceOf(h), U_SHRINK_EXPECTED).restore !== null,
						9_000,
						"U-legacy natural jiggle restore",
					);
				} catch {
					/* recorded via restoreTrigger below */
				}
				const subscribeMessages = h.txMessages().filter((message) => message.type === "subscribe_terminal");
				const snapshotMessages = h.rxMessages().filter((message) => ["snapshot_begin", "snapshot_end", "snapshot_frame"].includes(message.type));
				// Observation overlaps the real natural-restore wait: first content was
				// already committed before that wait, and the observer stays mounted.
				const elapsedObservationMs = now() - observationStartMs;
				if (elapsedObservationMs < 3000) await sleep(3000 - elapsedObservationMs + 50);
				const observationEndMs = now();
				const observation = {
					label: "U-legacy",
					observationStartMs,
					observationEndMs,
					observationActualMs: observationEndMs - observationStartMs,
					observationCompletion: "completed",
				};
				// PUBLIC detach (Ctrl+\ through the component's real input path) while
				// the socket is still live: the documented G3 restore runs before the
				// detach packet and `done({action:"detached"})` is the detach result.
				const detachAt = now();
				legacyState.detachAt = detachAt;
				(h.primary.component as unknown as { handleInput: (d: string) => void }).handleInput("\u001c");
				await waitFor(() => (h.primary.doneResult as { action?: string } | null)?.action === "detached", 5000, "U-legacy public detach done(action=detached)");
				const detachDoneResult = h.primary.doneResult;
				// The public detach closed the component's own input channel, so the
				// ordered exit uses the runner's documented public `input` protocol on
				// the SAME owned host (no forced kill is the normal exit).
				const diagPlatform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
				const exitEvidence = await orderedExitViaPublicSocket({
					socketPath: P.hostEndpointPathFor(diagPlatform, h.root, h.viewId, `inst-${h.viewId}-${process.pid}`),
					root: h.root,
					viewId: h.viewId,
					runner: h.runner,
					cleanup: h.cleanup,
					label: "U-legacy",
				});
				const evidence = {
					...literal,
					observation,
					legacyForced: process.env.AGENT_BOARD_TERMINAL_SNAPSHOT === "0",
					noSubscribe: subscribeMessages.length === 0,
					subscribeCount: subscribeMessages.length,
					snapshotMessageCount: snapshotMessages.length,
					childInputReadyObserved,
					settleEvidence: {
						probeQueryWriteIndex: probeQuery?.index ?? null,
						probeQueryAt: probeQuery?.receivedAt ?? null,
						settleWriteIndex: settleWrite?.index ?? null,
						settleWriteAt: settleWrite?.receivedAt ?? null,
						settleOutcomes,
					},
					detach: { at: detachAt, doneResult: detachDoneResult },
					orderedExit: exitEvidence,
					resizeSequenceBeforeDetach: resizeSequenceOf(h),
					note: "legacy path sent zero subscribe/snapshot messages and armed the real shrink-then-restore jiggle; env is restored after the scenario; no snapshot-mode or modern-latency claim",
				};
				return { evidence, teardownAllowedRowTexts: [...Object.values(HEADER_BY_STATUS), "─".repeat(WORK_AREA.cols)] };
			},
		);
	} finally {
		restoreEnv();
		envRestoredFlag = process.env.AGENT_BOARD_TERMINAL_SNAPSHOT === previous;
	}
	const evidence = result?.evidence as
		| (FullLiteralEvidence & {
				legacyForced: boolean;
				noSubscribe: boolean;
				subscribeCount: number;
				snapshotMessageCount: number;
				childInputReadyObserved: boolean;
				settleEvidence: { probeQueryAt: number | null; settleWriteAt: number | null };
				detach: { at: number; doneResult: { action?: string } | null };
				orderedExit: { childExited: boolean; runnerExited: boolean };
		  })
		| undefined;
	const cleanup = result?.cleanup as DiagCleanup | undefined;
	const teardownAnalysis = (result?.postTeardownAnalysis as { analysis?: LegacyResizeAnalysis } | undefined)?.analysis;
	const observation = (result?.evidence as { observation?: unknown } | undefined)?.observation ?? null;
	return {
		caseId: "U-legacy",
		measurementPath: "legacy-no-reporter",
		observation,
		recoveryCompletion: "not-applicable",
		ok:
			result?.ok === true &&
			cleanup?.ok === true &&
			cleanup.forcedKills.length === 0 &&
			evidence?.fullLiteralMatched === true &&
			evidence.inputEchoObserved === true &&
			evidence.childInputReadyObserved === true &&
			evidence.legacyForced === true &&
			evidence.noSubscribe === true &&
			evidence.snapshotMessageCount === 0 &&
			evidence.detach?.doneResult?.action === "detached" &&
			evidence.orderedExit?.childExited === true &&
			evidence.orderedExit?.runnerExited === true &&
			teardownAnalysis?.ok === true &&
			envRestoredFlag,
		error: (result?.error as string | null) ?? null,
		cleanup: result?.cleanup,
		envRestored: envRestoredFlag,
		evidence: result?.evidence,
		teardownAnalysis,
		artifactDir,
	};
}

// ---------------------------------------------------------------------------
// D1: deterministic lifecycle, product-RED evidence, resource identity
// ---------------------------------------------------------------------------

/**
 * Measured endpoint-path safety margin. D1 probes in this environment
 * (`d1-endpoint-limit-probe*`, `d1-relative-path-repro-*`) bound unix socket
 * paths of 113 chars (synthetic real server) and 139 chars (real-runner repro
 * layout) and failed with EADDRINUSE at 114 / 140 — the measured threshold is
 * PATH-SHAPE dependent, so no single numeric platform limit is claimed. D1
 * therefore keeps trial endpoints far below every measured threshold and fails
 * fast with an explicit infrastructure error instead of a 10 s host timeout.
 */
const D1_ENDPOINT_SAFE_LENGTH = 100;

export interface EndpointPathCheck {
	socketPath: string;
	length: number;
	safeLength: number;
	ok: boolean;
	note: string;
}

export function checkEndpointPath(socketPath: string): EndpointPathCheck {
	return {
		socketPath,
		length: socketPath.length,
		safeLength: D1_ENDPOINT_SAFE_LENGTH,
		ok: socketPath.length <= D1_ENDPOINT_SAFE_LENGTH,
		note: "D30 signature (host_endpoint_busy/EADDRINUSE) reproduced when the per-trial endpoint path grows; failure OBSERVED at 139 chars and DETERMINISTIC at 140 for the relative repro shape (synthetic sweep boundary 113/114) - path-shape dependent, no universal constant",
	};
}

/** One owned timer created while the tracker is installed (exact attribution by
 *  construction; timers created before installation are UNATTRIBUTABLE). */
export interface OwnedTimer {
	id: number;
	kind: "timeout" | "interval";
	ms: number;
	createdAt: number;
	clearedAt: number | null;
	firstFiredAt: number | null;
	firedCount: number;
	/** "case" = component/TUI code under test; "harness" = D1 harness timers
	 *  (runner spawn sampler / log flush) that must never be counted as owned
	 *  residual. */
	owner: "case" | "harness";
}

export interface LiveTimerClassification {
	intervals: Array<{ id: number; ms: number }>;
	oneShotBounded: Array<{ id: number; ms: number }>;
	oneShotLong: Array<{ id: number; ms: number }>;
}

/** Attribute live owned timers: an INTERVAL still live after teardown is a real
 *  owned leak candidate; a bounded one-shot timeout that has not fired yet will
 *  resolve on its own (recorded, not a leak); a long one-shot is UNKNOWN. */
export function classifyLiveTimers(live: readonly { id: number; kind: string; ms: number }[]): LiveTimerClassification {
	const intervals = live.filter((timer) => timer.kind === "interval").map((timer) => ({ id: timer.id, ms: timer.ms }));
	const oneShotBounded = live.filter((timer) => timer.kind === "timeout" && timer.ms <= 2000).map((timer) => ({ id: timer.id, ms: timer.ms }));
	const oneShotLong = live.filter((timer) => timer.kind === "timeout" && timer.ms > 2000).map((timer) => ({ id: timer.id, ms: timer.ms }));
	return { intervals, oneShotBounded, oneShotLong };
}

export interface ResourceSnapshot {
	label: string;
	at: number;
	ownedTimersLive: number;
	ownedTimersLiveDetail: Array<{ id: number; kind: string; ms: number }>;
	ownedTimerClassification: LiveTimerClassification;
	ownedTimerIntervalsLive: number;
	ownedTimersCreated: number;
	ownedTimersCleared: number;
	harnessTimersLive: number;
	harnessTimersLiveDetail: Array<{ id: number; kind: string; ms: number }>;
	sockets: Array<{ id: number; readyState: string; destroyed: boolean; dataListeners: number }>;
	socketsOpen: number;
	hookLifecycle: HookLifecycle | null;
	/** Bounded wait for the component's graceful socket close before this
	 *  snapshot (a socket still `open` at snapshot time is not automatically a
	 *  leak: close(true) uses a graceful window). */
	socketCloseWaitedMs: number;
	unattributable: string;
}

interface ResourceTracker {
	timers: OwnedTimer[];
	restore: () => void;
	/** Live timers owned by the CASE (component/TUI). */
	liveTimers: () => OwnedTimer[];
	/** Live HARNESS-owned timers (reported separately, never residual). */
	liveHarnessTimers: () => OwnedTimer[];
	/** Tag timers created inside this section as harness-owned. */
	beginHarnessSection: () => void;
	endHarnessSection: () => void;
}

/** Test-side timer instrumentation: wrap the GLOBAL timer functions for the
 *  duration of one trial so every timer the in-process component/TUI schedules
 *  is attributed by construction (cleared/fired tracked). The globals are
 *  restored in the trial's `finally`. Timers scheduled from code that captured
 *  the originals before installation remain UNATTRIBUTABLE (reported, never
 *  claimed clean). */
function createResourceTracker(): ResourceTracker {
	const timers: OwnedTimer[] = [];
	const byHandle = new Map<unknown, OwnedTimer>();
	const originalSetTimeout = globalThis.setTimeout;
	const originalSetInterval = globalThis.setInterval;
	const originalClearTimeout = globalThis.clearTimeout;
	const originalClearInterval = globalThis.clearInterval;
	let nextId = 1;
	let harnessSection = false;
	const create = (kind: "timeout" | "interval", ms: number): OwnedTimer => {
		const record: OwnedTimer = { id: nextId, kind, ms, createdAt: now(), clearedAt: null, firstFiredAt: null, firedCount: 0, owner: harnessSection ? "harness" : "case" };
		nextId += 1;
		timers.push(record);
		return record;
	};
	globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
		const record = create("timeout", Number(ms ?? 0));
		const handle = originalSetTimeout(() => {
			record.firedCount += 1;
			if (record.firstFiredAt === null) record.firstFiredAt = now();
			byHandle.delete(handle);
			fn(...args);
		}, ms);
		byHandle.set(handle, record);
		return handle;
	}) as unknown as typeof globalThis.setTimeout;
	globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
		const record = create("interval", Number(ms ?? 0));
		const handle = originalSetInterval(() => {
			record.firedCount += 1;
			if (record.firstFiredAt === null) record.firstFiredAt = now();
			fn(...args);
		}, ms);
		byHandle.set(handle, record);
		return handle;
	}) as unknown as typeof globalThis.setInterval;
	globalThis.clearTimeout = ((handle: unknown) => {
		const record = byHandle.get(handle);
		if (record !== undefined && record.clearedAt === null) record.clearedAt = now();
		byHandle.delete(handle);
		return originalClearTimeout(handle as Parameters<typeof originalClearTimeout>[0]);
	}) as unknown as typeof globalThis.clearTimeout;
	globalThis.clearInterval = ((handle: unknown) => {
		const record = byHandle.get(handle);
		if (record !== undefined && record.clearedAt === null) record.clearedAt = now();
		byHandle.delete(handle);
		return originalClearInterval(handle as Parameters<typeof originalClearInterval>[0]);
	}) as unknown as typeof globalThis.clearInterval;
	return {
		timers,
		restore: () => {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.setInterval = originalSetInterval;
			globalThis.clearTimeout = originalClearTimeout;
			globalThis.clearInterval = originalClearInterval;
		},
		liveTimers: () => timers.filter((timer) => timer.owner === "case" && timer.clearedAt === null && (timer.kind === "interval" || timer.firedCount === 0)),
		liveHarnessTimers: () => timers.filter((timer) => timer.owner === "harness" && timer.clearedAt === null && (timer.kind === "interval" || timer.firedCount === 0)),
		beginHarnessSection: () => {
			harnessSection = true;
		},
		endHarnessSection: () => {
			harnessSection = false;
		},
	};
}

function resourceSnapshot(
	label: string,
	tracker: ResourceTracker | null,
	capture: TransportCapture | null,
	hooks: HookLifecycle | null,
	socketCloseWaitedMs = 0,
): ResourceSnapshot {
	const live = tracker === null ? [] : tracker.liveTimers();
	const harnessLive = tracker === null ? [] : tracker.liveHarnessTimers();
	const sockets: ResourceSnapshot["sockets"] = [];
	if (capture !== null) {
		for (const [id, socket] of capture.sockets) {
			sockets.push({
				id,
				readyState: (socket as unknown as { readyState?: string }).readyState ?? "unknown",
				destroyed: (socket as unknown as { destroyed?: boolean }).destroyed === true,
				dataListeners: socket.listenerCount("data"),
			});
		}
	}
	const classification = classifyLiveTimers(live);
	return {
		label,
		at: now(),
		ownedTimersLive: live.length,
		ownedTimersLiveDetail: live.slice(0, 25).map((timer) => ({ id: timer.id, kind: timer.kind, ms: timer.ms })),
		ownedTimerClassification: classification,
		ownedTimerIntervalsLive: classification.intervals.length,
		ownedTimersCreated: tracker === null ? 0 : tracker.timers.length,
		ownedTimersCleared: tracker === null ? 0 : tracker.timers.filter((timer) => timer.clearedAt !== null).length,
		harnessTimersLive: harnessLive.length,
		harnessTimersLiveDetail: harnessLive.slice(0, 10).map((timer) => ({ id: timer.id, kind: timer.kind, ms: timer.ms })),
		sockets,
		socketsOpen: sockets.filter((socket) => !socket.destroyed && socket.readyState !== "closed").length,
		hookLifecycle: hooks === null ? null : { ...hooks },
		socketCloseWaitedMs,
		unattributable:
			tracker === null
				? "timer instrumentation not installed: timer identity UNKNOWN"
				: "timers scheduled by code that captured the global timer functions before instrumentation stay UNATTRIBUTABLE (UNKNOWN)",
	};
}

/** Bounded drain for owned ONE-SHOT timers after the component/TUI teardown:
 *  fires them naturally (they are bounded by construction) and reports what is
 *  still live at the end. A surviving one-shot is NOT clean. */
async function awaitOneShotDrain(tracker: ResourceTracker | null, timeoutMs: number): Promise<{ waitedMs: number; remaining: number }> {
	const start = now();
	if (tracker === null) return { waitedMs: 0, remaining: -1 };
	while (now() - start < timeoutMs) {
		const liveOneShots = tracker.liveTimers().filter((timer) => timer.kind === "timeout");
		if (liveOneShots.length === 0) return { waitedMs: now() - start, remaining: 0 };
		await sleep(20);
	}
	const remaining = tracker.liveTimers().filter((timer) => timer.kind === "timeout").length;
	return { waitedMs: now() - start, remaining };
}

/** Observe-only instrumentation of the REAL component parser, mirroring the
 *  accepted 20A `instrumentInnerParser` seam: wraps the real xterm `write` and
 *  registers real CSI handlers on the REAL parser. Nothing is replaced, no
 *  callback is invoked manually and no private state is forced; the private
 *  `term` read is the same accepted test-instrumentation pattern. */
type ParserLogEntry = {
	kind: string;
	at: number;
	bytes: number;
	sha256: string;
	connectionToken?: number | null;
	baselineToken?: number | null;
	parserEpoch?: number | null;
	stale?: boolean;
};

function instrumentComponentParser(
	component: unknown,
	log: ParserLogEntry[],
	parserIdentity: string,
): () => void {
	const state = component as {
		term?: { write: (data: string, cb?: () => void) => void; parser?: { registerCsiHandler: (opts: { prefix: string; final: string }, cb: (params: unknown[]) => boolean) => { dispose: () => void } } };
		connectionToken?: number;
		baselineToken?: number;
		parserEpoch?: number;
	};
	if (state.term === undefined || typeof state.term.write !== "function" || state.term.parser === undefined) {
		throw new Error("no real component parser available for the accepted observe-only instrumentation");
	}
	let current: typeof state.term | null = null;
	let originalWrite: ((data: string, callback?: () => void) => void) | null = null;
	let disposables: Array<{ dispose: () => void }> = [];
	let identity: { connectionToken: number | null; baselineToken: number | null; parserEpoch: number | null } = { connectionToken: null, baselineToken: null, parserEpoch: null };
	const detach = () => {
		if (current === null) return;
		log.push({ kind: "parser-detach", at: now(), bytes: 0, sha256: "", ...identity, stale: state.term !== current });
		if (originalWrite !== null) (current as unknown as { write: unknown }).write = originalWrite;
		for (const disposable of disposables) disposable.dispose();
		disposables = [];
		originalWrite = null;
		current = null;
	};
	const attach = (term: NonNullable<typeof state.term>) => {
		detach();
		current = term;
		identity = {
			connectionToken: typeof state.connectionToken === "number" ? state.connectionToken : null,
			baselineToken: typeof state.baselineToken === "number" ? state.baselineToken : null,
			parserEpoch: typeof state.parserEpoch === "number" ? state.parserEpoch : null,
		};
		log.push({ kind: `parser-identity:${parserIdentity}`, at: now(), bytes: 0, sha256: "", ...identity });
		const parser = term.parser;
		if (!parser) return;
		const original = term.write.bind(term);
		originalWrite = original;
		(term as unknown as { write: unknown }).write = (data: string, callback?: () => void) => {
			log.push({ kind: "write", at: now(), bytes: Buffer.byteLength(data, "utf8"), sha256: sha256(data), ...identity, stale: state.term !== term });
			return original(data, callback);
		};
		disposables = [
			parser.registerCsiHandler({ prefix: "?", final: "h" }, () => {
				log.push({ kind: "csi-open", at: now(), bytes: 0, sha256: "", ...identity, stale: state.term !== term });
				return false;
			}),
			parser.registerCsiHandler({ prefix: "?", final: "l" }, () => {
				log.push({ kind: "csi-close", at: now(), bytes: 0, sha256: "", ...identity, stale: state.term !== term });
				return false;
			}),
		];
	};
	const install = () => {
		const term = state.term;
		if (term && term !== current) attach(term);
	};
	const replaceTarget = state as unknown as { replaceParser?: () => boolean };
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
		detach();
	};
}

/** Bounded wait until every captured client socket is destroyed/closed. The
 *  component closes gracefully (bounded window), so a snapshot taken instantly
 *  after dispose can legitimately still see one `open` socket; this wait makes
 *  the residual metric truthful without hiding a socket that never closes. */
async function awaitSocketsClosed(capture: TransportCapture, timeoutMs: number): Promise<{ waitedMs: number; remaining: number }> {
	const start = now();
	const isOpen = (socket: Socket) =>
		(socket as unknown as { destroyed?: boolean }).destroyed !== true && (socket as unknown as { readyState?: string }).readyState !== "closed";
	while (now() - start < timeoutMs) {
		let open = 0;
		for (const socket of capture.sockets.values()) if (isOpen(socket)) open += 1;
		if (open === 0) return { waitedMs: now() - start, remaining: 0 };
		await sleep(20);
	}
	let remaining = 0;
	for (const socket of capture.sockets.values()) if (isOpen(socket)) remaining += 1;
	return { waitedMs: now() - start, remaining };
}

/** Per-spawn runner record (D1 diagnosis). Absolute paths only; stderr/stdout are
 *  captured to files and tails are never discarded. */
export interface RunnerSpawnRecord {
	label: string;
	iteration: number | null;
	argv: string[];
	root: string;
	configPath: string;
	socketPath: string;
	endpoint: EndpointPathCheck;
	spawnedAt: number;
	pid: number | null;
	asyncError: { at: number; code: string | null; message: string } | null;
	exit: { at: number; code: number | null; signal: string | null } | null;
	close: { at: number; code: number | null; signal: string | null } | null;
	stderrFile: string | null;
	stdoutFile: string | null;
	stderrTail: string;
	stdoutTail: string;
	hostTransitions: Array<{ at: number; state: string; runnerPid: number | null; childPid: number | null }>;
}

/** Spawn a REAL runner with absolute paths and full per-spawn instrumentation.
 *  Host state transitions are sampled (bounded) until the caller stops it. */
function spawnInstrumentedRunner(input: {
	label: string;
	iteration?: number | null;
	root: string;
	viewId: string;
	instanceId: string;
	socketPath: string;
	configPath: string;
	childPath: string;
	childEnv: Record<string, string>;
	sessionFile: string;
	artifactDirForLogs: string;
}): { runner: ChildProcess; record: RunnerSpawnRecord; stopSampling: () => void; readLogs: () => { stderr: string; stdout: string } } {
	const stderrFile = join(input.artifactDirForLogs, `${input.label}-runner.stderr.log`);
	const stdoutFile = join(input.artifactDirForLogs, `${input.label}-runner.stdout.log`);
	const stderrChunks: string[] = [];
	const stdoutChunks: string[] = [];
	const spawnedAt = now();
	const record: RunnerSpawnRecord = {
		label: input.label,
		iteration: input.iteration ?? null,
		argv: [process.execPath, resolve(REPO_ROOT, "runner/pty-runner.mjs"), input.configPath],
		root: resolve(input.root),
		configPath: resolve(input.configPath),
		socketPath: input.socketPath,
		endpoint: checkEndpointPath(input.socketPath),
		spawnedAt,
		pid: null,
		asyncError: null,
		exit: null,
		close: null,
		stderrFile,
		stdoutFile,
		stderrTail: "",
		stdoutTail: "",
		hostTransitions: [],
	};
	// Absolute paths in the config so the runner never resolves against a
	// different cwd (D30 repro: relative per-trial endpoints crossed the measured
	// path-length threshold and the bind failed with EADDRINUSE).
	atomicWriteJson(input.configPath, {
		root: resolve(input.root),
		viewId: input.viewId,
		instanceId: input.instanceId,
		socketPath: input.socketPath,
		sessionFile: input.sessionFile,
		cwd: resolve(input.root),
		initialPrompt: null,
		piCommand: process.execPath,
		piArgsPrefix: [input.childPath],
		model: null,
		tools: null,
		env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", ...input.childEnv },
		cols: WORK_AREA.cols,
		rows: WORK_AREA.rows,
	});
	const runner = spawn(process.execPath, record.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
	record.pid = runner.pid ?? null;
	runner.stdout?.setEncoding("utf8");
	runner.stderr?.setEncoding("utf8");
	runner.stdout?.on("data", (chunk: string) => stdoutChunks.push(chunk));
	runner.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));
	runner.on("error", (err) => {
		record.asyncError = { at: now(), code: (err as NodeJS.ErrnoException).code ?? null, message: err.message };
	});
	runner.on("exit", (code, signal) => {
		record.exit = { at: now(), code, signal };
	});
	runner.on("close", (code, signal) => {
		record.close = { at: now(), code, signal };
	});
	let lastState = "";
	const sampler = setInterval(() => {
		const host = readHost(input.root, input.viewId);
		const state = host?.state ?? "(none)";
		if (state === lastState) return;
		lastState = state;
		record.hostTransitions.push({ at: now(), state, runnerPid: host?.runnerPid ?? null, childPid: host?.childPid ?? null });
	}, 20);
	sampler.unref?.();
	const stopSampling = () => clearInterval(sampler);
	const readLogs = () => ({ stderr: stderrChunks.join(""), stdout: stdoutChunks.join("") });
	// Continuous persistence so a crash/failure keeps its output even if the
	// harness dies before the trial's finally.
	const flush = setInterval(() => {
		try {
			writeFileSync(stderrFile, stderrChunks.join(""));
			writeFileSync(stdoutFile, stdoutChunks.join(""));
		} catch {
			/* retained best-effort */
		}
	}, 100);
	flush.unref?.();
	runner.on("close", () => clearInterval(flush));
	return { runner, record, stopSampling, readLogs };
}

/** Bounded post-dispose observation: every outer write received AFTER disposeAt
 *  with its exact bytes/hash/timing and the projected grid at that boundary. */
interface PostCloseWriteRecord {
	index: number;
	receivedAt: number;
	bytes: number;
	sha256: string;
	head: string;
	kind: string | null;
	containsNewContent: boolean;
	preCloseRequestRenderSeq: number | null;
	postCloseRequestRenderSeq: number | null;
}

function collectPostCloseWrites(input: {
	writes: readonly { index: number; data: string; receivedAt: number }[];
	disposeAt: number;
	newContentMarkers: readonly string[];
	requestRenderLog: readonly RequestRenderEntry[];
}): PostCloseWriteRecord[] {
	return input.writes
		.filter((write) => write.receivedAt > input.disposeAt)
		.map((write) => {
			const preClose = input.requestRenderLog.filter((entry) => entry.at <= input.disposeAt);
			const postClose = input.requestRenderLog.filter((entry) => entry.at > input.disposeAt);
			return {
				index: write.index,
				receivedAt: write.receivedAt,
				bytes: Buffer.byteLength(write.data, "utf8"),
				sha256: sha256(write.data),
				head: write.data.slice(0, 160),
				kind: null,
				containsNewContent: input.newContentMarkers.some((marker) => write.data.includes(marker)),
				preCloseRequestRenderSeq: preClose.length === 0 ? null : preClose[preClose.length - 1].seq,
				postCloseRequestRenderSeq: postClose.length === 0 ? null : postClose[0].seq,
			};
		});
}

/** Zero-post-close assertion (REAL assertion, not diagnostic): the trial is
 *  product-CLEAN only when no outer write/frame lands after disposeAt. */
/** Explicit resource gates for one post-teardown snapshot. Everything here must
 *  hold for a case to be called clean; a missing/unknown fact stays UNKNOWN and
 *  FAILS the gate (never laundered into "clean"). */
export interface ResourceGates {
	intervalsLive: number;
	oneShotsLive: number;
	socketsOpen: number;
	bridgeUnsubscribes: number;
	harnessTimersLive: number;
	intervalsZero: boolean;
	oneShotsZero: boolean;
	socketsZero: boolean;
	bridgeUnsubscribed: boolean;
	ok: boolean;
	note: string;
}

export function resourceGates(snapshot: ResourceSnapshot | null, hookLifecycle: HookLifecycle | null, requiredBridgeUnsubscribes = 1): ResourceGates {
	const intervalsLive = snapshot === null ? -1 : snapshot.ownedTimerIntervalsLive;
	const oneShotsLive = snapshot === null ? -1 : snapshot.ownedTimerClassification.oneShotBounded.length;
	const socketsOpen = snapshot === null ? -1 : snapshot.socketsOpen;
	const bridgeUnsubscribes = hookLifecycle === null ? -1 : hookLifecycle.bridgeUnsubscribes;
	const harnessTimersLive = snapshot === null ? -1 : snapshot.harnessTimersLive;
	const intervalsZero = intervalsLive === 0;
	const oneShotsZero = oneShotsLive === 0;
	const socketsZero = socketsOpen === 0;
	const bridgeUnsubscribed = bridgeUnsubscribes >= requiredBridgeUnsubscribes;
	return {
		intervalsLive,
		oneShotsLive,
		socketsOpen,
		bridgeUnsubscribes,
		harnessTimersLive,
		intervalsZero,
		oneShotsZero,
		socketsZero,
		bridgeUnsubscribed,
		ok: intervalsZero && oneShotsZero && socketsZero && bridgeUnsubscribed && snapshot !== null && hookLifecycle !== null,
		note:
			snapshot === null
				? "UNKNOWN: no post-teardown snapshot"
				: "gates require zero live owned intervals AND zero live owned one-shots after the bounded drain, zero open sockets and the expected TUI unsubscriptions",
	};
}

export function postCloseProductClean(input: {
	postCloseWrites: number;
	postCloseFrames: number;
	duplicatePublishes: number;
	stalePublishes: number;
	doneCount: number;
	hookRegistrations: number;
	/** Owned timers still live after teardown, split by attribution class. A live
	 *  INTERVAL is a leak candidate; a bounded one-shot timeout fires on its own
	 *  (recorded as evidence, not laundered into "clean"). */
	ownedTimerIntervalsLive: number;
	ownedTimerOneShotsLive: number;
	socketsOpenAfterDispose: number;
	bridgeUnsubscribes?: number;
	requiredBridgeUnsubscribes?: number;
}): { zeroPostClose: boolean; noDuplicatePublish: boolean; hooksAtMostOnce: boolean; noOwnedResidual: boolean; bridgeUnsubscribed: boolean; boundedTimersPending: boolean; productClean: boolean } {
	const zeroPostClose = input.postCloseWrites === 0 && input.postCloseFrames === 0;
	const noDuplicatePublish = input.duplicatePublishes === 0 && input.stalePublishes === 0;
	const hooksAtMostOnce = input.doneCount <= 1 && input.hookRegistrations <= 1;
	// A pending bounded one-shot is NO LONGER automatically clean: after the
	// bounded drain, any live owned one-shot is a residual (or UNKNOWN).
	const noOwnedResidual = input.ownedTimerIntervalsLive === 0 && input.ownedTimerOneShotsLive === 0 && input.socketsOpenAfterDispose === 0;
	const bridgeUnsubscribed = (input.bridgeUnsubscribes ?? 0) >= (input.requiredBridgeUnsubscribes ?? 0);
	const boundedTimersPending = input.ownedTimerOneShotsLive > 0;
	return {
		zeroPostClose,
		noDuplicatePublish,
		hooksAtMostOnce,
		noOwnedResidual,
		bridgeUnsubscribed,
		boundedTimersPending,
		productClean: zeroPostClose && noDuplicatePublish && hooksAtMostOnce && noOwnedResidual && bridgeUnsubscribed,
	};
}

/** Post-close cause classification from RAW evidence (never from timing alone):
 *  a write whose bytes carry post-dispose NEW content is a real stale publish;
 *  otherwise the write is a late paint of a render the component requested
 *  BEFORE dispose (the pre-close requestRender sequence is retained). */
export interface PostCloseCause {
	classification: "zero" | "postCloseNewContent" | "latePaintOfPreDisposeRender" | "postCloseRenderRequest" | "unknown";
	newContentWrites: number;
	postDisposeRenderRequests: number;
	preDisposeRenderRequestSeq: number | null;
	note: string;
}

export function classifyPostCloseCause(
	writes: readonly PostCloseWriteRecord[],
	requestRenderLog: readonly RequestRenderEntry[],
	disposeAt: number | null,
): PostCloseCause {
	if (writes.length === 0) {
		return { classification: "zero", newContentWrites: 0, postDisposeRenderRequests: 0, preDisposeRenderRequestSeq: null, note: "no outer write after dispose" };
	}
	const newContentWrites = writes.filter((write) => write.containsNewContent).length;
	const postDisposeRenderRequests = disposeAt === null ? 0 : requestRenderLog.filter((entry) => entry.at > disposeAt).length;
	const preDispose = disposeAt === null ? [] : requestRenderLog.filter((entry) => entry.at <= disposeAt);
	const preDisposeRenderRequestSeq = preDispose.length === 0 ? null : preDispose[preDispose.length - 1].seq;
	if (newContentWrites > 0) {
		return {
			classification: "postCloseNewContent",
			newContentWrites,
			postDisposeRenderRequests,
			preDisposeRenderRequestSeq,
			note: "a post-dispose write carries content produced after dispose (real stale publish)",
		};
	}
	if (postDisposeRenderRequests > 0) {
		return {
			classification: "postCloseRenderRequest",
			newContentWrites,
			postDisposeRenderRequests,
			preDisposeRenderRequestSeq,
			note: "a render was requested after dispose (component/TUI published after close)",
		};
	}
	if (preDisposeRenderRequestSeq !== null) {
		return {
			classification: "latePaintOfPreDisposeRender",
			newContentWrites,
			postDisposeRenderRequests,
			preDisposeRenderRequestSeq,
			note: "the write is a late paint of a render requested BEFORE dispose (no new content); the zero-post-close assertion still fails and the cause is retained raw",
		};
	}
	return { classification: "unknown", newContentWrites, postDisposeRenderRequests, preDisposeRenderRequestSeq, note: "no requestRender attribution available (UNKNOWN)" };
}

/** Unique snapshot identities observed on the wire (begin seq per socket). */
export function countDuplicatePublishes(identities: readonly string[]): { duplicates: number; unique: number } {
	const seen = new Set<string>();
	let duplicates = 0;
	for (const identity of identities) {
		if (seen.has(identity)) duplicates += 1;
		seen.add(identity);
	}
	return { duplicates, unique: seen.size };
}

// --- D1 shared trial scaffold (short absolute paths, instrumented) ----------

interface D1Host {
	root: string;
	viewId: string;
	sessionFile: string;
	socketPath: string;
	configPath: string;
	eventsPath: string;
	runner: ChildProcess;
	spawn: RunnerSpawnRecord;
	stopSampling: () => void;
	readLogs: () => { stderr: string; stdout: string };
}

/** Open one owned host for a D1 case: SHORT absolute root (the D30 signature was
 *  a per-trial endpoint path-length failure), instrumented spawn, bounded
 *  host-alive wait that keeps the spawn record on failure. */
async function openD1Host(input: {
	artifactDir: string;
	label: string;
	viewId: string;
	childPath: string;
	childEnv: Record<string, string>;
	iteration?: number | null;
	/** Reuse an existing owned root + endpoint (a REAL epoch change keeps the
	 *  endpoint: only the runner/child is replaced). */
	reuse?: { root: string; socketPath: string; configPath: string; sessionFile: string };
}): Promise<D1Host> {
	const root = input.reuse?.root ?? mkdtempSync(join(tmpdir(), "s20b-d1-"));
	const socketPath = input.reuse?.socketPath ?? join(root, "endpoint.sock");
	const configPath = input.reuse?.configPath ?? join(root, "host-config.json");
	const eventsPath = input.reuse !== undefined ? join(root, `child-events-${input.label}.jsonl`) : join(root, "child-events.jsonl");
	const sessionFile = input.reuse?.sessionFile ?? createView(root, { id: input.viewId, name: `s20b ${input.viewId}`, cwd: root }).sessionFile;
	claimHost(root, {
		viewId: input.viewId,
		instanceId: input.viewId,
		configPath,
		socketPath,
		claimAt: Date.now(),
		claimPid: process.pid,
		claimIdentity: null,
		cols: WORK_AREA.cols,
		rows: WORK_AREA.rows,
	});
	const spawned = spawnInstrumentedRunner({
		label: input.label,
		iteration: input.iteration ?? null,
		root,
		viewId: input.viewId,
		instanceId: input.viewId,
		socketPath,
		configPath,
		childPath: input.childPath,
		childEnv: { FAKE_PTY_EVENTS_PATH: eventsPath, ...input.childEnv },
		sessionFile,
		artifactDirForLogs: input.artifactDir,
	});
	return {
		root,
		viewId: input.viewId,
		sessionFile,
		socketPath,
		configPath,
		eventsPath,
		runner: spawned.runner,
		spawn: spawned.record,
		stopSampling: spawned.stopSampling,
		readLogs: spawned.readLogs,
	};
}

/** Ordered/public exit for a D1 host after the scenario action: documented
 *  `input` message on the real runner socket, then the accepted cleanup record. */
async function closeD1Host(host: D1Host, cleanup: DiagCleanup, label: string): Promise<void> {
	try {
		await orderedExitViaPublicSocket({
			socketPath: host.socketPath,
			root: host.root,
			viewId: host.viewId,
			runner: host.runner,
			cleanup,
			label,
		});
	} catch {
		/* recorded through cleanup + the spawn record */
	}
	host.stopSampling();
}

// --- case: dispose while parsing is incomplete, real remaining output -------

async function runD1Dispose(artifactDir: string): Promise<Record<string, unknown>> {
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists: ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const writeArtifact = makeArtifactWriter(artifactDir, []);
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	const capture = captureClientSockets();
	// Installed right before the component mount so harness-owned timers (spawn
	// sampler, log flush) are outside the tracked window and cannot masquerade as
	// component residue.
	let tracker: ResourceTracker | null = null;
	const cleanup = createDiagCleanup();
	const gen = "gen-1";
	const seedLiteral = s17GenerationRowsText(gen, "F0");
	const targetLiteral = s17GenerationRowsText(gen, "F1");
	let host: D1Host | null = null;
	let side: RestartSide | null = null;
	let error: string | null = null;
	let infrastructureError: string | null = null;
	let f0Committed = false;
	let disposeAt: number | null = null;
	let disposeWallMs: number | null = null;
	let writesBeforeDispose = 0;
	let framesBeforeDispose = 0;
	let gridBeforeDispose: string[] | null = null;
	let postCloseWrites: PostCloseWriteRecord[] = [];
	let postCloseFrames = 0;
	let childWritesAfterDispose = 0;
	let childWritesTotal = 0;
	let resourcesAfterTeardown: ResourceSnapshot | null = null;
	let resourcesActiveWindow: ResourceSnapshot | null = null;
	let gatesAfterTeardown: ResourceGates | null = null;
	let oneShotDrain: { waitedMs: number; remaining: number } | null = null;
	let stepCommandAt: number | null = null;
	let stepCommandAcceptedByChild = false;
	let parserLog: ParserLogEntry[] = [];
	let socketDeliveries: Array<{ at: number; bytes: number; sha256: string }> = [];
	let parserInstrumentationInstalled = false;
	let parserInstrumentationError: string | null = null;
	let detachParserInstrumentation: (() => void) | null = null;
	let doneCount = 0;
	let endpoint: EndpointPathCheck | null = null;
	let iterationValid = false;
	let teardownAt: number | null = null;
	let postCloseCause: PostCloseCause | null = null;
	let postCloseObservation: Record<string, unknown> | null = null;
	try {
		host = await openD1Host({
			artifactDir,
			label: "d1-dispose",
			viewId: "d1-dispose",
			childPath: GENERATION_CHILD,
			childEnv: { FAKE_PTY_GENERATION: gen },
		});
		endpoint = host.spawn.endpoint;
		if (!endpoint.ok) {
			infrastructureError = `endpoint path ${endpoint.length} exceeds the measured safe length ${endpoint.safeLength}`;
			throw new Error(infrastructureError);
		}
		await waitFor(() => {
			const current = readHost(host!.root, host!.viewId);
			return !!current && current.state === "alive" && !!current.childPid;
		}, 10_000, "D1-dispose host alive");
		tracker = createResourceTracker();
		side = await mountRestartSide(host.socketPath, dims, { trackRequestRender: true, trackHookLifecycle: true });
		{
			try {
				detachParserInstrumentation = instrumentComponentParser(side.component, parserLog, "component-parser-1");
				parserInstrumentationInstalled = true;
			} catch (err) {
				infrastructureError = err instanceof Error ? err.message : String(err);
			}
		}
		await waitFor(
			() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), seedLiteral)),
			10_000,
			"D1-dispose F0 commit",
		);
		f0Committed = true;
		await waitFor(() => side!.hooks.colorProbe >= 1 && side!.hooks.schemeBridge >= 1, 10_000, "D1-dispose initial hooks");
		resourcesActiveWindow = resourceSnapshot("active-window", tracker, capture, side.hookLifecycle);
		// Stale-parser dimension (D1 fix1 I1): observe the REAL parser and the REAL
		// socket delivery for the in-flight bytes. Observe-only instrumentation.
		try {
			detachParserInstrumentation?.();
			detachParserInstrumentation = instrumentComponentParser(side.component, parserLog, "component-parser-1");
			parserInstrumentationInstalled = true;
			const instrumentedSocket = componentClientSocket(capture);
			if (instrumentedSocket !== null) {
				socketDeliveries = [];
				instrumentedSocket.on("data", (chunk: Buffer | string) => {
					const text = chunk.toString("utf8");
					socketDeliveries.push({ at: now(), bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) });
				});
			}
		} catch (err) {
			parserInstrumentationError = err instanceof Error ? err.message : String(err);
		}
		// REAL remaining output in flight: the child writes the complete F1 frame on
		// `step`; the component is disposed before that frame can be parsed.
		stepCommandAt = now();
		(side.component as unknown as { handleInput: (data: string) => void }).handleInput(producerCommand({ cmd: "step", step: 1 }));
		gridBeforeDispose = projectedRows(side.observer.observations[side.observer.observations.length - 1], dims);
		writesBeforeDispose = side.observer.writes.length;
		framesBeforeDispose = side.observer.observations.filter((o) => o.kind === "frame").length;
		disposeWallMs = Date.now();
		disposeAt = now();
		(side.component as unknown as { dispose: () => void }).dispose();
		// ACTIVE post-dispose window: the TUI is still started (teardown is kept
		// separate), so every write here is a post-close publish candidate.
		await sleep(400);
		resourcesActiveWindow = resourceSnapshot("after-dispose-window", tracker, capture, side.hookLifecycle);
		postCloseWrites = collectPostCloseWrites({
			writes: side.observer.writes,
			disposeAt,
			newContentMarkers: [`${gen} F1 `],
			requestRenderLog: side.requestRenderLog,
		});
		postCloseFrames = side.observer.observations.filter((o) => o.kind === "frame" && o.boundaryParsedAt > disposeAt!).length;
		doneCount = side.doneResults.length;
		const childEvents = readEventsSafe(host.eventsPath);
		childWritesTotal = childEvents.filter((event) => event.event === "stdout-write").length;
		childWritesAfterDispose = childEvents.filter(
			(event) => event.event === "stdout-write" && typeof event.wallMs === "number" && disposeWallMs !== null && (event.wallMs as number) >= disposeWallMs,
		).length;
		stepCommandAcceptedByChild = childEvents.some((event) => event.event === "command" && typeof event.raw === "string" && (event.raw as string).includes("\"step\""));
	} catch (err) {
		error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		if (infrastructureError === null) infrastructureError = error;
	} finally {
		teardownAt = now();
		try {
			detachParserInstrumentation?.();
			detachParserInstrumentation = null;
		} catch {
			/* best-effort */
		}
		// D1 fix1 C1: dispose the case component BEFORE the teardown snapshot
		// (idempotent where the active window already disposed it).
		try {
			side?.component && (side.component as unknown as { dispose: () => void }).dispose();
		} catch {
			/* best-effort */
		}
		try {
			side?.tui.stop();
		} catch {
			/* best-effort */
		}
		// Bounded settle of the TUI's OWN teardown timers (one macrotask), then the
		// owned-resource snapshot BEFORE the harness's drain timers exist; a live
		// owned INTERVAL after this remains a real leak candidate.
		if (host !== null) {
			// Harness-owned teardown traffic: its timers/sockets are attributed
			// to the harness, never to the component under test.
			tracker?.beginHarnessSection();
			await closeD1Host(host, cleanup, `D1-dispose`);
			tracker?.endHarnessSection();
		}
		const socketCloseWait = await awaitSocketsClosed(capture, 2000);
		oneShotDrain = await awaitOneShotDrain(tracker, 2500);
		resourcesAfterTeardown = resourceSnapshot("after-teardown", tracker, capture, side?.hookLifecycle ?? null, socketCloseWait.waitedMs);
		gatesAfterTeardown = resourceGates(resourcesAfterTeardown, side?.hookLifecycle ?? null);
		tracker?.restore();
		capture.restore();
		if (side) {
			try {
				await Promise.race([side.observer.whenIdle(), sleep(1500)]);
			} catch {
				/* best-effort */
			}
		}
		await killOwnedDiagProcesses(host?.runner ?? null, host?.root ?? join(tmpdir(), "d1-none"), host?.viewId ?? "d1-none", cleanup);
		if (host !== null) {
			try {
				rmSync(host.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
				cleanup.rootRemoved = true;
			} catch {
				/* recorded below */
			}
		}
		cleanup.ok = diagCleanupOk(cleanup);
		try {
			side?.observer.dispose();
		} catch {
			/* best-effort */
		}
		iterationValid = error === null && f0Committed && disposeAt !== null && side !== null;
		postCloseCause = classifyPostCloseCause(postCloseWrites, side?.requestRenderLog ?? [], disposeAt);
		writeArtifact("observations.json", { activeBoundary: disposeAt === null ? 0 : side?.observer.observations.length ?? 0, observations: side?.observer.observations ?? [] });
		writeArtifact("writes.json", side?.observer.writes ?? []);
		writeArtifact("request-renders.json", side?.requestRenderLog ?? []);
		writeArtifact("post-close-writes.json", postCloseWrites);
		writeArtifact("parser-events.json", parserLog);
		writeArtifact("socket-deliveries.json", socketDeliveries);
		writeArtifact("resources.json", { activeWindow: resourcesActiveWindow, afterTeardown: resourcesAfterTeardown, gates: gatesAfterTeardown, oneShotDrain });
		writeArtifact("spawn.json", host?.spawn ?? null);
		const logs = host?.readLogs() ?? { stderr: "", stdout: "" };
		writeArtifact("runner-stderr.txt", logs.stderr);
		writeArtifact("runner-stdout.txt", logs.stdout);
		writeArtifact("cleanup.json", cleanup);
		writeArtifact("child-events.jsonl", readEventsSafe(host?.eventsPath ?? ""));
		writeArtifact("summary.json", {
			caseId: "D1-dispose",
			error,
			infrastructureError,
			iterationValid,
			f0Committed,
			stepCommandAt,
			stepCommandAcceptedByChild,
			disposeAt,
			teardownAt,
			writesBeforeDispose,
			framesBeforeDispose,
			gridBeforeDispose,
			postCloseWrites,
			postCloseFrames,
			postCloseCause,
			childWritesTotal,
			childWritesAfterDispose,
			doneCount,
			hooks: side?.hooks ?? null,
			hookLifecycle: side?.hookLifecycle ?? null,
			resourceGates: gatesAfterTeardown,
			oneShotDrain,
			parserInstrumentationInstalled,
			postDisposeParserWrites: parserLog.filter((entry) => entry.kind === "write" && disposeAt !== null && entry.at > disposeAt).length,
			postDisposeSocketDeliveries: socketDeliveries.filter((entry) => disposeAt !== null && entry.at > disposeAt).length,
			endpoint,
			resourcesAfterTeardown,
			cleanup,
		});
	}
	const product = postCloseProductClean({
		postCloseWrites: postCloseWrites.length,
		postCloseFrames,
		duplicatePublishes: 0,
		stalePublishes: 0,
		doneCount,
		hookRegistrations: side?.hookLifecycle.bridgeRegistrations ?? 0,
		ownedTimerIntervalsLive: resourcesAfterTeardown?.ownedTimerIntervalsLive ?? -1,
		ownedTimerOneShotsLive: resourcesAfterTeardown?.ownedTimerClassification.oneShotBounded.length ?? -1,
		socketsOpenAfterDispose: resourcesAfterTeardown?.socketsOpen ?? -1,
		bridgeUnsubscribes: side?.hookLifecycle.bridgeUnsubscribes ?? 0,
		requiredBridgeUnsubscribes: 1,
	});
	const productWithResources = gatesAfterTeardown?.ok === true && product.productClean;
	return {
		caseId: "D1-dispose",
		ok: iterationValid,
		iterationValid,
		infrastructureError,
		productClean: productWithResources,
		exitCode: iterationValid ? 0 : 1,
		error,
		evidence: {
			endpoint,
			stepCommandAcceptedByChild,
			childWritesAfterDispose,
			childWritesTotal,
			disposeAt,
			writesBeforeDispose,
			framesBeforeDispose,
			gridBeforeDispose,
			postCloseWrites,
			postCloseFrames,
			postCloseCause,
			doneCount,
			hooks: side?.hooks ?? null,
			hookLifecycle: side?.hookLifecycle ?? null,
			product,
			resourceGates: gatesAfterTeardown,
			oneShotDrain,
			resourcesAfterTeardown,
			staleParserDimension: {
				parserInstrumentationInstalled,
				parserInstrumentationError,
				parserIdentity: "component-parser-1",
				postDisposeParserWrites: parserLog.filter((entry) => entry.kind === "write" && disposeAt !== null && entry.at > disposeAt).length,
				postDisposeParserCsiEvents: parserLog.filter((entry) => (entry.kind === "csi-open" || entry.kind === "csi-close") && disposeAt !== null && entry.at > disposeAt).length,
				postDisposeSocketDeliveries: socketDeliveries.filter((entry) => disposeAt !== null && entry.at > disposeAt).length,
				childWritesAfterDispose,
				note: "observe-only instrumentation of the REAL parser plus a public socket 'data' listener; 0 post-dispose parser writes/deliveries with real child output after dispose means the disposed component has no parser re-entry path (structural), while a non-zero value would be a real stale-parser finding"
			},
			cleanup,
		},
		artifactDir,
	};
}

// --- case: duplicate completion / frame-ready -------------------------------

async function runD1Duplicate(artifactDir: string): Promise<Record<string, unknown>> {
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists: ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const writeArtifact = makeArtifactWriter(artifactDir, []);
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	const capture = captureClientSockets();
	let tracker: ResourceTracker | null = null;
	const cleanup = createDiagCleanup();
	const gen = "gen-1";
	const seedLiteral = s17GenerationRowsText(gen, "F0");
	let host: D1Host | null = null;
	let side: RestartSide | null = null;
	let error: string | null = null;
	let infrastructureError: string | null = null;
	let iterationValid = false;
	let f0Committed = false;
	let doneCount = 0;
	let duplicateSubscribeAt: number | null = null;
	let snapshotIdentities: string[] = [];
	let duplicateBeginIdentity: string | null = null;
	let blankWindowsAfterDuplicate = 0;
	let baselineFramesAfterDuplicate = 0;
	let settleProbeDiagnosticsAfterDuplicate = 0;
	let hooksBeforeDuplicate: InitialHookCounts | null = null;
	let hooksAfterDuplicate: InitialHookCounts | null = null;
	let resourcesAfterTeardown: ResourceSnapshot | null = null;
	let gatesAfterTeardown: ResourceGates | null = null;
	let oneShotDrain: { waitedMs: number; remaining: number } | null = null;
	let endpoint: EndpointPathCheck | null = null;
	const duplicateWriteFailures: string[] = [];
	try {
		host = await openD1Host({
			artifactDir,
			label: "d1-duplicate",
			viewId: "d1-duplicate",
			childPath: GENERATION_CHILD,
			childEnv: { FAKE_PTY_GENERATION: gen },
		});
		endpoint = host.spawn.endpoint;
		if (!endpoint.ok) {
			infrastructureError = `endpoint path ${endpoint.length} exceeds the measured safe length ${endpoint.safeLength}`;
			throw new Error(infrastructureError);
		}
		await waitFor(() => {
			const current = readHost(host!.root, host!.viewId);
			return !!current && current.state === "alive" && !!current.childPid;
		}, 10_000, "D1-duplicate host alive");
		tracker = createResourceTracker();
		side = await mountRestartSide(host.socketPath, dims, { trackRequestRender: true, trackHookLifecycle: true });
		await waitFor(
			() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), seedLiteral)),
			10_000,
			"D1-duplicate F0 commit",
		);
		f0Committed = true;
		await waitFor(() => side!.hooks.colorProbe >= 1 && side!.hooks.schemeBridge >= 1, 10_000, "D1-duplicate initial hooks");
		hooksBeforeDuplicate = { ...side.hooks };
		snapshotIdentities = capture.rxLines
			.filter((line) => line.msg.type === "snapshot_begin")
			.map((line) => `${line.socketId}:${String(line.msg.generation ?? "?")}:${String(line.msg.snapshotSeq ?? "?")}`);
		// Truthful duplicate frame-ready: a SECOND documented `subscribe_terminal`
		// on the component's OWN socket (real runner → real duplicate snapshot),
		// never a manual private late callback.
		const clientSocket = componentClientSocket(capture);
		if (clientSocket === null) throw new Error("no component client socket captured for the duplicate subscribe");
		const beginsBefore = capture.rxLines.filter((line) => line.msg.type === "snapshot_begin").length;
		duplicateSubscribeAt = now();
		clientSocket.write(`${JSON.stringify({ type: "subscribe_terminal", frameVersion: 1 })}\n`);
		await waitFor(
			() => capture.rxLines.filter((line) => line.msg.type === "snapshot_begin").length > beginsBefore,
			10_000,
			"D1-duplicate second snapshot_begin",
		);
		await waitFor(
			() => capture.rxLines.some((line) => line.msg.type === "snapshot_end" && line.at >= duplicateSubscribeAt!),
			10_000,
			"D1-duplicate second snapshot_end",
		);
		const duplicateBegin = capture.rxLines.filter((line) => line.msg.type === "snapshot_begin" && line.at >= duplicateSubscribeAt!);
		duplicateBeginIdentity = duplicateBegin.length === 0 ? null : `${duplicateBegin[0].socketId}:${String(duplicateBegin[0].msg.generation ?? "?")}:${String(duplicateBegin[0].msg.snapshotSeq ?? "?")}`;
		snapshotIdentities = capture.rxLines
			.filter((line) => line.msg.type === "snapshot_begin")
			.map((line) => `${line.socketId}:${String(line.msg.generation ?? "?")}:${String(line.msg.snapshotSeq ?? "?")}`);
		// Let the duplicate answer settle, then count real observable side effects.
		await sleep(500);
		hooksAfterDuplicate = { ...side.hooks };
		doneCount = side.doneResults.length;
		// Real observable side effects of the duplicate answer: a buffer WIPE would
		// show as a blank outer window; a legitimate re-baseline shows the seed.
		const duplicateWindows = side.observer.observations.filter((o) => o.boundaryParsedAt >= duplicateSubscribeAt!);
		blankWindowsAfterDuplicate = duplicateWindows.filter((o) => projectedRows(o, dims).every((row) => row === "")).length;
		baselineFramesAfterDuplicate = duplicateWindows.filter((o) => projectedRows(o, dims).some((row) => row.includes(`${gen} F0 `))).length;
		// Informational only: the settle probe diagnostic is NOT a reset.
		settleProbeDiagnosticsAfterDuplicate = (side.diagnostics as Array<{ code?: string }>).filter((event) => event.code === "attach_settle_scheme").length;
	} catch (err) {
		error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		if (infrastructureError === null) infrastructureError = error;
	} finally {
		// D1 fix1 C1: dispose the case component BEFORE the teardown snapshot
		// (idempotent where the active window already disposed it).
		try {
			side?.component && (side.component as unknown as { dispose: () => void }).dispose();
		} catch {
			/* best-effort */
		}
		try {
			side?.tui.stop();
		} catch {
			/* best-effort */
		}
		// Bounded settle of the TUI's OWN teardown timers (one macrotask), then the
		// owned-resource snapshot BEFORE the harness's drain timers exist; a live
		// owned INTERVAL after this remains a real leak candidate.
		if (host !== null) {
			// Harness-owned teardown traffic: its timers/sockets are attributed
			// to the harness, never to the component under test.
			tracker?.beginHarnessSection();
			await closeD1Host(host, cleanup, `D1-duplicate`);
			tracker?.endHarnessSection();
		}
		const socketCloseWait = await awaitSocketsClosed(capture, 2000);
		oneShotDrain = await awaitOneShotDrain(tracker, 2500);
		resourcesAfterTeardown = resourceSnapshot("after-teardown", tracker, capture, side?.hookLifecycle ?? null, socketCloseWait.waitedMs);
		gatesAfterTeardown = resourceGates(resourcesAfterTeardown, side?.hookLifecycle ?? null);
		tracker?.restore();
		capture.restore();
		if (side) {
			try {
				await Promise.race([side.observer.whenIdle(), sleep(1500)]);
			} catch {
				/* best-effort */
			}
		}
		await killOwnedDiagProcesses(host?.runner ?? null, host?.root ?? join(tmpdir(), "d1-none"), host?.viewId ?? "d1-none", cleanup);
		if (host !== null) {
			try {
				rmSync(host.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
				cleanup.rootRemoved = true;
			} catch {
				/* recorded below */
			}
		}
		cleanup.ok = diagCleanupOk(cleanup);
		try {
			side?.observer.dispose();
		} catch {
			/* best-effort */
		}
		iterationValid = error === null && f0Committed && duplicateBeginIdentity !== null;
		const hooksAtMostOnce =
			hooksAfterDuplicate !== null &&
			hooksAfterDuplicate.colorProbe <= 1 &&
			hooksAfterDuplicate.schemeBridge === 1 &&
			(side?.hookLifecycle.bridgeRegistrations ?? 0) === 1;
		const duplicateIdentityCount = countDuplicatePublishes(snapshotIdentities);
		const duplicateObservableClean =
			hooksAtMostOnce && doneCount === 0 && blankWindowsAfterDuplicate === 0 && gatesAfterTeardown?.ok === true;
		writeArtifact("observations.json", { observations: side?.observer.observations ?? [] });
		writeArtifact("writes.json", side?.observer.writes ?? []);
		writeArtifact("tx-lines.json", capture.txLines);
		writeArtifact("rx-lines.json", capture.rxLines);
		writeArtifact("request-renders.json", side?.requestRenderLog ?? []);
		writeArtifact("resources.json", { afterTeardown: resourcesAfterTeardown });
		writeArtifact("spawn.json", host?.spawn ?? null);
		const logs = host?.readLogs() ?? { stderr: "", stdout: "" };
		writeArtifact("runner-stderr.txt", logs.stderr);
		writeArtifact("runner-stdout.txt", logs.stdout);
		writeArtifact("cleanup.json", cleanup);
		writeArtifact("child-events.jsonl", readEventsSafe(host?.eventsPath ?? ""));
		writeArtifact("summary.json", {
			caseId: "D1-duplicate",
			error,
			infrastructureError,
			iterationValid,
			f0Committed,
			duplicateSubscribeAt,
			snapshotIdentities,
			duplicateBeginIdentity,
			hooksBeforeDuplicate,
			hooksAfterDuplicate,
			hookLifecycle: side?.hookLifecycle ?? null,
			doneCount,
			blankWindowsAfterDuplicate,
			baselineFramesAfterDuplicate,
			settleProbeDiagnosticsAfterDuplicate,
			duplicateIdentityCount,
			resourceGates: gatesAfterTeardown,
			oneShotDrain,
			duplicateObservableClean,
			duplicatePublishIdentityNote:
				"per-snapshot PUBLISH identity is not observable on the component path without a private client seam: duplicatePublishIdentityCount is UNKNOWN (client-level duplicate semantics are pinned by test/terminal-attach-client.test.mjs)",
			resourcesAfterTeardown,
			endpoint,
			cleanup,
		});
	}
	const hooksAtMostOnce =
		hooksAfterDuplicate !== null && hooksAfterDuplicate.colorProbe <= 1 && hooksAfterDuplicate.schemeBridge === 1 && (side?.hookLifecycle.bridgeRegistrations ?? 0) === 1;
	const duplicateIdentityCount = countDuplicatePublishes(snapshotIdentities);
	const duplicateObservableClean =
		hooksAtMostOnce && doneCount === 0 && blankWindowsAfterDuplicate === 0 && gatesAfterTeardown?.ok === true;
	return {
		caseId: "D1-duplicate",
		ok: iterationValid,
		iterationValid,
		infrastructureError,
		duplicateObservableClean,
		duplicateIdentityCount,
		duplicatePublishIdentityCount: null,
		duplicatePublishIdentityNote:
			"UNKNOWN: no truthful public per-snapshot PUBLISH identity on the component path; duplicateIdentityCount is the wire-identity duplicate count only",
		exitCode: iterationValid ? 0 : 1,
		error,
		evidence: {
			endpoint,
			duplicateSubscribeAt,
			snapshotIdentities,
			duplicateBeginIdentity,
			hooksBeforeDuplicate,
			hooksAfterDuplicate,
			hookLifecycle: side?.hookLifecycle ?? null,
			doneCount,
			blankWindowsAfterDuplicate,
			baselineFramesAfterDuplicate,
			settleProbeDiagnosticsAfterDuplicate,
			hooksAtMostOnce,
			duplicateIdentityCount,
			resourceGates: gatesAfterTeardown,
			oneShotDrain,
			resourcesAfterTeardown,
			cleanup,
		},
		artifactDir,
	};
}

// --- case: stale connection/baseline/parser after a newer epoch -------------

async function runD1StaleEpoch(artifactDir: string): Promise<Record<string, unknown>> {
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists: ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const writeArtifact = makeArtifactWriter(artifactDir, []);
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	const capture = captureClientSockets();
	let tracker: ResourceTracker | null = null;
	const cleanup = createDiagCleanup();
	const gen1 = "gen-1";
	const gen2 = "gen-2";
	const gen1Seed = s17GenerationRowsText(gen1, "F0");
	const gen2Seed = s20bRestartRowsText(gen2, "F0");
	let host: D1Host | null = null;
	let side: RestartSide | null = null;
	let error: string | null = null;
	let infrastructureError: string | null = null;
	let iterationValid = false;
	let gen1Committed = false;
	let gen2Committed = false;
	let gen1Generation: string | null = null;
	let gen2Generation: string | null = null;
	let reconcileSent = false;
	let reconcileGeneration: string | null = null;
	let subscribeAfterEpoch: { at: number; sinceSeq: number | null } | null = null;
	let epochResetObserved = false;
	let staleCursorRejected = false;
	let staleGenerationMessagesAfterEpoch = 0;
	let stalePublishesAfterEpoch: PostCloseWriteRecord[] = [];
	let persistenceWritesBeforeRecovery: PostCloseWriteRecord[] = [];
	let recoveryAt: number | null = null;
	let endpoint: EndpointPathCheck | null = null;
	let resourcesAfterTeardown: ResourceSnapshot | null = null;
	let gatesAfterTeardown: ResourceGates | null = null;
	let oneShotDrain: { waitedMs: number; remaining: number } | null = null;
	const scenarioKills: string[] = [];
	const parserLog: ParserLogEntry[] = [];
	let parserInstrumentationInstalled = false;
	let detachParserInstrumentation: (() => void) | null = null;
	try {
		host = await openD1Host({
			artifactDir,
			label: "d1-stale-epoch-gen1",
			viewId: "d1-stale",
			childPath: GENERATION_CHILD,
			childEnv: { FAKE_PTY_GENERATION: gen1 },
		});
		endpoint = host.spawn.endpoint;
		if (!endpoint.ok) {
			infrastructureError = `endpoint path ${endpoint.length} exceeds the measured safe length ${endpoint.safeLength}`;
			throw new Error(infrastructureError);
		}
		await waitFor(() => {
			const current = readHost(host!.root, host!.viewId);
			return !!current && current.state === "alive" && !!current.childPid;
		}, 10_000, "D1-stale gen-1 host alive");
		tracker = createResourceTracker();
		side = await mountRestartSide(host.socketPath, dims, { trackRequestRender: true, trackHookLifecycle: true });
		{
			tracker.beginHarnessSection();
			try {
				detachParserInstrumentation = instrumentComponentParser(side.component, parserLog, "component-parser-1");
				parserInstrumentationInstalled = true;
			} catch (err) {
				infrastructureError = err instanceof Error ? err.message : String(err);
			} finally {
				tracker.endHarnessSection();
			}
		}
		await waitFor(
			() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), gen1Seed)),
			10_000,
			"D1-stale gen-1 commit",
		);
		gen1Committed = true;
		gen1Generation = (capture.rxLines.find((line) => line.msg.type === "hello" && typeof line.msg.generation === "string")?.msg.generation as string | undefined) ?? null;
		if (gen1Generation === null) throw new Error("gen-1 runner boot generation not observed (UNKNOWN)");
		// Scenario action: kill the OLD owned runner/child, then start a NEW runner
		// on the SAME endpoint (a real epoch change; the component reconnects).
		const oldChild = readHost(host.root, host.viewId)?.childPid ?? null;
		if (oldChild !== null) {
			try {
				process.kill(oldChild, "SIGKILL");
				scenarioKills.push(`child:${oldChild}`);
			} catch {
				/* already exited */
			}
		}
		if (host.runner.pid !== undefined) {
			try {
				host.runner.kill("SIGKILL");
				scenarioKills.push(`runner:${host.runner.pid}`);
			} catch {
				/* already exited */
			}
		}
		await new Promise((resolveExit) => host!.runner.once("exit", resolveExit));
		host.stopSampling();
		// New epoch: fresh runner, new boot generation, same socket path.
		try {
			rmSync(host.socketPath, { force: true });
		} catch {
			/* no stale socket */
		}
		const gen2Host = await openD1Host({
			artifactDir,
			label: "d1-stale-epoch-gen2",
			viewId: "d1-stale",
			childPath: RESTART_CHILD,
			childEnv: { FAKE_PTY_RESTART_GENERATION: gen2 },
			// REAL epoch change on the SAME endpoint: only the runner/child is new.
			reuse: { root: host.root, socketPath: host.socketPath, configPath: host.configPath, sessionFile: host.sessionFile },
		});
		host = gen2Host;
		await waitFor(() => {
			const current = readHost(host!.root, host!.viewId);
			return !!current && current.state === "alive" && !!current.childPid;
		}, 10_000, "D1-stale gen-2 host alive");
		// The component reconnects on its own real retry schedule: wait for the
		// epoch gate (reconcile) and the post-epoch subscribe.
		// Epoch detection: the replacement runner's hello carries a NEW boot
		// generation. The client compares it with the generation it saw at
		// disconnect, so the epoch decision precedes a possible reconcile_result.
		await waitFor(
			() =>
				capture.rxLines.some(
					(line) => line.msg.type === "hello" && typeof line.msg.generation === "string" && line.msg.generation !== gen1Generation,
				),
			10_000,
			"D1-stale post-epoch hello with a NEW generation",
		);
		const epochHello = capture.rxLines.find(
			(line) => line.msg.type === "hello" && typeof line.msg.generation === "string" && line.msg.generation !== gen1Generation,
		)!;
		gen2Generation = epochHello.msg.generation as string;
		epochResetObserved = gen2Generation !== gen1Generation;
		// The reconnect burst (hello → reconcile → subscribe) is WRITTEN before
		// the runner's hello is parsed, so the epoch socket's own first write is
		// the correct boundary (not the rx hello timestamp).
		const epochSocketTx = capture.txLines.filter((line) => line.socketId === epochHello.socketId);
		const epochSocketStartAt = epochSocketTx.length === 0 ? epochHello.at : epochSocketTx[0].at;
		// The first subscribe on the NEW epoch socket must be a FRESH snapshot
		// (no stale sinceSeq from the old baseline).
		await waitFor(
			() => capture.txLines.some((line) => line.msg.type === "subscribe_terminal" && line.socketId === epochHello.socketId && line.at >= epochSocketStartAt),
			10_000,
			"D1-stale post-epoch subscribe",
		);
		const postEpochSubscribe = capture.txLines.find(
			(line) => line.msg.type === "subscribe_terminal" && line.socketId === epochHello.socketId && line.at >= epochSocketStartAt,
		)!;
		subscribeAfterEpoch = { at: postEpochSubscribe.at, sinceSeq: typeof postEpochSubscribe.msg.sinceSeq === "number" ? (postEpochSubscribe.msg.sinceSeq as number) : null };
		staleCursorRejected = epochResetObserved && subscribeAfterEpoch.sinceSeq === null;
		reconcileSent = capture.txLines.some((line) => line.msg.type === "reconcile" && line.at >= epochSocketStartAt);
		const reconcileResult = capture.rxLines.filter((line) => line.msg.type === "reconcile_result" && line.at >= epochSocketStartAt).pop() ?? null;
		reconcileGeneration = reconcileResult !== null && typeof reconcileResult.msg.generation === "string" ? (reconcileResult.msg.generation as string) : null;
		await waitFor(
			() => capture.rxLines.some((line) => line.msg.type === "snapshot_begin" && line.socketId === epochHello.socketId && line.at >= epochHello.at),
			10_000,
			"D1-stale post-epoch baseline",
		);
		const newBaseline = capture.rxLines.filter((line) => line.msg.type === "snapshot_begin" && line.socketId === epochHello.socketId && line.at >= epochHello.at)[0];
		// Release the gen-2 frame only after the new baseline.
		(side.component as unknown as { handleInput: (data: string) => void }).handleInput(producerCommand({ cmd: "go" }));
		await waitFor(
			() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), gen2Seed)),
			15_000,
			"D1-stale gen-2 commit",
		);
		gen2Committed = true;
		// STALE gates (identity based, from the raw transport/observation log).
		staleGenerationMessagesAfterEpoch = capture.rxLines.filter(
			(line) => line.at >= epochSocketStartAt && typeof line.msg.generation === "string" && line.msg.generation === gen1Generation,
		).length;
		// Old-grid writes after the new baseline are classified against the REAL
		// recovery window: pixels that persist through baseline consumption before
		// the reset render are persistence (recorded), and only gen-1 bytes written
		// AFTER the reset are stale publishes.
		const resetWindow = side.observer.observations.find(
			(o) => o.boundaryParsedAt >= newBaseline.at && projectedRows(o, dims).every((row) => row === ""),
		);
		recoveryAt = resetWindow?.boundaryParsedAt ?? null;
		const staleWritesFromBaseline = collectPostCloseWrites({
			writes: side.observer.writes,
			disposeAt: newBaseline.at,
			newContentMarkers: [`${gen1} `],
			requestRenderLog: side.requestRenderLog,
		}).filter((write) => write.containsNewContent);
		const recoveryBoundary = recoveryAt;
		persistenceWritesBeforeRecovery =
			recoveryBoundary === null ? [] : staleWritesFromBaseline.filter((write) => write.receivedAt < recoveryBoundary);
		stalePublishesAfterEpoch =
			recoveryBoundary === null ? staleWritesFromBaseline : staleWritesFromBaseline.filter((write) => write.receivedAt >= recoveryBoundary);
		// Disposed after the new epoch: the post-close gate still applies.
		const disposeAt = now();
		(side.component as unknown as { dispose: () => void }).dispose();
		await sleep(300);
		writeArtifact("post-close-after-dispose.json", collectPostCloseWrites({ writes: side.observer.writes, disposeAt, newContentMarkers: [`${gen2} `], requestRenderLog: side.requestRenderLog }));
	} catch (err) {
		error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		if (infrastructureError === null) infrastructureError = error;
	} finally {
		// D1 fix1 C1: dispose the case component BEFORE the teardown snapshot
		// (idempotent where the active window already disposed it).
		try {
			side?.component && (side.component as unknown as { dispose: () => void }).dispose();
		} catch {
			/* best-effort */
		}
		try {
			side?.tui.stop();
		} catch {
			/* best-effort */
		}
		// Bounded settle of the TUI's OWN teardown timers (one macrotask), then the
		// owned-resource snapshot BEFORE the harness's drain timers exist; a live
		// owned INTERVAL after this remains a real leak candidate.
		if (host !== null) {
			// Harness-owned teardown traffic: its timers/sockets are attributed
			// to the harness, never to the component under test.
			tracker?.beginHarnessSection();
			await closeD1Host(host, cleanup, `D1-stale`);
			tracker?.endHarnessSection();
		}
		const socketCloseWait = await awaitSocketsClosed(capture, 2000);
		oneShotDrain = await awaitOneShotDrain(tracker, 2500);
		resourcesAfterTeardown = resourceSnapshot("after-teardown", tracker, capture, side?.hookLifecycle ?? null, socketCloseWait.waitedMs);
		gatesAfterTeardown = resourceGates(resourcesAfterTeardown, side?.hookLifecycle ?? null);
		tracker?.restore();
		capture.restore();
		if (side) {
			try {
				await Promise.race([side.observer.whenIdle(), sleep(1500)]);
			} catch {
				/* best-effort */
			}
		}
		await killOwnedDiagProcesses(host?.runner ?? null, host?.root ?? join(tmpdir(), "d1-none"), host?.viewId ?? "d1-none", cleanup);
		if (host !== null) {
			try {
				rmSync(host.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
				cleanup.rootRemoved = true;
			} catch {
				/* recorded below */
			}
		}
		cleanup.ok = diagCleanupOk(cleanup);
		try {
			side?.observer.dispose();
		} catch {
			/* best-effort */
		}
		iterationValid = error === null && gen1Committed && gen2Committed && epochResetObserved;
		const staleClean =
			staleGenerationMessagesAfterEpoch === 0 &&
			stalePublishesAfterEpoch.length === 0 &&
			recoveryAt !== null &&
			gatesAfterTeardown?.ok === true;
		writeArtifact("observations.json", { observations: side?.observer.observations ?? [] });
		writeArtifact("writes.json", side?.observer.writes ?? []);
		writeArtifact("tx-lines.json", capture.txLines);
		writeArtifact("rx-lines.json", capture.rxLines);
		writeArtifact("stale-publishes.json", stalePublishesAfterEpoch);
		writeArtifact("resources.json", { afterTeardown: resourcesAfterTeardown });
		writeArtifact("spawn.json", { final: host?.spawn ?? null });
		const logs = host?.readLogs() ?? { stderr: "", stdout: "" };
		writeArtifact("runner-stderr.txt", logs.stderr);
		writeArtifact("runner-stdout.txt", logs.stdout);
		writeArtifact("cleanup.json", cleanup);
		writeArtifact("summary.json", {
			caseId: "D1-stale-epoch",
			error,
			infrastructureError,
			iterationValid,
			gen1Committed,
			gen2Committed,
			gen1Generation,
			gen2Generation,
			reconcileSent,
			reconcileGeneration,
			subscribeAfterEpoch,
			epochResetObserved,
			staleCursorRejected,
			staleGenerationMessagesAfterEpoch,
			stalePublishesAfterEpoch,
			persistenceWritesBeforeRecovery,
			recoveryAt,
			resourceGates: gatesAfterTeardown,
			oneShotDrain,
			scenarioKills,
			endpoint,
			resourcesAfterTeardown,
			cleanup,
		});
	}
	const staleClean =
		staleGenerationMessagesAfterEpoch === 0 &&
		stalePublishesAfterEpoch.length === 0 &&
		recoveryAt !== null &&
		gatesAfterTeardown?.ok === true;
	return {
		caseId: "D1-stale-epoch",
		ok: iterationValid,
		iterationValid,
		infrastructureError,
		staleClean,
		exitCode: iterationValid ? 0 : 1,
		error,
		evidence: {
			gen1Generation,
			gen2Generation,
			reconcileSent,
			reconcileGeneration,
			subscribeAfterEpoch,
			epochResetObserved,
			staleCursorRejected,
			staleGenerationMessagesAfterEpoch,
			stalePublishesAfterEpoch,
			persistenceWritesBeforeRecovery,
			recoveryAt,
			resourceGates: gatesAfterTeardown,
			oneShotDrain,
			scenarioKills,
			staleParserDimension: (() => {
					const identities = parserLog.filter((entry) => entry.kind.startsWith("parser-identity:"));
					const staleEvents = parserLog.filter((entry) => entry.stale === true);
					return {
						status: parserInstrumentationInstalled && identities.length > 0 ? "OBSERVED" : "STOPPED_UNKNOWN",
						reason:
							identities.length > 0
								? "the component-managed parser identity seam was re-instrumented through each replacement; parserEpoch/baselineToken/connectionToken and real stale callbacks are recorded"
								: "parser instrumentation was not installed on a real component parser",
						parserIdentityPublicApi: "component.term + connectionToken/baselineToken/parserEpoch private test seam",
						parserIdentities: identities.map((entry) => ({ parserEpoch: entry.parserEpoch ?? null, baselineToken: entry.baselineToken ?? null, connectionToken: entry.connectionToken ?? null })),
						staleParserWritesObserved: staleEvents.length,
						note: "actual late callbacks/CSI hooks observed after a newer parser are recorded with stale:true; a clean replacement chain records zero",
					};
				})(),
			endpoint,
			resourcesAfterTeardown,
			cleanup,
		},
		artifactDir,
	};
}

// ---------------------------------------------------------------------------
// D diagnostic (bounded: at most 12 iterations in this dispatch)
// ---------------------------------------------------------------------------

export type DShape = "quiet" | "render-pending";

async function runDSingle(iteration: number, trialDir: string, shape: DShape): Promise<Record<string, unknown>> {
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	mkdirSync(trialDir, { recursive: true });
	const artifactDir = trialDir;
	const writeArtifact = makeArtifactWriter(artifactDir, []);
	const capture = captureClientSockets();
	let tracker: ResourceTracker | null = null;
	const cleanup = createDiagCleanup();
	const gen = "gen-1";
	const seedLiteral = s17GenerationRowsText(gen, "F0");
	let host: D1Host | null = null;
	let side: RestartSide | null = null;
	let error: string | null = null;
	let infrastructureError: string | null = null;
	let iterationValid = false;
	let f0Committed = false;
	let disposeAt: number | null = null;
	let postCloseWrites: PostCloseWriteRecord[] = [];
	let postCloseFrames = 0;
	let doneCount = 0;
	let resourcesAfterTeardown: ResourceSnapshot | null = null;
	let gatesAfterTeardown: ResourceGates | null = null;
	let oneShotDrain: { waitedMs: number; remaining: number } | null = null;
	let endpoint: EndpointPathCheck | null = null;
	let postCloseCause: PostCloseCause | null = null;
	let postCloseObservation: Record<string, unknown> | null = null;
	let stepCommandAt: number | null = null;
	let childWritesAfterDispose = 0;
	let disposeWallMs: number | null = null;
	let shapeValid = false;
	const scenarioKills: string[] = [];
	try {
		host = await openD1Host({
			artifactDir,
			label: `d${iteration}`,
			viewId: `d1-d-${iteration}`,
			childPath: GENERATION_CHILD,
			childEnv: { FAKE_PTY_GENERATION: gen },
			iteration,
		});
		endpoint = host.spawn.endpoint;
		if (!endpoint.ok) {
			infrastructureError = `iteration ${iteration}: endpoint path ${endpoint.length} exceeds the measured safe length ${endpoint.safeLength}`;
			throw new Error(infrastructureError);
		}
		await waitFor(() => {
			const current = readHost(host!.root, host!.viewId);
			return !!current && current.state === "alive" && !!current.childPid;
		}, 10_000, `D iteration ${iteration} host alive`);
		tracker = createResourceTracker();
		side = await mountRestartSide(host.socketPath, dims, { trackRequestRender: true, trackHookLifecycle: true });
		await waitFor(
			() => side!.observer.observations.some((o) => o.kind === "frame" && rowsEqual(projectedRows(o, dims), seedLiteral)),
			10_000,
			`D iteration ${iteration} F0 commit`,
		);
		f0Committed = true;
		await waitFor(() => side!.hooks.colorProbe >= 1 && side!.hooks.schemeBridge >= 1, 10_000, `D iteration ${iteration} initial hooks`);
		if (shape === "render-pending") {
			// D1-dispose topology: REAL in-flight output (the child writes the F1
			// frame on `step`) and the component is disposed before it can parse it.
			stepCommandAt = now();
			(side.component as unknown as { handleInput: (data: string) => void }).handleInput(producerCommand({ cmd: "step", step: 1 }));
			disposeWallMs = Date.now();
		} else {
			// Quiet/post-settle topology: no in-flight output, a bounded idle window
			// so the settle/scheduler work has drained before dispose.
			await sleep(200);
		}
		disposeAt = now();
		(side.component as unknown as { dispose: () => void }).dispose();
		await sleep(300);
		postCloseObservation = { observationStartMs: disposeAt, observationEndMs: now(), observationActualMs: now() - disposeAt, observationCompletion: "completed", label: "D-post-close" };
		const childEvents = readEventsSafe(host.eventsPath);
		childWritesAfterDispose = childEvents.filter(
			(event) => event.event === "stdout-write" && typeof event.wallMs === "number" && disposeWallMs !== null && (event.wallMs as number) >= disposeWallMs,
		).length;
		shapeValid = shape === "render-pending" ? childWritesAfterDispose >= 1 : childWritesAfterDispose === 0;
		postCloseWrites = collectPostCloseWrites({
			writes: side.observer.writes,
			disposeAt,
			newContentMarkers: [`${gen} F1 `],
			requestRenderLog: side.requestRenderLog,
		});
		postCloseFrames = side.observer.observations.filter((o) => o.kind === "frame" && o.boundaryParsedAt > disposeAt!).length;
		doneCount = side.doneResults.length;
	} catch (err) {
		error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		if (infrastructureError === null) infrastructureError = error;
	} finally {
		try {
			side?.tui.stop();
		} catch {
			/* best-effort */
		}
		if (host !== null) {
			// Harness-owned teardown traffic: its timers/sockets are attributed
			// to the harness, never to the component under test.
			tracker?.beginHarnessSection();
			await closeD1Host(host, cleanup, `D-${iteration}`);
			tracker?.endHarnessSection();
		}
		const socketCloseWait = await awaitSocketsClosed(capture, 2000);
		oneShotDrain = await awaitOneShotDrain(tracker, 2500);
		resourcesAfterTeardown = resourceSnapshot(`iteration-${iteration}-after-teardown`, tracker, capture, side?.hookLifecycle ?? null, socketCloseWait.waitedMs);
		gatesAfterTeardown = resourceGates(resourcesAfterTeardown, side?.hookLifecycle ?? null);
		tracker?.restore();
		capture.restore();
		if (side) {
			try {
				await Promise.race([side.observer.whenIdle(), sleep(1000)]);
			} catch {
				/* best-effort */
			}
		}
		await killOwnedDiagProcesses(host?.runner ?? null, host?.root ?? join(tmpdir(), "d1-none"), host?.viewId ?? "d1-none", cleanup);
		if (host !== null) {
			try {
				rmSync(host.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
				cleanup.rootRemoved = true;
			} catch {
				/* recorded below */
			}
		}
		cleanup.ok = diagCleanupOk(cleanup);
		try {
			side?.observer.dispose();
		} catch {
			/* best-effort */
		}
		iterationValid = error === null && f0Committed && disposeAt !== null;
		postCloseCause = classifyPostCloseCause(postCloseWrites, side?.requestRenderLog ?? [], disposeAt);
		const product = postCloseProductClean({
			postCloseWrites: postCloseWrites.length,
			postCloseFrames,
			duplicatePublishes: 0,
			stalePublishes: 0,
			doneCount,
			hookRegistrations: side?.hookLifecycle.bridgeRegistrations ?? 0,
			ownedTimerIntervalsLive: resourcesAfterTeardown?.ownedTimerIntervalsLive ?? -1,
			ownedTimerOneShotsLive: resourcesAfterTeardown?.ownedTimerClassification.oneShotBounded.length ?? -1,
			socketsOpenAfterDispose: resourcesAfterTeardown?.socketsOpen ?? -1,
			bridgeUnsubscribes: side?.hookLifecycle.bridgeUnsubscribes ?? 0,
			requiredBridgeUnsubscribes: 1,
		});
		const productWithResources = gatesAfterTeardown?.ok === true && product.productClean;
		writeArtifact("spawn.json", host?.spawn ?? null);
		writeArtifact("post-close-writes.json", postCloseWrites);
		writeArtifact("resources.json", { afterTeardown: resourcesAfterTeardown });
		writeArtifact("writes.json", side?.observer.writes ?? []);
		writeArtifact("request-renders.json", side?.requestRenderLog ?? []);
		writeArtifact("cleanup.json", cleanup);
		const logs = host?.readLogs() ?? { stderr: "", stdout: "" };
		writeArtifact("runner-stderr.log", logs.stderr);
		writeArtifact("runner-stdout.log", logs.stdout);
		writeArtifact("summary.json", {
			iteration,
			shape,
			shapeValid,
			stepCommandAt,
			childWritesAfterDispose,
			error,
			infrastructureError,
			iterationValid,
			f0Committed,
			disposeAt,
			postCloseWrites,
			postCloseFrames,
			postCloseCause,
			doneCount,
			product,
			resourceGates: gatesAfterTeardown,
			oneShotDrain,
			resourcesAfterTeardown,
			endpoint,
			scenarioKills,
			cleanup,
		});
	}
	const product = postCloseProductClean({
		postCloseWrites: postCloseWrites.length,
		postCloseFrames,
		duplicatePublishes: 0,
		stalePublishes: 0,
		doneCount,
		hookRegistrations: side?.hookLifecycle.bridgeRegistrations ?? 0,
		ownedTimerIntervalsLive: resourcesAfterTeardown?.ownedTimerIntervalsLive ?? -1,
		ownedTimerOneShotsLive: resourcesAfterTeardown?.ownedTimerClassification.oneShotBounded.length ?? -1,
		socketsOpenAfterDispose: resourcesAfterTeardown?.socketsOpen ?? -1,
		bridgeUnsubscribes: side?.hookLifecycle.bridgeUnsubscribes ?? 0,
		requiredBridgeUnsubscribes: 1,
	});
	const productWithResources = gatesAfterTeardown?.ok === true && product.productClean;
	return {
		iteration,
		shape,
		shapeValid,
		stepCommandAt,
		observation: postCloseObservation,
		childWritesAfterDispose,
		ok: iterationValid,
		iterationValid,
		infrastructureError,
		// productCLEAN is the resource-gated contract verdict (D1 fix1 C1/C2).
		productClean: gatesAfterTeardown?.ok === true && product.productClean,
		// The zero-post-close contract is evaluated for EVERY shape (never flipped).
		zeroPostClose: product.zeroPostClose,
		resourceGates: gatesAfterTeardown,
		oneShotDrain,
		product,
		postCloseWrites: postCloseWrites.length,
		postCloseFrames,
		postCloseCause,
		doneCount,
		postCloseWriteDetails: postCloseWrites,
		ownedTimersLiveAfterDispose: resourcesAfterTeardown?.ownedTimersLive ?? null,
		socketsOpenAfterDispose: resourcesAfterTeardown?.socketsOpen ?? null,
		endpoint,
		cleanup,
		error,
		artifactDir,
	};
}

/** D2 shapes alternate within ONE batch so both dispose topologies are measured
 *  on the same run (odd = quiet, even = render-pending). Per-shape counts are
 *  kept separate and never aggregated away. */
export function dShapeForIteration(iteration: number): DShape {
	return iteration % 2 === 1 ? "quiet" : "render-pending";
}

interface ShapeAggregate {
	shape: DShape;
	iterations: number;
	iterationValidCount: number;
	productCleanCount: number;
	productFailureCount: number;
	shapeValidCount: number;
	resourceGatesOkCount: number;
	cleanupOkCount: number;
	postCloseWritesMax: number;
	postCloseFramesMax: number;
	ownedTimersLiveMax: number;
	socketsOpenMax: number;
	harnessTimersLiveMax: number;
}

function aggregateShape(shape: DShape, records: Array<Record<string, unknown>>): ShapeAggregate {
	const rows = records.filter((record) => record.shape === shape);
	const gatesOk = (record: Record<string, unknown>) => (record.resourceGates as { ok?: boolean } | null)?.ok === true;
	return {
		shape,
		iterations: rows.length,
		iterationValidCount: rows.filter((record) => record.iterationValid === true).length,
		productCleanCount: rows.filter((record) => record.productClean === true).length,
		productFailureCount: rows.filter((record) => record.iterationValid === true && record.productClean === false).length,
		shapeValidCount: rows.filter((record) => record.shapeValid === true).length,
		resourceGatesOkCount: rows.filter(gatesOk).length,
		cleanupOkCount: rows.filter((record) => (record.cleanup as { ok?: boolean } | null)?.ok === true).length,
		postCloseWritesMax: rows.reduce((max, record) => Math.max(max, Number(record.postCloseWrites ?? 0)), 0),
		postCloseFramesMax: rows.reduce((max, record) => Math.max(max, Number(record.postCloseFrames ?? 0)), 0),
		ownedTimersLiveMax: rows.reduce((max, record) => Math.max(max, Number(record.ownedTimersLiveAfterDispose ?? 0)), 0),
		socketsOpenMax: rows.reduce((max, record) => Math.max(max, Number(record.socketsOpenAfterDispose ?? 0)), 0),
		harnessTimersLiveMax: rows.reduce(
			(max, record) => Math.max(max, Number((record.resourceGates as { harnessTimersLive?: number } | null)?.harnessTimersLive ?? 0)),
			0,
		),
	};
}

async function runD(options: { artifactDir: string; repeat: number }): Promise<Record<string, unknown>> {
	const { artifactDir, repeat } = options;
	mkdirSync(artifactDir, { recursive: true });
	const iterationsJsonl = join(artifactDir, "iterations.jsonl");
	const results: Array<Record<string, unknown>> = [];
	let stoppedAfterInfrastructureFailure = false;
	for (let i = 1; i <= repeat; i += 1) {
		const shape = dShapeForIteration(i);
		const record = await runDSingle(i, join(artifactDir, `trial-${i}`), shape);
		results.push(record);
		appendFileSync(
			iterationsJsonl,
			`${JSON.stringify({
				iteration: i,
				shape,
				shapeValid: record.shapeValid,
				iterationValid: record.iterationValid,
				infrastructureError: record.infrastructureError,
				productClean: record.productClean,
				zeroPostClose: record.zeroPostClose,
				postCloseWrites: record.postCloseWrites,
				postCloseFrames: record.postCloseFrames,
				postCloseCause: (record.postCloseCause as { classification?: string } | null)?.classification ?? null,
				resourceGates: record.resourceGates,
				cleanupOk: (record.cleanup as { ok?: boolean } | null)?.ok ?? null,
				forcedKills: (record.cleanup as { forcedKills?: string[] } | null)?.forcedKills ?? null,
				endpointLength: (record.endpoint as { length?: number } | null)?.length ?? null,
				error: record.error,
			})}\n`,
		);
		if (record.infrastructureError !== null) {
			// Stop at the FIRST infrastructure failure with the full raw record
			// retained; the batch is never continued blindly and never called a 30.
			stoppedAfterInfrastructureFailure = true;
			break;
		}
	}
	const quiet = aggregateShape("quiet", results);
	const renderPending = aggregateShape("render-pending", results);
	const iterationValidAll = results.every((r) => r.iterationValid === true);
	const infrastructureErrors = results.filter((r) => r.infrastructureError !== null).map((r) => ({ iteration: r.iteration, shape: r.shape, infrastructureError: r.infrastructureError }));
	const complianceFailures = results.filter((r) => r.infrastructureError === null && (r.iterationValid !== true || (r.resourceGates as { ok?: boolean } | null)?.ok !== true));
	return {
		caseId: "D",
		repeat,
		iterationsRun: results.length,
		observation: results[0]?.observation ?? null,
		stoppedAfterInfrastructureFailure,
		iterationValidAll,
		// Per-shape counts (never aggregated away).
		quiet,
		renderPending,
		// Quiet shape MUST be product-clean; render-pending is evaluated by the SAME
		// zero-post-close contract and its current failures are counted separately.
		quietProductCleanAll: quiet.iterations > 0 && quiet.productCleanCount === quiet.iterations,
		renderPendingProductFailureCount: renderPending.productFailureCount,
		fullyCovered: false,
		coverageBoundary:
			"not full D coverage: after-newer-epoch parser identity remains STOPPED_UNKNOWN (P4/step23); the zero-post-close render-pending RED is open",
		complianceFailures,
		infrastructureErrors,
		ok: iterationValidAll && complianceFailures.length === 0,
		exitCode: iterationValidAll && complianceFailures.length === 0 ? 0 : 1,
		iterations: results,
		maxPostCloseWrites: results.reduce((max, r) => Math.max(max, Number(r.postCloseWrites ?? 0)), 0),
		maxPostCloseFrames: results.reduce((max, r) => Math.max(max, Number(r.postCloseFrames ?? 0)), 0),
		maxOwnedTimersLive: results.reduce((max, r) => Math.max(max, Number(r.ownedTimersLiveAfterDispose ?? 0)), 0),
		note: "D2 batch: per-iteration instrumented records + iterations.jsonl; both dispose shapes measured; a render-pending productClean=false is a counted product failure, not infrastructure invalidity",
		artifactDir,
	};
}

// ---------------------------------------------------------------------------
// Dispatcher + CLI
// ---------------------------------------------------------------------------

const CASES = new Set(["R-reconnect", "R-restart", "U-unframed", "U-legacy", "D", "D1-dispose", "D1-duplicate", "D1-stale-epoch"]);

export async function runCase20B(options: { caseId: string; artifactDir: string; repeat: number }): Promise<Record<string, unknown>> {
	const { caseId, artifactDir, repeat } = options;
	const invocationId = `inv-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
	mkdirSync(artifactDir, { recursive: true });
	const appendInvocation = (record: Record<string, unknown>) => appendFileSync(join(artifactDir, "invocations.jsonl"), JSON.stringify(record) + "\n");
	appendInvocation({ kind: "begin", invocationId, at: new Date().toISOString(), caseId, repeat });
	let record: Record<string, unknown>;
	try {
		if (caseId === "R-reconnect") record = await runReconnect(join(artifactDir, "trial-r-reconnect"));
		else if (caseId === "R-restart") record = await runRestart(join(artifactDir, "trial-r-restart"));
		else if (caseId === "U-unframed") record = await runUnframed(join(artifactDir, "trial-u-unframed"));
		else if (caseId === "U-legacy") record = await runLegacy(join(artifactDir, "trial-u-legacy"));
		else if (caseId === "D1-dispose") record = await runD1Dispose(join(artifactDir, "trial-d1-dispose"));
		else if (caseId === "D1-duplicate") record = await runD1Duplicate(join(artifactDir, "trial-d1-duplicate"));
		else if (caseId === "D1-stale-epoch") record = await runD1StaleEpoch(join(artifactDir, "trial-d1-stale-epoch"));
		else record = await runD({ artifactDir: join(artifactDir, "trial-d"), repeat });
	} catch (err) {
		record = { caseId, ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) };
	}
	appendInvocation({ kind: "trial-end", invocationId, at: new Date().toISOString(), caseId, ok: record.ok });
	// Explicit CLI semantics (D1): usage error 2, infrastructure/harness invalid
	// 1, valid evidence 0 — even when productClean=false (a genuine product RED is
	// a separate, asserted result, never an infrastructure failure).
	const exitCode = typeof record.exitCode === "number" ? record.exitCode : record.ok === true ? 0 : 1;
	const measurementPath = typeof record.measurementPath === "string"
		? record.measurementPath
		: caseId.startsWith("R-") ? "modern-reporter-viewproof" : "legacy-no-reporter";
	const result = { ok: record.ok === true, measurementPath, exitCode, caseId, repeat, invocationId, trials: [record], artifactRoot: artifactDir };
	appendInvocation({ kind: "end", invocationId, at: new Date().toISOString(), ok: result.ok });
	writeFileSync(join(artifactDir, `result-${invocationId}.json`), JSON.stringify(result, null, 2));
	return result;
}

function cliError(message: string): never {
	process.stderr.write(`pty-attach-20b-scenario: ${message}\n`);
	process.exit(2);
}

export function parse20BCli(argv: string[]): { caseId: string; repeat: number; clock: string; artifactDir: string } {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith("--") || i + 1 >= argv.length) cliError(`malformed arguments: ${argv.join(" ")}`);
		args.set(argv[i].slice(2), argv[i + 1]);
	}
	const caseId = args.get("case") ?? cliError("missing --case");
	if (!CASES.has(caseId)) cliError(`unsupported --case ${JSON.stringify(caseId)} (only ${[...CASES].join(", ")} are implemented)`);
	const repeat = Number(args.get("repeat") ?? "1");
	if (caseId === "D") {
		if (!Number.isInteger(repeat) || repeat < 1) cliError(`--repeat for D must be a positive integer (got ${args.get("repeat")})`);
	} else if (repeat !== 1) {
		cliError(`unsupported --repeat ${JSON.stringify(args.get("repeat"))} (only 1 for non-D cases)`);
	}
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
	const cli = parse20BCli(process.argv.slice(2));
	runCase20B({ caseId: cli.caseId, artifactDir: cli.artifactDir, repeat: cli.repeat })
		.then((result) => {
			process.stdout.write(JSON.stringify(result) + "\n");
			process.exit(typeof result.exitCode === "number" ? result.exitCode : 0);
		})
		.catch((err) => {
			process.stderr.write(`pty-attach-20b-scenario: harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exit(1);
		});
}
