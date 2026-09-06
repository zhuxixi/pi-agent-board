import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService, HOST_START_GRACE_MS } from "../src/runtime/service.mjs";
import { createView, readHost, readState, writeHost, writeHostPid, writeState } from "../src/core/store.mjs";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import * as P from "../src/core/paths.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-recovery-"));
}

function service(root, overrides = {}) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: process.pid, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
		ptySupport: () => ({ ok: true }),
		...overrides,
	});
}

/** Minimal new-protocol host record on disk. */
function writeHostRecord(root, viewId, patch = {}) {
	writeHost(root, {
		version: 1,
		viewId,
		mode: "pty",
		instanceId: "i1",
		configPath: P.hostConfigPathFor(root, viewId, "i1"),
		socketPath: P.hostEndpointPathFor(process.platform, root, viewId, "i1"),
		claimAt: Date.now() - 60_000,
		claimPid: null,
		claimIdentity: null,
		runnerPid: null,
		runnerIdentity: null,
		runnerSpawnedAt: null,
		childPid: null,
		childIdentity: null,
		childSpawnedAt: null,
		state: "alive",
		startedAt: Date.now() - 60_000,
		lastSeenAt: Date.now(),
		endedAt: null,
		exitCode: null,
		error: null,
		readyAt: Date.now() - 50_000,
		cols: 80,
		rows: 24,
		attachedClients: 0,
		stopRequestedAt: null,
		revokeToken: null,
		stopReason: null,
		...patch,
	});
}

