import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-mixed-input-scenario.ts");

// Component-level coverage (issue #189): the REAL PtyAttachComponent against a REAL runner socket
// and a fake PTY. Asserts that a read mixing mouse reports with terminal reports is dispatched per
// segment: the gesture still copies (OSC 52) and keeps its selection, no raw mouse bytes reach the
// child, a spontaneous report clears neither selection nor viewport, and the mid-read detach guard
// stops the rest of the read.
test("attach mixed input: per-segment dispatch keeps copy/selection/viewport; reports pass through", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 120_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	for (const [name, passed] of Object.entries(parsed.checks)) {
		assert.equal(passed, true, `check failed: ${name}`);
	}
});
