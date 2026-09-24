// Control reconcile integration (issue #91 phase 5, spec D4 acceptance A2):
// disconnect mid-stream → reconnect executes hello → reconcile →
// snapshot/subscribe IN ORDER → retryable commands resume exactly-once, with
// the reconcile baseline (generation / hostRevision / terminalCursor /
// stateMaterializedRevision) consistent with the runner's own state.
//
// Also carries the Task-3-deferred component-level pin (runner restart with a
// generation change discards the cursor — the epoch-ambiguity structural fix)
// and the §10 true end-to-end (accepted-before-restart survives as
// accepted_unknown; the service marks the item failed and the new child is
// never written).
//
// Layer choice for the epoch pin: client-module level over a REAL socket and a
// REAL runner restart. The client module owns the reconnect/epoch decision
// (the UI consumes its events, unit-pinned in terminal-attach-client.test.mjs);
// a component-level pty-attach.ts harness would only re-test the same decision
// through one more indirection.
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
import { readFollowUpQueue } from "../src/core/follow-up-queue.mjs";
import { createTerminalAttachClient } from "../src/core/terminal-attach-client.mjs";
import * as P from "../src/core/paths.mjs";
import { claimHost, createView, readHost, readState, writeHost, writeState } from "../src/core/store.mjs";
import { createService } from "../src/runtime/service.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-reconcile-"));
}

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
		for (const line of lines) {
			if (!line.trim()) continue;
			try { messages.push(JSON.parse(line)); } catch { /* malformed line: not a protocol message */ }
		}
	});
	return { messages };
}

/** Distinct seqs strictly greater than `from`, in first-occurrence order. */
function distinctSeqsFrom(seqs, from) {
	const seen = new Set();
	const out = [];
	for (const s of seqs) {
		if (typeof s !== "number" || s <= from) continue;
		if (!seen.has(s)) {
			seen.add(s);
			out.push(s);
		}
	}
	return out;
}

/** True when the wire repeated at least one seq — the broadcast→replay overlap. */
function hasWireOverlap(seqs) {
	return new Set(seqs).size !== seqs.length;
}

/** The first `count` distinct seqs must be exactly from+1 .. from+count (no gap). */
function isContiguousFrom(distinct, from, count) {
	if (distinct.length < count) return false;
	for (let i = 0; i < count; i += 1) {
		if (distinct[i] !== from + i + 1) return false;
	}
	return true;
}

/**
 * Cross-socket wire/event recorder with windows (#140): `mark()` snapshots the
 * current lengths; `messagesSince(mark)` / `eventsSince(mark)` scope reads to
 * everything recorded AFTER the mark, so pre-reconnect residue can never leak
 * into post-reconnect assertions. `messages` / `events` stay live arrays for
 * the legacy accessors.
 */
function createRecorder() {
	const messages = [];
	const events = [];
	return {
		messages,
		events,
		mark: () => ({ m: messages.length, e: events.length }),
		messagesSince: (mark) => messages.slice(mark.m),
		eventsSince: (mark) => events.slice(mark.e),
	};
}

// --- #140: seq-window predicates (pure) and the windowed recorder ----------

test("seq window predicates: distinctSeqsFrom keeps first-occurrence order and drops <= from", () => {
	assert.deepEqual(distinctSeqsFrom([7, 7, 8, 9, 7], 6), [7, 8, 9]);
	assert.deepEqual(distinctSeqsFrom([9, 10, 9, 11], 8), [9, 10, 11]);
	assert.deepEqual(distinctSeqsFrom([13, 14, 15, 16, 17, 18, 13, 14, 15, 16, 17, 18], 12), [13, 14, 15, 16, 17, 18]);
	assert.deepEqual(distinctSeqsFrom([1, 2, 3], 3), []); // boundary: `from` itself excluded
});

test("seq window predicates: hasWireOverlap", () => {
	assert.equal(hasWireOverlap([7, 7, 8]), true);
	assert.equal(hasWireOverlap([7, 8, 9]), false);
	assert.equal(hasWireOverlap([]), false);
});

