# Spec：host-meta 租约孤锁（identity:null）永不回收（issue #112）

日期：2026-09-14 · 状态：approved（用户确认 v2）
调研：issue 评论 R1（现状核实）/ R2（修向评估）· v1 自查 review 记录见 §6

## 1. 根因（systematic-debugging Phase 1-3 结论）

**直接根因**：host-meta 租约的两个获取点——`claimHost`（store.mjs:157）与 `updateOwnedHost`（store.mjs:246）——都不传 `identity`，owner.json 的 `identity` 恒为 null；`reclaimOrBlock`（locks.mjs）对 identity-less 锁无条件返回 `blocked`（判死信息缺失），持锁进程暴毙后**没有任何代码路径能回收这把锁**。

**证据链**（issue 探针 5 门闸门 + 代码静态核对）：
1. 探针：host-start 锁 acquired ✓，host-meta 锁 blocked ✗ → 唯一 blocker；
2. 删锁后复跑全绿 → 锁残留是唯一阻塞因素；
3. 代码：reclaimOrBlock 判定 `owner?.identity?.pid`，缺失即 `blocked`（locks.test.mjs:258 锚定该行为）；
4. 设计盲点已留痕：store.mjs:219 注释明知孤锁场景，设计结论是 "surface as retryable" 但无任何清扫者；updateOwnedHost 3×20ms 有界重试后静默 `{updated:false}`，零诊断。

**范围核实**：host-meta 获取点全仓库仅上述 2 处（host-crash.mjs / pty-runner 均经 updateOwnedHost 间接进入）。

**间接问题**：失败路径全程静默 → 现场零 diagnostics 记录，排障靠猜。

## 2. 修复设计（方向 3 + 1 + 4 组合，R2 已评估）

### 2.1 locks.mjs：identity-less 超龄兜底（方向 1，修存量孤锁）

新增**纯函数** `classifyLeaseOwner(owner, now, isProcessDead, opts)`（导出，供单测），返回 `"reclaim" | "busy" | "blocked"`。判定契约：

| 输入状态 | 输出 | 说明 |
|---|---|---|
| owner 不可解析 / 非对象 | blocked | 无判死信息 |
| `owner.token` 非 string | blocked | quarantine 核对依赖它，缺失不可回收（**v1 遗漏，review 补**） |
| identity 完整（`pid>0` + `startToken:string`）且 pid 活 | busy | 现有语义不变 |
| identity 完整且 pid 死 | reclaim | 现有语义不变（方向 3 的未来锁走此路） |
| identity 不完整（含 `startToken:null`）且顶层 pid 无效 | blocked | 无判死信息 |
| identity 不完整、顶层 pid 有效、`age < orphanAgeMs` | blocked | 新鲜锁：可能仍在合法短临界区内 |
| identity 不完整、顶层 pid 有效、`age >= orphanAgeMs`、pid 活 | busy | 活持有者 |
| identity 不完整、顶层 pid 有效、`age >= orphanAgeMs`、pid 死 | reclaim | **存量孤锁兜底回收** |

- `age = now - owner.startedAt`；`orphanAgeMs` 默认 `ORPHAN_LEASE_AGE_MS = 5min`，经 `opts` 可注入（测试用）。
- **平台差异（v1 遗漏，review 补）**：非 Linux 平台 `startToken` 恒为 null → 新锁也落入「identity 不完整」行，暴毙锁需等 5min 才可回收。这是无 startToken 时无法区分 pid 复用的必然保守降级，可接受。
- `reclaimOrBlock` 改为调用该函数（传入 clock），quarantine 机制（调用者 token 命名、inspectedToken 核对、concurrent-winner 恢复）**原封不动**。
- 数据零新增字段：顶层 `pid`/`startedAt` 为 locks.mjs 候选写入时既有。

安全边界：超龄阈值（5min，远大于毫秒级临界区）+ pid 确死双条件；host-meta 持锁毫秒级，5min 不误伤合法持锁。

### 2.2 store.mjs / pid.mjs：获取点传 identity（方向 3，修增量孤锁）

- `src/core/pid.mjs` 新增两个导出（实现取自 service.mjs / pty-runner.mjs 的既有复制体，Linux /proc/<pid>/stat field 22，失败或非 Linux 返回 null）：
  - `captureStartToken(pid): string|null`
  - `currentProcessIdentity(): {pid: number, startToken: string|null}`
