// Component-level selection-mirror coverage (issue #174 B2): the REAL
// PtyAttachComponent with a fake fullscreen TUI whose getActiveSelectionText
// returns a controllable fixture, run against a nonexistent control socket,
// with a PATH-stubbed bidirectional xclip that appends every invocation
// (args + stdin for writes) to a log file and prints a read fixture for -o.
// Run via `node --experimental-transform-types`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const READ_FIXTURE = "read-fixture-text";

const root = mkdtempSync(join(tmpdir(), "agentview-sel-mirror-"));
const binDir = join(root, "bin");
mkdirSync(binDir);
const logPath = join(root, "xclip.log");
writeFileSync(logPath, "");
writeFileSync(
	join(binDir, "xclip"),
	[
		"#!/bin/sh",
		`if [ "$1" = "-o" ]; then`,
		`  echo "read $*" >> "${logPath}"`,
		`  printf '%s' "${READ_FIXTURE}"`,
		"else",
		'  text="$(cat)"',
		`  echo "write $* text=$text" >> "${logPath}"`,
		"fi",
	].join("\n"),
);
chmodSync(join(binDir, "xclip"), 0o755);
process.env.PATH = `${binDir}:${process.env.PATH}`;

// The selection pi would have finalized by the time the deferred mirror runs.
let selectionText: string | undefined = "mirror-fixture-text";
// Issue #172 knobs. clearTextSelection invalidates the fixture so a read-after-clear
// order would produce no PRIMARY write — that is what pins the ordering, not the count.
let copyOnSelect = true;
let clearAvailable = true;
let clearCalls = 0;

const resetFixture = (text: string | undefined = "mirror-fixture-text") => {
	selectionText = text;
	copyOnSelect = true;
	clearAvailable = true;
	clearCalls = 0;
};

const writes = () =>
	readFileSync(logPath, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("write "));

const reads = () =>
	readFileSync(logPath, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("read "));

const leftEvent = (type: "release" | "click" | "press" | "move") => ({
	type,
	button: "left",
	x: 3,
	y: 3,
	screenX: 3,
	screenY: 3,
	width: 80,
	height: 22,
	shift: false,
});

