// Position-keep probe (issue #254): drive the hold / done gestures through the
// public handleInput() and report where the cursor lands. One run feeds every
// assertion in test/dashboard-position-keep.test.mjs.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

// Seed writes stay real (service commands, disk state) but skip the detached
// state-coordinator: it outlives this process, and `npm test` fails on
// coordinators that leak past the suite. This is the documented
// coordinator_disabled escape hatch; the service writes the same state directly.
process.env.AGENT_BOARD_COORDINATOR = "off";

type Env = {
	service: ReturnType<typeof createService>;
	root: string;
	dash: DashboardComponent;
};

const tui = {
	terminal: { rows: 24, cols: 240, columns: 240, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };

type Priv = {
	mode: string;
	selectedId: string | null;
	selectedSection: string | null;
	peekId: string | null;
	orderedIds: string[];
	filterQuery: string;
	flash: { text: string; level: string } | null;
};

function priv(dash: DashboardComponent): Priv {
	return dash as unknown as Priv;
}

// Every scenario gets its own root: seeding goes through the real service
// commands (clearHoldView / holdView), so the disk state stays the source of
// truth and nothing has to be faked in the row view.
async function makeEnv(count: number): Promise<Env> {
	const root = mkdtempSync(join(tmpdir(), "agentview-position-keep-"));
	const ids = Array.from({ length: count }, (_, i) => `v${i + 1}`);
	for (const id of ids) createView(root, { id, name: id, cwd: root });
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
	for (const id of ids) {
		const res = await service.clearHoldView(id);
		if (!res.ok) throw new Error(`seed idle failed for ${id}: ${res.error}`);
	}
	const dash = new DashboardComponent(tui as never, theme as never, { matches: () => false } as never, () => {}, {
		service,
		root,
		defaultCwd: root,
		availableModels: [],
		currentModel: null,
		currentThinkingLevel: "off",
	} as never);
	return { service, root, dash };
}

/** Point the cursor at a row without depending on navigation order. */
function select(dash: DashboardComponent, id: string): void {
	priv(dash).selectedId = id;
	priv(dash).selectedSection = null;
	dash.refresh();
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return pred();
}

function cursor(dash: DashboardComponent, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const p = priv(dash);
	return { selectedId: p.selectedId, orderedIds: [...p.orderedIds], mode: p.mode, ...extra };
}

const report: Record<string, unknown> = {};

// A2: h on a middle row keeps the slot; the row below takes the cursor.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.holdMiddle = cursor(env.dash, { demotedId: "v3" });
	env.dash.dispose();
}

// A3: h on the last row selects the previous row.
{
	const env = await makeEnv(5);
	select(env.dash, "v5");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.holdLast = cursor(env.dash, { demotedId: "v5" });
	env.dash.dispose();
}

// A4: h on the only row keeps it selected.
{
	const env = await makeEnv(1);
	select(env.dash, "v1");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).flash !== null);
	report.holdOnly = cursor(env.dash, { demotedId: "v1" });
	env.dash.dispose();
}

// A6: unhold keeps the slot too — the cursor must not stay on the resumed row.
{
	const env = await makeEnv(4);
	await env.service.holdView("v3");
	await env.service.holdView("v4");
	env.dash.refresh();
	select(env.dash, "v3");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.unhold = cursor(env.dash, { demotedId: "v3" });
	env.dash.dispose();
}

// A8 (h branch): a rejected hold leaves the cursor alone.
{
	const env = await makeEnv(4);
	select(env.dash, "v3");
	env.service.holdView = (() => Promise.resolve({ ok: false, error: "boom" })) as typeof env.service.holdView;
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).flash !== null);
	report.holdFailed = cursor(env.dash, { notice: priv(env.dash).flash?.text ?? null });
	env.dash.dispose();
}

// A9: filtering hides the demoted row; the next surviving row takes the cursor.
{
	const env = await makeEnv(5);
	priv(env.dash).filterQuery = "s:idle";
	env.dash.refresh();
	select(env.dash, "v3");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.holdFiltered = cursor(env.dash, { demotedId: "v3" });
	env.dash.dispose();
}

