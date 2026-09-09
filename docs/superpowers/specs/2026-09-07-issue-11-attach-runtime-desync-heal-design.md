# Spec: attach 运行期失同步检测 + 限速 heal 兜底（issue #11）

- 日期：2026-09-07
- 状态：approved（2026-09-08 用户批准；review v2 修订：检测改定时器入口、CJK 验证点、A4 可行性标注）
- 范围校准：attach 期失同步已由 shrink-and-hold 协议（#25 + #42 G6）覆盖；本 spec 只做**运行期**（attach settle 后、会话进行中）的失同步检测与限速补救。

## 1. 背景

issue #2 的修复建议 #2（失同步检测）在 #10 复盘中被证明必要：jiggle 链耗尽后系统再无自愈手段，脏画面（双光标+残留帧）一直挂着直到用户 detach/reattach。#25/#42 之后 attach 期已收敛，但运行期失同步（重放垃圾残留、子端渲染异常、未知失败模式）仍无兜底——本 spec 补上这道最后防线。

## 2. 失同步信号原理

**正常态**：子端 pi-tui 每帧把 PTY 硬件光标定位到编辑器 marker 处，而 marker 处的编辑器假光标 cell 是反色的（`ESC[7m`）。因此**光标 cell 本身就是反色 cell**。

**失同步态**：本地 headless xterm 的光标记账与 buffer 内容不一致（典型：光标停在差分写结束处、footer 段末尾），光标 cell 非反色，假光标留在编辑器行。

**streaming 例外**：输出进行中光标落在输出行（非反色）是正常的。用「距上次 socket 输出 > DESYNC_QUIET_MS」区分——输出停止后子端最后一帧会把光标定位回编辑器。

## 3. 设计

### 3.1 失同步判定纯函数 `detectCursorDesync(buf, cursor)`

位置：`src/core/pty-attach-render.mjs`（纯函数、零依赖，随既有模块）。输入：xterm buffer（`getLine`/`getCell`/`isInverse` 最小接口）+ `projectPtyCursor()` 的返回值。返回三态：

- `"aligned"`：cursor 非空且光标 cell 反色（含光标列越界但行末 cell 反色的等价形态）——正常；
- `"misaligned"`：cursor 非空（光标在投影视口内）但光标 cell 非反色（cell 不存在、宽度 0、非反色均算）——候选失同步，等待时间门确认；
- `"unknown"`：cursor 为 null（光标在视口外，如用户滚动历史）——不判定。

主判定 O(1)（只查光标 cell）；仅在光标列越界需回看行末 cell 时退化 O(cols)。

### 3.2 controller 新增 `heal(cols, rows)`

位置：`src/core/pty-attach-jiggle-controller.mjs`。运行期补救入口，复用 shrink-and-hold 协议：

1. healBudget 检查：已达上限（`HEAL_MAX_PER_LIFETIME = 5`）→ return，不再补救；通过检查即消耗一次额度（含后续因极小终端放弃的情况——防反复尝试）；
2. 清 timer；若有旧 hold（held）先 restore（幂等）；
3. 重置检测状态（`state = createJiggleRetryState()`、carry 清空）；
4. **保留 `tuiFrameSeen = true`**（运行期子端必然渲染过——这是与 `start()` 的关键区别，跳过 G1 无帧守卫与首帧 re-arm 分支）；
5. 重新 shrink 并 hold（`holdSize = resizeJiggleSize(cols, rows)`；极小终端无 holdSize → 直接放弃本次 heal）；
6. `scheduleNextRetry()` 复用现有退避表（G2 预算耗尽自动 restore）。

清屏检测复用 `feed()`：见 `\x1b[2J` → restore + 停链（现有逻辑）。守卫交互：

