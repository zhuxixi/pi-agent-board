// cwd browse-Tab probe (issue #127): drive Tab through the public handleInput()
// in browse and favorites picker modes and report picker state as JSON.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";
import { nextCwdPickerState } from "../src/core/launch-options.mjs";

const root = mkdtempSync(join(tmpdir(), "agentview-cwd-tab-"));
const work = join(root, "work");
mkdirSync(join(work, "app"), { recursive: true });
mkdirSync(join(work, "notes"), { recursive: true });

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

const tui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
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

// TS-private is runtime-accessible; white-box the launch dialog open
// (input must be non-empty or openLaunchDialog bails back to list mode).
dash.input = "go";
dash.openLaunchDialog();
dash.openLaunchPicker("cwd", join(root, "wo"));

const out = { root, work };
out.mode0 = dash.launch.cwdPickerMode;
out.sugg0 = dash.launch.cwdSuggestions;

// Browse Tab 1: completes the highlighted candidate with a trailing separator.
dash.handleInput("\t");
out.afterTab1 = {
	query: dash.launch.cwdQuery,
	mode: dash.launch.cwdPickerMode,
	suggestions: dash.launch.cwdSuggestions,
	index: dash.launch.cwdSuggestionIndex,
};

// Browse Tab 2: highlight sits on the just-completed dir (no progress) -> drill into first child.
dash.handleInput("\t");
out.afterTab2 = { query: dash.launch.cwdQuery, mode: dash.launch.cwdPickerMode };

// Browse Tab 3: leaf dir has a lone self suggestion -> stable no-op.
dash.handleInput("\t");
out.afterTab3 = dash.launch.cwdQuery;

// Browse hint advertises tab completion (render while still in browse mode).
out.browseHint = dash.render(80).join("\n").includes("type to filter folders · tab complete");

// Favorites regression: ranked hit keeps the old complete-into-input semantics (no trailing separator).
const launch = dash.launch;
launch.cwdRanked = [{ path: work, count: 3 }];
launch.cwdQuery = "wo";
const st = nextCwdPickerState("wo", launch.cwdRanked, launch.cwd);
launch.cwdPickerMode = st.mode;
launch.cwdSuggestions = st.suggestions;
launch.cwdSuggestionIndex = 0;
dash.handleInput("\t");
out.fav = { query: dash.launch.cwdQuery, mode: dash.launch.cwdPickerMode };

dash.dispose();
console.log(JSON.stringify(out));
