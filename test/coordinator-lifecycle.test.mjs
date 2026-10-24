import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, dirname, join, resolve } from "node:path";
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
	for (const input of [base, `${base}/`, join(base, "views", "..")]) {
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
		const { pid } = launchCoordinator(root, { runnerScript: fake });
		assert.ok(pid, "detached child has a pid");
		const probePath = join(root, "spawn-probe.json");
		const raw = await waitFor(() => (existsSync(probePath) ? readFileSync(probePath, "utf8") : null), 5000);
		assert.ok(raw, "fake runner must write its probe file");
		const probe = JSON.parse(raw);
		const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
		assert.equal(norm(probe.arg), norm(root), "argv[2] is the absolute root");
		assert.equal(norm(probe.cwd), norm(dirname(root)), "cwd is the root's parent, not the root");
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
 * Poll a pid until the process is gone. Returns whether it is gone.
 * @param {number} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForPidGone(pid, timeoutMs = 5000) {
	const start = Date.now();
	while (Date.now() - start <= timeoutMs) {
		if (!isAlive(pid)) return true;
		await sleep(25);
	}
	return !isAlive(pid);
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
 * Cleanup for any coordinator that did NOT self-exit: SIGTERM → poll → SIGKILL,
 * then remove the root with rename-retry slack (win32 rejects a delete while a
 * heartbeat file is briefly open). Never throws, so a failing assertion keeps
 * its original error.
 * @param {number|null} pid
 * @param {string} root
 * @returns {Promise<void>}
 */
async function stopCoordinatorAndCleanup(pid, root) {
	if (pid && isAlive(pid)) {
		try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
		if (!await waitForPidGone(pid, 4000)) {
			try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
			await waitForPidGone(pid, 2000);
		}
	}
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

test("A3 deleting the root makes the coordinator exit within the grace window", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-exit-"));
	const restoreKnob = setHeartbeatKnob(100);
	/** @type {number|null} */
	let pid = null;
	try {
		({ pid } = launchCoordinator(root, { runnerScript: COORDINATOR_SCRIPT }));
		assert.ok(pid);
		assert.ok(await waitForCoordinatorReady(root, 10_000), "coordinator binds its endpoint");
		const lease = join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json");
		assert.ok(existsSync(lease), "lease exists BEFORE the delete (anti-vacuous precondition)");
		assert.ok(isAlive(pid), "coordinator is alive before the delete");
		rmSync(root, { recursive: true, force: true }); // must not throw: cwd no longer pins the root
		assert.equal(existsSync(root), false);
		await waitForPidGone(pid, 5000);
		assert.equal(isAlive(pid), false, "coordinator exits after its root vanished");
		// Discriminator (anti-vacuous): a vanished root ALSO makes `lease.touch()`
		// fail, so the pre-#241 heartbeat-loss fallback (3 consecutive failures)
		// already kills the process — the pid assertion above passes without any
		// root check. The step-down must be attributed to the root check, which
		// fires on the FIRST tick after the delete. The diagnostic write recreates
		// the deleted directory chain, which is why the file is readable here.
		const diagnostics = P.diagnosticsPath(root, "_coordinator");
		assert.ok(existsSync(diagnostics), "the step-down diagnostic is recorded");
		const codes = readFileSync(diagnostics, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line).code);
		assert.ok(codes.includes("coordinator_root_missing"), `step-down is attributed to the root check (codes: ${codes.join(",")})`);
		assert.equal(codes.includes("coordinator_heartbeat_lost"), false, "the heartbeat-loss fallback must not be what fired");
	} finally {
		restoreKnob();
		await stopCoordinatorAndCleanup(pid, root);
	}
});

test("A3b a root deleted before boot makes the coordinator exit without lingering", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-bootgone-"));
	rmSync(root, { recursive: true, force: true });
	const restoreKnob = setHeartbeatKnob(100);
	/** @type {number|null} */
	let pid = null;
	try {
		assert.equal(existsSync(root), false, "precondition: the root is already gone at spawn time");
		({ pid } = launchCoordinator(root, { runnerScript: COORDINATOR_SCRIPT }));
		assert.ok(pid, "detached child has a pid");
		await waitForPidGone(pid, 5000);
		assert.equal(isAlive(pid), false, "a coordinator with no board root exits instead of serving forever");
		assert.equal(await waitForCoordinatorReady(root, 300), false, "nothing answers on the endpoint");
		// Lease acquisition runs ensureDir, so an unguarded boot would recreate the
		// deleted board and serve that empty root indefinitely. A throwaway root
		// must stay deleted (issue #241 G2).
		assert.equal(existsSync(root), false, "the boot path must not resurrect the deleted root");
	} finally {
		restoreKnob();
		await stopCoordinatorAndCleanup(pid, root);
	}
});

test("A4 a present root keeps the coordinator serving (no false step-down)", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-stays-"));
	const restoreKnob = setHeartbeatKnob(100);
	/** @type {number|null} */
	let pid = null;
	try {
		({ pid } = launchCoordinator(root, { runnerScript: COORDINATOR_SCRIPT }));
		assert.ok(pid);
		assert.ok(await waitForCoordinatorReady(root, 10_000), "coordinator binds its endpoint");
		const lease = join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json");
		assert.ok(existsSync(lease), "precondition: the lease a step-down would release is owned");
		// ≥ 3 supervised ticks at the 100 ms knob.
		await sleep(500);
		assert.ok(isAlive(pid), "coordinator survives its ticks while the root is present");
		const pong = await rawPing(P.coordinatorEndpointPathFor(process.platform, root));
		assert.ok(pong, "coordinator still answers a ping");
		assert.equal(pong.type, "pong");
		// No false step-down. The file may legitimately not exist yet (nothing has
		// logged), in which case there is nothing to contradict the absence.
		const diagnostics = P.diagnosticsPath(root, "_coordinator");
		if (existsSync(diagnostics)) {
			const lines = readFileSync(diagnostics, "utf8").split("\n").filter((line) => line.trim());
			assert.equal(lines.some((line) => line.includes('"code":"coordinator_root_missing"')), false, "no root-missing diagnostic while the root exists");
		}
	} finally {
		restoreKnob();
		await stopCoordinatorAndCleanup(pid, root);
	}
});
