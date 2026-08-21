import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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

const hasNodePty = await import("node-pty").then(
	() => true,
	() => false,
);

function send(socket, msg) {
	socket.write(JSON.stringify(msg) + "\n");
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

function spawnRunner(root, viewId, piArgsPrefix, env = {}) {
	const meta = createView(root, { id: viewId, name: "cold", cwd: process.cwd() });
	atomicWriteJson(P.hostConfigPath(root, viewId), {
		root,
		viewId,
		sessionFile: meta.sessionFile,
		cwd: process.cwd(),
		initialPrompt: null,
		piCommand: process.execPath,
		piArgsPrefix,
		model: null,
		tools: null,
		env,
		cols: 120,
		rows: 36,
	});
	const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), P.hostConfigPath(root, viewId)], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	return runner;
}

function cleanup(root, runner, socket) {
	try { socket?.end(); } catch {}
	// Give the runner a beat to tear down before removing the tmpdir.
	setTimeout(() => {
		try { runner?.kill("SIGTERM"); } catch {}
		rmSync(root, { recursive: true, force: true });
	}, 80);
}

// Hold-protocol cold-start heal (issue #25): the attach shrinks the child PTY
// to (W-1,H-1) and holds; when the cold child TUI finally starts (4.5s), its
// first \x1b[?2026h frame triggers the re-arm which restores the original size;
// the now-rendering child sees the width delta and fullRenders with \x1b[2J.
// Assert the heal lands within 3s of the first frame and the PTY ends at the
// original size.
//
// The stub TUI delay MUST be < NO_FRAME_RESTORE_MS (6s): if it started later,
// G1 would release the hold before the TUI booted, so no width delta would
// ever exist (plan brief said 8s — that exercised G1, not the re-arm heal).
test(
	"cold-start attach: shrink-and-hold re-arms on first TUI frame, heals in <=3s, ends at original size",
	{ skip: !hasNodePty && "node-pty unavailable", timeout: 45000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "agentview-hold-"));
		let runner;
		let socket;
		const t0 = Date.now();
		try {
			runner = spawnRunner(root, "cold1", [resolve("test-support/fake-coldstart-tui-pi.mjs")], {
				STUB_TUI_DELAY_MS: "4500",
			});
			await waitFor(() => existsSync(P.controlSocketPath(root, "cold1")) && readHost(root, "cold1")?.state === "alive");

			socket = createConnection(P.controlSocketPath(root, "cold1"));
			await once(socket, "connect");

			let frameAt = null;
			let clearAt = null;
			// Record every resize the controller sends so we can assert the
			// restore (original size) actually went out.
			const resizes = [];
			const controller = createJiggleRetryController({
				sendResize: (cols, rows) => {
					resizes.push([cols, rows]);
					send(socket, { type: "resize", cols, rows });
				},
				setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
				clearTimeoutFn: (t) => clearTimeout(t),
			});
			controller.start(196, 39); // protocol sends original + shrink + hold itself
			send(socket, { type: "hello", clientId: "e2e", wantOutput: true });

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
							// Sample off the controller's own state machine (carry-safe).
							if (frameAt === null && controller.getState().tuiFrameSeen) {
								frameAt = Date.now() - t0;
							}
							if (clearAt === null && controller.getState().clearDetected) {
								clearAt = Date.now() - t0;
							}
						}
					} catch {}
				}
			});

			await waitFor(() => clearAt !== null, 30000);
			assert.ok(frameAt !== null, "controller never saw a TUI frame");
			const frameToClear = clearAt - frameAt;
			assert.ok(
				frameToClear <= 3000,
				`clear followed the first TUI frame by ${frameToClear}ms — expected a few round-trips (restore → child width delta → fullRender). heal did not follow the re-arm restore within 3s.`,
			);

			// Final state: not held, chain stopped, restore sent, PTY back at original.
			const s = controller.getState();
			assert.equal(s.held, false);
			assert.equal(s.clearDetected, true);
			assert.equal(s.tuiFrameSeen, true);
			assert.deepEqual(resizes.at(-1), [196, 39], "last resize must be the restore to original");
			// Runner-side confirmation: host.json settles at the original size.
			await waitFor(() => {
				const h = readHost(root, "cold1");
				return h?.cols === 196 && h?.rows === 39;
			}, 10000);
			controller.restoreAndStop();
		} finally {
			cleanup(root, runner, socket);
		}
	},
);

