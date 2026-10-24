# issue #238 — 设计：把进程身份 token 统一为一处跨平台实现，让 Windows 也能产出并比对 token

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T11:52:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T12:05:00+08:00 · 依据 R1 复核（R1-G1 darwin 秒级抖动排除 token 路径、R1-G2 观测侧 token memo、R1-G3 U1 pid 复用步骤重写、R1-D1…D10 全部接受）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T12:20:00+08:00 · 依据 R2 复核（R2-G1 U1④ resolver 双角色 ended 门槛、R2-D1 probe 账 6 次、R2-D2 not_started 接线与纯函数条件、R2-D3 darwin 行号、R2-D4 CI 分步命令、R2-D5 U1③ 毫秒换算、R2-D6 重验降级描述；全部接受）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T12:45:00+08:00 · 依据 R3 复核（收敛轮：0 真缺口；R3-D1 ci.yml 步骤行号、R3-D2 pid fallback 与 D4 签名统一、R3-D3 U1① 安装形态与升级路径；全部接受）

仓库：zhuxixi/pi-agent-board · issue：#238 · 基线：`main` @ 0a31485 · 状态：已收敛（第 3 轮 0 真缺口），待用户确认设计

---

## 1. 问题与根因（已核实）

**现象**：Windows 上每一处进程身份判定都退化为「pid 死活」——`captureStartToken()` 读 `/proc`，非 Linux 恒 `null`。`host.json` 的 `runnerIdentity` / `childIdentity` 在 Windows 上永远写着 `startToken: null`，观测侧只能靠 pid 存活判断，pid 一被复用就永远判不出身份。

**根因（两层）**：

| 层 | 事实 | 位置 |
|---|---|---|
| 能力层 | token 采集实现有 **四份**（issue 说三份，漏了 service 私有副本），且都只支持 Linux | `src/core/pid.mjs:53`、`runner/pty-runner.mjs:1613`、`runner/state-coordinator.mjs:494`、`src/runtime/service.mjs:2546 readProcStartToken` |
| 语义层 | host-role 判定散在三处：运行时走 `service.mjs:2624 defaultObserveProcess`（同步），纯函数 `host-coordination.mjs:49 processIdentityState` 运行时未被引用，`observeHostRole`（`service.mjs:983`）自带一套平行判定 | 见左 |

**已修复的部分（本设计的前提，不要重做）**：issue 正文的 consequence 1（#217 卡在 `stopping`）已由 **PR #240**（`b743ef6`）修复——`src/core/process-identity-probe.mjs` + `classifyUnverifiableProcess`（`host-coordination.mjs:109`）用「命令行优先 / 创建时间 5 s 容差兜底」把 `unknown` 细化为 `owned`/`foreign`。本 issue 不做第二套兜底逻辑，只补「token 本身」。

**剩余缺口（本设计要修的）**：

1. 记录侧在 Windows 上写 `null` → 观测侧无法直接比对，只能依赖命令行可读性与 5 s 创建时间窗口。
2. 四份采集实现漂移风险（注释已不一致）。
3. 判定未收敛：`processIdentityState` 是死代码，`observeHostRole` 自己实现了一遍 `not_started`/`dead` 语义。

**可行性实测（本机 Windows 11，2026-10-24，脚本 `research/verify-probe-self.mjs`）**：

| 观测 | 结果 |
|---|---|
| 同一 pid 连续两次 probe 的 `creationTimeMs` | 完全相同（`1792811668715`）→ 稳定，可作 token |
| 自查询 `creationTimeMs` vs `Date.now() - process.uptime()*1000` | 差 **-10 ms** → 同一时钟语义，但记录侧仍应统一用 probe 值 |
| 刚 `spawn` 的子进程立即可 probe？ | **可以**，`creationTimeMs - spawnedAt = -1 ms` → 无竞态窗口 |
| 单次 probe 耗时 | **356–387 ms**（`Get-CimInstance`） |
| 命令行可读 | 可读（`node.exe <script> ...`） |

