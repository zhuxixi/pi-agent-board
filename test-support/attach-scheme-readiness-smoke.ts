import { PtyAttachComponent } from "../src/ui/pty-attach.ts";
import { feedAttachOutput } from "./attach-output-fixture.ts";

function fixture() {
	const sent: string[] = [];
	const diagnostics: unknown[] = [];
	let listener: ((scheme: "light" | "dark") => void) | undefined;
	let late: ((colors: unknown) => void) | undefined;
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
		onTerminalColorSchemeChange: (callback: typeof listener) => {
			listener = callback;
			return () => { listener = undefined; };
		},
		queryTerminalColors: async (opts: { onLateReply?: typeof late }) => {
			late = opts.onLateReply;
			return { background: { r: 41, g: 41, b: 54 } };
		},
	};
	const attach = new PtyAttachComponent(tui as never, { fg: (_c, text) => text, bold: text => text }, {} as never, () => {}, {
		socketPath: "/nonexistent/scheme-readiness.sock", title: "scheme-readiness",
		// This smoke models the settle-scheme probe only; the #284 recovery
		// settle record (attach_settle_ready) is out of scope and filtered.
		onDiagnostic: event => {
			if ((event as { code?: string }).code === "attach_settle_scheme") diagnostics.push(event);
		},
	});
	// SAFETY: These are the real private members; replace only socket delivery
	// and seed a connected transport. Readiness always uses production parsing.
	const internals = attach as unknown as {
		send: (msg: { type: string; data?: string }) => void;
		connected: boolean;
		finishAttachTransition: (source: string) => void;
		handleAttachEvent: (event: string, payload: unknown) => void;
	};
	internals.connected = true;
	internals.send = msg => { if (msg.type === "input" && msg.data) sent.push(msg.data); };
	return {
		attach, sent, diagnostics,
		settle: async () => {
			internals.finishAttachTransition("legacy-settle");
			await new Promise(resolve => setImmediate(resolve));
		},
		fireScheme: (scheme: "light" | "dark") => listener?.(scheme),
		fireLate: (scheme: "light" | "dark") => late?.({ background: scheme === "light" ? { r: 240, g: 240, b: 240 } : { r: 41, g: 41, b: 54 } }),
		emptySnapshot: () => internals.handleAttachEvent("snapshotReady", { empty: true }),
	};
}

const out: Record<string, unknown> = {};
{
	const f = fixture();
	try {
		// Historical output from an earlier incarnation must not release input.
		await feedAttachOutput(f.attach, "\x1b[?2004h", "history");
		await f.settle();
		out.historyInput = [...f.sent];
		out.historyDiagnostics = [...f.diagnostics];
		await feedAttachOutput(f.attach, "BOOTING", "live");
		out.historyThenLiveInput = [...f.sent];
		f.emptySnapshot();
		await feedAttachOutput(f.attach, "BOOTING", "live");
		f.fireLate("light");
		out.emptySnapshotInput = [...f.sent];
		await feedAttachOutput(f.attach, "\x1b[?20");
		out.partialEnableInput = [...f.sent];
		await feedAttachOutput(f.attach, "04h");
		out.readyInput = [...f.sent];
		out.readyDiagnostics = [...f.diagnostics];
		await feedAttachOutput(f.attach, "more output");
		out.repeatedOutputInput = [...f.sent];
		// Stop/reload disables bracketed paste before leaving raw mode. Scheme
		// notifications and late probe replies must be held during that window.
		await feedAttachOutput(f.attach, "\x1b[?2004l");
		f.fireScheme("dark");
		f.fireLate("light");
		out.stoppedInput = [...f.sent];
		await feedAttachOutput(f.attach, "\x1b[?2004h");
		out.restartedInput = [...f.sent];
	} finally {
		f.attach.dispose();
	}
}
{
	const f = fixture();
	try {
		await feedAttachOutput(f.attach, "\x1b[?2004h", "snapshot");
		await f.settle();
		out.warmSnapshotInput = [...f.sent];
	} finally {
		f.attach.dispose();
	}
}
{
	const f = fixture();
	await f.settle();
	f.attach.dispose();
	f.fireLate("light");
	await feedAttachOutput(f.attach, "\x1b[?2004h");
	out.closedInput = [...f.sent];
}
console.log(JSON.stringify(out));
