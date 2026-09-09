import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { createService, shouldProbePtySupport } from "../src/runtime/service.mjs";
import { readCodeRefs } from "../src/core/code-refs-store.mjs";
import { diagnoseNodePtyFailure } from "../src/core/pty-support.mjs";
import { readJournal } from "../src/core/coordinator-journal.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost, readState, readStatus, writeHost, writeHostPid, writeLaunchPrefs, writeState, writeStatus } from "../src/core/store.mjs";
import { readFollowUpQueue } from "../src/core/follow-up-queue.mjs";
import { startCoordinator } from "../test-support/ensure-coordinator-helper.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-service-"));
}

function gitAvailable() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function initRepo(dir) {
	execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.email", "t@t.dev"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
}

function service(root, overrides = {}) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
		...overrides,
	});
}

function setEnv(name, value) {
	const prev = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	return prev;
}

/** Poll until `fn` returns truthy (fire-and-forget beats materialize asynchronously). */
async function waitFor(fn, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = fn();
		if (value) return value;
		if (Date.now() > deadline) return null;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Pin the isolation env the coordinator/client pair needs, then start a tracked coordinator. */
async function startTrackedCoordinator(root) {
	const prev = {
		coordinator: setEnv("AGENT_BOARD_COORDINATOR", undefined),
		boardRoot: setEnv("AGENT_BOARD_ROOT", root),
		piDir: setEnv("PI_CODING_AGENT_DIR", root),
	};
	const coord = await startCoordinator(root);
	return {
		coord,
		restore() {
			setEnv("AGENT_BOARD_COORDINATOR", prev.coordinator);
			setEnv("AGENT_BOARD_ROOT", prev.boardRoot);
			setEnv("PI_CODING_AGENT_DIR", prev.piDir);
		},
	};
}

test("archiveByState archives inactive rows and skips live rows", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "done1", name: "done1", cwd: "/r" });
		createView(root, { id: "done2", name: "done2", cwd: "/r" });
		createView(root, { id: "work1", name: "work1", cwd: "/r" });
		for (const id of ["done1", "done2"]) {
			const s = readState(root, id);
			s.semanticState = "completed";
			s.processState = "exited";
			writeState(root, s);
		}
		const live = readState(root, "work1");
		live.semanticState = "working";
		live.processState = "alive";
		writeState(root, live);

		assert.deepEqual(service(root).archiveByState("completed"), { ok: true, archived: 2, skipped: 0 });
		assert.deepEqual(service(root).rows().map((r) => r.meta.id), ["work1"]);
		assert.deepEqual(service(root).archiveByState("working"), { ok: true, archived: 0, skipped: 1 });
		assert.deepEqual(service(root).rows().map((r) => r.meta.id), ["work1"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("archive deletes an active or stuck queued row after confirmation", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		createView(root, { id: "stuck", name: "stuck", cwd: "/r" });
		const state = readState(root, "stuck");
		state.semanticState = "queued";
		state.processState = "alive";
		state.summary = "Queued";
		writeState(root, state);

		assert.deepEqual(await service(root).archive("stuck"), { ok: true });
		assert.deepEqual(service(root).rows().map((r) => r.meta.id), []);
		const archived = readState(root, "stuck");
		assert.equal(archived.semanticState, "stopped");
		assert.equal(archived.processState, "exited");
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("launch prefs round-trip through service", () => {
	const root = freshRoot();
	try {
		const svc = service(root);
		svc.saveLaunchPrefs({ cwd: "/tmp/work", model: "openai/gpt-5.4", thinkingLevel: "high" });
		assert.deepEqual(svc.getLaunchPrefs(), {
			version: 1,
			cwd: "/tmp/work",
			model: "openai/gpt-5.4",
			thinkingLevel: "high",
			screenLogRetentionDays: null,
			screenLogMaxSize: null,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("attachTarget uses any live PTY host for fast attach", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		assert.deepEqual(service(root).attachTarget("v1"), { kind: "session", sessionFile: meta.sessionFile });
		writeHost(root, {
			version: 1,
			viewId: "v1",
			mode: "pty",
			runnerPid: process.pid,
			childPid: null,
			socketPath: P.controlSocketPath(root, "v1"),
			state: "alive",
			startedAt: 1,
			lastSeenAt: 2,
			endedAt: null,
			exitCode: null,
			error: null,
			cols: 80,
			rows: 24,
			attachedClients: 0,
		});
		writeHostPid(root, "v1", process.pid);
		assert.deepEqual(service(root).attachTarget("v1"), {
			kind: "pty",
			socketPath: P.controlSocketPath(root, "v1"),
			sessionFile: meta.sessionFile,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dispatch schedules detached GPT title generation", () => {
	const root = freshRoot();
	let titled = null;
	try {
		const svc = service(root, {
			titleRunnerScript: "/no/title-runner.mjs",
			launchTitle: (_root, config) => {
				titled = config;
				return { pid: null, configPath: "/no/title-config.json" };
			},
		});
		const res = svc.dispatch("fix websocket reconnect bug", { cwd: "/tmp/project-a" });
		assert.equal(res.ok, true);
		assert.equal(titled.prompt, "fix websocket reconnect bug");
		assert.equal(titled.viewId, res.viewId);
		assert.equal(titled.fallbackName, "fix-websocket-reconnect-bug");
		assert.equal(titled.cwd, "/tmp/project-a");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("successful PTY support stays cached for the process lifetime", () => {
	const cached = { ok: true, checkedAt: 1 };
	assert.equal(shouldProbePtySupport(cached, {}, 60_000), false);
	assert.equal(shouldProbePtySupport(cached, { refresh: true }, 60_000), false);
});

test("failed PTY support respects expiry and explicit refresh", () => {
	const cached = { ok: false, checkedAt: 1_000 };
	assert.equal(shouldProbePtySupport(undefined, {}, 1_500), true);
	assert.equal(shouldProbePtySupport(cached, {}, 1_500), false);
	assert.equal(shouldProbePtySupport(cached, {}, 3_000), true);
	assert.equal(shouldProbePtySupport(cached, { refresh: true }, 1_500), true);
});

test("dispatch refreshes PTY support so a fixed install can recover without restarting Pi", () => {
	const root = freshRoot();
	let healthy = false;
	const calls = [];
	let hostLaunches = 0;
	let jsonLaunches = 0;
	try {
		const svc = service(root, {
			ptySupport: (opts = {}) => {
				calls.push(opts);
				return healthy
					? { ok: true }
					: { ok: false, reason: "posix_spawnp failed", issue: diagnoseNodePtyFailure("posix_spawnp failed", { platform: "darwin", arch: "arm64" }) };
			},
			launchHost: () => {
				hostLaunches += 1;
				return { pid: process.pid, configPath: "/no/host-config.json" };
			},
			launch: () => {
				jsonLaunches += 1;
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		const first = svc.dispatch("first", { cwd: "/tmp/project-a" });
		assert.equal(first.ok, true);
		assert.equal(first.hostMode, "json-runner");
		assert.equal(jsonLaunches, 1);
		healthy = true;
		const second = svc.dispatch("second", { cwd: "/tmp/project-a" });
		assert.equal(second.ok, true);
		assert.equal(second.hostMode, "pty");
		assert.equal(hostLaunches, 1);
		assert.equal(calls.length, 2);
		assert.equal(calls.every((opts) => opts.refresh === true), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dispatch carries cwd, model, and thinking into the hosted session config", () => {
	const root = freshRoot();
	const oldForce = process.env.AGENT_BOARD_FORCE_PTY;
	try {
		process.env.AGENT_BOARD_FORCE_PTY = "1";
		let launched = null;
		const svc = service(root, {
			launchHost: (_root, config) => {
				launched = config;
				return { pid: process.pid, configPath: "/no/host-config.json" };
			},
		});
		const res = svc.dispatch("ship it", {
			cwd: "/tmp/project-a",
			model: "anthropic/claude-sonnet-4-8",
			thinkingLevel: "high",
		});
		assert.equal(res.ok, true);
		assert.equal(launched.cwd, "/tmp/project-a");
		assert.equal(launched.model, "anthropic/claude-sonnet-4-8");
		assert.equal(launched.thinkingLevel, "high");
		const row = svc.row(res.viewId);
		assert.equal(row.meta.cwd, "/tmp/project-a");
		assert.equal(row.meta.defaultModel, "anthropic/claude-sonnet-4-8");
		assert.equal(row.meta.defaultThinking, "high");
	} finally {
		if (oldForce === undefined) delete process.env.AGENT_BOARD_FORCE_PTY;
		else process.env.AGENT_BOARD_FORCE_PTY = oldForce;
		rmSync(root, { recursive: true, force: true });
	}
});

test("dispatch rejects explicit worktree requests", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	const repo = freshRoot();
	try {
		initRepo(repo);
		const res = service(root).dispatch("ship it", { cwd: repo, worktree: true });
		assert.deepEqual(res, { ok: false, error: "Worktree mode is currently disabled." });
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("dispatch allows a second active session in the same repo", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	const repo = freshRoot();
	try {
		initRepo(repo);
		const svc = service(root);
		const first = svc.dispatch("first", { cwd: repo });
		assert.equal(first.ok, true);
		const second = svc.dispatch("second", { cwd: repo });
		assert.equal(second.ok, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("dispatch allows a second active session in the same non-git folder", () => {
	const root = freshRoot();
	const folder = freshRoot();
	try {
		const svc = service(root);
		const first = svc.dispatch("first", { cwd: folder });
		assert.equal(first.ok, true);
		const second = svc.dispatch("second", { cwd: folder });
		assert.equal(second.ok, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(folder, { recursive: true, force: true });
	}
});

test("ensureHost starts an idle PTY host without changing row task state", () => {
	const root = freshRoot();
	const oldForce = process.env.AGENT_BOARD_FORCE_PTY;
	try {
		process.env.AGENT_BOARD_FORCE_PTY = "1";
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, JSON.stringify({ type: "session", id: "s1", cwd: "/r" }) + "\n");
		const before = readState(root, "v1");
		before.semanticState = "completed";
		before.processState = "exited";
		before.summary = "Done";
		writeState(root, before);

		let launched = null;
		const svc = service(root, { launchHost: (_root, config) => {
			launched = config;
			return { pid: process.pid, configPath: "/no/host-config.json" };
		} });
		const res = svc.ensureHost("v1");
		assert.equal(res.ok, true);
		assert.equal(res.started, true);
		assert.ok(res.instanceId, "fresh start reports its instanceId");
		assert.equal(res.socketPath, P.hostEndpointPathFor(process.platform, root, "v1", res.instanceId));
		assert.equal(launched.initialPrompt, null);
		const host = readHost(root, "v1");
		assert.equal(host.instanceId, res.instanceId);
		assert.equal(host.state, "starting");
		assert.equal(host.runnerPid, process.pid);
		const after = readState(root, "v1");
		assert.equal(after.semanticState, "completed");
		assert.equal(after.processState, "exited");
		assert.equal(after.summary, "Done");
	} finally {
		if (oldForce === undefined) delete process.env.AGENT_BOARD_FORCE_PTY;
		else process.env.AGENT_BOARD_FORCE_PTY = oldForce;
		rmSync(root, { recursive: true, force: true });
	}
});

function startingClaimHost(root, viewId, instanceId = "i1") {
	writeHost(root, {
		version: 1,
		viewId,
		mode: "pty",
		instanceId,
		runnerPid: null,
		childPid: null,
		socketPath: P.hostEndpointPathFor(process.platform, root, viewId, instanceId),
		state: "starting",
		claimAt: Date.now(),
		claimPid: process.pid,
		claimIdentity: { pid: process.pid, startToken: null },
		runnerIdentity: null,
		runnerSpawnedAt: null,
		childIdentity: null,
		childSpawnedAt: null,
		readyAt: null,
		stopRequestedAt: null,
		revokeToken: null,
		stopReason: null,
		startedAt: Date.now(),
		lastSeenAt: Date.now(),
		endedAt: null,
		exitCode: null,
		error: null,
		cols: 80,
		rows: 24,
		attachedClients: 0,
	});
}

test("ensureHost returns pending for a fresh starting claim with null runnerPid", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		startingClaimHost(root, "v1", "i1");
		let launches = 0;
		const svc = service(root, {
			launchHost: () => {
				launches += 1;
				return { pid: process.pid, configPath: "/no/host-config.json" };
			},
		});
		const res = svc.ensureHost("v1");
		assert.deepEqual(res, { ok: true, pending: true, socketPath: P.hostEndpointPathFor(process.platform, root, "v1", "i1"), instanceId: "i1" });
		assert.equal(launches, 0, "an existing starting claim must never trigger a second spawn");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("second ensureHost sees the on-disk claim and never spawns twice", () => {
	const root = freshRoot();
	const oldForce = process.env.AGENT_BOARD_FORCE_PTY;
	try {
		process.env.AGENT_BOARD_FORCE_PTY = "1";
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, "");
		let launches = 0;
		const svc = service(root, {
			launchHost: () => {
				launches += 1;
				return { pid: process.pid, configPath: "/no/host-config.json" };
			},
		});
		const first = svc.ensureHost("v1");
		assert.equal(first.ok, true);
		assert.equal(first.started, true);
		assert.equal(launches, 1);
		const second = svc.ensureHost("v1");
		assert.equal(second.ok, true);
		assert.equal(second.pending, true);
		assert.equal(second.instanceId, first.instanceId);
		assert.equal(launches, 1, "the provisional claim on disk must dedupe a second ensure");
	} finally {
		if (oldForce === undefined) delete process.env.AGENT_BOARD_FORCE_PTY;
		else process.env.AGENT_BOARD_FORCE_PTY = oldForce;
		rmSync(root, { recursive: true, force: true });
	}
});

test("lock contention yields pending without spawn", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, "");
		let launches = 0;
		const svc = service(root, {
			ptySupport: () => ({ ok: true }),
			tryAcquireLock: () => ({ acquired: false, reason: "busy" }),
			launchHost: () => {
				launches += 1;
				return { pid: process.pid, configPath: "/no/host-config.json" };
			},
		});
		const res = svc.ensureHost("v1");
		assert.deepEqual(res, { ok: true, pending: true, socketPath: null, instanceId: null });
		assert.equal(launches, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reply with a pending host enqueues the prompt instead of dropping it", async () => {
	const root = freshRoot();
	const oldForce = process.env.AGENT_BOARD_FORCE_PTY;
	try {
		process.env.AGENT_BOARD_FORCE_PTY = "1";
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		startingClaimHost(root, "v1", "i1");
		let launches = 0;
		const svc = service(root, {
			launchHost: () => {
				launches += 1;
				return { pid: process.pid, configPath: "/no/host-config.json" };
			},
		});
		const res = await svc.reply("v1", "hello");
		assert.equal(res.ok, true);
		assert.equal(res.queued, true);
		assert.equal(launches, 0, "pending claim must not spawn a second host");
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items.filter((i) => i.status === "queued").length, 1);
		assert.equal(queue.items[0].text, "hello");
	} finally {
		if (oldForce === undefined) delete process.env.AGENT_BOARD_FORCE_PTY;
		else process.env.AGENT_BOARD_FORCE_PTY = oldForce;
		rmSync(root, { recursive: true, force: true });
	}
});

test("dispatch creates per-instance config and endpoint paths", () => {
	const root = freshRoot();
	const oldForce = process.env.AGENT_BOARD_FORCE_PTY;
	try {
		process.env.AGENT_BOARD_FORCE_PTY = "1";
		let captured = null;
		const svc = service(root, {
			launchHost: (_root, config) => {
				captured = config;
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const res = svc.dispatch("ship it", { cwd: "/tmp/project-a" });
		assert.equal(res.ok, true);
		assert.equal(res.hostMode, "pty");
		assert.ok(captured, "launchHostImpl must have been called");
		assert.ok(captured.instanceId, "config carries the instance token");
		assert.equal(captured.configPath, P.hostConfigPathFor(root, res.viewId, captured.instanceId));
		assert.equal(captured.socketPath, P.hostEndpointPathFor(process.platform, root, res.viewId, captured.instanceId));
		const host = readHost(root, res.viewId);
		assert.equal(host.instanceId, captured.instanceId);
		assert.equal(host.state, "starting");
		assert.equal(host.configPath, captured.configPath);
		assert.equal(host.socketPath, captured.socketPath);
		assert.equal(host.runnerPid, process.pid);
	} finally {
		if (oldForce === undefined) delete process.env.AGENT_BOARD_FORCE_PTY;
		else process.env.AGENT_BOARD_FORCE_PTY = oldForce;
		rmSync(root, { recursive: true, force: true });
	}
});

test("syncForegroundEvent marks a managed attached session working when user inputs", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const s = readState(root, "v1");
		s.semanticState = "needs_input";
		s.processState = "exited";
		s.summary = "Needs input";
		s.question = "Proceed?";
		writeState(root, s);

		assert.equal(await service(root).syncForegroundEvent(meta.sessionFile, { type: "input", text: "yes" }), true);
		// The working-state mirror is a fire-and-forget sync_foreground beat — poll
		// for the coordinator to materialize it instead of asserting synchronously.
		const next = await waitFor(() => {
			const s = readState(root, "v1");
			return s?.semanticState === "working" ? s : null;
		});
		assert.ok(next, "sync_foreground beat materialized the working state");
		assert.equal(next.processState, "alive");
		assert.equal(next.currentRunId, null);
		assert.equal(next.question, null);
		assert.equal(service(root).row("v1").alive, true);
		// Let the in-flight fire-and-forget beat settle against the tracked
		// coordinator before kill — otherwise its ensure path can spawn an
		// untracked twin that outlives the rmSync below.
		await new Promise((resolve) => setTimeout(resolve, 150));
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("syncHostedEvent persists interactive questions and resets them on new input", async () => {
	const root = freshRoot();
	// markCompleted here only exercises the busy reject; pin the coordinator off
	// so the real-coordinator ensure path cannot leak a detached process.
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		assert.equal(await svc.syncHostedEvent("v1", {
			type: "tool_execution_start",
			toolCallId: "q1",
			toolName: "ask_questions",
			args: { questions: [{ question: "Choose a mode?" }] },
		}), true);
		const waiting = readState(root, "v1");
		assert.equal(waiting.semanticState, "needs_input");
		assert.equal(waiting.processState, "alive");
		assert.equal(waiting.needsInput, true);
		assert.equal(waiting.question, "Choose a mode?");
		assert.deepEqual(waiting.pendingQuestions, [{ toolCallId: "q1", question: "Choose a mode?" }]);
		assert.equal((await svc.markCompleted("v1")).ok, false);
		assert.deepEqual(await svc.reply("v1", "safe"), { ok: false, error: "Attach to answer the pending question" });

		assert.equal(await svc.syncHostedEvent("v1", { type: "input", text: "safe" }), true);
		const resumed = readState(root, "v1");
		assert.equal(resumed.semanticState, "working");
		assert.equal(resumed.needsInput, false);
		assert.equal(resumed.question, null);
		assert.deepEqual(resumed.pendingQuestions, []);
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});

test("syncHostedEvent persists code refs (github.json) from bash gh commands", { skip: !gitAvailable() }, async () => {
	const root = freshRoot();
	const repo = freshRoot();
	try {
		initRepo(repo);
		execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/widget.git"], { stdio: "ignore" });
		createView(root, { id: "v1", name: "a", cwd: repo, repoRoot: repo });
		const svc = service(root);
		assert.equal(await svc.syncHostedEvent("v1", {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "gh issue comment 40 --body hi" },
		}), true);
		assert.equal(existsSync(P.codeRefsPath(root, "v1")), true);
		assert.equal(readCodeRefs(root, "v1").issue?.number, 40);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("syncForegroundEvent finalizes attached foreground turn from assistant output", async () => {
	const root = freshRoot();
	// Foreground classification now routes through the coordinator; pin it off so
	// the legacy direct-apply path keeps this unit-level assertions exact and no
	// detached coordinator can leak past the rmSync. The real-coordinator
	// foreground path has its own integration test below.
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		await svc.syncForegroundEvent(meta.sessionFile, { type: "agent_start" });
		await svc.syncForegroundEvent(meta.sessionFile, {
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All done." }] },
		});
		await svc.syncForegroundEvent(meta.sessionFile, { type: "agent_end" });

		const next = readState(root, "v1");
		assert.equal(next.semanticState, "idle");
		assert.equal(next.processState, "exited");
		assert.equal(next.latestAssistantPreview, "All done.");
		assert.equal(next.autoState?.kind, "in_progress");
		assert.equal(svc.row("v1").alive, false);
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});

test("syncForegroundEvent auto-completes foreground turn when auto-done flag is off", async () => {
	const root = freshRoot();
	process.env.AGENT_BOARD_AUTO_STATE_NO_DONE = "0";
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		await svc.syncForegroundEvent(meta.sessionFile, { type: "agent_start" });
		await svc.syncForegroundEvent(meta.sessionFile, {
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All done." }] },
		});
		await svc.syncForegroundEvent(meta.sessionFile, { type: "agent_end" });

		const next = readState(root, "v1");
		assert.equal(next.semanticState, "completed");
		assert.equal(next.processState, "exited");
		assert.equal(next.autoState?.kind, "done");
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		delete process.env.AGENT_BOARD_AUTO_STATE_NO_DONE;
		rmSync(root, { recursive: true, force: true });
	}
});

test("late foreground agent_end after a manual completion is fenced (#46 class, issue #91)", async () => {
	const root = freshRoot();
	// The fence is coordinator-independent (a plain disk read); coordinator off
	// keeps this unit-level and avoids spawning a coordinator for it.
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		await svc.syncForegroundEvent(meta.sessionFile, { type: "agent_start" });
		await svc.syncForegroundEvent(meta.sessionFile, {
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All done." }] },
		});
		await svc.syncForegroundEvent(meta.sessionFile, { type: "agent_end" });
		assert.equal((await svc.markCompleted("v1")).ok, true);
		const completed = readState(root, "v1");
		assert.equal(completed.semanticState, "completed");

		// A stale/duplicate agent_end after the manual completion must not
		// resurrect the row via finalizeRun + projection.
		await svc.syncForegroundEvent(meta.sessionFile, { type: "agent_end" });

		const next = readState(root, "v1");
		assert.equal(next.semanticState, "completed");
		assert.equal(next.autoState ?? null, null, "manual fence signal (completed + autoState null) must survive");
		assert.equal(next.summary, completed.summary, "completion summary must survive the late event");
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});

test("syncForegroundEvent routes foreground classification through the coordinator (A8, service source)", async () => {
	const root = freshRoot();
	process.env.AGENT_BOARD_AUTO_STATE_NO_DONE = "0";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	// Tracked coordinator: prevents a detached-coordinator leak past the rmSync
	// (the client's ensure path would otherwise spawn one).
	const coord = await startCoordinator(root);
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		await svc.syncForegroundEvent(meta.sessionFile, { type: "agent_start" });
		await svc.syncForegroundEvent(meta.sessionFile, {
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All done." }] },
		});
		await svc.syncForegroundEvent(meta.sessionFile, { type: "agent_end" });

		// The classification is materialized by the coordinator (not by the
		// service's direct write): the journal carries the service-sourced
		// command, and state.json carries its revision with CONSISTENT fields —
		// the foreground projection must not clobber semanticState back to the
		// pre-classification value while keeping autoState (#46-class mix).
		const records = readJournal(root);
		const classifyRecord = records.find(
			(r) => r.command?.kind === "auto_state_classified" && r.command?.source === "service",
		);
		assert.ok(classifyRecord, "journal carries the service-sourced classification");
		assert.equal(classifyRecord.result.status, "applied");

		const next = readState(root, "v1");
		assert.ok(next.materializedRevision >= classifyRecord.materializedRevision);
		assert.equal(next.semanticState, "completed");
		assert.equal(next.autoState?.kind, "done");
		assert.equal(next.autoState?.source, "heuristic");
	} finally {
		await coord.kill();
		delete process.env.AGENT_BOARD_AUTO_STATE_NO_DONE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true });
	}
});

test("markCompleted explicitly moves an inactive session to completed", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const s = readState(root, "v1");
		s.semanticState = "idle";
		s.processState = "exited";
		s.summary = "All done.";
		s.latestAssistantPreview = "All done.";
		writeState(root, s);

		assert.deepEqual(await service(root).markCompleted("v1"), { ok: true });
		const next = readState(root, "v1");
		assert.equal(next.semanticState, "completed");
		assert.equal(next.processState, "exited");
		assert.equal(next.summary, "All done.");
		assert.equal(next.needsInput, false);
		assert.equal(next.hasError, false);
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});

test("completeView goes through the coordinator command path", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", undefined);
	const prevBoardRoot = setEnv("AGENT_BOARD_ROOT", root);
	const prevPiDir = setEnv("PI_CODING_AGENT_DIR", root);
	const coord = await startCoordinator(root);
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const s = readState(root, "v1");
		s.semanticState = "idle";
		s.processState = "exited";
		writeState(root, s);

		assert.deepEqual(await service(root).markCompleted("v1"), { ok: true });

		const records = readJournal(root);
		const record = records.find((r) => r.command?.kind === "mark_completed" && r.command?.viewId === "v1");
		assert.ok(record, "expected a mark_completed record in the coordinator journal");
		assert.equal(record.command.source, "dashboard-user");
		assert.equal(readState(root, "v1").semanticState, "completed");
	} finally {
		await coord.kill();
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		setEnv("AGENT_BOARD_ROOT", prevBoardRoot);
		setEnv("PI_CODING_AGENT_DIR", prevPiDir);
		rmSync(root, { recursive: true, force: true });
	}
});

test("completeView does not fall back to a direct write on ambiguous coordinator outcomes (issue #91)", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const s = readState(root, "v1");
		s.semanticState = "idle";
		s.processState = "exited";
		writeState(root, s);
		const before = readFileSync(P.statePath(root, "v1"), "utf8");

		// Ambiguous result (timeout: the command MAY already be journaled). The
		// service must surface it verbatim and never reach completeViewDirect —
		// a direct write here would bypass the single-writer fence (#46 class).
		const sent = [];
		const svc = service(root, {
			async sendStateCommand(_root, command) {
				sent.push(command);
				return { status: "rejected", reason: "timeout", materializedRevision: 0 };
			},
		});
		assert.deepEqual(await svc.markCompleted("v1"), { ok: false, error: "timeout" });
		assert.equal(sent.length, 1);
		assert.equal(sent[0].kind, "mark_completed");
		assert.equal(readFileSync(P.statePath(root, "v1"), "utf8"), before, "state.json must stay byte-identical on ambiguous outcomes");

		// Same guarantee for coordinator_unavailable (never-delivered, nothing journaled).
		const svcUnavailable = service(root, {
			async sendStateCommand() {
				return { status: "rejected", reason: "coordinator_unavailable", materializedRevision: 0 };
			},
		});
		assert.deepEqual(await svcUnavailable.markCompleted("v1"), { ok: false, error: "coordinator_unavailable" });
		assert.equal(readFileSync(P.statePath(root, "v1"), "utf8"), before, "state.json must stay byte-identical when the coordinator is unavailable");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("markVisited records a durable lastVisitedAt timestamp", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const before = readState(root, "v1");
		assert.equal(before.lastVisitedAt, null);
		assert.deepEqual(await service(root).markVisited("v1"), { ok: true });
		const after = await waitFor(() => {
			const s = readState(root, "v1");
			return typeof s?.lastVisitedAt === "number" ? s : null;
		});
		assert.ok(after, "lastVisitedAt materialized through the coordinator");
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});


test("markCompletedMany completes inactive rows and skips live/already-done rows", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	try {
		createView(root, { id: "idle1", name: "idle1", cwd: "/r" });
		createView(root, { id: "done1", name: "done1", cwd: "/r" });
		createView(root, { id: "live1", name: "live1", cwd: "/r" });
		const idle = readState(root, "idle1");
		idle.semanticState = "idle";
		idle.processState = "exited";
		writeState(root, idle);
		const done = readState(root, "done1");
		done.semanticState = "completed";
		done.processState = "exited";
		writeState(root, done);
		const live = readState(root, "live1");
		live.semanticState = "working";
		live.processState = "alive";
		writeState(root, live);

		assert.deepEqual(await service(root).markCompletedMany(["idle1", "done1", "live1"]), {
			ok: true,
			completed: 1,
			skipped: 2,
			completedIds: ["idle1"],
		});
		assert.equal(readState(root, "idle1").semanticState, "completed");
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});


test("archiveMany archives explicit completed rows and skips live ones", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "done1", name: "done1", cwd: "/r" });
		createView(root, { id: "done2", name: "done2", cwd: "/r" });
		createView(root, { id: "live1", name: "live1", cwd: "/r" });
		for (const id of ["done1", "done2"]) {
			const s = readState(root, id);
			s.semanticState = "completed";
			s.processState = "exited";
			writeState(root, s);
		}
		const live = readState(root, "live1");
		live.semanticState = "working";
		live.processState = "alive";
		writeState(root, live);

		assert.deepEqual(await service(root).archiveMany(["done1", "done2", "live1"]), { ok: true, archived: 2, skipped: 1 });
		assert.deepEqual(service(root).rows().map((r) => r.meta.id), ["live1"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("busy replies queue and drain when idle", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "working";
		st.processState = "alive";
		writeState(root, st);
		const launched = [];
		const svc = service(root, {
			ptySupport: () => ({ ok: false, reason: "test" }),
			launch: (_root, config) => {
				launched.push(config);
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		const queued = await svc.reply("v1", "next step");
		assert.equal(queued.ok, true);
		assert.equal(queued.queued, true);
		assert.equal(svc.followUps("v1").summary.queuedCount, 1);

		const idle = readState(root, "v1");
		idle.semanticState = "idle";
		idle.processState = "exited";
		writeState(root, idle);
		const drained = await svc.drainNextFollowUp("v1");
		assert.equal(drained.ok, true);
		assert.equal(launched.length, 1);
		assert.equal(launched[0].prompt, "next step");
		assert.equal(svc.followUps("v1").summary.queuedCount, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("adoptSession creates and reuses rows for an existing session file", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		const sessionFile = join(root, "current.jsonl");
		const svc = service(root);
		const first = await svc.adoptSession({ sessionFile, cwd: "/r", name: "current" });
		assert.equal(first.ok, true);
		assert.equal(first.reused, false);
		const second = await svc.adoptSession({ sessionFile, cwd: "/r", name: "current renamed" });
		assert.equal(second.ok, true);
		assert.equal(second.reused, true);
		assert.equal(second.viewId, first.viewId);
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile does not drain queued follow-ups after failed terminal state", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "failed";
		st.processState = "exited";
		writeState(root, st);
		const launched = [];
		const svc = service(root, {
			ptySupport: () => ({ ok: false, reason: "test" }),
			launch: (_root, config) => {
				launched.push(config);
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		svc.queueFollowUp("v1", "should wait");
		svc.reconcile();
		assert.equal(launched.length, 0);
		assert.equal(svc.followUps("v1").summary.queuedCount, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("busy steering actions queue raw steering payloads", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "working";
		st.processState = "alive";
		writeState(root, st);
		const svc = service(root);
		const res = await svc.requestPlan("v1", "make a plan");
		assert.equal(res.ok, true);
		const queue = svc.followUps("v1").queue;
		assert.equal(queue.items[0].kind, "plan_request");
		assert.equal(queue.items[0].text, "make a plan");
		assert.doesNotMatch(queue.items[0].text, /Create an implementation plan only/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("idle non-PTY plan request launches with plan run kind", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "idle";
		st.processState = "exited";
		writeState(root, st);
		const launched = [];
		const svc = service(root, {
			ptySupport: () => ({ ok: false, reason: "test" }),
			launch: (_root, config) => {
				launched.push(config);
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		const res = await svc.requestPlan("v1", "make a plan");
		assert.equal(res.ok, true);
		assert.equal(launched.length, 1);
		assert.equal(launched[0].kind, "plan");
		assert.match(launched[0].prompt, /Create an implementation plan only/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("adoptSession resets reused inactive failed row to idle so queued bg prompts can drain", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		const sessionFile = join(root, "current.jsonl");
		const svc = service(root);
		const first = await svc.adoptSession({ sessionFile, cwd: "/r", name: "current" });
		const state = readState(root, first.viewId);
		state.semanticState = "failed";
		state.processState = "exited";
		state.hasError = true;
		state.error = "old failure";
		writeState(root, state);
		const reused = await svc.adoptSession({ sessionFile, cwd: "/r", name: "current" });
		assert.equal(reused.reused, true);
		const next = await waitFor(() => {
			const s = readState(root, first.viewId);
			return s?.semanticState === "idle" ? s : null;
		});
		assert.ok(next, "adopt_session materialized the idle reset");
		assert.equal(next.hasError, false);
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile finalizes host-backed row when PTY host exits without agent_end", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "queued";
		st.processState = "alive";
		st.currentRunId = null;
		writeState(root, st);
		writeHost(root, {
			version: 1,
			viewId: "v1",
			mode: "pty",
			runnerPid: null,
			childPid: null,
			socketPath: P.controlSocketPath(root, "v1"),
			state: "exited",
			startedAt: 1,
			lastSeenAt: 2,
			endedAt: 3,
			exitCode: 0,
			error: null,
			cols: 80,
			rows: 24,
			attachedClients: 0,
		});
		assert.equal(await service(root).reconcile(), 1);
		const next = await waitFor(() => {
			const s = readState(root, "v1");
			return s?.processState === "exited" ? s : null;
		});
		assert.ok(next, "reconcile_finalize materialized through the coordinator");
		assert.equal(next.semanticState, "idle");
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("adopted external session does not fall back to JSON runner when PTY is unavailable", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		const sessionFile = join(root, "external-current.jsonl");
		const launched = [];
		const svc = service(root, {
			ptySupport: () => ({ ok: false, reason: "test" }),
			launch: (_root, config) => {
				launched.push(config);
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		const adopted = await svc.adoptSession({ sessionFile, cwd: "/r", name: "current" });
		const res = await svc.reply(adopted.viewId, "continue", { delivery: "now" });
		assert.equal(res.ok, false);
		assert.match(res.error, /PTY is required/);
		assert.equal(launched.length, 0);
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile finalizes stale starting/alive host snapshots", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "working";
		st.processState = "alive";
		st.currentRunId = null;
		writeState(root, st);
		writeHost(root, {
			version: 1,
			viewId: "v1",
			mode: "pty",
			runnerPid: 99999999,
			childPid: null,
			socketPath: P.controlSocketPath(root, "v1"),
			state: "alive",
			startedAt: 1,
			lastSeenAt: 2,
			endedAt: null,
			exitCode: null,
			error: null,
			cols: 80,
			rows: 24,
			attachedClients: 0,
		});
		assert.equal(await service(root).reconcile(), 1);
		const next = await waitFor(() => {
			const s = readState(root, "v1");
			return s?.semanticState === "failed" ? s : null;
		});
		assert.ok(next, "reconcile_finalize materialized the failed verdict");
		assert.equal(next.processState, "exited");
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("createService schedules screen log GC with the prefs retention", async () => {
	const root = freshRoot();
	try {
		writeLaunchPrefs(root, { screenLogRetentionDays: 3 });
		const calls = [];
		service(root, { pruneScreenLogs: (r, o) => calls.push([r, o]) });
		// GC is deferred via setImmediate; one tick is enough (FIFO order).
		await new Promise((r) => setImmediate(r));
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0], root);
		assert.deepEqual(calls[0][1], { retentionDays: 3 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failing screen log GC does not break createService", async () => {
	const root = freshRoot();
	try {
		const svc = service(root, {
			pruneScreenLogs: () => {
				throw new Error("gc boom");
			},
		});
		await new Promise((r) => setImmediate(r));
		assert.equal(typeof svc.row, "function"); // service still constructed fine
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureHost passes screenLogMaxBytes from prefs into HostConfig", async () => {
	const root = freshRoot();
	try {
		writeLaunchPrefs(root, { screenLogMaxSize: 2048 });
		const meta = createView(root, { id: "gc1", name: "gc1", cwd: process.cwd() });
		writeFileSync(meta.sessionFile, "");
		let captured = null;
		const svc = service(root, {
			ptySupport: () => ({ ok: true }),
			launchHost: (r, config) => {
				captured = config;
				return { pid: process.pid, configPath: "/no/host-config.json" };
			},
		});
		const result = svc.ensureHost("gc1");
		assert.equal(result.ok, true);
		assert.equal(captured.screenLogMaxBytes, 2048);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("screen log GC writes a summary record to gc-history.jsonl when it reclaims", async () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		const DAY = 24 * 60 * 60 * 1000;
		createView(root, { id: "gc9", name: "gc9", cwd: process.cwd() });
		writeHost(root, {
			version: 1,
			viewId: "gc9",
			mode: "pty",
			runnerPid: null,
			childPid: null,
			socketPath: "",
			state: "exited",
			startedAt: now - 11 * DAY,
			lastSeenAt: now - 10 * DAY,
			endedAt: now - 10 * DAY,
			exitCode: 0,
			error: null,
			cols: 80,
			rows: 24,
			attachedClients: 0,
		});
		writeFileSync(P.screenLogPath(root, "gc9"), Buffer.alloc(4096, 65));
		// Backdate host.json past the heartbeat grace window so the sweep acts.
		const oldSecs = (now - 10 * DAY) / 1000;
		utimesSync(P.hostPath(root, "gc9"), oldSecs, oldSecs);
		service(root); // no pruneScreenLogs override → the real sweep runs
		await new Promise((r) => setImmediate(r));
		const lines = readFileSync(P.gcHistoryPath(root), "utf8").trim().split("\n");
		const record = JSON.parse(lines[lines.length - 1]);
		assert.equal(record.removed, 1);
		assert.ok(record.bytesReclaimed >= 4096);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("screen log GC stays silent when nothing is reclaimed", async () => {
	const root = freshRoot();
	try {
		service(root);
		await new Promise((r) => setImmediate(r));
		assert.equal(existsSync(P.gcHistoryPath(root)), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("persistent skippedForeign does not trigger gc-history records", async () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		// A permanent foreign dir holding an old screen.log: skippedForeign > 0 on
		// every pass, but nothing is ever removed — no record may be appended.
		const foreign = join(P.viewsDir(root), "not-a-view");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(P.screenLogPath(root, "not-a-view"), Buffer.alloc(4096, 65));
		const oldSecs = (now - 30 * 24 * 60 * 60 * 1000) / 1000;
		utimesSync(P.screenLogPath(root, "not-a-view"), oldSecs, oldSecs);
		service(root);
		await new Promise((r) => setImmediate(r));
		assert.equal(existsSync(P.gcHistoryPath(root)), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("errors-only GC passes produce no gc-history record", async () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		const DAY = 24 * 60 * 60 * 1000;
		createView(root, { id: "gcerr", name: "gcerr", cwd: process.cwd() });
		writeHost(root, {
			version: 1,
			viewId: "gcerr",
			mode: "pty",
			runnerPid: null,
			childPid: null,
			socketPath: "",
			state: "exited",
			startedAt: now - 11 * DAY,
			lastSeenAt: now - 10 * DAY,
			endedAt: now - 10 * DAY,
			exitCode: 0,
			error: null,
			cols: 80,
			rows: 24,
			attachedClients: 0,
		});
		// A directory named screen.log: stat succeeds, unlink fails with EISDIR on
		// every pass — a persistent errors>0 condition that must stay silent.
		mkdirSync(P.screenLogPath(root, "gcerr"));
		const oldSecs = (now - 10 * DAY) / 1000;
		utimesSync(P.hostPath(root, "gcerr"), oldSecs, oldSecs);
		service(root);
		await new Promise((r) => setImmediate(r));
		assert.equal(existsSync(P.gcHistoryPath(root)), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureHost probes PTY support with TTL cache, not forced refresh", () => {
	const root = freshRoot();
	const oldForce = process.env.AGENT_BOARD_FORCE_PTY;
	try {
		process.env.AGENT_BOARD_FORCE_PTY = "1";
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, JSON.stringify({ type: "session", id: "s1", cwd: "/r" }) + "\n");
		const probeCalls = [];
		const svc = service(root, {
			ptySupport: (opts = {}) => { probeCalls.push(opts); return { ok: true }; },
			launchHost: () => ({ pid: process.pid, configPath: "/no/host-config.json" }),
		});
		const res = svc.ensureHost("v1");
		assert.equal(res.ok, true);
		assert.ok(probeCalls.length >= 1);
		for (const opts of probeCalls) {
			assert.notEqual(opts?.refresh, true, "ensureHost must not force ptySupport refresh");
		}
	} finally {
		if (oldForce === undefined) delete process.env.AGENT_BOARD_FORCE_PTY;
		else process.env.AGENT_BOARD_FORCE_PTY = oldForce;
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile auto-drain uses the cached PTY probe, never forced refresh", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "idle";
		st.processState = "exited";
		writeState(root, st);
		const probeCalls = [];
		const svc = service(root, {
			ptySupport: (opts = {}) => {
				probeCalls.push(opts);
				return { ok: false, reason: "test" };
			},
			launch: () => ({ pid: null, configPath: "/no/config.json" }),
		});
		const queued = svc.queueFollowUp("v1", "next step");
		assert.equal(queued.ok, true);
		const fixed = await svc.reconcile();
		assert.ok(fixed >= 1, "reconcile drained the queued follow-up");
		assert.ok(probeCalls.length >= 1, "drain path probed ptySupport");
		for (const opts of probeCalls) {
			assert.notEqual(opts?.refresh, true, "reconcile→drain must not force ptySupport refresh");
		}
		// Settle the fire-and-forget mark_queued beat against the tracked
		// coordinator before kill (prevents an untracked twin past the rmSync).
		await new Promise((resolve) => setTimeout(resolve, 150));
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("markCompleted clears autoState in the run status so in-flight model passes skip refinement", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", undefined);
	const prevBoardRoot = setEnv("AGENT_BOARD_ROOT", root);
	const prevPiDir = setEnv("PI_CODING_AGENT_DIR", root);
	const coord = await startCoordinator(root);
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const s = readState(root, "v1");
		s.semanticState = "idle";
		s.processState = "exited";
		s.currentRunId = "run_1";
		s.summary = "All done.";
		s.latestAssistantPreview = "All done.";
		writeState(root, s);
		writeStatus(root, {
			version: 1,
			runId: "run_1",
			viewId: "v1",
			pid: null,
			startedAt: 1,
			endedAt: 2,
			exitCode: 0,
			kind: "dispatch",
			prompt: "x",
			model: null,
			semanticState: "completed",
			processState: "exited",
			summary: "All done.",
			lastActivityAt: 2,
			currentTool: null,
			latestAssistantPreview: "All done.",
			question: null,
			pendingQuestions: [],
			error: null,
			lastAgentActivityAt: null,
			stopReason: null,
			stoppedByUser: false,
			turns: 1,
			toolCount: 0,
			eventCount: 0,
			lastEventAt: null,
			usage: null,
			stallReason: null,
			evidenceSummary: null,
			autoState: { version: 1, kind: "done", semanticState: "completed", confidence: "high", source: "heuristic", reason: "done", question: null, classifiedAt: 2, lastAgentActivityAt: null, textHash: "abc" },
		});

		assert.deepEqual(await service(root).markCompleted("v1"), { ok: true });
		const nextStatus = readStatus(root, "v1", "run_1");
		assert.equal(nextStatus.autoState, null);
		const next = readState(root, "v1");
		assert.equal(next.semanticState, "completed");
		assert.equal(next.autoState, null);
	} finally {
		await coord.kill();
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		setEnv("AGENT_BOARD_ROOT", prevBoardRoot);
		setEnv("PI_CODING_AGENT_DIR", prevPiDir);
		rmSync(root, { recursive: true, force: true });
	}
});
