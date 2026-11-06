// Issue #280 A04/A05: child fixture that uses the REAL reporter and shared helper.
// This script runs as a managed child under the actual runner/pty-runner.mjs.
// It creates a FakeTerminal, negotiates with the runner, and injects a marker write failure.
// The failure triggers onUnavailable → socket.destroy → runner cleanup.
import { createHostedFrameWitness } from "../src/core/hosted-frame-witness.mjs";

const OPEN = "\x1b[?2026h";
const CUP = "\x1b[1;1H";
const FULL = `${OPEN}${CUP}text\x1b[?2026l`;

// FakeTerminal that throws on marker writes
class FakeTerminal {
	constructor() {
		this.written = [];
	}
	get columns() { return 80; }
	get rows() { return 24; }
	write(text) {
		if (text.startsWith("\x1bP>")) throw new Error("injected marker write failure");
		this.written.push(text);
	}
	hideCursor() { this.written.push("<hide>"); }
	showCursor() { this.written.push("<show>"); }
	start() {}
	stop() {}
}

const terminal = new FakeTerminal();
const widgets = new Map();
const tui = {
	mode: "fullscreen",
	terminal,
	focus: { id: "editor" },
	getFocusedComponent() { return this.focus; },
	hasOverlay: () => false,
	requestRender() {},
};
const ui = { setWidget(key, factory) { widgets.set(key, factory(tui)); } };

// The runner injects AGENT_BOARD_CONTROL_SOCKET
const socketPath = process.env.AGENT_BOARD_CONTROL_SOCKET;
if (!socketPath) {
	console.error("AGENT_BOARD_CONTROL_SOCKET not set");
	process.exit(1);
}

const { reporter, socket, cleanup } = createHostedFrameWitness({
	socketPath,
	sessionEpoch: 1,
	ui,
	onUnavailable: (reason) => {
		console.error(`onUnavailable called: ${reason}`);
		// Use the helper's cleanup to trigger the full production cleanup path:
		// reporter.dispose → socket.destroy → runner cleanup
		cleanup(`reporter-unavailable:${reason}`);
	},
});

// The helper already sets up error/close handlers. We add connect/data handlers here.
socket.on("connect", () => {
	reporter.announce();
});

socket.on("data", (chunk) => {
	const text = chunk.toString("utf8");
	for (const line of text.split("\n").filter(Boolean)) {
		try {
			const message = JSON.parse(line);
			if (message.type === "frame_witness_enable") {
				const negotiation = reporter.handleMessage(message);
				if (negotiation.status === "enabled") {
					reporter.install();
					// Trigger a render pass to open a candidate
					void terminal.columns;
					void terminal.rows;
					const widget = widgets.get("agent-board-frame-witness");
					widget.render(80);
					// Now write a frame — this will fail on marker write
					terminal.write(FULL);
				}
			} else if (message.type === "frame_witness_intent") {
				reporter.applyIntent(message);
			}
		} catch {
			/* ignore */
		}
	}
});

socket.on("error", (err) => {
	// Expected: socket is destroyed after onUnavailable. Swallow ECONNRESET.
	if (err.code !== "ECONNRESET") console.error("socket error:", err.message);
});

socket.on("close", () => {
	// Runner should have cleaned up by now
	process.exit(0);
});

// Keep alive until socket closes
setInterval(() => {}, 1000);
