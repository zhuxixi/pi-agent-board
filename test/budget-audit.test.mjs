/** F2 budget-audit gate (issue #95): fixtures must bite, the real tree must be clean. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { auditBudgets, parseTestBudgets } from "../scripts/budget-audit.mjs";

const FIX_A_VIOLATION = `async function waitFor(predicate, timeoutMs = 15000) { /* poll */ }
test("rule-a violation", { timeout: 20000 }, async () => {
	await waitFor(() => null, 20000);
});
`;
const FIX_A_PASS = `async function waitFor(predicate, timeoutMs = 15000) { /* poll */ }
test("rule-a pass", { timeout: 27000 }, async () => {
	await waitFor(() => null, 20000);
});
`;
const FIX_DEFAULT_VIOLATION = `async function waitFor(predicate, timeoutMs = 15000) { /* poll */ }
test("default violation", { timeout: 10000 }, async () => {
	await waitFor(() => null);
});
`;
const FIX_RULE_B_VIOLATION = `test("rule-b violation", async () => {
	const r = await resolveAttachTarget("v1", { timeoutMs: 150_000 });
	return r;
});
`;
const FIX_RULE_B_ESCAPE = `test("rule-b escape", async () => {
	const r = await resolveAttachTarget("v1", { timeoutMs: 150_000 }); // budget: knob
	return r;
});
`;

function violations(source) {
	return auditBudgets([{ path: "fixture.mjs", source }]);
}

test("A5: rule-a flags a declared timeout that cannot contain its wait", () => {
	const v = violations(FIX_A_VIOLATION);
	assert.equal(v.length, 1);
	assert.equal(v[0].rule, "rule-a");
	assert.match(v[0].message, /20000/);
});

test("A5: rule-a passes when the timeout covers max wait + margin", () => {
	assert.deepEqual(violations(FIX_A_PASS), []);
});

test("A5: the file's default wait participates when a call omits the budget", () => {
	const v = violations(FIX_DEFAULT_VIOLATION);
	assert.equal(v.length, 1);
	assert.equal(v[0].rule, "rule-a");
	assert.match(v[0].message, /15000/);
});

test("A5: an app-level deadline >= 30s needs a covering timeout or an escape", () => {
	const v = violations(FIX_RULE_B_VIOLATION);
	assert.equal(v.length, 1);
	assert.equal(v[0].rule, "rule-b");
	assert.match(v[0].message, /150000/);
});

test("A5: a // budget: escape line exempts the deadline", () => {
	assert.deepEqual(violations(FIX_RULE_B_ESCAPE), []);
});

test("A5: parseTestBudgets exposes the declared timeout and waits", () => {
	const parsed = parseTestBudgets(FIX_A_VIOLATION);
	assert.equal(parsed.fileDefaultWaitMs, 15000);
	assert.equal(parsed.tests[0].declaredTimeoutMs, 20000);
	assert.deepEqual(parsed.tests[0].waitLiterals, [20000]);
});

test("A5: the real test tree audits clean", () => {
	const dir = join(import.meta.dirname, "..");
	const sources = readdirSync(join(dir, "test"))
		// This gate's own fixtures are deliberately-violating shapes, not real tests;
		// it declares no real waits or deadlines of its own, so self-scanning is noise.
		.filter((f) => f.endsWith(".test.mjs") && f !== "budget-audit.test.mjs")
		.map((f) => ({ path: f, source: readFileSync(join(dir, "test", f), "utf8") }));
	assert.ok(sources.length > 50, "found the test tree");
	assert.deepEqual(auditBudgets(sources), []);
});
