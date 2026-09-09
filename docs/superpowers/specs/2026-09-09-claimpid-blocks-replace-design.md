# Spec: exited host 的 claimPid 存活导致 attach 永久 pending（issue #99）

## 背景

dashboard 里对已退出的 session 点 attach，永远连不上：attach 一直转圈，最终超时提示 `host start timed out`。实测对象 `view_2472d82627`（host 已正常退出 `state: "exited"`，`exitCode: 0`），同机另有 `view_4b667ad75d`、`view_c038badb30` 两个 view 处于相同状态（exited + claimPid 存活），全部无法 attach。

## 根因

### 触发链条

1. 用户从 dashboard（进程 P）attach session → `claimHost`（`src/core/store.mjs:172`）把 `claimPid` 记为 **dashboard 进程的 pid**（`claimPid: provisionalHost.claimPid ?? null`，即 service 进程 pid）
2. pi 子进程正常退出（`pty-runner.mjs:262` `child.onExit` → `state: "exited"`）→ **退出路径不清除 claimPid**
3. dashboard 进程 P 继续存活（用户一直开着 dashboard）
4. 再次 attach → `startHostUnderLease`（`service.mjs:243`）替换 terminal host 前调 `canReplaceHost(observeHostForReplace(existing))`
5. `observeHostForReplace`（`service.mjs:2006`）对 claim 角色用 `conservativeObservation(host.claimPid)`：**pid 活着 → `"unknown"`**
6. `canReplaceHost`（`src/core/host-coordination.mjs:72`）要求 runner / child / claim 三角色都 `SAFE_TO_RELEASE`（`not_started | dead | foreign`），claim 为 `"unknown"` → **返回 false**
7. → `pendingLaunchResult` → attach 循环等待直到 deadline → `pending(sessionFile, "host start timed out")`

实机验证（node 直接调用 `canReplaceHost`）：

```
host.state: exited
runnerPid 1004724 → dead
childPid null → dead
claimPid 1003423 → unknown   ← 阻塞点
canReplaceHost → false
```

### claimPid 的语义（代码注释 + 测试确认）

- **非 null = "launcher 可能还在 claim 和 spawn 之间"**：保护 mid-transaction，让 ensureHost/adopt 等 grace 窗口（`service.mjs:976` `withinGrace` 判定依赖 `claimPid != null`）
- **recovery claim 用 `claimPid: null`**（`service.mjs:723-736`）：recovery 事务在 claim 落盘时已完成，spawning 是 adopter 的活；`host-recovery.test.mjs:317` 断言 `recovery claim must not carry a live claimPid`
- **spawn 失败路径清除 claimPid**（`service.mjs:832, 869`）：failed fenced
- **正常退出路径不清除** ← 缺口：host 进入 `exited` 后 claimPid 残留，而 claim 保护语义（launcher mid-transaction）在 host 已 terminal 时**不可能成立**（runner 都跑完退出了）

### 为什么是 bug

`canReplaceHost` 的 claim 角色检查在 host 已 terminal 的场景下过度保守。claim 保护只对 `starting` 状态有意义；host 为 `exited/failed` 时，claim 进程不可能还在启动它（启动要么成功——runner 跑过并退出，要么失败——failed fenced 已清 claimPid）。触发条件常见：**dashboard 进程存活 + host exited → 任何从 dashboard 启动又退出的 session 都无法再次 attach**。

## 修复方案（选定：放宽 canReplaceHost 的 claim 角色判定）

### 方案对比

| 方案 | 改动 | 对存量坏记录 | 评价 |
|------|------|-------------|------|
| **A. canReplaceHost 放宽 claim 判定** | 纯函数（`host-coordination.mjs`）+ 调用方（`service.mjs`） | **立即生效**（下次 attach 即可替换） | ✅ 选定 |
| B. terminal 时清除 claimPid | 改 pty-runner 退出路径多处 + recoverHost finalize | 无效（已存在的坏记录不会自动修复，需额外迁移机制） | 改动面大、覆盖不全 |
| C. conservativeObservation 增加 host 状态感知 | 改观测函数签名（传入 host 状态） | 立即生效 | 污染通用观测函数语义：`conservativeObservation` 的职责是"保守判断单个 pid 是否活着"，让它感知 host 状态会把生命周期决策混进观测层，违背 service.mjs 里观测与决策分离的既有结构 |

