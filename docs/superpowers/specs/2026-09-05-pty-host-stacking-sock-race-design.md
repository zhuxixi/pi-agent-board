# Issue #70 Spec v4：pty 宿主堆叠与 `control.sock` 互删修复

日期：2026-09-04  
修订：R8（根据 spec review 采用独立 socket + owner fencing 方案）  
状态：待用户确认

## 0. 方案结论

原方案试图继续复用固定 `control.sock`，再用 `probe → unlink → listen` 消除竞争；review 证明这仍然存在 TOCTOU（检查与删除之间的时间窗口），而且无法可靠处理旧 runner 的迟到清理。本版改为：

1. **每个 host instance 使用独立 socket/pipe 路径**，新 runner 永远不删除共享固定路径；
2. **per-view `host-start` lease** 串行化“是否启动”的决策；
3. **`instanceId` fencing** 保护 `host.json`、`host-pid.json`、终态和 cleanup；
4. **bind-before-child**，runner 只有取得当前 instance 的 socket ownership 后才创建 child Pi；
5. **真实 connect + hello probe** 只用于 attach/健康判断，不用于盲目删除 socket；
6. **revoke → 等待旧 runner/child 退出 → replacement**，禁止 SIGTERM 后立即重启。

这套方案直接消除“旧 runner 删除新 runner 的同一路径 socket”这一类竞态，而不是在共享路径上增加更多防守性判断。

## 一、目标与边界

### 1.1 目标

修复同一 `root + viewId` 上多个 PTY host 并发启动、互相删除 `control.sock`、并发写同一个 Pi session JSONL，最终导致 attach 永久失败的问题。

本期必须保证：

- 同一 view 的并发 `ensureHost()` 最终只产生一个 active host instance；
- runner 在 bind 自己的 socket 前不创建 child Pi；
- 新 runner 使用独立 socket，旧 runner 的退出不会删除新 runner 的 socket；
- service、runner、crash handler 的迟到写入不能覆盖当前 owner；
- 并发 launch 不共享可被覆盖的 `host-config.json`；
- attach 对 cold start、stale host、revoke/recovery 有明确的 ready、等待或安全 pending 结果；
- service 生成的 reply/follow-up prompt 在未确认送达时不会静默丢失。

### 1.2 平台策略

- **Linux**：本期自动恢复、并发和现场复现的主验收平台。
- **macOS**：使用相同的 instance/lease/probe 协议；如果无法取得稳定的进程启动身份，只做 cooperative revoke，不做强制 signal，返回 `recovery_pending`。
- **Windows**：每个 instance 使用独立 named pipe；不使用 `existsSync` 判断 pipe 健康，不调用 `unlinkSync` 清理 pipe。进程身份无法确认时不强制 signal。没有 Windows/WSL2 实机时，U2 必须标记 `pending`。

### 1.3 非目标

- 不改 Pi session JSONL 格式，不修复已经发生的历史文件损坏。
- 不做全仓库 `fs/promises` 异步化。
- 不改 dashboard 渲染器、PTY attach jiggle、detach gate。
- 不使用 `SO_REUSEADDR` 解决 Unix socket 竞争。
- 不管理绕过 agent-board 协议、直接占用路径的外部 listener；对外部 listener 只做保守识别和诊断。
- 不对 legacy runner 做盲杀或盲目删除固定 `control.sock`。
- 不把 attach 面板中的普通键盘输入改成 exactly-once 消息；可靠 ack 只覆盖 service 生成的 prompt。

## 二、已确认根因

1. `src/core/store.mjs` 的 `hostAlive` 只看 `host.json.state` 和 runner PID，不验证 socket 是否可连接。
2. `runner/pty-runner.mjs` 启动前无条件删除固定 `control.sock`；并发 runner 会使其他 listener 变成无路径 inode。
3. runner shutdown 无条件删除同一路径，旧 runner 可以删除新 runner 的 socket。
4. `service.mjs` 在 spawn 后写固定 `host.json`/`host-pid.json`，并发 service 会覆盖 owner 元数据。
5. `src/core/launch.mjs` 使用固定 `host-config.json`，并发 launch 可能让 runner 读取另一个 launch 的 prompt/cwd/model。
6. 正常 child exit 直接退出，跳过统一 socket cleanup，导致死 socket 残留。
7. `attachTarget()` 把同步元数据查询当成 socket 健康检查；UI 可能拿着死路径重试很久，再触发重复启动。

## 三、生命周期硬不变量

以下条款是实现和验收的硬约束：

