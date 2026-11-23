import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { indentedTestCaseBody, waitForCalls } from "../test-support/test-source-scan.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET = "test/attach-frame-witness.integration.test.mjs";
const read = (rel) => readFileSync(join(PACKAGE_ROOT, rel), "utf8");
const targetCase = () => indentedTestCaseBody(read(TARGET), "\ttest(`internal marker failure revokes capability");

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

test("A2: the shared wait keeps its 15000 ms default and 25 ms interval", () => {
	const source = read(TARGET);
	assert.match(source, /async function waitFor\(predicate, timeoutMs = 15000, capture = null\)/);
	assert.match(source, /waitForWithPostmortem\(predicate, \{ timeoutMs, intervalMs: 25, capture \}\)/);
});

test("A3: both marker-failure waits carry the named postmortem capture", () => {
	const calls = waitForCalls(targetCase());
	assert.equal(calls.length, 2);
	for (const args of calls) assert.match(args, /,\s*capture\s*$/);
});

test("A4: only the legacy branch carries the temporary issue #95 skip", () => {
	const body = targetCase();
	assert.match(body, /skip:\s*legacy\s*\?\s*"issue #95[^"]*"\s*:\s*undefined/);
	assert.match(body, /temporary quarantine/);
	assert.match(body, /restore after process-phase serialization/);
});

test("A5: both capability-loss assertions remain in the parameterized case", () => {
	const body = targetCase();
	assert.match(body, /msg\.status\?\.frameWitness\?\.enabled === false/);
	assert.match(body, /readHost\(root, viewId\)\?\.frameWitness\?\.enabled === false/);
});
