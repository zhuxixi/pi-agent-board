# issue #106 spec：终态链（clear/settled）仍须学习帧认知

日期：2026-09-14 · 状态：设计已确认（用户 2026-09-14 决策，范围 B：两个终态一起覆盖）

## 根因（机制链确认）

`src/core/pty-attach-jiggle-controller.mjs` 的 `feed()` 把「帧认知学习」放在两条终态早退之后：

```js
220:  if (state.clearDetected) return; // chain done; nothing left to detect
221:  if (state.stopped) return;       // chain ended (G2/G3/G4); output is inert
222:  const result = feedOutput(state, data, carry);
...
229:  if (result.frameStartFound) tuiFrameSeen = true;   // ← 唯一学习点（start() 的 :186 是唯一重置点）
```

因此，**链在第一个 TUI 帧之前进入终态 ⇒ 本次连接内 `tuiFrameSeen` 恒为 false**（写入点全仓只有 186/229 两处）。

后果链：`tuiFrameSeen === false` ⇒ `checkDesync()` 的 gate 2 早退（`src/ui/pty-attach.ts:590`）⇒ `heal()` 不可达（其唯一调用点 `pty-attach.ts:601` 在 gate 2 之后）⇒ 运行期失配自愈（#11）对本连接静默失效。纯漏报：不闪屏、不误触发，只是「该治不治」。

## 两个终态的可达性（含 `clearDetected` 的依据）

| 终态 | 进入条件（代码事实） | 现实场景 |
|---|---|---|
| `stopped` | G2：退避表 8 轮耗尽（120ms…20s，累计 **56.12s**）期间既无 `\x1b[2J` 也无 `\x1b[?2026h`；G4：`notifyExternalResize`（`pty-attach.ts:969`）在首帧前到达 | 子进程是 shell（无 TUI 帧）；慢启动 TUI 56s 内一帧未出；attach 后立刻拖窗口 |
| `clearDetected` | live 输出出现 `\x1b[2J` 而此前/同 chunk 无 `\x1b[?2026h` | shell 里 `clear`、alt-screen 程序退出清屏等，之后**同一 session 内**起 TUI（例如 shell 里敲 pi） |

`clearDetected` 是对 issue 正文（只点了 `stopped`）的扩展，依据是同一守卫区同形状、后果相同（gate 2 恒关）。

**一处事实纠正**：`#11` 的永久笔记与 682f016 的代码注释称「screen-log replay 混合历史 2J + 2026h」。核实：`replayScreenLog()`（`pty-attach.ts:1091`）只调 `pushOutput()`，replay **不喂 controller**；`checkClearSequence()`（唯一调 `jiggleRetry.feed`，`:981`）只在 `onSocketData` 的 live `output` 分支被调（`:1050`）。所以 clear-wins 的真实来源是 **live 的 fullRender 输出块**（pi-tui 在同一同步更新块内发 `2026h … 2J …`），与 #106 的两个终态同源同路径。

**复位路径（故障窗口边界）**：只有 `start()`（socket connect，`pty-attach.ts:427`）全复位 `clearDetected`/`stopped`/`tuiFrameSeen`/`carry`；`heal()`（保留认知，且认知缺失时不可达）、`restoreAndStop()`（G3）、`notifyExternalResize()`（G4）都不复位终态。⇒ **窗口 = 本次连接的整个生命周期**，「用户 reattach 一下就好」不成立（#11 的诉求正是无需用户干预）。

## 复现（确定性，无需 56s 真实等待）

单测层用现成的 `fakeScheduler` 直接 fire 完 G1 + 8 轮退避 → 链进 `stopped`（现有用例 `no re-arm probe after chain exhausted (stopped)` 已示范这条驱动路径）；再 `feed("\x1b[?2026h late frame")` → 当前代码下 `tuiFrameSeen` 仍为 false（红）。`clearDetected` 分支用一次 `feed("\x1b[2J…")` 即可到达。

组件层用 `test-support/desync-heal-smoke.ts` 的既有基座（真 `PtyAttachComponent` + fake TUI + 注入 clock/connected + 真实 socket-data 路径）复现：终态后喂帧 → 当前代码下 `checkDesync()` 不 heal（红）。

## 修复设计

改动只有一个文件、一个函数：`src/core/pty-attach-jiggle-controller.mjs` 的 `feed()`（`pty-attach-jiggle-retry.mjs` 纯层不动——`feedOutput()` 早已返回 `frameStartFound` + `carry`，终态扫描所需信息齐备）。

```js
	function feed(data) {
		// Terminal chain states: a clear was seen (chain done) or the chain ended
		// (G2/G3/G4). Output no longer drives the retry protocol — but frame
		// cognition must still be learned from it (issue #106): a TUI whose first
		// frame lands after the chain settled must still open the runtime desync
		// backstop's gate 2 (issue #11), otherwise heal() stays unreachable for the
		// rest of this connection. Cognition only — no timers, no resizes, and no
		// retry-state change: re-opening the protocol is heal()'s job (rate-limited
		// and lifetime-capped), not an output chunk's.
		if (state.clearDetected || state.stopped) {
			if (tuiFrameSeen) return; // latched already — nothing left to learn
			const terminal = feedOutput(state, data, carry);
			carry = terminal.carry; // keep cross-chunk marker detection intact
			if (terminal.frameStartFound) tuiFrameSeen = true;
			return;
		}
		const result = feedOutput(state, data, carry);
		...（以下原样不动）
```

