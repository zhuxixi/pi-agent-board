// Component-level coverage for issue #258: the REAL DashboardComponent with a
// fake fullscreen TUI exposing the pi-tui selection seam, driven via handleMouse
// directly (the #172 pty-attach-selection-mirror-scenario.ts pattern).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createView, listRows } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const root = mkdtempSync(join(tmpdir(), "board-settle-"));
let selectionText: string | undefined = "board-fixture-text";
let clearCalls = 0;
let readCalls = 0;
let renderCalls = 0;

const resetFixture = () => {
	selectionText = "board-fixture-text";
	clearCalls = 0;
	readCalls = 0;
	renderCalls = 0;
};

const tui = {
	mode: "fullscreen",
	getActiveSelectionText: () => { readCalls += 1; return selectionText; },
	getCopyOnSelect: () => true,
	clearTextSelection: () => { clearCalls += 1; selectionText = undefined; },
	requestRender: () => { renderCalls += 1; },
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
};

const leftEvent = (type: "release" | "click" | "press" | "move", x = 3, y = 3) => ({
	type, button: "left", x, y, screenX: x, screenY: y, width: 80, height: 22, shift: false,
});

const base = (() => {
	createView(root, { id: "base", name: "base", cwd: root });
	return listRows(root)[0];
})();
const rows = Array.from({ length: 6 }, (_, i) => ({
	...base,
	meta: { ...base.meta, id: `v${i}`, name: `settle-case-${i}`, createdAt: i, cwd: root, repoCwd: root },
	state: { ...base.state, semanticState: i < 3 ? "needs_input" : "idle" },
}));
const service = {
	rows: () => rows,
	row: (id: string) => rows.find((row) => row.meta.id === id),
	prewarmHost: () => ({ ok: false }),
	ptyHealth: () => ({ ok: true, reason: null, staleHosts: 0, liveHosts: 0 }),
	getLaunchPrefs: () => null,
	reconcile: async () => {},
};

const result = {
	error: null as string | null,
	releaseUndefined: false,
	listClears: -1, listRenders: -1,
	coalescedClears: -1,
	nonEndingClears: -1,
	filterMode: false, filterClears: -1,
	launchMode: false, launchClears: -1,
	disposeRaceReads: -1, disposeRaceClears: -1, disposeRaceRenders: -1,
};

const open = () => new DashboardComponent(
	tui as never,
	{ fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t } as never,
	{ matches: () => false } as never,
	() => { throw new Error("unexpected attach/exit"); },
	{ service: service as never, root, defaultCwd: root, availableModels: [], currentModel: null, currentThinkingLevel: "off" } as never,
);

let dash: any;
try {
	// 1. List mode: left release defers one tick, then clears and repaints; never consumes.
	dash = open();
	resetFixture();
	result.releaseUndefined = dash.handleMouse(leftEvent("release")) === undefined;
	await sleep(30);
	result.listClears = clearCalls;
	result.listRenders = renderCalls;

	// 2. Release + new press in one tick: the queued settle is dropped.
	resetFixture();
	dash.handleMouse(leftEvent("release", 3, 3));
	dash.handleMouse(leftEvent("press", 9, 9));
	await sleep(30);
	result.coalescedClears = clearCalls;

	// 3. Non-endings never settle (right/middle press, move, wheel-shaped event).
	resetFixture();
	dash.handleMouse({ ...leftEvent("press"), button: "right" });
	dash.handleMouse({ ...leftEvent("press"), button: "middle" });
	dash.handleMouse(leftEvent("move"));
	dash.handleMouse({ type: "wheel", button: "none", x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 22, shift: false });
	await sleep(30);
	result.nonEndingClears = clearCalls;

	// 4. Editor-bearing mode (filter): same observer, same settle (spec D6).
	resetFixture();
	dash.startFilter();
	result.filterMode = dash.mode === "filter";
	dash.handleMouse(leftEvent("release"));
	await sleep(30);
	result.filterClears = clearCalls;
	dash.toListMode();

	// 5. Editor-bearing mode (launch): same observer, same settle (spec D6).
	resetFixture();
	dash.input = "probe";
	dash.openLaunchDialog();
	result.launchMode = dash.mode === "launch";
	dash.handleMouse(leftEvent("release"));
	await sleep(30);
	result.launchClears = clearCalls;

	// 6. Unmount race (R2-D1): dispose() before flush blocks before any host
	// read even when the host already carries a newer UI's selection.
	resetFixture();
	dash.handleMouse(leftEvent("release"));
	const readsBeforeDispose = readCalls;
	dash.dispose();
	selectionText = "newer-ui-selection";
	await sleep(30);
	result.disposeRaceReads = readCalls - readsBeforeDispose;
	result.disposeRaceClears = clearCalls;
	result.disposeRaceRenders = renderCalls;
} catch (err) {
	result.error = err instanceof Error ? err.stack : String(err);
} finally {
	try { dash?.dispose(); } catch { /* already disposed in case 6 */ }
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
