# Windows Lease Publish EPERM Reclaim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `attemptAcquireLease` 在 Windows 的 publish-rename EPERM（目标目录已存在）下进入 reclaim 判定，使 coordinator / host 的租约孤锁可被自动回收（issue #114）。

**Architecture:** 把 rename 冲突码判定抽成导出的纯函数 `isPublishConflictCode(code)`（`EEXIST`/`ENOTEMPTY`/`EPERM`），`attemptAcquireLease` 的 catch 改用它；回收安全性完全由既有 `classifyLeaseOwner` 决定，本次不放宽任何回收条件。测试分三层：纯函数 unit → 注入 fs 模拟 Windows EPERM 的接管 unit/integration → spawn 真 coordinator 的端到端回归。

**Tech Stack:** Node 24 ESM、`node:test`、零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-15-lease-publish-eprem-reclaim-design.md`

## Global Constraints

- 不改 `classifyLeaseOwner` 的判定契约、不改 quarantine / inspectedToken 核对机制、不改 `ORPHAN_LEASE_AGE_MS`（5min）。
- 不新增依赖；不新增生产文件。
- 生产改动仅限 `src/core/locks.mjs`。
- 所有测试命令在 worktree 根目录执行（`node --test test/<file>.test.mjs`）。
- Windows 真机既有失败基线（修复前）：`node --test test/locks.test.mjs` = 20 tests / **4 fail**（全部为租约接管路径），修复后必须 0 fail。
- commit 用 conventional commits；每个 task 独立 commit。

---

### Task 1: `isPublishConflictCode` 纯函数 + catch 接线

**Files:**
- Modify: `src/core/locks.mjs`（新增导出函数；改造 `attemptAcquireLease` catch）
- Test: `test/locks.test.mjs`

**Interfaces:**
- Produces: `isPublishConflictCode(code: string|undefined): boolean`（导出）——`EEXIST`/`ENOTEMPTY`/`EPERM` → true，其余 → false。
- Consumes: 既有 `attemptAcquireLease` / `reclaimOrBlock`（不动其签名）。

- [ ] **Step 1: Write the failing test**

在 `test/locks.test.mjs` 的 import 块（第 6 行）把 `isPublishConflictCode` 加入解构列表：

```js
import { acquireOwnedViewLock, classifyLeaseOwner, defaultLocksFs, isPublishConflictCode, releaseWithToken, tryAcquireOwnedViewLock, withFileLockSync, withViewLockSync } from "../src/core/locks.mjs";
```

在文件末尾追加测试：

```js
// ---- publish-rename conflict codes (issue #114) -----------------------------

