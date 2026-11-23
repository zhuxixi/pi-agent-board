import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../src/runtime/service.mjs";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import { createView, readHost, writeHost } from "../src/core/store.mjs";
import * as P from "../src/core/paths.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-replacement-"));
}

/**
 * A terminal host record whose recorded runner pid was recycled by a stranger
 * (issue #301). `runnerIdentity` carries a token so the observation takes the
 * identity path; the injected observer decides what that pid "is".
 */
function terminalHostRecord(root, viewId, over = {}) {
	writeHost(root, {
		version: 1,
		viewId,
		mode: "pty",
		instanceId: "old-instance",
		runnerPid: 4242,
		runnerIdentity: { pid: 4242, startToken: "old-token" },
		runnerSpawnedAt: Date.now() - 60_000,
		childPid: null,
		childIdentity: null,
		childSpawnedAt: null,
		socketPath: P.hostEndpointPathFor(process.platform, root, viewId, "old-instance"),
		state: "exited",
		claimAt: null,
		claimPid: null,
		claimIdentity: null,
		readyAt: null,
		stopRequestedAt: null,
		startedAt: Date.now() - 60_000,
		lastSeenAt: Date.now() - 60_000,
		endedAt: Date.now() - 60_000,
		exitCode: 0,
		error: null,
		cols: 80,
		rows: 24,
		attachedClients: 0,
		...over,
	});
}

/** Service with injected process observations and a launch counter. */
function replacementService(root, { runnerObservation, overrides = {} } = {}) {
	const spawns = [];
	const signals = [];
	const svc = createService({
		root,
		runnerScript: "/no/runner.mjs",
		ptyRunnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
		ptySupport: () => ({ ok: true }),
		observeProcess: async () => runnerObservation,
		probeProcessIdentity: async () => null,
		readStartToken: async () => null,
		signalOwnedProcess: (identity, signal) => { signals.push({ identity, signal }); },
		launchHost: (_root, config) => {
			spawns.push(config);
			return { pid: process.pid, configPath: config.configPath };
		},
		...overrides,
	});
	return { svc, spawns, signals };
}

test("a terminal record whose runner pid is foreign is replaced (issue #301 A3)", async () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, "");
		terminalHostRecord(root, "v1");
		const { svc, spawns } = replacementService(root, { runnerObservation: "foreign" });

		const res = await svc.ensureHost("v1");
		assert.equal(res.ok, true);
		assert.equal(res.started, true, `a foreign runner must not block replacement: ${JSON.stringify(res)}`);
		assert.notEqual(res.instanceId, "old-instance");
		assert.equal(spawns.length, 1, "exactly one spawn");

		const released = readDiagnostics(root, "v1").filter((e) => e.code === "host_replace_released");
		assert.equal(released.length, 1, "release is diagnosed exactly once");
		assert.equal(released[0].details.oldInstanceId, "old-instance");
		assert.equal(released[0].details.runnerObservation, "foreign");
		assert.equal(released[0].details.runnerPid, 4242);

		// The fresh claim owns the view now: a second ensure must dedupe on it and
		// never log a second release for the dead instance.
		const again = await svc.ensureHost("v1");
		assert.equal(again.ok, true);
		assert.equal(again.pending, true);
		assert.notEqual(again.started, true, "an active claim is reused, never re-spawned");
		assert.equal(readDiagnostics(root, "v1").filter((e) => e.code === "host_replace_released").length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a terminal record whose runner is provably alive refuses replacement (issue #301 A4)", async () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, "");
		terminalHostRecord(root, "v1");
		const { svc, spawns, signals } = replacementService(root, { runnerObservation: "owned" });

		const res = await svc.ensureHost("v1");
		assert.equal(res.ok, true);
		assert.equal(res.started, false);
		assert.equal(res.pending, true);
		assert.equal(spawns.length, 0, "never stack a second host on a live runner");
		assert.equal(signals.length, 0, "the replace gate never signals");
		assert.equal(res.socketPath, null, "a refused replacement must not echo the dead instance endpoint");
		assert.equal(res.instanceId, null);
		assert.ok(res.blocked, `expected a structured refusal: ${JSON.stringify(res)}`);
		assert.match(res.blocked.reason, /runner pid 4242/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a refusal leaves one host_replace_blocked diagnostic with role, pid and observation (issue #301 A5)", async () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, "");
		terminalHostRecord(root, "v1");
		const { svc, spawns } = replacementService(root, { runnerObservation: "unknown" });

		const first = await svc.ensureHost("v1");
		const second = await svc.ensureHost("v1");
		assert.equal(spawns.length, 0);
		assert.equal(first.blocked.reason, second.blocked.reason);

		const blocked = readDiagnostics(root, "v1").filter((e) => e.code === "host_replace_blocked");
		assert.equal(blocked.length, 1, "appendDiagnosticOnce must dedupe repeated refusals on the same record");
		assert.equal(blocked[0].level, "warn");
		assert.equal(blocked[0].details.instanceId, "old-instance");
		assert.equal(blocked[0].details.runnerPid, 4242);
		assert.equal(blocked[0].details.runnerObservation, "unknown");
		assert.equal(blocked[0].details.childObservation, "not_started");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a released record is actually reclaimed by a new instance (issue #301 A3 follow-through)", async () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, "");
		terminalHostRecord(root, "v1");
		const { svc } = replacementService(root, { runnerObservation: "dead" });
		await svc.ensureHost("v1");
		const host = readHost(root, "v1");
		assert.notEqual(host.instanceId, "old-instance");
		assert.equal(host.state, "starting");
		assert.equal(host.runnerPid, process.pid, "the new runner pid is recorded");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
