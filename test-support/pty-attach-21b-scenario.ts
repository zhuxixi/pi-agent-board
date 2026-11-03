// Issue #222 step 21B (task-21b-brief.md): A4 target-geometry, A5 empty/cold
// startup, C poison+boot-before-editor, all DELAYED (>250, <2500), plus the
// SEPARATE legacy compatibility contracts (unframed settle/hard-cap and forced
// legacy jiggle).
//
// Additive only: accepted 20A/20B/21A sources, oracles and raw are untouched.
// This file reuses the accepted 21A fake clock and oracles, the accepted
// presentation observer, the real runner/child/component/TUI/parser, and the
// accepted public hook/cursor/ordering instrumentation. Only attach-side timers
// are virtual (`Date.now` stays real so runner fencing is unaffected).
//
// STATUS: A4/A5 are CONTROLLED DIAGNOSTIC evidence; A4/A5 production signal
// sufficiency remains UNESTABLISHED. Fake timing is not a latency distribution
// or physical-pixel claim.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
	s16GeometryRowsText,
	s16GeometryCursor,
	s16EditorRowsText,
	S16_BOOT_LINES,
	S16_POISON_TEXT,
	createDiagCleanup,
	diagCleanupOk,
	killOwnedDiagProcesses,
	type AttachSurfaceDims,
	type DiagCleanup,
} from "./pty-attach-ready-scenario.ts";
import {
	SETTLE_MS,
	HARD_TIMEOUT_MS,
	MODERN_PUBLISH_BUDGET_MS,
	createFakeClock,
	classifyCommit,
	firstCompleteCommit,
	halfFrameCommits,
	evaluatePublishCursor,
	evaluatePublishOrdering,
	type FakeClock,
	type OuterCommit,
} from "./pty-attach-timing-scenario.ts";
import { formalMeasurementVersion } from "./formal-measurement/version.mjs";
import { holdFormalObservation } from "./formal-measurement/observation.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONTROLLED_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-pi.mjs");
const MEASUREMENT_CONTROLLED_CHILD = resolve(REPO_ROOT, "test-support/formal-measurement/fake-pty-controlled-pi.mjs");
const C_FRAME_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-c-frame.mjs");
const FRAME_WRAPPER = resolve(REPO_ROOT, "test-support/fake-pty-frame-wrapper.mjs");
const GEOMETRY_FRAME_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-geometry-frame-pi.mjs");
const UNFRAMED_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-unframed-pi.mjs");
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;
const realSleep = (ms: number) => new Promise<void>((resolveSleep) => realSetTimeout(resolveSleep, ms));
const flushRealTurn = () => new Promise<void>((resolveTurn) => realSetImmediate(resolveTurn));
const realNow = () => Date.now();

// ---------------------------------------------------------------------------
// Pure oracles (21B-specific; the 21A oracles are reused unchanged)
// ---------------------------------------------------------------------------

export interface GeometryGate {
	resizeCommands: Array<{ cols: number; rows: number; at: number }>;
	appliedAcks: Array<{ at: number; value: string | null }>;
	childLiveDims: Array<{ cols: number | null; rows: number | null; at: number }>;
	expectedTarget: { cols: number; rows: number };
	exactlyOneResize: boolean;
	resizeTargetsCorrectly: boolean;
	appliedBeforeTargetFrame: boolean;
	ok: boolean;
	note: string;
}

/** A4 gate: exactly ONE real resize to the target geometry, applied by the
 *  runner, and the child really reported the live target dims. */
export function evaluateGeometryGate(input: {
	resizeCommands: Array<{ cols: number; rows: number; at: number }>;
	appliedAcks: Array<{ at: number; value: string | null }>;
	childLiveDims: Array<{ cols: number | null; rows: number | null; at: number }>;
	expectedTarget: { cols: number; rows: number };
	targetFrameAt: number | null;
}): GeometryGate {
	const { cols, rows } = input.expectedTarget;
	const targetCommands = input.resizeCommands.filter((command) => command.cols === cols && command.rows === rows);
	const exactlyOneResize = input.resizeCommands.length === 1 && targetCommands.length === 1;
	const resizeTargetsCorrectly = targetCommands.length > 0;
	const lastApply = input.appliedAcks.length === 0 ? null : input.appliedAcks[input.appliedAcks.length - 1];
	const appliedBeforeTargetFrame = lastApply !== null && (input.targetFrameAt === null || lastApply.at <= input.targetFrameAt);
	const liveDimsMatch = input.childLiveDims.some((dims) => dims.cols === cols && dims.rows === rows);
	return {
		resizeCommands: input.resizeCommands,
		appliedAcks: input.appliedAcks,
		childLiveDims: input.childLiveDims,
		expectedTarget: input.expectedTarget,
		exactlyOneResize,
		resizeTargetsCorrectly,
		appliedBeforeTargetFrame,
		ok: exactlyOneResize && resizeTargetsCorrectly && appliedBeforeTargetFrame && liveDimsMatch,
		note: "one resize command to the target geometry, applied ack before the target frame, and a real child pty-resize at those dims",
	};
}

/** A4/A5/C pre-boundary gate: before the independently complete CURRENT frame
 *  nothing but loading/blank may have been committed and no first hook may have
 *  fired. Old-geometry frames, boot text, partial editors and arbitrary sync
 *  closes all fail this gate. */
export interface PreBoundaryGate {
	commits: number;
	classes: string[];
	firstHook: { colorProbe: number; schemeBridge: number };
	ok: boolean;
	note: string;
}

export function evaluatePreBoundary(commits: readonly OuterCommit[], targetLiteral: readonly string[], hooks: { colorProbe: number; schemeBridge: number }): PreBoundaryGate {
	const classes = commits.map((commit) => classifyCommit(commit.rows, targetLiteral));
	const content = classes.filter((kind) => kind !== "loading" && kind !== "blank");
	const ok = content.length === 0 && hooks.colorProbe === 0 && hooks.schemeBridge === 0;
	return {
		commits: commits.length,
		classes,
		firstHook: hooks,
		ok,
		note: "only loading/blank commits and zero first hooks before the complete current frame",
	};
}

/** Poison gate: the planted marker must never appear in any outer commit row or
 *  outer write (observations and writes are scanned). */
export interface PoisonGate {
	marker: string;
	planted: boolean;
	plantReadbackContained: boolean;
	observationHits: number;
	writeHits: number;
	ok: boolean;
}

export function evaluatePoison(input: {
	marker: string;
	plantReadbackContained: boolean;
	commits: readonly OuterCommit[];
	writes: ReadonlyArray<{ data: string }>;
}): PoisonGate {
	const observationHits = input.commits.filter((commit) => commit.rows.some((row) => row.includes(input.marker))).length;
	const writeHits = input.writes.filter((write) => write.data.includes(input.marker)).length;
	return {
		marker: input.marker,
		planted: true,
		plantReadbackContained: input.plantReadbackContained,
		observationHits,
		writeHits,
		ok: input.plantReadbackContained && observationHits === 0 && writeHits === 0,
	};
}

/** Legacy compatibility gate: the legacy path must NOT be judged by the modern
 *  boundary budget. It keeps the original 250 ms settle (and the 2500 ms hard
 *  cap as the outer bound), so a complete unframed surface publishes at/after
 *  the settle — never before it. */
export interface LegacySettleGate {
	lastOutputAt: number | null;
	publishAt: number | null;
	settleDelayMs: number | null;
	publishedBeforeSettle: boolean;
	publishedAtSettle: boolean;
	withinHardCap: boolean;
	modernBudgetWouldFail: boolean;
	ok: boolean;
	note: string;
}

