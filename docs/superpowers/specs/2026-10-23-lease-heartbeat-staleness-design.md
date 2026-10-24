# issue #224 — 设计：用租约心跳超龄回收替代「pid 死活」判定

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T21:35:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T21:58:00+08:00 · 依据 R1 复核（G1 + D1–D5）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T22:12:00+08:00 · 依据 R2 复核（G1 + G2 + D1–D5）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T22:31:00+08:00 · 依据 R3 复核（0 真缺口 + D1–D6，收敛轮）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T23:20:00+08:00 · 规划期回改（监督定时器起点移到 listen 之后、A9b、`reason` 语义）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T00:05:00+08:00 · 实现期回改（D1 伪代码的无 token 语义与既有 A4 契约对齐）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T01:00:00+08:00 · 整支复核后文档精确性修正（A6 表述、D4 常量关系改为由 A9b 单测钉住）

仓库：zhuxixi/pi-agent-board · issue：#224 · 起草轮次：R0（待交叉复核）

---

## 1. 问题与根因（已复现）

**现象**：租约 owner 的 pid 被系统复用后，`classifyLeaseOwner` 认为「持有者还活着」，导致
`state-coordinator.lock` 永久不可回收；新 coordinator 每次抢锁失败即 `exit(0)`（stderr 被丢弃），
`ensureCoordinator` 永远返回 `coordinator_unavailable`，全部 `state_command` 被拒，面板所有会话停在 `QUEUED`。

**根因链**（行号已核实）：

| 环节 | 位置 | 事实 |
|---|---|---|
| 身份捕获 | `src/core/pid.mjs:53` | `captureStartToken()` 仅 Linux 读 `/proc`，Windows 恒 `null` |
| 判定 | `src/core/locks.mjs:270-286` | identity 分支只问 `isProcessDead(pid)`；identity-less 分支同样只问死活 |
| 探针 | `locks.mjs:226` | 默认 `(pid) => !isAlive(pid)`，无法表达「pid 活着但不是持有者」 |
| 心跳 | `locks.mjs:342` + `state-coordinator.mjs:119` | 每 1000ms 写 `heartbeat.<token>`，**`locks.mjs` 从不读取** |
| 静默 | `state-coordinator.mjs:116` | 抢锁失败只写 stderr 后 `exit(0)` |

**复现证据**（Windows 本机、真实模块；脚本在留档目录
`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-224/research/repro-224.mjs`，**不入库**。
该脚本的四个用例在 PR 中以单测形态复刻为 A1/A2/A4，因此修复前基线在仓内可回归）：

| 用例 | 期望 | 实测（修复前） |
|---|---|---|
| A. pid 活着（复用）+ 心跳 24h 未更新 | 回收 | **`busy`（bug）** |
| B. pid 活着 + 心跳新鲜 | busy | `busy` ✓ |
| C. pid 死 + 锁龄 48h | 回收 | acquired ✓ |
| D. 无心跳文件 + pid 活着（host-meta 形态） | busy | `busy` ✓ |

**关键结论**：记录 Windows 的进程创建时间（issue 建议 2）**修不好本 bug**——判定函数从不比对
token 值；且该改动会让记录落入 identity 分支，跳过 5 分钟宽限，反而更糟。心跳是唯一平台无关、
且能区分「持有者活着」与「pid 被复用」的信号。

## 2. 范围

**做**：心跳超龄回收（租约层）+ 心跳承诺的自描述/显式契约 + coordinator 级可观测性 + 心跳失效时的自终止不变量。

**不做**（明确非目标，避免范围蔓延）：

1. Windows `captureStartToken` 实现与三份拷贝收敛、token 值比对 —— 属「进程身份可验证」共享底座，另行处理。
2. `replaceStaleCoordinator`（`coordinator-client.mjs:154`）对复用 pid 直接 `SIGTERM` 的隐患 —— 同源但语义独立，另开 issue。
3. #217 的 `stopping` 顺序缺陷与释放路径 —— 另一层，独立修。
4. 心跳回收**不**扩展到 host-meta 毫秒级租约（见 D2 否决理由）。