1. **单 active claim**：同一 `root + viewId` 同时最多一个新协议 host instance 是 active；旧 instance 未安全结束时不能创建 replacement。
2. **独立 endpoint**：每个 instance 的 socket/pipe 路径包含 instance token；新 instance 不复用旧 instance 的 endpoint。
3. **先 bind、后 child**：runner 在 `host-start` lease 内成功 bind 当前 instance endpoint 前，不得 spawn child Pi。
4. **owner-only write**：只有当前 `instanceId` 才能写 host 状态、heartbeat、终态、host-pid 镜像和自己的 endpoint cleanup；失去 owner 的旧 runner 必须停止写入并关闭 child。
5. **starting 是正常中间态**：`runnerPid:null`、`childPid:null` 或 socket 尚未出现，在 grace/launch transaction 内都不能被当作 orphan。
6. **真实健康结论**：路径存在、host state 为 alive、PID 存活都只是 hint；attachable 必须由真实 connect + 合法 hello/status 证明。
7. **先停止再替换**：旧 runner/child 未确认退出前，不得创建 replacement child；不能 SIGTERM 后立即 relaunch。
8. **安全终止**：不能仅凭 PID 发终止信号；只有 process identity 明确属于目标 instance 时才允许 signal。
9. **配置隔离**：每个 instance 从独立 config 文件读取；任何 runner 不得读到另一个 instance 的 prompt/cwd/model。
10. **prompt 不丢失**：service prompt 在收到 runner `input_ack` 前必须保留在 durable queue/launch intent 中；连接建立不等于发送成功。

## 四、数据模型与路径

### 4.1 `HostStatus`

`HostState` 扩展为：

```text
starting | alive | stopping | exited | failed
```

新协议 `host.json` 在现有字段上增加：

```json
{
  "instanceId": "<128-bit-random-hex>",
  "socketPath": ".../control.<instanceId>.sock",
  "configPath": ".../host-config.<instanceId>.json",
  "claimAt": 1786114800000,
  "claimPid": 123,
  "claimIdentity": { "pid": 123, "startToken": "..." },
  "runnerPid": null,
  "runnerIdentity": null,
  "runnerSpawnedAt": null,
  "childPid": null,
  "childIdentity": null,
  "childSpawnedAt": null,
  "readyAt": null,
  "stopRequestedAt": null,
  "revokeToken": null,
  "stopReason": null
}
```

约束：

- `instanceId` 是唯一 owner/fencing token，每次新 host launch 必须重新生成。
- `socketPath` 必须从 instance 生成，不能再使用新协议的固定 `control.sock`。
- POSIX 路径建议为 view 目录下的 `control.<instanceId>.sock`；Windows pipe 名称必须由 `viewId + instanceId` 生成且不超过平台长度限制（可使用固定长度 hash）。
- `configPath` 必须是 instance-specific；旧固定 `host-config.json` 只保留 legacy 读取兼容。
- `runnerPid`/`childPid` 仅用于展示和低成本 liveness hint，不能单独代表 owner 或作为 kill 依据。
- `runnerSpawnedAt:null` 表示 service 尚未确认 runner spawn；非空但 identity 缺失表示“已尝试 spawn、当前无法观测”，不能当作 dead。
- `childSpawnedAt:null` 表示 child 尚未创建；非空但 identity 缺失同样不能当作 dead。
- `readyAt` 只有 endpoint bind、child 创建成功、instance fencing 仍匹配后三个条件同时满足时才写入；`state:"alive"` 必须与非空 `readyAt` 同时成立。
- `state:"stopping"` 是 replacement barrier：revoke 到旧 runner/child 退出、终态写入和 endpoint cleanup 结束前，任何 caller 都不得创建 replacement。
- `host-pid.json` 改为镜像 `{ pid, instanceId, identity, at }`；新协议以 `host.json` 为权威，镜像失败只记诊断。

### 4.2 旧路径兼容

- 没有 `instanceId` 的 legacy host 仍可使用固定 `control.sock`（或旧 named pipe）进行 probe/attach。
- 新协议 host 不再绑定 legacy 固定路径，因此 stale legacy socket 不会阻塞新 host；新 recovery 不盲目删除 legacy socket。
- `loadRow()` 只有在 `host.json` 不存在或缺少 `runnerPid` 属性时才回退读取 legacy `host-pid.json`；属性存在且为 `null` 时不得被旧镜像覆盖。

### 4.3 进程身份

统一使用五态：

```text
not_started  对应角色明确从未成功 spawn（spawnedAt 为 null）
dead          记录的 PID 已不存在
owned         PID 存活且稳定 startToken 与记录一致
foreign       PID 存活但 startToken 明确不一致（PID 已复用）
unknown       无法取得稳定身份或读取失败
```

实现要求：

