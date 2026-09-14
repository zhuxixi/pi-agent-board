import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-fallback-scenario.ts");

function runScenario(mode) {
	const out = execFileSync(
		process.execPath,
		["--experimental-transform-types", SCENARIO],
		{ encoding: "utf8", timeout: 60_000, env: { ...process.env, SCENARIO_MODE: mode } },
	);
	return JSON.parse(out.trim().split("\n").filter(Boolean).pop());
}

// Task 3 fix wave (issue #91 phase 4 review): the three fallback-path findings,
// each pinned at the component level against a scripted fake runner socket.

test("F1: fast frame_version_mismatch fallback still arms the legacy jiggle (resize goes out)", () => {
	const r = runScenario("mismatch");
	assert.equal(r.error, null, `scenario error: ${r.error}`);
	assert.equal(r.subscribeCount, 1, "exactly one subscribe (mismatch consumes the probe)");
	assert.ok(r.resizes > 0, "legacy jiggle must arm after the early-decided fallback (resize observed)");
	assert.equal(r.ok, true);
});

test("F2: post-settle protocol→legacy downgrade re-arms the jiggle chain", () => {
	const r = runScenario("downgrade");
	assert.equal(r.error, null, `scenario error: ${r.error}`);
	assert.equal(r.settled, true, "precondition: attach settle finished before the recovery storm");
	assert.equal(r.resizesBeforeStorm, 0, "protocol phase sends zero resizes (mode discriminator)");
	assert.ok(r.resizes > r.resizesBeforeStorm, "downgrade after settle must re-arm the jiggle (resize observed)");
	assert.ok((r.subscribeCount ?? 0) > 1, "recovery storm drove at least one resubscribe");
	assert.equal(r.ok, true);
});

test("F3: reconnect to a restarted runner (empty baseline) wipes the dead session's frame", () => {
	const r = runScenario("restart-empty");
	assert.equal(r.error, null, `scenario error: ${r.error}`);
	assert.equal(r.sawMarker, true, "precondition: dead session frame hydrated into the local buffer");
	assert.equal(r.reconnected, true, "component must reconnect and resubscribe after the disconnect");
	assert.ok(Number.isInteger(r.reconnectSinceSeq), "protocol reconnect resumes via sinceSeq (no probe)");
	assert.equal(r.wiped, true, "empty baseline after reconnect must wipe the stale frame (term.reset)");
	assert.equal(r.ok, true);
});
