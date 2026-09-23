// Detach-gate regression harness (issues #42/#48/#66/#89, then issue #91
// Phase 6 / spec §D1): construct PtyAttachComponent with a fake TUI, feed it
// Pi-like buffer states, then verify the ← gate reads ONLY the pushed
// editorEmpty side channel:
//   A. ctrl+] passes through as Pi's native editor shortcut.
//   B.* Without a pushed editor_state (null), ← ALWAYS forwards — every
//       heuristic-era buffer shape (draft, empty, garbled, glyph, chat
//       inverse content) pins the same conservative policy; buffer content
//       must be irrelevant to the gate.
//   B2. ← escapes unconditionally while disconnected (issue #48).
//   C. ← escapes when the socket never connected.
//   D. ← detach restores the held PTY size before a graceful socket end.
//   H/I/J. The pushed editor_state is authoritative; hello null resets a
//       stale cache to the conservative forward policy.
//   L/M/N. Ctrl+← detaches unconditionally (issue #89).
//   P1-P7. Ctrl+\ detaches unconditionally in every editor/socket state and
//       across raw/kitty/modifyOtherKeys encodings; printable keys still
//       forward (issue #126).
// Run via `node --experimental-transform-types` (TS parameter properties).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const keybindings = {} as never;

// Minimal fake TUI for scenarios that need no write/scheme capture.
const plainTui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
	requestRender: () => {},
	onTerminalColorSchemeChange: (_listener: (scheme: string) => void) => () => {},
};

function makeAttach() {
	let result: unknown = null;
	// Issue #128: per-attach fake TUI with terminal-write capture and a
	// color-scheme listener registry (the bridge under test registers here).
	const terminalWrites: string[] = [];
	const colorSchemeListeners = new Set<(scheme: string) => void>();
	const scopedTui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (s: string) => { terminalWrites.push(s); } },
		requestRender: () => {},
		onTerminalColorSchemeChange: (listener: (scheme: string) => void) => {
			colorSchemeListeners.add(listener);
			return () => { colorSchemeListeners.delete(listener); };
		},
		fireColorScheme: (scheme: string) => {
			for (const listener of [...colorSchemeListeners]) listener(scheme);
		},
		listenerCount: () => colorSchemeListeners.size,
	};
	const attach = new PtyAttachComponent(
		scopedTui as never,
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
		terminalWrites,
		scopedTui,
		didDetach: () => (result as { action?: string } | null)?.action === "detached",
	};
}

function countWrites(writes: string[], needle: string): number {
	return writes.filter((w) => w.includes(needle)).length;
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

// B. Without a pushed editor_state the gate must forward ← regardless of the
// buffer: null means "unknown", and the conservative policy forwards. This
// shape (a draft-looking line with Pi's inverse fake cursor) used to be read
// by the tier-1 heuristic; that heuristic is deleted (issue #91 Phase 6).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m草\x1b[27m稿");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftStaysGatedOnNonEmptyLine = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// B1. Without a pushed editor_state, even a garbled replay buffer forwards ←
// — the heuristic-era "no editor line recoverable, treat as empty" escape is
// gone (issue #91 Phase 6). The escape guarantee is Ctrl+← / a down socket,
// never a buffer guess. The socket is pinned connected=true explicitly: when
// it is down, issue #48 makes ← escape unconditionally instead (see B2).
{
	const { attach, sent, didDetach } = makeAttach();
	await poisonCursorLine(attach);
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsOnGarbledBufferWithoutEditorState = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// B3. The streaming shape from issue #66 (empty editor line at the bottom,
// terminal cursor parked on a working line) also forwards without a pushed
// editor_state — buffer shape is irrelevant to the gate (issue #91 Phase 6).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m \x1b[27m");
	await writeToTerm(attach, "\x1b[3;1H⠙ Working...");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsOnEmptyEditorLineWithoutEditorState = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
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

// C. ← escapes when the socket never connected (issue #48): the key could
// never reach the child, so the view must stay exitable.
{
	const { attach, didDetach } = makeAttach();
	attach.handleInput("\x1b[D");
	out.leftEscapesWhenSocketNeverConnected = didDetach();
	attach.dispose();
}

// D. When detach happens while the jiggle hold is active, restore the original
// PTY size before ending the control socket (G3). The runner closes the socket
// after detach, so the client must use a graceful end rather than destroy.
// editor_state empty:true is pushed so ← actually detaches (issue #91 Phase 6:
// only the side channel can arm the detach).
{
	const attach = new PtyAttachComponent(
		plainTui as never,
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
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: true }) + "\n");
	wire.length = 0;
	attach.handleInput("\x1b[D");
	const packets = wire.filter((entry) => entry !== "END" && entry !== "DESTROY").map((entry) => JSON.parse(entry));
	out.leftDetachRestoresBeforeGracefulEnd = packets.length === 2 && packets[0].type === "resize" && packets[0].cols === 80 && packets[0].rows === 22 && packets[1].type === "detach" && wire.at(-1) === "END" && !wire.includes("DESTROY");
	attach.dispose();
}

