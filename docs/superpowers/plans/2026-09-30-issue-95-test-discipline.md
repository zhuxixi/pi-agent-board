# Issue #95 Test-Discipline (F3→F2→F4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give issue #95's flaky real-process tests a failure black-box (F3 postmortem), a mechanical budget-discipline gate (F2 audit), and test-only ladder knobs (F4) — all on one branch, verified by A5/A6/A7 plus `npm run verify`.

**Architecture:** F3 adds a pure formatter + capture shell + waitFor wrapper in `test-support/` and adopts it in the four flaky files' local `waitFor` helpers (optional `capture` thunk threaded to the known-flaky call sites). F2 is a pure source-audit script wired as a test over fixtures AND the real tree. F4 converts six wall-clock ladder constants to dynamic test-scoped env readers (use-site reads, exported constants kept for compatibility).

**Tech Stack:** Node.js 20+ ESM (.mjs), JSDoc types, `node:test` + `assert/strict`, tabs.

**Spec:** `docs/superpowers/specs/2026-09-30-issue-95-test-discipline-design.md` (refreshed; F1/A1–A4/A10 already delivered by #153).

## Global Constraints

- Tabs; English comments; conventional commits ending `(issue #95)`.
- No wall-clock widening: no test timeout or wait budget may grow beyond rule-derived values; the 40→90→150s pattern is retired.
- `.github/workflows/ci.yml` untouched. `CHANGELOG.md` never hand-edited.
- Production behavior byte-identical when knobs are unset; `AGENT_BOARD_TEST_*` naming only.
- Fixtures self-contained under mkdtemp roots removed in `finally`; never mutate `~/.pi/agent/agent-board`.
- All work in this worktree only; `npm run verify` must exit 0 at branch head.

## Review Focus

1. **Postmortem must not change waitFor's success semantics** — the wrapper returns the predicate value identically; only the timeout path throws. Pinned: Task 1's return-value tests + Task 2's suites staying green.
2. **A thrown postmortem must still contain the legacy "timed out waiting" prefix** — anything grepping old output keeps working. Pinned: Task 1 unit test asserting the prefix.
3. **The audit must not false-positive on the untouched real tree** — pinned by Task 3's real-tree zero-violations assertion; planted fixtures prove both rules bite.
4. **Knob readers must be dynamic at use sites** (module-load-time evaluation would make in-process test knobs dead) — pinned: Task 4 requires use-site reader calls, and Task 5's A7 test sets env AFTER import and must observe compressed behavior.
5. **Invalid knob values fall back to defaults with a one-shot warn** — never NaN into the ladders. Pinned: Task 4 unit tests.

---

### Task 1: F3 core — flake-postmortem module

**Files:**
- Create: `test-support/flake-postmortem.mjs`
- Test: `test/flake-postmortem.test.mjs`

**Interfaces:**
- Produces: `formatPostmortem(snapshot) → string` (pure), `capturePostmortem(root, viewId, runId=null) → snapshot` (I/O shell), `waitForWithPostmortem(predicate, opts) → Promise<value>` (throws on timeout with the postmortem attached).

- [ ] **Step 1: Write the failing tests** — `test/flake-postmortem.test.mjs`:

```js
/** F3 unit tests (issue #95): the flake black-box. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createView } from "../src/core/store.mjs";
import { capturePostmortem, formatPostmortem, waitForWithPostmortem } from "../test-support/flake-postmortem.mjs";

test("A6: formatPostmortem renders the last-observed block deterministically", () => {
	const text = formatPostmortem({
		status: { semanticState: "working", processState: "alive", endedAt: null, pid: 4242 },
		state: { semanticState: "working", currentRunId: "run_1" },
		host: null,
		diagnosticsTail: [{ code: "runner_start", at: 1 }, { code: "stop_latch_armed", at: 2 }],
		journalTail: ["{\"kind\":\"run_started\"}"],
	});
	assert.match(text, /flake postmortem/);
	assert.match(text, /"semanticState":"working"/);
	assert.match(text, /stop_latch_armed/);
	assert.match(text, /run_started/);
	assert.doesNotMatch(text, /undefined/);
});

test("A6: formatPostmortem marks absent artifacts explicitly", () => {
	const text = formatPostmortem({ status: null, state: null, host: null, diagnosticsTail: [], journalTail: [] });
	assert.match(text, /status: <absent>/);
	assert.match(text, /state: <absent>/);
	assert.match(text, /host: <absent>/);
});

test("A6: waitForWithPostmortem returns the predicate value on success", async () => {
	const value = await waitForWithPostmortem(() => 42, { timeoutMs: 100, intervalMs: 5 });
	assert.equal(value, 42);
});

test("A6: a timeout throws with the legacy prefix plus the postmortem block", async () => {
	let captured = 0;
	const err = await waitForWithPostmortem(() => false, {
		timeoutMs: 30,
		intervalMs: 5,
		capture: () => {
			captured += 1;
			return formatPostmortem({ status: { semanticState: "working", endedAt: null }, state: null, host: null, diagnosticsTail: [], journalTail: [] });
		},
	}).then(
		() => null,
		(e) => e,
	);
	assert.ok(err instanceof Error, "timeout throws");
	assert.match(err.message, /^timed out waiting/);
	assert.match(err.message, /flake postmortem/);
	assert.match(err.message, /"semanticState":"working"/);
	assert.equal(captured, 1, "capture runs exactly once, at timeout");
});

test("A6: a timeout without a capture thunk still throws the legacy error", async () => {
	const err = await waitForWithPostmortem(() => false, { timeoutMs: 20, intervalMs: 5 }).then(
		() => null,
		(e) => e,
	);
	assert.ok(err instanceof Error);
	assert.equal(err.message, "timed out waiting");
});

test("A6: capturePostmortem reads the real artifacts from a fixture root", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pm-"));
	try {
		createView(root, { id: "v", name: "t", cwd: root });
		const snap = capturePostmortem(root, "v", null);
		assert.ok(snap.state, "state.json captured");
		assert.equal(snap.status, null, "no run status without runId");
		assert.deepEqual(snap.diagnosticsTail, []);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 2: Run to verify RED** — `node --test test/flake-postmortem.test.mjs` → all fail (`Cannot find module .../flake-postmortem.mjs`).
- [ ] **Step 3: Implement** — `test-support/flake-postmortem.mjs`:

```js
/**
 * Flake postmortem black-box (issue #95 F3).
 *
 * When a real-process waitFor burns its budget, the failure currently says
 * only "timed out waiting" — the red carries no scene. formatPostmortem
 * renders the last observed durable state; capturePostmortem reads it from a
 * root; waitForWithPostmortem attaches it to the thrown error at timeout.
 * Pure rendering; the only I/O is capturePostmortem's reads.
 */
import { readFileSync } from "node:fs";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import { readHost, readState, readStatus } from "../src/core/store.mjs";

/**
 * @param {{
 * 	status: object | null,
 * 	state: object | null,
 * 	host: object | null,
 * 	diagnosticsTail: object[],
 * 	journalTail: string[],
 * }} snapshot
 * @returns {string}
 */
export function formatPostmortem(snapshot) {
	const show = (label, value) => `${label}: ${value == null ? "<absent>" : JSON.stringify(value)}`;
	const lines = [
		"--- flake postmortem (last observed state at waitFor timeout) ---",
		show("status", snapshot.status),
		show("state", snapshot.state),
		show("host", snapshot.host),
		`diagnosticsTail: ${snapshot.diagnosticsTail.length ? JSON.stringify(snapshot.diagnosticsTail) : "<empty>"}`,
		`journalTail: ${snapshot.journalTail.length ? snapshot.journalTail.join(" | ") : "<empty>"}`,
	];
	return lines.join("\n");
}

/**
 * @param {string} root @param {string} viewId @param {string | null} runId
 * @returns {{ status: object | null, state: object | null, host: object | null, diagnosticsTail: object[], journalTail: string[] }}
 */
export function capturePostmortem(root, viewId, runId = null) {
	const safe = (fn) => {
		try {
			return fn();
		} catch {
			return null;
		}
	};
	let journalTail = [];
	try {
		const raw = readFileSync(join(root, "state-journal.jsonl"), "utf8");
		journalTail = raw.trim().split("\n").slice(-8);
	} catch {
		/* absent journal */
	}
	return {
		status: safe(() => (runId ? readStatus(root, viewId, runId) : null)),
		state: safe(() => readState(root, viewId)),
		host: safe(() => readHost(root, viewId)),
		diagnosticsTail: safe(() => (readDiagnostics(root, viewId) ?? []).slice(-8)) ?? [],
		journalTail,
	};
}

/**
 * waitFor with an optional postmortem. Success semantics identical to the
 * files' local helpers (poll → return the predicate value); on timeout throws
 * "timed out waiting" plus the capture thunk's postmortem, when provided.
 * @param {() => any | Promise<any>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, capture?: () => string }} [opts]
 */
export async function waitForWithPostmortem(predicate, { timeoutMs = 15000, intervalMs = 25, capture = null } = {}) {
	const start = Date.now();
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() - start > timeoutMs) {
			const detail = capture ? "\n" + capture() : "";
			throw new Error("timed out waiting" + detail);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}
```

(Note: `join` needs `import { join } from "node:path";` — add it.)

- [ ] **Step 4: Run to verify GREEN** — `node --test test/flake-postmortem.test.mjs` → 6/6 pass.
- [ ] **Step 5: Commit** — `git add test-support/flake-postmortem.mjs test/flake-postmortem.test.mjs && git commit -m "feat: flake postmortem black-box for waitFor timeouts (issue #95)"`

---

### Task 2: F3 adoption — the four flaky helpers

**Files:**
- Modify: `test/runner.integration.test.mjs`, `test/host-concurrency.integration.test.mjs`, `test/pty-runner.integration.test.mjs`, `test/terminal-snapshot.integration.test.mjs`

**Interfaces:**
- Consumes: `waitForWithPostmortem`, `capturePostmortem`, `formatPostmortem` from Task 1.
- Produces: each file's local `waitFor(predicate, timeoutMs, capture)` delegating to the shared wrapper (runner.integration also keeps its `intervalMs` third-arg position — its signature becomes `(predicate, timeoutMs = 15000, capture = null)`; the shared default interval for it is overridden to 50 via opts).

- [ ] **Step 1:** In each of the four files, import the helpers and replace the local `waitFor` body with a delegation (keep each file's existing default timeout):

```js
import { capturePostmortem, formatPostmortem, waitForWithPostmortem } from "../test-support/flake-postmortem.mjs";

async function waitFor(predicate, timeoutMs = 15000, capture = null) {
	return waitForWithPostmortem(predicate, { timeoutMs, intervalMs: 50, capture });
}
```

(host-concurrency / pty-runner / terminal-snapshot use `intervalMs: 25`; runner.integration used 50 — preserve each file's original interval. runner.integration's helper is `waitFor(fn, timeoutMs = 15000, intervalMs = 50)` — extend it as `waitFor(fn, timeoutMs = 15000, intervalMs = 50, capture = null)` and forward all four.)

- [ ] **Step 2:** Add `capture` at the historically-flaky call sites ONLY (pass a closure over that test's `root`/view/run ids):
  - `runner.integration.test.mjs` — the `stopping the runner finalizes the run as stopped` test's two waits: `capture: () => formatPostmortem(capturePostmortem(root, "v", "r"))`.
  - `host-concurrency.integration.test.mjs` — A10's three waits (original-alive 30s, runner-death 10s, replacement 30s): `capture: () => formatPostmortem(capturePostmortem(root, "v1", null))`.
  - `pty-runner.integration.test.mjs` — the `subscribe_terminal: snapshot + live continuity alongside legacy clients` test's waits (grep its waitFor calls inside that test): closure over its fixture root/view.
  - `terminal-snapshot.integration.test.mjs` — the four explicit 30s waits (`:276`, `:293`, `:319`, `:352` region): same closure pattern.
- [ ] **Step 3:** `node --test test/runner.integration.test.mjs test/host-concurrency.integration.test.mjs test/terminal-snapshot.integration.test.mjs test/pty-runner.integration.test.mjs` → all pass (pty-runner may need `node-pty`; if unavailable locally it skips — record it).
- [ ] **Step 4:** Red-world: in `flake-postmortem.mjs` temporarily make `capture` never invoked (comment the `const detail = ...` line down to `throw new Error("timed out waiting")`), then hand-edit ONE call site's predicate to always-false with timeout 50ms — expect the thrown message WITHOUT the postmortem block (proving the adoption path is the wrapper). Restore both. Record outputs.
- [ ] **Step 5:** Commit — `git add test/*.integration.test.mjs && git commit -m "test: attach flake postmortems to the known-flaky waits (issue #95)"`

---

### Task 3: F2 — budget audit gate

**Files:**
- Create: `scripts/budget-audit.mjs`, `test/budget-audit.test.mjs`
- Modify: `test/host-concurrency.integration.test.mjs` (escape comment on the A10 deadline line)

**Interfaces:**
- Produces: `parseTestBudgets(source) → {fileDefaultWaitMs, tests: [{name, declaredTimeoutMs, waitLiterals[], deadlineLiterals[]}]}` and `auditBudgets(sources) → violations[]` (pure; `sources` = `[{path, source}]`).

- [ ] **Step 1: Write the failing tests** — `test/budget-audit.test.mjs`:

```js
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
		.filter((f) => f.endsWith(".test.mjs"))
		.map((f) => ({ path: f, source: readFileSync(join(dir, "test", f), "utf8") }));
	assert.ok(sources.length > 50, "found the test tree");
	assert.deepEqual(auditBudgets(sources), []);
});
```

- [ ] **Step 2: RED run** — `node --test test/budget-audit.test.mjs` → module-not-found.

- [ ] **Step 3: Implement `scripts/budget-audit.mjs`:**

```js
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
	const m = /async function waitFor\([^)]*\)\s*\{[\s\S]{0,400}?timeoutMs\s*=\s*([0-9_]+)/.exec(source);
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
		const toM = /timeout:\s*([0-9_]+)/.exec(chunk.slice(0, 240));
		const waitLiterals = [];
		let hasDefaultWaitCall = false;
		const waitRe = /waitFor\(/g;
		for (let w = waitRe.exec(chunk); w; w = waitRe.exec(chunk)) {
			const args = callArgs(chunk, w.index + "waitFor".length);
			if (args == null) continue;
			const trailing = /,\s*([0-9_]+)\s*,?\s*$/.exec(args.trim());
			if (trailing) waitLiterals.push(Number(trailing[1].replace(/_/g, "")));
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
```
- [ ] **Step 4: GREEN** — all fixtures report as designed AND the real tree is clean after adding this line to host-concurrency A10 (immediately after the `resolveAttachTarget` line): `// budget: app deadline 150s, runtime-compressed by the F4 knob; node-default test timeout accepted`
- [ ] **Step 5:** `node --test test/host-concurrency.integration.test.mjs` still green (comment-only change).
- [ ] **Step 6:** Commit — `git add scripts/budget-audit.mjs test/budget-audit.test.mjs test/host-concurrency.integration.test.mjs && git commit -m "test: budget audit gate for test timeout/wait nesting (issue #95)"`

---

### Task 4: F4 — test-only ladder knob readers

**Files:**
- Create: `src/core/test-knobs.mjs`, `test/test-knobs.test.mjs`
- Modify: `src/runtime/service.mjs:61-69`, `src/core/host-probe.mjs:17-19`, `src/core/pty-attach-reconnect.mjs:12-14`

**Interfaces:**
- Produces: `resolveTestMs(env, name, defaultMs)` plus per-constant readers `resolveHostStartGraceMs / resolveHostRecoveryGraceMs / resolveHostRecoveryPollMs / resolveAttachResolveTimeoutMs / resolveHostProbeTimeoutMs / resolveAttachReconnectTimeoutMs` (each `(env = process.env) → number`). Exported constants KEEP their names and default values (compat).

- [ ] **Step 1: Failing tests** — `test/test-knobs.test.mjs`: unset/empty ⇒ default; `"250"` ⇒ 250; invalid (`"abc"`, `"-5"`) ⇒ default AND a one-shot stderr warning (monkeypatch `process.stderr.write` to collect; second invalid call for the same knob adds no second warning); each per-constant reader: `{}` ⇒ exact default (`10_000`, `5_000`, `150`, `120_000`, `250`, `15_000`), env-set ⇒ override; module-level exports `HOST_START_GRACE_MS` etc. still equal the defaults (env unset).
- [ ] **Step 2: RED run.**
- [ ] **Step 3: Implement `src/core/test-knobs.mjs`:**

```js
/** Test-only wall-clock knob readers (issue #95 F4). Ladder constants gain a
 * dynamic reader so tests can compress production grace periods instead of
 * waiting them out. Unset ⇒ default (production byte-identical). Invalid ⇒
 * default plus a one-shot stderr warning (no diagnostics root at this layer). */
const warned = new Set();

/** @param {NodeJS.ProcessEnv} env @param {string} name @param {number} defaultMs @returns {number} */
export function resolveTestMs(env, name, defaultMs) {
	const raw = env[name];
	if (raw == null || raw === "") return defaultMs;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		if (!warned.has(name)) {
			warned.add(name);
			process.stderr.write(`test-knobs: ignoring invalid ${name}=${JSON.stringify(raw)}; using default ${defaultMs}ms\n`);
		}
		return defaultMs;
	}
	return value;
}
```

  Then in `src/runtime/service.mjs`: import `resolveTestMs`; add the four readers next to the constants; **switch the ladder USE SITES to reader calls** (dynamic — module-load evaluation would make in-process knobs dead): grep every reference of the four constant names inside service.mjs and replace with the reader call (e.g. `now - (row.host.claimAt ?? ...) < resolveHostStartGraceMs()`); keep the `export const` definitions (unchanged values) for compat, and check `rg -n "HOST_START_GRACE_MS|HOST_RECOVERY_GRACE_MS|HOST_RECOVERY_POLL_MS|ATTACH_RESOLVE_TIMEOUT_MS" src/ runner/ test/` for external importers — if any test imports them, leave those imports valid. Same pattern in `host-probe.mjs` (HOST_PROBE_TIMEOUT_MS, default 250) and `pty-attach-reconnect.mjs` (ATTACH_RECONNECT_TIMEOUT_MS, default 15_000).
- [ ] **Step 4:** GREEN on `node --test test/test-knobs.test.mjs`; then `node --test test/host-concurrency.integration.test.mjs test/runner.integration.test.mjs test/service.test.mjs test/host-probe.test.mjs test/pty-attach-reconnect.test.mjs` (adapt list to existing files) all green — proving unset ⇒ identical behavior.
- [ ] **Step 5:** Commit — `git add src/core/test-knobs.mjs test/test-knobs.test.mjs src/runtime/service.mjs src/core/host-probe.mjs src/core/pty-attach-reconnect.mjs && git commit -m "feat: test-only ladder knobs with dynamic use-site readers (issue #95)"`

---

### Task 5: F4 A7 — knobs compress the recovery chain

**Files:**
- Modify: `test/host-concurrency.integration.test.mjs` (new test)

- [ ] **Step 1:** Append after A10 (same fixture shape):

```js
test("A7: ladder knobs compress the A10 recovery chain without weakening it", { skip: !hasNodePty }, async () => {
	process.env.AGENT_BOARD_TEST_HOST_START_GRACE_MS = "1000";
	process.env.AGENT_BOARD_TEST_HOST_RECOVERY_GRACE_MS = "500";
	process.env.AGENT_BOARD_TEST_HOST_RECOVERY_POLL_MS = "50";
	process.env.AGENT_BOARD_TEST_ATTACH_RESOLVE_TIMEOUT_MS = "30000";
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "knob", cwd: process.cwd() });
		ensureSessionFile(root, "v1");
		const first = await runHelper(root, "v1");
		assert.equal(first.result?.started, true, `first helper started: ${JSON.stringify(first)}`);
		const original = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h.readyAt != null && h.childPid && isAlive(h.runnerPid) ? h : false;
		}, 30000, () => formatPostmortem(capturePostmortem(root, "v1", null)));
		process.kill(original.runnerPid, "SIGKILL");
		await waitFor(() => !isAlive(original.runnerPid), 10000, () => formatPostmortem(capturePostmortem(root, "v1", null)));
		// The compressed chain must converge well inside the 30s resolve budget —
		// the same budget the production default would need 150s of headroom for.
		const service = testService(root);
		const resolved = await service.resolveAttachTarget("v1", { timeoutMs: 30_000 });
		assert.equal(resolved.kind, "pty", `resolver produced a pty target: ${JSON.stringify(resolved)}`);
		assert.notEqual(resolved.instanceId, original.instanceId, "replacement is a new instance");
		assert.equal(isAlive(original.childPid), false, "old child is dead once the resolver returns");
	} finally {
		delete process.env.AGENT_BOARD_TEST_HOST_START_GRACE_MS;
		delete process.env.AGENT_BOARD_TEST_HOST_RECOVERY_GRACE_MS;
		delete process.env.AGENT_BOARD_TEST_HOST_RECOVERY_POLL_MS;
		delete process.env.AGENT_BOARD_TEST_ATTACH_RESOLVE_TIMEOUT_MS;
		await teardownHost(root, "v1", testService(root)).catch(() => {});
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

(Verify the exact `freshRoot`/`ensureSessionFile`/`runHelper`/`teardownHost` names against the file; `rmSync`/`readHost`/`isAlive`/`waitFor` are already imported there — add what's missing. If the 30s budget still proves too tight on this machine, lower only the knob values, never the assertion.)
- [ ] **Step 2:** `node --test test/host-concurrency.integration.test.mjs` → all green including A7 and the untouched A10.
- [ ] **Step 3:** Red-world: set `AGENT_BOARD_TEST_ATTACH_RESOLVE_TIMEOUT_MS = "3000"` in a temporary copy of the fixture with a `timeoutMs: 3000` resolve — expect it to time out (proves the knob actually governs the budget). Restore; record outputs.
- [ ] **Step 4:** Commit — `git add test/host-concurrency.integration.test.mjs && git commit -m "test: A7 knob-compressed recovery chain (issue #95)"`

---

### Task 6: Full gate + evidence

- [ ] `npm run verify` → exit 0 (coverage thresholds may need the new files' branches — if a threshold fails on the new modules, add the missing branch tests, never lower thresholds).
- [ ] Record A5 (`node --test test/budget-audit.test.mjs`), A6 (`node --test test/flake-postmortem.test.mjs`), A7 (host-concurrency suite) evidence lines for the PR body.
- [ ] No commit unless a defect surfaces (then fix per task rules).

## Self-Review

- Spec coverage: F3 → Tasks 1–2 (A6); F2 → Task 3 (A5, two-inversion handling: the A10 deadline gets the escape comment; runner.integration:282 needs NO change under max+margin — recorded here as a deliberate no-op with the arithmetic: 20000 ≥ 15000+5000); F4 → Tasks 4–5 (A7); A8 → Task 6. F5/F6/F7 excluded per spec delivery-status.
- Placeholders: none; every step carries code or an exact command with expected output.
- Type consistency: reader/option names identical across Tasks 1→2 and 4→5 (`waitForWithPostmortem` opts; knob env names verbatim).
- Review Focus: all five pinned inline.