export function evaluateLegacySettle(input: { lastOutputAt: number | null; publishAt: number | null }): LegacySettleGate {
	if (input.publishAt === null || input.lastOutputAt === null) {
		return {
			lastOutputAt: input.lastOutputAt,
			publishAt: input.publishAt,
			settleDelayMs: null,
			publishedBeforeSettle: false,
			publishedAtSettle: false,
			withinHardCap: false,
			modernBudgetWouldFail: true,
			ok: false,
			note: "no publish/last-output observed",
		};
	}
	const delay = input.publishAt - input.lastOutputAt;
	const publishedAtSettle = delay >= SETTLE_MS;
	const withinHardCap = delay < HARD_TIMEOUT_MS;
	const modernBudgetWouldFail = delay > MODERN_PUBLISH_BUDGET_MS;
	return {
		lastOutputAt: input.lastOutputAt,
		publishAt: input.publishAt,
		settleDelayMs: delay,
		publishedBeforeSettle: delay < SETTLE_MS,
		publishedAtSettle,
		withinHardCap,
		modernBudgetWouldFail,
		ok: publishedAtSettle && withinHardCap && modernBudgetWouldFail,
		note: "legacy compatibility: the publish waits for the 250 ms settle (the modern 30 ms budget does NOT apply) and stays inside the 2500 ms cap",
	};
}

/** Legacy reveal gate: the FIRST non-loading content commit must wait for the
 *  250 ms settle after the LAST parser output that preceded it (the legacy
 *  transition gate). Later live outputs are not settle-gated (the attach is
 *  already settled) and are not claimed otherwise. */
export interface LegacyRevealGate {
	firstContentAt: number | null;
	lastWriteBeforeContentAt: number | null;
	revealDelayMs: number | null;
	attachStartAt: number;
	hardCapDelayMs: number | null;
	revealedAtLegacyDeadline: boolean;
	revealedByHardCap: boolean;
	revealedBySettle: boolean;
	modernFastPath: boolean;
	ok: boolean;
	note: string;
}

export function evaluateLegacyReveal(input: {
	firstHookAt: number | null;
	parserWrites: ReadonlyArray<{ at: number }>;
}): LegacyRevealGate {
	if (input.firstHookAt === null) {
		return {
			firstContentAt: null,
			lastWriteBeforeContentAt: null,
			revealDelayMs: null,
			attachStartAt: 0,
			hardCapDelayMs: null,
			revealedAtLegacyDeadline: false,
			revealedByHardCap: false,
			revealedBySettle: false,
			modernFastPath: false,
			ok: false,
			note: "no settle transition observed",
		};
	}
	const before = input.parserWrites.filter((write) => write.at <= input.firstHookAt!);
	const lastWrite = before.length === 0 ? null : before[before.length - 1].at;
	const delay = lastWrite === null ? null : input.firstHookAt - lastWrite;
	const attachStartAt = 0; // the mount is virtual t=0 for every trial
	const hardCapDelay = input.firstHookAt - attachStartAt;
	// The legacy attach can NEVER reveal before its own 250 ms settle (the timer
	// needs 250 ms from the first output/mount). Continuous real-time output
	// (e.g. a paste-enable every 100 ms) may defer that settle to the documented
	// 2500 ms hard cap; both are legacy deadlines. The per-output delay is
	// recorded as evidence only, because a real-time child chunk can land in the
	// same virtual tick as the settle.
	const revealedBySettle = hardCapDelay >= SETTLE_MS && hardCapDelay < HARD_TIMEOUT_MS - 50;
	const revealedByHardCap = hardCapDelay >= HARD_TIMEOUT_MS - 50;
	const modernFastPath = hardCapDelay <= MODERN_PUBLISH_BUDGET_MS;
	return {
		firstContentAt: input.firstHookAt,
		lastWriteBeforeContentAt: lastWrite,
		revealDelayMs: delay,
		attachStartAt,
		hardCapDelayMs: hardCapDelay,
		revealedAtLegacyDeadline: revealedBySettle || revealedByHardCap,
		revealedByHardCap,
		revealedBySettle,
		modernFastPath,
		ok: hardCapDelay >= SETTLE_MS && hardCapDelay <= HARD_TIMEOUT_MS + 200 && !modernFastPath,
		note: "legacy: the reveal can never happen before the 250 ms settle and stays inside the 2500 ms hard cap (continuous output may defer the settle to the cap); the modern 30 ms budget never applies. The per-output delay is evidence only (a real-time child chunk can share the settle's virtual tick).",
	};
}

/** Legacy timer contract: the 250 ms settle and the 2500 ms hard cap are the
 *  only readiness deadlines on the unframed path (no modern fast path). */
export function evaluateLegacyTimers(input: { settlePublishedAt: number; hardCapAt: number }): { settle: number; hardCap: number; modernBudget: number; settleUnchanged: boolean; hardCapUnchanged: boolean; ok: boolean; note: string } {
	return {
		settle: input.settlePublishedAt,
		hardCap: input.hardCapAt,
		modernBudget: MODERN_PUBLISH_BUDGET_MS,
		settleUnchanged: SETTLE_MS === 250,
		hardCapUnchanged: HARD_TIMEOUT_MS === 2500,
		ok: SETTLE_MS === 250 && HARD_TIMEOUT_MS === 2500 && MODERN_PUBLISH_BUDGET_MS < SETTLE_MS,
		note: "legacy constants unchanged: settle 250 ms, hard cap 2500 ms, modern budget 30 ms never applied to the legacy path",
	};
}

/** Poison/old-content scan for one projected literal family: any row that
 *  belongs to ANOTHER frame identity (old G1/E-something) is old content. */
export function oldIdentityCommits(commits: readonly OuterCommit[], allowedIds: readonly string[]): OuterCommit[] {
	return commits.filter((commit) => {
		const rows = commit.rows.filter((row) => row.trim() !== "");
		if (rows.length === 0) return false;
		const ids = new Set(rows.map((row) => row.split(" ")[0]).filter((token) => /^[A-Z]+\d*$/.test(token)));
		return [...ids].some((id) => !allowedIds.includes(id));
	});
}

// ---------------------------------------------------------------------------
// Real trial scaffold (real pipeline, virtual attach timers)
// ---------------------------------------------------------------------------

interface TrialOptions {
	artifactDir: string;
	caseId: string;
	script: "plain" | "same-write" | "split" | "cold" | "resize";
	childPath?: string;
	childEnv?: (eventsPath: string) => Record<string, string>;
	hostCols?: number;
	hostRows?: number;
	/** Plant S16_POISON_TEXT into the retained screen.log BEFORE the mount. */
	poison?: boolean;
	/** C fixture only: opt-in reporter/marker probe before the mount. */
	frameWitness?: boolean;
	/** A4 modern: geometry-aware wrapper around the accepted resize child. */
	geometryFrames?: boolean;
	forceLegacy?: boolean;
}

interface Trial {
	root: string;
	viewId: string;
	socketPath: string;
	configPath: string;
	eventsPath: string;
	runner: ChildProcess;
	clock: FakeClock;
	observer: AttachPresentationObserver;
	tui: TuiAltScreen;
	component: unknown;
	detachParser?: () => void;
	hooks: { colorProbe: number; bridgeRegistrations: number; bridgeUnsubscribes: number };
	/** Mutable public-hook fire timestamps (shared with the wrapper closures). */
	hookTiming: { firstProbeAt: number | null; firstBridgeAt: number | null };
	requestRenders: Array<{ at: number; force: boolean; observationCount: number }>;
	parserLog: Array<{ kind: string; at: number; bytes: number; observationCount: number }>;
	rx: Array<{ at: number; type: string; msg: Record<string, unknown> }>;
	tx: Array<{ at: number; type: string; msg: Record<string, unknown> }>;
	done: unknown[];
	controlSocket?: import("node:net").Socket;
	/** C fixture only: raw opt-in subscriber created before the mount. */
	frameTokenPath: string | null;
	frameReporterSocket?: import("node:net").Socket;
	frameReporterEnable?: Record<string, unknown>;
	proofSocket?: import("node:net").Socket;
	proofMessages: Array<{ at: number; type: string; msg: Record<string, unknown> }>;
	runnerStderr: string;
	runnerStdout: string;
}

