/**
 * Integration tests for the View State Coordinator client (issue #91, plan Task 5).
 * Fake in-process JSONL servers cover protocol/timeout/reset semantics; happy-path
 * suites spawn the REAL coordinator on isolated roots through the client's
 * ensure/spawn path (mirrors the state-coordinator integration fixture).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { test } from "node:test";
import { readJsonl } from "../src/core/atomic.mjs";
import { COORDINATOR_PROTOCOL_VERSION } from "../src/core/coordinator-protocol.mjs";
import { ensureCoordinator, judgeReplacementTarget, readCoordinatorLeaseRecord, replaceStaleCoordinator, sendStateCommand } from "../src/core/coordinator-client.mjs";
import * as P from "../src/core/paths.mjs";
import { captureStartToken, isAlive } from "../src/core/pid.mjs";
import { createView, readState } from "../src/core/store.mjs";

const COORDINATOR_SCRIPT = fileURLToPath(new URL("../runner/state-coordinator.mjs", import.meta.url));

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-cclient-"));
}

/**
 * In-process fake coordinator socket. Answers `ping` → pong; `state_command`
 * handling is caller-configured per test (reply / silence / destroy).
 * @param {{ onStateCommand?: (cmd: object, socket: import("node:net").Socket, seen: object[]) => void, protocolVersion?: number }} [handlers]
 */
async function startFakeServer(handlers = {}) {
	const root = freshRoot();
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	const seen = [];
	const connections = { count: 0 };
	const server = createServer((socket) => {
		connections.count += 1;
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const msg = JSON.parse(line);
				if (msg.type === "ping") {
					socket.write(JSON.stringify({ type: "pong", instanceId: "fake-1", startedAt: 1, protocolVersion: handlers.protocolVersion ?? COORDINATOR_PROTOCOL_VERSION }) + "\n");
					return;
				}
				seen.push(msg);
				handlers.onStateCommand?.(msg, socket, seen);
			}
		});
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(socketPath, () => resolveListen());
	});
	return {
		root,
		socketPath,
		seen,
		connections,
		close: () => new Promise((r) => server.close(() => r())),
	};
}

/** Fake server hook: echo a fixed state_command_result back. */
function replyWith(result) {
	return (cmd, socket) => {
		socket.write(JSON.stringify({ type: "state_command_result", commandId: cmd.commandId, ...result }) + "\n");
	};
}

function markCompleted(overrides = {}) {
	return {
		type: "state_command",
		kind: "mark_completed",
		viewId: "v1",
		runId: null,
		source: "dashboard-user",
		expectedRevision: null,
		payload: {},
		...overrides,
	};
}

test("sendStateCommand sends a state_command envelope and resolves the applied result", async (t) => {
	const fake = await startFakeServer({
		onStateCommand: replyWith({ status: "applied", reason: "manual_completion", materializedRevision: 3 }),
	});
	t.after(() => fake.close());

	const result = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 1500 });

	assert.deepEqual(result, { status: "applied", reason: "manual_completion", materializedRevision: 3 });
	assert.equal(fake.seen.length, 1);
	const envelope = fake.seen[0];
	assert.equal(envelope.type, "state_command");
	assert.equal(envelope.kind, "mark_completed");
	assert.equal(envelope.viewId, "v1");
	assert.equal(envelope.source, "dashboard-user");
	assert.match(envelope.commandId, /^[a-z]+_[0-9a-f]+$/);
});

test("caller-supplied commandId is preserved; otherwise a fresh id is generated per call", async (t) => {
	const fake = await startFakeServer({
		onStateCommand: replyWith({ status: "rejected", reason: "no_change", materializedRevision: 1 }),
	});
	t.after(() => fake.close());

	const first = await sendStateCommand(fake.root, markCompleted({ commandId: "cmd-fixed" }), { timeoutMs: 1500 });
	const second = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 1500 });

	assert.equal(fake.seen[0].commandId, "cmd-fixed");
	assert.notEqual(fake.seen[1].commandId, "cmd-fixed");
	assert.match(fake.seen[1].commandId, /^[a-z]+_[0-9a-f]+$/);
	assert.deepEqual(first, { status: "rejected", reason: "no_change", materializedRevision: 1 });
	assert.equal(second.status, "rejected");
});

test("timeout resolves rejected/timeout — ambiguous, no auto-retry", async (t) => {
	const fake = await startFakeServer({
		onStateCommand: () => { /* never answers */ },
	});
	t.after(() => fake.close());

	const result = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 150 });

	assert.deepEqual(result, { status: "rejected", reason: "timeout", materializedRevision: 0 });
	// Exactly one envelope was sent: the client never silently retries.
	assert.equal(fake.seen.length, 1);
});

