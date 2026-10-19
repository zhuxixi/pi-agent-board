# Spec — Issue #170: attach 入站应答护栏（终端应答碎片不再漏进子进程输入框）

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T07:53:40+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T08:02:08+08:00（round-1：R1-G1/G2 接受并改；R1-D1/D2 接受并改；R1-D3 部分接受）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T08:12:00+08:00（round-2：R2-D1/D2/D3 全部接受并改）

> 状态：**DRAFT v3 — 交叉复核已收敛（第 2 轮真缺口 0）→ ⏸ 等用户确认设计**
> 认领：zhuxixi（2026-10-14）；基线 HEAD：`acc40fd`（main；origin/main 已到 `f81949d`，本 issue 涉及文件一致）
> 路由：bug → `systematic-debugging`（Phase 1 根因调查已在 research 完成，本文档是 Phase 2-4 的产出）
> 调研：`research/01-in-repo-mechanism.md`（本仓机制与硬约束）、`research/02-upstream-wire-evidence.md`（上游源码级链路与真实字节）、`research/03-test-infrastructure.md`（可测性落点）
> 上游：earendil-works/pi#10657（OPEN，同族 #10256 OPEN、#8603 closed、#10250 closed）
> 关联：#128（终端能力透传）、#148/#161（settle 探针）、#180（子进程就绪门）

## 1. 问题陈述

**每次 attach 进一个会话，子进程输入框会被塞进字面垃圾**（本机稳定为 `c7c`，zsh 子进程的提示行与 pi 子进程的 composer 都中招）。垃圾来自真实终端对 DA1 查询的应答碎片，经 pi-tui 的输入管线落到 attach 覆盖层，再由覆盖层「未识别输入一律透传」的兜底送进子进程。

影响面有两个，第二个是本 issue 立题以来新确认的：

1. **子进程输入被污染**：用户 attach 后立即要按退格清掉垃圾；自动化子进程（headless worker、脚本）会把这段文本当成 prompt 内容的一部分。
2. **本地终端探测恒超时**：碎片化的 DA1 永远不会作为单一事件到达 pi-tui 的 `consumeTerminalColorResponse`，所以 `queryTerminalColors` 只能走超时路径——这是本机每条 attach 都记 `attach_settle_scheme: timeout` 的直接原因之一。

真实字节（上游 #10657 记录，WezTerm 20240203 + WSL2/ConPTY）：DA1 应答 28 字节 `ESC[?61;6;7;22;23;24;28;32;42c`，以 8 字节读交付，间隔 >50ms：`ESC[?61;6;` / `7;22;23;` / `24;28;32` / `;42c`。

## 2. 根因

**根因是两个超时阈值与一张「只覆盖 OSC/DCS/APC、不覆盖 CSI」的排除表：CSI 形状的应答头在 50ms 后被 `StdinBuffer` 当作输入事件发出，再过 150ms 被 `ProcessTerminal` 当作普通输入 flush；应答尾部逐字符发出，落到覆盖层的兜底透传。**

四段链路（每段已在 pi 1.2.0 安装产物中核到行）：

| # | 层 | 行为 | 位置 |
|---|---|---|---|
| 1 | 终端 | 只答 DA1，应答被切成 4 个 8 字节读 | WezTerm + ConPTY 实测 |
| 2 | `stdin-buffer.js` | `DEFAULT_SEQUENCE_TIMEOUT_MS = 50`；`TERMINAL_REPLY_HEADER_PATTERN` 只匹配 OSC/DCS/APC，**CSI 不在内** → 前缀武装 50ms 超时后被当 `data` 事件发出 | `:21`、`:27`、`:344-352` |
| 3 | `terminal.js` | `KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150`；只认 `^\x1b\[\?(\d+)u$`（kitty flags）与 `^\x1b\[\?[\d;]*c$`（DA）为完整；前缀缓冲 150ms 后 `flushKeyboardProtocolNegotiationBufferAsInput()` **当普通输入转发** | `:13`、`:16-28`、`:239-263`、`:274-287` |
| 4 | 本仓覆盖层 | 尾部碎片不以 `ESC` 开头 → `stdin-buffer` 走 not-escape 分支逐字符发出 → `PtyAttachComponent.handleInput` 兜底 `send({type:"input"})` | `src/ui/pty-attach.ts:295`（函数体末尾） |

