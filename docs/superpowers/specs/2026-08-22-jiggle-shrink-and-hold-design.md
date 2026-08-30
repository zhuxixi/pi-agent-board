# Spec：attach jiggle 协议改造 — shrink-and-hold（issue #25）

> **历史设计，部分内容已被 issue #42 superseded。** 当前实现保留 G1–G5，
> 并在首帧快速 restore 后增加 G6 post-restore verify：900ms 内没有 clear
> 时重新 shrink；attach detach 只使用空输入时的 `←`，`ctrl+]` 透传给 Pi。

## 日期
2026-08-22

## 问题

#10 修复后冷启动 attach 自愈延迟 10-25s（re-arm 生效但后续 ±1/200ms 脉冲对被启动风暴合并成净零尺寸变化，子端渲染时看不到宽度变化 → 不触发 fullRender 全清）。目标：冷启动 ≤3s 自愈，热 attach ≤300ms 不劣化，且不破坏任何现有功能。

## 协议设计（核心状态机）

**旧协议**：connect → shrink(−1) → [200ms] → restore → 每次重试重复脉冲对 → 见全清停。
**新协议**：

```
connect:
  1. sendResize(W×H)              # 原始尺寸（保持现有语义）
  2. shrink 到 (W−1)×(H−1) 并 HOLD # "armed"：与子端基线之间存在待兑现的宽度差
  3. 启动安全计时器（见"守卫 G1/G2"）

子端输出处理（沿用 feed）:
  - 见 \x1b[2J（全清）→ restore(W×H)，链停        # 子端渲染时读到窄宽 → fullRender → 我们恢复
  - 见首个 \x1b[?2026h（re-arm）→ restore(W×H) 并停在那里
      # 冷启动死锁解法：TUI 若在 shrink 后才启动，首帧把窄宽当基线；
      # restore 让"正在渲染的子端"下一帧看到宽 1 列 → 必然 fullRender → 走上面的全清分支

守卫:
  G1 无帧兜底: connect 后 6s 内无任何 TUI 帧 → restore(W×H)（没有渲染器可触发，继续缩无意义）
  G2 预算兜底: 全部退避预算（56.12s）走完无全清 → restore(W×H)（非 pi 子进程/死 session）
  G3 close/detach: close() 时若 hold 生效 → 先 restore 再断（socket 尚可用）
  G4 真实 resize: resizeIfNeeded(新宽) 进入时若 hold 生效 → 取消 hold 状态、按新尺寸 sendResize、
     之后由下一次 attach 语义重启链（hold 的"原尺寸"取新值）
  G5 reconnect: start() 重置前若 hold 生效 → 先 restore（socket 刚连上）
```

**为什么合并不再重要**：旧协议的净零来自"缩"与"恢复"互相抵消；新协议在见到全清前根本不存在"恢复"，任何一侧（外层 timer / 子端 SIGWINCH / 渲染节流）的合并最多推迟信号到达，不能消除"宽度与基线不同"这个事实。子端只要渲染任何一帧，全清必然发生。

## 模块改动

### 1. `src/core/pty-attach-jiggle-retry.mjs`（纯逻辑，微调）
- 不变：退避表、`hasTuiFrameStart`/`hasFullClearSequence`、carry=7。
- `JiggleRetryState` 增加 `held: boolean`（是否正缩着）与 `originalCols/originalRows`。由控制器维护，状态机保持零副作用。

### 2. `src/core/pty-attach-jiggle-controller.mjs`（协议主体）
- deps 增加：`sendResize(cols, rows)`（发送任意尺寸；sendJiggle 语义被 hold 协议取代，删除或保留为内部组合）。
- `start()`：若前次 hold 生效 → 先 `sendResize(original)`（G5）；随后 `sendResize(W,H)`、`sendResize(W−1,H−1)` 置 `held=true`（armed）；启动 G1 计时器；预算链照常排（作 G2 计时用，重试回调在 hold 下为 no-op——不发脉冲）。
- `feed()`：见全清 → `restoreIfHeld()` + 停链 + 置 clearDetected；见首帧（re-arm）→ `restoreIfHeld()`（G-rearm），**预算链不重置不重排**（hold 协议下 re-arm 后无需再脉冲；若全清一直不来，由 G1/G2 兜底）。G1 计时器见帧后取消。
- `stop()`：restoreIfHeld 不在此做（组件 close 语义不同——见 G3，由组件在 socket 可用时显式调用 `restoreAndStop()`）。
- 新增 API：`restoreAndStop()`（G3）、`notifyExternalResize(cols, rows)`（G4：取消 hold/计时器、更新 original、可选重启链）。
- 计时器仍全部走注入的 setTimeoutFn/clearTimeoutFn，unref。

