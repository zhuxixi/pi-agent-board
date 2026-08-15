# Spec: screen.log Startup GC（startup 回收 ended view 的 screen.log）

- Issue: zhuxixi/pi-agent-board#1
- Date: 2026-08-15
- Status: draft（待 review）

## Background（来自调研，证据已评论到 issue）

上游 PR #41（commit `ee3780a`，2026-08-03 合入）已给**写路径**加上界：
`appendBoundedScreenLog()` 超过 `SCREEN_LOG_MAX_BYTES`（5 MB）时原子 compact 成
100 KB tail；runner 启动时 `reconcileScreenLog()` 压存量。本机验证（2026-08-15）：
活跃 view 的 screen.log 最大 3.9 MB，cap 工作正常。

**残留缺口（本 spec 的 scope）**：

1. ended view 的 screen.log 无人回收——`reconcileScreenLog` 只在该 view 的
   pty-runner 重启时触发；session 结束后 runner 不再运行，文件永久留存。
   本机 views 目录仍有 1.6 GB 历史存量。
2. 全仓无 retention/prune/GC 机制（ended view 目录永久保留）。
3. `SCREEN_LOG_MAX_BYTES` / `SCREEN_LOG_REPLAY_BYTES` 硬编码，不可配。

## Goals

- Dashboard 启动时异步回收：ended 超龄 view 的 `screen.log` 被删除（unlink）。
- 两个配置项写入 `launch-prefs.json` 即生效：
  - `screenLogRetentionDays`（默认 7；**0 = 关闭 GC**）
  - `screenLogMaxSize`（默认 5 MB；透传给 pty-runner 写路径的 cap）
- 全程容错：GC 任何失败不得影响 dashboard 或 runner。

## Non-goals

- 不做 log 轮转（screen.log → screen.log.1）。写路径已有 cap + tail compact，轮转与其重叠（YAGNI）。
- 不做压缩（.gz）。
- 不删整个 view 目录；保留 `meta.json` / `state.json` / `evidence.json` 等 KB 级文件，dashboard 历史行不丢。
- 不动 job-runner 路径（它不写 screen.log）。
- 不引入防抖/状态持久化（扫描成本可忽略，每次启动都跑）。

## Design

### 新模块：`src/core/screen-log-gc.mjs`

单一职责，导出 `pruneScreenLogs(root, opts)`：

- 扫描 `<root>/views/view_*/`。
- 对每个 view，判定清理条件（全部满足才删）：
  1. `screen.log` 存在且非空；
  2. view 已结束——`host.json` 的 `endedAt` 非 null（首选依据），
     或 `host.state !== "alive"`；host.json 缺失/损坏时 fallback 用
     screen.log 的 mtime 判定年龄；
  3. 结束时间（或 mtime）早于 `now - retentionDays`。
- 满足条件 → `unlinkSync(screenLog)`。失败静默（单文件失败不中断整体扫描）。
- **活跃 view 一律跳过**：runner 持有 `screenLogBytes` 内存计数，外部动活跃
  文件引入 race；活跃 view 由 `appendBoundedScreenLog` 的 cap 自管。
- fs 操作沿用 `screen-log.mjs` 的可注入 fs 模式（defaultScreenLogFs），便于单测。
- 返回统计 `{ scanned, removed, skippedActive, skippedFresh, bytesReclaimed, errors }`，
  供可选的 diagnostics 记录。

### 触发点：`src/runtime/service.mjs`

- service 初始化时 fire-and-forget 调 `pruneScreenLogs()`（不 await、不阻塞首帧；
  几百个 view 的 stat 扫描 <10ms，实际删除走 unlink，足够快）。
- 整个调用包 try/catch，异常静默；可选把统计 append 到 diagnostics.jsonl。

### 配置读取：`launch-prefs.json`

新增两个字段（缺省用默认值，向后兼容旧 prefs 文件）：

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `screenLogRetentionDays` | number | 7 | ended 超过该天数的 view 清理 screen.log；0 = 关闭 GC |
| `screenLogMaxSize` | number | 5_000_000 | pty-runner 写路径 cap（字节），透传进 HostConfig → `appendBoundedScreenLog(opts.maxBytes)` |

- 非法值（负数、NaN、非数）回退默认值。
- `screenLogMaxSize` 传递链路：service 读 prefs → 写入 pty-runner 的 HostConfig
  JSON → runner `appendBoundedScreenLog(screenLog, data, bytes, { maxBytes })`。
  `appendBoundedScreenLog` 已支持 `opts.maxBytes`，runner 侧只需读取并透传。

### Error handling

- GC 整体 fire-and-forget + try/catch；单 view 失败跳过继续。
- host.json 读取失败 → mtime fallback；两者都失败 → 跳过该 view。
- prefs 读取失败 → 全默认值（不影响现有 launch-prefs 逻辑）。

### Testing

新增 `test/screen-log-gc.test.mjs`（沿用现有 test 风格与可注入 fs）：

1. ended 超龄 view → screen.log 被删，meta/state 等文件保留。
2. 活跃 view（host.json `state: "alive"` 且 endedAt null）→ 不删。
3. ended 但未超龄 → 不删。
4. `screenLogRetentionDays: 0` → 全部不删。
5. host.json 缺失 → mtime fallback 正确判定。
6. `screenLogMaxSize` 经 HostConfig 透传到 runner cap（runner 侧单测或链路断言）。
7. 单文件 unlink 失败不中断其他 view 的清理。

## Data flow

```
/dashboard 打开
  └─ service init
       └─ (async, fire-and-forget) pruneScreenLogs(root, prefs)
            ├─ scan views/view_*/
            ├─ per view: ended? aged? → unlink screen.log
            └─ return stats → (optional) diagnostics.jsonl
```