**为什么修在覆盖层**（Phase 2 模式分析）：

- **工作样例就在上游**：`readKeyboardProtocolNegotiationSequence` 已经实现了「前缀缓冲 + 拼接补全」，`stdin-buffer.js` 的 `TERMINAL_REPLY_HEADER_PATTERN` 已经实现了「可识别应答头永不 flush」。两处都证明了这套模式可行，缺的只是**覆盖面**（CSI 家族 + 覆盖层这一侧）。本改动是这两个模式的嵌入方超集，不是新发明。
- **上游不可控且不在本仓范围内**：#10657 至今 OPEN；patch `node_modules` 的机制在本仓已退役（升级即失效）。
- **损坏发生在子进程可见面上**：无论上游将来是否修好，覆盖层丢弃「对子进程无意义的应答」都是纵深防御；且本仓的兜底透传是**所有**未识别输入的必经之路，只有它能统一兜住。

## 3. 设计

### 3.1 模块契约（纯函数，零依赖）

新模块 `src/core/terminal-reply-guard.mjs`（与 `terminal-query-sequences.mjs` 同层同风格：纯函数、无 I/O、无定时器、不 import pi-tui）。

```js
export const REPLY_GUARD_WINDOW_MS = 250;
export const REPLY_GUARD_MAX_ABSORB_BYTES = 64;

/** 单事件分类，无状态。 */
export function classifyReplyEvent(data) => Classification;
//  { kind: "reply-head",     family }       ← 需要进入暂存态
//  { kind: "reply-complete", family, action: "forward" | "drop" }
//  { kind: "plain" }                         ← 可能是应答尾部
//  { kind: "other" }                         ← 键/鼠标/paste 等（非纯文本）

/** 纯状态机：不持定时器，时间由调用方注入。 */
export function createReplyGuard({ windowMs = REPLY_GUARD_WINDOW_MS, maxAbsorbBytes = REPLY_GUARD_MAX_ABSORB_BYTES } = {}) => ({
	feed(data, now) => Decision,     // {action:"pass"} | {action:"swallow"} | {action:"forward", data}
	expire(now) => Decision | null,  // 窗口到期时调用：{action:"swallow"}，此后回到 idle 返回 null
	pendingSince() => number | null, // 供接线层决定是否武装定时器；idle 为 null
	reset() => void,
});

/** 分类表（家族 → 完成形状 → 动作）。 */
//  drop    : ESC[?…c (DA1/DA3) · ESC[>…c (DA2) · ESC[?<n>u (kitty flags) · ESC[6;<h>;<w>t (cell size) · ESC P … ST (DCS)
//  forward : ESC[?997;<n>n (color-scheme report；单数字值均接受，子进程解析器自行拒绝未知值) · ESC]4;N;… / ]10;… / ]11;… / ]12;… (BEL|ST)
```

### 3.2 分类与动作表

| 家族 | 完成形状 | 动作 | 理由 |
|---|---|---|---|
| DA1 / DA3 | `ESC[?<params>c` | **drop** | #128 已决策不转发 kitty/DA；子进程的协商发生在 spawn 时，attach 后收到的 DA 对应答对它无意义 |
| DA2 | `ESC[><params>c` | **drop** | 同上 |
| kitty flags | `ESC[?<n>u` | **drop** | 同上（转发会污染共享终端的 kitty 栈顶） |
| cell size | `ESC[6;<h>;<w>t` | **drop** | XTWINOPS 应答，子进程在 attach 后不消费 |
| DCS | `ESC P … ST` | **drop** | XTVersion 等，子进程不消费 |
| color-scheme report | `ESC[?997;<n>n` | **forward（整条）** | #128/#180 链路：子进程的 pi-tui 解析器消费它（正则锚定 `^…$`，必须整条到达）。单数字值（含未知的 `3`）都整条转发：本 guard 不做值域校验，子进程解析器自行拒绝未知值 |
| OSC 彩色应答 | `ESC]4;N;…`、`ESC]10;…`、`ESC]11;…`、`ESC]12;…`（BEL 或 ST 终止） | **forward（整条）** | #128 的自动主题依赖整条转发（KB `202609232016086714`） |
| 其它一切 | — | **pass** | 交回 `handleInput` 原链路（mouse → 键位拦截 → 兜底透传），语义不变 |

### 3.3 状态机

只有两个状态：`idle` 与 `armed`。

