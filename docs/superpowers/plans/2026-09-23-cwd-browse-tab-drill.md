# cwd 选择器 browse 模式 Tab 补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Start session 的 cwd 选择器在文件系统浏览（browse）模式下 Tab 键可用：补全高亮候选、连续 Tab 像 shell 一样逐层下钻（issue #127，选项 B）。

**Architecture:** 新语义全部沉到 `src/core/launch-options.mjs` 的两个纯函数（`sameResolvedDir`、`browseTabCompletion`）；`src/ui/dashboard.ts` 的 Tab 分支删掉 favorites-only 模式守卫，browse 走新 helper，favorites 逻辑一字不动。探针式集成测试（test-support/*.ts + `node --experimental-transform-types`）覆盖接线层，沿用 `navigation-wrap.ts` 既有模式。

**Tech Stack:** Node.js (node:test)、TypeScript（dashboard.ts，strip-types 经 transform 跑）、纯 JSDoc 的 .mjs core 层。

**Worktree（所有作业路径基准，记作 $WT）:** `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-127-cwd-browse-tab-drill`

**Spec:** `$WT/docs/superpowers/specs/2026-09-23-cwd-browse-tab-drill-design.md`（已提交，含验收矩阵 A1–A6/U1）

## Global Constraints

- 只在 $WT 内作业；git 操作用 `git -C $WT`；**禁碰主 checkout**。
- 测试命令：`node --test test/<file>.test.mjs`（在 $WT 下跑）；全量 `npm test`（= `node --test test/*.test.mjs`）。
- dashboard.ts 用了 TS parameter properties，测试必须经 `node --experimental-transform-types` 子进程跑探针；test-support/ 不在 tsconfig 内、不做 typecheck。
- 纯函数边界是实现硬约束：`sameResolvedDir` / `browseTabCompletion` 不得依赖 dashboard 状态；dashboard.ts 只接线。
- favorites 模式的既有 Tab 语义（补全进输入框、回车确认）一行不改。
- 不做 `~` 展开进收藏匹配（spec 已确认范围外）；不做 fuzzy 匹配。
- commit message 用 conventional commits（`fix:` / `feat:` / `test:`），按文件 `git add`，禁用 `git add -A`。

## 验收追溯（spec 验收 ID ↔ task）

| 验收 ID | 归属 task |
|---------|-----------|
| A4 纯函数 helper 边界 | Task 1 |
| A1 browse Tab 补全 + 重算 | Task 2 |
| A2 连续 Tab 逐层下钻 | Task 2 |
| A3 favorites Tab 不回归 | Task 2 |
| A5 browse 提示含 tab | Task 2 |
| A6 全量测试 + typecheck 无回归 | Task 3 |
| U1 真实 TUI 手感（用户实测） | Task 4（post-implementation manual verification） |

---

### Task 1: 纯函数 helpers —— `sameResolvedDir` + `browseTabCompletion`

**Files:**
- Modify: `$WT/src/core/launch-options.mjs`（在 `filterCwdCandidates` 附近追加；`expandHome` 定义于 :279，同文件可直接调用；`path` 已 import）
- Test: `$WT/test/launch-options.test.mjs`（现有 import 行 :6 追加两个函数名；文件已 import `node:assert/strict`、`node:test`；另需 `import os from "node:os";` 与 `import path from "node:path";`，若已有则复用）

**Interfaces:**
- Produces:
  - `sameResolvedDir(a: string, b: string): boolean` — 两路径串是否解析到同一目录；空白输入永不匹配。
  - `browseTabCompletion(query: string, suggestions: string[], index: number): { query: string, completed: string, usedIndex: number } | null` — browse 模式 Tab 补全计算；suggestions 为空返回 null。
- Consumes: 无（首个 task）。

- [ ] **Step 1: 写失败测试**（追加到 `$WT/test/launch-options.test.mjs`；先确认文件头部的 import 行，缺 `os`/`path` 就补）

```js
test("sameResolvedDir: matches across trailing separator and ~; blank never matches", () => {
	const home = os.homedir();
	assert.equal(sameResolvedDir("~/work", `${home}/work/`), true);
	assert.equal(sameResolvedDir("/a/b", "/a/c"), false);
	assert.equal(sameResolvedDir("", "/a"), false);
	assert.equal(sameResolvedDir("   ", "/a"), false);
});

test("browseTabCompletion: completes highlighted suggestion with trailing separator", () => {
	const res = browseTabCompletion("/tmp/x/wo", ["/tmp/x/work"], 0);
	assert.deepEqual(res, { query: `/tmp/x/work${path.sep}`, completed: "/tmp/x/work", usedIndex: 0 });
});

test("browseTabCompletion: no-progress highlight advances cyclically", () => {
	const s = ["/tmp/x/work", "/tmp/x/work/app", "/tmp/x/work/notes"];
	const res = browseTabCompletion(`/tmp/x/work${path.sep}`, s, 0);
	assert.equal(res.usedIndex, 1);
	assert.equal(res.query, `/tmp/x/work/app${path.sep}`);
	// wraps from the last entry back to the first
	const res2 = browseTabCompletion("/tmp/x/work/notes", ["/tmp/x/work", "/tmp/x/work/notes"], 1);
	assert.equal(res2.usedIndex, 0);
	assert.equal(res2.query, `/tmp/x/work${path.sep}`);
});

test("browseTabCompletion: single self suggestion stays put (drill naturally stops)", () => {
	const res = browseTabCompletion(`/tmp/x/work${path.sep}`, ["/tmp/x/work"], 0);
	assert.equal(res.query, `/tmp/x/work${path.sep}`);
	assert.equal(res.usedIndex, 0);
});

test("browseTabCompletion: empty suggestions -> null; out-of-range index clamps", () => {
	assert.equal(browseTabCompletion("x", [], 0), null);
	assert.equal(browseTabCompletion("x", null, 0), null);
	const res = browseTabCompletion("x", ["/a"], 7);
	assert.equal(res.usedIndex, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $WT && node --test test/launch-options.test.mjs`
Expected: FAIL（`sameResolvedDir is not defined` / import 报错）

- [ ] **Step 3: 实现 helpers**（追加到 `$WT/src/core/launch-options.mjs`，放在 `filterCwdCandidates` 之后、`nextCwdPickerState` 之前）

```js
/**
 * Whether two path strings resolve to the same directory. Blank inputs never
 * match (path.resolve("") would silently equal process.cwd()).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameResolvedDir(a, b) {
	const na = String(a ?? "").trim();
	const nb = String(b ?? "").trim();
	if (!na || !nb) return false;
	return path.resolve(expandHome(na)) === path.resolve(expandHome(nb));
}

/**
 * Browse-mode Tab completion for the cwd picker. Completes to the highlighted
 * suggestion with a trailing separator (so the next recompute lists that
 * directory's children); when the highlight already equals the current query
 * (no progress), advances cyclically so repeated Tab drills downward. A lone
 * self suggestion stays put, so drilling stops naturally at leaf directories.
 * @param {string} query
 * @param {string[]} suggestions
 * @param {number} index
 * @returns {{query: string, completed: string, usedIndex: number} | null}
 */
