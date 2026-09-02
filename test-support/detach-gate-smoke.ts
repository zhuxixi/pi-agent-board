// Detach-gate regression harness (issues #42/#48/#66): construct
// PtyAttachComponent with a fake TUI, feed it Pi-like buffer states (fake
// cursor, garbled replay, streaming working line), then verify:
//   A. ctrl+] passes through as Pi's native editor shortcut.
//   B. ← stays gated: NOT detached while the editor line carries a draft.
//   B1. ← escapes on a garbled buffer with no recoverable editor line.
//   B2. ← escapes unconditionally while disconnected (issue #48).
//   B3. ← detaches when the editor line is empty but the cursor is elsewhere.
//   C. ← still detaches on a genuinely empty prompt line.
//   D. ← detach restores the held PTY size before a graceful socket end.
//   E. ← detaches on an empty editor line that renders no fake cursor.
//   F. ← detaches via the glyph fallback when a glyph line renders without a fake cursor.
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

async function writeToTerm(attach: PtyAttachComponent, data: string): Promise<void> {
	await new Promise<void>((resolve) => {
		(attach as unknown as { term: { write: (d: string, cb: () => void) => void } }).term.write(data, resolve);
	});
	(attach as unknown as { receivedOutput: boolean }).receivedOutput = true;
}

async function poisonCursorLine(attach: PtyAttachComponent): Promise<void> {
	// Write junk so the xterm cursor sits on a line that is NOT an empty pi
	// prompt — mimics the stale replay buffer of a failed attach jiggle.
	await writeToTerm(attach, "chat content\r\n────── ◊◊ ──────");
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

// B. ← must NOT detach while attached with a draft in the editor line (child
// is mid-draft and ← is also the editor's cursor-left key). The draft line
// carries Pi's inverse-video fake cursor (ESC[7m).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m草\x1b[27m稿");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftStaysGatedOnNonEmptyLine = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// B1. The garbled replay buffer (`────── ◊◊ ──────`) carries no inverse fake
// cursor and no prompt glyph, so no editor line is recoverable — the escape
// fallback treats the input as empty and ← must detach rather than trap the
// user. The socket is pinned connected=true explicitly: when it is down,
// issue #48 makes ← escape unconditionally instead (see B2).
{
	const { attach, sent, didDetach } = makeAttach();
	await poisonCursorLine(attach);
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftEscapesOnGarbledBuffer = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// B3. The streaming case from issue #66: the editor line is empty (bottom of
// the buffer, with its fake cursor) but the terminal cursor rests on the
// working line because Pi's differential frames only repaint the changed
// line. The gate must be judged from the fake-cursor line, not the cursor.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m \x1b[27m");
	await writeToTerm(attach, "\x1b[3;1H⠙ Working...");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesWhenCursorOffEmptyInputLine = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// B2. While the socket is down (issue #48) ← escapes unconditionally, even
// with a poisoned buffer — the key can never reach the child, so the view
// must remain exitable after a host crash mid-output.
{
	const { attach, didDetach } = makeAttach();
	await poisonCursorLine(attach);
	// connected stays false: the socket path never existed.
	attach.handleInput("\x1b[D");
	out.leftEscapesWhenDisconnected = didDetach();
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

// E. Empty input line rendered WITHOUT a fake cursor: no inverse cell and no
// glyph anywhere, and the terminal cursor sits on a non-empty output line.
// Falls through to the escape fallback — treat as empty, detach.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	await writeToTerm(attach, "\x1b[1;1H"); // park the cursor on the non-empty line
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesOnEmptyInputWithoutFakeCursor = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// F. Prompt-glyph line rendered WITHOUT an inverse fake cursor (a Pi variant
// that skips the fake cursor): tier-2 glyph fallback must find the editor
// line and detach on the empty `> ` prompt.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> ");
	await writeToTerm(attach, "\x1b[1;1H"); // park the cursor on the non-empty line
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesOnGlyphLineWithoutFakeCursor = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// H. The pushed editor state is authoritative over the render heuristic: the
// buffer holds a draft-looking line (heuristic would forward ←) but the
// child reports empty → ← detach.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m草\x1b[27m稿");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: true }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftEditorStateOverridesHeuristicEmpty = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// I. The pushed editor state is authoritative the other way: the heuristic
// would say "empty" (nothing in the buffer), but the child reports a draft →
// ← is forwarded (editor protection), NOT detach.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: false }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftEditorStateBlocksDetachOnDraft = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// J. A hello carrying null editorEmpty (fresh runner after a crash) resets a
// stale cached draft state — the gate falls back to the heuristic instead of
// mis-detaching. The heuristic sees a draft (fake cursor on a glyph line) →
// ← forwarded.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m草\x1b[27m稿");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: true }) + "\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "hello", editorEmpty: null }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftHelloNullResetsStaleEditorState = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// E2. A terminal at the minimum supported size must not emit a shrink that the
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
	// Windows has no unix-domain sockets: net.listen(path) treats the path as
	// a named pipe, which must use the \\.\pipe\ prefix (a plain temp path
	// fails with EACCES). Keep a random suffix so parallel runs cannot collide.
	const suffix = root.split(/[\\/]/).pop() ?? String(Date.now());
	const socketPath = process.platform === "win32"
		? `\\\\.\\pipe\\agentview-socket-identity-${suffix}`
		: join(root, "control.sock");
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
