// test/pty-attach-delete-gate.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const GATE_SCRIPT = join(ROOT_DIR, "test-support", "detach-gate-smoke.ts");

// Issue #147: the in-attach delete gesture — arm/confirm/cancel/cancel-swallow
// branches, both mouse channels, encoding forms, and the teardown ordering.
test("attach delete gate: arm/confirm/cancel/teardown semantics", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", GATE_SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(out);
	for (const key of [
		"deleteArmShowsPrompt",
		"deleteArmHoldsKey",
		"deleteConfirmResolves",
		"deleteConfirmSendsNoControlFrame",
		"deleteLongNameKeepsHint",
		"deleteCancelForwards",
		"deleteSecondSwallowed",
		"deleteYAfterSwallowForwards",
		"deleteWheelChunkClears",
		"deleteHandleMouseClears",
		"deleteEncodingsArm",
		"deleteTeardownRestoresBeforeEnd",
	]) {
		assert.equal(parsed[key], true, `${key} must hold (issue #147 A3/A4)`);
	}
});
