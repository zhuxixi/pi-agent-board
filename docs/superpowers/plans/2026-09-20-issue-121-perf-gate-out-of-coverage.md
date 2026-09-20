# Issue #121 Perf Gate Out of Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the A11 perf assertions out of the default/coverage suites behind an opt-in gate, so they only decide CI from a dedicated, serial, non-instrumented step (issue #121).

**Architecture:** Three layers that must not merge — pure decision (`test-support/perf-gate.mjs`, no side effects) ↔ side-effect entry (`scripts/run-perf-gate.mjs`, spawn/env/exit-code only, no decision logic, no measurement) ↔ measurement (`test/terminal-model-perf.test.mjs`, owns thresholds and assertions). Wiring (package.json / ci.yml / docs) is pinned by committed static tests so silently deleting the CI step fails the suite.

**Spec:** `docs/superpowers/specs/2026-09-20-issue-121-perf-gate-out-of-coverage-design.md` (acceptance IDs A1–A8, U1–U2 referenced below). U1/U2 are post-merge observations, not implementation tasks.

**Tech Stack:** Node `node:test` runner, c8, GitHub Actions, plain ESM `.mjs` (no TypeScript, no new deps).

**Worktree (all paths relative to this root):** `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-121-perf-gate-out-of-coverage` — never touch the main checkout.

## Global Constraints

- Thresholds stay verbatim: `FEED_P95_LIMIT = 5`, `FEED_P99_LIMIT = 8`, `CAPTURE_LIMIT = 50`, `HYDRATE_LIMIT = 100` in `test/terminal-model-perf.test.mjs`. No silent relax (spec D4).
- No new npm dependencies. No production-code changes (`src/`, `runner/` untouched). `.c8rc.json` untouched (`test-support/**` already excluded).
- `test` and `test:coverage` scripts and their `test/*.test.mjs` glob stay byte-identical.
- No new CI job, no branch-protection changes — exactly one new step in the existing job.
- Windows-compatible: no inline `VAR=1 cmd` in package.json; env is injected via `spawn` with `process.execPath`.
- Node 22 + 24 compatible (CI matrix).
- Commit messages: English, conventional commits. The squash-merged PR title lands in CHANGELOG under "Changes" — write it for readers.
- The `AGENT_BOARD_*` env naming is established precedent (`AGENT_BOARD_NO_SWEEP`, `AGENT_BOARD_AUTO_STATE`, …); the new var is `AGENT_BOARD_PERF_GATE`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `test-support/perf-gate.mjs` (create) | Pure gate decision `perfGateDecision(env)` | 1 |
| `test/perf-gate.test.mjs` (create) | A1 truth table + A2 entry-refusal tests | 1, 2 |
| `scripts/run-perf-gate.mjs` (create) | Entry: instrumentation detection → loud refuse, else spawn perf file with `AGENT_BOARD_PERF_GATE=1` | 2 |
| `test/terminal-model-perf.test.mjs` (modify) | Consume the gate; skip with reason when not opted in | 3 |
| `package.json` (modify) | Add `test:perf`; extend `verify` | 4 |
| `.github/workflows/ci.yml` (modify) | New "Perf gate" step before Unit tests | 5 |
| `test/perf-gate-wiring.test.mjs` (create) | A5 wiring + A8 docs static assertions | 5, 6 |
| `README.md`, `VERIFY.md` (modify) | Document the opt-in gate | 6 |

---

### Task 1: `perfGateDecision` pure function + truth-table tests (A1)

**Files:**
- Create: `test-support/perf-gate.mjs`
- Test: `test/perf-gate.test.mjs`

**Interfaces:**
- Consumes: nothing (new code).
- Produces: `perfGateDecision(env = process.env): { run: boolean, reason: string }` — consumed by Task 3 (`test/terminal-model-perf.test.mjs`). **NOT** consumed by Task 2's entry script (spec §3.2 layering contract: the script does its own instrumentation check and never silently skips).

- [ ] **Step 1: Write the failing test**