## 3. 设计决策

### D1 判定输入：把「心跳年龄」作为注入的纯函数参数

`classifyLeaseOwner` 保持纯函数（现有单测风格），新增 `opts`：

```js
classifyLeaseOwner(owner, now, isProcessDead, {
  orphanAgeMs,        // 既有（默认 5min）
  heartbeatAgeMs,     // 新增：number（陈旧）| null（无心跳证据）| undefined（同 null）
  heartbeatMs,        // 新增：owner 声明的周期（number>0）| undefined 未声明
  heartbeatStaleMs,   // 新增：门限（默认 LEASE_HEARTBEAT_STALE_MS = 60_000）
}) -> "reclaim" | "busy" | "blocked"
```

判定顺序（伪代码，前置优先级与失败方向都在此固定；实现必须逐条对应）：

```js
const hasIdentity = identity.pid > 0 && typeof identity.startToken === "string";
const pid         = Number(owner?.identity?.pid ?? owner?.pid ?? 0);
const declared    = Number(heartbeatMs) > 0;                 // D2 显式声明
// 无 token 只剥夺「可回收性」，不影响 busy 判定（既有契约，已被单测钉住）
const reclaimable = typeof owner?.token === "string";
if (!owner || typeof owner !== "object") return "blocked";
if (pid <= 0) return "blocked";                              // 没有 pid 无法判定

if (declared) {
    // 显式声明：对 identity 与 identity-less 两个分支都生效，且**绕过** age 早退
    const hbAge = heartbeatAgeMs ?? (now - owner.startedAt);  // 无文件/破损 → startedAt 回退（D3）
    if (hbAge >= Math.max(heartbeatStaleMs, 3 * heartbeatMs)) return reclaimable ? "reclaim" : "blocked";
} else if (heartbeatAgeMs != null && (now - owner.startedAt) >= orphanAgeMs) {
    // 存量自愈：只对 identity-less 生效，且要求 age >= orphanAgeMs（D2）
    if (heartbeatAgeMs >= heartbeatStaleMs) return reclaimable ? "reclaim" : "blocked";
}

if (hasIdentity) {
    if (!isProcessDead(pid)) return "busy";                   // 既有：identity 分支不跳 age
    return reclaimable ? "reclaim" : "blocked";
}
// identity-less
if (!declared && (now - owner.startedAt) < orphanAgeMs) return "blocked";   // 既有；仅非声明租约受 age 约束
if (!isProcessDead(pid)) return "busy";
return reclaimable ? "reclaim" : "blocked";
```

三点必须钉住（否则前向契约形同虚设）：
1. 显式声明分支**先于** `hasIdentity` 的 `busy` 早退 —— 否则 Linux（有 startToken）上永远不进心跳判定。
2. 显式声明**绕过** identity-less 的 `age < orphanAgeMs -> blocked` —— 否则崩溃后 60s 自愈退化为 5min+。
3. 负值 `heartbeatAgeMs` 在纯函数与 I/O 壳两层都按 0（新鲜）处理（防御性双保险；壳层见 D3）。
4. **无 token 不等于 blocked**：它只剥夺「可回收性」（quarantine 需 token 校验），仍可返回 `busy`。
   既有单测 `live-holder path keeps busy even without a token` 钉住了这一点。

### D2 心跳承诺如何成立（eligibility）——两条互斥路径

| 路径 | 条件 | 覆盖对象 | 理由 |
|---|---|---|---|
| 显式声明 | `owner.heartbeatMs` 为正数（新 coordinator 写 1000） | 前向契约 | 声明即承诺；门限 = `max(heartbeatStaleMs, 3 × heartbeatMs)` |
| 存量自愈 | `heartbeat.<owner.token>` 可解析 **且** 锁龄 ≥ `orphanAgeMs`（5min） | 升级前遗留记录（含 #224 现场） | 心跳文件证明该租约确实承诺心跳；5min 锁龄保证与毫秒级短持有租约完全区隔 |