// E. Empty-looking buffer (no fake cursor, no glyph) without a pushed
// editor_state: forward — only editorEmpty === true detaches (issue #91
// Phase 6; the old escape fallback is deleted).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	await writeToTerm(attach, "\x1b[1;1H"); // park the cursor on the non-empty line
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsWithoutEditorStateEvenOnEmptyLookingBuffer = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// F. Prompt-glyph line rendered WITHOUT a fake cursor, no pushed
// editor_state: forward — the tier-2 glyph fallback is deleted (issue #69 is
// dissolved by D1: there is no heuristic left to misfire).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> ");
	await writeToTerm(attach, "\x1b[1;1H"); // park the cursor on the non-empty line
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsOnGlyphLineWithoutEditorState = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// H. The pushed editor state is the ONLY detach signal: the buffer holds a
// draft-looking line, but the child reports empty → ← detaches.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m草\x1b[27m稿");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: true }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesWhenEditorStateReportsEmpty = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// I. The pushed editor state is authoritative the other way: the buffer
// looks empty, but the child reports a draft → ← is forwarded (editor
// protection), NOT detach.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: false }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsWhenEditorStateReportsDraft = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// J. A hello carrying null editorEmpty (fresh runner after a crash) resets a
// stale cached draft state — the gate lands on the conservative forward
// policy (no heuristic fallback; issue #91 Phase 6). The buffer holds a
// draft-looking line → ← forwarded either way.
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

