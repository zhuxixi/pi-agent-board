// Issue #222 step 23a fix1 (task-23a-smoke-fix1-brief.md): repo-local, ISOLATED
// actual-Pi probe extension. Loaded into an owned real PTY Pi child via
// `--extension <absolute path>`. It proves INSIDE the extension that Pi loaded
// it, then exercises ONLY documented public APIs:
//   ctx.hasUI / ctx.mode / ctx.ui.setWidget(key, factory, {placement:"belowEditor"})
//   ctx.ui.custom(factory)            (real renderer overlay composition + focus)
// and observes the SHARED Terminal instance with INSTANCE-OWN property shadows
// (never prototype mutation): `columns`/`rows` getters, `write`/`hideCursor`/
// `showCursor`, and the `start`/`stop` lifecycle methods.
//
// fix1 adds the diagnostic candidate evaluator (test-support only, not
// production): every sampling pair opens a candidate, the belowEditor sentinel
// supplies the focus/mode fact, and S/F/A/none/unsupported decisions are written
// into the JSONL with explicit candidate identities. Lifecycle evidence is also
// recorded inside the extension: shadow restore results with descriptor/ownership
// checks on explicit stop, and the actual `session_shutdown` event afterwards
// (the post-stop log channel stays open on purpose).
//
// FACT BOUNDARIES: headless PTY is not physical-pixel evidence; no model or
// network request is made; passing this probe is not A4/A5 acceptance.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FrameCandidateEvaluator } from "./pi23a-candidate-evaluator.ts";

const SELF = fileURLToPath(import.meta.url);
const LOG = process.env.PI23A_PROBE_LOG ?? join(dirname(SELF), "probe.jsonl");
const CONTROL = process.env.PI23A_CONTROL_FILE ?? join(dirname(SELF), "control.json");
const SENTINEL_KEY = "agent-board-probe-23a";

let loadCount = 0;
let phase = "boot";

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function record(event: Record<string, unknown>): void {
	try {
		appendFileSync(LOG, `${JSON.stringify({ at: process.hrtime.bigint().toString(), wallMs: Date.now(), phase, ...event })}\n`);
	} catch {
		/* diagnostics are best-effort; the runner records a missing log */
	}
}

function readReal(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/**
 * Resolve the ACTUAL runtime package paths/versions from inside the extension by
 * walking the real runtime entry's `node_modules` on disk (the host packages use
 * subpath-only `exports`, so `require.resolve(name)` is not usable).
 */
function resolvedPackages(): Record<string, unknown> {
	const roots: Array<{ via: string; start: string }> = [];
	const argvEntry = process.argv[1];
	if (argvEntry !== undefined) {
		const real = readReal(argvEntry) ?? argvEntry;
		roots.push({ via: "argv[1] (managed pi runtime entry)", start: dirname(real) });
	}
	roots.push({ via: "extension module (self)", start: dirname(readReal(SELF) ?? SELF) });
	const out: Record<string, unknown> = {};
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		const attempts: string[] = [];
		for (const root of roots) {
			let dir = root.start;
			for (let i = 0; i < 8; i += 1) {
				const pkg = join(dir, "node_modules", name, "package.json");
				if (existsSync(pkg)) {
					const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: string; exports?: unknown };
					out[name] = {
						version: parsed.version,
						packageJson: readReal(pkg) ?? pkg,
						exportsKeys: parsed.exports === undefined ? null : Object.keys(parsed.exports as Record<string, unknown>),
						resolvedVia: root.via,
					};
					break;
				}
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
			if (out[name] !== undefined) break;
			attempts.push(`${root.via}: no node_modules/${name}/package.json up-tree from ${root.start}`);
		}
		if (out[name] === undefined) out[name] = { error: "unresolved", attempts };
	}
	return out;
}

interface Shadow {
	key: string;
	kind: "getter" | "method";
	descriptor: PropertyDescriptor | undefined;
	installed: unknown;
	restored: string | null;
}

