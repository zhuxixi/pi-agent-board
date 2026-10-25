Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-25T10:40:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-25T10:52:00+08:00 · 依据 R1 复核（R1-G1 全接受：重写 §1.4 租约形态两条路径、D4 收缩为 wait-for-exit、删除客户端租约回收；R1-G2 全接受：D6 改为记录侧表述；R1-G3 全接受：U1 拆 U1a/U1b 并补前置与人工恢复；R1-G4 全接受：probe null 分支重定义；R1-G5 全接受：撤掉 scope 4 与 releaseLeaseWithToken；R1-G6 全接受：诊断去重；R1-D1…D6 全部接受）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-25T11:02:00+08:00 · 依据 R2 复核（R2-G1 接受：§1.4 表按平台拆分、§9.4 平台归因改正；R2-G2 接受：U1 收缩为隔离 root 脚本化演示、删除不可复现的 U1b；R2-D1 补 A3i/A3j；R2-D2 明确 try/catch 层级；R2-D3 补 A3k；R2-D4 U1 触发/观察/恢复步骤重写；R2-D5 A10 去掉耗时后缀、A11 口径统一；R2-D6 在 D2 明示 J3 对 issue 建议 2 的偏离）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-25T11:17:00+08:00 · 依据 R3 复核（R3-G1 接受：§9.3 重写为生产恢复流程——定位 endpoint 服务者而非租约 pid、删锁目录前必须停 coordinator；R3-G2 接受：§7 删除相对 runnerScript 覆盖、脚本改绝对 import + --recover 入口 + root 显式参数；R3-D1 接受：D6 改 async 并新增 A7b 真实接线验收；R3-D2 接受：A3h 删 ensureCoordinator 子句；R3-D4 接受：删 pre-#112 措辞、N5 限定为本设计产生的 pid 死场景；R3-D5 接受：头部状态、脚本更名 verify-u1-legacy-no-kill、U1a 引用清理）

Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-25T11:33:00+08:00 · 依据 R4（cap 轮，收敛）5 条细化（R4-D1 kill try/catch 与 A3l；R4-D2 §9.3 c/d/e 可执行化；R4-D3 POSIX 改 `ps -e -ww -o pid=,args=`；R4-D4 §7 执行现场/自检/--recover 残留；R4-D5 `currentStartToken` 非字符串归一为 identity_unverified）

仓库：zhuxixi/pi-agent-board · issue：#239 · 基线：`main` @ 41e3e31 · 状态：**已收敛（第 4 轮 0 真缺口），待用户确认设计**

---

# 设计：身份校验的 coordinator 替换（issue #239）

## 1. 根因（Phase 1 证据链）

### 1.1 判据分离

```
probeOnce(endpoint) → { instanceId, protocolVersion }        src/core/coordinator-client.mjs:195
  protocolVersion < 当前 → replaceStaleCoordinator(root, socketPath)          :197-198
    readCoordinatorLeasePid(root) → owner.json.pid                           :126-135  ← 信号目标
    process.kill(pid, "SIGTERM")                                             :154      ← 无身份校验
```

「陈旧」的证据来自 endpoint 的 pong；「杀谁」的依据来自 lease 文件的 pid。代码从不验证 lease owner 与 endpoint 服务者是同一个实例。

### 1.2 触发条件（三者同时成立）

1. 一个 live coordinator 以旧协议应答 ping（升级窗口）；
2. lease 记录的 owner 与 endpoint 服务者不同（lease 被 #224 心跳回收后残留旧记录，或记录 stale）；
3. 记录里的 pid 已被无关进程复用。

Windows 上 pid 复用是常规事件；#224 现场记录到 `svchost.exe` 占用记录 pid（不可杀，未出事）。同样的记录若碰撞到用户进程即被误杀。

### 1.3 根因

**信号发送缺少「lease owner == endpoint server」的同一性证明。** 修法：lease 记录 coordinator 的 `instanceId`（进程内唯一、只经 pong 外露），用刚探测到的 pong 值比对，相等才发信号。

### 1.4 平台事实与替换可靠性（修订：v1 的「必然失败」结论错误）

**实测（本机 Windows 11，2026-10-25，脚本 `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-239/research/probe-win32-sigterm.mjs`）：**

```json
{"platform":"win32","sigtermMs":1502,"handlerRan":false,"exitedEvent":true,"pidAliveAfter":false}
```

win32 上 `process.kill(pid, "SIGTERM")` 是 TerminateProcess：目标进程的 `process.on("SIGTERM")` handler **不执行**。旧 coordinator 因此不会走 `shutdown()`（`runner/state-coordinator.mjs:404-419`），不 release lease、不 unlink endpoint。

**但这不等于「替换必然失败」**——能否接管取决于残留租约的形态，而租约形态由旧 coordinator 的构建版本决定：

