# issue #87 spec：legacy 死 host 安全回收（resolver 自愈）

日期：2026-09-08 · 状态：待用户确认

## 背景与问题

v0.5.x 时代（无 instanceId 协议）的 legacy PTY host，当 runner 进程被异常杀死（SIGKILL / 承载终端关闭）时 host.json 永远停在 `state: "alive"`（或 `"starting"`）。v0.6.0 的 attach resolver 对 legacy host 执行「never recovered」（spec §10.1 保守决策），probe 失败直接 pending，同时 `hostActive`（纯磁盘状态）让 ensureHost 拒绝重新 claim——三层叠加成死锁，attach 永久失败。本机实录 6 个 view 处于该状态。

## 设计目标

resolver 对「pid 可验证已死 + endpoint 不可达」的 legacy host 自动 finalize 为 `exited` 并走正常 ensure/claim 自愈，消除死锁；不满足安全条件时保持现有 pending 行为（不推翻 spec 的保守原意）。

## 核心设计

### D1：纯决策函数 `canFinalizeLegacyHost`（host-coordination.mjs）

```js
/**
 * @param {{ host: HostStatus|null, hostPid: number|null, hostPidAlive: boolean,
 *           probeClassification: string }} input
 * @returns {boolean}
 */
```

返回 true 当且仅当四条件同时成立：
1. `host.instanceId == null`（legacy）
2. `host.state ∈ {"starting", "alive"}`（stopping 由既有恢复路径 L907-933 覆盖，不重复处理）
3. `hostPid != null && hostPidAlive === false` —— pid 已死是核心安全证据；pid 复用只会让 isAlive=true → 走保守分支，方向安全
4. `probeClassification ∈ {"missing", "stale"}` —— missing=ENOENT（socket/pipe 不存在）；stale=ECONNREFUSED+isSocket（进程死、socket 文件残留）。`unknown`/`occupied`/`starting` 一律不回收

纯函数、零副作用、零注入，真值表可全枚举测试。

### D2：resolver legacy 分支改造（service.mjs `resolveAttachTargetInner`）

- pid 解析复用 loadRow 同款 fallback：`Object.hasOwn(host, "runnerPid") ? host.runnerPid : readHostPid(root, viewId)`（legacy 的 pid 在 host-pid.json 镜像）
- 现 L963 `else if (legacy) return pending(...)` 改为：
  - `canFinalizeLegacyHost(...)` 为 true → finalize（见 D3）→ `continue`（下一轮 row 重载 hostActive=false → 走正常 ensure/claim）
  - 否则保持原 pending（行为不变）
- `state === "starting"` 的 legacy（L936 `withinGrace` 恒 true 的等死分支）：在 grace 等待分支内同样先查 `canFinalizeLegacyHost`（该分支 probe 已执行，classification 可得），满足即 finalize + continue，不再等 grace 到期

### D3：finalize 动作（service.mjs 内联，写路径唯一）

`writeHost(root, viewId, { ...host, state: "exited", endedAt: now, lastSeenAt: now, error: "legacy host finalized: runner pid dead" })` + `appendDiagnostic({ source: "service", level: "info", code: "legacy_host_finalized", ... })`。

- legacy 无 instanceId，不存在并发 owner，无需 fencing（与新协议 updateOwnedHost 路径区分）；竞态窗口由 host-start lease 串行化兜底（claim 走全新 instanceId，与 exited 记录不冲突）。
- 选 `exited` 而非 `failed`：进程是正常死亡语义（被外部杀死），failed 在现有代码里语义是"spawn/启动失败"（#86 场景），exited 与 v0.5.x runner 自然退出时写的状态一致，下游（canReplaceHost/ensure）对两者处理相同。

### D4：平台兼容性

不引入任何文件存在性检查（Windows 命名管道 existsSync 不可用，#45）；证据只来自 probe classification（connect+hello 是唯一权威，spec §7.1）+ isAlive（kill(pid,0) 跨平台）。不碰 prewarm keypress 路径（2s TTL 纪律）。

## 非目标（明确排除）

- **升级迁移扫描**（issue 建议 2）：resolver 自愈后功能冗余（下次 attach 自然恢复）；若后续要 dashboard 行状态立刻正确可单开 issue。
- **UI 兜底提示**（issue 建议 3）：永久 pending 状态被消除后无存在意义。
- **stopping 状态 legacy**：已有恢复路径覆盖（L907-933 对 instanceId != null 生效；legacy stopping 的 `staleStop` 判定要求 instanceId != null——属现存另一个小缺口，本次不扩范围，记为遗留观察项）。

## 可测性拆分设计

| 单元 | 位置 | 性质 | 测法 |
|---|---|---|---|
| `canFinalizeLegacyHost` | host-coordination.mjs 新增导出 | 纯函数 | 真值表单测：4 条件 × 关键组合（全满足/缺 pid/pid 活/unknown/stopping/新协议 host） |
| pid fallback 解析 | service.mjs resolver 内联（复用 store.readHostPid） | 副作用隔离 | 集成测试造 legacy host.json（无 runnerPid 属性）+ host-pid.json |
| finalize + 自愈闭环 | service.mjs resolver | 集成 | 注入 scriptProbe(missing) + 死 pid → 断言 host.json 落 exited、diagnostic 写入、resolver 继续 claim 新 host |
| 保守分支 | 同上 | 集成 | pid 活（用 process.pid）→ 断言 pending 且不写盘 |

测试基建现成：`resolverService` + `scriptProbe` + `aliveHost` fixtures + `instantSleep`（test/host-resolver.test.mjs 模式）。`aliveHost` fixture 需支持造 legacy host（无 instanceId、无 runnerPid 属性 + host-pid.json 镜像），必要时加 `legacyHost` fixture helper。

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | canFinalizeLegacyHost 决策正确性 | 自动化（unit） | `node --test test/host-coordination.test.mjs` | 真值表全组合通过 |
| A2 | legacy alive + pid 死 + missing → 自愈闭环 | 自动化（integration） | `node --test test/host-resolver.test.mjs` | host.json 落 exited、diagnostic 有 legacy_host_finalized、resolver 成功 claim 新 instance |
| A3 | legacy alive + pid 活 → 不回收 | 自动化（integration） | 同上 | pending 返回、host.json 未被改写 |
| A4 | legacy starting + pid 死 → 不等 grace 即回收 | 自动化（integration） | 同上 | 不 sleep 到 deadline 即完成回收 + claim |
| A5 | probe unknown → 不回收 | 自动化（integration） | 同上 | pending、不写盘 |
| A6 | 全量回归 | 自动化（static/build） | `npm test` + `npm run typecheck` | 568+ 全绿、无新类型错误 |
| U1 | 本机 6 个真实卡死 legacy view 实测 | 用户实测 | 运行副本 checkout PR 分支 → 重启 pi → board 对卡死 view 按 enter | 全部自动拉起新 host 可正常 attach，无 manual restart 提示 |

U1 必须用户执行（重启 pi 会断开实现 session）。执行时机：PR 合并前。

## 风险与降级

- pid 复用误判方向恒为保守（不回收），不会误杀；
- finalize 后若 claim 失败（如 PTY 不可用），行为与现有 ensure 失败路径一致（pending + 原因），无新增失败模式；
- Windows 无 legacy named-pipe 实测环境（U2 类）——设计只依赖平台无关的 probe/isAlive，风险评估为低，最终报告标注未实测。