// Non-pi shell child: never emits TUI frames and never responds to resizes, so
// no clear can ever arrive. G1 (NO_FRAME_RESTORE_MS = 6s) must restore the PTY
// to the original size so a shell attach is not left one column narrower.
test(
	"shell child attach: G1 restores the original size within 8s when no TUI frame ever arrives",
	{ skip: !hasNodePty && "node-pty unavailable", timeout: 20000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "agentview-shell-"));
		let runner;
		let socket;
		try {
			runner = spawnRunner(root, "shell1", [resolve("test-support/fake-pty-pi.mjs")]);
			await waitFor(() => existsSync(P.controlSocketPath(root, "shell1")) && readHost(root, "shell1")?.state === "alive");

			socket = createConnection(P.controlSocketPath(root, "shell1"));
			await once(socket, "connect");

			const resizes = [];
			const controller = createJiggleRetryController({
				sendResize: (cols, rows) => {
					resizes.push([cols, rows]);
					send(socket, { type: "resize", cols, rows });
				},
				setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
				clearTimeoutFn: (t) => clearTimeout(t),
			});
			controller.start(120, 36);
			send(socket, { type: "hello", clientId: "e2e", wantOutput: true });

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
						}
					} catch {}
				}
			});

			// start() sent [120,36] then [119,35]. G1 fires at 6s (no frame) and
			// must send [120,36] again — so two [120,36] sends total within 8s.
			await waitFor(() => resizes.filter(([c, r]) => c === 120 && r === 36).length >= 2, 10000);
			const s = controller.getState();
			assert.equal(s.held, false, "hold must be released after G1 restore");
			assert.equal(s.tuiFrameSeen, false);
			controller.restoreAndStop();
		} finally {
			cleanup(root, runner, socket);
		}
	},
);

// Slow-boot heal (F1, final review): the TUI boots AFTER G1 (NO_FRAME_RESTORE_MS
// = 6s) has already released the hold, so the child baselines at the original
// size. The first frame's re-arm must re-hold (probe), the running child then
// fullRenders on the width delta, and the clear restores the original size.
// This is the capability the old pulse protocol had (heal at any boot time)
// that the initial hold design would have lost for boots >6s.
test(
	"slow boot >6s: first frame re-arms hold after G1, heals in <=3s, ends at original size",
	{ skip: !hasNodePty && "node-pty unavailable", timeout: 30000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "agentview-holdslow-"));
		let runner;
		let socket;
		const t0 = Date.now();
		try {
			runner = spawnRunner(root, "slow1", [resolve("test-support/fake-coldstart-tui-pi.mjs")], {
				STUB_TUI_DELAY_MS: "7000", // > G1's 6000: TUI starts after the hold is released
			});
			await waitFor(() => existsSync(P.controlSocketPath(root, "slow1")) && readHost(root, "slow1")?.state === "alive");

			socket = createConnection(P.controlSocketPath(root, "slow1"));
			await once(socket, "connect");

			let frameAt = null;
			let clearAt = null;
			const resizes = [];
			const controller = createJiggleRetryController({
				sendResize: (cols, rows) => {
					resizes.push([cols, rows]);
					send(socket, { type: "resize", cols, rows });
				},
				setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
				clearTimeoutFn: (t) => clearTimeout(t),
			});
			controller.start(196, 39);
			send(socket, { type: "hello", clientId: "e2e", wantOutput: true });

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
							if (frameAt === null && controller.getState().tuiFrameSeen) {
								frameAt = Date.now() - t0;
							}
							if (clearAt === null && controller.getState().clearDetected) {
								clearAt = Date.now() - t0;
							}
						}
					} catch {}
				}
			});

			await waitFor(() => clearAt !== null, 25000);
			assert.ok(frameAt !== null, "controller never saw a TUI frame");
			const frameToClear = clearAt - frameAt;
			assert.ok(
				frameToClear <= 3000,
				`slow boot: clear followed the first TUI frame by ${frameToClear}ms — expected the re-armed hold to fullRender quickly.`,
			);

			const s = controller.getState();
			assert.equal(s.held, false, "hold must be released after the clear restore");
			assert.equal(s.clearDetected, true);
			assert.equal(s.tuiFrameSeen, true);
			assert.deepEqual(resizes.at(-1), [196, 39], "last resize must be the restore to original");
			await waitFor(() => {
				const h = readHost(root, "slow1");
				return h?.cols === 196 && h?.rows === 39;
			}, 10000);
			controller.restoreAndStop();
		} finally {
			cleanup(root, runner, socket);
		}
	},
);