test("connection reset mid-command resolves rejected/connection_reset — ambiguous, no auto-retry", async (t) => {
	const fake = await startFakeServer({
		onStateCommand: (cmd, socket) => {
			socket.destroy(); // crash-window simulation: no reply at all
		},
	});
	t.after(() => fake.close());

	const result = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 1500 });

	assert.deepEqual(result, { status: "rejected", reason: "connection_reset", materializedRevision: 0 });
	assert.equal(fake.seen.length, 1); // exactly one attempt, no silent retry
});

test("AGENT_BOARD_COORDINATOR=off short-circuits with coordinator_disabled and never connects", async (t) => {
	const fake = await startFakeServer({});
	t.after(() => fake.close());
	process.env.AGENT_BOARD_COORDINATOR = "off";
	try {
		const result = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 300 });
		assert.deepEqual(result, { status: "rejected", reason: "coordinator_disabled", materializedRevision: 0 });
		assert.equal(fake.connections.count, 0);
	} finally {
		delete process.env.AGENT_BOARD_COORDINATOR;
	}
});

test("ensureCoordinator spawns the real coordinator; sendStateCommand happy path is applied", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});

	createView(root, { id: "v1", name: "client-e2e", cwd: root });

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	assert.match(ensured.instanceId, /^[0-9a-f]+$/);
	assert.ok(ensured.pid, "spawning ensure reports the child pid for cleanup");
	track(ensured.pid);

	const result = await sendStateCommand(root, markCompleted(), { timeoutMs: 5000 });
	assert.equal(result.status, "applied");
	assert.ok(result.materializedRevision >= 1);

	const state = readState(root, "v1");
	assert.equal(state.semanticState, "completed");
	assert.equal(state.autoState, null);
	assert.ok(state.materializedRevision >= 1);
});

test("coordinator records its instanceId in the lease identity (issue #239 A4)", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});
	createView(root, { id: "v1", name: "a4", cwd: root });

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	if (ensured.pid) track(ensured.pid);

	const owner = JSON.parse(readFileSync(
		join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json"), "utf8"));
	assert.equal(typeof owner.identity?.instanceId, "string");
	assert.notEqual(owner.identity.instanceId.length, 0);
	assert.equal(owner.identity.instanceId, ensured.instanceId);
});

test("ensureCoordinator reclaims a stale identity-less orphan lease (issue #114)", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});

	// Residue of a killed coordinator on a platform without startToken (Windows):
	// dead pid, identity-less, past the 5min orphan age.
	const lockPath = P.viewLockPath(root, "_coordinator", "state-coordinator");
	mkdirSync(lockPath, { recursive: true });
	writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
		token: "orphan-lease",
		pid: 99999999,
		identity: { pid: 99999999, startToken: null },
		startedAt: Date.now() - 10 * 60_000,
	}), "utf8");

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true, "the orphan lease must be reclaimed, not block startup");
	assert.match(ensured.instanceId, /^[0-9a-f]+$/);
	track(ensured.pid);

	// On-disk proof of takeover: the planted orphan record is gone, replaced by
	// the live coordinator's own token and pid.
	const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
	assert.notEqual(owner.token, "orphan-lease", "the orphan token must no longer own the lock");
	assert.equal(owner.pid, ensured.pid, "the lock must now be owned by the spawned coordinator pid");
});

test("a coordinator started under one root spelling serves clients using another (issue #124)", async (t) => {
	const root = freshRoot(); // win32: mkdtempSync returns a backslash path
	t.after(async () => {
		await cleanupRoot(root);
	});
	const altRoot = process.platform === "win32" ? root.replace(/\\/g, "/") : `${root}/`;
	assert.notEqual(root, altRoot, "the two spellings must actually differ as strings");

	// the coordinator runs under altRoot; the panel client uses root
	const started = await ensureCoordinator(altRoot, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(started.ok, true, "coordinator must start under the alternate spelling");
	track(started.pid);

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true, "a client using the other spelling must reach a coordinator");
	assert.equal(ensured.instanceId, started.instanceId, "both spellings must resolve to ONE endpoint and owner");
});

test("two parallel ensureCoordinator calls converge on one owner; both clients get pongs", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});

	const [a, b] = await Promise.all([
		ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT }),
		ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT }),
	]);
	assert.equal(a.ok, true);
	assert.equal(b.ok, true);
	assert.equal(a.instanceId, b.instanceId); // one lease owner serves both
	if (a.pid) track(a.pid);
	if (b.pid) track(b.pid);
});

// --- protocol version gate (issue #108) ---

/**
 * One raw ping round-trip against any JSONL socket. Resolves the parsed pong
 * message, or null on timeout/error.
 * @param {string} socketPath
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>}
 */