test("seq window predicates: isContiguousFrom", () => {
	assert.equal(isContiguousFrom([7, 8, 9], 6, 3), true);
	assert.equal(isContiguousFrom([8, 9, 10], 6, 3), false); // replay start too high (gap at 7)
	assert.equal(isContiguousFrom([7, 9, 10], 6, 3), false); // a dropped chunk
	assert.equal(isContiguousFrom([7, 8], 6, 3), false); // not enough yet
});

test("recorder window: since(mark) excludes everything before the mark", () => {
	const rec = createRecorder();
	rec.messages.push({ type: "hello" });
	rec.events.push({ event: "snapshotReady", payload: { nextSeq: 1 } });
	const mark = rec.mark();
	rec.messages.push({ type: "output", seq: 7 });
	rec.events.push({ event: "output", payload: "x" });
	assert.equal(rec.messagesSince(mark).length, 1);
	assert.equal(rec.messagesSince(mark)[0].seq, 7);
	assert.equal(rec.eventsSince(mark)[0].event, "output");
	assert.equal(rec.messages.length, 2); // live arrays: legacy accessors keep working
});

let instanceCounter = 0;

/** Spawn the OWNED main (instance-scoped endpoint) — same shape as the
 *  control-lifecycle harness. Steady mode gives a continuous tick stream so a
 *  mid-stream cursor is non-degenerate. */
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
		env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "steady", ...env },
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

async function stopRunner(runner) {
	if (!runner || runner.exitCode !== null || runner.signalCode !== null) return;
	try { runner.kill("SIGTERM"); } catch {}
	await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), 800);
		runner.once("exit", () => { clearTimeout(timer); resolve(true); });
	});
	if (runner.exitCode === null && runner.signalCode === null) {
		try { runner.kill("SIGKILL"); } catch {}
	}
}

function reapChild(root, viewId) {
	try {
		const pid = readHost(root, viewId)?.childPid;
		if (pid) process.kill(pid, "SIGKILL");
	} catch { /* already gone */ }
}

/** Durable-input envelope as the service would send it (stable commandId). */
function durableInput({ clientId, seq, instanceId, viewId = "v1", commandId, data }) {
	return { type: "input", durable: true, commandId, clientId, seq, viewId, instanceId, data };
}

/** Drive the real client module over real sockets. The hello is UI-owned and
 *  routed through the same wire recorder so the reconnect ORDER assertion sees
 *  every client-side byte. */
function attachClientOverSocket(socket, { clientId = "reconcile-ui", deferWrite = () => 0, deferFeed = () => 0 } = {}) {
	const sent = [];
	const rec = createRecorder();
	const { messages, events } = rec;
	let buf = "";
	let current = socket;
	const route = (msg) => {
		sent.push(msg);
		// Injection seam (#140 A4): defer the WRITE only. `sent` records before
		// the deferral, so wire-order assertions stay truthful.
		const writeDelay = deferWrite(msg);
		if (writeDelay > 0) {
			const target = current;
			setTimeout(() => {
				try { target.write(JSON.stringify(msg) + "\n"); } catch { /* socket death is the close handler's job */ }
			}, writeDelay);
			return;
		}
		try { current.write(JSON.stringify(msg) + "\n"); } catch { /* socket death is the close handler's job */ }
	};
	const feed = (chunk) => {
		buf += chunk.toString("utf8");
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let msg;
			try { msg = JSON.parse(line); } catch { continue; }
			// Injection seam (#140 A6): defer BOTH the recording and the client
			// handling — a slow consumer, for one message class only.
			const feedDelay = deferFeed(msg);
			if (feedDelay > 0) {
				setTimeout(() => {
					messages.push(msg);
					client.handleMessage(msg);
				}, feedDelay);
				continue;
			}
			messages.push(msg);
			client.handleMessage(msg);
		}
	};
	const client = createTerminalAttachClient({
		send: route,
		emit: (event, payload) => events.push({ event, payload }),
		clientId,
	});
	const bind = (s) => {
		s.on("data", feed);
		s.on("close", () => client.onDisconnect());
	};
	bind(socket);
	return {
		client,
		sent,
		events,
		messages,
		/** UI-owned hello, through the recorder (A2 wire-order visibility). */
		hello: () => route({ type: "hello", clientId }),
		switchSocket: (next) => {
			current = next;
			bind(next);
		},
		eventsOf: (name) => events.filter((e) => e.event === name).map((e) => e.payload),
		mark: () => rec.mark(),
		messagesSince: (mark) => rec.messagesSince(mark),
		eventsSince: (mark) => rec.eventsSince(mark),
		// The client's "output" event payload is the bare data string — read
		// seqs/content from the wire-level messages instead (this socket carries
		// ONLY the subscribed stream once subscribe_terminal was sent: sticky
		// ownership excludes the legacy broadcast).
		outputSeqs: () => messages.filter((m) => m.type === "output" && typeof m.seq === "number").map((m) => m.seq),
		echoCount: (needle) => messages.filter((m) => m.type === "output" && String(m.data ?? "").includes(needle)).length,
	};
}

