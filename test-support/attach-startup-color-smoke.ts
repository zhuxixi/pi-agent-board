import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";
import { ensureNodePtySpawnHelperExecutable } from "../src/core/pty-support.mjs";

const require = createRequire(import.meta.url);
ensureNodePtySpawnHelperExecutable(require);
const pty = require("node-pty") as typeof import("node-pty");
const root = mkdtempSync(join(tmpdir(), "agent-board-startup-color-"));
const query = "\x1b]11;?\x07";
const reply = "\x1b]11;rgb:2887/2a18/353c\x1b\\";
const echoedReply = "^[]11;rgb:2887/2a18/353c^[\\";
// Keep the child in the real PTY's default canonical/echo mode, as during a
// slow Pi startup. A marker makes the test independent of process-start timing.
const child = pty.spawn(process.execPath, ["-e", 'process.stdout.write("BOOTING\\r\\n"); setInterval(() => {}, 1000);'], {
	name: "xterm-256color",
	cols: 80,
	rows: 24,
	cwd: root,
	env: process.env,
});
let output = "";
const dataSubscription = child.onData((data) => { output += data; });
const childExit = new Promise<void>((resolve) => child.onExit(() => resolve()));
let attach: PtyAttachComponent | undefined;

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for PTY output");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

try {
	await waitFor(() => output.includes("BOOTING"));
	const writes: string[] = [];
	const sent: string[] = [];
	// Simulate a terminal that immediately answers OSC 11. This TUI has no
	// queryTerminalBackgroundColor (as in newer Pi), so only an untracked raw
	// probe can generate a reply that falls through to the attached component.
	const tui = {
		terminal: {
			rows: 24, cols: 80, columns: 80,
			write: (data: string) => {
				writes.push(data);
				if (data === query) attach?.handleInput(reply);
			},
		},
		requestRender: () => {},
		onTerminalColorSchemeChange: () => () => {},
	};
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	attach = new PtyAttachComponent(tui as never, theme, {} as never, () => {}, {
		socketPath: join(root, "missing.sock"), title: "startup-color",
	});
	// SAFETY: These are the production component's private methods; only the
	// socket transport is replaced so input reaches the real canonical PTY.
	const internals = attach as unknown as {
		send: (message: { type: string; data?: string }) => void;
		finishAttachTransition: () => void;
	};
	internals.send = (message) => {
		if (message.type !== "input" || !message.data) return;
		sent.push(message.data);
		child.write(message.data);
	};
	internals.finishAttachTransition();
	internals.finishAttachTransition();
	await new Promise((resolve) => setTimeout(resolve, 100));
	const result = {
		settleQueries: writes.filter((data) => data === query).length,
		settleInput: [...sent],
		startupOutput: output,
		canonicalEchoReproduced: false,
	};
	// Positive control: the old untracked replay must reproduce the screenshot
	// on this same PTY, proving that raw-mode/echo assumptions are really tested.
	tui.terminal.write(query);
	await waitFor(() => output.includes(echoedReply));
	result.canonicalEchoReproduced = true;
	console.log(JSON.stringify(result));
} finally {
	attach?.dispose();
	child.kill();
	await childExit;
	dataSubscription.dispose();
	rmSync(root, { recursive: true, force: true });
}
