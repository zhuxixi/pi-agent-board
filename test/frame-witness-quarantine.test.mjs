import assert from "node:assert/strict";
import test from "node:test";

import { indentedTestCaseBody } from "../test-support/test-source-scan.mjs";

const SAMPLE = [
	"for (const legacy of [false, true]) {",
	"\ttest(`one`, async () => {",
	"\t\tconst value = 1;",
	"\t});",
	"\ttest(`two`, async () => {",
	"\t\tconst value = 2;",
	"\t});",
	"}",
	"",
].join("\n");

test("A1: indentedTestCaseBody stops at the matching indented case boundary", () => {
	const body = indentedTestCaseBody(SAMPLE, "\ttest(`one`");
	assert.match(body, /const value = 1/);
	assert.doesNotMatch(body, /test\(`two`/);
	assert.ok(body.endsWith("\n\t});"));
});

test("A1: indentedTestCaseBody fails closed on an absent marker or closing boundary", () => {
	assert.throws(() => indentedTestCaseBody(SAMPLE, "\ttest(`missing`"), /case not found/);
	assert.throws(() => indentedTestCaseBody("\ttest(`open`, async () => {", "\ttest(`open`"), /case end not found/);
});
