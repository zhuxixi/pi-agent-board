import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { captureStartToken, currentProcessIdentity, isAlive, killProcess } from "../src/core/pid.mjs";

/** Spawn a short-lived child that stays alive until killed. */
function spawnSleep(ms = 30_000) {
	return spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio: "ignore" });
}

function waitExit(child, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("child did not exit in time")), timeoutMs);
		child.on("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

test("isAlive reports true for a live child pid", async () => {
	const child = spawnSleep();
	try {
		assert.equal(isAlive(child.pid), true);
	} finally {
		child.kill("SIGKILL");
		await waitExit(child);
	}
});

test("isAlive reports false for a dead pid and invalid values", async () => {
	const child = spawnSleep();
	const pid = child.pid;
	child.kill("SIGKILL");
	await waitExit(child);
	assert.equal(isAlive(pid), false);
	assert.equal(isAlive(null), false);
	assert.equal(isAlive(undefined), false);
	assert.equal(isAlive(0), false);
	assert.equal(isAlive(-1), false);
});

test("killProcess terminates a live child and is a no-op for dead pids", async () => {
	const child = spawnSleep();
	killProcess(child.pid, 200);
	await waitExit(child);
	// No-op on an already-dead pid must not throw.
	killProcess(child.pid, 200);
	// Give the deferred SIGKILL timer a chance to fire harmlessly.
	await new Promise((resolve) => setTimeout(resolve, 300));
});

test("killProcess escalates to SIGKILL when the child ignores SIGTERM", async () => {
	const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"], {
		stdio: "ignore",
	});
	killProcess(child.pid, 150);
	await waitExit(child, 5_000);
});

test("captureStartToken is stable for a live pid and null otherwise", () => {
	if (process.platform === "linux") {
		const token = captureStartToken(process.pid);
		assert.equal(typeof token, "string");
		assert.ok(token.length > 0, "starttime token must be non-empty on Linux");
		assert.equal(captureStartToken(process.pid), token, "stable across calls");
		assert.equal(captureStartToken(99999999), null, "dead pid has no token");
	} else {
		assert.equal(captureStartToken(process.pid), null, "non-Linux platforms cannot capture a start token");
	}
	assert.equal(captureStartToken(0), null);
	assert.equal(captureStartToken(null), null);
	assert.equal(captureStartToken(undefined), null);
});

test("currentProcessIdentity stamps this process", () => {
	const identity = currentProcessIdentity();
	assert.equal(identity.pid, process.pid);
	assert.equal(identity.startToken, captureStartToken(process.pid));
});
