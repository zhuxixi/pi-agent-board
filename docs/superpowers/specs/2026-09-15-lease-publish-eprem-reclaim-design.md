# Spec：Windows 上 coordinator 租约孤锁因 EPERM 无法自动接管（issue #114）

日期：2026-09-15 · 状态：approved（用户确认）
调研：issue 评论 R1（根因收敛 + Windows 测试基线）
前置：#112（PR #116）已修复「identity-less 超龄回收」；本 issue 修复其剩余阻塞

## 1. 根因（systematic-debugging Phase 1-3 结论）

**唯一剩余根因**：`attemptAcquireLease`（src/core/locks.mjs）的 publish-rename 冲突白名单只认 `EEXIST`/`ENOTEMPTY`；Windows 上 `renameSync(candidate, lockPath)` 对已存在目标抛 `EPERM`（errno -4048，实测目标空/非空一致），被 catch 直接 `throw`，执行流永远到不了 `reclaimOrBlock`。

**证据链**：
1. 实机（2026-09-12 / 09-13 两次）：coordinator 暴毙 → 残留 `state-coordinator.lock` → `node runner/state-coordinator.mjs <root>` 输出 `lease unavailable (EPERM); ...; exiting`（exit 0）→ ensureCoordinator 10s 窗口内 probe 全败 → 面板报 `coordinator_unavailable`（DONE/archive/adopt 全断）。
2. 复现脚本（最新代码 a129b09，Windows）：构造「死 pid + `startToken:null` + 超龄 10min」残留锁后 `tryAcquireOwnedViewLock` → `THREW: EPERM`（锁已满足 #112 全部回收条件，仍被白名单拒之门外）。
3. 代码静态核对：locks.mjs:224（renameSync）→ :228（`if (code !== "EEXIST" && code !== "ENOTEMPTY") throw err;`）。
4. Windows 测试基线：`node --test test/locks.test.mjs` = **20 tests / 4 fail**，4 个失败全部是 lease 接管路径（含 #112 新增的 2 个）→ 证明该路径在 Windows 从未真实执行过（CI 为 Linux；#112 的纯函数测试不触碰真实 rename）。
5. 影响面不止 coordinator：pty host 的 `host-meta` / `host-start` 租约共用 `attemptAcquireLease`，Windows 上锁已存在即同断。

**已修复部分（#112，确认无需重做）**：`classifyLeaseOwner` 对 identity-less owner（含非 Linux `startToken:null`）在「`age >= ORPHAN_LEASE_AGE_MS`(5min) 且顶层 pid 确死」时返回 `reclaim`；活 pid 恒 `busy`；quarantine + inspectedToken 核对保留。

## 2. 修复设计

### 2.1 locks.mjs：rename 冲突码判定抽为纯函数并纳入 EPERM（D1）

新增导出纯函数：

```js
/**
 * Whether a publish-rename failure means "the lock path already exists"
 * (contention) rather than a genuine filesystem error.
 * POSIX reports EEXIST/ENOTEMPTY; Windows reports EPERM (errno -4048) for
 * renaming a directory onto an existing directory — this op's platform
 * equivalent of EEXIST (issue #114).
 * @param {string|undefined} code
 * @returns {boolean}
 */
export function isPublishConflictCode(code) {
	return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}
```

`attemptAcquireLease` catch 改为：

```js
if (!isPublishConflictCode(code)) throw err;
const verdict = reclaimOrBlock(lockPath, token, fs, isProcessDead, now);
```

- **可测性拆分**：判定为纯函数（零副作用、可注入断言）；副作用（reclaim/quarantine）仅在判定为冲突后触发，边界清晰。
- **POSIX 语义变化**：真权限类 EPERM 将进入 `reclaimOrBlock` → 锁不存在/不可解析时返回 `blocked` → 最终抛 `LOCK_TIMEOUT`（原为 `EPERM`）。两者皆为失败退出、不产生错误回收，形态变化可接受（#48 的 `renameWithRetry` 亦已把 EPERM 列入无条件白名单，语义一致）。
- **安全性**：能否回收仍由 `classifyLeaseOwner` 决定（pid 确死 / 超龄 + pid 确死），白名单化 EPERM 不放宽回收条件。