| 形态 | 平台 | 何时出现 | lease 特征 | pid 已死后新实例能否接管 |
|---|---|---|---|---|
| pre-#224 | linux | 协议 <3 的 coordinator 必然早于 #151（引入 v3），#224（`20b0323`）又晚于 #151 | 无 `heartbeatMs`、无 heartbeat 文件；`startToken` **非空**（自 #91 `b022a7b` 起 coordinator 租约就写 `identity.startToken`，`runner/state-coordinator.mjs:229`） | identity 分支：`locks.mjs:325-327` pid 死 → 立即 reclaim |
| pre-#224 | win32/darwin | 同上 | 无 `heartbeatMs`；`startToken` **恒 null**（`captureStartToken` 仅 linux，`pid.mjs:55-66`） | identity-less：`lockAge≥5min` 且 pid 死 → reclaim（`:329-331`）；`lockAge<5min` → blocked |
| post-#224 | 全部 | 本版本之后的 coordinator | 声明 `heartbeatMs` | pid 死 → 立即 reclaim（declared 分支只加「心跳超龄」这条额外路径，不遮蔽 `:325-331` 的死 pid 路径） |

因此真实缺陷只有两处：

- **(a) win32 替换等待失效**：endpoint 是命名管道（`paths.mjs:120-139`），`!existsSync(socketPath)`（`:156-160`）恒 true → 发完 SIGTERM 立即返回成功，不等旧进程退出。新实例可能在旧进程尚未完全退出时抢锁（`waitMs: 500`）失败 → `exit(0)`；`launchCoordinator` 不会二次 spawn → 10s 后 `coordinator_unavailable`。这是替换可靠性缺陷，与身份校验同函数、同路径，本设计用 **wait-for-exit** 收口。
- **(b) 年轻 pre-#224 legacy 残留租约**：受 5min 门限制。可达性分析：win32 上此类记录无 `instanceId`、无 `startToken` → 判定停在 J6、**不会走到 kill**；Linux 上经 J3 可 kill，但 POSIX SIGTERM handler 会自行 `lease.release()`；若进程卡住，等待超时 → skip 不 spawn。故 (b) 不可达，**不需要客户端主动回收租约**（v1 的 D4 已删除）。

## 2. 范围

**做**

1. coordinator 在租约记录 `identity.instanceId`（与 pong 同值）。
2. 客户端读租约记录 → 纯函数判定 → 仅在同一性可证时发信号。
3. 发信号前双重实时确认（重 ping endpoint + 重读租约），关 TOCTOU。
4. 发信号后等待旧进程退出（≤3s）再继续 spawn，消除 §1.4(a) 的竞态。
5. 跳过信号时写**去重**诊断 `coordinator_replacement_skipped`（含原因）。
6. Linux legacy 记录（无 instanceId）用实时 `/proc` startToken 兜底，保住升级路径。
7. 单元 + 集成测试覆盖判定分支与平台语义（注入式）。

**不做（显式非目标）**

| # | 非目标 | 理由 |
|---|---|---|
| N1 | `locks.mjs classifyLeaseOwner` 的 token 比对 | #238 N1 保持：锁获取全同步，win32 probe ~390ms |
| N2 | 租约 identity 写 win32 `ct:` token | #238 N2 保持：`hasIdentity` 会切换租约分支；且 #224 后已无收益 |
| N3 | 协议版本 bump / 主动重启存量 coordinator | 迁移策略另议；本 issue 不改变协议 |
| N4 | SIGTERM 超时后升级为 SIGKILL | 超时即放弃（安全方向）；不可杀进程由人工处理 |
| N5 | 客户端主动回收残留租约（v1 的 scope 4） | 新实例既有 reclaim 覆盖**本设计产生的** pid 死场景（J1 的 declared 形态、J3 的 Linux identity 形态，§1.4 表）；客户端回收需 quarantine 语义；win32/darwin 的 pre-#224 残留不由本设计产生（J6 止步），由既有 #112/#224 语义处理（§9 第 4 条） |
| N6 | 诊断的 UI 呈现 | 只保证 JSONL 留痕；消费端不在本 issue |
| N7 | `launchCoordinator` 二次 spawn 重试 | wait-for-exit 消除触发条件；残留失败由 §8 明示 |

## 3. 设计决策

### D1 — 身份字段：`identity.instanceId`

coordinator 获取租约时把 `instanceId` 写进透传的 `identity` 对象：

```js
// runner/state-coordinator.mjs:227-231
lease = acquireOwnedViewLock(root, "_coordinator", "state-coordinator", {
  waitMs: 500,
  identity: { pid: process.pid, startToken: captureStartToken(process.pid), instanceId },
  heartbeatMs,
});
```

- `identity` 由 `locks.mjs:255-263` 原样序列化，**锁层零改动**；`classifyLeaseOwner` 只读 `identity.pid`/`identity.startToken`（`:304-305`）→ 租约判定行为不变（R1-P1 已核对无形状断言冲突）。
- 旧 reader 忽略未知字段；旧记录（无该字段）落 legacy 分支。
- 读取侧兼容 `owner?.identity?.instanceId ?? owner?.instanceId`（首个非空字符串），为未来顶层字段留路径。

### D2 — 判定纯函数 `judgeReplacementTarget`

```js
/**
 * @param {{ recorded: LeaseRecord|null, probedInstanceId: string,
 *           currentStartToken?: string|null }} args
 * @returns {{ action: "signal" } | { action: "skip", reason: SkipReason }}
 */
```

