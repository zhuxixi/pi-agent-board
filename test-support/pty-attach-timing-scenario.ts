// Issue #222 step 21A (task-21a-brief.md): deterministic fake-clock readiness
// harness for the UNDECIDED / B(same-size nonempty) / S(synchronized split) /
// DELAYED B+S / LATE-STALE timer contract.
//
// Truth boundaries:
//  - REAL: runner (`runner/pty-runner.mjs`), child (`test-support/fake-pty-pi.mjs`
//    controlled-frames producer), component (`src/ui/pty-attach.ts`), TUI
//    (`TuiAltScreen`), the child/runner protocol and the accepted presentation
//    observer (independent xterm grid/cursor snapshots).
//  - VIRTUAL: ONLY the attach-side timers (global setTimeout/setInterval and
//    their clear functions are replaced by a fake clock that advances only when
//    the test calls `tick`). `Date.now` is NOT virtualized: the runner's claim
//    fencing and the component's desync gating keep real time, so the runner's
//    lifecycle cannot be perturbed by fake time.
//  - NOT USED: fake transport/query, parser replacement, synchronous render
//    shim, forced private attaching/input/ready/render/finish state, manual
//    private late callback, hidden-timer frame close, candidate-ready flags.
//
// The harness distinguishes: protocol RECEIPT (rx messages, real time) → local
// PARSER write/drain callbacks (virtual time) → independently COMPLETE frame
// (child-authored literal) → render REQUEST (public `tui.requestRender`) →
// OUTER COMMIT (observer frame with grid/cursor).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TuiAltScreen } from "@earendil-works/pi-tui/dist/tui-alt-screen.js";
import { AttachPresentationObserver, asTerminal, type PresentationObservation } from "./attach-presentation-fixture.ts";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { claimHost, createView, readHost } from "../src/core/store.mjs";
import {
	WORK_AREA,
	makeAttachDims,
	producerRowsText,
	PRODUCER_CURSOR,
	createDiagCleanup,
	diagCleanupOk,
	killOwnedDiagProcesses,
	type AttachSurfaceDims,
	type DiagCleanup,
} from "./pty-attach-ready-scenario.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONTROLLED_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-pi.mjs");
const FRAME_WRAPPER = resolve(REPO_ROOT, "test-support/fake-pty-frame-wrapper.mjs");
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;

/** Settle window the CURRENT source waits before it reveals the buffer. */
export const SETTLE_MS = 250;
/** Hard attach cap the current source arms alongside the settle timer. */
export const HARD_TIMEOUT_MS = 2500;
/** Protocol probe window after which the attach decides the legacy path. */
export const PROBE_TIMEOUT_MS = 1500;
/** Budget after the independently complete frame within which the modern
 *  contract must publish (a small drain allowance, NOT the settle window). */
export const MODERN_PUBLISH_BUDGET_MS = 30;

const realSleep = (ms: number) => new Promise<void>((resolveSleep) => realSetTimeout(resolveSleep, ms));
const flushRealTurn = () => new Promise<void>((resolveTurn) => realSetImmediate(resolveTurn));

// ---------------------------------------------------------------------------
// Fake clock (attach-side timers only)
// ---------------------------------------------------------------------------

export interface FakeTimerRecord {
	id: number;
	kind: "timeout" | "interval";
	delay: number;
	dueAt: number;
	createdAt: number;
	owner: string;
}

export interface FakeClock {
	now: () => number;
	install: () => void;
	uninstall: () => void;
	/** Advance virtual time; fires due timers in due order. */
	tick: (ms: number) => number;
	/** Fire timers already due at the CURRENT virtual time (no time advance). */
	fireDueNow: () => number;
	pending: () => FakeTimerRecord[];
}

/** Stack-based ownership label so a fire can be attributed without guessing. */
function timerOwner(stack: string): string {
	if (stack.includes("jiggle")) return "jiggle";
	if (stack.includes("attachClient") || stack.includes("terminal-attach-client")) return "attach-client";
	if (stack.includes("pty-attach.ts")) return "component";
	if (stack.includes("tui.js") || stack.includes("tui-alt-screen")) return "tui";
	return "other";
}

export function createFakeClock(startAt = 0): FakeClock {
	let virtualNow = startAt;
	let nextId = 1;
	const timers = new Map<number, { record: FakeTimerRecord; fn: (...args: unknown[]) => void; args: unknown[] }>();
	const originals = {
		setTimeout: globalThis.setTimeout,
		setInterval: globalThis.setInterval,
		clearTimeout: globalThis.clearTimeout,
		clearInterval: globalThis.clearInterval,
	};
	const schedule = (kind: "timeout" | "interval", fn: (...args: unknown[]) => void, delay: number, args: unknown[]): unknown => {
		const id = nextId;
		nextId += 1;
		const record: FakeTimerRecord = {
			id,
			kind,
			delay: Number.isFinite(delay) ? Math.max(0, delay) : 0,
			dueAt: virtualNow + (Number.isFinite(delay) ? Math.max(0, delay) : 0),
			createdAt: virtualNow,
			owner: timerOwner(new Error().stack ?? ""),
		};
		timers.set(id, { record, fn, args });
		const handle = { id, unref: () => handle, ref: () => handle, hasRef: () => false, [Symbol.toPrimitive]: () => id } as unknown as ReturnType<typeof setTimeout>;
		return handle;
	};
	const clear = (handle: unknown): void => {
		const id = typeof handle === "object" && handle !== null ? (handle as { id?: number }).id : (handle as number | undefined);
		if (typeof id === "number") timers.delete(id);
	};
	const fireDue = (upTo: number): number => {
		let fired = 0;
		for (let guard = 0; guard < 100000; guard += 1) {
			let next: { id: number; dueAt: number } | null = null;
			for (const [id, entry] of timers) {
				if (entry.record.dueAt > upTo) continue;
				if (next === null || entry.record.dueAt < next.dueAt || (entry.record.dueAt === next.dueAt && id < next.id)) next = { id, dueAt: entry.record.dueAt };
			}
			if (next === null) return fired;
			const entry = timers.get(next.id);
			if (entry === undefined) continue;
			if (entry.record.dueAt > virtualNow) virtualNow = entry.record.dueAt;
			if (entry.record.kind === "interval") {
				entry.record.dueAt = virtualNow + Math.max(1, entry.record.delay);
			} else {
				timers.delete(next.id);
			}
			fired += 1;
			try {
				entry.fn(...entry.args);
			} catch {
				/* a throwing timer must not break the clock */
			}
			// A zero-delay timeout rearmed by the callback is fired in the same pass
			// only when it is due at the current virtual time (bounded by `guard`).
		}
		return fired;
	};
	return {
		now: () => virtualNow,
		install: () => {
			globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => schedule("timeout", fn, Number(delay ?? 0), args)) as unknown as typeof globalThis.setTimeout;
			globalThis.setInterval = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => schedule("interval", fn, Number(delay ?? 0), args)) as unknown as typeof globalThis.setInterval;
			globalThis.clearTimeout = ((handle: unknown) => clear(handle)) as unknown as typeof globalThis.clearTimeout;
			globalThis.clearInterval = ((handle: unknown) => clear(handle)) as unknown as typeof globalThis.clearInterval;
		},
		uninstall: () => {
			globalThis.setTimeout = originals.setTimeout;
			globalThis.setInterval = originals.setInterval;
			globalThis.clearTimeout = originals.clearTimeout;
			globalThis.clearInterval = originals.clearInterval;
		},
		tick: (ms: number) => {
			const target = virtualNow + Math.max(0, ms);
			const fired = fireDue(target);
			if (virtualNow < target) virtualNow = target;
			return fired;
		},
		fireDueNow: () => fireDue(virtualNow),
		pending: () => [...timers.values()].map((entry) => ({ ...entry.record })),
	};
}

// ---------------------------------------------------------------------------
// Pure oracles (exported for RED/GREEN)
// ---------------------------------------------------------------------------

/** One outer commit (observer frame) with the projection the oracle reads. */
export interface OuterCommit {
	index: number;
	at: number; // virtual time
	kind: string;
	note: string | null;
	rows: string[];
	cursor: { x: number; y: number; visible: boolean };
}

export type CommitClass = "complete" | "half-frame" | "loading" | "blank" | "other";

/** Classify one outer commit against the declared complete literal. A commit
 *  that carries a frame marker row (TAIL/INPUT) without the COMPLETE literal is
 *  a half frame: arbitrary chunk boundaries are never readiness. */
export function classifyCommit(rows: readonly string[], literal: readonly string[]): CommitClass {
	const complete = rows.length === literal.length && rows.every((row, i) => row === literal[i]);
	if (complete) return "complete";
	const joined = rows.join("\n");
	const hasMarker = rows.some((row) => /TAIL|INPUT >/.test(row));
	if (hasMarker && !complete) return "half-frame";
	if (rows.every((row) => row.trim() === "")) return "blank";
	if (/Loading|Starting the session host|Attached · waiting/.test(joined)) return "loading";
	return "other";
}

/** First OUTER COMMIT of the complete literal. */
export function firstCompleteCommit(commits: readonly OuterCommit[], literal: readonly string[]): OuterCommit | null {
	return commits.find((commit) => classifyCommit(commit.rows, literal) === "complete") ?? null;
}

/** The child's cursor contract is BODY-relative (`PRODUCER_CURSOR`); the
 *  observer records a SCREEN cursor. The projection is explicit so a screen vs
 *  logical comparison can never masquerade as a cursor mismatch. */
export interface CursorContract {
	x: number;
	y: number;
	visible: boolean;
}