async function waitReal(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const start = realNow();
	while (realNow() - start < timeoutMs) {
		if (predicate()) return;
		await realSleep(15);
	}
	throw new Error(`timed out (real ${timeoutMs}ms) waiting for: ${label}`);
}

/** Wait on REAL evidence while advancing the virtual clock in small steps (the
 *  attach's render/settle timers are virtual, so a pure real wait would never
 *  paint or settle). */
async function pumpUntilReal(trial: Trial, predicate: () => boolean, timeoutMs: number, label: string, stepMs = 50): Promise<number> {
	const start = realNow();
	let ticks = 0;
	while (realNow() - start < timeoutMs) {
		if (predicate()) return ticks;
		trial.clock.tick(stepMs);
		ticks += 1;
		await flushVirtual(trial.clock);
		await realSleep(10);
	}
	if (predicate()) return ticks;
	throw new Error(`timed out (real ${timeoutMs}ms, ${ticks} virtual ticks) waiting for: ${label}`);
}

async function flushVirtual(clock: FakeClock, turns = 6): Promise<number> {
	let fired = 0;
	for (let i = 0; i < turns; i += 1) {
		await flushRealTurn();
		await Promise.resolve();
		fired += clock.fireDueNow();
	}
	return fired;
}

function projectedRows(observation: PresentationObservation, dims: AttachSurfaceDims): string[] {
	return observation.grid.slice(dims.bodyTop, dims.footerRow).map((row) => row.text.replace(/\s+$/u, ""));
}

function commitsOf(trial: Trial, dims: AttachSurfaceDims): OuterCommit[] {
	return trial.observer.observations.map((observation, index) => ({
		index,
		at: observation.boundaryParsedAt,
		kind: observation.kind,
		note: observation.note,
		rows: projectedRows(observation, dims),
		cursor: { x: observation.cursor.x, y: observation.cursor.y, visible: observation.cursor.visible },
	}));
}

function readEvents(eventsPath: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

let trialRef: Trial | null = null;

async function connectFrameReporter(socketPath: string, tokenPath: string): Promise<{ socket: import("node:net").Socket; enable: Record<string, unknown> }> {
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
		realSetTimeout(() => rejectConnect(new Error("21B frame reporter connect timeout")), 4000).unref?.();
	});
	socket.write(`${JSON.stringify({ type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 1 } })}\n`);
	const start = realNow();
	while (realNow() - start < 12_000) {
		const enable = messages.find((message) => message.type === "frame_witness_enable");
		if (enable && typeof enable.token === "string") {
			writeFileSync(tokenPath, enable.token);
			return { socket, enable };
		}
		await realSleep(15);
	}
	socket.destroy();
	throw new Error("21B frame reporter enable timeout");
}

async function openTrial(options: TrialOptions): Promise<{ trial: Trial; dims: AttachSurfaceDims; hostCols: number; hostRows: number; poison: null | { path: string; plantReadbackContained: boolean } }> {
	const dims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	const hostCols = options.hostCols ?? WORK_AREA.cols;
	const hostRows = options.hostRows ?? WORK_AREA.rows;
	const root = mkdtempSync(join(tmpdir(), "s21b-"));
	const viewId = `s21b-${options.caseId}`;
	const socketPath = join(root, "endpoint.sock");
	const configPath = join(root, "host-config.json");
	const eventsPath = join(root, "child-events.jsonl");
	const frameTokenPath = options.frameWitness === true ? join(root, "c-frame-token.txt") : null;
	const meta = createView(root, { id: viewId, name: `s21b ${options.caseId}`, cwd: root });
	claimHost(root, { viewId, instanceId: viewId, configPath, socketPath, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: hostCols, rows: hostRows });
	atomicWriteJson(configPath, {
		root,
		viewId,
		instanceId: viewId,
		socketPath,
		sessionFile: meta.sessionFile,
		cwd: process.cwd(),
		initialPrompt: null,
		piCommand: process.execPath,
		piArgsPrefix: [options.geometryFrames === true ? FRAME_WRAPPER : options.childPath ?? CONTROLLED_CHILD],
		model: null,
		tools: null,
		env: {
			...(options.childEnv
				? options.childEnv(eventsPath)
				: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "controlled-frames", FAKE_PTY_CONTROLLED_SCRIPT: options.script, FAKE_PTY_EVENTS_PATH: eventsPath }),
			...(frameTokenPath === null ? {} : { FAKE_PTY_C_FRAME_TOKEN: frameTokenPath, FAKE_PTY_FRAME_TOKEN: frameTokenPath }),
			...(options.geometryFrames === true ? {
				FAKE_PTY_FRAME_CHILD_PATH: CONTROLLED_CHILD,
				FAKE_PTY_FRAME_TOKEN: frameTokenPath,
				FAKE_PTY_FRAME_GEOMETRY: "1",
			} : {}),
		},
		cols: hostCols,
		rows: hostRows,
	});
	const runner = spawn(process.execPath, [resolve(REPO_ROOT, "runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
	let runnerStderr = "";
	let runnerStdout = "";
	runner.stdout?.setEncoding("utf8");
	runner.stdout?.on("data", (chunk: string) => { runnerStdout += chunk; });
	runner.stderr?.setEncoding("utf8");
	runner.stderr?.on("data", (chunk: string) => { runnerStderr += chunk; });
	await waitReal(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.childPid;
	}, 12_000, `${options.caseId} host alive`);
	// C fixture only: the real reporter handshake must precede the mount so the
	// component's first status already advertises frame-witness capability.
	let frameReporterSocket: import("node:net").Socket | undefined;
	let frameReporterEnable: Record<string, unknown> | undefined;
	if (options.frameWitness === true && frameTokenPath !== null) {
		const connected = await connectFrameReporter(socketPath, frameTokenPath);
		frameReporterSocket = connected.socket;
		frameReporterEnable = connected.enable;
	}
	// C fixture only: an opt-in raw subscriber BEFORE the mount captures the
	// empty baseline/UNKNOWN view-proof coverage and the live S/F records.
	const proofMessages: Trial["proofMessages"] = [];
	let proofSocket: import("node:net").Socket | undefined;
	if (options.frameWitness === true) {
		const { createConnection } = await import("node:net");
		proofSocket = createConnection(socketPath);
		await new Promise<void>((resolveConnect, rejectConnect) => {
			proofSocket?.once("connect", () => resolveConnect());
			proofSocket?.once("error", rejectConnect);
			realSetTimeout(() => rejectConnect(new Error("frame-proof probe connect timeout")), 4000).unref?.();
		});
		proofSocket.on("error", () => { /* recorded through evidence */ });
		proofSocket.on("data", (chunk: Buffer | string) => {
			for (const line of chunk.toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					proofMessages.push({ at: 0, type: "rx", msg: JSON.parse(line) as Record<string, unknown> });
				} catch {
					/* non-protocol bytes */
				}
			}
		});
		proofSocket.write(`${JSON.stringify({ type: "subscribe_terminal", viewProof: 1 })}\n`);
		await flushRealTurn();
	}
	// POISON PLANT (C only): into the view's ACTUAL retained screen.log, BEFORE the
	// mount, using the accepted A5 plant technique (append + read back).
	let poison: null | { path: string; plantReadbackContained: boolean } = null;
	if (options.poison === true) {
		const poisonPath = P.screenLogPath(root, viewId);
		appendFileSync(poisonPath, S16_POISON_TEXT);
		const readback = (() => {
			try {
				return readFileSync(poisonPath, "utf8");
			} catch {
				return "";
			}
		})();
		poison = { path: poisonPath, plantReadbackContained: readback.includes("OLD-LOG-POISON") };
	}
	const clock = createFakeClock(0);
	const hooks = { colorProbe: 0, bridgeRegistrations: 0, bridgeUnsubscribes: 0 };
	const hookTiming: { firstProbeAt: number | null; firstBridgeAt: number | null } = { firstProbeAt: null, firstBridgeAt: null };
	const requestRenders: Trial["requestRenders"] = [];
	const parserLog: Trial["parserLog"] = [];
	const rx: Trial["rx"] = [];
	const tx: Trial["tx"] = [];
	const done: unknown[] = [];
	const observer = new AttachPresentationObserver({ cols: dims.cols, rows: dims.screenRows, now: () => clock.now() });
	const { Socket } = await import("node:net");
	const originalWrite = Socket.prototype.write;
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
		const socket = this as unknown as { on: (event: string, cb: (chunk: Buffer | string) => void) => void; _s21bRx?: boolean };
		if (socket._s21bRx !== true && typeof socket.on === "function") {
			socket._s21bRx = true;
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
	// Attach timers are virtual from here on.
	clock.install();
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
		if (hookTiming.firstProbeAt === null) hookTiming.firstProbeAt = clock.now();
		return realProbe(probe);
	};
	const realBridge = seams.onTerminalColorSchemeChange.bind(tui);
	seams.onTerminalColorSchemeChange = (listener) => {
		hooks.bridgeRegistrations += 1;
		if (hookTiming.firstBridgeAt === null) hookTiming.firstBridgeAt = clock.now();
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
		{ socketPath, title: "s21b", onDiagnostic: () => {} } as never,
	);
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
	tui.setLayoutRoot(component as never);
	tui.start();
	await flushVirtual(clock);
	const trial: Trial = { root, viewId, socketPath, configPath, eventsPath, runner, clock, observer, tui, component, detachParser, hooks, hookTiming, requestRenders, parserLog, rx, tx, done, frameTokenPath, frameReporterSocket, proofSocket, proofMessages, runnerStderr, runnerStdout };
	trialRef = trial;
	return { trial, dims, hostCols, hostRows, poison };
}

