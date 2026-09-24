#!/usr/bin/env node
/**
 * Detached PTY host runner.
 *
 * Owns one long-lived interactive Pi child, captures raw terminal output, and exposes
 * a small JSONL-over-Unix-socket protocol for live attach from the dashboard.
 * Uses node-pty when available; falls back to stdio pipes so tests and installs without
 * native deps still exercise the control protocol.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, readJson } from "../src/core/atomic.mjs";
import { appendDiagnostic } from "../src/core/diagnostics.mjs";
import { finalizeHostCrash } from "../src/core/host-crash.mjs";
import { ownsEndpoint, shouldYieldRunner } from "../src/core/host-coordination.mjs";
import { lastVisibleLogLine } from "../src/core/heuristics.mjs";
import { acquireOwnedViewLock } from "../src/core/locks.mjs";
import * as P from "../src/core/paths.mjs";
import { appendBoundedScreenLog, reconcileScreenLog } from "../src/core/screen-log.mjs";
import { createTerminalModel, feedOutput, resizeChildAndModel } from "../src/core/terminal-model.mjs";
import { createTerminalSubscription } from "../src/core/terminal-attach-protocol.mjs";
import { encodePromptForCliArg } from "../src/core/prompt-transport.mjs";
import {
	checkSeq,
	CONTROL_COMMAND_TYPES,
	createResizeTracker,
	journalAppendRecord,
	journalGc,
	journalUnresolved,
	JOURNAL_KEEP_DEFAULT,
	validateCommandEnvelope,
} from "../src/core/control-protocol.mjs";
import { readHost, readState, updateOwnedHost, writeHost } from "../src/core/store.mjs";
import { sendStateCommand } from "../src/core/coordinator-client.mjs";
import { classifyClientHello, helloBookkeeping } from "../src/core/host-protocol.mjs";
import { markRowFailedDirect } from "./pty-runner-legacy.mjs";
import { ensureNodePtySpawnHelperExecutable } from "../src/core/pty-support.mjs";

const requireForPty = createRequire(import.meta.url);

/** @type {any|null} */
let pty = null;
try {
	pty = await import("node-pty");
} catch {
	pty = null;
}

const HEARTBEAT_MS = 1000;
/** Service-input ack dedup bound (issue #70 Task 8): requestId → true, FIFO evict. */
const HOST_ACK_DEDUP_MAX = 1000;
/** Max time an owned runner waits to take the per-view host-start lease (issue #70). */
const HOST_RUNNER_LOCK_WAIT_MS = 5_000;
/** Boot identity for the control lifecycle (issue #91 phase 5, spec D4 generation
 *  token): one runner process = one generation. Clients detect a runner
 *  replacement by the generation changing, which structurally disambiguates a
 *  reconnect ring-replay from a fresh child (phase 4 epoch ambiguity). */
const GENERATION = randomUUID();
/** GC trigger: rewrite the journal when records exceed 2× the keep bound.
 *  Append-only between rewrites, so the common path stays O(1) per command. */
const JOURNAL_GC_TRIGGER = JOURNAL_KEEP_DEFAULT * 2;
/** How much of the screen.log tail to scan when attributing an abnormal child
 *  exit (issue #90). Tail-only: the log can be 100MB+. */
const EXIT_LOG_TAIL_BYTES = 8_192;

/** Tail-read the last `maxBytes` of a file without loading it whole.
 * @param {string} path
 * @param {number} maxBytes
 * @returns {string}
 */
function readScreenLogTail(path, maxBytes) {
	let fd;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		const buffer = Buffer.allocUnsafe(length);
		readSync(fd, buffer, 0, length, start);
		return buffer.toString("utf8");
	} finally {
		try { if (fd != null) closeSync(fd); } catch { /* best effort */ }
	}
}

/**
 * Best-effort error attribution for an abnormal child exit (issue #90): the
 * child's failure reason (e.g. "Model X not found") exists only in the raw
 * screen log, so surface its last visible line in host.json.error. Never
 * throws — this runs on the exit path.
 * @param {number} exitCode
 * @param {string} screenLogPath
 * @returns {{} | { error: string }}
 */
function attributedExitError(exitCode, screenLogPath) {
	if (exitCode === 0) return {};
	try {
		const line = lastVisibleLogLine(readScreenLogTail(screenLogPath, EXIT_LOG_TAIL_BYTES));
		return line ? { error: line } : {};
	} catch {
		return {};
	}
}

function main() {
	const configPath = process.argv[2];
	if (!configPath) failEarly("pty-runner: missing config path");
	/** @type {import("../src/core/types.mjs").HostConfig|null} */
	const config = readJson(configPath, null);
	if (!config) failEarly(`pty-runner: cannot read config ${configPath}`);
	// New ownership protocol (issue #70): instance-scoped config selects the fenced
	// path. Legacy configs (no instanceId) keep the historical behavior unchanged.
	if (config.instanceId) {
		// A mid-flight throw in ownedMain must still terminate the process — the
		// runner is detached with ignored stdio; an unhandled rejection would hang it.
		ownedMain(config).catch(() => process.exit(1));
		return;
	}
	legacyMain(config);
}