- Linux 的 `startToken` 从 `/proc/<pid>/stat` 读取；读取异常返回 `unknown`，不能猜测 dead。
- macOS/Windows 使用可注入 adapter；adapter 无法给出稳定 token 时返回 `unknown`。
- 只有 `owned` 才允许 `signalOwnedProcess(identity, signal)`；`dead`/`foreign` 不发信号；`unknown` 返回 `recovery_pending`。
- 进程身份观测只在 launch、runner startup、recovery 等低频路径调用，不进入 dashboard 700ms 轮询。

### 4.4 派生行状态

保留 `row.hostAlive` 兼容旧 UI，但重新定义为“host 处于 starting/alive 且 PID hint 存活”，不表示 attachable。新增：

- `row.hostActive`：host 存在且 state 为 starting/alive/stopping；表示存在不可重复启动的 claim。
- `row.hostReady`：`hostActive && state === "alive" && readyAt != null`；只是显示优化 hint，不替代 probe。
- 所有“能否 attach/能否替换”的判断必须使用 host state、lease、process observation 和 probe，不能只看 `hostAlive`。

## 五、跨进程 lease 与 owner-aware 写入

### 5.1 `host-start` lease

在 `src/core/locks.mjs` 增加 host 专用 owner-safe lease API，保留现有 `withFileLockSync()` 的旧语义和测试：

```js
acquireOwnedViewLock(root, viewId, name, { waitMs, identity })
  -> { token, touch(), isOwner(), release() }
tryAcquireOwnedViewLock(root, viewId, name, { identity })
  -> { acquired: true, lease } | { acquired: false, reason: "busy" | "blocked" }
```

host 使用两个锁名：

- `host-start`：是否启动、claim、endpoint bind、child startup 和 replacement barrier；
- `host-meta`：短时 host.json compare-and-write。

锁必须满足：

1. **完整 owner 原子发布**：先在唯一 sibling candidate 目录写入 `owner.json`，再用同文件系统 `rename(candidate, lockPath)` 发布；其他进程不能观察到“已 acquired 但没有 owner record”的半成品 lock。
2. `owner.json` 至少包含 `token`、`pid`、`identity`、`startedAt`；heartbeat 写入 owner-specific 文件 `heartbeat.<token>`，旧 token 不能更新 canonical owner record。
3. `touch()`、`isOwner()`、`release()` 都以 token fencing；旧 lease 的迟到操作不能修改或删除新 lease。
4. stale reclaim 禁止直接 `rmSync(originalLockPath)`：只有 owner identity 明确为 `dead` 时，回收者才可把原 lock 目录原子 rename 到带自身 token 的 quarantine 路径，再只删除自己的 quarantine；rename 失败必须重新读取并重试。
5. heartbeat 超时本身不能抢占仍活着的 owner；identity 为 `unknown`、owner 文件损坏或缺失时返回 `blocked`，记录 recovery diagnostic，不能凭年龄盲删。
6. `host-start` lease 可以跨越异步 `server.listen()` 和 child startup；每秒 touch，所有成功、失败、异常路径清理 timer 并 release。
7. `host-meta` 只做短临界区；锁顺序固定为 `host-start → host-meta`，禁止反向嵌套。
8. dashboard prewarm 使用 try-acquire 或 `waitMs <= 50`；争用返回 pending，不阻塞 UI、不重复 spawn。

`host-start` lease 同时是 launch transaction 的边界：

- provisional claim 在 lease 持有期间不可替换；
- service 在释放 lease 前必须记录 runner spawn 成功或失败；
- 如果 service 在 spawn 前后崩溃，后续 caller 只需确认 lease 已结束、旧 runner/child 的 instance observation 安全，即可恢复；不能仅因为 `claimPid` 进程还活着就永久阻塞。

### 5.2 `claimHost()` 与 `updateOwnedHost()`

```js
claimHost(root, provisionalHost, { heldStartLease })
updateOwnedHost(root, expectedInstanceId, mutate, { heldStartLease? })
```

`claimHost()`：

1. 在 `host-meta` lock 内重新读取 host；
2. 用 `canReplaceHost()` 判断当前 runner、child 和未完成 launch transaction 是否可回收；`null/unknown` 不得当作 dead；
3. 成功后写新 instance 的完整 provisional record，清除旧 runner/child/ready/stop 字段；
4. 原子写 host.json，再 best-effort 写 host-pid 镜像；
5. 只能在 host-start lease 内被 service 调用，不能在锁外覆盖 host。

`updateOwnedHost()`：

1. 未持有 start lease 时获取短 host-meta lock；已持有时按 `host-start → host-meta` 顺序获取；
2. 在锁内重新读取 host.json；
3. 只有 instance 匹配才执行 mutate；当前 owner 自己可以推进 stopping/终态，但 instance 已变化时必须拒绝；
4. 原子写回 host.json，再按同一 token 规则 best-effort 更新 host-pid 镜像；
5. owner mismatch、host 缺失或已被新 instance 接管时返回 `{ updated:false, ownerChanged:true }`，旧 caller 必须停止 heartbeat、关闭资源并退出。