| 当前态 | 输入 | 下一态 | 动作 |
|---|---|---|---|
| idle | `reply-head` | armed（记 `since=now`，缓冲=该事件） | swallow |
| idle | `reply-complete` | idle | 按动作表：drop → swallow；forward → 整条转发 |
| idle | `plain` / `other` | idle | pass |
| armed | `plain` 且 缓冲+事件 ≤ `maxAbsorbBytes` | armed | swallow（追加缓冲） |
| armed | `plain` 且超上限 | idle | swallow（丢弃缓冲与该事件，**有界**损失） |
| armed | 拼接后命中 `reply-complete` | idle | 按动作表（`forward` 时转发**拼接后的整条**，`drop` 时 swallow） |
| armed | **新 `reply-head`（未与缓冲拼接命中）** | armed（重新武装） | 丢弃旧缓冲，以新事件为缓冲并把 `since` 重算为 `now`，swallow |
| armed | **`reply-complete` 且未与缓冲拼接命中**（自身即完整应答） | idle | 丢弃旧缓冲，按**该事件自身**的动作表处理（`forward` → 整条转发；`drop` → swallow） |
| armed | `other`（键/鼠标/paste 等） | idle | 丢弃缓冲，然后 **pass 该事件**（保住用户意图） |
| armed | `expire(now)` 且 `now - since ≥ windowMs` | idle | swallow（丢弃不完整缓冲） |

设计要点与理由：

1. **窗口只由 `reply-head` 武装**，只有「永不可能是按键/鼠标编码前缀」的形状才武装：`ESC[?`、`ESC[>`、`ESC[6;`、`ESC P`、`ESC]1`、`ESC]4`。`ESC` 单独、`ESC[`、`ESC[5`/`ESC[6`（PageUp/PageDown 头）、`ESC[<`（SGR mouse）、`ESC O`（SS3）**一律不武装**——否则会在 250ms 内吞掉用户的按键。
2. **250ms 窗口覆盖的是「head 交付之后、尾碎片陆续到达」的跨度**（不是上游阈值）：head 到达 `handleInput` 时上游两级超时（50ms + 150ms）已经消耗完，窗口是从 head 到达的那一刻起算，要吸收的是之后各段尾碎片的读间隔总和（上游记录 >50ms/段，4 段证据约 150ms）再留余量。
3. **上限 64 字节**：真实应答尾 ≤ 32 字节（DA1 尾部 20 字符），上限只用于把「用户快速输入」的损失限定成有界量，避免无界吞输入。
4. **不完整就丢**：窗口到期仍在 armed → 丢弃。扔掉的是一段永远补不全的应答前缀，对子进程只有害处（半条 OSC 可能被行规程回显成可见字样，正是 #180 记录过的形态）。
5. **`other` 事件先结束事件再放行**：避免「用户按了 PageUp 却被吞掉」这类不可接受的体验；代价是极端情况下把应答尾留下一小部分（用户按键导致 state 结束，后续尾巴变成 pass → 落进兜底透传）。这是**有意的边界**：宁可少吞一点垃圾，不可吞用户按键。

6. **近失形状的归属**（R2-D3）：完整但参数为空的 DA（`ESC[?c`）按完成形状处理（drop）；不完整前缀（`ESC[?1;`、`ESC[6;`、`ESC[6;24;80`、`ESC]11;`、`ESC P`）一律武装（swallow）；未知第三值的 997 报告按 forward 家族整条转发。这三类由 A1/A4 的「近失形状」清单锁死，不得靠实现者自由发挥。

7. **修正（issue #213）**：第 1 条「`ESC[6;` 永不可能是按键前缀」已被推翻 —— kitty 功能键编码
   把 PageDown 放在 `CSI 6;<mods>u`（modifyOtherKeys 为 `\x1b[6;<mods>~`），与 cell-size 的
   `ESC[6;` 共享前缀。「完整 CSI 键序列优先」（#213）是现行规则：以 `u`/`~` 终结的完整键序列
   先于 head 前缀判定，不带终结符的片段仍然武装。实现见 `CSI_KEY_SEQUENCE`。

### 3.4 接线点

`src/ui/pty-attach.ts` 的 `handleInput(data)` **最前面**（在既有 mouse/key 拦截之前）：