async function controlSend(trial: Trial, command: Record<string, unknown>): Promise<void> {
	const baselineTopology = formalMeasurementVersion() === "baseline";
	if (baselineTopology) {
		const raw = typeof (command as { __raw?: unknown }).__raw === "string" ? (command as { __raw: string }).__raw : `\u001e${JSON.stringify(command)}\n`;
		(trial.component as unknown as { handleInput: (data: string) => void }).handleInput(raw);
		await flushRealTurn();
		await realSleep(5);
		return;
	}
	if (trial.controlSocket === undefined) {
		const { createConnection } = await import("node:net");
		const socket = createConnection(trial.socketPath);
		await new Promise<void>((resolveConnect, rejectConnect) => {
			socket.once("connect", () => resolveConnect());
			socket.once("error", rejectConnect);
			realSetTimeout(() => rejectConnect(new Error("control client connect timeout")), 4000).unref?.();
		});
		socket.on("error", () => {
			/* recorded by the child log */
		});
		socket.write(`${JSON.stringify({ type: "hello", clientId: `s21b-ctl-${process.pid}`, wantOutput: false })}\n`);
		trial.controlSocket = socket;
		await flushRealTurn();
	}
	const raw = typeof (command as { __raw?: unknown }).__raw === "string" ? (command as { __raw: string }).__raw : null;
	const payload = raw === null ? `\u001e${JSON.stringify(command)}\n` : raw;
	trial.controlSocket.write(`${JSON.stringify({ type: "input", data: payload })}\n`);
	await flushRealTurn();
	await realSleep(5);
}

async function controlSendRaw(trial: Trial, text: string): Promise<void> {
	await controlSend(trial, { __raw: text });
}