**darwin 未实测且机制上不可用**：`resolveProbeCommand` 的 darwin 分支（`process-identity-probe.mjs:132-134`）用 `ps -p <pid> -o etime=,command=`，`parsePsElapsedMs`（`:69` 正则，`MM:SS`/`HH:MM:SS`/`D-HH:MM:SS`）只有**秒级分辨率**，`parsePsProbeLine`（`:86-101`）以 `nowMs - elapsedMs` 反推创建时间 —— 两次读取在不同时刻进行时估算值可相差约 1 s。若把它当 token 做字符串相等比对，会把活着的 owned host 判成 `foreign`（→ 释放记录 + 新起宿主 + 双写 session 文件）。**故 token 路径只给 win32；darwin 维持 `null`**，继续走 #217 的 5 s 容差兜底（容差恰好吸收秒级抖动）。

**下游价值**：#239（`replaceStaleCoordinator` 发 SIGTERM 前不校验身份）正文自述依赖本 issue 的底座。

## 2. 范围

### 做

1. **单一采集实现**（4 → 1）：`src/core/pid.mjs` 为唯一同步 token 实现；删除 pty-runner / state-coordinator / service 三份私有副本。
2. **跨平台异步 token 读取**：新增 `readProcessStartToken(pid, opts)`（`src/core/process-identity-probe.mjs`）——Linux 用 `/proc`；**win32 用已有 probe 的创建时间，格式化为 `ct:<unix-ms>`**；darwin 与其他平台 `null`；失败 `null`。
3. **记录侧写入真实 token（只限 `host.json` 身份）**：`pty-runner` 的 `runnerIdentity` 与 `childIdentity` 在 Windows 上写 `ct:<ms>`。
4. **观测侧 token 比对**：`service` 的 host-role 观测在「记录 token 非空」时异步读取观测 token 并比对；相等 `owned`、不等 `foreign`；记录或观测任一为 `null` → 维持 `unknown` 并走 #217 的 probe 兜底。观测侧 token 读取**按 pid memo 化**（单次恢复 ≤2 次 probe）。
5. **判定收敛**：`observeHostRole` 的 `not_started`/`dead`/`owned`/`foreign` 判定改由 `host-coordination.mjs` 的 `processIdentityState` 产出（纯函数），`observeHostRole` 只负责组装观测快照与兜底。
6. **发信号前重验覆盖 token 路径**：`revalidateProbeOwned` 对「记录 token 非空」不再无条件放行，而是实时重读比对（绕过 memo），读失败即拒绝发信号（见 D6）。

### 不做（显式非目标）

| # | 非目标 | 理由 |
|---|---|---|
| N1 | `locks.mjs classifyLeaseOwner` 的 token 比对 | 锁获取全同步（`tryAcquireOwnedViewLock`）；Windows 读 token 需 ~390 ms 异步 probe，实现只能把锁层异步化。且 #224（PR #236）已用心跳覆盖租约回收语义。 |
| N2 | 租约 identity（`host-start` / `host-meta` / coordinator lease）写 Windows token | 同上：`hasIdentity` 切换会把租约推进 identity 分支（`locks.mjs:305`），而判定仍只问 pid 死活 —— #224 spec 已论证这比现状更糟。本 issue 只改 `host.json`，锁层行为零变化。 |
| N3 | `service` 的 `currentProcessIdentity()` / `hostMetaIdentity()` 跨平台异步化 | 同步高频路径（每次 claim/recover），probe 会阻塞 dashboard 事件循环 390 ms。保持 `null`（= 现状）。 |
| N4 | 重写 #217 的命令行佐证逻辑；darwin 的 token 化 | `classifyUnverifiableProcess` 保留为 token 不可用时的兜底；darwin 的 `ps` 只有秒级分辨率（见 §1），不能当 token。 |
| N5 | #239 的发信号前身份校验 | 依赖本底座，另立。 |
| N6 | legacy（`instanceId == null`）记录的 token 补齐 | 既有 `canFinalizeLegacyHost` 覆盖，不受影响。 |

## 3. 设计决策

### D1 — 单一采集实现（同步）

`src/core/pid.mjs` 保留唯一 `captureStartToken(pid)`：Linux 读 `/proc/<pid>/stat` 第 22 字段，其他平台 `null`。删除：

- `runner/pty-runner.mjs:1613` → `import { captureStartToken } from "../src/core/pid.mjs"`
- `runner/state-coordinator.mjs:494` → 同上
- `src/runtime/service.mjs:2546 readProcStartToken` → 用 `captureStartToken`

契约不变：`test/pid.test.mjs:69` 的「非 Linux 返回 null」继续成立。

### D2 — 跨平台异步 token（仅 win32 产出 token）

`src/core/process-identity-probe.mjs` 新增：