其余一律不eligible，沿用 #112 契约。**否决**「心跳文件存在即可回收」：`pty-runner` 的
`host-start` 租约也写心跳，但它在 boot 期间持有（`pty-runner.mjs:769-1058`），若仅凭文件存在判定，
一次 30s 以上的慢启动就会被第二个 runner 抢占 → host.json 双写。以「锁龄 ≥5min」或「显式声明」作门槛
把该窗口排除；`host-meta`（`store.mjs:191`，从不 `touch()`）两种门槛都不满足，行为完全不变（用例 D）。

### D3 心跳年龄的计算与失败方向

`reclaimOrBlock`（`locks.mjs:299`，唯一 I/O 壳）在读取 owner.json 后：

| 情形 | `heartbeatAgeMs` |
|---|---|
| `heartbeat.<token>` 可解析且 `at` 为有限数 | `max(0, now - at)`（未来时间戳按新鲜处理） |
| 文件不存在 | `null`（未声明租约则永不 eligible；已声明则**回退**为 `now - startedAt`） |
| 文件不可读 / JSON 破损 / `at` 非数 | 未声明 → `null`（fail-closed）；已声明 → `now - startedAt` |

「不可读即新鲜」不可取（会让真实孤锁永久卡死）；「不可读即陈旧」也不可取（会让健康持有者被抢占）。
上表是二者之间的最小让步：**只有主动声明了心跳契约的持有者才吃 startedAt 回退**。

### D4 心跳写失败必须自终止（防双写不变量）

`lease.touch()` 失败时静默返回 false → 一个**活着但写不了心跳**的 coordinator 会在 60s 后被判陈旧并被抢占，
产生双写。新增不变量：

> 持有者连续 3 次**由 interval 监督的** `touch()` 失败（即 3s，远小于 60s 门限）→ **best-effort** 写诊断
> `coordinator_heartbeat_lost`（包在 try/catch 里，写失败不阻断）→ 走**既有** `shutdown(0)`
> （`state-coordinator.mjs:199-215`：`clearInterval(startTouchTimer)` + `server.close()` +
> POSIX socket unlink + `lease.release()` + exit）。

顺序固定为 **计数 → 诊断 → shutdown**。`shutdown(0)` 直接 exit，所以诊断必须先落盘；反之
`appendDiagnostic` 内部的 `appendFileSync` 会抛（仓库 host-meta spec 已记录此风险），而 D4 的目标场景
恰恰是磁盘故障，因此诊断必须 try/catch 包住，**写失败不得阻断 shutdown**。

即：**不能在门限耗尽前证明自己活着，就主动让位**，而不是被别人抢占。门限与失败上限的关系由 **A9b 单测**钉住
（`MAX_CONSECUTIVE_TOUCH_FAILURES × heartbeatMs < LEASE_HEARTBEAT_STALE_MS`，比注释更难被绕过）：
`LEASE_HEARTBEAT_STALE_MS (60s) > MAX_CONSECUTIVE_TOUCH_FAILURES (3) × heartbeatMs (1s)`。

**计数范围（与 D5 协调）**：监督心跳定时器在 **`server.listen` 成功后**启动，不在取锁后启动。理由：若在 boot 期间就监督，`3 × 50ms` 的强制失败测试会在 `server.listen` 之前触发让位，socket 从未绑定，A14 的端点清理断言退化为空断言；语义上也应「服务期间才需要心跳」。boot 期间由 D5 的边界 touch 保活。
只有监督定时器的 touch 计入连续失败；boot 阶段边界 touch（取锁后、回放后、listen 前）直接调 `lease.touch()`
并忽略返回值，**不计入**。boot 阶段的磁盘故障会由启动后的第一个 tick 在一个周期内捕获。