function rawPing(socketPath, timeoutMs = 1000) {
	return new Promise((resolve) => {
		let settled = false;
		let buffer = "";
		/** @type {import("node:net").Socket|null} */
		let socket = null;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket?.destroy(); } catch { /* best effort */ }
			resolve(value);
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

/** Inline CJS body for the stale pre-#107 coordinator fixture. Binds the
 *  socket, answers pings with a pong that has NO protocolVersion field (the
 *  v1 wire format), publishes the coordinator lease record described by the
 *  JSON template, and on SIGTERM unlinks the socket + releases the lease.
 *  argv: socketPath, lockDir, ownerTemplateJson, pongInstanceId, pidModuleUrl.
 *  A templated pid/startToken of "@self" resolves to this child and its REAL
 *  live `/proc` token via the runtime's own captureStartToken, so a legacy
 *  scenario can record the live lease owner without racing the spawn. */
const STALE_COORDINATOR_CJS = `
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const socketPath = process.argv[2];
const lockDir = process.argv[3];
const ownerTemplate = JSON.parse(process.argv[4]);
const pongInstanceId = process.argv[5];
const pidModuleUrl = process.argv[6];

function resolveSelf(value) {
	return value === "@self" ? process.pid : value;
}

(async () => {
	const owner = JSON.parse(JSON.stringify(ownerTemplate));
	owner.pid = resolveSelf(owner.pid);
	owner.identity.pid = resolveSelf(owner.identity.pid);
	if (owner.identity.startToken === "@self") {
		const { captureStartToken } = await import(pidModuleUrl);
		owner.identity.startToken = captureStartToken(process.pid);
	}
	fs.mkdirSync(lockDir, { recursive: true });
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner));
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const msg = JSON.parse(line);
				if (msg.type === "ping") socket.write(JSON.stringify({ type: "pong", instanceId: pongInstanceId, startedAt: 1 }) + "\\n");
			}
		});
	});
	process.on("SIGTERM", () => {
		try { server.close(); } catch {}
		try { fs.unlinkSync(socketPath); } catch {}
		try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
		process.exit(0);
	});
	server.listen(socketPath);
})();
`;

/**
 * Build the lease record the fixture publishes. The default record is the
 * post-#239 shape: the fixture's own pid and an `instanceId` matching the
 * default pong ("stale-v1"). A caller-supplied `identity` replaces that default
 * field set (so a legacy scenario can omit `instanceId` entirely, and
 * `startToken: "@self"` records the child's live token); a top-level
 * `instanceId` override always wins (pass null for an instanceId-less record).
 * @param {{ pid?: number|string, instanceId?: string|null, identity?: object }} [ownerOverrides]
 */
function staleLeaseRecord(ownerOverrides = {}) {
	const pid = ownerOverrides.pid ?? "@self";
	const identity = ownerOverrides.identity
		? { pid, startToken: "1", ...ownerOverrides.identity }
		: { pid, startToken: "1", instanceId: "stale-v1" };
	if (ownerOverrides.instanceId !== undefined) identity.instanceId = ownerOverrides.instanceId;
	return { token: "stale", pid, identity, startedAt: 1 };
}

/**
 * Spawn a fake "old-build" coordinator as a REAL child process so the client's
 * identity-gated SIGTERM-via-lease-pid replacement path can be exercised end to
 * end. The lease the fixture publishes is parameterized per scenario; the
 * defaults keep the pre-#239 matching scenario (own pid, own pong instanceId).
 * @param {string} root
 * @param {{ pid?: number|string, instanceId?: string|null, identity?: object }} [ownerOverrides]
 * @param {string} [pongInstanceId]
 */
async function spawnStaleV1Coordinator(root, ownerOverrides = {}, pongInstanceId = "stale-v1") {
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	const lockDir = P.viewLockPath(root, "_coordinator", "state-coordinator");
	const scriptPath = join(root, "stale-coordinator.cjs");
	writeFileSync(scriptPath, STALE_COORDINATOR_CJS);
	const child = spawn(process.execPath, [
		scriptPath,
		socketPath,
		lockDir,
		JSON.stringify(staleLeaseRecord(ownerOverrides)),
		pongInstanceId,
		new URL("../src/core/pid.mjs", import.meta.url).href,
	], { stdio: "ignore" });
	const deadline = Date.now() + 3000;
	for (;;) {
		const pong = await rawPing(socketPath, 300);
		if (pong) break;
		if (Date.now() >= deadline) {
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
			throw new Error("stale coordinator fixture failed to bind");
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return {
		child,
		socketPath,
		alive() {
			try { process.kill(child.pid, 0); return true; } catch { return false; }
		},
		cleanup: () => {
			try { child.kill("SIGTERM"); } catch { /* already gone */ }
		},
	};
}

/**
 * Spawn a live, unrelated node process and register its cleanup. Its pid is the
 * bait planted in a lease: no identity gate may ever signal it.
 * @param {import("node:test").TestContext} t
 */
function spawnUnrelatedProcess(t) {
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	child.unref?.();
	t.after(() => {
		try { child.kill("SIGKILL"); } catch { /* already gone */ }
	});
	return child;
}

/**
 * Plant a coordinator lease owner.json under `root` for the ensure-level
 * pass-through tests, which need an exact lease shape rather than the fixture's
 * own writer.
 * @param {string} root
 * @param {{ pid: number, token?: string, instanceId?: string|null, startToken?: string|null }} record
 */
function plantLease(root, record) {
	const lockPath = P.viewLockPath(root, "_coordinator", "state-coordinator");
	mkdirSync(lockPath, { recursive: true });
	const identity = { pid: record.pid, startToken: record.startToken ?? null };
	if (record.instanceId !== undefined) identity.instanceId = record.instanceId;
	writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
		token: record.token ?? "planted",
		pid: record.pid,
		identity,
		startedAt: 1,
	}), "utf8");
}

test("coordinator pong carries the current protocol version", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	if (ensured.pid) track(ensured.pid);

	const pong = await rawPing(P.coordinatorEndpointPathFor(process.platform, root));
	assert.ok(pong, "coordinator answers ping");
	assert.equal(pong.protocolVersion, COORDINATOR_PROTOCOL_VERSION);
});