### 为什么这样切

- **合并两个终态为一个分支**：两者对重试协议的含义相同（链已结束），对认知学习的需求相同；分开写会复制同一段学习逻辑。
- **`if (tuiFrameSeen) return;` 前置短路**：终态里认知已锁存后，每个 chunk 的两次 `includes` 扫描是无用功（惰性 shell session 会长期持续输出）；短路后稳态成本为零，且 `carry` 也不再需要推进。
- **`carry` 仍要推进（仅在未锁存时）**：帧标记 `\x1b[?2026h` 8 字节可能跨 chunk 边界，不推进会漏学（「只学一半」的假修）。
- **不改 retry state**：终态是「协议已结束」的判定，不能被后续输出改写（否则 G2 的预算语义、`no re-arm probe` 契约都被推翻）。

### 契约（终态分支的行为边界）

| 允许 | 禁止 |
|---|---|
| 读 `data`/`carry`，锁存 `tuiFrameSeen`，推进 `carry` | 设/清任何 timer（`chainTimer`/`g1Timer`） |
| 立即返回 | 发任何 resize |
| | 改 `state`（`clearDetected`/`stopped`/`retryIndex`） |

### 数据流（修复后）

```
live 输出 → onSocketData → checkClearSequence → feed()
  ├─ 链活跃：原逻辑（clear 优先 / 首帧 fast-path / F1 慢启动探针）
  └─ 终态  ：未锁存 → feedOutput 扫一遍 → 命中 2026h 即 tuiFrameSeen=true → 返回
                                                            ↓
  desync 探针（2s）→ checkDesync → gate 2 通过 → 后续门（链空闲/静默/限速/失配）
                                                            ↓
                                              heal() → 重新 shrink-and-hold → 子端 fullRender 自愈
```

### 风险与取舍

| 风险 | 评估 |
|---|---|
| 误判面扩大（终态后 latch 的程序不一定是 pi-tui，如 vim 等使用 DECSET 2026 的程序） | 与「链活跃期内 latch」的既有语义完全一致（同一子进程若早 10 秒出帧就会被 latch）。heal 后续仍有 gate 3（光标真失配）+ 静默 + 10s 限速 + 5 次终身上限；伤害面最坏是一次重绘 |
| 惰性链上持续扫描的开销 | 仅发生在「终态 + 认知未锁存」窗口；锁存后立即短路。窗口内每 chunk 成本 = 一次字符串拼接 + 两次 `includes` |
| 把 G2 的「预算耗尽 = 放弃」语义变松 | 不变：终态分支不发 resize、不重开协议，重打开仍由 heal() 的独立预算把关 |

## 备选方案（考虑并否决）

| 备选 | 否决理由 |
|---|---|
| 只在 `stopped` 早退前学习（issue 原文范围） | `clearDetected` 同形状同后果，分两次改动要重复复核同一守卫区（用户已选 B） |
| 把学习点整体移到 `feed()` 最前面（无条件先学，再走各分支） | 等价于 682f016 的写法，但会把「链活跃」路径的学习语义也一并改写（`firstFrame` 与 clear 分支的相对顺序），改动面大于必要；本次只在终态新开一条零副作用通路，既有分支逐字不动 |
| 终态后由 `feed()` 直接走 F1 式 re-arm（重开 hold） | F1 的前提是「预算未耗尽」（`ensureHold` 守卫含 `state.stopped`）；在终态里 re-arm 等于绕过 G2 的预算判定，把「放弃」改成「无限重试」。重打开应交由 heal()（有独立限速与上限） |
| 让 `checkDesync` 的 gate 2 改用别的信号（如「子端曾是 TUI」的其它痕迹） | 无更可靠信号；`tuiFrameSeen` 是现有唯一「子端确实在渲染帧」的证据，改判据会引入误报面（对 shell 子进程 heal 是明确要避免的） |
| 改 `heal()` 使其可在无认知时自举 | 同上：会让 shell 子进程进入 heal 路径，直接违反 gate 2 的设计意图 |

## 非目标

- 不改 G1/G2/G4 的守卫语义、退避表、`heal()` 预算与限速参数。
- 不改 clear-wins 语义（同 chunk 内 clear 仍优先决定 re-arm）。
- 不为「非 TUI 子进程」打开任何 heal 通路（无帧 ⇒ 仍不 heal，H4 语义保持）。
- 不把 56s 的 G2 窗口改短/改长（#106 与窗口长度无关，只与「窗口结束后能否再学」有关）。

## 可测性拆分设计（自动化验证类功能点）

