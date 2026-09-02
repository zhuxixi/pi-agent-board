import assert from "node:assert/strict";
import { test } from "node:test";
import { isProbablyEmptyPiInputLine, isProbablyPiInputLine, resolveEditorEmpty } from "../src/core/pty-input.mjs";

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