test("protocol version gates the holding command kinds (issue #145)", () => {
	// A live v2 coordinator answers unknown_kind for mark_holding/clear_holding
	// (issue #108 class); version 3 is the floor that ships them.
	assert.ok(COORDINATOR_PROTOCOL_VERSION >= 3, `expected >= 3, got ${COORDINATOR_PROTOCOL_VERSION}`);
});

test("A5: a matching-instanceId stale coordinator is replaced (end-to-end)", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});
	const stale = await spawnStaleV1Coordinator(root);
	t.after(() => stale.cleanup());
	createView(root, { id: "v1", name: "a5", cwd: root });

	// sanity: the fixture serves the v1 wire format (no version field) and its
	// lease names the SAME instance that answered the ping — the premise of the
	// identity gate.
	const stalePong = await rawPing(stale.socketPath);
	assert.equal(stalePong?.instanceId, "stale-v1");
	assert.equal(stalePong?.protocolVersion, undefined);
	assert.equal(readCoordinatorLeaseRecord(root)?.instanceId, stalePong?.instanceId,
		"the lease must name the instance that answered the ping");

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	assert.notEqual(ensured.instanceId, "stale-v1"); // a FRESH instance owns the lease now
	if (ensured.pid) track(ensured.pid);
	assert.equal(stale.alive(), false, "stale instance was terminated");

	const result = await sendStateCommand(root, markCompleted(), { timeoutMs: 5000 });
	assert.equal(result.status, "applied");

	// A matching replacement takes the signal path; only a deliberate skip
	// reports, so no replacement-skip diagnostic may exist for this root.
	const skips = readJsonl(P.diagnosticsPath(root, "_coordinator"))
		.filter((event) => event.code === "coordinator_replacement_skipped");
	assert.equal(skips.length, 0, "a matching replacement must not report a skip");
});

test("A6: a mismatched lease identity never kills the unrelated pid (core)", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});
	const unrelated = spawnUnrelatedProcess(t);
	// The lease names a DIFFERENT instance than the pong and its pid belongs to
	// the unrelated process: the identity gate must skip before any signal.
	const stale = await spawnStaleV1Coordinator(root, { pid: unrelated.pid, instanceId: "not-the-pong-instance" });
	t.after(() => stale.cleanup());
	const diagnostics = P.diagnosticsPath(root, "_coordinator");

	assert.equal((await rawPing(stale.socketPath))?.instanceId, "stale-v1");

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	if (ensured.pid) track(ensured.pid);
	assert.deepEqual(ensured, { ok: false, error: "coordinator_stale_protocol" });
	assert.equal(isAlive(unrelated.pid), true, "the unrelated process must survive");
	assert.equal(stale.alive(), true, "the stale fixture must survive too");

	const events = readJsonl(diagnostics).filter((event) => event.code === "coordinator_replacement_skipped");
	assert.equal(events.length, 1);
	assert.equal(events[0].details.reason, "lease_owner_mismatch");
	assert.equal(events[0].details.recordedInstanceId, "not-the-pong-instance");
	assert.equal(events[0].details.probedInstanceId, "stale-v1");
});