/**
 * Install an INSTANCE-OWN shadow, choosing the descriptor kind from the existing
 * prototype descriptor. The prototype is never touched.
 */
function installShadow(
	target: Record<string, unknown>,
	key: string,
	record_: (event: Record<string, unknown>) => void,
	makeValue: (original: unknown) => unknown,
	makeGetter: (originalDescriptor: PropertyDescriptor) => () => unknown,
): Shadow {
	const instanceBefore = Object.getOwnPropertyDescriptor(target, key);
	const proto = Object.getPrototypeOf(target) as Record<string, unknown>;
	const protoDescriptor = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, key);
	const isAccessor = instanceBefore !== undefined ? typeof instanceBefore.get === "function" : typeof protoDescriptor?.get === "function";
	let installed: unknown;
	try {
		if (isAccessor) {
			const getter = makeGetter(protoDescriptor ?? instanceBefore ?? { get: () => undefined });
			installed = getter;
			Object.defineProperty(target, key, { configurable: true, enumerable: instanceBefore?.enumerable ?? false, get: getter });
		} else {
			const value = makeValue(instanceBefore !== undefined ? instanceBefore.value : proto[key]);
			installed = value;
			Object.defineProperty(target, key, { configurable: true, enumerable: instanceBefore?.enumerable ?? false, value, writable: true });
		}
	} catch (err) {
		record_({ event: "shadow-install-failed", key, error: err instanceof Error ? err.message : String(err) });
		return { key, kind: isAccessor ? "getter" : "method", descriptor: instanceBefore, installed: null, restored: "not-installed" };
	}
	return { key, kind: isAccessor ? "getter" : "method", descriptor: instanceBefore, installed, restored: null };
}

/** Remove ONLY our own shadow; never touch a third party's later replacement. */
function restoreShadow(target: Record<string, unknown>, shadow: Shadow): string {
	if (shadow.restored !== null) return shadow.restored;
	const current = Object.getOwnPropertyDescriptor(target, shadow.key);
	const installed = shadow.installed;
	const stillOurs =
		current !== undefined && (typeof installed === "function" ? current.get === installed || current.value === installed : current.value === installed);
	if (!stillOurs) {
		shadow.restored = current === undefined ? "already-absent" : "shadow-replaced-not-restored";
		return shadow.restored;
	}
	delete target[shadow.key];
	shadow.restored = "restored";
	return shadow.restored;
}

export default function agentBoardProbe23a(pi: ExtensionAPI): void {
	loadCount += 1;
	record({
		event: "extension-load",
		loadCount,
		self: SELF,
		selfRealpath: readReal(SELF),
		selfSha256: sha256(readFileSync(SELF, "utf8")),
		evaluatorSha256: sha256(readFileSync(join(dirname(SELF), "pi23a-candidate-evaluator.ts"), "utf8")),
		importMetaUrl: import.meta.url,
		pid: process.pid,
		ppid: process.ppid,
		execPath: process.execPath,
		argv: process.argv,
		envAllowlist: {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
			TERM: process.env.TERM ?? null,
			PI23A_PROBE_LOG: LOG,
			PI23A_CONTROL_FILE: CONTROL,
		},
		packages: resolvedPackages(),
	});
	pi.on("session_start", (_event: unknown, ctx: unknown) => {
		phase = "session";
		const typed = ctx as {
			hasUI?: boolean;
			mode?: string;
			ui?: {
				setWidget: (key: string, factory: unknown, options?: { placement?: string }) => void;
				custom: (factory: unknown, options?: unknown) => Promise<unknown>;
			};
			sessionManager?: { getSessionFile?: () => string | null };
		};
		const uiSeen = typed.hasUI === true && typed.ui !== undefined;
		record({
			event: "session-start",
			hasUI: typed.hasUI ?? null,
			mode: typed.mode ?? null,
			sessionFile: typed.sessionManager?.getSessionFile?.() ?? null,
			loadCount,
			uiSeen,
		});
		if (!uiSeen || typed.ui === undefined) {
			record({ event: "unsupported", reason: "no UI context (hasUI false or ctx.ui missing)" });
			return;
		}
		install(typed.ui as NonNullable<typeof typed.ui>);
	});
	pi.on("session_shutdown", (event: unknown) => {
		// Post-stop channel: the probe keeps writing after `stop` so the ACTUAL
		// shutdown event is recorded rather than inferred from exit code 0.
		phase = "shutdown";
		const reason = (event as { reason?: unknown } | undefined)?.reason;
		record({ event: "session-shutdown", reason: reason ?? null, loadCount });
	});
}

