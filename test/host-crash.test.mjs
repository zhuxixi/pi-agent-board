import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createView, readHost } from "../src/core/store.mjs";
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
