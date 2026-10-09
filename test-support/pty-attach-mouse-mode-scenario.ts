// Component-level outer-mouse-mode ownership coverage (issue #169): the REAL
// PtyAttachComponent with a fake TUI whose terminal.write collects bytes, run
// against a nonexistent control socket (on non-Windows, connect() short-
// circuits to its reconnect loop before creating a socket — no socket churn).
// Four cases:
//   1. mode "fullscreen"       → ZERO mouse-mode/XTSHIFTESCAPE writes across
//      ctor + the 0/50/250ms refresh window + close() (TuiAltScreen owns it);
//   2. mode "regular"          → today's pairing preserved (MOUSE_ENABLE at
//      ctor, MOUSE_DISABLE at close);
//   3. mode "regular" + AGENT_BOARD_ATTACH_MOUSE=0 → zero writes including
//      close() (fixes the previously unguarded disable);
//   4. mode absent (old pi)    → behaves like regular.
// Run via `node --experimental-transform-types`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MOUSE_BYTE_RE = /\x1b\[\?(1000|1002|1003|1004|1006)[hl]/;
const XTSHIFTESCAPE_RE = /\x1b\[>0s/;

interface CaseResult {
	writes: number;
	enableAtCtor: boolean;
	disableAtClose: boolean;
}

async function runCase(mode: string | undefined, env: Record<string, string> | undefined): Promise<CaseResult> {
	const writes: string[] = [];
	const tui = {
		mode,
		terminal: { rows: 24, cols: 80, columns: 80, write: (s: string) => { writes.push(s); } },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const root = mkdtempSync(join(tmpdir(), "agentview-mouse-mode-"));
	const socketPath = join(root, "nonexistent.sock");
	const prevEnv: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env ?? {})) {
		prevEnv[k] = process.env[k];
		process.env[k] = v;
	}
	let component: PtyAttachComponent | null = null;
	try {
		component = new PtyAttachComponent(
			tui as never,
			theme as never,
			{} as never,
			() => {},
			{ socketPath, title: "mouse mode e2e" } as never,
		);
		const enableAtCtor = writes.some((s) => s.includes("\x1b[?1000h"));
		await sleep(400); // past the 250ms refresh window
		try { component.dispose(); } catch {}
		await sleep(100);
		const disableAtClose = writes.some((s) => s.includes("\x1b[?1000l"));
		return {
			writes: writes.filter((s) => MOUSE_BYTE_RE.test(s) || XTSHIFTESCAPE_RE.test(s)).length,
			enableAtCtor,
			disableAtClose,
		};
	} finally {
		try { component?.dispose(); } catch {}
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); } catch {}
	}
}

const result = {
	error: null as string | null,
	fullscreen: null as CaseResult | null,
	regular: null as CaseResult | null,
	off: null as CaseResult | null,
	legacy: null as CaseResult | null,
};

try {
	result.fullscreen = await runCase("fullscreen", { AGENT_BOARD_ATTACH_MOUSE: "1" });
	result.regular = await runCase("regular", { AGENT_BOARD_ATTACH_MOUSE: "1" });
	result.off = await runCase("regular", { AGENT_BOARD_ATTACH_MOUSE: "0" });
	result.legacy = await runCase(undefined, { AGENT_BOARD_ATTACH_MOUSE: "1" });
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
}
console.log(JSON.stringify(result));
process.exit(0);