// K1. Issue #69's real-world shape (zero inverse cells, markdown table row
// and quote glyph lines, no pushed editor_state): forwards — the tier-2
// fallback that #69 tightened is deleted, so the issue is dissolved rather
// than re-tuned (issue #91 Phase 6).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n│ Issue #778 │ open │\r\n> quote line\r\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsOnTableRowsWithoutEditorState = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// K2. The flip side of K1 — the SAME draft shape (`> draft`) forwards without
// a pushed editor_state, exactly like every other buffer shape: only
// editorEmpty === true detaches. The heuristic-era asymmetry (gated with a
// fake cursor, detached without one) is gone (issue #91 Phase 6).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> draft\r\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsOnContentGlyphWithoutEditorState = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// O1. Issue #103's diff hunk (chat-area inverse content) without a pushed
// editor_state: forwards — chat content is render-only now, never a gate
// input (issue #91 Phase 6 dissolves #103's anchor-hijack class).
{
	const { attach, sent, didDetach } = makeAttach();
	const DIFF_LINE = "\x1b[48;2;230;233;239m \x1b[38;2;64;160;43m+ 65 ## \x1b[7mR2 · \x1b[27m#\x1b[7m822 新 step 挂链顺序调研\x1b[27m";
	await writeToTerm(attach, "chat\r\n" + DIFF_LINE + "\r\n  ");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsWithDiffHighlightWithoutEditorState = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// O2. The notification banner renders the whole entry inverse — same shape,
// same conservative forward without a pushed editor_state.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat\r\n\x1b[7m Session saved \x1b[27m\r\n  ");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsWithInverseBannerWithoutEditorState = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// O3. The #103 R1 trade-off is superseded (spec §D1): a new-style draft line
// (text + one inverse fake cursor, no prompt glyph) with no pushed
// editor_state now FORWARDS — without the side channel the gate never
// detaches, which restores draft protection instead of trading it away
// (issue #91 Phase 6). Escape remains Ctrl+←.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n\x1b[7m草\x1b[27m稿");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftForwardsOnNewStyleDraftWithoutReporter = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// L. Issue #89: the Ctrl+← chord detaches unconditionally — even when the
// editor holds a draft (editor_state empty:false would forward single ←),
// because the chord is unambiguous exit intent, not a cursor-left.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: false }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[1;5D");
	out.ctrlLeftDetachesOnDraft = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// M. Issue #89: the chord also detaches from a genuinely empty editor —
// same unconditional guarantee on the other side of the gate.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m \x1b[27m");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[1;5D");
	out.ctrlLeftDetachesOnEmptyInput = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// N. Issue #89: the surface must advertise the chord — the live header names
// Ctrl+← next to ← once the loading screen is gone.
{
	const { attach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	const lines = attach.render(80);
	out.headerMentionsCtrlLeft = lines.some((line) => line.includes("Ctrl+←"));
	out.headerMentionsCtrlBackslash = lines.some((line) => line.includes("Ctrl+\\"));
	attach.dispose();
}

// P1. Issue #126: Ctrl+\ (raw 0x1c) detaches even with a pushed draft — the
// unconditional escape never consults the editor gate (contrast scenario I
// where a draft forwards single ←). It is the bottom layer of the ladder:
// ← (editor-gated) → Ctrl+← (modifier encoding) → Ctrl+\ (raw byte).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: false }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1c");
	out.ctrlBackslashDetachesOnDraft = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// P2. Issue #126: the empty-editor quadrant — same unconditional detach.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: true }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1c");
	out.ctrlBackslashDetachesOnEmptyEditor = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// P3. Issue #126: the null quadrant (no editor_state ever pushed) — the
// conservative-forward policy for ← must not trap Ctrl+\.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1c");
	out.ctrlBackslashDetachesWithoutEditorState = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// P4. Issue #126: the disconnected quadrant — Ctrl+\ still ends the surface
// (issue #48's always-exitable guarantee does not depend on the key chosen).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	attach.handleInput("\x1c");
	out.ctrlBackslashDetachesWhileDisconnected = didDetach() && !sent.some((msg) => msg.type === "input");
	attach.dispose();
}

// P5. Issue #126: terminals in kitty keyboard protocol mode encode the same
// chord as CSI-u (\x1b[92;5u) instead of the raw byte — matchesKey covers
// that form; pin it so a parser change cannot silently drop the escape.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: false }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[92;5u");
	out.ctrlBackslashDetachesViaKittyEncoding = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// P6. Issue #126: modifyOtherKeys mode (\x1b[27;5;92~) — the third real-world
// encoding (pi itself enables modifyOtherKeys in its TUI), same guarantee.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: false }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[27;5;92~");
	out.ctrlBackslashDetachesViaModifyOtherKeys = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// P7. Isolation: an ordinary printable key keeps forwarding to the child —
// adding the unconditional escape must not widen into a generic interceptor.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: false }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("q");
	out.printableQStillForwardsToChild = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "q";
	attach.dispose();
}