| # | recorded.instanceId | recorded.startToken | currentStartToken | 输出 | 依据 |
|---|---|---|---|---|---|
| J1 | == probed | any | not read | `signal` | 同一实例，正常升级替换 |
| J2 | ≠ probed（字符串） | any | not read | `skip("lease_owner_mismatch")` | lease 属于另一个实例 |
| J3 | 缺失 | 字符串 | == recorded | `signal` | legacy Linux：pid 实时 token 证明同一进程 |
| J4 | 缺失 | 字符串 | ≠ recorded | `skip("pid_reused")` | pid 已被复用 |
| J5 | 缺失 | 字符串 | null（读失败） | `skip("identity_unverified")` | 读不到 ≠ 可以杀 |
| J6 | 缺失 | null/缺失（win32/darwin **记录侧**） | not read | `skip("identity_unverified")` | issue 建议 2：宁可「不能替换」 |
| J7 | 记录不可读（null/畸形） | — | not read | `skip("lease_unreadable")` | 无证据不杀 |

边界：`instanceId`/`startToken` 必须是非空字符串才参与比对；`recorded.pid` 取 `Number(identity.pid ?? pid)`，非正数 → `lease_unreadable`。**`currentStartToken` 非 string 且非 null（含漏 await 的 Promise）→ `skip("identity_unverified")`，不落 `pid_reused`**（T1 覆盖该输入）。纯函数不读盘、不发信号、不看平台。

**与 issue 建议 2 的偏离（明示，R2-D6）**：issue 原文建议「legacy 记录（无 recorded instanceId）一律不发信号，报告 `coordinator_stale_protocol`」。本设计对 **Linux 的 legacy 记录**保留 J3 例外：实时 `/proc` startToken 与记录相等，仍是「同一性可证」的证明（强度等价于 instanceId），且 D3 还会二次确认；win32/darwin 因记录侧无 token，严格按建议 2 一律 skip（J6）。该偏离在 issue 的复核评论中已列为待确认的设计决定，不在实现阶段悄悄放宽。

### D3 — 发信号前的双重实时确认（关 TOCTOU）

判定后、`kill` 前：

1. **重探 endpoint**（复用 `probeOnce`，注入同一 `connect`/`probeTimeoutMs`）：
   - pong 且 `instanceId === expectedInstanceId` → 旧实例仍在服务（活进程的 pid 不会被复用）→ 继续第 2 步；
   - pong 且 `instanceId !== expectedInstanceId`：该实例 `protocolVersion >= 当前` → 返回 `replaced: true`（健康实例已接管，继续 spawn 流程）；否则 `skip("replacement_raced")`；
   - `null`（1s 内没有合法 pong —— **不能断言进程已消失**）→ 重读租约：
     - 不可读 → `skip("lease_unreadable")`；
     - `isAlive(recorded.pid) === false` → 返回 `replaced: true`（owner 已死，新实例将按既有 reclaim 接管）；
     - `isAlive(...) === true` → `skip("instance_unresponsive")`（慢而活的旧实例，绝不 spawn 空转）。
2. **重读租约**：`token` 或 `instanceId` 与判定时不同 → `skip("lease_changed")`。

只有两步都通过才 `process.kill(pid, "SIGTERM")`。

### D4 — 发信号后等待旧进程退出（替代 v1 的租约回收）

```
kill(pid, SIGTERM)
  → 轮询 isAlive(pid)（50ms tick，预算 REPLACE_TIMEOUT_MS = 3_000）
     ├─ 超时 → skip("replace_timeout")，不 spawn（旧进程可能仍持有租约）
     └─ 已退出 → replaced: true → ensureCoordinator 继续 launchCoordinator
```

**不调用任何释放/删除租约的 API。** 残留租约交给新实例的既有 #224 reclaim（pid 死 → 立即回收；§1.4 表）。这样避免在客户端引入与仓库 quarantine 不变量冲突的 check-then-act 原语（R1-G5）。

`kill` **必须包 try/catch**，异常统一进入 wait-for-exit（它是这段代码里唯一未收口的系统调用，逃逸会违反 never-throws）：

- `ESRCH`（目标在 D3 二次确认后、kill 前退出）→ 视为已退出 → `replaced: true`；
- `EPERM`/其它 → 目标仍可能存活 → 不视为替换成功，走 wait-for-exit，超时即 `skip("replace_timeout")`（fail-closed）。

### D5 — 结果契约与去重诊断

```js
/** @typedef {{ replaced: true } | { replaced: false, reason: SkipReason }} ReplaceOutcome */
/** @typedef {"lease_unreadable"|"lease_owner_mismatch"|"pid_reused"|"identity_unverified"|"lease_changed"|"instance_unresponsive"|"replacement_raced"|"replace_timeout"} SkipReason */
```

- `ensureCoordinator` 对外结果**形状不变**（`{ok:false, error:"coordinator_stale_protocol"}`；`test/coordinator-client.test.mjs:409` 的 deepEqual 继续成立）；`reason` 只进诊断。
- 跳过信号时写诊断，**两层去重**（R1-G6 / R2-D2 / R2-D3）：
  1. 模块级 `Set`（key = `${root}|${reason}|${recordedInstanceId}|${probedInstanceId}`）先挡：命中即返回，**不触盘**——`appendDiagnosticOnce` 的 tail 读取走 `readJsonlTail`，而后者会整文件读取（`atomic.mjs:151-155`），不能放在 `sendStateCommand` 每次 ensure 的热路径上；
  2. Set miss（每进程每种状态首次）才调 `appendDiagnosticOnce(root, "_coordinator", patch, { match: ["reason","recordedInstanceId","probedInstanceId"] })`（`diagnostics.mjs:29-41`）做跨进程去重。
