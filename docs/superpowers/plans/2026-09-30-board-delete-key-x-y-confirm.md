# Board Delete Key `x` → `y` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 board 主列表新增 `x` → `(y/N)` 确认删除入口，同时完整保留旧的 `Ctrl+X` ×2 免确认快捷方式。

**Architecture:** 复用 dashboard 已有的确认机制（`pending` + `mode = "confirm"` + `handleConfirmKey`）与删除语义（`service.archive`，软删除、busy 先停 host/run）。改动 = `handleListKey` 一个按键分支 + 一个新的 `confirmDelete()` 方法 + 文案同步；不改 service 层、不改协议、不改多选态。

**Tech Stack:** TypeScript（`src/ui/dashboard.ts`）、Node 内置 test runner（`node:test`）、`--experimental-transform-types` 探针（`test-support/*.ts`）、c8 覆盖率。

**Spec:** `docs/superpowers/specs/2026-09-30-board-delete-key-x-y-confirm-design.md`

**Worktree (`$WT` in the commands below):** `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-150-board-delete-key-x-y-confirm`

## Global Constraints

- 工作目录：worktree 根 `<repo>/.pi/worktrees/issue-150-board-delete-key-x-y-confirm`；禁止改动 main checkout，禁止 `git checkout -b` / `git switch -c`。
- Node >= 20；测试命令 `npm test`（= `node --test test/*.test.mjs`），类型检查 `npm run typecheck`，全量验证 `npm run verify`（typecheck + perf gate + tests + coverage[lines 85 / funcs 80 / branches 70] + pack:dry）。
- 探针文件放 `test-support/`，用 `node --experimental-transform-types` 运行（dashboard.ts 使用 TS 参数属性）；`test-support/` 不参与类型检查。
- 缩进用 tab；代码注释、commit message 用英文；conventional commits（`test:` / `feat:` / `docs:`）。
- `git add <file>` 逐个文件 stage，禁止 `git add -A`。
- 不新增 export、不改 `PtyAttachResult` / 协议 / `service` 层；不改大写 `X`、evidence 的 `x`、多选态 `ctrl+x`。

## Review Focus

| # | 输入 / 失败模式 | 期望行为 | 归属测试 |
| --- | --- | --- | --- |
| 1 | 确认态下按 `x` / `q` / `n` / esc | 取消，不删除、无 notice | Task 1 A3 |
| 2 | 空列表 / 无选中行按 `x` | 静默返回，不崩溃、不进入 confirm | Task 1 A1b |
| 3 | busy 行（working）按 `x` | 提示标明会停 active run；`y` 后走 archive（停 host/run） | Task 1 A1c + A2 |
| 4 | insert 模式下按 `x` | 作为普通字符进编辑器，不触发删除 | Task 1 A5 |
| 5 | 旧 `ctrl+x` ×2 与 `x` 混按 | 500ms 窗口语义不变；按 `x` 清掉 arm，不叠加触发 | Task 2 A4 |

---

### Task 1: `x` → `(y/N)` 确认删除（主路径）

**Deliverable:** list 模式按 `x` 打开确认提示；`y` 执行 `service.archive` 并回到列表；`n` / esc / 其它键取消；busy 行提示会停 run；insert 模式的 `x` 不受影响。

**Files:**
- Create: `test-support/dashboard-delete-key-probe.ts`
- Create: `test/dashboard-delete-key.test.mjs`
- Modify: `src/ui/dashboard.ts`（`handleListKey` :355-390 加分支；新增 `confirmDelete()`，紧邻 `confirmDeleteState` :1035）

**Interfaces:**
- Consumes: `DashboardComponent` 构造签名 `(tui, theme, keybindings, done, deps: DashboardDeps)`；`deps.service.rows()/row(id)/archive(id)`；`handleConfirmKey` 既有语义（`y`/`Y`/enter = 确认，其它 = 取消）。
- Produces: `private confirmDelete(): void`（本 task 内部方法，不被其它 task 引用）。

- [ ] **Step 0: 安装依赖**

Run: `cd "$WT" && npm install`
Expected: 成功；出现 `node_modules/`。失败则停止并报告（后续所有测试依赖它）。

- [ ] **Step 1: 写失败的探针 + 测试**

创建 `test-support/dashboard-delete-key-probe.ts`：

