/**
 * Budget audit for test files (issue #95 F2).
 *
 * Mechanical discipline: a test's declared timeout must be able to contain
 * its waits (rule a), and an app-level deadline a test drives must be covered
 * by the test's own budget unless explicitly escaped (rule b). Pure functions
 * only — the gate lives in test/budget-audit.test.mjs, which runs these over
 * fixture sources AND the real test tree.
 */

/** Strip escaped lines (`// budget: <reason>`) from a source. @param {string} source @returns {string} */
export function stripEscapedLines(source) {
	return source.split("\n").filter((line) => !line.includes("// budget:")).join("\n");
}

/** @param {string} source @returns {number | null} */
export function parseFileDefaultWaitMs(source) {
	// The default lives in the parameter list: `async function waitFor(predicate, timeoutMs = 15_000, ...) {`.
	const m = /async function waitFor\([^)]*?timeoutMs\s*=\s*([0-9_]+)[^)]*\)\s*\{/.exec(source);
	return m ? Number(m[1].replace(/_/g, "")) : null;
}

/** Balanced-paren argument text for the call whose `(` sits at fromIndex. @param {string} text @param {number} fromIndex @returns {string | null} */
function callArgs(text, fromIndex) {
	let depth = 0;
	for (let i = fromIndex; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")") {
			depth--;
			if (depth === 0) return text.slice(fromIndex + 1, i);
		}
	}
	return null;
}

/** Top-level (depth-0) comma-separated arguments of a call's argument text. @param {string} args @returns {string[]} */
function splitTopLevelArgs(args) {
	const parts = [];
	let depth = 0;
	let current = "";
	for (const ch of args) {
		if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
		if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
		} else current += ch;
	}
	parts.push(current);
	return parts;
}

/**
 * Distinct numeric budget literals a `waitFor(...)` call declares: the trailing
 * numeric argument (`waitFor(pred, 30_000)` / `waitFor(pred, 30_000, 50)`) plus
 * the first top-level numeric argument, which covers
 * `waitFor(pred, 30_000, capture)` shapes where the trailing regex only ever
 * sees the capture thunk — and the `(pred, timeout, interval)` shape, whose
 * trailing number is the interval, not the budget. Empty when the call omits
 * the budget and inherits the file default.
 * @param {string} args @returns {number[]}
 */
function waitLiteralsIn(args) {
	const out = [];
	const add = (raw) => {
		const value = Number(raw.replace(/_/g, ""));
		if (!out.includes(value)) out.push(value);
	};
	const trailing = /,\s*([0-9_]+)\s*,?\s*$/.exec(args.trim());
	if (trailing) add(trailing[1]);
	const first = splitTopLevelArgs(args).map((a) => a.trim()).find((a) => /^[0-9_]+$/.test(a));
	if (first) add(first);
	return out;
}

/**
 * @param {string} source
 * @returns {{ fileDefaultWaitMs: number | null, tests: Array<{ name: string, declaredTimeoutMs: number | null, waitLiterals: number[], hasDefaultWaitCall: boolean, deadlineLiterals: number[] }> }}
 */
export function parseTestBudgets(source) {
	const clean = stripEscapedLines(source);
	const fileDefaultWaitMs = parseFileDefaultWaitMs(clean);
	const tests = [];
	const starts = [];
	const re = /^(?:export )?test\(/gm;
	for (let m = re.exec(clean); m; m = re.exec(clean)) starts.push(m.index);
	for (let i = 0; i < starts.length; i++) {
		const chunk = clean.slice(starts[i], starts[i + 1] ?? clean.length);
		const nameM = /^(?:export )?test\("([^"]+)"/.exec(chunk);
		const toM = /timeout:\s*([0-9_]+)/.exec(chunk.slice(0, 400));
		const waitLiterals = [];
		let hasDefaultWaitCall = false;
		const waitRe = /waitFor\(/g;
		for (let w = waitRe.exec(chunk); w; w = waitRe.exec(chunk)) {
			const args = callArgs(chunk, w.index + "waitFor".length);
			if (args == null) continue;
			const literals = waitLiteralsIn(args);
			if (literals.length > 0) waitLiterals.push(...literals);
			else hasDefaultWaitCall = true;
		}
		const deadlineLiterals = [];
		const dlRe = /timeoutMs:\s*([0-9_]+)/g;
		for (let d = dlRe.exec(chunk); d; d = dlRe.exec(chunk)) deadlineLiterals.push(Number(d[1].replace(/_/g, "")));
		tests.push({ name: nameM ? nameM[1] : `<test ${i + 1}>`, declaredTimeoutMs: toM ? Number(toM[1].replace(/_/g, "")) : null, waitLiterals, hasDefaultWaitCall, deadlineLiterals });
	}
	return { fileDefaultWaitMs, tests };
}

/**
 * Rule (a): declared timeout >= max(single explicit wait, file default when a
 * call omits it) + margin, margin = max(5000, wait / 3).
 * Rule (b): an app deadline >= 30s needs a declared timeout >= it (escape via
 * `// budget:` lines, stripped upstream).
 * @param {Array<{ path: string, source: string }>} sources
 * @returns {Array<{ path: string, test: string, rule: string, message: string }>}
 */
export function auditBudgets(sources) {
	const violations = [];
	for (const { path, source } of sources) {
		const parsed = parseTestBudgets(source);
		for (const t of parsed.tests) {
			const waits = [...t.waitLiterals];
			if (t.hasDefaultWaitCall && parsed.fileDefaultWaitMs != null) waits.push(parsed.fileDefaultWaitMs);
			if (t.declaredTimeoutMs != null && waits.length > 0) {
				const maxWait = Math.max(...waits);
				const margin = Math.max(5000, Math.round(maxWait / 3));
				if (t.declaredTimeoutMs < maxWait + margin) violations.push({ path, test: t.name, rule: "rule-a", message: `declared timeout ${t.declaredTimeoutMs}ms cannot contain max wait ${maxWait}ms + margin ${margin}ms` });
			}
			for (const d of t.deadlineLiterals) {
				if (d >= 30000 && (t.declaredTimeoutMs == null || t.declaredTimeoutMs < d)) violations.push({ path, test: t.name, rule: "rule-b", message: `app deadline ${d}ms needs a declared test timeout >= it (or a // budget: escape)` });
			}
		}
	}
	return violations;
}