export function browseTabCompletion(query, suggestions, index) {
	if (!suggestions || suggestions.length === 0) return null;
	const len = suggestions.length;
	let usedIndex = ((index % len) + len) % len;
	let completed = suggestions[usedIndex];
	if (len > 1 && sameResolvedDir(completed, query)) {
		usedIndex = (usedIndex + 1) % len;
		completed = suggestions[usedIndex];
	}
	return { query: completed + path.sep, completed, usedIndex };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $WT && node --test test/launch-options.test.mjs`
Expected: PASS（新旧用例全绿）

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/core/launch-options.mjs test/launch-options.test.mjs
git -C $WT commit -m "feat: add browse-mode Tab completion helpers for cwd picker (issue #127)"
```

---

### Task 2: dashboard 接线 + browse 提示文案 + 探针集成测试

**Files:**
- Create: `$WT/test-support/cwd-browse-tab-probe.ts`
- Create: `$WT/test/dashboard-cwd-tab.test.mjs`
- Modify: `$WT/src/ui/dashboard.ts`（import 行；Tab 分支 :598-608；提示文案 :1586）

**Interfaces:**
- Consumes: Task 1 的 `sameResolvedDir`（不直接用）、`browseTabCompletion`（dashboard.ts 引用）。
- Produces: 无新对外接口（行为修复）。

- [ ] **Step 1: 写失败探针与测试**

Create `$WT/test-support/cwd-browse-tab-probe.ts`:

```ts
// cwd browse-Tab probe (issue #127): drive Tab through the public handleInput()
// in browse and favorites picker modes and report picker state as JSON.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";
import { nextCwdPickerState } from "../src/core/launch-options.mjs";

const root = mkdtempSync(join(tmpdir(), "agentview-cwd-tab-"));
const work = join(root, "work");
mkdirSync(join(work, "app"), { recursive: true });
mkdirSync(join(work, "notes"), { recursive: true });

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

const tui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
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

// TS-private is runtime-accessible; white-box the launch dialog open
// (input must be non-empty or openLaunchDialog bails back to list mode).
dash.input = "go";
dash.openLaunchDialog();
dash.openLaunchPicker("cwd", join(root, "wo"));

const out = { root, work };
out.mode0 = dash.launch.cwdPickerMode;
out.sugg0 = dash.launch.cwdSuggestions;

// Browse Tab 1: completes the highlighted candidate with a trailing separator.
dash.handleInput("\t");
out.afterTab1 = {
	query: dash.launch.cwdQuery,
	mode: dash.launch.cwdPickerMode,
	suggestions: dash.launch.cwdSuggestions,
	index: dash.launch.cwdSuggestionIndex,
};

// Browse Tab 2: highlight sits on the just-completed dir (no progress) -> drill into first child.
dash.handleInput("\t");
out.afterTab2 = { query: dash.launch.cwdQuery, mode: dash.launch.cwdPickerMode };

// Browse Tab 3: leaf dir has a lone self suggestion -> stable no-op.
dash.handleInput("\t");
out.afterTab3 = dash.launch.cwdQuery;

// Browse hint advertises tab completion (render while still in browse mode).
out.browseHint = dash.render(80).join("\n").includes("type to filter folders · tab complete");

// Favorites regression: ranked hit keeps the old complete-into-input semantics (no trailing separator).
const launch = dash.launch;
launch.cwdRanked = [{ path: work, count: 3 }];
launch.cwdQuery = "wo";
const st = nextCwdPickerState("wo", launch.cwdRanked, launch.cwd);
launch.cwdPickerMode = st.mode;
launch.cwdSuggestions = st.suggestions;
launch.cwdSuggestionIndex = 0;
dash.handleInput("\t");
out.fav = { query: dash.launch.cwdQuery, mode: dash.launch.cwdPickerMode };

dash.dispose();
console.log(JSON.stringify(out));
```

Create `$WT/test/dashboard-cwd-tab.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "cwd-browse-tab-probe.ts");

test("cwd picker: browse-mode Tab completes and drills; favorites Tab unchanged (issue #127)", () => {
	// dashboard.ts uses TS parameter properties, which strip-only mode rejects;
	// --experimental-transform-types handles them (Node 22.7+ / 24).
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const r = JSON.parse(out);
	const work = r.work;

	// A1: browse-mode Tab completes the highlighted candidate into the query.
	assert.equal(r.mode0, "browse");
	assert.deepEqual(r.sugg0, [work]);
	assert.equal(r.afterTab1.query, `${work}${sep}`);
	assert.equal(r.afterTab1.mode, "browse");
	assert.equal(r.afterTab1.suggestions[0], work);

	// A2: repeated Tab drills down like a shell (work/ -> work/app/), stopping at the leaf.
	assert.equal(r.afterTab2.query, `${join(work, "app")}${sep}`);
	assert.equal(r.afterTab2.mode, "browse");
	assert.equal(r.afterTab3, `${join(work, "app")}${sep}`);

	// A5: browse-mode hint advertises tab completion.
	assert.equal(r.browseHint, true);

	// A3: favorites mode keeps the original semantics (bare path, mode stays favorites).
	assert.equal(r.fav.query, work);
	assert.equal(r.fav.mode, "favorites");
});
```

- [ ] **Step 2: 跑测试确认失败（复现 bug）**

Run: `cd $WT && node --test test/dashboard-cwd-tab.test.mjs`
Expected: FAIL —— `r.afterTab1.query` 仍是探针 seed 的 `join(root, "wo")`（browse 模式 Tab 被静默吞掉），A1 断言先挂。

- [ ] **Step 3: 实现修复**

a) `$WT/src/ui/dashboard.ts` 顶部 import（:24 附近，现有 `nextCwdPickerState` 同一条 import 里）追加 `browseTabCompletion`。

