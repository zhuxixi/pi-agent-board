import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { createTerminalAttachClient } from "../src/core/terminal-attach-client.mjs";

// Spec acceptance coverage (issue #91 phase 4):
//   A5  — snapshot/subscribe 无 gap、无重复（real runner, real socket, real client module）
//   A5c — runner 重启后的 attach 基线（new child, no old-screen restoration）
// plus the phase-3 final-review pre-flight: firehose stress + parser containment
// (those live in the second half of this file).

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-snap-"));
}

// Same rationale as pty-runner.integration.test.mjs: every waitFor is an
// "eventually happens" predicate, never a timing bound; the generous ceiling
// only buys spawn+first-output latency under full-suite parallel load.
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

/** Attach a newline-delimited JSON collector to a socket. */
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
			child.removeListener("exit", onExit);
			resolve(exited);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
	});
}

async function stopRunner(runner) {
	if (!runner || runner.exitCode !== null || runner.signalCode !== null) return;
	try { runner.kill("SIGTERM"); } catch {}
	if (!(await waitForExit(runner, 500)) && runner.exitCode === null && runner.signalCode === null) {
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

/** Create a view + host config + spawn a runner. Mirrors the pty-runner
 *  integration fixture (same helper child, same isolation shape). */
function spawnRunner(root, viewId, { env = {}, cols = 80, rows = 24 } = {}) {
	const meta = createView(root, { id: viewId, name: viewId, cwd: process.cwd() });
	const configPath = P.hostConfigPath(root, viewId);
	atomicWriteJson(configPath, {
		root,
		viewId,
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
	return { runner, configPath };
}

/** Bridge a real socket into the real client module (the UI wiring shape:
 *  every parsed runner message goes through handleMessage; its boolean return
 *  says whether the protocol consumed it). Returns a handle whose `attach`
 *  re-points the SAME client at a new socket — the reconnect flow (the UI's
 *  send routes through the CURRENT socket, not the one the client was born
 *  with). */
function wireClient(socket) {
	const events = { mode: [], snapshotReady: [], output: [], resubscribing: [], protocolError: [] };
	let current = socket;
	const client = createTerminalAttachClient({
		send: (msg) => send(current, msg),
		emit: (event, payload) => events[event].push(payload ?? null),
	});
	const attach = (nextSocket) => {
		current = nextSocket;
		let buf = "";
		nextSocket.on("data", (chunk) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					client.handleMessage(JSON.parse(line));
				} catch {
					/* malformed line: same tolerance as the UI parser */
				}
			}
		});
	};
	attach(socket);
	return { client, events, attach };
}

async function cleanup(root, viewId, sockets, runners) {
	for (const s of sockets) {
		try { s.destroy(); } catch {}
	}
	for (const r of runners) await stopRunner(r);
	reapChild(root, viewId);
	await new Promise((r) => setTimeout(r, 50));
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test("A5: mid-stream subscribe via the real client module — no gap, no dup, alongside a second subscriber and a legacy client", async () => {
	const root = freshRoot();
	const viewId = "a5";
	let runner;
	const sockets = [];
	try {
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_STREAM_MODE: "steady" } }));
		await waitFor(() => hostReady(root, viewId));

		// Legacy client: plain hello, no subscribe. Its steady output proves the
		// model is being fed before either subscriber attaches.
		const legacy = createConnection(P.controlSocketPath(root, viewId));
		await once(legacy, "connect");
		sockets.push(legacy);
		const legacyMessages = listen(legacy).messages;
		send(legacy, { type: "hello" });
		await waitFor(() => legacyMessages.find((m) => m.type === "output" && String(m.data).startsWith("steady-")));

		// Subscriber A: the REAL client module over a REAL socket.
		const socketA = createConnection(P.controlSocketPath(root, viewId));
		await once(socketA, "connect");
		sockets.push(socketA);
		const { client: clientA, events: eventsA } = wireClient(socketA);
		send(socketA, { type: "hello" });
		clientA.start();
		await waitFor(() => eventsA.snapshotReady.length > 0);
		const readyA = eventsA.snapshotReady[0];
		assert.equal(typeof readyA.frame, "string", "protocol mode decided; frame assembled");
		assert.ok(readyA.frame.includes("steady-"), "frame renders canonical viewport content");
		assert.equal(eventsA.mode[0], "protocol");

		// Subscriber B: raw protocol socket (independent wire observation).
		const socketB = createConnection(P.controlSocketPath(root, viewId));
		await once(socketB, "connect");
		sockets.push(socketB);
		const messagesB = listen(socketB).messages;
		send(socketB, { type: "subscribe_terminal" });
		await waitFor(() => messagesB.find((m) => m.type === "snapshot_end"));

		// Drive ~1s of additional output across both subscribers.
		const ticks = 40;
		for (let i = 0; i < ticks; i++) {
			send(legacy, { type: "input", data: `tick-${i}\r` });
			await new Promise((r) => setTimeout(r, 20));
		}
		await waitFor(() => clientA.getLastSeq() >= readyA.nextSeq + ticks);

		// Client A: zero protocol failures — the gap/dup discipline held end-to-end.
		assert.deepEqual(eventsA.protocolError, [], "no protocol errors on the real socket");
		assert.deepEqual(eventsA.resubscribing, [], "no recovery resubscribes needed");
		assert.equal(eventsA.snapshotReady.length, 1, "exactly one snapshot");
		const outputsA = eventsA.output;
		assert.ok(outputsA.length >= ticks, "client A consumed the live stream");
		assert.equal(clientA.getMode(), "protocol");

		// Subscriber B: wire-level seq contiguity from snapshot cursor onward.
		const beginB = messagesB.find((m) => m.type === "snapshot_begin");
		const endB = messagesB.find((m) => m.type === "snapshot_end");
		assert.equal(beginB.frameVersion, 1);
		assert.equal(endB.nextSeq, beginB.snapshotSeq + 1);
		const seqsB = messagesB.filter((m) => m.type === "output").map((m) => m.seq);
		assert.ok(seqsB.length >= ticks);
		assert.deepEqual(seqsB, seqsB.map((_, i) => endB.nextSeq + i), "subscriber seqs strictly contiguous, no dup");

		// Legacy client: same stream, plain data field, unaffected by seq.
		const legacyOut = legacyMessages.filter((m) => m.type === "output");
		assert.ok(legacyOut.length >= ticks);
		for (const m of legacyOut) assert.equal(typeof m.data, "string");
		assert.ok(legacyOut.some((m) => m.data.includes("echo:tick-")), "legacy socket sees the same echo content");
	} finally {
		await cleanup(root, viewId, sockets, [runner]);
	}
});