async function closeTrial(trial: Trial, cleanup: DiagCleanup, label: string): Promise<void> {
	try {
		trial.controlSocket?.destroy();
		trial.proofSocket?.destroy();
		trial.frameReporterSocket?.destroy();
	} catch {
		/* best-effort */
	}
	try {
		const { createConnection } = await import("node:net");
		const socket = createConnection(trial.socketPath);
		await new Promise<void>((resolveConnect, rejectConnect) => {
			socket.once("connect", () => resolveConnect());
			socket.once("error", rejectConnect);
			realSetTimeout(() => rejectConnect(new Error("exit-client connect timeout")), 4000).unref?.();
		});
		socket.write(`${JSON.stringify({ type: "hello", clientId: `s21b-exit-${process.pid}`, wantOutput: false })}\n`);
		socket.write(`${JSON.stringify({ type: "input", data: "\u001e{\"cmd\":\"exit\"}\n" })}\n`);
		await waitReal(() => readHost(trial.root, trial.viewId)?.state === "exited", 6000, `${label} host exited`);
		cleanup.childExited = true;
		if (trial.runner.exitCode === null && trial.runner.signalCode === null) {
			await Promise.race([new Promise<void>((r) => trial.runner.once("exit", () => r())), realSleep(5000)]);
		}
		cleanup.runnerExited = trial.runner.exitCode !== null || trial.runner.signalCode !== null;
		cleanup.runnerExitCode = trial.runner.exitCode;
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
	await killOwnedDiagProcesses(trial.runner, trial.root, trial.viewId, cleanup);
	try {
		rmSync(trial.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
		cleanup.rootRemoved = true;
	} catch {
		/* recorded */
	}
	cleanup.ok = diagCleanupOk(cleanup);
	try {
		trial.observer.dispose();
	} catch {
		/* best-effort */
	}
}

interface CaseResult {
	caseId: string;
	measurementPath: string;
	ok: boolean;
	exitCode: number;
	error: string | null;
	evidence: Record<string, unknown>;
	artifactDir: string;
}

function makeWriter(artifactDir: string) {
	return (name: string, value: unknown) => {
		try {
			writeFileSync(join(artifactDir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
		} catch {
			/* retained best-effort */
		}
	};
}

async function runCase(options: TrialOptions, body: (ctx: { trial: Trial; dims: AttachSurfaceDims; hostCols: number; hostRows: number; poison: null | { path: string; plantReadbackContained: boolean } }) => Promise<Record<string, unknown>>): Promise<CaseResult> {
	if (existsSync(options.artifactDir)) throw new Error(`attempt artifact dir already exists: ${options.artifactDir}`);
	mkdirSync(options.artifactDir, { recursive: true });
	const writeArtifact = makeWriter(options.artifactDir);
	const cleanup = createDiagCleanup();
	let trial: Trial | null = null;
	let dims: AttachSurfaceDims = makeAttachDims(WORK_AREA.cols, WORK_AREA.rows);
	let error: string | null = null;
	let evidence: Record<string, unknown> = {};
	let childEvents: Array<Record<string, unknown>> = [];
	try {
		const opened = await openTrial(options);
		trial = opened.trial;
		dims = opened.dims;
		const bodyResult = await body({ trial, dims, hostCols: opened.hostCols, hostRows: opened.hostRows, poison: opened.poison });
		evidence = bodyResult;
	} catch (err) {
		error = err instanceof Error ? (err.stack ?? err.message) : String(err);
	} finally {
		if (trial !== null) {
			childEvents = readEvents(trial.eventsPath);
			const commits = commitsOf(trial, dims);
			await closeTrial(trial, cleanup, options.caseId);
			writeArtifact("commits.json", commits);
			writeArtifact("observations.json", trial.observer.observations);
			writeArtifact("writes.json", trial.observer.writes);
			writeArtifact("request-renders.json", trial.requestRenders);
			writeArtifact("parser-events.json", trial.parserLog);
			writeArtifact("rx.json", trial.rx);
			writeArtifact("tx.json", trial.tx);
			writeArtifact("child-events.jsonl", childEvents);
			writeArtifact("proof-wire.json", trial.proofMessages);
			writeArtifact("runner-stderr.txt", trial.runnerStderr);
			writeArtifact("runner-stdout.txt", trial.runnerStdout);
			writeArtifact("hooks.json", trial.hooks);
			writeArtifact("done.json", trial.done);
			writeArtifact("pending-timers.json", trial.clock.pending());
			evidence = { ...evidence, cleanup, commits };
		}
		writeArtifact("cleanup.json", cleanup);
		writeArtifact("summary.json", { caseId: options.caseId, script: options.script, error, ...evidence });
	}
	return { caseId: options.caseId, measurementPath: options.frameWitness === true ? "modern-reporter-viewproof" : "legacy-no-reporter", ok: error === null && evidence.ok === true, exitCode: error === null ? 0 : 1, error, evidence, artifactDir: options.artifactDir };
}

/** Pump small virtual steps until the complete target literal is committed
 *  (EVIDENCE ONLY / bounded transition wait), or the budget is exhausted. */
async function pumpForComplete(trial: Trial, dims: AttachSurfaceDims, literal: readonly string[], maxSteps: number, stepMs = 10): Promise<{ commit: OuterCommit | null; waitedMs: number }> {
	let waited = 0;
	for (let step = 0; step < maxSteps; step += 1) {
		const found = firstCompleteCommit(commitsOf(trial, dims), literal);
		if (found !== null) return { commit: found, waitedMs: waited };
		trial.clock.tick(stepMs);
		waited += stepMs;
		await flushVirtual(trial.clock);
	}
	return { commit: firstCompleteCommit(commitsOf(trial, dims), literal), waitedMs: waited };
}

function componentModernFacts(trial: Trial): Record<string, unknown> {
	const c = trial.component as unknown as {
		attachMode?: string;
		frameWitnessAvailable?: boolean;
		publishabilityState?: string;
		notReadyReason?: string | null;
		geometryRevision?: number;
		resizeIntentRequired?: boolean;
		resizeIntentSatisfied?: boolean;
		committedView?: { start: number; end: number; rows: Array<{ cells: { translateToString: (trim?: boolean) => string } }> } | null;
		latestViewProof?: unknown;
		receivedOutput?: boolean;
	};
	return {
		mode: c.attachMode ?? null,
		frameWitnessAvailable: c.frameWitnessAvailable ?? null,
		publishability: c.publishabilityState ?? null,
		notReadyReason: c.notReadyReason ?? null,
		geometryRevision: c.geometryRevision ?? null,
		resizeIntentRequired: c.resizeIntentRequired ?? null,
		resizeIntentSatisfied: c.resizeIntentSatisfied ?? null,
		committedView: c.committedView === null || c.committedView === undefined ? null : {
			start: c.committedView.start,
			end: c.committedView.end,
			rows: c.committedView.rows.length,
			firstRow: c.committedView.rows[0]?.cells.translateToString(true) ?? "",
			lastRow: c.committedView.rows.at(-1)?.cells.translateToString(true) ?? "",
		},
		latestViewProof: c.latestViewProof ?? null,
		receivedOutput: c.receivedOutput ?? null,
	};
}

// ---------------------------------------------------------------------------
// Case A4 — target-geometry readiness, delayed complete redraw
// ---------------------------------------------------------------------------

export async function runA4(artifactDir: string): Promise<CaseResult> {
	return runCase({
		artifactDir,
		caseId: "A4",
		script: "resize",
		hostCols: 100,
		hostRows: 28,
		frameWitness: modernMeasurementRequested(),
		geometryFrames: true,
		childPath: CONTROLLED_CHILD,
		childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "controlled-frames", FAKE_PTY_CONTROLLED_SCRIPT: "resize", FAKE_PTY_EVENTS_PATH: eventsPath }),
	}, async ({ trial, dims, hostCols, hostRows }) => {
		const targetCols = dims.cols;
		const targetRows = dims.rows;
		const targetLiteral = s16GeometryRowsText("G2", targetCols, targetRows);
		const logicalCursor = s16GeometryCursor("G2", targetRows);
		// 1. Non-empty OLD-size baseline + the one real target resize.
		await waitReal(() => trial.rx.some((line) => line.msg.type === "snapshot_begin"), 12_000, "A4 old-size baseline");
		await flushVirtual(trial.clock);
		await waitReal(() => trial.tx.some((line) => line.msg.type === "resize"), 8000, "A4 resize command");
		await waitReal(() => trial.rx.some((line) => line.msg.type === "cmd_ack" && line.msg.stage === "applied"), 8000, "A4 resize applied ack");
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.event === "pty-resize"), 8000, "A4 child live resize");
		// 2. Hold the target frame past the settle window; stale-geometry frames and
		// arbitrary sync closes must not publish or fire first hooks.
		trial.clock.tick(300);
		await flushVirtual(trial.clock);
		await controlSend(trial, { cmd: "step", step: 1 }); // G1 upper at STALE seed dims
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "open-stale"), 6000, "A4 stale upper half");
		await flushVirtual(trial.clock);
		await controlSend(trial, { cmd: "step", step: 2 }); // G1 lower + CLOSE at STALE dims (arbitrary close)
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "closed-stale"), 6000, "A4 stale close");
		await flushVirtual(trial.clock);
		trial.clock.tick(SETTLE_MS);
		await flushVirtual(trial.clock);
		const preCommits = commitsOf(trial, dims);
		const preGate = evaluatePreBoundary(preCommits, targetLiteral, { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations });
		// 3. The CURRENT target-geometry complete redraw.
		await controlSend(trial, { cmd: "step", step: 3 }); // G2 complete at LIVE target dims
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "closed-live"), 8000, "A4 target complete frame");
		await flushVirtual(trial.clock);
		const completeFrameAt = trial.clock.now();
		trial.clock.tick(MODERN_PUBLISH_BUDGET_MS);
		await flushVirtual(trial.clock);
		const commits = commitsOf(trial, dims);
		const publish = firstCompleteCommit(commits, targetLiteral);
		const cursor = evaluatePublishCursor(publish, logicalCursor, dims);
		const ordering = evaluatePublishOrdering({ publish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		const hooksAfter = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const resizeCommands = trial.tx.filter((line) => line.msg.type === "resize").map((line) => ({ cols: Number(line.msg.cols), rows: Number(line.msg.rows), at: line.at }));
		const appliedAcks = trial.rx.filter((line) => line.msg.type === "cmd_ack" && line.msg.stage === "applied").map((line) => ({ at: line.at, value: typeof line.msg.value === "string" ? line.msg.value : null }));
		const childLiveDims = readEvents(trial.eventsPath)
			.filter((event) => event.event === "pty-resize")
			.map((event) => ({ cols: typeof event.cols === "number" ? event.cols : null, rows: typeof event.rows === "number" ? event.rows : null, at: Number(event.wallMs ?? 0) }));
		const geometry = evaluateGeometryGate({ resizeCommands, appliedAcks, childLiveDims, expectedTarget: { cols: targetCols, rows: targetRows }, targetFrameAt: completeFrameAt });
		const publishedInBudget = publish !== null && publish.at - completeFrameAt <= MODERN_PUBLISH_BUDGET_MS;
		return {
			ok: preGate.ok && publishedInBudget && cursor.matched && ordering.ok && hooksAfter.colorProbe === 1 && hooksAfter.schemeBridge === 1 && geometry.ok,
			oldDims: { cols: hostCols, rows: hostRows },
			targetDims: { cols: targetCols, rows: targetRows },
			preGate,
			geometry,
			completeFrameAt,
			publishAt: publish?.at ?? null,
			publishedInBudget,
			publishedInBudgetConditional: !preGate.ok,
			publishedInBudgetNote:
				preGate.ok === false
					? "CONDITIONAL: the publish is inside the budget only because stale-geometry content already settled the attach; the case-level RED is the pre-boundary publish"
					: "independent: the attach had not published anything before the target frame",
			cursor,
			ordering,
			hooksAfter,
			componentModernFacts: componentModernFacts(trial),
			parserDrains: trial.parserLog.filter((entry) => entry.kind === "drain").length,
			note: "A4 modern reporter acceptance: one real target resize/intent, stale-geometry/arbitrary-close frames masked, complete target redraw publishes with hooks1 in the modern budget",
		};
	});
}

