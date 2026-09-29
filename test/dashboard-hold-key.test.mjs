import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "hold-key-wrap.ts");

test("h key submits mark_holding / clear_holding across list, peek and session modes (issue #145)", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], { encoding: "utf-8", timeout: 30_000 });
	assert.deepEqual(JSON.parse(out), [
		["mark_holding", "v1"],
		["clear_holding", "v2"],
		["mark_holding", "v2"],
		["clear_holding", "v2"],
	]);
});
