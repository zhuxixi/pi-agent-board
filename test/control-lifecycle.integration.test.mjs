import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import * as P from "../src/core/paths.mjs";
import { claimHost, createView, readHost } from "../src/core/store.mjs";

// Control command lifecycle e2e (issue #91 phase 5, spec D4 acceptance A1/A2
// runner half; A2's client-side reconcile ordering lives in its own file).
// Drives the OWNED main directly (instance-scoped config) — the legacy main
// fences every envelope by contract (instanceId null).

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-ctl-"));
}

// Same waitFor discipline as the other runner integration files: every
// predicate is "eventually happens"; generous ceilings only buy spawn latency
// under full-suite parallel load. Genuine loss still fails, only later.
async function waitFor(predicate, timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting");
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function hostReady(root, viewId) {
	const host = readHost(root, viewId);
	if (!host || host.state !== "alive" || !host.socketPath || !host.childPid) return false;
	return isAlive(host.runnerPid);
}

function send(socket, msg) {
	socket.write(JSON.stringify(msg) + "\n");
}

function listen(socket) {
	let buf = "";
	const messages = [];
	socket.on("data", (chunk) => {
		buf += chunk.toString();
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
	});
	return { messages };
}

async function waitForExit(child, timeoutMs) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return true;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(exited);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", () => finish(true));
	});
}

async function stopRunner(runner) {
	if (!runner || runner.exitCode !== null || runner.signalCode !== null) return;
	try { runner.kill("SIGTERM"); } catch {}
	if (!(await waitForExit(runner, 800)) && runner.exitCode === null && runner.signalCode === null) {
		try { runner.kill("SIGKILL"); } catch {}
		await waitForExit(runner, 500);
	}
}

function reapChild(root, viewId) {
	try {
		const pid = readHost(root, viewId)?.childPid;
		if (pid) process.kill(pid, "SIGKILL");
	} catch {}
}

let instanceCounter = 0;

/** Spawn the OWNED main against an instance-scoped endpoint (the production
 *  shape: claimHost record + instance config path + per-instance socket). */
function spawnOwnedRunner(root, viewId, { env = {}, cols = 80, rows = 24, instanceId = `inst-${viewId}-${++instanceCounter}` } = {}) {
	const meta = createView(root, { id: viewId, name: viewId, cwd: process.cwd() });
	const socketPath = P.hostEndpointPathFor(process.platform, root, viewId, instanceId);
	const configPath = P.hostConfigPathFor(root, viewId, instanceId);
	const claimed = claimHost(root, {
		viewId,
		instanceId,
		configPath,
		socketPath,
		claimAt: Date.now(),
		claimPid: process.pid,
		claimIdentity: null,
		cols,
		rows,
	});
	if (!claimed.claimed) throw new Error(`claim lost for ${viewId}/${instanceId}`);
	atomicWriteJson(configPath, {
		root,
		viewId,
		instanceId,
		socketPath,
		sessionFile: meta.sessionFile,
		cwd: process.cwd(),
		initialPrompt: null,
		piCommand: process.execPath,
		piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
		model: null,
		tools: null,
		env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", ...env },
		cols,
		rows,
	});
	const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	runner.stdout.resume();
	runner.stderr.resume();
	return { runner, instanceId, socketPath };
}