```ts
// Delete-key probe: drive the dashboard delete gestures through the public
// handleInput() and report observable state as JSON. One run covers the new
// `x` -> (y/N) path plus the legacy ctrl+x and multi-select regressions.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

type Row = { meta: { id: string; name: string }; alive: boolean; hostAlive: boolean; state: Record<string, unknown> | null };

function makeEnv(): {
	service: ReturnType<typeof createService>;
	root: string;
	archiveCalls: string[];
	archiveManyCalls: string[][];
	setRowPatch: (fn: ((r: Row) => Row) | null) => void;
} {
	const root = mkdtempSync(join(tmpdir(), "agentview-delete-key-"));
	createView(root, { id: "v1", name: "one", cwd: root });
	createView(root, { id: "v2", name: "two", cwd: root });
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
	const archiveCalls: string[] = [];
	const realArchive = service.archive.bind(service);
	service.archive = ((id: string) => {
		archiveCalls.push(id);
		return realArchive(id);
	}) as typeof service.archive;
	// archiveMany calls archiveView directly (bypasses the archive wrapper
	// above), so the batch path needs its own recorder.
	const archiveManyCalls: string[][] = [];
	const realArchiveMany = service.archiveMany.bind(service);
	service.archiveMany = ((ids: string[]) => {
		archiveManyCalls.push([...ids]);
		return realArchiveMany(ids);
	}) as typeof service.archiveMany;
	const realRows = service.rows.bind(service);
	let rowPatch: ((r: Row) => Row) | null = null;
	service.rows = (() => realRows().map((r) => (rowPatch ? rowPatch(r as unknown as Row) : r))) as typeof service.rows;
	return { service, root, archiveCalls, archiveManyCalls, setRowPatch: (fn) => { rowPatch = fn; } };
}

const writes: string[] = [];
const tui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: (d: string) => { writes.push(d); } },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function makeDash(env: ReturnType<typeof makeEnv>): DashboardComponent {
	return new DashboardComponent(tui as never, theme as never, {} as never, () => {}, {
		service: env.service,
		root: env.root,
		defaultCwd: env.root,
		availableModels: [],
		currentModel: null,
		currentThinkingLevel: "off",
	} as never);
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return pred();
}

type Snapshot = { mode: string; prompt: string | null; notice: string | null; archived: string[] };

function snap(dash: DashboardComponent, env: ReturnType<typeof makeEnv>): Snapshot {
	const d = dash as unknown as { mode: string; pending: { prompt: string } | null; flash: { text: string } | null };
	return { mode: d.mode, prompt: d.pending?.prompt ?? null, notice: d.flash?.text ?? null, archived: [...env.archiveCalls] };
}

const report: Record<string, unknown> = {};

// 1) idle row: x opens the confirm prompt, nothing archived yet
{
	const env = makeEnv();
	const dash = makeDash(env);
	dash.handleInput("x");
	report.idlePrompt = snap(dash, env);
	dash.dispose();
}

// 2) busy row: prompt names the stopped run
{
	const env = makeEnv();
	env.setRowPatch((r) => ({ ...r, alive: true, hostAlive: true, state: { ...(r.state ?? {}), semanticState: "working" } }));
	const dash = makeDash(env);
	dash.handleInput("x");
	report.busyPrompt = snap(dash, env);
	dash.dispose();
}

// 3) cancel paths: n / esc / x again / q must not delete
{
	const cancel: Record<string, Snapshot> = {};
	for (const [name, key] of [["n", "n"], ["escape", "\x1b"], ["x", "x"], ["q", "q"]] as const) {
		const env = makeEnv();
		const dash = makeDash(env);
		dash.handleInput("x");
		dash.handleInput(key);
		cancel[name] = snap(dash, env);
		dash.dispose();
	}
	report.cancel = cancel;
}

// 4) y confirms: archive runs, notice lands, the row leaves the list
{
	const env = makeEnv();
	const dash = makeDash(env);
	const before = (dash as unknown as { orderedIds: string[] }).orderedIds[0];
	const beforeName = env.service.row(before)?.meta.name ?? "?";
	dash.handleInput("x");
	dash.handleInput("y");
	await waitFor(() => env.archiveCalls.length > 0, 5000);
	const after = dash as unknown as { orderedIds: string[]; selectedId: string; mode: string; flash: { level: string } | null };
	await waitFor(() => after.flash !== null, 5000);
	report.confirm = { ...snap(dash, env), beforeId: before, beforeName, orderedIds: after.orderedIds, selectedId: after.selectedId, level: after.flash?.level ?? null };
	dash.dispose();
}

// 5) insert mode: x is literal editor text
{
	const env = makeEnv();
	const dash = makeDash(env);
	dash.handleInput("i");
	dash.handleInput("x");
	const d = dash as unknown as { mode: string; input: string };
	report.insertMode = { mode: d.mode, input: d.input, archived: [...env.archiveCalls] };
	dash.dispose();
}

// 6) empty list: x is a no-op
{
	const root = mkdtempSync(join(tmpdir(), "agentview-delete-key-empty-"));
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
	const dash = new DashboardComponent(tui as never, theme as never, {} as never, () => {}, {
		service,
		root,
		defaultCwd: root,
		availableModels: [],
		currentModel: null,
		currentThinkingLevel: "off",
	} as never);
	dash.handleInput("x");
	const d = dash as unknown as { mode: string; pending: unknown };
	report.emptyList = { mode: d.mode, pending: d.pending ?? null, crashed: false };
	dash.dispose();
}

console.log(JSON.stringify(report));
```