function legacyMain(config) {
	const socketPath = P.controlSocketPath(config.root, config.viewId);
	const screenLog = P.screenLogPath(config.root, config.viewId);
	// Optional per-install cap override from launch prefs (screenLogMaxSize).
	// undefined → screen-log.mjs falls back to its built-in default.
	const screenLogMaxBytes =
		Number.isFinite(config.screenLogMaxBytes) && config.screenLogMaxBytes > 0
			? Math.floor(config.screenLogMaxBytes)
			: undefined;
	const screenLogLimits = { maxBytes: screenLogMaxBytes };
	let screenLogBytes = reconcileScreenLog(screenLog, screenLogLimits);
	try {
		if (existsSync(socketPath)) unlinkSync(socketPath);
	} catch {}

	/** @type {Set<import("node:net").Socket>} */
	const clients = new Set();
	/** Resident editor-state reporters: connected but never "attached" (#103). */
	const editorReporters = new Set();
	let childPid = null;
	let child = null;
	let exitCode = null;
	let shutdownStarted = false;
	let shutdownExitCode = null;
	let childExited = false;
	let resolveChildExit;
	const childExitPromise = new Promise((resolve) => {
		resolveChildExit = resolve;
	});
	// Set when the uncaughtException crash handler finalizes the host. Guards
	// child.onExit against clobbering the persisted "failed" state with an
	// "exited" update (the handler kills the child, so its exit callback fires
	// inside the 50ms flush window — CR round-1, issue #48).
	let crashed = false;
	/** Authoritative child editor emptiness, pushed by the child Pi extension
	 * (issue #68). null = unknown (extension missing / not yet reported). */
	let editorEmpty = null;
	/** @type {import("../src/core/types.mjs").HostStatus} */
	let host = {
		version: 1,
		viewId: config.viewId,
		mode: "pty",
		runnerPid: process.pid,
		childPid: null,
		socketPath,
		state: "starting",
		startedAt: Date.now(),
		lastSeenAt: Date.now(),
		endedAt: null,
		exitCode: null,
		error: null,
		cols: config.cols || 120,
		rows: config.rows || 36,
		attachedClients: 0,
		attachedEver: false,
		revision: 0,
	};
	// Canonical terminal model + per-socket snapshot subscriptions (issue #91
	// phase 3). Fed from child.onData alongside the legacy screen.log/broadcast
	// path; legacy message semantics unchanged (the `seq` field is additive).
	const terminalModel = createTerminalModel({ cols: host.cols, rows: host.rows, scrollback: 2000 });
	/** @type {Map<import("node:net").Socket, ReturnType<typeof createTerminalSubscription>>} */
	const terminalSubscriptions = new Map();
	// Control lifecycle runtime (issue #91 phase 5). instanceId is null in this
	// legacy-mode main: no instance fence exists, so EVERY envelope claims a
	// foreign instance and is rejected with `instance_mismatch` (documented
	// contract — legacy-mode hosts serve only envelope-less clients).
	const control = createControlRuntime({
		viewId: config.viewId,
		root: config.root,
		instanceId: null,
		send,
		diag: (code, message, details) => {
			try {
				appendDiagnostic(config.root, config.viewId, { source: "runner", code, message, ...(details ? { details } : {}) });
			} catch {
				/* diagnostics must never kill the host */
			}
		},
		actions: {
			childReady: () => Boolean(child),
			writeInput: (data) => {
				child.write(data);
			},
			hostCols: () => host.cols,
			hostRows: () => host.rows,
			applyResize: (cols, rows) => {
				resizeChildAndModel(child, terminalModel, cols, rows);
				update({ cols, rows });
			},
			currentDims: () => ({ cols: terminalModel.cols, rows: terminalModel.rows }),
			applyInterrupt: () => {
				if (child) child.write("\x1b");
			},
			applyTerminate: () => {
				killChild(child, childPid, "SIGTERM");
				setTimeout(() => killChild(child, childPid, "SIGKILL"), 4000).unref?.();
			},
			applyDetach: (s) => {
				s.end();
			},
			hostRevision: () => host.revision ?? 0,
			cursor: () => ({ lastSeq: terminalModel.lastSeq, cols: terminalModel.cols, rows: terminalModel.rows }),
			stateStamp: () => readState(config.root, config.viewId)?.materializedRevision ?? null,
		},
	});
	/** Persist host.json. A transient failure (e.g. Windows rename EPERM racing a
	 *  reader) must degrade, not kill the host: record a diagnostic and let the
	 *  next heartbeat tick retry. Socket protocol is the attach main channel, so
	 *  host.json being briefly stale is acceptable. */
	const persist = () => {
		try {
			writeHost(config.root, host);
		} catch (err) {
			try {
				appendDiagnostic(config.root, config.viewId, {
					source: "runner",
					level: "error",
					code: "persist_error",
					message: err instanceof Error ? err.message : String(err),
				});
			} catch { /* diagnostics must never kill the host either */ }
		}
	};
	const broadcast = (msg) => {
		const line = JSON.stringify(msg) + "\n";
		for (const c of clients) c.write(line);
	};
	const update = (patch = {}) => {
		host = { ...host, ...patch, revision: (host.revision ?? 0) + 1, lastSeenAt: Date.now(), attachedClients: clients.size };
		persist();
		broadcast({ type: "status", status: host, generation: GENERATION });
	};
	persist();

	// Last-resort crash path (registered early, before spawnInteractive, so any
	// early synchronous failure is also covered): the runner is launched detached
	// with stdio ignored, so an uncaught exception is otherwise completely silent —
	// no host.json finalize, no exit message, and the attach view reconnects
	// forever. Record diagnostics, finalize the host as failed, and broadcast exit
	// so attached clients can leave the view instead of looping.
	process.on("uncaughtException", (err) => {
		process.removeAllListeners("uncaughtException");
		try {
			appendDiagnostic(config.root, config.viewId, {
				source: "runner",
				level: "error",
				code: "runner_crash",
				message: err instanceof Error ? err.message : String(err),
				details: { stack: err instanceof Error ? err.stack : undefined },
			});
		} catch { /* best effort */ }
		crashed = true;
		host = finalizeHostCrash(config.root, config.viewId, host, err);
		try {
			broadcast({ type: "exit", exitCode: 1 });
		} catch { /* best effort */ }
		try { if (child) killChild(child, childPid, "SIGTERM"); } catch { /* best effort */ }
		setTimeout(() => process.exit(1), 50).unref?.();
	});

	const args = [...config.piArgsPrefix, "--session", config.sessionFile];
	if (config.model) args.push("--model", config.model);
	if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
	if (config.tools) args.push("--tools", config.tools);
	if (config.initialPrompt) args.push(encodePromptForCliArg(config.initialPrompt));

	const env = {
		...process.env,
		...(config.env || {}),
		AGENT_BOARD_ROOT: config.root,
		AGENT_BOARD_VIEW_ID: config.viewId,
		AGENT_BOARD_CHILD: "1",
		AGENT_BOARD_HOSTED: "pty",
		// The endpoint this host actually bound: the child's editor-state reporter
		// dials it instead of guessing the stable per-view address (issue #103).
		AGENT_BOARD_CONTROL_SOCKET: socketPath,
		// Legacy names are exported too so older child extension builds still behave.
		AGENT_VIEW_ROOT: config.root,
		AGENT_VIEW_VIEW_ID: config.viewId,
		AGENT_VIEW_CHILD: "1",
		AGENT_VIEW_HOSTED: "pty",
	};

	try {
		child = spawnInteractive(config.piCommand, args, {
			cwd: config.cwd,
			env,
			cols: host.cols,
			rows: host.rows,
			allowPipeFallback: config.env?.AGENT_BOARD_ALLOW_PIPE_FALLBACK === "1" || config.env?.AGENT_VIEW_ALLOW_PIPE_FALLBACK === "1",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		update({ state: "failed", endedAt: Date.now(), exitCode: 1, error: message });
		// The command settles within the client's own timeout (never throws), so
		// the exit stays bounded while the fenced write gets its chance. Return
		// instead of falling through: child is null here and the rest of this
		// function assumes a spawned child.
		void markRowFailed(config.root, config.viewId, `PTY host failed: ${message}`).finally(() => process.exit(1));
		return;
	}
	childPid = child.pid ?? null;
	update({ childPid });

	child.onData((data) => {
		screenLogBytes = appendBoundedScreenLog(screenLog, data, screenLogBytes, screenLogLimits);
		const outputSeq = feedOutput(terminalModel, data);
		// Per-socket output delivery (issue #91 phase 3): sockets that speak the
		// subscribe_terminal protocol get exactly-once, gap-checked chunks from
		// their subscription state machine; every other client keeps the legacy
		// fire-and-forget broadcast (additive seq). Both streams to one socket
		// would duplicate every chunk.
		const outputLine = JSON.stringify({ type: "output", seq: outputSeq, data }) + "\n";
		for (const [socket, sub] of terminalSubscriptions) {
			if (sub.subscribed()) sub.onOutput(outputSeq, data);
			// Per-socket guard: a synchronous throw from a dead socket must never
			// escape into the uncaughtException crash path (whole-branch review).
			else { try { socket.write(outputLine); } catch { /* 'error' handler cleans up */ } }
		}
	});
	child.onExit((code) => {
		childExited = true;
		resolveChildExit?.();
		exitCode = code ?? 0;
		// Terminate lifecycle (spec D4): a confirmed child exit is the observed
		// evidence for any enveloped terminate still pending on a live socket.
		control.flushTerminateObservations(exitCode, false);
		// After a crash the handler already persisted "failed" and broadcast
		// exit; this callback must not overwrite that state.
		if (!crashed) {
			// Attribute only a NATURAL abnormal exit (issue #90): after a deliberate
			// stop (shutdownStarted) the child was killed by us — no error line.
			update({ state: "exited", endedAt: Date.now(), exitCode, childPid: null, ...(shutdownStarted ? {} : attributedExitError(exitCode, screenLog)) });
			editorEmpty = null;
			broadcast({ type: "editor_state", empty: null });
			broadcast({ type: "exit", exitCode });
		}
		if (!shutdownStarted) setTimeout(() => process.exit(exitCode ?? 0), 50).unref?.();
	});
	child.onError((err) => {
		update({ state: "failed", endedAt: Date.now(), exitCode: 1, error: err instanceof Error ? err.message : String(err) });
		broadcast({ type: "error", message: host.error || "child error" });
		void shutdown(1);
	});

	let server;
	server = createServer((socket) => {
		clients.add(socket);
		terminalSubscriptions.set(
			socket,
			createTerminalSubscription({ model: terminalModel, send: (msg) => send(socket, msg), generation: GENERATION }),
		);
		socket.write(JSON.stringify({ type: "hello", status: host, editorEmpty, generation: GENERATION }) + "\n");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleClientLine(line, socket);
		});
		socket.on("close", () => {
			clients.delete(socket);
			editorReporters.delete(socket);
			terminalSubscriptions.delete(socket);
			control.closeSocket(socket);
			update();
		});
		socket.on("error", () => {
			clients.delete(socket);
			editorReporters.delete(socket);
			terminalSubscriptions.delete(socket);
			control.closeSocket(socket);
			update();
		});
	});
	server.on("error", (err) => {
		update({ state: "failed", endedAt: Date.now(), error: err instanceof Error ? err.message : String(err), exitCode: 1 });
		void shutdown(1);
	});
	server.listen(socketPath, () => update({ socketPath, state: "alive" }));

	function handleClientLine(line, socket) {
		if (!line.trim()) return;
		let msg;
		try { msg = JSON.parse(line); } catch { return send(socket, { type: "error", message: "invalid json" }); }
		// Enveloped control commands take the phase-5 lifecycle path; everything
		// else (no commandId, or a non-control type carrying one) falls through to
		// the legacy switch byte-identically.
		const envelope = validateCommandEnvelope(msg);
		if (envelope.enveloped && CONTROL_COMMAND_TYPES.includes(msg.type)) {
			control.handle(msg, socket, envelope);
			return;
		}
		switch (msg.type) {
			case "hello": {
				// Bookkeeping-only clients must never pin the host against warm-host
				// reclaim (issue #103 §C / #130): probes are read-only and transient,
				// the editor reporter is resident. Both leave `clients` — the sole
				// source of `attachedClients` — while their socket stays writable so
				// probe replies and editor_state keep flowing. The policy lives in
				// `helloBookkeeping`, so this path and the owned one cannot drift.
				const book = helloBookkeeping(classifyClientHello(msg));
				if (!book.keepInClients) {
					clients.delete(socket);
					terminalSubscriptions.delete(socket);
				}
				if (book.registerReporter) editorReporters.add(socket);
				if (book.flipAttachedEver) update({ attachedEver: true });
				else if (book.persist) update();
				send(socket, { type: "hello", status: host, editorEmpty, generation: GENERATION });
				break;
			}
			case "input":
				if (typeof msg.data === "string") child.write(msg.data);
				break;
			case "resize": {
				const cols = clampInt(msg.cols, 20, 300, host.cols);
				const rows = clampInt(msg.rows, 5, 120, host.rows);
				// Paired step (CR R1 advisory): model reflows only when the real PTY
				// resize succeeded. host.cols/rows keep recording the intended size
				// (new-client clamp baseline), deliberately outside the guard.
				resizeChildAndModel(child, terminalModel, cols, rows);
				update({ cols, rows });
				break;
			}
			case "interrupt":
				child.write("\x1b");
				break;
			case "subscribe_terminal":
				terminalSubscriptions.get(socket)?.handleMessage(msg);
				break;
			case "terminate": {
				killChild(child, childPid, "SIGTERM");
				setTimeout(() => killChild(child, childPid, "SIGKILL"), 4000).unref?.();
				break;
			}
			case "detach":
				socket.end();
				break;
			case "get_status":
				send(socket, { type: "status", status: host, generation: GENERATION });
				break;
			case "editor_state": {
				editorEmpty = typeof msg.empty === "boolean" ? msg.empty : null;
				broadcast({ type: "editor_state", empty: editorEmpty });
				break;
			}
		}
	}

	const heartbeat = setInterval(() => {
		if (host.state === "alive") update();
	}, HEARTBEAT_MS);
	heartbeat.unref?.();

	function waitForChildExit(timeoutMs) {
		if (childExited) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			let timer;
			const finish = (exited) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(exited);
			};
			timer = setTimeout(() => finish(false), timeoutMs);
			childExitPromise.then(() => finish(true));
		});
	}

	async function shutdown(requestedExitCode = null) {
		if (requestedExitCode !== null) shutdownExitCode = requestedExitCode;
		if (shutdownStarted) return;
		shutdownStarted = true;
		// Terminate lifecycle (spec D4): pending enveloped terminates get the
		// runner-finalizing evidence before sockets end (exit-confirm flush in
		// child.onExit covers the natural path; this covers deliberate shutdown).
		control.flushTerminateObservations(null, true);
		try { server?.close(); } catch {}
		try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch {}
		for (const client of clients) {
			try { client.end(); } catch {}
		}
		for (const reporter of editorReporters) {
			try { reporter.end(); } catch { /* best effort */ }
		}
		editorReporters.clear();
		killChild(child, childPid, "SIGTERM");
		if (!(await waitForChildExit(4000)) && !childExited) {
			killChild(child, childPid, "SIGKILL");
			if (!(await waitForChildExit(1000)) && !childExited) {
				// The child abstraction has no portable liveness probe. Exit only
				// after the escalation window so normal children are always awaited;
				// an unkillable platform child is left to the OS.
				process.exit(1);
			}
		}
		process.exit(shutdownExitCode ?? exitCode ?? 0);
	}
	process.on("SIGTERM", () => { void shutdown(); });
	process.on("SIGINT", () => { void shutdown(); });
}