async function withComponent(env: Record<string, string> | undefined, fn: (c: PtyAttachComponent) => Promise<void>): Promise<void> {
	const prevEnv: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env ?? {})) {
		prevEnv[k] = process.env[k];
		process.env[k] = v;
	}
	const tui = {
		mode: "fullscreen",
		getActiveSelectionText: () => selectionText,
		getCopyOnSelect: () => copyOnSelect,
		...(clearAvailable
			? {
					clearTextSelection: () => {
						clearCalls += 1;
						selectionText = undefined;
					},
				}
			: {}),
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	let component: PtyAttachComponent | null = null;
	try {
		component = new PtyAttachComponent(
			tui as never,
			theme as never,
			{} as never,
			() => {},
			{ socketPath: join(root, "nonexistent.sock"), title: "sel mirror e2e" } as never,
		);
		await fn(component);
	} finally {
		try { component?.dispose(); } catch {}
		await sleep(50);
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const result = {
	error: null as string | null,
	releaseResultUndefined: false,
	mirrorWrites: -1,
	mirrorText: null as string | null,
	mirrorWriteArgs: null as string | null,
	clickResultUndefined: false,
	clickMirrorWrites: -1,
	emptyWrites: -1,
	killSwitchWrites: -1,
	nonEndingWrites: -1,
	releaseClears: -1,
	clickClears: -1,
	emptyClears: -1,
	killSwitchClears: -1,
	nonEndingClears: -1,
	copyOnSelectOffWrites: -1,
	copyOnSelectOffClears: -1,
	fallbackError: null as string | null,
	fallbackWrites: -1,
	middleHandled: false,
	clipboardReads: -1,
	clipboardReadSource: null as string | null,
};

try {
	// 1. Drag-style release mirrors the selection exactly once, unconsumed, and clears.
	await withComponent(undefined, async (c) => {
		resetFixture();
		const before = writes().length;
		const r = (c as any).handleMouse(leftEvent("release"));
		result.releaseResultUndefined = r === undefined;
		await sleep(80); // nextTick + xclip spawn
		const ws = writes();
		result.mirrorWrites = ws.length - before;
		const line = ws.length > before ? ws[ws.length - 1] : null;
		result.mirrorText = line ? line.replace(/^write .*?text=/, "") : null;
		result.mirrorWriteArgs = line ? line.slice(0, line.indexOf("text=")) : null;
		result.releaseClears = clearCalls;
	});

	// 2. Click ending (non-empty selection) mirrors too, unconsumed, and clears.
	await withComponent(undefined, async (c) => {
		resetFixture();
		const before = writes().length;
		const r = (c as any).handleMouse(leftEvent("click"));
		result.clickResultUndefined = r === undefined;
		await sleep(80);
		result.clickMirrorWrites = writes().length - before;
		result.clickClears = clearCalls;
	});

	// 3. Empty selection: no write, no clear.
	await withComponent(undefined, async (c) => {
		resetFixture();
		selectionText = undefined;
		const before = writes().length;
		(c as any).handleMouse(leftEvent("release"));
		await sleep(80);
		result.emptyWrites = writes().length - before;
		result.emptyClears = clearCalls;
	});

	// 4. Kill switch: no PRIMARY write (writePrimarySelection self-gates), but the
	// highlight is still cleared — the switch governs X11 copy/paste, not UI state.
	await withComponent({ AGENT_BOARD_ATTACH_NATIVE_PASTE: "0" }, async (c) => {
		resetFixture();
		const before = writes().length;
		(c as any).handleMouse(leftEvent("release"));
		await sleep(80);
		result.killSwitchWrites = writes().length - before;
		result.killSwitchClears = clearCalls;
	});

	// 5. Non-endings (press/move): no write, no clear.
	await withComponent(undefined, async (c) => {
		resetFixture();
		const before = writes().length;
		(c as any).handleMouse(leftEvent("press"));
		(c as any).handleMouse(leftEvent("move"));
		await sleep(80);
		result.nonEndingWrites = writes().length - before;
		result.nonEndingClears = clearCalls;
	});

	// 6. copy-on-select off: the user keeps the selection for pi's Ctrl+X, so the
	// mirror still runs (the text exists) but the highlight must stay.
	await withComponent(undefined, async (c) => {
		resetFixture();
		copyOnSelect = false;
		const before = writes().length;
		(c as any).handleMouse(leftEvent("release"));
		await sleep(80);
		result.copyOnSelectOffWrites = writes().length - before;
		result.copyOnSelectOffClears = clearCalls;
	});

	// 7. Older/newer pi without the private clear method: degrade, never throw.
	await withComponent(undefined, async (c) => {
		resetFixture();
		clearAvailable = false;
		const before = writes().length;
		try {
			(c as any).handleMouse(leftEvent("release"));
			await sleep(80);
		} catch (err) {
			result.fallbackError = err instanceof Error ? err.message : String(err);
		}
		result.fallbackWrites = writes().length - before;
	});

	// 8. Paste source override: middle paste reads CLIPBOARD when configured.
	await withComponent({ AGENT_BOARD_ATTACH_PASTE_SOURCE: "clipboard" }, async (c) => {
		resetFixture();
		const before = reads().length;
		const r = (c as any).handleMouse({ type: "press", button: "middle", x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 22, shift: false });
		result.middleHandled = r?.handled === true;
		await sleep(200); // xclip spawn + close
		const rs = reads();
		result.clipboardReads = rs.length - before;
		result.clipboardReadSource = rs.length > before ? rs[rs.length - 1] : null;
	});
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
}

try {
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
} catch {}
console.log(JSON.stringify(result));
process.exit(0);
