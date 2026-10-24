# Warm-host background-run guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 warm-host sweeper 不再驱逐正在跑后台 workflow 的宿主，并在驱逐确实发生时/宿主死亡后留下可读痕迹。

**Architecture:** 新增 `src/core/background-runs.mjs`（纯解析/判定 + 一层 IO shell，读 pi-dynamic-workflows 的 run head 文件）；`selectIdleHostsToEvict` 接受可注入的 `isProtected` 谓词保持纯函数；`service.pruneWarmHosts` 两阶段选择（先无保护快跑，有候选才扫描 store）+ 停止前复查；`service.reconcile()` 新增独立 pre-pass，对已死宿主的 paused run 写行级提示（经 `patch_fields`）。

**Tech Stack:** Node ESM (`.mjs`) + `node:test` + `assert/strict`；无新依赖；JSDoc typedef（`checkJs: false`，类型只作注释）。

**Spec:** `docs/superpowers/specs/2026-10-24-issue-230-warm-host-background-runs-design.md`

## Global Constraints

- 缩进用 **Tab**；注释与 commit message 用 **英文**；commit subject 用 conventional 格式。
- 测试一律 `node:test` + `node:assert/strict`，文件放 `test/*.test.mjs`；涉及文件系统的用例必须用 `mkdtempSync(tmpdir())` 自建 fixture，**不得**读写宿主仓库或真实 `~/.pi/workflows`。
- 禁止修改 `main`；所有改动在本 worktree（`C:/Users/27499/proj/opensource/pi-agent-board/.pi/worktrees/issue-230-warm-host-background-runs`）内提交，`git add <file>` 逐文件，**禁用 `git add -A`**。
- 生产代码**不得**新增 `writeState` / `writeStatus` import（`test/architecture-writer-boundary.test.mjs` 静态检查）。
- 判定语义固定：保护 ⇔ `status === "running"` 且（`hostStartedAt == null` 或 `updatedAtMs == null` 或 `updatedAtMs >= hostStartedAt - CLOCK_EPSILON_MS`）；`CLOCK_EPSILON_MS = 2000`。
- 环境变量名：`AGENT_BOARD_NO_BACKGROUND_RUN_GUARD`（`"1"` = 关闭保护）、`AGENT_BOARD_WORKFLOW_HOME`（覆盖 workflow home）。
- 诊断 code 固定：`warm_prune_probe_failed`、`warm_prune_during_background_run`、`background_run_interrupted`；三者都必须传 `appendDiagnosticOnce` 的 `opts.match`。
- 覆盖率门槛不变：lines 85 / funcs 80 / branches 70（`npm run verify`）。

## Review Focus

以下几类输入 spec 没有逐条写测试，但最容易在真实使用中出问题；每条都已在对应 Task 里钉了测试：