- 默认 `reportSkip` 内部 `try/catch` 吞掉一切错误（含 `existsSync(root)` 与 append 异常）；`replaceStaleCoordinator` 在调用 `reportSkip` 的调用点再包一层 try/catch。**`ensureCoordinator` 不 catch**——它依赖这两层保证 never-throws（`sendStateCommand` 对 ensure 无 try/catch，模块契约见 `coordinator-client.mjs:216-218`）。
- **写前 `existsSync(root)`**：`appendJsonl` 会 ensureDir 父目录，root 已删时写诊断会重建目录链（#241 同类残留）。
- details 不含 lease token（`recordedInstanceId` 缺失时写 null）。

### D6 — legacy Linux 兜底（记录侧表述，R1-G2 修正）

租约的 `identity.startToken` 由 `captureStartToken`（`src/core/pid.mjs:55-66`）写入，**仅 linux 非空**；win32/darwin 记录为 `null`。所以：

- legacy 记录在 win32/darwin 上无法验证（J6），这与 `readProcessStartToken` 无关——后者在 win32 上其实可用（返回 `ct:<ms>`，`process-identity-probe.mjs:67-70`），但 #238 N2 决定不把该 token 写进协调器租约，故本路径用不上。
- Linux 上 J3 用 `await readProcessStartToken(pid)`（`:61`，**async**；Linux 分支内部委托同步 `captureStartToken` 读 `/proc`，成本为零）实时读取并与记录比对。D2 的 `currentStartToken` 是 await 之后的字符串；漏掉 await 会让 Promise 与字符串不等——按 D2 边界归一为 `skip("identity_unverified")`（不是 `pid_reused`），因此除 T3/A3a 的注入桩外必须有真实接线验收（A7b，Linux CI）。
- **为什么 legacy 是主路径**：协议当前为 3；升级到本版本不 bump 协议 → 旧 coordinator 继续服务；只有未来协议 bump 才触发替换，那时的租约记录是本版本之前写的（无 `instanceId`）。Linux 靠 J3 保持升级无感；win32/darwin 停在 `coordinator_stale_protocol` + `identity_unverified` 诊断，需人工恢复（§9 第 3 条；不是「心跳超龄自愈」——活着的旧 coordinator 持续 touch，租约不会自行过期，`ensureCoordinator` 也不会替它 spawn）。

## 4. 接口契约（文件级）

| 文件 | 符号 | 变化 |
|---|---|---|
| `src/core/coordinator-client.mjs` | `readCoordinatorLeaseRecord(root)` | **新增并导出**（供 A2 直接单测）；返回 `{token, pid, instanceId, startToken} \| null`；替换私有 `readCoordinatorLeasePid` |
| 同上 | `judgeReplacementTarget(args)` | **新增并导出**纯函数 |
| 同上 | `replaceStaleCoordinator(root, socketPath, expectedInstanceId, opts)` | **导出**（供 A3）；签名扩展；返回 `ReplaceOutcome`；`opts` 全部可注入，默认值：`probe`=`probeOnce`、`readLease`=`readCoordinatorLeaseRecord`、`kill`=`process.kill`、`isAlive`=`pid.mjs` 的 `isAlive`、`readStartToken`=`readProcessStartToken`（**async，J3 路径必须 await**）、`clock`=`Date.now`、`sleep`=可取消的 setTimeout promise、`replaceTimeoutMs`=3000、`reportSkip`=D5 默认实现 |
| 同上 | `ensureCoordinator` | 传 `first.instanceId` 与 `connect`/`probeTimeoutMs`；按 `ReplaceOutcome.replaced` 决定继续/返回 `coordinator_stale_protocol` |
| `runner/state-coordinator.mjs` | `main()` 租约获取 | `identity` 增加 `instanceId` |
| `test/coordinator-client.test.mjs` | `STALE_COORDINATOR_CJS` | owner.json 增 `identity.instanceId`（与 pong 同值）；新增反向 fixture（不匹配 / 缺失） |
| `test/locks.test.mjs` | — | 无（不新增锁原语） |

**测试边界（可测性拆分设计，编号供 plan 引用）**

| ID | 拆分点 | 形态 | 测试边界 |
|---|---|---|---|
| T1 | `judgeReplacementTarget` | **纯函数** | 单测 J1-J7 + 边界（空串/非字符串/非正 pid/缺失字段）：不触盘、不注入平台 |
| T2 | `readCoordinatorLeaseRecord` | I/O（纯读） | 单测：文件缺失、坏 JSON、`identity:null`、legacy 记录、instanceId 非字符串、顶层 `instanceId` 兼容 |
| T3 | `replaceStaleCoordinator` | I/O 编排（全注入） | 单测：注入 `probe`/`readLease`/`kill`/`isAlive`/`readStartToken`/`clock`/`sleep`/`reportSkip`；断言 kill 调用次数、`ReplaceOutcome`、诊断调用 |
| T4 | 记录侧接线 | integration（真实 spawn） | 真实 coordinator 的 owner.json：`identity.instanceId` 存在且 == pong.instanceId |
| T5 | 真实替换链路 | integration（真实子进程 fixture） | 匹配 → 被杀 + 替换 + `state_command applied`；不匹配 → 无关进程存活 + `stale_protocol` + 诊断 |
| T6 | 诊断去重 | unit（`ensureCoordinator` 级） | 同一 stale 状态下连续 N 次调用 → 诊断条数 ≤1 |

