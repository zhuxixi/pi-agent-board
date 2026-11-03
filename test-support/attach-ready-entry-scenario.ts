// Issue #222 step 18 (task-18-brief.md): REAL attach-entry timing smoke
// topology, case ENTRY. This is a NEW, separate scenario from the accepted
// S/A4/A5/T/GEN battery in test-support/pty-attach-ready-scenario.ts: that
// scenario mounts the REAL PtyAttachComponent directly on a REAL TuiAltScreen
// via setLayoutRoot, while ENTRY drives the REAL production command path —
// `dashboardAttachLoop` (src/commands/agent-board.ts) with a REAL
// `createService` (real default `launchHostProcess`, real `resolveAttachTarget`)
// on an owned runner/socket/root. Only the terminal and the isolated
// session/fixture are replaced: the dashboard factory is the REAL
// DashboardComponent, the attach overlay is the REAL PtyAttachComponent mounted
// through the REAL TuiAltScreen `showOverlay` path, and the accepted
// AttachPresentationObserver is the replaceable Terminal for both stages.
//
// What is measured: total attach from the user's attach action (`select`,
// when the dashboard produces its normal `{action:"attach",viewId}` result)
// to the first INDEPENDENTLY observed outer frame whose work area equals the
// current-generation literal F0 grid (`terminalCommitted`). The real resolver
// is wrapped log-and-delegate ONLY (args/this/return/errors pass through);
// overlay construction is recorded separately around the real showOverlay
// (`overlayFactoryStart` / `overlayMounted`) and is never called the select
// start. Prewarm (root creation, host launch, baseline seed proof) happens
// BEFORE select and is excluded. The child is the accepted session-generation
// fixture (test-support/fake-pty-generation-pi.mjs) with literal F0 and an
// explicit grid/cursor; a same-size 80x22 attach must issue ZERO resize.
//
// If the real entry cannot be driven, total latency is UNMEASURED
// (`measured:false`, `totalEntryMs:null`) — never a fabricated pass.
//
// CLI: --case ENTRY --repeat 1 --clock real --artifact-dir <owned path>.
// Unsupported cases/clocks/repeats fail explicitly (stderr + exit 2, no dummy
// success). A valid invocation prints exactly one JSON result line on stdout.
// Run via `node --experimental-transform-types`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import xtermHeadless from "@xterm/headless";
import { TuiAltScreen } from "@earendil-works/pi-tui/dist/tui-alt-screen.js";
import { AttachPresentationObserver, asTerminal } from "./attach-presentation-fixture.ts";
import { WORK_AREA, projectObservationToWorkArea, s17GenerationCursor, s17GenerationRowsText } from "./pty-attach-ready-scenario.ts";
import { createView, readHost } from "../src/core/store.mjs";

// PtyAttachComponent / DashboardComponent / dashboardAttachLoop use TS
// parameter properties; import them LAZILY inside the trial driver so this
// module stays importable under plain `node --test` for the pure-helper tests.
async function loadRuntime() {
	const { dashboardAttachLoop } = await import("../src/commands/agent-board.ts");
	const { createService } = await import("../src/runtime/service.mjs");
	return { dashboardAttachLoop, createService };
}

const { Terminal: HeadlessTerminal } = /** @type {any} */ (xtermHeadless);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

/** Current session generation and its literal baseline. Independently declared
 *  here against the accepted scenario's exported generation-contract literals
 *  (which themselves mirror the fixture, never the captured bytes). */
export const ENTRY_GENERATION = "gen-1";
export const ENTRY_F0_ID = "F0";
export const ENTRY_F0_ROWS: string[] = s17GenerationRowsText(ENTRY_GENERATION, ENTRY_F0_ID);
export const ENTRY_F0_CURSOR: { x: number; y: number; visible: boolean } = s17GenerationCursor(ENTRY_GENERATION, ENTRY_F0_ID);

/** The detach chord the component recognizes (pty-attach.ts handleKeyInput:
 *  matchesKey(data, "ctrl+\\") — the C0 FS byte 0x1C). */
export const DETACH_INPUT = "\x1c";

