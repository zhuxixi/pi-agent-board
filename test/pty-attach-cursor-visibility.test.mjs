import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SMOKE_SCRIPT = join(ROOT_DIR, "test-support", "cursor-visibility-smoke.ts");

// Issue #102: the projection must honor the child's DECTCEM state. pi-tui hides the
// hardware cursor (ESC[?25l) on nearly every frame, so an unconditional inverse block
// shows up as a ghost cell at the last diff-write/park position.
test("attach projection honors the child's cursor visibility (issue #102)", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SMOKE_SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.hiddenOnContentCellOmitsInverseBlock, true, "a hidden cursor must not paint an inverse block on a content cell");
	assert.equal(parsed.hiddenOnEmptyLineKeepsMarkerWithoutBlock, true, "a hidden cursor on an empty line keeps the marker but paints no block");
	assert.equal(parsed.hiddenPastEndOmitsInverseSpace, true, "a hidden cursor past the line content must not append an inverse space");
	assert.equal(parsed.visibleOnContentCellPaintsInverseBlock, true, "a visible cursor still paints the inverse block");
	assert.equal(parsed.visibleByDefaultOnContentCell, true, "an unknown DECTCEM state must keep today's visible behavior");
	assert.equal(parsed.visiblePastEndPaintsInverseSpace, true, "a visible cursor past the line content still appends an inverse space");
});
