import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService, HOST_START_GRACE_MS } from "../src/runtime/service.mjs";
import { createView, readHost, writeHost, writePid, writeState } from "../src/core/store.mjs";
import * as P from "../src/core/paths.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-resolver-"));
}

function resolverService(root, overrides = {}) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => {
			throw new Error("unexpected spawn");
		},
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
		...overrides,
	});
}

/** Scripted probeHostFn: pops classifications in order, holds the last, records calls. */
function scriptProbe(seq) {
	const calls = [];
	let i = 0;
	const fn = async (socketPath, opts) => {
		calls.push({ socketPath, opts });
		const classification = seq[Math.min(i, seq.length - 1)];
		i += 1;
		return { classification, connected: false, protocolValid: false, ready: classification === "ready", viewId: null, instanceId: null, state: null, errorCode: null };
	};
	return { fn, calls };
}

/** Instant sleepFn so retry loops run without real delays. */
const instantSleep = async () => {};

function hostRecord(root, viewId, over = {}) {
	writeHost(root, {
		version: 1,
		viewId,
		mode: "pty",
		instanceId: null,
		runnerPid: null,
		childPid: null,
		socketPath: P.hostEndpointPathFor(process.platform, root, viewId, "i1"),
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
		...over,
	});
}

function aliveHost(root, viewId, instanceId, over = {}) {
	hostRecord(root, viewId, {
		instanceId,
		state: "alive",
		runnerPid: 999999,
		runnerIdentity: { pid: 999999, startToken: "tok" },
		runnerSpawnedAt: 1,
		readyAt: 12345,
		socketPath: P.hostEndpointPathFor(process.platform, root, viewId, instanceId),
		...over,
	});
}

