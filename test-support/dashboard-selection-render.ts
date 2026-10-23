// Dashboard selected-row harness: renders real DashboardComponent frames with a
// recording/ANSI-emitting theme stub and prints JSON flags the .mjs test asserts
// on. Unit checks for the pure helper live here too so one process proves both.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createView } from "../src/core/store.mjs";
import { createService } from "../src/runtime/service.mjs";
import { applyRowHighlight, DashboardComponent } from "../src/ui/dashboard.ts";

const BG_OPEN = "\x1b[48;2;1;2;3m";
const BG_CLOSE = "\x1b[49m";

const root = mkdtempSync(join(tmpdir(), "agentview-selection-render-"));
try {
	let bgCalls = 0;
	const fgCalls: Array<[string, string]> = [];
	const theme = {
		fg: (token: string, text: string) => {
			fgCalls.push([token, text]);
			return text;
		},
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		bg: (_color: string, text: string) => {
			bgCalls += 1;
			return `${BG_OPEN}${text}${BG_CLOSE}`;
		},
	};

	// --- unit: the pure helper -------------------------------------------
	const identity = "plain line";
	const untouched = applyRowHighlight(theme, false, identity);
	const callsAfterUnselected = bgCalls;
	const wrapped = applyRowHighlight(theme, true, identity);
	const bgCallsBeforeIntegration = bgCalls;

	// --- integration: real render frames ---------------------------------
	mkdirSync(join(root, "proj-a"), { recursive: true });
	mkdirSync(join(root, "proj-b"), { recursive: true });
	createView(root, { id: "v1", name: "alpha session", cwd: join(root, "proj-a") });
	createView(root, { id: "v2", name: "beta session", cwd: join(root, "proj-b") });
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
		terminal: { rows: 40, cols: 160, columns: 160, write: () => {} },
		requestRender: () => {},
	};
	const makeDash = () =>
		new DashboardComponent(tui as never, theme as never, {} as never, () => {}, {
			service,
			root,
			defaultCwd: root,
			availableModels: [],
			currentModel: null,
			currentThinkingLevel: "off",
		});

	// Two cwds ⇒ showFolders=true ⇒ rows carry indent 4.
	bgCalls = 0;
	const dash = makeDash();
	const lines = dash.render(160);
	const selectedLine = lines.find((line) => line.includes("alpha session")) ?? "";
	const otherLine = lines.find((line) => line.includes("beta session")) ?? "";

	const selectedStartsAtCol0 = selectedLine.startsWith(BG_OPEN);
	const selectedWidth = visibleWidth(selectedLine);
	const unselectedHasNoOpener = !otherLine.includes(BG_OPEN);
	const selectedHasArrow = selectedLine.includes("›");
	const unselectedHasNoArrow = !otherLine.includes("›");
	const firstFrameBgCalls = bgCalls;

	// select mode: press `m`, then space to batch-mark the current row.
	dash.handleInput("m");
	dash.handleInput(" ");
	const selectLines = dash.render(160);
	const selectMarkerPresent = selectLines.some((line) => line.includes("◉"));
	const selectHasBg = selectLines.find((line) => line.includes("alpha session"))?.includes(BG_OPEN) ?? false;
	dash.handleInput("\x1b");

	// peek: space in list mode opens the peek header (must stay unhighlighted).
	const peekDash = makeDash();
	peekDash.handleInput(" ");
	const peekHasNoOpener = !peekDash.render(160).some((line) => line.includes(BG_OPEN));

	// ultra-narrow: width 23 with indent 4 overflows (4 + max(20, 19) = 24 > 23),
	// so `clip` really truncates. The intent is width safety plus "the opener is
	// only on the selected row": identify the selected row by its `›` cursor
	// marker rather than relying on the session name to survive clipping.
	const narrowLines = dash.render(23);
	const narrowMaxWidth = Math.max(...narrowLines.map((line) => visibleWidth(line)));
	const narrowBgLines = narrowLines.filter((line) => line.includes(BG_OPEN));
	const narrowLeaked = narrowBgLines.length !== 1 || !narrowBgLines[0].includes("›");

	// D4: unselected rows keep `muted`, never `dim`, for name/summary.
	const unselectedUsesMuted = fgCalls.some(([token, text]) => token === "muted" && text.includes("beta session"));
	const unselectedNameIsDim = fgCalls.some(([token, text]) => token === "dim" && text.includes("beta session"));

	console.log(
		JSON.stringify({
			ok: true,
			unit: {
				unselectedIdentical: untouched === identity && callsAfterUnselected === 0,
				selectedWrapped: wrapped === `${BG_OPEN}${identity}${BG_CLOSE}`,
				themeCallCount: bgCallsBeforeIntegration,
			},
			integration: {
				selectedStartsAtCol0,
				selectedWidth,
				unselectedHasNoOpener,
				selectedHasArrow,
				unselectedHasNoArrow,
				firstFrameBgCalls,
				selectMarkerPresent,
				selectHasBg,
				peekHasNoOpener,
				narrowMaxWidth,
				narrowLeaked,
				unselectedUsesMuted,
				unselectedNameIsDim,
			},
		}),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