// ---------------------------------------------------------------------------
// Case A5 — empty baseline / cold startup, delayed complete editor
// ---------------------------------------------------------------------------

function modernMeasurementRequested(): boolean {
	return formalMeasurementVersion() !== "baseline";
}

async function coldStartupCase(options: TrialOptions, poisonExpected: boolean): Promise<CaseResult> {
	return runCase(options, async ({ trial, dims, poison }) => {
		const targetLiteral = s16EditorRowsText("E1");
		const logicalCursor = PRODUCER_CURSOR;
		// 1. EMPTY authoritative baseline already established BEFORE the mount.
		await waitReal(() => trial.rx.some((line) => line.msg.type === "snapshot_begin"), 12_000, `${options.caseId} empty baseline`);
		await flushVirtual(trial.clock);
		const baseline = trial.rx.filter((line) => line.msg.type === "snapshot_begin").pop() ?? null;
		const emptyBaseline = baseline !== null && baseline.msg.empty === true;
		// C fixture only: real reporter hello/token + the opt-in raw viewProof probe
		// created before the mount. The marker path is active only after this token
		// exists; A5 has no reporter and never sees marker bytes.
		let frameProbe: Record<string, unknown> | null = null;
		if (options.frameWitness === true && trial.frameReporterSocket !== undefined) {
			await waitReal(() => trial.proofMessages.some((line) => line.msg.type === "snapshot_end"), 12_000, "C empty viewProof baseline");
			const begin = trial.proofMessages.find((line) => line.msg.type === "snapshot_begin");
			const end = trial.proofMessages.find((line) => line.msg.type === "snapshot_end");
			const enable = trial.frameReporterEnable ?? {};
			frameProbe = {
				instanceId: enable.instanceId,
				generation: enable.generation,
				sessionEpoch: enable.sessionEpoch,
				tokenPresent: typeof enable.token === "string" && enable.token.length > 0,
				empty: begin?.msg.empty === true,
				snapshotBeginViewProof: begin?.msg.viewProof ?? null,
				snapshotEndViewProof: end?.msg.viewProof ?? null,
				snapshotEndRecordCount: Array.isArray(end?.msg.viewProofRecords) ? end.msg.viewProofRecords.length : null,
			};
		}
		if (options.frameWitness === true && trial.frameReporterSocket === undefined) {
			const { createConnection } = await import("node:net");
			const reporter = createConnection(trial.socketPath);
			await new Promise<void>((resolveConnect, rejectConnect) => {
				reporter.once("connect", () => resolveConnect());
				reporter.once("error", rejectConnect);
				realSetTimeout(() => rejectConnect(new Error("C reporter connect timeout")), 4000).unref?.();
			});
			reporter.on("error", () => { /* recorded by the runner */ });
			reporter.write(`${JSON.stringify({ type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 1 } })}\n`);
			await waitReal(() => trial.rx.some((line) => line.msg.type === "frame_witness_enable"), 12_000, "C reporter enable");
			const enable = trial.rx.filter((line) => line.msg.type === "frame_witness_enable").pop();
			if (enable === undefined || typeof enable.msg.token !== "string" || trial.frameTokenPath === null) throw new Error("C reporter enable/token missing");
			writeFileSync(trial.frameTokenPath, enable.msg.token);
			await waitReal(() => trial.proofMessages.some((line) => line.msg.type === "snapshot_end"), 12_000, "C empty viewProof baseline");
			const begin = trial.proofMessages.find((line) => line.msg.type === "snapshot_begin");
			const end = trial.proofMessages.find((line) => line.msg.type === "snapshot_end");
			frameProbe = {
				instanceId: enable.msg.instanceId,
				generation: enable.msg.generation,
				sessionEpoch: enable.msg.sessionEpoch,
				tokenPresent: typeof enable.msg.token === "string" && enable.msg.token.length > 0,
				empty: begin?.msg.empty === true,
				snapshotBeginViewProof: begin?.msg.viewProof ?? null,
				snapshotEndViewProof: end?.msg.viewProof ?? null,
				snapshotEndRecordCount: Array.isArray(end?.msg.viewProofRecords) ? end.msg.viewProofRecords.length : null,
			};
			trial.frameReporterSocket = reporter;
		}
		// 2. Hold the startup stages past the settle window.
		trial.clock.tick(300);
		await flushVirtual(trial.clock);
		await controlSend(trial, { cmd: "step", step: 1 }); // boot text (unframed)
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "boot"), 6000, `${options.caseId} boot text`);
		await flushVirtual(trial.clock);
		await controlSend(trial, { cmd: "step", step: 2 }); // alt screen + bracketed paste (input mode)
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "input-mode"), 6000, `${options.caseId} input mode`);
		await flushVirtual(trial.clock);
		trial.clock.tick(SETTLE_MS); // the legacy 250 ms callback may fire here
		await flushVirtual(trial.clock);
		const bootCommits = commitsOf(trial, dims);
		const bootGate = evaluatePreBoundary(bootCommits, targetLiteral, { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations });
		await controlSend(trial, { cmd: "step", step: 3 }); // OPEN + upper half (partial editor)
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "open"), 6000, `${options.caseId} partial editor`);
		await flushVirtual(trial.clock);
		trial.clock.tick(SETTLE_MS);
		await flushVirtual(trial.clock);
		const partialCommits = commitsOf(trial, dims);
		const partialGate = evaluatePreBoundary(partialCommits, targetLiteral, { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations });
		const partialHalfFrames = halfFrameCommits(partialCommits, targetLiteral).length;
		const proofBeforeComplete = trial.proofMessages.filter((line) => line.msg.type === "view_proof").map((line) => line.msg.record as Record<string, unknown>);
		const completedBeforeComplete = proofBeforeComplete.filter((record) => record.marker === "F");
		// 3. The current child's COMPLETE editor frame.
		await controlSend(trial, { cmd: "step", step: 4 }); // lower half + CLOSE
		await waitReal(() => readEvents(trial.eventsPath).some((event) => event.phase === "closed"), 8000, `${options.caseId} complete editor`);
		await flushVirtual(trial.clock);
		const completeFrameAt = trial.clock.now();
		const pumped = await pumpForComplete(trial, dims, targetLiteral, 40, 10);
		const publish = pumped.commit;
		const cursor = evaluatePublishCursor(publish, logicalCursor, dims);
		const ordering = evaluatePublishOrdering({ publish, parserLog: trial.parserLog, requestRenders: trial.requestRenders });
		const hooksAfter = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
		const poisonGate = evaluatePoison({
			marker: "OLD-LOG-POISON",
			plantReadbackContained: poison === null ? true : poison.plantReadbackContained,
			commits: commitsOf(trial, dims),
			writes: trial.observer.writes,
		});
		const publishedInBudget = publish !== null && publish.at - completeFrameAt <= MODERN_PUBLISH_BUDGET_MS;
		const oldContentHits = oldIdentityCommits(commitsOf(trial, dims), ["E1"]);
		let frameWitness: Record<string, unknown> | null = null;
		if (options.frameWitness === true) {
			await waitReal(
				() => trial.proofMessages.some((line) => line.msg.type === "view_proof" && (line.msg.record as Record<string, unknown> | undefined)?.marker === "F"),
				12_000,
				"C complete-editor F proof",
			);
			const allProofMessages = trial.proofMessages.map((line) => line.msg);
			const records = trial.proofMessages
				.filter((line) => line.msg.type === "view_proof")
				.map((line) => line.msg.record as Record<string, unknown>);
			const fRecord = records.find((record) => record.marker === "F") ?? null;
			const sRecord = records.find((record) => record.marker === "S") ?? null;
			const outputSeqs = new Set(trial.proofMessages.filter((line) => line.msg.type === "output").map((line) => line.msg.seq));
			const { createConnection } = await import("node:net");
			const late = createConnection(trial.socketPath);
			await new Promise<void>((resolveConnect, rejectConnect) => {
				late.once("connect", () => resolveConnect());
				late.once("error", rejectConnect);
				realSetTimeout(() => rejectConnect(new Error("C late proof subscriber timeout")), 4000).unref?.();
			});
			const lateMessages: Array<Record<string, unknown>> = [];
			late.on("data", (chunk: Buffer | string) => {
				for (const line of chunk.toString("utf8").split("\n")) {
					if (!line.trim()) continue;
					try { lateMessages.push(JSON.parse(line) as Record<string, unknown>); } catch { /* non-protocol */ }
				}
			});
			late.write(`${JSON.stringify({ type: "subscribe_terminal", viewProof: 1, sinceSeq: 1_000_000 })}\n`);
			await waitReal(() => lateMessages.some((message) => message.type === "snapshot_end"), 12_000, "C late covered snapshot");
			const lateEnd = lateMessages.filter((message) => message.type === "snapshot_end").pop();
			const lateBegin = lateMessages.find((message) => message.type === "snapshot_begin");
			const comp = trial.component as unknown as {
				protocolBaselineState?: string;
				latestViewProof?: unknown;
				viewProofRecords?: unknown[];
				viewProofRecordCount?: number;
				firstAttachSideEffectsApplied?: boolean;
				publishabilityState?: string;
				parserEpoch?: number;
				attachClient?: { requestResync: (reason?: string) => boolean };
				committedView?: { start: number; end: number; rows: unknown[]; cursor: unknown } | null;
			};
			// Fresh baseline through the REAL client resync path: the component
			// receives snapshotReady coverage/records without any publish hook.
			comp.attachClient?.requestResync("c-fixture");
			await waitReal(() => (comp.latestViewProof as { status?: string } | null)?.status === "covered", 12_000, "C component covered baseline");
			frameWitness = {
				...frameProbe,
				completeFrameAt,
				publishAt: publish?.at ?? null,
				publishedInBudget,
				proofBeforeComplete,
				completedBeforeComplete: completedBeforeComplete.length,
				records,
				sRecords: records.filter((record) => record.marker === "S").length,
				fRecords: records.filter((record) => record.marker === "F").length,
				sRecord,
				fRecord,
				fSeqIsPrecedingOutput: fRecord === null ? null : outputSeqs.has(Number(fRecord.seq)),
				fMetadata: fRecord?.metadata ?? null,
				fCursorVisible: fRecord?.cursorVisible ?? null,
				lateSnapshotBeginViewProof: lateBegin?.viewProof ?? null,
				lateSnapshotEndViewProof: lateEnd?.viewProof ?? null,
				lateSnapshotEndRecords: Array.isArray(lateEnd?.viewProofRecords) ? lateEnd.viewProofRecords : null,
				component: {
					protocolBaselineState: comp.protocolBaselineState ?? null,
					latestViewProof: comp.latestViewProof ?? null,
					viewProofRecords: comp.viewProofRecords ?? [],
					viewProofRecordCount: comp.viewProofRecordCount ?? null,
					firstAttachSideEffectsApplied: comp.firstAttachSideEffectsApplied ?? null,
					publishabilityState: comp.publishabilityState ?? null,
					parserEpoch: comp.parserEpoch ?? null,
					committedView: comp.committedView === null || comp.committedView === undefined ? null : {
						start: comp.committedView.start,
						end: comp.committedView.end,
						rows: comp.committedView.rows.length,
						cursor: comp.committedView.cursor,
					},
				},
			};
			late.destroy();
			const fOk = fRecord !== null && fRecord.marker === "F" && Number(fRecord.seq) >= 1 && fRecord.metadata !== null;
			const lateCoverage = lateEnd?.viewProof as { status?: string; proof?: { seq?: number } | null; throughSeq?: number | null } | undefined;
			frameWitness.ok =
				frameProbe !== null &&
				frameProbe.empty === true &&
				completedBeforeComplete.length === 0 &&
				records.filter((record) => record.marker === "S").length === 1 &&
				records.filter((record) => record.marker === "F").length === 1 &&
				fOk &&
				(frameWitness.fSeqIsPrecedingOutput === true) &&
				lateCoverage?.status === "covered" &&
				typeof lateCoverage.proof?.seq === "number" &&
				typeof lateCoverage.throughSeq === "number" &&
				lateCoverage.proof.seq <= lateCoverage.throughSeq;
			frameWitness.wireMessageCount = allProofMessages.length;
		}
		const observation = await holdFormalObservation(realNow, realSleep, options.caseId);
		const contractOk =
			emptyBaseline &&
			bootGate.ok &&
			partialGate.ok &&
			partialHalfFrames === 0 &&
			publishedInBudget &&
			cursor.matched &&
			ordering.ok &&
			hooksAfter.colorProbe === 1 &&
			hooksAfter.schemeBridge === 1 &&
			poisonGate.ok &&
			(poisonExpected ? poison !== null && poison.plantReadbackContained : true) &&
			oldContentHits.length === 0;
		return {
			ok: contractOk,
			contractOk,
			emptyBaseline,
			baselineSeq: baseline === null ? null : String(baseline.msg.snapshotSeq ?? "?"),
			bootGate,
			partialGate,
			partialHalfFrames,
			completeFrameAt,
			publishAt: publish?.at ?? null,
			publishWaitedMs: pumped.waitedMs,
			publishedInBudget,
			publishedInBudgetConditional: !(bootGate.ok && partialGate.ok),
			publishedInBudgetNote:
				bootGate.ok && partialGate.ok
					? "independent: no earlier content/hooks released the attach"
					: "CONDITIONAL: the publish is inside the budget only because earlier boot/partial content already settled the attach; the case-level RED is that early release",
			cursor,
			ordering,
			hooksAfter,
			poisonGate,
			frameWitness,
			oldContentHits: oldContentHits.length,
			startupNote: "startup cost is separate: no 200 ms target claim; boot/raw/mode/partial editor stages are not readiness",
			poisonPath: poison === null ? null : poison.path,
			observation: observation ?? null,
			themeCompletion: "not-applicable",
			recoveryCompletion: "not-applicable",
			note:
				options.caseId === "C"
					? "C: planted poison + empty baseline reset + boot-before-editor; poison never visible, first hooks only at the complete editor"
					: "A5: empty baseline, boot/raw/mode/partial editor are not readiness; only the complete current editor publishes (early BOOT/partial behavior is a named RED)",
		};
	});
}