export interface CursorEvidence {
	/** The raw SCREEN cursor recorded by the observer (unchanged). */
	rawScreenCursor: CursorContract | null;
	logicalExpected: CursorContract;
	projectedExpectedScreen: CursorContract;
	bodyTop: number;
	matched: boolean;
}

export function projectCursorToScreen(logical: CursorContract, dims: { bodyTop: number }): CursorContract {
	return { x: logical.x, y: logical.y + dims.bodyTop, visible: logical.visible };
}

export function cursorMatches(cursor: CursorContract | null, expectedScreen: CursorContract): boolean {
	return cursor !== null && cursor.x === expectedScreen.x && cursor.y === expectedScreen.y && cursor.visible === expectedScreen.visible;
}

/** Cursor evidence for one publish commit: raw screen cursor retained, expected
 *  logical and projected-SCREEN values both recorded, comparison against the
 *  projected value only. */
export function evaluatePublishCursor(
	publish: OuterCommit | null,
	logicalExpected: CursorContract,
	dims: { bodyTop: number },
): CursorEvidence {
	const projectedExpectedScreen = projectCursorToScreen(logicalExpected, dims);
	return {
		rawScreenCursor: publish === null ? null : publish.cursor,
		logicalExpected,
		projectedExpectedScreen,
		bodyTop: dims.bodyTop,
		matched: publish !== null && cursorMatches(publish.cursor, projectedExpectedScreen),
	};
}

/** Structural complete/drain/render → publish ordering by EVENT INDEX (the
 *  observation count recorded when the drain/render happened), never by
 *  timestamp alone; equal virtual timestamps are allowed only when that
 *  sequence holds. */
export interface PublishOrdering {
	publishObservationIndex: number | null;
	lastDrain: { at: number; observationCount: number } | null;
	lastRenderRequest: { at: number; observationCount: number } | null;
	drainAtOrBeforePublish: boolean;
	renderAtOrBeforePublish: boolean;
	ok: boolean;
	note: string;
}

export function evaluatePublishOrdering(input: {
	publish: OuterCommit | null;
	parserLog: ReadonlyArray<{ kind: string; at: number; observationCount: number }>;
	requestRenders: ReadonlyArray<{ at: number; observationCount: number }>;
}): PublishOrdering {
	if (input.publish === null) {
		return {
			publishObservationIndex: null,
			lastDrain: null,
			lastRenderRequest: null,
			drainAtOrBeforePublish: false,
			renderAtOrBeforePublish: false,
			ok: false,
			note: "no publish to order",
		};
	}
	const publishAt = input.publish.at;
	const publishIndex = input.publish.index;
	// Fake-clock events can share a timestamp across the publish boundary. Select
	// by the captured observation sequence as well, so a later same-time drain or
	// render cannot hide the actual preceding pair.
	const lastDrain = [...input.parserLog].filter((entry) => entry.kind === "drain" && entry.at <= publishAt && entry.observationCount <= publishIndex).pop() ?? null;
	const lastRenderRequest = [...input.requestRenders].filter((entry) => entry.at <= publishAt && entry.observationCount <= publishIndex).pop() ?? null;
	const drainAtOrBeforePublish = lastDrain !== null && input.publish.index >= lastDrain.observationCount;
	const renderAtOrBeforePublish = lastRenderRequest !== null && input.publish.index >= lastRenderRequest.observationCount;
	return {
		publishObservationIndex: input.publish.index,
		lastDrain,
		lastRenderRequest,
		drainAtOrBeforePublish,
		renderAtOrBeforePublish,
		ok: drainAtOrBeforePublish && renderAtOrBeforePublish,
		note: "ordering is derived from observation counts captured at drain/render time (sequence), not from virtual timestamps",
	};
}

/** Every half-frame commit (must be empty: no partial frame is ever published). */
export function halfFrameCommits(commits: readonly OuterCommit[], literal: readonly string[]): OuterCommit[] {
	return commits.filter((commit) => classifyCommit(commit.rows, literal) === "half-frame");
}

export interface ModernBeforeSettleResult {
	completeFrameAt: number | null;
	publishAt: number | null;
	deltaFromCompleteMs: number | null;
	publishedBeforeSettle: boolean;
	withinModernBudget: boolean;
	ok: boolean;
	note: string;
}

/** The modern-before-settle contract: the complete frame must be committed
 *  within a small drain budget of the independently complete frame, NOT after
 *  the 250 ms settle window. */
export function evaluateModernBeforeSettle(input: {
	completeFrameAt: number | null;
	publishAt: number | null;
	budgetMs?: number;
}): ModernBeforeSettleResult {
	const budget = input.budgetMs ?? MODERN_PUBLISH_BUDGET_MS;
	if (input.completeFrameAt === null || input.publishAt === null) {
		return {
			completeFrameAt: input.completeFrameAt,
			publishAt: input.publishAt,
			deltaFromCompleteMs: null,
			publishedBeforeSettle: false,
			withinModernBudget: false,
			ok: false,
			note: input.publishAt === null ? "no complete publish observed" : "complete frame identity missing (UNKNOWN)",
		};
	}
	const delta = input.publishAt - input.completeFrameAt;
	return {
		completeFrameAt: input.completeFrameAt,
		publishAt: input.publishAt,
		deltaFromCompleteMs: delta,
		publishedBeforeSettle: delta < SETTLE_MS,
		withinModernBudget: delta >= 0 && delta <= budget,
		ok: delta >= 0 && delta <= budget,
		note: `publish at +${delta} ms of the complete frame (budget ${budget} ms, settle ${SETTLE_MS} ms)`,
	};
}

export interface DelayedResult {
	beforeBoundaryCommits: number;
	completeFrameAt: number | null;
	/** Publish observed within the modern boundary budget (the contract). */
	boundaryPublishAt: number | null;
	/** Old-behaviour evidence: publish observed after the settle window. */
	settlePublishAt: number | null;
	noEarlyPublish: boolean;
	publishedAtCompleteBoundary: boolean;
	settlePublishBeforeHardTimeout: boolean;
	ok: boolean;
}

/** Delayed-frame contract: nothing may publish before the complete frame, and
 *  the publish must not wait for the 2500 ms hard timeout. */
export function evaluateDelayed(input: {
	commitsBeforeBoundary: readonly OuterCommit[];
	literal: readonly string[];
	completeFrameAt: number | null;
	boundaryPublishAt: number | null;
	settlePublishAt?: number | null;
}): DelayedResult {
	const early = input.commitsBeforeBoundary.filter((commit) => classifyCommit(commit.rows, input.literal) !== "loading" && classifyCommit(commit.rows, input.literal) !== "blank");
	const settlePublishAt = input.settlePublishAt ?? null;
	const publishedAtCompleteBoundary =
		input.boundaryPublishAt !== null && input.completeFrameAt !== null && input.boundaryPublishAt >= input.completeFrameAt && input.boundaryPublishAt - input.completeFrameAt <= MODERN_PUBLISH_BUDGET_MS;
	const settlePublishBeforeHardTimeout = settlePublishAt !== null && input.completeFrameAt !== null && settlePublishAt - input.completeFrameAt < HARD_TIMEOUT_MS;
	return {
		beforeBoundaryCommits: early.length,
		completeFrameAt: input.completeFrameAt,
		boundaryPublishAt: input.boundaryPublishAt,
		settlePublishAt,
		noEarlyPublish: early.length === 0,
		publishedAtCompleteBoundary,
		settlePublishBeforeHardTimeout,
		ok: early.length === 0 && publishedAtCompleteBoundary,
	};
}

export interface LateTimerResult {
	hooksBefore: { colorProbe: number; schemeBridge: number };
	hooksAfter: { colorProbe: number; schemeBridge: number };
	completeCommitsBefore: number;
	completeCommitsAfter: number;
	halfFramesAfter: number;
	postDisposeWrites: number;
	hooksNotRepeated: boolean;
	noSecondFirstView: boolean;
	newCompleteDistinct?: number;
	noPostDisposeRender: boolean;
	ok: boolean;
}

/** Late/stale timer contract: after a qualified publish, old settle/hard-timeout
 *  callbacks must not repeat the first hooks or publish another first view, and
 *  after dispose nothing may render. */
export function evaluateLateTimers(input: Omit<LateTimerResult, "hooksNotRepeated" | "noSecondFirstView" | "noPostDisposeRender" | "ok">): LateTimerResult {
	const hooksNotRepeated = input.hooksAfter.colorProbe === input.hooksBefore.colorProbe && input.hooksAfter.schemeBridge === input.hooksBefore.schemeBridge;
	const noSecondFirstView = (input.newCompleteDistinct ?? (input.completeCommitsAfter > input.completeCommitsBefore ? 1 : 0)) === 0 && input.halfFramesAfter === 0;
	const noPostDisposeRender = input.postDisposeWrites === 0;
	return { ...input, hooksNotRepeated, noSecondFirstView, noPostDisposeRender, ok: hooksNotRepeated && noSecondFirstView && noPostDisposeRender };
}

export interface UndecidedResult {
	loadingObserved: boolean;
	commitsDuringWindow: number;
	hooksDuringWindow: { colorProbe: number; schemeBridge: number };
	firedTimerOwners: string[];
	ok: boolean;
}

/** Undecided contract: below the settle/hard windows the attach stays in the
 *  loading state with zero first hooks and no publish, even after the stale/
 *  legacy timers that exist in that window fire. */
export function evaluateUndecided(input: UndecidedResult): UndecidedResult {
	const hooksZero = input.hooksDuringWindow.colorProbe === 0 && input.hooksDuringWindow.schemeBridge === 0;
	return { ...input, ok: input.loadingObserved && input.commitsDuringWindow === 0 && hooksZero };
}

