# Spec: 修复 locks.mjs acquireLock 无眠死循环（issue #33）

> Draft 状态：待用户确认设计后进 worktree 实现（github-issue-driven 步 4 暂停点）。

## 问题

`src/core/locks.mjs` `acquireLock` 在锁持续不可得时（根目录被删 / 只读 / 锁状态损坏），30s 等待窗过期后退化为零睡眠忙等循环：100% 单核 CPU、事件循环冻死、定时器全灭、进程永远不退出。现网两个 job-runner 僵尸进程分别空转 10.5 天 / 4.4 天（#33 现场证据）。

## 根因（两处叠加）

```js
while (true) {
    try {
        mkdirSync(lockPath);
        writeFileSync(path.join(lockPath, "owner.json"), ...);
        return;
    } catch (err) {
        // 缺陷 1：睡眠只在初始窗口内生效，窗口一过永不睡眠
        if (!isLockStale(lockPath, staleMs) && Date.now() - started < Math.max(250, staleMs)) {
            Atomics.wait(...20ms);
            continue;
        }
        // 缺陷 2：releaseLock 静默吞错，循环无条件继续 → 无眠紧循环
        releaseLock(lockPath);
    }
}
```

**触发机制（现场还原）**：teardown 的 `rmSync(root, {recursive})` 与 runner 收尾链在时间上系统性重叠（runner 快速收尾链 ~10-50ms 到达锁 vs 测试 waitFor 轮询 ~50ms + 断言后才 rmSync ~50-150ms）。目录树遍历删掉 `ensureDir` 刚验证过的父目录后，`mkdirSync` 从此永远 ENOENT（**ensureDir 只在循环外跑一次，循环内永不重建父目录**）→ 30s 窗口后零睡眠死循环。另两类等价失败：owner.json 写失败（半成品锁被误判 stale → 删了重建无限循环）、锁目录删不掉（rmSync 失败被吞）。

## 设计决策

### 决策表

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| D1 | 强夺失败后的行为 | **有界尝试后抛错**（`Error: lock timeout: <path>`） | 锁不可得属环境故障，忙等无意义；抛错让调用层决定降级 |
| D2 | 强夺（窗口后偷锁）语义 | **保留**：窗口过期 → releaseLock → 立即重试一次 | 现有测试「fresh lock 等窗口后强夺」固化此语义，改动会破坏契约 |
| D3 | 重试上限 | 等待窗内无限重试（带睡眠，窗口 = `max(250, staleMs)`，保留现有 floor）；窗口后**最多 2 次强夺**（含 owner.json 写失败路径），仍失败即抛 | 覆盖 rm 失败 / mkdir 仍失败 / 写失败三类；有界即无死循环 |
| D4 | 睡眠策略 | 保留 `Atomics.wait(20ms)`；循环内任何 continue 前必有睡眠或已抛错 | 反证 D1 的失败模式，杜绝任何无眠路径 |
| D4b | **循环内自愈**：每次 catch 后重跑 `ensureDir(dirname)`（ensureDir 自身失败计为一次失败尝试） | 现场最高频竞态（teardown rmSync 删掉父目录）从「等窗口后抛错」升级为「瞬时自愈、正常拿锁退出」；有界性不变 |
| D5 | fs 注入 | 仿 `screen-log.mjs` `defaultScreenLogFs` 先例，加 `locksFs` 参数（默认 node:fs） | 现有测试无注入，注入后才能确定性复现「mkdir 永败」等场景 |
| D6 | 队列层错误传播 | follow-up-queue.mjs 5 个入口 try/catch **catch-all**（含 fn 内 writeFollowUpQueue 的 fs 错误，非仅锁错误）→ `{ok:false, error}` | 保持 {ok} 返回值约定，service.mjs 无需改动；已确认 follow-up-queue.test.mjs 无 throw 断言，catch-all 安全 |
| D7 | job-runner 兜底 | `.finally` 链里 `finalizeSteeringIfNeeded` + `drainQueuedFollowUp` 各自 try/catch | 锁层抛错永远不会阻止 `process.exit`——僵尸进程防线最后一道 |
| D8 | 默认 staleMs | 不变（30s） | 现有测试与调用方依赖 |
| D9 | 测试 harness 清理 | 全部 7 处 launchRun 都捕获 pid（现有 4 处丢弃，含出过僵尸的 dash 测试）→ finally 里 TERM → 短等待 → KILL → 再 rmSync(root) | 现场两个僵尸的直接源头是 teardown 只删目录不杀 detached runner；这层保证测试不再产出孤儿（launch.test.mjs 的 detached fake-pi 已确认自然退出，无需处理） |