test("A7: a legacy record without instanceId/token is not signalled", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});
	const unrelated = spawnUnrelatedProcess(t);
	// Legacy (pre-#239) record shape: no instanceId and no recorded startToken,
	// with the lease pid pointing at an unrelated live process. Nothing proves
	// ownership, so the record must never be signalled.
	const stale = await spawnStaleV1Coordinator(root, {
		pid: unrelated.pid,
		identity: { pid: unrelated.pid, startToken: null },
	}, "legacy-pong");
	t.after(() => stale.cleanup());
	const diagnostics = P.diagnosticsPath(root, "_coordinator");

	assert.equal((await rawPing(stale.socketPath))?.instanceId, "legacy-pong");
	const lease = readCoordinatorLeaseRecord(root);
	assert.equal(lease?.instanceId, null, "the legacy lease carries no instanceId");
	assert.equal(lease?.startToken, null, "and no recorded startToken to fall back on");

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	if (ensured.pid) track(ensured.pid);
	assert.deepEqual(ensured, { ok: false, error: "coordinator_stale_protocol" });
	assert.equal(isAlive(unrelated.pid), true, "the unrelated lease pid must survive");
	assert.equal(stale.alive(), true);

	const events = readJsonl(diagnostics).filter((event) => event.code === "coordinator_replacement_skipped");
	assert.equal(events.length, 1);
	assert.equal(events[0].details.reason, "identity_unverified");
});

test("A7b: Linux legacy live-token wiring kills the real lease owner", { skip: process.platform !== "linux" }, async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});
	// The fixture records ITS OWN pid and the real live /proc start token (the
	// client's default readStartToken must read back the same value); the pong
	// instanceId is arbitrary because a legacy record carries none.
	const stale = await spawnStaleV1Coordinator(root, { identity: { startToken: "@self" } }, "legacy-pong");
	t.after(() => stale.cleanup());
	createView(root, { id: "v1", name: "a7b", cwd: root });

	const lease = readCoordinatorLeaseRecord(root);
	assert.equal(lease?.instanceId, null);
	assert.equal(lease?.pid, stale.child.pid, "the lease names the fixture child");
	assert.equal(lease?.startToken, captureStartToken(stale.child.pid),
		"the recorded token is the child's real live start token");

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	assert.notEqual(ensured.instanceId, "legacy-pong");
	if (ensured.pid) track(ensured.pid);
	assert.equal(stale.alive(), false, "the verified live lease owner was terminated");

	const result = await sendStateCommand(root, markCompleted(), { timeoutMs: 5000 });
	assert.equal(result.status, "applied");
});

test("A8: repeated ensures keep exactly one skip diagnostic", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});
	const unrelated = spawnUnrelatedProcess(t);
	// The A6 configuration: a lease whose identity mismatches the pong.
	const stale = await spawnStaleV1Coordinator(root, { pid: unrelated.pid, instanceId: "not-the-pong-instance" });
	t.after(() => stale.cleanup());
	const diagnostics = P.diagnosticsPath(root, "_coordinator");

	for (let attempt = 0; attempt < 5; attempt++) {
		assert.deepEqual(await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT }),
			{ ok: false, error: "coordinator_stale_protocol" }, `ensure #${attempt + 1} keeps reporting the stale protocol`);
	}
	const countSkips = () => readJsonl(diagnostics)
		.filter((event) => event.code === "coordinator_replacement_skipped").length;
	assert.equal(countSkips(), 1, "five ensures at the same stale state write exactly one diagnostic");
	assert.equal(isAlive(unrelated.pid), true);

	// The process-local dedup Set must short-circuit BEFORE any disk access:
	// deleting the file and ensuring again must not recreate it. A fresh root per
	// test keeps the module-level Set from masking this scenario.
	rmSync(diagnostics);
	assert.deepEqual(await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT }),
		{ ok: false, error: "coordinator_stale_protocol" });
	assert.equal(existsSync(diagnostics), false, "the Set hit must not touch or recreate the diagnostics file");
});

test("ensureCoordinator reports coordinator_stale_protocol instead of trusting an irreplaceable stale instance", async (t) => {
	const fake = await startFakeServer({ protocolVersion: 1 }); // in-process fake: no lease pid to SIGTERM
	t.after(() => fake.close());

	const ensured = await ensureCoordinator(fake.root, { runnerScript: COORDINATOR_SCRIPT });
	assert.deepEqual(ensured, { ok: false, error: "coordinator_stale_protocol" });
});

// --- issue #239: ensure-level pass-through of the replacement seams (D5) ---