1. **同一 project 下多会话并发**：一个会话在跑 workflow、另一个空闲 → 只有前者被保护（按 `parentSessionFile` 精确匹配，不是按项目目录整体保护）。
2. **同一路径的不同写法**：盘符大小写、`\` 与 `/` 混用（上游在不同进程里 `path.join` 产物可能不同）→ 仍判同文件。
3. **上一次宿主遗留的 `running` 记录**（宿主崩溃后没来得及落终态）→ **不保护**，否则 host 泄漏回来了。
4. **半写坏掉的 head 文件**（原子写落 `.bak` 中途被读）→ 不抛异常、不改变其它记录的判定结果。
5. **`AGENT_BOARD_NO_BACKGROUND_RUN_GUARD=1`** → 行为与今天逐字节一致（长 run 仍会被驱逐），但 paused 提示链路照常工作（提示不受该开关控制；U2 实测覆盖这个组合）。

---

### Task 1: 纯判定核心 `src/core/background-runs.mjs`

**Files:**
- Create: `src/core/background-runs.mjs`
- Test: `test/background-runs.test.mjs`

**Interfaces:**
- Produces:
  - `CLOCK_EPSILON_MS: number` = `2000`
  - `resolveWorkflowHome(o?: { env?: Record<string,string|undefined>, home?: string }): string`
  - `parseRunHead(raw: any): { runId: string, status: string, parentSessionFile: string|null, startedAtMs: number|null, updatedAtMs: number|null, hasCheckpoint: boolean } | null`
  - `isSameSessionFile(a: string, b: string, o?: { platform?: string }): boolean`
  - `classifyRunForRow(run: Object, o: { sessionFile: string, hostStartedAt: number|null }): "protecting"|"paused"|"irrelevant"`
  - `classifyRunsForRow(runs: Array<Object>, o: same): { state: "protecting"|"paused"|"irrelevant", run: Object|null }`

- [ ] **Step 1: 先写失败的测试**

`test/background-runs.test.mjs`（完整文件）:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLOCK_EPSILON_MS,
	classifyRunForRow,
	classifyRunsForRow,
	isSameSessionFile,
	parseRunHead,
	resolveWorkflowHome,
} from "../src/core/background-runs.mjs";

const V2 = (o = {}) => ({
	format: "pi-workflow-run-v2",
	index: { runId: "run-1", status: "running", parentSessionFile: "C:\\r\\sessions\\view_a.jsonl", updatedAt: "2026-10-24T01:00:00.000Z", startedAt: "2026-10-24T00:50:00.000Z", ...o },
	summary: { checkpoint: null },
	keys: [],
});

test("A1: v2 head -> status/parentSessionFile/updatedAt", () => {
	const h = parseRunHead(V2());
	assert.equal(h.runId, "run-1");
	assert.equal(h.status, "running");
	assert.equal(h.parentSessionFile, "C:\\r\\sessions\\view_a.jsonl");
	assert.equal(h.updatedAtMs, Date.parse("2026-10-24T01:00:00.000Z"));
	assert.equal(h.hasCheckpoint, false);
});

test("A1: v2 head without parentSessionFile -> null parent", () => {
	const raw = V2();
	delete raw.index.parentSessionFile;
	assert.equal(parseRunHead(raw).parentSessionFile, null);
});

test("A1: legacy flat record -> parseable but no parentSessionFile", () => {
	const h = parseRunHead({ runId: "old-1", status: "completed", startedAt: "2026-08-30T00:00:00.000Z" });
	assert.equal(h.runId, "old-1");
	assert.equal(h.status, "completed");
	assert.equal(h.parentSessionFile, null);
});

test("A1: garbage never throws and yields null", () => {
	for (const bad of [null, 42, "str", [], {}, { format: "something-else" }]) {
		assert.equal(parseRunHead(bad), null);
	}
});

test("A2: running + same session + updatedAt >= hostStartedAt -> protecting", () => {
	const h = parseRunHead(V2());
	const startedAt = Date.parse("2026-10-24T00:55:00.000Z");
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: startedAt }), "protecting");
});

test("A3: stale running (updatedAt < hostStartedAt) -> irrelevant", () => {
	const h = parseRunHead(V2());
	const startedAt = Date.parse("2026-10-24T02:00:00.000Z");
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: startedAt }), "irrelevant");
});

test("A3: stale running within CLOCK_EPSILON_MS still protects", () => {
	const h = parseRunHead(V2());
	const startedAt = Date.parse("2026-10-24T01:00:00.000Z") + CLOCK_EPSILON_MS - 1;
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: startedAt }), "protecting");
});

test("A3: missing hostStartedAt protects; missing updatedAt protects", () => {
	const h = parseRunHead(V2());
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null }), "protecting");
	const raw = V2();
	delete raw.index.updatedAt;
	assert.equal(classifyRunForRow(parseRunHead(raw), { sessionFile: raw.index.parentSessionFile, hostStartedAt: Date.now() }), "protecting");
});

test("A4: non-running statuses never protect; paused is classified separately", () => {
	const sessionFile = "C:\\r\\sessions\\view_a.jsonl";
	for (const status of ["completed", "failed", "aborted", "pending", ""]) {
		assert.equal(classifyRunForRow(parseRunHead(V2({ status })), { sessionFile, hostStartedAt: null }), "irrelevant", status);
	}
	assert.equal(classifyRunForRow(parseRunHead(V2({ status: "paused" })), { sessionFile, hostStartedAt: null }), "paused");
});

test("A4: other session's run is irrelevant", () => {
	const h = parseRunHead(V2());
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_b.jsonl", hostStartedAt: null }), "irrelevant");
});

test("A5: win32 path spelling differences compare equal (platform injected)", () => {
	assert.equal(isSameSessionFile("C:\\r\\sessions\\view_a.jsonl", "c:/r/sessions/view_a.jsonl", { platform: "win32" }), true);
	assert.equal(isSameSessionFile("c:/r/sessions/view_a.jsonl", "C:\\r\\sessions\\view_b.jsonl", { platform: "win32" }), false);
	assert.equal(isSameSessionFile("/tmp/x/a.jsonl", "/tmp/x/./a.jsonl", { platform: "linux" }), true);
	assert.equal(isSameSessionFile("/tmp/x/A.jsonl", "/tmp/x/a.jsonl", { platform: "linux" }), false);
});

test("A5: missing operands -> false, never throws", () => {
	assert.equal(isSameSessionFile(null, "/a", {}), false);
	assert.equal(isSameSessionFile("/a", undefined, {}), false);
});

test("A16: workflow home precedence and tilde expansion", () => {
	const home = "/home/u";
	assert.equal(resolveWorkflowHome({ env: {}, home }), "/home/u/.pi/workflows");
	assert.equal(resolveWorkflowHome({ env: { PI_CODING_AGENT_DIR: "/custom/agent" }, home }), "/custom/agent/workflows");
	assert.equal(resolveWorkflowHome({ env: { PI_CODING_AGENT_DIR: "~/agent" }, home }), "/home/u/agent/workflows");
	assert.equal(
		resolveWorkflowHome({ env: { PI_CODING_AGENT_DIR: "/custom/agent", AGENT_BOARD_WORKFLOW_HOME: "/explicit/wf" }, home }),
		"/explicit/wf",
	);
	assert.equal(resolveWorkflowHome({ env: { AGENT_BOARD_WORKFLOW_HOME: "~/wf" }, home }), "/home/u/wf");
});

test("ReviewFocus 1: two runs in one project — only the matching session protects", () => {
	const mine = parseRunHead(V2());
	const other = parseRunHead(V2({ runId: "run-2", parentSessionFile: "C:\\r\\sessions\\view_b.jsonl" }));
	const res = classifyRunsForRow([other, mine], { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null });
	assert.equal(res.state, "protecting");
	assert.equal(res.run.runId, "run-1");
});

test("ReviewFocus: protecting outranks paused in one scan", () => {
	const paused = parseRunHead(V2({ runId: "p", status: "paused" }));
	const running = parseRunHead(V2({ runId: "r", status: "running" }));
	assert.equal(classifyRunsForRow([paused, running], { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null }).state, "protecting");
	assert.equal(classifyRunsForRow([paused], { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null }).state, "paused");
	assert.equal(classifyRunsForRow([], { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null }).state, "irrelevant");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/background-runs.test.mjs`
