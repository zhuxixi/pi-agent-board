import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "dashboard-tui-modes.ts");

// Issue #258 A4: the full dispatch chain — synthetic SGR drag/release into the
// real TuiAltScreen, overlay hit-test to the board's handleMouse, deferred
// settle clearing pi's selection. Non-empty precondition first (R1-G3).
test("dashboard tui modes: fullscreen SGR drag-select settles through the board", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const results = JSON.parse(out);
	assert.deepEqual(results.map(({ mode }) => mode), ["regular", "fullscreen"]);
	const fullscreen = results.find((r) => r.mode === "fullscreen");
	assert.equal(fullscreen.ok, true);
	assert.equal(fullscreen.mouseSettleOk, true, "fullscreen run must pass the SGR settle case");
	const regular = results.find((r) => r.mode === "regular");
	assert.equal(regular.mouseSettleOk, null, "regular mode has no fullscreen selection seam");
});