创建 `test/dashboard-delete-key.test.mjs`：

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "dashboard-delete-key-probe.ts");

// One probe run feeds every assertion below.
const report = JSON.parse(
	execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 60_000,
	}),
);

test("A1: x opens a (y/N) confirm prompt naming the selected session", () => {
	assert.equal(report.idlePrompt.mode, "confirm");
	assert.match(report.idlePrompt.prompt, /^Delete "(one|two)"\? Session file is preserved\. \(y\/N\)$/);
	assert.deepEqual(report.idlePrompt.archived, [], "nothing archived before the confirm key");
});

test("A1b: x on an empty list is a no-op", () => {
	assert.equal(report.emptyList.mode, "list");
	assert.equal(report.emptyList.pending, null);
});

test("A1c: busy rows warn that deletion stops the active run", () => {
	assert.equal(report.busyPrompt.mode, "confirm");
	assert.match(report.busyPrompt.prompt, /Stops the active run\./);
});

test("A3: n / esc / x / q cancel without deleting", () => {
	for (const [name, snap] of Object.entries(report.cancel)) {
		assert.equal(snap.mode, "list", `${name}: back to list mode`);
		assert.equal(snap.prompt, null, `${name}: prompt dismissed`);
		assert.equal(snap.notice, null, `${name}: no notice`);
		assert.deepEqual(snap.archived, [], `${name}: nothing archived`);
	}
});

test("A2: y archives the selected view, notices, and returns to the list", async () => {
	assert.deepEqual(report.confirm.archived, [report.confirm.beforeId]);
	assert.equal(report.confirm.mode, "list");
	assert.equal(report.confirm.notice, `Deleted "${report.confirm.beforeName}"`);
	assert.equal(report.confirm.level, "info");
	assert.ok(!report.confirm.orderedIds.includes(report.confirm.beforeId), "deleted row leaves the list");
	assert.notEqual(report.confirm.selectedId, report.confirm.beforeId, "selection leaves the deleted row");
	assert.equal(report.confirm.selectedId, report.confirm.orderedIds[0], "selection re-lands on the remaining row");
});