export async function runA5(artifactDir: string): Promise<CaseResult> {
	// Modern A5 acceptance topology: the accepted C cold child plus real reporter
	// and opt-in viewProof, without C's poison plant. The no-reporter diagnostic
	// artifact remains preserved separately.
	return coldStartupCase({ artifactDir, caseId: "A5", script: "cold", frameWitness: modernMeasurementRequested(), childPath: C_FRAME_CHILD }, false);
}

/** Case C — same cold startup PLUS the explicit poisoned screen.log plant. */
export async function runC(artifactDir: string): Promise<CaseResult> {
	return coldStartupCase({ artifactDir, caseId: "C", script: "cold", poison: true, frameWitness: modernMeasurementRequested(), childPath: modernMeasurementRequested() ? C_FRAME_CHILD : MEASUREMENT_CONTROLLED_CHILD }, true);
}

// ---------------------------------------------------------------------------
// Legacy contracts (separate; compatible behavior expected to PASS)
// ---------------------------------------------------------------------------

export async function runLegacyUnframed(artifactDir: string): Promise<CaseResult> {
	const previous = process.env.AGENT_BOARD_TERMINAL_SNAPSHOT;
	process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = "0";
	try {
		return await runCase(
		{ artifactDir, caseId: "L-unframed", script: "cold", childPath: UNFRAMED_CHILD, childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_EVENTS_PATH: eventsPath }) },
		async ({ trial, dims }) => {
			// The unframed child has NO modern frame guarantee: the only readiness
			// deadline is the original 250 ms settle (2500 ms hard cap outer bound).
			await waitReal(() => readEvents(trial.eventsPath).some((event) => event.event === "stdout-write" && (event.phase === "ready" || event.phase === "input-mode")), 10_000, "legacy child ready phase");
			await pumpUntilReal(trial, () => trial.parserLog.some((entry) => entry.kind === "write"), 10_000, "legacy first parser write");
			const hooksBefore = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
			const reveal = await (async () => {
				const start = realNow();
				while (realNow() - start < 10_000) {
					const gate = evaluateLegacyReveal({ firstHookAt: trial.hookTiming.firstProbeAt ?? trial.hookTiming.firstBridgeAt, parserWrites: trial.parserLog.filter((entry) => entry.kind === "write") });
					if (gate.firstContentAt !== null) return gate;
					trial.clock.tick(10);
					await flushVirtual(trial.clock);
					await realSleep(5);
				}
				return evaluateLegacyReveal({ firstHookAt: trial.hookTiming.firstProbeAt ?? trial.hookTiming.firstBridgeAt, parserWrites: trial.parserLog.filter((entry) => entry.kind === "write") });
			})();
			const hooksAfter = { colorProbe: trial.hooks.colorProbe, schemeBridge: trial.hooks.bridgeRegistrations };
			const timers = evaluateLegacyTimers({ settlePublishedAt: SETTLE_MS, hardCapAt: HARD_TIMEOUT_MS });
			return {
				ok: reveal.ok && timers.ok && hooksAfter.colorProbe === 1 && hooksAfter.schemeBridge === 1,
				reveal,
				timers,
				hooksBefore,
				hooksAfter,
				note: "legacy unframed: no modern fast path — the first content reveal waits for the 250 ms settle; the 2500 ms hard cap remains the outer bound; this is NOT modern readiness",
			};
		},
		);
	} finally {
		if (previous === undefined) delete process.env.AGENT_BOARD_TERMINAL_SNAPSHOT;
		else process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = previous;
	}
}