test("isPublishConflictCode: rename conflict codes including Windows EPERM", () => {
	assert.equal(isPublishConflictCode("EEXIST"), true);
	assert.equal(isPublishConflictCode("ENOTEMPTY"), true, "POSIX rename onto an existing dir");
	assert.equal(isPublishConflictCode("EPERM"), true, "Windows rename onto an existing dir (errno -4048)");
	assert.equal(isPublishConflictCode("ENOENT"), false);
	assert.equal(isPublishConflictCode("EACCES"), false);
	assert.equal(isPublishConflictCode(undefined), false);
	assert.equal(isPublishConflictCode(null), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/locks.test.mjs`
Expected: FAIL —— `isPublishConflictCode is not a function`（或 import 报错），其余用例不受影响。

- [ ] **Step 3: Write minimal implementation**

在 `src/core/locks.mjs` 的 `attemptAcquireLease` **之前**插入：

```js
/**
 * Whether a publish-rename failure means "the lock path already exists"
 * (contention) rather than a genuine filesystem error.
 *
 * POSIX reports EEXIST/ENOTEMPTY when renaming a directory onto an existing
 * one; Windows reports EPERM (errno -4048) for the same situation — this op's
 * platform equivalent of EEXIST (issue #114: a crashed owner's lease could
 * never be reclaimed because EPERM was rethrown before reclaimOrBlock).
 * Routing a genuine permission error here stays safe: reclaimability is still
 * decided solely by `classifyLeaseOwner`, so it resolves `blocked`/`busy`.
 * @param {string|undefined|null} code
 * @returns {boolean}
 */
export function isPublishConflictCode(code) {
	return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}
```

把 `attemptAcquireLease` catch 中的：

```js
			const code = err && err.code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") throw err;
```

替换为：

```js
			const code = /** @type {NodeJS.ErrnoException|undefined} */ (err)?.code;
			if (!isPublishConflictCode(code)) throw err;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/locks.test.mjs`
Expected: 新用例 PASS；其余用例与修复前一致（Windows 真机此时 4 个接管用例仍 fail —— 它们在 Task 2 的注入用例之外，属既有基线，Task 4 复验）。

- [ ] **Step 5: Commit**

```bash
git add src/core/locks.mjs test/locks.test.mjs
git commit -m "fix(locks): treat Windows publish-rename EPERM as lease contention (issue #114)"
```

---

### Task 2: 注入 fs 的 EPERM 接管测试（reclaim / busy / blocked）

**Files:**
- Test: `test/locks.test.mjs`

**Interfaces:**
- Consumes: `isPublishConflictCode` 接线后的 `tryAcquireOwnedViewLock`（Task 1）。
- Produces: 无生产接口；测试辅助 `windowsPublishFs(lockPath)`。

- [ ] **Step 1: Write the failing tests**

在 `test/locks.test.mjs` 顶部 import 增加 `renameSync as realRenameSync`（保留既有名字）：

```js
import { existsSync, mkdirSync, mkdtempSync, renameSync as realRenameSync, rmSync, writeFileSync } from "node:fs";
```

在文件末尾追加：

```js
/** Windows-style publish fs: renaming onto an existing lock path throws EPERM
 *  (errno -4048) instead of POSIX's ENOTEMPTY; all other ops are real. */
function windowsPublishFs(lockPath) {
	return {
		...LOCK_FS,
		renameSync: (from, to, ...rest) => {
			if (String(to) === lockPath && existsSync(to)) {
				const e = new Error("EPERM: operation not permitted, rename");
				e.code = "EPERM";
				throw e;
			}
			return realRenameSync(from, to, ...rest);
		},
	};
}

const ME = { pid: process.pid, startToken: "me" };
const DEAD = { pid: 99999999, startToken: "dead" };

test("EPERM publish contention: dead owner with full identity is reclaimed", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "coordinator");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "t", pid: DEAD.pid, identity: DEAD, startedAt: Date.now() }));
		const got = tryAcquireOwnedViewLock(root, "v1", "coordinator", { identity: ME, fs: windowsPublishFs(lockPath) });
		assert.equal(got.acquired, true, "EPERM contention must reach reclaimOrBlock");
		assert.equal(got.lease.isOwner(), true);
		got.lease.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("EPERM publish contention: stale identity-less owner (Windows startToken:null) is reclaimed", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "coordinator");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
			token: "t", pid: DEAD.pid,
			identity: { pid: DEAD.pid, startToken: null },
			startedAt: Date.now() - 10 * 60_000,
		}));
		const got = tryAcquireOwnedViewLock(root, "v1", "coordinator", { identity: ME, fs: windowsPublishFs(lockPath) });
		assert.equal(got.acquired, true, "issue #112 orphan reclaim must be reachable through EPERM contention");
		got.lease.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("EPERM publish contention: live owner stays busy (no steal)", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "coordinator");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "t", pid: process.pid, identity: { pid: process.pid, startToken: "live" }, startedAt: Date.now() }));
		const got = tryAcquireOwnedViewLock(root, "v1", "coordinator", { identity: ME, fs: windowsPublishFs(lockPath) });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "busy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("EPERM publish contention: fresh identity-less owner stays blocked", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "coordinator");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "t", pid: DEAD.pid, identity: null, startedAt: Date.now() }));
		const got = tryAcquireOwnedViewLock(root, "v1", "coordinator", { identity: ME, fs: windowsPublishFs(lockPath) });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "blocked");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test test/locks.test.mjs`
Expected: 4 个新用例 PASS。

- [ ] **Step 3: Prove the tests actually pin the fix (revert check)**

临时把 Task 1 的 catch 判定改回旧形态（`if (code !== "EEXIST" && code !== "ENOTEMPTY") throw err;`），运行：

Run: `node --test test/locks.test.mjs`
Expected: 4 个新用例 FAIL（`EPERM` 被 throw）。确认后恢复 Task 1 的实现，再跑一次确认 PASS。

- [ ] **Step 4: Commit**

```bash
git add test/locks.test.mjs
git commit -m "test(locks): cover EPERM publish contention reclaim/busy/blocked (issue #114)"
```

---

### Task 3: `ensureCoordinator` 端到端孤锁接管（spawn 真 coordinator）

**Files:**
- Test: `test/coordinator-client.test.mjs`

**Interfaces:**
- Consumes: 既有 `ensureCoordinator(root, { runnerScript })`、文件内辅助 `track(pid)` / `cleanupRoot(root)`、`COORDINATOR_SCRIPT` 常量。
- Produces: 无生产接口。

- [ ] **Step 1: Write the failing test**

在 `test/coordinator-client.test.mjs` 的 node:fs import 中加入 `mkdirSync`：

```js
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
```

在 `ensureCoordinator spawns the real coordinator; ...` 测试之后追加：

```js
test("ensureCoordinator reclaims a stale identity-less orphan lease (issue #114)", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});

	// Residue of a killed coordinator on a platform without startToken (Windows):
	// dead pid, identity-less, past the 5min orphan age.
	const lockPath = P.viewLockPath(root, "_coordinator", "state-coordinator");
	mkdirSync(lockPath, { recursive: true });
	writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
		token: "orphan-lease",
		pid: 99999999,
		identity: { pid: 99999999, startToken: null },
		startedAt: Date.now() - 10 * 60_000,
	}), "utf8");

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true, "the orphan lease must be reclaimed, not block startup");
	assert.match(ensured.instanceId, /^[0-9a-f]+$/);
	track(ensured.pid);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test test/coordinator-client.test.mjs`
Expected: 新用例 PASS；同文件其余用例不受影响。

- [ ] **Step 3: Commit**

```bash
git add test/coordinator-client.test.mjs
git commit -m "test(coordinator): e2e orphan lease takeover via ensureCoordinator (issue #114)"
```

---

### Task 4: 真机 Windows 验证 + 全量回归（验收 A5/A6/A7）

**Files:** 无代码改动（验证任务）。

- [ ] **Step 1: Windows 真机：锁测试转绿（A5）**

Run: `node --test test/locks.test.mjs`
Expected: **0 fail**（基线 20 tests / 4 fail → 修复后 25 tests / 0 fail，含 Task 1-2 新增用例）。

- [ ] **Step 2: Windows 真机：coordinator 集成套件（A7）**

Run: `node --test test/coordinator-client.test.mjs test/coordinator-journal.test.mjs`
Expected: 0 fail（含 Task 3 新增用例）。

- [ ] **Step 3: 类型检查（A6）**

Run: `npm run typecheck`
Expected: 零错误。

- [ ] **Step 4: 全量回归（A6）**

Run: `npm test 2>&1 | tail -40`
Expected: 失败集不新增。与修复前基线对比：在**同一 worktree、未含本次改动**的 `a129b09` 上先记录一次基线失败清单（`git stash` 或另存输出），修复后按名字逐项比对，仅允许减少、不允许新增。（Windows 既有环境类失败照旧记录。）

- [ ] **Step 5: 记录验收结果到 issue**

```bash
gh issue comment 114 --repo zhuxixi/pi-agent-board --body "## 实现完成：验收结果 A1–A7
<贴各命令与结果摘要>"
```

- [ ] **Step 6: Commit（如有验证脚本或文档微调）**

若 Step 1-4 全部通过且无文件改动，本任务无 commit；若为跑基线在 worktree 内产生了临时产物，确认未 add 后删除。

---

## Self-Review

- **Spec coverage**：A1 → Task 1 Step 1；A2/A3/A4 → Task 2；A5/A6 → Task 4；A7 → Task 3 + Task 4 Step 2；U1（用户实测）→ 合并部署后由用户执行（spec §3 已标 pending 规则）。
- **Placeholder scan**：无 TBD/TODO；所有测试与实现代码已给出完整文本。
- **Type consistency**：`isPublishConflictCode(code)` 签名在 Task 1 定义、Task 2 测试辅助通过行为依赖；`windowsPublishFs` 仅测试内使用；`track` / `cleanupRoot` / `COORDINATOR_SCRIPT` 均为既有名字。
