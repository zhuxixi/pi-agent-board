import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const GATE_SCRIPT = join(ROOT_DIR, "test-support", "detach-gate-smoke.ts");

// Issue #42: a stale/garbled attach buffer must not trap the user — ctrl+]
// remains Pi input, while ← keeps its empty-input detach gate.
test("attach detach gate: ctrl+] passes through, ← keeps its gate", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", GATE_SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.ctrlBracketPassesThrough, true, "ctrl+] must pass through to Pi unchanged");
	assert.equal(parsed.leftStaysGatedOnNonEmptyLine, true, "← must stay gated while attached when the input line looks non-empty");
	assert.equal(parsed.leftEscapesWhenDisconnected, true, "← must escape unconditionally while the socket is down (issue #48)");
	assert.equal(parsed.leftDetachesOnEmptyInput, true, "← must still detach on an empty input line");
	assert.equal(parsed.leftEscapesOnGarbledBuffer, true, "← must escape on a garbled replay buffer with no recoverable editor line");
	assert.equal(parsed.leftDetachesWhenCursorOffEmptyInputLine, true, "← must detach when the editor line is empty even if the cursor sits on a working line");
	assert.equal(parsed.leftDetachesOnEmptyInputWithoutFakeCursor, true, "← must detach when an empty editor line renders no fake cursor");
	assert.equal(parsed.leftDetachesOnGlyphLineWithoutFakeCursor, true, "← must detach via the glyph fallback when a glyph line renders without a fake cursor");
	assert.equal(parsed.leftEditorStateOverridesHeuristicEmpty, true, "← must detach when editor_state says empty even if the buffer looks non-empty");
	assert.equal(parsed.leftEditorStateBlocksDetachOnDraft, true, "← must be forwarded when editor_state reports a draft even if the buffer looks empty");
	assert.equal(parsed.leftHelloNullResetsStaleEditorState, true, "← must fall back to the heuristic when a hello resets a stale editor_state cache to null");
	assert.equal(parsed.leftDetachRestoresBeforeGracefulEnd, true, "← must restore before graceful socket end");
	assert.equal(parsed.minimumSizeAvoidsInvalidShrink, true, "minimum terminal size must avoid an invalid shrink");
	assert.equal(parsed.staleSocketEventsDoNotClearCurrent, true, "stale socket events must not clear a replacement connection");
});
