// cwd favorites-pool probe (issue #262): seed more favorites than the legacy
// 8-entry cap, then type a fragment of the lowest-ranked entry through the
// public handleInput() path and report the picker state as JSON.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-cwd-pool-"));
const entries: Record<string, { count: number; lastUsed: number }> = {};
for (let i = 1; i <= 9; i++) {
	const dir = join(root, `rank-${String(i).padStart(2, "0")}`);
	mkdirSync(dir, { recursive: true });
	entries[dir] = { count: 100 - i, lastUsed: 1000 - i };
}
const target = join(root, "work", "proj", "stability", "alert-automation");
mkdirSync(target, { recursive: true });
entries[target] = { count: 1, lastUsed: 1 };
writeFileSync(join(root, "cwd-stats.json"), JSON.stringify({ version: 1, entries }));

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
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };

const dash = new DashboardComponent(tui, theme, {}, () => {}, {
	service,
	root,
	defaultCwd: root,
	availableModels: [],
	currentModel: null,
	currentThinkingLevel: "off",
});

// TS-private is runtime-accessible; input must be non-empty or
// openLaunchDialog() bails back to list mode and launch stays null.
dash.input = "go";
dash.openLaunchDialog();
dash.openLaunchPicker("cwd", "");
for (const ch of "aler") dash.handleInput(ch);

const out = { target, mode: dash.launch?.cwdPickerMode, suggestions: dash.launch?.cwdSuggestions };
dash.dispose();
console.log(JSON.stringify(out));
