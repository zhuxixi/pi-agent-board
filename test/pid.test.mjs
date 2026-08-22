import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { isAlive, killProcess } from "../src/core/pid.mjs";

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
