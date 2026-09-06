import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createView, readHost, writeHost } from "../src/core/store.mjs";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import { finalizeHostCrash } from "../src/core/host-crash.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-crash-"));
}

test("finalizeHostCrash persists failed host state with the crash error", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "crash", cwd: process.cwd() });
		const host = { version: 1, viewId: "v1", mode: "pty", runnerPid: 123, childPid: 456, socketPath: "/x", state: "alive", startedAt: 1, lastSeenAt: 1, endedAt: null, exitCode: null, error: null, cols: 80, rows: 24, attachedClients: 0, attachedEver: true };
		const out = finalizeHostCrash(root, "v1", host, new Error("boom"));
		assert.equal(out.state, "failed");
		assert.equal(out.error, "boom");
		assert.equal(out.exitCode, 1);
		assert.ok(out.endedAt > 0);
		const persisted = readHost(root, "v1");
		assert.equal(persisted.state, "failed");
		assert.equal(persisted.error, "boom");
		assert.ok(readDiagnostics(root, "v1").some((d) => d.code === "host_crashed"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("finalizeHostCrash never throws even with a broken root", () => {
	const root = freshRoot();
	try {
		const host = { version: 1, viewId: "v1", state: "alive" };
		assert.doesNotThrow(() => finalizeHostCrash(join(root, "does-not-exist"), "v1", host, "x"));
		assert.doesNotThrow(() => finalizeHostCrash(root, "v1", null, "x"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("finalizeHostCrash stringifies non-Error errors", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v2", name: "crash2", cwd: process.cwd() });
		const out = finalizeHostCrash(root, "v2", { version: 1, viewId: "v2", state: "alive" }, "plain string");
		assert.equal(out.error, "plain string");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

function newProtocolHost(instanceId, state) {
	return { version: 1, viewId: "v1", mode: "pty", instanceId, runnerPid: 111, childPid: null, socketPath: "/x", state, startedAt: 1, lastSeenAt: 1, endedAt: null, exitCode: null, error: null, cols: 80, rows: 24, attachedClients: 0 };
}

test("finalizeHostCrash with expectedInstanceId refuses to overwrite a superseded instance", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "crash3", cwd: process.cwd() });
		// The replacement instance "b" owns the live record.
		writeHost(root, newProtocolHost("b", "alive"));
		// A superseded runner (instance "a") crashes late and tries to finalize.
		const out = finalizeHostCrash(root, "v1", newProtocolHost("a", "alive"), new Error("boom"), { expectedInstanceId: "a" });
		const persisted = readHost(root, "v1");
		assert.equal(persisted.instanceId, "b", "live record must keep the new owner");
		assert.equal(persisted.state, "alive");
		assert.equal(persisted.error, null);
		assert.equal(out.state, "failed", "returned record stays usable for broadcast");
		assert.equal(out.instanceId, "a");
		const diags = readDiagnostics(root, "v1");
		assert.ok(diags.some((d) => d.code === "host_crash_owner_changed"), "skip must be recorded");
		assert.ok(!diags.some((d) => d.code === "host_crashed"), "superseded crash does not double-log host_crashed");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("finalizeHostCrash with matching expectedInstanceId finalizes the live record as failed", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "crash4", cwd: process.cwd() });
		writeHost(root, newProtocolHost("a", "starting"));
		const out = finalizeHostCrash(root, "v1", newProtocolHost("a", "starting"), new Error("kaboom"), { expectedInstanceId: "a" });
		const persisted = readHost(root, "v1");
		assert.equal(persisted.instanceId, "a");
		assert.equal(persisted.state, "failed");
		assert.equal(persisted.error, "kaboom");
		assert.equal(persisted.exitCode, 1);
		assert.ok(persisted.endedAt > 0);
		assert.equal(out.state, "failed");
		assert.equal(out.error, "kaboom");
		assert.ok(readDiagnostics(root, "v1").some((d) => d.code === "host_crashed"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("finalizeHostCrash without expectedInstanceId keeps legacy writeHost behavior", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "crash5", cwd: process.cwd() });
		writeHost(root, newProtocolHost("b", "alive"));
		// Legacy call: no fencing — overwrites whatever is on disk (historical path).
		finalizeHostCrash(root, "v1", newProtocolHost("a", "alive"), new Error("legacy"));
		const persisted = readHost(root, "v1");
		assert.equal(persisted.instanceId, "a");
		assert.equal(persisted.state, "failed");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
