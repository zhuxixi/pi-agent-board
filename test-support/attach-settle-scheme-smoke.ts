// Attach settle scheme probe scenarios (issue #161). Driver: test/pty-attach-settle-scheme.test.mjs.
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

// OSC 11 replies (and pi-tui's parsed reply) carry 0-255 channels, and the
// luminance threshold sits at ~188 grey, so these pin one answer per scheme.
const LIGHT = { r: 240, g: 240, b: 240 };
const DARK = { r: 41, g: 41, b: 54 };
/** The unowned raw probe #165 deleted: writing it makes the reply fall through
 * handleInput into the still-starting child. A3 pins that it never comes back. */
const RAW_OSC11_QUERY = "\x1b]11;?";

interface Captures { sent: string[]; diagnostics: any[]; writes: string[]; }

function makeTui(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		terminal: { rows: 24, cols: 80, columns: 80, write: (_d: string) => {} },
		requestRender: () => {},
		onTerminalColorSchemeChange: () => () => {},
		...overrides,
	};
}

async function runSettle(tui: Record<string, unknown>, opts: { env?: Record<string, string> } = {}): Promise<Captures> {
	const captures: Captures = { sent: [], diagnostics: [], writes: [] };
	// The component legitimately writes mouse-mode / XTSHIFTESCAPE control
	// sequences at construction and teardown, so `writes` records only the
	// terminal queries that have no local owner — what A3 asserts about.
	(tui.terminal as { write: (d: string) => void }).write = (d) => { if (d.includes(RAW_OSC11_QUERY)) captures.writes.push(d); };
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
	let attach: PtyAttachComponent | undefined;
	try {
		attach = new PtyAttachComponent(tui as never, theme as never, {} as never, () => {}, {
			socketPath: "/nonexistent/settle-scheme.sock",
			title: "settle-scheme",
			onDiagnostic: (event) => captures.diagnostics.push(event),
		});
		const internals = attach as unknown as { send: (m: { type: string; data?: string }) => void; finishAttachTransition: () => void };
		internals.send = (m) => { if (m?.type === "input" && m.data) captures.sent.push(m.data); };
		internals.finishAttachTransition();
		await new Promise((r) => setImmediate(r));
		return captures;
	} finally {
		// Each scenario owns a component whose socket retry chain would otherwise
		// hold the event loop open (the driver reads our stdout to EOF).
		attach?.dispose();
		for (const k of Object.keys(opts.env ?? {})) delete process.env[k];
	}
}

const out: Record<string, unknown> = {};
const dump = (c: Captures) => ({ sent: c.sent, diagnostics: c.diagnostics, writes: c.writes });

// A1: new API, light and dark backgrounds.
out.newApiLight = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({ background: LIGHT }) })));
out.newApiDark = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({ background: DARK }) })));
// A2: old API fallback keeps #149 behavior.
out.oldApi = dump(await runSettle(makeTui({ queryTerminalBackgroundColor: async () => LIGHT })));
// A3: neither API — no probe, no raw write.
out.noApi = dump(await runSettle(makeTui({})));
// A9: three failure branches.
out.timeout = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({}) })));
out.error = dump(await runSettle(makeTui({ queryTerminalColors: async () => { throw new Error("boom"); } })));
out.noBackground = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({ foreground: DARK }) })));
// Kill switch: suppressed, info level, no probeApi.
out.killSwitch = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({ background: LIGHT }) }), { env: { AGENT_BOARD_FORWARD_TERMINAL_QUERIES: "0" } }));

console.log(JSON.stringify(out));
