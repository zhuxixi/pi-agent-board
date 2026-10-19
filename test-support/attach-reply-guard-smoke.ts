// Issue #170 component smoke: the REAL PtyAttachComponent with only the socket
// transport replaced, so the guard wiring — not a stub — decides what reaches
// the child. Shape follows test-support/attach-scheme-readiness-smoke.ts (#180).
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

// Keep the smoke hermetic: an exported escape hatch in the developer's shell
// must not flip the guard off and fail A6 spuriously.
delete process.env.AGENT_BOARD_REPLY_GUARD;

// Real bytes from upstream #10657: a DA1 reply delivered as four reads.
const DA1_CHUNKS = ["\x1b[?61;6;", "7;22;23;", "24;28;32", ";42c"];
const OSC11_REPLY = "\x1b]11;rgb:2887/2a18/353c\x1b\\";

function fixture() {
	const sent: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	const attach = new PtyAttachComponent(
		tui as never,
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
		{} as never,
		() => {},
		{ socketPath: "/nonexistent/reply-guard.sock", title: "reply-guard" },
	);
	// SAFETY: the production component's real private members; only socket
	// delivery and the connection flag are replaced.
	const internals = attach as unknown as {
		send: (msg: { type: string; data?: string }) => void;
		connected: boolean;
		replyGuard: { pendingSince: () => number | null } | null;
		replyGuardTimer: unknown;
	};
	internals.connected = true;
	internals.send = (msg) => {
		if (msg.type === "input" && msg.data) sent.push(msg.data);
	};
	return { attach, sent, internals };
}

const out: Record<string, unknown> = {};
{
	const f = fixture();
	try {
		for (const chunk of DA1_CHUNKS) f.attach.handleInput(chunk);
		out.guardedFragments = [...f.sent];
		f.attach.handleInput(OSC11_REPLY);
		out.guardedColorReply = [...f.sent];
	} finally {
		f.attach.dispose();
	}
}
{
	// Issue #213: a complete CSI key must reach the child, not the absorption window,
	// and the bytes typed right after a key must still be forwarded verbatim.
	const f = fixture();
	try {
		f.attach.handleInput("\x1b[6;1u");
		f.attach.handleInput("\x1b[6;5~");
		out.guardedPageDown = [...f.sent];
		f.sent.length = 0;
		f.attach.handleInput("\x1b[6;1u");
		f.attach.handleInput("x");
		out.guardedPageDownThenText = [...f.sent];
	} finally {
		f.attach.dispose();
	}
}
{
	process.env.AGENT_BOARD_REPLY_GUARD = "0";
	const f = fixture();
	try {
		for (const chunk of DA1_CHUNKS) f.attach.handleInput(chunk);
		out.killSwitchFragments = [...f.sent];
	} finally {
		f.attach.dispose();
		delete process.env.AGENT_BOARD_REPLY_GUARD;
	}
}
{
	const f = fixture();
	f.attach.handleInput("\x1b[?61;6;");
	out.armedFrames = [...f.sent];
	out.pendingBeforeDispose = f.internals.replyGuard?.pendingSince() ?? null;
	f.attach.dispose();
	out.pendingAfterDispose = f.internals.replyGuard?.pendingSince() ?? null;
	out.timerAfterDispose = f.internals.replyGuardTimer ?? null;
}
console.log(JSON.stringify(out));