### 设计

**1. `canReplaceHost`（`src/core/host-coordination.mjs:72`）判定改为**：host 已 terminal（exited/failed）+ runner/child 均 provably gone + 无 launch lease → 可替换，claim 角色不参与判定。

```js
export function canReplaceHost({ host, runnerObservation, childObservation, launchLeaseActive }) {
	if (!host || (host.state !== "exited" && host.state !== "failed")) return false;
	if (launchLeaseActive) return false;
	// claim 角色不参与判定：claim 保护语义（launcher mid-transaction）只在 host
	// 处于 starting 时有意义；host 已 terminal 时 claim 进程不可能还在启动它
	// （启动要么成功——runner 跑过并退出，要么失败——failed fenced 已清 claimPid）。
	return (
		SAFE_TO_RELEASE.has(runnerObservation) &&
		SAFE_TO_RELEASE.has(childObservation)
	);
}
```

**2. 同步移除 `claimObservation` 参数**（而非保留 unused 参数）：

- `canReplaceHost` 签名从 `{host, runnerObservation, childObservation, claimObservation, launchLeaseActive}` 改为 `{host, runnerObservation, childObservation, launchLeaseActive}`
- `observeHostForReplace`（`service.mjs:2006`，内部函数不导出）返回值移除 `claimObservation` 字段——少一次 `process.kill(pid, 0)` 系统调用
- 既有测试用例同步移除 `claimObservation` 参数

**取舍论证**（为什么移除而非保留 unused）：