### 数据流（修复后）

```
claimNextFollowUp(root, viewId)
  → withViewLockSync(root, viewId, "queue", fn)
    → acquireLock: [wait loop w/ sleep] → 窗口过期 → steal attempt ×2 → 失败 → throw
  → catch → { ok: false, error: "follow-up queue lock unavailable: ..." }
  → job-runner drainQueuedFollowUp: claimNextFollowUp 返回 {ok:false} → 直接 return（不进 launch）
  → .finally → process.exit 必达
```

### 组件契约

- `withFileLockSync` / `withViewLockSync`：成功返回 fn 结果；**新行为**——锁超时抛 `Error`（message 含 lockPath 与耗时）。
- follow-up-queue 5 个导出（enqueue/claim/complete/release/remove/clear）：任何锁失败 → `{ok:false, error}`，不再抛出。
- service.mjs：零改动（已按 {ok} 消费）。
- job-runner.mjs：收尾链不因锁失败挂起。

### 降级行为

- 锁失败时队列操作静默失败并写 diagnostics（job-runner 用 appendDiagnostic；service 层已有该模式），用户可感知但系统不挂。
- 不引入锁重试队列、不引入跨进程 watchdog——超出本 issue 范围。

## 非目标

- 不改锁的 mkdir 实现（不换 flock/其他机制）
- 不处理「锁持有者崩溃残留」之外的竞争语义
- 不改 30s staleMs 默认值
- 不引入异步锁

## 测试计划（red-green）

test/locks.test.mjs 现有 5 测试全绿；新增（全部带 `{ timeout: 5000 }` 防挂）：

1. **mkdir 永败**（注入 fs）：`withFileLockSync(..., { staleMs: 50 })` 在 ~250ms 窗口（`max(250, staleMs)` floor）后抛错，不在 5s 内挂起。
2. **写 owner.json 永败**（注入 fs）：mkdir 成功但 writeFileSync 抛 → 有界强夺后抛错。
3. **rmSync 永败**（注入 fs）：窗口后强夺 rm 失败 → 抛错。
4. **争用正常恢复**：注入 fs 模拟「前 N 次 mkdir EEXIST、之后成功」→ 等待窗内获取成功（保语义 1）。
4b. **父目录被删后自愈**（D4b）：真实 fs，锁获取前删掉父目录 → ensureDir 在循环内重建 → 正常拿锁（验证现场最高频竞态透明自愈）。
5. **窗口后强夺仍成功**：复用现有测试 4（不回归）。
6. follow-up-queue 层：锁失败 → `{ok:false, error}`（用注入 fs 或真实坏路径）。
7. job-runner 收尾：若可低成本导出/集成测试则覆盖「锁坏时 drainQueuedFollowUp 不挂起、process 退出」；否则以代码评审 + 手动验证为准。
8. 集成测试 teardown：runner 被杀后进程表里不再残留 job-runner（现有集成测试全绿即可证明 kill 生效）。

## 验收

- `npm test`（或 `npm run verify`）全绿
- 35s 复现脚本（/sys 只读路径）修复后应立即抛错而非空转
- 跑完集成测试后 `ps` 无残留 job-runner
- 代码评审通过后 PR + Zima CR