export async function runLegacyForced(artifactDir: string): Promise<CaseResult> {
	const previous = process.env.AGENT_BOARD_TERMINAL_SNAPSHOT;
	const restoreEnv = previous === undefined ? () => delete process.env.AGENT_BOARD_TERMINAL_SNAPSHOT : () => {
		process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = previous;
	};
	process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = "0";
	let result: CaseResult | null = null;
	let envRestored = false;
	try {
		result = await runCase(
			{ artifactDir, caseId: "L-forced", script: "cold", childPath: UNFRAMED_CHILD, childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_EVENTS_PATH: eventsPath }) },
			async ({ trial, dims }) => {
				await waitReal(() => readEvents(trial.eventsPath).some((event) => event.event === "stdout-write" && (event.phase === "ready" || event.phase === "input-mode")), 10_000, "forced legacy child ready phase");
				await pumpUntilReal(trial, () => trial.parserLog.some((entry) => entry.kind === "write"), 10_000, "forced legacy first parser write");
				const subscribeMessages = trial.tx.filter((line) => line.msg.type === "subscribe_terminal");
				const snapshotMessages = trial.rx.filter((line) => line.msg.type === "snapshot_begin" || line.msg.type === "snapshot_end" || line.msg.type === "snapshot_frame");
				const reveal = await (async () => {
					const start = realNow();
					while (realNow() - start < 10_000) {
						const gate = evaluateLegacyReveal({ firstHookAt: trial.hookTiming.firstProbeAt ?? trial.hookTiming.firstBridgeAt, parserWrites: trial.parserLog.filter((entry) => entry.kind === "write") });
						if (gate.firstContentAt !== null) return gate;
						trial.clock.tick(10);
						await flushVirtual(trial.clock);
						await realSleep(5);
					}
					return evaluateLegacyReveal({ firstHookAt: trial.hookTiming.firstProbeAt ?? trial.hookTiming.firstBridgeAt, parserWrites: trial.parserLog.filter((entry) => entry.kind === "write") });
				})();
				// Public detach through the real input path (ctrl+\). The legacy
				// close restores a held PTY (G3), so the resize list is read AFTER it.
				(trial.component as unknown as { handleInput: (data: string) => void }).handleInput("\u001c");
				await waitReal(() => (trial.done as Array<{ action?: string }>).some((entry) => entry?.action === "detached"), 5000, "forced legacy public detach");
				await flushVirtual(trial.clock);
				const detachDone = (trial.done as Array<{ action?: string }>)[trial.done.length - 1] ?? null;
				const resizeCommands = trial.tx.filter((line) => line.msg.type === "resize").map((line) => ({ cols: Number(line.msg.cols), rows: Number(line.msg.rows), at: line.at }));
				const shrinkIndex = resizeCommands.findIndex((command) => command.cols === dims.cols - 1 && command.rows === dims.rows - 1);
				const restoreIndex = resizeCommands.findIndex((command, index) => index > shrinkIndex && command.cols === dims.cols && command.rows === dims.rows);
				const jiggleOrderOk = shrinkIndex >= 0 && restoreIndex > shrinkIndex;
				const timers = evaluateLegacyTimers({ settlePublishedAt: SETTLE_MS, hardCapAt: HARD_TIMEOUT_MS });
				return {
					ok:
						reveal.ok &&
						subscribeMessages.length === 0 &&
						snapshotMessages.length === 0 &&
						jiggleOrderOk &&
						timers.ok &&
						(detachDone as { action?: string } | null)?.action === "detached",
					reveal,
					timers,
					subscribeCount: subscribeMessages.length,
					snapshotMessageCount: snapshotMessages.length,
					resizeCommands,
					jiggleOrderOk,
					detachDone,
					note: "forced legacy (AGENT_BOARD_TERMINAL_SNAPSHOT=0 in-process): zero subscribe/snapshot, real shrink→restore jiggle (restore at detach/G3), settle-driven reveal, public detach, env restored",
				};
			},
		);
	} finally {
		restoreEnv();
		envRestored = process.env.AGENT_BOARD_TERMINAL_SNAPSHOT === previous;
	}
	return result === null ? { caseId: "L-forced", ok: false, exitCode: 1, error: "no result", evidence: {}, artifactDir } : { ...result, ok: result.ok && envRestored, evidence: { ...result.evidence, envRestored } };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CASES = new Set(["A4", "A5", "C", "L-unframed", "L-forced"]);

export async function runCase21B(options: { caseId: string; artifactDir: string }): Promise<Record<string, unknown>> {
	const invocationId = `inv-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
	const record = await (async (): Promise<CaseResult> => {
		if (options.caseId === "A4") return runA4(options.artifactDir);
		if (options.caseId === "A5") return runA5(options.artifactDir);
		if (options.caseId === "C") return runC(options.artifactDir);
		if (options.caseId === "L-unframed") return runLegacyUnframed(options.artifactDir);
		return runLegacyForced(options.artifactDir);
	})();
	const result = { ok: record.ok === true, exitCode: record.exitCode, caseId: options.caseId, invocationId, trials: [record], artifactRoot: options.artifactDir };
	writeFileSync(join(options.artifactDir, `result-${invocationId}.json`), JSON.stringify(result, null, 2));
	return result;
}

function cliError(message: string): never {
	process.stderr.write(`pty-attach-21b-scenario: ${message}\n`);
	process.exit(2);
}

export function parse21BCli(argv: string[]): { caseId: string; artifactDir: string } {
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
	const cli = parse21BCli(process.argv.slice(2));
	runCase21B({ caseId: cli.caseId, artifactDir: cli.artifactDir })
		.then((result) => {
			process.stdout.write(JSON.stringify(result) + "\n");
			process.exit(typeof result.exitCode === "number" ? result.exitCode : 0);
		})
		.catch((err) => {
			process.stderr.write(`pty-attach-21b-scenario: harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exit(1);
		});
}