**适用范围（明确边界）**：D4 只覆盖 coordinator 租约。`pty-runner` 的 `host-start` 租约虽然也写心跳，
但其磁盘故障兜底是 instance 校验（`shouldYieldRunner` / `owner_lost`，见 R2），本 issue **不**给
host-start 加自终止（非目标，避免范围扩张）。

**可注入 seam**（供 A14 自动验证，沿用 `src/core/test-knobs.mjs` 与 `AGENT_BOARD_TEST_*` 既有模式，
未设置时生产行为字节一致）：`AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS`（压缩心跳周期）与
`AGENT_BOARD_TEST_FORCE_TOUCH_FAILURE=1`（强制**被监督的** interval touch 返回 false）。
唯一失败注入点就在 interval 回调里；boot 边界 touch 不经过它。

### D5 门限取 60s（而非 30s）

租约持有者在拿到锁到绑定端点之间有一段同步 boot（`repairJournalTail` + `readJournal` 回放，
`state-coordinator.mjs:127-189`）；回放被 `CHECKPOINT_THRESHOLD_BYTES`（256KB）约束，正常情况下 << 1s，
但慢盘/杀软扫描不可假设。60s 给出 60× 余量，代价是最坏 60s 才自愈（远优于「永不」）。
另外在 boot 阶段边界各补一次同步 `touch()`（取锁后、回放后、listen 前），使心跳反映真实进度；
**监督定时器在 `server.listen` 成功后才启动**（见 D4），因此 boot 的心跳间隙 = boot 耗时，由 60s 门限覆盖
（回放受 `CHECKPOINT_THRESHOLD_BYTES` 约束，正常 << 1s）。

### D6 可观测性：coordinator 级诊断 + 回收留痕

- 新文件 `views/_coordinator/diagnostics.jsonl`（`appendDiagnostic(root, "_coordinator", …)`；`viewDir` 只是
  路径拼接，无 viewId 校验；`pruneScreenLogs` 对无 `meta.json` 的外来目录只统计不删除，已核实）。
- 事件：`lease_reclaimed`（info，source `lock`，details: ownerPid/heartbeatAgeMs/lockAgeMs/eligibility）、
  `coordinator_lease_unavailable`（error，source `coordinator`，details **= `describeLeaseConflict` 的六个键，无增删**）、
  `coordinator_heartbeat_lost`（error，source `coordinator`，details: `{ consecutiveFailures }`）。
- 回收留痕不引入依赖倒置：`attemptAcquireLease` 在回收成功时把 `reclaimed` 元数据挂在返回的 Lease 上
  （`lease.reclaimed: {ownerPid, heartbeatAgeMs, lockAgeMs, eligibility} | null`），由调用方决定是否落盘。
- 抢锁失败细节由新导出 `describeLeaseConflict(root, viewId, name, opts)` 提供（读 owner.json + 心跳），
  返回**固定六字段**：`{ reason, ownerPid, hasIdentity, lockAgeMs, heartbeatAgeMs, heartbeatMs }`（读不到锁时返回 `null`）。
  `reason` 的语义固定为**调用时刻 `classifyLeaseOwner` 的原始判定**：`"reclaim" | "busy" | "blocked"`（诊断路径上实际只会看到后两者）。
  该六字段**即** `coordinator_lease_unavailable` 事件 `details` 的全部键（`reason` 取代上文的 `code`），
  A8 断言与实现字段**一一对应**，不得增删。

## 4. 契约与边界

