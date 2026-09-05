// Prewarm/attach prelude smoke: construct a dashboard with a FAKE service,
// drive prewarmSelected()/requestAttach() white-box, report counts as JSON.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { DashboardComponent } from "../src/ui/dashboard.ts";

const now = Date.now();

function fakeRow(id, { hostActive = false, alive = false, semanticState = null } = {}) {
	return {
		meta: { id, name: id, cwd: "/r", updatedAt: now },
		state: semanticState
			? { viewId: id, semanticState, processState: alive ? "alive" : "exited", pendingQuestions: [], updatedAt: now }
			: null,
		alive,
		hostAlive: false,
		hostActive,
		hostReady: false,
		host: null,
	};
}

const results = {};
const tui = { terminal: { rows: 24, cols: 80, columns: 80, write: () => {} }, requestRender: () => {} };
const theme = { fg: (_c, t) => t, bold: (t) => t };

function makeDashboard(rows, { prewarmResult = { ok: true }, doneCapture } = {}) {
	const service = {
		rows: () => rows,
		row: (id) => rows.find((r) => r.meta.id === id) ?? null,
		prewarmHost: undefined,
		reply: async () => ({ ok: true, sent: true }),
	};
	let prewarmCalls = 0;
	if (prewarmResult !== null) {
		service.prewarmHost = () => {
			prewarmCalls += 1;
			return prewarmResult;
		};
	}
	const dash = new DashboardComponent(tui, theme, {}, (r) => doneCapture?.push(r), {
		service: service as never,
		root: "/r",
		defaultCwd: "/r",
		availableModels: [],
		currentModel: null,
		currentThinkingLevel: "off",
	});
	return { dash, getPrewarmCalls: () => prewarmCalls };
}

// S1: starting host claim — prewarm is a no-op service-wise but marks prewarmedId.
{
	const { dash, getPrewarmCalls } = makeDashboard([fakeRow("starting1", { hostActive: true })]);
	dash.selectedId = "starting1";
	dash.mode = "list";
	dash.prewarmSelected();
	dash.prewarmSelected();
	results.startingHostPrewarmCalls = getPrewarmCalls();
	results.startingHostMarked = dash.prewarmedId === "starting1";
}

// S2: idle row — one ok prewarm marks; re-entry is idempotent; ok:false never marks.
{
	const { dash, getPrewarmCalls } = makeDashboard([fakeRow("idle1")], { prewarmResult: { ok: true } });
	dash.selectedId = "idle1";
	dash.mode = "list";
	dash.prewarmSelected();
	dash.prewarmSelected();
	results.idlePrewarmCalls = getPrewarmCalls();
	results.idleMarked = dash.prewarmedId === "idle1";
}
{
	const { dash, getPrewarmCalls } = makeDashboard([fakeRow("idle2")], { prewarmResult: { ok: false, error: "PTY unavailable" } });
	dash.selectedId = "idle2";
	dash.mode = "list";
	dash.prewarmSelected();
	results.idleFailPrewarmCalls = getPrewarmCalls();
	results.idleFailMarked = dash.prewarmedId === "idle2";
}

// S3: hostActive busy row attaches directly — no confirm prompt, stopFirst:false.
{
	const done = [];
	const { dash } = makeDashboard(
		[fakeRow("hosted1", { hostActive: true, alive: true, semanticState: "working" })],
		{ doneCapture: done },
	);
	dash.selectedId = "hosted1";
	dash.mode = "list";
	dash.requestAttach(dash.selectedRow());
	results.hostActiveAttachDirect = done.length === 1 && done[0].stopFirst === false;
	results.hostActiveAttachModeConfirm = dash.mode === "confirm";
}

// S4: busy non-host row goes through the stopFirst confirm; done not called yet.
{
	const done = [];
	const { dash } = makeDashboard(
		[fakeRow("busy1", { alive: true, semanticState: "working" })],
		{ doneCapture: done },
	);
	dash.selectedId = "busy1";
	dash.mode = "list";
	dash.requestAttach(dash.selectedRow());
	results.busyAttachDoneCalled = done.length > 0;
	results.busyAttachModeConfirm = dash.mode === "confirm";
}

process.stdout.write(JSON.stringify({ ok: true, ...results }));