Create `test/perf-gate.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { perfGateDecision } from "../test-support/perf-gate.mjs";

// A1: truth table over the full domain —
// AGENT_BOARD_PERF_GATE ∈ {unset, "1", "0", other} × NODE_V8_COVERAGE ∈ {unset, set}.
const CASES = [
	// [gate, coverage, expectedRun, reasonSubstring]
	[undefined, undefined, false, "AGENT_BOARD_PERF_GATE=1"],
	[undefined, "/tmp/x", false, "AGENT_BOARD_PERF_GATE=1"],
	["1", undefined, true, ""],
	["1", "/tmp/x", false, "coverage instrumentation"],
	["0", undefined, false, "AGENT_BOARD_PERF_GATE=1"],
	["0", "/tmp/x", false, "AGENT_BOARD_PERF_GATE=1"],
	["yes", undefined, false, "AGENT_BOARD_PERF_GATE=1"],
	["yes", "/tmp/x", false, "AGENT_BOARD_PERF_GATE=1"],
];

for (const [gate, coverage, expectedRun, reasonSubstring] of CASES) {
	test(`gate=${JSON.stringify(gate)} coverage=${coverage ?? "unset"} → run=${expectedRun}`, () => {
		const env = {};
		if (gate !== undefined) env.AGENT_BOARD_PERF_GATE = gate;
		if (coverage !== undefined) env.NODE_V8_COVERAGE = coverage;
		const d = perfGateDecision(env);
		assert.equal(d.run, expectedRun);
		if (expectedRun) assert.equal(d.reason, "");
		else assert.ok(
			d.reason.includes(reasonSubstring),
			`reason ${JSON.stringify(d.reason)} must contain ${JSON.stringify(reasonSubstring)}`,
		);
	});
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/perf-gate.test.mjs`
Expected: FAIL — the file errors with `Cannot find module .../test-support/perf-gate.mjs` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `test-support/perf-gate.mjs`:

```js
/**
 * Perf-gate decision — a pure function of two environment variables (issue #121).
 *
 * The A11 perf assertions are only meaningful in a quiet, non-instrumented
 * environment: c8 instrumentation inflates measured latency ~2.5–6× and the
 * parallel suite adds contention noise (see research/03 in the issue-121
 * research dir). They must therefore never decide results inside `npm test`
 * or `npm run test:coverage`. The only authoritative path is
 * `npm run test:perf`, which sets AGENT_BOARD_PERF_GATE=1.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ run: boolean, reason: string }}
 */
export function perfGateDecision(env = process.env) {
	const instrumented = env.NODE_V8_COVERAGE !== undefined;
	if (env.AGENT_BOARD_PERF_GATE === "1") {
		if (instrumented) {
			return {
				run: false,
				reason:
					"perf assertions refuse to measure under coverage instrumentation " +
					"(NODE_V8_COVERAGE is set); run `npm run test:perf` instead",
			};
		}
		return { run: true, reason: "" };
	}
	return {
		run: false,
		reason:
			"perf assertions are opt-in: run them via `npm run test:perf` " +
			"(or set AGENT_BOARD_PERF_GATE=1)",
	};
}
```

Note the reason wording pins the two assertion substrings the test relies on: `"AGENT_BOARD_PERF_GATE=1"` for every non-run case except instrumented-opted-in, which contains `"coverage instrumentation"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/perf-gate.test.mjs`
Expected: PASS — `pass 8 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add test-support/perf-gate.mjs test/perf-gate.test.mjs
git commit -m "test: add perf-gate decision function with truth-table coverage (issue #121)"
```

---

### Task 2: `scripts/run-perf-gate.mjs` entry + instrumentation-refusal test (A2)

**Files:**
- Create: `scripts/run-perf-gate.mjs`
- Modify: `test/perf-gate.test.mjs` (append the A2 test)

**Interfaces:**
- Consumes: nothing from Task 1 (deliberate layering: the script does NOT call `perfGateDecision`).
- Produces: the executable invoked by `npm run test:perf` (Task 4) and the CI step (Task 5). Contract: exit 0 ⇔ the perf file ran to completion under `AGENT_BOARD_PERF_GATE=1`; exit 1 with a stderr message when `NODE_V8_COVERAGE` is present.

- [ ] **Step 1: Write the failing test**

Append to `test/perf-gate.test.mjs`:

```js
// A2: the entry script refuses loudly under instrumentation — nonzero exit,
// a clear message, and no measurement output. Setting AGENT_BOARD_PERF_GATE=1
// too proves the instrumentation check dominates the opt-in.
const ENTRY_SCRIPT = fileURLToPath(new URL("../scripts/run-perf-gate.mjs", import.meta.url));

test("run-perf-gate.mjs refuses when NODE_V8_COVERAGE is set", () => {
	const r = spawnSync(process.execPath, [ENTRY_SCRIPT], {
		env: { ...process.env, NODE_V8_COVERAGE: "/tmp/perf-gate-a2", AGENT_BOARD_PERF_GATE: "1" },
		encoding: "utf8",
	});
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /coverage instrumentation|NODE_V8_COVERAGE/);
	assert.doesNotMatch(r.stdout, /burst:|paced:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/perf-gate.test.mjs`
Expected: the 8 truth-table tests still pass; the new test FAILS (`spawnSync` errors / nonzero status with an ENOENT-style message because `scripts/run-perf-gate.mjs` does not exist).

- [ ] **Step 3: Write the implementation**

Create `scripts/run-perf-gate.mjs`:

```js
#!/usr/bin/env node
/**
 * Authoritative entry for the A11 perf gate (issue #121).
 *
 * Loudly refuses under coverage instrumentation: c8 sets NODE_V8_COVERAGE
 * for its whole process tree, and instrumented latency measurements are
 * invalid (2.5–6× inflation). Silently skipping here would manufacture a
 * fake-green gate, so refusal is a nonzero exit with an explicit message.
 *
 * This script is the side-effect layer only — no decision logic, no
 * measurement. The pure gate decision lives in test-support/perf-gate.mjs
 * and serves the test file; do not merge the layers (spec §3.2/§4).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.NODE_V8_COVERAGE !== undefined) {
	console.error(
		"run-perf-gate: refusing to measure under coverage instrumentation " +
			"(NODE_V8_COVERAGE is set). Perf assertions are only valid without c8; " +
			"run `npm run test:perf` directly, outside any coverage wrapper.",
	);
	process.exit(1);
}

const perfTest = fileURLToPath(new URL("../test/terminal-model-perf.test.mjs", import.meta.url));
const child = spawn(
	process.execPath,
	["--test", "--test-concurrency=1", perfTest],
	{ stdio: "inherit", env: { ...process.env, AGENT_BOARD_PERF_GATE: "1" } },
);
child.on("error", (err) => {
	console.error(`run-perf-gate: failed to spawn the perf suite: ${err.message}`);
	process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
```

- [ ] **Step 4: Run the tests + a manual happy-path smoke**

Run: `node --test test/perf-gate.test.mjs` → PASS, `pass 9 / fail 0`.
Run: `node scripts/run-perf-gate.mjs` → exit 0, output contains `burst:` and `paced:` value lines, `pass 3 / fail 0`. (Pre-Task-3 the perf tests always measure, so this already works end to end.)

- [ ] **Step 5: Commit**

```bash
git add scripts/run-perf-gate.mjs test/perf-gate.test.mjs
git commit -m "test: add run-perf-gate entry script with instrumentation refusal (issue #121)"
```

---

### Task 3: Wire the gate into `test/terminal-model-perf.test.mjs` (A4, first half)

**Files:**
- Modify: `test/terminal-model-perf.test.mjs` (imports ~L1-15, constants ~L84-87, three `test(...)` declarations at ~L89/L142/L169)

**Interfaces:**
- Consumes: `perfGateDecision` from Task 1.
- Produces: the skip behavior A4 asserts — three skipped tests with a reason pointing at `npm run test:perf` whenever the gate says no.

- [ ] **Step 1: Add the import and the gate evaluation**

After the last import line (`import { createTerminalSubscription } from "../src/core/terminal-attach-protocol.mjs";`), add:

```js
import { perfGateDecision } from "../test-support/perf-gate.mjs";
```

Directly below the four threshold constants (`FEED_P95_LIMIT` … `HYDRATE_LIMIT`), add:

```js
// Perf assertions are opt-in (issue #121): they only measure via
// `npm run test:perf`. Under the default/parallel/coverage suites they skip —
// c8 instrumentation inflates latency ~2.5–6× and parallel contention is
// noise, so measuring there would decide CI on runner busy-ness, not code.
const GATE = perfGateDecision(process.env);
const PERF_SKIP = { skip: GATE.run ? false : GATE.reason };
```

- [ ] **Step 2: Attach the option to all three tests**

Change each declaration — `test("A11: 750-chunk burst (60s × 12.5fps equivalent) meets feed/capture/hydrate thresholds", async () => {` becomes `test("A11: 750-chunk burst (60s × 12.5fps equivalent) meets feed/capture/hydrate thresholds", PERF_SKIP, async () => {`, and identically for the `paced stream` and `ring overflow` tests (insert `PERF_SKIP, ` as the second argument). Do not touch any assertion, threshold, or measurement code.

- [ ] **Step 3: Verify the four environment behaviors**

Run each from the worktree root:

1. `node --test test/terminal-model-perf.test.mjs` → `tests 3 / pass 0 / fail 0 / skipped 3`; each line shows `# SKIP` with a reason containing `npm run test:perf`.
2. `AGENT_BOARD_PERF_GATE=1 node --test test/terminal-model-perf.test.mjs` → `pass 3 / fail 0 / skipped 0`, output contains `burst:` and `paced:` lines (~7s wall).
3. `npx c8 node --test test/terminal-model-perf.test.mjs` → `skipped 3` (opt-in reason; instrumentation without opt-in does not change the verdict).
4. `AGENT_BOARD_PERF_GATE=1 npx c8 node --test test/terminal-model-perf.test.mjs` → `skipped 3` with the coverage-instrumentation refusal reason.

- [ ] **Step 4: Verify the default suite now skips (A4 behavior half)**

Run: `npm test 2>&1 | tail -12`
Expected: the three A11 lines show as skipped with the reason; summary `skipped 3` (the suite has zero other skips at this HEAD); `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add test/terminal-model-perf.test.mjs
git commit -m "test: wire A11 perf assertions behind the opt-in gate (issue #121)"
```

---

### Task 4: `package.json` scripts — `test:perf` + `verify` ordering (A3, A5 package half)

**Files:**
- Modify: `package.json` (`scripts` block)

**Interfaces:**
- Consumes: `scripts/run-perf-gate.mjs` (Task 2).
- Produces: `"test:perf": "node scripts/run-perf-gate.mjs"`; `verify` runs perf before the parallel suite and before coverage (mirrors CI step order, spec §3.4).

- [ ] **Step 1: Edit the scripts block**

In `package.json`, add one line and change the `verify` value:

```json
		"test": "node --test test/*.test.mjs",
		"test:coverage": "c8 node --test test/*.test.mjs",
		"test:perf": "node scripts/run-perf-gate.mjs",
```

```json
		"verify": "npm run typecheck && npm run test:perf && npm test && npm run test:coverage && npm run pack:dry",
```

Keep `test` / `test:coverage` byte-identical (the glob must not change — spec D2). Match the file's existing tab indentation.

- [ ] **Step 2: Verify the authoritative entry (A3)**