| 契约 | 现状 | 本改动后 |
|---|---|---|
| quarantine 回收前校验 token | 有（`locks.mjs:313-325`） | **不变**，新增路径同样走该校验 |
| 过期 token 不可删后继锁 | 有（`releaseWithToken`） | **不变** |
| 全新 identity-less 锁 → blocked | 有（#112） | **不变**（用例 A4） |
| identity-less + 超龄 + pid 死 → reclaim | 有 | **不变**（用例 A4） |
| host-meta（无心跳声明） | busy/blocked | **不变**（用例 D/A4） |
| `pty-runner` host-start（心跳但短持有，锁龄<5min） | busy | **不变**；锁龄≥5min 且心跳陈旧时可回收（性质变化，见风险 R2） |
| `owner.json` 结构 | `{token,pid,identity,startedAt}` | 追加可选 `heartbeatMs`（仅 coordinator 写）；旧记录完全兼容 |

## 5. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | 存量记录（identity.startToken=null、pid 活着、心跳 24h 陈旧、`startedAt` 48h 前即锁龄≥5min、无 `heartbeatMs`）可回收 | 自动化（unit） | `node --test test/locks.test.mjs` 中新增用例：构造 #224 原样 owner.json（含 `startedAt = now - 48h`）+ `heartbeat.<token>`，用真实 fs 调 `tryAcquireOwnedViewLock` | `acquired: true`，锁目录被替换，`lease.reclaimed.heartbeatAgeMs ≥ 24h` |
| A1b | **D2 否决项的失败分支**：有心跳文件但锁龄 <5min（pid 活着、未声明 `heartbeatMs`）→ 不得回收 | 自动化（unit） | 同上：`startedAt = now - 30s`、`heartbeat.at = now - 29s`、pid 活着 | `acquired: false, reason: "blocked"`（与既有「fresh identity-less lock → blocked」一致：超龄门槛先于 liveness 判定，故不是 busy） |
| A1c | 存量路径的反向边界：锁龄超龄但心跳**新鲜** → 仍不得回收 | 自动化（unit） | `startedAt = now - 10min`、`heartbeat.at = now`、pid 活着 | `acquired: false, reason: "busy"` |
| A2 | 显式声明租约：心跳新鲜时仍 busy，且 `heartbeatMs` 真的被写入 `owner.json` | 自动化（unit） | (a) `tryAcquireOwnedViewLock(..., { heartbeatMs: 1000 })` → 读 `owner.json`；(b) 预置声明租约 `startedAt = now-30s` + `heartbeat.at = now` → 再抢 | (a) `owner.heartbeatMs === 1000`；(b) `acquired: false, reason: "busy"` |
| A3 | 声明 `heartbeatMs` 的租约：陈旧 → 回收；门限 = `max(heartbeatStaleMs, 3×heartbeatMs)` 两侧都能被穷举 | 自动化（unit） | 纯函数直接调用，**同时注入** `heartbeatMs`、`heartbeatStaleMs`、`now`、`heartbeatAgeMs`；分两组：(a) `heartbeatStaleMs > 3×heartbeatMs`（max 取 staleMs）(b) `heartbeatStaleMs < 3×heartbeatMs`（max 取 3×周期）。各在门限 `-1ms` / `+0ms` 处断言 | 两组均：`门限-1ms → busy`、`门限 → reclaim` |
| A3b | 显式声明**绕过** identity-less 的 age 早退 | 自动化（unit） | 纯函数：`startedAt = now - 30s`（锁龄<5min）+ `heartbeatMs: 1000` + `heartbeatAgeMs = 120_000`（陈旧）| `reclaim`（若实现保留 age 早退则得 `blocked`，测试必挂） |
| A4 | 无心跳证据的租约行为完全不变 | 自动化（unit） | 三条：全新 identity-less→blocked；超龄+pid 死→reclaim；超龄+pid 活→busy | 与现状一致 |
| A5 | 负值 `heartbeatAgeMs`（未来时间戳/时钟回拨）按新鲜处理——纯函数与 I/O 壳两层都钉住 | 自动化（unit） | (a) 纯函数：`heartbeatAgeMs = -5000` + 已声明 → `busy`（不得 reclaim）；(b) `readLeaseHeartbeat` 注入假 fs 返回 `at = now + 5000` → 返回 `0` | 两层均按新鲜处理，无 reclaim |
| A6 | 心跳文件破损/不可读的失败方向 | 自动化（unit） | 未声明→无资格（`heartbeatAgeMs=null`）：超龄+pid 活→`busy`，锁龄<5min→`blocked`；已声明→按 startedAt 回退→超门限 reclaim | 与 D3 表一致 |
| A7 | 回收路径仍受 quarantine token 校验保护（不得删除后继的锁） | 自动化（unit） | 沿用既有并发模式：回收过程中插入新 owner，断言恢复而非删除 | 后继锁存活，verdict=busy |
| A8 | `describeLeaseConflict` 摘要正确 | 自动化（unit） | 临时目录构造 owner+heartbeat，调用该函数 | 恰好返回 `{reason, ownerPid, hasIdentity, lockAgeMs, heartbeatAgeMs, heartbeatMs}` 六字段且值正确；无锁时返回 `null` |
| A9 | 心跳连续失败 → 让位（纯判定） | 自动化（unit） | 新增 `heartbeatFailureAction(n, max)` 纯函数（导出位置见 §9：`locks.mjs`） | `n<max → "continue"`，`n>=max → "abandon"`，边界包含 |
| A9b | 让位界限严格早于陈旧门限（常量关系） | 自动化（unit） | 断言 `MAX_CONSECUTIVE_TOUCH_FAILURES × 1000 < LEASE_HEARTBEAT_STALE_MS` | 断言成立（防未来有人把两者调反） |
| A14 | 让位的**接线**：连续心跳失败 → coordinator 释放租约、清理端点、退出并留诊断 | 自动化（integration） | 在 `test/state-coordinator.integration.test.mjs` 内先写 `process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS="50"` 与 `AGENT_BOARD_TEST_FORCE_TOUCH_FAILURE="1"`（`startCoordinator` 经 `env:{...process.env}` 继承，**无需改签名**），`t.after` 里 `delete` 清理；等待退出 | 进程在 ≤ 1s 内以 0 退出；`views/_coordinator/state-coordinator.lock/` 已删除（租约释放）；`views/_coordinator/diagnostics.jsonl` 有 `coordinator_heartbeat_lost`（details 含 consecutiveFailures）；**端点清理**：POSIX 断言 socket 文件已 unlink（`boundSocketIdentity` 已置位，非空断言），win32 断言命名管道不再可连接 |
| A14b | **诊断写失败的失败分支**：诊断写抛错不得阻断 shutdown | 自动化（integration） | 同 A14，额外加 `AGENT_BOARD_TEST_FAIL_DIAGNOSTIC="1"`（只包住 coordinator 的 diag 包装，使 `appendDiagnostic` 抛） | 进程仍以 0 退出、租约仍释放、端点仍清理；`diagnostics.jsonl` 无该事件（写失败）——断言的是**不阻断**，不是落盘 |
| A10 | 端到端：陈旧租约存在时新 coordinator 接管并恢复写入 | 自动化（integration） | `test/state-coordinator.integration.test.mjs` 新增用例：预置陈旧锁 + `createView`，起 coordinator，发 `state_command` | 命令 `applied`、`state-journal.jsonl` 增长、`views/_coordinator/diagnostics.jsonl` 含 `lease_reclaimed` |
| A11 | 健康租约仍独占（第二个实例立即退出），且**抢锁失败会落诊断** | 自动化（integration） | 既有用例「second coordinator instance exits immediately」+ 新增断言 | 保持通过；且 `views/_coordinator/diagnostics.jsonl` 出现 `coordinator_lease_unavailable`，details 键集 = `{reason, ownerPid, hasIdentity, lockAgeMs, heartbeatAgeMs, heartbeatMs}` |
| A12 | 类型与静态检查 | 自动化（static） | `npm run typecheck` | 无错误 |
| A13 | 全量回归 + 覆盖率门槛 | 自动化（build） | `npm run verify` | 全绿，coverage 门槛不降 |
| U1 | Windows 真实环境：复用 pid 的陈旧租约无需人工 `mv` 即自愈 | 用户实测 | **前置**：PR 已合并并发布，本机 `git pull` 到含本次 fix 的版本，重载 Pi（确认 `runner/state-coordinator.mjs` 含 `lease_reclaimed`）且 `jfox`-无关的旧 coordinator 进程已退出。步骤：① 停掉 coordinator；② 把 `views/_coordinator/state-coordinator.lock/owner.json` 改写为 `{"token":"x","pid":<任一存活无关进程pid>,"identity":{"pid":…,"startToken":null},"startedAt":<48h前>}`，并写 `heartbeat.x={"at":<24h前>}`；③ 在面板触发任一状态操作；④ 等 ≤60s 再触发一次 | 面板不再报 `coordinator_unavailable`；`state.json` 的 `materializedRevision` 变为非 null；`views/_coordinator/diagnostics.jsonl` 出现 `lease_reclaimed` |
| U2 | 心跳失效自终止不误伤正常路径 | 用户实测 | **前置**：同 U1（含 fix 的构建 + Pi 重载）。步骤：正常使用 10 分钟，期间观察 `views/_coordinator/diagnostics.jsonl` 与 coordinator pid | 无 `coordinator_heartbeat_lost`；coordinator pid 不变 |

