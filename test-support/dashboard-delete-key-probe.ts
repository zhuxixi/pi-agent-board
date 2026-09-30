// Delete-key probe: drive the dashboard delete gestures through the public
// handleInput() and report observable state as JSON. One run covers the new
// `x` -> (y/N) path plus the legacy ctrl+x and multi-select regressions.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

type Row = { meta: { id: string; name: string }; alive: boolean; hostAlive: boolean; state: Record<string, unknown> | null };

function makeEnv(): {
	service: ReturnType<typeof createService>;
	root: string;
	archiveCalls: string[];
	archiveManyCalls: string[][];
	setRowPatch: (fn: ((r: Row) => Row) | null) => void;
} {
	const root = mkdtempSync(join(tmpdir(), "agentview-delete-key-"));
	createView(root, { id: "v1", name: "one", cwd: root });
	createView(root, { id: "v2", name: "two", cwd: root });
	const service = createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: root,
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
	});
	const archiveCalls: string[] = [];
	const realArchive = service.archive.bind(service);
	service.archive = ((id: string) => {
		archiveCalls.push(id);
		return realArchive(id);
	}) as typeof service.archive;
	// archiveMany calls archiveView directly (bypasses the archive wrapper
	// above), so the batch path needs its own recorder.
	const archiveManyCalls: string[][] = [];
	const realArchiveMany = service.archiveMany.bind(service);
	service.archiveMany = ((ids: string[]) => {
		archiveManyCalls.push([...ids]);
		return realArchiveMany(ids);
	}) as typeof service.archiveMany;
	const realRows = service.rows.bind(service);
	let rowPatch: ((r: Row) => Row) | null = null;
	service.rows = (() => realRows().map((r) => (rowPatch ? rowPatch(r as unknown as Row) : r))) as typeof service.rows;
	// selectedBatchRows() reads service.row(id), not service.rows() — patch
	// both so fixtures (busy/completed rows) stay consistent everywhere.
	const realRow = service.row.bind(service);
	service.row = ((id: string) => {
		const r = realRow(id);
		return r && rowPatch ? rowPatch(r as unknown as Row) : r;
	}) as typeof service.row;
	return { service, root, archiveCalls, archiveManyCalls, setRowPatch: (fn) => { rowPatch = fn; } };
}

const writes: string[] = [];
const tui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: (d: string) => { writes.push(d); } },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function makeDash(env: ReturnType<typeof makeEnv>): DashboardComponent {
	return new DashboardComponent(tui as never, theme as never, { matches: () => false } as never, () => {}, {
		service: env.service,
		root: env.root,
		defaultCwd: env.root,
		availableModels: [],
		currentModel: null,
		currentThinkingLevel: "off",
	} as never);
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return pred();
}

type Snapshot = { mode: string; prompt: string | null; notice: string | null; archived: string[] };

function snap(dash: DashboardComponent, env: ReturnType<typeof makeEnv>): Snapshot {
	const d = dash as unknown as { mode: string; pending: { prompt: string } | null; flash: { text: string } | null };
	return { mode: d.mode, prompt: d.pending?.prompt ?? null, notice: d.flash?.text ?? null, archived: [...env.archiveCalls] };
}

const report: Record<string, unknown> = {};

// 1) idle row: x opens the confirm prompt, nothing archived yet
{
	const env = makeEnv();
	const dash = makeDash(env);
	dash.handleInput("x");
	report.idlePrompt = snap(dash, env);
	dash.dispose();
}

// 2) busy row: prompt names the stopped run
{
	const env = makeEnv();
	env.setRowPatch((r) => ({ ...r, alive: true, hostAlive: true, state: { ...(r.state ?? {}), semanticState: "working" } }));
	const dash = makeDash(env);
	dash.handleInput("x");
	report.busyPrompt = snap(dash, env);
	dash.dispose();
}

// 3) cancel paths: n / esc / x again / q must not delete
{
	const cancel: Record<string, Snapshot> = {};
	for (const [name, key] of [["n", "n"], ["escape", "\x1b"], ["x", "x"], ["q", "q"]] as const) {
		const env = makeEnv();
		const dash = makeDash(env);
		dash.handleInput("x");
		dash.handleInput(key);
		cancel[name] = snap(dash, env);
		dash.dispose();
	}
	report.cancel = cancel;
}