```ts
handleInput(data: string): void {
    const decision = this.replyGuard.feed(data, Date.now());
    if (decision.action === "forward") { this.send({ type: "input", data: decision.data }); return; }
    if (decision.action === "swallow") return;
    // ...既有逻辑（parseMouseInputChunk → PageUp/Down/Home/End → Ctrl+\ → Ctrl+← → ← → 兜底透传）原样不动
}
```

- 定时器：`feed` 返回后若 `pendingSince() !== null` 则武装一个 `windowMs` 定时器（重复 feed 不重复武装），回调里 `expire(Date.now())`；`close()`/`done()` 走 `reset()` 并清定时器（与 `detachColorSchemeBridge` 同样的清理纪律）。
- kill switch：`AGENT_BOARD_REPLY_GUARD=0`（也接受 `off`/`false`）时**不创建 guard**，`handleInput` 走原逻辑（guard 为 null 即跳过），语义等价于改动前。该开关必须在 README 登记（与 `AGENT_BOARD_FORWARD_TERMINAL_QUERIES` 同处：环境变量表行或配置段落），验收项见 A9。
- **与 #180 无重叠**：#180 的 `childInputReady` 门在 `deliverSettleScheme`（send 侧、出站），guard 在入口侧（入站）；两者不共享状态。
- **与 #128 的既有转发是加法关系**：guard 的 `forward` 走与今天兜底完全相同的 `send({type:"input"})`，只是多了一条「碎片拼接后整条转发」的路径。

### 3.5 决策表（被否方案）

| 方案 | 否决理由 |
|---|---|
| 把兜底改成白名单（只放行可打印字符） | 会挡掉 Alt 组合、SS3、kitty/modifyOtherKeys 修饰键等合法输入；`ESC[27;5;92~` 这类是用户按键而非应答 |
| 只丢弃 `ESC` 开头的未知序列，不管尾碎片 | 尾碎片（真凶）恰恰不以 `ESC` 开头 |
| 在子进程侧治理（如往子 PTY 写前过滤） | 子进程是任意程序（zsh 也中招），本仓无法控制 |
| patch `node_modules` 里的 pi-tui | patch 机制已退役，升级即失效 |
| 只文档化 + 等上游 #10657 | 上游 OPEN 且无时间表；护栏是纵深防御，不与上游修复冲突 |
| 把窗口做成「永久吸收直到超时无上限」 | 无界吞输入不可接受；有界损失 + kill switch 是更小的恶 |

## 4. 边界与非目标

**明确不做**：不修上游（不动 `node_modules`）；不改本地 `queryTerminalColors` 的超时行为（它的超时是上游碎片化导致的**结果**，本改动不声称修复它）；不做应答合成/重放；除一个需在 README 登记的 kill switch 外不引入新配置项。

**已知边界**：窗口内的快速打字可能被吞（≤64 字节，250ms，可 kill switch 关闭）；**尾碎片晚于窗口到达时仍会漏**——窗口从 head 到达起算，若终端读间隔异常拉长（更慢的 ConPTY、网络终端、重负载），最后一段尾碎片可能落在窗口之外并被兜底透传进子进程；U1 的 ≥5 次 attach 观察就是这条边界的探测手段（属于「降低发生率」而非「数学上消除」）；DSR/CPR（`ESC[<r>;<c>R`）家族**不在本次范围**——它需要「`ESC[` + 数字」这类与按键编码（`ESC[6~`、`ESC[27;5;92~`）共享前缀的武装规则，风险与本改动不同量级，另案处理（本次先记录）。`ESC[` 单独作为 negotiation 前缀是 pi-tui 自己的行为，本 guard 不重复。

## 5. 验收矩阵