Run: `npm run test:perf`
Expected: exit 0; output contains `burst:` and `paced:` value lines; summary `pass 3 / fail 0 / skipped 0`. (Post-Task-3 this proves the script's `AGENT_BOARD_PERF_GATE=1` injection is what unlocks measurement — the layering works end to end.)

- [ ] **Step 3: Verify the loud refusal through the npm script**

Run: `npx c8 npm run test:perf`
Expected: nonzero exit; stderr contains the refusal message naming `NODE_V8_COVERAGE`; no `burst:`/`paced:` lines.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add test:perf script and gate it into verify (issue #121)"
```

---

### Task 5: CI step + wiring static tests (A5)

**Files:**
- Modify: `.github/workflows/ci.yml` (between the Typecheck and Unit tests steps)
- Create: `test/perf-gate-wiring.test.mjs`

**Interfaces:**
- Consumes: `npm run test:perf` (Task 4).
- Produces: the CI step `Perf gate (serial, no coverage)`; committed static assertions that pin the wiring (spec §7: deleting the CI step must fail the suite).

- [ ] **Step 1: Write the failing wiring tests**

Create `test/perf-gate-wiring.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// A5: the perf-gate wiring is a contract — deleting the CI step, moving it
// after the parallel suite, or retargeting the npm scripts must fail loudly
// here instead of silently un-guarding the perf assertions (spec §7).
const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("ci.yml: perf gate step exists and runs before Unit tests", () => {
	const perfIdx = CI.indexOf("npm run test:perf");
	const unitIdx = CI.indexOf("- name: Unit tests");
	assert.ok(perfIdx > -1, "ci.yml wires `npm run test:perf`");
	assert.ok(unitIdx > -1, "ci.yml still has the Unit tests step");
	assert.ok(perfIdx < unitIdx, "perf gate runs before Unit tests (quietest machine window)");
});

test("package.json: default globs unchanged, test:perf wired, verify ordered", () => {
	assert.equal(PKG.scripts.test, "node --test test/*.test.mjs");
	assert.equal(PKG.scripts["test:coverage"], "c8 node --test test/*.test.mjs");
	assert.equal(PKG.scripts["test:perf"], "node scripts/run-perf-gate.mjs");
	const order = PKG.scripts.verify.split("&&").map((s) => s.trim());
	const idx = (needle) => order.findIndex((s) => s === needle);
	assert.ok(idx("npm run test:perf") > idx("npm run typecheck"), "perf runs after typecheck");
	assert.ok(idx("npm run test:perf") < idx("npm test"), "perf runs before the parallel suite");
	assert.ok(idx("npm run test:perf") < idx("npm run test:coverage"), "perf runs before coverage");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/perf-gate-wiring.test.mjs`
Expected: the package.json test PASSES (Task 4 already satisfied it); the ci.yml test FAILS (`ci.yml wires npm run test:perf` assertion).

- [ ] **Step 3: Add the CI step**

In `.github/workflows/ci.yml`, between `- name: Typecheck` / `run: npm run typecheck` and `- name: Unit tests`, insert (6-space step indentation, matching the file):

```yaml
      - name: "Perf gate (serial, no coverage)"
        run: npm run test:perf
```

Resulting step order: checkout → setup-node → Install dependencies → Typecheck → **Perf gate (serial, no coverage)** → Unit tests → Coverage → Package dry-run.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/perf-gate-wiring.test.mjs`
Expected: PASS — `pass 2 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml test/perf-gate-wiring.test.mjs
git commit -m "chore(ci): run the perf gate as a dedicated serial step before unit tests (issue #121)"
```

---

### Task 6: Docs (README, VERIFY.md) + docs static test (A8)

**Files:**
- Modify: `README.md` (the `npm run verify` description line, ~L380)
- Modify: `VERIFY.md` (§0 "Static checks" block, ~L5-14)
- Modify: `test/perf-gate-wiring.test.mjs` (append the docs test)

**Interfaces:**
- Consumes: everything above (docs describe final behavior).
- Produces: doc text the A8 test pins: `npm run test:perf` must appear in both files; README must state perf assertions are opt-in/skipped by default.

- [ ] **Step 1: Write the failing docs test**

Append to `test/perf-gate-wiring.test.mjs`:

```js
// A8: the docs are part of the contract — if the opt-in gate disappears from
// README/VERIFY, the next maintainer will re-add perf assertions to the
// coverage path and reintroduce the flake this issue removes.
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const VERIFY_MD = readFileSync(new URL("../VERIFY.md", import.meta.url), "utf8");

test("docs: README and VERIFY document the opt-in perf gate", () => {
	assert.match(README, /npm run test:perf/, "README mentions the perf gate entry");
	assert.match(README, /perf assertions.*(opt-in|skip)/i, "README states perf assertions are opt-in / skipped by default");
	assert.match(VERIFY_MD, /npm run test:perf/, "VERIFY.md §0 mentions the perf gate entry");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/perf-gate-wiring.test.mjs`
Expected: the two wiring tests pass; the docs test FAILS (`README mentions the perf gate entry`).

- [ ] **Step 3: Update README**

In `README.md`, replace the verify description sentence

`npm run verify` runs typecheck, tests, coverage, and a package dry-run.

with:

`npm run verify` runs typecheck, the perf gate (`npm run test:perf`), tests, coverage, and a package dry-run. The A11 perf assertions are opt-in — they skip under `npm test` / `npm run test:coverage` and only measure via `npm run test:perf` (issue #121).

(Leave the surrounding sentences — "The same checks run in CI…" and the VERIFY.md link — untouched.)

- [ ] **Step 4: Update VERIFY.md §0**

In `VERIFY.md`, in the §0 "Static checks" code block, insert a line between `npm run typecheck` and `npm test`:

```bash
npm run test:perf    # expect: `burst:`/`paced:` value lines, pass 3 / skipped 0 — the ONLY path that measures perf assertions; they skip under npm test (issue #121)
```

and adjust the `npm test` comment to note the three A11 perf tests now show as skipped with a reason pointing at `npm run test:perf`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/perf-gate-wiring.test.mjs`
Expected: PASS — `pass 3 / fail 0`.

- [ ] **Step 6: Commit**

```bash
git add README.md VERIFY.md test/perf-gate-wiring.test.mjs
git commit -m "docs: document the opt-in perf gate in README and VERIFY (issue #121)"
```

---

### Task 7: Acceptance sweep (A3/A4/A6/A7 re-verified, ledger)

**Files:** none (verification only; the ledger goes into the PR body and an issue comment, not the repo).

- [ ] **Step 1: A1+A2+A5+A8** — `node --test test/perf-gate.test.mjs test/perf-gate-wiring.test.mjs` → all pass (12 tests).
- [ ] **Step 2: A3** — `npm run test:perf` → exit 0, `burst:`/`paced:` lines, `pass 3 / fail 0 / skipped 0`.
- [ ] **Step 3: A4** — `npm test 2>&1 | tail -15` → 3 A11 tests skipped with `npm run test:perf` reason, no perf assertion failures; `npm run test:coverage 2>&1 | tail -15` → same skip behavior; `rg -c "perfGateDecision" test/terminal-model-perf.test.mjs` → ≥2.
- [ ] **Step 4: A6** — `npm run test:coverage` → exit 0; record the `All files` line; assert Lines ≥ 85, Functions ≥ 80, Branches ≥ 70 (R3 baseline at HEAD 794c755: 92.46 / 91.41 / 80.07 — expect the same modulo new files).
- [ ] **Step 5: A7** — `npm test` three consecutive rounds; record `pass/fail/skipped` per round. Any failure is only acceptable if it lands in the known-flake ledger (#95 family, or the A5 mid-stream assertion from #122) AND is unrelated to this change's files (perf-gate / run-perf-gate / terminal-model-perf / package.json / ci.yml); otherwise it blocks.
- [ ] **Step 6: Full verify** — `npm run verify` → exit 0 end to end (this is the exact command the release flow uses).
- [ ] **Step 7: Write the acceptance ledger** — a per-ID table (A1–A8: command run + observed result; U1/U2: pending post-merge) for the PR description / issue comment.

---

## Self-Review

**1. Spec coverage:** D1 opt-in gate → Tasks 1+3 (A1/A4). D2 unchanged globs → Task 4 byte-identical guard + Task 5 static test (A5). D3 serial CI step → Task 5 (A5). D4 thresholds untouched → Global Constraints + Task 3 Step 2 (constants untouched). D5 instrumentation refusal → Tasks 1+2 (A1 row 4, A2). Docs → Task 6 (A8). Sweep → Task 7 (A3/A4/A6/A7). U1/U2 → explicitly post-merge, noted in header. Spec §9 migration order maps 1:1 onto Tasks 1–7. No gaps.

**2. Placeholder scan:** every code step contains full file/test content; no TBD/TODO/"add tests" without code.

**3. Type consistency:** `perfGateDecision(env)` → `{ run, reason }` used identically in Tasks 1/3; entry script path `scripts/run-perf-gate.mjs` identical in Tasks 2/4/5; `PERF_SKIP` name only used inside Task 3; test file names consistent across tasks (`test/perf-gate.test.mjs` Tasks 1-2, `test/perf-gate-wiring.test.mjs` Tasks 5-6).

**Residual risks accepted:** A7's flake-ledger clause requires judgment at sweep time; U1 stays dependent on the separate A5 mid-stream fix (spec §7 row).
