import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-legacy-drag-scenario.ts");

// Component-level legacy drag coverage (issue #187): a motion-less press+release
// (Warp fast flick) must copy; the canonical move-ful gesture must copy the same
// text; a same-cell click must stay a click; the double-click path the fix routes
// through must still select and copy the word.
test("attach legacy drag: a motion-less press→release copies; clicks still behave as clicks", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const p = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(p.error, null, `scenario error: ${p.error}`);
	assert.equal(p.sawContent, true, "session content must render before the gesture (no empty-buffer race)");
	// A2
	assert.equal(p.motionlessOsc52, "fake pi ready", "a motion-less drag must copy the selected line via OSC 52");
	assert.equal(p.motionlessPrimary, "fake pi ready", "the copy must also mirror into X11 PRIMARY");
	assert.equal(p.motionlessSelectionSurvives, true, "the selection must survive the 260 ms pending-click timer");
	assert.equal(p.motionlessForwardedInput, false, "mouse events must never be forwarded to the child as input");
	// A3
	assert.equal(p.movefulOsc52, "fake pi ready", "the move-ful drag must copy the same text");
	assert.equal(p.movefulOsc52, p.motionlessOsc52, "both drag shapes must produce the same payload");
	// A4
	assert.equal(p.clickPressedSelection, true, "the press must create a selection (otherwise this case is vacuous)");
	assert.equal(p.clickOsc52, null, "a stationary click must not copy");
	assert.equal(p.clickSelectionCleared, true, "the pending-click timer must clear the selection");
	// A6
	assert.equal(p.doubleOsc52, "fake", "a double click must select and copy the word under the pointer");
	assert.equal(p.doubleSelectionIsWord, true, "the word selection must stay past the pending-click window");
});