async function connectControl(socketPath) {
	const start = Date.now();
	while (Date.now() - start < 8000) {
		if (!existsSync(socketPath) && process.platform !== "win32") {
			await new Promise((r) => setTimeout(r, 50));
			continue;
		}
		const socket = createConnection(socketPath);
		try {
			await once(socket, "connect");
			return socket;
		} catch {
			socket.destroy();
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	throw new Error("timed out waiting for control socket");
}

/** Envelope with per-test unique ids and a fresh per-connection seq counter.
 * instanceId is REQUIRED per envelope (spec D4) — the runner rejects foreign
 * instanceIds with instance_mismatch, which is exactly the fencing under test. */
function makeClient(clientId, instanceId) {
	let seq = 0;
	return (msg) => ({ clientId, seq: ++seq, viewId: "v1", instanceId, ...msg });
}

function journalRecords(root, viewId) {
	try {
		return readFileSync(P.controlJournalPath(root, viewId), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

test("durable input: accepted→applied staged acks, echo lands, journal records both stages; same-commandId re-send is cached, never re-written", async () => {
	const root = freshRoot();
	let runner;
	let instanceId;
	try {
		({ runner, instanceId } = spawnOwnedRunner(root, "v1"));
		await waitFor(() => hostReady(root, "v1"));
		const socket = await connectControl(P.hostEndpointPathFor(process.platform, root, "v1", readHost(root, "v1").instanceId));
		const { messages } = listen(socket);
		const env = makeClient("ctl-1", instanceId);

		send(socket, env({ type: "input", durable: true, data: "hello\r", commandId: "cmd-1" }));
		await waitFor(() => {
			const applied = messages.find((m) => m.type === "cmd_ack" && m.commandId === "cmd-1" && m.stage === "applied");
			return applied && messages.some((m) => m.type === "output" && String(m.data).includes("echo:hello"));
		});
		const stages = messages.filter((m) => m.type === "cmd_ack" && m.commandId === "cmd-1").map((m) => m.stage);
		assert.deepEqual(stages, ["accepted", "applied"], "durable input acks accepted then applied, in order");

		const records = journalRecords(root, "v1").filter((r) => r.commandId === "cmd-1");
		assert.deepEqual(records.map((r) => r.kind), ["accepted", "applied"], "journal records both lifecycle stages");

		const recordsBefore = journalRecords(root, "v1").length;
		const echoesBefore = messages.filter((m) => m.type === "output" && String(m.data).includes("echo:hello")).length;
		send(socket, env({ type: "input", durable: true, data: "hello\r", commandId: "cmd-1" }));
		await waitFor(() => messages.filter((m) => m.type === "cmd_ack" && m.commandId === "cmd-1").length >= 3);
		const restage = messages.filter((m) => m.type === "cmd_ack" && m.commandId === "cmd-1").at(-1);
		assert.equal(restage.stage, "applied", "re-send of an applied commandId returns the cached final stage");
		assert.equal(journalRecords(root, "v1").length, recordsBefore, "re-send appends nothing to the journal");
		assert.equal(
			messages.filter((m) => m.type === "output" && String(m.data).includes("echo:hello")).length,
			echoesBefore,
			"re-send never writes to the child again (commandId dedup)",
		);
		socket.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("resize: applied ack carries the real PTY dims; duplicate commandId returns the cached result", async () => {
	const root = freshRoot();
	let runner;
	let instanceId;
	try {
		({ runner, instanceId } = spawnOwnedRunner(root, "v1"));
		await waitFor(() => hostReady(root, "v1"));
		const socket = await connectControl(P.hostEndpointPathFor(process.platform, root, "v1", readHost(root, "v1").instanceId));
		const { messages } = listen(socket);
		const env = makeClient("ctl-1", instanceId);

		send(socket, env({ type: "resize", cols: 100, rows: 30, commandId: "rs-1" }));
		await waitFor(() => messages.find((m) => m.type === "cmd_ack" && m.commandId === "rs-1" && m.stage === "applied"));
		const ack = messages.find((m) => m.type === "cmd_ack" && m.commandId === "rs-1");
		assert.equal(ack.cols, 100);
		assert.equal(ack.rows, 30);
		assert.equal(readHost(root, "v1").cols, 100, "host record mirrors the applied resize");

		send(socket, env({ type: "resize", cols: 100, rows: 30, commandId: "rs-1" }));
		await waitFor(() => messages.filter((m) => m.type === "cmd_ack" && m.commandId === "rs-1").length >= 2);
		const dup = messages.filter((m) => m.type === "cmd_ack" && m.commandId === "rs-1").at(-1);
		assert.equal(dup.stage, "applied");
		assert.equal(dup.cols, 100, "duplicate commandId returns the cached applied result");
		socket.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("terminate: applied (started) then observed (runner-finalizing evidence); idempotent repeat stays applied", async () => {
	const root = freshRoot();
	let runner;
	let instanceId;
	try {
		({ runner, instanceId } = spawnOwnedRunner(root, "v1"));
		await waitFor(() => hostReady(root, "v1"));
		const socket = await connectControl(P.hostEndpointPathFor(process.platform, root, "v1", readHost(root, "v1").instanceId));
		const { messages } = listen(socket);
		const env = makeClient("ctl-1", instanceId);

// node-pty fires onExit synchronously inside kill, so finalization (including
// socket teardown) completes within the first terminate's handler. A repeat
// arriving in the same batch re-enters the fresh-start branch but its applied
// ack is undeliverable (socket already destroyed) — the client's answer for
// the repeat is the already-delivered terminal evidence (observed + exit).
// The idempotency contract under test: NO error, NO observable second
// fresh-start side effects, and exactly one terminal observed stage per
// commandId. (On the legacy main, whose host keeps serving, a post-exit
// repeat would return a stale termination_started — a known imprecision,
// ledgered; nothing double-applies.)
		send(socket, env({ type: "terminate", commandId: "term-1" }));
		send(socket, env({ type: "terminate", commandId: "term-1" }));
		await waitFor(() => messages.some((m) => m.type === "cmd_ack" && m.commandId === "term-1" && m.stage === "observed"));
		const stages = messages.filter((m) => m.type === "cmd_ack" && m.commandId === "term-1").map((m) => m.stage);
		assert.ok(stages.includes("applied"), "terminate acks applied (started)");
		assert.equal(stages.filter((s) => s === "applied").length, 1, "the repeat never causes a second fresh-start applied");
		assert.equal(stages.filter((s) => s === "observed").length, 1, "exactly one terminal observed stage");
		assert.ok(!messages.some((m) => m.type === "error"), "repeat terminate is not an error");
		assert.equal(stages.at(-1), "observed", "terminate ends in the observed stage");
		const observed = messages.find((m) => m.type === "cmd_ack" && m.commandId === "term-1" && m.stage === "observed");
		assert.ok(
			observed.exitConfirmed === true || observed.runnerFinalizing === true,
			"observed carries structured evidence (exit confirmation or runner finalizing), never a bare claim",
		);
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("interrupt and detach emit applied acks; detach still ends the socket", async () => {
	const root = freshRoot();
	let runner;
	let instanceId;
	try {
		({ runner, instanceId } = spawnOwnedRunner(root, "v1"));
		await waitFor(() => hostReady(root, "v1"));
		const socket = await connectControl(P.hostEndpointPathFor(process.platform, root, "v1", readHost(root, "v1").instanceId));
		const { messages } = listen(socket);
		const env = makeClient("ctl-1", instanceId);

		send(socket, env({ type: "interrupt", commandId: "int-1" }));
		await waitFor(() => messages.find((m) => m.type === "cmd_ack" && m.commandId === "int-1" && m.stage === "applied"));

		send(socket, env({ type: "detach", commandId: "det-1" }));
		await waitFor(() => messages.find((m) => m.type === "cmd_ack" && m.commandId === "det-1" && m.stage === "applied"));
		await waitFor(() => socket.destroyed || socket.readableEnded);
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("instance fence: foreign instanceId rejected with currentInstanceId; legacy (no-envelope) commands stay byte-identical", async () => {
	const root = freshRoot();
	let runner;
	let instanceId;
	try {
		const spawned = spawnOwnedRunner(root, "v1");
		const instanceId = spawned.instanceId;
		runner = spawned.runner;
		await waitFor(() => hostReady(root, "v1"));
		const socket = await connectControl(spawned.socketPath);
		const { messages } = listen(socket);

		// Foreign instance: rejected with the current instanceId, nothing applied.
		send(socket, { type: "input", durable: true, data: "ghost\r", commandId: "cmd-x", clientId: "c", seq: 1, viewId: "v1", instanceId: "inst-foreign" });
		await waitFor(() => messages.find((m) => m.type === "error" && m.code === "instance_mismatch"));
		const err = messages.find((m) => m.type === "error" && m.code === "instance_mismatch");
		assert.equal(err.currentInstanceId, spawned.instanceId);
		assert.equal(err.commandId, "cmd-x");

		// Legacy keystroke (no envelope): echo, no cmd_ack, no fence.
		send(socket, { type: "input", data: "plain\r" });
		await waitFor(() => messages.some((m) => m.type === "output" && String(m.data).includes("echo:plain")));
		assert.equal(messages.some((m) => m.type === "cmd_ack"), false, "envelope-less commands get no lifecycle acks");

		// Legacy requestId durable input: input_ack contract unchanged (issue #70).
		send(socket, { type: "input", data: "followup\r", requestId: "req-1" });
		await waitFor(() => messages.some((m) => m.type === "input_ack" && m.requestId === "req-1"));

		// Legacy resize: host record moves, no cmd_ack.
		send(socket, { type: "resize", cols: 120, rows: 40 });
		await waitFor(() => readHost(root, "v1")?.cols === 120);
		assert.equal(messages.some((m) => m.type === "cmd_ack"), false);

		// The foreign-instance durable command never reached the child.
		await new Promise((r) => setTimeout(r, 250));
		assert.equal(messages.some((m) => m.type === "output" && String(m.data).includes("echo:ghost")), false, "fenced command is never applied");
		socket.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("seq: non-monotonic dropped with diagnostic; monotonic traffic unaffected; seq is never a dedup key", async () => {
	const root = freshRoot();
	let runner;
	let instanceId;
	try {
		({ runner, instanceId } = spawnOwnedRunner(root, "v1"));
		await waitFor(() => hostReady(root, "v1"));
		const socket = await connectControl(P.hostEndpointPathFor(process.platform, root, "v1", readHost(root, "v1").instanceId));
		const { messages } = listen(socket);
		const env = makeClient("ctl-1", instanceId);

		send(socket, env({ type: "input", durable: true, data: "one\r", commandId: "cmd-a" })); // seq 1
		await waitFor(() => messages.some((m) => m.type === "cmd_ack" && m.commandId === "cmd-a" && m.stage === "applied"));

		send(socket, env({ type: "input", durable: true, data: "two\r", commandId: "cmd-b", seq: -3 })); // invalid seq
		send(socket, env({ type: "input", durable: true, data: "three\r", commandId: "cmd-c", seq: 1 })); // regression (1 ≤ 1)
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(messages.some((m) => m.type === "cmd_ack" && m.commandId === "cmd-b"), false, "invalid seq dropped");
		assert.equal(messages.some((m) => m.type === "cmd_ack" && m.commandId === "cmd-c"), false, "seq regression dropped");
		assert.equal(messages.some((m) => m.type === "output" && String(m.data).includes("echo:two")), false);
		assert.equal(messages.some((m) => m.type === "output" && String(m.data).includes("echo:three")), false);
		const diags = readDiagnostics(root, "v1");
		assert.ok(diags.some((d) => d.code === "seq_out_of_order"), "regression recorded as an ordering diagnostic");

		// Same commandId, NEW (higher) seq: dedup keys on commandId only — cached
		// applied, no second write. Proves seq is not the dedup key.
		const appliedBefore = messages.filter((m) => m.type === "cmd_ack" && m.commandId === "cmd-a" && m.stage === "applied").length;
		send(socket, env({ type: "input", durable: true, data: "one\r", commandId: "cmd-a", seq: 9 }));
		await waitFor(() => messages.filter((m) => m.type === "cmd_ack" && m.commandId === "cmd-a" && m.stage === "applied").length > appliedBefore);
		socket.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("restart: journal survives — reconcile reports accepted_unknown, never replayed; generation changes across restart", async () => {
	const root = freshRoot();
	let runner;
	let instanceId;
	try {
		// Simulate a PREVIOUS runner's journal: an accepted command whose applied
		// never landed (the §10 fault window), left on disk before this spawn.
		const meta = createView(root, { id: "v1", name: "v1", cwd: process.cwd() });
		void meta;
		const staleAccepted = { kind: "accepted", commandId: "cmd-stale", command: "stale\r", acceptedAt: 1 };
		writeFileSync(P.controlJournalPath(root, "v1"), JSON.stringify(staleAccepted) + "\n");

		const first = spawnOwnedRunner(root, "v1");
		let instanceId = first.instanceId;
		runner = first.runner;
		await waitFor(() => hostReady(root, "v1"));
		// The coordinator owns state.json in production; simulate its stamp AFTER
		// the runner boots (spawnOwnedRunner's createView resets state.json).
		atomicWriteJson(P.statePath(root, "v1"), { materializedRevision: 42 });
		const socket1 = await connectControl(first.socketPath);
		const { messages: messages1 } = listen(socket1);
		const env1 = makeClient("ctl-1", instanceId);

		send(socket1, env1({ type: "reconcile", commandId: "rec-1" }));
		await waitFor(() => messages1.find((m) => m.type === "reconcile_result" && m.commandId === "rec-1"));
		const rec1 = messages1.find((m) => m.type === "reconcile_result");
		assert.equal(typeof rec1.generation, "string");
		assert.ok(rec1.generation.length > 0, "reconcile carries the generation token");
		assert.equal(typeof rec1.hostRevision, "number");
		assert.ok(rec1.hostRevision >= 1);
		assert.equal(typeof rec1.terminalCursor.lastSeq, "number");
		assert.equal(rec1.stateMaterializedRevision, 42, "state materialized revision surfaced from the stamp");
		assert.equal(rec1.unresolved.length, 1);
		assert.equal(rec1.unresolved[0].commandId, "cmd-stale");
		assert.equal(rec1.unresolved[0].status, "accepted_unknown");
		assert.equal(rec1.unresolved[0].command, "stale\r", "unresolved entries surface the command text");
		assert.equal(rec1.unresolved[0].acceptedAt, 1);
		const helloGeneration = messages1.find((m) => m.type === "hello")?.generation;
		assert.equal(helloGeneration, rec1.generation, "hello and reconcile agree on the generation");
		socket1.destroy();
		await stopRunner(runner);
		reapChild(root, "v1");

		// Restart with a NEW instance (service contract: every spawn is a new
		// generation). The stale accepted_unknown must NOT replay into the new
		// child, and a re-send returns the cached accepted stage.
		const second = spawnOwnedRunner(root, "v1");
		instanceId = second.instanceId;
		runner = second.runner;
		await waitFor(() => hostReady(root, "v1"));
		const socket2 = await connectControl(second.socketPath);
		const { messages: messages2 } = listen(socket2);
		const env2 = makeClient("ctl-2", instanceId);

		send(socket2, { type: "hello" });
		await waitFor(() => messages2.find((m) => m.type === "hello" && m.generation));
		assert.notEqual(messages2.find((m) => m.type === "hello").generation, rec1.generation, "generation changes across runner restart");

		send(socket2, env2({ type: "reconcile", commandId: "rec-2" }));
		await waitFor(() => messages2.find((m) => m.type === "reconcile_result" && m.commandId === "rec-2"));
		const rec2 = messages2.find((m) => m.type === "reconcile_result" && m.commandId === "rec-2");
		assert.equal(rec2.unresolved.length, 1);
		assert.equal(rec2.unresolved[0].commandId, "cmd-stale");
		assert.equal(rec2.unresolved[0].status, "accepted_unknown", "the §10 window survives restart");
		assert.equal(rec2.unresolved[0].command, "stale\r");

		send(socket2, env2({ type: "input", durable: true, data: "stale\r", commandId: "cmd-stale" }));
		await waitFor(() => messages2.some((m) => m.type === "cmd_ack" && m.commandId === "cmd-stale"));
		const staleAck = messages2.find((m) => m.type === "cmd_ack" && m.commandId === "cmd-stale");
		assert.equal(staleAck.stage, "accepted", "re-send of an accepted-unknown returns the journaled stage, not applied");
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(messages2.some((m) => m.type === "output" && String(m.data).includes("echo:stale")), false, "§10: never auto-replayed into the new child");
		const staleRecords = journalRecords(root, "v1").filter((r) => r.commandId === "cmd-stale");
		assert.equal(staleRecords.filter((r) => r.kind === "accepted").length, 1, "journal never re-appends an accepted commandId");
		socket2.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