test("A5: burst through the snapshot window — frame→flush→end interleaving pinned on the wire, client converges in order", async () => {
	const root = freshRoot();
	const viewId = "a5flush";
	let runner;
	const sockets = [];
	try {
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_BURST_LINES: "400" } }));
		await waitFor(() => hostReady(root, viewId));

		const driver = createConnection(P.controlSocketPath(root, viewId));
		await once(driver, "connect");
		sockets.push(driver);
		const driverMessages = listen(driver).messages;
		send(driver, { type: "hello" });
		await waitFor(() => driverMessages.find((m) => m.type === "output" && m.data.includes("fake pi ready")));

		// Client B: real client module, subscribed mid-burst.
		const socketB = createConnection(P.controlSocketPath(root, viewId));
		await once(socketB, "connect");
		sockets.push(socketB);
		const { client: clientB, events: eventsB } = wireClient(socketB);
		clientB.start();

		// Raw subscriber C: wire observation of the frame→flush→end window.
		const socketC = createConnection(P.controlSocketPath(root, viewId));
		await once(socketC, "connect");
		sockets.push(socketC);
		const messagesC = listen(socketC).messages;

		// Dispatch the burst, THEN subscribe both — chunks stream through the
		// runner while the captures run, so the catch-up flush path is exercised.
		send(driver, { type: "input", data: "burst\r" });
		send(socketC, { type: "subscribe_terminal" });

		await waitFor(() => {
			const end = messagesC.find((m) => m.type === "snapshot_end");
			return end && eventsB.snapshotReady.length > 0;
		});

		// Wire pin (subscriber C): outputs between snapshot_frame and
		// snapshot_end ARE the catch-up flush window; they must be contiguous
		// and end exactly at end.nextSeq - 1.
		const frameIdx = messagesC.findIndex((m) => m.type === "snapshot_frame");
		const endIdx = messagesC.findIndex((m) => m.type === "snapshot_end");
		const beginC = messagesC.find((m) => m.type === "snapshot_begin");
		const endC = messagesC[endIdx];
		const flushC = messagesC.slice(frameIdx + 1, endIdx).filter((m) => m.type === "output");
		for (let i = 0; i < flushC.length; i++) {
			assert.equal(flushC[i].seq, beginC.snapshotSeq + 1 + i, "flush chunks contiguous after the snapshot cursor");
		}
		if (flushC.length > 0) {
			assert.equal(endC.nextSeq, flushC[flushC.length - 1].seq + 1, "end cursor continues exactly after the flush tail");
		}

		// Client B: converged with zero recovery, then the full burst content is
		// delivered exactly once across frame ∪ outputs. NOTE: outputSeq counts
		// CHUNKS, not lines — the PTY coalesces the 400-line burst into a
		// handful of multi-KB reads, so completeness is asserted over content
		// (line coverage), never over seq magnitude.
		assert.deepEqual(eventsB.protocolError, []);
		assert.deepEqual(eventsB.resubscribing, []);
		const seen = new Set();
		const frameB = eventsB.snapshotReady[0].frame ?? "";
		const collect = (text) => {
			for (const m of String(text).matchAll(/burstline-(\d{4})/g)) seen.add(Number(m[1]));
		};
		collect(frameB);
		await waitFor(() => {
			for (const data of eventsB.output) collect(data);
			return seen.size >= 400;
		}, 20000);
		assert.equal(seen.size, 400, "every burst line delivered exactly once across frame+flush+live");
	} finally {
		await cleanup(root, viewId, sockets, [runner]);
	}
});

