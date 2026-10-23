import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT_DIR, "test-support", "dashboard-selection-render.ts");

function runHarness() {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	return JSON.parse(out);
}

test("applyRowHighlight is a pure pass-through when unselected and wraps once when selected (issue #231)", () => {
	const parsed = runHarness();
	assert.equal(parsed.ok, true);
	assert.equal(parsed.unit.unselectedIdentical, true, "unselected input must come back byte-identical");
	assert.equal(parsed.unit.selectedWrapped, true, "selected input must be wrapped exactly once");
	assert.equal(parsed.unit.themeCallCount, 1, "the helper must call theme.bg once per selected row, never for unselected rows");
});