b) 替换 Tab 分支（:598-608）为：

```ts
		if (launch.picker === "cwd" && matchesKey(data, Key.tab)) {
			if (launch.cwdSuggestions.length > 0) {
				if (launch.cwdPickerMode === "browse") {
					const completion = browseTabCompletion(launch.cwdQuery, launch.cwdSuggestions, launch.cwdSuggestionIndex);
					if (completion) {
						launch.cwdQuery = completion.query;
						const state = nextCwdPickerState(launch.cwdQuery, launch.cwdRanked, launch.cwd);
						launch.cwdPickerMode = state.mode;
						launch.cwdSuggestions = state.suggestions;
						launch.cwdSuggestionIndex = Math.max(0, state.suggestions.indexOf(completion.completed));
					}
				} else {
					const completed = launch.cwdSuggestions[launch.cwdSuggestionIndex] ?? launch.cwdSuggestions[0];
					launch.cwdQuery = completed;
					const state = nextCwdPickerState(launch.cwdQuery, launch.cwdRanked, launch.cwd);
					launch.cwdPickerMode = state.mode;
					launch.cwdSuggestions = state.suggestions;
					launch.cwdSuggestionIndex = Math.max(0, state.suggestions.indexOf(completed));
				}
			}
			return;
		}
```

c) browse 提示文案（:1586）：