// P8. Issue #128 A3: the child's OSC 11 query and 2031 notify switch reach
// the real terminal via the D1 forwarder; the rgb SET-form must not (it
// would repaint the local terminal's own colors). Driven through the
// production forwarding entry point (pushOutput with forwardProtocols).
{
	const { attach, terminalWrites } = makeAttach();
	const push = (attach as unknown as { pushOutput: (d: string, o?: { forwardProtocols?: boolean }) => void });
	push.pushOutput("hello\x1b]11;?\x07world", { forwardProtocols: true });
	push.pushOutput("\x1b]11;rgb:ffff/ffff/ffff\x07", { forwardProtocols: true });
	push.pushOutput("\x1b[?2031h", { forwardProtocols: true });
	out.queriesForwardedToTerminal = countWrites(terminalWrites, "\x1b]11;?\x07") === 1;
	out.oscSetFormNotForwarded = !terminalWrites.some((w) => w.includes("rgb:ffff/ffff/ffff"));
	out.notifySwitchForwarded = countWrites(terminalWrites, "\x1b[?2031h") === 1;
	attach.dispose();
}

// P9. Issue #128 A4/A7: after settle the color-scheme bridge repackages the
// local TUI's scheme events as 997 reports on the child pty; detaching must
// unsubscribe (no leaked listener) and silence further sends.
{
	const { attach, sent, scopedTui } = makeAttach();
	(attach as unknown as { finishAttachTransition: () => void }).finishAttachTransition();
	scopedTui.fireColorScheme("light");
	out.schemeBridgeSendsReport = sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[?997;2n";
	attach.handleInput("\x1c");
	const sentAfterDetach = sent.length;
	out.schemeBridgeUnsubscribesOnDetach = scopedTui.listenerCount() === 0;
	scopedTui.fireColorScheme("dark");
	out.schemeBridgeSilentAfterDetach = sent.length === sentAfterDetach;
	attach.dispose();
}

// P10. Issue #128 A5: settle writes the background probe to the real
// terminal exactly once (double-settle is a no-op: `attaching` never re-arms);
// the kill switch silences forwarding, replay, AND the bridge.
{
	const { attach, terminalWrites } = makeAttach();
	const settle = (attach as unknown as { finishAttachTransition: () => void });
	settle.finishAttachTransition();
	settle.finishAttachTransition();
	out.replayProbeWrittenOnceOnSettle = countWrites(terminalWrites, "\x1b]11;?\x07") === 1;
	attach.dispose();

	process.env.AGENT_BOARD_FORWARD_TERMINAL_QUERIES = "0";
	try {
		const killed = makeAttach();
		const killPush = (killed.attach as unknown as { pushOutput: (d: string, o?: { forwardProtocols?: boolean }) => void });
		killPush.pushOutput("\x1b]11;?\x07", { forwardProtocols: true });
		(killed.attach as unknown as { finishAttachTransition: () => void }).finishAttachTransition();
		out.killSwitchSilencesQueriesAndReplay = !killed.terminalWrites.some((w) => w.includes("\x1b]11;?\x07"));
		out.killSwitchSkipsBridge = killed.scopedTui.listenerCount() === 0;
		killed.attach.dispose();
	} finally {
		delete process.env.AGENT_BOARD_FORWARD_TERMINAL_QUERIES;
	}
}

// P11. Issue #128 A6: kitty keyboard protocol / DA1 negotiation must NOT be
// forwarded — the child negotiated at spawn (before attach) and pushing
// flags would retune the shared real-terminal keyboard stack.
{
	const { attach, terminalWrites } = makeAttach();
	(attach as unknown as { pushOutput: (d: string, o?: { forwardProtocols?: boolean }) => void }).pushOutput("\x1b[>7u\x1b[?u\x1b[c", { forwardProtocols: true });
	out.kittyNegotiationNotForwarded = !terminalWrites.some((w) => w.includes("\x1b[>7u") || w.includes("\x1b[?u") || w.includes("\x1b[c"));
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

	const identityTui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
		onTerminalColorSchemeChange: (_listener: (scheme: string) => void) => () => {},
	};
	const attach = new PtyAttachComponent(
		identityTui as never,
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