## 6. 可测性拆分设计

| 单元 | 形态 | 测试边界 |
|---|---|---|
| `classifyLeaseOwner(owner, now, isProcessDead, opts)` | 纯函数，无 I/O | 新增 opts 字段全部以字面量注入；A3/A4/A5 在此层验证 |
| `readLeaseHeartbeat(lockPath, token, fs)` | 薄 I/O 壳（`fs` 可注入，沿用 `defaultLeaseFs` 模式） | A6 用假 fs 验证三种读失败；真实 fs 仅在 A1 由 `tryAcquireOwnedViewLock` 覆盖 |
| `reclaimOrBlock` → `attemptAcquireLease` | 内部，经 `tryAcquireOwnedViewLock` 观察 | A1/A2/A7 用真实临时目录（自包含 fixture，不碰宿主仓） |
| `describeLeaseConflict(root, viewId, name, opts)` | 读文件的摘要函数（`fs`/`clock` 可注入） | A8 |
| `heartbeatFailureAction(consecutive, max)` | 纯函数（`locks.mjs` 导出，与 `classifyLeaseOwner` 同层） | A9 |
| coordinator 让位接线（计数 → 诊断(try/catch) → shutdown(0)） | 脚本 shell；seam = 三个 `AGENT_BOARD_TEST_*` 旋钮（经 `process.env` 注入，`startCoordinator` 继承） | A14（成功路径）、A14b（诊断写失败的失败分支） |

