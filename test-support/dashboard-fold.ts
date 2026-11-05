// Runtime UI probe: deliberate white-box assertions complement public key input.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DashboardComponent } from "../src/ui/dashboard.ts";
import { readFoldedSections } from "../src/core/dashboard-prefs.mjs";
import { createView, listRows } from "../src/core/store.mjs";

const root = mkdtempSync(join(tmpdir(), "board-fold-"));
const dashboards: any[] = [];
try {
	createView(root, { id: "base", name: "base", cwd: root });
	const base = listRows(root)[0];
	const states = ["needs_input", "idle", "holding", "completed"];
	let rows = Array.from({ length: 32 }, (_, i) => ({
		...base,
		meta: { ...base.meta, id: `v${i}`, name: `fold-case-${i}`, createdAt: i,
			cwd: join(root, `folder-${i % 2}`), repoCwd: join(root, `folder-${i % 2}`) },
		state: { ...base.state, semanticState: states[Math.floor(i / 8)], summary: i === 0 ? "literal › in content" : "waiting" },
	}));
	const calls: string[] = [];
	const service = {
		rows: () => rows,
		row: (id: string) => rows.find((row) => row.meta.id === id),
		prewarmHost: () => ({ ok: false }),
		ptyHealth: () => ({ ok: true, reason: null, staleHosts: 0, liveHosts: 0 }),
		rename: () => calls.push("rename"),
		setPinned: () => calls.push("pin"),
		stop: () => calls.push("stop"),
		holdView: () => calls.push("hold"),
		clearHoldView: () => calls.push("unhold"),
		markCompleted: () => calls.push("done"),
		archive: () => calls.push("delete"),
		archiveByState: () => calls.push("delete-state"),
	};
	const tui = { terminal: { rows: 24, cols: 120, columns: 120, write: () => {} }, requestRender: () => {} };
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text, bg: (_c: string, text: string) => text };
	const open = (prefsRoot = root): any => {
		const dash = new DashboardComponent(tui as never, theme as never, { matches: () => false } as never, () => calls.push("attach-or-exit"), {
			service: service as never, root: prefsRoot, defaultCwd: root, availableModels: [],
			currentModel: null, currentThinkingLevel: "off",
		});
		dashboards.push(dash);
		return dash;
	};
	let dash = open();
	const frame = (width = 120) => {
		const lines: string[] = dash.render(width);
		assert.equal(lines.length, tui.terminal.rows);
		assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
		if (dash.listTargets.length > 0) {
			const body: string[] = dash.renderRows(width).map(stripVTControlCharacters);
			assert.ok(lines.map(stripVTControlCharacters).includes(body[dash.selectedBodyLine]), "selected session/header must never be hidden by an indicator");
		}
		return lines.map(stripVTControlCharacters);
	};
	const focusHeader = (state: string) => {
		for (let i = 0; i <= dash.listTargets.length; i++) {
			if (dash.selectedSection === state) return;
			dash.handleInput("\x1b[B");
			frame();
		}
		throw new Error(`cannot reach ${state} header`);
	};

	// Tab also works from a session: collapse its section and focus the header.
	dash.handleInput("\t");
	assert.equal(dash.selectedId, null);
	assert.equal(dash.selectedSection, "needs_input");
	assert.ok(frame().some((line: string) => line.includes("›▸ NEEDS ANSWER (8)")));
	assert.ok(!dash.renderRows(120).some((line: string) => line.includes("fold-case-0 ")));
	assert.ok(!dash.orderedIds.includes("v0"));
	dash.refresh();
	assert.equal(dash.selectedSection, "needs_input", "polling must retain header focus");

	// Insert-mode Tab belongs to the editor. Folding from Normal keeps a draft.
	dash.handleInput("i");
	for (const char of "draft") dash.handleInput(char);
	dash.handleInput("\t");
	assert.ok(dash.isSectionFolded("needs_input"));
	dash.handleInput("\x1b");
	const draft = dash.input;
	dash.handleInput("\t");
	assert.ok(!dash.isSectionFolded("needs_input"));
	assert.equal(dash.input, draft);
	dash.handleInput("\x1b");
	assert.equal(dash.input, "");
	dash.handleInput("\t");

	// Headers never act on the previously selected session.
	for (const key of ["v", "e", "d", "h", "x", "X", "\x18", "\x18", "\x12", "\x14", "\x13", ">", "m"]) {
		dash.handleInput(key);
		assert.equal(dash.mode, "list");
		assert.equal(dash.selectedId, null);
	}
	assert.deepEqual(calls, []);
	dash.handleInput("\t");
	assert.ok(dash.orderedIds.includes("v0"));
	assert.equal(dash.selectedSection, "needs_input");
	dash.handleInput("\r");
	assert.ok(dash.isSectionFolded("needs_input"));
	dash.handleInput("\x1b[C");
	assert.ok(!dash.isSectionFolded("needs_input"));
	dash.handleInput("\x1b[D");
	dash.handleInput("\x1b[D");
	assert.ok(dash.isSectionFolded("needs_input"), "left is an idempotent collapse");
	for (const state of ["holding", "completed"]) {
		focusHeader(state);
		dash.handleInput("\t");
	}
	assert.deepEqual(readFoldedSections(root), ["needs_input", "holding", "completed"]);

	// Mixed expanded/folded groups, wraparound, and small resized viewports.
	for (const height of [24, 16, 12]) {
		tui.terminal.rows = height;
		for (const width of [120, 60]) {
			for (const key of ["\x1b[B", "\x1b[A"]) {
				for (let i = 0; i <= dash.listTargets.length; i++) {
					frame(width);
					dash.handleInput(key);
					if (dash.selectedId) assert.ok(dash.orderedIds.includes(dash.selectedId));
				}
			}
		}
	}
	tui.terminal.rows = 24;
	focusHeader("idle");
	dash.handleInput("\t");
	assert.equal(dash.orderedIds.length, 0);
	assert.equal(dash.listTargets.length, 4);
	for (let i = 0; i < 5; i++) {
		dash.handleInput("\x1b[B");
		assert.equal(dash.selectedId, null);
		frame();
	}
	focusHeader("needs_input");
	assert.ok(!frame().some((line: string) => /↑ \d+ more/.test(line)), "folded first heading reaches the true top");

	// Saved folds survive reopening; no hidden session becomes initially selected.
	dash.dispose();
	dash = open();
	assert.equal(dash.orderedIds.length, 0);
	assert.equal(dash.selectedSection, "needs_input");
	assert.equal(dash.selectedId, null);
	frame();

	// Batch selection and peek navigation only include expanded sessions.
	focusHeader("idle");
	dash.handleInput("\x1b[C");
	dash.handleInput("\x1b[B");
	const firstIdle = dash.selectedId;
	assert.ok(firstIdle);
	dash.handleInput("m");
	dash.handleInput("a");
	assert.equal(dash.selectedIds.size, 8);
	assert.deepEqual([...dash.selectedIds], dash.orderedIds);
	dash.handleInput("\x1b[A");
	assert.equal(dash.selectedId, dash.orderedIds.at(-1));
	dash.handleInput("\x1b[B");
	assert.equal(dash.selectedId, firstIdle);
	dash.handleInput("\x1b");
	dash.handleInput(" ");
	assert.equal(dash.mode, "peek");
	dash.handleInput("\x1b[A");
	assert.equal(dash.selectedId, dash.orderedIds.at(-1));
	dash.handleInput("\x1b");
	dash.handleInput("\t");
	assert.equal(dash.orderedIds.length, 0);

	// Search temporarily reveals matching folded rows without changing prefs.
	const saved = readFoldedSections(root);
	dash.handleInput("/");
	for (const char of "s:hold") dash.handleInput(char);
	dash.handleInput("\r");
	assert.equal(dash.orderedIds.length, 8);
	assert.ok(!dash.isSectionFolded("holding"));
	dash.handleInput("\t");
	assert.deepEqual(readFoldedSections(root), saved);
	dash.handleInput("/");
	dash.handleInput("\x1b");
	assert.equal(dash.orderedIds.length, 0);
	assert.ok(dash.isSectionFolded("holding"));

	// A selected row moving into a folded state focuses that state's header.
	focusHeader("idle");
	dash.handleInput("\x1b[C");
	dash.handleInput("\x1b[B");
	rows.find((row) => row.meta.id === dash.selectedId)!.state.semanticState = "completed";
	dash.refresh();
	assert.equal(dash.selectedSection, "completed");
	assert.equal(dash.selectedId, null);
	assert.ok(frame().some((line: string) => line.includes("›▸ DONE (9)")));

	// A removed section cannot leave stale focus; reappearing sections retain folds.
	focusHeader("holding");
	const held = rows.filter((row) => row.state.semanticState === "holding");
	rows = rows.filter((row) => row.state.semanticState !== "holding");
	dash.refresh();
	assert.notEqual(dash.selectedSection, "holding");
	rows.push(...held);
	dash.refresh();
	assert.ok(dash.isSectionFolded("holding"));
	assert.ok(!dash.orderedIds.includes(held[0].meta.id));

	// A failed preference write must not undo folding or break navigation.
	const badRoot = join(root, "cannot-save");
	mkdirSync(join(badRoot, "dashboard-prefs.json"), { recursive: true });
	dash = open(badRoot);
	dash.handleInput("\t");
	assert.ok(dash.inputNotice.text.includes("could not save"));
	assert.ok(dash.isSectionFolded("needs_input"));
	frame();

	rows = [];
	dash.refresh();
	assert.equal(dash.selectedId, null);
	assert.equal(dash.selectedSection, null);
	for (const key of ["\t", "\x1b[A", "\x1b[B", "\r"]) dash.handleInput(key);
	assert.ok(frame().some((line: string) => line.includes("No background sessions")));
	assert.deepEqual(calls, []);
	console.log(JSON.stringify({ ok: true }));
} finally {
	for (const dash of dashboards) dash.dispose();
	rmSync(root, { recursive: true, force: true });
}
