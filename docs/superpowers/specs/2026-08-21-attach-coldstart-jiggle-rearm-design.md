# Spec：attach 冷启动双光标根治 — jiggle 重试链编排修复（issue #10）

## 日期
2026-08-21（v2：评审后修订，补三项编排严谨性修正）

## 问题

d10f21d（issue #2 修复）的 jiggle 重试链在**编排层**有三个不覆盖点，导致冷启动 attach 双光标未根治：

1. **启动时机错位**：链从 socket connect 即启动（start&attach 流程下 = spawn+0.3-0.5s），而冷启动 pi-tui 要 ~5.1-5.2s 才装好 resize 监听（EXP-2 实测 5180/5199/5191ms），链的窗口（connect+0.12~5.12s）全部落在 TUI 不存在的时段，注定空枪。
2. **jiggle 结构脆弱**：±1 尺寸、shrink→restore 仅隔 40ms。初始 sendResize 在 TUI 启动前白花掉唯一一次真实尺寸变化（120x36→196x39）；后续重试全是围绕已正确尺寸的 ±1 噪声，启动期繁忙事件循环 + pi-tui 16ms 渲染节流可将其合并成净零变化 → 命中也不清屏。
3. **链断零自愈**：链耗尽即 stopRetry，一次性补偿已被 d10f21d 移除；此后脏屏只能等用户 detach/reattach 或拖窗口。

状态机本身（pty-attach-jiggle-retry.mjs）无 bug，不推翻，只改编排。

## 设计原则

- 沿用"可测性优先"：新增逻辑抽成纯函数/可注入控制器，验收 = 单测 + 一个确定性 E2E。
- 不碰 runner（它即时应用 resize，无 debounce，无责）。
- 保留 settle-survive（ADR 202608211244444979 已记录取舍）。
- 失同步检测兜底**不在本 issue**（→ #11）。

## 方案（四个改动）

### 改动 1：重试链 re-arm — 首个 TUI 帧触发（一次性锁存）

**信号**：子 pi-tui 每帧（含差分帧）以 `\x1b[?2026h`（synchronized output begin）开头；冷启动 boot 期扩展输出不含该序列（EXP-2 screen.log 验证）→ 首个 `\x1b[?2026h` = "TUI 已开始渲染"的可靠信号。

**纯逻辑层**（`src/core/pty-attach-jiggle-retry.mjs` 扩展）：

```typescript
/** 检测数据中是否含 TUI 帧开始序列（跨 chunk 安全） */
function hasTuiFrameStart(data: string): boolean; // 查 \x1b[?2026h
```

**跨 chunk carry 修正（评审修正 #2）**：现有 `CARRY_LEN = 3` 只服务四字节的 `\x1b[2J`；`\x1b[?2026h` 是 8 字节序列，跨 chunk 时会漏检。**carry 统一扩到 7 字节**（两个目标序列的公共前缀都是 `\x1b[`；`tailCarry` 从尾部 7 字节里找最后一个 `\x1b` 起携带，逻辑同构）。feedOutput 返回值增加 `frameStartFound`，与 `clearFound` 共用同一次扫描与 carry。

