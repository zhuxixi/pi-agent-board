/**
 * Cross-process concurrency integration tests (issue #70 A8/A9/A10).
 *
 * Unlike test/pty-runner.integration.test.mjs (which drives the runner directly),
 * these tests spawn the REAL service entry via test-support/ensure-host-helper.mjs
 * child processes, so claim/lease/fencing contends across actual process
 * boundaries:
 *
 *  - A8: two helper processes call ensureHost simultaneously → exactly one host.
 *  - A9: a hijacked host record must fence a second launcher and late writes.
 *  - A10: a SIGKILLed runner (dead endpoint, live orphaned child) is recovered by
 *    resolveAttachTarget: revoke → wait for old child death → fresh claim →
 *    adopt-and-spawn → new ready host. Old child dead before the new one exists
 *    is the no-double-child guarantee.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { probeHost } from "../src/core/host-probe.mjs";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost, updateOwnedHost, writeHost } from "../src/core/store.mjs";
import { createService } from "../src/runtime/service.mjs";

const HELPER = resolve("test-support/ensure-host-helper.mjs");

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-conc-"));
}

async function waitFor(predicate, timeoutMs = 15_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting");
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function launchHostEvents(root, viewId) {
	return readDiagnostics(root, viewId).filter((d) => d.code === "launch_host");
}

/** The service instance the TEST process uses for teardown/assertions — same real
 *  dependencies as the helper, so requestHostStop etc. behave exactly like prod. */
function testService(root) {
	return createService({
		root,
		runnerScript: resolve("runner/job-runner.mjs"),
		ptyRunnerScript: resolve("runner/pty-runner.mjs"),
		piCommand: process.execPath,
		piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
		defaultCwd: process.cwd(),
	});
}

/** createView does not touch the session file; ensureHost requires it to exist. */
function ensureSessionFile(root, viewId) {
	const meta = JSON.parse(readFileSync(P.metaPath(root, viewId), "utf8"));
	mkdirSync(dirname(meta.sessionFile), { recursive: true });
	if (!existsSync(meta.sessionFile)) writeFileSync(meta.sessionFile, "\n");
	return meta;
}

/** Spawn a helper and collect its single ENSURE_RESULT line. */
function runHelper(root, viewId) {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [HELPER, root, viewId], { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		child.stdout.on("data", (chunk) => { out += chunk.toString(); });
		child.on("error", (err) => resolvePromise({ error: String(err) }));
		child.on("close", (code) => {
			const line = out.split("\n").find((l) => l.startsWith("ENSURE_RESULT "));
			resolvePromise(line ? { code, result: JSON.parse(line.slice("ENSURE_RESULT ".length)) } : { code, error: `no result line: ${out.trim()}` });
		});
	});
}

async function teardownHost(root, viewId, service) {
	const host = readHost(root, viewId);
	if (host?.runnerPid && isAlive(host.runnerPid)) {
		try { service.requestHostStop(viewId, host.instanceId, "test teardown"); } catch { /* best effort */ }
		await waitFor(() => !isAlive(host.runnerPid), 8_000).catch(() => {
			try { process.kill(host.runnerPid, "SIGKILL"); } catch { /* already gone */ }
		});
	}
	try { if (host?.childPid) process.kill(host.childPid, "SIGKILL"); } catch { /* already gone */ }
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

let hasNodePty = true;
try {
	await import("node-pty");
} catch {
	hasNodePty = false;
}

test("A8: two concurrent helper processes start exactly one host", { skip: !hasNodePty }, async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "conc", cwd: process.cwd() });
		ensureSessionFile(root, "v1");

		// Launch both helpers within milliseconds of each other.
		const [a, b] = await Promise.all([runHelper(root, "v1"), runHelper(root, "v1")]);
		assert.ok(a.result, `helper A produced a result: ${a.error ?? ""}`);
		assert.ok(b.result, `helper B produced a result: ${b.error ?? ""}`);
		assert.equal(a.result.ok, true, `helper A ok: ${JSON.stringify(a.result)}`);
		assert.equal(b.result.ok, true, `helper B ok: ${JSON.stringify(b.result)}`);

		const results = [a.result, b.result];
		assert.equal(results.filter((r) => r.started === true).length, 1, `exactly one starter: ${JSON.stringify(results)}`);
		const other = results.find((r) => r.started !== true);
		assert.equal(other.pending, true, `loser is pending, not failed: ${JSON.stringify(other)}`);

		// Exactly one launch_host diagnostic — the loser must not have spawned.
		assert.equal(launchHostEvents(root, "v1").length, 1);

		// The single host reaches alive+ready with a live runner.
		const host = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h.readyAt != null && h.runnerPid && isAlive(h.runnerPid) ? h : false;
		}, 15_000);
		assert.ok(host.instanceId);

		// host.json is authoritative; the mirror agrees on the instance.
		const mirror = JSON.parse(readFileSync(P.hostPidPath(root, "v1"), "utf8"));
		assert.equal(mirror.instanceId, host.instanceId);

		// The endpoint is real: a live probe classifies ready.
		const probe = await probeHost(host.socketPath, { expectedViewId: "v1", expectedInstanceId: host.instanceId });
		assert.equal(probe.classification, "ready");

		await teardownHost(root, "v1", testService(root));
	} catch (err) {
		await teardownHost(root, "v1", testService(root)).catch(() => {});
		throw err;
	}
});