```js
/** `ct:<unix-ms>` — a comparable, stable process token for win32 only. */
export function creationTimeToken(creationTimeMs) {
	// pure: positive safe integer → `ct:<ms>`; anything else → null
}

/**
 * Cross-platform start token.
 *  - linux : captureStartToken(pid)          （/proc 第 22 字段，jiffies）
 *  - win32 : probe → creationTimeToken(ms)   （CIM 毫秒级，两次读取严格相等）
 *  - 其他  : null                            （darwin 的 ps etime 只有秒级，不能当 token）
 */
export async function readProcessStartToken(pid, {
	platform = process.platform,
	probe = readProcessIdentityProbe,   // injectable for tests
} = {}) { /* linux → captureStartToken; win32 → probe → creationTimeToken; else null */ }
```

- 非法 pid / `probe == null` / `creationTimeMs == null` → `null`（= 不可验证，绝不猜测）。
- `ct:` 前缀保证与 Linux 的 jiffies 字符串永不相等；跨平台/跨来源记录不会被误判 `owned`。
- **darwin 显式返回 `null`，且不调用 probe**（省一次 ~`ps` 往返，语义上也不需要）。

### D3 — 记录侧（仅 `host.json`）

`runner/pty-runner.mjs`（注意：`main()` `:110` 是**同步**入口，只读 config 并分发；第 1–7 步都在 `async function ownedMain(config)` `:545` 内）：

| 位置 | 现在 | 改为 |
|---|---|---|
| `:771` start lease identity | `captureStartToken(process.pid)` | **不变**（锁层保持 `null` on Windows，见 N2） |
| `:936 runnerIdentity` | `captureStartToken(process.pid)` | `await selfTokenPromise` |
| `:1026 childIdentity` | `captureStartToken(childPid)` | `await readProcessStartToken(childPid)` |

**发起时点**：在 `ownedMain(config)` **开头、第 1 步（`acquireOwnedViewLock`，`:768`）之前**：

```js
const selfTokenPromise = readProcessStartToken(process.pid);   // 与 lease/yield/listen 并行
```

第 4 步（`:933`）`await selfTokenPromise` 后再 `ownedUpdate`。

**时序量化（Windows 实测）**：

- `runnerIdentity`：前三步（lease/yield/listen）是本地快速操作（通常 <100 ms），probe 需 356–387 ms → 锁内等待 `≈ 390 − 前三步 ≈ 300 ms`。`HOST_RUNNER_LOCK_WAIT_MS = 5_000`（`pty-runner.mjs:58`）足以吸收；start lease 的持锁窗口因此比现状长约 0.3 s（现状本来就含 spawn/ready 等毫秒—百毫秒级操作）。
- `childIdentity`：`state: "alive"` 的 publish 延后 ≤ ~390 ms（仅 Windows；Linux 上两个 await 都是 `/proc` 同步零成本）。
- probe 失败（PowerShell 被禁/超时）→ `null`，写盘结果与现状一致。

`runner/state-coordinator.mjs:134`：改为 import `captureStartToken`（语义不变，Windows 仍 `null`，见 N2）。

### D4 — 观测侧（`service`）：观测层与判定层分离 + token memo

现状 `defaultObserveProcess`（`service.mjs:2624`）把「读 token」和「判定」揉在一个模块级函数里，且 `opts` 注入到不了它（`createService` 之外）。改为两层：

1. **纯判定**：`host-coordination.mjs` 的 `processIdentityState(identity, observed, spawnedAt)`——`not_started` → `dead` → 任一 token `null` → `unknown` → 相等 `owned` / 不等 `foreign`。
   **`not_started` 的判定条件本次修订为 `identity == null && spawnedAt == null`**（R2-D2）：旧条件是 `spawnedAt == null`，会把「identity 已写但 spawnedAt 缺失」的畸形记录判成 `not_started`（属于 `SAFE_TO_RELEASE`）→ 可能释放一个**仍然活着**的 host → 新起宿主双写 session 文件。`identity` 存在即证明该角色 spawn 已发生，此时必须按观测判定（`owned`/`dead`/`unknown`），不能宣布未启动。既有用例 `(null, null, null) → not_started` 不受影响。