test("ensureCoordinator forwards probe/connect/probeTimeoutMs/reportSkip into the replacement", async (t) => {
	const fake = await startFakeServer({ protocolVersion: 1 }); // pong instanceId "fake-1"
	t.after(() => fake.close());
	// Matching identity: the judge signals, so the injected re-probe decides the
	// outcome. A DIFFERENT old-protocol instance means the replacement raced; the
	// skip must go to the injected writer, never to the default diagnostics file.
	plantLease(fake.root, { pid: 99_999_999, instanceId: "fake-1" });
	const seen = { probes: [], connects: [], timeouts: [], skips: [] };
	const connect = (path) => createConnection(path);
	const ensured = await ensureCoordinator(fake.root, {
		runnerScript: COORDINATOR_SCRIPT,
		connect,
		probeTimeoutMs: 1234,
		probe: async (socketPath, probeConnect, timeoutMs) => {
			seen.probes.push(socketPath);
			seen.connects.push(probeConnect);
			seen.timeouts.push(timeoutMs);
			return { instanceId: "other-old", protocolVersion: 1 };
		},
		reportSkip: (details) => seen.skips.push(details),
	});
	if (ensured.pid) track(ensured.pid);

	assert.deepEqual(ensured, { ok: false, error: "coordinator_stale_protocol" });
	assert.equal(seen.probes.length, 1, "the injected probe replaces the real re-probe");
	assert.equal(seen.connects[0], connect, "connect is forwarded into the re-probe");
	assert.equal(seen.timeouts[0], 1234, "probeTimeoutMs is forwarded into the re-probe");
	assert.equal(seen.skips.length, 1);
	assert.equal(seen.skips[0].reason, "replacement_raced");
	assert.equal(existsSync(P.diagnosticsPath(fake.root, "_coordinator")), false,
		"the injected writer replaces the default diagnostic writer");
});

test("ensureCoordinator forwards the legacy/wait seams into the replacement", async (t) => {
	const fake = await startFakeServer({ protocolVersion: 1 });
	t.after(() => fake.close());
	// Legacy record: no instanceId and a recorded token, so only the injected
	// live read proves ownership. The injected kill/isAlive/clock/sleep keep the
	// never-exits branch deterministic: the fake lease pid never dies.
	plantLease(fake.root, { pid: 99_999_999, startToken: "1" });
	const seen = { tokens: [], kills: [], sleeps: 0 };
	const ensured = await ensureCoordinator(fake.root, {
		runnerScript: COORDINATOR_SCRIPT,
		readStartToken: async (pid) => {
			seen.tokens.push(pid);
			return "1";
		},
		kill: (pid, signal) => seen.kills.push([pid, signal]),
		isAlive: () => true,
		clock: () => 0,
		sleep: async () => { seen.sleeps += 1; },
		replaceTimeoutMs: 100,
	});
	if (ensured.pid) track(ensured.pid);

	assert.deepEqual(ensured, { ok: false, error: "coordinator_stale_protocol" });
	assert.deepEqual(seen.tokens, [99_999_999], "readStartToken is forwarded (legacy J3)");
	assert.deepEqual(seen.kills, [[99_999_999, "SIGTERM"]], "kill is forwarded and used exactly once");
	assert.ok(seen.sleeps > 0, "the injected sleep drives the never-exits wait");
});

// --- fixture helpers (mirrors state-coordinator.integration.test.mjs) ---

/** Pids of coordinators spawned by this test file, for the cleanup ladder. */
const spawnedPids = new Set();

/** @param {number|null|undefined} pid */
function track(pid) {
	if (pid) spawnedPids.add(pid);
}

/**
 * Poll (bounded) until every pid is really gone. `process.kill(pid, 0)` throws
 * ESRCH once the process exited, so a throw means "gone".
 * @param {number[]} pids @param {number} timeoutMs
 */
async function waitForPidsGone(pids, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	let alive = [...pids];
	while (alive.length > 0 && Date.now() < deadline) {
		alive = alive.filter((pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		});
		if (alive.length > 0) await new Promise((r) => setTimeout(r, 50));
	}
}

/**
 * Remove a temp tree, retrying the Windows handle-release races: a coordinator
 * spawned with cwd = the temp root keeps that directory handle for a moment
 * after it dies, so an immediate rmSync fails with EPERM/EBUSY. Anything else
 * (and the last attempt) throws.
 * @param {string} target @param {number} attempts
 */
async function rmTreeWithRetry(target, attempts = 20) {
	for (let attempt = 0; ; attempt++) {
		try {
			rmSync(target, { recursive: true, force: true });
			return;
		} catch (err) {
			const code = /** @type {NodeJS.ErrnoException} */ (err).code;
			if ((code !== "EPERM" && code !== "EBUSY") || attempt >= attempts - 1) throw err;
			await new Promise((r) => setTimeout(r, 100));
		}
	}
}

async function cleanupRoot(root) {
	for (const pid of spawnedPids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone (e.g. the lease loser exiting) — nothing to clean
		}
	}
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline && spawnedPids.size > 0) {
		for (const pid of [...spawnedPids]) {
			try {
				process.kill(pid, 0);
			} catch {
				spawnedPids.delete(pid);
			}
		}
		if (spawnedPids.size > 0) await new Promise((r) => setTimeout(r, 50));
	}
	const stubborn = [...spawnedPids];
	for (const pid of stubborn) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone already — fine
		}
	}
	await waitForPidsGone(stubborn);
	spawnedPids.clear();
	await rmTreeWithRetry(root);
}

