# Spec: warm host 回收 —— 周期 sweep + 退出清理（issue #75）

日期：2026-09-04
状态：draft，待用户确认
仓库：zhuxixi/pi-agent-board

## 1. 背景与根因

detach / 关闭宿主后，空闲 PTY host（runner + child pi）无限期空转（实测 8.5h）。根因：

1. `pruneWarmHosts()` 仅惰性触发（attach/prewarm/dispatch 时），用户 detach 后不再操作 board 则永不触发 → `AGENT_BOARD_WARM_HOST_TTL_MS`（默认 10min）与 `AGENT_BOARD_MAX_WARM_HOSTS`（默认 4）形同虚设
2. 宿主 pi 退出/会话切换时无清理钩子（扩展未注册 `session_shutdown`）
3. 无周期扫描兜底；Windows 下 runner detached 孤儿，宿主被 kill 后无任何回收

## 2. 设计决策

### M1：提取纯判定函数 `selectIdleHostsToEvict`（可测性核心）

把淘汰判定从 `pruneWarmHosts` 闭包中提取为**纯函数**（无 IO、无 env）：

```
selectIdleHostsToEvict(rows, opts) -> { ttlEvicted: Row[], excessEvicted: Row[] }

opts = { now, maxWarm, ttlMs, graceMs, keepViewId, isBusy? }
```

- idle 定义：`hostAlive && !isBusy(row) && (host.attachedClients ?? 0) === 0 && (row.meta.id !== keepViewId)`
- **新增 graceMs 豁免**：`host.startedAt` 距今 < graceMs 的 host 不参与淘汰（防 ensureHost→attach 竞态；attach 重连兜底为第二保险）
- 排序：survivors 按 `lastActivityAt ?? startedAt` 升序，超出 maxWarm 的从最旧淘汰
- `isBusy` 默认 = 现 `isAgentBusy` 语义（queued/working/hasPendingQuestions），作为参数注入以保持纯性

### M2：新增调度器 `createWarmHostSweeper`（新模块 `src/core/warm-host-sweeper.mjs`）

```
createWarmHostSweeper({ sweep, intervalMs }) -> { start, stop, sweepNow }
```

- `setInterval(sweep, intervalMs)`，`unref()`（不阻塞宿主退出）；`sweepNow()` 立即执行一次（错误吞掉，best-effort）
- `stop()` 清定时器；`start()` 幂等
- 新环境变量 `AGENT_BOARD_SWEEP_INTERVAL_MS`（默认 60_000；0 = 禁用周期 sweep，仅保留启动/session_shutdown 时 sweepNow）

### M3：接线（src/index.ts，扩展模块级）

- 扩展加载时：**非 isHostedChild** 才创建 sweeper（`sweep = () => pruneWarmHosts({})`），`start()` + 立即 `sweepNow()`（回收上一个宿主遗留的泄漏 host）
- 注册 `session_shutdown`：`sweepNow()`（尽力清理）+ `stop()`
- **isHostedChild 必须跳过**：child pi 内加载扩展时若启动 sweeper，会向自己的 runner 发 terminate（自杀链），绝对禁止
- 新增环境变量 `AGENT_BOARD_WARM_HOST_GRACE_MS`（默认 30_000；0 = 无豁免，保持旧行为可调）

### M4：dashboard 打开期间顺带 prune（低成本增强）

`openDashboard` 的 POLL_MS 轮询回调里加一次 `pruneWarmHosts()`（dashboard 打开 = 用户正用 board，实时回收）。保持既有惰性调用点不变。

### Non-goals（明确不做）

- **runner 自退出兜底**：runner 无权威 busy 信号（state.json 是 service 层写的，跨进程读取引入耦合/竞态）；误杀风险（PRD stretch "detach while running 转 headless worker" 未实现时，pty child 可能正跑任务）。宿主被杀场景由"下一次任意宿主启动 sweepNow"覆盖，残余缺口（永不再开任何 pi）接受。
- **detach-while-running 转 headless worker**：PRD stretch，独立议题。
- 不改变 terminate 消息协议（沿用 `{type:"terminate"}` 既有语义：杀 child，runner 收尾退出）。

## 3. 数据流

