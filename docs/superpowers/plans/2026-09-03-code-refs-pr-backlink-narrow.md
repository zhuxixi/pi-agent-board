# code-refs PR Back-Link Narrowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop code-review report text (e.g. "上轮 issue #1") from being mis-extracted as a claim-strength PR back-link, by splitting the back-link grammar by evidence context (PR-create command vs. later assistant text) and removing the unbounded follow-up command scan (issue #65).

**Architecture:** All behavior changes live in the pure engine `src/core/code-refs.mjs`. One shared regex (`PR_BACKLINK_RE`) becomes two context-specific matchers: `PR_CREATE_BACKLINK_RE` (explicit `pr create` body, keeps the legacy bare `issue #N` form) and `PR_FOLLOWUP_BACKLINK_RE` (later assistant text, canonical `Closes/Fixes/Resolves #N` only). Rule 4b's resolver becomes assistant-only and runs only when exactly one distinct PR-create command index exists. Store/render layers are untouched.

**Tech Stack:** Node.js ≥20 ESM (`node --test`), zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-code-refs-pr-backlink-narrow-design.md` (approved 2026-09-03).

## Global Constraints

- All edits happen in the worktree `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-65-code-refs-pr-backlink-narrow` (branch `issue-65-code-refs-pr-backlink-narrow`). Never touch the main checkout.
- Commit messages: English, conventional commits, reference `issue #65`. Stage by exact file path, never `git add -A`.
- No new exports from `code-refs.mjs` (internal helpers stay module-private; tests go through `extractCodeRefs`).
- Do not modify `code-refs-store.mjs` runtime logic, `github.json` schema, `mergeWithExisting`, providers.json schema, or the mention fallback (issue #61).
- No network calls, no I/O in the engine — it stays a pure function module.
- Coverage gates from `.c8rc.json`: lines ≥85%, functions ≥80%, branches ≥70% (`npm run verify` enforces).
- Test commands run from the worktree root: `node --test test/code-refs-extract.test.mjs` / `node --test test/code-refs-store.test.mjs`. (NOT `npm test -- <file>` — that script keeps its glob and runs everything.)

**Acceptance mapping:** Task 1 → A2; Task 2 → A1, A2, A3; Task 3 → A4; Task 4 → A5. Spec IDs are quoted in each task.

---

### Task 1: Split the back-link regex into create/followup matchers

**Files:**
- Modify: `src/core/code-refs.mjs:509-510` (constant), `src/core/code-refs.mjs:637-640` (`applyPrBacklink`), `src/core/code-refs.mjs:651-660` (`resolveBacklinkAfter` body — matcher swap only, signature unchanged in this task)
- Test: `test/code-refs-extract.test.mjs` (append new test)

**Interfaces:**
- Consumes: existing `applyPrBacklink(text, index, candidates)` call site at `src/core/code-refs.mjs:571`; existing `resolveBacklinkAfter(marker, commands, assistantTexts, stopBefore)` (Task 1 only swaps the regex used inside it).
- Produces (module-private, used by Task 2): `matchPrCreateBacklink(text) → number|null`, `matchPrFollowupBacklink(text) → number|null`, constants `PR_CREATE_BACKLINK_RE`, `PR_FOLLOWUP_BACKLINK_RE`. `PR_BACKLINK_RE` is deleted.

Covers spec A2: create body keeps bare `issue #40`; both regexes gain word boundaries and the `(?!\w)` number guard.

- [ ] **Step 1: Write the failing test**

Append to `test/code-refs-extract.test.mjs` (after the "pr-body back-link is case-insensitive" test):

```js
test("pr create body back-link word boundaries and number guard (issue #65)", () => {
	const run = (body) =>
		extractCodeRefs(
			{
				commands: [{ command: `gh pr create --title t --body "${body}"` }],
				assistantTexts: [],
				worktreePath: null,
				branch: null,
				repoUrl: "owner/repo",
				host: "github.com",
			},
			github()
		);
	// Embedded-keyword prose must not match.
	assert.equal(run("prefix #1 disclose #2 unresolved #3").issue, null);
	// 8-digit numbers are rejected wholesale, not truncated to 7 digits.
	assert.equal(run("closes #12345678").issue, null);
	// Canonical and legacy forms keep working.
	assert.equal(run("fixes issue #40").issue?.number, 40);
	assert.equal(run("fixes issue #40").issue?.source, "pr-body");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/code-refs-extract.test.mjs`
Expected: FAIL — the old regex matches `fix #1` inside `"prefix #1 ..."` so `run("prefix #1 ...").issue` is `1`, not `null` (assert diff shows `1 !== null`).

- [ ] **Step 3: Implement the split**

In `src/core/code-refs.mjs`, replace lines 509-510:

```js
/** `closes #N` / `fixes #N` / `issue #N` back-link inside a `pr create` body. */
const PR_BACKLINK_RE = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|issue)\s+#(\d{1,7})/i;
```

with:

```js
/**
 * Back-link inside an explicit `pr create` command body: closing keywords
 * (optionally followed by "issue") or the legacy bare `issue #N` form.
 * Word boundaries keep embedded keywords (prefix/disclose/unresolved) out;
 * `(?!\w)` rejects longer numbers instead of truncating them to 7 digits.
 */