function install(ui: { setWidget: (key: string, factory: unknown, options?: { placement?: string }) => void; custom: (factory: unknown, options?: unknown) => Promise<unknown> }): void {
	const initialCounter: { value: number } = { value: 0 };
	const state: {
		tui: Record<string, unknown> | null;
		terminal: Record<string, unknown> | null;
		terminalToken: symbol | null;
		focusApi: "present" | "absent" | "unknown";
		shadows: Shadow[];
		renderPasses: number;
		sizeReads: number;
		overlayDone: ((value: unknown) => void) | null;
		currentMode: "fullscreen" | "regular";
		rendererEpoch: number;
		staleTui: boolean;
		evaluator: FrameCandidateEvaluator;
		frameIdCounter: { value: number };
		stopped: boolean;
	} = {
		tui: null,
		terminal: null,
		terminalToken: null,
		focusApi: "unknown",
		shadows: [],
		renderPasses: 0,
		sizeReads: 0,
		overlayDone: null,
		currentMode: "fullscreen",
		rendererEpoch: 1,
		staleTui: false,
		// One counter for the whole probe lifetime = one reporter token, so frameIds
		// stay strictly increasing across rendererEpoch changes (parent decision).
		frameIdCounter: initialCounter,
		evaluator: new FrameCandidateEvaluator({ mode: "fullscreen", frameIdCounter: initialCounter }),
		stopped: false,
	};

	const emitDecisions = (decisions: Array<{ kind: string; frameId: number | null; reason: string; sampledCols: number | null; sampledRows: number | null; mode: string | null }>, source: string): void => {
		for (const decision of decisions) record({ event: "candidate-decision", source, rendererEpoch: state.rendererEpoch, ...decision });
	};

	const sentinel = (tui: unknown, _theme: unknown) => {
		const previousTui = state.tui;
		state.tui = tui as Record<string, unknown>;
		const maybe = (tui as { getFocusedComponent?: unknown }).getFocusedComponent;
		state.focusApi = typeof maybe === "function" ? "present" : "absent";
		const mode = (tui as { mode?: unknown }).mode;
		if (typeof mode === "string" && (mode === "fullscreen" || mode === "regular")) state.currentMode = mode;
		// Rebind the diagnostic evaluator when the observed renderer mode differs
		// (startup flag or a documented in-session switch); the old candidate is
		// aborted and the new mode applies from the next sampling pair.
		if (state.evaluator.mode !== state.currentMode) {
			state.evaluator.stop();
			state.evaluator = new FrameCandidateEvaluator({ mode: state.currentMode, frameIdCounter: state.frameIdCounter });
			record({ event: "evaluator-rebound", mode: state.currentMode, rendererEpoch: state.rendererEpoch, lastFrameId: state.frameIdCounter.value, loadCount });
		}
		record({
			event: previousTui === null ? "sentinel-factory" : "sentinel-refactory",
			focusApi: state.focusApi,
			mode: state.currentMode,
			rendererEpoch: state.rendererEpoch,
			loadCount,
		});
		attachTerminal();
		return {
			render: (_width: number): string[] => {
				state.renderPasses += 1;
				const focus = state.focusApi === "present" ? (tui as { getFocusedComponent?: () => unknown }).getFocusedComponent?.() : undefined;
				const hasOverlay = typeof (tui as { hasOverlay?: () => boolean }).hasOverlay === "function" ? (tui as { hasOverlay: () => boolean }).hasOverlay() : null;
				record({
					event: "sentinel-render",
					pass: state.renderPasses,
					mode: state.currentMode,
					focusPresent: state.focusApi === "present" ? focus !== null && focus !== undefined : null,
					focusApi: state.focusApi,
					hasOverlay,
					rendererEpoch: state.rendererEpoch,
					staleTui: state.staleTui,
					loadCount,
				});
				if (!state.stopped && !state.staleTui && state.focusApi === "present") {
					state.evaluator.sentinel({ focusPresent: focus !== null && focus !== undefined, focusIdentity: focus, mode: state.currentMode });
				}
				return []; // zero height: never changes layout/rows
			},
			dispose: () => {
				record({ event: "sentinel-dispose", rendererEpoch: state.rendererEpoch, loadCount });
			},
		};
	};

	function attachTerminal(): void {
		if (state.tui === null) return;
		if (state.terminal !== null) {
			// Re-registration after a mode switch: prove the renderer kept the SAME
			// terminal instance (switchTuiMode passes `previousUi.terminal` through).
			const current = (state.tui as { terminal?: unknown }).terminal;
			record({
				event: "terminal-identity-check",
				sameTerminalInstance: current === state.terminal,
				terminalToken: state.terminalToken === null ? null : "assigned",
				rendererEpoch: state.rendererEpoch,
				loadCount,
			});
			return;
		}
		const terminal = (state.tui as { terminal?: Record<string, unknown> }).terminal;
		if (terminal === undefined || terminal === null) {
			record({ event: "unsupported", reason: "tui.terminal is not exposed on the public TUI instance" });
			return;
		}
		state.terminal = terminal;
		state.terminalToken = Symbol("terminal-instance");
		const proto = Object.getPrototypeOf(terminal) as Record<string, unknown>;
		record({
			event: "terminal-identity",
			terminalConstructor: (terminal as { constructor?: { name?: string } }).constructor?.name ?? null,
			prototypeDescriptors: {
				columns: Object.getOwnPropertyDescriptor(proto, "columns") ?? null,
				rows: Object.getOwnPropertyDescriptor(proto, "rows") ?? null,
				write: Object.getOwnPropertyDescriptor(proto, "write") ?? null,
				hideCursor: Object.getOwnPropertyDescriptor(proto, "hideCursor") ?? null,
				showCursor: Object.getOwnPropertyDescriptor(proto, "showCursor") ?? null,
				start: Object.getOwnPropertyDescriptor(proto, "start") ?? null,
				stop: Object.getOwnPropertyDescriptor(proto, "stop") ?? null,
			},
			ownBefore: {
				columns: Object.getOwnPropertyDescriptor(terminal, "columns") ?? null,
				rows: Object.getOwnPropertyDescriptor(terminal, "rows") ?? null,
				write: Object.getOwnPropertyDescriptor(terminal, "write") ?? null,
				start: Object.getOwnPropertyDescriptor(terminal, "start") ?? null,
				stop: Object.getOwnPropertyDescriptor(terminal, "stop") ?? null,
			},
			loadCount,
		});
		for (const key of ["columns", "rows"] as const) {
			state.shadows.push(
				installShadow(
					terminal,
					key,
					record,
					(original) => original,
					(descriptor) => () => {
						const getter = descriptor.get;
						const value = getter === undefined ? undefined : getter.call(terminal);
						state.sizeReads += 1;
						record({ event: "size-read", key, value: typeof value === "number" ? value : null, rendererEpoch: state.rendererEpoch, loadCount });
						if (!state.stopped && typeof value === "number") {
							const before = state.evaluator.log.length;
							state.evaluator.sizeRead(key, value);
							emitDecisions(state.evaluator.log.slice(before), "sampling");
							scheduleFence();
						}
						return value;
					},
				),
			);
		}
		for (const key of ["write", "hideCursor", "showCursor"] as const) {
			state.shadows.push(
				installShadow(
					terminal,
					key,
					record,
					(original) => {
						const fn = original as (...args: unknown[]) => unknown;
						return (...args: unknown[]) => {
							const text = typeof args[0] === "string" ? (args[0] as string) : "";
							record({
								event: "terminal-op",
								key,
								bytes: text.length,
								sha256: text === "" ? null : sha256(text),
								hasSyncOpen: text.includes("\u001b[?2026h"),
								hasSyncClose: text.includes("\u001b[?2026l"),
								hasCursorVisibility: /\u001b\[\?25[hl]/.test(text),
								head: text.slice(0, 40),
								rendererEpoch: state.rendererEpoch,
								loadCount,
							});
							if (!state.stopped) {
								emitDecisions(state.evaluator.op({ kind: key, text }), "live");
								scheduleFence();
							}
							return fn.apply(terminal, args);
						};
					},
					() => () => undefined,
				),
			);
		}
		for (const key of ["start", "stop"] as const) {
			state.shadows.push(
				installShadow(
					terminal,
					key,
					record,
					(original) => {
						const fn = original as (...args: unknown[]) => unknown;
						return (...args: unknown[]) => {
							const openFrameId = state.evaluator.openFrameId;
							record({ event: "terminal-lifecycle", key, rendererEpoch: state.rendererEpoch, openFrameId, loadCount });
							// start/stop invalidate the open candidate (contract §2.1). The
							// decision slice produced by abort() is emitted, so a real
							// open-stop witness carries its identity and outcome.
							if (!state.stopped) {
								const before = state.evaluator.log.length;
								state.evaluator.abort(`terminal-${key}`);
								const produced = state.evaluator.log.slice(before);
								emitDecisions(produced, "lifecycle");
								if (openFrameId !== null) {
									record({
										event: "candidate-abort-fence",
										reason: `terminal-${key}`,
										openFrameId,
										decisionKind: produced.at(-1)?.kind ?? null,
										rendererEpoch: state.rendererEpoch,
										loadCount,
									});
								}
							}
							if (key === "stop") {
								state.staleTui = true;
							} else {
								// Keep `staleTui` until the widget factory is re-invoked: the
								// captured TuiRef belongs to the previous renderer, so focus
								// facts stay suppressed (conservative) until re-registration.
								state.rendererEpoch += 1;
							}
							record({ event: "terminal-lifecycle-applied", key, rendererEpoch: state.rendererEpoch, staleTui: state.staleTui, loadCount });
							return fn.apply(terminal, args);
						};
					},
					() => () => undefined,
				),
			);
		}
		record({ event: "terminal-shadows-installed", keys: state.shadows.map((entry) => entry.key), rendererEpoch: state.rendererEpoch, loadCount });
	}

	let fenceScheduled = false;
	function scheduleFence(): void {
		if (fenceScheduled) return;
		fenceScheduled = true;
		process.nextTick(() => {
			fenceScheduled = false;
			if (state.stopped) return;
			const before = state.evaluator.log.length;
			state.evaluator.fence();
			emitDecisions(state.evaluator.log.slice(before), "fence");
		});
	}

	function restoreAllShadows(reason: string): void {
		const terminal = state.terminal;
		const proto = terminal === null ? null : (Object.getPrototypeOf(terminal) as Record<string, unknown>);
		const restoreResults: Array<Record<string, unknown>> = [];
		for (const shadow of state.shadows) {
			if (terminal === null) break;
			const ownBefore = Object.getOwnPropertyDescriptor(terminal, shadow.key);
			const result = restoreShadow(terminal, shadow);
			const ownAfter = Object.getOwnPropertyDescriptor(terminal, shadow.key);
			const protoDescriptor = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, shadow.key);
			restoreResults.push({
				key: shadow.key,
				kind: shadow.kind,
				result,
				hadOwnBefore: ownBefore !== undefined,
				ownAfter: ownAfter ?? null,
				protoAfter: protoDescriptor ?? null,
				protoUnchanged: shadow.kind === "getter" ? typeof protoDescriptor?.get === "function" : typeof protoDescriptor?.value === "function",
			});
		}
		for (const entry of restoreResults) record({ event: "shadow-restore", ...entry });
		record({
			event: "stop-verified",
			reason,
			restored: restoreResults.filter((entry) => entry.result === "restored").length,
			notRestored: restoreResults.filter((entry) => entry.result !== "restored").map((entry) => ({ key: entry.key, result: entry.result })),
			ownPropertiesRemaining: terminal === null ? null : state.shadows.filter((shadow) => Object.getOwnPropertyDescriptor(terminal, shadow.key) !== undefined).map((shadow) => shadow.key),
			markerRecursionSeen: state.evaluator.sawMarkerRecursion,
			lastFrameId: state.frameIdCounter.value,
			loadCount,
		});
	}

	ui.setWidget(SENTINEL_KEY, sentinel, { placement: "belowEditor" });
	record({ event: "widget-registered", key: SENTINEL_KEY, placement: "belowEditor", loadCount });

	// Control channel: the runner writes {"cmd": ...}; the probe performs the
	// documented public operation and records its identity/sequence.
	let last = "";
	const timer = setInterval(() => {
		let text = "";
		try {
			text = readFileSync(CONTROL, "utf8");
		} catch {
			return;
		}
		if (text === last) return;
		last = text;
		let cmd: { cmd?: string } = {};
		try {
			cmd = JSON.parse(text) as { cmd?: string };
		} catch {
			return;
		}
		if (cmd.cmd === "reads") {
			const terminal = state.terminal as Record<string, unknown> | null;
			const before = state.renderPasses;
			const readsBefore = state.sizeReads;
			record({ event: "non-render-read-command", sizeReadsBefore: readsBefore, renderPassesBefore: before, rendererEpoch: state.rendererEpoch, loadCount });
			const columns = terminal === null ? null : (terminal as { columns?: unknown }).columns;
			const rows = terminal === null ? null : (terminal as { rows?: unknown }).rows;
			record({ event: "non-render-size-reads", columns: columns ?? null, rows: rows ?? null, sizeReadsBefore: readsBefore, sizeReadsAfter: state.sizeReads, renderPassesBefore: before, renderPassesAfter: state.renderPasses, rendererEpoch: state.rendererEpoch, loadCount });
			scheduleFence();
			return;
		}
		if (cmd.cmd === "open-stop-witness") {
			// REAL open-stop witness (parent decision 3). The candidate is created
			// only from public `columns`/`rows` getter reads (the same sampling pair a
			// scattered mouse/hover read produces), and the invalidation comes from the
			// ACTUAL public Terminal lifecycle: `terminal.stop()`, the very method the
			// renderer calls from `InteractiveMode.switchTuiMode()` (via
			// `previousUi.stop()`), invoked synchronously so the candidate cannot
			// complete first. No private callback, no fake renderer.
			const terminal = state.terminal as (Record<string, unknown> & { stop?: () => void; start?: () => void }) | null;
			if (terminal === null) {
				record({ event: "open-stop-witness", supported: false, reason: "no shared terminal instance", loadCount });
				return;
			}
			const frameBefore = state.frameIdCounter.value;
			const readsBefore = state.sizeReads;
			const columns = (terminal as { columns?: unknown }).columns;
			const rows = (terminal as { rows?: unknown }).rows;
			const openFrameId = state.evaluator.openFrameId;
			const sEmittedBeforeStop = openFrameId !== null && state.evaluator.log.some((decision) => decision.frameId === openFrameId && decision.kind === "S");
			const before = state.evaluator.log.length;
			terminal.stop?.();
			const produced = state.evaluator.log.slice(before);
			emitDecisions(produced, "open-stop-witness");
			const stopDecision = produced.at(-1) ?? null;
			const finishForFrame = state.evaluator.log.filter((decision) => decision.frameId === openFrameId && decision.kind === "F").length;
			record({
				event: "open-stop-witness",
				supported: true,
				openFrameId,
				sEmittedBeforeStop,
				stopDecisionKind: stopDecision?.kind ?? null,
				stopDecisionReason: stopDecision?.reason ?? null,
				stopDecisionFrameId: stopDecision?.frameId ?? null,
				decisionsForFrame: state.evaluator.log.filter((decision) => decision.frameId === openFrameId).map((decision) => ({ kind: decision.kind, reason: decision.reason })),
				finishForFrame,
				columns: columns ?? null,
				rows: rows ?? null,
				sizeReadsBefore: readsBefore,
				sizeReadsAfter: state.sizeReads,
				frameIdBefore: frameBefore,
				frameIdAfter: state.frameIdCounter.value,
				rendererEpoch: state.rendererEpoch,
				loadCount,
			});
			// The real `stop()` removes stdin listeners, so the session must not be
			// resumed here: restarting requires the renderer's own `start(onInput,
			// onResize)` handlers (a bare `start()` throws inside ProcessTerminal).
			// The witness cell therefore ends through a real graceful SIGTERM shutdown.
			phase = "stopped";
			state.stopped = true;
			restoreAllShadows("open-stop-witness");
			record({
				event: "open-stop-witness-resumed",
				resumed: false,
				reason: "real terminal.stop() removed stdin listeners; restart belongs to the renderer (switchTuiMode) and no key-driven step may follow",
				lastFrameId: state.frameIdCounter.value,
				rendererEpoch: state.rendererEpoch,
				loadCount,
			});
			return;
		}
		if (cmd.cmd === "overlay" && state.overlayDone === null) {
			record({ event: "overlay-open-request", rendererEpoch: state.rendererEpoch, loadCount });
			void ui.custom((tui: unknown, _theme: unknown, _kb: unknown, done: (value: unknown) => void) => {
				state.overlayDone = done;
				record({ event: "overlay-mounted", mode: (tui as { mode?: unknown }).mode ?? null, rendererEpoch: state.rendererEpoch, loadCount });
				return {
					render: (width: number): string[] => {
						record({ event: "overlay-render", width, rendererEpoch: state.rendererEpoch, loadCount });
						return [` probe-23a overlay ${"".padEnd(1)}`];
					},
					dispose: () => record({ event: "overlay-dispose", rendererEpoch: state.rendererEpoch, loadCount }),
				};
			});
			return;
		}
		if (cmd.cmd === "close-overlay" && state.overlayDone !== null) {
			const done = state.overlayDone;
			state.overlayDone = null;
			done({ closed: true });
			record({ event: "overlay-closed", rendererEpoch: state.rendererEpoch, loadCount });
			return;
		}
		if (cmd.cmd === "refresh-widget") {
			// Documented public re-registration: the factory receives the CURRENT
			// TUI reference, which is how the observed mode is re-measured after a
			// documented in-session `/settings` mode change.
			record({ event: "widget-refresh-request", rendererEpoch: state.rendererEpoch, loadCount });
			ui.setWidget(SENTINEL_KEY, sentinel, { placement: "belowEditor" });
			record({ event: "widget-refresh-done", mode: state.currentMode, rendererEpoch: state.rendererEpoch, staleTui: state.staleTui, loadCount });
			return;
		}
		if (cmd.cmd === "stop") {
			// Invalidation + restore-on-stop, with descriptor/ownership evidence.
			phase = "stopped";
			state.stopped = true;
			const decisionsBefore = state.evaluator.log.length;
			state.evaluator.stop();
			emitDecisions(state.evaluator.log.slice(decisionsBefore), "stop");
			record({ event: "probe-stop", renderPasses: state.renderPasses, rendererEpoch: state.rendererEpoch, loadCount });
			restoreAllShadows("stop-control");
			clearInterval(timer);
			// Logging stays writable: `session_shutdown` must be RECORDED, not inferred.
			return;
		}
	}, 100);
	timer.unref?.();
}