- **G3**：`restoreAndStop()` 照常清 heal 的 hold；
- **G4**：`notifyExternalResize()` 清 hold 与 timer，heal 自动取消（现有逻辑不动）；
- **G5**：`start()`（重连）先恢复旧 hold——heal 的 hold 同样被恢复，重连后协议重新走 attach 期自愈；
- **预算**：healBudget 在 controller 实例生命周期内累计（`start()`/`restoreAndStop()` 均不重置），防断连循环骚扰。

### 3.3 组件接线（`src/ui/pty-attach.ts`）

- `pushOutput()` **同步**收到数据时记录 `lastOutputAt`（不在 `term.write` 异步回调里记）；
- `attachSettled` 即现有 `!this.attaching` 字段（不新造计时器），settle 后才开始检测；
- **检测入口是独立 `checkDesync()` 组件方法 + 低频定时器，不挂 render 路径**——render 是事件驱动的（socket 输出/keypress/resize），而失同步恰恰发生在输出停止后，挂在 render 路径上会让空闲态失同步永远没有检测机会。定时器在 attach settle 后启动（周期 `DESYNC_PROBE_INTERVAL_MS = 2000`），unref 不阻止进程退出，`close()` 时清理；
- `checkDesync()` 内部用与 `project()` 相同的视口计算（start/height）调 `projectPtyCursor` + `detectCursorDesync`，7 个门全部通过才 heal：
  1. `attachSettled === true`；
  2. controller `tuiFrameSeen === true`（子端是 pi，shell/vim 不检测）；
  3. `detectCursorDesync(...) === "misaligned"`；
  4. `Date.now() - lastOutputAt > DESYNC_QUIET_MS`（1500ms）；
  5. 链不活跃：`getState()` 满足 `state.stopped && !held`（heal/attach 链进行中不重复触发）；
  6. 距上次 heal > `HEAL_RATELIMIT_MS`（10000ms）；
  7. socket 连接存活（`this.connected`）。
- 门 1-7 通过 → `jiggleRetry.heal(this.cols, this.rows)`，记录 `lastHealAt`。healBudget 上限不是组件层门：由 `heal()` 内部强制（预算耗尽直接拒绝），组件层无需重复检查。

### 3.4 数据流

```
socket 输出 → pushOutput（记 lastOutputAt）→ term.write 异步解析
                                        ↘（输出停止后 render 不再触发）
settle 后定时器（2s 周期）→ checkDesync()（自算视口 + projectPtyCursor）
  → detectCursorDesync → 7 门判定 → heal()
  → sendResize(shrink) → 子端 fullRender(true) 全清
  → feed() 检测 \x1b[2J → restore 原尺寸 → 自愈完成
```

## 4. 误报场景与防护

| 场景 | 防护 |
|------|------|
| streaming 中光标在输出行 | 门 4 时间条件（1.5s 无输出才判） |
| 全清重绘中间态 | 重绘=大量输出 → lastOutputAt 持续刷新 → 门 4 挡住 |
| 非 pi 子进程（shell/vim，光标行永无反色） | 门 2 tuiFrameSeen |
| attach settle 前（重放中间态/banner 遮挡） | 门 1 |
| 用户滚动历史（光标在视口外） | detectCursorDesync 返回 unknown |
| pi 静默等待外部输入（密码 prompt 等） | 无法完全防（真误报）→ healBudget=5 上限封顶，闪烁有限次后停止 |
| heal 进行中重复检测 | 门 5 链活跃检查 |

**已知漏报（接受）**：光标 cell 恰好反色但 buffer 其他处有残影——检测不到。兜底不追求完美。

**假设**：子端 buffer 的反色 cell 主要来源是编辑器假光标（detach gate `findLastInverseCellLine` 已依赖同一假设）。若存在其他反色源，只影响漏报（把失同步误判为 aligned），不产生误报。

**实现时验证点**：CJK 宽字符的 continuation cell（width 0）在 xterm 中是否继承首格的反色属性——若光标停在中文 continuation cell 上被判为非反色，会造成中文输入场景误报。实现时用真实 @xterm/headless 验证，并在 A1 补对应用例（若确实误判，检测逻辑需回看首格）。