/**
 * New-protocol host runner (issue #70).
 *
 * Runs only for instance-scoped configs. The lifecycle is fenced by an
 * `instanceId` owner token and the per-view `host-start` lease:
 *   lease → ownership decision → bind UNIQUE endpoint → publish runner identity
 *   → spawn child → publish ready → release lease → heartbeat.
 * All exits funnel through finishHost(), which writes only while the instance
 * still owns host.json and unlinks only the exact socket inode it bound.
 * @param {import("../src/core/types.mjs").HostConfig & { instanceId: string }} config
 */
async function ownedMain(config) {
	if (!config.socketPath) failEarly("pty-runner: owned config missing socketPath");
	const socketPath = config.socketPath;
	const screenLog = P.screenLogPath(config.root, config.viewId);
	const screenLogMaxBytes =
		Number.isFinite(config.screenLogMaxBytes) && config.screenLogMaxBytes > 0
			? Math.floor(config.screenLogMaxBytes)
			: undefined;
	const screenLogLimits = { maxBytes: screenLogMaxBytes };
	let screenLogBytes = reconcileScreenLog(screenLog, screenLogLimits);

	/** @type {Set<import("node:net").Socket>} */
	const clients = new Set();
	/** Resident editor-state reporters: connected but never "attached" (#103). */
	const editorReporters = new Set();
	let childPid = null;
	let child = null;
	let exitCode = null;
	let childExited = false;
	let resolveChildExit;
	const childExitPromise = new Promise((resolve) => {
		resolveChildExit = resolve;
	});
	/** {dev,ino} recorded at bind time; cleanup unlinks only this exact inode. */
	let boundSocketIdentity = null;
	/** Set once THIS process published its runner identity into the record —
	 * only then may finishHost write host state. A same-instance duplicate that
	 * dies at listen (EADDRINUSE) shares the fencing token but never took the
	 * record, so it must leave the winner's state untouched (issue #70). */
	let claimedRecord = false;
	let shutdownStarted = false;
	/** Authoritative child editor emptiness (issue #68); null = unknown. */
	let editorEmpty = null;
	/** In-memory snapshot of the owned host record, refreshed on every owned write. */
	let host = readHost(config.root, config.viewId);
	/** @type {{ token: string, touch(): boolean, isOwner(): boolean, release(): boolean } | null} */
	let startLease = null;
	let startTouchTimer = null;
	let heartbeatTimer = null;
	let server = null;
	/** Service-input ack dedup: requestId → true. FIFO-capped at
	 *  HOST_ACK_DEDUP_MAX. Interactive UI keystrokes (no requestId) bypass it. */
	const ackedRequestIds = new Map();
	/** Last {cols, rows} held while the child does not exist yet; applied when
	 *  ready is published (issue #70 §6.3 starting protocol). */
	let cachedResize = null;

	const diag = (code, message, details) => {
		try {
			appendDiagnostic(config.root, config.viewId, {
				source: "runner",
				code,
				message,
				...(details ? { details } : {}),
			});
		} catch { /* best effort */ }
	};
	const broadcast = (msg) => {
		const line = JSON.stringify(msg) + "\n";
		for (const c of clients) {
			try { c.write(line); } catch { /* best effort */ }
		}
	};
	/** Owner-fenced host write; refreshes the in-memory snapshot. */
	const ownedUpdate = (mutate) => {
		const result = updateOwnedHost(config.root, config.viewId, config.instanceId, (cur) => {
			const next = mutate(cur);
			// Record revision (phase 5 reconcile baseline): every committed fenced
			// write bumps it, heartbeats included — a client comparing revisions
			// sees any host-record movement, which is exactly the contract.
			return { ...next, revision: (cur.revision ?? 0) + 1, lastSeenAt: Date.now(), attachedClients: clients.size };
		});
		if (result.updated && result.host) host = result.host;
		return result;
	};
	const isOwnerNow = () => {
		const h = readHost(config.root, config.viewId);
		return Boolean(h && h.instanceId === config.instanceId);
	};
	const releaseStartLease = () => {
		if (startTouchTimer) {
			clearInterval(startTouchTimer);
			startTouchTimer = null;
		}
		const lease = startLease;
		startLease = null;
		try { lease?.release(); } catch { /* best effort */ }
	};

	function waitForChildExit(timeoutMs) {
		if (childExited) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			let timer;
			const finish = (exited) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(exited);
			};
			timer = setTimeout(() => finish(false), timeoutMs);
			childExitPromise.then(() => finish(true));
		});
	}

	/** Reasons that finalize as `failed` rather than `exited`. */
	const FAILED_REASONS = new Set(["server_error", "child_error", "crash", "child_spawn_failed", "endpoint_busy"]);

	/**
	 * Idempotent unified finish: fenced terminal write, bounded server close,
	 * child exit with escalation, inode-owned socket cleanup, config cleanup.
	 * @param {string} reason
	 * @param {number|null} [requestedExitCode]
	 */
	async function finishHost(reason, requestedExitCode = null) {
		if (shutdownStarted) return;
		shutdownStarted = true;
		// Terminate lifecycle (spec D4): pending enveloped terminates get the
		// runner-finalizing evidence before teardown ends sockets. The child-exit
		// flush (exitConfirmed) normally wins the race; whichever fires first
		// clears the pending set, so exactly one observed ack goes out.
		control.flushTerminateObservations(null, true);
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
		// Only the runner that actually claimed the record writes terminal state; a
		// superseded owner (or a duplicate that never claimed) never writes.
		if (claimedRecord && reason !== "owner_lost" && isOwnerNow()) {
			ownedUpdate((cur) => ({ ...cur, state: "stopping", stopReason: reason }));
			broadcast({ type: "status", status: host, generation: GENERATION });
		}
		try { broadcast({ type: "exit", exitCode: requestedExitCode ?? exitCode ?? 0 }); } catch { /* best effort */ }
		for (const c of clients) {
			try { c.destroy(); } catch { /* best effort */ }
		}
		clients.clear();
		for (const reporter of editorReporters) {
			try { reporter.destroy(); } catch { /* best effort */ }
		}
		editorReporters.clear();
		// Bounded server close (1s): never let a stuck client block cleanup.
		await new Promise((resolve) => {
			if (!server) return resolve();
			let settled = false;
			const done = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			const timer = setTimeout(done, 1000);
			server.close(() => {
				clearTimeout(timer);
				done();
			});
		});
		if (child && !childExited) {
			killChild(child, childPid, "SIGTERM");
			if (!(await waitForChildExit(4000)) && !childExited) {
				killChild(child, childPid, "SIGKILL");
				await waitForChildExit(1000);
			}
		}
		if (claimedRecord && reason !== "owner_lost" && isOwnerNow()) {
			const failed = FAILED_REASONS.has(reason);
			ownedUpdate((cur) => ({
				...cur,
				state: failed ? "failed" : "exited",
				endedAt: Date.now(),
				exitCode: requestedExitCode ?? exitCode ?? 0,
				childPid: null,
				readyAt: null,
				stopRequestedAt: null,
				stopReason: reason,
				// Attribute abnormal NATURAL child exits only (issue #90): reason
				// "child_exit" with a non-zero code. Stops ("signal") and crashes
				// have their own attribution (stopReason / crash finalize), and a
				// SIGTERM'd healthy child must not capture a junk error line.
				...(reason === "child_exit" && cur.error == null
					? attributedExitError(requestedExitCode ?? exitCode ?? 0, screenLog)
					: {}),
			}));
		}
		// Endpoint cleanup: only the exact inode this instance bound.
		if (process.platform !== "win32" && boundSocketIdentity) {
			try {
				const st = statSync(socketPath);
				if (ownsEndpoint(boundSocketIdentity, { dev: st.dev, ino: st.ino })) {
					try { unlinkSync(socketPath); } catch { /* best effort */ }
				}
			} catch { /* path gone — nothing to clean */ }
		}
		// Best-effort config cleanup (instance-scoped file only).
		try {
			if (config.configPath && config.instanceId && config.configPath.includes(config.instanceId)) {
				unlinkSync(config.configPath);
			}
		} catch { /* best effort */ }
		releaseStartLease();
		process.exit(requestedExitCode ?? exitCode ?? 0);
	}

	// Bounded finish: a mid-finish throw must still exit the process (the runner
	// is detached; an unhandled rejection inside finishHost would otherwise hang).
	const finish = (reason, requestedExitCode = null) => {
		finishHost(reason, requestedExitCode).catch(() => process.exit(1));
	};

	process.on("SIGTERM", () => { finish("signal"); });
	process.on("SIGINT", () => { finish("signal"); });
	process.on("uncaughtException", (err) => {
		process.removeAllListeners("uncaughtException");
		const message = err instanceof Error ? err.message : String(err);
		diag("runner_crash", message, { stack: err instanceof Error ? err.stack : undefined });
		// Crash finalize is owner-fenced via the expected-instance path in
		// finalizeHostCrash: a superseded owner must not clobber the replacement's
		// record (it records host_crash_owner_changed instead of writing).
		host = finalizeHostCrash(config.root, config.viewId, host, err, { expectedInstanceId: config.instanceId });
		finish("crash", 1);
	});

	// 1. Take the per-view host-start lease — the launch transaction boundary.
	try {
	startLease = acquireOwnedViewLock(config.root, config.viewId, "host-start", {
			waitMs: HOST_RUNNER_LOCK_WAIT_MS,
			identity: { pid: process.pid, startToken: captureStartToken(process.pid) },
		});
	} catch (err) {
		diag("host_start_lock_timeout", err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	startTouchTimer = setInterval(() => {
		try { startLease?.touch(); } catch { /* best effort */ }
	}, HEARTBEAT_MS);
	startTouchTimer.unref?.();

	// 2. Ownership decision inside the lease: never write host.json on the yield paths.
	const current = readHost(config.root, config.viewId);
	if (shouldYieldRunner({ host: current, instanceId: config.instanceId })) {
		diag("host_start_yielded", "host record belongs to another active instance", { recordInstance: current?.instanceId ?? null });
		releaseStartLease();
		process.exit(0);
	}
	if (!current || current.instanceId !== config.instanceId) {
		diag("host_start_stale_record", "no matching host claim for this instance", { recordInstance: current?.instanceId ?? null });
		releaseStartLease();
		process.exit(0);
	}
	// Own-terminal record: this instance already finished once (e.g. the prior
	// runner of the SAME instance exited after claiming). Continuing would
	// re-publish exited→starting and re-deliver initialPrompt — exit instead.
	if (current.state === "exited" || current.state === "failed") {
		diag("host_start_own_terminal", "host record for this instance is already terminal");
		releaseStartLease();
		process.exit(0);
	}
	if (current.state === "stopping" || current.stopRequestedAt != null) {
		diag("host_start_revoked", "host claim was revoked before this runner started");
		releaseStartLease();
		process.exit(0);
	}
	host = current;

	// Canonical terminal model + per-socket snapshot subscriptions (issue #91
	// phase 3). Created from the owned host record before the endpoint binds,
	// so every connect (including probes) can carry a subscription. Legacy
	// message semantics unchanged (the `seq` field on output is additive).
	const terminalModel = createTerminalModel({ cols: host.cols, rows: host.rows, scrollback: 2000 });
	/** @type {Map<import("node:net").Socket, ReturnType<typeof createTerminalSubscription>>} */
	const terminalSubscriptions = new Map();
	// Control lifecycle runtime (issue #91 phase 5). Created after the terminal
	// model (actions close over it) and BEFORE the endpoint binds, so the durable
	// journal is loaded from disk before any client can reconcile. The action
	// closures read `child`/`host` at call time (both are let-bound above).
	const control = createControlRuntime({
		viewId: config.viewId,
		root: config.root,
		instanceId: config.instanceId,
		send,
		diag,
		actions: {
			childReady: () => Boolean(child),
			writeInput: (data) => {
				child.write(data);
			},
			hostCols: () => host.cols,
			hostRows: () => host.rows,
			applyResize: (cols, rows) => {
				// The runtime pre-checks childReady (host_starting reply otherwise),
				// so this only runs against a live child — the starting window's
				// cachedResize path belongs exclusively to the legacy switch below.
				// Paired step (CR R1 advisory): model reflows only when the real
				// PTY resize succeeded; cachedResize cleared either way — a failed
				// resize is not retried against a exiting child.
				resizeChildAndModel(child, terminalModel, cols, rows);
				notifyChildResize(childPid);
				cachedResize = null;
				ownedUpdate((cur) => ({ ...cur, cols, rows }));
			},
			currentDims: () => ({ cols: terminalModel.cols, rows: terminalModel.rows }),
			applyInterrupt: () => {
				if (child) child.write("\x1b");
			},
			applyTerminate: () => {
				// Single exit path: finishHost carries the SIGTERM→4s→SIGKILL ladder,
				// so a SIGTERM-immune child still terminates within a bounded window.
				// The applied ack was already sent by the runtime BEFORE this hook.
				finish("terminated", 0);
			},
			applyDetach: (s) => {
				s.end();
			},
			hostRevision: () => host.revision ?? 0,
			cursor: () => ({ lastSeq: terminalModel.lastSeq, cols: terminalModel.cols, rows: terminalModel.rows }),
			stateStamp: () => readState(config.root, config.viewId)?.materializedRevision ?? null,
		},
	});

	// 3. Bind the per-instance endpoint. NO unlink: the path is unique to this
	//    instance; an occupied path means someone else owns it.
	const listenOutcome = await new Promise((resolveListen) => {
		const onError = (err) => resolveListen({ ok: false, error: err });
		// Probe connections (clientId:"probe" hello) must not write host.json: the
		// attach resolver's 150ms probe loop would amplify fenced writes and flip
		// attachedEver with no client ever attached (CR round-1 finding 3).
		const probeSockets = new WeakSet();
		server = createServer((socket) => {
			clients.add(socket);
			terminalSubscriptions.set(
				socket,
				createTerminalSubscription({ model: terminalModel, send: (msg) => send(socket, msg), generation: GENERATION }),
			);
			socket.write(JSON.stringify({ type: "hello", status: host, editorEmpty, generation: GENERATION }) + "\n");
			broadcast({ type: "status", status: host, generation: GENERATION });
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handleClientLine(line, socket);
			});
			socket.on("close", () => {
				clients.delete(socket);
				editorReporters.delete(socket);
				terminalSubscriptions.delete(socket);
				control.closeSocket(socket);
				if (probeSockets.has(socket)) return;
				// Merge into the live record (a stale closure spread here erases a
				// concurrent revoke — final review finding 2).
				ownedUpdate((cur) => ({ ...cur }));
			});
			socket.on("error", () => {
				clients.delete(socket);
				editorReporters.delete(socket);
				terminalSubscriptions.delete(socket);
				control.closeSocket(socket);
				if (probeSockets.has(socket)) return;
				ownedUpdate((cur) => ({ ...cur }));
			});
			socket.markProbe = () => probeSockets.add(socket);
		});
		server.once("error", onError);
		server.listen(socketPath, () => {
			server?.removeListener("error", onError);
			resolveListen({ ok: true });
		});
	});
	if (!listenOutcome.ok) {
		diag("host_endpoint_busy", listenOutcome.error instanceof Error ? listenOutcome.error.message : String(listenOutcome.error));
		await finishHost("endpoint_busy", 1);
		return;
	}
	server.on("error", (err) => {
		diag("server_error", err instanceof Error ? err.message : String(err));
		finish("server_error", 1);
	});
	// POSIX: record the exact inode we bound — cleanup matches dev+ino.
	if (process.platform !== "win32") {
		try {
			const st = statSync(socketPath);
			boundSocketIdentity = { dev: st.dev, ino: st.ino };
		} catch { /* without the identity, cleanup degrades to no-op */ }
	}

	// 4. Publish runner identity while still holding the lease.
	const claimedSelf = ownedUpdate((cur) => ({
		...cur,
		runnerPid: process.pid,
		runnerIdentity: { pid: process.pid, startToken: captureStartToken(process.pid) },
		runnerSpawnedAt: cur.runnerSpawnedAt ?? Date.now(),
		state: cur.state === "alive" ? "alive" : "starting",
	}));
	if (!claimedSelf.updated) {
		await finishHost("owner_lost", 0);
		return;
	}
	claimedRecord = true;
	broadcast({ type: "status", status: host, generation: GENERATION });

	// Test seam (issue #70 Task 8): a config-level delay between publishing the
	// runner identity and spawning the child creates a REAL starting window
	// (endpoint accepting, child null) so the starting protocol is testable.
	// Only host configs written by tests set this env; the service never does.
	const spawnDelayMs = Number(config.env?.AGENT_BOARD_TEST_SPAWN_DELAY_MS || 0);
	if (spawnDelayMs > 0) await new Promise((r) => { setTimeout(r, spawnDelayMs).unref?.(); });

	// 5. Spawn the child — only after the endpoint is bound and owned.
	const args = [...config.piArgsPrefix, "--session", config.sessionFile];
	if (config.model) args.push("--model", config.model);
	if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
	if (config.tools) args.push("--tools", config.tools);
	if (config.initialPrompt) args.push(encodePromptForCliArg(config.initialPrompt));
	const env = {
		...process.env,
		...(config.env || {}),
		AGENT_BOARD_ROOT: config.root,
		AGENT_BOARD_VIEW_ID: config.viewId,
		AGENT_BOARD_CHILD: "1",
		AGENT_BOARD_HOSTED: "pty",
		// The endpoint this host actually bound: the child's editor-state reporter
		// dials it instead of guessing the stable per-view address (issue #103).
		AGENT_BOARD_CONTROL_SOCKET: socketPath,
		// Legacy names are exported too so older child extension builds still behave.
		AGENT_VIEW_ROOT: config.root,
		AGENT_VIEW_VIEW_ID: config.viewId,
		AGENT_VIEW_CHILD: "1",
		AGENT_VIEW_HOSTED: "pty",
	};
	try {
		child = spawnInteractive(config.piCommand, args, {
			cwd: config.cwd,
			env,
			cols: host.cols,
			rows: host.rows,
			allowPipeFallback: config.env?.AGENT_BOARD_ALLOW_PIPE_FALLBACK === "1" || config.env?.AGENT_VIEW_ALLOW_PIPE_FALLBACK === "1",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		diag("child_spawn_failed", message);
		await markRowFailed(config.root, config.viewId, `PTY host failed: ${message}`);
		await finishHost("child_spawn_failed", 1);
		return;
	}
	childPid = child.pid ?? null;
	child.onData((data) => {
		screenLogBytes = appendBoundedScreenLog(screenLog, data, screenLogBytes, screenLogLimits);
		const outputSeq = feedOutput(terminalModel, data);
		// Per-socket output delivery — same contract as legacyMain above.
		const outputLine = JSON.stringify({ type: "output", seq: outputSeq, data }) + "\n";
		for (const [socket, sub] of terminalSubscriptions) {
			if (sub.subscribed()) sub.onOutput(outputSeq, data);
			// Same per-socket guard the legacy broadcast had: a synchronous throw
			// from a dead socket must never escape into the uncaughtException
			// crash path (whole-branch review finding).
			else { try { socket.write(outputLine); } catch { /* socket 'error' handler cleans up */ } }
		}
	});
	child.onExit((code) => {
		childExited = true;
		resolveChildExit?.();
		exitCode = code ?? 0;
		// Terminate lifecycle (spec D4): a confirmed child exit is the observed
		// evidence for any enveloped terminate still pending — flush before the
		// finish teardown ends the client sockets.
		control.flushTerminateObservations(exitCode, false);
		editorEmpty = null;
		broadcast({ type: "editor_state", empty: null });
		finish("child_exit", exitCode);
	});
	child.onError((err) => {
		diag("child_error", err instanceof Error ? err.message : String(err));
		finish("child_error", 1);
	});

	// 6. Re-check ownership after the child exists, then publish ready.
	const ready = ownedUpdate((cur) => ({
		...cur,
		childPid,
		childIdentity: { pid: childPid, startToken: captureStartToken(childPid) },
		childSpawnedAt: Date.now(),
		state: "alive",
		readyAt: Date.now(),
	}));
	if (!ready.updated) {
		// Superseded between spawn and ready: never publish; take the child down.
		killChild(child, childPid, "SIGTERM");
		const revoked = readHost(config.root, config.viewId)?.stopRequestedAt != null;
		await finishHost(revoked ? "host_start_revoked" : "owner_lost", 0);
		return;
	}
	broadcast({ type: "status", status: host, generation: GENERATION });

	// A starting-window resize cannot be applied at spawn-return nor at first
	// output: the child node process is still bootstrapping and a SIGWINCH
	// landing in that window is silently lost (pending-signal race, observed
	// empirically). Defer the apply until the child has had time to finish
	// bootstrapping; one-shot, best-effort, superseded by any newer direct
	// resize (which clears the cache).
	if (cachedResize) {
		const applyHeld = setTimeout(() => {
			if (!cachedResize || !child || shutdownStarted) return;
			// Paired step (CR R1 advisory): model follows the real PTY, never leads.
			resizeChildAndModel(child, terminalModel, cachedResize.cols, cachedResize.rows);
			notifyChildResize(childPid);
			cachedResize = null;
		}, 500);
		applyHeld.unref?.();
	}

	// 7. Launch transaction complete — hand the start lease back.
	releaseStartLease();

	// 8. Heartbeat: watch the owner record; loss or revoke routes to finishHost.
	heartbeatTimer = setInterval(() => {
		const h = readHost(config.root, config.viewId);
		if (!h || h.instanceId !== config.instanceId) {
			finish("owner_lost", 0);
			return;
		}
		if (h.stopRequestedAt != null) {
			finish("revoked", 0);
			return;
		}
		const hb = ownedUpdate((cur) => ({ ...cur }));
		// Plain host-meta lease contention returns {updated:false, ownerChanged:false}
		// — transient, retry next tick (store.mjs contract). Only a confirmed
		// ownership change tears the session down (CR round-1 finding 1).
		if (hb.ownerChanged) finish("owner_lost", 0);
	}, HEARTBEAT_MS);
	heartbeatTimer.unref?.();

	/** Client commands with the starting protocol (issue #70 §6.3): while the
	 *  child does not exist, service inputs answer host_starting, resizes are
	 *  held, and interactive keystrokes are dropped safely; once ready,
	 *  requestId-tagged inputs ack with an in-process dedup table. */
	function handleClientLine(line, socket) {
		if (!line.trim()) return;
		let msg;
		try { msg = JSON.parse(line); } catch { return send(socket, { type: "error", message: "invalid json" }); }
		// Enveloped control commands take the phase-5 lifecycle path; everything
		// else (no commandId, or a non-control type carrying one — e.g.
		// subscribe_terminal with correlation metadata) falls through to the
		// legacy switch byte-identically.
		const envelope = validateCommandEnvelope(msg);
		if (envelope.enveloped && CONTROL_COMMAND_TYPES.includes(msg.type)) {
			control.handle(msg, socket, envelope);
			return;
		}
		switch (msg.type) {
			case "hello": {
				// Probe and reporter sockets are bookkeeping-only: neither may flip
				// attachedEver nor keep attachedClients non-zero, or warm-host reclaim
				// never fires and hosts leak (issue #103 §C).
				const kind = classifyClientHello(msg);
				if (kind === "probe") {
					socket.markProbe?.();
				} else if (kind === "editor-reporter") {
					clients.delete(socket);
					terminalSubscriptions.delete(socket);
					editorReporters.add(socket);
					ownedUpdate((cur) => ({ ...cur }));
				} else {
					ownedUpdate((cur) => ({ ...cur, attachedEver: true }));
				}
				send(socket, { type: "hello", status: host, editorEmpty, generation: GENERATION });
				break;
			}
			case "input": {
				if (typeof msg.data !== "string") break;
				if (typeof msg.requestId !== "string" || !msg.requestId) {
					// Interactive UI keystrokes: fire-and-forget, no ack protocol.
					if (child) child.write(msg.data);
					break;
				}
				if (!child) {
					send(socket, { type: "error", code: "host_starting", requestId: msg.requestId });
					break;
				}
				if (ackedRequestIds.has(msg.requestId)) {
					send(socket, { type: "input_ack", requestId: msg.requestId });
					break;
				}
				child.write(msg.data);
				ackedRequestIds.set(msg.requestId, true);
				if (ackedRequestIds.size > HOST_ACK_DEDUP_MAX) {
					ackedRequestIds.delete(ackedRequestIds.keys().next().value);
				}
				send(socket, { type: "input_ack", requestId: msg.requestId });
				break;
			}
			case "resize": {
				const cols = clampInt(msg.cols, 20, 300, host.cols);
				const rows = clampInt(msg.rows, 5, 120, host.rows);
				if (child) {
					// Paired step (CR R1 advisory): model reflows only when the real
					// PTY resize succeeded; cachedResize cleared either way — a failed
					// resize is not retried against a exiting child.
					resizeChildAndModel(child, terminalModel, cols, rows);
					notifyChildResize(childPid);
					cachedResize = null;
				} else {
					cachedResize = { cols, rows };
				}
				ownedUpdate((cur) => ({ ...cur, cols, rows }));
				break;
			}
			case "interrupt":
				if (child) child.write("\x1b");
				break;
			case "subscribe_terminal":
				terminalSubscriptions.get(socket)?.handleMessage(msg);
				break;
			case "terminate":
				// Single exit path: finishHost carries the SIGTERM→4s→SIGKILL ladder,
				// so a SIGTERM-immune child still terminates within a bounded window.
				finish("terminated", 0);
				break;
			case "detach":
				socket.end();
				break;
			case "get_status":
				send(socket, { type: "status", status: host, generation: GENERATION });
				break;
			case "editor_state": {
				editorEmpty = typeof msg.empty === "boolean" ? msg.empty : null;
				broadcast({ type: "editor_state", empty: editorEmpty });
				break;
			}
		}
	}
}

function spawnInteractive(command, args, opts) {
	ensureNodePtySpawnHelperExecutable(requireForPty);
	if (pty?.spawn) {
		try {
			const proc = pty.spawn(command, args, {
				name: "xterm-256color",
				cols: opts.cols,
				rows: opts.rows,
				cwd: opts.cwd,
				env: opts.env,
			});
			return {
				pid: proc.pid ?? null,
				write: (s) => proc.write(s),
				resize: (cols, rows) => proc.resize(cols, rows),
				kill: (signal) => proc.kill(signal),
				onData: (fn) => proc.onData(fn),
				onExit: (fn) => proc.onExit((e) => fn(e.exitCode ?? 0)),
				onError: () => {},
			};
		} catch (err) {
			if (!opts.allowPipeFallback) throw err;
		}
	}
	if (!opts.allowPipeFallback) throw new Error("node-pty is unavailable");

	const proc = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	return {
		pid: proc.pid ?? null,
		write: (s) => proc.stdin.write(s),
		resize: () => {},
		kill: (signal) => proc.kill(signal),
		onData: (fn) => {
			proc.stdout.on("data", (c) => fn(c.toString()));
			proc.stderr.on("data", (c) => fn(c.toString()));
		},
		onExit: (fn) => proc.on("close", (code) => fn(code ?? 0)),
		onError: (fn) => proc.on("error", fn),
	};
}

function send(socket, msg) {
	socket.write(JSON.stringify(msg) + "\n");
}

/**
 * Terminate the hosted child on all platforms. node-pty's kill() throws
 * "Signals not supported on windows", so on win32 we TerminateProcess via
 * process.kill; on unix keep the graceful SIGTERM/SIGKILL path through the pty.
 * @param {{ kill: (signal: string) => void }} child
 * @param {number|null} pid
 * @param {"SIGTERM"|"SIGKILL"} [signal]
 */
function killChild(child, pid, signal = "SIGTERM") {
	if (process.platform === "win32") {
		if (pid) {
			try {
				process.kill(pid, "SIGKILL");
				return;
			} catch {}
		}
	}
	try { child.kill(signal); } catch {}
}

/**
 * node-pty's TIOCSWINSZ updates the kernel tty size, but the automatic
 * SIGWINCH to the pty's foreground group is NOT reliably delivered when the
 * runner itself is a detached session (empirically verified on Linux: the
 * child's kernel size is correct, its signal handler never fires, and a
 * direct kill delivers instantly). Real TUI children poll or handle SIGWINCH
 * — an explicit best-effort signal is harmless for them and makes resize
 * deterministic for every child. POSIX only.
 * @param {number|null} pid
 */
function notifyChildResize(pid) {
	if (process.platform === "win32" || !pid) return;
	try { process.kill(pid, "SIGWINCH"); } catch { /* best effort */ }
}

function clampInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Control-command lifecycle runtime (issue #91 phase 5, spec D4). Pure
// decision logic lives in src/core/control-protocol.mjs; this is the runner's
// serial side-effect shell: per-socket seq tracking, the durable command
// journal, resize latest-wins routing, and staged ack emission. Messages
// WITHOUT an envelope (no commandId) never reach this code — the legacy
// switch keeps byte-identical behavior.
// ---------------------------------------------------------------------------

/** Load journal records, dropping torn tail lines from a crash mid-append. */
function loadJournalRecords(path) {
	try {
		const records = [];
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				/* torn tail: the accepted/applied truth for that line is unknown —
				 dropping it can only widen the accepted_unknown set, never hide one */
			}
		}
		return records;
	} catch {
		return [];
	}
}

