# Issue #48 根因报告 + 修复 spec

Windows: pty-runner dies with uncaught EPERM when host.json atomicWrite races a reader; attach view stuck in reconnect loop

状态：**草稿，待用户确认**（2026-08-30）

---

## 1. 根因（已代码层验证，非推测）

### 机制（Windows 特有）
libuv 打开文件默认共享模式不含 `FILE_SHARE_DELETE`；Node `renameSync` 在 Windows 映射为 MoveFileExW(MOVEFILE_REPLACE_EXISTING)，替换已存在目标需先删除旧目标，而删除要求所有持句柄进程带 FILE_SHARE_DELETE——否则抛 `EPERM: operation not permitted`（本机 100/100 复现，见 issue 正文复现代码）。

### 触发链
1. `runner/pty-runner.mjs` 1s 心跳 `update()` → `persist()` → `writeHost()` → `atomicWriteJson()`（`src/core/atomic.mjs`：写 `.tmp` → `renameSync`，**无重试**）
2. service 渲染路径高频 `readHost()/loadRow()`（`readFileSync` host.json）——密集工具调用 + 任意面板渲染即构成 reader
3. 窗口重叠 → renameSync 抛 EPERM → **无 try/catch**（update/persist 均无防护，全文件无 uncaughtException 兜底）→ runner 以 `detached: true, stdio: "ignore"`（`launch.mjs`）静默死亡，留 `.tmp` 残留
4. 连锁：runner 死 → ConPTY 断 → 托管 child pi 随死
5. attach 视图：只有 socket `{type:"exit"}` 消息才置 `status="host exited"`（`pty-attach.ts` onSocketData L871）；崩溃 runner 不发 → `scheduleReconnect()` 150ms **无限重连**
6. 逃生失败：`handleInput` 中 `←`/`ctrl+]` 仅当 `childInputLooksEmpty()` 才 detach（崩溃画面停在非空输出行，不满足）；`send()`（L852）`!connected` 时**静默丢弃**；pi-tui 无系统级兜底键

### 次要发现
- `failEarly()` 硬编码 `/tmp/pi-agent-board-pty-runner.err`（Windows 无 /tmp，写失败被吞）——崩溃零痕迹的原因之一
- 二次崩溃无 `host_reconciled` 诊断（reconcile 只在 panel open / session_start 跑）→ idle 行掩盖崩溃

## 2. 修复设计（四层，L1-L3 必做，L4 待确认）

### L1 `src/core/atomic.mjs` — rename 重试（根因层）
- 新增内部 `renameWithRetry(tmp, file, opts?)`：
  - 错误码白名单重试：`EPERM` / `EBUSY` / `EACCES`（Windows 共享冲突三兄弟）
  - 3 次重试 + 退避 10ms → 50ms → 250ms（同步调用，上限阻塞 ~310ms，可接受）
  - 重试无需重写 tmp（写文件已在 rename 前完成，tmp 内容完整）
  - 全部失败：`unlinkSync(tmp)`（try/catch 清理残留）→ 抛**原错误**（保持调用方语义，由 L2 降级）
- `atomicWrite` 调 `renameWithRetry`；导出 `renameWithRetry` 供单测注入失败回调

### L2 `runner/pty-runner.mjs` — 持久化防御 + 崩溃兜底（防御层）
- `persist()` 包 try/catch：失败时 `appendDiagnostic(root, viewId, { type: "persist_error", ... })`（`core/diagnostics.mjs` 仅依赖 atomic/paths，runner 可安全导入）→ 降级继续，下个心跳 tick 再试，**不杀进程**
- `update()`：persist 失败不影响 `broadcast()`（socket 消息是 attach 主通道，host.json 短暂陈旧可接受）
- `process.on("uncaughtException")` 一次性兜底：
  1. 移除 handler（防循环）
  2. appendDiagnostic 记录
  3. 尽力最终 persist：`state:"failed", error, endedAt`（try/catch 包住）
  4. `broadcast({ type: "exit", exitCode: 1 })` ← **关键**：让已连 attach 正常退出，不再无限重连
  5. `process.exit(1)`
- `failEarly` 的 `/tmp` 硬编码 → `os.tmpdir()`（Windows 兼容小修）

### L3 `src/ui/pty-attach.ts` — 逃生键 + 重连超时（UI 层）
- **逃生**：DETACH 分支条件改为 `if (!this.connected || this.childInputLooksEmpty()) this.detach()` —— 断连/启动中随时可按 `←`/`ctrl+]` 退出（`send({type:"detach"})` 在 !connected 时被丢弃，无害）
- **重连超时**（新增 `everConnected` 标志，首个 socket connect 成功置位）：
  - `everConnected === true` 断开后：15s 重连窗口 → 超时置 `status = "host exited"`、停止重连、保持可 detach（覆盖 issue 主场景：host 已崩）
  - `everConnected === false`（host 冷启动中，service 在 attach 前已 launchHost）：保留无限重连 + 宽松上限 120s → 超时置 `status = "host not reachable"` 停止重连（覆盖 launchHost 失败场景）
  - 超时到期不自动 `done()`，显示错误状态等用户按 `←` 退出（避免突然弹走）

### L4（可选，待确认）— idle 行掩盖崩溃的展示级检测
- 落点：`loadRow()` 已派生 `hostAlive`；dashboard 渲染时对 `host.state==="alive" && !hostAlive && lastSeenAt 陈旧(>10s)` 的行显示 host-lost 标记（**仅展示级，不改 state.json**，避免与 resume/重启中误判）
- 不做 state 级 reconcile 触发时机修改（范围外）

## 3. 测试计划（TDD 先行）

| 层 | 测试 | 方式 |
|---|---|---|
| L1 | `renameWithRetry` 重试次数/退避/白名单/最终抛错/失败后 tmp 清理/happy path | 单测注入失败回调（新增 `test/atomic-retry.test.mjs`） |
| L2 | persist 持续失败 → runner 不崩溃 + diagnostics 有记录 + host.json 陈旧但不死 | 集成：host.json 目标路径被同名**目录**占位（rename 必失败，跨平台稳定触发） |
| L2 | 崩溃兜底 `finalizeCrash`：写 failed 状态 + broadcast exit | 抽纯函数单测（外部无法稳定注入 uncaughtException） |
| L3 | handleInput 逃生分支（!connected 时 detach） | 现有 pty-attach render 测试基建（mock tui/theme/term） |
| L3 | 重连超时状态机（everConnected × 超时 × 状态文案） | 抽纯函数或组件级测试 |

回归：全量 `node --test test/*.test.mjs` + `npm run typecheck`（Windows 全量已知 6 个既有失败，基线对比排除回归）。

## 4. 非目标
- 不做 unlink-then-rename 兜底（短暂缺失窗口影响并发 reader；重试已覆盖）
- 不改 reconcile 触发时机（L4 仅展示级）
- 不做历史 `.tmp` 残留 GC（screen-log-gc 范围外，可后续单列）

## 5. 交付
- worktree：`issue-48-eprm-atomicwrite-race`（spec 批准后）
- PR 标题：`fix: harden host.json persistence against Windows EPERM rename races (issue #48)`，覆盖 L1-L3（L4 视确认）
