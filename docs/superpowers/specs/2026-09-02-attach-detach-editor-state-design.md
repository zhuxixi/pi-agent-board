# Issue #68 Spec：editor_state 推送 —— detach 门禁从渲染启发式迁移到子 pi 编辑器真实状态

> Draft：2026-09-02。state: **pending user review**（⏸ 等用户确认后再进 worktree）

## 1. 背景与根因

#66 的三层渲染启发式（反色假光标锚点 → 字形行 → 逃生兜底）在真实 pi 渲染下全部失效：
- 空编辑器行行首**无 prompt 字形**；attach buffer 常**无反色 cell**（差分渲染不重绘编辑器行）；
- 结果 tier-1 落空 → tier-2 误命中聊天区 markdown 表格行（`│ ... │`）/ 冒号行（`:` 开头）→ 判"有草稿" → `←` 被吞（#68/#69 实锤）。

渲染流**不是**编辑器状态的可靠载体。根治方案（本 spec）：子 pi 扩展直接读取 `ctx.ui.getEditorText()`（pi 官方 API，权威状态），经现有 control socket 推送给 runner → broadcast 给 attach 面板 → 门禁直接用。渲染启发式降级为 fallback。

## 2. 架构设计

```
子 pi 扩展（isHostedChild 时 session_start 启动上报循环）
  └─ 每 100ms 轮询 ctx.ui.getEditorText()，文本变化时：
       → {type:"editor_state", empty} → control socket（JSONL client）
pty-runner（handleClientLine 新 case "editor_state"）
  ├─ 缓存 host.editorEmpty + persist 到 host.json（可选，见 §7）
  ├─ broadcast({type:"editor_state", empty}) 给所有 attach clients
  └─ hello 消息带初始 editorEmpty（新 attach 立即同步）
attach 面板（pty-attach.ts）
  ├─ 缓存 this.editorEmpty: boolean | null（null = 未知）
  ├─ onSocketData 新 case "editor_state" 更新缓存
  └─ ← 判定：resolveEditorEmpty(editorEmpty, 启发式结果)
       editorEmpty !== null ? editorEmpty : 现有启发式（fallback）
```

### 2.1 协议（JSONL，向后兼容）

```jsonc
// 子 pi 扩展 → runner
{ "type": "editor_state", "empty": true }

// runner → attach clients（广播 + hello 初始值）
{ "type": "editor_state", "empty": true }
{ "type": "hello", "status": {...}, "editorEmpty": true }
```

旧端忽略未知字段/消息（现有 parser 已忽略未知 type）→ 协议向后兼容。

### 2.2 子 pi 扩展上报循环（新文件 `src/core/editor-state-reporter.mjs`）

- 激活条件：`process.env.AGENT_BOARD_CHILD === "1" || process.env.AGENT_VIEW_CHILD === "1"`（与 index.ts 同判据）
- socket 路径：`controlSocketPathFor(process.platform, root, viewId)`（复用 `src/core/paths.mjs`）
- 连接策略：runner **先 spawn 子 pi 后 listen** → 初始连接带重试（退避 1s→2s→…封顶 5s，永久重试）；断开后同样重连
- 轮询：`setInterval(100ms)` 读 `getEditorText()`，`text !== lastText` 才发送（dedupe，避免常发）
- 生命周期：session_start 启动、进程退出自然回收；`stop()` 供测试
- 依赖注入设计（可测性，§5）：`createEditorStateReporter({ getEditorText, connect, intervalMs, now, log })` → `{ start, stop }`；生产接线在 index.ts

### 2.3 runner 改动（`runner/pty-runner.mjs`）

- `handleClientLine` switch 加 `case "editor_state"`：`host.editorEmpty = !!msg.empty; broadcast({type:"editor_state", empty: host.editorEmpty})`（不 persist，见 §7）
- `hello` 消息：`{ type:"hello", status: host, editorEmpty: host.editorEmpty ?? null }`
- 子 pi 断开（child exit）→ editorEmpty 复位 null 并 broadcast（attach 端退回启发式）

### 2.4 attach 面板改动（`src/ui/pty-attach.ts`）

- 字段 `private editorEmpty: boolean | null = null`
- `onSocketData`：`case "editor_state"` → `this.editorEmpty = !!msg.empty`；`case "hello"` → 读 `msg.editorEmpty`
- `←` 判定（handleInput）：`shouldEscapeAttach(this.connected, this.resolveEditorEmpty())`
- 纯函数 `resolveEditorEmpty(editorEmpty, heuristic)`（放 `src/core/pty-input.mjs` 或新纯函数文件）：
  `editorEmpty === null ? heuristic : editorEmpty`
- `ctrl+]` 语义不变；现有三层启发式**原样保留**（fallback）

## 3. 行为矩阵

| 场景 | editorEmpty | 判定 | ← 行为 |
|------|-------------|------|--------|
| 空输入（attach/streaming/任意时刻） | true | 空 | detach ✓ |
| 草稿（多行/单行/autocomplete 后/↑ 召回） | false | 非空 | 转发（编辑保护）✓ |
| 提交瞬间 | true（清空） | 空 | detach ✓ |
| 子 pi 扩展缺失/socket 断流 | null | 启发式 | 现状 fallback 行为 |
| 损坏 buffer + editor_state 正常 | true/false | 权威 | 正确判定（不再被残影误导）✓ |