### 3. `src/ui/pty-attach.ts`（薄胶水）
- `forceChildRedraw` 语义替换：connect 处理器改调 `jiggleRetry.start()`（内含 armed shrink）；`JIGGLE_RESTORE_MS` 删除（无脉冲）。
- `resizeIfNeeded`：尺寸变化时调 `jiggleRetry.notifyExternalResize(newCols, newRows)`，再照常 `term.resize + sendResize`。
- `close()`：`jiggleRetry.restoreAndStop()`。
- `checkClearSequence` → `jiggleRetry.feed(data)` 不变。

### 4. 测试
- 单测（controller）：armed 后见全清→restore+停；见首帧→restore 且不重排；G1 6s 无帧 restore；G2 预算耗尽 restore；close restoreAndStop；notifyExternalResize 取消 hold 并更新原尺寸；重复 start 先 restore 旧 hold；所有 restore 只发一次（幂等）。
- E2E 重写（stub 语义改为 hold 协议）：
  - 冷启动：stub 延迟 8s 启动 TUI；收到 shrink 不动作；**收到 restore(原尺寸) 且 TUI 已启动** → 发全清。断言全清 ≤3s 内到达（re-arm 后 ~一帧间隔），且 PTY 终态=原尺寸。
  - shell 型子进程（永不发全清）：断言 G1 兜底 6s 后收到 restore(原尺寸)。
  - （可选）hold 中途外部 resize：模拟 notifyExternalResize，断言不发旧尺寸。
- 既有 208 测试适配（controller 单测大改、retry 状态机测试微调）。

## 决策表

| 决策点 | 选择 | 理由 |
|---|---|---|
| hold 的宽度 | cols−1 且 rows−1 | 沿用现有 jiggle 尺寸语义；宽高都变确保 heightChanged 路径也可触发 |
| re-arm 后行为 | 只 restore，不再脉冲 | 子端已在渲染，restore 即待兑现差值；脉冲回归旧脆弱性 |
| G1 时长 | 6s | > 最慢正常 boot 出首帧（实测 ~5.2s）+ 余量；< G2 预算 |
| G2 | 退避表走完（56.12s） | 与 #10 验收窗口一致；hold 下重试回调 no-op，表仅作计时 |
| restore 幂等 | 只发一次 | 防止 close/reconnect/兜底叠加多发 |
| `JIGGLE_RESTORE_MS` | 删除 | 无脉冲对 |

## 风险面 → 守卫映射（用户重点确认区）

| # | 风险面 | 守卫 | 验证 |
|---|---|---|---|
| R1 | 非 pi 子进程/死 session | G1(6s)+G2(56s) restore | E2E shell stub |
| R2 | detach/close 中途 | G3 close 先 restore | 单测 |
| R3 | 真实 resize 打架 | G4 中断+取新值 | 单测 |
| R4 | 子端窄 1 列渲染 | 瞬态，restore 全清重绘 | 人工+E2E 终态尺寸断言 |
| R5 | 本地投影 1 列差 | 流内自洽，无影响 | 人工 |
| R6 | reconnect 残留 | G5 start 先 restore | 单测 |
| R7 | settle 后 UX | 无脉冲（频次低于现状） | 人工 |
| R8 | 测试有效性 | stub 改 hold 语义+兜底用例 | E2E |

## 降级

- 若 pi-tui 改掉 `\x1b[?2026h`：re-arm 不触发，退化为 G1(6s) restore——**比 #10 修复前更好**（6s 内恢复正确尺寸，画面可能仍脏但不卡窄宽）。
- 若全清信号消失：同上走 G1/G2，终态尺寸正确。

## 非目标

- 失同步渲染检测（#11 范围，若 hold 后仍有可见脏窗再评估）。
- runner / pi-tui 侧改动。
- screen.log 重放锚点问题。

## 验收标准

1. 冷启动 E2E：全清 ≤3s 到达且终态=原尺寸（旧协议同场景 >10s，反证有效）。
2. shell stub E2E：G1 兜底 6s 后 restore 原尺寸。
3. 8 个风险面守卫全部有单测/E2E 覆盖。
4. 全套测试通过、typecheck 干净、CR 收敛。
5. 人工实机：home 目录冷启动 attach ≤3s 自愈；热 attach 无可感知劣化。
