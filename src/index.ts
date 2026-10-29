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
import { defaultRoot, resolveControlEndpoint } from "./core/paths.mjs";
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
/**
 * Issue #222 (23b1, FW-03/FW-04): hosted-child frame-witness reporter. It is
 * capability-gated by the runner (`frame_witness_enable`) and only exists for hosted
 * children with a view id and a TUI; it publishes NO attach readiness or proof — the
 * runner only consumes the markers for its own bookkeeping until 23b2.
 */
let hostedFrameWitness: { stop(): void } | null = null;
// F4: truthful session epoch source. A hosted runner child currently hosts exactly ONE
// interactive session, so the first session_start is epoch 1; any additional actual
// session_start increments it (and the runner-side intent lifecycle invalidates the old
// candidates). No other topology is used here.
let hostedSessionEpoch = 0;

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
	let sweepService: ReturnType<typeof createService> | null = null;
	attachWarmHostSweeper(pi, {
		isHostedChild,
		sweep: () => {
			try {
				// Reuse one service instance per extension lifetime: createService
				// schedules a screen-log GC on construction, so per-tick creation
				// would turn an event-driven cost into a timed one.
				sweepService ??= serviceForContext();
				sweepService.pruneWarmHosts();
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
	// Live model list for the stale-defaultModel launch guard (issue #90); the
	// service calls it per validation, and undefined conservatively skips.
	const availableModelsFor = (ctx: ExtensionContext) => () => {
		try {
			return ctx.modelRegistry.getAvailable();
		} catch {
			return undefined;
		}
	};
	const serviceFor = (ctx: ExtensionContext) =>
		createService({ root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, titleRunnerScript: TITLE_RUNNER_SCRIPT, autoStateRunnerScript: AUTO_STATE_RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: ctx.cwd, availableModels: availableModelsFor(ctx) });

	const updateStatus = (ctx: ExtensionContext) => {
		try {
			void serviceFor(ctx).reconcile().catch(() => {});
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

	async function startHostedFrameWitness(ctx: ExtensionContext): Promise<void> {
		if (hostedFrameWitness !== null || !hostedViewId || !ctx.hasUI || !ctx.ui) return;
		const { AttachFrameReporter } = await import("./core/attach-frame-reporter.mjs");
		const socket = createConnection(
			resolveControlEndpoint({
				envSocketPath: process.env.AGENT_BOARD_CONTROL_SOCKET,
				platform: process.platform as "win32" | "linux" | "darwin",
				root,
				viewId: hostedViewId,
			}),
		);
		const reporter = new AttachFrameReporter({
			ui: ctx.ui as never,
			mode: "fullscreen", // F6: the sentinel factory rebinds from the ACTUAL public tui.mode
			sessionEpoch: hostedSessionEpoch,
			send: (message: unknown) => {
				try {
					socket.write(`${JSON.stringify(message)}\n`);
				} catch {
					/* socket errors surface through the error handler */
				}
			},
		});
		let installed = false;
		let buffer = "";
		socket.on("connect", () => reporter.announce());
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					const message = JSON.parse(line) as { type?: string };
					if (message.type === "frame_witness_enable") {
						const negotiation = reporter.handleMessage(message);
						if (negotiation.status === "enabled" && !installed) installed = reporter.install();
					} else if (message.type === "frame_witness_intent") {
						reporter.applyIntent(message);
					}
				} catch {
					/* malformed runner message: ignore, the capability stays as it is */
				}
				newline = buffer.indexOf("\n");
			}
		});
		let cleaned = false;
		const cleanup = (reason: string) => {
			if (cleaned) return;
			cleaned = true;
			try {
				reporter.dispose(reason);
			} catch {
				/* never break the session over the frame witness */
			}
			try {
				socket.destroy();
			} catch {
				/* already closed */
			}
			hostedFrameWitness = null;
		};
		socket.on("error", () => cleanup("socket-error"));
		socket.on("close", () => cleanup("socket-close"));
		hostedFrameWitness = { stop: () => cleanup("session-shutdown") };
	}

	pi.on("session_start", async (event, ctx) => {
		if (isHostedChild && !hostedEditorReporter && typeof ctx.ui?.getEditorText === "function" && hostedViewId) {
			const { createEditorStateReporter } = await import("./core/editor-state-reporter.mjs");
			hostedEditorReporter = createEditorStateReporter({
				getEditorText: () => ctx.ui.getEditorText(),
				connect: () => createConnection(resolveControlEndpoint({
					// The runner injects the endpoint it actually bound (issue #103);
					// falling back to the stable per-view address keeps older runners
					// and legacy hosts working.
					envSocketPath: process.env.AGENT_BOARD_CONTROL_SOCKET,
					platform: process.platform as "win32" | "linux" | "darwin",
					root,
					viewId: hostedViewId,
				})),
			});
			hostedEditorReporter.start();
		}
		if (isHostedChild) {
			hostedSessionEpoch += 1;
			try {
				// P2: an actual additional session_start invalidates the old witness (its
				// epoch is stale) and starts a new one with the new epoch.
				if (hostedFrameWitness !== null) {
					hostedFrameWitness.stop();
					hostedFrameWitness = null;
				}
				await startHostedFrameWitness(ctx);
			} catch {
				/* the frame witness must never break a hosted session */
			}
		}
		updateStatus(ctx);
		if (event.reason === "startup" && !isHostedChild && pi.getFlag("agent-board") === true && ctx.hasUI) {
			const service = createService({ root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, titleRunnerScript: TITLE_RUNNER_SCRIPT, autoStateRunnerScript: AUTO_STATE_RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: ctx.cwd, availableModels: availableModelsFor(ctx) });
			void service.reconcile().catch(() => {});
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

	pi.on("session_shutdown", () => {
		try {
			hostedFrameWitness?.stop();
		} catch {
			/* best effort */
		}
		hostedFrameWitness = null;
	});
	pi.on("input", async (event, ctx) => syncForeground(event, ctx));
	pi.on("before_agent_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("agent_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("tool_execution_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("tool_execution_end", async (event, ctx) => syncForeground(event, ctx));
	pi.on("message_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("message_end", async (event, ctx) => syncForeground(event, ctx));
	pi.on("agent_end", async (event, ctx) => syncForeground(event, ctx));
}