// --- issue #239: lease record + pure judge (T1/T2) ---

function mkRecord(overrides = {}) {
	return { token: "t1", pid: 4242, instanceId: "abc", startToken: null, ...overrides };
}

test("judgeReplacementTarget: instanceId equality decides (J1/J2)", () => {
	assert.deepEqual(judgeReplacementTarget({ recorded: mkRecord(), probedInstanceId: "abc" }), { action: "signal" });
	assert.deepEqual(judgeReplacementTarget({ recorded: mkRecord(), probedInstanceId: "other" }),
		{ action: "skip", reason: "lease_owner_mismatch" });
});

test("judgeReplacementTarget: legacy startToken fallback (J3/J4/J5/J6)", () => {
	const legacy = mkRecord({ instanceId: null, startToken: "777" });
	assert.deepEqual(judgeReplacementTarget({ recorded: legacy, probedInstanceId: "x", currentStartToken: "777" }), { action: "signal" });
	assert.deepEqual(judgeReplacementTarget({ recorded: legacy, probedInstanceId: "x", currentStartToken: "888" }),
		{ action: "skip", reason: "pid_reused" });
	assert.deepEqual(judgeReplacementTarget({ recorded: legacy, probedInstanceId: "x", currentStartToken: null }),
		{ action: "skip", reason: "identity_unverified" });
	assert.deepEqual(judgeReplacementTarget({ recorded: legacy, probedInstanceId: "x", currentStartToken: Promise.resolve("777") }),
		{ action: "skip", reason: "identity_unverified" }, "a missed await must not read as pid_reused");
	const noToken = mkRecord({ instanceId: null, startToken: null });
	assert.deepEqual(judgeReplacementTarget({ recorded: noToken, probedInstanceId: "x" }),
		{ action: "skip", reason: "identity_unverified" });
});

test("judgeReplacementTarget: malformed records are never signalled (J7)", () => {
	assert.deepEqual(judgeReplacementTarget({ recorded: null, probedInstanceId: "x" }),
		{ action: "skip", reason: "lease_unreadable" });
	assert.deepEqual(judgeReplacementTarget({ recorded: mkRecord({ pid: 0 }), probedInstanceId: "abc" }),
		{ action: "skip", reason: "lease_unreadable" });
});

test("judgeReplacementTarget: empty-string fields count as missing", () => {
	assert.deepEqual(judgeReplacementTarget({ recorded: mkRecord({ instanceId: "" }), probedInstanceId: "abc" }),
		{ action: "skip", reason: "identity_unverified" });
});

test("readCoordinatorLeaseRecord parses identity / legacy / top-level instanceId (A2)", () => {
	const root = freshRoot();
	const lockPath = P.viewLockPath(root, "_coordinator", "state-coordinator");
	mkdirSync(lockPath, { recursive: true });
	const ownerPath = join(lockPath, "owner.json");

	assert.equal(readCoordinatorLeaseRecord(root), null, "missing owner.json");
	writeFileSync(ownerPath, "{not json", "utf8");
	assert.equal(readCoordinatorLeaseRecord(root), null, "corrupt json");

	writeFileSync(ownerPath, JSON.stringify({ token: "a", pid: 7, identity: { pid: 7, startToken: "9", instanceId: "i" } }), "utf8");
	assert.deepEqual(readCoordinatorLeaseRecord(root), { token: "a", pid: 7, instanceId: "i", startToken: "9" });

	writeFileSync(ownerPath, JSON.stringify({ token: "b", pid: 8, identity: { pid: 8, startToken: null } }), "utf8");
	assert.deepEqual(readCoordinatorLeaseRecord(root), { token: "b", pid: 8, instanceId: null, startToken: null });

	writeFileSync(ownerPath, JSON.stringify({ token: "c", pid: 9, instanceId: "top" }), "utf8");
	assert.equal(readCoordinatorLeaseRecord(root).instanceId, "top", "top-level compatibility");

	writeFileSync(ownerPath, JSON.stringify({ token: "d", identity: null }), "utf8");
	assert.equal(readCoordinatorLeaseRecord(root).pid, null);
	rmSync(root, { recursive: true, force: true });
});

// --- issue #239: replacement orchestration (T3) ---

/** Build injected dependencies for replaceStaleCoordinator; `calls` records kills. */
function mkReplacementDeps(overrides = {}) {
	const calls = { kill: [], probe: 0, report: [] };
	const deps = {
		readLease: () => mkRecord(),
		probe: async () => { calls.probe += 1; return { instanceId: "abc", protocolVersion: COORDINATOR_PROTOCOL_VERSION }; },
		kill: (pid, sig) => { calls.kill.push([pid, sig]); },
		isAlive: () => false,
		readStartToken: async () => null,
		clock: () => 0,
		sleep: async () => {},
		replaceTimeoutMs: 3000,
		reportSkip: (details) => { calls.report.push(details); },
		...overrides,
	};
	return { deps, calls };
}