原则：能满足验收的最低层级优先（`unit` > `integration`）；跨进程/跨文件交互（真实的
"新 coordinator 抢占并恢复写入"）必须走 `integration`；Windows 专属语义不进 CI 覆盖范围
（CI 仅 `ubuntu-latest`），Windows 行为的正确性由「平台无关的纯判定 + 夹具形态」承载，实机由 U1 兜底。

## 7. 部署与执行路径真实性

- 改动位于 `src/core/locks.mjs`（被 dashboard 与两个 runner 共同引用）与 `runner/state-coordinator.mjs`。
- 生效路径：扩展更新 → Pi 重载 → 下次 `ensureCoordinator` 拉起的新 coordinator 进程即带新代码。
  **已卡死的实例无需重启面板**：卡死的是锁文件，不是 dashboard；新 spawn 的 coordinator 会自行回收。
- 存量锁（无 `heartbeatMs`）由 D2 的「存量自愈」路径覆盖，无需人工 `mv`（U1 验证）。
- 打包面无新增**运行时**产物；`npm run pack:dry` 会多出一个 `docs/superpowers/specs/…-design.md`（`package.json` 的 `files` 含 `docs/`，文档非运行时文件，不算回归）。
- **不新增生产行为开关**（门限仅经 opts 注入）。新增三个**测试专用** `AGENT_BOARD_TEST_*` 旋钮
  （`AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS`、`AGENT_BOARD_TEST_FORCE_TOUCH_FAILURE`、
  `AGENT_BOARD_TEST_FAIL_DIAGNOSTIC`），沿用 `src/core/test-knobs.mjs` 既有模式；未设置时生产行为字节一致。

