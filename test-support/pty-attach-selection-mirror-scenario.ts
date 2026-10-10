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

const writes = () =>
	readFileSync(logPath, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("write "));

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
	clickResultUndefined: false,
	clickMirrorWrites: -1,
	emptyWrites: -1,
	killSwitchWrites: -1,
	nonEndingWrites: -1,
};

try {
	// 1. Drag-style release mirrors the selection exactly once, unconsumed.
	await withComponent(undefined, async (c) => {
		const before = writes().length;
		const r = (c as any).handleMouse(leftEvent("release"));
		result.releaseResultUndefined = r === undefined;
		await sleep(80); // nextTick + xclip spawn
		const ws = writes();
		result.mirrorWrites = ws.length - before;
		result.mirrorText = ws.length > before ? ws[ws.length - 1].replace(/^write .*?text=/, "") : null;
	});

	// 2. Click ending (non-empty selection) mirrors too, unconsumed.
	await withComponent(undefined, async (c) => {
		const before = writes().length;
		const r = (c as any).handleMouse(leftEvent("click"));
		result.clickResultUndefined = r === undefined;
		await sleep(80);
		result.clickMirrorWrites = writes().length - before;
	});

	// 3. Empty selection: no write.
	await withComponent(undefined, async (c) => {
		const prev = selectionText;
		selectionText = undefined;
		const before = writes().length;
		(c as any).handleMouse(leftEvent("release"));
		await sleep(80);
		result.emptyWrites = writes().length - before;
		selectionText = prev;
	});

	// 4. Kill switch: no write.
	await withComponent({ AGENT_BOARD_ATTACH_NATIVE_PASTE: "0" }, async (c) => {
		const before = writes().length;
		(c as any).handleMouse(leftEvent("release"));
		await sleep(80);
		result.killSwitchWrites = writes().length - before;
	});

	// 5. Non-endings (press/move): no write.
	await withComponent(undefined, async (c) => {
		const before = writes().length;
		(c as any).handleMouse(leftEvent("press"));
		(c as any).handleMouse(leftEvent("move"));
		await sleep(80);
		result.nonEndingWrites = writes().length - before;
	});
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
}

try {
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
} catch {}
console.log(JSON.stringify(result));
process.exit(0);