test("A3a: matching instanceId signals once and reports replaced", async () => {
	const { deps, calls } = mkReplacementDeps();
	const out = await replaceStaleCoordinator("/root", "/sock", "abc", deps);
	assert.deepEqual(out, { replaced: true });
	assert.deepEqual(calls.kill, [[4242, "SIGTERM"]]);
});

test("A3b: mismatched instanceId never signals", async () => {
	const { deps, calls } = mkReplacementDeps({ readLease: () => mkRecord({ instanceId: "other" }) });
	const out = await replaceStaleCoordinator("/root", "/sock", "abc", deps);
	assert.deepEqual(out, { replaced: false, reason: "lease_owner_mismatch" });
	assert.deepEqual(calls.kill, []);
	assert.equal(calls.report.at(-1).reason, "lease_owner_mismatch");
});

test("A3c/A3d: re-probe null with dead pid replaces; with live pid skips", async () => {
	const dead = mkReplacementDeps({ probe: async () => null, isAlive: () => false });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", dead.deps), { replaced: true });
	assert.deepEqual(dead.calls.kill, []);

	const live = mkReplacementDeps({ probe: async () => null, isAlive: () => true });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", live.deps),
		{ replaced: false, reason: "instance_unresponsive" });
	assert.deepEqual(live.calls.kill, []);
});

test("A3e: another old-protocol instance taking over skips; a healthy one replaces", async () => {
	const stale = mkReplacementDeps({ probe: async () => ({ instanceId: "newer-old", protocolVersion: 1 }) });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", stale.deps),
		{ replaced: false, reason: "replacement_raced" });

	const healthy = mkReplacementDeps({ probe: async () => ({ instanceId: "new", protocolVersion: COORDINATOR_PROTOCOL_VERSION }) });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", healthy.deps), { replaced: true });
	assert.deepEqual(healthy.calls.kill, []);
});

test("A3f: lease changing between judge and signal skips", async () => {
	let reads = 0;
	const { deps, calls } = mkReplacementDeps({ readLease: () => (++reads === 1 ? mkRecord() : mkRecord({ token: "t2" })) });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", deps),
		{ replaced: false, reason: "lease_changed" });
	assert.deepEqual(calls.kill, []);
});

test("A3g: a process that never exits times out after the kill", async () => {
	let now = 0;
	const { deps, calls } = mkReplacementDeps({ isAlive: () => true, clock: () => now, sleep: async () => { now += 100; } });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", deps),
		{ replaced: false, reason: "replace_timeout" });
	assert.equal(calls.kill.length, 1);
});

test("A3h: a throwing reportSkip does not throw or change the outcome", async () => {
	const { deps } = mkReplacementDeps({
		readLease: () => mkRecord({ instanceId: "other" }),
		reportSkip: () => { throw new Error("disk full"); },
	});
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", deps),
		{ replaced: false, reason: "lease_owner_mismatch" });
});

test("A3j: unreadable lease on the null-probe re-read skips", async () => {
	let reads = 0;
	const { deps, calls } = mkReplacementDeps({
		probe: async () => null,
		readLease: () => (++reads === 1 ? mkRecord() : null),
	});
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", deps),
		{ replaced: false, reason: "lease_unreadable" });
	assert.deepEqual(calls.kill, []);
});

test("A3l: kill errors are contained (ESRCH replaces, EPERM times out)", async () => {
	const esrch = Object.assign(new Error("gone"), { code: "ESRCH" });
	const a = mkReplacementDeps({ kill: () => { throw esrch; } });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", a.deps), { replaced: true });

	const eperm = Object.assign(new Error("denied"), { code: "EPERM" });
	const b = mkReplacementDeps({ kill: () => { throw eperm; }, isAlive: () => true, clock: () => 0, sleep: async () => {} });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", b.deps),
		{ replaced: false, reason: "replace_timeout" });
});

test("A3k: a removed root is not resurrected by the skip diagnostic", async () => {
	const root = join(freshRoot(), "removed-root"); // never created on disk
	const { deps } = mkReplacementDeps({
		readLease: () => mkRecord({ instanceId: "other" }),
		reportSkip: undefined, // default writer -> existsSync guard
	});
	// default reportSkip is not injectable here; instead assert the default writer's guard:
	const out = await replaceStaleCoordinator(root, "/sock", "abc", { ...deps, reportSkip: undefined });
	assert.deepEqual(out, { replaced: false, reason: "lease_owner_mismatch" });
	assert.equal(existsSync(root), false, "a deleted/missing root must not be recreated");
});