生产 service、runner、crash finalizer 禁止直接用旧快照调用 `writeHost()`；`writeHost()` 仅用于 migration 和测试 fixture。

## 六、host 启动协议

### 6.1 service 两阶段 launch

内部 host launch 统一返回：

```js
{ ok: true, status: "started", pid, socketPath, instanceId }
{ ok: true, status: "pending" | "reused", pid: null, socketPath, instanceId }
{ ok: false, error, fallbackReason? }
```

在 `host-start` lease 内：

1. 重新读取 host；`starting/alive/stopping` 都返回 pending/reused，不生成新 instance、不写新 config、不 spawn。
2. 对 `exited/failed` 执行 `canReplaceHost()`；runner、child 和 launch transaction 必须为 `not_started/dead/foreign`，任何 unknown 返回 pending。
3. 生成 instanceId、独立 socketPath、独立 configPath；原子写 config（包含 viewId、instanceId、socketPath、claim identity、initial prompt）。
4. 调 `claimHost()` 写 provisional starting record：`runnerPid:null`、`childPid:null`、`readyAt:null`。
5. 调整 `src/core/launch.mjs`，使用该 instance-specific config path spawn runner；固定 `host-config.json` 不再用于新协议。
6. spawn 返回后，在仍持有 lease 且 instance 未被 revoke 的条件下，用 `updateOwnedHost()` 合并写入 runner PID/identity/`runnerSpawnedAt`；不能用完整旧快照覆盖 runner 已写字段。
7. spawn 抛错或返回 `pid:null` 时，仅在 instance 仍匹配的情况下标记 failed、保留/转移未消费的 initial prompt，并删除自己的 config。
8. release lease 后只追加一次 `launch_host` diagnostic；pending/reused 不追加重复 launch 诊断、不重复 `markQueued`。

调用方规则：

- `dispatch`：initial prompt 绑定到本次 launch intent；只有 host ready 后才标记 intent consumed，启动失败时可重新入队。
- `reply`/`drainNextFollowUp`：pending/reused 或 host 未 ready 时保留 queue item；未收到 `input_ack` 时 release/重入队，不能标记 completed。
- `ensureHost/prewarm`：只创建无 initial prompt 的 warm host；pending 是已有 claim/launch，不是失败。

### 6.2 runner bind-before-child

`runner/pty-runner.mjs`：

1. 读取独立 config，校验 viewId、instanceId、socketPath；在 ownership decision 前不得 spawn child、删除任何 socket 或调用初始 host persist。
2. 获取同 view 的 `host-start` lease；在 lease 内重新读取 host：
   - host 缺失、instance 不匹配、state 已终态 → 记录 diagnostic，退出，不创建 child；
   - 当前 instance 是自己的且未 stopping/revoked → 继续；
   - 当前 instance 正在 stopping/revoked → 受控退出，不创建 child。
3. **新协议不做 startup unlink，也不探测/删除共享固定路径**：socketPath 已由 instance 唯一化。如果自己的 endpoint 路径已存在、类型不对或 `listen` 返回 EADDRINUSE，记录明确错误并退出；不能删除该路径。
4. 创建 server 并 listen 自己的 socketPath；直到 callback/error 被启动协调器处理完都持有 lease。listen 成功后 POSIX 记录 `boundSocketIdentity={dev,ino}`。
5. 通过 owner-aware update 写 runner identity，保持 `state:"starting"`；安装完整 server/client handlers。
6. **此时才 spawn child Pi**。child spawn 失败走统一 finish，不发布 ready。
7. child 创建成功后记录 child identity/`childSpawnedAt`，再次检查 instance/revoke；不匹配或 stopping 时立即 finish，不发布 ready。
8. owner 仍匹配时写 `childPid`、`childIdentity`、`state:"alive"`、`readyAt`，再 release host-start lease，开始 heartbeat。

多个 runner 同时启动时，即使 service 层发生异常：

- 只有当前 host record 对应的 instance 能继续；
- 同一 endpoint 最多一个 runner 能 bind；bind loser 在 child 创建前退出；
- 由于 endpoint 按 instance 隔离，旧 runner 不可能通过 cleanup 删除新 instance 的 endpoint。

### 6.3 starting 协议

bind 到 child ready 之间允许 probe/attach 连接，但 child 为 null 时必须安全：

- hello/status 返回 `state:"starting"`、instanceId 和 `readyAt:null`；
- `resize` 只保存最后一次尺寸，child ready 后应用；
- service-generated `input`/`interrupt` 返回带 requestId 的 `host_starting` error，不访问 null child；
- child ready 后广播 `state:"alive"` 和 `readyAt`；resolver 只接受匹配 instance 且 ready 的 hello。