## 5. 数据流

```
写入侧（coordinator 启动）
  instanceId = randomBytes(8).hex          state-coordinator.mjs:198
  lease = acquireOwnedViewLock(... identity: {pid, startToken, instanceId}, heartbeatMs)
    → owner.json 落盘（locks.mjs 原样序列化）
  pong = { instanceId, startedAt, protocolVersion }        :431

替换侧（客户端 ensureCoordinator）
  probeOnce → first {instanceId, protocolVersion<当前}
    replaceStaleCoordinator(root, socket, first.instanceId, {connect, probeTimeoutMs})
      readCoordinatorLeaseRecord ──┐
      judgeReplacementTarget ──────┤ J1-J7
      probeOnce（再确认）──────────┤ D3：null → 租约+isAlive 判定
      readCoordinatorLeaseRecord ──┘     不同 → replacement_raced / instance_unresponsive
        └ signal: kill(SIGTERM) → waitExit(≤3s) → replaced:true
             skip:   reportSkip（Set + appendDiagnosticOnce 去重）
  replaced=true → launchCoordinator → 轮询 pong（既有逻辑；新实例按 #224 reclaim 处理残留租约）
  replaced=false → { ok:false, error:"coordinator_stale_protocol" }
```

## 6. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | 判定表 J1-J7 + 边界 | 自动化（unit，T1） | `node --test test/coordinator-client.test.mjs` | 7 分支 + 空串/非字符串/非正 pid 命中预期 action/reason |
| A2 | 租约记录解析 | 自动化（unit，T2） | 同上 | 缺失/坏 JSON/`identity:null`/legacy/非字符串/顶层 instanceId → 正确 `null` 或字段 |
| A3a | J1/J3 命中 → 发信号 | 自动化（unit，T3） | 注入桩：`kill` 调用一次、返回 `replaced:true` | kill 恰好一次，目标 pid 正确 |
| A3b | J2/J4/J5/J6/J7 → 不发信号 | 自动化（unit，T3） | 注入桩 | `kill` 0 次；`replaced:false` + 对应 reason |
| A3c | 重 ping null + pid 已死 | 自动化（unit，T3） | `probe` 第二次返回 null、`isAlive` false | 不 kill；`replaced:true` |
| A3d | 重 ping null + pid 仍活 | 自动化（unit，T3） | `probe` null、`isAlive` true | 不 kill；`skip("instance_unresponsive")` |
| A3e | 重 ping 返回另一旧协议实例 | 自动化（unit，T3） | 第二次 probe `instanceId` 不同且 version < 当前 | 不 kill；`skip("replacement_raced")` |
| A3f | 二次读租约变化 | 自动化（unit，T3） | `readLease` 第二次返回不同 token | 不 kill；`skip("lease_changed")` |
| A3g | 旧进程不退出 | 自动化（unit，T3） | `isAlive` 恒 true、注入 clock/sleep | kill 一次；`skip("replace_timeout")` |
| A3h | 诊断写失败不影响结果 | 自动化（unit，T3） | 注入抛错的 `reportSkip` | `replaceStaleCoordinator` 返回同一 `ReplaceOutcome` 且不抛（不设 ensure 级断言：`ensureCoordinator` 没有 reportSkip 注入点，never-throws 由 D5 的调用点 catch + reportSkip 自身 catch 保证） |
| A3i | 重 ping 返回另一**健康**实例 | 自动化（unit，T3） | 第二次 probe `instanceId` 不同且 `protocolVersion >= 当前` | 不 kill；`replaced:true`（ensure 继续 launch，不返回 stale_protocol） |
| A3j | 重 ping null + 二次租约不可读 | 自动化（unit，T3） | `probe` 第二次 null、`readLease` 第二次 null | 不 kill；`skip("lease_unreadable")` |
| A3k | root 已删时不重建目录 | 自动化（unit，T3） | 注入 `probe` null、`readLease` 一条记录、`isAlive` true；调用前 `rmSync(root)` | 调用后 `existsSync(root) === false`（未写诊断）；`skip("instance_unresponsive")` |
| A3l | kill 抛错不改变结果 | 自动化（unit，T3） | 注入抛 `ESRCH` 的 `kill` → 期望 `replaced:true`；注入抛 `EPERM` 的 `kill` + `isAlive` true | ESRCH：不抛、`replaced:true`；EPERM：不抛、`skip("replace_timeout")` |
| A4 | 记录侧 instanceId | 自动化（integration，T4） | 真实 spawn 用例 | owner.json `identity.instanceId` 非空且 == pong.instanceId |
| A5 | 匹配替换端到端 | 自动化（integration，T5） | stale-v1 fixture（owner.json 带匹配 instanceId） | 旧进程退出；新实例接管；`sendStateCommand` → `applied` |
| A6 | **不匹配不杀（核心）** | 自动化（integration，T5） | fixture 记录不匹配 instanceId，lease pid 指向无关存活进程 | 无关进程 `isAlive === true`；返回 `stale_protocol`；诊断 `reason:"lease_owner_mismatch"` |
| A7 | legacy 记录不杀 | 自动化（integration，T5） | fixture 无 instanceId、`startToken:null`（平台无关的记录侧形态） | 旧进程存活；`stale_protocol`；诊断 `reason:"identity_unverified"` |
| A7b | J3 真实接线（Linux） | 自动化（integration，ubuntu） | fixture 写入 spawn 子进程的**实时** `captureStartToken(child.pid)`（非注入），owner.json 无 instanceId；pong 报任意 instanceId；调用 `ensureCoordinator` | 子进程收到 SIGTERM 并退出；新实例接管；`sendStateCommand` → `applied`；win32/darwin 跳过（记录侧 startToken 恒 null） |
| A8 | 诊断去重 | 自动化（unit，T6） | 同一 stale 状态下连续 5 次 `ensureCoordinator` | 诊断条数 ≤1（`readDiagnostics` 统计 code） |
| A9 | CI 完成门槛 | 自动化（static/build） | **CI（ubuntu-latest）**：`npm run verify`（typecheck + test:perf + test + coverage + pack:dry；`.github/workflows/ci.yml:31-44`） | 五步全绿，含 c8 门槛 lines 85 / funcs 80 / branches 70 |
| A10 | 本机 Windows 回归对照 | 自动化（build/test，本机） | `npm test *> after.log`；提取 `^✖ ` 行 → 剥去结尾耗时 ` ([\d.]+ms)` → 按失败测试名集合比较（含子测试行） | `after` 集合 ⊆ `baseline` 集合（基线：1375 tests / 62 fail / 125 ✖ 行，来源 `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-239/research/baseline-failures.txt`） |
| A11 | 相关文件本机全绿 | 自动化（build/test，本机 win32） | `node --test test/coordinator-client.test.mjs test/locks.test.mjs test/state-coordinator.integration.test.mjs` | 三文件全绿（基线均 0 失败；后两个无改动，作为租约写入面回归） |
| U1 | legacy 不误杀（隔离 root 脚本化实测） | 用户实测 | 见 §7；脚本由实现任务产出到 `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-239/research/verify-u1-legacy-no-kill.mjs`（`--root <隔离路径>` 必填；`--recover` 演示恢复） | 输出 `stale_protocol`；无关进程存活；诊断 `coordinator_replacement_skipped` 且 `reason=identity_unverified`；重复运行不新增诊断；`--recover` 后 `outcome.ok === true`（新 coordinator 接管） |

