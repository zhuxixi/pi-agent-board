// Hold-key probe: construct a dashboard with a fake service, press "h" in
// list/peek/session modes, and report the submitted commands as JSON.
// Run via `node --experimental-transform-types`. Not typechecked.
import { DashboardComponent } from "../src/ui/dashboard.ts";

const stateById: Record<string, { semanticState: string; processState: string; pendingQuestions: unknown[] }> = {
	v1: { semanticState: "idle", processState: "exited", pendingQuestions: [] },
	v2: { semanticState: "holding", processState: "exited", pendingQuestions: [] },
	v3: { semanticState: "working", processState: "alive", pendingQuestions: [] },
};
const sent: Array<[string, string]> = [];
const row = (id: string, overrides: Record<string, unknown> = {}) => ({
	meta: { id, name: id, cwd: "/", sessionFile: `/s/${id}.jsonl` },
	state: stateById[id],
	alive: false, hostAlive: false, hostActive: false, hostReady: false, host: null,
	...overrides,
});
const service = {
	rows: () => [row("v1"), row("v2"), row("v3", { alive: true })],
	holdView: async (id: string) => { sent.push(["mark_holding", id]); stateById[id].semanticState = "holding"; return { ok: true }; },
	clearHoldView: async (id: string) => { sent.push(["clear_holding", id]); stateById[id].semanticState = "idle"; return { ok: true }; },
	reconcile: async () => 0,
};
const tui = { terminal: { rows: 24, cols: 80, columns: 80, write: () => {} }, requestRender: () => {} };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const dash = new DashboardComponent(tui as never, theme as never, {} as never, () => {}, {
	service: service as never, root: "/", defaultCwd: "/", availableModels: [], currentModel: null, currentThinkingLevel: "off",
});
dash.selectedId = "v1";
dash.handleInput("h");            // list mode, idle row -> mark_holding
dash.selectedId = "v2";
dash.handleInput("h");            // list mode, holding row -> clear_holding
dash.peekId = "v2"; dash.mode = "peek";
dash.handleInput("h");            // peek mode -> (v2 was reset to idle by the previous press) mark_holding
dash.mode = "session";
dash.handleInput("h");            // session mode -> clear_holding
dash.mode = "list";
dash.selectedId = "v3";
dash.handleInput("h");            // list mode, busy row -> busy pre-check blocks, sent must not grow
dash.dispose();
console.log(JSON.stringify(sent));
