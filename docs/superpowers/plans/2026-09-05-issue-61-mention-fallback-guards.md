# Issue #61 Mention Fallback Guards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Rule 6 bare `#N` mention fallback from lifting placeholder numbers: left-boundary guard, inline-code-span exclusion, PR-context kind-aware skip, plus a documented providers.json example for internal-platform CLIs.

**Architecture:** Three guards inside `mentionFallback`/`MENTION_RE` (pure regex logic), one README example. Tests go through the public `extractCodeRefs` seam like all existing mention tests.

**Tech Stack:** Node built-in test runner; no new dependencies.

## Global Constraints

- Issue-only fallback stays (no PR mention candidate fabrication) — spec non-goals.
- Existing mention tests unchanged (spec A5).
- Only `src/core/code-refs.mjs`, `README.md` (Evidence section), `test/code-refs-extract.test.mjs` change (spec A7).
- Test command: `npm test`.

**Execution mode:** inline (executing-plans).

---

### Task 1: Red tests for the three guards + composite repro

**Files:**
- Modify: `test/code-refs-extract.test.mjs` (after the existing "mention fallback yields no winner" test, ~L283)

- [ ] **Step 1: Add failing tests**

```js
test("mention fallback ignores ##N heading forms and word-prefixed #N (issue #61)", () => {
	const result = extractCodeRefs(
		{ commands: [], assistantTexts: ["##1378", "##1378", "##1378", "a#1378", "b#99"], worktreePath: null, branch: null, repoUrl: null, host: null },
		github()
	);
	assert.equal(result.issue, null);
	assert.equal(result.pr, null);
});

test("mention fallback ignores #N inside inline code spans (issue #61)", () => {
	const result = extractCodeRefs(
		{ commands: [], assistantTexts: ["`monitor pr #1378`", "`#1378` x3", "see `#1378`"], worktreePath: null, branch: null, repoUrl: null, host: null },
		github()
	);
	assert.equal(result.issue, null);
});

test("mention fallback does not count pr-context #N toward issue candidates (issue #61)", () => {
	const result = extractCodeRefs(
		{ commands: [], assistantTexts: ["monitor pr #1378", "monitor pr #1378", "monitor pr #1378", "monitor pr #1378", "monitor pr #1378"], worktreePath: null, branch: null, repoUrl: null, host: null },
		github()
	);
	assert.equal(result.issue, null);
});

test("issue #61 repro shape: guarded placeholder loses, real issue prose wins", () => {
	const result = extractCodeRefs(
		{
			commands: [],
			assistantTexts: [
				"设置 IID=\"#1378\" 会让 \"#$IID\" 展开成 \"##1378\" → 404",   // ##1378 heading-guard form
				"`monitor pr #1378` 文档示例",                                   // code-span form
				"monitor pr #1378 用户独立调用",                                 // pr-context form
				"正在处理 issue #18", "issue #18 的修复", "更新 #18 状态",       // real issue prose ×3
			],
			worktreePath: null, branch: null, repoUrl: null, host: null,
		},
		github()
	);
	assert.equal(result.issue.number, 18);
	assert.equal(result.issue.strength, "mention");
});
```

Note on the heading test: `##1378` — with the guard, the second `#` is preceded by `#` → no match; the first `#` is followed by `#` not digits → no match. `a#1378`/`b#99`: preceded by word char → no match. Expected result with OLD code: `#1378` counts 3× (from the `##1378` lines' second hash) + more → a winner exists → test fails (red).

- [ ] **Step 2: Run, verify red**

Run: `node --test test/code-refs-extract.test.mjs`
Expected: the new tests fail against current code; existing tests green.

### Task 2: Implement the guards

**Files:**
- Modify: `src/core/code-refs.mjs` (MENTION_RE L549; mentionFallback L767)

- [ ] **Step 3: Code changes**

Replace:

```js
/** Bare `#N` mentions. */
const MENTION_RE = /#(\d{1,7})/g;
```

with:

```js
/**
 * Bare `#N` mentions. The lookbehind rejects a preceding `#` (markdown
 * headings, `##N` typos) or word character (`a#1`) — those are not issue
 * references (issue #61).
 */