test("requestHostStop marks stopping with a revoke token and never signals", () => {
	const root = freshRoot();
	const signals = [];
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHostRecord(root, "v1", { runnerPid: 4242, runnerIdentity: { pid: 4242, startToken: "t" }, runnerSpawnedAt: 1 });
		writeHostPid(root, "v1", 4242);
		const svc = service(root, { signalOwnedProcess: (identity, signal) => signals.push({ pid: identity.pid, signal }) });

		const res = svc.requestHostStop("v1", "i1", "test_stop");

		assert.deepEqual(res, { ok: true, requested: true });
		const host = readHost(root, "v1");
		assert.equal(host.state, "stopping");
		assert.ok(host.stopRequestedAt != null);
		assert.ok(host.revokeToken != null);
		assert.equal(host.stopReason, "test_stop");
		assert.equal(signals.length, 0, "requestHostStop must never signal");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("requestHostStop on a terminal state returns requested:false and leaves state unchanged", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHostRecord(root, "v1", { state: "exited", endedAt: 1, exitCode: 0 });
		const svc = service(root);

		const res = svc.requestHostStop("v1", "i1", "late");

		assert.deepEqual(res, { ok: true, requested: false });
		const host = readHost(root, "v1");
		assert.equal(host.state, "exited");
		assert.equal(host.stopRequestedAt, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("requestHostStop with the wrong expectedInstanceId refuses and leaves the disk untouched", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHostRecord(root, "v1");
		const svc = service(root);

		const res = svc.requestHostStop("v1", "someone-else", "test");

		assert.equal(res.ok, false);
		assert.equal(res.error, "owner_changed");
		const host = readHost(root, "v1");
		assert.equal(host.state, "alive");
		assert.equal(host.stopRequestedAt, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recoverHost escalates an owned runner once, then claims a replacement only after it is dead", async () => {
	const root = freshRoot();
	const signals = [];
	const observations = [];
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHostRecord(root, "v1", {
			runnerPid: 4242,
			runnerIdentity: { pid: 4242, startToken: "t" },
			runnerSpawnedAt: 1,
			childPid: null,
			childIdentity: null,
			childSpawnedAt: null,
		});
		// runner: owned on first observation, dead afterwards; child never spawned.
		const runnerStates = ["owned", "dead", "dead", "dead"];
		const svc = service(root, {
			observeProcess: (identity) => {
				observations.push(identity.pid);
				return runnerStates[Math.min(observations.length - 1, runnerStates.length - 1)];
			},
			signalOwnedProcess: (identity, signal) => signals.push({ pid: identity.pid, signal }),
		});

		const res = await svc.recoverHost("v1", "i1");

		assert.equal(res.ok, true);
		assert.equal(res.recovered, true);
		assert.notEqual(res.instanceId, "i1");
		const host = readHost(root, "v1");
		assert.equal(host.instanceId, res.instanceId);
		assert.equal(host.state, "starting");
		// Exactly one escalation, SIGTERM only, aimed at the runner identity.
		assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
		// The claim happened strictly after the "dead" observation.
		assert.ok(observations.length >= 2, `expected >=2 observations, got ${observations.length}`);
		assert.equal(observations[0], 4242);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recoverHost refuses to signal an unknown identity and stays pending", async () => {
	const root = freshRoot();
	const signals = [];
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHostRecord(root, "v1", { runnerPid: 4242, runnerIdentity: { pid: 4242, startToken: null }, runnerSpawnedAt: 1 });
		const svc = service(root, {
			observeProcess: () => "unknown",
			signalOwnedProcess: (identity, signal) => signals.push({ pid: identity.pid, signal }),
		});

		const res = await svc.recoverHost("v1", "i1");

		assert.equal(res.ok, false);
		assert.equal(res.error, "recovery_pending");
		assert.equal(signals.length, 0);
		const host = readHost(root, "v1");
		assert.equal(host.instanceId, "i1");
		assert.equal(host.state, "stopping");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recoverHost treats a foreign pid as ended: no signal, replacement claimed", async () => {
	const root = freshRoot();
	const signals = [];
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHostRecord(root, "v1", { runnerPid: 4242, runnerIdentity: { pid: 4242, startToken: "old" }, runnerSpawnedAt: 1 });
		const svc = service(root, {
			observeProcess: () => "foreign",
			signalOwnedProcess: (identity, signal) => signals.push({ pid: identity.pid, signal }),
		});

		const res = await svc.recoverHost("v1", "i1");

		assert.equal(res.ok, true);
		assert.equal(res.recovered, true);
		assert.equal(signals.length, 0, "must never signal a foreign pid");
		const host = readHost(root, "v1");
		assert.equal(host.instanceId, res.instanceId);
		assert.equal(host.state, "starting");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pruneWarmHosts revokes new-protocol hosts via the file record instead of the socket", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "warm1", name: "w", cwd: "/r" });
		const old = Date.now() - 60 * 60 * 1000;
		// Live runner pid so the sweeper selects the row; idle far beyond TTL.
		writeHostRecord(root, "warm1", {
			runnerPid: process.pid,
			runnerIdentity: { pid: process.pid, startToken: "t" },
			runnerSpawnedAt: 1,
			startedAt: old,
			claimAt: old,
		});
		writeHostPid(root, "warm1", process.pid);
		const state = readState(root, "warm1");
		state.semanticState = "idle";
		state.processState = "exited";
		state.lastActivityAt = old;
		writeState(root, state);

		const svc = service(root);
		svc.reconcile();

		// Direct prune call (keepViewId excludes nothing here).
		svc.pruneWarmHosts({});

		const host = readHost(root, "warm1");
		assert.equal(host.state, "stopping");
		assert.equal(host.stopReason, "warm_prune");
		assert.ok(host.revokeToken != null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile leaves starting hosts within the claim grace alone, and finalizes them past it", () => {
	const root = freshRoot();
	try {
		// Within grace: starting claim with no runner pid must NOT be reconciled to failed.
		createView(root, { id: "fresh", name: "f", cwd: "/r" });
		writeHostRecord(root, "fresh", { state: "starting", claimAt: Date.now() - 500, startedAt: Date.now() - 500, runnerPid: null, readyAt: null });
		const freshState = readState(root, "fresh");
		freshState.semanticState = "queued";
		freshState.processState = "alive";
		freshState.summary = "Queued";
		writeState(root, freshState);

		// Past grace: same shape but claimAt old → reconcile is allowed to finalize.
		createView(root, { id: "stale", name: "s", cwd: "/r" });
		writeHostRecord(root, "stale", { state: "starting", claimAt: Date.now() - HOST_START_GRACE_MS - 5_000, startedAt: Date.now() - HOST_START_GRACE_MS - 5_000, runnerPid: null, readyAt: null });
		const staleState = readState(root, "stale");
		staleState.semanticState = "queued";
		staleState.processState = "alive";
		staleState.summary = "Queued";
		writeState(root, staleState);

		const svc = service(root);
		svc.reconcile();

		const afterFresh = readState(root, "fresh");
		assert.equal(afterFresh.semanticState, "queued", "within-grace starting host must stay untouched");
		assert.equal(readDiagnostics(root, "fresh").some((d) => d.code === "host_reconciled"), false);

		const afterStale = readState(root, "stale");
		assert.equal(afterStale.semanticState, "failed", "past-grace starting host is reconciled to failed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


test("recoverHost's replacement claim is immediately adopt-eligible (no grace wait)", async () => {
	const root = freshRoot();
	const spawnCalls = [];
	// Frozen-ish clock: recovery runs at T, adoption is probed at T+100 — deep
	// inside HOST_START_GRACE_MS. Before the fix the fresh claim (live claimPid)
	// pended through the whole grace window; now it must adopt on the spot.
	let clock = 1_000_000_000_000;
	const svc = service(root, {
		now: () => clock,
		observeProcess: () => "dead",
		signalOwnedProcess: () => {},
		launchHost: (_root, config) => {
			spawnCalls.push(config.instanceId);
			return { pid: process.pid, configPath: config.configPath };
		},
	});
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHostRecord(root, "v1", {
			runnerPid: 4242,
			runnerIdentity: { pid: 4242, startToken: "t" },
			runnerSpawnedAt: 1,
		});

		const res = await svc.recoverHost("v1", "i1");
		assert.equal(res.ok, true);

		// The replacement claim carries NO launcher: the recovery transaction is
		// complete, spawning is the adopter's job, nothing waits on claimPid.
		const claimed = readHost(root, "v1");
		assert.equal(claimed.instanceId, res.instanceId);
		assert.equal(claimed.claimPid, null, "recovery claim must not carry a live claimPid");
		assert.equal(claimed.claimIdentity, null, "recovery claim must not carry a claimIdentity");

		// 100ms after the claim — far inside the grace window — adoption fires.
		clock += 100;
		const ensured = svc.ensureHost("v1");
		assert.equal(ensured.ok, true);
		assert.equal(ensured.started, true, `adoption must be immediate, got: ${JSON.stringify(ensured)}`);
		assert.equal(ensured.instanceId, res.instanceId, "adoption spawns the recovery claim, not a new one");

		const after = readHost(root, "v1");
		assert.notEqual(after.runnerSpawnedAt, null, "runner spawned by adoption");
		assert.equal(after.instanceId, res.instanceId);
		assert.deepEqual(spawnCalls, [res.instanceId], "exactly one adopt-and-spawn");
		assert.ok(readDiagnostics(root, "v1").some((d) => d.code === "host_adopted"), "host_adopted recorded");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