## 七、真实 probe 与 attach API

### 7.1 `probeHost()`

新增 `src/core/host-probe.mjs`：

```js
probeHost(socketPath, {
  timeoutMs,
  expectedViewId,
  expectedInstanceId,
  connect
}) -> Promise<{
  classification: "ready" | "starting" | "stale" | "occupied" | "missing" | "unknown",
  connected: boolean,
  protocolValid: boolean,
  ready: boolean,
  viewId: string | null,
  instanceId: string | null,
  state: string | null,
  errorCode: string | null
}>
```

规则：

- 通过真实 `createConnection()`，读取合法 JSONL hello/status，必要时发送 probe hello；成功后关闭 probe socket。
- 新协议下只有 viewId/instanceId 匹配、state 为 alive、readyAt 非空才返回 ready。
- 合法但 state 为 starting → starting/occupied，不是 stale。
- view/instance 不匹配 → occupied，绝不删除 endpoint。
- `ECONNREFUSED`、`ENOENT`、timeout、普通文件/目录、协议非法分别保留 errorCode；它们只用于 recovery 分类，不直接 unlink。
- Windows named pipe 同样走真实 connect；不以 existsSync 恒真/恒假推断 ready。
- `existsSync` 最多作为 POSIX cheap negative hint，不能产生 `ready:true`。

### 7.2 `resolveAttachTarget()`

新增唯一的异步 attach 前置：

```js
resolveAttachTarget(viewId, { timeoutMs = 120000 }) -> Promise<
  { kind: "pty", socketPath, sessionFile, instanceId } |
  { kind: "session", sessionFile } |
  { kind: "pending", sessionFile, reason } |
  { kind: "missing" }
>
```

算法：

1. 每轮重新读取 row/host；同一 service 实例对同一 view 的并发 resolver 合并为一个 in-flight Promise。
2. 没有 host claim 且没有 live JSON runner 时，调用一次 `ensureHost()`；PTY 明确不可用才返回 `session`。
3. 对 starting/alive host probe 当前 `socketPath`；只有匹配 instance 且 classification=`ready` 才返回 pty。
4. starting 未超过 `HOST_START_GRACE_MS`、probe=`starting/occupied` 或 lock 忙时按 150ms 重试，不 spawn 第二个 host。
5. grace 后 probe 仍失败，调用 `recoverHost(viewId, expectedInstanceId)`；recovery 已进入 stopping 时只等待，不重复 revoke。
6. recovery 只有在旧 runner、child 和未完成 launch transaction 都是 not_started/dead/foreign 后才允许新 claim；任何 unknown 返回 pending。
7. 新 host 启动后继续 probe，直到 ready 或 timeout。
8. timeout 且旧 host/child 仍可能存活时返回 pending，不能降级为 session；只有确认没有 active host/child 时才允许 session switch。
9. 没有 host 但 live JSON runner/queued run 仍存在时保留 `isAgentBusy` 保护；stopFirst 未完成时返回 pending/reason，不另起 PTY child。

`src/commands/attach-flow.ts` 和 `src/commands/agent-board.ts` 的 attach 流程只调用一次 resolver：

- pty → 打开 `PtyAttachComponent`；
- session → 现有 session switch；
- pending → 显示 reason，留在 dashboard；
- missing → 现有 warning。

### 7.3 `attachTarget()` 与 dashboard

`attachTarget()` 保留为无副作用同步 hint：不 spawn、不 kill、不 probe、不改文件；生产 attach 路径禁止把它当健康检查。

现有 `row.alive && !row.hostAlive` 的 attach 前置必须改为区分 `hostActive`、live JSON runner 和 stopFirst，不能把 starting host 当成普通无 host runner。

`prewarmHost()` 调 `ensureHost()`；收到 pending 或观察到 hostActive 时视为已有 launch，不重复 prewarm。`reconcile()` 在 grace 内不把 starting 标成 failed；stopping 不得被当作可重启。

## 八、revoke、恢复与输入可靠性

### 8.1 `requestHostStop()`

```js
requestHostStop(viewId, expectedInstanceId, reason)
  -> { ok: true, requested: boolean } | { ok: false, error }
```

步骤：

1. 获取 host-meta lock，重新读取 host，确认 expected instance 未变化；
2. 写 `state:"stopping"`、`stopRequestedAt`、随机 `revokeToken` 和 reason；
3. release；不直接 signal、不启动 replacement；socket 健康时可以额外发 terminate 作为优化。

runner 在 starting/alive/stopping 状态每秒读取 host record：