2. **观测组装**（`createService` 闭包内，可注入）：`observeProcessIdentity(identity, { spawnedAt, pid, tokenMemo })`。`pid` 由 `observeHostRole` 按现状 `identity?.pid ?? host?.[`${role}Pid`] ?? null`（`service.mjs:990`）算出后传入——**保留 pid fallback**，identity 已写但 pid 字段缺失的畸形记录仍能走 #217 probe 兜底：

```js
// 组装 observed 快照，判定一律交给 processIdentityState（无魔法值参数）
if (identity == null && spawnedAt == null) return "not_started";   // 保留既有 :987-989 语义
if (pid == null) return "unknown";
const alive = isAliveImpl(pid);
const observed = { alive, startToken: null };
if (alive && identity.startToken != null) {
	// 只在记录 token 非空时才读观测 token：旧记录/服务侧仍是 0 次新增 probe
	if (!tokenMemo.has(pid)) tokenMemo.set(pid, readStartTokenImpl(pid));
	observed.startToken = await tokenMemo.get(pid);
}
return processIdentityState(identity, observed, spawnedAt);
```

`opts.observeProcess` 的注入点保留（测试优先，接管「观测 + 判定」）；默认值改为上述闭包实现；新增 `opts.isAlive` 与 `opts.readStartToken`（**均为待新增注入点**，默认 `pid.isAlive` / `readProcessStartToken`）。

3. **token 读取 memo 化**（R1-G2）：`observeHostRole(host, role, { sessionFile, memo, tokenMemo })`，新增 `tokenMemo: Map<pid, Promise<string|null>>`。`recoverHost` 的一次调用内对每个 pid 只 probe 一次：

```js
if (!tokenMemo.has(pid)) tokenMemo.set(pid, readStartTokenImpl(pid));
const startToken = await tokenMemo.get(pid);
```

调用点（`service.mjs:1109/1110/1152/1155` 与 resolver 的 `:1416/1417`）各创建一个 `tokenMemo`（与既有 `probeMemo` 并列，互不混用：`probeMemo` 的值是 probe 对象，`tokenMemo` 的值是字符串/null）。

**probe 次数账（Windows，单次恢复）**：

| 路径 | probe 次数 |
|---|---|
| 记录 token 为 `null`（旧记录/service 侧） | **0 次新增**（立即 `unknown` → #217 兜底，兜底本身 memo 化 ≤2 次） |
| 记录 token 非空（本 issue 新路径） | 首次 2 次（runner+child，各 ~390 ms）+ 重验 ≤4 次（≤2 角色 × 2 信号，见 D6/§8）= 总计 ≤6 次 |
| 其中 probe 挂起（3 s 超时） | 首次两角色最多 6 s；已计入 grace 预算，见 §8 |

### D5 — 兜底顺序不变（#70 契约）

观测判定顺序固定为：**token 比对优先，probe 佐证兜底，仍不可验证 → `unknown`**。任何读取失败都不得猜测成 `foreign`（`foreign` 会触发释放/新起宿主）。

### D6 — 发信号前重验（覆盖 token 路径）

`service.mjs:1005 revalidateProbeOwned` 现在对「记录 token 非空」直接 `return true`（`:1007-1008`，理由是 Linux 的 `/proc` 读取本身实时）。Windows 上 token 路径的观测来自 ~390 ms 前的 probe，与发信号之间存在 pid 复用窗口，因此：

- 记录 token 非空 → **实时重读** `readStartTokenImpl(pid)`（**绕过 `tokenMemo`**）并比对；相等才放行；
- 重读失败（`null`）→ **返回 `false`**（拒绝发信号）。实际后果（R2-D6 修正）：观察值仍由 `tokenMemo` 的既有 promise 供出，后续轮次仍可能得 `owned`，重验持续失败直到 grace 耗尽 → 最终观察仍 `owned` → `recovery_pending`；**全程不发信号、不释放**（安全，但不会自动退化为 #217 的 probe 兜底）；
- 记录 token 为 `null` → 保持现有 probe 重验（含写回 `probeMemo`）；
- **token 路径重验结果不写回 memo**（避免把字符串塞进 probe 对象的 Map）。

Linux 上重读 `/proc` 是同步零成本；Windows 上每次重验 +~390 ms，只发生在即将发信号的恢复轮次（每角色最多 2 次：SIGTERM + SIGKILL，最坏 4 次）。

### D7 — 降级与失败

