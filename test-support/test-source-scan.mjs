/**
 * Pure source scanners shared by static tests.
 *
 * These read real test sources as text and pin invariants at the source level
 * (see test/wait-capture-wiring.test.mjs for the wiring guards). They are pure
 * string functions with no I/O so each guard test stays a unit test.
 */
import assert from "node:assert/strict";

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

/**
 * Return the source of one tab-indented `test("<marker>", …)` case.
 * Missing markers and closing boundaries throw so an empty scan cannot pass.
 * @param {string} source
 * @param {string} marker
 * @returns {string}
 */
export function indentedTestCaseBody(source, marker) {
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `case not found: ${marker}`);
	assert.ok(start === 0 || source[start - 1] === "\n", `marker is not at line start: ${marker}`);
	const close = source.indexOf("\n\t});", start);
	assert.notEqual(close, -1, `case end not found: ${marker}`);
	return source.slice(start, close + 5);
}