const PR_CREATE_BACKLINK_RE =
	/\b(?:(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+(?:issue\s+)?|issue\s+)#(\d{1,7})(?!\w)/i;
/**
 * Back-link in later assistant evidence: canonical closing-keyword syntax
 * only (`closes #N` etc.). A bare `issue #N` mention — e.g. a code-review
 * report's finding number — never matches here (issue #65).
 */
const PR_FOLLOWUP_BACKLINK_RE =
	/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+#(\d{1,7})(?!\w)/i;
```

Add the two module-private matchers right after the constants (before `WORKTREE_RE`):

```js
/**
 * Match a PR→issue back-link in the text of an explicit `pr create` command
 * (closing keywords or the legacy bare `issue #N` body form).
 * @param {string} text
 * @returns {number|null}
 */
function matchPrCreateBacklink(text) {
	const m = PR_CREATE_BACKLINK_RE.exec(text);
	return m ? Number(m[1]) : null;
}

/**
 * Match a PR→issue back-link in later assistant evidence — canonical
 * closing-keyword syntax only, never a bare `issue #N` (issue #65).
 * @param {string} text
 * @returns {number|null}
 */
function matchPrFollowupBacklink(text) {
	const m = PR_FOLLOWUP_BACKLINK_RE.exec(text);
	return m ? Number(m[1]) : null;
}
```

Rewrite `applyPrBacklink` (currently lines 637-640):

```js
function applyPrBacklink(text, index, candidates) {
	const number = matchPrCreateBacklink(text);
	if (number !== null) addCandidate(candidates, "issue", number, "claim", "pr-body", index);
}
```

Inside `resolveBacklinkAfter` (lines 651-660), replace the matching lines

```js
		const m = PR_BACKLINK_RE.exec(text);
		if (m) return { number: Number(m[1]), index };
```

with:

```js
		const number = matchPrFollowupBacklink(text);
		if (number !== null) return { number, index };
```

(Signature, loop bounds, and `stopBefore` stay as-is in this task — Task 2 restructures them.)

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/code-refs-extract.test.mjs`
Expected: PASS — new test plus all 19 existing tests (legacy `issue #40` body at :54, case-insensitive `Closes #40` at :77, later-assistant-message back-link at :150 all stay green because their forms are preserved by the split).

- [ ] **Step 5: Commit**

```bash
git add src/core/code-refs.mjs test/code-refs-extract.test.mjs
git commit -m "fix(code-refs): split PR back-link regex into create/followup matchers with word boundaries (issue #65)"
```

---

### Task 2: Assistant-only follow-up scan, gated on a single PR create

**Files:**
- Modify: `src/core/code-refs.mjs:590-608` (Rule 3 loop + Rule 4b call site), `src/core/code-refs.mjs:642-660` (`resolveBacklinkAfter` rewrite; `evidenceTextAt` callers)
- Test: `test/code-refs-extract.test.mjs` (2 existing tests rewritten, 4 new tests)

**Interfaces:**
- Consumes: `matchPrFollowupBacklink(text)` from Task 1.
- Produces: `resolveBacklinkAfter(assistantTexts, baseIndex)` → `{ number: number, index: number } | null` (module-private). `evidenceTextAt` is deleted if it has no remaining callers after this task — verify with `rg -n "evidenceTextAt" src/core/code-refs.mjs` and remove it only when unused (its other caller `resolveCreate` still needs it — check first; if `resolveCreate` keeps it, leave `evidenceTextAt` in place).

Covers spec A1 (real false-positive fixture), A3 (commands never promoted; multi-PR skips), and the follow-up half of A2 (assistant negative forms).

- [ ] **Step 1: Rewrite the two behavior-contract tests (they must fail before implementation)**

In `test/code-refs-extract.test.mjs`, replace the test at :110 ("back-link between two pr creates belongs to the first create only") with:

```js
test("echo back-link command between two pr creates is ignored (issue #65)", () => {
	const result = extractCodeRefs(
		{
			commands: [
				{ command: "gh pr create --title A" },
				{ command: 'echo "closes #40"' },
				{ command: "gh pr create --title B" },
			],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	// Later commands are never scanned as PR back-links, and two PR creates
	// disable the assistant scan — so nothing is extracted here.
	assert.equal(result.issue, null);
});
```

Replace the test at :131 ("second pr create absorbs only the back-link that follows it") with:

```js
test("assistant back-link with two pr creates produces no pr-backlink (issue #65)", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh issue comment 40 --body hi" }, { command: "gh pr create --title A" }, { command: "gh pr create --title B" }],
			assistantTexts: ["PR B closes #60"],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	// Ambiguous attribution (two PR creates) → assistant scan skipped; the
	// issue falls back to the plain command action, never a guessed PR link.
	assert.equal(result.issue?.number, 40);
	assert.equal(result.issue?.strength, "action");
	assert.equal(result.issue?.source, "command");
	assert.ok(!result.allRefs.some((r) => r.source === "pr-backlink"));
});
```

- [ ] **Step 2: Add the four new tests (A1 + A3 + follow-up negatives)**

Append to `test/code-refs-extract.test.mjs`:

```js
test("issue 65 regression: CR-report finding numbers never become pr-backlinks", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: 'gh pr create --title fix --body "Closes #19"' }],
			assistantTexts: [
				"CR 报告：本轮仅验证上轮 issue #1（no-pushback）",
				"pushback verdict for issue #1",
			],
			worktreePath: "/repo/.pi/worktrees/issue-19-fix-thing",
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue?.number, 19);
	assert.ok(!result.allRefs.some((r) => r.kind === "issue" && r.number === 1));
});

test("later assistant bare issue mentions and non-canonical forms are not pr back-links", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh pr create --title t" }],
			assistantTexts: [
				"Progress note: 上轮 issue #1 已验证",
				"pushback verdict for issue #1, plus prefix #2 disclose #3",
			],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue, null);
	assert.ok(!result.allRefs.some((r) => r.source === "pr-backlink"));
});

test("later close/comment/echo commands are not promoted to pr back-links", () => {
	const result = extractCodeRefs(
		{
			commands: [
				{ command: 'gh pr create --title t --body "Closes #19"' },
				{ command: "gh issue close #21" },
				{ command: 'gh pr comment 20 --body "fixes #21"' },
				{ command: 'echo "closes #21"' },
			],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue?.number, 19);
	assert.ok(!result.allRefs.some((r) => r.source === "pr-backlink"));
	// #21 keeps its own plain command-action semantics (not a PR back-link).
	const ref21 = result.allRefs.find((r) => r.kind === "issue" && r.number === 21);
	assert.equal(ref21?.source, "command");
});

test("follow-up back-link still found in later assistant message with a single pr create", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh pr create --title t --body-file /tmp/body.md" }],
			assistantTexts: ["Opened the PR. This PR closes #40."],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue?.number, 40);
	assert.equal(result.issue?.source, "pr-backlink");
});
```

(The last test duplicates coverage of the existing :150 test but pins the new single-create gate explicitly; keep both.)

- [ ] **Step 3: Run tests to verify the new expectations fail**

Run: `node --test test/code-refs-extract.test.mjs`
Expected: FAIL — the two rewritten tests fail because the current code still scans commands (`echo "closes #40"` yields issue 40) and still attributes `PR B closes #60` to create B; the A3 command-promotion test fails because `gh issue close #21` currently becomes a `pr-backlink` claim that beats #19.

- [ ] **Step 4: Implement the gate and the assistant-only resolver**

In `src/core/code-refs.mjs`, restructure the Rule 3 loop (lines 590-608). Replace:

```js
	// Rule 3: resolve pending create markers against subsequent evidence.
	for (let mi = 0; mi < pendingCreates.length; mi++) {
		const marker = pendingCreates[mi];
		const resolved = resolveCreate(marker, commands, assistantTexts, urlRules);
		if (resolved) {
			addCandidate(candidates, marker.kind, resolved.number, "action", "create-url", resolved.index);
		}
		// Rule 4b: the issue back-link of a created PR may live in a later
		// assistant message ("This PR closes #40") or in --body-file content
		// that never appears in the command string — scan subsequent evidence
		// for the back-link pattern as well (not just the command itself).
		// The scan stops at the NEXT pr-create marker so an earlier create
		// never absorbs a later PR's back-link.
		if (marker.kind === "pr") {
			const nextPr = pendingCreates.slice(mi + 1).find((m) => m.kind === "pr");
			const backlink = resolveBacklinkAfter(marker, commands, assistantTexts, nextPr?.index ?? Infinity);
			if (backlink) addCandidate(candidates, "issue", backlink.number, "claim", "pr-backlink", backlink.index);
		}
	}
```

with:

```js
	// Rule 3: resolve pending create markers against subsequent evidence.
	for (const marker of pendingCreates) {
		const resolved = resolveCreate(marker, commands, assistantTexts, urlRules);
		if (resolved) {
			addCandidate(candidates, marker.kind, resolved.number, "action", "create-url", resolved.index);
		}
	}
	// Rule 4b: the issue back-link of a created PR may live in a later
	// assistant message ("This PR closes #40") or in --body-file content that
	// never appears in the command string. The flattened evidence input keeps
	// no interleaving timestamps, so a follow-up back-link can be attributed
	// only when exactly one distinct PR-create command exists; with zero or
	// multiple PR creates the assistant scan is skipped rather than guessing.
	// Later commands are never scanned: `gh issue close #N` or
	// `gh pr comment ... fixes #N` are their own signals, not this PR's
	// back-link (issue #65).
	const prCreateIndexes = new Set(pendingCreates.filter((m) => m.kind === "pr").map((m) => m.index));
	if (prCreateIndexes.size === 1) {
		const backlink = resolveBacklinkAfter(assistantTexts, commands.length);
		if (backlink) addCandidate(candidates, "issue", backlink.number, "claim", "pr-backlink", backlink.index);
	}
```

Replace `resolveBacklinkAfter` (lines 642-660) entirely with:

```js
/**
 * Find the first PR→issue back-link in later assistant texts — canonical
 * closing-keyword syntax only ("Closes #N" etc., see
 * PR_FOLLOWUP_BACKLINK_RE). Commands are never scanned. `baseIndex` (the
 * command count) keeps the existing ordering contract; it is not a real
 * timestamp.
 * @param {string[]} assistantTexts
 * @param {number} baseIndex
 * @returns {{number: number, index: number}|null}
 */
function resolveBacklinkAfter(assistantTexts, baseIndex) {
	for (let i = 0; i < assistantTexts.length; i++) {
		const text = assistantTexts[i];
		if (typeof text !== "string" || !text) continue;
		const number = matchPrFollowupBacklink(text);
		if (number !== null) return { number, index: baseIndex + i };
	}
	return null;
}
```

Then check `evidenceTextAt`: `resolveCreate` still uses it — leave it in place. Verify with `rg -n "evidenceTextAt" src/core/code-refs.mjs` (expect 2 hits: definition + `resolveCreate`).

- [ ] **Step 5: Run tests to verify pass**

Run: `node --test test/code-refs-extract.test.mjs`
Expected: PASS — all tests green, including the two rewritten contract tests and the four new tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/code-refs.mjs test/code-refs-extract.test.mjs
git commit -m "fix(code-refs): scan only assistant texts for follow-up back-links, gated on a single PR create (issue #65)"
```

---

### Task 3: Store-level regression tests (persistence path)

**Files:**
- Test only: `test/code-refs-store.test.mjs` (append two tests after "partial re-trigger carries forward the untouched kind's earned ref")

**Interfaces:**
- Consumes: existing helpers `freshRoot()`, `makeRepo()`, `gitAvailable()` (defined at the top of the test file, lines 18-40); existing exports `updateCodeRefsFromEvidence`, `readCodeRefs`, `writeCodeRefs` from `src/core/code-refs-store.mjs`; engine behavior from Tasks 1-2.
- Produces: nothing (pure test additions — proves spec A4).

Covers spec A4: the persisted `github.json` never gains a new `pr-backlink #1` from CR-report evidence, and a pre-existing stale `pr-backlink` ref is explicitly NOT retroactively cleaned (documented non-goal).

- [ ] **Step 1: Write the two failing tests**

Append to `test/code-refs-store.test.mjs`:

```js
test("CR-report finding numbers never surface as issue refs through the store hook (issue #65)", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	const repo = makeRepo();
	try {
		const evidence = {
			viewId: "v1",
			commands: [{ id: "c1", command: 'gh pr create --title fix --body "Closes #19"' }],
			assistantEvidence: [
				{ at: 1, text: "CR 报告：本轮仅验证上轮 issue #1（no-pushback）" },
				{ at: 2, text: "pushback verdict for issue #1" },
			],
		};
		assert.equal(updateCodeRefsFromEvidence(root, "v1", evidence, { cwd: repo, repoRoot: repo, worktreePath: "issue-19-fix-thing" }), true);
		const snap = readCodeRefs(root, "v1");
		assert.equal(snap.provider, "github");
		assert.equal(snap.issue?.number, 19);
		assert.equal(snap.issue?.source, "pr-body");
		assert.ok(!snap.allRefs.some((r) => r.kind === "issue" && r.number === 1));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("pre-existing stale pr-backlink ref is not retroactively cleaned (issue #65 non-goal)", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	const repo = makeRepo();
	try {
		const stale = {
			kind: "issue",
			number: 1,
			strength: "claim",
			confidence: "high",
			source: "pr-backlink",
			url: null,
			lastIndex: 3,
		};
		writeCodeRefs(root, { version: 1, viewId: "v1", updatedAt: 1, provider: "github", issue: stale, pr: null, allRefs: [stale] });
		const evidence = {
			viewId: "v1",
			commands: [{ id: "c1", command: 'gh pr create --title fix --body "Closes #19"' }],
			assistantEvidence: [],
		};
		assert.equal(updateCodeRefsFromEvidence(root, "v1", evidence, { cwd: repo, repoRoot: repo }), true);
		const after = readCodeRefs(root, "v1");
		// Fresh extraction wins the badge...
		assert.equal(after.issue?.number, 19);
		// ...but the historical stale ref carries forward (documented non-goal:
		// no retroactive artifact cleanup in this issue).
		assert.ok(after.allRefs.some((r) => r.kind === "issue" && r.number === 1));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run tests to verify they pass already (engine fix landed in Task 2)**

Run: `node --test test/code-refs-store.test.mjs`
Expected: PASS. These are persistence-path proofs: on the unfixed engine the first test would fail with `snap.issue.number === 1`; now the engine from Tasks 1-2 makes them green. If either fails, the engine regression (not these tests) is what to investigate.

- [ ] **Step 3: Commit**

```bash
git add test/code-refs-store.test.mjs
git commit -m "test(code-refs): store-level regression — CR findings never surface as issue refs (issue #65)"
```

---

### Task 4: Documentation sync + full verification

**Files:**
- Modify: `src/core/code-refs.mjs` (doc comments only — verify no stale references), `docs/superpowers/specs/2026-08-29-code-refs-badges-design.md:66` (C2 claim row)

**Interfaces:**
- Consumes: final engine behavior from Tasks 1-2.
- Produces: docs consistent with the code; `npm run verify` green (spec A5).

Covers spec F3 and A5.

- [ ] **Step 1: Update the original design doc's C2 claim row**

In `docs/superpowers/specs/2026-08-29-code-refs-badges-design.md`, replace the row:

```markdown
| claim | PR 回链：`gh pr create` 的 body/后续文本中的 `issue #N` / `Closes #N`（同时定 issue + PR 两个值） | commands + assistantTexts |
```

with:

```markdown
| claim | PR 回链（按证据上下文拆分，issue #65）：`gh pr create` body 中的 `Closes #N` / `fixes issue #N` / 兼容裸 `issue #N`；后续 assistant 文本仅认 canonical `Closes/Fixes/Resolves #N`（带单词边界与 7 位编号边界）；仅在恰好一个 PR create 命令时扫描 assistant，后续 command 不参与回链 | create 命令自身 + assistantTexts |
```

- [ ] **Step 2: Verify no stale references remain in the engine**

Run: `rg -n "PR_BACKLINK_RE" src/ test/`
Expected: no hits (only `PR_CREATE_BACKLINK_RE` / `PR_FOLLOWUP_BACKLINK_RE` exist). Also run `rg -n "next pr create|stopBefore" src/core/code-refs.mjs` — expected: no hits (Task 2 removed them; if any comment still mentions them, update the comment).

- [ ] **Step 3: Full verification (spec A5)**

Run: `npm run verify`
Expected: typecheck clean, all tests pass (including service / runner integration end-to-end badge tests, which use `gh issue edit` + URL paths unaffected by this change), c8 coverage gates met (lines ≥85%, functions ≥80%, branches ≥70%), `npm pack --dry-run` succeeds.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-29-code-refs-badges-design.md src/core/code-refs.mjs
git commit -m "docs(code-refs): sync back-link grammar in design spec and comments (issue #65)"
```

---

## Verification checklist (spec acceptance matrix)

| Spec ID | Verified by | Task |
|---------|-------------|------|
| A1 | `issue 65 regression` extractor test (winner #19, allRefs has no issue 1) + store hook test | 2, 3 |
| A2 | create-body word-boundary/number-guard test + rewritten legacy-compatible tests + assistant negative-forms test | 1, 2 |
| A3 | command-promotion test + two-pr-create skip tests (rewritten ×2, new ×0) | 2 |
| A4 | two store tests: no new `pr-backlink #1`; stale ref carries forward (non-goal documented) | 3 |
| A5 | `npm run verify` (typecheck + tests + coverage gates + pack dry-run) | 4 |
