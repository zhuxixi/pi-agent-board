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
import { createServer } from "node:net";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, readJson } from "../src/core/atomic.mjs";
import { appendDiagnostic } from "../src/core/diagnostics.mjs";
import { finalizeHostCrash } from "../src/core/host-crash.mjs";
import { ownsEndpoint, shouldYieldRunner } from "../src/core/host-coordination.mjs";
import { acquireOwnedViewLock } from "../src/core/locks.mjs";
import * as P from "../src/core/paths.mjs";
import { appendBoundedScreenLog, reconcileScreenLog } from "../src/core/screen-log.mjs";
import { encodePromptForCliArg } from "../src/core/prompt-transport.mjs";
import { readHost, readState, updateOwnedHost, writeHost, writeState } from "../src/core/store.mjs";
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
	};
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
		host = { ...host, ...patch, lastSeenAt: Date.now(), attachedClients: clients.size };
		persist();
		broadcast({ type: "status", status: host });
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
		markRowFailed(config.root, config.viewId, `PTY host failed: ${message}`);
		process.exit(1);
	}
	childPid = child.pid ?? null;
	update({ childPid });

	child.onData((data) => {
		screenLogBytes = appendBoundedScreenLog(screenLog, data, screenLogBytes, screenLogLimits);
		broadcast({ type: "output", data });
	});
	child.onExit((code) => {
		childExited = true;
		resolveChildExit?.();
		exitCode = code ?? 0;
		// After a crash the handler already persisted "failed" and broadcast
		// exit; this callback must not overwrite that state.
		if (!crashed) {
			update({ state: "exited", endedAt: Date.now(), exitCode, childPid: null });
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
		update({ attachedEver: true });
		socket.write(JSON.stringify({ type: "hello", status: host, editorEmpty }) + "\n");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleClientLine(line, socket);
		});
		socket.on("close", () => {
			clients.delete(socket);
			update();
		});
		socket.on("error", () => {
			clients.delete(socket);
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
		switch (msg.type) {
			case "hello":
				send(socket, { type: "hello", status: host, editorEmpty });
				break;
			case "input":
				if (typeof msg.data === "string") child.write(msg.data);
				break;
			case "resize": {
				const cols = clampInt(msg.cols, 20, 300, host.cols);
				const rows = clampInt(msg.rows, 5, 120, host.rows);
				child.resize(cols, rows);
				update({ cols, rows });
				break;
			}
			case "interrupt":
				child.write("\x1b");
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
				send(socket, { type: "status", status: host });
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
		try { server?.close(); } catch {}
		try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch {}
		for (const client of clients) {
			try { client.end(); } catch {}
		}
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
			return { ...next, lastSeenAt: Date.now(), attachedClients: clients.size };
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
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
		// Only the runner that actually claimed the record writes terminal state; a
		// superseded owner (or a duplicate that never claimed) never writes.
		if (claimedRecord && reason !== "owner_lost" && isOwnerNow()) {
			ownedUpdate((cur) => ({ ...cur, state: "stopping", stopReason: reason }));
			broadcast({ type: "status", status: host });
		}
		try { broadcast({ type: "exit", exitCode: requestedExitCode ?? exitCode ?? 0 }); } catch { /* best effort */ }
		for (const c of clients) {
			try { c.destroy(); } catch { /* best effort */ }
		}
		clients.clear();
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

	// 3. Bind the per-instance endpoint. NO unlink: the path is unique to this
	//    instance; an occupied path means someone else owns it.
	const listenOutcome = await new Promise((resolveListen) => {
		const onError = (err) => resolveListen({ ok: false, error: err });
		server = createServer((socket) => {
			clients.add(socket);
			socket.write(JSON.stringify({ type: "hello", status: host, editorEmpty }) + "\n");
			ownedUpdate((cur) => ({ ...cur, attachedEver: true }));
			broadcast({ type: "status", status: host });
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handleClientLine(line, socket);
			});
			socket.on("close", () => {
				clients.delete(socket);
				// Merge into the live record (a stale closure spread here erases a
				// concurrent revoke — final review finding 2).
				ownedUpdate((cur) => ({ ...cur }));
			});
			socket.on("error", () => {
				clients.delete(socket);
				ownedUpdate((cur) => ({ ...cur }));
			});
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
	broadcast({ type: "status", status: host });

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
		markRowFailed(config.root, config.viewId, `PTY host failed: ${message}`);
		await finishHost("child_spawn_failed", 1);
		return;
	}
	childPid = child.pid ?? null;
	child.onData((data) => {
		screenLogBytes = appendBoundedScreenLog(screenLog, data, screenLogBytes, screenLogLimits);
		broadcast({ type: "output", data });
	});
	child.onExit((code) => {
		childExited = true;
		resolveChildExit?.();
		exitCode = code ?? 0;
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
	broadcast({ type: "status", status: host });

	// A starting-window resize cannot be applied at spawn-return nor at first
	// output: the child node process is still bootstrapping and a SIGWINCH
	// landing in that window is silently lost (pending-signal race, observed
	// empirically). Defer the apply until the child has had time to finish
	// bootstrapping; one-shot, best-effort, superseded by any newer direct
	// resize (which clears the cache).
	if (cachedResize) {
		const applyHeld = setTimeout(() => {
			if (!cachedResize || !child || shutdownStarted) return;
			try { child.resize(cachedResize.cols, cachedResize.rows); } catch { /* best effort */ }
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
		if (!hb.updated) finish("owner_lost", 0);
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
		switch (msg.type) {
			case "hello":
				send(socket, { type: "hello", status: host, editorEmpty });
				break;
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
					child.resize(cols, rows);
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
			case "terminate":
				// Single exit path: finishHost carries the SIGTERM→4s→SIGKILL ladder,
				// so a SIGTERM-immune child still terminates within a bounded window.
				finish("terminated", 0);
				break;
			case "detach":
				socket.end();
				break;
			case "get_status":
				send(socket, { type: "status", status: host });
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


function markRowFailed(root, viewId, message) {
	const now = Date.now();
	const state = readState(root, viewId) ?? {
		version: 1,
		viewId,
		currentRunId: null,
		semanticState: "queued",
		processState: "exited",
		summary: "Queued",
		lastActivityAt: now,
		updatedAt: now,
		needsInput: false,
		hasError: false,
		latestAssistantPreview: "",
		latestTool: null,
		question: null,
		pendingQuestions: [],
		error: null,
	};
	state.semanticState = "failed";
	state.processState = "exited";
	state.summary = message;
	state.hasError = true;
	state.needsInput = false;
	state.error = message;
	state.updatedAt = now;
	state.lastActivityAt = now;
	writeState(root, state);
}

function failEarly(message) {
	try { appendLine(join(tmpdir(), "pi-agent-board-pty-runner.err"), message); } catch {}
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

main();