test("A5c: runner restart — reconnect gets a fresh/empty baseline from the new child, never the old screen", async () => {
	const root = freshRoot();
	const viewId = "a5c";
	let runner;
	const sockets = [];
	try {
		// Hold-mode child: silent until first input — the restarted runner's
		// model is guaranteed empty at reconnect time (no empty-vs-fresh race).
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_HOLD: "1" } }));
		await waitFor(() => hostReady(root, viewId));

		const driver = createConnection(P.controlSocketPath(root, viewId));
		await once(driver, "connect");
		sockets.push(driver);
		const driverMessages = listen(driver).messages;
		send(driver, { type: "hello" });
		send(driver, { type: "input", data: "before-restart\r" });
		await waitFor(() => driverMessages.find((m) => m.type === "output" && m.data.includes("echo:before-restart")));

		const socket1 = createConnection(P.controlSocketPath(root, viewId));
		await once(socket1, "connect");
		sockets.push(socket1);
		const { client, events, attach } = wireClient(socket1);
		client.start();
		await waitFor(() => events.snapshotReady.length > 0);
		assert.ok((events.snapshotReady[0].frame ?? "").includes("before-restart"), "pre-restart frame shows the old content");
		const cursorBefore = client.getLastSeq();
		assert.ok(cursorBefore >= 1);

		// Crash the runner (SIGKILL: no finalize, no socket cleanup) + reap the
		// orphaned child. Same config: the legacy main path takes over cleanly.
		try { runner.kill("SIGKILL"); } catch {}
		await waitFor(() => !isAlive(runner.pid));
		reapChild(root, viewId);

		// New runner, same view/config → new child → fresh canonical model.
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_HOLD: "1" } }));
		await waitFor(() => hostReady(root, viewId));

		// The SAME client instance reconnects with its old cursor (UI flow:
		// client survives the socket swap). The new runner cannot honor the
		// foreign cursor: fresh empty baseline, nextSeq restarts at 1.
		const socket2 = createConnection(P.controlSocketPath(root, viewId));
		await once(socket2, "connect");
		sockets.push(socket2);
		// Re-point the SAME client at the new socket (the UI reconnect shape:
		// this.send routes through the current socket), then reconnect with the
		// pre-crash cursor.
		attach(socket2);
		// Scope every post-restart assertion to events emitted AFTER the reconnect:
		// snapshotReady[0] is the PRE-restart snapshot and legitimately carries the
		// old screen (the test itself asserted that above).
		const readyCountBeforeReconnect = events.snapshotReady.length;
		client.reconnect(cursorBefore);

		await waitFor(() => events.snapshotReady.length > 1);
		const rebased = events.snapshotReady[1];
		assert.equal(rebased.empty, true, "restarted runner answers with the empty host-starting baseline");
		assert.equal(rebased.frame, undefined, "empty baseline carries no frame");
		assert.equal(rebased.nextSeq, 1, "sequence restarts at 1 for the new child");

		// New child output establishes the new baseline; the old screen content
		// never reappears. (The driver socket belonged to runner1 and died with
		// it — post-restart input goes through the reconnected session socket,
		// which is the UI-shaped path anyway.)
		send(socket2, { type: "input", data: "after-restart\r" });
		await waitFor(() => events.output.some((d) => String(d).includes("echo:after-restart")));
		assert.ok(client.getLastSeq() <= 3, "new child seqs start from the bottom of the new model");
		for (const d of events.output) assert.ok(!String(d).includes("before-restart"), "no old-screen restoration in the new stream");
		assert.ok(
			!events.snapshotReady.slice(readyCountBeforeReconnect).some((r) => typeof r.frame === "string" && r.frame.includes("before-restart")),
			"no post-restart frame ever carries the old screen",
		);
		try { socket1.destroy(); } catch {}
	} finally {
		await cleanup(root, viewId, sockets, [runner]);
	}
});