## 8. 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | 磁盘故障使健康持有者心跳停滞 → 被抢占 → 双写 | **coordinator**：D4 连续 3 次失败即自终止并让位，门限 60s 远大于 3s；**host-start 租约**：无自终止（非目标），其兜底是 R2 的 instance 校验（`shouldYieldRunner` / `owner_lost`）。两者边界不得混用 |
| R2 | `host-start` 租约锁龄≥5min 且心跳停滞时被回收（boot 卡死场景） | boot 事务正常为秒级；卡死 5min 时回收优于永久占锁；`host.json` 写入前有 instance 校验（`shouldYieldRunner` / `owner_lost`） |
| R3 | 并发两个 dashboard 各 spawn 一个 coordinator，在 boot 窗口互相判定陈旧 | D5 门限 60s + boot 阶段边界 touch；且 `ensureCoordinator` 先探端点，端点未绑定时窗口 << 60s；回收仍需通过 quarantine token 校验 |
| R4 | 时钟回拨导致 `heartbeatAgeMs` 异常大 | 门限判定用 `max(0, now-at)`；回拨幅度远小于 60s 且不影响「pid 确死」路径 |
| R5 | 诊断目录新增文件影响既有读取 | `_coordinator` 不被 `pruneScreenLogs` 删除（无 meta.json → foreign skip），不被视图扫描当普通 view（`readState` 按 viewId 定点读） |

## 9. 变更文件清单（预估）

| 文件 | 变更 |
|---|---|
| `src/core/locks.mjs` | `LEASE_HEARTBEAT_STALE_MS`、`MAX_CONSECUTIVE_TOUCH_FAILURES`、`readLeaseHeartbeat`、`classifyLeaseOwner` opts 扩展 + **两个分支都先判心跳**（显式声明绕过 age 早退，见 D1 伪代码）、回收判定、`lease.reclaimed`、`describeLeaseConflict`、`heartbeatFailureAction`；**`attemptAcquireLease` 接受 `opts.heartbeatMs` 并写入 `owner.json`**（新 seam，D2 显式声明路径的前提） |
| `runner/state-coordinator.mjs` | 传 `heartbeatMs: HEARTBEAT_MS`（心跳周期经 `resolveTestMs(env, "AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS", HEARTBEAT_MS)`）；boot 边界 touch（不计数）；**监督定时器在 `server.listen` 成功后启动**；interval touch 失败 → `heartbeatFailureAction` → **先** try/catch 写诊断 → **后** `shutdown(0)`；`AGENT_BOARD_TEST_FORCE_TOUCH_FAILURE` / `AGENT_BOARD_TEST_FAIL_DIAGNOSTIC` seam；抢锁失败写 `coordinator_lease_unavailable`（details = `describeLeaseConflict` 六字段）；成功后 `lease.reclaimed` → `lease_reclaimed` |
| `test/locks.test.mjs` | A1、A1b、A1c、A2–A9（含 A3/A3b/A5 的两组与两层断言、A9b） |
| `test/state-coordinator.integration.test.mjs` | A10、A11（含新增诊断断言）、A14、A14b |
| `docs/superpowers/specs/2026-10-23-lease-heartbeat-staleness-design.md` | 本 spec（进 worktree，首个 commit） |