- 同 instance 且发现 revoke → 停止接受新 service input，进入 finish；
- instance 已变化 → 视为失去 owner，关闭自己的 server/client/child，禁止写新 owner 状态；
- 无 revoke → 正常 heartbeat。

### 8.2 `recoverHost()`

`recoverHost(viewId, expectedInstanceId)` 只由显式 attach resolver 或 recovery-aware reconcile 调用：

1. 获取 host-start lease并 re-read；owner 已变化、probe 已恢复或 state 已终态时放弃本次 recovery。
2. 在 host-meta 临界区以 expected instance 写 stopping/revoke，然后释放 host-start lease；不能持有 start lease 等待旧 child，否则旧 runner无法完成协作退出。
3. 在 `HOST_RECOVERY_GRACE_MS = 5000` 内轮询 host 与 runner/child/launch transaction observation，等待各角色变为 not_started/dead/foreign。
4. 仍为 owned-live 时，每次 signal 前重新取得 host-meta lock 确认 instance 未变化，再调用注入的 `signalOwnedProcess()`；等待 bounded escalation window。
5. identity unknown 时不发送信号、不启动 replacement，返回 `recovery_pending`；foreign 视为原目标已结束，不向该 PID 发信号。
6. 旧 runner/child/launch transaction 都安全结束后，再取得 host-start lease，以 expected instance 做 CAS；确认仍是 stopping 后创建一次新 provisional claim。
7. 新 instance 使用自己的独立 socket/config；recovery 本身不得在锁外 unlink 任何 endpoint。

整个恢复流程禁止“SIGTERM 后立即 relaunch”。无法安全确认时宁可 pending，也不制造双 child 或误杀无关进程。

### 8.3 service prompt 投递

新增 `sendHostInput()`，取代 service 对当前 fire-and-forget `sendHostMessage()` 的成功判断：

- 所有 service-generated reply/follow-up 先以 durable queue item 存储；queue item id 作为 requestId，再尝试发送；
- runner 收到 `{type:"input", requestId, data}` 后，只有确认 child 存在并完成 `child.write()` 才回复 `input_ack`；ack 表示 runner 已接受，不表示 Pi 已完成处理；
- runner 在同一 instance 生命周期内维护有界 requestId 去重表；重复 requestId 只重发 ack，不再次写 child；跨 host restart 不宣称 exactly-once；
- starting/stopping、connect error、timeout、`host_starting` 或非 ack 都视为未确认；queue item 保持 claimed 或 release/requeue，不能标记 completed；
- `drainNextFollowUp()` 只有收到 ack 才 complete；`reply()` 也必须经过同一 durable delivery wrapper，不能绕过 queue 直接返回成功；
- attach 面板中的普通键盘输入保持现有交互协议，不纳入本 ack 机制。

## 九、runner cleanup 与 crash

### 9.1 统一 `finishHost()`

新增幂等 `finishHost(reason, exitCode, activeLease?)`，覆盖：

- child 自然退出；
- control protocol terminate；
- runner SIGTERM/SIGINT；
- child error；
- server error；
- uncaughtException；
- owner revoke/lost。

若 startup/cleanup 已持有 host-start lease，必须传入该 lease，不能隐式再次 acquire 同一路径。

finish 顺序：

1. 设置 `shutdownStarted`，停止接受新 input；若仍是 owner，先 owner-aware 写 stopping；
2. 停止 heartbeat，结束/销毁 clients，再 `server.close()` 并等待 close（有界）；
3. 等待 child 退出；必要时只对 identity=`owned` 的 child 做 escalation；child 未确认退出前保持 replacement barrier；
4. 若仍是 owner，owner-aware 写最终 `exited/failed`、清空 child PID/ready/revoke 字段；owner 已变化则跳过旧状态写入；
5. 调用 `cleanupOwnedSocket()`：POSIX 只有当前路径 `stat.dev/ino` 与本 instance bind 时记录的 identity 相同，且 owner token 仍匹配，才 unlink；路径不存在或 identity 不匹配都 no-op；Windows 不调用 unlink；
6. 删除当前 instance 的 config（若其中仍有未消费 prompt，先保留/转移 launch intent）；release lease 后再 `process.exit()`。

### 9.2 crash 与自然退出

- `src/core/host-crash.mjs` 接收 expected instance，调用同一 owner-aware finalizer 和 endpoint cleanup；禁止直接 `writeHost()`/`unlinkSync()`。
- uncaughtException handler 必须进入有界 finish 流程，不能写 failed 后 50ms 直接退出而跳过 cleanup；最终超时记录 cleanup-pending diagnostic，只对 identity=`owned` 的 child 做最后 escalation。
- child 自然退出必须经过 finish，不能保留当前“50ms 后直接 exit、跳过 cleanup”的路径。
- 新协议 endpoint 按 instance 隔离，因此旧 runner 的 cleanup 即使迟到，也不能删除新 instance endpoint。