| 失败点 | 行为 | 验收 |
|---|---|---|
| probe 不可用（PowerShell 被禁、超时、pid 已死） | `readProcessStartToken` → `null`；记录侧写 `null`（= 现状）；观测侧走 #217 兜底 | A2 / A9 |
| 记录 token 为 `ct:` 但观测读不到 | `unknown` → 兜底 → 仍 `unknown` 则 `recovery_pending`（不变） | A9 |
| 旧记录（token `null`） | 完全维持现状路径，零行为变化 | A3 |
| darwin / 其他平台 | `null` → 现状 | A2 |
| Linux 无 `/proc` 权限 | `captureStartToken` → `null` → 兜底 | 既有测试 |

## 4. 组件契约

| 模块 | 导出 | 语义 |
|---|---|---|
| `src/core/pid.mjs` | `captureStartToken(pid)` | 同步；Linux `/proc` → 字符串；其他/失败 → `null` |
| `src/core/process-identity-probe.mjs` | `creationTimeToken(ms)` | 纯函数；正安全整数 → `"ct:<ms>"`；否则 `null` |
| 同上 | `readProcessStartToken(pid, opts)` | 异步；linux → `captureStartToken`；**win32 → probe → `creationTimeToken`**；**darwin 及其他 → `null`（不调 probe）**；失败 `null`；`opts.platform` / `opts.probe` 可注入 |
| `src/core/host-coordination.mjs` | `processIdentityState(identity, observed, spawnedAt)` | 纯函数，签名不变（`observed.startToken` 现在是跨平台 token） |
| `src/runtime/service.mjs` | `createService(opts)` | `opts.observeProcess` 允许返回 Promise（`await` 兼容同步返回值）；**新增** `opts.isAlive`（默认 `pid.mjs` 的 `isAlive`）与 `opts.readStartToken`（默认 `readProcessStartToken`） |
| 同上 | `observeHostRole(host, role, { sessionFile, memo, tokenMemo })` | `tokenMemo` 新增；`probeMemo` 语义不变 |
| 同上 | `revalidateProbeOwned(...)` | token 路径实时重读、不写 memo、读失败拒绝 |

## 5. 可测性拆分设计（必答）

| 拆分点 | 形态 | 测试边界 |
|---|---|---|
| `creationTimeToken(ms)` | 纯函数 | 单测：正整数/0/负数/NaN/Infinity/字符串/超大值 → `null` |
| `readProcessStartToken(pid, opts)` | 异步 + 注入 `platform` + `probe` | 单测：linux → `/proc` 值；win32 → `ct:`；**darwin → `null` 且 `probe` 未被调用**；probe `null` → `null`；非法 pid → 不调 probe |
| `processIdentityState` | 纯函数 | 既有 5 态单测；补 `ct:` token 相等/不等 |
| `observeProcessIdentity`（service 闭包） | 异步 + 注入 `isAlive` / `readStartToken` | 单测（经 `createService({isAlive, readStartToken})`）：记录 token `null` → **不调** `readStartToken` 且 `unknown`；相等 → `owned`；不等 → `foreign`；读失败 → `unknown`；alive=false → `dead` |
| `observeHostRole` + `tokenMemo` | 异步编排 | 单测：同一 pid 两轮观测只 probe 一次（计数桩）；`probeMemo` 与 `tokenMemo` 互不污染 |
| `revalidateProbeOwned` | 异步编排 | 单测：记录 token 非空 + 重读返回不同值 → 拒绝信号；重读返回 `null` → 拒绝；Linux 路径零额外开销 |
| `pty-runner` 记录侧 | 集成 | 现有 `pty-runner.integration.test.mjs:886` 断言非空 token（Linux `/^\d+$/`）；win32 `ct:` 分支由 `readProcessStartToken` 单测 + U1 实机覆盖 |

## 6. 数据流

```
spawn 时（记录侧）                      恢复时（观测侧，service）
─────────────────────                  ──────────────────────────
ownedMain 开头：                        observeHostRole(host, role)
  selfTokenPromise = readProcessStartToken(self)
  → host.json.runnerIdentity.startToken    │ identity == null && spawnedAt == null ──▶ not_started
  spawn child 后：                          │（identity 存在则绝不判 not_started，见 D4）
  readProcessStartToken(childPid)          ▼
  → host.json.childIdentity.startToken  pid = identity?.pid ?? host[rolePid]
                                           │ null ──▶ unknown
                                           ▼
                                isAlive(pid)? ──no──▶ dead
                                           │yes
                                           ▼
                              identity.startToken == null? ──yes──▶ unknown
                                           │no                        │
                                           ▼                          ▼
                              tokenMemo(pid) = readProcessStartToken(pid)   （#217 probe 兜底）
                                           │
                                           ▼
                              processIdentityState(...) = equal? owned : foreign
                                           │
                                           ▼
                              发信号前 revalidate（D6，绕过 tokenMemo 重读）
```

