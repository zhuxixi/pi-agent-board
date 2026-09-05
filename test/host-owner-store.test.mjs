import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as P from "../src/core/paths.mjs";
import { acquireOwnedViewLock } from "../src/core/locks.mjs";
import {
	claimHost,
	createView,
	loadRow,
	readHost,
	updateOwnedHost,
	writeHost,
	writeHostPid,
} from "../src/core/store.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-owner-store-"));
}

/** Minimal new-protocol host fixture; caller overrides what matters. */
function hostFixture(root, viewId, over = {}) {
	return {
		version: 1,
		viewId,
		mode: "pty",
		instanceId: "inst-b",
		configPath: P.hostConfigPathFor(root, viewId, "inst-b"),
		socketPath: P.hostEndpointPathFor("linux", root, viewId, "inst-b"),
		claimAt: 1000,
		claimPid: 111,
		claimIdentity: { pid: 111, startToken: "claim" },
		runnerPid: 222,
		runnerIdentity: { pid: 222, startToken: "runner" },
		runnerSpawnedAt: 1500,
		childPid: 333,
		childIdentity: { pid: 333, startToken: "child" },
		childSpawnedAt: 2000,
		state: "alive",
		startedAt: 1000,
		lastSeenAt: 2000,
		endedAt: null,
		exitCode: null,
		error: null,
		cols: 120,
		rows: 36,
		attachedClients: 0,
		readyAt: 2500,
		stopRequestedAt: null,
		revokeToken: null,
		stopReason: null,
		...over,
	};
}

/** provisional claim input as the service layer would build it. */
function provisionalFixture(root, viewId, instanceId = "inst-new") {
	return {
		viewId,
		instanceId,
		socketPath: P.hostEndpointPathFor("linux", root, viewId, instanceId),
		configPath: P.hostConfigPathFor(root, viewId, instanceId),
		claimAt: Date.now(),
		claimPid: process.pid,
		claimIdentity: { pid: process.pid, startToken: "svc" },
		cols: 120,
		rows: 36,
	};
}