**U1 为什么不能自动化**：真实的「历史版本 detached coordinator 跨越安装升级」需要装旧版本包并保留其进程，CI 无法稳定复现；可自动化的等价语义已由 A5-A7（真实子进程 fixture + 注入）覆盖。U1 用隔离 root 复现同一代码路径（见 §7），不覆盖跨版本安装现场（§9 第 8 条）。

## 7. U1 详细步骤（隔离 root + 可执行脚本）

**为什么必须用隔离 root**：默认 root（`~/.pi/agent/agent-board`，README.md:284/:288）在正常使用后必然存在一个 protocol 3 的活 coordinator；`ensureCoordinator` 第一次 probe 拿到 `version >= 当前` 就直接返回 ok（`coordinator-client.mjs:196-197`），**根本不会进入替换路径**——在默认 root 上做 U1 会假通过。若为造场景覆盖默认 root 的 `owner.json`，在跑的 coordinator 会因 `lease.touch()` 的 `stillOwns()` 变 false 而失败、3 次后自退（`locks.mjs:487-493`、`state-coordinator.mjs:377-392`），污染真实 board。故 U1 一律用隔离 root。

**前置**：
- **执行现场**：实现 worktree `$WT=C:\Users\27499\proj\opensource\pi-agent-board\.pi\worktrees\issue-239-replace-stale-coordinator-identity`（合并前）；或合并后的 `main`（先 `git pull` 到合并版本）。脚本 import 必须锚定该 checkout 的绝对 file URL（`$WT/src/core/coordinator-client.mjs`）——跑旧 checkout 会走未修复的 `replaceStaleCoordinator`（直接 SIGTERM 租约 pid），四个通过标准全挂，看起来像修复无效。
- **运行前自检**：`git -C <checkout> log -1 --oneline` + `Select-String -Path <checkout>\src\core\coordinator-client.mjs -Pattern judgeReplacementTarget`（应命中）。
- 隔离 root：`$env:TEMP\ab-u1-239`（脚本用 `--root` 显式传入；`AGENT_BOARD_ROOT` 只影响 `paths.defaultRoot()`，`ensureCoordinator` 本身不读它）。
- 脚本：`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-239/research/verify-u1-legacy-no-kill.mjs`（实现任务产出；复用 `test/coordinator-client.test.mjs:300-328` 的 `STALE_COORDINATOR_CJS` 形态）。
- win32 端点公式（脚本内置）：`\\.\pipe\agent-board-coordinator-<sha256(path.win32.resolve(root)).slice(0,16)>`（`paths.mjs:120-136`）。
- 路径：租约 `<root>/views/_coordinator/state-coordinator.lock/owner.json`；诊断 `<root>/views/_coordinator/diagnostics.jsonl`；观察进程 `Get-Process -Id <pid> -ErrorAction SilentlyContinue`。

