import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { coordinatorSpawnPlan, launchCoordinator } from "../src/core/launch.mjs";
import * as P from "../src/core/paths.mjs";
import { isAlive } from "../src/core/pid.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 10_000, intervalMs = 50) {
	const start = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - start > timeoutMs) return null;
		await sleep(intervalMs);
	}
}

const FAKE_RUNNER = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.argv[2], "spawn-probe.json"), JSON.stringify({ cwd: process.cwd(), arg: process.argv[2] }));
`;

test("A1 coordinatorSpawnPlan: absolute root argv, parent-dir cwd", () => {
	const base = join(tmpdir(), "agentview-c241-plan", "board root");
	// The dot-segment spelling is literal: path.join() would normalize it away
	// before coordinatorSpawnPlan ever saw the non-canonical input.
	const inputs = [base, `${base}/`, `${base}/views/..`];
	// A relative spelling is what makes the absolute-root assertion non-vacuous.
	// A `..`-prefixed path is a perfectly valid relative input (tmpdir is usually
	// outside the checkout), so only an absolute spelling is excluded — win32
	// yields one when tmpdir sits on a different drive than cwd.
	const relativeBase = relative(process.cwd(), base);
	if (relativeBase && !isAbsolute(relativeBase)) inputs.push(relativeBase);
	for (const input of inputs) {
		const plan = coordinatorSpawnPlan(input);
		assert.ok(isAbsolute(plan.root), `root must be absolute for ${input}`);
		assert.equal(plan.root, resolve(input));
		assert.equal(plan.cwd, dirname(resolve(input)));
	}
});

test("A2 launchCoordinator spawns with absolute root argv and parent-dir cwd", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-spawn-"));
	try {
		const fake = join(root, "fake-runner.mjs");
		writeFileSync(fake, FAKE_RUNNER, "utf8");
		// Deliberately non-canonical spelling: the spawn plan must canonicalize it.
		const { pid } = launchCoordinator(`${root}/`, { runnerScript: fake });
		assert.ok(pid, "detached child has a pid");
		const probePath = join(root, "spawn-probe.json");
		const raw = await waitFor(() => (existsSync(probePath) ? readFileSync(probePath, "utf8") : null), 5000);
		assert.ok(raw, "fake runner must write its probe file");
		const probe = JSON.parse(raw);
		// Exact raw comparison: argv carries the canonical root itself, not the
		// caller's trailing-separator spelling.
		assert.equal(probe.arg, resolve(root), "argv[2] is the canonical absolute root");
		// cwd keeps the normalized comparison: win32 casing plus the POSIX case of
		// symlinked temp dirs (macOS /var -> /private/var) must not false-fail.
		const normCwd = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : realpathSync(resolve(p)));
		assert.equal(normCwd(probe.cwd), normCwd(dirname(root)), "cwd is the root's parent, not the root");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- Task 2: root-vanished step-down (issue #241 A3, A3b, A4) ---

/** The real detached coordinator (not a fake): A3/A3b/A4 test its own exit logic. */
const COORDINATOR_SCRIPT = fileURLToPath(new URL("../runner/state-coordinator.mjs", import.meta.url));
const HEARTBEAT_ENV = "AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS";

/**
 * Set the coordinator heartbeat knob for one test and return its restorer. The
 * knob is read at coordinator `main()` start, so it must be in place BEFORE
 * `launchCoordinator` — and restored afterwards so later tests keep the
 * production 1000 ms cadence.
 * @param {number} ms
 * @returns {() => void}
 */
function setHeartbeatKnob(ms) {
	const previous = process.env[HEARTBEAT_ENV];
	process.env[HEARTBEAT_ENV] = String(ms);
	return () => {
		if (previous === undefined) delete process.env[HEARTBEAT_ENV];
		else process.env[HEARTBEAT_ENV] = previous;
	};
}

/**
 * Poll real connect attempts against the coordinator's JSONL endpoint: the
 * socket is bound only after boot replay, so a successful connect is the
 * readiness signal. Resolves true on connect, false on timeout.
 * @param {string} root
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForCoordinatorReady(root, timeoutMs = 10_000) {
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	const start = Date.now();
	for (;;) {
		const connected = await new Promise((settle) => {
			let settled = false;
			/** @type {import("node:net").Socket|null} */
			let socket = null;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try { socket?.destroy(); } catch { /* best effort */ }
				settle(value);
			};
			const timer = setTimeout(() => finish(false), 250);
			timer.unref?.();
			try { socket = createConnection(socketPath); } catch { return finish(false); }
			socket.on("connect", () => finish(true));
			socket.on("error", () => finish(false));
		});
		if (connected) return true;
		if (Date.now() - start > timeoutMs) return false;
		await sleep(50);
	}
}

/**
 * One raw ping/pong round-trip against the coordinator's JSONL endpoint.
 * Resolves the parsed pong, or null on timeout/error.
 * @param {string} socketPath
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>}
 */
function rawPing(socketPath, timeoutMs = 2000) {
	return new Promise((settle) => {
		let settled = false;
		let buffer = "";
		/** @type {import("node:net").Socket|null} */
		let socket = null;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket?.destroy(); } catch { /* best effort */ }
			settle(value);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		try { socket = createConnection(socketPath); } catch { return finish(null); }
		socket.on("error", () => finish(null));
		socket.on("connect", () => {
			try { socket?.write(JSON.stringify({ type: "ping" }) + "\n"); } catch { finish(null); }
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg?.type === "pong") finish(msg);
				} catch { /* malformed line — keep waiting */ }
			}
		});
	});
}

/**
 * Wait until the coordinator's supervised heartbeat has just fired, so the next
 * full heartbeat period is free for a delete + recreating write. Every tick
 * rewrites the lease's `heartbeat.<token>` file, so polling its mtime is the
 * only observation needed. Resolves true on an observed tick, false on timeout
 * (never throws).
 * @param {string} root
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForHeartbeatTick(root, timeoutMs = 5000) {
	const lockDir = P.viewLockPath(root, "_coordinator", "state-coordinator");
	/** @type {string|null} */
	let heartbeatPath = null;
	try {
		const name = readdirSync(lockDir).find((entry) => entry.startsWith("heartbeat."));
		if (name) heartbeatPath = join(lockDir, name);
	} catch { /* the lease is written before readiness; a miss just skips the sync */ }
	if (!heartbeatPath) return false;
	let previous;
	try { previous = statSync(heartbeatPath).mtimeMs; } catch { return false; }
	const start = Date.now();
	for (;;) {
		await sleep(5);
		let current;
		try { current = statSync(heartbeatPath).mtimeMs; } catch { return false; }
		if (current !== previous) return true;
		if (Date.now() - start > timeoutMs) return false;
	}
}

/**
 * Open one JSONL connection to the coordinator endpoint and resolve it once
 * connected (null on error/timeout). A connection opened BEFORE a root delete
 * stays usable afterwards: on POSIX the socket file lives inside the root and is
 * unlinked with it, so a post-delete connect could not resolve the path, while
 * an already-connected socket keeps its inode.
 * @param {string} socketPath
 * @param {number} [timeoutMs]
 * @returns {Promise<{ send: (message: object) => void, awaitReply: (timeoutMs?: number) => Promise<object|null>, close: () => void }|null>}
 */
function openJsonlConnection(socketPath, timeoutMs = 2000) {
	return new Promise((settle) => {
		let settled = false;
		let buffer = "";
		/** @type {((message: object) => void)|null} */
		let onReply = null;
		/** @type {import("node:net").Socket|null} */
		let socket = null;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			settle(value);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		try { socket = createConnection(socketPath); } catch { return finish(null); }
		socket.setEncoding("utf8");
		socket.on("error", () => finish(null));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let message;
				try { message = JSON.parse(line); } catch { continue; }
				if (message?.type === "state_command_result" && onReply) {
					const reply = onReply;
					onReply = null;
					reply(message);
				}
			}
		});
		socket.on("connect", () => {
			finish({
				send: (message) => { socket?.write(JSON.stringify(message) + "\n"); },
				awaitReply: (replyTimeoutMs = 2000) => new Promise((resolveReply) => {
					const replyTimer = setTimeout(() => {
						onReply = null;
						resolveReply(null);
					}, replyTimeoutMs);
					replyTimer.unref?.();
					onReply = (message) => {
						clearTimeout(replyTimer);
						resolveReply(message);
					};
				}),
				close: () => { try { socket?.destroy(); } catch { /* best effort */ } },
			});
		});
	});
}

/**
 * Spawn the real coordinator directly, exactly as `coordinatorSpawnPlan` lays
 * out (A1/A2 already lock `launchCoordinator`'s actual spawn shape), but with a
 * piped stderr. `launchCoordinator` ignores stdio, and the root-missing
 * step-down writes no diagnostic (it must not recreate the root), so stderr is
 * the only in-band attribution for A3/A3b/A4.
 * @param {string} root
 * @returns {{ child: import("node:child_process").ChildProcess, stderr: () => string }}
 */
function spawnCoordinatorDirect(root) {
	const plan = coordinatorSpawnPlan(root);
	const child = spawn(process.execPath, [COORDINATOR_SCRIPT, plan.root], {
		cwd: plan.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	return { child, stderr: () => stderr };
}

/**
 * Wait for a spawned child to exit. Resolves `{code, signal}` or null on
 * timeout; the caller's `finally` still kills a timed-out child.
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} [timeoutMs]
 * @returns {Promise<{code: number|null, signal: string|null}|null>}
 */
function waitForChildExit(child, timeoutMs = 10_000) {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((settle) => {
		let settled = false;
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		function finish(value) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off("exit", onExit);
			settle(value);
		}
		function onExit(code, signal) {
			finish({ code, signal });
		}
		child.once("exit", onExit);
	});
}

/**
 * Cleanup for any coordinator that did NOT self-exit: SIGTERM → poll child exit
 * → SIGKILL, then remove the root with rename-retry slack (win32 rejects a
 * delete while a heartbeat file is briefly open). Best-effort throughout: it
 * never throws, so a failing assertion keeps its original error.
 * @param {import("node:child_process").ChildProcess|null} child
 * @param {string} root
 * @returns {Promise<void>}
 */
async function stopCoordinatorAndCleanup(child, root) {
	try {
		const pid = child?.pid ?? null;
		if (pid && isAlive(pid)) {
			try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
			if (!await waitForChildExit(child, 4000)) {
				try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
				await waitForChildExit(child, 2000);
			}
		}
	} catch { /* best effort: cleanup must not mask the test failure */ }
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	} catch { /* best effort: a pinned root must not mask the test failure */ }
}

test("A3 deleting the root makes the coordinator exit within the grace window", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-exit-"));
	const restoreKnob = setHeartbeatKnob(100);
	/** @type {import("node:child_process").ChildProcess|null} */
	let child = null;
	/** @type {() => string} */
	let stderrText = () => "";
	try {
		const spawned = spawnCoordinatorDirect(root);
		child = spawned.child;
		stderrText = spawned.stderr;
		assert.ok(child.pid);
		assert.ok(await waitForCoordinatorReady(root, 10_000), "coordinator binds its endpoint");
		const lease = join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json");
		assert.ok(existsSync(lease), "lease exists BEFORE the delete (anti-vacuous precondition)");
		assert.ok(isAlive(child.pid), "coordinator is alive before the delete");
		assert.doesNotMatch(stderrText(), /board root missing/, "no root-missing line before the delete");
		// maxRetries: rmSync can overlap a heartbeat write holding a file handle.
		// A cwd-pinned root fails every retry, so the cwd evidence is not weakened.
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		assert.equal(existsSync(root), false, "the root is gone before the step-down");
		const exit = await waitForChildExit(child, 10_000);
		assert.ok(exit, "coordinator exits after its root vanished");
		assert.equal(exit.signal, null, "the self-exit is not a signal death");
		assert.equal(exit.code, 0, "the step-down is a clean exit");
		// The step-down writes no diagnostic by design, so stderr is the
		// attribution: it proves the root check fired (not a boot failure, and
		// not the 3-failure heartbeat-loss fallback, which is later and noisy).
		assert.match(stderrText(), /board root missing/, `step-down is attributed on stderr (got: ${JSON.stringify(stderrText())})`);
		// I1 regression guard: the step-down itself must not recreate the root
		// skeleton via a diagnostic append (appendLine ensureDirs its parent).
		assert.equal(existsSync(root), false, "the root stays deleted after the self-exit");
	} finally {
		restoreKnob();
		await stopCoordinatorAndCleanup(child, root);
	}
});

test("A3c a root recreated in the delete window is detected as replaced and stepped down", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-replaced-"));
	const restoreKnob = setHeartbeatKnob(100);
	/** @type {import("node:child_process").ChildProcess|null} */
	let child = null;
	/** @type {() => string} */
	let stderrText = () => "";
	/** @type {Awaited<ReturnType<typeof openJsonlConnection>>} */
	let connection = null;
	try {
		const spawned = spawnCoordinatorDirect(root);
		child = spawned.child;
		stderrText = spawned.stderr;
		assert.ok(child.pid);
		assert.ok(await waitForCoordinatorReady(root, 10_000), "coordinator binds its endpoint");
		const lease = join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json");
		assert.ok(existsSync(lease), "lease exists BEFORE the delete (anti-vacuous precondition)");
		assert.ok(isAlive(child.pid), "coordinator is alive before the delete");
		connection = await openJsonlConnection(P.coordinatorEndpointPathFor(process.platform, root));
		assert.ok(connection, "endpoint connection is open before the delete");
		// Sync to just after a supervised tick so the next one is a full heartbeat
		// away and the recreating write below reliably wins the race.
		assert.ok(await waitForHeartbeatTick(root), "observed a supervised heartbeat before the delete");
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		assert.equal(existsSync(root), false, "the root is gone before the recreating write");
		// A valid-but-rejected command is still journaled, and appendCommand
		// ensureDirs its parent: this write resurrects the deleted root exactly like
		// the reported delete-window race (final-review I1). The identity guard must
		// still step down instead of serving the recreated skeleton.
		const replyPromise = connection.awaitReply(3000);
		connection.send({
			type: "state_command",
			commandId: "a3c-recreate-1",
			viewId: "c241-unknown-view",
			source: "state-runner",
			kind: "patch_fields",
			expectedRevision: null,
			payload: { state: { review: {} } },
		});
		const reply = await replyPromise;
		assert.ok(reply, "the rejected command is answered (its journal append ran)");
		assert.equal(reply.status, "rejected", "unknown view rejects, but only after the journal append");
		assert.equal(reply.reason, "unknown_view");
		assert.ok(existsSync(root), "the recreating write resurrected the root (the I1 failure shape)");
		const exit = await waitForChildExit(child, 2000);
		assert.ok(exit, "the coordinator steps down within ~2 s of the replacement");
		assert.equal(exit.signal, null, "the replacement step-down is not a signal death");
		assert.equal(exit.code, 0, "the replacement step-down is a clean exit");
		// Either attribution is correct: a tick that beat the write sees "missing",
		// the identity guard sees "replaced" — both must step down.
		assert.match(stderrText(), /board root (missing|replaced)/, `step-down is attributed on stderr (got: ${JSON.stringify(stderrText())})`);
		assert.ok(!isAlive(child.pid), "no coordinator process survives the replacement");
	} finally {
		restoreKnob();
		try { connection?.close(); } catch { /* best effort */ }
		await stopCoordinatorAndCleanup(child, root);
	}
});

test("A3b a root deleted before boot makes the coordinator exit without lingering", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-bootgone-"));
	rmSync(root, { recursive: true, force: true });
	const restoreKnob = setHeartbeatKnob(100);
	/** @type {import("node:child_process").ChildProcess|null} */
	let child = null;
	/** @type {() => string} */
	let stderrText = () => "";
	try {
		assert.equal(existsSync(root), false, "precondition: the root is already gone at spawn time");
		const spawned = spawnCoordinatorDirect(root);
		child = spawned.child;
		stderrText = spawned.stderr;
		assert.ok(child.pid, "the direct child has a pid");
		const exit = await waitForChildExit(child, 10_000);
		assert.ok(exit, "a coordinator with no board root exits instead of serving forever");
		assert.equal(exit.signal, null, "the boot guard is not a signal death");
		assert.equal(exit.code, 0, "the boot guard exits 0");
		assert.match(stderrText(), /board root missing/, `boot guard is attributed on stderr (got: ${JSON.stringify(stderrText())})`);
		// Lease acquisition runs ensureDir, so an unguarded boot would recreate the
		// deleted board and serve that empty root indefinitely. A throwaway root
		// must stay deleted (issue #241 G2).
		assert.equal(existsSync(root), false, "the boot path must not resurrect the deleted root");
	} finally {
		restoreKnob();
		await stopCoordinatorAndCleanup(child, root);
	}
});

test("A4 a present root keeps the coordinator serving (no false step-down)", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-stays-"));
	const restoreKnob = setHeartbeatKnob(100);
	/** @type {import("node:child_process").ChildProcess|null} */
	let child = null;
	/** @type {() => string} */
	let stderrText = () => "";
	try {
		const spawned = spawnCoordinatorDirect(root);
		child = spawned.child;
		stderrText = spawned.stderr;
		assert.ok(child.pid);
		assert.ok(await waitForCoordinatorReady(root, 10_000), "coordinator binds its endpoint");
		const lease = join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json");
		assert.ok(existsSync(lease), "precondition: the lease a step-down would release is owned");
		// ≥ 3 supervised ticks at the 100 ms knob.
		await sleep(500);
		assert.ok(isAlive(child.pid), "coordinator survives its ticks while the root is present");
		const pong = await rawPing(P.coordinatorEndpointPathFor(process.platform, root));
		assert.ok(pong, "coordinator still answers a ping");
		assert.equal(pong.type, "pong");
		// No false step-down. The root-missing path is observable only on stderr
		// (it writes no diagnostic by design), so a piped stderr is the evidence.
		assert.doesNotMatch(stderrText(), /board root missing/, `no root-missing line while the root exists (got: ${JSON.stringify(stderrText())})`);
	} finally {
		restoreKnob();
		await stopCoordinatorAndCleanup(child, root);
	}
});