- `store.mjs` 内部 `hostMetaIdentity()` = `currentProcessIdentity()`；
- `claimHost` / `updateOwnedHost` 的 host-meta 获取传入该 identity；
- **`claimHost` 新增 `opts.lockImpl` 注入点**（与 updateOwnedHost 对齐；v1 遗漏，review 补）——用于测试断言 identity 传递；
- **文档更新（v1 遗漏，review 补）**：store.mjs:212-219 注释块（现描述 "identity-less short hold ... surfaces as retryable"）与 host-owner-store.test.mjs:313 测试注释随行为更新。

效果：Linux 上此后任何持锁进程暴毙，contender 看到完整 identity + pid 确死 → 走现有 reclaimOrBlock 立即回收。**非目标**：service.mjs / pty-runner.mjs 本地复制体不迁移（缩小 diff，共享函数已就位可作后续小 PR）。

### 2.3 store.mjs：失败路径 diagnostics（方向 4，review 修正版）

- `updateOwnedHost` 重试耗尽（`{updated:false, ownerChanged:false}`）→ `appendDiagnostic` 一条 `level: warn, code: "host_meta_lease_contended"`，`details: { attempts, lastReason }`（循环中保存最后一次 acquire 失败 reason）。
- `claimHost` 锁未取得**且 reason === "blocked"** → `appendDiagnostic` 一条 `level: warn, code: "host_meta_claim_contended"`，`details: { reason }`。busy（正常活锁竞争）不写——**避免误报污染 warningCount（review 修正）**。
- **进程内节流（review 补）**：模块级「未恢复标记」集合；同一 view 的 contended 事件只写一条，成功写入（updated:true / claim 成功）后清除标记，恢复后再次失败才再写。导出 `clearHostMetaThrottleForTests()`（项目有 `clearXxxCacheForTests` 先例）。
- 诊断写入 try/catch 包裹（`appendDiagnostic` 内部 `appendFileSync` 无兜底，**会抛**——已核实），best effort，不破坏主流程。
- store.mjs 新增 import `appendDiagnostic`（与现有 `readDiagnosticSummary` 同模块，无循环依赖，**已核实**）。

### 2.4 非目标

- sweeper（方向 2）：覆盖弱于真实回收路径，另立后续 issue；
- service.mjs / pty-runner.mjs 的 startToken 复制体迁移到共享模块（本 issue 只新增共享版供 store.mjs 用）；
- host.json state 字段与现实脱节：#70/#87 已覆盖。

## 3. 可测性拆分设计（自动化功能点必答）

| 拆分 | 位置 | 形态 | 测试边界 |
|------|------|------|----------|
| F1 | locks.mjs `classifyLeaseOwner` | 纯函数（无 fs，输入全参数化，orphanAgeMs 可注入） | locks.test.mjs 直接单测：契约表 8 行全覆盖 + 阈值边界 |
| F2 | locks.mjs `reclaimOrBlock` | fs + quarantine，判定委托 F1 | locks.test.mjs 真实锁目录：超龄死锁回收、新鲜锁 blocked |
| F3 | pid.mjs `captureStartToken` / `currentProcessIdentity` | 纯函数（读 /proc；非 Linux null） | locks/pid 单测：Linux 下当前 pid 返回非空 string |
| F4 | store.mjs `hostMetaIdentity` | store 内部 helper | 经 F5 观测点间接验证 |
| F5a | `updateOwnedHost` identity 传递 | mutate 回调在持锁窗口内执行 → 回调内读锁 owner.json | host-owner-store.test.mjs：真实路径断言 identity={pid, startToken:string} |
| F5b | `claimHost` identity 传递 | 新增 `opts.lockImpl` 记录+透传 opts | 同上，scriptLock 增强记录 opts |
| F6 | store.mjs 诊断写入 + 节流 | 侧效，try/catch；未恢复标记集合 | host-owner-store.test.mjs：真 root 断言 diagnostics.jsonl 与节流 |