**脚本做的事**（用户只需运行，不需要手工造 owner.json）：
1. 解析 `--root <隔离路径>`（**必填**；`ensureCoordinator` 只接受显式 root，不读 `AGENT_BOARD_ROOT`）；以**绝对 file URL** import 实现 checkout 的 `src/core/coordinator-client.mjs`（脚本位于 research/，不在仓库内）；
2. 在隔离 root 建一个 view 行（`createView`）；
3. `spawn` 一个**无关**的 `node -e "setInterval(()=>{},1000)"` 进程并存下 pid；
4. 写 legacy `owner.json`：`{token:"u1", pid:<无关进程 pid>, identity:{pid:<同一 pid>, startToken:null}, startedAt:Date.now()}`（**无 `instanceId`**）；
5. 起旧协议监听端并绑定 `P.coordinatorEndpointPathFor(process.platform, root)`，pong 回 `{type:"pong", instanceId:"stale-v1", startedAt:1}`（无 `protocolVersion`）；
6. 调 `ensureCoordinator(root)`（**不传 `runnerScript`**：默认 `COORDINATOR_SCRIPT` 已是绝对路径，`coordinator-client.mjs:34-36`；传相对路径会因 `launchCoordinator` 以 `cwd=dirname(root)` 启动子进程而 ENOENT——这是 R3-G2 的修订点）；
7. 打印 JSON `{ outcome, unrelatedAlive, diagnostics }`，并清理无关进程与监听端；
8. `--recover` 模式：跳过步骤 3-5（不重建 stale 场景），直接再调一次 `ensureCoordinator(root)` 并打印结果——供恢复演示使用。

**步骤**：
1. 在 `<checkout>`（worktree 或合并后 main）内 `npm install`。
2. 运行 `node "C:\Users\27499\.github-issue-driven\zhuxixi\pi-agent-board\issue-239\research\verify-u1-legacy-no-kill.mjs" --root "$env:TEMP\ab-u1-239"`。
3. 观察脚本输出与 `<隔离 root>/views/_coordinator/diagnostics.jsonl`。
4. **通过标准**：`outcome.error === "coordinator_stale_protocol"`；`unrelatedAlive === true`；诊断含 `coordinator_replacement_skipped` 且 `details.reason === "identity_unverified"`；再次运行脚本时诊断**不新增**行（跨进程去重）。
5. **恢复演示**：删除 `<隔离 root>/views/_coordinator/state-coordinator.lock`（隔离场景已无存活 coordinator；生产环境须先按 §9 第 3 条停掉 endpoint 服务者）→ 运行 `node <脚本> --root "$env:TEMP\ab-u1-239" --recover` → 输出 `outcome.ok === true`。注意真正阻塞替换的是旧的 endpoint 服务者，租约 pid 只是被故意指向的无关进程，杀它不能恢复。
6. **`--recover` 的残留**：`--recover` 会在隔离 root 上留下一个真实的 protocol 3 coordinator。**重跑 U1 前必须先停掉它**（按 root 过滤 node 命令行）**或删除隔离 root**，否则下一次 U1 会因首次 probe 即 ok 而假通过。

**跨版本安装现场的验收边界**：真实「历史版本 detached coordinator 跨越安装升级」需要旧版本包并保留其进程，CI 与本机都难以稳定复现；本 issue 不把它列为可执行实测项，语义由 A5-A7 覆盖（§9 第 8 条）。

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 重 ping 增加的延迟 | 替换路径最多 +1s（通常 ms） | 只在协议落后时发生；正常路径零变化 |
| Linux legacy 用 `/proc` token 兜底误判 | 极少：starttime jiffies 同值 | token 不等即 skip（安全方向） |
| win32 pid 复用导致 `isAlive` 仍 true | `replace_timeout`，替换失败但安全 | fail-closed；诊断给出原因 |
| 诊断写入重建已删 root | #241 同类残留 | 写前 `existsSync(root)`；写失败 best-effort |
| 旧记录形态多样（顶层/嵌套 instanceId） | 解析错 | `readCoordinatorLeaseRecord` 兼容两种位置；A2 覆盖 |
| 高频率 ensure 触发诊断 | JSONL 膨胀 | Set 先挡（不触盘）+ `appendDiagnosticOnce` 仅首次调用（整文件 tail 读不在热路径）；A8 钉住 |
| 去重 Set 内存 | 每进程每 root×状态一条 | key 为短字符串，进程生命周期内有限；无需清理 |
| win32/darwin 上 pre-#224 残留租约（`lockAge<5min`） | 新实例 blocked 至 5min | **本设计不产生该形态**（替换路径在 J6 止步、不会 kill）；外部崩溃产生的残留按既有 #112/#224 语义处理，见 §9 第 4 条 |

## 9. 保证边界（明说做不到的）

