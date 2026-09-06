# Evidence outputPreview Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `evidence.json` `commands[].outputPreview` storing `[object Object]` for bash tool results by extracting text from pi's `AgentToolResult.content` blocks (issue #41).

**Architecture:** New pure function `toolResultText(result)` in `src/core/heuristics.mjs` (symmetric with existing `assistantText`); `reduceEvidence` bash branch swaps `String(event.result ?? "")` for it. No data-structure changes, no migration.

**Tech Stack:** Node.js ESM, `node:test`, JSDoc types checked by `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-09-04-evidence-outputpreview-design.md` (acceptance IDs A1/A2/A3/U1 referenced below).

## Global Constraints

- All edits under worktree `$WT=/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-41-evidence-outputpreview-object`; git via `git -C $WT` — never touch main checkout.
- `toolResultText` must stay a pure function with zero side effects; do NOT inline it into `reduceEvidence` (spec §3 hard constraint).
- Unknown-shaped objects must yield `""`, never `"[object Object]"` (spec D2, #40's 宁可不显示也不错显示 principle).
- Legacy string `result` must keep passing through unchanged (spec D5).
- Do NOT change the 500-char truncate, `EvidenceCommand` shape, other tools' branches, or powershell handling (spec §5 non-goals).
- Stage files individually with `git -C $WT add <file>`; never `git add -A`.
- Full gate per task end: `npm run verify` (typecheck + test + coverage + pack:dry). Never `npm test -- <file>` (glob expands to full suite anyway).

---

### Task 1: `toolResultText` pure function (acceptance: A1)

**Files:**
- Modify: `src/core/heuristics.mjs` (after `assistantText`, line ~26)
- Test: `test/heuristics.test.mjs`

**Interfaces:**
- Produces: `toolResultText(result: any): string` — exported from `src/core/heuristics.mjs`. Task 2 imports it in `src/core/evidence.mjs`.
- Behavior table (spec D2): `null/undefined → ""`; `string → passthrough`; object with `content` array → text blocks `join("\n")` trimmed; object without content/text → `""`; number/bool → `String()`.

- [ ] **Step 1: Write the failing tests**

Append to `test/heuristics.test.mjs`, and add `toolResultText` to the existing import block from `../src/core/heuristics.mjs`:

```js
test("toolResultText extracts text blocks from AgentToolResult", () => {
	const result = {
		content: [
			{ type: "text", text: "line1" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "line2" },
		],
		details: { fullOutputPath: "/tmp/pi-bash-x.log" },
	};
	assert.equal(toolResultText(result), "line1\nline2");
});

test("toolResultText returns empty string for image-only content", () => {
	assert.equal(toolResultText({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }), "");
});

test("toolResultText returns empty string for object without content array", () => {
	assert.equal(toolResultText({ details: {} }), "");
	assert.equal(toolResultText({}), "");
});

test("toolResultText passes through plain strings (legacy events)", () => {
	assert.equal(toolResultText("ok"), "ok");
});

test("toolResultText handles nullish and scalar inputs", () => {
	assert.equal(toolResultText(null), "");
	assert.equal(toolResultText(undefined), "");
	assert.equal(toolResultText(42), "42");
	assert.equal(toolResultText(true), "true");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd $WT && node --test test/heuristics.test.mjs`
Expected: FAIL — `toolResultText is not defined` / import error.

- [ ] **Step 3: Implement `toolResultText` in `src/core/heuristics.mjs`**

Insert after the existing `assistantText` function:

```js
/**
 * Extract text from a pi AgentToolResult object
 * ({ content: [{ type: "text", text }, ...], details, ... }), or, defensively,
 * a plain string. Unknown-shaped objects yield "" — never "[object Object]"
 * (issue #41; mirrors pi's own convertToolResultOutput join("\n") semantics).
 * @param {any} result
 * @returns {string}
 */
export function toolResultText(result) {
	if (result == null) return "";
	if (typeof result === "string") return result;
	if (typeof result !== "object") return String(result);
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd $WT && node --test test/heuristics.test.mjs`
Expected: PASS (all 5 new tests + pre-existing suite).

- [ ] **Step 5: Commit**

```bash
git -C $WT add test/heuristics.test.mjs src/core/heuristics.mjs
git -C $WT commit -m "feat: add toolResultText extractor for AgentToolResult content (issue #41)"
```

---

### Task 2: `reduceEvidence` bash branch uses `toolResultText` (acceptance: A2, A3)

**Files:**
- Modify: `src/core/evidence.mjs` (import line 2; bash branch line ~196)
- Test: `test/evidence.test.mjs`

**Interfaces:**
- Consumes: `toolResultText(result: any): string` from Task 1.
- Produces: unchanged `EvidenceCommand` shape; `outputPreview` now carries extracted text.

- [ ] **Step 1: Write the failing test (real AgentToolResult shape)**

In `test/evidence.test.mjs`, inside the existing top-level test that builds `snap` (after the current `b1` end event at line ~24), append:

```js
	reduceEvidence(snap, { type: "tool_execution_end", toolCallId: "b2", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "https://github.com/zhuxixi/pi-agent-board/pull/45" }] } }, 31);
```

and alongside the existing assertions:

```js
	assert.equal(snap.commands.find((c) => c.id === "b2").outputPreview, "https://github.com/zhuxixi/pi-agent-board/pull/45");
```

(The pre-existing `b1` fixture with `result: "ok"` stays untouched — its `outputPreview` passthrough is the D5 regression guard.)

**Assertion ripple:** the new `b2` command raises the command count. In the same test, update the tail assertion:

```js
	assert.equal(summary.commandCount, 2);
```

(was `assert.equal(summary.commandCount, 1);`)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $WT && node --test test/evidence.test.mjs`
Expected: FAIL — `outputPreview` is `"[object Object]"` instead of the URL.

- [ ] **Step 3: Modify `src/core/evidence.mjs`**

Import line (currently):

```js
import { assistantText, classifyCommand, toolFileOperation, truncate } from "./heuristics.mjs";
```

becomes:

```js
import { assistantText, classifyCommand, toolFileOperation, toolResultText, truncate } from "./heuristics.mjs";
```

In `reduceEvidence`, `tool_execution_end` → `name === "bash"` branch, replace exactly this line:

```js
				outputPreview: truncate(String(event.result ?? ""), 500),
```

with:

```js
				outputPreview: truncate(toolResultText(event.result), 500),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd $WT && node --test test/evidence.test.mjs`
Expected: PASS — new assertion green AND legacy `"ok"` fixture still green (D5).

- [ ] **Step 5: Full verify gate**

Run: `cd $WT && npm run verify`
Expected: PASS — typecheck, full test suite, coverage, pack:dry all green.

- [ ] **Step 6: Commit**

```bash
git -C $WT add src/core/evidence.mjs test/evidence.test.mjs
git -C $WT commit -m "fix: extract evidence outputPreview from AgentToolResult content (issue #41)"
```

---

### Task 3: Post-merge manual verification (acceptance: U1, user-verified)

**Trigger:** after PR merge + board reloads the new extension on next pi session start.

- [ ] **Step 1:** In a real pi session, run a few bash commands (e.g. `gh pr create`, `git log`).
- [ ] **Step 2:** Inspect `~/.pi/agent/agent-board/views/<view>/evidence.json`.
- [ ] **Step 3:** Pass criteria: newly recorded bash commands show real output text in `outputPreview` (e.g. the `gh pr create` URL); no new `[object Object]` entries. Record observation result back on issue #41.