/**
 * One control runtime per main. `actions` bundles the main-specific side
 * effects (child shape differs between the legacy and owned lifecycles); the
 * decision order here is shared and binding:
 *   envelope validity → instance fence → seq monotonicity → per-type dispatch.
 * @param {{
 *   viewId: string, root: string, instanceId: string|null,
 *   send: (socket: import("node:net").Socket, msg: object) => void,
 *   diag: (code: string, message: string, details?: object) => void,
 *   actions: {
 *     childReady(): boolean,
 *     writeInput(data: string): void,
 *     hostCols(): number, hostRows(): number,
 *     applyResize(cols: number, rows: number): void,  // runtime pre-checks childReady — never called without a child
 *     currentDims(): { cols: number, rows: number },
 *     applyInterrupt(): void,
 *     applyTerminate(): void,
 *     applyDetach(socket: import("node:net").Socket): void,
 *     hostRevision(): number,
 *     cursor(): { lastSeq: number, cols: number, rows: number },
 *     stateStamp(): number | null,
 *   },
 * }} opts
 */
function createControlRuntime({ viewId, root, instanceId, send, diag, actions }) {
	/** Per-connection seq watermark (ordering aid only — never dedup). */
	const connectionSeq = new Map();
	const journalPath = P.controlJournalPath(root, viewId);
	const journalRecords = loadJournalRecords(journalPath);
	/** O(1) journal dedup — rebuilt after GC so it mirrors the retained records. */
	const journalIds = new Set(journalRecords.map((r) => r.commandId));
	const resizes = createResizeTracker();
	/** commandId → socket awaiting the resize ack (superseded/applied routing). */
	const pendingResizeSockets = new Map();
	/** commandId → socket that requested terminate (observed routing). */
	const pendingTerminates = new Map();

	const rawAppend = (record) => {
		appendFileSync(journalPath, JSON.stringify(record) + "\n");
	};
	const maybeGcJournal = () => {
		if (journalRecords.length <= JOURNAL_GC_TRIGGER) return;
		const kept = journalGc(journalRecords, JOURNAL_KEEP_DEFAULT);
		journalRecords.length = 0;
		journalRecords.push(...kept);
		journalIds.clear();
		for (const record of kept) journalIds.add(record.commandId);
		try {
			writeFileSync(journalPath, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
		} catch (err) {
			diag("control_journal_rewrite_failed", err instanceof Error ? err.message : String(err));
		}
	};
	/** @returns {boolean} false when the append failed — the command is NOT accepted. */
	const journalAccept = (commandId, command, now) => {
		// Ruling (b): a journaled commandId is NEVER re-appended — the dedup
		// check is the caller's, and this guard is the last line of defense.
		if (journalIds.has(commandId)) return true;
		const record = { kind: "accepted", commandId, command, acceptedAt: now };
		journalAppendRecord(journalRecords, record); // shape validation; throws on a runner bug
		try {
			rawAppend(record);
		} catch (err) {
			// Nothing was pushed into journalRecords for this record (pure
			// validate + manual push on success), so there is nothing to unwind —
			// the command is simply not accepted.
			diag("control_journal_write_failed", err instanceof Error ? err.message : String(err), { commandId });
			return false;
		}
		journalRecords.push(record);
		journalIds.add(commandId);
		maybeGcJournal();
		return true;
	};
	const journalApply = (commandId, now) => {
		const record = { kind: "applied", commandId, appliedAt: now };
		try {
			rawAppend(record);
		} catch (err) {
			diag("control_journal_write_failed", err instanceof Error ? err.message : String(err), { commandId });
			return;
		}
		journalRecords.push(record);
		maybeGcJournal();
	};

	/** Socket-death semantics for every ack: a dead client must never turn a
	 *  control reply into a runner crash (same invariant as the broadcast guard). */
	const reply = (socket, msg) => {
		try {
			send(socket, msg);
		} catch {
			/* socket 'error'/'close' handler owns cleanup */
		}
	};

	const flushTerminateObservations = (exitCode, runnerFinalizing) => {
		for (const [commandId, termSocket] of pendingTerminates) {
			reply(termSocket, {
				type: "cmd_ack",
				commandId,
				stage: "observed",
				...(exitCode != null ? { exitConfirmed: true, exitCode } : {}),
				...(runnerFinalizing ? { runnerFinalizing: true } : {}),
			});
		}
		pendingTerminates.clear();
	};

	/**
	 * Dispatch an enveloped control command. Caller guarantees
	 * `env.enveloped && CONTROL_COMMAND_TYPES.includes(msg.type)`.
	 *
	 * Crash containment: a throwing action (e.g. child.write on a pty that died
	 * mid-command) must degrade to an error reply + diagnostic, never escape
	 * into the runner's uncaughtException path — the legacy switch predates this
	 * invariant, but new protocol code must not inherit that crash class.
	 */
	const handle = (msg, socket, env) => {
		// (d) errors are only meaningful for enveloped messages — this function is
		// only entered for enveloped control types, so every error below is legal.
		if (env.errors.length > 0) {
			reply(socket, { type: "error", code: "envelope_invalid", commandId: msg.commandId, errors: env.errors });
			return;
		}
		try {
			handleChecked(msg, socket, env);
		} catch (err) {
			diag("control_command_failed", err instanceof Error ? err.message : String(err), { commandId: msg.commandId, type: msg.type });
			reply(socket, { type: "error", code: "command_failed", commandId: msg.commandId });
		}
	};

	const handleChecked = (msg, socket, env) => {
		// (a) instance fencing, reject-with-current: a client naming a DIFFERENT
		// instance is talking across a runner replacement (stale socket race);
		// silently applying its commands would resurrect phantom controls — the
		// exact class #70 fencing exists to prevent. The error carries the current
		// instanceId so a well-behaved client re-hellos and recovers. Legacy-mode
		// hosts (instanceId null) fence EVERY envelope: an envelope claims an
		// instance a legacy-mode runner never had.
		if (msg.instanceId !== instanceId) {
			diag("instance_mismatch", "control command carries a foreign instanceId", {
				commandId: msg.commandId,
				got: msg.instanceId,
				current: instanceId,
			});
			reply(socket, { type: "error", code: "instance_mismatch", commandId: msg.commandId, currentInstanceId: instanceId });
			return;
		}
		// (c) per-connection monotonic seq: an ordering aid. Repeats/regressions
		// are dropped with a diagnostic — NOT a dedup signal (dedup keys on
		// commandId only); a legitimate re-send after reconnect uses a new socket.
		const lastSeq = connectionSeq.get(socket) ?? 0;
		const seqVerdict = checkSeq(lastSeq, msg.seq);
		if (!seqVerdict.ok) {
			diag("seq_out_of_order", "control command dropped for non-monotonic seq", {
				commandId: msg.commandId,
				seq: msg.seq,
				lastSeq,
			});
			return;
		}
		connectionSeq.set(socket, msg.seq);

		switch (msg.type) {
			case "input": {
				if (typeof msg.data !== "string") {
					reply(socket, { type: "error", code: "envelope_invalid", commandId: msg.commandId, errors: ["input_data_missing"] });
					return;
				}
				if (msg.durable !== true) {
					// Keystroke with a correlation id: fire-and-forget preserved — no
					// ack, no journal (journal writes must never sit on the keystroke
					// path). The envelope is correlation/debugging metadata only.
					if (actions.childReady()) actions.writeInput(msg.data);
					return;
				}
				// Durable follow-up: accepted (journaled) → applied (written). A
				// re-send of a journaled commandId returns the cached final stage —
				// never re-appended (ruling b), never re-written (commandId dedup).
				if (journalIds.has(msg.commandId)) {
					const wasApplied = journalRecords.some((r) => r.kind === "applied" && r.commandId === msg.commandId);
					reply(socket, { type: "cmd_ack", commandId: msg.commandId, stage: wasApplied ? "applied" : "accepted", durable: true });
					return;
				}
				if (!actions.childReady()) {
					// Starting window: nothing accepted (matches the requestId path's
					// host_starting contract; the service retries with its own policy).
					reply(socket, { type: "error", code: "host_starting", commandId: msg.commandId });
					return;
				}
				if (!journalAccept(msg.commandId, msg.data, Date.now())) {
					// accepted means JOURNALED — without the journal entry the stage
					// would be a lie, so the command is refused, not silently applied.
					reply(socket, { type: "error", code: "journal_unavailable", commandId: msg.commandId });
					return;
				}
				reply(socket, { type: "cmd_ack", commandId: msg.commandId, stage: "accepted", durable: true });
				try {
					actions.writeInput(msg.data);
				} catch (err) {
					// §10 honesty: accepted but the write failed — the command stays
					// accepted_unknown; reconcile reports it; never auto-replayed.
					diag("input_apply_failed", err instanceof Error ? err.message : String(err), { commandId: msg.commandId });
					return;
				}
				journalApply(msg.commandId, Date.now());
				reply(socket, { type: "cmd_ack", commandId: msg.commandId, stage: "applied" });
				return;
			}
			case "resize": {
				// Uniform starting-window contract with input: without a child there
				// is nothing to resize and no honest applied value — the client
				// retries (new commandId). This also keeps latest-wins tracking off
				// the books for commands that never applied.
				if (!actions.childReady()) {
					reply(socket, { type: "error", code: "host_starting", commandId: msg.commandId });
					return;
				}
				const cols = clampInt(msg.cols, 20, 300, actions.hostCols());
				const rows = clampInt(msg.rows, 5, 120, actions.hostRows());
				const tracked = resizes.track({ commandId: msg.commandId, clientId: msg.clientId, cols, rows });
				for (const sup of tracked.superseded) {
					const oldSocket = pendingResizeSockets.get(sup.commandId) ?? socket;
					pendingResizeSockets.delete(sup.commandId);
					reply(oldSocket, { type: "cmd_ack", commandId: sup.commandId, stage: "superseded", byCommandId: sup.byCommandId });
				}
				if (tracked.duplicate) {
					// Same commandId re-request: applyResize is synchronous, so a
					// duplicate always finds the command already applied — return the
					// cached result. (CR R1 advisory: the pendingResizeSockets entry is
					// deliberately NOT set here — the original resolved synchronously,
					// so a re-pointed entry would be a stale leak.)
					const cached = resizes.resultFor(msg.commandId);
					if (cached) reply(socket, { type: "cmd_ack", commandId: msg.commandId, stage: "applied", cols: cached.cols, rows: cached.rows });
					return;
				}
				pendingResizeSockets.set(msg.commandId, socket);
				actions.applyResize(cols, rows);
				// The paired resize step keeps the model mirroring the REAL PTY
				// (reflow only on successful child.resize), so the model's dims are
				// the honest applied value — even when the PTY kept its old geometry.
				const dims = actions.currentDims();
				resizes.applied(msg.commandId, dims.cols, dims.rows);
				pendingResizeSockets.delete(msg.commandId);
				reply(socket, { type: "cmd_ack", commandId: msg.commandId, stage: "applied", cols: dims.cols, rows: dims.rows });
				return;
			}
			case "interrupt": {
				// Starting-window honesty (CR R1 blocking): applyInterrupt no-ops
				// without a child, so an unconditional applied ack would be a lie —
				// same contract as input/resize. The client consumes host_starting
				// as a cmdAck error (no retry chain: interrupt is transient and
				// user-timed; a re-send carries a fresh commandId).
				if (!actions.childReady()) {
					reply(socket, { type: "error", code: "host_starting", commandId: msg.commandId });
					return;
				}
				actions.applyInterrupt();
				reply(socket, { type: "cmd_ack", commandId: msg.commandId, stage: "applied" });
				return;
			}
			case "terminate": {
				// Idempotent: a repeat while the termination is in flight returns the
				// current stage instead of claiming a fresh start.
				if (pendingTerminates.has(msg.commandId)) {
					reply(socket, { type: "cmd_ack", commandId: msg.commandId, stage: "applied", value: "termination_started" });
					return;
				}
				pendingTerminates.set(msg.commandId, socket);
				reply(socket, { type: "cmd_ack", commandId: msg.commandId, stage: "applied", value: "termination_started" });
				actions.applyTerminate();
				return;
			}
			case "detach": {
				reply(socket, { type: "cmd_ack", commandId: msg.commandId, stage: "applied", value: "detach_accepted" });
				actions.applyDetach(socket);
				return;
			}
			case "reconcile": {
				reply(socket, {
					type: "reconcile_result",
					commandId: msg.commandId,
					generation: GENERATION,
					hostRevision: actions.hostRevision(),
					terminalCursor: actions.cursor(),
					stateMaterializedRevision: actions.stateStamp(),
					unresolved: journalUnresolved(journalRecords).map((u) => ({ ...u, status: "accepted_unknown" })),
				});
				return;
			}
		}
	};

	/** Socket teardown: drop the seq watermark and any ack-routing entries. */
	const closeSocket = (socket) => {
		connectionSeq.delete(socket);
		for (const [commandId, sock] of pendingResizeSockets) if (sock === socket) pendingResizeSockets.delete(commandId);
		for (const [commandId, sock] of pendingTerminates) if (sock === socket) pendingTerminates.delete(commandId);
	};

	// (completeHeldResize was removed as dead code: the starting-window resize
	// path rejects with host_starting instead of holding, and applyResize is
	// synchronous — there is no held-resize completion path. Task 2 review P2-C.)
	return { handle, closeSocket, flushTerminateObservations, journalIds };
}

/** POSIX process start token — /proc/<pid>/stat field 22 (starttime), stable
 *  across exec(2). Recorded in published identities so service-side recovery
 *  (issue #70 Task 11) can tell an owned-live pid from a reused one; null on
 *  failure or non-Linux platforms. */
function captureStartToken(pid) {
	if (process.platform !== "linux" || !pid) return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) may contain spaces and parens — fields resume AFTER the
		// last ')'. fields[0] is state (field 3) → starttime (field 22) is [19].
		const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trimStart();
		const fields = afterComm.split(/\s+/);
		const startTime = fields[19];
		return startTime ?? null;
	} catch {
		return null;
	}
}