// 4) y confirms: archive runs, notice lands, the row leaves the list
{
	const env = makeEnv();
	const dash = makeDash(env);
	const before = (dash as unknown as { orderedIds: string[] }).orderedIds[0];
	const beforeName = env.service.row(before)?.meta.name ?? "?";
	dash.handleInput("x");
	dash.handleInput("y");
	await waitFor(() => env.archiveCalls.length > 0, 5000);
	const after = dash as unknown as { orderedIds: string[]; selectedId: string; mode: string; flash: { level: string } | null };
	await waitFor(() => after.flash !== null, 5000);
	report.confirm = { ...snap(dash, env), beforeId: before, beforeName, orderedIds: after.orderedIds, selectedId: after.selectedId, level: after.flash?.level ?? null };
	dash.dispose();
}

// 5) insert mode: x is literal editor text
{
	const env = makeEnv();
	const dash = makeDash(env);
	dash.handleInput("i");
	dash.handleInput("x");
	const d = dash as unknown as { mode: string; input: string };
	report.insertMode = { mode: d.mode, input: d.input, archived: [...env.archiveCalls] };
	dash.dispose();
}

// 6) empty list: x is a no-op
{
	const root = mkdtempSync(join(tmpdir(), "agentview-delete-key-empty-"));
	const service = createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: root,
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
	});
	const dash = new DashboardComponent(tui as never, theme as never, { matches: () => false } as never, () => {}, {
		service,
		root,
		defaultCwd: root,
		availableModels: [],
		currentModel: null,
		currentThinkingLevel: "off",
	} as never);
	dash.handleInput("x");
	const d = dash as unknown as { mode: string; pending: unknown };
	report.emptyList = { mode: d.mode, pending: d.pending ?? null, crashed: false };
	dash.dispose();
}

// 7) legacy shortcut: ctrl+x twice inside the window still deletes without confirm
{
	const env = makeEnv();
	const dash = makeDash(env);
	dash.handleInput("\x18");
	dash.handleInput("\x18");
	await waitFor(() => env.archiveCalls.length > 0);
	report.legacyDoublePress = snap(dash, env);
	dash.dispose();
}

// 8) legacy window: a second ctrl+x after 700ms only re-arms
{
	const env = makeEnv();
	const dash = makeDash(env);
	dash.handleInput("\x18");
	await new Promise((r) => setTimeout(r, 700));
	dash.handleInput("\x18");
	report.legacySlow = snap(dash, env);
	dash.dispose();
}

// 9) multi-select keeps ctrl+x; plain x does nothing there
{
	const env = makeEnv();
	env.setRowPatch((r) => ({ ...r, state: { ...(r.state ?? {}), semanticState: "completed" } }));
	const dash = makeDash(env);
	const target = (dash as unknown as { orderedIds: string[] }).orderedIds[0];
	dash.handleInput("m");
	dash.handleInput(" ");
	const d0 = dash as unknown as { mode: string; pending: { prompt: string; returnMode?: string } | null };
	dash.handleInput("x");
	const afterX = { mode: d0.mode, prompt: d0.pending?.prompt ?? null };
	dash.handleInput("\x18");
	const d1 = dash as unknown as { mode: string; pending: { prompt: string; returnMode?: string } | null };
	const ctrlX = { mode: d1.mode, prompt: d1.pending?.prompt ?? null, returnMode: d1.pending?.returnMode ?? null };
	dash.handleInput("y");
	const d2 = dash as unknown as { mode: string; orderedIds: string[] };
	await waitFor(() => !d2.orderedIds.includes(target), 5000);
	report.selectMode = { afterX, ctrlX, target, confirmed: { archiveManyCalls: [...env.archiveManyCalls], mode: d2.mode, orderedIds: [...d2.orderedIds] }, archived: [...env.archiveCalls] };
	dash.dispose();
}

// 10) copy: list hints and the help overlay both advertise the new key
{
	const env = makeEnv();
	const dash = makeDash(env);
	const d = dash as unknown as { mode: string };
	// 240 cols: the hints line clips at narrow widths (pre-existing behavior);
	// assert against the unclipped source string.
	const hints = dash.render(240).join("\n");
	d.mode = "help";
	const help = dash.render(240).join("\n");
	report.copy = { hints, help };
	dash.dispose();
}

console.log(JSON.stringify(report));