test("A2: reconnect wires hello → reconcile → subscribe in order; baseline matches the runner; retryable durable input resumes exactly-once", async () => {
	const root = freshRoot();
	let runner;
	let socket2 = null;
	try {
		const spawned = spawnOwnedRunner(root, "v1");
		runner = spawned.runner;
		const { instanceId, socketPath } = spawned;
		await waitFor(() => hostReady(root, "v1"));

		const socket1 = await connectControl(socketPath);
		const h = attachClientOverSocket(socket1);
		h.hello();
		await waitFor(() => h.messages.some((m) => m.type === "hello" && m.generation));
		const gen1 = h.client.getIdentity().generation;
		assert.equal(typeof gen1, "string");
		h.client.start();
		const ready = await waitFor(() => h.eventsOf("snapshotReady")[0]);
		assert.equal(typeof ready.nextSeq, "number");
		await waitFor(() => h.client.getLastSeq() >= ready.nextSeq + 2, 10000);

		// Retryable durable command BEFORE the drop; it resumes after reconnect.
		// seq 1: the FIRST enveloped message on this connection (the watermark is
		// per-connection monotonic — start() probes are not enveloped).
		send(socket1, durableInput({ clientId: "svc-sim", seq: 1, instanceId, commandId: "follow-1", data: "resume-probe\r" }));
		await waitFor(() => h.messages.some((m) => m.type === "cmd_ack" && m.commandId === "follow-1" && m.stage === "applied"));
		await waitFor(() => h.echoCount("echo:resume-probe") >= 1);
		const disconnectSeq = h.client.getLastSeq();

		// Drop. Reconnect on a fresh socket with the SAME client instance.
		socket1.destroy();
		socket2 = await connectControl(socketPath);
		h.switchSocket(socket2);
		const wireStart = h.sent.length;
		h.hello();
		h.client.reconnect(disconnectSeq);

		const reconciled = await waitFor(() => h.eventsOf("reconciled")[0]);
		// Wire order (spec D4): hello → reconcile → snapshot/subscribe.
		assert.deepEqual(
			h.sent.slice(wireStart).map((m) => m.type),
			["hello", "reconcile", "subscribe_terminal"],
			"reconnect must wire hello → reconcile → subscribe, in order",
		);
		// Baseline consistency with the runner's own state.
		assert.equal(reconciled.generation, gen1, "same runner ⇒ same generation (no epoch reset)");
		assert.equal(h.client.getIdentity().generation, gen1);
		assert.equal(typeof reconciled.hostRevision, "number");
		assert.ok(reconciled.hostRevision >= 1, "host revision is the runner's update counter");
		assert.equal(typeof reconciled.terminalCursor.lastSeq, "number");
		assert.ok(reconciled.terminalCursor.lastSeq >= disconnectSeq, "the runner's cursor is at least the client's cursor");
		assert.ok(
			reconciled.stateMaterializedRevision === null || typeof reconciled.stateMaterializedRevision === "number",
			"state stamp: null (no coordinator write in this fixture) or a materialized revision",
		);
		const sub = h.sent[h.sent.length - 1];
		assert.equal(sub.type, "subscribe_terminal");
		// Same generation ⇒ replay from the applied cursor — EXACTLY the cursor
		// when no steady tick landed inside the gate window, or the stray
		// high-water when one did (the stray was emitted + the cursor advanced
		// past it: exactly-once delivery, pinned by the marker cross-check below).
		assert.ok(
			sub.sinceSeq === disconnectSeq || sub.sinceSeq > disconnectSeq,
			`same generation ⇒ replay path (sinceSeq=${sub.sinceSeq} covers the applied cursor ${disconnectSeq})`,
		);

		// Gap-free continuation after the reconnect. The WIRE may legally repeat
		// seqs at the broadcast→replay handoff (#140 signature A): a stray the
		// runner raw-wrote before processing our subscribe can only be DELIVERED
		// after we sent it, so the client cannot fold it into the cursor — the
		// ring replay re-sends it and seq-checked consumption dedups. The
		// invariant is "no gap over the distinct seqs"; a UI-level duplicate is
		// the marker guard's job below.
		await waitFor(() => distinctSeqsFrom(h.outputSeqs(), disconnectSeq).length >= 3);
		const distinct = distinctSeqsFrom(h.outputSeqs(), disconnectSeq);
		assert.ok(
			isContiguousFrom(distinct, disconnectSeq, 3),
			`no gap after reconnect: distinct seqs past the cursor were ${JSON.stringify(distinct.slice(0, 8))}`,
		);
		await waitFor(() => h.client.getLastSeq() >= disconnectSeq + 3, 10000);
		// Task-5 review P0 regression guard: every wire-delivered seq past the
		// cursor must reach the UI exactly once (gate strays are EMITTED, replay
		// covers the rest). Compare steady markers: wire vs emitted events.
		{
			const wireMarkers = h.messages
				.filter((m) => m.type === "output" && typeof m.seq === "number" && m.seq > disconnectSeq)
				.flatMap((m) => String(m.data ?? "").match(/steady-\d+/g) ?? []);
			const uiMarkers = h.events
				.filter((e) => e.event === "output")
				.flatMap((e) => String(e.payload ?? "").match(/steady-\d+/g) ?? []);
			const wireSet = new Set(wireMarkers);
			const uiCounts = new Map();
			for (const mk of uiMarkers) uiCounts.set(mk, (uiCounts.get(mk) ?? 0) + 1);
			for (const mk of wireSet) {
				assert.equal(uiCounts.get(mk) ?? 0, 1, `steady marker ${mk} delivered to the UI exactly once`);
			}
		}

		// The retried durable command dedups to the cached applied stage — the
		// child sees the prompt exactly once across the reconnect. (seq 2: the
		// client's reconnect reconcile already consumed seq 1 on this socket.)
		send(socket2, durableInput({ clientId: "svc-sim", seq: 2, instanceId, commandId: "follow-1", data: "resume-probe\r" }));
		await waitFor(() => h.messages.filter((m) => m.type === "cmd_ack" && m.commandId === "follow-1" && m.stage === "applied").length >= 2);
		assert.equal(h.echoCount("echo:resume-probe"), 1, "commandId dedup: the retry never re-writes the child");

		socket2.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		try { socket2?.destroy(); } catch {}
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("A2 epoch: runner restart with a generation change discards the cursor — fresh snapshot, never cross-generation replay (deferred T3 pin)", async () => {
	const root = freshRoot();
	let runner;
	let runner2;
	let socket2 = null;
	try {
		const first = spawnOwnedRunner(root, "v1");
		runner = first.runner;
		await waitFor(() => hostReady(root, "v1"));

		const socket1 = await connectControl(first.socketPath);
		const h = attachClientOverSocket(socket1);
		h.hello();
		await waitFor(() => h.messages.some((m) => m.type === "hello" && m.generation));
		const gen1 = h.client.getIdentity().generation;
		h.client.start();
		await waitFor(() => h.eventsOf("snapshotReady")[0]);
		await waitFor(() => h.client.getLastSeq() >= 3, 10000);
		const disconnectSeq = h.client.getLastSeq();
		assert.ok(disconnectSeq >= 3);

		// Runner replacement: stop the runner (releases the claim), reap the
		// child, boot a new instance (new fence, new generation UUID).
		await stopRunner(runner);
		reapChild(root, "v1");
		const second = spawnOwnedRunner(root, "v1");
		runner2 = second.runner;
		await waitFor(() => hostReady(root, "v1"));

		socket2 = await connectControl(second.socketPath);
		h.switchSocket(socket2);
		h.hello();
		// The fresh hello carries the NEW identity; the client remembers the
		// pre-drop generation baseline for the epoch comparison.
		await waitFor(() => h.messages.some((m) => m.type === "hello" && m.status?.instanceId === second.instanceId));
		h.client.reconnect(disconnectSeq);

		// Generation changed ⇒ the cursor is dead: epochReset + seq-less
		// subscribe (fresh snapshot), never a sinceSeq replay across the
		// generation boundary.
		const reset = await waitFor(() => h.eventsOf("epochReset")[0]);
		assert.equal(reset.previous, gen1);
		assert.equal(typeof reset.current, "string");
		assert.notEqual(reset.current, gen1);
		const sub = [...h.sent].reverse().find((m) => m.type === "subscribe_terminal");
		assert.ok(sub, "a subscribe followed the epoch reset");
		assert.equal(sub.sinceSeq, undefined, "fresh snapshot after an epoch change — no ring replay");

		// The fresh baseline: snapshot (empty or framed) then live continuation
		// from ITS nextSeq — the old cursor is gone.
		const ready2 = await waitFor(() => h.eventsOf("snapshotReady").at(-1));
		assert.equal(typeof ready2.nextSeq, "number");
		await waitFor(() => h.outputSeqs().length >= 1, 10000);
		assert.ok(h.outputSeqs().at(-1) >= ready2.nextSeq, "live output continues from the new baseline");
		assert.ok(h.client.getLastSeq() >= ready2.nextSeq - 1);

		socket2.destroy();
	} finally {
		await stopRunner(runner);
		await stopRunner(runner2);
		reapChild(root, "v1");
		try { socket2?.destroy(); } catch {}
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

/** host.json for a LIVE host whose socket does not exist yet (reply queues the
 *  prompt against the dead socket — the launch path must not fire). */
function writeLiveHostFor(root, viewId, socketPath, instanceId) {
	writeHost(root, {
		version: 1,
		viewId,
		mode: "pty",
		instanceId,
		runnerPid: process.pid,
		childPid: null,
		socketPath,
		state: "alive",
		claimAt: Date.now(),
		claimPid: process.pid,
		claimIdentity: { pid: process.pid, startToken: null },
		runnerIdentity: { pid: process.pid, startToken: null },
		runnerSpawnedAt: Date.now(),
		cols: 80,
		rows: 24,
	});
}

test("A2 §10: accepted-before-restart surfaces as accepted_unknown — service marks the item failed, the new child is never written", async () => {
	const root = freshRoot();
	let runner;
	let monitor = null;
	try {
		createView(root, { id: "v1", name: "v1", cwd: process.cwd() });
		// Pre-derive the fence so reply() can queue against the dead endpoint
		// BEFORE the runner exists (no host → reply would try to LAUNCH).
		const instanceId = `inst-v1-${++instanceCounter}`;
		const socketPath = P.hostEndpointPathFor(process.platform, root, "v1", instanceId);
		writeLiveHostFor(root, "v1", socketPath, instanceId);
		const svc = createService({
			root,
			runnerScript: "/no/runner.mjs",
			piCommand: "pi",
			piArgsPrefix: [],
			defaultCwd: process.cwd(),
			launch: () => ({ pid: null, configPath: "/no/config.json" }),
			launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		});

		// Queue the prompt against the dead endpoint → the item stays queued.
		const queued = await svc.reply("v1", "resume-echo-prompt");
		assert.equal(queued.queued, true);
		const itemId = readFollowUpQueue(root, "v1").items[0].id;

		// Deterministic §10 seeding: the prompt was ACCEPTED (journaled) by a
		// previous runner generation that died before applying. accepted →
		// applied is synchronous inside one handler on a live runner (Task 2
		// ruling 4), so "accepted in the journal of a DEAD generation" is the
		// only externally constructible form of the §10 window — and it is
		// exactly the state a SIGKILL between the stages leaves behind.
		writeFileSync(
			P.controlJournalPath(root, "v1"),
			JSON.stringify({ kind: "accepted", commandId: itemId, command: "resume-echo-prompt\r", acceptedAt: 1 }) + "\n",
		);

		// The same fence, now really booted — with the inherited journal. The
		// fake "live" host record (written so reply() would queue instead of
		// launching) must be replaced by a dead shape first: claimHost refuses to
		// re-claim an instance whose record still shows a live claim.
		writeHost(root, {
			version: 1,
			viewId: "v1",
			mode: "pty",
			instanceId,
			runnerPid: null,
			childPid: null,
			socketPath,
			state: "exited",
			claimAt: 0,
			claimPid: null,
			claimIdentity: null,
			cols: 80,
			rows: 24,
		});
		const spawned = spawnOwnedRunner(root, "v1", { instanceId });
		runner = spawned.runner;
		assert.equal(spawned.socketPath, socketPath);
		await waitFor(() => hostReady(root, "v1"));
		// The runner owns host.json; only the queue-drain gate needs the idle
		// state the fake child never reports.
		const st = readState(root, "v1");
		st.semanticState = "idle";
		st.processState = "exited";
		writeState(root, st);

		// Watch the child's output stream: any echo of the prompt proves a write.
		monitor = await connectControl(spawned.socketPath);
		send(monitor, { type: "subscribe_terminal", frameVersion: 1 });
		const mon = listen(monitor);
		const sawEcho = () => mon.messages.some((m) => m.type === "output" && String(m.data).includes("echo:resume-echo-prompt"));

		// The service drains into the REAL runner: the cached-accepted answer is
		// not an applied ack → deadline → reconcile-query → accepted_unknown.
		const drained = await svc.drainNextFollowUp("v1");
		assert.equal(drained.ok, true);
		assert.equal(drained.failed, true, "the drain resolves §10-ambiguous to failed");

		const item = readFollowUpQueue(root, "v1").items[0];
		assert.equal(item.status, "failed", "ambiguous item is terminal — never re-queued");
		assert.ok(item.error.includes("accepted_unknown"), "reason recorded on the item");
		const diags = readDiagnostics(root, "v1").filter((d) => d.code === "follow_up_ambiguous");
		assert.equal(diags.length, 1);
		assert.equal(diags[0].level, "error");

		// The new child was NEVER written: no echo within a bounded window.
		const deadline = Date.now() + 1200;
		while (Date.now() < deadline && !sawEcho()) await new Promise((r) => setTimeout(r, 50));
		assert.equal(sawEcho(), false, "§10: the accepted-but-unapplied prompt is never replayed into the new child");

		// And the runner's own reconcile names the window honestly.
		send(monitor, { type: "reconcile", commandId: "rec-final", clientId: "probe", seq: 1, viewId: "v1", instanceId: spawned.instanceId });
		const rec = await waitFor(() => mon.messages.find((m) => m.type === "reconcile_result" && m.commandId === "rec-final"));
		const entry = (rec.unresolved ?? []).find((u) => u.commandId === itemId);
		assert.ok(entry, "the §10 window is visible in reconcile");
		assert.equal(entry.status, "accepted_unknown");
		assert.equal(entry.command, "resume-echo-prompt\r");
		monitor.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		try { monitor?.destroy(); } catch {}
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
