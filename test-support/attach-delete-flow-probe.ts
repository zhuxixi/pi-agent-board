// A5/A6 probe (issue #147): drive the REAL dashboardAttachLoop with a stub
// ctx and a real temp-root service. ui.custom is scripted two-stage: the
// board stage runs the factory (constructing a real DashboardComponent whose
// deps we capture) and resolves the attach action; the PTY stage resolves the
// component result {action:"delete"} without a factory run. service.resolveAttachTarget
// is stubbed to {kind:"pty"} — the stub custom never connects a socket (spec §5
// exception). DEL_FLOW_MODE=archive-fail stubs service.archive for A6.
// Run via `node --experimental-transform-types`.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { dashboardAttachLoop } from "../src/commands/agent-board.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-del-flow-"));
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

// Session files must exist so "archive preserves the session file" is a real assertion.
for (const id of ["v1", "v2", "v3"]) {
	const meta = JSON.parse(readFileSync(join(root, "views", id, "meta.json"), "utf8"));
	if (meta.sessionFile && !existsSync(meta.sessionFile)) writeFileSync(meta.sessionFile, "");
}

const stub = service as unknown as { resolveAttachTarget: (id: string) => Promise<unknown>; archive: (id: string) => Promise<{ ok: boolean; error?: string }> };
stub.resolveAttachTarget = async () => ({ kind: "pty", socketPath: join(root, "fake.sock") });
const archiveCalls: string[] = [];
const realArchive = service.archive.bind(service);
if (process.env.DEL_FLOW_MODE === "archive-fail") {
	stub.archive = async (id: string) => { archiveCalls.push(id); return { ok: false, error: "boom" }; };
} else {
	stub.archive = async (id: string) => { archiveCalls.push(id); return realArchive(id); };
}

const notifications: Array<{ text: string; level: string }> = [];
const boardDeps: Array<{ initialSelectedId: string | null; initialNotice?: string }> = [];
let stage = 0;
const fakeTui = { terminal: { rows: 24, cols: 80, columns: 80, write() {} }, requestRender() {} };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };

const ctx = {
	cwd: root,
	model: null,
	modelRegistry: { getAvailable: () => [] },
	sessionManager: { getSessionFile: () => null },
	ui: {
		setWorkingVisible() {},
		setHeader() {},
		setFooter() {},
		setTitle() {},
		notify: (text: string, level: string) => notifications.push({ text, level }),
		custom: (factory: (t: unknown, th: unknown, kb: unknown, done: (r: unknown) => void) => unknown) =>
			new Promise((resolve) => {
				stage += 1;
				if (stage === 2) {
					resolve({ action: "delete" });
					return;
				}
				const comp = factory(fakeTui, theme, {}, (result: unknown) => resolve(result)) as unknown as {
					deps: { initialSelectedId: string | null; initialNotice?: string };
					done: (r: unknown) => void;
					dispose?: () => void;
				};
				boardDeps.push({ initialSelectedId: comp.deps.initialSelectedId, initialNotice: comp.deps.initialNotice });
				comp.done(stage === 1 ? { action: "attach", viewId: "v2", stopFirst: false } : { action: "exit" });
				comp.dispose?.();
			}),
	},
};

await dashboardAttachLoop(ctx as never, service, root, null);

const v2Meta = JSON.parse(readFileSync(join(root, "views", "v2", "meta.json"), "utf8"));
const sessionExists = existsSync(String(v2Meta.sessionFile));
const rowsAfter = (await import("../src/core/store.mjs")).listRows(root).map((r) => r.meta.id);
const report = {
	error: null as string | null,
	archived: v2Meta.archived === true,
	sessionExists,
	rowsAfter,
	archiveCalls,
	notifications,
	boardDeps,
	stage,
};
try {
	console.log(JSON.stringify(report));
} finally {
	rmSync(root, { recursive: true, force: true });
}