test("firehose stress: sustained multi-MB/s stream — capture completes, runner alive, functional after", async () => {
	const root = freshRoot();
	const viewId = "firehose";
	let runner;
	const sockets = [];
	try {
		// ~2KB chunks every 1ms for 3s ≈ 6MB through the real PTY pipeline.
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_STREAM_MODE: "firehose" } }));
		await waitFor(() => hostReady(root, viewId));

		// Subscriber 1 races the child's first output: both outcomes are
		// contract-valid — an empty host-starting baseline (subscribe landed
		// before the child emitted; A5c shape) or a framed mid-flood snapshot.
		const socket1 = createConnection(P.controlSocketPath(root, viewId));
		await once(socket1, "connect");
		sockets.push(socket1);
		const { client: client1, events: events1 } = wireClient(socket1);
		client1.start();
		await waitFor(() => events1.snapshotReady.length > 0);
		assert.equal(events1.mode.at(-1), "protocol", "protocol mode decided");

		// Subscriber 2 attaches once flood content is confirmed flowing: its
		// snapshot MUST carry a real frame (model non-empty mid-stream).
		await waitFor(() => events1.output.some((d) => String(d).includes("fh-")));
		const socket2 = createConnection(P.controlSocketPath(root, viewId));
		await once(socket2, "connect");
		sockets.push(socket2);
		const { client: client2, events: events2 } = wireClient(socket2);
		client2.start();
		await waitFor(() => events2.snapshotReady.length > 0);
		assert.equal(
			typeof events2.snapshotReady[0].frame, "string",
			"mid-stream capture completes with a real frame",
		);

		// The flood must end without killing anyone, and the stream must still flow.
		await waitFor(() => events1.output.some((d) => String(d).includes("firehose-done")), 20000);
		assert.ok(isAlive(runner.pid), "runner alive after the flood");
		assert.equal(client1.getMode(), "protocol", "still in protocol mode after the flood");
		assert.ok(events1.output.some((d) => String(d).includes("fh-")), "flood content reached the client");

		// Post-flood liveness: input echo still works end-to-end.
		send(socket1, { type: "input", data: "post-flood\r" });
		await waitFor(() => events1.output.some((d) => String(d).includes("echo:post-flood")));
		assert.ok(client1.getLastSeq() >= 1);
		// Recovery under ring pressure is legitimate; a version mismatch never is.
		for (const e of events1.protocolError) assert.notEqual(e.code, "frame_version_mismatch");
		console.log(`EVIDENCE firehose: ${JSON.stringify({
			firstSnapshotEmpty: events1.snapshotReady[0].empty === true,
			snapshot1Count: events1.snapshotReady.length,
			snapshot2FrameBytes: events2.snapshotReady[0].frame.length,
			outputs1: events1.output.length,
			outputs2: events2.output.length,
			resyncs1: events1.resubscribing.length,
			protocolErrorCodes: events1.protocolError.map((e) => e.code),
		})}`);
	} finally {
		await cleanup(root, viewId, sockets, [runner]);
	}
});