test("A5: x is literal text in insert mode", () => {
	assert.equal(report.insertMode.mode, "dispatch");
	assert.match(report.insertMode.input, /x/);
	assert.deepEqual(report.insertMode.archived, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "$WT" && node --test test/dashboard-delete-key.test.mjs`
Expected: FAIL —— `A1` 的 `mode` 是 `"list"` 而非 `"confirm"`（`x` 目前只会触发 "Press i to enter INSERT mode" 提示）。

- [ ] **Step 3: 最小实现**

`src/ui/dashboard.ts` `handleListKey`，在 `if (data === "d") return this.confirmDone();` 之后、`ctrl+x` 分支之前插入：

```ts
		if (data === "x") return this.confirmDelete();
```

在 `confirmDeleteState()`（:1035）之前新增方法：

```ts
	private confirmDelete(): void {
		const row = this.selectedRow();
		if (!row) return;
		// Confirmation-style delete (issue #150): `x` then `y`, mirroring the
		// `d`-then-`y` flow. The legacy ctrl+x double-press stays as the
		// no-confirm shortcut.
		this.pending = {
			prompt: `Delete "${row.meta.name}"?${isAgentBusy(row) ? " Stops the active run." : ""} Session file is preserved. (y/N)`,
			onYes: () => {
				// archive is async (routes through the view-state coordinator, issue #91);
				// the notice + refresh land when the command settles.
				void Promise.resolve(this.deps.service.archive(row.meta.id)).then((res) => {
					if (!res.ok) this.notice(res.error ?? "Delete failed", "error");
					else this.notice(`Deleted "${row.meta.name}"`, "info");
					this.refresh();
				});
			},
		};
		this.mode = "confirm";
	}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "$WT" && node --test test/dashboard-delete-key.test.mjs`
Expected: PASS（6 个 test 全绿：A1/A1b/A1c/A3/A2/A5）。若 `A2` 超时，检查探针 `waitFor` 轮询条件是否覆盖 `flash`。

- [ ] **Step 5: 类型检查与全量测试**

Run: `cd "$WT" && npm run typecheck && npm test`
Expected: 均通过；无新增 warning。

- [ ] **Step 6: Commit**

```bash
cd "$WT"
git add test-support/dashboard-delete-key-probe.ts test/dashboard-delete-key.test.mjs src/ui/dashboard.ts
git commit -m "feat(ui): x then y confirms session deletion (issue #150)"
```

---

### Task 2: 旧路径回归钉死（`ctrl+x` ×2 与多选态）

**Deliverable:** 探针新增回归场景：`ctrl+x` 双击仍免确认删除（含 700ms 窗口过期不删）；多选态仍是 `ctrl+x`（`x` 无副作用），且 `y` 确认后经 `service.archiveMany` 归档、行从列表消失。

**Files:**
- Modify: `test-support/dashboard-delete-key-probe.ts`（追加两个场景 + report 字段）
- Modify: `test/dashboard-delete-key.test.mjs`（追加三个 test：A4/A4b/A6）

**Interfaces:**
- Consumes: Task 1 的探针工厂 `makeEnv()` / `makeDash()` / `snap()`；`Row` 补丁钩子 `setRowPatch`。
- Produces: report 新增 `legacyDoublePress`、`legacySlow`、`selectMode`（含 `afterX` / `ctrlX` / `confirmed` 子字段）；`makeEnv()` 返回值新增 `archiveManyCalls: string[][]`。

- [ ] **Step 1: 写回归场景（先跑，预期直接通过）**

在探针 `console.log` 之前追加：

```ts
// 7) legacy shortcut: ctrl+x twice inside the window still deletes without confirm
{
	const env = makeEnv();
	const dash = makeDash(env);
	dash.handleInput("\x18");
	dash.handleInput("\x18");
	await waitFor(() => env.archiveCalls.length > 0);
	report.legacyDoublePress = snap(dash, env);
	dash.dispose();
}

// 8) legacy window: a second ctrl+x after 700ms only re-arms
{
	const env = makeEnv();
	const dash = makeDash(env);
	dash.handleInput("\x18");
	await new Promise((r) => setTimeout(r, 700));
	dash.handleInput("\x18");
	report.legacySlow = snap(dash, env);
	dash.dispose();
}

// 9) multi-select keeps ctrl+x; plain x does nothing there
{
	const env = makeEnv();
	env.setRowPatch((r) => ({ ...r, state: { ...(r.state ?? {}), semanticState: "completed" } }));
	const dash = makeDash(env);
	const target = (dash as unknown as { orderedIds: string[] }).orderedIds[0];
	dash.handleInput("m");
	dash.handleInput(" ");
	const d0 = dash as unknown as { mode: string; pending: { prompt: string; returnMode?: string } | null };
	dash.handleInput("x");
	const afterX = { mode: d0.mode, prompt: d0.pending?.prompt ?? null };
	dash.handleInput("\x18");
	const d1 = dash as unknown as { mode: string; pending: { prompt: string; returnMode?: string } | null };
	const ctrlX = { mode: d1.mode, prompt: d1.pending?.prompt ?? null, returnMode: d1.pending?.returnMode ?? null };
	dash.handleInput("y");
	const d2 = dash as unknown as { mode: string; orderedIds: string[] };
	await waitFor(() => !d2.orderedIds.includes(target), 5000);
	report.selectMode = { afterX, ctrlX, target, confirmed: { archiveManyCalls: [...env.archiveManyCalls], mode: d2.mode, orderedIds: [...d2.orderedIds] }, archived: [...env.archiveCalls] };
	dash.dispose();
}
```

测试文件追加：

```js
test("A4: legacy ctrl+x double-press still deletes without a confirm step", () => {
	assert.equal(report.legacyDoublePress.mode, "list", "no confirm mode involved");
	assert.equal(report.legacyDoublePress.prompt, null);
	assert.deepEqual(report.legacyDoublePress.archived, ["v1"]);
});

test("A4b: ctrl+x outside the 500ms window only re-arms", () => {
	assert.deepEqual(report.legacySlow.archived, []);
	assert.equal(report.legacySlow.mode, "list");
});

test("A6: multi-select keeps ctrl+x and ignores plain x", () => {
	assert.equal(report.selectMode.afterX.mode, "select", "plain x is a no-op in select mode");
	assert.equal(report.selectMode.afterX.prompt, null);
	assert.equal(report.selectMode.ctrlX.mode, "confirm");
	assert.match(report.selectMode.ctrlX.prompt, /^Delete 1 done session\? Session files are preserved\. \(y\/N\)$/);
	assert.equal(report.selectMode.ctrlX.returnMode, "select");
	assert.deepEqual(report.selectMode.archived, [], "the batch path never routes through single-row archive");
	assert.deepEqual(report.selectMode.confirmed.archiveManyCalls, [[report.selectMode.target]], "y routes the batch through archiveMany");
	assert.ok(!report.selectMode.confirmed.orderedIds.includes(report.selectMode.target), "deleted row leaves the list");
});
```

- [ ] **Step 2: 跑测试**

Run: `cd "$WT" && node --test test/dashboard-delete-key.test.mjs`
Expected: PASS（9 个 test）。若 8) 出现误删，说明 500ms 窗口被 Task 1 改动破坏——回到 `handleListKey` 首行的 arm 重置语义排查。

- [ ] **Step 3: 全量测试**

Run: `cd "$WT" && npm test`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
cd "$WT"
git add test-support/dashboard-delete-key-probe.ts test/dashboard-delete-key.test.mjs
git commit -m "test(ui): pin legacy ctrl+x and multi-select delete paths (issue #150)"
```

---

### Task 3: 文案同步（hints / help overlay / README）

**Deliverable:** 三条路径都只讲同一事实：`x`（确认式）与 `ctrl+x` ×2（免确认快捷），无 `ctrl+x x2` 独占表述。

**Files:**
- Modify: `src/ui/dashboard.ts`（`listHints` :1316；help overlay :1667-1668）
- Modify: `README.md`（:117 bullet、:142 表格；:119 多选 bullet 不动）
- Modify: `test-support/dashboard-delete-key-probe.ts`（渲染快照）
- Modify: `test/dashboard-delete-key.test.mjs`（A7 断言）

**Interfaces:**
- Consumes: Task 1 的探针 harness；`DashboardComponent.render(width)` 公开方法；`dash.mode = "help"` 白盒设置。
- Produces: report 新增 `copy` 字段（`{ hints: string, help: string }`）。

- [ ] **Step 1: 写失败断言**

探针追加（`console.log` 之前）：

```ts
// 10) copy: list hints and the help overlay both advertise the new key
{
	const env = makeEnv();
	const dash = makeDash(env);
	const d = dash as unknown as { mode: string };
	const hints = dash.render(120).join("\n");
	d.mode = "help";
	const help = dash.render(120).join("\n");
	report.copy = { hints, help };
	dash.dispose();
}
```

测试追加：

```js
test("A7: hints and help advertise x (y/N) alongside the legacy shortcut", () => {
	assert.match(report.copy.hints, /x delete/);
	assert.match(report.copy.hints, /ctrl\+x x2/);
	assert.match(report.copy.help, /x {2}Delete selected session \(y\/N confirm\)/);
	assert.match(report.copy.help, /ctrl\+x x2 {2}Delete selected session \(quick double-press, no confirm\)/);
});
```

Run: `cd "$WT" && node --test test/dashboard-delete-key.test.mjs`
Expected: FAIL（hints 仍是 `ctrl+x x2 delete`，help 无 `x` 行）。

- [ ] **Step 2: 改文案**

`src/ui/dashboard.ts` `listHints`（:1316）把 `"ctrl+x x2 delete"` 改为 `"x delete (y/N)"` 与 `"ctrl+x x2 quick"` 两项（保持数组顺序：`d done` … `x delete (y/N)` … `ctrl+x x2 quick` …）。

help overlay（:1668）在 `ctrl+x x2` 行之前插入：

```ts
			["x", "Delete selected session (y/N confirm)"],
```

`README.md` :117 bullet 改为：

```markdown
- Press `x`, then `y` to confirm deleting the selected row. `Ctrl+X` twice quickly still deletes without confirmation. Archiving removes the row from the board but preserves its underlying Pi session file.
```

`README.md` :142 表格在 `Ctrl+X` 行之前插入：

```markdown
| `x`, then `y` | Archive/delete the selected row (confirmation prompt). |
```

并把既有行文案改为：

```markdown
| `Ctrl+X` twice quickly | Archive/delete the selected row without confirmation. |
```

- [ ] **Step 3: 跑测试与静态检查**

Run:
```bash
cd "$WT"
node --test test/dashboard-delete-key.test.mjs
rg -n "ctrl\+x x2 delete" src/ README.md ; test $? -eq 1
rg -n "Ctrl\+X twice quickly|Ctrl\+X` twice" README.md
```
Expected: 测试 PASS；第一条 `rg` 无匹配（exit 1）；第二条命中 README :117 与 :142。

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `cd "$WT" && npm run typecheck && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd "$WT"
git add src/ui/dashboard.ts README.md test-support/dashboard-delete-key-probe.ts test/dashboard-delete-key.test.mjs
git commit -m "docs(ui): document x-then-y delete alongside the ctrl+x shortcut (issue #150)"
```

---

### Task 4: 全量验证与验收对账

**Deliverable:** `npm run verify` 全绿；spec 验收矩阵（A1-A7 / U1）逐项对账记录。

**Files:**
- Modify: `docs/superpowers/plans/2026-09-30-board-delete-key-x-y-confirm.md`（勾选本 plan 的 checkbox，附验证输出摘要）

- [ ] **Step 1: 全量验证**

Run: `cd "$WT" && npm run verify`
Expected: typecheck / perf gate / tests / coverage（lines 85, funcs 80, branches 70）/ pack:dry 全部通过。若覆盖率不足，补充探针场景而不是放宽阈值。

- [ ] **Step 2: 验收矩阵对账**

逐项执行并记录：
```bash
cd "$WT"
node --test test/dashboard-delete-key.test.mjs     # A1, A1b, A1c, A2, A3, A4, A4b, A5, A6, A7
npm run typecheck                                   # 静态
rg -n "ctrl\+x x2 delete|Ctrl\+X`? twice quickly to archive" src/ README.md  # A7 静态（应无旧表述）
```
Expected: 全部通过；A7 的 `rg` 无输出。

- [ ] **Step 3: 记录 U1 实测清单（交给用户执行）**

在 plan 末尾记录（不勾选，等用户结果）：

```markdown
## U1 实测清单（用户在真实终端执行）
1. 启动 board：`pi` → 打开 agent-board 面板。
2. 选中一个已完成的 session → 按 `x` → 看到 `Delete "name"? Session file is preserved. (y/N)` → 按 `n`：无变化。
3. 再次 `x` → `y`：该行消失、出现 `Deleted "name"`，board 交互正常。
4. 选中一个 Working 行 → `x`：提示含 `Stops the active run.` → `y`：行消失；`ps` 确认无残留 runner/host 进程。
5. 查 `~/.pi/agent/agent-board/views/<viewId>/`：`meta.json` 中 `archived: true`，session 文件仍在。
6. 老路径：选中一行 → `Ctrl+X` 连按两次：仍免确认删除。
```

- [ ] **Step 4: Commit**

```bash
cd "$WT"
git add docs/superpowers/plans/2026-09-30-board-delete-key-x-y-confirm.md docs/superpowers/specs/2026-09-30-board-delete-key-x-y-confirm-design.md
git commit -m "chore: record issue-150 verification results"
```

---

## 追溯矩阵（spec 验收 ID ↔ 本 plan task）

| 验收 ID | Task |
| --- | --- |
| A1 / A1b / A1c / A2 / A3 / A5 | Task 1 |
| A4 / A4b / A6 | Task 2 |
| A7 | Task 3 |
| U1 + 全量静态/构建验证 | Task 4 |
| Review Focus 1-5 | Task 1（1/2/3/4）、Task 2（5） |
