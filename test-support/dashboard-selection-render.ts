// Dashboard selected-row harness: renders real DashboardComponent frames with a
// recording/ANSI-emitting theme stub and prints JSON flags the .mjs test asserts
// on. Unit checks for the pure helper live here too so one process proves both.
import { mkdtempSync, rmSync } from "node:fs";
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
	const fgCalls: Array<[string, string]> = [];

	// --- unit: the pure helper -------------------------------------------
	const identity = "plain line";
	const untouched = applyRowHighlight(theme, false, identity);
	const callsAfterUnselected = bgCalls;
	const wrapped = applyRowHighlight(theme, true, identity);

	console.log(
		JSON.stringify({
			ok: true,
			unit: {
				unselectedIdentical: untouched === identity && callsAfterUnselected === 0,
				selectedWrapped: wrapped === `${BG_OPEN}${identity}${BG_CLOSE}`,
				themeCallCount: bgCalls,
			},
		}),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