## 4. 非目标

- ❌ 删除现有渲染启发式（保留为 fallback）
- ❌ #69 的短期 tier-2 收紧（#68 长期方案落地后启发式仅 fallback；#69 由维护者按需处理）
- ❌ RPC 模式特判（子 pi 恒 PTY/TUI；RPC 下 getEditorText 恒 "" → empty 恒 true → ← 恒 detach，无 TUI 草稿概念，方向安全）
- ❌ 击键级拦截（评论 2 已排除：会覆盖编辑器光标行为，hack 且危险）

## 5. 可测性拆分设计

| 单元 | 位置 | 职责 | 测试边界 |
|------|------|------|----------|
| `createEditorStateReporter({getEditorText, connect, intervalMs, now})` | src/core/editor-state-reporter.mjs | 轮询、变化 dedupe、断线重连退避、stop | 依赖全注入；fake connect/getEditorText/手动推进时钟 → 断言 send 序列与时机；不碰真实 socket/interval |
| `resolveEditorEmpty(editorEmpty, heuristic)` | src/core/pty-input.mjs | 判定优先级 | 纯函数：4 种输入组合 → boolean |
| runner `editor_state` case + hello 字段 | runner/pty-runner.mjs | 缓存、broadcast、复位 | 现有 integration harness（pty-runner.integration.test.mjs 模式）：注入 client line → 断言 broadcast 与 hello 载荷 |
| attach `editorEmpty` 缓存 + 判定 | src/ui/pty-attach.ts | 消息 case、字段、← 判定 | detach-gate-smoke 场景 H（editor_state 消息 + 草稿 buffer → detach）；场景 I（草稿 + editor_state:false → 转发） |

约束：reporter 的生产接线只做「注入真实依赖」，纯逻辑全在工厂函数内；实现不得把轮询/重连逻辑重新耦合进 index.ts。

## 6. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | reporter：轮询变化才上报、dedupe、stop | 自动化验证（unit） | `node --test test/editor-state-reporter.test.mjs` | 变化序列上报次数/内容精确匹配；无变化零上报 |
| A2 | reporter：初始连接重试退避 + 断线重连 | 自动化验证（unit） | 同上 | fake connect 先拒后通 → 按退避序列重试并在连通后恢复上报 |
| A3 | runner：editor_state case 缓存 + broadcast + hello 初始值 + exit 复位 | 自动化验证（integration） | `node --test test/pty-runner.integration.test.mjs` | 注入 editor_state line → 其他 client 收到广播；新 client hello 带 editorEmpty；exit 后 editorEmpty=null 广播 |
| A4 | attach：editor_state 消息更新缓存、判定优先级（null 走启发式） | 自动化验证（unit） | detach-gate-smoke 场景 H/I | 空输入+editorEmpty=true → detach；草稿+editorEmpty=false → 转发；无消息 → 走启发式（既有场景全绿） |
| A5 | 纯函数 resolveEditorEmpty | 自动化验证（unit） | `node --test test/pty-input.test.mjs` | 4 组合精确匹配 |
| A6 | 全套回归 + 覆盖率门禁 | 自动化验证（build/static + unit） | `npm run verify`（typecheck + 全测 + c8 门禁 85/80/70 + pack:dry）；CI Node 22/24 | 全绿；既有 430+ 测试无语义改动 |
| U1 | 空输入 attach 后 ← 回退 | 用户实测 | attach 进入 → 立即 ← | 回 dashboard |
| U2 | Working... 中 ← 回退 | 用户实测 | 思考动画中 ← | 回 dashboard |
| U3 | 草稿中 ← 左移不被抢 | 用户实测 | 输入草稿 → ← | 光标左移，不 detach |
| U4 | 断流 fallback（子 pi 扩展被禁用时仍可退出） | 用户实测 | 临时禁用扩展的 editor_state 上报（env 开关）→ ← | 仍可回退（启发式兜底） |

## 7. 决策与风险

- **不 persist editorEmpty**（首版）：host.json 是行状态持久化，editor 状态是瞬态（毫秒级），重启后 attach 的 hello 里 null → 启发式兜底 1-2s 内收到首个 editor_state 修正。避免 host.json 写放大（100ms 级变化频率）。
- **100ms 轮询开销**：getEditorText 是内存 join，忽略不计；socket 仅在变化时写。
- **风险：editorEmpty=false 但用户实际想退出**（草稿场景）：与既有"编辑中不抢键"哲学一致（attach-flow 同样）；用户清空草稿即可退出。
- **风险：子 pi 扩展未安装/旧版**（fallback 启发式接管，U4 验证）。
- **风险：runner 老版本**（不认识 editor_state case，忽略）→ attach 收不到 → 启发式兜底，向后兼容。

## 8. 关联

- #68（本 issue 长期方案）、#66/#67（启发式起源与失效）、#69（同症状短期方案，由维护者处理）、#42/#48（门禁可靠性原则：视图必须始终可退出）