/** Publish-identity gate: the first complete publish must carry the identity of
 *  the newest qualified baseline, never a stale/older one. */
export function evaluatePublishIdentity(input: { publishIdentity: string | null; qualifiedIdentity: string | null }): { ok: boolean; note: string } {
	if (input.publishIdentity === null || input.qualifiedIdentity === null) return { ok: false, note: "identity UNKNOWN" };
	return input.publishIdentity === input.qualifiedIdentity
		? { ok: true, note: "publish carries the qualified baseline identity" }
		: { ok: false, note: `stale identity: published ${input.publishIdentity} vs qualified ${input.qualifiedIdentity}` };
}

// ---------------------------------------------------------------------------
// Real trial scaffold (real runner/child/component/TUI, virtual attach timers)
// ---------------------------------------------------------------------------

export interface TimingTrial {
	root: string;
	viewId: string;
	socketPath: string;
	configPath: string;
	eventsPath: string;
	sessionFile: string;
	runner: ChildProcess;
	clock: FakeClock;
	observer: AttachPresentationObserver;
	tui: TuiAltScreen;
	component: unknown;
	detachParser?: () => void;
	hooks: { colorProbe: number; bridgeRegistrations: number; bridgeUnsubscribes: number };
	requestRenders: Array<{ at: number; force: boolean; observationCount: number }>;
	parserLog: Array<{ kind: string; at: number; bytes: number; observationCount: number }>;
	rx: Array<{ at: number; type: string; msg: Record<string, unknown> }>;
	tx: Array<{ at: number; type: string; msg: Record<string, unknown> }>;
	done: unknown[];
	frameTokenPath: string;
	reporterSocket?: import("node:net").Socket;
}

interface TrialOptions {
	artifactDir: string;
	caseId: string;
	script: "plain" | "same-write" | "split" | "cold" | "resize" | "theme";
	/** Mount the component BEFORE the host exists (undecided / delayed shapes). */
	lateHost?: boolean;
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

/** Wait on REAL time (the fake clock never advances here). */
async function waitReal(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await realSleep(15);
	}
	throw new Error(`timed out (real ${timeoutMs}ms) waiting for: ${label}`);
}

/** EVIDENCE-ONLY bounded pump: tick small steps until the complete literal is
 *  committed (or the budget is exhausted). Used AFTER a contract assertion point
 *  to record where the current source actually publishes, independent of tick
 *  granularity. Never used to satisfy a contract assertion. */
async function pumpForCompletePublish(
	trial: TimingTrial,
	dims: AttachSurfaceDims,
	literal: readonly string[],
	maxSteps = 100,
	stepMs = 10,
): Promise<{ commit: OuterCommit | null; steps: number; waitedMs: number }> {
	let steps = 0;
	let waitedMs = 0;
	for (; steps < maxSteps; steps += 1) {
		const found = firstCompleteCommit(commitsOf(trial.observer.observations, dims), literal);
		if (found !== null) return { commit: found, steps, waitedMs };
		trial.clock.tick(stepMs);
		waitedMs += stepMs;
		await flushVirtual(trial.clock);
	}
	return { commit: firstCompleteCommit(commitsOf(trial.observer.observations, dims), literal), steps, waitedMs };
}

/** Drain the REAL parser + zero-delay render/scheduler tasks WITHOUT advancing
 *  virtual time (zero-delay timers fire at the current virtual instant). */
async function flushVirtual(clock: FakeClock, turns = 6): Promise<number> {
	let fired = 0;
	for (let i = 0; i < turns; i += 1) {
		await flushRealTurn();
		await Promise.resolve();
		fired += clock.fireDueNow();
	}
	return fired;
}

function projectRows(observation: PresentationObservation, dims: AttachSurfaceDims): string[] {
	return observation.grid.slice(dims.bodyTop, dims.footerRow).map((row) => row.text.replace(/\s+$/u, ""));
}

function commitsOf(observations: readonly PresentationObservation[], dims: AttachSurfaceDims): OuterCommit[] {
	return observations.map((observation, index) => ({
		index,
		at: observation.boundaryParsedAt,
		kind: observation.kind,
		note: observation.note,
		rows: projectRows(observation, dims),
		cursor: { x: observation.cursor.x, y: observation.cursor.y, visible: observation.cursor.visible },
	}));
}