/**
 * Finalize the view row as failed when the PTY host itself fails (child spawn
 * failure). Routed through the View State Coordinator as a fenced
 * `host_run_failed` command (issue #91, PR #1 residual risk #2): a manually
 * completed row rejects with manual_fence and stays completed, and a row
 * re-pointed to a newer run rejects with stale_run.
 *
 * The runId is sourced from the row's current state.json (null = the row had
 * no run) so the coordinator's stale_run guard stays effective; the
 * coordinator cannot enforce this from its side because it has no visibility
 * into what the host knows.
 *
 * Never throws: every client outcome is handled so the crash path cannot hang.
 *  - applied → done (journaled + materialized by the coordinator).
 *  - coordinator_disabled → legacy direct write (documented escape hatch).
 *  - decided rejections (manual_fence / stale_run / no_change) → info
 *    diagnostic; the coordinator's verdict governs.
 *  - everything else (timeout / connection reset / unavailable) → warn
 *    diagnostic: the outcome is unknown or the row could not be marked — the
 *    runner still shuts down.
 * @param {string} root
 * @param {string} viewId
 * @param {string} message
 */
async function markRowFailed(root, viewId, message) {
	const knownRunId = readState(root, viewId)?.currentRunId ?? null;
	const result = await sendStateCommand(root, {
		type: "state_command",
		viewId,
		runId: knownRunId,
		source: "pty-runner",
		kind: "host_run_failed",
		payload: { error: message },
	});
	if (result.status === "applied") return;
	if (result.reason === "coordinator_disabled") {
		markRowFailedDirect(root, viewId, message);
		return;
	}
	if (result.reason === "manual_fence" || result.reason === "stale_run" || result.reason === "no_change") {
		try {
			appendDiagnostic(root, viewId, {
				source: "runner",
				level: "info",
				code: "host_run_failed_skipped",
				message: `Host failure not applied to the row (${result.reason})`,
				details: { reason: result.reason },
			});
		} catch { /* best effort */ }
		return;
	}
	try {
		appendDiagnostic(root, viewId, {
			source: "runner",
			level: "warn",
			code: "host_run_failed_ambiguous",
			message: `Host failure outcome unknown (${result.reason}); the row may not reflect the failed host`,
			details: { reason: result.reason },
		});
	} catch { /* best effort */ }
}

function failEarly(message) {
	try { appendLine(join(tmpdir(), "pi-agent-board-pty-runner.err"), message); } catch {}
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

main();