test("resolver waits out a starting host and returns pty once probe ready", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		hostRecord(root, "v1", { instanceId: "i1", state: "starting", runnerPid: process.pid, runnerSpawnedAt: 1 });
		const probe = scriptProbe(["starting", "starting", "ready"]);
		const spawns = [];
		const svc = resolverService(root, {
			probeHostFn: probe.fn,
			sleepFn: instantSleep,
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const result = await svc.resolveAttachTarget("v1");
		assert.equal(result.kind, "pty");
		assert.equal(result.instanceId, "i1");
		assert.equal(result.socketPath, P.hostEndpointPathFor(process.platform, root, "v1", "i1"));
		assert.equal(probe.calls.length, 3, "starting/starting/ready probes");
		assert.equal(spawns.length, 0, "existing fresh claim must never spawn a second host");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolver recovers a stale alive host then attaches to the replacement", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		aliveHost(root, "v1", "i1");
		const probe = scriptProbe(["stale", "missing", "missing", "ready"]);
		const spawns = [];
		// Fake clock: every resolver "sleep" advances virtual time 20s so the
		// recovered claim's grace window elapses without real waiting.
		let clock = 1_000_000;
		const svc = resolverService(root, {
			now: () => clock,
			probeHostFn: probe.fn,
			sleepFn: async () => {
				clock += 20_000;
			},
			observeProcess: () => "dead",
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const result = await svc.resolveAttachTarget("v1");
		assert.equal(result.kind, "pty");
		assert.ok(result.instanceId && result.instanceId !== "i1", "attaches to the replacement instance");
		assert.ok(probe.calls.length >= 3, "stale → recover; missing (grace) → wait; missing (past grace) → adopt; ready → attach");
		assert.equal(spawns.length, 1, "exactly one spawn, from adopt-and-spawn of the recovered claim");
		assert.equal(spawns[0].config.instanceId, result.instanceId);
		assert.equal(spawns[0].config.configPath, P.hostConfigPathFor(root, "v1", result.instanceId));
		assert.equal(spawns[0].config.initialPrompt, null, "adopt builds a fresh config with no recovered prompt");
		assert.ok(existsSync(spawns[0].config.configPath), "adopt persists the config file itself (Task 11 rider a)");
		const finalHost = readHost(root, "v1");
		assert.equal(finalHost.instanceId, result.instanceId);
		assert.ok(finalHost.runnerSpawnedAt != null, "adopt merged the runner spawn into the claim");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolver never downgrades to session while an unknown host may be alive", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		aliveHost(root, "v1", "i1");
		const probe = scriptProbe(["unknown"]);
		const spawns = [];
		const svc = resolverService(root, {
			probeHostFn: probe.fn,
			sleepFn: instantSleep,
			observeProcess: () => "unknown",
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const result = await svc.resolveAttachTarget("v1", { timeoutMs: 250 });
		assert.equal(result.kind, "pending");
		assert.match(result.reason, /recovery_pending/);
		assert.equal(probe.calls.length, 1);
		assert.equal(spawns.length, 0, "identity-unverifiable hosts are never replaced or attached");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("live JSON runner without a host stays pending and never spawns a PTY child", async () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const state = { semanticState: "queued", processState: "alive", currentRunId: "r1" };
		state.version = 1; state.viewId = "v1"; state.summary = "Queued"; state.lastActivityAt = 1; state.updatedAt = 1;
		state.needsInput = false; state.hasError = false; state.latestAssistantPreview = ""; state.latestTool = null;
		state.question = null; state.pendingQuestions = []; state.error = null; state.lastVisitedAt = null;
		state.lastAgentActivityAt = null; state.autoState = null;
		writeState(root, state);
		writePid(root, "v1", "r1", process.pid);
		const probe = scriptProbe(["ready"]);
		const spawns = [];
		const svc = resolverService(root, {
			probeHostFn: probe.fn,
			sleepFn: instantSleep,
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const result = await svc.resolveAttachTarget("v1", { timeoutMs: 100 });
		assert.equal(result.kind, "pending");
		assert.match(result.reason, /background run active/);
		assert.equal(result.sessionFile, meta.sessionFile);
		assert.equal(probe.calls.length, 0, "nothing to probe without a host claim");
		assert.equal(spawns.length, 0, "isAgentBusy guard blocks a parallel PTY child");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("concurrent resolver calls for the same view share one inflight promise", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		aliveHost(root, "v1", "i1");
		const probe = scriptProbe(["ready"]);
		const svc = resolverService(root, { probeHostFn: probe.fn, sleepFn: instantSleep });
		const p1 = svc.resolveAttachTarget("v1");
		const p2 = svc.resolveAttachTarget("v1");
		const [r1, r2] = await Promise.all([p1, p2]);
		assert.deepEqual(r1, r2, "both callers see the same shared resolution");
		assert.equal(r1.kind, "pty");
		assert.equal(probe.calls.length, 1, "shared run probes exactly once");
		// A completed resolution must clear the in-flight slot: a later call runs anew.
		const after = await svc.resolveAttachTarget("v1");
		assert.equal(after.kind, "pty");
		assert.equal(probe.calls.length, 2, "in-flight entry is cleaned up after completion");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("abandoned claim past grace gets adopt-and-spawned on the SAME instance", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		hostRecord(root, "v1", {
			instanceId: "i1",
			state: "starting",
			claimAt: Date.now() - HOST_START_GRACE_MS - 5_000,
			claimPid: process.pid,
			runnerSpawnedAt: null,
		});
		const probe = scriptProbe(["missing", "ready"]);
		const spawns = [];
		const svc = resolverService(root, {
			probeHostFn: probe.fn,
			sleepFn: instantSleep,
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const result = await svc.resolveAttachTarget("v1");
		assert.equal(result.kind, "pty");
		assert.equal(result.instanceId, "i1", "adoption reuses the claimed instance, not a new claim");
		assert.equal(spawns.length, 1);
		assert.equal(spawns[0].config.configPath, P.hostConfigPathFor(root, "v1", "i1"));
		assert.ok(existsSync(spawns[0].config.configPath), "adopt persists the config the claim never got");
		assert.equal(probe.calls.length, 2, "missing → adopt; ready → attach");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureHost directly adopts an abandoned claim past grace", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		hostRecord(root, "v1", {
			instanceId: "i1",
			state: "starting",
			claimAt: Date.now() - HOST_START_GRACE_MS - 5_000,
			claimPid: 999999, // long-gone claimer; claimPid liveness alone must adopt
			runnerSpawnedAt: null,
		});
		const spawns = [];
		const svc = resolverService(root, {
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const res = svc.ensureHost("v1");
		assert.equal(res.ok, true);
		assert.equal(res.started, true);
		assert.equal(res.instanceId, "i1");
		assert.equal(spawns.length, 1);
		assert.ok(existsSync(P.hostConfigPathFor(root, "v1", "i1")));
		const host = readHost(root, "v1");
		assert.equal(host.state, "starting");
		assert.equal(host.runnerPid, process.pid);
		assert.ok(host.runnerSpawnedAt != null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("attachTarget remains a pure sync hint with no probe or spawn side effects", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		// The sync hint gates on the legacy hostAlive liveness flag (runner pid alive);
		// keep that contract untouched — the fixture just needs a live pid.
		aliveHost(root, "v1", "i1", { runnerPid: process.pid });
		const probe = scriptProbe(["ready"]);
		const spawns = [];
		const svc = resolverService(root, {
			probeHostFn: probe.fn,
			sleepFn: instantSleep,
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		assert.deepEqual(svc.attachTarget("v1"), {
			kind: "pty",
			socketPath: P.hostEndpointPathFor(process.platform, root, "v1", "i1"),
			sessionFile: meta.sessionFile,
		});
		assert.equal(probe.calls.length, 0);
		assert.equal(spawns.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
