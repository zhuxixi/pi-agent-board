// Exercise the real regular/fullscreen TUI renderers and input dispatch, with
// their actual ANSI output replayed into a headless terminal (no host services).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import xterm from "@xterm/headless";
import { TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { DashboardComponent } from "../src/ui/dashboard.ts";
import { createView, listRows } from "../src/core/store.mjs";

const results = [];
for (const mode of ["regular", "fullscreen"] as const) {
	const root = mkdtempSync(join(tmpdir(), `board-${mode}-`));
	const emulator = new xterm.Terminal({ cols: 120, rows: 24, allowProposedApi: true });
	let input = (_data: string) => {};
	let resize = () => {};
	const terminal = {
		rows: 24,
		columns: 120,
		kittyProtocolActive: false,
		start: (onInput: typeof input, onResize: typeof resize) => { input = onInput; resize = onResize; },
		stop: () => {},
		drainInput: async () => {},
		write: (data: string) => emulator.write(data),
		moveBy: (lines: number) => { if (lines) terminal.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`); },
		hideCursor: () => terminal.write("\x1b[?25l"),
		showCursor: () => terminal.write("\x1b[?25h"),
		clearLine: () => terminal.write("\x1b[2K"),
		clearFromCursor: () => terminal.write("\x1b[J"),
		clearScreen: () => terminal.write("\x1b[2J\x1b[H"),
		setTitle: () => {},
		setProgress: () => {},
		setProgramStatus: () => {},
	};
	const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
	let dash: any;
	try {
		createView(root, { id: "base", name: "base", cwd: root });
		const base = listRows(root)[0];
		const states = ["needs_input", "holding", "completed"];
		let rows = Array.from({ length: 18 }, (_, i) => ({
			...base,
			meta: { ...base.meta, id: `v${i}`, name: `mode-case-${i}`, createdAt: i,
				cwd: join(root, `folder-${i % 2}`), repoCwd: join(root, `folder-${i % 2}`) },
			state: { ...base.state, semanticState: states[Math.floor(i / 6)] },
		}));
		const service = {
			rows: () => rows,
			row: (id: string) => rows.find((row) => row.meta.id === id),
			prewarmHost: () => ({ ok: false }),
			ptyHealth: () => ({ ok: true, reason: null, staleHosts: 0, liveHosts: 0 }),
		};
		const open = () => new DashboardComponent(tui, { fg: (_c: string, text: string) => text, bold: (text: string) => text, bg: (_c: string, text: string) => text } as never,
			{ matches: () => false } as never, () => { throw new Error("unexpected attach/exit"); }, {
				service: service as never, root, defaultCwd: root, availableModels: [],
				currentModel: null, currentThinkingLevel: "off",
			});
		tui.addChild({ render: () => ["underlying Pi view"], invalidate: () => {} });
		const overlayOptions = { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } as const;
		dash = open();
		let overlay = tui.showOverlay(dash, overlayOptions);
		tui.start();
		let frames = 0;
		const frame = async () => {
			tui.renderNow();
			// Flush deferred force-clears (mount and content shrink) between frames.
			await new Promise<void>((resolve) => setImmediate(resolve));
			tui.renderNow();
			await new Promise<void>((resolve) => emulator.write("", resolve));
			frames++;
			const buffer = emulator.buffer.active;
			const lines = Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? "");
			const body: string[] = dash.renderRows(terminal.columns).map(stripVTControlCharacters);
			const selectedPrefix = body[dash.selectedBodyLine].trimEnd().slice(0, 20);
			assert.ok(lines.some((line) => line.trimEnd().slice(0, 20) === selectedPrefix),
				`${mode}: selected target must be visible in actual terminal output`);
			return lines;
		};
		const key = async (data: string) => { input(data); return frame(); };
		const focusHeader = async (state: string) => {
			for (let i = 0; i <= dash.listTargets.length; i++) {
				if (dash.selectedSection === state) return;
				await key("\x1b[B");
			}
			throw new Error(`${mode}: cannot navigate to ${state}`);
		};
		await frame();
		let screen = await key("\t");
		assert.ok(screen.some((line) => line.includes("›▸ NEEDS ANSWER (6)")));
		assert.ok(!screen.some((line) => /mode-case-[0-5](?:\s|$)/.test(line)), `${mode}: folded rows must leave no stale terminal text`);
		assert.equal(dash.selectedSection, "needs_input");
		await key("\x1b[9u"); // CSI-u Tab (extended-key terminals/tmux)
		assert.ok(!dash.isSectionFolded("needs_input"));
		await key("\x1b[27;1;9~"); // xterm modifyOtherKeys Tab
		assert.ok(dash.isSectionFolded("needs_input"));
		screen = await key("\r");
		assert.ok(screen.some((line) => line.includes("mode-case-0")));
		await focusHeader("completed");
		await key("\t");
		terminal.rows = 16;
		terminal.columns = 80;
		emulator.resize(terminal.columns, terminal.rows);
		resize();
		await frame();
		for (const direction of ["\x1b[A", "\x1b[B"]) {
			for (let i = 0; i <= dash.listTargets.length; i++) await key(direction);
		}
		await focusHeader("needs_input");
		screen = await frame();
		assert.ok(!screen.some((line) => /↑ \d+ more/.test(line)), `${mode}: no-running layout must reach the true top`);
		await key("\t");
		// Recreate the overlay as the command does after an attach/detach roundtrip.
		overlay.hide();
		dash.dispose();
		dash = open();
		overlay = tui.showOverlay(dash, overlayOptions);
		screen = await frame();
		assert.ok(dash.isSectionFolded("needs_input"));
		assert.ok(dash.isSectionFolded("completed"));
		assert.ok(!screen.some((line) => /mode-case-[0-5](?:\s|$)/.test(line)));
		// Polling a section away while scrolled must not strand the focus.
		await focusHeader("holding");
		rows = rows.filter((row) => row.state.semanticState !== "holding");
		dash.refresh();
		await frame();
		assert.notEqual(dash.selectedSection, "holding");
		results.push({ mode, frames, ok: true });
	} finally {
		dash?.dispose();
		tui.stop();
		await new Promise<void>((resolve) => emulator.write("", resolve));
		emulator.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}
console.log(JSON.stringify(results));