测试边界约定：F1 纯函数零 fs（快、全分支）；F2/F5 走真实锁路径复现 issue 现场（关键）；F6 真实临时 root + 重置钩子。

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | F1 classifyLeaseOwner 契约表全分支 | 自动化（unit） | `node --test test/locks.test.mjs` 新增用例 | 8 行契约全覆盖（含 token 缺失、startToken:null、age==阈值、corrupt、owner 非对象） |
| A2a | 存量 identity-less 孤锁真实回收 | 自动化（unit） | host-owner-store.test.mjs：手写 `{token, pid:99999999, identity:null, startedAt:10min前}` 锁 → **真实** `updateOwnedHost`（不注入 lockImpl） | updated:true、写落地、原孤锁 token 不可再观测（reclaim/quarantine 已清） |
| A2b | identity 完整死锁（方向 3 未来锁）回收 | 自动化（unit） | 同上，锁 `{identity:{pid:99999999, startToken:"x"}}` | 同上（`claimHost` 路径同法验证一次） |
| A3 | F5a/F5b 获取点带 identity | 自动化（unit） | updateOwnedHost：mutate 回调内读锁 owner.json；claimHost：lockImpl 记录 opts | 两者 owner.json identity = {pid: process.pid, startToken: string} |
| A4 | 失败写 diagnostics + 节流 | 自动化（unit） | 注入持续 busy（update）/ blocked（claim） | jsonl 含 `host_meta_lease_contended`（details.lastReason）与 `host_meta_claim_contended`；同 view 连续两次耗尽只写一条（节流）；busy claim 不写 |
| A5 | 全量回归 | 自动化（build） | `npm run verify`（typecheck + 全测试 + coverage + pack dry；可退化为 `npm test`） | 0 失败；锚点测试（locks.test.mjs:258、host-owner-store.test.mjs:122/313）按新契约更新后全绿 |
| A6 | 文档/注释更新 | 自动化（static） | `rg "identity-less short hold" src/ test/` 复核 | store.mjs:212-219 与 host-owner-store.test.mjs:313 注释反映新语义 |
| U1 | 实机 attach 自愈 | 用户实测 | 真实 view 手动造 identity-null 超龄孤锁：`~/.pi/agent/agent-board/views/<viewId>/host-meta.lock/owner.json` 写 `{token:"manual", pid:99999999, identity:null, startedAt:<10min前>}`（先 `ps -p 99999999` 确认死）→ attach 该 view | attach 自动 reclaim 并拉起宿主，无需手工删锁；diagnostics.jsonl 有对应记录 |

## 5. 风险与权衡

- **超龄阈值 5min**：host-meta 均为毫秒级临界区持锁，5min 无合法冲突；非 Linux 平台的暴毙锁回收因此延迟 5min（无 startToken，无法更激进）。
- **pid 复用**：超龄 + pid 确死双条件，host-meta 短临界区 + 5min 门槛，恢复窗口极小；与 host-start 租约现有回收语义一致。
- **行为变化**：updateOwnedHost 竞争者的观察 reason 从 blocked（identity-less）→ busy（带 identity 后 pid 活）——retry 对两者一视同仁，语义等价；host-owner-store.test.mjs:313 注入测试本身不受影响（注释需更新，见 A6）。
- **诊断噪音**：节流保证同一 view 一次 contended 事件一条；watch 场景（外进程持锁 >60ms）恰好是值得诊断的异常，保留 warn 合理。

## 6. v1 自查 Review 记录（2026-09-14）

| # | 发现 | 处置 |
|---|------|------|
| 1 | A3 的 claimHost identity 无法观测（无注入点；且 identity 是写入自身锁而非判定他人） | 加 `opts.lockImpl`；updateOwnedHost 改用 mutate 回调观测（§2.2 / F5a/b） |
| 2 | 诊断无节流 → 1Hz 心跳路径可刷屏 | 未恢复标记节流 + 测试重置导出（§2.3） |
| 3 | claimHost 对 busy 误报 warn | 仅 blocked 写（§2.3） |
| 4 | 非 Linux startToken=null 落入兜底路径未声明 | 契约表 + 平台差异说明（§2.1） |
| 5 | classifyLeaseOwner 未要求 owner.token | 契约表 blocked 行（§2.1） |
| 6 | A2 单场景不足 | 拆 A2a/A2b |
| 7 | A2 断言不精确 | 改为「原锁 token 不可再观测」 |
| 8 | U1 未指定死 pid/路径 | 写明 99999999 + 具体路径 + 验证 diagnostics |
| 9 | 文档/注释更新缺失 | 新增 A6 |
| 10 | appendDiagnostic 会抛 | 明确 try/catch（§2.3，已核实 appendFileSync 无兜底） |
| 11 | startToken helper 命名 | pid.mjs 提供 captureStartToken + currentProcessIdentity（§2.2） |

已核实无误：host-meta 获取点全仓库仅 2 处；diagnostics.mjs ↔ store.mjs 无循环依赖；1Hz 读 /proc 开销可忽略；pty-runner.integration.test.mjs:1099（外来活锁 2.3s）行为不变（新增一条 warn 诊断，测试不断言该内容）。
