// Dashboard shrink-render harness (issue #88): verify the self-heal frames —
// the mount frame forces a full clear, an unchanged frame does not, and a
// content-shrink frame (a view archived between renders) forces one again.
// Emits JSON flags the .mjs test asserts on. Run via
// `node --experimental-transform-types` (the DashboardComponent class uses TS
// parameter properties); mirrors test-support/dashboard-refs-render.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createView } from "../src/core/store.mjs";
import { createService } from "../src/runtime/service.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-shrink-render-"));
try {
	createView(root, { id: "v1", name: "alpha row", cwd: root });
	createView(root, { id: "v2", name: "beta row", cwd: root });
	createView(root, { id: "v3", name: "gamma row", cwd: root });

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

	// Spy tui: record requestRender arg lists so the test can tell forced
	// (requestRender(true)) from differential (requestRender()) calls.
	const requestRenderCalls: Array<Array<boolean | undefined>> = [];
	const writes: string[] = [];
	const tui = {
		terminal: { rows: 40, cols: 160, columns: 160, write: (d: string) => writes.push(d) },
		requestRender: (...args: Array<boolean | undefined>) => {
			requestRenderCalls.push(args);
		},
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

	const forced = (calls: Array<Array<boolean | undefined>>) => calls.some((c) => c[0] === true);

	// Frame 1: mount frame — must force a full clear (dirty bottoms / crash
	// output would otherwise persist: pi-tui's first render "assumes clean
	// screen" and overlays never get clearOnShrink).
	const mark1 = requestRenderCalls.length;
	dashboard.render(160);
	const frame1 = requestRenderCalls.slice(mark1);

	// Frame 2: same data — differential repaint, no forced clear.
	const mark2 = requestRenderCalls.length;
	dashboard.render(160);
	const frame2 = requestRenderCalls.slice(mark2);

	// Shrink: archive one view, refresh the component cache, re-render.
	service.archive("v3");
	dashboard.refresh();
	const mark3 = requestRenderCalls.length;
	dashboard.render(160);
	const frame3 = requestRenderCalls.slice(mark3);

	console.log(JSON.stringify({
		ok: true,
		frame1Forced: forced(frame1),
		frame2Forced: forced(frame2),
		frame3Forced: forced(frame3),
		frame1Args: frame1,
		frame2Args: frame2,
		frame3Args: frame3,
	}));
} finally {
	rmSync(root, { recursive: true, force: true });
}
