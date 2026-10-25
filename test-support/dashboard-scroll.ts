// Exercise the real dashboard viewport and keyboard navigation on crowded screens.
// Run with --experimental-transform-types for DashboardComponent parameter properties.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createView } from "../src/core/store.mjs";
import { createService } from "../src/runtime/service.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-scroll-"));
let dashboard;
try {
	for (let i = 0; i < 30; i++) {
		createView(root, { id: `v${i}`, name: `session-${i}`, cwd: root });
	}
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
		terminal: { rows: 24, cols: 120, columns: 120, write: () => {} },
		requestRender: () => {},
	};
	const theme = { fg: (_c, text) => text, bold: (text) => text, bg: (_c, text) => text };
	dashboard = new DashboardComponent(tui, theme, {}, () => {}, {
		service, root, defaultCwd: root, availableModels: [],
		currentModel: null, currentThinkingLevel: "off",
	});

	// Reproduce moving up onto the first sliced line with a hidden line above.
	dashboard.scrollTop = 1;
	const selected = "  › running session";
	const body = ["RUNNING", selected, ...Array.from({ length: 10 }, (_, i) => `row ${i}`)];
	assert.ok(dashboard.windowBody(body, 5).lines.includes(selected), "up marker must not overwrite selection");

	// Every selection must survive both clipping boundaries, even on a resize
	// leaving only one or two body lines. Counts include the replaced lines.
	for (let capacity = 1; capacity <= 14; capacity++) {
		for (let start = 0; start < 12; start++) {
			for (let sel = 0; sel < 12; sel++) {
				dashboard.scrollTop = start;
				const body = Array.from({ length: 12 }, (_, i) => i === sel ? selected : `row ${i}`);
				const { lines } = dashboard.windowBody(body, capacity);
				assert.ok(lines.includes(selected), `selection ${sel}, start ${start}, capacity ${capacity}`);
				assert.ok(lines.length <= capacity);
				if (lines[0].includes("↑")) {
					assert.equal(lines[0], `  ↑ ${dashboard.scrollTop + 1} more`);
				}
				if (lines.at(-1).includes("↓")) {
					assert.equal(lines.at(-1), `  ↓ ${body.length - dashboard.scrollTop - capacity + 1} more`);
				}
			}
		}
	}

	// Drive public input and render after every step, including wraparound and
	// changing terminal height while the viewport is scrolled down.
	for (const height of [24, 16, 12, 24]) {
		tui.terminal.rows = height;
		for (const key of ["\x1b[B", "\x1b[A"]) {
			for (let step = 0; step <= dashboard.orderedIds.length; step++) {
				const row = service.rows().find((row) => row.meta.id === dashboard.selectedId);
				const lines = dashboard.render(120);
				assert.equal(lines.length, height);
				assert.ok(lines.some((line) => line.includes("›") && line.includes(row.meta.name)),
					`selected ${row.meta.name} must be visible at height ${height}`);
				dashboard.handleInput(key);
			}
		}
	}
	// With no Running section, the first waiting section may span several
	// folders. Its stage and folder headers must be reachable too, not merely
	// its first selectable session row.
	dashboard.dispose();
	const fixtureRows = service.rows();
	for (const firstState of ["needs_input", "idle", "holding", "completed"]) {
		const rows = fixtureRows.map((row, i) => ({
			...row,
			meta: { ...row.meta, cwd: join(root, `folder-${i % 5}`), repoCwd: join(root, `folder-${i % 5}`) },
			state: { ...row.state, semanticState: i < 20 ? firstState : "completed" },
		}));
		const groupedService = {
			...service,
			rows: () => rows,
			row: (id) => rows.find((row) => row.meta.id === id),
			prewarmHost: () => ({ ok: false }),
		};
		for (const width of [120, 60]) {
			for (const height of [24, 16]) {
				tui.terminal.rows = height;
				dashboard = new DashboardComponent(tui, theme, {}, () => {}, {
					service: groupedService, root, defaultCwd: root, availableModels: [],
					currentModel: null, currentThinkingLevel: "off",
				});
				// Start at the bottom, then walk up to the first session.
				dashboard.handleInput("\x1b[A");
				dashboard.render(width);
				assert.ok(dashboard.scrollTop > 0, "fixture must overflow the screen");
				for (let step = 1; step < dashboard.orderedIds.length; step++) {
					dashboard.handleInput("\x1b[A");
					dashboard.render(width);
				}
				assert.equal(dashboard.selectedId, dashboard.orderedIds[0]);
				const frame = dashboard.render(width);
				assert.equal(dashboard.scrollTop, 0, `${firstState}: first session must reveal the true top at ${width}x${height}`);
				const body = dashboard.renderRows(width);
				assert.ok(frame.includes(body[0]), "first section header must be visible");
				assert.ok(frame.includes(body[1]), "first folder header must be visible");
				assert.ok(!frame.some((line) => /↑ \d+ more/.test(line)), "no hidden lines above the first section");
				// Wrapping from the last session to the first must reveal headers too.
				dashboard.handleInput("\x1b[A");
				dashboard.render(width);
				dashboard.handleInput("\x1b[B");
				dashboard.render(width);
				assert.equal(dashboard.scrollTop, 0, "downward wrap must reveal the true top");
				dashboard.dispose();
			}
		}
	}
	console.log(JSON.stringify({ ok: true }));
} finally {
	dashboard?.dispose();
	rmSync(root, { recursive: true, force: true });
}