**U 项共享部署前置（R1-G2）**：先让被测 pi 会话真的加载本改动——按 `VERIFY.md:55` 的方式 `pi install "$(pwd)"`（指向含本改动的 checkout；合并发布后可改 `pi install npm:@zhuxixi/pi-agent-board`）→ 重启 pi，或按 `VERIFY.md:101` 的 `/reload` → 确认扩展加载无报错、`/agent-board` 可打开 → 再执行 U1–U3。可执行时机：worktree 实现完成且 `npm run verify` 通过后在合并前试点；合并发布后可复验。缺这一步会在旧安装上得到假阴性「通过」。

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | 完整应答形状的分类与动作 | 自动化（unit） | `node --test --test-name-pattern="A1" test/terminal-reply-guard.test.mjs` | drop 家族（DA1/DA2/DA3、kitty flags、cell size、DCS）全部返回 drop；forward 家族（997 报告、OSC 4/10/11/12 的 BEL 与 ST 两种终止）返回 forward。**近失形状**：空参 DA1 `ESC[?c` → drop；未知第三值报告 `ESC[?997;3n` → forward；完整但未知的 CSI（如 `ESC[1;2R`）→ pass（不误判为任何家族）（R2-D3） |
| A2 | 碎片重组：4×8 字节 DA1 | 自动化（unit） | `node --test --test-name-pattern="A2" …` | 四段依次 feed 后：前三段全部 swallow、第四段 swallow，`sent`/forward 次数为 0；缓冲与状态回到 idle |
| A3 | 窗口语义、有界损失与 armed 态的按键放行 | 自动化（unit） | `node --test --test-name-pattern="A3" …` | ① 窗口未到期的 `plain` 被吸收；② 到期 `expire` 丢弃并回 idle；③ 超上限时丢弃并回 idle；④ `reset()` 立即回 idle 且不带残留；⑤ 两次独立事件不串味；⑥ **armed 态收到 `other`**（`ESC[5~`、`ESC[<35;20;5M`、`ESC[200~…ESC[201~`）→ 该事件 **pass**、缓冲被丢弃、`pendingSince()` 回 null、其后的 `plain` 不再被吸收（R1-G1）；⑦ **armed 态收到新的 `reply-head`** → 保持 armed 且 `since` 以新事件重算，旧缓冲不再参与拼接（R1-D2）；⑧ **armed 态收到「自身完整但未与缓冲拼接命中」的 `reply-complete`**（如 250ms 内整条到达的 OSC 11 回复）→ 旧缓冲被丢弃、按该事件自身动作表处理（forward 时逐字节断言内容相等）、回 idle、`pendingSince()` 回 null（R2-D2） |
| A4 | 非应答输入不被吞（idle 态基线） | 自动化（unit） | `node --test --test-name-pattern="A4" …` | `ESC[5~`、`ESC[6~`、`ESC[H`、`ESC[F`、`ESC[3~`、`ESC[<35;20;5M`、`ESCOA`、`ESCOB`、`ESC`、`ESC`+字母、`ESC[27;5;92~`、`ESC[92;5u`、`ESC[200~`、普通文本 全部 pass；且这些事件之后 `pendingSince()` 仍为 null（未被武装）。本项是 idle 态基线，armed 态下的同类事件见 A3⑥。**近失前缀**：`ESC[?1;`、`ESC[6;`、`ESC[6;24;80`、`ESC]11;`、`ESC P` 全部武装（`pendingSince()` 非 null）且不发任何帧；而完整的非应答 CSI（`ESC[1;2R`）pass 且不武装（R2-D3） |
| A5 | 彩色应答整条转发（含碎片形态） | 自动化（unit） | `node --test --test-name-pattern="A5" …` | 完整 OSC 11 回复（BEL/ST）与 `ESC[?997;1n` / `ESC[?997;2n` → forward 且内容逐字节相等；碎片化的 OSC 11 回复被拼接后整条 forward |
| A6 | 组件接线：`sent` 帧里不再有垃圾 | 自动化（component smoke） | `node --test test/pty-attach-reply-guard.test.mjs` | 把 4×8 字节 DA1 经真实 `handleInput` 喂入：捕获的 `input` 帧为 0（改动前会捕获到 4 帧）；喂入 OSC 11 回复：捕获到 1 帧且逐字节相等 |
| A7 | kill switch 与清理 | 自动化（component smoke + unit） | `node --test test/pty-attach-reply-guard.test.mjs` | `AGENT_BOARD_REPLY_GUARD=0` 时 4×8 字节 DA1 全部照旧透传（捕获 4 帧）；`close()` 后残留定时器不再产生任何 `send` |
| A8 | 静态与回归 | 自动化（static + 全量） | `npm run typecheck && npm test` | 「类型检查通过」且「既有测试全绿（无回归）」 |
| A9 | kill switch 的可发现性（文档契约） | 自动化（static） | `rg -n "AGENT_BOARD_REPLY_GUARD" README.md` 且人工核对落点 | **硬性落点**：`README.md` 的 `## Configuration` 段（:302 起）变量表新增一行（默认启用；`0`/`off`/`false` 关闭；写明 ≤64 字节 / 250ms 吞入边界与逃生场景）；功能散文里另提可作补充但不满足本条。**不得**以 `AGENT_BOARD_FORWARD_TERMINAL_QUERIES` 为锚定先例——后者只登记在功能散文（`README.md:96`、`:203`），不在 Configuration 表内，而表内已含其余全部布尔开关（R1-D3 实质 + R2-D1 修正） |
| U1 | 真机：attach 不再出现碎片垃圾 | 用户实测 | 在会慢速应答的终端（WezTerm+WSL2/ConPTY、mintty 等）attach 进一个 pi 子进程与一个 zsh 子进程，观察 composer/提示行 | 连续 attach ≥5 次，子进程输入框**不出现** `c7c` 一类的字面碎片 |
| U2 | 真机：自动主题无回归 | 用户实测 | 浅色终端里 attach 一个配 `theme: light-warm/dark` 的子进程 | 子进程主题随终端亮暗正确；`attach_settle_scheme` 诊断仍有 outcome（允许 timeout 形态保留，超时不是本次验收目标） |
| U3 | 真机：输入可用性无回归 | 用户实测 | attach 后依次执行：正常打字、PageUp/PageDown 滚动、中键粘贴、拖选拷贝、250ms 内快速连打 10 个字符 | 五类操作行为与改动前一致；快速连打最多损失不超过 64 字节（不符合则记录实际形态） |

