// Detach-gate regression harness (issue #42): construct PtyAttachComponent with
// a fake TUI, poison the headless buffer so the cursor line looks like a
// non-empty prompt (the stale/garbled state a failed attach jiggle leaves
// behind), then verify:
//   A. ctrl+] passes through as Pi's native editor shortcut.
//   B. ← stays gated: NOT detached while the input line looks non-empty.
//   C. ← still detaches on a genuinely empty prompt line.
// Run via `node --experimental-transform-types` (TS parameter properties).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const tui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const keybindings = {} as never;

function makeAttach() {
	let result: unknown = null;
	const attach = new PtyAttachComponent(
		tui as never,
		theme,
		keybindings,
		(r) => { result = r; },
		{ socketPath: "/no/such/socket", title: "gate" },
	);
	const sent: Array<Record<string, unknown>> = [];
	(attach as unknown as { send: (msg: Record<string, unknown>) => void }).send = (msg) => sent.push(msg);
	return {
		attach,
		sent,
		didDetach: () => (result as { action?: string } | null)?.action === "detached",
	};
}

async function poisonCursorLine(attach: PtyAttachComponent): Promise<void> {
	// Write junk so the xterm cursor sits on a line that is NOT an empty pi
	// prompt — mimics the stale replay buffer of a failed attach jiggle.
	await new Promise<void>((resolve) => {
		(attach as unknown as { term: { write: (d: string, cb: () => void) => void } }).term.write(
			"chat content\r\n────── ◊◊ ──────",
			resolve,
		);
	});
	(attach as unknown as { receivedOutput: boolean }).receivedOutput = true;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

const out: Record<string, boolean> = {};

// A. ctrl+] is a native Pi editor key and must pass through unchanged,
// even with a poisoned buffer; it is not an agent-board detach key.
{
	const { attach, sent, didDetach } = makeAttach();
	await poisonCursorLine(attach);
	attach.handleInput("\x1d");
	out.ctrlBracketPassesThrough = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1d";
	attach.dispose();
}

// B. ← must NOT detach with a poisoned buffer (child may be mid-draft).
{
	const { attach, sent, didDetach } = makeAttach();
	await poisonCursorLine(attach);
	attach.handleInput("\x1b[D");
	out.leftStaysGatedOnNonEmptyLine = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// C. ← still detaches on an empty prompt line (no output received yet).
{
	const { attach, didDetach } = makeAttach();
	attach.handleInput("\x1b[D");
	out.leftDetachesOnEmptyInput = didDetach();
	attach.dispose();
}

// D. When detach happens while the jiggle hold is active, restore the original
// PTY size before ending the control socket (G3). The runner closes the socket
// after detach, so the client must use a graceful end rather than destroy.
{
	const attach = new PtyAttachComponent(
		tui as never,
		theme,
		keybindings,
		() => {},
		{ socketPath: "/no/such/socket", title: "wire" },
	);
	const wire: string[] = [];
	const socket = {
		write(data: string) { wire.push(data); return true; },
		end() { wire.push("END"); },
		destroy() { wire.push("DESTROY"); },
		once(_event: string, _listener: () => void) { return this; },
	};
	const internals = attach as unknown as {
		socket: typeof socket | null;
		connected: boolean;
		receivedOutput: boolean;
		jiggleRetry: { start: (cols: number, rows: number) => void };
	};
	internals.socket = socket;
	internals.connected = true;
	internals.receivedOutput = false;
	internals.jiggleRetry.start(80, 22);
	wire.length = 0;
	attach.handleInput("\x1b[D");
	const packets = wire.filter((entry) => entry !== "END" && entry !== "DESTROY").map((entry) => JSON.parse(entry));
	out.leftDetachRestoresBeforeGracefulEnd = packets.length === 2 && packets[0].type === "resize" && packets[0].cols === 80 && packets[0].rows === 22 && packets[1].type === "detach" && wire.at(-1) === "END" && !wire.includes("DESTROY");
	attach.dispose();
}

// E. A terminal at the minimum supported size must not emit a shrink that the
// runner immediately clamps back, because that is not a real width delta.
{
	const { attach } = makeAttach();
	const internals = attach as unknown as {
		jiggleRetry: { start: (cols: number, rows: number) => void };
	};
	const sent: Array<Record<string, unknown>> = [];
	(internals as unknown as { send: (msg: Record<string, unknown>) => void }).send = (msg) => sent.push(msg);
	internals.jiggleRetry.start(20, 5);
	out.minimumSizeAvoidsInvalidShrink = sent.length === 1 && sent[0].type === "resize" && sent[0].cols === 20 && sent[0].rows === 5;
	attach.dispose();
}

async function runStaleSocketIdentityScenario(): Promise<boolean> {
	const root = mkdtempSync(join(tmpdir(), "agentview-socket-identity-"));
	const socketPath = join(root, "control.sock");
	const server = createServer();
	const serverSockets: Array<import("node:net").Socket> = [];
	server.on("connection", (socket) => serverSockets.push(socket));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	const attach = new PtyAttachComponent(
		tui as never,
		theme,
		keybindings,
		() => {},
		{ socketPath, title: "identity" },
	);
	const internals = attach as unknown as {
		socket: import("node:net").Socket | null;
		connected: boolean;
		status: string;
	};
	try {
		const connected = await waitFor(() => internals.connected && internals.socket !== null, 2000);
		if (!connected) return false;
		const stale = internals.socket;
		if (!stale) return false;
		const staleErrorHandler = stale.listeners("error")[0] as ((error: Error) => void) | undefined;
		const staleCloseHandler = stale.listeners("close")[0] as (() => void) | undefined;

		// Invoke the old socket's production handlers directly so the close is
		// guaranteed to arrive after the reconnect, not as a normal net.Socket
		// error->close sequence before socket B exists.
		staleErrorHandler?.(new Error("simulated stale socket error"));
		const reconnected = await waitFor(() => internals.connected && internals.socket !== null && internals.socket !== stale, 2500);
		if (!reconnected) return false;
		const current = internals.socket;
		if (!current) return false;

		// A late close from A must not clear the state belonging to B.
		staleCloseHandler?.();
		return internals.socket === current && internals.connected && internals.status === "attached";
	} finally {
		attach.dispose();
		for (const socket of serverSockets) {
			try { socket.destroy(); } catch {}
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}

out.staleSocketEventsDoNotClearCurrent = await runStaleSocketIdentityScenario();

console.log(JSON.stringify(out));
