# Circular List Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard list arrow-key navigation wrap around (last ⇄ first) instead of clamping at boundaries.

**Architecture:** Change index clamping to modulo wrap in `moveSelection()` and `peekStep()` in `src/ui/dashboard.ts`. Scroll-follow needs no change (`windowBody()` keeps the selected row visible regardless of direction). Behavior is covered by a new child-process test following the `ui-smoke` pattern.

**Tech Stack:** Node 24 (`--experimental-transform-types`), node:test, TypeScript (parameter properties, no typecheck on test-support).

**Spec:** `docs/superpowers/specs/2026-08-30-circular-navigation-design.md`

## Global Constraints

- Work only in the worktree: `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation` (all paths below are relative to it).
- `npm test` = `node --test test/*.test.mjs`; `npm run typecheck` = `tsc --noEmit`. Both must stay green.
- `src/ui/dashboard.ts` uses TS parameter properties → it can only be imported from a child process spawned with `--experimental-transform-types` (the `test-support/ui-smoke.ts` pattern). Never import it directly from `test/*.test.mjs`.
- `tsconfig.json` excludes `test/` and `test-support/` — no type casts needed in the probe script.
- Do NOT touch the launch dialog pickers (`dashboard.ts` L539-547) — out of scope for this issue.
- Commit per task with conventional commits; `git add <file>` per file, never `git add -A`.
- `cur < 0` fallback semantics: out-of-list `selectedId` uses base index 0 — ↓ yields index 1 (second row, same as before); ↑ wraps to the last row (**changed** from the old clamp's first row — intentional, wrap-consistent, and effectively unreachable since `refresh()` keeps `selectedId` ∈ `orderedIds`).

---

### Task 1: `moveSelection()` 取模回绕 + 行为测试

**Files:**
- Modify: `src/ui/dashboard.ts:250-258` (`moveSelection`)
- Create: `test-support/navigation-wrap.ts` (probe script, prints JSON)
- Create: `test/dashboard-navigation.test.mjs` (node:test wrapper)

**Interfaces:**
- Consumes: existing `createService` (`src/runtime/service.mjs`), `createView` (`src/core/store.mjs`), `DashboardComponent` (`src/ui/dashboard.ts`), public method `handleInput(data: string)`.
- Produces: `test-support/navigation-wrap.ts` prints one JSON line `{ ids: string[], seq: (string|null)[] }`; Task 2 extends the same probe with a peek-mode segment (do not rewrite the file structure).

- [ ] **Step 1: Worktree dependency setup**

Worktree has no `node_modules`. Symlink from the main checkout (instant; postinstall patches already applied there):

```bash
WT=/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation
ln -s /home/elling/git-repo/github/pi-agent-board/node_modules "$WT/node_modules"
ls "$WT/node_modules/@mariozechner"  # sanity: pi-tui present
```

(Fallback if the symlink misbehaves: `cd "$WT" && npm ci`.)

- [ ] **Step 2: Write the failing test probe**

Create `test-support/navigation-wrap.ts`:

```ts
// Nav wrap probe: construct a dashboard with 3 views, drive arrow keys through
// the public handleInput(), and report the selection sequence as JSON.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-nav-wrap-"));
createView(root, { id: "v1", name: "one", cwd: root });
createView(root, { id: "v2", name: "two", cwd: root });
createView(root, { id: "v3", name: "three", cwd: root });

const service = createService({
	root,
	runnerScript: "/no/runner.mjs",
	piCommand: "pi",
	piArgsPrefix: [],
	defaultCwd: root,
	launch: () => ({ pid: null, configPath: "/no/config.json" }),
	launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
	launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
});

const writes = [];
const tui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: (d) => writes.push(d) },
	requestRender: () => {},
};
const theme = { fg: (_c, t) => t, bold: (t) => t };

const dash = new DashboardComponent(tui, theme, {}, () => {}, {
	service,
	root,
	defaultCwd: root,
	availableModels: [],
	currentModel: null,
	currentThinkingLevel: "off",
});

// TS-private is runtime-accessible; read white-box state for assertions.
const ids = dash.orderedIds;
const seq = [];
seq.push(dash.selectedId); // initial selection = ids[0]
dash.handleInput("\x1b[B"); // ↓ -> ids[1]
seq.push(dash.selectedId);
dash.handleInput("\x1b[B"); // ↓ -> ids[2]
seq.push(dash.selectedId);
dash.handleInput("\x1b[B"); // ↓ at last -> WRAP to ids[0]
seq.push(dash.selectedId);
dash.handleInput("\x1b[A"); // ↑ at first -> WRAP to ids[2]
seq.push(dash.selectedId);

dash.dispose();
console.log(JSON.stringify({ ids, seq }));
```

- [ ] **Step 3: Write the failing test wrapper**

Create `test/dashboard-navigation.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "navigation-wrap.ts");

test("list arrow-key navigation wraps around at both ends (issue #52)", () => {
	// dashboard.ts uses TS parameter properties, which strip-only mode rejects;
	// --experimental-transform-types handles them (Node 22.7+ / 24).
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const { ids, seq } = JSON.parse(out);
	assert.equal(ids.length, 3, "probe must see 3 rows");
	assert.deepEqual(
		seq,
		[ids[0], ids[1], ids[2], ids[0], ids[2]],
		"down past the last row wraps to first; up past the first wraps to last",
	);
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation
node --test test/dashboard-navigation.test.mjs
```

Expected: FAIL — `seq[3]` is `ids[2]` (clamped at last) instead of `ids[0]`, and `seq[4]` is `ids[0]` instead of `ids[2]`.

If the probe itself crashes (e.g. key sequence mismatch), debug the probe first — `matchesKey(data, Key.up/down)` must match `\x1b[A` / `\x1b[B]`; verify against `@mariozechner/pi-tui` `Key` defaults if not.

- [ ] **Step 5: Implement modulo wrap in `moveSelection()`**

In `src/ui/dashboard.ts`, replace:

```ts
	private moveSelection(delta: number): void {
		if (this.orderedIds.length === 0) return;
		const cur = this.selectedId ? this.orderedIds.indexOf(this.selectedId) : 0;
		const next = Math.max(0, Math.min(this.orderedIds.length - 1, (cur < 0 ? 0 : cur) + delta));
```

with:

```ts
	private moveSelection(delta: number): void {
		if (this.orderedIds.length === 0) return;
		const cur = this.selectedId ? this.orderedIds.indexOf(this.selectedId) : 0;
		const len = this.orderedIds.length;
		// Wrap around both ends: down past last -> first, up past first -> last.
		const next = (((cur < 0 ? 0 : cur) + delta) % len + len) % len;
```

Everything below that line (`const nextId = ...` through the end of the method) stays unchanged — the `nextId === this.selectedId` early return keeps single-row lists a no-op.

- [ ] **Step 6: Run test to verify it passes**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation
node --test test/dashboard-navigation.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Full test suite + typecheck**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation
npm test && npm run typecheck
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation
git add src/ui/dashboard.ts test-support/navigation-wrap.ts test/dashboard-navigation.test.mjs
git commit -m "fix: wrap list arrow-key navigation at both ends (issue #52)"
```

---

### Task 2: `peekStep()` 取模回绕 + peek 段测试

**Files:**
- Modify: `src/ui/dashboard.ts:1094-1101` (`peekStep`)
- Modify: `test-support/navigation-wrap.ts` (append peek segment)
- Modify: `test/dashboard-navigation.test.mjs` (assert extended sequence)

**Interfaces:**
- Consumes: Task 1's probe file and test wrapper; `peekId` / `mode` are TS-private fields on `DashboardComponent`, runtime-accessible from the probe (same white-box pattern as `selectedId`).
- Produces: probe JSON gains nothing new — `seq` grows by one entry (peek-mode wrap result); test asserts the 6-element sequence.

- [ ] **Step 1: Extend the probe with a peek-mode segment (failing)**

In `test-support/navigation-wrap.ts`, insert immediately BEFORE `dash.dispose();`:

```ts
// Peek mode: stepping down from the last row wraps to the first.
dash.peekId = ids[2];
dash.selectedId = ids[2];
dash.mode = "peek";
dash.handleInput("\x1b[B"); // ↓ at last in peek -> WRAP to ids[0]
seq.push(dash.selectedId);
```

And in `test/dashboard-navigation.test.mjs`, replace the final assertion with:

```js
	assert.deepEqual(
		seq,
		[ids[0], ids[1], ids[2], ids[0], ids[2], ids[0]],
		"list and peek navigation wrap around at both ends",
	);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation
node --test test/dashboard-navigation.test.mjs
```

Expected: FAIL — `seq[5]` is `ids[2]` (peek clamped at last) instead of `ids[0]`.

- [ ] **Step 3: Implement modulo wrap in `peekStep()`**

In `src/ui/dashboard.ts`, replace:

```ts
	private peekStep(delta: number): void {
		if (!this.peekId) return;
		const idx = this.orderedIds.indexOf(this.peekId);
		if (idx < 0) return;
		const next = Math.max(0, Math.min(this.orderedIds.length - 1, idx + delta));
```

with:

```ts
	private peekStep(delta: number): void {
		if (!this.peekId) return;
		const idx = this.orderedIds.indexOf(this.peekId);
		if (idx < 0) return;
		const len = this.orderedIds.length;
		// Wrap around both ends, same as moveSelection().
		const next = ((idx + delta) % len + len) % len;
```

The two lines below (`this.peekId = ...; this.selectedId = ...`) stay unchanged. `len` is guaranteed `>= 1` here because `idx >= 0` implies the id was found in `orderedIds`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation
node --test test/dashboard-navigation.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Full test suite + typecheck**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation
npm test && npm run typecheck
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-52-circular-navigation
git add src/ui/dashboard.ts test-support/navigation-wrap.ts test/dashboard-navigation.test.mjs
git commit -m "fix: wrap peek-mode stepping at both ends (issue #52)"
```

---

## Self-Review 记录

- **Spec coverage**：spec 改动点 #1 → Task 1；改动点 #2 → Task 2；滚动跟随"不改"已在 Global Constraints 外无对应任务（无需任务）；launch picker 非目标 → Global Constraints 显式禁止。测试要求 → 两任务各带 TDD 循环。✅ 无缺口。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤含完整可运行代码。✅
- **Type consistency**：`orderedIds` / `selectedId` / `peekId` / `mode` / `handleInput(data: string)` / `dispose()` 名称与 `src/ui/dashboard.ts` 实际成员一致；probe 的 JSON 形状 `{ ids, seq }` 在两个任务间一致（Task 2 只扩 seq 长度）。✅
