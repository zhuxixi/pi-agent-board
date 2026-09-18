import assert from "node:assert/strict";
import { test } from "node:test";
import { isProbablyEmptyPiInputLine, isProbablyPiInputLine, pickEditorAnchorLine, resolveEditorEmpty } from "../src/core/pty-input.mjs";

test("isProbablyEmptyPiInputLine accepts empty Pi prompt lines", () => {
	assert.equal(isProbablyEmptyPiInputLine("› "), true);
	assert.equal(isProbablyEmptyPiInputLine("  ┃   "), true);
	assert.equal(isProbablyEmptyPiInputLine("  │   "), true);
});

test("isProbablyEmptyPiInputLine rejects prompt lines containing draft text", () => {
	assert.equal(isProbablyEmptyPiInputLine("› hello"), false);
	assert.equal(isProbablyEmptyPiInputLine("  ┃ edit me"), false);
	assert.equal(isProbablyEmptyPiInputLine("  │ second line"), false);
});

test("isProbablyPiInputLine recognizes Pi prompt / continuation lines", () => {
	assert.equal(isProbablyPiInputLine("> "), true);
	assert.equal(isProbablyPiInputLine("  ┃ edit me"), true);
	assert.equal(isProbablyPiInputLine("  │ second line"), true);
	assert.equal(isProbablyPiInputLine("› draft"), true);
});

test("isProbablyPiInputLine rejects content lines and empty lines", () => {
	assert.equal(isProbablyPiInputLine("chat content"), false);
	assert.equal(isProbablyPiInputLine("────── ◊◊ ──────"), false);
	assert.equal(isProbablyPiInputLine(""), false);
	assert.equal(isProbablyPiInputLine("   "), false);
});

test("resolveEditorEmpty prefers the pushed editor state, falls back on null/undefined", () => {
	assert.equal(resolveEditorEmpty(true, false), true);
	assert.equal(resolveEditorEmpty(false, true), false);
	assert.equal(resolveEditorEmpty(null, true), true);
	assert.equal(resolveEditorEmpty(null, false), false);
	assert.equal(resolveEditorEmpty(undefined, true), true);
});

test("pickEditorAnchorLine trusts a single inverse char on a glyph line (legacy draft)", () => {
	assert.deepEqual(pickEditorAnchorLine([{ text: "> 草稿", inverseCharCount: 1 }]), { empty: false });
	assert.deepEqual(pickEditorAnchorLine([{ text: "> ", inverseCharCount: 1 }]), { empty: true });
});

test("pickEditorAnchorLine trusts a single inverse char on a blank non-glyph line (new-style fake cursor)", () => {
	assert.deepEqual(pickEditorAnchorLine([{ text: "", inverseCharCount: 1 }]), { empty: true });
	assert.deepEqual(pickEditorAnchorLine([{ text: "   ", inverseCharCount: 1 }]), { empty: true });
});

test("pickEditorAnchorLine skips multi-char inverse chat content (issue #103 scenarios H/I)", () => {
	const diff = { text: "+ 65 ## R2 · #822 新 step 挂链顺序调研", inverseCharCount: 15 };
	const banner = { text: " Session saved ", inverseCharCount: 15 };
	assert.equal(pickEditorAnchorLine([diff]), null);
	assert.equal(pickEditorAnchorLine([banner]), null);
	// bottom-up order: the banner sits below the editor line, so a later candidate wins
	assert.deepEqual(pickEditorAnchorLine([banner, { text: "", inverseCharCount: 1 }]), { empty: true });
});

test("pickEditorAnchorLine skips a new-style draft line and keeps scanning (R1 trade-off)", () => {
	// Text + a single inverse fake cursor, no prompt glyph: deliberately untrusted
	// so the escape chain still releases the user (spec §2.1).
	assert.equal(pickEditorAnchorLine([{ text: "草稿", inverseCharCount: 1 }]), null);
	// …but a trusted editor line above it still anchors.
	assert.deepEqual(pickEditorAnchorLine([{ text: "草稿", inverseCharCount: 1 }, { text: "> ", inverseCharCount: 1 }]), { empty: true });
});

test("pickEditorAnchorLine ignores zero-count, malformed and empty input", () => {
	assert.equal(pickEditorAnchorLine([{ text: "  ", inverseCharCount: 0 }]), null);
	assert.equal(pickEditorAnchorLine([{}]), null);
	assert.equal(pickEditorAnchorLine([]), null);
	assert.equal(pickEditorAnchorLine(undefined), null);
});