Expected: FAIL — `Cannot find module '.../src/core/background-runs.mjs'`

- [ ] **Step 3: 实现 `src/core/background-runs.mjs`（纯函数部分）**

导出签名如上。实现要点（算法由 spec 固定，照写）：
- `parseRunHead`：`raw.format === "pi-workflow-run-v2"` → 用 `raw.index`；否则顶层有 `string` 型 `runId` → 当 legacy flat（`parentSessionFile: null`）；其它一律 `null`。`startedAtMs/updatedAtMs` 用 `Date.parse`，非有限值记 `null`。`hasCheckpoint = Boolean(source.summary?.checkpoint ?? source.checkpoint)`。
- `isSameSessionFile`：`const impl = platform === "win32" ? path.win32 : path.posix;` normalize 用 `impl.resolve`；win32 比较前 `toLowerCase()`。
- `classifyRunForRow`：顺序 —— 无 `run`/无 `parentSessionFile` → `irrelevant`；`!isSameSessionFile(...)` → `irrelevant`；`status === "paused"` → `paused`；`status !== "running"` → `irrelevant`；`hostStartedAt == null || updatedAtMs == null` → `protecting`；`updatedAtMs >= hostStartedAt - CLOCK_EPSILON_MS` → `protecting`；否则 `irrelevant`。
- `classifyRunsForRow`：遍历取最强（`protecting > paused > irrelevant`），返回 `{ state, run }`（`irrelevant` 时 `run: null`）。
- `resolveWorkflowHome`：`AGENT_BOARD_WORKFLOW_HOME` → `PI_CODING_AGENT_DIR/workflows` → `<home>/.pi/workflows`；`~` 前缀替换为 `home`。
- 文件头写英文注释块，说明这是 issue #230 的判定核心，并指向 spec。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/background-runs.test.mjs`
Expected: PASS（15 个 test）

- [ ] **Step 5: Commit**

```bash
git add src/core/background-runs.mjs test/background-runs.test.mjs
git commit -m "feat(core): classify background workflow runs for warm-host protection (issue #230)"
```

---

### Task 2: IO shell `scanBackgroundRuns` / `probeBackgroundRun`

**Files:**
- Modify: `src/core/background-runs.mjs`
- Test: `test/background-runs.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `parseRunHead` / `classifyRunsForRow` / `CLOCK_EPSILON_MS`
- Produces:
  - `scanBackgroundRuns(o: { workflowHome: string, minMtimeMs?: number }): { ok: boolean, heads: Array<RunHeadWithPath>, error: string|null }`，其中 `RunHeadWithPath = RunHead & { path: string, mtimeMs: number }`
  - `probeBackgroundRun(o: { sessionFile: string, hostStartedAt: number|null, workflowHome: string }): { ok: boolean, running: RunHeadWithPath|null, paused: RunHeadWithPath|null, error: string|null }`

- [ ] **Step 1: 先写失败的测试**（追加到 `test/background-runs.test.mjs`）

```js
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeBackgroundRun, scanBackgroundRuns } from "../src/core/background-runs.mjs";