const MENTION_RE = /(?<![#\w])#(\d{1,7})/g;
/** Inline code span (single-line) — excluded from mention counting. */
const INLINE_CODE_SPAN_RE = /`[^`\n]*`/g;
/** Explicit PR-context tokens immediately before a `#N` match. */
const PR_CONTEXT_RE = /(?:^|\W)(?:pr|pull|mr|merge)s?(?:\W|$)/i;
```

In `mentionFallback`, replace the counting loop:

```js
	for (let i = start; i < assistantTexts.length; i++) {
		const text = assistantTexts[i];
		if (typeof text !== "string") continue;
		for (const m of text.matchAll(MENTION_RE)) {
			const n = Number(m[1]);
			counts.set(n, (counts.get(n) ?? 0) + 1);
			lastIndex.set(n, baseIndex + i);
		}
	}
```

with:

```js
	for (let i = start; i < assistantTexts.length; i++) {
		const text = assistantTexts[i];
		if (typeof text !== "string") continue;
		// Doc examples inside inline code spans are not real references; strip
		// them before counting (issue #61).
		const stripped = text.replace(INLINE_CODE_SPAN_RE, " ");
		for (const m of stripped.matchAll(MENTION_RE)) {
			// `monitor pr #N` is explicitly PR context: do not count it toward
			// the issue fallback (issue #61).
			const before = stripped.slice(Math.max(0, m.index - 16), m.index);
			if (PR_CONTEXT_RE.test(before)) continue;
			const n = Number(m[1]);
			counts.set(n, (counts.get(n) ?? 0) + 1);
			lastIndex.set(n, baseIndex + i);
		}
	}
```

- [ ] **Step 4: Run test file, verify green**

Run: `node --test test/code-refs-extract.test.mjs`
Expected: all pass (new + existing).

- [ ] **Step 5: Full suite (A5)**

Run: `npm test`
Expected: all green.

### Task 3: README providers.json example (G1/A6)

**Files:**
- Modify: `README.md` (Evidence and Code References section)
- Modify: `test/code-refs-extract.test.mjs` (one JSON-validity test)

- [ ] **Step 6: Append after the section's first paragraph**

```markdown
For internal code platforms (non-github/gitlab hosts) or custom CLIs, add a
per-store `providers.json` so claim/action rules exist and sessions stop
depending on the low-confidence mention fallback. Example — an internal CLI
(`acli`) with claim-strength issue rules:

```json
{
  "providers": [
    {
      "name": "acode",
      "hosts": ["acode.internal.example.com"],
      "rules": [
        { "pattern": "acli\\s+issue\\s+update\\s+#?(\\d+)(?=[\\s\\S]*--assignee)", "kind": "issue", "strength": "claim" },
        { "pattern": "acli\\s+issue\\s+(?:note|comment|close)\\s+#?(\\d+)", "kind": "issue", "strength": "action" },
        { "pattern": "acli\\s+issue\\s+(?:show|view)\\s+#?(\\d+)", "kind": "issue", "strength": "view" }
      ]
    }
  ]
}
```

`hosts` matches the repo's remote host; rules follow the same
`pattern`/`kind`/`strength` shape as the built-in `gh`/`glab` tables
(`strength`: `claim` > `action` > `view`), and `#N` in the matched text
captures the number. Validation errors from a broken file are surfaced in the
diagnostics panel and never break extraction — the file is simply ignored.
```

- [ ] **Step 7: JSON-validity test**

```js
test("README providers.json example parses and validates (issue #61)", async () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const fence = readme.match(/```json\n(\{[\s\S]*?providers[\s\S]*?\})\n```/);
	assert.ok(fence, "README contains a json providers example");
	const parsed = JSON.parse(fence[1]);
	const { provider, errors } = validateProvider(parsed.providers[0]);
	assert.deepEqual(errors, []);
	assert.equal(provider.name, "acode");
	assert.equal(provider.rules.length, 3);
});
```

Add `validateProvider` to the import from `../src/core/code-refs.mjs` and
`readFileSync` to the node:fs import if not already present.

- [ ] **Step 8: Full suite + scope (A5/A7)**

Run: `npm test` and `git diff main -- src/ README.md test/ --stat`
Expected: all green; scope = code-refs.mjs, README.md, code-refs-extract.test.mjs.

- [ ] **Step 9: Commit**

```bash
git add src/core/code-refs.mjs README.md test/code-refs-extract.test.mjs
git commit -m "fix: guard mention fallback against placeholders, code spans, and pr-context (issue #61)"
```

## Self-Review

- Spec coverage: A1/A2/A3 (Task 1 red + Task 2), A4 (composite test), A5 (Step 5), A6 (Task 3), A7 (Step 8). Covered.
- Placeholder scan: full code shown.
- Type consistency: regexes module-level constants; matchAll index usage valid post-strip (indices refer to `stripped`, used only for the window check).