## 6. 可测性拆分设计

判定逻辑与副作用严格分离，测试边界如下：

| 单元 | 形态 | 测什么 | 不测什么 |
|---|---|---|---|
| `classifyReplyEvent(data)` | 纯函数（无状态、无时间） | 单事件分类与动作（A1、A4 的 pass 侧、A5 的完整形态） | 状态、窗口、转发 |
| `createReplyGuard().feed/expire/pendingSince/reset` | 纯状态机（时间由参数注入） | 碎片重组、窗口、上限、reset（A2、A3、A5 的碎片形态） | 定时器、socket、UI |
| `PtyAttachComponent.handleInput` 接线 | 薄接线（三行分支 + 定时器武装） | 三态决策是否正确落到 `send`/return（A6、A7） | 字节矩阵（已在纯模块层覆盖） |

- 因此组件层 smoke **不重复**纯模块的字节矩阵：它只验「四个碎片 → 0 帧」与「OSC 回复 → 1 帧」两条端到端事实，加 kill switch 与 close 清理。
- 测试基座（模板）：纯模块层用 `test/terminal-reply-guard.test.mjs`（风格照 `test/terminal-query-sequences.test.mjs`）；组件层用 `test-support/attach-reply-guard-smoke.ts` + `test/pty-attach-reply-guard.test.mjs`（形态照 #180 的 `attach-scheme-readiness-smoke.ts` + `test/pty-attach-scheme-readiness.test.mjs`：真实组件 + 只替换 `send`/`connected`，`execFileSync('--experimental-transform-types')` 取回 JSON）。
- fixture 基准：上游 #10657 记录的真实 28 字节 DA1 与 4×8 切分；合成变体（DA2 `ESC[>41;330;0c`、单字符尾、`ESC[?997;2n`、OSC 11 BEL/ST、`ESC[6;24;80t`）。**全部字节字面量写死在测试里**（生产代码不得 import pi-tui）。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 窗口内吞掉用户输入（最坏 64 字节 / 250ms） | 有界 + 只在应答头之后 + `AGENT_BOARD_REPLY_GUARD=0` kill switch；U3 真机确认 |
| 误判导致彩色应答被丢 → 自动主题失效 | forward 家族单测锁死（A5）+ U2 真机确认；kill switch 兜底 |
| 半条应答在前缀判定上开洞（如 `ESC[?1;` 被判成 drop 家族混入） | 分类表以「完成形状」为准，前缀只用于武装不用于动作；近失形状（空参 DA、未知 997 值、不完整前缀、完整但未知的 CSI）逐条列入 A1/A4 并写明期望分类（R2-D3） |
| 与上游将来修复叠加产生双重处理 | 上游修复发生在 pi-tui 内部（更早的层），本 guard 只在「上游已放弃」的碎片上生效，两者叠加时 guard 无输入可处理，无冲突 |
| 定时器泄漏 | A7 覆盖 close 路径；接线层与 `detachColorSchemeBridge` 同纪律 |