```
宿主扩展实例（每个 pi session 一个，随 session_shutdown 销毁）
  ├─ module load（非 child）: createWarmHostSweeper(...).start() + sweepNow()
  ├─ setInterval(60s, unref): pruneWarmHosts({}) → selectIdleHostsToEvict → sendHostMessage(terminate)
  ├─ dashboard POLL_MS: pruneWarmHosts({})（UI 打开时）
  └─ session_shutdown: sweepNow() + stop()

selectIdleHostsToEvict(rows, opts)  ← 纯判定（无副作用）
pruneWarmHosts(opts)                ← 薄执行层（listRows + select + sendHostMessage），既有惰性调用点行为等价
sendHostMessage(row, terminate)     ← 既有 fire-and-forget socket 路径（#71 协议）
```

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | selectIdleHostsToEvict：TTL 到期淘汰、未到期保留、keepViewId 豁免 | 自动化(unit) | `node --test test/warm-host-sweeper.test.mjs` | 过期 idle host 进入 ttlEvicted；未过期/keepViewId 不进入 |
| A2 | busy（queued/working/pendingQuestions）与 attachedClients>0 永不淘汰 | 自动化(unit) | 同上 | 两类 host 均不进入任何淘汰列表 |
| A3 | graceMs 豁免：startedAt 距今 < grace 的 host 不淘汰 | 自动化(unit) | 同上 | 豁免窗口内不进淘汰列表；窗口外正常淘汰 |
| A4 | maxWarm 超额时淘汰最旧 survivors（按 lastActivityAt/startedAt） | 自动化(unit) | 同上 | 淘汰对象为排序最旧者，数量 = survivors - maxWarm |
| A5 | sweeper 调度：start 定时触发、stop 停止、sweepNow 立即执行、unref | 自动化(unit) | 同上（node:test mock timers） | fake timer 前进 intervalMs 后 sweep 被调用；stop 后不再调用；sweepNow 立即调用 |
| A6 | 接线：非 child 宿主启动即 sweepNow + 周期 sweep；isHostedChild 不接线 | 自动化(integration) | `node --test test/service.test.mjs` 增补：临时 root + node:net 假 server 捕获 terminate | idle host 的 socketPath 收到 terminate；child 模式（flag）下无 sweeper 启动 |
| A7 | session_shutdown 触发 sweepNow（退出清理） | 自动化(integration) | 同上：调用注册的 shutdown 回调 | terminate 发出；sweeper 已 stop |
| A8 | 重构无回归：pruneWarmHosts 既有惰性调用点行为等价 | 自动化(全量) | `node --test test/*.test.mjs`（基线 409+ 含既有失败清单） | 与修复前基线一致，无新增失败 |
| U1 | 真实场景回收 | 用户实测 | 开会话→attach→detach→设 `AGENT_BOARD_WARM_HOST_TTL_MS=10s` + `AGENT_BOARD_SWEEP_INTERVAL_MS=5s`→观察 | TTL 过后 host.json 变 exited，runner/child 进程退出，dashboard 状态正确 |

## 5. 可测性拆分设计（实现硬约束）

1. **`selectIdleHostsToEvict`**：纯函数，输入 rows + opts，输出淘汰分组；不触盘、不连 socket、不读 process.env（所有阈值参数显式传入）。测试直接构造内存 rows。**边界**：判定逻辑全部在此函数内；`pruneWarmHosts` 只做 IO 编排，不得内联任何判定分支。
2. **`createWarmHostSweeper`**：调度器封装，`sweep` 回调依赖注入；timer 用全局 setInterval（node:test mock timers 可控）。**边界**：不 import service/store；与业务零耦合。
3. **`attachWarmHostSweeperToLifecycle(piLike, deps)`**（index.ts 内接线函数）：接收 `pi`（on 事件注册）与 `deps = { createSweeper, isHostedChild, sweep }`，可注入 fake 断言注册行为。**边界**：index.ts 只调这个函数，不内联生命周期逻辑。
4. **`pruneWarmHosts`**：重构为薄执行层（listRows → selectIdleHostsToEvict → sendHostMessage），原惰性调用点（dispatch/ensureHost/dashboard）签名不变，行为等价（A8 回归保障）。

## 6. 风险与缓解

- 竞态（attach 与 sweep 同时）：graceMs + attach 重连兜底（既有 #48 L3）
- child pi 自杀链：isHostedChild 硬跳过（A6 覆盖）
- 多宿主并发 sweep 重复 terminate：terminate 幂等（sendHostMessage 失败静默、runner 已死则 socket error 吞掉）
- sweep 与 archive/stop 竞态：单进程内同 service 数据视图，均 fire-and-forget，最坏重复 terminate（幂等）

## 7. 测试计划摘要

- 新增 `test/warm-host-sweeper.test.mjs`：A1-A5（unit，含 mock timers）
- 增补 `test/service.test.mjs`：A6-A7（integration，net 假 server 捕获 terminate）
- 全量回归：A8
- U1 用户实测清单写入 PR 描述与 issue 评论