test("claimHost refuses when an active claim exists (starting/alive/stopping)", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		for (const state of ["starting", "alive", "stopping"]) {
			writeHost(root, hostFixture(root, "v1", { instanceId: "inst-a", state }));
			const res = claimHost(root, provisionalFixture(root, "v1"));
			assert.equal(res.claimed, false, `state=${state} must block a new claim`);
			assert.equal(res.host?.instanceId, "inst-a", "existing host is returned for the caller to wait on");
			assert.equal(readHost(root, "v1").instanceId, "inst-a", "disk unchanged");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("claimHost writes a complete provisional record when the prior host is exited/failed/missing", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		for (const prior of [null, "exited", "failed"]) {
			if (prior) writeHost(root, hostFixture(root, "v1", { instanceId: "inst-old", state: prior, stopRequestedAt: 1, revokeToken: "tok", stopReason: "x" }));
			const res = claimHost(root, provisionalFixture(root, "v1"));
			assert.equal(res.claimed, true, `prior=${prior} allows a new claim`);
			const written = readHost(root, "v1");
			assert.equal(written.instanceId, "inst-new");
			assert.equal(written.state, "starting");
			assert.equal(written.viewId, "v1");
			assert.equal(written.mode, "pty");
			assert.equal(written.claimPid, process.pid);
			assert.deepEqual(written.claimIdentity, { pid: process.pid, startToken: "svc" });
			assert.equal(written.socketPath, P.hostEndpointPathFor("linux", root, "v1", "inst-new"));
			assert.equal(written.configPath, P.hostConfigPathFor(root, "v1", "inst-new"));
			// runner/child/ready and stale stop fields must be nulled on a fresh claim
			assert.equal(written.runnerPid, null);
			assert.equal(written.childPid, null);
			assert.equal(written.readyAt, null);
			assert.equal(written.stopRequestedAt, null);
			assert.equal(written.revokeToken, null);
			assert.equal(written.stopReason, null);
			// host-pid mirror carries the claim pid + instance
			const mirror = JSON.parse(readFileSync(P.hostPidPath(root, "v1"), "utf8"));
			assert.equal(mirror.pid, process.pid);
			assert.equal(mirror.instanceId, "inst-new");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("claimHost returns claimed:false without writing when the host-meta lock is contended", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		// Occupy the host-meta lease from this process to force contention.
		const lease = acquireOwnedViewLock(root, "v1", "host-meta", { identity: { pid: process.pid, startToken: "t" } });
		const res = claimHost(root, provisionalFixture(root, "v1"));
		assert.equal(res.claimed, false);
		assert.equal(res.host, null);
		assert.equal(readHost(root, "v1"), null, "no host record written under contention");
		lease.release();
		// After release the same claim succeeds.
		const retry = claimHost(root, provisionalFixture(root, "v1"));
		assert.equal(retry.claimed, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("updateOwnedHost fences late writes from a superseded instance", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHost(root, hostFixture(root, "v1", { instanceId: "inst-b", state: "alive" }));
		const res = updateOwnedHost(root, "v1", "inst-a", (h) => ({ ...h, state: "exited" }));
		assert.deepEqual(res, { updated: false, ownerChanged: true, host: readHost(root, "v1") });
		const disk = readHost(root, "v1");
		assert.equal(disk.instanceId, "inst-b", "disk keeps the current owner");
		assert.equal(disk.state, "alive");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("updateOwnedHost applies mutate for the current owner and mirrors host-pid", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const claimed = claimHost(root, provisionalFixture(root, "v1", "inst-b"));
		assert.equal(claimed.claimed, true);
		const res = updateOwnedHost(root, "v1", "inst-b", (h) => ({ ...h, runnerPid: 42, runnerIdentity: { pid: 42, startToken: "rt" }, state: "alive", readyAt: 9999 }));
		assert.equal(res.updated, true);
		assert.equal(res.ownerChanged, false);
		const disk = readHost(root, "v1");
		assert.equal(disk.state, "alive");
		assert.equal(disk.readyAt, 9999);
		assert.equal(disk.runnerPid, 42);
		const mirror = JSON.parse(readFileSync(P.hostPidPath(root, "v1"), "utf8"));
		assert.equal(mirror.pid, 42);
		assert.equal(mirror.instanceId, "inst-b");
		assert.deepEqual(mirror.identity, { pid: 42, startToken: "rt" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadRow does not let the legacy host-pid mirror override an explicit null runnerPid", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHost(root, hostFixture(root, "v1", { state: "starting", runnerPid: null, runnerIdentity: null, runnerSpawnedAt: null, childPid: null }));
		writeHostPid(root, "v1", 123);
		const row = loadRow(root, "v1");
		assert.equal(row.host.runnerPid, null, "explicit null must win over the mirror");
		assert.equal(row.hostAlive, false, "null pid is not alive");
		assert.equal(row.hostActive, true, "starting claim is active");
		assert.equal(row.hostReady, false, "starting claim is never ready");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadRow falls back to the legacy mirror only when runnerPid is absent, and derives hostReady", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		// Legacy record: no runnerPid property at all → mirror fallback applies.
		const legacy = hostFixture(root, "v1");
		delete legacy.runnerPid;
		delete legacy.instanceId;
		writeHost(root, legacy);
		writeHostPid(root, "v1", process.pid);
		let row = loadRow(root, "v1");
		assert.equal(row.hostAlive, true, "fallback reads the mirror pid (live)");

		// New-protocol ready host: alive + readyAt → hostReady true.
		writeHost(root, hostFixture(root, "v1", { runnerPid: process.pid }));
		row = loadRow(root, "v1");
		assert.equal(row.hostAlive, true);
		assert.equal(row.hostActive, true);
		assert.equal(row.hostReady, true);

		// alive without readyAt is not ready.
		writeHost(root, hostFixture(root, "v1", { runnerPid: process.pid, readyAt: null }));
		row = loadRow(root, "v1");
		assert.equal(row.hostReady, false);

		// stopping is active but never ready.
		writeHost(root, hostFixture(root, "v1", { runnerPid: process.pid, state: "stopping" }));
		row = loadRow(root, "v1");
		assert.equal(row.hostActive, true);
		assert.equal(row.hostReady, false);

		// exited is neither active nor ready.
		writeHost(root, hostFixture(root, "v1", { runnerPid: process.pid, state: "exited" }));
		row = loadRow(root, "v1");
		assert.equal(row.hostActive, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
