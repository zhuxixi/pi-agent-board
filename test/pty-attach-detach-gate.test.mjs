import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const GATE_SCRIPT = join(ROOT_DIR, "test-support", "detach-gate-smoke.ts");

// Issue #91 Phase 6 (spec §D1/A3): the ← detach gate reads ONLY the pushed
// editorEmpty side channel — true detaches, false and null forward (explicit
// conservative policy), and a down socket escapes unconditionally. The
// terminal-buffer heuristics are deleted from the control chain entirely.
test("attach detach gate: ctrl+] passes through, ← reads only editor_state", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", GATE_SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.ctrlBracketPassesThrough, true, "ctrl+] must pass through to Pi unchanged");
	// Without a pushed editor_state (null) the gate must FORWARD — the buffer
	// shape must be irrelevant, so every heuristic-era buffer shape pins the
	// same conservative policy.
	assert.equal(parsed.leftStaysGatedOnNonEmptyLine, true, "← must forward without editor_state even when the buffer carries a draft-shaped line");
	assert.equal(parsed.leftForwardsOnGarbledBufferWithoutEditorState, true, "← must forward without editor_state even on a garbled replay buffer (escape is Ctrl+←)");
	assert.equal(parsed.leftForwardsOnEmptyEditorLineWithoutEditorState, true, "← must forward without editor_state even when the buffer's editor line looks empty");
	assert.equal(parsed.leftForwardsWithoutEditorStateEvenOnEmptyLookingBuffer, true, "← must forward without editor_state on an empty-looking buffer (only true detaches)");
	assert.equal(parsed.leftForwardsOnGlyphLineWithoutEditorState, true, "← must forward without editor_state on a prompt-glyph line (issue #69 fallback dissolved)");
	assert.equal(parsed.leftForwardsOnTableRowsWithoutEditorState, true, "← must forward without editor_state when the buffer holds table/quote glyph rows (issue #69 dissolved by D1)");
	assert.equal(parsed.leftForwardsOnContentGlyphWithoutEditorState, true, "← must forward without editor_state on a content glyph line (issue #69 dissolved by D1)");
	assert.equal(parsed.leftForwardsWithDiffHighlightWithoutEditorState, true, "← must forward without editor_state when chat-area diff inverse content is present (issue #103 dissolved by D1)");
	assert.equal(parsed.leftForwardsWithInverseBannerWithoutEditorState, true, "← must forward without editor_state when the inverse notification banner is present (issue #103 dissolved by D1)");
	assert.equal(parsed.leftForwardsOnNewStyleDraftWithoutReporter, true, "← must forward without editor_state on an untrusted new-style draft — conservative forward protects the draft");
	// The pushed side channel is authoritative in both directions.
	assert.equal(parsed.leftDetachesWhenEditorStateReportsEmpty, true, "← must detach when editor_state reports empty even if the buffer looks draft-bearing");
	assert.equal(parsed.leftForwardsWhenEditorStateReportsDraft, true, "← must be forwarded when editor_state reports a draft even if the buffer looks empty");
	assert.equal(parsed.leftHelloNullResetsStaleEditorState, true, "← must forward (conservative policy) when a hello resets a stale editor_state cache to null");
	// Escape guarantees that do not depend on the child's state at all.
	assert.equal(parsed.leftEscapesWhenDisconnected, true, "← must escape unconditionally while the socket is down (issue #48)");
	assert.equal(parsed.leftEscapesWhenSocketNeverConnected, true, "← must escape when the socket never connected — the key could never reach the child");
	assert.equal(parsed.leftDetachRestoresBeforeGracefulEnd, true, "← must restore before graceful socket end");
	assert.equal(parsed.ctrlLeftDetachesOnDraft, true, "Ctrl+← must detach even when editor_state reports a draft (issue #89)");
	assert.equal(parsed.ctrlLeftDetachesOnEmptyInput, true, "Ctrl+← must detach from an empty editor too (issue #89)");
	assert.equal(parsed.headerMentionsCtrlLeft, true, "the live header must advertise the Ctrl+← chord (issue #89)");
	assert.equal(parsed.minimumSizeAvoidsInvalidShrink, true, "minimum terminal size must avoid an invalid shrink");
	assert.equal(parsed.staleSocketEventsDoNotClearCurrent, true, "stale socket events must not clear a replacement connection");
});

const HEURISTIC_IDENTIFIERS = [
	"childInputLooksEmpty",
	"pickEditorAnchorLine",
	"isProbablyPiInputLine",
	"isProbablyEmptyPiInputLine",
	"resolveEditorEmpty",
];

function listSourceFiles(dir) {
	const entries = [];
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, name.name);
		if (name.isDirectory()) entries.push(...listSourceFiles(full));
		else if (/\.(ts|mjs|js)$/.test(name.name)) entries.push(full);
	}
	return entries;
}

// A3 (spec): the detach control call chain contains no screen-semantics
// heuristic — grep-level pin over the whole src/ tree.
test("detach control chain contains no terminal-buffer heuristics", () => {
	const offenders = [];
	for (const file of listSourceFiles(join(ROOT_DIR, "src"))) {
		const text = readFileSync(file, "utf8");
		for (const identifier of HEURISTIC_IDENTIFIERS) {
			if (text.includes(identifier)) offenders.push(`${file} :: ${identifier}`);
		}
	}
	assert.deepEqual(offenders, [], "src/ must not reference the deleted buffer heuristics");
});
