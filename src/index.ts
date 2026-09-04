/**
 * Pi Agent Board — extension entry point.
 *
 * Registers the `/agent-board` dashboard command, resolves how to
 * launch background workers and the detached runner, and keeps a small footer status with
 * the count of sessions needing attention. See docs/EXPLORATION.md for the design.
 */
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvePiInvocation } from "./core/invocation.mjs";
import { controlSocketPathFor, defaultRoot } from "./core/paths.mjs";
import { listRows } from "./core/store.mjs";
import { createService, envInt } from "./runtime/service.mjs";
import { attachWarmHostSweeper } from "./core/warm-host-sweeper.mjs";
import { openDashboard, registerAgentBoardCommand } from "./commands/agent-board.js";
import { registerBgCommand } from "./commands/bg.js";

const RUNNER_SCRIPT = fileURLToPath(new URL("../runner/job-runner.mjs", import.meta.url));
const PTY_RUNNER_SCRIPT = fileURLToPath(new URL("../runner/pty-runner.mjs", import.meta.url));
const TITLE_RUNNER_SCRIPT = fileURLToPath(new URL("../runner/title-runner.mjs", import.meta.url));
const AUTO_STATE_RUNNER_SCRIPT = fileURLToPath(new URL("../runner/state-runner.mjs", import.meta.url));

let hostedEditorReporter: { start(): void; stop(): void } | null = null;

export default function piAgentBoard(pi: ExtensionAPI): void {
	const root = defaultRoot();
	const { piCommand, piArgsPrefix } = resolvePiInvocation();

	const isHostedChild = process.env.AGENT_BOARD_CHILD === "1" || process.env.AGENT_VIEW_CHILD === "1";
	const hostedViewId = process.env.AGENT_BOARD_VIEW_ID ?? process.env.AGENT_VIEW_VIEW_ID;

	const commandOpts = {
		root,
		runnerScript: RUNNER_SCRIPT,
		titleRunnerScript: TITLE_RUNNER_SCRIPT,
		autoStateRunnerScript: AUTO_STATE_RUNNER_SCRIPT,
		ptyRunnerScript: PTY_RUNNER_SCRIPT,
		piCommand,
		piArgsPrefix,
		getThinkingLevel: () => pi.getThinkingLevel(),
	};

	// Warm-host reclaim (issue #75): idle PTY hosts must not leak forever after
	// detach. Sweep once now (reclaims hosts orphaned by a previous host pi that
	// exited without cleanup), then periodically; sweep again on shutdown.
	// Child pi processes skip entirely (they share the board root and would
	// terminate their own runner). serviceForContext is defined before the attach
	// call because the sweeper sweeps synchronously on attach and the sweep
	// closure references it (no TDZ).
	const serviceForContext = () =>
		createService({ root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, titleRunnerScript: TITLE_RUNNER_SCRIPT, autoStateRunnerScript: AUTO_STATE_RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: process.cwd() });
	attachWarmHostSweeper(pi, {
		isHostedChild,
		sweep: () => {
			try {
				serviceForContext().pruneWarmHosts();
			} catch {
				/* best-effort: never break the session over a sweep */
			}
		},
		intervalMs: envInt("AGENT_BOARD_SWEEP_INTERVAL_MS", 60_000, 0, 24 * 60 * 60 * 1000, "AGENT_VIEW_SWEEP_INTERVAL_MS"),
	});

	registerAgentBoardCommand(pi, commandOpts);
	registerBgCommand(pi, commandOpts);
	pi.registerFlag("agent-board", {
		description: "Open the agent-board dashboard on startup",
		type: "boolean",
		default: false,
	});

	// Footer status: reconcile stale rows and surface how many need attention.
	const serviceFor = (ctx: ExtensionContext) =>
		createService({ root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, titleRunnerScript: TITLE_RUNNER_SCRIPT, autoStateRunnerScript: AUTO_STATE_RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: ctx.cwd });

	const updateStatus = (ctx: ExtensionContext) => {
		try {
			serviceFor(ctx).reconcile();
			const rows = listRows(root);
			const needs = rows.filter((r) => r.state?.semanticState === "needs_input").length;
			const working = rows.filter((r) => r.alive).length;
			const queued = rows.reduce((sum, r) => sum + (r.state?.followUps?.queuedCount ?? 0), 0);
			if (isHostedChild) return;
			if (rows.length === 0) {
				ctx.ui.setStatus("agent-board", undefined);
				return;
			}
			const parts: string[] = [];
			if (working > 0) parts.push(ctx.ui.theme.fg("accent", `●${working}`));
			if (needs > 0) parts.push(ctx.ui.theme.fg("warning", `◆${needs}`));
			if (queued > 0) parts.push(ctx.ui.theme.fg("muted", `q${queued}`));
			ctx.ui.setStatus("agent-board", parts.length ? `${ctx.ui.theme.fg("muted", "agents")} ${parts.join(" ")}` : undefined);
		} catch {
			/* never break the session over a status update */
		}
	};

	pi.on("session_start", async (event, ctx) => {
		if (isHostedChild && !hostedEditorReporter && typeof ctx.ui?.getEditorText === "function" && hostedViewId) {
			const { createEditorStateReporter } = await import("./core/editor-state-reporter.mjs");
			hostedEditorReporter = createEditorStateReporter({
				getEditorText: () => ctx.ui.getEditorText(),
				connect: () => createConnection(controlSocketPathFor(process.platform as "win32" | "linux" | "darwin", root, hostedViewId)),
			});
			hostedEditorReporter.start();
		}
		updateStatus(ctx);
		if (event.reason === "startup" && !isHostedChild && pi.getFlag("agent-board") === true && ctx.hasUI) {
			const service = createService({ root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, titleRunnerScript: TITLE_RUNNER_SCRIPT, autoStateRunnerScript: AUTO_STATE_RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: ctx.cwd });
			service.reconcile();
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
			ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
			ctx.ui.setTitle("agent board");
			const result = await openDashboard(ctx, service, { currentThinkingLevel: pi.getThinkingLevel() });
			if (result.action === "attach") {
				ctx.ui.notify("Attach requires the /agent-board command path; launch from a normal Pi session for now.", "warning");
			} else {
				ctx.shutdown();
			}
		}
	});
	const syncForeground = (event: unknown, ctx: ExtensionContext) => {
		try {
			const service = serviceFor(ctx);
			if (hostedViewId) service.syncHostedEvent(hostedViewId, event);
			else service.syncForegroundEvent(ctx.sessionManager.getSessionFile(), event);
			updateStatus(ctx);
		} catch {
			/* never break the session over dashboard mirroring */
		}
	};

	pi.on("input", async (event, ctx) => syncForeground(event, ctx));
	pi.on("before_agent_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("agent_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("tool_execution_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("tool_execution_end", async (event, ctx) => syncForeground(event, ctx));
	pi.on("message_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("message_end", async (event, ctx) => syncForeground(event, ctx));
	pi.on("agent_end", async (event, ctx) => syncForeground(event, ctx));
}