```ts
				lines.push(t.fg("dim", "type to filter folders · tab complete · enter choose · esc back"));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $WT && node --test test/dashboard-cwd-tab.test.mjs`
Expected: PASS（A1/A2/A3/A5 全绿）

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/ui/dashboard.ts test-support/cwd-browse-tab-probe.ts test/dashboard-cwd-tab.test.mjs
git -C $WT commit -m "fix: browse-mode Tab completes and drills down directories in cwd picker (issue #127)"
```

---

### Task 3: 全量回归 + typecheck（A6）

**Files:** 无改动（纯验证）。

**Interfaces:**
- Consumes: Task 1、Task 2 的全部产物。
- Produces: 无。

- [ ] **Step 1: 全量测试**

Run: `cd $WT && npm test`
Expected: PASS（`node --test test/*.test.mjs` 全绿；特别关注 launch-options / dashboard 相关文件无回归）

- [ ] **Step 2: typecheck**

Run: `cd $WT && npm run typecheck`
Expected: PASS（`tsc --noEmit` 无错；dashboard.ts 对 `browseTabCompletion` 的调用类型正确，含 null 收窄）

- [ ] **Step 3: 如全量中有与本改动无关的既存 flake（对照 issue #95/#140 清单）失败，隔离复跑该文件确认；与本改动相关则回到对应 task 修**

---

### Task 4: 用户实测 U1（post-implementation manual verification）

**Files:** 无改动。

- [ ] **Step 1: 请用户实测**（PR 合并前执行；自动化测试通过不能替代本项）

操作步骤：
1. 从本 worktree 构建/链接后打开 agent-board 面板，进入 Start session。
2. 聚焦 cwd 字段，输入 `~/wo`（或任意 `~` 开头路径片段），确认候选列表出现后按 Tab。
3. 连续按 Tab 观察逐层下钻；用 ↑/↓ 调整高亮后再按 Tab；Enter 确认并启动 session。

观察结果（记录）：
- Tab 是否补全高亮候选进输入框；连续 Tab 是否逐层深入；叶子目录是否自然停止。
- 启动的 session cwd 是否为最终确认的目录。

通过标准：补全/下钻手感符合 shell 习惯；session cwd 正确；favorites 场景（输入收藏目录名片段）Tab 行为与 main 一致。

实测结果：**pending**（待用户执行）