export async function openTimingTrial(options: TrialOptions): Promise<TimingTrial> {
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	const root = mkdtempSync(join(tmpdir(), "s21a-"));
	const viewId = `s21a-${options.caseId}`;
	const socketPath = join(root, "endpoint.sock");
	const configPath = join(root, "host-config.json");
	const eventsPath = join(root, "child-events.jsonl");
	const frameTokenPath = join(root, "frame-token.txt");
	const meta = createView(root, { id: viewId, name: `s21a ${options.caseId}`, cwd: root });
	claimHost(root, { viewId, instanceId: viewId, configPath, socketPath, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: WORK_AREA.cols, rows: WORK_AREA.rows });
	const clock = createFakeClock(0);
	const hooks = { colorProbe: 0, bridgeRegistrations: 0, bridgeUnsubscribes: 0 };
	const requestRenders: Array<{ at: number; force: boolean; observationCount: number }> = [];
	const parserLog: Array<{ kind: string; at: number; bytes: number; observationCount: number }> = [];
	const rx: TimingTrial["rx"] = [];
	const tx: TimingTrial["tx"] = [];
	const done: unknown[] = [];
	const observer = new AttachPresentationObserver({ cols: dims.cols, rows: dims.screenRows, now: () => clock.now() });
	// Protocol transport capture (rx/tx with real arrival times, virtual stamps too).
	const originalWrite = (await import("node:net")).Socket.prototype.write;
	const { Socket } = await import("node:net");
	const isStdio = (socket: unknown) => socket === (process.stdout as unknown) || socket === (process.stderr as unknown) || socket === (process.stdin as unknown);
	(Socket.prototype as unknown as { write: (data: string, ...rest: unknown[]) => unknown }).write = function (data: string, ...rest: unknown[]) {
		if (isStdio(this)) return (originalWrite as unknown as (...args: unknown[]) => unknown).apply(this, [data, ...rest]);
		if (typeof data === "string") {
			for (const line of data.split("\n")) {
				if (!line.trim()) continue;
				try {
					tx.push({ at: clock.now(), type: "tx", msg: JSON.parse(line) as Record<string, unknown> });
				} catch {
					/* non-protocol bytes */
				}
			}
		}
		const socket = this as unknown as { on: (event: string, cb: (chunk: Buffer | string) => void) => void; _s21aRx?: boolean };
		if (socket._s21aRx !== true && typeof socket.on === "function") {
			socket._s21aRx = true;
			socket.on("data", (chunk: Buffer | string) => {
				for (const line of chunk.toString("utf8").split("\n")) {
					if (!line.trim()) continue;
					try {
						rx.push({ at: clock.now(), type: "rx", msg: JSON.parse(line) as Record<string, unknown> });
					} catch {
						/* non-protocol bytes */
					}
				}
			});
		}
		return (originalWrite as unknown as (...args: unknown[]) => unknown).apply(this, [data, ...rest]);
	};
	const spawnHost = (): ChildProcess => {
		atomicWriteJson(configPath, {
			root,
			viewId,
			instanceId: viewId,
			socketPath,
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [FRAME_WRAPPER],
			model: null,
			tools: null,
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "controlled-frames", FAKE_PTY_CONTROLLED_SCRIPT: options.script, FAKE_PTY_EVENTS_PATH: eventsPath, FAKE_PTY_FRAME_CHILD_PATH: CONTROLLED_CHILD, FAKE_PTY_FRAME_TOKEN: frameTokenPath },
			cols: WORK_AREA.cols,
			rows: WORK_AREA.rows,
		});
		const runner = spawn(process.execPath, [resolve(REPO_ROOT, "runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		runner.stdout?.resume();
		runner.stderr?.resume();
		return runner;
	};
	const runner = options.lateHost === true ? (null as unknown as ChildProcess) : spawnHost();
	if (options.lateHost !== true) {
		await waitReal(() => {
			const host = readHost(root, viewId);
			return !!host && host.state === "alive" && !!host.childPid;
		}, 12_000, "host alive");
		await connectFrameReporterAt({ root, viewId, socketPath, frameTokenPath, rx: rx as unknown as Array<{ msg: Record<string, unknown> }> });
	}
	// Virtual attach timers ONLY from here on (the component/TUI/client are constructed below).
	clock.install();
	let trialRef: TimingTrial | null = null;
	const { PtyAttachComponent } = await import("../src/ui/pty-attach.ts");
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
	const tui = new TuiAltScreen(asTerminal(observer), false, undefined, {});
	const seams = tui as unknown as {
		requestRender: (force?: boolean) => void;
		queryTerminalColors: (options: { timeoutMs: number; onLateReply?: (colors: never) => void }) => Promise<unknown>;
		onTerminalColorSchemeChange: (listener: (scheme: never) => void) => () => void;
	};
	const originalRequestRender = seams.requestRender.bind(tui);
	seams.requestRender = (force?: boolean) => {
		requestRenders.push({ at: clock.now(), force: force === true, observationCount: observer.observations.length });
		originalRequestRender(force);
	};
	const realProbe = seams.queryTerminalColors.bind(tui);
	seams.queryTerminalColors = (probe) => {
		hooks.colorProbe += 1;
		return realProbe(probe);
	};
	const realBridge = seams.onTerminalColorSchemeChange.bind(tui);
	seams.onTerminalColorSchemeChange = (listener) => {
		hooks.bridgeRegistrations += 1;
		const unsubscribe = realBridge(listener);
		return () => {
			hooks.bridgeUnsubscribes += 1;
			return unsubscribe();
		};
	};
	const component = new PtyAttachComponent(
		tui as never,
		theme as never,
		{} as never,
		((result: unknown) => {
			done.push(result);
		}) as never,
		{ socketPath, title: "s21a", onDiagnostic: () => {} } as never,
	);
	if (process.env.S21A_FORCE_LIVE_PROJECTION === "1") {
		// RED-only fault injection: simulate the pre-step25 live projection while
		// retaining the real component, committed gate and fixtures. Never set by
		// the normal suites.
		(component as unknown as { projectCommitted: (height: number) => { lines: string[]; cursor: null } }).projectCommitted = function (this: unknown, height: number) {
			const self = this as { term: { buffer: { active: { length: number; getLine: (index: number) => { translateToString: (trim?: boolean) => string } | undefined } } } };
			const buf = self.term.buffer.active;
			const start = Math.max(0, buf.length - height);
			const lines: string[] = [];
			for (let index = start; index < buf.length; index += 1) lines.push(buf.getLine(index)?.translateToString(true) ?? "");
			return { lines, cursor: null };
		};
	}
	// Observe-only REAL parser instrumentation (accepted 20A pattern), reattached per
	// the component-managed parser replacement.
	let currentTerm: { write: (data: string, cb?: () => void) => void } | null = null;
	let originalTermWrite: ((data: string, cb?: () => void) => void) | null = null;
	const attachParser = () => {
		const term = (component as unknown as { term?: { write: (data: string, cb?: () => void) => void } }).term;
		if (!term || typeof term.write !== "function" || term === currentTerm) return;
		if (currentTerm && originalTermWrite) (currentTerm as unknown as { write: unknown }).write = originalTermWrite;
		currentTerm = term;
		originalTermWrite = term.write.bind(term);
		const wrapped = originalTermWrite;
		(term as unknown as { write: unknown }).write = (data: string, callback?: () => void) => {
			parserLog.push({ kind: "write", at: clock.now(), bytes: Buffer.byteLength(data, "utf8"), observationCount: observer.observations.length });
			return wrapped(data, () => {
				parserLog.push({ kind: "drain", at: clock.now(), bytes: 0, observationCount: observer.observations.length });
				callback?.();
			});
		};
	};
	attachParser();
	const parserTimer = setInterval(attachParser, 5);
	parserTimer.unref?.();
	const replaceTarget = component as unknown as { replaceParser?: () => boolean };
	const originalReplace = replaceTarget.replaceParser;
	if (typeof originalReplace === "function") {
		replaceTarget.replaceParser = function (this: unknown) {
			const replaced = originalReplace.call(this);
			if (replaced) attachParser();
			return replaced;
		};
	}
	const detachParser = () => {
		clearInterval(parserTimer);
		if (currentTerm && originalTermWrite) (currentTerm as unknown as { write: unknown }).write = originalTermWrite;
		currentTerm = null;
		originalTermWrite = null;
		if (typeof originalReplace === "function") replaceTarget.replaceParser = originalReplace;
	};
	const trialDetachParser = detachParser;
	tui.setLayoutRoot(component as never);
	tui.start();
	// Initial paint + first virtual zero-delay tasks (does NOT advance the clock).
	await flushVirtual(clock);
	trialRef = {
		root,
		viewId,
		socketPath,
		configPath,
		eventsPath,
		sessionFile: meta.sessionFile,
		runner,
		clock,
		observer,
		tui,
		hooks,
		component,
		detachParser: trialDetachParser,
		requestRenders,
		parserLog,
		rx,
		tx,
		done,
		frameTokenPath,
	};
	return trialRef;
}

export async function startLateHost(trial: TimingTrial, script: TrialOptions["script"]): Promise<void> {
	atomicWriteJson(trial.configPath, {
		root: trial.root,
		viewId: trial.viewId,
		instanceId: trial.viewId,
		socketPath: trial.socketPath,
		sessionFile: trial.sessionFile,
		cwd: process.cwd(),
		initialPrompt: null,
		piCommand: process.execPath,
		piArgsPrefix: [FRAME_WRAPPER],
		model: null,
		tools: null,
		env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "controlled-frames", FAKE_PTY_CONTROLLED_SCRIPT: script, FAKE_PTY_EVENTS_PATH: trial.eventsPath, FAKE_PTY_FRAME_CHILD_PATH: CONTROLLED_CHILD, FAKE_PTY_FRAME_TOKEN: trial.frameTokenPath },
		cols: WORK_AREA.cols,
		rows: WORK_AREA.rows,
	});
	const runner = spawn(process.execPath, [resolve(REPO_ROOT, "runner/pty-runner.mjs"), trial.configPath], { stdio: ["ignore", "pipe", "pipe"] });
	runner.stdout?.resume();
	runner.stderr?.resume();
	(trial as unknown as { runner: ChildProcess }).runner = runner;
	await waitReal(() => {
		const host = readHost(trial.root, trial.viewId);
		return !!host && host.state === "alive" && !!host.childPid;
	}, 12_000, "late host alive");
	await ensureFrameReporter(trial);
}

async function connectFrameReporterAt(input: {
	root: string;
	viewId: string;
	socketPath: string;
	frameTokenPath: string;
	rx: Array<{ msg: Record<string, unknown> }>;
}): Promise<import("node:net").Socket> {
	const { createConnection } = await import("node:net");
	const socket = createConnection(input.socketPath);
	await new Promise<void>((resolveConnect, rejectConnect) => {
		socket.once("connect", () => resolveConnect());
		socket.once("error", rejectConnect);
		realSleep(4000).then(() => rejectConnect(new Error("frame reporter connect timeout"))).catch(() => {});
	});
	socket.on("error", () => { /* runner owns cleanup */ });
	socket.write(`${JSON.stringify({ type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 1 } })}\n`);
	const start = Date.now();
	while (Date.now() - start < 12_000) {
		const enable = input.rx.find((line) => line.msg?.type === "frame_witness_enable");
		if (enable !== undefined && typeof enable.msg.token === "string") {
			writeFileSync(input.frameTokenPath, enable.msg.token);
			return socket;
		}
		await realSleep(15);
	}
	socket.destroy();
	throw new Error("frame reporter enable timeout");
}

export async function ensureFrameReporter(trial: TimingTrial): Promise<void> {
	if (trial.reporterSocket !== undefined) return;
	trial.reporterSocket = await connectFrameReporterAt({
		root: trial.root,
		viewId: trial.viewId,
		socketPath: trial.socketPath,
		frameTokenPath: trial.frameTokenPath,
		rx: trial.rx as unknown as Array<{ msg: Record<string, unknown> }>,
	});
}

/** Wait on real protocol/child evidence while advancing the VIRTUAL clock in
 *  small steps (the attach's reconnect/settle timers are virtual, so a real
 *  wait alone would never fire them). */
async function pumpUntilReal(trial: TimingTrial, predicate: () => boolean, timeoutMs: number, label: string, stepMs = 150): Promise<number> {
	const start = Date.now();
	let ticks = 0;
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return ticks;
		trial.clock.tick(stepMs);
		ticks += 1;
		await flushVirtual(trial.clock);
		await realSleep(10);
	}
	if (predicate()) return ticks;
	throw new Error(`timed out (real ${timeoutMs}ms, ${ticks} virtual ticks) waiting for: ${label}`);
}

/** ONE persistent real PUBLIC runner client used to deliver documented `input`
 *  commands to the child (the runner's protocol message, exactly what an
 *  attached client forwards). No private component state is touched and no
 *  readiness gate is forced; the socket stays open so consecutive commands
 *  cannot race a close. */
async function controlClient(trial: TimingTrial): Promise<{ socket: import("node:net").Socket }> {
	const existing = (trial as unknown as { controlSocket?: import("node:net").Socket }).controlSocket;
	if (existing !== undefined) return { socket: existing };
	const { createConnection } = await import("node:net");
	const socket = createConnection(trial.socketPath);
	await new Promise<void>((resolveConnect, rejectConnect) => {
		socket.once("connect", () => resolveConnect());
		socket.once("error", rejectConnect);
		realSetTimeout(() => rejectConnect(new Error("control client connect timeout")), 4000).unref?.();
	});
	socket.on("error", () => {
		/* recorded by the child event log */
	});
	socket.write(`${JSON.stringify({ type: "hello", clientId: `s21a-ctl-${process.pid}`, wantOutput: false })}\n`);
	(trial as unknown as { controlSocket?: import("node:net").Socket }).controlSocket = socket;
	await flushRealTurn();
	return { socket };
}

async function controlSend(trial: TimingTrial, command: Record<string, unknown>): Promise<void> {
	const { socket } = await controlClient(trial);
	socket.write(`${JSON.stringify({ type: "input", data: `\u001e${JSON.stringify(command)}\n` })}\n`);
	await flushRealTurn();
	await realSleep(5);
}