1. **不防伪造**：租约文件在本地磁盘，威胁模型外；instanceId 比对防误用，不防恶意写入。
2. **无线性化保证**：靠 D3 的两次实时确认收敛窗口；不提供跨进程事务语义。
3. **win32/darwin 的 legacy 记录无法自动替换**：记录侧 `startToken` 恒 null（`captureStartToken` 仅 linux）→ J6 停在 `coordinator_stale_protocol`。生产恢复步骤（首个 post-#239 协议 bump 后可能出现）：
   - **a. 定位 endpoint 服务者，不要信租约 pid。** 租约记录的 pid 可能已被无关进程复用（正是本 issue 要防的误杀目标）。在 win32 上用 root 过滤 node 命令行：`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*state-coordinator.mjs*" -and $_.CommandLine -like "*<root>*" } | Select-Object ProcessId, CommandLine`；POSIX 用仓内同款跨平台写法 `ps -e -ww -o pid=,args=`（`scripts/run-tests.mjs:312-314`）再 grep `state-coordinator.mjs` 与 `<root>`。**不要用 `pgrep -af`**：Linux procps 的 `-a` 是完整命令行，而 BSD/macOS 的 `-a` 是「包含祖先进程」，darwin 上拿不到命令行。
   - **b. 终止该进程。**
   - **c. 按 §1.4 形态处理残留租约**：post-#224 declared 记录在 pid 死后可被新实例立即 reclaim；Linux 的 pre-#224 identity 记录在 pid 死后立即 reclaim；win32/darwin 的 pre-#224 identity-less 记录在 `lockAge<5min` 时需等 5min。**若 ownerPid 被一个存活的非 coordinator 进程复用，identity-less 分支会永远返回 busy（`locks.mjs:329-331`）——等 5min 不会自愈，直接走 d。**
   - **d. 可执行的阻塞确认（删锁目录前）**：跑一次 ensure（脚本直调 `ensureCoordinator`，或触发一次 state_command）；若返回 `coordinator_unavailable` 且 `<root>/views/_coordinator/diagnostics.jsonl` 出现 `coordinator_lease_unavailable`（`details` 含 `reason`=busy/blocked、`ownerPid`、`hasIdentity`；`state-coordinator.mjs:236-239`），即确认租约阻塞 → 删除 `<root>/views/_coordinator/state-coordinator.lock` 并重跑。**删除前必须先停掉 coordinator**：删掉仍存活 coordinator 的锁目录会让它的 `stillOwns()` 变 false、3 次心跳失败后自退（`locks.mjs:487-493`、`state-coordinator.mjs:377-392`），并可能与新实例的 bind 产生竞态。
   - **e. 重跑并触发一次确定会产生 state_command 的动作**：dashboard 里回复/标记完成/切换 view（markVisited），或脚本直调 `sendStateCommand`。**不要以「打开 dashboard」作为触发**——唯一直接调用 `ensureCoordinator` 的是 desync 修复路径（`service.mjs:2567`），打开面板本身不保证产生 state_command。
   - **禁止**：对未经验证的租约 pid 发信号——这正是本 issue 修复的缺陷。
4. **身份缺失且未声明心跳的 coordinator 租约需等 5min**：5min 门（`ORPHAN_LEASE_AGE_MS`，`locks.mjs:151`）只在 `hasIdentity === false` 且未声明心跳时生效（`:305`、`:329-331`）。典型形态是 **win32/darwin 的 pre-#224 coordinator 记录**（记录侧 `startToken` 恒 null，`pid.mjs:55-66`）；**Linux 的 pre-#224 coordinator 租约自 #91（`b022a7b`）起就带 `startToken`**，pid 死即由 identity 分支立即回收（`:325-327`），不会等 5min。本设计不产生该形态（替换路径在 J6 止步）；外部崩溃产生的残留按既有 #112/#224 语义处理，不由本 issue 清理（N5）。
5. **SIGTERM 语义平台差异**：win32 强制终止（已实测）、POSIX 协作退出；等待窗只覆盖正常退出时长，超时即放弃。
6. **不改变协议版本**：本 issue 不触发任何现存 coordinator 的替换；遗留记录只会在未来版本升级时暴露。
7. **诊断消费端（UI 呈现）不在范围**。
8. **真实安装形态的跨版本升级无法自动验收**：需要旧版本 detached coordinator 跨越安装升级存活，CI 与本机难以稳定复现；U1 用隔离 root 复现同一代码路径，不覆盖该现场。语义由 A5-A7 的真实子进程 fixture 覆盖。
9. **J3 是对 issue 建议 2 的显式偏离**：Linux legacy 在实时 startToken 相等（同一性可证）后仍发信号；win32/darwin 严格按建议 2 skip。若复核/评审不接受该偏离，回退方式是删除 J3（Linux 升级路径退化为人工恢复，恢复步骤见第 3 条）。

## 10. 参考

- issue #108 / PR #109（`64f4fac`）协议版本门与 `replaceStaleCoordinator` 的引入
- issue #224 / PR #236（`20b0323`）租约心跳回收；spec §2 非目标第 2 条即本 issue
- issue #238 / PR #243（`2815469`）进程身份 token 统一；spec N1/N2/N5 边界
- `docs/superpowers/specs/2026-10-23-lease-heartbeat-staleness-design.md`
- `docs/superpowers/specs/2026-10-24-issue-238-windows-process-identity-token-design.md`
- `README.md:44-55`（安装命令）、`:284`/`:288`（默认 board root 与 `AGENT_BOARD_ROOT` 覆盖）
- 调研/验收脚本（不在 repo 内）：`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-239/research/01-call-chain-and-identity.md`、`02-repair-shape-and-upgrade-path.md`、`probe-win32-sigterm.mjs`、`baseline-summary.md`、`verify-u1-legacy-no-kill.mjs`（实现任务产出，U1 使用）
