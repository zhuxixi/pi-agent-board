/**
 * Static capture-wiring test (issue #178 spec §3.5, acceptance A3/A7).
 *
 * The flake postmortem only prints when a wait passes a capture thunk, so a
 * wait that silently loses its wiring re-opens the "red with no scene" gap
 * this issue exists to close. This test reads the real test sources and pins
 * three invariants:
 *
 *   1. every `await waitFor(` in the editor_state case carries a capture;
 *   2. the subscribe_terminal snapshot assertions are still present (deleting
 *      an assertion is not a way to go green);
 *   3. every `await waitFor(` in the control-reconcile A2 case carries a capture.
 *
 * Boundary: source-text level only. It does not prove that a failure actually
 * prints a scene — the flake-postmortem fixture tests and the integration
 * cases cover that. Its single job is to block silent rewiring regressions.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(PACKAGE_ROOT, rel), "utf8");

/**
 * Return the source of one top-level `test("<marker>", …)` case.
 *
 * The end is the first column-0 `});`, not a parenthesis balance: real source
 * comments in these files carry unbalanced parentheses (subscribe_terminal's
 * "…unsolicited hello on connect (now with the"), and a text scanner cannot
 * tell a comment from code. Top-level cases always end with a column-0 `});`
 * while the helper functions between them end with a column-0 `}`, so this
 * boundary is exact.
 * @param {string} source
 * @param {string} marker
 * @returns {string}
 */
export function testCaseBody(source, marker) {
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `case not found: ${marker}`);
	assert.ok(start === 0 || source[start - 1] === "\n", `marker is not at top level: ${marker}`);
	const close = source.indexOf("\n});", start);
	assert.notEqual(close, -1, `case end not found: ${marker}`);
	return source.slice(start, close + 4);
}

/**
 * Return the argument text of every `await waitFor(` call, with string literals
 * skipped and nested parentheses balanced.
 * @param {string} body
 * @returns {string[]}
 */
export function waitForCalls(body) {
	const needle = "await waitFor(";
	/** @type {string[]} */
	const calls = [];
	let i = 0;
	while ((i = body.indexOf(needle, i)) !== -1) {
		let depth = 1;
		let j = i + needle.length;
		/** @type {string | null} */
		let quote = null;
		for (; j < body.length && depth > 0; j += 1) {
			const ch = body[j];
			if (quote) {
				if (ch === "\\") j += 1;
				else if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") quote = ch;
			else if (ch === "(") depth += 1;
			else if (ch === ")") depth -= 1;
		}
		calls.push(body.slice(i + needle.length, j - 1));
		i = j;
	}
	return calls;
}

const PTY_RUNNER = "test/pty-runner.integration.test.mjs";
const CONTROL_RECONCILE = "test/control-reconcile.integration.test.mjs";

test("A7: waitForCalls parses nested calls, strings and a trailing capture", () => {
	const source = [
		'await waitFor(() => x.find((m) => m.type === "a, )(b"));',
		"await waitFor(() => hostReady(root, \"v1\"), 15000, capture);",
	].join("\n");
	const calls = waitForCalls(source);
	assert.equal(calls.length, 2);
	assert.match(calls[0], /^\(\) => x\.find/);
	assert.match(calls[1], /,\s*15000,\s*capture$/);
});

test("A7: testCaseBody stops at the case's own closing brace, not the next case", () => {
	const source = [
		'test("one", () => {',
		"\tconst a = 1;",
		"});",
		"",
		"// a helper defined between cases, with an unbalanced ( paren in a comment",
		"function helper() {",
		"\treturn await waitFor(() => x, 15000, capture);",
		"}",
		"",
		'test("two", () => {});',
		"",
	].join("\n");
	const body = testCaseBody(source, 'test("one"');
	assert.match(body, /const a = 1/);
	assert.doesNotMatch(body, /function helper/, "a trailing helper must not be swallowed");
	assert.doesNotMatch(body, /test\("two"/);
	assert.equal(waitForCalls(body).length, 0, "no wait belongs to this case");
});

test("A3/A7: every wait in the editor_state case carries a capture thunk", () => {
	const body = testCaseBody(read(PTY_RUNNER), 'test("pty-runner routes editor_state');
	const calls = waitForCalls(body);
	assert.ok(calls.length >= 6, `found the editor_state waits (${calls.length})`);
	for (const args of calls) {
		assert.match(args, /,\s*capture\s*$/, `wait without capture: ${args.trim().slice(0, 120)}`);
	}
});

test("A2/A7: the subscribe_terminal snapshot assertions are still executed", () => {
	const body = testCaseBody(read(PTY_RUNNER), 'test("subscribe_terminal:');
	assert.match(body, /includes\("fake pi ready"\)/, "the frame assertion must not be deleted");
	assert.match(body, /begin\.snapshotSeq >= 1/, "the baseline assertion must not be deleted");
});

test("A7: every wait in the control-reconcile A2 case carries a capture thunk", () => {
	const body = testCaseBody(read(CONTROL_RECONCILE), 'test("A2: reconnect wires hello');
	const calls = waitForCalls(body);
	assert.ok(calls.length >= 13, `found the A2 waits (${calls.length})`);
	for (const args of calls) {
		assert.match(args, /,\s*capture\s*$/, `wait without capture: ${args.trim().slice(0, 120)}`);
	}
});
