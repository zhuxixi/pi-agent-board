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

// The stub TUI starts 8s in — beyond the OLD chain's ~5.12s window, so only the
// TUI-frame re-arm (issue #10) can produce a clear. Old choreography fails this.
test(
	"cold-start attach: chain re-arms on first TUI frame and sees full clear",
	{ skip: !hasNodePty && "node-pty unavailable", timeout: 45000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "agentview-coldstart-"));
		let runner;
		let socket;
		const t0 = Date.now();
		try {
			const meta = createView(root, { id: "cold1", name: "cold", cwd: process.cwd() });
			atomicWriteJson(P.hostConfigPath(root, "cold1"), {
				root,
				viewId: "cold1",
				sessionFile: meta.sessionFile,
				cwd: process.cwd(),
				initialPrompt: null,
				piCommand: process.execPath,
				piArgsPrefix: [resolve("test-support/fake-coldstart-tui-pi.mjs")],
				model: null,
				tools: null,
				env: { STUB_TUI_DELAY_MS: "8000" },
				cols: 120,
				rows: 36,
			});
			runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), P.hostConfigPath(root, "cold1")], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			await waitFor(() => existsSync(P.controlSocketPath(root, "cold1")) && readHost(root, "cold1")?.state === "alive");

			socket = createConnection(P.controlSocketPath(root, "cold1"));
			await once(socket, "connect");

			let clearAt = null;
			const controller = createJiggleRetryController({
				sendJiggle: () => {
					send(socket, { type: "resize", cols: 195, rows: 38 });
					setTimeout(() => send(socket, { type: "resize", cols: 196, rows: 39 }), 200);
				},
				setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
				clearTimeoutFn: (t) => clearTimeout(t),
			});
			controller.start(); // connect-time chain, like the component
			send(socket, { type: "hello", clientId: "e2e", wantOutput: true });
			send(socket, { type: "resize", cols: 196, rows: 39 }); // initial sendResize

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
							// Detection is driven off the controller's carry-safe state machine: a
							// clear split across socket messages is still detected, unlike a naive
							// msg.data.includes scan which would flake on chunk boundaries. The
							// [7800, 10000]ms window keeps ~1.8s headroom over the observed ~8.2s
							// and stays below the 11.12s backoff-tail fire time, which is what
							// proves the re-arm fired (and that the old choreography would fail).
							if (clearAt === null && controller.getState().clearDetected) {
								clearAt = Date.now() - t0;
							}
						}
					} catch {}
				}
			});

			await waitFor(() => clearAt !== null, 30000);
			// 下界证明清屏来自 TUI 启动之后；上界 <11.1s 证明是 re-arm（首帧+120ms）
			// 而非退避尾部第 6 档（11.12s 才能命中）——旧表最后一档 5.12s 注定失败。
			assert.ok(clearAt >= 7800, `clear arrived too early (${clearAt}ms) — not from the re-armed chain`);
			assert.ok(clearAt <= 10000, `clear arrived too late (${clearAt}ms) — re-arm did not fire`);
			const s = controller.getState();
			assert.equal(s.clearDetected, true);
			assert.equal(s.stopped, true);
			assert.equal(s.tuiFrameSeen, true);
			controller.stop();
		} finally {
			try { socket?.end(); } catch {}
			try { runner?.kill("SIGTERM"); } catch {}
			rmSync(root, { recursive: true, force: true });
		}
	},
);