- `observeHostForReplace` 只有**一个**调用方（`service.mjs:243` 传给 `canReplaceHost`），且该函数是 service.mjs 内部函数不导出——无外部兼容性问题
- 保留一个不参与判定的参数会让测试产生误导（传 `claimObservation: "unknown"` 的用例看起来期望 false，实际被忽略）
- 移除后观测层少一次无用的 `isAlive` 系统调用

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/core/host-coordination.mjs` | `canReplaceHost` 判定放宽 + 签名移除 `claimObservation` + JSDoc 更新 |
| `src/runtime/service.mjs` | `observeHostForReplace` 返回值移除 `claimObservation` 字段 |
| `test/host-coordination.test.mjs` | 既有 3 用例移除 `claimObservation` 参数；新增 A1-A5 用例 |
| `test/host-resolver.test.mjs` | 新增 A6 集成测试 |

### 安全性论证

| 场景 | 分析 | 结论 |
|------|------|------|
| exited + claimPid 活着 | 只可能来自 runner 跑完退出（claim 事务早已完成） | 安全，**修复目标** |
| failed + claimPid 活着 | runner 崩溃 / child spawn 失败（claim 事务已完成或 failed fenced 已清）；child 存活时 childObservation 仍阻塞 | 安全 |
| runner 活着 | runnerObservation = "unknown" → 仍阻塞（不受影响） | 保守性保留 |
| child 活着 | childObservation = "unknown" → 仍阻塞（不受影响） | 保守性保留 |
| alive/starting host + claimPid 存活 | attach 直接到现有 host（probe ready → 返回 pty），**不经过 canReplaceHost** | 不受影响 |
| recoverHost 并发 | recoverHost 与 startHostUnderLease 都在 host-start lease 内执行，互斥 | 无竞争 |
| starting 状态 | canReplaceHost 对非 terminal 直接返回 false（不进入新判定） | 不受影响 |

### 非目标

- 不改 pty-runner 退出路径（方案 B 不做）
- 不做存量 host.json 迁移/清理（方案 A 对存量记录天然生效）
- 不改 `conservativeObservation`（其保守语义在 starting 场景仍需要）
- 不改 dashboard UI、不改 host.json 结构（不加新字段）

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | canReplaceHost：exited/failed + runner/child dead + **claimPid 存活** → 可替换（修复点） | 自动化验证（unit） | `node --test test/host-coordination.test.mjs` | 新增用例通过：`{host:{state:"exited"}, runner:"dead", child:"dead", lease:false}` → `true`；`{host:{state:"failed"}, ...}` 同 → `true` |
| A2 | canReplaceHost：runner/child 任一 unknown 仍阻塞（保守性不破坏） | 自动化验证（unit） | 同上 | `runnerObservation:"unknown"` 或 `childObservation:"unknown"` 时返回 `false` |
| A3 | canReplaceHost：launchLeaseActive 仍阻塞 | 自动化验证（unit） | 同上 | `launchLeaseActive: true` 时返回 `false`（既有用例回归） |
| A4 | canReplaceHost：非 terminal host（starting/alive/stopping）仍拒绝 | 自动化验证（unit） | 同上 | 三个状态均返回 `false`（新增断言） |
| A5 | canReplaceHost：SAFE_TO_RELEASE 边界回归——foreign/not_started → 可替换；host null → false | 自动化验证（unit） | 同上 | `runnerObservation:"foreign"` 或 `childObservation:"not_started"` 时返回 `true`；`host: null` 返回 `false` |
| A6 | resolver 集成：exited host + 存活 claimPid → attach 启动新 host | 自动化验证（integration） | `node --test test/host-resolver.test.mjs` | 新增用例：构造 exited host 记录（`claimPid: process.pid`，存活），`resolveAttachTarget` 返回 `{kind:"pty"}` 且 spawn 恰好 1 次 |
| U1 | 真实 dashboard 场景：attach 已退出 session（dashboard 进程存活） | 用户实测 | 见下方步骤 | attach 成功进入 session，历史消息正常显示，无超时提示 |

**U1 实测步骤**：

1. **重启 dashboard 进程**（加载新代码——方案 A 对存量坏记录的"立即生效"以重启为前提）
2. 打开 dashboard，找到已知坏记录 `view_2472d82627`（issue-225 session，host `state: "exited"` + claimPid 存活）
3. 点 attach → 观察：成功进入 session、历史消息正常显示、无 `host start timed out` 提示
4. 退出 session，再 attach，确认可重复
5. 同法验证 `view_4b667ad75d` / `view_c038badb30`（另两个 exited + claimPid 存活的 view）

## 可测性拆分设计

修复集中在 `canReplaceHost` 一个纯函数（`src/core/host-coordination.mjs`），无副作用、无 I/O，天然可单测：

- **纯函数边界**：`canReplaceHost({host, runnerObservation, childObservation, launchLeaseActive})` → boolean。输入为纯数据快照，输出只依赖输入，不触碰 fs/进程/socket。
- **观测与决策分离**：`observeHostForReplace`（`service.mjs:2006`）负责进程观测（`conservativeObservation`），`canReplaceHost` 负责决策。修复只动决策层；观测层移除 `claimObservation` 字段是配套清理（少一次无用的 `isAlive` 调用），不改变观测语义。
- **测试边界**：
  - `test/host-coordination.test.mjs`：A1-A5 全部在纯函数层覆盖（现有 `canReplaceHost refuses unknown observations` 用例扩展 + 新增用例）
  - `test/host-resolver.test.mjs`：A6 走现有 `resolverService` + `healServiceOverrides` 基建（真实 ensureHostImpl claim + scripted probe），验证 attach 全链路（resolver → ensureHost → startHostUnderLease → canReplaceHost → spawn）

## 风险与降级

- **行为变化面**：仅放宽"exited/failed host 的替换判定"一个点；starting/alive/stopping 的 host 不经过 `canReplaceHost`；runner/child 存活的 host 仍阻塞。
- **回归风险**：低。改动为纯函数内一个条件的放宽 + 配套签名清理，A2-A5 保证保守性不破坏。
- **降级路径**：若 U1 实测发现异常，**revert 本 issue 的 commit 恢复原判定**（claim 角色重新参与判定）。

## 环境

- Linux x64，node v24.13.0，pi-agent-board main（0.6.1）
- 2026-09-09 实机排查，`view_2472d82627` 现场取证（host.json / diagnostics.jsonl / ps 进程树）
