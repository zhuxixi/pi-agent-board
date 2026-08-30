// Nav wrap probe: construct a dashboard with 3 views, drive arrow keys through
// the public handleInput(), and report the selection sequence as JSON.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-nav-wrap-"));
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

const writes = [];
const tui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: (d) => writes.push(d) },
	requestRender: () => {},
};
const theme = { fg: (_c, t) => t, bold: (t) => t };

const dash = new DashboardComponent(tui, theme, {}, () => {}, {
	service,
	root,
	defaultCwd: root,
	availableModels: [],
	currentModel: null,
	currentThinkingLevel: "off",
});

// TS-private is runtime-accessible; read white-box state for assertions.
const ids = dash.orderedIds;
const seq = [];
seq.push(dash.selectedId); // initial selection = ids[0]
dash.handleInput("\x1b[B"); // ↓ -> ids[1]
seq.push(dash.selectedId);
dash.handleInput("\x1b[B"); // ↓ -> ids[2]
seq.push(dash.selectedId);
dash.handleInput("\x1b[B"); // ↓ at last -> WRAP to ids[0]
seq.push(dash.selectedId);
dash.handleInput("\x1b[A"); // ↑ at first -> WRAP to ids[2]
seq.push(dash.selectedId);

dash.dispose();
console.log(JSON.stringify({ ids, seq }));