## 十、实现边界与可测性拆分

### 10.1 必改模块

- `src/core/types.mjs`：HostState 增加 stopping；HostStatus/Row 增加 instance、active/ready、identity、spawnedAt 字段。
- `src/core/paths.mjs`：增加 `hostConfigPathFor(root, viewId, instanceId)` 和 instance-specific socket/pipe path；保留 legacy path。
- `src/core/locks.mjs`：增加完整 owner 原子发布、token-safe touch/release、dead-owner quarantine、try-acquire；保留旧 API。
- `src/core/launch.mjs`：支持 instance-specific host config path。
- `src/core/store.mjs`：修正 host-pid fallback，派生 hostActive/hostReady，提供 `claimHost/updateOwnedHost` owner-aware 入口。
- 新增 `src/core/host-coordination.mjs`：状态、grace、replace、identity、endpoint ownership 纯决策。
- 新增 `src/core/host-probe.mjs`：POSIX socket/Windows pipe connect + JSONL hello probe。
- `src/runtime/service.mjs`：两阶段 launch、幂等 ensure、revoke/recovery、async resolver、durable prompt delivery。
- `runner/pty-runner.mjs`：instance-specific endpoint、lease-protected bind-before-child、starting 协议、owner-aware persist、统一 finish/cleanup、input ack。
- `src/core/host-crash.mjs`：expected-instance owner-aware finalize。
- `src/commands/attach-flow.ts`、`src/commands/agent-board.ts`：只使用 async resolver，移除旧的 hint→ensure 重复路径。
- `src/ui/dashboard.ts`：识别 hostActive/pending，避免重复 prewarm，并调整 starting host 的 attach 前置判断。

### 10.2 纯函数边界

`src/core/host-coordination.mjs` 只接收快照，不触达 I/O：

- `sameHostOwner(host, expectedInstanceId)`；
- `isStartingWithinGrace(host, now, graceMs)`；
- `processIdentityState(expected, observed, spawnedAt)`；
- `canReplaceHost({ host, runnerObservation, childObservation, launchObservation, startLease })`；
- `ownsEndpoint(bound, current)`；
- `classifyProbeResult(rawResult)`；
- `shouldYieldRunner({ host, instanceId })`；
- `shouldAcceptInput(host)`；
- `shouldRetryBind(errorCode, attempt)`。

每个函数只接收快照并返回决策；测试边界不包含 fs/net/process.kill/timer。

副作用隔离：

- probe 注入 `connect`、clock、timeout；真实 net 只在 integration 测试触达；
- lease 注入 fs、identity reader、clock、sleep；
- owner update 注入读写函数，单测覆盖 compare-and-write 及 owner 变化窗口；
- signal 注入 identity reader 和 signal 函数，unknown/foreign 的 signal 调用数必须为 0；
- service 注入 clock/random/launch/lock/probe，ensure 单测不启动真实进程；
- runner 的 server、child、stat、cleanup、自然退出和 crash 在 integration 覆盖；
- queue delivery 注入 ack/timeout，测试 requestId 去重、失败回放和单次 complete。

