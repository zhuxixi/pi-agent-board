import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { createJiggleRetryController } from "../src/core/pty-attach-jiggle-controller.mjs";

const hasNodePty = await import("node-pty").then(() => true, () => false);

function send(socket, msg) { socket.write(JSON.stringify(msg) + "\n"); }

function waitForExit(child, timeoutMs) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		let timer;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("exit", onExit);
			resolve(exited);
		};
		const onExit = () => finish(true);
		timer = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
		if (child.exitCode !== null || child.signalCode !== null) finish(true);
	});
}

async function cleanup(root, runner, socket, controller) {
	try { controller?.restoreAndStop(); } catch {}
	try { socket?.end(); } catch {}
	if (runner && runner.exitCode === null && runner.signalCode === null) {
		try { runner.kill("SIGTERM"); } catch {}
		if (!(await waitForExit(runner, 250)) && runner.exitCode === null && runner.signalCode === null) {
			try { runner.kill("SIGKILL"); } catch {}
			await waitForExit(runner, 250);
		}
	}
	rmSync(root, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 10000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting");
}

// ISSUE #42 E2E: hot session + in-flight differential frame at attach.
// The frameStart fast path restores the held shrink before the child observed
// it; the child's coalesced resize handling reads back a net-zero size and
// stays silent forever. A healing controller must re-poke (re-shrink) so the
// child fullRenders with \x1b[2J and the PTY settles back at the original size.
test(
	"issue #42 e2e: hot child + racing differential frame → attach must still heal to a clear + original size",
	{ skip: !hasNodePty && "node-pty unavailable", timeout: 30000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "agentview-hot-"));
		let runner;
		let socket;
		let controller;
		try {
			const meta = createView(root, { id: "hot1", name: "hot", cwd: process.cwd() });
			atomicWriteJson(P.hostConfigPath(root, "hot1"), {
				root,
				viewId: "hot1",
				sessionFile: meta.sessionFile,
				cwd: process.cwd(),
				initialPrompt: null,
				piCommand: process.execPath,
				piArgsPrefix: [resolve("test-support/fake-hot-tui-pi.mjs")],
				model: null,
				tools: null,
				env: {},
				cols: 196,
				rows: 39,
			});
			runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), P.hostConfigPath(root, "hot1")], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			await waitFor(() => existsSync(P.controlSocketPath(root, "hot1")) && readHost(root, "hot1")?.state === "alive");
			// The session must be HOT before we attach: wait until the boot
			// fullRender has been written to the screen log, so every frame the
			// controller sees post-connect is a differential one (no clear) —
			// otherwise the boot clear rides the socket and heals us before the
			// race can happen.
			await waitFor(() => {
				try {
					return statSync(P.screenLogPath(root, "hot1")).size > 0;
				} catch {
					return false;
				}
			}, 5000);

			socket = createConnection(P.controlSocketPath(root, "hot1"));
			socket.on("error", () => {});
			await once(socket, "connect");

			const resizes = [];
			controller = createJiggleRetryController({
				sendResize: (cols, rows) => { resizes.push([cols, rows]); send(socket, { type: "resize", cols, rows }); },
				setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
				clearTimeoutFn: (t) => clearTimeout(t),
			});
			controller.start(196, 39);
			send(socket, { type: "hello", clientId: "e2e-hot", wantOutput: true });

			let sawDifferentialBeforeClear = false;
			let clearAt = null;
			let buf = "";
			socket.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line);
						if (msg.type === "output" && typeof msg.data === "string") {
							controller.feed(msg.data);
							const s = controller.getState();
							if (s.tuiFrameSeen && !s.clearDetected) sawDifferentialBeforeClear = true;
							if (clearAt === null && s.clearDetected) clearAt = Date.now();
						}
					} catch {}
				}
			});

			// Sanity: the race setup really did trip the fast path (frame without clear).
			await waitFor(() => sawDifferentialBeforeClear, 5000);

			// A full clear must follow (heal). On the buggy build the child is
			// net-zeroed silent and the controller never re-pokes → this waitFor
			// times out.
			await waitFor(() => clearAt !== null, 8000);

			// The healing path must contain the second shrink, not merely any
			// eventual clear from the fixture.
			assert.deepEqual(
				resizes.slice(0, 5),
				[[196, 39], [195, 38], [196, 39], [195, 38], [196, 39]],
				"fast-path restore must be followed by a G6 re-poke and final restore",
			);

			// And the PTY must settle back at the original size.
			await waitFor(() => {
				const h = readHost(root, "hot1");
				return h?.cols === 196 && h?.rows === 39;
			}, 5000);
		} finally {
			await cleanup(root, runner, socket, controller);
		}
	},
);
