# Coordinator Pipe-Name Root Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 win32 上的 coordinator 命名管道名对 root 的写法不敏感（与锁路径同一归一化口径），消除「同一逻辑 root → 同一把锁 + 两根管道」造成的面板永久失联（issue #124）。

**Architecture:** 在 `coordinatorEndpointPathFor` 的 **win32 分支** hash 前对 root 做 `path.resolve` 归一化 —— 纯函数内部单点修复，client 与 server 两侧同时生效；POSIX 分支不动（其 socket 是文件系统路径，`path.join` 已归一化）。

**Tech Stack:** Node ESM、`node:test`、零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-15-coordinator-pipe-root-normalize-design.md`

## Global Constraints

- 生产改动**仅** `src/core/paths.mjs`，且**仅 win32 分支**；POSIX 行为零变化。
- **向后兼容**：规范形式的 hash 必须不变 —— `path.resolve(canonical) === canonical`（spec §2.1 已实测）。任何会改变规范形式 hash 的做法（如大小写折叠）一律不做。
- 非目标：大小写归一化、root 入口统一归一化（`defaultRoot`/runner argv）、复用或改动 #114 的锁逻辑。
- 测试命令在 worktree 根目录执行：`node --test test/<file>.test.mjs`。
- Windows 全量基线（`628e42b`）：883 tests / 846 pass / 36 fail（既有环境类失败），修复后失败集不得新增。
- commit 用 conventional commits；每个 task 独立 commit。

---

### Task 1: 归一化实现 + unit 不变量（验收 A1–A4）

**Files:**
- Modify: `src/core/paths.mjs`（win32 分支，+~5 行）
- Test: `test/socket-path.test.mjs`（新增 import + 追加 ~45 行）

**Interfaces:**
- Produces: 无新导出；`coordinatorEndpointPathFor(platform, root)` 契约加强 —— win32 下返回值对 `root` 的写法不敏感。
- Consumes: 已有的 `path.resolve`（`node:path` 已 import）、`createHash`（已 import）。

- [ ] **Step 1: Write the failing tests**

在 `test/socket-path.test.mjs` 第 4 行的 import 中加入 `coordinatorEndpointPathFor`：

```js
import { controlPipeName, controlSocketPath, controlSocketPathFor, coordinatorEndpointPathFor, hostConfigPathFor, hostEndpointPathFor, viewDir } from "../src/core/paths.mjs";
```

在文件末尾追加：

```js
// ---- coordinator endpoint root-form invariance (issue #124) -----------------

test("coordinator pipe name is invariant to the root spelling (win32, issue #124)", () => {
	const forms = [
		"C:\\root\\board",
		"C:/root/board",
		"C:\\root\\board\\",
		"C:\\root\\.\\board",
	];
	const names = forms.map((r) => coordinatorEndpointPathFor("win32", r));
	for (const n of names) {
		assert.match(n, /^\\\\.\\pipe\\agent-board-coordinator-[0-9a-f]{16}$/);
		assert.ok(n.length <= 256, "named pipe name must fit the Windows 256-char limit");
	}
	assert.equal(new Set(names).size, 1, "one logical root must map to one pipe name regardless of spelling");
});

test("coordinator pipe name still isolates distinct roots (win32)", () => {
	assert.notEqual(
		coordinatorEndpointPathFor("win32", "C:\\root\\board-a"),
		coordinatorEndpointPathFor("win32", "C:\\root\\board-b"),
	);
});

test("coordinator endpoint keeps POSIX semantics unchanged", () => {
	const expected = join("/tmp/root", "coordinator.sock");
	assert.equal(coordinatorEndpointPathFor("linux", "/tmp/root"), expected);
	assert.equal(coordinatorEndpointPathFor("darwin", "/tmp/root"), expected);
	assert.equal(coordinatorEndpointPathFor("linux", "/tmp/root/"), expected, "path.join already normalizes on POSIX");
});
```

- [ ] **Step 2: Run tests to verify the invariance test fails**

Run: `node --test test/socket-path.test.mjs`
Expected: 第 1 个新用例 **FAIL**（`Set.size` = 4 ≠ 1）；第 2、3 个新用例 PASS（它们是回归护栏）。

- [ ] **Step 3: Implement the normalization**

`src/core/paths.mjs` 中 `coordinatorEndpointPathFor` 的 win32 分支改为：

```js
export function coordinatorEndpointPathFor(platform, root) {
	if (platform === "win32") {
		// Normalize before hashing: the pipe name must be invariant to the root's
		// spelling (C:/x vs C:\x, trailing separators, dot segments). The lock path
		// derived from the same root already is (via path.join); a mismatch yields
		// "same lock, two pipes" — the panel probes a pipe nobody bound, spawns
		// replacements that cannot take the held lease, and locks itself out
		// (issue #124). resolve() is idempotent on canonical roots, so coordinators
		// already deployed keep their pipe name and need no restart.
		const normalized = path.resolve(root);
		const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
		return `\\\\.\\pipe\\agent-board-coordinator-${hash}`;
	}
	return path.join(root, "coordinator.sock");
}
```

（保持函数内注释对 256 字符限制的既有说明；POSIX 分支逐字节不变。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/socket-path.test.mjs`
Expected: 全部 PASS（含 3 个新用例）。