## 十一、验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | host 状态、owner、grace、identity 决策 | 自动化（unit） | `node --test test/host-coordination.test.mjs` | starting（含 runnerPid:null）、not_started/dead/owned/foreign/unknown、replace 条件全部通过 |
| A2 | owner-safe lease | 自动化（unit） | `node --test test/locks.test.mjs` | candidate 原子发布、活 owner 不被抢、dead owner quarantine、unknown blocked、旧 token 不能 touch/release 新 lock，回收不会删除新 lock |
| A3 | instance config/endpoint 隔离 | 自动化（unit/integration） | `node --test test/launch.test.mjs test/paths.test.mjs` | 两次 host launch 的 config/socket path 不同；prompt/cwd/model 不串线；Windows pipe 名称满足长度约束 |
| A4 | service claim 与 ensure 幂等 | 自动化（unit） | `node --test test/service.test.mjs` | starting + runnerPid:null/存活且未超 grace 不 kill/不 spawn；lease busy 返回 pending；只产生一次 launch diagnostic；launch transaction 结束后可安全恢复 |
| A5 | 真实 socket/pipe probe | 自动化（integration） | `node --test test/host-probe.test.mjs` | ready/starting/stale/missing/occupied/unknown 分类正确；普通文件/目录/非法协议不被删除；Windows 不依赖 existsSync |
| A6 | runner bind-before-child | 自动化（integration） | `node --test test/pty-runner.integration.test.mjs`，N 个 runner 同时启动同一 instance config | 只有一个 runner bind 并创建 child；loser 在 child 前退出；winner hello 的 instance/ready 一致 |
| A7 | instance endpoint cleanup fencing | 自动化（integration） | 两个 instance 交错启动/退出，模拟路径替换与迟到 cleanup | 旧 instance cleanup 不影响新 endpoint；当前 owner endpoint 正常退出后无残留；不发生共享路径 unlink |
| A8 | service 跨进程并发 launch | 自动化（integration） | 两个独立 Node helper 同时调用 `ensureHost()`，覆盖 provisional 未 ready 窗口 | 最终一个 instance/runner/child；一个 launch diagnostic；第二 caller 只得 pending/reused；host/config/pid/socket hello 一致 |
| A9 | late write/revoke fencing | 自动化（unit/integration） | 旧 instance 在新 instance 发布后发送 heartbeat/crash/exit；revoke 后迟到写入 | 旧写入全部拒绝；新 host.json、host-pid、readyAt 不被覆盖；stopping 期间不启动 replacement |
| A10 | revoke 后安全替换 | 自动化（integration） | endpoint 不可达但 runner/child 存活；另测 child 忽略 SIGTERM、abandoned starting claim | 先 stopping/revoke，确认旧 runner/child/transaction 可安全回收后才创建新 child；等待期间无双 child；unknown 保持 pending |
| A11 | 全退出路径 cleanup | 自动化（integration） | natural child exit、protocol terminate、runner signal、server error、uncaughtException、owner lost | 当前 owner endpoint 清理；foreign/new endpoint 不被删；host 终态正确；自然退出无残留 |
| A12 | attach resolver 契约 | 自动化（integration） | 新增 `test/attach-flow.test.mjs` 与 service fixture | attach 只调用一次 resolver；starting 等待；stale 可恢复；pending 不切换 session、不重复 ensure；并发 resolver 合并 |
| A13 | prompt ack 与 queue 保留 | 自动化（unit/integration） | 新增 `test/host-input.test.mjs` | 只有 input_ack 才算 runner 接受；starting/connect error/timeout 会 release 或重入 queue；同一 requestId 在同一 host 生命周期内不重复写 child |
| A14 | prewarm/停止幂等 | 自动化（unit） | dashboard fake scheduler + service mock | 连续导航、pending、lock 争用期间最多一个 launch；prune/archive 使用 revoke，不依赖坏 socket |
| A15 | live JSON runner 保护 | 自动化（unit/integration） | 构造无 host 但 live JSON runner/queued state | resolver 不另起 PTY child；stopFirst 未完成时返回 pending/reason |
| A16 | 静态与全量回归 | 自动化（static/build） | `npm run typecheck && npm test` | 类型检查、全部既有和新增测试通过；生产路径没有固定新协议 socket unlink 或绕过 fencing 的 host write |
| U1 | 原始 Linux 堆叠现场 | 用户实测 | 隔离 root 中让两个独立 board/service 进程同时对同一 view 发起 attach/prewarm；观察 `ps`、`ss -xlp`、host.json、diagnostics，再实际 attach | 仅一个 runner/child；attach 成功；旧 runner 不影响新 endpoint；无持续 launch_host 堆叠 |
| U2 | Windows named pipe | 用户实测（有环境才执行） | 同一流程观察 pipe connect、revoke/recovery、runner 数和 filesystem 操作 | 不调用 unlink；活 pipe 可 attach；缺失 pipe 不被 existsSync 掩盖；无环境明确 pending |

## 十二、完成标准与残余风险

只有同时满足以下条件才能宣称 issue #70 修复完成：

1. A1-A16 自动化验收全部通过；
2. U1 已执行并记录实际观察结果；
3. U2 若无 Windows/WSL2 环境，最终报告明确标记 pending；
4. 本地 CR 按矩阵逐项对账，重点核对 A6-A13；
5. 没有未解释的双 child、foreign cleanup、owner mismatch 或 prompt 丢失诊断。

残余风险：

- 新协议不再复用固定 `control.sock`；已经运行的 legacy runner 仍由 legacy 规则管理，无法安全确认身份时会停在 pending。
- `SIGKILL`、机器断电或文件系统故障可能留下旧 instance 的 endpoint/config；它们不会阻塞新 instance，但需要后续受 owner/inode 约束的 GC，不能按路径盲删。
- macOS/Windows 无稳定 process start token 时，自动 recovery 会保守降级，牺牲可用性换取不误杀。
- 外部进程若占用新 instance endpoint，系统按 occupied/unknown 失败并记录诊断，不删除外部路径。
- prompt delivery 只保证 durable at-least-once；同一 prompt 在 host restart 边界可能需要人工确认，不宣称跨 host exactly-once。