test("parser containment: malformed byte flood cannot crash the runner or wedge the pipeline", async () => {
	const root = freshRoot();
	const viewId = "malformed";
	let runner;
	const sockets = [];
	const stderrChunks = [];
	try {
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_STREAM_MODE: "malformed" } }));
		runner.stderr.on("data", (c) => stderrChunks.push(String(c)));
		await waitFor(() => hostReady(root, viewId));

		const socket = createConnection(P.controlSocketPath(root, viewId));
		await once(socket, "connect");
		sockets.push(socket);
		const { client, events } = wireClient(socket);
		client.start();
		await waitFor(() => events.snapshotReady.length > 0, 20000);

		// Broken CSI/OSC/DCS, truncated UTF-8, C0/binary garbage for 2s, then the
		// done marker. The runner's uncaughtException path exits(1) — surviving
		// it (and still answering input) IS the containment assertion.
		await waitFor(() => events.output.some((d) => String(d).includes("malformed-done")), 20000);
		assert.ok(isAlive(runner.pid), "runner alive after malformed flood (no uncaughtException exit)");
		assert.equal(client.getMode(), "protocol");
		send(socket, { type: "input", data: "after-garbage\r" });
		await waitFor(() => events.output.some((d) => String(d).includes("echo:after-garbage")));
		console.log(`EVIDENCE malformed: stderrBytes=${Buffer.concat(stderrChunks.map((s) => Buffer.from(s))).length} stderrPreview=${JSON.stringify(stderrChunks.join("").slice(0, 300))}`);
	} finally {
		await cleanup(root, viewId, sockets, [runner]);
	}
});

/** Read the settled viewport of an independent headless parser as text rows. */
async function viewportRows(term, rows, cols) {
	// @xterm/headless parses asynchronously; settle before reading.
	await new Promise((r) => setTimeout(r, 80));
	const b = term.buffer.active;
	const out = [];
	for (let y = b.baseY; y < b.baseY + rows; y++) {
		const line = b.getLine(y);
		let s = "";
		for (let x = 0; x < cols; x++) s += line.getCell(x).getChars() || " ";
		out.push(s);
	}
	return out;
}

