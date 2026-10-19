# reply guard CSI-key collision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the reply guard from swallowing kitty/modifyOtherKeys PageDown (`\x1b[6;<mods>u` / `\x1b[6;<mods>~`) while keeping every genuine cell-size reply fragment armed.

**Architecture:** One new pure predicate in `src/core/terminal-reply-guard.mjs`: a *complete* CSI key sequence is user input and must be classified before the `REPLY_HEADS` prefix loop. Every fragment shape the guard protects today has no `u`/`~` terminator, so the predicate cannot weaken #170's protection.

**Tech Stack:** ESM `.mjs` core module, `node:test` + `assert/strict`, TypeScript component (unchanged), `@earendil-works/pi-tui` (unchanged).

**Spec:** `docs/superpowers/specs/2026-10-19-issue-213-reply-guard-csi-key-design.md`

## Global Constraints

- Tabs for indentation; English comments and commit messages (repo AGENTS.md).
- No new dependencies.
- `npm run verify` must pass on CI (typecheck + perf gate + tests + coverage + pack dry-run). Locally only the targeted suites plus `typecheck`/`pack:dry` are authoritative — this Windows host has a pre-existing ~72-test baseline failure set that also fails on `main`.
- New test names carry the `#213-` prefix (spec §6 "验收 ID 作用域") to avoid colliding with the `A1:`/`A2:`/… names already in `test/terminal-reply-guard.test.mjs`.
- Do not change `REPLY_HEADS`, the absorption window (250 ms / 64 bytes), or the kill switch.

## Review Focus

- **A genuine cell-size fragment that looks like a key** — `\x1b[6;` and `\x1b[6;24` (no terminator) must still `reply-head` and arm; only `u`/`~`-terminated sequences are keys.
- **A complete reply that looks like a key** — `\x1b[6;24;80t` must still be `reply-complete`/drop (DROP_SHAPES runs first).
- **Other kitty functional keys that share a head prefix** — `\x1b[6;1:2;65u` (alternate keys) must also be treated as a key, which is why the predicate is `(?:[;:]\d+)*` and not the narrower form in the issue text.
- **A key that arrives while the guard is armed** — an armed window must not swallow it silently; the state machine's `armed + other` path drops the stale buffer and passes the event.
- **Plain text right after a key** — forwarding must stay byte-exact (no duplication, no reordering).

---

### Task 1: Classify complete CSI keys before the head prefixes

**Files:**
- Modify: `src/core/terminal-reply-guard.mjs` (add `CSI_KEY_SEQUENCE` near the other shape constants, and one branch in `classifyReplyEvent`)
- Test: `test/terminal-reply-guard.test.mjs`

**Interfaces:**
- Produces: `classifyReplyEvent(data)` now returns `{ kind: "other" }` for `CSI <num>[;<mod>[:<event>][;<alt>]]{u,~}`. No exported symbol changes.

- [ ] **Step 1: Write the failing tests**

Append to `test/terminal-reply-guard.test.mjs`:

```js
// Issue #213: kitty / modifyOtherKeys PageDown shares the cell-size head prefix.
test("#213-A1: a complete CSI key sequence is user input, never a reply head", () => {
	for (const seq of ["\x1b[6;1u", "\x1b[6;5u", "\x1b[6;1:2u", "\x1b[6;1:2;65u", "\x1b[6;5~", "\x1b[6;2~"]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "other" }, `${JSON.stringify(seq)} must be a key`);
	}
});

test("#213-A2: neighbouring keys are unaffected", () => {
	for (const seq of ["\x1b[5;1u", "\x1b[5;5~", "\x1b[57422u", "\x1b[57421u", "\x1b[3;5~"]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "other" }, `${JSON.stringify(seq)} must stay a key`);
	}
});

test("#213-A3: genuine cell-size fragments still arm", () => {
	for (const seq of ["\x1b[6;", "\x1b[6;24"]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "reply-head", family: "cell-size" });
	}
});

test("#213-A4: a complete cell-size reply still drops", () => {
	assert.deepEqual(classifyReplyEvent("\x1b[6;24;80t"), { kind: "reply-complete", family: "cell-size", action: "drop" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/terminal-reply-guard.test.mjs`
