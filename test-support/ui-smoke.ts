// UI smoke: load the two TS entrypoints with real dependencies (pi-tui,
// @xterm/headless, service), construct them with a fake TUI, render one frame
// each, and dispose. Run via `node --experimental-transform-types` because the
// classes use TS parameter properties.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-ui-smoke-"));
createView(root, { id: "v1", name: "hello world", cwd: root });

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
const keybindings = {};

let dashboard;
try {
	dashboard = new DashboardComponent(
		tui,
		theme,
		keybindings,
		() => {},
		{
			service,
			root,
			defaultCwd: root,
			availableModels: [],
			currentModel: null,
			currentThinkingLevel: "off",
		},
	);
} catch (err) {
	console.error("dashboard construct failed:", err);
	process.exit(1);
}
const dashLines = dashboard.render(80);
if (dashLines.length === 0) {
	console.error("dashboard render returned no lines");
	process.exit(1);
}
if (!dashLines.some((line) => line.includes("hello world"))) {
	console.error("dashboard render missing row title");
	process.exit(1);
}
if (typeof dashboard.dispose === "function") dashboard.dispose();
else if (typeof dashboard.invalidate === "function") dashboard.invalidate();

let attach;
try {
	attach = new PtyAttachComponent(
		tui,
		theme,
		keybindings,
		() => {},
		{ socketPath: "/no/such/socket", title: "smoke" },
	);
} catch (err) {
	console.error("pty-attach construct failed:", err);
	process.exit(1);
}
const attachLines = attach.render(80);
if (attachLines.length === 0) {
	console.error("pty-attach render returned no lines");
	process.exit(1);
}
attach.dispose();

console.log(JSON.stringify({ ok: true, dashLines: dashLines.length, attachLines: attachLines.length }));
