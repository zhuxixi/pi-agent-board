import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-legacy-drag-drift-scenario.ts");

// Drift negative control (issue #187, finding R1-G1): with the session streaming,
// a stationary click maps press and release to different BUFFER lines while the
// screen cell is identical. Classifying on screen cells keeps it a click; a
// buffer-space comparison would copy and never clear. The case asserts the buffer
// really moved, otherwise it proves nothing.
test("attach legacy drag drift: a stationary click stays a click while the viewport drifts", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const p = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(p.error, null, `scenario error: ${p.error}`);
	assert.equal(p.sawContent, true, "streaming content must render before the gesture");
	assert.equal(p.bufferGrew, true, `the buffer must have drifted during the gesture (grew ${p.bufferGrowth} lines)`);
	assert.equal(p.pressCreatedSelection, true, "the press must create a selection (otherwise this case is vacuous)");
	assert.equal(p.osc52, null, "a stationary click must not copy, however far the viewport drifted");
	assert.equal(p.selectionCleared, true, "the pending-click timer must clear the selection");
	assert.equal(p.mirroredWrites, 0, "no PRIMARY write may happen for a click");
});