- [ ] **Step 5: Commit**

```bash
git add src/core/paths.mjs test/socket-path.test.mjs
git commit -m "fix(paths): normalize root before hashing the win32 coordinator pipe name (issue #124)"
```

---

### Task 2: 跨写法端到端互通（验收 A5）

**Files:**
- Test: `test/coordinator-client.test.mjs`（追加 ~30 行）

**Interfaces:**
- Consumes: 既有 `ensureCoordinator(root, { runnerScript })`、`freshRoot()`、`track(pid)`、`cleanupRoot(root)`、`COORDINATOR_SCRIPT`（同文件已定义）。
- Produces: 无生产接口。

- [ ] **Step 1: Write the failing test**

在 `test/coordinator-client.test.mjs` 中（`ensureCoordinator reclaims a stale identity-less orphan lease` 用例之后）追加：

```js
test("a coordinator started under one root spelling serves clients using another (issue #124)", async (t) => {
	const root = freshRoot(); // win32: mkdtempSync returns a backslash path
	t.after(async () => {
		await cleanupRoot(root);
	});
	const altRoot = process.platform === "win32" ? root.replace(/\\/g, "/") : `${root}/`;
	assert.notEqual(root, altRoot, "the two spellings must actually differ as strings");

	// the coordinator runs under altRoot; the panel client uses root
	const started = await ensureCoordinator(altRoot, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(started.ok, true, "coordinator must start under the alternate spelling");
	track(started.pid);

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true, "a client using the other spelling must reach a coordinator");
	assert.equal(ensured.instanceId, started.instanceId, "both spellings must resolve to ONE endpoint and owner");
});
```

- [ ] **Step 2: Prove the test pins the fix (revert check)**

临时把 Task 1 的实现改回未归一化形态（`const hash = createHash("sha256").update(String(root))...`），运行：

Run: `node --test test/coordinator-client.test.mjs`
Expected: 新用例 **FAIL**（第二个 `ensureCoordinator` 探测的是另一根管道：Windows 上 `ENOENT` → spawn 新实例 → 抢锁失败 → 约 10s 后返回 `{ok:false, error:"coordinator_unavailable"}`；POSIX 上两写法本就同一 socket，故该回归守卫在 POSIX 上恒定通过）。确认失败后恢复 Task 1 的实现。

- [ ] **Step 3: Run tests to verify they pass**

Run: `node --test test/coordinator-client.test.mjs`
Expected: 全部 PASS（含新用例）。

- [ ] **Step 4: Commit**

```bash
git add test/coordinator-client.test.mjs
git commit -m "test(coordinator): cross-spelling endpoint interop e2e (issue #124)"
```

---

### Task 3: 全量回归与验收记录（验收 A6）

**Files:** 无代码改动（验证任务）。

- [ ] **Step 1: 目标测试文件**

Run: `node --test test/socket-path.test.mjs`
Expected: 0 fail（含 Task 1 新增用例）。

- [ ] **Step 2: coordinator 套件**

Run: `node --test test/coordinator-client.test.mjs test/state-coordinator.integration.test.mjs test/coordinator-journal.test.mjs`
Expected: 与基线相比无新增失败（`state-coordinator.integration` 的 5 个 Windows 环境失败为既有项，需逐名核对）。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 零错误。

- [ ] **Step 4: 全量回归**

Run: `npm test 2>&1 | tail -50`
Expected: 失败集不新增（基线 `628e42b`：883 / 846 pass / 36 fail）。逐名比对失败清单。

- [ ] **Step 5: 记录验收结果到 issue**

```bash
gh issue comment 124 --repo zhuxixi/pi-agent-board --body "## 实现完成：验收结果 A1–A6
<贴各命令与结果摘要>"
```

- [ ] **Step 6: 无文件改动则无 commit**

若 Step 1–4 产生了临时产物，确认未 stage 后删除。

---

## Self-Review

- **Spec coverage**：A1 → Task 1 Step 1 第 1 用例；A2 → 第 2 用例；A3 → 第 1 用例的长度/前缀断言；A4 → 第 3 用例；A5 → Task 2；A6 → Task 3。spec 无非目标项被实现（无大小写折叠、无 POSIX 改动、无入口归一化）。
- **Placeholder scan**：无 TBD/TODO；测试与实现均为完整代码。
- **Type consistency**：`coordinatorEndpointPathFor(platform, root)` 签名不变（仅内部归一化）；测试 helper 名称（`freshRoot`/`track`/`cleanupRoot`/`COORDINATOR_SCRIPT`）与既有定义一致。
- **向后兼容护栏**：Task 1 第 2 用例（隔离保留）与 Task 2 的 revert-check 共同保证"修复真的修好了"且没有把不同 root 折叠成一个。