### 2.2 测试（D2）

1. **纯函数层**（unit）：`isPublishConflictCode` 三分支断言（EEXIST/ENOTEMPTY/EPERM → true；ENOENT/EACCES/undefined → false）。
2. **接管路径层**（unit + 注入 fs 模拟 Windows）：注入 `fs.renameSync` 首次对 `lockPath` 抛 EPERM，后续走真实 rename，覆盖：
   - 死 owner（identity 完整）→ `acquired=true`，lease 可正常 release；
   - 死 owner（identity-less 超龄）→ `acquired=true`（#112 路径打通）；
   - 活 owner → `acquired=false, reason="busy"`（不误抢）；
   - 身份不明（pid 活/无 token）→ 该场景回落 `blocked`/`busy` 既有语义。
3. **真机 integration**：Windows 上 `node --test test/locks.test.mjs` 全绿（修复前 16/20）。

### 2.3 非目标

- 不实现 Windows `startToken`（PowerShell `CreationDate`）：修复后最坏为 5min 超龄自愈（原为永久卡死），扩围留独立 issue；
- 不改 `ORPHAN_LEASE_AGE_MS` / ensureCoordinator 的 `ENSURE_WINDOW_MS`；
- 不动 host-meta 获取点 / service.mjs / pty-runner.mjs 的 identity 传递；
- 不加 coordinator 失败诊断（#112 已在 store 侧落地 contended 诊断，coordinator 侧留后续）。

### 2.4 部署路径

PR 合并 → 同步运行副本（`~/.pi/agent/git/github.com/zhuxixi/pi-agent-board`）→ 用户实测。合并前可用同一 worktree 代码做 U1。

## 3. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 冲突码判定含 EPERM | 自动化验证（unit） | `node --test test/locks.test.mjs`（新纯函数用例） | EEXIST/ENOTEMPTY/EPERM→true；其余→false |
| A2 | EPERM 下死 owner（identity 完整）可接管 | 自动化验证（unit） | 同上（注入 fs renameSync 首抛 EPERM） | `acquired=true`，lease.release() 成功 |
| A3 | EPERM 下死 owner（identity-less 超龄）可接管 | 自动化验证（unit） | 同上 | `acquired=true`（#112 回收路径被打通） |
| A4 | EPERM 下活 owner 不误抢 | 自动化验证（unit） | 同上 | `acquired=false, reason="busy"` |
| A5 | Windows 真机接管测试转绿 | 自动化验证（integration，真机） | `node --test test/locks.test.mjs`（Windows 11） | 20/20 pass（基线 16/20） |
| A6 | 无回归 + 类型干净 | 自动化验证（static + unit） | `npm run typecheck`；`npm test` | typecheck 零错误；全量失败集不新增（Windows 既有环境类失败除外，需给出基线对比） |
| A7 | 实机 coordinator 自愈 | 自动化验证（E2E 脚本，真机） | 临时 root：造超龄 identity-less 孤锁 → 启动 coordinator → 断言接管成功 + socket 可 probe | coordinator 常驻，owner.json 刷新为新 pid |
| U1 | 面板实机回归（用户实测） | 用户实测 | 修复部署后：kill 当前 coordinator（保留孤锁）→ 等 5min 超龄 → 面板按 `d` → `y` | 标记 DONE 成功；无需手动删锁；coordinator 自拉起 |

U1 执行时机说明：需 5min 等待窗口，可在修复部署后按用户时间安排；未执行前标记 `pending`，不宣称全量验收完成。

## 4. 影响文件（预估）

- `src/core/locks.mjs`（+~12 行：导出纯函数 + catch 改造 + 注释）
- `test/locks.test.mjs`（+~70 行：纯函数用例 + EPERM 注入接管用例）
- 无其他生产文件改动。