维持现有边界，**不新增抽象**：`pty-attach-jiggle-retry.mjs`（纯函数层：`feedOutput`/`advanceRetry`/`stopRetry`…）不动；`createJiggleRetryController(deps)` 是「状态机 + 注入副作用（`sendResize`/`setTimeoutFn`/`clearTimeoutFn`）」的既有拆分。观测点 = `getState()` 与测试记录下的 `resizes`/scheduler timer 集合——足以证明「认知锁存」与「零副作用」两个断言维度。

| 功能点 | 独立单元 | 测试边界 |
|---|---|---|
| 终态认知锁存（两个终态） | `feed()` 终态分支（输入 `data`/`carry`/`tuiFrameSeen`；**无副作用**：不调 `sendResize`、不设 timer） | controller 单测（`fakeScheduler` + `resizes`）：断言 `getState().tuiFrameSeen` 翻 true、`resizes.length` 不变、timer 集合不变、`stopped`/`clearDetected` 不变 |
| 跨 chunk 帧标记拼接 | `feedOutput()` 的 `carry` 语义（既有纯函数，不改） | controller 单测：先喂半截 `\x1b[?202`（不锁存）→ 再喂 `6h`（锁存） |
| 认知锁存后 heal 可达 | `heal()` 既有入口 | controller 单测：终态 + 锁存 → `heal(cols,rows) === true` 且 `held === true` |
| 组件级 gate 2 真打开 → 真触发一次 heal | `PtyAttachComponent.checkDesync`（注入 `nowFn`/`connected`/`finishAttachTransition`） | `test-support/desync-heal-smoke.ts` 新场景 H8（走真实 socket-data 路径：`pushOutput` + `checkClearSequence`），断言 `healCount === 1` 且 resize 次数 = 1 |
| 无帧子进程仍不 heal（回归） | 同上（H4 既有场景） | smoke H4 保持 `false`（不喂帧 ⇒ 学不到 ⇒ gate 2 仍挡） |

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `stopped` 终态后帧认知仍锁存，且零副作用 | 自动化（unit） | `node --test test/pty-attach-jiggle-controller.test.mjs`（新增用例） | 预算耗尽 → feed 帧 → `tuiFrameSeen=true`；`resizes` 不变；无新增 timer；`stopped` 仍 true |
| A2 | `clearDetected` 终态后帧认知仍锁存，且零副作用 | 自动化（unit） | 同上 | clear-only 终态（无帧）→ feed 帧 → `tuiFrameSeen=true`；`resizes` 不变 |
| A3 | 跨 chunk 拆分的帧标记在终态下仍被 `carry` 接住 | 自动化（unit） | 同上 | 半截标记不锁存；补齐后锁存 |
| A4 | 锁存后 `heal()` 可达（gate 2 打开） | 自动化（unit） | 同上 | `heal(cols,rows) === true`，`held === true`，`tuiFrameSeen` 保持 true |
| A5 | 组件级：终态（shell，无帧）后晚到帧 → 真触发一次 heal | 自动化（integration） | `node --test test/pty-attach-desync-heal.test.mjs`（新增 H8 断言） | `healCount === 1` 且 resize = 1；H4（无帧）仍为 false |
| A6 | 零副作用契约（终态后不发 resize）回归 | 自动化（unit） | 同 A1 | 既有 `no re-arm probe after chain exhausted (stopped)` 保持绿（27 条 controller 用例全绿） |
| A7 | 静态与类型 | 自动化（static） | `npm run typecheck` | 无错误 |
| A8 | 全量回归 + 打包 | 自动化（build） | `npm test`、`npm run verify`（含 `test:coverage`、`pack:dry`） | 全绿，无新增未覆盖分支告警 |
| A9 | 红/绿自证（TDD 纪律） | 自动化（unit + integration） | 先在未改源码上跑 A1–A5 断言 | 修复前必失败（红），修复后必通过（绿）；red 证据记入 PR |
| U1 | 真实 session 观察性验收 | 用户实测（**非阻塞**） | 1) attach 到一个 shell 型/长静默 session；2) 等链走完预算（>60s）或先 resize 一次；3) 在该 session 内启动 pi；4) 观察是否出现周期性全清重绘 | 无误触发闪烁；若发生真失配，限速周期内自愈。**pending 理由**：需真实 ≥56s 无帧窗口 + 人为构造失配，脚本化成本高、收益低；与 #11 的 U1 同性质，合并观察 |

## 附：随修复一并提交的文档纠正（可单独 revert）

同一 doc-comment 块内的这句陈述不准确：「a clear only proves the child redraws, not that it isn't a TUI (**screen-log replay bundles historical frames with clears**, issue #11)」。依据：replay 不喂 controller（`replayScreenLog` 只调 `pushOutput`），真实来源是 live 的 fullRender 输出块。建议改为「a live fullRender chunk bundles a frame start with its clear」。理由：错误的成因描述会把后续排查引向 replay 路径。**若 review 认为应保持最小 diff，可单独 revert 这一句，不影响修复正确性。**