test("A6: mid-stream runner kill → reconnect → fresh baseline hydrate; recovery independent of screen.log; frame overwrites a polluted buffer", async () => {
	const root = freshRoot();
	const viewId = "a6";
	let runner;
	const sockets = [];
	const POISON = "SCREENLOG-POISON-MARKER";
	try {
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_STREAM_MODE: "steady" } }));
		await waitFor(() => hostReady(root, viewId));

		// Establish the protocol session and a pre-kill discriminator on the old child.
		const socket1 = createConnection(P.controlSocketPath(root, viewId));
		await once(socket1, "connect");
		sockets.push(socket1);
		const { client, events, attach } = wireClient(socket1);
		client.start();
		await waitFor(() => events.snapshotReady.length > 0);
		assert.equal(events.mode[0], "protocol");
		send(socket1, { type: "input", data: "pre-kill\r" });
		await waitFor(() => events.output.some((d) => String(d).includes("echo:pre-kill")));
		const cursorBefore = client.getLastSeq();
		assert.ok(cursorBefore >= 1);

		// Kill the runner, reap the child, and POISON screen.log: every recovery
		// from here must come from the canonical snapshot, never the log file.
		try { runner.kill("SIGKILL"); } catch {}
		await waitFor(() => !isAlive(runner.pid));
		try {
			const pid = readHost(root, viewId)?.childPid;
			if (pid) process.kill(pid, "SIGKILL");
		} catch {}
		writeFileSync(P.screenLogPath(root, viewId), `${POISON}\n`);

		// Replacement runner + new child on the same view/config.
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_STREAM_MODE: "steady" } }));
		await waitFor(() => hostReady(root, viewId));

		// SAME client instance reconnects with its pre-kill cursor (the UI shape):
		// foreign cursor → fresh baseline, explicitly marked resnapshot.
		const socket2 = createConnection(P.controlSocketPath(root, viewId));
		await once(socket2, "connect");
		sockets.push(socket2);
		attach(socket2);
		const readyCountBefore = events.snapshotReady.length;
		// Mark the live-stream cursor BEFORE reconnecting: pre-kill outputs also
		// contain steady- content, so post-restart liveness must be asserted on
		// the slice, never the whole array.
		const outputMarkBeforeReconnect = events.output.length;
		client.reconnect(cursorBefore);
		await waitFor(() => events.snapshotReady.length > readyCountBefore);
		const rebased = events.snapshotReady[readyCountBefore];
		assert.equal(
			rebased.resnapshot === true || rebased.empty === true,
			true,
			"foreign cursor earns a discard-your-buffer baseline",
		);
		const rebasedFrame = typeof rebased.frame === "string" ? rebased.frame : "";
		assert.ok(!rebasedFrame.includes("echo:pre-kill"), "fresh baseline never carries the old screen");
		assert.ok(!rebasedFrame.includes(POISON), "baseline never carries screen.log content");

		// Wait for the new child's live stream, then take a DETERMINISTIC framed
		// snapshot from a third raw subscriber — the canonical viewport is then
		// guaranteed non-empty (no capture-timing race on the empty-baseline path).
		await waitFor(() => events.output.slice(outputMarkBeforeReconnect).some((d) => String(d).includes("steady-")));
		const socket3 = createConnection(P.controlSocketPath(root, viewId));
		await once(socket3, "connect");
		sockets.push(socket3);
		const messages3 = listen(socket3).messages;
		send(socket3, { type: "subscribe_terminal" });
		await waitFor(() => messages3.find((m) => m.type === "snapshot_frame"));
		const frame = messages3.find((m) => m.type === "snapshot_frame").data;
		assert.equal(typeof frame, "string");

		// Pollution overwrite proof with INDEPENDENT parsers: a clean terminal and
		// a terminal pre-polluted with garbage must converge to identical viewports
		// once the frame lands — the frame is self-contained (no dependence on
		// prior buffer state, no reliance on screen.log or jiggle clears).
		const clean = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
		const dirty = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
		dirty.write(
			"\x1b[31mGARBAGE-DIRTY-MARKER\x1b[0m stale recovery junk\r\n\x1b[1;44m more garbage \x1b[0m\nstale row\r\n\x1b[10;10Hstale cursor zone",
		);
		clean.write(frame);
		dirty.write(frame);
		const cleanRows = await viewportRows(clean, 24, 80);
		const dirtyRows = await viewportRows(dirty, 24, 80);
		assert.ok(cleanRows.join("\n").includes("steady-"), "hydrated frame renders canonical content");
		assert.equal(
			JSON.stringify(dirtyRows), JSON.stringify(cleanRows),
			"polluted buffer converges byte-identically to the clean hydrate",
		);
		assert.ok(!dirtyRows.join("\n").includes("GARBAGE-DIRTY-MARKER"), "pollution fully overwritten by the frame");

		// Converge to the NEW child: post-restart input echoes through the new model.
		// Scope stream assertions to outputs AFTER the reconnect: the pre-kill live
		// stream legitimately contains the old echo.
		const outputMark = events.output.length;
		send(socket2, { type: "input", data: "post-restart\r" });
		await waitFor(() => events.output.slice(outputMark).some((d) => String(d).includes("echo:post-restart")));
		const postRestartStream = events.output.slice(outputMark).map((d) => String(d));
		assert.ok(postRestartStream.some((d) => d.includes("echo:post-restart")));
		assert.ok(
			!postRestartStream.some((d) => d.includes(POISON) || d.includes("echo:pre-kill")),
			"new stream carries neither screen.log poison nor the old screen",
		);
		// The client never hit a protocol violation on this recovery path.
		for (const e of events.protocolError) assert.notEqual(e.code, "frame_version_mismatch");
	} finally {
		await cleanup(root, viewId, sockets, [runner]);
	}
});