## 5. 非目标

- attach 期失同步检测（已由 shrink-and-hold 覆盖）；
- 连续补救失败后隐藏光标块 + 状态行提示（原 issue 可选兜底 3，以 healBudget 上限替代）；
- 残留帧特征检测（内容重复行等，成本高收益低）；
- Windows 实机行为（无实机，标 pending）。

## 6. 参数表

| 参数 | 默认值 | 说明 |
|------|--------|------|
| DESYNC_QUIET_MS | 1500 | 判定失同步所需的输出静默窗口 |
| DESYNC_PROBE_INTERVAL_MS | 2000 | settle 后定时检测周期 |
| HEAL_RATELIMIT_MS | 10000 | 两次 heal 最小间隔 |
| HEAL_MAX_PER_LIFETIME | 5 | controller 实例生命周期内 heal 总上限（进入 heal() 即消耗一次，含极小终端放弃的情况） |

## 7. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | detectCursorDesync 三态判定 | 自动化（unit） | `node --test test/pty-attach-render.test.mjs` | aligned/misaligned/unknown 各场景断言正确（反色 cell、非反色、cell 越界、宽度 0、cursor null） |
| A2 | heal() 协议行为 | 自动化（unit） | `node --test test/pty-attach-jiggle-controller.test.mjs` | shrink→feed clear→restore；budget 耗尽拒绝；G4 取消 heal；G5 恢复 heal hold；tuiFrameSeen 保留；极小终端放弃 |
| A3 | 组件接线 + 7 门 + 自愈闭环 | 自动化（integration） | 新增 test-support TS 脚本（`--experimental-transform-types`，仿 detach-gate-smoke 模式）+ `node --test` 包装 | 伪造 buffer/输出流驱动真实组件：misaligned+静默→触发一次 heal resize；10s 内不重复；链活跃/settle 前/视口外/无帧均不触发；模拟子端全清输出后自愈停止；时间相关断言优先时间注入，其次真实等待 |
| A4 | 健康 session 无误触发 | 自动化（E2E） | 复用 cold-start E2E harness 模式，真实 runner+pi 冷启动 attach 后稳定运行窗口内监控 heal 计数/resize 序列 | 正常会话全流程 heal 触发次数为 0。**可行性依赖**：现有 E2E harness 绕过组件胶水层（advisory 30-3），plan 阶段先核实组件级 harness 能力；不可行则降级为「A3 强化门控回归 + U1 观察」 |
| U1 | 日常使用观察 | 用户实测 | 日常使用若干天：观察无误触发闪烁；（若偶遇真失同步）观察限速周期内自愈 | 无每 10s 频闪类骚扰性重绘；U1 为观察性验收，允许 pending，不阻塞合并 |

## 8. 可测性拆分设计

- **detectCursorDesync(buf, cursor)**：纯函数，输入最小 buffer 接口（伪造 `getLine→getCell→isInverse` 对象，test/pty-attach-render.test.mjs 已有 BufferLineLike 伪造模式）。测试边界：只测函数本身的三态映射，不涉及时间/限速（属组件层）。
- **heal()**：注入式 controller（fake `sendResize`/`setTimeoutFn`/`clearTimeoutFn`，既有模式）。测试边界：协议时序与守卫交互，不涉及检测信号。
- **接线门控**：真实组件（TS）+ 伪造 tui/socket 数据流，test-support 脚本模式。测试边界：门的组合逻辑与端到端自愈闭环，不依赖真实子进程。
- **A4 E2E**：真实 runner+pi，只断言「健康流无误触发」这一回归性质，不构造失同步（构造失同步属于 A3 的伪造层职责）。

## 9. 风险

- pi 静默等待场景（密码 prompt/长工具无 spinner 帧）真误报 → 一次闪烁 + budget 封顶，无无限循环；
- 子端其他反色源（若存在）→ 只漏报不误报；
- 参数（1.5s/10s/5 次）为工程估值，A3/A4 验证后可调。