test("A9: a hijacked host record fences second launchers and late writers", { skip: !hasNodePty }, async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "fence", cwd: process.cwd() });
		ensureSessionFile(root, "v1");

		const first = await runHelper(root, "v1");
		assert.equal(first.result?.ok, true, `first helper ok: ${JSON.stringify(first)}`);
		assert.equal(first.result.started, true, `first helper started the host: ${JSON.stringify(first.result)}`);
		const original = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h.readyAt != null && h.runnerPid && isAlive(h.runnerPid) ? h : false;
		}, 15_000);

		// Hijack the record: host.json now claims a different instance owns the view.
		writeHost(root, { ...original, instanceId: "hijack" });

		const second = await runHelper(root, "v1");
		assert.equal(second.result?.ok, true, `second helper ok: ${JSON.stringify(second)}`);
		assert.equal(second.result.started !== true && second.result.pending === true, true, `second helper pends against the hijacked claim: ${JSON.stringify(second.result)}`);
		assert.equal(launchHostEvents(root, "v1").length, 1, "no second spawn happened");
		assert.equal(isAlive(original.runnerPid), true, "original runner untouched");

		// Restore the true record; a writer holding the pre-hijack token is fenced out.
		writeHost(root, { ...original });
		const late = updateOwnedHost(root, "v1", "stale-pre-hijack-token", (h) => ({ ...h, state: "exited", endedAt: Date.now() }));
		assert.equal(late.updated, false);
		assert.equal(late.ownerChanged, true);
		const after = readHost(root, "v1");
		assert.equal(after.instanceId, original.instanceId);
		assert.equal(after.state, "alive", "late write did not land");

		await teardownHost(root, "v1", testService(root));
	} catch (err) {
		await teardownHost(root, "v1", testService(root)).catch(() => {});
		throw err;
	}
});

test("A10: SIGKILLed runner is recovered by the attach resolver without double children", { skip: !hasNodePty }, async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "recover", cwd: process.cwd() });
		ensureSessionFile(root, "v1");

		const first = await runHelper(root, "v1");
		assert.equal(first.result?.started, true, `first helper started: ${JSON.stringify(first)}`);
		const original = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h.readyAt != null && h.childPid && isAlive(h.runnerPid) ? h : false;
		}, 15_000);
		assert.equal(isAlive(original.childPid), true, "original child alive before the kill");

		// Orphan the host the hard way: runner SIGKILL leaves a stale endpoint file,
		// host.json claiming alive, and a live orphaned child — the classic #70 state.
		process.kill(original.runnerPid, "SIGKILL");
		await waitFor(() => !isAlive(original.runnerPid), 5_000);

		const service = testService(root);
		const resolved = await service.resolveAttachTarget("v1", { timeoutMs: 40_000 });
		assert.equal(resolved.kind, "pty", `resolver produced a pty target: ${JSON.stringify(resolved)}`);
		assert.notEqual(resolved.instanceId, original.instanceId, "replacement is a new instance");

		// The no-double-child guarantee: recovery claims only after the OLD child died.
		assert.equal(isAlive(original.childPid), false, "old child is dead once the resolver returns");

		const replacement = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h.readyAt != null && h.runnerPid && isAlive(h.runnerPid) && h.childPid ? h : false;
		}, 15_000);
		assert.notEqual(replacement.childPid, original.childPid);
		assert.notEqual(replacement.instanceId, original.instanceId);
		assert.equal(isAlive(replacement.runnerPid), true);

		// One original launch + one adopt-and-spawn — no stacking. The replacement
		// spawn is deliberately recorded under its own code, so each appearing
		// exactly once is a stronger no-respawn-loop assertion than a shared count.
		const diags = readDiagnostics(root, "v1");
		assert.equal(diags.filter((d) => d.code === "launch_host").length, 1, "one original launch");
		assert.equal(diags.filter((d) => d.code === "host_adopted").length, 1, "one adopt-and-spawn");
		assert.ok(diags.some((d) => d.code === "host_recovered"), "recovery diagnostic recorded");

		const probe = await probeHost(replacement.socketPath, { expectedViewId: "v1", expectedInstanceId: replacement.instanceId });
		assert.equal(probe.classification, "ready");

		await teardownHost(root, "v1", service);
	} catch (err) {
		await teardownHost(root, "v1", testService(root)).catch(() => {});
		throw err;
	}
});
