import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendDiagnostic, appendDiagnosticOnce, clearDiagnostics, readDiagnosticSummary, tailDiagnostics } from "../src/core/diagnostics.mjs";
import { createView } from "../src/core/store.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-diag-"));
}

test("diagnostics append, tail, summarize, clear, and redact secrets", () => {
	const root = freshRoot();
	try {
		appendDiagnostic(root, "v1", { code: "runner_start", message: "started", details: { token: "secret", nested: { apiKey: "abc", ok: true } } });
		appendDiagnostic(root, "v1", { level: "error", code: "worker_exit", message: "failed" });
		const tail = tailDiagnostics(root, "v1", { limit: 1 });
		assert.equal(tail.length, 1);
		assert.equal(tail[0].code, "worker_exit");
		const all = tailDiagnostics(root, "v1", { limit: 10 });
		assert.equal(all[0].details.token, "[redacted]");
		assert.equal(all[0].details.nested.apiKey, "[redacted]");
		const summary = readDiagnosticSummary(root, "v1");
		assert.equal(summary.count, 2);
		assert.equal(summary.errorCount, 1);
		clearDiagnostics(root, "v1");
		assert.equal(tailDiagnostics(root, "v1").length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("appendDiagnosticOnce writes once per match key", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-diag-"));
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const patch = { source: "service", level: "warn", code: "host_recovery_pending", details: { instanceId: "i1", role: "child" } };
		assert.ok(appendDiagnosticOnce(root, "v1", patch, { match: ["instanceId", "role"] }));
		assert.equal(appendDiagnosticOnce(root, "v1", patch, { match: ["instanceId", "role"] }), null);
		assert.ok(appendDiagnosticOnce(root, "v1", { ...patch, details: { instanceId: "i2", role: "child" } }, { match: ["instanceId", "role"] }));
		assert.equal(tailDiagnostics(root, "v1", { limit: 10 }).length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("appendDiagnosticOnce without match keys appends every time", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-diag-"));
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const patch = { level: "warn", code: "host_recovery_pending", details: { instanceId: "i1", role: "child" } };
		assert.ok(appendDiagnosticOnce(root, "v1", patch));
		assert.ok(appendDiagnosticOnce(root, "v1", patch));
		assert.equal(tailDiagnostics(root, "v1", { limit: 10 }).length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
