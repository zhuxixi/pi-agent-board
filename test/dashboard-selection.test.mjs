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

test("renderRow paints the selected row from column 0 through the padded right edge (issue #231)", () => {
	const parsed = runHarness();
	const it = parsed.integration;
	assert.equal(it.selectedStartsAtCol0, true, "bg must open before the folder indent");
	assert.equal(it.selectedWidth, 160, "bg span must reach the padded right edge");
	assert.equal(it.unselectedHasNoOpener, true, "unselected rows must have no bg");
	assert.equal(it.selectedHasArrow, true, "the › cursor marker stays on the selected row");
	assert.equal(it.unselectedHasNoArrow, true, "no › on unselected rows");
	assert.equal(it.firstFrameBgCalls, 1, "exactly one row is painted per frame");
});

test("selected-row highlight coexists with select mode, peek, and narrow terminals (issue #231)", () => {
	const parsed = runHarness();
	const it = parsed.integration;
	assert.equal(it.selectMarkerPresent, true, "select mode's ◉ batch marker survives");
	assert.equal(it.selectHasBg, true, "select mode keeps the row highlight");
	assert.equal(it.peekHasNoOpener, true, "peek header is not highlighted");
	assert.ok(it.narrowMaxWidth <= 23, "no line may exceed the requested width");
	assert.equal(it.narrowLeaked, false, "narrow clipping must not leak bg into other rows");
});

test("unselected rows keep muted name/summary, not dim (issue #231 decision D4)", () => {
	const parsed = runHarness();
	assert.equal(parsed.integration.unselectedUsesMuted, true);
	assert.equal(parsed.integration.unselectedNameIsDim, false);
});