/** The dashboard's list-mode attach key (dashboard.ts handleInput: `>`). */
const ATTACH_KEY = ">";
/** The dashboard's list-mode exit key (Key.escape). */
const EXIT_KEY = "\x1b";

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

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const start = now();
	while (now() - start < timeoutMs) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for: ${label}`);
}

/** Right-trim the observed work-area rows so they compare against the literal
 *  contract rows (the runner's synthesized hydrate frame pads to full width). */
export function rtrimRows(rows: string[]): string[] {
	return rows.map((row) => row.replace(/\s+$/u, ""));
}

/** Projected work-area rows of one observer state (drops header/footer). */
export function projectedBodyRows(observation: unknown): string[] {
	const projected = projectObservationToWorkArea(observation as never);
	return rtrimRows(projected.grid.map((row) => row.text));
}

export function rowsEqual(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((text, i) => text === expected[i]);
}

/** All inverse-video cells of one observer grid (width-0 continuation cells are
 *  skipped so a wide glyph is never double-counted). Recorded as DATA — the
 *  known hydrate DECTCEM defect is never an oracle verdict here. */
export function inverseCellsOf(observation: unknown): Array<{ x: number; y: number }> {
	const grid = (observation as { grid: Array<{ cells: Array<{ inverse: boolean; width: number }> }> }).grid;
	const points: Array<{ x: number; y: number }> = [];
	for (let y = 0; y < grid.length; y++) {
		const cells = grid[y].cells;
		for (let x = 0; x < cells.length; x++) {
			if (cells[x].inverse && cells[x].width !== 0) points.push({ x, y });
		}
	}
	return points;
}

// ---- the one real-entry trial seam -----------------------------------------

interface Timeline {
	select: number | null;
	resolverStart: number | null;
	resolverEnd: number | null;
	overlayFactoryStart: number | null;
	overlayMounted: number | null;
	connected: number | null;
	/** Protocol `snapshot_begin` receipt (collection start) — NOT a parse fact. */
	snapshotBeginReceived: number | null;
	/** Protocol `snapshotReady` receipt — the client has ALREADY validated
	 *  continuity before emitting it; this is a receipt, not a local parse. */
	snapshotValidated: number | null;
	/** The local xterm parser write-callback for the EXACT snapshot frame data
	 *  (the `term.write` drain that hydrates the frame). null = unobserved. */
	snapshotParsed: number | null;
	renderRequest: number | null;
	terminalCommitted: number | null;
}

interface EntryState extends Timeline {
	customCount: number;
	attachDone: boolean;
	attachResult: unknown;
	attachComponent: unknown;
	attachObserver: AttachPresentationObserver | null;
	attachTui: TuiAltScreen | null;
	rxLog: Array<{ at: number; data: string }>;
	txLog: Array<{ at: number; data: string }>;
	resolverCalls: number;
	resolverSocketPath: string | null;
	resolverInstanceId: string | null;
	resolverKind: string | null;
	attachDetachers: Array<() => void>;
	/** The exact `snapshotReady` frame bytes to match against the next local
	 *  `term.write` (internal; never emitted as a timeline field). */
	pendingSnapshotFrame: string | null;
}

function createEntryState(): EntryState {
	return {
		select: null,
		resolverStart: null,
		resolverEnd: null,
		overlayFactoryStart: null,
		overlayMounted: null,
		connected: null,
		snapshotBeginReceived: null,
		snapshotValidated: null,
		snapshotParsed: null,
		renderRequest: null,
		terminalCommitted: null,
		customCount: 0,
		attachDone: false,
		attachResult: null,
		attachComponent: null,
		attachObserver: null,
		attachTui: null,
		rxLog: [],
		txLog: [],
		resolverCalls: 0,
		resolverSocketPath: null,
		resolverInstanceId: null,
		resolverKind: null,
		attachDetachers: [],
		pendingSnapshotFrame: null,
	};
}

/** Log-and-delegate wrapper around tui.requestRender so the first render
 *  request after mount is recorded on the same parent clock. The original
 *  method is delegated unchanged (never replaced with rendering). */
function wrapRequestRender(tui: TuiAltScreen, entry: EntryState): void {
	const anyTui = tui as unknown as { requestRender: (force?: boolean) => void };
	const original = anyTui.requestRender.bind(tui);
	anyTui.requestRender = (force?: boolean) => {
		if (entry.renderRequest === null) entry.renderRequest = now();
		return original(force);
	};
}

/** Additional (non-interfering) rx listener on the component's live socket. */
function attachSocketRxLogger(component: unknown, rxLog: EntryState["rxLog"]): () => void {
	let current: Socket | null = null;
	const onData = (chunk: Buffer | string) => {
		rxLog.push({ at: now(), data: chunk.toString("utf8") });
	};
	const install = () => {
		const socket = (component as { socket?: Socket | null }).socket ?? null;
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

/** Log-and-delegate wrapper around the live socket's public write(): every
 *  outgoing protocol byte string is logged; original args/this/return pass
 *  through unchanged. A poller re-wraps on reconnect. */
function attachSocketTxLogger(component: unknown, txLog: EntryState["txLog"]): () => void {
	let current: Socket | null = null;
	let original: Socket["write"] | null = null;
	const install = () => {
		const socket = (component as { socket?: Socket | null }).socket ?? null;
		if (socket && socket !== current) {
			if (current && original) (current as unknown as { write: unknown }).write = original;
			current = socket;
			original = socket.write;
			const wrapped = original;
			(socket as unknown as { write: unknown }).write = function (this: Socket, ...args: unknown[]) {
				txLog.push({ at: now(), data: String(args[0]) });
				return (wrapped as (...a: unknown[]) => unknown).apply(this, args);
			};
		}
	};
	install();
	const timer = setInterval(install, 5);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		if (current && original) (current as unknown as { write: unknown }).write = original;
		current = null;
		original = null;
	};
}

function parseTxMessages(txLog: EntryState["txLog"]): Array<{ at: number; type: string; msg: Record<string, unknown> }> {
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

/** Log-and-delegate wrapper around the component's REAL inner xterm parser
 *  `term.write`. It records the local parse-completion write-callback ONLY for
 *  the EXACT snapshot frame bytes (matched by full string identity against the
 *  `snapshotReady` frame), never for an arbitrary later callback or the
 *  constructor's pre-instrumentation screen.log replay (those predate this
 *  wrapper and are simply not observed). args/this/return/errors pass through;
 *  the original callback still runs after the timestamp is recorded. */
interface InnerTermInstrumentation {
	detach: () => void;
	reattach: () => void;
}

function instrumentInnerTermWrite(component: unknown, entry: EntryState): InnerTermInstrumentation {
	let current: { write: (data: string, callback?: () => void) => unknown } | null = null;
	let originalWrite: ((data: string, callback?: () => void) => unknown) | null = null;
	const attach = () => {
		const term = (component as { term: { write: (data: string, callback?: () => void) => unknown } }).term;
		if (!term || typeof term.write !== "function" || term === current) return;
		if (current && originalWrite) (current as unknown as { write: unknown }).write = originalWrite;
		current = term;
		originalWrite = term.write.bind(term);
		const wrapped = originalWrite;
		(term as unknown as { write: unknown }).write = function (this: unknown, data: string, callback?: () => void) {
			if (entry.pendingSnapshotFrame !== null && data === entry.pendingSnapshotFrame) {
				return wrapped(data, () => {
					if (entry.snapshotParsed === null) entry.snapshotParsed = now();
					callback?.();
				});
			}
			return wrapped(data, callback);
		};
	};
	attach();
	const timer = setInterval(attach, 5);
	timer.unref?.();
	return {
		reattach: attach,
		detach: () => {
			clearInterval(timer);
			if (current && originalWrite) (current as unknown as { write: unknown }).write = originalWrite;
			current = null;
			originalWrite = null;
		},
	};
}

/** Install the entry observations on the freshly constructed attach component:
 *  an additional connect listener (exact `connected` time), a log-and-delegate
 *  wrap of the component's REAL attach-client event handler (snapshot_begin /
 *  snapshotReady receipts), a log-and-delegate wrap of the REAL inner parser
 *  `term.write` (local snapshot-frame parse drain), and rx/tx socket loggers.
 *  Never substitutes a result. Residual gap (documented): the `connect` listener
 *  attaches only to the first observed socket; a reconnect or an already-open
 *  socket at install leaves `connected` null (honest, no error). */
function installAttachObservers(component: unknown, entry: EntryState): Array<() => void> {
	const detachers: Array<() => void> = [];
	const innerTerm = instrumentInnerTermWrite(component, entry);
	detachers.push(innerTerm.detach);
	const replaceTarget = component as { replaceParser?: () => boolean };
	if (typeof replaceTarget.replaceParser === "function") {
		const originalReplace = replaceTarget.replaceParser;
		replaceTarget.replaceParser = function (this: unknown) {
			const replaced = originalReplace.call(this);
			if (replaced) innerTerm.reattach();
			return replaced;
		};
		detachers.push(() => {
			replaceTarget.replaceParser = originalReplace;
		});
	}
	const socket = (component as { socket?: Socket | null }).socket ?? null;
	if (socket) {
		const onConnect = () => {
			if (entry.connected === null) entry.connected = now();
		};
		socket.once("connect", onConnect);
		detachers.push(() => socket.off("connect", onConnect));
	}
	const target = component as { handleAttachEvent?: (event: string, payload: unknown) => unknown };
	if (typeof target.handleAttachEvent === "function") {
		const original = target.handleAttachEvent;
		target.handleAttachEvent = function (this: unknown, event: string, payload: unknown) {
			if (event === "snapshotBegin" && entry.snapshotBeginReceived === null) {
				entry.snapshotBeginReceived = now();
			} else if (event === "snapshotReady") {
				// Receipt of the client-validated snapshotReady; the client has already
				// verified continuity before emitting it. This is NOT a local parse.
				if (entry.snapshotValidated === null) entry.snapshotValidated = now();
				entry.pendingSnapshotFrame = payload && typeof (payload as { frame?: unknown }).frame === "string" ? (payload as { frame: string }).frame : null;
			}
			const result = original.call(this, event, payload);
			if (event === "snapshotReady") innerTerm.reattach();
			return result;
		};
		detachers.push(() => {
			target.handleAttachEvent = original;
		});
	}
	
	detachers.push(attachSocketRxLogger(component, entry.rxLog));
	detachers.push(attachSocketTxLogger(component, entry.txLog));
	return detachers;
}

async function waitForFirstF0(observer: AttachPresentationObserver, literal: string[], timeoutMs: number): Promise<unknown | null> {
	const start = now();
	while (now() - start < timeoutMs) {
		const found = observer.observations.find((o) => o.kind === "frame" && rowsEqual(projectedBodyRows(o), literal));
		if (found) return found;
		await sleep(20);
	}
	return null;
}

/** The fake extension command context: every UI/terminal seam the production
 *  `dashboardAttachLoop` / `openDashboard` / `openPtyAttach` reach is replaced
 *  with a faithful real-overlay reproduction of `ctx.ui.custom`. */
function makeEntryCustom(entry: EntryState, theme: Record<string, unknown>, keybindings: unknown) {
	return (factory: (tui: TuiAltScreen, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown, options?: { overlayOptions?: Record<string, unknown> }): Promise<unknown> => {
		entry.customCount += 1;
		const isAttachStage = entry.select !== null && !entry.attachDone;
		const observer = new AttachPresentationObserver({ cols: WORK_AREA.cols, rows: WORK_AREA.screenRows, now });
		const tui = new TuiAltScreen(asTerminal(observer), false, undefined, {});
		if (isAttachStage) wrapRequestRender(tui, entry);
		return new Promise((resolve, reject) => {
			let component: unknown;
			const done = (result: unknown) => {
				if (!entry.select && result && (result as { action?: string }).action === "attach") {
					entry.select = now();
				}
				if (isAttachStage) {
					entry.attachResult = result;
					entry.attachDone = true;
				}
				// Owned teardown BEFORE resolving so the next ctx.ui.custom (attach
				// after dashboard, or the second dashboard after detach) starts clean.
				void (async () => {
					try {
						(component as { dispose?: () => void })?.dispose?.();
					} catch {
						/* best-effort teardown */
					}
					try {
						tui.stop();
					} catch {
						/* best-effort teardown */
					}
					try {
						await Promise.race([observer.whenIdle(), sleep(1000)]);
					} catch {
						/* best-effort drain */
					}
					try {
						observer.dispose();
					} catch {
						/* best-effort teardown */
					}
					resolve(result);
				})();
			};
			if (isAttachStage) entry.overlayFactoryStart = now();
			try {
				component = factory(tui, theme, keybindings, done);
			} catch (err) {
				reject(err);
				return;
			}
			if (isAttachStage) {
				entry.attachComponent = component;
				entry.attachObserver = observer;
				entry.attachTui = tui;
				entry.attachDetachers.push(...installAttachObservers(component, entry));
			}
			tui.showOverlay(component as never, (options?.overlayOptions ?? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }) as never);
			if (isAttachStage) entry.overlayMounted = now();
			tui.start();
			if (isAttachStage) {
				// Wait for the real first current-generation commit, then finish
				// through the REAL detach input (unconditional Ctrl+\). The attach
				// observer/timeline are read after dashboardAttachLoop returns.
				void (async () => {
					const f0 = await waitForFirstF0(observer, ENTRY_F0_ROWS, 15_000);
					if (f0) {
						entry.terminalCommitted = (f0 as { boundaryParsedAt: number }).boundaryParsedAt;
					}
					await sleep(200); // bounded settle so the commit is a closed frame
					try {
						observer.inputHandler?.(DETACH_INPUT);
					} catch {
						/* the trial records detach failure as UNMEASURED/error below */
					}
				})();
			} else {
				// Dashboard stage: the FIRST dashboard drives its normal attach
				// result; the SECOND (post-detach) drives exit to end the loop.
				setImmediate(() => {
					try {
						observer.inputHandler?.(entry.select === null ? ATTACH_KEY : EXIT_KEY);
					} catch {
						/* recorded via dashboardAttachLoop/attach outcome */
					}
				});
			}
		});
	};
}

/** Real reporter handshake for the opt-in frame wrapper. */
function connectFrameReporter(socketPath: string, tokenPath: string): Promise<import("node:net").Socket> {
	return new Promise((resolveReporter, rejectReporter) => {
		const socket = createConnection(socketPath);
		const messages: Array<Record<string, unknown>> = [];
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try { messages.push(JSON.parse(line)); } catch { /* runner error */ }
			}
		});
		socket.on("error", () => {});
		socket.once("connect", async () => {
			socket.write(JSON.stringify({ type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 1 } }) + "\n");
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline) {
				const enable = messages.find((message) => message.type === "frame_witness_enable");
				if (enable && typeof enable.token === "string") {
					writeFileSync(tokenPath, enable.token);
					resolveReporter(socket);
					return;
				}
				await new Promise((resolveSleep) => setTimeout(resolveSleep, 15));
			}
			socket.destroy();
			rejectReporter(new Error("entry frame reporter enable timeout"));
		});
	});
}

/** One raw second client on the runner endpoint speaking the real
 *  subscribe/capture protocol (baseline seed proof BEFORE select). */
function connectProbe(socketPath: string): Promise<{
	socket: Socket;
	capture: () => Promise<{ frame: string | null; begin: Record<string, unknown> }>;
	destroy: () => void;
}> {
	return new Promise((resolveProbe, rejectProbe) => {
		const connectDeadline = setTimeout(() => {
			try {
				socket.destroy();
			} catch {
				/* best-effort */
			}
			rejectProbe(new Error("probe connect timed out after 5000ms"));
		}, 5000);
		const socket = createConnection(socketPath);
		const messages: Array<Record<string, unknown>> = [];
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					messages.push(JSON.parse(line));
				} catch {
					/* malformed lines are runner errors */
				}
			}
		});
		socket.on("error", () => {});
		socket.once("connect", () => {
			clearTimeout(connectDeadline);
			resolveProbe({
				socket,
				capture: async () => {
					const base = messages.length;
					socket.write(JSON.stringify({ type: "subscribe_terminal", frameVersion: 1 }) + "\n");
					await waitFor(() => messages.slice(base).some((m) => m.type === "snapshot_end" || m.type === "error"), 5000, "probe snapshot_end");
					const slice = messages.slice(base);
					const begin = (slice.find((m) => m.type === "snapshot_begin") ?? {}) as Record<string, unknown>;
					const frameMsg = slice.find((m) => m.type === "snapshot_frame");
					return { begin, frame: typeof frameMsg?.data === "string" ? (frameMsg.data as string) : null };
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

/** Paint one captured snapshot frame on an independent raw terminal. */
async function paintFrame(frameData: string, cols: number, rows: number): Promise<string[]> {
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

interface EntryCleanup {
	childPid: number | null;
	runnerPid: number | null;
	childKnownAliveBeforeKill: boolean | null;
	runnerKnownAliveBeforeKill: boolean | null;
	childKilled: boolean;
	runnerKilled: boolean;
	hostExited: boolean;
	childAliveAfter: boolean | null;
	runnerAliveAfter: boolean | null;
	rootRemoved: boolean;
	rootRetainedForEvidence: boolean;
	ok: boolean;
}

function createEntryCleanup(): EntryCleanup {
	return {
		childPid: null,
		runnerPid: null,
		childKnownAliveBeforeKill: null,
		runnerKnownAliveBeforeKill: null,
		childKilled: false,
		runnerKilled: false,
		hostExited: false,
		childAliveAfter: null,
		runnerAliveAfter: null,
		rootRemoved: false,
		rootRetainedForEvidence: false,
		ok: false,
	};
}

/** Owned teardown for the detached host runner + child (bounded, recorded).
 *  The pids come from the owned host record; a missing pid is UNKNOWN (null),
 *  never known-dead. A host-observed child exit (state === "exited") is valid
 *  termination evidence; forced SIGKILL is recorded where a known pid was
 *  still alive. */
async function killOwnedEntryProcesses(root: string, viewId: string, cleanup: EntryCleanup): Promise<void> {
	let host: { childPid?: number | null; runnerPid?: number | null; state?: string } | null = null;
	try {
		host = readHost(root, viewId);
	} catch {
		host = null;
	}
	cleanup.childPid = typeof host?.childPid === "number" && host.childPid > 0 ? host.childPid : null;
	cleanup.runnerPid = typeof host?.runnerPid === "number" && host.runnerPid > 0 ? host.runnerPid : null;
	cleanup.childKnownAliveBeforeKill = cleanup.childPid === null ? null : isAlive(cleanup.childPid);
	cleanup.runnerKnownAliveBeforeKill = cleanup.runnerPid === null ? null : isAlive(cleanup.runnerPid);
	if (cleanup.childPid !== null && cleanup.childKnownAliveBeforeKill) {
		try {
			process.kill(cleanup.childPid, "SIGKILL");
			cleanup.childKilled = true;
		} catch {
			/* already exited */
		}
	}
	// The runner observes the child exit and finalizes; wait for that bounded
	// observed exit, then force the runner only if it still lingers.
	const deadline = now() + 3000;
	while (now() < deadline) {
		let current: { childPid?: number | null; runnerPid?: number | null; state?: string } | null = null;
		try {
			current = readHost(root, viewId);
		} catch {
			current = null;
		}
		if (current?.state === "exited") break;
		if (cleanup.runnerPid !== null && !isAlive(cleanup.runnerPid)) break;
		await sleep(50);
	}
	try {
		const current = readHost(root, viewId);
		cleanup.hostExited = current?.state === "exited";
	} catch {
		cleanup.hostExited = false;
	}
	cleanup.childAliveAfter = cleanup.childPid === null ? null : isAlive(cleanup.childPid);
	cleanup.runnerAliveAfter = cleanup.runnerPid === null ? null : isAlive(cleanup.runnerPid);
	if (cleanup.runnerPid !== null && cleanup.runnerAliveAfter) {
		try {
			process.kill(cleanup.runnerPid, "SIGKILL");
			cleanup.runnerKilled = true;
		} catch {
			/* already exited */
		}
		await sleep(100);
		cleanup.runnerAliveAfter = cleanup.runnerPid === null ? null : isAlive(cleanup.runnerPid);
	}
}

function entryCleanupOk(cleanup: EntryCleanup): boolean {
	const childTerminated = cleanup.hostExited || cleanup.childAliveAfter === false;
	const runnerTerminated = cleanup.runnerAliveAfter === false || cleanup.runnerKilled;
	return childTerminated && runnerTerminated && (cleanup.rootRemoved || cleanup.rootRetainedForEvidence);
}

function environmentInfo(scenarioHash: string): Record<string, unknown> {
	return {
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		piTui: JSON.parse(readFileSync(join(REPO_ROOT, "node_modules/@earendil-works/pi-tui/package.json"), "utf8")).version,
		xtermHeadless: JSON.parse(readFileSync(join(REPO_ROOT, "node_modules/@xterm/headless/package.json"), "utf8")).version,
		head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
		scenarioHash,
		hashes: {
			generationFixture: sha256File(join(REPO_ROOT, "test-support/fake-pty-generation-pi.mjs")),
			observerFixture: sha256File(join(REPO_ROOT, "test-support/attach-presentation-fixture.ts")),
			acceptedScenario: sha256File(join(REPO_ROOT, "test-support/pty-attach-ready-scenario.ts")),
		},
	};
}

/**
 * The one real-entry trial: owned root, REAL createService (real default
 * launchHostProcess + real resolveAttachTarget), prewarm via the real
 * ensureHost path, seed proof through a real subscribe/capture BEFORE select,
 * then the REAL dashboardAttachLoop with the REAL DashboardComponent (stage1)
 * and the REAL PtyAttachComponent + TuiAltScreen overlay (stage2) observed by
 * the accepted observer. Total timing is select→terminalCommitted as ONE
 * witness; resolver/overlay/component timings are recorded separately on the
 * same parent-monotonic clock. Trial failures are retained evidence.
 */
export async function runEntryTrial(options: { artifactDir: string }): Promise<Record<string, unknown>> {
	const { artifactDir } = options;
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
			writeFileSync(join(artifactDir, name), readFileSync(source));
		} catch (err) {
			artifactErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const entry = createEntryState();
	const cleanup = createEntryCleanup();
	const scenarioHash = sha256File(join(REPO_ROOT, "test-support/attach-ready-entry-scenario.ts"));
	const declared = {
		caseId: "ENTRY",
		generation: ENTRY_GENERATION,
		baselineFrame: { id: ENTRY_F0_ID, rows: ENTRY_F0_ROWS, cursorWorkArea: ENTRY_F0_CURSOR },
		hostSize: { cols: WORK_AREA.cols, rows: WORK_AREA.rows },
		attachSurface: { terminalCols: WORK_AREA.cols, terminalRows: WORK_AREA.screenRows, bodyCols: WORK_AREA.cols, bodyRows: WORK_AREA.rows },
		measuredFrom: "select (the dashboard's real {action:'attach',viewId} result)",
		measuredTo: "the first independently observed outer complete frame whose work area equals the current-generation literal F0 grid",
		excluded: "root creation, host launch and baseline seed proof happen before select and are excluded",
		note: "ENTRY is a smoke topology case, not a formal B/Q performance cell and not R recovery; total latency is reported as ONE witness, never a distribution or target verdict",
	};
	writeArtifact("expectation.json", { declared });

	// Test-isolation env (documented; no production edit): the legacy
	// direct-write state path avoids spawning a detached state coordinator for
	// markVisited. The attach topology (real launchHostProcess + real
	// resolveAttachTarget) is unaffected by this knob.
	const savedEnv: Record<string, string | undefined> = {
		COLUMNS: process.env.COLUMNS,
		LINES: process.env.LINES,
		AGENT_BOARD_COORDINATOR: process.env.AGENT_BOARD_COORDINATOR,
		FAKE_PTY_GENERATION: process.env.FAKE_PTY_GENERATION,
		FAKE_PTY_EVENTS_PATH: process.env.FAKE_PTY_EVENTS_PATH,
		FAKE_PTY_FRAME_CHILD_PATH: process.env.FAKE_PTY_FRAME_CHILD_PATH,
		FAKE_PTY_FRAME_TOKEN: process.env.FAKE_PTY_FRAME_TOKEN,
	};

	let root: string | null = null;
	let viewId: string | null = null;
	let probe: { destroy: () => void; capture: () => Promise<{ frame: string | null; begin: Record<string, unknown> }> } | null = null;
	let reporter: import("node:net").Socket | null = null;
	let trialError: string | null = null;
	let prewarm: Record<string, unknown> = { ok: false, detail: "not reached" };

	try {
		root = mkdtempSync(join(tmpdir(), "entry-"));
		const eventsPath = join(root, "child-events.jsonl");
		const frameTokenPath = join(root, "frame-token.txt");
		// Same-size control: the host must spawn the child at 80x22 so the
		// 80x22 attach body issues ZERO resize. The generation fixture token +
		// event log flow through the runner's inherited process.env.
		process.env.COLUMNS = String(WORK_AREA.cols);
		process.env.LINES = String(WORK_AREA.rows);
		process.env.AGENT_BOARD_COORDINATOR = "off";
		process.env.FAKE_PTY_GENERATION = ENTRY_GENERATION;
		process.env.FAKE_PTY_EVENTS_PATH = eventsPath;
		process.env.FAKE_PTY_FRAME_CHILD_PATH = join(REPO_ROOT, "test-support/fake-pty-generation-pi.mjs");
		process.env.FAKE_PTY_FRAME_TOKEN = frameTokenPath;

		const prewarmStart = now();
		const { createService, dashboardAttachLoop } = await loadRuntime();
		const service = createService({
			root,
			runnerScript: join(REPO_ROOT, "runner/job-runner.mjs"),
			ptyRunnerScript: join(REPO_ROOT, "runner/pty-runner.mjs"),
			piCommand: process.execPath,
			piArgsPrefix: [join(REPO_ROOT, "test-support/fake-pty-frame-wrapper.mjs")],
			defaultCwd: process.cwd(),
		});

		// Prewarm (EXCLUDED from total entry): create the view, materialize the
		// session file, launch the real host through the real ensureHost path.
		viewId = `entry-${process.pid}-${Date.now()}`;
		const meta = createView(root, { id: viewId, name: "entry-prewarm", cwd: process.cwd() });
		writeFileSync(meta.sessionFile, "");
		const ensured = service.ensureHost(viewId);
		if (!ensured.ok) throw new Error(`ensureHost failed: ${ensured.error ?? "unknown"}`);
		await waitFor(() => {
			const host = readHost(root!, viewId!);
			return !!host && host.state === "alive" && !!host.childPid;
		}, 15_000, "runner host alive with child");
		const socketPath = readHost(root!, viewId!)!.socketPath!;
		reporter = await connectFrameReporter(socketPath, frameTokenPath);

		// Baseline seed proof (EXCLUDED): a real subscribe/capture on a second
		// client paints the literal F0 grid BEFORE select.
		probe = await connectProbe(socketPath);
		let seedRows: string[] | null = null;
		const seedDeadline = now() + 8000;
		while (now() < seedDeadline) {
			const capture = await probe.capture();
			if (capture.frame !== null) {
				seedRows = rtrimRows(await paintFrame(capture.frame, WORK_AREA.cols, WORK_AREA.rows));
				break;
			}
			await sleep(200);
		}
		prewarm = {
			ok: seedRows !== null && rowsEqual(seedRows, ENTRY_F0_ROWS),
			start: prewarmStart,
			end: now(),
			method: "runner-capture-replay at 80x22 (independent raw terminal), BEFORE the measured select",
			rows: seedRows,
			literalRows: ENTRY_F0_ROWS,
		};
		if (!prewarm.ok) throw new Error(`ENTRY seed proof failed: ${JSON.stringify(seedRows)}`);

		// Wrap the real resolver log-and-delegate ONLY (args/this/return/errors
		// pass through unchanged; the result is never substituted).
		const originalResolve = service.resolveAttachTarget.bind(service);
		(service as unknown as { resolveAttachTarget: (viewId: string, opts?: { timeoutMs?: number }) => Promise<unknown> }).resolveAttachTarget = async (id: string, opts?: { timeoutMs?: number }) => {
			entry.resolverCalls += 1;
			entry.resolverStart = now();
			try {
				const result = await originalResolve(id, opts);
				entry.resolverSocketPath = typeof (result as { socketPath?: unknown }).socketPath === "string" ? (result as { socketPath: string }).socketPath : null;
				entry.resolverInstanceId = typeof (result as { instanceId?: unknown }).instanceId === "string" ? (result as { instanceId: string }).instanceId : null;
				entry.resolverKind = typeof (result as { kind?: unknown }).kind === "string" ? (result as { kind: string }).kind : null;
				return result;
			} finally {
				entry.resolverEnd = now();
			}
		};

		// The fake extension command context: only the terminal + session/fixture
		// are replaced; the command/dashboard factory and attach component are the
		// REAL production code reached through their real call path.
		const theme: Record<string, unknown> = {
			fg: (_c: string, text: string) => text,
			bg: (_c: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => text,
			strikethrough: (text: string) => text,
		};
		const keybindings = { matches: () => false };
		const ctx = {
			ui: {
				setWorkingVisible() {},
				setHeader() {},
				setFooter() {},
				setTitle() {},
				notify() {},
				theme,
				custom: makeEntryCustom(entry, theme, keybindings),
			},
			cwd: process.cwd(),
			model: null,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionFile: () => null },
			switchSession: async () => ({ cancelled: true }),
		};

		// The measured real entry: dashboard (stage1) → select → real resolver →
		// real overlay attach (stage2) → first F0 commit → real detach.
		await (dashboardAttachLoop as (c: unknown, s: unknown, r: string, id: string | null, get: (() => string) | undefined) => Promise<void>)(
			ctx,
			service,
			root,
			viewId,
			() => "off",
		);
	} catch (err) {
		trialError = err instanceof Error ? (err.stack ?? err.message) : String(err);
	} finally {
		// Owned teardown on success AND failure; raw truth written before root
		// removal; copy/write failures retain the root as evidence.
		for (const detach of entry.attachDetachers.reverse()) {
			try {
				detach();
			} catch {
				/* best-effort teardown */
			}
		}
		try {
			probe?.destroy();
		} catch {
			/* best-effort teardown */
		}
		try { reporter?.destroy(); } catch { /* best-effort */ }
		if (root && viewId) await killOwnedEntryProcesses(root, viewId, cleanup);
		// The attach observer/timeline survive disposal (frozen lists).
		if (entry.attachObserver) {
			writeArtifact("observations.json", { observations: entry.attachObserver.observations });
			writeArtifact("writes.json", entry.attachObserver.writes);
			writeArtifact("controls.json", entry.attachObserver.controls);
		}
		writeArtifact("rx-socket.json", entry.rxLog);
		writeArtifact("tx-socket.json", entry.txLog);
		writeArtifact("tx-messages.json", parseTxMessages(entry.txLog));
		if (root && viewId) {
			try {
				copyArtifact("child-events.jsonl", join(root, "child-events.jsonl"));
			} catch {
				/* missing child events are recorded as absent */
			}
		}
		if (artifactErrors.length > 0) {
			cleanup.rootRetainedForEvidence = true;
		} else if (root) {
			try {
				rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
				cleanup.rootRemoved = true;
			} catch {
				/* recorded below */
			}
		}
		cleanup.ok = entryCleanupOk(cleanup);
		writeArtifact("cleanup.json", cleanup);
		// Restore process env (the scenario owns its process, but be tidy).
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}

	const totalEntryMs = entry.terminalCommitted !== null && entry.select !== null ? entry.terminalCommitted - entry.select : null;
	const componentMs = entry.terminalCommitted !== null && entry.overlayMounted !== null ? entry.terminalCommitted - entry.overlayMounted : null;
	const resolverMs = entry.resolverStart !== null && entry.resolverEnd !== null ? entry.resolverEnd - entry.resolverStart : null;
	const componentSocketPath = entry.attachComponent ? (entry.attachComponent as { opts?: { socketPath?: string } }).opts?.socketPath ?? null : null;
	const firstContentFrame = entry.attachObserver
		? (entry.attachObserver.observations.find((o) => o.kind === "frame" && rowsEqual(projectedBodyRows(o), ENTRY_F0_ROWS)) ?? null)
		: null;
	const firstContent = firstContentFrame
		? {
				observationIndex: (firstContentFrame as { index: number }).index,
				boundaryParsedAt: (firstContentFrame as { boundaryParsedAt: number }).boundaryParsedAt,
				rows: projectedBodyRows(firstContentFrame),
				isCurrentGenerationF0: rowsEqual(projectedBodyRows(firstContentFrame), ENTRY_F0_ROWS),
				hasTailInput: (projectedBodyRows(firstContentFrame)[19] ?? "").includes("TAIL") && (projectedBodyRows(firstContentFrame)[21] ?? "").includes("INPUT >"),
				outerCursor: { ...(firstContentFrame as { cursor: { x: number; y: number; absoluteY: number; visible: boolean } }).cursor },
				inverseCells: inverseCellsOf(firstContentFrame),
				oldGenerationSeen: projectedBodyRows(firstContentFrame).some((row) => /\bgen-\d+\b/.test(row) && !row.includes(`${ENTRY_GENERATION} `)),
		}
		: null;
	const ordering = {
		"select<=resolverStart": entry.select !== null && entry.resolverStart !== null && entry.select <= entry.resolverStart,
		"resolverStart<=resolverEnd": entry.resolverStart !== null && entry.resolverEnd !== null && entry.resolverStart <= entry.resolverEnd,
		"resolverEnd<=overlayFactoryStart": entry.resolverEnd !== null && entry.overlayFactoryStart !== null && entry.resolverEnd <= entry.overlayFactoryStart,
		"overlayFactoryStart<=overlayMounted": entry.overlayFactoryStart !== null && entry.overlayMounted !== null && entry.overlayFactoryStart <= entry.overlayMounted,
		"overlayMounted<=terminalCommitted": entry.overlayMounted !== null && entry.terminalCommitted !== null && entry.overlayMounted <= entry.terminalCommitted,
	};
	const record: Record<string, unknown> = {
		ok: trialError === null,
		caseId: "ENTRY",
		repeat: 1,
		clock: "real",
		measured: totalEntryMs !== null,
		totalEntryMs,
		componentMs,
		resolverMs,
		resolverCalls: entry.resolverCalls,
		resolver: { kind: entry.resolverKind, socketPath: entry.resolverSocketPath, instanceId: entry.resolverInstanceId },
		timeline: {
			select: entry.select,
			resolverStart: entry.resolverStart,
			resolverEnd: entry.resolverEnd,
			overlayFactoryStart: entry.overlayFactoryStart,
			overlayMounted: entry.overlayMounted,
			connected: entry.connected,
			snapshotBeginReceived: entry.snapshotBeginReceived,
			snapshotValidated: entry.snapshotValidated,
			snapshotParsed: entry.snapshotParsed,
			renderRequest: entry.renderRequest,
			terminalCommitted: entry.terminalCommitted,
			customCount: entry.customCount,
			attachDone: entry.attachDone,
		},
		ordering,
		prewarm,
		endpoint: {
			resolverSocketPath: entry.resolverSocketPath,
			componentSocketPath,
			matches: entry.resolverSocketPath !== null && componentSocketPath !== null && entry.resolverSocketPath === componentSocketPath,
		},
		resizeCommands: parseTxMessages(entry.txLog).filter((m) => m.type === "resize").map((m) => m.msg),
		zeroResize: parseTxMessages(entry.txLog).every((m) => m.type !== "resize"),
		snapshotTiming: {
			snapshotBeginReceived: "protocol snapshot_begin receipt (collection start) — not a parse fact",
			snapshotValidated: "protocol snapshotReady receipt — the attach client has already validated continuity before emitting it; this is a receipt, not a local parse",
			snapshotParsed: "the local xterm parser term.write write-callback for the EXACT snapshot frame data (matched by full string identity); null = unobserved (older constructor replay writes predate instrumentation and empty/no-frame baselines stay null)",
		},
		firstContent,
		detach: { driven: entry.attachDone, result: entry.attachResult, input: DETACH_INPUT },
		declared,
		cleanup,
		artifactErrors,
		environment: environmentInfo(scenarioHash),
		error: trialError,
		artifactDir,
	};
	writeArtifact("summary.json", record);
	return record;
}

// ---------------------------------------------------------------------------
// CLI surface (approved): --case ENTRY --repeat 1 --clock real --artifact-dir
// <owned path>. Anything else fails explicitly (stderr + exit 2, no dummy
// success). A valid invocation runs the trial and prints exactly one JSON line.
// ---------------------------------------------------------------------------

function cliError(message: string): never {
	process.stderr.write(`attach-ready-entry-scenario: ${message}\n`);
	process.exit(2);
}

export function parseCli(argv: string[]): { caseId: string; repeat: number; clock: string; artifactDir: string } {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith("--") || i + 1 >= argv.length) cliError(`malformed arguments: ${argv.join(" ")}`);
		args.set(argv[i].slice(2), argv[i + 1]);
	}
	const caseId = args.get("case") ?? cliError("missing --case");
	if (caseId !== "ENTRY") cliError(`unsupported --case ${JSON.stringify(caseId)} (only ENTRY is implemented)`);
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
	const cli = parseCli(process.argv.slice(2));
	// Exclusivity guard BEFORE any trial runs: an already-existing artifact dir
	// refuses with exit 2 + stderr + no stdout, preserving the prior artifact
	// byte-identical. (runEntryTrial keeps its own throw as defense in depth.)
	if (existsSync(cli.artifactDir)) cliError(`artifact dir already exists (overwrite refused): ${cli.artifactDir}`);
	runEntryTrial({ artifactDir: cli.artifactDir })
		.then((result) => {
			process.stdout.write(JSON.stringify(result) + "\n");
			process.exit(0);
		})
		.catch((err) => {
			process.stderr.write(`attach-ready-entry-scenario: trial harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exit(1);
		});
}
