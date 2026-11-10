import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "dashboard-selection-settle-scenario.ts");

// Issue #258: the board must settle pi's fullscreen selection after
// copy-on-select, through the same shared core the attach view uses.
test("dashboard selection settle: board observes mouse, defers settle, gates on dispose", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.releaseUndefined, true, "handleMouse must never consume (returns undefined)");
	assert.equal(parsed.listClears, 1, "list-mode release clears pi's selection exactly once");
	assert.equal(parsed.listRenders, 1, "a successful clear schedules exactly one repaint");
	assert.equal(parsed.coalescedClears, 0, "a release+press in one tick must not clear the new gesture");
	assert.equal(parsed.nonEndingClears, 0, "right/middle/move/wheel events never settle");
	assert.equal(parsed.filterMode, true, "case 4 must actually enter filter mode");
	assert.equal(parsed.filterClears, 1, "editor-bearing mode (filter) settles the same way (D6)");
	assert.equal(parsed.launchMode, true, "case 5 must actually enter launch mode");
	assert.equal(parsed.launchClears, 1, "editor-bearing mode (launch) settles the same way (D6)");
	assert.equal(parsed.disposeRaceReads, 0, "dispose() before flush blocks before any host read (R2-D1)");
	assert.equal(parsed.disposeRaceClears, 0, "dispose() before flush must not clear");
	assert.equal(parsed.disposeRaceRenders, 0, "dispose() before flush must not repaint");
});