## 7. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | `creationTimeToken` 纯函数 | 自动化（unit） | `node --test test/process-identity-probe.test.mjs` | 合法 ms → `ct:<ms>`；0/负/非整数/非数字/超大 → `null` |
| A2 | 跨平台 token 读取 | 自动化（unit） | 同上，注入 `platform` + `probe` 桩 | linux 走 `/proc`；win32 返回 `ct:`；**darwin → `null` 且 probe 未被调用**；probe `null` → `null`；非法 pid 不调 probe |
| A3 | 观测侧 token 比对 | 自动化（unit） | `node --test test/service.test.mjs`（`createService({isAlive, readStartToken})` 注入） | 相等 → `owned`；不等 → `foreign`；记录 `null` → 不调 `readStartToken` 且 `unknown`；读失败 → `unknown` |
| A4 | 判定收敛 | 自动化（unit） | `test/host-coordination.test.mjs` + `test/host-recovery.test.mjs` | 既有 5 态用例全过（`(null,null,null) → not_started` 保持）；新增 `(identity, {alive:true,token 匹配}, null) → owned`（不被误判 not_started）；配置用例覆盖 not_started/dead/foreign |
| A5 | 发信号前重验 | 自动化（unit） | `test/service.test.mjs` 新增：token 非空 + 重读返回不同 token / `null` | 不发信号、流程 finalize 或 pending（按 observation 而定） |
| A6 | token memo 生效 | 自动化（unit） | `test/service.test.mjs` 新增：同一 pid 两轮观测 + 计数桩 | `readStartToken` 对该 pid 只调 1 次；`probeMemo` 不受影响 |
| A7 | 四份拷贝收敛 | 自动化（static） | `Get-ChildItem src,runner -Recurse -Filter *.mjs \| Select-String -Pattern 'captureStartToken'`（等价 `grep -rn captureStartToken src runner`） | 只有 `src/core/pid.mjs` 有定义；其余为 import/调用；`npm run typecheck` 通过 |
| A8 | 记录侧接线（Linux 行为不变） | 自动化（integration） | `node --test test/pty-runner.integration.test.mjs` | `runnerIdentity/childIdentity.startToken` 仍匹配 `/^\d+$/`（既有 :886 断言） |
| A9 | 降级链路 | 自动化（unit） | `test/service.test.mjs`：注入 `readStartToken → null` 且 `probeProcessIdentity → null` | observation 最终 `unknown` → 恢复返回 `recovery_pending`，不误判 `foreign`、不发信号 |
| A10 | CI 全量回归 | 自动化（build/test） | **CI（ubuntu-latest）分步全绿**：`npm run typecheck` / `npm run test:perf` / `npm test` / `npm run test:coverage` / `npm run pack:dry`（`.github/workflows/ci.yml:32-44` 的五个 `run:` 步骤，等价于 `package.json:60` 的 `npm run verify`；CI job 不直接调 verify） | 五步全绿，含 c8 门槛（lines 85 / funcs 80 / branches 70） |
| A11 | 本机 Windows 回归对照 | 自动化（build/test，本机） | `npm test *> baseline-after.log`，与 `research/baseline-test.log` / `research/baseline-failures.txt` 逐条对照 | 不新增失败测试（口径：`✖` 行集合差集为空；基线 1298 tests / 66 fail / 5 skip）。**不要求本机 `npm run verify` 全绿**——既有 66 个失败会让链在 test 步骤中断 |
| U1 | Windows 实机 token 与 pid 复用 | 用户实测 | ① 本机 `git pull` 到含 fix 的版本并重载 Pi（确认 `runner/pty-runner.mjs` 含 `readProcessStartToken`）；**确认失败说明是 npm 安装形态**（`README.md:45` 的 `pi install npm:@zhuxixi/pi-agent-board` 不受本地 checkout 影响）→ 改按 `README.md:53-54` 执行 `npm install` + `pi install "$(pwd)"`（或安装含 fix 的已发布版本）后重载，再次确认；② **用新 session 或先结束旧 host 再 attach**，确保走一次全新 host 启动（新 `instanceId` 记录）；③ 读 `~/.pi/agent/agent-board/views/<view>/host.json`，用 `[long]([datetimeoffset](Get-CimInstance Win32_Process -Filter "ProcessId=<pid>").CreationDate).ToUnixTimeMilliseconds()` 换算毫秒值比对（或直接跑 `research/verify-probe-self.mjs` 对照）；④ 造复用（resolver 需**双角色都 ended** 才进 `recoverHost`，`service.mjs:1423`）：先 `stopping` 化——把 `state` 置 `stopping`、`stopRequestedAt` 改为 `now - 6000`（≥ `HOST_RECOVERY_GRACE_MS=5000` 才过 `staleStop`，`service.mjs:1413`）；再把 `runnerPid` 与 `runnerIdentity` 都改成**已死的 pid**（如 `99999999`，`startToken` 随便写 `ct:1`）→ runner 侧判 `dead`；最后把 `childPid` 与 `childIdentity` 指向**当前存活的无关进程**（`startToken` 写不匹配值如 `ct:1`）→ child 侧 token 比对不等判 `foreign`；然后 attach | ③ `runnerIdentity.startToken` / `childIdentity.startToken` 以 `ct:` 开头且与 CIM 换算值一致；④ 恢复判 `foreign` 并正常收尾：`host.json` 出现新 `instanceId` 或 state 推进、不永久 `recovery_pending`、无信号发给该无关进程（该进程仍存活）；验收后把 `host.json` 改回或删掉该 view 记录，并清理失去引用的真实 child 进程（若成为孤儿） |

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Windows 上 `childIdentity` 使 `alive` publish 延迟 ~390 ms | 首次 attach 慢 0.4 s | 仅 Windows 新记录；Linux 零成本；CR 可评估改「先 publish 后补写」 |
| 锁内等待 ~300 ms（`runnerIdentity`） | start lease 持有变长 | probe 在拿锁前发起；`HOST_RUNNER_LOCK_WAIT_MS = 5 s` 兜底；实测前三步 <100 ms |
| **观测侧每轮 probe** | 若无 memo：每轮 2×390 ms，5 s grace 内约 10 次 PowerShell；probe 挂起（3 s 超时）时单轮 >6 s | **D4 的 `tokenMemo`**：单次恢复 ≤2 次；重验每次 1 次（≤2 角色 × 2 信号）；probe 挂起最坏 2×3 s = 6 s，仍受 `HOST_RECOVERY_GRACE_MS=5 s` 轮次约束（最终观察在循环外补一次，见 `:1152-1155`） |
| `observeProcess` 改 async 破坏注入点 | 既有测试/调用方 | 仅一处调用（`service.mjs:986`）；`await` 兼容同步返回值；`opts.observeProcess` 类型注释改为「可返回 Promise」 |
| `defaultObserveProcess` 是模块级函数，`opts` 到不了 | A3 的注入落空 | D4：观测组装移入 `createService` 闭包，新增 `opts.isAlive` / `opts.readStartToken` |
| 记录 token 非空改变 `hasIdentity` | 租约分支切换 | N2：只改 `host.json`，租约 identity 仍走 `captureStartToken`（Windows `null`） |
| CI 无 Windows | 平台分支无端到端 | 注入式单测（A1–A3/A5/A6/A9）+ U1 实机 |

## 9. 参考

- #217 设计：`docs/superpowers/specs/2026-10-24-issue-217-windows-pid-reuse-stopping-design.md`（probe / `classifyUnverifiableProcess` 的来源；其 U1 用「手改 host.json」造复用）
- #224 设计：`docs/superpowers/specs/2026-10-23-lease-heartbeat-staleness-design.md:42,52`（本 issue 的范围划界）
- #70 契约：`docs/superpowers/specs/2026-09-05-pty-host-stacking-sock-race-design.md:131-146`
- 调研留档：`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-238/research/01-census-and-scope.md`
- 实测脚本：`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-238/research/verify-probe-self.mjs`
- **本机基线**（A11 对照基准）：`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-238/research/baseline-test.log`（1298 tests / 1227 pass / 66 fail / 5 skip）与 `baseline-failures.txt`（133 条 `✖` 行，含子测试）
- 第 1 轮复核报告：`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-238/research/spec-review-round-1.md`