// A10: peek keeps its own target; the list cursor still moves to the slot.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	env.dash.handleInput(" "); // space opens peek
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.holdPeek = cursor(env.dash, { peekId: priv(env.dash).peekId, demotedId: "v3" });
	env.dash.dispose();
}

// A10b: a second distinct demote from peek must still refresh the board. The
// guard sees `moved` (the list cursor sits on v4, peek still targets v3) and
// correctly skips the anchor, but refresh() has to run so the grouping is not
// left stale until the next poll tick.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	env.dash.handleInput(" "); // space opens peek on v3
	env.dash.handleInput("h"); // hold v3 from peek — the list cursor moves to v4
	await waitFor(() => priv(env.dash).selectedId === "v4");
	env.dash.handleInput("h"); // unhold v3 from peek — guard sees moved, refresh must run
	await waitFor(() => priv(env.dash).orderedIds.indexOf("v3") < priv(env.dash).orderedIds.indexOf("v4"));
	report.peekRepeat = cursor(env.dash, { peekId: priv(env.dash).peekId });
	env.dash.dispose();
}

// A11: a background transition (not driven by the dashboard) still follows.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	await env.service.markCompleted("v3");
	env.dash.refresh();
	report.backgroundFollow = cursor(env.dash, { movedId: "v3" });
	env.dash.dispose();
}

// A5: d+y on a middle row keeps the slot.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.doneMiddle = cursor(env.dash, { demotedId: "v3" });
	env.dash.dispose();
}

// A8 (done branch): a rejected mark-completed leaves the cursor alone.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	env.service.markCompleted = (() => Promise.resolve({ ok: false, error: "boom" })) as typeof env.service.markCompleted;
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).flash !== null);
	report.doneFailed = cursor(env.dash, { notice: priv(env.dash).flash?.text ?? null });
	env.dash.dispose();
}

// A7: batch done selects the block's neighbour, never a completed id.
{
	const env = await makeEnv(5);
	select(env.dash, "v2");
	env.dash.handleInput("m");
	env.dash.handleInput(" ");
	env.dash.handleInput("j");
	env.dash.handleInput(" ");
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.batchMiddle = cursor(env.dash, { doneIds: ["v2", "v3"] });
	env.dash.dispose();
}

// A7 (block at the end): nothing follows the block, so the previous row wins.
{
	const env = await makeEnv(5);
	select(env.dash, "v4");
	env.dash.handleInput("m");
	env.dash.handleInput(" ");
	env.dash.handleInput("j");
	env.dash.handleInput(" ");
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).selectedId === "v3");
	report.batchEnd = cursor(env.dash, { doneIds: ["v4", "v5"] });
	env.dash.dispose();
}

// A7 (selection order differs from board order): the anchor follows the board,
// not the Set insertion order. Selecting v5 then v2 leaves doneIds as
// ["v5", "v2"]; anchoring on doneIds[0] would land on v4, board order lands on
// v3.
{
	const env = await makeEnv(5);
	select(env.dash, "v5");
	env.dash.handleInput("m");
	env.dash.handleInput(" ");
	env.dash.handleInput("k");
	env.dash.handleInput("k");
	env.dash.handleInput("k");
	env.dash.handleInput(" ");
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).selectedId === "v3");
	report.batchBoardOrder = cursor(env.dash, { doneIds: ["v5", "v2"] });
	env.dash.dispose();
}

// A13: a batch that completed nothing must not move the cursor.
{
	const env = await makeEnv(5);
	select(env.dash, "v2");
	env.dash.handleInput("m");
	env.dash.handleInput(" ");
	env.dash.handleInput("j");
	env.dash.handleInput(" ");
	// Completed 0 but completedIds non-empty: impossible real output, exactly
	// what a completed/completedIds field swap looks like.
	env.service.markCompletedMany = (() => Promise.resolve({ ok: true, completed: 0, skipped: 2, completedIds: ["v2", "v3"] })) as typeof env.service.markCompletedMany;
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).flash !== null);
	report.batchAllSkipped = cursor(env.dash);
	env.dash.dispose();
}

console.log(JSON.stringify(report));