export async function closeTimingTrial(trial: TimingTrial, cleanup: DiagCleanup): Promise<void> {
	try {
		(trial as unknown as { controlSocket?: import("node:net").Socket }).controlSocket?.destroy();
	} catch {
		/* best-effort */
	}
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	try {
		// Ordered exit through the documented public runner `input` message.
		const { createConnection } = await import("node:net");
		const socket = createConnection(trial.socketPath);
		await new Promise<void>((resolveConnect, rejectConnect) => {
			socket.once("connect", () => resolveConnect());
			socket.once("error", rejectConnect);
			realSetTimeout(() => rejectConnect(new Error("exit-client connect timeout")), 4000).unref?.();
		});
		socket.write(`${JSON.stringify({ type: "hello", clientId: `s21a-exit-${process.pid}`, wantOutput: false })}\n`);
		socket.write(`${JSON.stringify({ type: "input", data: "\u001e{\"cmd\":\"exit\"}\n" })}\n`);
		await waitReal(() => readHost(trial.root, trial.viewId)?.state === "exited", 6000, "host exited after public-socket input");
		cleanup.childExited = true;
		if (trial.runner && trial.runner.exitCode === null && trial.runner.signalCode === null) {
			await Promise.race([new Promise<void>((r) => trial.runner.once("exit", () => r())), realSleep(5000)]);
		}
		cleanup.runnerExited = trial.runner ? trial.runner.exitCode !== null || trial.runner.signalCode !== null : cleanup.runnerExited;
		cleanup.runnerExitCode = trial.runner?.exitCode ?? cleanup.runnerExitCode;
		socket.destroy();
	} catch {
		/* recorded through cleanup */
	}
	trial.clock.uninstall();
	try {
		trial.detachParser?.();
		trial.detachParser = undefined;
		(trial.component as unknown as { dispose: () => void }).dispose();
	} catch {
		/* best-effort */
	}
	try {
		trial.tui.stop();
	} catch {
		/* best-effort */
	}
	await killOwnedDiagProcesses(trial.runner ?? null, trial.root, trial.viewId, cleanup);
	try {
		rmSync(trial.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
		cleanup.rootRemoved = true;
	} catch {
		/* recorded below */
	}
	cleanup.ok = diagCleanupOk(cleanup);
	try {
		trial.observer.dispose();
	} catch {
		/* best-effort */
	}
}

// ---------------------------------------------------------------------------
// Case bodies
// ---------------------------------------------------------------------------

interface CaseRecord {
	caseId: string;
	ok: boolean;
	evidence: Record<string, unknown>;
	artifactDir: string;
	exitCode?: number;
	error?: string | null;
}

function readEvents(eventsPath: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/** The controlled-frames producer's complete literal for one frame id (the
 *  plain/same-write/split scripts share the `controlled work area` header). */
export function producerLiteral(id: string): string[] {
	return producerRowsText(id);
}

/** The COLD script's editor literal (row 0 header differs; every other row is
 *  the shared 22-row contract). Declared independently from the fixture's
 *  `editorRowsText` so the oracle is not derived from the observed bytes. */
export function coldEditorLiteral(id: string): string[] {
	const rows = producerRowsText(id);
	rows[0] = `${id} HEADER controlled cold editor`;
	return rows;
}

async function withTrial(options: TrialOptions, body: (trial: TimingTrial, dims: AttachSurfaceDims) => Promise<Record<string, unknown>>): Promise<CaseRecord> {
	if (existsSync(options.artifactDir)) throw new Error(`attempt artifact dir already exists: ${options.artifactDir}`);
	mkdirSync(options.artifactDir, { recursive: true });
	const artifactErrors: string[] = [];
	const writeArtifact = makeArtifactWriter(options.artifactDir, artifactErrors);
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	const cleanup = createDiagCleanup();
	let trial: TimingTrial | null = null;
	let error: string | null = null;
	let evidence: Record<string, unknown> = {};
	try {
		trial = await openTimingTrial(options);
		evidence = await body(trial, dims);
	} catch (err) {
		error = err instanceof Error ? (err.stack ?? err.message) : String(err);
	} finally {
		if (trial !== null) {
			const commits = commitsOf(trial.observer.observations, dims);
			// Child events are read BEFORE the owned root is removed.
			const childEvents = readEvents(trial.eventsPath);
			await closeTimingTrial(trial, cleanup);
			writeArtifact("commits.json", commits);
			writeArtifact("observations.json", trial.observer.observations);
			writeArtifact("writes.json", trial.observer.writes);
			writeArtifact("request-renders.json", trial.requestRenders);
			writeArtifact("parser-events.json", trial.parserLog);
			writeArtifact("rx.json", trial.rx);
			writeArtifact("tx.json", trial.tx);
			writeArtifact("child-events.jsonl", childEvents);
			writeArtifact("hooks.json", trial.hooks);
			writeArtifact("done.json", trial.done);
			writeArtifact("pending-timers.json", trial.clock.pending());
			writeArtifact("cleanup.json", cleanup);
			evidence = { ...evidence, cleanup, artifactErrors, commits };
		} else {
			writeArtifact("cleanup.json", cleanup);
		}
		writeArtifact("summary.json", { caseId: options.caseId, script: options.script, error, ...evidence });
	}
	const ok = error === null && evidence.ok === true;
	return { caseId: options.caseId, ok, evidence, artifactDir: options.artifactDir, exitCode: error === null ? 0 : 1, error };
}

function componentFacts(trial: TimingTrial): Record<string, unknown> {
	const c = trial.component as unknown as {
		attachMode?: string;
		attaching?: boolean;
		protocolBaselineState?: string;
		localHydrationState?: string;
		publishabilityState?: string;
		notReadyReason?: string | null;
		latestViewProof?: unknown;
		viewProofRecords?: unknown[];
		viewProofIdentity?: unknown;
		geometryRevision?: number;
		resizeIntentRequired?: boolean;
		resizeIntentSatisfied?: boolean;
		receivedOutput?: boolean;
		parserSyncOpen?: boolean;
		parserWritesInFlight?: number;
		closed?: boolean;
		attachClient?: { getLastSeq?: () => number };
		committedView?: {
			start: number;
			end: number;
			rows: Array<{ cells: { cells: Array<{ getChars: () => string }> } }>;
			cursor: unknown;
			cursorHidden: boolean;
		} | null;
	};
	return {
		mode: c.attachMode ?? null,
		attaching: c.attaching ?? null,
		baseline: c.protocolBaselineState ?? null,
		hydration: c.localHydrationState ?? null,
		publishability: c.publishabilityState ?? null,
		notReadyReason: c.notReadyReason ?? null,
		latestViewProof: c.latestViewProof ?? null,
		viewProofRecords: c.viewProofRecords ?? [],
		viewProofIdentity: c.viewProofIdentity === null || c.viewProofIdentity === undefined ? null : (() => {
			const identity = c.viewProofIdentity as Record<string, unknown>;
			return {
				connectionToken: identity.connectionToken ?? null,
				baselineToken: identity.baselineToken ?? null,
				generation: identity.generation ?? null,
				geometryRevision: identity.geometryRevision ?? null,
				targetCols: identity.targetCols ?? null,
				targetRows: identity.targetRows ?? null,
				closed: identity.closed ?? null,
				parserPresent: identity.parser !== null && identity.parser !== undefined,
			};
		})(),
		geometryRevision: c.geometryRevision ?? null,
		resizeIntentRequired: c.resizeIntentRequired ?? null,
		resizeIntentSatisfied: c.resizeIntentSatisfied ?? null,
		receivedOutput: c.receivedOutput ?? null,
		parserSyncOpen: c.parserSyncOpen ?? null,
		parserWritesInFlight: c.parserWritesInFlight ?? null,
		closed: c.closed ?? null,
		localSeq: c.attachClient?.getLastSeq?.() ?? null,
		committedView: c.committedView === null || c.committedView === undefined ? null : {
			start: c.committedView.start,
			end: c.committedView.end,
			rows: c.committedView.rows.length,
			cursor: c.committedView.cursor,
			cursorHidden: c.committedView.cursorHidden,
			firstRow: c.committedView.rows[0]?.cells.cells.map((cell) => cell.getChars()).join("").trimEnd() ?? "",
			lastRow: c.committedView.rows.at(-1)?.cells.cells.map((cell) => cell.getChars()).join("").trimEnd() ?? "",
		},
	};
}

/** Case 1 — UNDECIDED: no host yet; below the settle/hard windows the loading
 *  banner stays, hooks stay 0 and nothing publishes; firing the timers that
 *  exist in that window must not consume the later modern transition. */
export async function runUndecided(artifactDir: string): Promise<CaseRecord> {
	return withTrial({ artifactDir, caseId: "undecided", script: "plain", lateHost: true }, async (trial, dims) => {
		const literal = producerLiteral("F0");
		await flushVirtual(trial.clock);
		const beforeTicks = commitsOf(trial.observer.observations, dims);
		// Advance the pre-baseline window (below the 250 ms settle and far below the
		// 2500 ms hard cap), firing whatever timers exist (loading ticker, legacy
		// arming) — none of them may publish or install first hooks.
		const firedA = trial.clock.tick(120);
		await flushVirtual(trial.clock);
		const firedB = trial.clock.tick(120); // virtual 240 ms
		await flushVirtual(trial.clock);
		const windowCommits = commitsOf(trial.observer.observations, dims);
		const loadingSeen = windowCommits.some((commit) => classifyCommit(commit.rows, literal) === "loading");
		const windowClasses = windowCommits.map((commit) => classifyCommit(commit.rows, literal));
		const hooksDuringWindow = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const publishedDuringWindow = windowCommits.filter((commit) => classifyCommit(commit.rows, literal) === "complete").length;
		const undecided = evaluateUndecided({
			loadingObserved: loadingSeen,
			commitsDuringWindow: windowCommits.filter((commit) => classifyCommit(commit.rows, literal) !== "loading" && classifyCommit(commit.rows, literal) !== "blank").length,
			hooksDuringWindow,
			firedTimerOwners: trial.clock.pending().map((timer) => timer.owner),
			ok: false,
		});
		// Now start the REAL host: the qualified protocol baseline arrives and the
		// modern transition must complete exactly once, still below the settle window.
		await startLateHost(trial, "plain");
		await pumpUntilReal(trial, () => trial.rx.some((line) => line.msg.type === "snapshot_end"), 12_000, "undecided qualified baseline (snapshot_end)");
		const baseline = trial.rx.filter((line) => line.msg.type === "snapshot_begin").pop() ?? null;
		const qualifiedIdentity = baseline === null ? null : `${String(baseline.msg.generation ?? "?")}:${String(baseline.msg.snapshotSeq ?? "?")}`;
		// Deterministic target selection: a non-empty qualified baseline already
		// carries the complete F0 frame; an EMPTY baseline (the child seeded before
		// the model captured it) is completed through the documented producer steps
		// so the transition target never depends on a seed/attach race.
		const baselineEmpty = baseline !== null && baseline.msg.empty === true;
		if (baselineEmpty) {
			// The wrapper may make the seed frame live immediately after an empty
			// snapshot. It is the current complete frame and is the modern target;
			// only if no live seed arrives do we drive the documented F1 steps.
			await waitReal(
				() => trial.rx.some((line) => line.msg.type === "view_proof" && (line.msg.record as { marker?: string } | undefined)?.marker === "F"),
				5000,
				"undecided live seed proof",
			).catch(() => {});
			await flushVirtual(trial.clock, 100);
		}
		const seedLiteral = producerLiteral("F0");
		const seedComplete = firstCompleteCommit(commitsOf(trial.observer.observations, dims), seedLiteral);
		const targetId = seedComplete !== null ? "F0" : "F1";
		const targetLiteral = producerLiteral(targetId);
		if (baselineEmpty && seedComplete === null) {
			await controlSend(trial, { cmd: "step", step: 1 });
			await controlSend(trial, { cmd: "step", step: 2 });
			await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "closed"), 6000, "undecided F1 completion");
		}
		await flushVirtual(trial.clock);
		const beforeTransition = commitsOf(trial.observer.observations, dims);
		const completeBefore = firstCompleteCommit(beforeTransition, targetLiteral);
		// UNDECIDED contract is "completes exactly once" (the modern-before-settle
		// budget is measured by the B/S cases): advance the attach's own settle
		// window in bounded steps and require exactly ONE completion, not consumed
		// by the stale timers fired earlier.
		let loopSteps = 0;
		let loopCompleteAtEntry: number | null = null;
		for (let step = 0; step < 20; step += 1) {
			const found = firstCompleteCommit(commitsOf(trial.observer.observations, dims), targetLiteral);
			if (found !== null) {
				if (loopCompleteAtEntry === null) loopCompleteAtEntry = found.at;
				break;
			}
			loopSteps += 1;
			trial.clock.tick(50);
			await flushVirtual(trial.clock);
		}
		const virtualNowAfterLoop = trial.clock.now();
		const afterTransition = commitsOf(trial.observer.observations, dims);
		const publish = firstCompleteCommit(afterTransition, targetLiteral);
		const hooksAfter = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const halfFrames = halfFrameCommits(afterTransition, targetLiteral);
		const completeCommits = afterTransition.filter((commit) => classifyCommit(commit.rows, targetLiteral) === "complete");
		const completeCount = completeCommits.length;
		const distinctCompleteContent = new Set(completeCommits.map((commit) => commit.rows.join("\n"))).size;
		const repaintCount = completeCount - 1;
		const parserDrains = trial.parserLog.filter((entry) => entry.kind === "drain");
		const cursor = evaluatePublishCursor(publish, PRODUCER_CURSOR, dims);
		const ordering = evaluatePublishOrdering({ publish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		const identity = evaluatePublishIdentity({ publishIdentity: publish === null ? null : qualifiedIdentity, qualifiedIdentity });
		return {
			ok:
				undecided.ok &&
				publish !== null &&
				hooksAfter.colorProbe === 1 &&
				hooksAfter.schemeBridge === 1 &&
				halfFrames.length === 0 &&
				distinctCompleteContent === 1 &&
				identity.ok &&
				cursor.matched &&
				ordering.ok &&
				parserDrains.length > 0,
			undecided,
			windowClasses,
			publishedDuringWindow,
			firedTicks: [firedA, firedB],
			virtualNowAtWindowEnd: 240,
			virtualNowAtPublish: publish?.at ?? null,
			loopSteps,
			loopCompleteAtEntry,
			virtualNowAfterLoop,
			// Truthful semantics: a complete commit already existed when the bounded
			// transition loop STARTED (not a causal ordering claim).
			completeBeforeTransitionLoop: completeBefore !== null,
			baselineKind: baselineEmpty ? "empty-live" : "snapshot",
			targetFrameId: targetId,
			parserDrains: parserDrains.length,
			parserDrainEvents: parserDrains.map((entry) => ({ at: entry.at, observationCount: entry.observationCount })),
			cursor,
			ordering,
			publishAt: publish?.at ?? null,
			completeCount,
			distinctCompleteContent,
			repaintCount,
			halfFrames: halfFrames.length,
			hooksAfter,
			qualifiedIdentity,
			identity,
			loadingStateRetained: loadingSeen,
			note: "undecided window: loading only, hooks 0, no publish even with the pre-baseline timers fired; after the qualified baseline the new identity completes exactly once (repaints of the same content are not transitions)",
		};
	});
}

/** Case 2 — B same-size nonempty: the authoritative snapshot is validated, the
 *  local parser drains and the child frame is independently complete; the
 *  complete literal must be committed within the modern budget (NOT after 250). */
export async function runSameSizeB(artifactDir: string): Promise<CaseRecord> {
	return withTrial({ artifactDir, caseId: "B", script: "plain" }, async (trial, dims) => {
		const literal = producerLiteral("F0");
		await waitReal(() => trial.rx.some((line) => line.msg.type === "snapshot_end"), 12_000, "B qualified baseline");
		await flushVirtual(trial.clock);
		const completeFrameAt = trial.clock.now();
		const parserDrains = trial.parserLog.filter((entry) => entry.kind === "drain").length;
		// Tick to just below the settle window.
		trial.clock.tick(SETTLE_MS - 10);
		await flushVirtual(trial.clock);
		const commits = commitsOf(trial.observer.observations, dims);
		const publish = firstCompleteCommit(commits, literal);
		const resizes = trial.tx.filter((line) => line.msg.type === "resize").length;
		const hooksAfter = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const modern = evaluateModernBeforeSettle({ completeFrameAt, publishAt: publish?.at ?? null });
		const halfFrames = halfFrameCommits(commits, literal);
		const cursor = evaluatePublishCursor(publish, PRODUCER_CURSOR, dims);
		const ordering = evaluatePublishOrdering({ publish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		// EVIDENCE ONLY (after the assertion point): let the old settle window
		// elapse (bounded small steps) and record where the current source publishes.
		const pumped = await pumpForCompletePublish(trial, dims, literal);
		const oldSettlePublish = pumped.commit;
		const oldSettleHooks = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		// EVIDENCE: the SAME projected-cursor assertion on the old settle publish
		// proves the cursor oracle is not a harness bug (a P4 boundary publish would
		// satisfy it identically).
		const oldSettleCursor = evaluatePublishCursor(oldSettlePublish, PRODUCER_CURSOR, dims);
		const oldSettleOrdering = evaluatePublishOrdering({ publish: oldSettlePublish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		return {
			ok: modern.ok && resizes === 0 && hooksAfter.colorProbe === 1 && hooksAfter.schemeBridge === 1 && halfFrames.length === 0 && cursor.matched && ordering.ok && parserDrains > 0,
			modern,
			completeFrameAt,
			publishAt: publish?.at ?? null,
			virtualNowAtAssert: SETTLE_MS - 10,
			parserDrains,
			parserWrites: trial.parserLog.filter((entry) => entry.kind === "write").length,
			resizes,
			hooksAfter,
			halfFrames: halfFrames.length,
			cursor,
			ordering,
			oldSettlePublishAt: oldSettlePublish?.at ?? null,
			oldSettleHooks,
			oldSettleCursor,
			oldSettleOrdering,
			componentFacts: componentFacts(trial),
			note: "same-size nonempty: authoritative snapshot + parser drain + complete frame; the modern contract publishes before the settle window with zero resize",
		};
	});
}

/** Case 3 — S synchronized split: OPEN+upper parsed/drained (still loading, no
 *  half frame); after the lower half + CLOSE + drain the SAME frame publishes
 *  before 250. `close-open-in-one-chunk` uses the same-write script. */
export async function runSplitS(artifactDir: string, closeOpenInOneChunk = false): Promise<CaseRecord> {
	const script = closeOpenInOneChunk ? "same-write" : "split";
	return withTrial({ artifactDir, caseId: closeOpenInOneChunk ? "S-close-open" : "S", script }, async (trial, dims) => {
		const literal = producerLiteral("F1");
		await waitReal(() => trial.rx.some((line) => line.msg.type === "snapshot_end"), 12_000, "S qualified baseline");
		await flushVirtual(trial.clock);
		// Drive the real child's split writes through the documented input path.
		await controlSend(trial, { cmd: "step", step: 1 });
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "open-fragment-1" || event.phase === "open"), 6000, "S open fragment emitted");
		await flushVirtual(trial.clock);
		if (closeOpenInOneChunk) {
			await controlSend(trial, { cmd: "step", step: 2 }); // lower(F1)+CLOSE+OPEN+upper(F2) in ONE chunk
		} else {
			await controlSend(trial, { cmd: "step", step: 2 }); // "6h" + upper(F1)
		}
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "open"), 6000, "S upper half emitted");
		await flushVirtual(trial.clock);
		// Force the other public render entries while the synchronized block is open.
		trial.tui.requestRender();
		(trial.component as unknown as { onSocketData?: (text: string) => void }).onSocketData?.(
			`${JSON.stringify({ type: "status", status: { frameWitness: { enabled: true } } })}\n`,
		);
		await flushVirtual(trial.clock, 30);
		const midCommits = commitsOf(trial.observer.observations, dims);
		const midHooks = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const midComponentFacts = componentFacts(trial);
		const midHalfFrames = halfFrameCommits(midCommits, literal).length;
		const midComplete = firstCompleteCommit(midCommits, literal);
		// Close the frame in script order (split: step 3 = lower + close fragment,
		// step 4 = "6l"; same-write: step 3 = lower(F2) + CLOSE).
		await controlSend(trial, { cmd: "step", step: 3 });
		await flushVirtual(trial.clock);
		if (!closeOpenInOneChunk) {
			await controlSend(trial, { cmd: "step", step: 4 });
		}
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "closed"), 6000, "S close emitted");
		await flushVirtual(trial.clock, 200);
		const completeFrameAt = trial.clock.now();
		// Tick below the settle window: the same-frame publish must already be here.
		trial.clock.tick(SETTLE_MS - 10); // one explicit tick below the settle window
		await flushVirtual(trial.clock, 200);
		const commits = commitsOf(trial.observer.observations, dims);
		const target = closeOpenInOneChunk ? producerLiteral("F2") : literal;
		const publish = firstCompleteCommit(commits, target);
		const hooksAfter = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const modern = evaluateModernBeforeSettle({ completeFrameAt, publishAt: publish?.at ?? null });
		const initialLiteral = producerLiteral("F0");
		const initialPublish = firstCompleteCommit(commits, initialLiteral);
		const initialModern = evaluateModernBeforeSettle({ completeFrameAt: 0, publishAt: initialPublish?.at ?? null });
		const families = ["F0", "F1", "F2"].map((id) => producerLiteral(id));
		const anyComplete = (rows: readonly string[]) => families.some((literal) => classifyCommit(rows, literal) === "complete");
		const afterInitial = initialPublish === null ? commits : commits.filter((commit) => commit.index > initialPublish.index);
		const postInitialHalfFrames = afterInitial.filter((commit) => classifyCommit(commit.rows, target) === "half-frame" && !anyComplete(commit.rows)).length;
		const mixedFrameNumbers = afterInitial.filter((commit) => {
			const ids = new Set(commit.rows.map((row) => /^(F\d+) /u.exec(row)?.[1] ?? "").filter(Boolean));
			return ids.size > 1;
		}).length;
		const initialHalfFrames = initialPublish === null ? 0 : halfFrameCommits(commits.slice(0, initialPublish.index + 1), initialLiteral).length;
		const halfFrames = halfFrameCommits(commits, target);
		const cursor = evaluatePublishCursor(publish, PRODUCER_CURSOR, dims);
		const ordering = evaluatePublishOrdering({ publish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		// EVIDENCE ONLY after the assertion point: where does the old source publish?
		const pumped = await pumpForCompletePublish(trial, dims, target);
		const oldSettlePublish = pumped.commit;
		const oldSettleHooks = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const oldSettleCursor = evaluatePublishCursor(oldSettlePublish, PRODUCER_CURSOR, dims);
		const oldSettleOrdering = evaluatePublishOrdering({ publish: oldSettlePublish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		return {
			ok:
				initialModern.ok &&
				initialHalfFrames === 0 &&
				postInitialHalfFrames === 0 &&
				mixedFrameNumbers === 0 &&
				hooksAfter.colorProbe === 1 &&
				hooksAfter.schemeBridge === 1 &&
				cursor.matched &&
				ordering.ok,
			modern,
			initialModern,
			initialPublishAt: initialPublish?.at ?? null,
			initialHalfFrames,
			postInitialHalfFrames,
			mixedFrameNumbers,
			controlRendersWhileOpen: commits.filter((commit) => commit.at >= 0 && classifyCommit(commit.rows, initialLiteral) === "complete" || classifyCommit(commit.rows, initialLiteral) === "loading").length,
			midHalfFrames,
			midCompleteAt: midComplete?.at ?? null,
			midHooks,
			hooksAfter,
			publishAt: publish?.at ?? null,
			completeFrameAt,
			halfFrames: halfFrames.length,
			splitFrameId: closeOpenInOneChunk ? "F2" : "F1",
			cursor,
			ordering,
			oldSettlePublishAt: oldSettlePublish?.at ?? null,
			oldSettleHooks,
			oldSettleCursor,
			oldSettleOrdering,
			componentFacts: componentFacts(trial),
			midComponentFacts,
			note: closeOpenInOneChunk
				? "same-write: lower(F1)+CLOSE+OPEN+upper(F2) in one chunk never publishes a half frame; F2 publishes complete before the settle window"
				: "split: OPEN fragment + upper half parsed/drained never publishes; lower+CLOSE+drain publishes the same F1 before the settle window",
		};
	});
}

/** Case 4a — DELAYED B: the complete authoritative frame only arrives after fake
 *  250 ms (host starts late); nothing publishes before it, and the publish does
 *  not wait for the 2500 ms hard cap. */
export async function runDelayedB(artifactDir: string): Promise<CaseRecord> {
	return withTrial({ artifactDir, caseId: "delayed-B", script: "plain", lateHost: true }, async (trial, dims) => {
		const literal = producerLiteral("F0");
		trial.clock.tick(300); // past the settle window, below the hard cap
		await flushVirtual(trial.clock);
		const beforeCommits = commitsOf(trial.observer.observations, dims);
		const beforeHooks = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		await startLateHost(trial, "plain");
		await pumpUntilReal(trial, () => trial.rx.some((line) => line.msg.type === "snapshot_end"), 12_000, "delayed-B baseline");
		await waitReal(
			() => trial.rx.some((line) => line.msg.type === "view_proof" && (line.msg.record as { marker?: string } | undefined)?.marker === "F"),
			12_000,
			"delayed-B complete proof",
		);
		await flushVirtual(trial.clock, 200);
		const completeFrameAt = trial.clock.now();
		// Small modern budget after the real complete boundary (NOT the hard cap).
		trial.clock.tick(MODERN_PUBLISH_BUDGET_MS);
		await flushVirtual(trial.clock, 200);
		const commits = commitsOf(trial.observer.observations, dims);
		const publish = firstCompleteCommit(commits, literal);
		const hooksAfter = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const cursor = evaluatePublishCursor(publish, PRODUCER_CURSOR, dims);
		const ordering = evaluatePublishOrdering({ publish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		// EVIDENCE ONLY after the boundary assertion: let the old settle window
		// elapse (bounded small steps) and record where it actually publishes.
		const pumped = await pumpForCompletePublish(trial, dims, literal);
		const oldSettlePublish = pumped.commit;
		const oldSettleHooks = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const oldSettleCursor = evaluatePublishCursor(oldSettlePublish, PRODUCER_CURSOR, dims);
		const oldSettleOrdering = evaluatePublishOrdering({ publish: oldSettlePublish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		const oldSettlePump = { steps: pumped.steps, waitedMs: pumped.waitedMs, virtualNow: trial.clock.now() };
		const delayed = evaluateDelayed({
			commitsBeforeBoundary: beforeCommits,
			literal,
			completeFrameAt,
			boundaryPublishAt: publish?.at ?? null,
			settlePublishAt: oldSettlePublish?.at ?? null,
		});
		return {
			ok:
				delayed.ok &&
				beforeHooks.colorProbe === 0 &&
				beforeHooks.schemeBridge === 0 &&
				hooksAfter.colorProbe === 1 &&
				hooksAfter.schemeBridge === 1 &&
				cursor.matched &&
				ordering.ok,
			delayed,
			completeFrameAt,
			completeFrameAtNote: "pump-tick boundary (the clock advanced in steps while awaiting the real baseline), not the exact arrival instant",
			publishAt: publish?.at ?? null,
			cursor,
			ordering,
			oldSettlePublishAt: oldSettlePublish?.at ?? null,
			oldSettleHooks,
			oldSettleCursor,
			oldSettleOrdering,
			virtualNowBeforeHost: 300,
			beforeHooks,
			hooksAfter,
			beforeClasses: beforeCommits.map((commit) => classifyCommit(commit.rows, literal)),
			componentFacts: componentFacts(trial),
			note: "delayed complete frame (>250, <2500): loading/no publish before it; publish at the complete boundary without waiting for 2500",
		};
	});
}

/** Case 4b — DELAYED S: the split halves arrive after fake 250 ms; the upper
 *  half alone must never publish; the completed frame publishes at its boundary. */
export async function runDelayedSplit(artifactDir: string): Promise<CaseRecord> {
	return withTrial({ artifactDir, caseId: "delayed-S", script: "cold" }, async (trial, dims) => {
		const literal = coldEditorLiteral("E1");
		await waitReal(() => trial.rx.some((line) => line.msg.type === "snapshot_begin"), 12_000, "delayed-S baseline (empty cold baseline)");
		await flushVirtual(trial.clock);
		trial.clock.tick(300); // past the settle window, below the hard cap
		await flushVirtual(trial.clock);
		const beforeCommits = commitsOf(trial.observer.observations, dims);
		// Cold script order: step 1 = unframed boot text, step 2 = alt screen +
		// bracketed paste, step 3 = OPEN + upper half, step 4 = lower + CLOSE.
		await controlSend(trial, { cmd: "step", step: 1 });
		await controlSend(trial, { cmd: "step", step: 2 });
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "input-mode"), 6000, "delayed-S boot/modes");
		await flushVirtual(trial.clock);
		await controlSend(trial, { cmd: "step", step: 3 });
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "open"), 6000, "delayed-S upper half");
		await flushVirtual(trial.clock);
		trial.clock.tick(SETTLE_MS); // the legacy 250 ms callback may already fire here
		await flushVirtual(trial.clock);
		const midCommits = commitsOf(trial.observer.observations, dims);
		const midHalfFrames = halfFrameCommits(midCommits, literal).length;
		const midComplete = firstCompleteCommit(midCommits, literal);
		const midContentCommits = midCommits.filter((commit) => {
			const kind = classifyCommit(commit.rows, literal);
			return kind !== "loading" && kind !== "blank";
		}).length;
		const midHooks = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		// Complete the frame: step 4 = lower half + CLOSE.
		await controlSend(trial, { cmd: "step", step: 4 });
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "closed"), 6000, "delayed-S close");
		await flushVirtual(trial.clock);
		const completeFrameAt = trial.clock.now();
		trial.clock.tick(MODERN_PUBLISH_BUDGET_MS);
		await flushVirtual(trial.clock);
		const commits = commitsOf(trial.observer.observations, dims);
		const publish = firstCompleteCommit(commits, literal);
		const hooksAfter = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const cursor = evaluatePublishCursor(publish, PRODUCER_CURSOR, dims);
		const ordering = evaluatePublishOrdering({ publish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		// EVIDENCE ONLY: bounded pump for the old settle publish (tick granularity safe).
		const pumpedSettle = await pumpForCompletePublish(trial, dims, literal);
		const oldSettlePublish = pumpedSettle.commit;
		const oldSettleHooks = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const oldSettleCursor = evaluatePublishCursor(oldSettlePublish, PRODUCER_CURSOR, dims);
		const oldSettleOrdering = evaluatePublishOrdering({ publish: oldSettlePublish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		const oldSettlePump = { steps: pumpedSettle.steps, waitedMs: pumpedSettle.waitedMs, virtualNow: trial.clock.now() };
		const delayed = evaluateDelayed({
			commitsBeforeBoundary: beforeCommits,
			literal,
			completeFrameAt,
			boundaryPublishAt: publish?.at ?? null,
			settlePublishAt: oldSettlePublish?.at ?? null,
		});
		return {
			ok:
				delayed.ok &&
				midHalfFrames === 0 &&
				midContentCommits === 0 &&
				midComplete === null &&
				midHooks.colorProbe === 0 &&
				midHooks.schemeBridge === 0 &&
				hooksAfter.colorProbe === 1 &&
				hooksAfter.schemeBridge === 1 &&
				cursor.matched &&
				ordering.ok,
			delayed,
			// CONDITIONAL: this boundary-budget pass exists only because the attach
			// already transitioned via the BOOT violation; it is NOT independent
			// modern-budget evidence. The case-level RED is the early BOOT/hooks.
			delayedSubverdictConditional: true,
			delayedSubverdictNote:
				"delayed.ok=true is conditional on the BOOT violation having already settled the attach; it is not independent modern-budget evidence",
			settleChronology:
				"the legacy settle fired at virtual 250 (armed at the empty baseline) BEFORE the boot text and the split halves; the BOOT commits are post-transition live output",
			completeFrameAt,
			completeFrameAtNote: "pump-tick boundary, not the exact arrival instant",
			publishAt: publish?.at ?? null,
			cursor,
			ordering,
			oldSettlePublishAt: oldSettlePublish?.at ?? null,
			oldSettleHooks,
			oldSettleCursor,
			oldSettleOrdering,
			oldSettlePump,
			midHalfFrames,
			midContentCommits,
			midCompleteAt: midComplete?.at ?? null,
			midHooks,
			hooksAfter,
			componentFacts: componentFacts(trial),
			note: "delayed split (>250): an incomplete upper half never publishes even after the legacy 250 ms callback; the completed frame publishes at its own boundary",
		};
	});
}

/** Case 5 — LATE/STALE timers: after a qualified publish, ticking past the
 *  settle and hard-timeout windows must not repeat the first hooks or publish
 *  another first view; after dispose no render may occur. */
export async function runLateTimers(artifactDir: string): Promise<CaseRecord> {
	return withTrial({ artifactDir, caseId: "late-timers", script: "plain" }, async (trial, dims) => {
		const literal = producerLiteral("F0");
		await waitReal(() => trial.rx.some((line) => line.msg.type === "snapshot_end"), 12_000, "late-timers baseline");
		await flushVirtual(trial.clock);
		// Reach a QUALIFIED publish first (the current source publishes at its settle
		// boundary; the modern contract is measured by the B/S cases), then fire the
		// late/stale timers and prove they cannot repeat hooks or publish again.
		trial.clock.tick(SETTLE_MS + 10);
		await flushVirtual(trial.clock);
		const pre = commitsOf(trial.observer.observations, dims);
		const publish = firstCompleteCommit(pre, literal);
		const hooksBefore = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const completeCommitsBefore = pre.filter((commit) => classifyCommit(commit.rows, literal) === "complete").length;
		// Late settle callback + hard timeout + a wide stale sweep.
		trial.clock.tick(SETTLE_MS);
		await flushVirtual(trial.clock);
		trial.clock.tick(HARD_TIMEOUT_MS);
		await flushVirtual(trial.clock);
		const mid = commitsOf(trial.observer.observations, dims);
		const hooksAfter = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const completeCommitsAfter = mid.filter((commit) => classifyCommit(commit.rows, literal) === "complete").length;
		const completeKeysBefore = new Set(pre.filter((commit) => classifyCommit(commit.rows, literal) === "complete").map((commit) => commit.rows.join("\n")));
		const newCompleteDistinct = new Set(mid.filter((commit) => classifyCommit(commit.rows, literal) === "complete" && !completeKeysBefore.has(commit.rows.join("\n"))).map((commit) => commit.rows.join("\n"))).size;
		const halfFramesAfter = halfFrameCommits(mid, literal).length;
		// Dispose, then fire every remaining timer: nothing may render after dispose.
		const disposeAt = trial.clock.now();
		const writesBefore = trial.observer.writes.length;
		trial.detachParser?.();
		trial.detachParser = undefined;
		(trial.component as unknown as { dispose: () => void }).dispose();
		trial.clock.tick(HARD_TIMEOUT_MS * 2);
		await flushVirtual(trial.clock);
		const postDisposeWrites = trial.observer.writes.filter((write) => write.receivedAt >= disposeAt).length;
		const late = evaluateLateTimers({ hooksBefore, hooksAfter, completeCommitsBefore, completeCommitsAfter, newCompleteDistinct, halfFramesAfter, postDisposeWrites });
		const cursor = evaluatePublishCursor(publish, PRODUCER_CURSOR, dims);
		const ordering = evaluatePublishOrdering({ publish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		return {
			ok: publish !== null && late.ok && cursor.matched && ordering.ok,
			publishAt: publish?.at ?? null,
			cursor,
			ordering,
			hooksBefore,
			hooksAfter,
			completeCommitsBefore,
			completeCommitsAfter,
			newCompleteDistinct,
			halfFramesAfter,
			postDisposeWrites,
			writesBeforeDispose: writesBefore,
			disposeAt,
			late,
			note: "late/stale timers after a qualified publish: hooks stay 1, no second first view, no half frame, and no render after dispose",
		};
	});
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CASES = new Set(["undecided", "B", "S", "S-close-open", "delayed-B", "delayed-S", "late-timers"]);

export async function runCase21A(options: { caseId: string; artifactDir: string }): Promise<Record<string, unknown>> {
	const invocationId = `inv-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
	const record = await (async (): Promise<CaseRecord> => {
		if (options.caseId === "undecided") return runUndecided(options.artifactDir);
		if (options.caseId === "B") return runSameSizeB(options.artifactDir);
		if (options.caseId === "S") return runSplitS(options.artifactDir, false);
		if (options.caseId === "S-close-open") return runSplitS(options.artifactDir, true);
		if (options.caseId === "delayed-B") return runDelayedB(options.artifactDir);
		if (options.caseId === "delayed-S") return runDelayedSplit(options.artifactDir);
		return runLateTimers(options.artifactDir);
	})();
	const result = {
		ok: record.ok === true,
		exitCode: record.exitCode ?? (record.ok ? 0 : 1),
		caseId: options.caseId,
		invocationId,
		trials: [record],
		artifactRoot: options.artifactDir,
	};
	writeFileSync(join(options.artifactDir, `result-${invocationId}.json`), JSON.stringify(result, null, 2));
	return result;
}

function cliError(message: string): never {
	process.stderr.write(`pty-attach-timing-scenario: ${message}\n`);
	process.exit(2);
}

export function parse21ACli(argv: string[]): { caseId: string; artifactDir: string } {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith("--") || i + 1 >= argv.length) cliError(`malformed arguments: ${argv.join(" ")}`);
		args.set(argv[i].slice(2), argv[i + 1]);
	}
	const caseId = args.get("case") ?? cliError("missing --case");
	if (!CASES.has(caseId)) cliError(`unsupported --case ${JSON.stringify(caseId)} (only ${[...CASES].join(", ")} are implemented)`);
	const artifactDir = args.get("artifact-dir") ?? cliError("missing --artifact-dir");
	return { caseId, artifactDir };
}

const isMain = (() => {
	try {
		return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
	} catch {
		return false;
	}
})();

if (isMain) {
	const cli = parse21ACli(process.argv.slice(2));
	runCase21A({ caseId: cli.caseId, artifactDir: cli.artifactDir })
		.then((result) => {
			process.stdout.write(JSON.stringify(result) + "\n");
			process.exit(typeof result.exitCode === "number" ? result.exitCode : 0);
		})
		.catch((err) => {
			process.stderr.write(`pty-attach-timing-scenario: harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exit(1);
		});
}