function fixtureTree() {
	const root = mkdtempSync(join(tmpdir(), "agentboard-wf-"));
	const runsDir = join(root, "projects", "proj-abc123", "runs");
	mkdirSync(runsDir, { recursive: true });
	return { root, runsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const writeHead = (runsDir, name, body) => writeFileSync(join(runsDir, name), JSON.stringify(body));

test("A6: scan enumerates v2 heads and skips .bak/.events.jsonl/.log/.result", () => {
	const fx = fixtureTree();
	try {
		writeHead(fx.runsDir, "run-1.json", V2());
		writeHead(fx.runsDir, "run-1.json.bak", V2());
		writeFileSync(join(fx.runsDir, "run-1.json.events.jsonl"), "{}\n");
		writeFileSync(join(fx.runsDir, "run-1.log"), "log\n");
		writeFileSync(join(fx.runsDir, "run-1.json.result-deadbeef"), "{}");
		const res = scanBackgroundRuns({ workflowHome: fx.root });
		assert.equal(res.ok, true);
		assert.equal(res.heads.length, 1);
		assert.equal(res.heads[0].runId, "run-1");
		assert.ok(typeof res.heads[0].mtimeMs === "number");
	} finally {
		fx.cleanup();
	}
});

test("A6: minMtimeMs prefilter drops old heads", () => {
	const fx = fixtureTree();
	try {
		writeHead(fx.runsDir, "run-1.json", V2());
		const future = Date.now() + 60_000;
		assert.deepEqual(scanBackgroundRuns({ workflowHome: fx.root, minMtimeMs: future }), { ok: true, heads: [], error: null });
	} finally {
		fx.cleanup();
	}
});

test("A6: corrupt JSON does not throw and does not change the verdict", () => {
	const fx = fixtureTree();
	try {
		writeHead(fx.runsDir, "run-1.json", V2());
		writeFileSync(join(fx.runsDir, "broken.json"), "{ not json");
		const res = scanBackgroundRuns({ workflowHome: fx.root });
		assert.equal(res.ok, true);
		assert.equal(res.heads.length, 1);
		assert.ok(res.error);
	} finally {
		fx.cleanup();
	}
});

test("A6: missing projects dir -> ok:true with empty heads", () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-wf-none-"));
	try {
		assert.deepEqual(scanBackgroundRuns({ workflowHome: root }), { ok: true, heads: [], error: null });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A10(setup): unreadable store -> ok:false (workflowHome is a file, not a dir)", () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-wf-bad-"));
	try {
		const asFile = join(root, "not-a-dir");
		writeFileSync(asFile, "x");
		const res = scanBackgroundRuns({ workflowHome: asFile });
		assert.equal(res.ok, false);
		assert.ok(res.error);
		assert.deepEqual(res.heads, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A6/probe: probe splits running vs paused for the matching session", () => {
	const fx = fixtureTree();
	try {
		writeHead(fx.runsDir, "run-2.json", V2({ runId: "run-2" }));
		writeHead(fx.runsDir, "run-1.json", V2({ runId: "run-1", status: "paused" }));
		const res = probeBackgroundRun({ sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null, workflowHome: fx.root });
		assert.equal(res.ok, true);
		assert.equal(res.paused.runId, "run-1");
		assert.equal(res.running, null);
	} finally {
		fx.cleanup();
	}
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/background-runs.test.mjs`
Expected: FAIL — `scanBackgroundRuns is not a function`

- [ ] **Step 3: 实现 IO shell**

要点：
- `scanBackgroundRuns`：读 `<workflowHome>/projects`（`readdirSync`，`ENOENT` → `{ok:true, heads:[], error:null}`；其它错误 → `{ok:false, heads:[], error:message}`）；每个 project 目录读 `runs`；只收 `endsWith(".json")` 的**文件**；`statSync().mtimeMs < minMtimeMs` 跳过；`JSON.parse` 与 `parseRunHead` 都包 `try/catch`，失败记首个 `error` 字符串并继续。
- `probeBackgroundRun`：`minMtimeMs = hostStartedAt == null ? 0 : hostStartedAt - CLOCK_EPSILON_MS`；`!res.ok` → 透传 `{ok:false, running:null, paused:null, error}`；否则 `classifyRunsForRow(heads, {sessionFile, hostStartedAt})` 映射成 `{ok:true, running, paused, error}`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/background-runs.test.mjs`
Expected: PASS（21 个 test）

- [ ] **Step 5: Commit**

```bash
git add src/core/background-runs.mjs test/background-runs.test.mjs
git commit -m "feat(core): read workflow run heads from disk for background-run probes (issue #230)"
```

---

### Task 3: sweeper 纯谓词 `isProtected`

**Files:**
- Modify: `src/core/warm-host-sweeper.mjs:57-88`
- Test: `test/warm-host-sweeper.test.mjs`

**Interfaces:**
- Consumes: 无（谓词由调用方注入）
- Produces: `selectIdleHostsToEvict(rows, { now, maxWarm, ttlMs, graceMs?, keepViewId?, isProtected?: ((row) => boolean)|null })` —— 签名向后兼容

- [ ] **Step 1: 先写失败的测试**（追加到 `test/warm-host-sweeper.test.mjs`）

```js
test("A7: isProtected 跳过 ttl 与 maxWarm 两个分支", () => {
	const now = 1_000_000;
	const mk = (id, startedAt) => ({
		meta: { id, updatedAt: now - 10_000 },
		state: { semanticState: "idle", lastActivityAt: startedAt },
		alive: true,
		hostAlive: true,
		host: { attachedClients: 0, startedAt },
	});
	const rows = [mk("a", now - 500_000), mk("b", now - 500_000), mk("c", now - 500_000), mk("d", now - 500_000), mk("e", now - 500_000)];
	const base = { now, maxWarm: 1, ttlMs: 100_000 };

	const unprotected = selectIdleHostsToEvict(rows, base);
	assert.deepEqual(unprotected.ttlEvicted, ["a", "b", "c", "d", "e"]);

	const protectedIds = new Set(["a", "b", "c", "d"]);
	const protectedRun = selectIdleHostsToEvict(rows, { ...base, isProtected: (row) => protectedIds.has(row.meta.id) });
	assert.deepEqual(protectedRun.ttlEvicted, ["e"]);
	assert.deepEqual(protectedRun.excessEvicted, []);

	const capOnly = selectIdleHostsToEvict(rows, { now, maxWarm: 1, ttlMs: 0, isProtected: (row) => protectedIds.has(row.meta.id) });
	assert.deepEqual(capOnly.excessEvicted, ["e"]);
});

test("A7: isProtected 默认不生效（null / undefined 与既有行为一致）", () => {
	const now = 1_000_000;
	const rows = [{ meta: { id: "a", updatedAt: now }, state: { semanticState: "idle", lastActivityAt: now - 500_000 }, alive: true, hostAlive: true, host: { attachedClients: 0, startedAt: now - 500_000 } }];
	assert.deepEqual(selectIdleHostsToEvict(rows, { now, maxWarm: 4, ttlMs: 100_000, isProtected: undefined }), { ttlEvicted: ["a"], excessEvicted: [] });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/warm-host-sweeper.test.mjs`
Expected: FAIL — 第一个新用例的 `ttlEvicted` 仍是 5 个（谓词被忽略）

- [ ] **Step 3: 实现**

在 `selectIdleHostsToEvict` 的 JSDoc 参数里补 `isProtected?: ((row: import("./store.mjs").Row) => boolean)|null`，并在候选循环中 `if (isAgentBusy(row)) continue;` 之后加一行：

```js
		// Background-run protection (issue #230): a host executing a background
		// workflow still counts as busy even though the assistant turn ended.
		if (isProtected && isProtected(row)) continue;
```

JSDoc 上方注释补一句：谓词由调用方注入（纯函数不读盘）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/warm-host-sweeper.test.mjs`
Expected: PASS（23 个 test，既有 21 个全绿）

- [ ] **Step 5: Commit**

```bash
git add src/core/warm-host-sweeper.mjs test/warm-host-sweeper.test.mjs
git commit -m "feat(host): let the sweep decision exempt background-workflow hosts (issue #230)"
```

---

### Task 4: `pruneWarmHosts` 接线（两阶段选择 + 停止前复查 + 逃生门）

**Files:**
- Modify: `src/runtime/service.mjs:915-939`（`pruneWarmHosts`）、`src/runtime/service.mjs:136-176`（`createService` 注入项）、服务对外暴露区（`pruneWarmHosts` 委托处 `service.mjs:2510` 不改）
- Test: `test/warm-host-sweep.integration.test.mjs`

**Interfaces:**
- Consumes: Task 1-3 的 `scanBackgroundRuns` / `probeBackgroundRun` / `classifyRunsForRow` / `resolveWorkflowHome` / `CLOCK_EPSILON_MS` / `selectIdleHostsToEvict(..., { isProtected })`；既有 `appendDiagnosticOnce`（`src/core/diagnostics.mjs`）
- Produces: `createService({ ..., workflowHome?: string, backgroundRuns?: { scanBackgroundRuns, probeBackgroundRun } })`；`pruneWarmHosts` 行为契约见 spec §4

- [ ] **Step 1: 先写失败的测试**（追加到 `test/warm-host-sweep.integration.test.mjs`）

新增 helper 与 4 个用例（沿用本文件既有的 `freshRoot` / `makeService` / `idleView` / `captureHostSocket`）：

```js
function wfFixture() {
	const root = mkdtempSync(join(tmpdir(), "agentboard-wf-svc-"));
	const runsDir = join(root, "projects", "proj-1", "runs");
	mkdirSync(runsDir, { recursive: true });
	return { root, runsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeRunningRun(runsDir, root, viewId, { runId = "run-1", status = "running", updatedAt = Date.now() } = {}) {
	writeFileSync(
		join(runsDir, `${runId}.json`),
		JSON.stringify({
			format: "pi-workflow-run-v2",
			index: { runId, status, parentSessionFile: P.sessionFilePath(root, viewId), updatedAt: new Date(updatedAt).toISOString() },
			summary: { checkpoint: null },
		}),
	);
}

test("A8: 有 running 后台 run 的 idle host 不被淘汰；无 run 的仍被淘汰", async () => {
	const root = freshRoot();
	const wf = wfFixture();
	try {
		const protectedId = "view_protected";
		const plainId = "view_plain";
		idleView(root, protectedId);
		idleView(root, plainId);
		writeRunningRun(wf.runsDir, root, protectedId);
		const a = await captureHostSocket(root, protectedId);
		const b = await captureHostSocket(root, plainId);
		makeService(root, { workflowHome: wf.root }).pruneWarmHosts();
		await waitFor(() => b.received.some((m) => m.type === "terminate"), 3000);
		assert.equal(a.received.some((m) => m.type === "terminate"), false);
		assert.equal(b.received.some((m) => m.type === "terminate"), true);
		await closeServer(a.server);
		await closeServer(b.server);
	} finally {
		wf.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A9: 选择后被跳过——复查阶段看到 running run 则不驱逐，并留 warm_prune_during_background_run", async () => {
	const root = freshRoot();
	const id = "view_race";
	try {
		idleView(root, id);
		const sock = await captureHostSocket(root, id);
		// 选择阶段扫不到任何 run；停前复查探针看到刚启动的 run（模拟快照→停止的窗口）
		const service = makeService(root, {
			backgroundRuns: {
				scanBackgroundRuns: () => ({ ok: true, heads: [], error: null }),
				probeBackgroundRun: () => ({ ok: true, running: { runId: "run-late" }, paused: null, error: null }),
			},
		});
		service.pruneWarmHosts();
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(sock.received.some((m) => m.type === "terminate"), false);
		const diags = readJsonl(P.diagnosticsPath(root, id));
		assert.equal(diags.filter((d) => d.code === "warm_prune_during_background_run").length, 1);
		assert.equal(diags.find((d) => d.code === "warm_prune_during_background_run").details.runId, "run-late");
		await closeServer(sock.server);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A10: 探测失败 fail-open（照常 terminate）+ 去重 warn 诊断", async () => {
	const root = freshRoot();
	const id = "view_probe_fail";
	try {
		idleView(root, id);
		const sock = await captureHostSocket(root, id);
		const failing = {
			scanBackgroundRuns: () => ({ ok: false, heads: [], error: "EACCES" }),
			probeBackgroundRun: () => ({ ok: false, running: null, paused: null, error: "EACCES" }),
		};
		const service = makeService(root, { backgroundRuns: failing });
		service.pruneWarmHosts();
		await waitFor(() => sock.received.some((m) => m.type === "terminate"), 3000);
		assert.equal(sock.received.some((m) => m.type === "terminate"), true);
		const diags = readJsonl(P.diagnosticsPath(root, id));
		assert.equal(diags.filter((d) => d.code === "warm_prune_probe_failed").length, 1);
		await closeServer(sock.server);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A11: AGENT_BOARD_NO_BACKGROUND_RUN_GUARD=1 回到今天的行为", async () => {
	const root = freshRoot();
	const wf = wfFixture();
	const prev = process.env.AGENT_BOARD_NO_BACKGROUND_RUN_GUARD;
	try {
		process.env.AGENT_BOARD_NO_BACKGROUND_RUN_GUARD = "1";
		const id = "view_guard_off";
		idleView(root, id);
		writeRunningRun(wf.runsDir, root, id);
		const sock = await captureHostSocket(root, id);
		makeService(root, { workflowHome: wf.root }).pruneWarmHosts();
		await waitFor(() => sock.received.some((m) => m.type === "terminate"), 3000);
		assert.equal(sock.received.some((m) => m.type === "terminate"), true);
		await closeServer(sock.server);
	} finally {
		if (prev === undefined) delete process.env.AGENT_BOARD_NO_BACKGROUND_RUN_GUARD;
		else process.env.AGENT_BOARD_NO_BACKGROUND_RUN_GUARD = prev;
		wf.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
```

同时给既有 `makeService(root)` 加第二参数（默认空对象）并透传注入项：

```js
function makeService(root, extra = {}) {
	return createService({
		root,
		/* ...既有参数保持不变... */
		...extra,
	});
}
```

需要的 import 增补：`mkdirSync, writeFileSync`（`node:fs`）；`readJsonl` 从 `../src/core/atomic.mjs`。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/warm-host-sweep.integration.test.mjs`
Expected: FAIL — A8 里受保护 host 也收到了 terminate（保护未实现）

- [ ] **Step 3: 实现 service 侧**

1. `createService` 顶部注入（与既有 `opts.X ?? default` 同款）：

```js
	const backgroundRunsImpl = opts.backgroundRuns ?? { scanBackgroundRuns, probeBackgroundRun };
	const workflowHomeImpl = opts.workflowHome ?? resolveWorkflowHome();
```

2. `pruneWarmHosts` 重写为 spec §4 的流程：`dry` 快跑 → 无候选即返回 → `AGENT_BOARD_NO_BACKGROUND_RUN_GUARD !== "1"` 时做一次 `scanBackgroundRuns`（`minMtimeMs` = 候选行 `host.startedAt` 最小值减 `CLOCK_EPSILON_MS`；任一候选行缺 `startedAt` 时取 `0`）→ `classifyRunsForRow` 生成 `isProtected` → 带谓词再选 → 逐行复查（既有四项 + `isProtected` + 新鲜 `probeBackgroundRun`）：`!ok` → `appendDiagnosticOnce(code:"warm_prune_probe_failed", {match:["error"]})` 后**继续**驱逐；`running` → `appendDiagnosticOnce(code:"warm_prune_during_background_run", {match:["runId"]})` 后 `continue`（跳过）；否则 `stopHostRow(row, "warm_prune")`。

3. 诊断 message 文案固定：
   - `warm_prune_probe_failed`: `"Could not read the workflow run store; warm-host eviction proceeded without background-run protection"`
   - `warm_prune_during_background_run`: `` `Skipped warm-host eviction: background workflow ${runId} started after selection` ``

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/warm-host-sweep.integration.test.mjs`
Expected: PASS（7 个 test：既有 3 + 新 4）

- [ ] **Step 5: 回归既有 sweep 单测**

Run: `node --test test/warm-host-sweeper.test.mjs test/host-recovery.test.mjs`
Expected: PASS（既有用例零改动）

- [ ] **Step 6: Commit**

```bash
git add src/runtime/service.mjs test/warm-host-sweep.integration.test.mjs
git commit -m "fix(host): keep warm hosts alive while a background workflow run is active (issue #230)"
```

---

### Task 5: 驱逐/宿主死亡的留痕（reconcile pre-pass + `patch_fields` 白名单）

**Files:**
- Modify: `src/core/state-commands.mjs:113`（`PATCHABLE_FIELDS["service"]`）、`:108-112` 注释
- Modify: `src/runtime/service.mjs:2269-2275`（`reconcile()` 开头加 pre-pass）与 `createService` 闭包内新增 `noticeProbeMemo` / `noticeInterruptedBackgroundRuns`
- Modify: `test/state-commands.test.mjs:118`（白名单断言）
- Modify: `test/architecture-writer-boundary.test.mjs:39`（豁免理由字符串「三处」→「四处」）
- Test: `test/background-run-notice.test.mjs`

**Interfaces:**
- Consumes: Task 1-4 的 probe 注入项与被测信息；既有 `sendLifecycleCommand` / `readState` / `writeState` / `appendDiagnosticOnce`
- Produces: `reconcile()` 新增 pre-pass 行为（spec §4 第 0 步）；`PATCHABLE_FIELDS["service"].state` 含 `"summary"`

- [ ] **Step 1: 先写失败的测试**

`test/background-run-notice.test.mjs`（完整文件；沿用 integration 测试里的 root/fixture 构造方式）：

```js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../src/runtime/service.mjs";
import { createView, readState, writeHost } from "../src/core/store.mjs";
import { readJsonl } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";

const makeService = (root, extra = {}) =>
	createService({ root, runnerScript: "/no/runner.mjs", piCommand: "pi", piArgsPrefix: [], defaultCwd: process.cwd(), ...extra });

function deadHostRow(root, id, { paused = true } = {}) {
	const wf = mkdtempSync(join(tmpdir(), "agentboard-notice-"));
	const runsDir = join(wf, "projects", "p", "runs");
	mkdirSync(runsDir, { recursive: true });
	createView(root, { id, name: id, cwd: "/r" });
	const s = readState(root, id);
	// 生产真实态：turn 已结束、run 已终态，宿主随后死亡
	s.semanticState = "idle";
	s.processState = "exited";
	s.currentRunId = null;
	s.summary = "Turn finished";
	writeState(root, s);
	writeHost(root, { viewId: id, mode: "pty", state: "exited", runnerPid: null, startedAt: Date.now() - 3_600_000, endedAt: Date.now() - 60_000, attachedClients: 0, lastSeenAt: Date.now() });
	writeFileSync(
		join(runsDir, "run-9.json"),
		JSON.stringify({
			format: "pi-workflow-run-v2",
			index: {
				runId: "run-9",
				status: paused ? "paused" : "completed",
				parentSessionFile: P.sessionFilePath(root, id),
				updatedAt: new Date(Date.now() - 90_000).toISOString(),
			},
			summary: { checkpoint: { checkpointId: "cp1", kind: "manual", status: "pending" } },
		}),
	);
	return { wf, cleanup: () => rmSync(wf, { recursive: true, force: true }) };
}

test("A12: 生产真实态的死宿主 + paused run -> summary 写入提示，诊断恰一条", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-root-"));
	const fx = deadHostRow(root, "view_notice");
	try {
		const service = makeService(root, { workflowHome: fx.wf, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		const s = readState(root, "view_notice");
		assert.match(s.summary, /Background workflow run-9 was interrupted/);
		assert.match(s.summary, /resume/);
		const diags = readJsonl(P.diagnosticsPath(root, "view_notice"));
		assert.equal(diags.filter((d) => d.code === "background_run_interrupted").length, 1);
		await service.reconcile();
		assert.equal(readState(root, "view_notice").summary, s.summary);
		assert.equal(readJsonl(P.diagnosticsPath(root, "view_notice")).filter((d) => d.code === "background_run_interrupted").length, 1);
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: completed run（非 paused）不写提示", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-root2-"));
	const fx = deadHostRow(root, "view_done", { paused: false });
	try {
		const service = makeService(root, { workflowHome: fx.wf, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		assert.equal(readState(root, "view_done").summary, "Turn finished");
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: 探针失败不记 memo —— 恢复后下一个 tick 仍能写提示", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-root3-"));
	const fx = deadHostRow(root, "view_retry");
	try {
		let calls = 0;
		const flaky = {
			scanBackgroundRuns: () => ({ ok: true, heads: [], error: null }),
			probeBackgroundRun: () => {
				calls += 1;
				if (calls === 1) return { ok: false, running: null, paused: null, error: "EACCES" };
				return { ok: true, running: null, paused: { runId: "run-9" }, error: null };
			},
		};
		const service = makeService(root, { backgroundRuns: flaky, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		assert.equal(readState(root, "view_retry").summary, "Turn finished");
		await service.reconcile();
		assert.match(readState(root, "view_retry").summary, /run-9/);
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
```

`test/state-commands.test.mjs`：把 `PATCHABLE_FIELDS["service"]` 断言改为 `{ state: ["lastVisitedAt", "summary"], status: [] }`（两处：L118 与 L648 附近的同类断言）。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/background-run-notice.test.mjs`
Expected: FAIL — summary 仍是 `Turn finished`（pre-pass 未实现）

- [ ] **Step 3: 实现**

1. `src/core/state-commands.mjs`：`"service"` 的 `state` 白名单加 `"summary"`，并把上方注释改为同时说明两条用途（`lastVisitedAt` = 访问时间；`summary` = 宿主死亡后的后台 run 中断提示，issue #230）。
2. `src/runtime/service.mjs`：
   - `createService` 闭包内新增 `const noticeProbeMemo = new Set();`
   - 新增 `async function noticeInterruptedBackgroundRuns(now)`，实现 spec §4 第 0 步（`host.state ∈ {exited, failed}` 且 `!row.hostAlive`；key = `` `${viewId}:${host.endedAt ?? 0}` ``；**probe 成功后才** `memo.add(key)`；`!probe.paused` → continue；summary 已以 `"Background workflow "` 开头则跳过写入；写入走 `sendLifecycleCommand({kind:"patch_fields", payload:{state:{summary}}})`，`reason === "coordinator_disabled"` 时 `const fresh = readState(root, id); fresh.summary = summary; fresh.updatedAt = now; writeState(root, fresh);`；随后 `appendDiagnosticOnce(..., {match:["runId"]})`）。
   - `reconcile()` 开头（`const now = Date.now();` 之后、`let fixed = 0;` 之前）`await noticeInterruptedBackgroundRuns(now);`
3. `test/architecture-writer-boundary.test.mjs:39` 的豁免理由字符串改为「…以及 reconcile() 的四处 coordinator_disabled 直写回退（host 探测终态 / project 模式 / runner-exited / paused-run summary notice）」。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/background-run-notice.test.mjs test/state-commands.test.mjs test/architecture-writer-boundary.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/state-commands.mjs src/runtime/service.mjs test/background-run-notice.test.mjs test/state-commands.test.mjs test/architecture-writer-boundary.test.mjs
git commit -m "feat(host): notice interrupted background runs after a warm host dies (issue #230)"
```

---

### Task 6: 全仓验收（A13 / A14）

**Files:** 无代码改动（仅验证）

**Interfaces:**
- Consumes: Task 1-5 全部
- Produces: 可合并的绿灯

- [ ] **Step 1: 类型与静态检查**

Run: `npm run typecheck`
Expected: 退出码 0

- [ ] **Step 2: 覆盖验收矩阵**

Run: `node --test test/background-runs.test.mjs test/warm-host-sweeper.test.mjs test/warm-host-sweep.integration.test.mjs test/background-run-notice.test.mjs test/state-commands.test.mjs test/architecture-writer-boundary.test.mjs`
Expected: PASS，对应 A1-A16 全绿

- [ ] **Step 3: 全仓门禁**

Run: `npm run verify`
Expected: 退出码 0（typecheck + perf gate + 全量测试 + c8 覆盖率门槛 + pack:dry）

- [ ] **Step 4: 提交（若前两步需要修 lint/覆盖率，逐个修复后）**

```bash
git add <changed files>
git commit -m "test: cover background-run guard end to end (issue #230)"
```

---

## Manual verification (post-implementation, U1 / U2)

部署前置与步骤见 spec §9（必须让 board 从 PR 分支加载，**不是**本工作副本）。两项在 PR 描述里登记为 `pending` 直到实际执行。

| ID | 操作 | 通过标准 |
|---|---|---|
| U1 | 压缩 TTL（`AGENT_BOARD_WARM_HOST_TTL_MS=60000`）后跑一个 ≥3 min 的单 step background workflow，关闭 attach 等 2×TTL | `host.json.state` 保持 `alive`；run 保持 `running`；无 `skipped/interrupted` |
| U2 | `AGENT_BOARD_NO_BACKGROUND_RUN_GUARD=1` 让驱逐发生，再打开 dashboard | 行 summary 含 runId 与 "resume"；诊断含 `background_run_interrupted`；resume 后 run 完成 |

## 验收 → Task 追溯

| 验收 ID | Task |
|---|---|
| A1, A2, A3, A4, A5, A16 | 1 |
| A6 | 2 |
| A7 | 3 |
| A8, A9, A10, A11 | 4 |
| A12, A15 | 5 |
| A13, A14 | 6 |
| U1, U2 | Manual verification |