Expected: FAIL — `#213-A1` reports `{ kind: "reply-head", family: "cell-size" }` for `\x1b[6;1u` / `\x1b[6;5~`.

- [ ] **Step 3: Implement the predicate**

In `src/core/terminal-reply-guard.mjs`, next to `REPLY_HEADS`:

```js
// Issue #213: kitty keyboard protocol keys that carry a modifier use the legacy
// functional-key encoding `CSI <num>;<mods>u`, and PageDown's legacy number IS 6
// (`\x1b[6;1u` = no modifier, mods field is bitmask+1). modifyOtherKeys uses the same
// prefix with `~` (`\x1b[6;5~`). Both therefore share the cell-size head prefix
// (`\x1b[6;`), which used to arm the guard and swallow the key — asymmetric with
// PageUp (key number 5) and invisible to the previous tests.
//
// A COMPLETE CSI key is user input, never a reply fragment: check it before the head
// prefixes. Only the terminator decides — geniune cell-size fragments (`\x1b[6;`,
// `\x1b[6;24`) carry no `u`/`~` and still arm below. `(?:[;:]\d+)*` also covers the
// alternate-key form (`\x1b[6;1:2;65u`), which a narrower `(?:;\d+)?(?::\d+)?` misses.
const CSI_KEY_SEQUENCE = /^\x1b\[\d+(?:[;:]\d+)*[u~]$/;
```

and in `classifyReplyEvent`, after the `FORWARD_SHAPES` loop and **before** the `REPLY_HEADS` loop:

```js
	// Issue #213: a complete CSI key wins over the head prefixes (see CSI_KEY_SEQUENCE).
	if (CSI_KEY_SEQUENCE.test(data)) return { kind: "other" };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/terminal-reply-guard.test.mjs test/pty-scroll.test.mjs`
Expected: PASS (the four new tests plus the existing 15).

- [ ] **Step 5: Commit**

```bash
git add src/core/terminal-reply-guard.mjs test/terminal-reply-guard.test.mjs
git commit -m "fix(attach): classify complete CSI keys before the reply-guard head prefixes (issue #213)"
```

---

### Task 2: Prove the key actually reaches the child

**Files:**
- Modify: `test-support/attach-reply-guard-smoke.ts` (new case + result fields)
- Modify: `test/pty-attach-reply-guard.test.mjs` (assertions)

**Interfaces:**
- Consumes: `classifyReplyEvent` behaviour from Task 1 through the real `PtyAttachComponent.handleInput`.
- Produces: `out.guardedPageDown: string[]`, `out.guardedPageDownThenText: string[]` in the smoke's JSON.

- [ ] **Step 1: Write the failing assertions**

In `test/pty-attach-reply-guard.test.mjs`:

```js
assert.deepEqual(parsed.guardedPageDown, ["\x1b[6;1u", "\x1b[6;5~"], "kitty and modifyOtherKeys PageDown must be forwarded to the child, not swallowed");
assert.deepEqual(parsed.guardedPageDownThenText, ["\x1b[6;1u", "x"], "text after a key must still be forwarded verbatim");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pty-attach-reply-guard.test.mjs`
Expected: FAIL — `parsed.guardedPageDown` is `undefined`.

- [ ] **Step 3: Implement the smoke case**

In `test-support/attach-reply-guard-smoke.ts`, next to the existing `guardedFragments` case:

```ts
	// Issue #213: a complete CSI key must reach the child, not the absorption window.
	f.attach.handleInput("\x1b[6;1u");
	f.attach.handleInput("\x1b[6;5~");
	out.guardedPageDown = [...f.sent];

	// …and the bytes that follow a key are still forwarded verbatim.
	f.attach.handleInput("\x1b[6;1u");
	f.attach.handleInput("x");
	out.guardedPageDownThenText = [...f.sent];
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/pty-attach-reply-guard.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test-support/attach-reply-guard-smoke.ts test/pty-attach-reply-guard.test.mjs
git commit -m "test(attach): pin that kitty PageDown reaches the child through the reply guard (issue #213)"
```

---

### Task 3: Retire the pinned invariant in the docs

**Files:**
- Modify: `src/core/terminal-reply-guard.mjs` (module header comment)
- Modify: `docs/superpowers/specs/2026-10-14-issue-170-attach-reply-guard-design.md` (§3.3 design-points list)

**Interfaces:**
- Consumes: nothing at runtime; produces the text the A8 static check greps for.

- [ ] **Step 1: Update the module header**

In the `terminal-reply-guard.mjs` header, extend the paragraph that lists what arms a window with:

```
 * Issue #213: `\x1b[6;` is NOT a "can never be a key" prefix — kitty's functional-key
 * encoding puts PageDown at `CSI 6;<mods>u` (and modifyOtherKeys at `\x1b[6;<mods>~`).
 * The rule is therefore "a COMPLETE CSI key sequence (`u`/`~` terminated) beats the head
 * prefixes", not "these prefixes are never keys". Fragments without a terminator still arm.
```

- [ ] **Step 2: Append the correction to the #170 design doc**

In `docs/superpowers/specs/2026-10-14-issue-170-attach-reply-guard-design.md`, at the end of the §3.3 design-points list (do NOT rewrite L106 — append):

```markdown
7. **修正（issue #213）**：上一条「`ESC[6;` 永不可能是按键前缀」已被推翻 —— kitty 功能键编码
   把 PageDown 放在 `CSI 6;<mods>u`（modifyOtherKeys 为 `\x1b[6;<mods>~`），与 cell-size 的
   `ESC[6;` 共享前缀。现行规则是「**完整 CSI 键序列（以 `u`/`~` 终结）优先于 head 前缀**」，
   不带终结符的片段仍然武装。实现见 `CSI_KEY_SEQUENCE`。
```

- [ ] **Step 3: Verify the A8 greps**

Run:
```bash
grep -n "complete CSI key" src/core/terminal-reply-guard.mjs
grep -n "完整 CSI 键序列优先.*#213" docs/superpowers/specs/2026-10-14-issue-170-attach-reply-guard-design.md
grep -c "can never be a key" src/core/terminal-reply-guard.mjs
```
Expected: the first two each match at least once (the first inside the module header, not inside a function body); the third prints 0.

- [ ] **Step 4: Commit**

```bash
git add src/core/terminal-reply-guard.mjs docs/superpowers/specs/2026-10-14-issue-170-attach-reply-guard-design.md
git commit -m "docs(attach): retire the 'ESC[6; is never a key' invariant (issue #213)"
```

---

### Task 4: Full gate

**Files:** none (verification only).

- [ ] **Step 1: Type/static checks**

Run: `npm run typecheck && npm run pack:dry`
Expected: both clean.

- [ ] **Step 2: Targeted suites**

Run: `node --test test/terminal-reply-guard.test.mjs test/pty-attach-reply-guard.test.mjs test/pty-scroll.test.mjs test/pty-attach-wheel.test.mjs`
Expected: all green.

- [ ] **Step 3: Baseline comparison**

Run: `node --test test/pty-attach-*.test.mjs` and compare the failing set against the known Windows-host baseline (same set as on `main`; no new names).
Expected: no new failures.

- [ ] **Step 4: Commit**

Nothing to commit — this task is the gate the PR description cites.

---

### Task 5: Manual verification (U1)

**Files:** none.

- [ ] **Step 1: Load the fix into a real pi**

Per spec §6.1: `pi install "$(pwd)"` (README.md:54) or symlink the worktree to
`~/.pi/agent/extensions/agent-board`, **not** the `~/.pi/agent/git/...` cache clone.

- [ ] **Step 2: Restart pi completely** and open a new attach session.

- [ ] **Step 3: Press PageDown in the attach view** (WezTerm + pi fullscreen).
Expected: the panel scrolls one page backwards, mirroring PageUp; no swallowed key.

- [ ] **Step 4: Record the outcome** in the issue (pass/fail + observed behaviour).
