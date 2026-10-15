import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-x10-scenario.ts");

// Component-level coverage (issue #188): the REAL PtyAttachComponent against a
// REAL runner socket with a fake PTY, driven with X10-encoded mouse reports
// through the legacy handleInput path. Pins the copy-on-release effect (#188)
// and the unchanged click / right-button / wheel branches.
test("attach X10 mouse: drag release copies; click, right button and wheel do not (issue #188)", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.sawContent, true, "session content must render before mouse dispatch");

	// A4: the X10 drag copies exactly once, with the selected text as payload.
	assert.deepEqual(parsed.cases.drag.osc52, ["fake pi ready"], "X10 drag release must copy the selection");

	// A5: a same-point click copies nothing and its highlight clears after the window.
	assert.deepEqual(parsed.cases.click.osc52, []);
	assert.equal(parsed.cases.click.paintedRightAfterRelease, true, "the click keeps its 1-cell highlight during the pending-click window");
	assert.equal(parsed.cases.click.paintedAfterWindow, false, "the pending-click window clears the click highlight");

	// A5: right press + release copies nothing.
	assert.deepEqual(parsed.cases.rightButton.osc52, []);

	// A5: an X10 wheel report the local viewport cannot use is forwarded raw.
	assert.deepEqual(parsed.cases.wheel.osc52, []);
	assert.deepEqual(parsed.cases.wheel.forwarded, ["\x1b[M`!\""]);

	assert.equal(parsed.ok, true);
});
