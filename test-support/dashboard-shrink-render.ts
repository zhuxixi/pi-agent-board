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

	// Spy tui that models pi-tui doRender's fatal interaction with in-pass
	// force-clears (issue #88 CR r1): a requestRender(true) issued SYNCHRONOUSLY
	// from inside the component render is swallowed — the mid-frame state reset
	// makes the current frame take the first-render no-clear branch and the
	// deferred re-render diffs identical content, so nothing is ever cleared.
	// Only force-clears issued outside the render pass (e.g. deferred via
	// process.nextTick) actually clear. The harness asserts on REAL clears.
	const requestRenderCalls: Array<Array<boolean | undefined>> = [];
	const swallowedInPassForceCalls: Array<Array<boolean | undefined>> = [];
	const clearedFrameLabels: string[] = [];
	let renderPassActive = false;
	let currentFrameLabel = "";
	const writes: string[] = [];
	const tui = {
		terminal: { rows: 40, cols: 160, columns: 160, write: (d: string) => writes.push(d) },
		requestRender: (...args: Array<boolean | undefined>) => {
			if (args[0] === true && renderPassActive) {
				swallowedInPassForceCalls.push(args);
				return;
			}
			requestRenderCalls.push(args);
			if (args[0] === true) clearedFrameLabels.push(currentFrameLabel);
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

	// Render one frame the way pi-tui does (component render runs inside the
	// doRender pass), then flush nextTick so any deferred force-clear lands.
	const renderFrame = async (label: string) => {
		currentFrameLabel = label;
		renderPassActive = true;
		dashboard.render(160);
		renderPassActive = false;
		await new Promise((resolve) => process.nextTick(resolve));
	};

	// Frame 1: mount frame — must force a full clear (dirty bottoms / crash
	// output would otherwise persist: pi-tui's first render "assumes clean
	// screen" and overlays never get clearOnShrink).
	const mark1 = requestRenderCalls.length;
	await renderFrame("frame1");
	const frame1 = requestRenderCalls.slice(mark1);

	// Frame 2: same data — differential repaint, no forced clear.
	const mark2 = requestRenderCalls.length;
	await renderFrame("frame2");
	const frame2 = requestRenderCalls.slice(mark2);

	// Shrink: archive one view, refresh the component cache, re-render.
	service.archive("v3");
	dashboard.refresh();
	const mark3 = requestRenderCalls.length;
	await renderFrame("frame3");
	const frame3 = requestRenderCalls.slice(mark3);

	console.log(JSON.stringify({
		ok: true,
		frame1Forced: forced(frame1),
		frame2Forced: forced(frame2),
		frame3Forced: forced(frame3),
		frame1Cleared: clearedFrameLabels.includes("frame1"),
		frame2Cleared: clearedFrameLabels.includes("frame2"),
		frame3Cleared: clearedFrameLabels.includes("frame3"),
		swallowedCount: swallowedInPassForceCalls.length,
		frame1Args: frame1,
		frame2Args: frame2,
		frame3Args: frame3,
	}));
} finally {
	rmSync(root, { recursive: true, force: true });
}
