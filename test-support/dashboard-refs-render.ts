// Dashboard refs render harness: build a temp store whose row has a github.json
// codeRefs artifact, render the dashboard list + peek frames, and emit JSON
// flags the .mjs test asserts on. Run via `node --experimental-transform-types`
// (the DashboardComponent class uses TS parameter properties).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCodeRefs } from "../src/core/code-refs-store.mjs";
import { createView } from "../src/core/store.mjs";
import { createService } from "../src/runtime/service.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-refs-render-"));
try {
	createView(root, { id: "v1", name: "refs row", cwd: root });
	createView(root, { id: "v2", name: "plain row", cwd: root });
	const issue = {
		kind: "issue",
		number: 40,
		strength: "claim",
		confidence: "high",
		source: "command",
		url: "https://github.com/o/r/issues/40",
		lastIndex: 0,
	};
	const pr = {
		kind: "pr",
		number: 45,
		strength: "claim",
		confidence: "high",
		source: "command",
		url: "https://github.com/o/r/pull/45",
		lastIndex: 1,
	};
	const mention = {
		kind: "issue",
		number: 7,
		strength: "mention",
		confidence: "low",
		source: "mention",
		url: null,
		lastIndex: 2,
	};
	writeCodeRefs(root, {
		version: 1,
		viewId: "v1",
		updatedAt: 0,
		provider: "github",
		issuePrefix: "#",
		prPrefix: "▸#",
		issue,
		pr,
		allRefs: [issue, pr, mention],
	});

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

	const writes: string[] = [];
	const tui = {
		terminal: { rows: 40, cols: 160, columns: 160, write: (d: string) => writes.push(d) },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const keybindings = {};
	const dashboard = new DashboardComponent(
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

	const listLines = dashboard.render(160);
	const refsRowLine = listLines.find((line) => line.includes("refs row")) ?? "";
	const plainRowLine = listLines.find((line) => line.includes("plain row")) ?? "";

	// Peek the codeRefs row: space opens peek, esc returns to list, down moves
	// the selection to the second (plain) row.
	dashboard.handleInput(" ");
	const peekLines = dashboard.render(160);
	dashboard.handleInput("\x1b");
	dashboard.handleInput("\x1b[B");
	dashboard.handleInput(" ");
	const plainPeekLines = dashboard.render(160);

	const result = {
		ok: true,
		rowHasBadge: refsRowLine.includes("#40 ▸#45"),
		plainRowHasNoBadge: !/#\d|▸#\d/.test(plainRowLine),
		peekHasRefs: peekLines.some((line) => line.includes("Refs")),
		peekHasProvider: peekLines.some((line) => line.trim() === "github"),
		peekHasRefLine: peekLines.some((line) => line.includes("issue #40")),
		peekHasPrLine: peekLines.some((line) => line.includes("pr ▸#45")),
		peekHasMentionLine: peekLines.some((line) => line.includes("issue #7 · low")),
		plainPeekHasNoRefs: !plainPeekLines.some((line) => line.includes("Refs")),
	};
	console.log(JSON.stringify(result));
} finally {
	rmSync(root, { recursive: true, force: true });
}
