import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assistantText,
	baseName,
	detectNeedsInput,
	firstSentence,
	relativeTime,
	toolPath,
	toolResultText,
	toolSummary,
	truncate,
} from "../src/core/heuristics.mjs";

test("assistantText joins text blocks, ignores tool calls", () => {
	const msg = {
		role: "assistant",
		content: [
			{ type: "text", text: "Hello." },
			{ type: "toolCall", name: "edit", arguments: {} },
			{ type: "text", text: "World." },
		],
	};
	assert.equal(assistantText(msg), "Hello.\nWorld.");
	assert.equal(assistantText({ content: "raw string" }), "raw string");
	assert.equal(assistantText(null), "");
});

test("detectNeedsInput: trailing question mark", () => {
	const r = detectNeedsInput("I did the thing. Which approach do you prefer?");
	assert.equal(r.needsInput, true);
	assert.match(r.question, /Which approach/);
});

test("detectNeedsInput: phrase trigger without question mark", () => {
	const r = detectNeedsInput("Please confirm before I delete the table.");
	assert.equal(r.needsInput, true);
	assert.match(r.question, /confirm/i);
});

test("detectNeedsInput: plain statement is not a blocker", () => {
	const r = detectNeedsInput("Done. All tests pass.");
	assert.equal(r.needsInput, false);
	assert.equal(r.question, null);
});

test("firstSentence", () => {
	assert.equal(firstSentence("First one. Second one."), "First one.");
	assert.equal(firstSentence(""), "");
});

test("toolSummary covers common tools", () => {
	assert.equal(toolSummary("edit", { file_path: "/a/b/src/auth.ts" }), "Editing auth.ts");
	assert.equal(toolSummary("bash", { command: "npm test" }), "Running tests");
	assert.equal(toolSummary("bash", { command: "tsc -p ." }), "Building");
	assert.equal(toolSummary("grep", { pattern: "TODO" }), "Searching /TODO/");
	assert.equal(toolSummary("read", {}), "Reading files");
});

test("toolPath prefers file_path/path then pattern", () => {
	assert.equal(toolPath({ file_path: "x" }), "x");
	assert.equal(toolPath({ path: "y" }), "y");
	assert.equal(toolPath({ pattern: "z" }), "z");
	assert.equal(toolPath({}), null);
});

test("baseName", () => {
	assert.equal(baseName("/a/b/c.ts"), "c.ts");
	assert.equal(baseName("c.ts"), "c.ts");
});

test("truncate adds ellipsis", () => {
	assert.equal(truncate("hello", 10), "hello");
	assert.equal(truncate("hello world", 5), "hell…");
	// CJK BMP chars are 1 UTF-16 unit each: unit-budget semantics unchanged.
	assert.equal(truncate("一二三四五六", 5), "一二三四…");
});

test("truncate never splits a surrogate pair", () => {
	// Cut point lands between the high and low surrogate of 👍: back off.
	assert.equal(truncate("a👍b", 3), "a…");
	// Long string whose cut lands inside the emoji (issue #39 repro shape):
	// units: 59 x + 10 CJK/punct + 👍(2) at idx 69-70; n=71 → end=70, the kept
	// slice ends on the high surrogate — must back off, not split the pair.
	const s = "x".repeat(59) + "完成 — LGTM " + "👍" + "y".repeat(10);
	const out = truncate(s, 71);
	assert.ok(!/[\uD800-\uDBFF]$/.test(out.replace(/…$/, "")), "no trailing lone high surrogate before ellipsis");
	assert.ok(out.endsWith("…") && out.length <= 71, "output within unit budget");
	// The pair survives whole when it fits the budget.
	assert.equal(truncate("👍", 2), "👍");
	assert.equal(truncate("a👍", 3), "a👍");
});

test("truncate strips lone surrogates from input", () => {
	assert.equal(truncate("ab\ud83d", 10), "ab"); // lone high surrogate, short path
	assert.equal(truncate("ab\ud83dcd", 4), "ab…"); // lone high surrogate, truncated path
	assert.equal(truncate("\udc4dab", 10), "ab"); // lone low surrogate, short path
});

test("relativeTime buckets", () => {
	const now = 1_000_000_000_000;
	assert.equal(relativeTime(now - 5_000, now), "5s");
	assert.equal(relativeTime(now - 120_000, now), "2m");
	assert.equal(relativeTime(now - 3 * 3600_000, now), "3h");
	assert.equal(relativeTime(now - 2 * 86400_000, now), "2d");
});

test("toolResultText extracts text blocks from AgentToolResult", () => {
	const result = {
		content: [
			{ type: "text", text: "line1" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "line2" },
		],
		details: { fullOutputPath: "/tmp/pi-bash-x.log" },
	};
	assert.equal(toolResultText(result), "line1\nline2");
});

test("toolResultText returns empty string for image-only content", () => {
	assert.equal(toolResultText({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }), "");
});

test("toolResultText returns empty string for object without content array", () => {
	assert.equal(toolResultText({ details: {} }), "");
	assert.equal(toolResultText({}), "");
});

test("toolResultText passes through plain strings (legacy events)", () => {
	assert.equal(toolResultText("ok"), "ok");
});

test("toolResultText handles nullish and scalar inputs", () => {
	assert.equal(toolResultText(null), "");
	assert.equal(toolResultText(undefined), "");
	assert.equal(toolResultText(42), "42");
	assert.equal(toolResultText(true), "true");
});
