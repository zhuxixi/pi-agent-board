// Vim-keys probe: drive j/k/l through the public handleInput() across modes
// and report observations as JSON (issue #229, spec A1-A9 + review-focus pins).
// Run via `node --experimental-transform-types`. Not typechecked.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-vim-keys-"));
createView(root, { id: "v1", name: "one", cwd: root });
createView(root, { id: "v2", name: "two", cwd: root });
createView(root, { id: "v3", name: "three", cwd: root });

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

const tui = { terminal: { rows: 24, cols: 80, columns: 80, write: () => {} }, requestRender: () => {} };
const theme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };
const doneCalls = [];
const keybindings = { matches: () => false };
const dash = new DashboardComponent(tui, theme, keybindings, (r) => doneCalls.push(r), {
	service, root, defaultCwd: root,
	availableModels: [], currentModel: null, currentThinkingLevel: "off",
});

// TS-private is runtime-accessible; read white-box state for assertions.
const ids = dash.orderedIds;
const out = { ids, list: [], select: [], peek: [], attach: [], negative: [], scroll: [], text: {}, notices: [], busyL: null };

// A1: list j/k == arrow keys (wrap at both ends); j must not pop the INSERT toast.
dash.handleInput("j"); out.list.push(dash.selectedId);
out.notices.push(dash.inputNotice === null);
dash.handleInput("j"); out.list.push(dash.selectedId);
dash.handleInput("j"); out.list.push(dash.selectedId); // wrap last -> first
dash.handleInput("k"); out.list.push(dash.selectedId); // wrap first -> last
// RF1: uppercase J stays on the printable fallback (current behavior pinned).
dash.handleInput("J"); out.notices.push(dash.inputNotice !== null);
// RF5: bracketed paste containing j/k/l must not move the selection.
dash.handleInput("\x1b[200~jkl\x1b[201~"); out.list.push(dash.selectedId);

// A2: select mode j/k move the selection (wrap).
dash.mode = "select"; dash.selectedId = ids[0];
dash.handleInput("j"); out.select.push(dash.selectedId);
dash.handleInput("k"); out.select.push(dash.selectedId);
dash.handleInput("k"); out.select.push(dash.selectedId); // wrap first -> last

// A9 negative: select "l" must not attach / leave the mode.
const doneBeforeSelect = doneCalls.length;
dash.handleInput("l");
out.negative.push(["select-l", dash.mode, doneCalls.length - doneBeforeSelect]);
dash.mode = "list";

// A3: peek j/k == peekStep (wrap).
dash.mode = "peek"; dash.peekId = ids[0]; dash.selectedId = ids[0];
dash.handleInput("j"); out.peek.push(dash.peekId);
dash.handleInput("k"); out.peek.push(dash.peekId);
dash.handleInput("k"); out.peek.push(dash.peekId); // wrap first -> last

// A4: l attaches in list / peek / evidence (non-busy rows -> direct done).
dash.mode = "list"; dash.selectedId = ids[0];
dash.handleInput("l"); out.attach.push(doneCalls.at(-1));
dash.mode = "peek"; dash.peekId = ids[1]; dash.selectedId = ids[1];
dash.handleInput("l"); out.attach.push(doneCalls.at(-1));
dash.mode = "evidence"; dash.selectedId = ids[2];
dash.handleInput("l"); out.attach.push(doneCalls.at(-1));

// A9 negative: session "l" must not attach / leave the mode.
dash.mode = "session"; dash.selectedId = ids[0];
const doneBeforeSession = doneCalls.length;
dash.handleInput("l");
out.negative.push(["session-l", dash.mode, doneCalls.length - doneBeforeSession]);

// A6: session / evidence j/k still scroll (regression guard).
dash.mode = "session";
dash.handleInput("j"); out.scroll.push(dash.sessionScrollTop);
dash.handleInput("k"); out.scroll.push(dash.sessionScrollTop);
dash.mode = "evidence";
dash.handleInput("j"); out.scroll.push(dash.evidenceScrollTop);
dash.handleInput("k"); out.scroll.push(dash.evidenceScrollTop);

// A5: text modes keep j/k/l literal.
for (const m of ["dispatch", "filter", "rename", "reply"]) {
	// setInput() mirrors real mode entry: it also resets the editor buffer.
	dash.mode = m; dash.setInput("");
	dash.handleInput("j"); dash.handleInput("k"); dash.handleInput("l");
	out.text[m] = dash.input;
}
dash.mode = "list"; dash.input = "";

// RF2: busy row + l -> confirm branch (same as →), not a direct attach.
const busyService = {
	rows: () => [{
		meta: { id: "b1", name: "busy", cwd: "/", sessionFile: "/s/b1.jsonl" },
		state: { semanticState: "working", processState: "alive", pendingQuestions: [] },
		alive: true, hostAlive: false, hostActive: false, hostReady: false, host: null,
	}],
	reconcile: async () => 0,
};
const done2 = [];
const dash2 = new DashboardComponent(tui, theme, keybindings, (r) => done2.push(r), {
	service: busyService, root, defaultCwd: root,
	availableModels: [], currentModel: null, currentThinkingLevel: "off",
});
dash2.selectedId = "b1";
dash2.handleInput("l");
out.busyL = { mode: dash2.mode, done: done2.length, prompt: dash2.pending?.prompt ?? null };
dash2.dispose();

// A7: help overlay + hint lines copy.
// The help box is 32 lines; the probe terminal is 24 rows, so render() would
// clip the bottom rows. Bump the height for the help capture only.
tui.terminal.rows = 40;
dash.mode = "help"; dash.helpReturnMode = "list";
const help120 = dash.render(120).join("\n");
const help80 = dash.render(80); // must not throw; renderCenteredBox clips
tui.terminal.rows = 24;
dash.mode = "list";
const listRender = dash.render(120).join("\n");
dash.mode = "select";
const selectRender = dash.render(120).join("\n");
// A5's filter run leaves the list filtered to zero rows; clear it so the
// session/evidence view captures render a selected row (and its footer).
dash.filterQuery = "";
dash.refresh();
dash.mode = "session";
const sessionRender = dash.render(120).join("\n");
dash.mode = "evidence";
const evidenceRender = dash.render(120).join("\n");
dash.mode = "list";
out.copy = { help120, listRender, selectRender, sessionRender, evidenceRender, help80Lines: help80.length };

dash.dispose();
console.log(JSON.stringify(out));