**编排层**（`src/ui/pty-attach.ts`）：
- connect 时照旧 `startJiggleRetry()`（保热 attach 现状）。
- 新增组件字段 `tuiFrameSeen = false`（**一次性锁存，评审修正 #1**）：output 路径检测到首个 `\x1b[?2026h` 且 `!tuiFrameSeen && !clearDetected` 时，置 `tuiFrameSeen = true` 并重置链为新状态机（retryIndex=0、预算计满）。**没有锁存的话 streaming 中每一帧都会 re-arm，退避永远走不完（评审发现的设计缺陷）。**
- **clear 优先规则（评审修正 #2 附带）**：同一 chunk 同时含 frame-start 与 clear（热 attach 常见：首帧即全清帧）时，先处理 clear（停链），re-arm 判断以"clear 处理后的最新状态"为准，禁止刚成功又被重置。
- 冷启动效果：TUI 开始渲染的瞬间链重启，第一个 jiggle 必落在活 TUI 上 → ~120ms 内见到 \x1b[2J。
- 热 attach 效果：首帧几乎与 connect 同时到达，链重置一次后首个 jiggle 立即成功自停；等价于现状。

### 改动 2：退避尾部拉长（与 60s 验收对齐，评审修正 #3）

```typescript
const BACKOFF_MS = [120, 500, 1500, 3000, 6000, 10000, 15000, 20000]; // 8 次，累计 56.12s
```

- 依据：jiggle 对健康 session 无害（见到 clear 自停）；长尾部只在前序全失败（画面本就脏）时才走完，代价已在 settle-survive ADR 中接受。
- **累计窗口必须与"60s 内自愈"验收标准一致（评审修正 #3）**：v1 草案的 ~92s 与验收冲突，修正为 56.12s。
- 与改动 1 的关系：改动 1 解决"时机"，改动 2 兜底"比 5s 更极端的慢启动/合并丢失"。

### 改动 3：jiggle 抗合并 — restore 延时 40ms → 200ms

- `forceChildRedraw` 的 `redrawTimer` 延时抽为常量 `JIGGLE_RESTORE_MS = 200`。
- 依据：200ms > pi-tui 16ms 节流一个数量级，启动期繁忙循环也能把 shrink/restore 分成两次独立渲染（各触发一次 fullRender）。
- 副作用评估：jiggle 只发给子端 PTY，不改本地 xterm 尺寸；settle defer 已覆盖 redraw 窗口；post-settle 残余 jiggle 的闪烁取舍同 ADR。
- 不采纳的备选：交替幅度 -1/-2（对"基线已正确"场景无效，徒增复杂度）。

### 改动 4：确定性 E2E 测试（验收核心）

编排层抽取：把"timer 调度 + jiggle 发送 + output 喂入"从 PtyAttachComponent 抽成**可注入控制器**（注入 scheduler 与 sendJiggle 回调），组件退化为薄 adapter。控制器可脱离 TUI 单测/E2E。

- `test/pty-attach-jiggle-controller.test.mjs`（单测级）：首帧检测（含跨 chunk 边界切割）、`tuiFrameSeen` 一次性锁存（第二帧不再 re-arm）、clear 优先规则、新退避表累计值、链在见 clear 后自停。
- `test/pty-attach-cold-start-e2e.test.mjs`：真实 pty-runner（node-pty）+ **stub 子进程**（node 脚本：延迟 8s 才"启动 TUI"——开始发 `\x1b[?2026h` 帧并安装 resize 监听；监听到 resize 且 TUI 已启动时回发 fullRender + `\x1b[2J`）+ 真实控制器。断言 **30s 内检测到 \x1b[2J**。
  - 反证有效性：stub 延迟 8s > 旧链窗口 5.12s，旧编排在该测试下必失败。
  - 时长 ~10-15s，可进 `npm test`；如 CI 敏感再拆慢测试脚本。

## 决策表

| 决策点 | 选择 | 理由 |
|---|---|---|
| TUI 就绪信号 | `\x1b[?2026h` | 每帧必有；boot 噪声不含（实测）；零成本 |
| re-arm vs 仅首帧启动 | re-arm（connect 链保留） | 热/冷统一；热路径不变 |
| re-arm 次数 | 每次连接仅一次（tuiFrameSeen 锁存） | 防 streaming 每帧重置链 |
| frame-start 与 clear 同 chunk | clear 优先 | 防刚成功又被重置 |
| restore 延时 | 200ms 常量 | ≫16ms 节流；对 attach 投影无影响 |
| 退避尾部 | 8 次 / 累计 56.12s | 对齐 60s 验收；健康 session 自停 |
| E2E 方式 | stub 子进程 + 真 runner + 真控制器 | 确定性、快、可 CI |

## 降级

- pi-tui 若改掉 2026h：re-arm 失效但 connect 链 + 长预算仍在，退化为"比现在好"（文档化注释）。
- pi-tui 若 fullRender 不再发 \x1b[2J：同 d10f21d 已文档化的退化（链按预算走完即停，不 worse than one-shot）。

## 非目标

- 失同步检测渲染兜底（→ #11）。
- screen.log 重放无锚点问题（#2 已分析，jiggle 即其解药）。
- runner / pi-tui 侧改动。
- 外层 ghost 内容（"[Themes] light-warm" 残留）——独立 cosmetic 问题，不在此列。

## 验收标准

1. 新 E2E 通过（stub 8s 延迟 TUI，30s 内见 \x1b[2J）；且能证明旧编排下失败。
2. 新增单测通过；既有测试（jiggle-retry 状态机等）不回归；`npm run typecheck` 过。
3. 人工实机验证：start & attach 冷启动一个重扩展 session，双光标/脏帧在 60s 内自愈，无需 detach/reattach。
4. 热 session attach 无劣化（首个 jiggle 见 clear 自停，无多余重绘）。

## 评审修订记录（v2）

1. re-arm 必须加一次性锁存 `tuiFrameSeen`（否则 streaming 每帧重置链，退避失效）。
2. 跨 chunk carry 从 3 字节扩到 7 字节（`\x1b[?2026h` 为 8 字节序列）；同 chunk 含 frame-start+clear 时 clear 优先。
3. 退避表从 ~92s 收敛为累计 56.12s，与"60s 内自愈"验收标准对齐。
