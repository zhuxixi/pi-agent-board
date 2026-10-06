# Spec: 修复 attach 落定的亮暗交付（issue #161）

Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-10-04T23:59:27+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-10-05T23:16:10+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-10-06T22:29:11+08:00

> 状态：v3（第 2 轮复核收敛：真缺口 0，细化 R2-D1~D3 已处置）——⏸ 等待用户确认设计，确认后进步 5（worktree）。
> 依据：issue #161 正文 + 三轮调研（`research/root-cause-probe-api-rename.md`、
> `research/fix-surface-api-availability.md`、`research/observability-hook-points.md`）。

## 1. 根因（已证实）

**落定探测调用的 pi-tui 方法在 pi ≥ 0.99 已改名，调用抛 `TypeError` 被 `catch {}` 吞掉，
probe 从未执行——settle 时刻的亮暗交付在 pi ≥ 0.99 上恒为 no-op。**

证据链：

1. `src/ui/pty-attach.ts:664`（origin/main，#165 后）调用
   `this.tui.queryTerminalBackgroundColor({ timeoutMs })`；665-667 行 `catch {}` 静默。
2. pi-tui 版本考古（npm tarball `tui.d.ts` 核对）：0.79.8 / 0.87.1 仅有旧名；
   0.99.0 / 0.99.2 / 1.0.0 / 1.0.2 仅有 `queryTerminalColors`。改名点 = 0.87.1 → 0.99.0。
3. `pi-coding-agent@0.99.2` 依赖 pi-tui ^0.99.2 → 事发环境（2026-10-01，pi 0.99.2）已改名，
   probe 当时即 no-op；当前本机 pi 1.0.2 亦然。
4. CI 绿的原因：repo devDeps 钉 0.79.8（旧名在，typecheck 过），测试 fake 只带旧名；
   运行时扩展副本 node_modules/@earendil-works 为空，peer 依赖由宿主 pi 解析（仅新名）
   → 开发面与运行面漂移。
5. 排除备选：settle 未触发 / 发送链路断——#165 修的回声残渣证明 settle 钩子在跑；
   「应答被僵尸条目吃掉」是旧实现的失败模式，且根本走不到那一步（调用即抛）。
6. （复核补强）扩展组件拿到的 tui 是 `createInteractiveTuiReference` 返回的透明 Proxy
   （pi 1.0.2 tui-renderer.js:37-66，get/set/has 全量转发底层 TuiBase）→ 旧名经
   `Reflect.get` 得 undefined、调用即 TypeError（与根因自洽）；新名 `queryTerminalColors`
   真实存在且可调（TuiBase 实现，tui.js:1056）——修复假设实现级成立。

**#165 合并后的现状**：settle 交付只剩 probe 一条路（D3 已删；D2 桥只转发宿主消费到的
scheme 事件，救不了落定即错的子 pi）→ 任何「子 pi spawn 时拿不到真实亮暗」的 attach 必现
恒 dark，直到外部 997 推送。比 issue 提交时更严重（当时 D3 至少还会发裸查询）。

## 2. 修复设计

### 2.1 决策表

| 决策点 | 选择 | 理由 | 被拒备选 |
|---|---|---|---|
| 探测 API | feature-detect：优先 `queryTerminalColors`（新），回退 `queryTerminalBackgroundColor`（旧），皆无则不发探测 | peerDependencies 为 `*`，须同时覆盖新旧宿主；#165 后 settle 只剩这条路 | 只用新名（砍掉 ≤0.87 宿主）；维持旧名（= 现状，坏的） |
| 迟到应答 | 新 API 传 `onLateReply`；到达时若组件未 closed **且 scheme 不同于已发送值**才补发一次 997；相同则跳过 | 上游已把迟到应答导向回调（tui.js:1064-1068）；997 幂等但重复发送是诊断噪音、违背 #148「一次探测」克制精神 | 忽略迟到（慢链路首拍仍 dark）；无去重（每次 attach 可能发两条相同 997） |
| 「读已解析状态」 | 不做 | 扩展面 TUI 接口无同步 getter（1.0.2 tui.d.ts 无 getTerminalTheme 暴露）；宿主进程直连真实终端、队列干净、WezTerm 毫秒级答 OSC 11，一次查询等价可靠 | issue 方向 2 原案（无 API 可用） |
| scheme 事件缓存重发 | 本期不做 | scheme 事件只在外部推送时触发；board 重启场景宿主是新进程、缓存必空，边际价值低 | 记为后续可选加固（开放问题 2） |
| 可观测性 | 组件 `onDiagnostic` 发 **DiagnosticEvent 兼容 patch**（code/source/level/message/details），两处构造点 wiring 直传 `appendDiagnostic(root, viewId, patch)` | `normalizeDiagnostic` 只保留 level/code/runId/source/message/details 白名单，其余字段会被丢弃——事件必须在源头就按既有 schema 构造 | 组件直写文件（层穿透、难单测）；自定义字段名（会被白名单丢弃，R1-G1） |
| devDeps 0.79.8 → 1.0.x | 本期不做 | 全量类型面迁移，独立 PR；本期用 feature-detect + 本地结构类型 + 局部 cast | 混入会放大回归面 |
| kill switch | 保留 `AGENT_BOARD_FORWARD_TERMINAL_QUERIES=0` | 既有回退语义（probe + D2 桥同关） | — |

### 2.2 数据流（settle 时刻）

```
finishAttachTransition（现有，不变）
 └─ probeAndReportRealTerminalColorScheme（重写编排）
     ├─ resolveProbeApi(this.tui)                      [新纯函数，terminal-query-sequences.mjs]
     │    api=colors    → tui.queryTerminalColors({timeoutMs, onLateReply})
     │                    → colors.background → RgbColor
     │    api=background→ tui.queryTerminalBackgroundColor({timeoutMs}) → RgbColor
     │    api=none      → 仅诊断事件，不发探测
     ├─ colorSchemeForBackgroundRgb(rgb)               [现有纯函数，不动]
     ├─ toColorSchemeReport(scheme)                    [现有纯函数，不动]
     ├─ this.send({type:"input", data:997…})           [现有通道，不动]
     └─ onDiagnostic(DiagnosticEvent 兼容 patch)       [新回调，缺省 no-op]
onLateReply(colors) →
    closed                            → 不发送，记 outcome=dropped_closed
    scheme 与已发送值相同             → 不发送，记 outcome=duplicate_skipped
    否则                              → 补发一次 997，记 outcome=reported + late:true
```

### 2.3 组件契约与改动面

- `src/core/terminal-query-sequences.mjs`（落点钉死，与 `colorSchemeForBackgroundRgb` 同域）：
  - `resolveProbeApi(tuiLike) → {api:"colors"|"background"|"none", invoke(tuiLike, timeoutMs, onLateReply?) → Promise<RgbColor|undefined>}`
    —— 纯检测 + 适配器，输入输出 plain object，零副作用。
  - `backgroundRgbFromTerminalColors(colors) → RgbColor|undefined`——纯映射。
  - **编译期类型约束**：本仓编译面是 pi-tui 0.79.8，没有 `TerminalColors` 类型也没有
    `queryTerminalColors` 方法 → 上述两个函数使用**本地定义的最小结构类型**
    （如 `interface TerminalColorsLike { background?: RgbColor }`），**禁止
    `import type { TerminalColors }` 自 pi-tui**；`typeof` 检测与必要的 cast 封装在
    `invoke` 内部，不外溢到编排层。
- `src/ui/pty-attach.ts`：
  - `PtyAttachOptions`（pty-attach.ts:24，实名）增加可选
    `onDiagnostic?: (event: AttachSettleDiagnosticPatch) => void`（缺省 no-op）。
  - `probeAndReportRealTerminalColorScheme` 重写为上述编排；每步失败写诊断后静默返回
    （保持 #148 的 best-effort 语义，但可观测）。
- **两处构造点都要注入**（当前为同构重复的两个 `openPtyAttach`，是否去重由 plan 决定，
  去重本身非目标）：
  - `src/commands/attach-flow.ts:33-37`（export 的 `openPtyAttach`，供 `attach()` /
    键盘回退路径）；
  - `src/commands/agent-board.ts:226-251`（私有 `openPtyAttach`，供 dashboard attach
    动作，构造在 238-240 行）。
  两处工厂闭包均持有 `root` 与 `viewId`，把 `onDiagnostic` 接到
  `appendDiagnostic(root, viewId, patch)`（与现有 `screenLogPath(root, viewId)` 同源）。
- **诊断事件契约（映射到既有 `DiagnosticEvent` schema，字段名必须落在
  `normalizeDiagnostic` 白名单内，否则会被静默丢弃）**：
  - `code: "attach_settle_scheme"`（snake_case，对齐 `host_crashed` /
    `host_crash_owner_changed` 等现有 code 命名）
  - `source: "attach"`
  - `level`: **「预期交付但失败」才 `"warn"`**——`timeout` / `error` / `no_background` /
    `no_probe_api` / `dropped_disconnected`；正常/预期操作用 `"info"`——`reported` / `duplicate_skipped` /
    `dropped_closed` / `suppressed`（后三者是慢链路正常去重、用户快速 detach、用户主动
    kill switch；标 warn 会污染 `summarizeDiagnostics` 的 warningCount——diagnostics.mjs:60
    计数、store.mjs:425 并入行摘要被 dashboard 消费）
  - `message`: 人类可读摘要（如 `attach settle scheme reported via queryTerminalColors (light)`）
  - `details: { probeApi: "colors"|"background"|"none", outcome:
    "reported"|"timeout"|"error"|"no_background"|"no_probe_api"|"dropped_closed"|
    "dropped_disconnected"|"duplicate_skipped"|"suppressed", report?: "997;1"|"997;2", late?: true }`
    （camelCase，对齐既有 details 键风格如 `ownerChanged`；`report` 仅在发送 997 时携带；
    kill switch 的 suppressed 事件不填 `probeApi`）
  - 组件的 `onDiagnostic` 即以上述 patch 形状发出，wiring 层直接透传给
    `appendDiagnostic(root, viewId, patch)`，不做二次映射。
  - **outcome 判定规则（实现与 A9 的对齐依据）**：
    (a) `timeout` 与 `no_background` 的区分——api=colors 时，返回对象**任一字段**
    （foreground / background / palette 任一项）有值但 `background` 缺失 →
    `no_background`（终端应答了但没答 OSC 11）；返回对象**完全为空** → `timeout`
    （pi-tui 1.0.2 tui.d.ts:376-378：未应答的颜色为 undefined，两种情形在返回值层面
    仅靠「是否有任何字段有值」区分）；api=background 时 `undefined` → `timeout`
    （旧 API 只查 OSC 11，无法细分）。
    (b) 去重基准 `sentScheme` 初始为 `null`；`null` 不命中 duplicate 判定——保证
    「超时 → 迟到应答补发」这条主路径不被去重吞掉。

### 2.4 降级路径

- probe 超时 / 异常 / 无 background → 诊断 `outcome=timeout|error|no_background`
  （level `"warn"`；判定规则见 §2.3 outcome 判定规则），不发 997。
- 无任何 probe API → 诊断 `details.probeApi="none"`、`outcome=no_probe_api`，不发探测。
- `onLateReply` 到达且组件已 closed → 不发送，诊断 `outcome=dropped_closed`（level `"info"`）。
- `onLateReply` 的 scheme 与已发送值（`sentScheme`，初始 `null`）相同 → 不发送，诊断
  `outcome=duplicate_skipped`（level `"info"`）；不同（含尚未发送过任何值的 `null` 情形，
  即「超时 → 迟到补发」主路径）→ 补发一次 997，诊断 `outcome=reported`、`late:true`。
- kill switch（`AGENT_BOARD_FORWARD_TERMINAL_QUERIES=0`）→ 全链路跳过，诊断
  `outcome=suppressed`（level `"info"`，不填 `probeApi`），行为回到修复前。
- 控制.socket 未连接时 settle 交付命中 send() 静默 no-op（硬超时落定、宿主连接慢的角落）→
  不没 sentScheme、不发 997，诊断 `outcome=dropped_disconnected`（level `"warn"`）——同 scheme
  的迟到应答之后重试而非被去重吞掉。（CR round-1 advisory 采纳）
- 以上降级均不抛错、不影响 attach 主流程。

### 2.5 非目标

- pi-tui 上游 `pendingTerminalColorQueries` 超时条目累积的队列卫生（上游问题）。
- WezTerm mode 2031 支持（上游 wezterm/wezterm#6454）。
- 子 pi 侧 OSC 11 僵尸条目泄漏（上游）。
- devDependencies 升级到 pi 1.0.x（独立 issue/PR，见开放问题 1）。
- 复活 #165 删除的 D3 raw replay。
- 两个 `openPtyAttach` 同构重复的去重（由 plan 自行决定，不作为本期验收项）。

## 3. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 新 API 探测与 997 交付 | 自动化验证（unit） | `node --test test/pty-attach-settle-scheme.test.mjs`：fake tui 仅带 `queryTerminalColors`，light/dark 两个 background 值 | probe 被调用；向 child 各发一次 `997;2` / `997;1` |
| A2 | 旧 API 回退不回归 | 自动化验证（unit） | 同文件：fake tui 仅带 `queryTerminalBackgroundColor` | 旧路径行为与 #149 语义一致（997 照发） |
| A3 | 双 API 皆缺 | 自动化验证（unit） | 同文件：fake tui 两者皆无 | 不抛错、不发探测；`onDiagnostic` 收到 `details.probeApi:"none"`、`outcome:"no_probe_api"` |
| A4 | 颜色→亮暗映射 | 自动化验证（unit） | `colorSchemeForBackgroundRgb` 现有边界用例保持 + `backgroundRgbFromTerminalColors` 新用例 | 亮度阈值与 pi 对齐；`background` 缺失返回 `undefined` |
| A5 | 迟到应答补发与去重 | 自动化验证（unit） | fake：resolve 后再触发 `onLateReply`（scheme 相同 / 不同两组）+ closed 场景 | scheme 不同补发一次 997 且 `late:true`；相同跳过且 `outcome:"duplicate_skipped"`；closed 后不发送且 `outcome:"dropped_closed"` |
| A6 | 诊断事件流（schema 兼容） | 自动化验证（unit） | fake `onDiagnostic` 捕获各阶段事件，并**将 patch 过一遍 `normalizeDiagnostic(viewId, patch)` 直证字段不丢** | 事件 `code:"attach_settle_scheme"`、`source:"attach"`、`details.{probeApi,outcome,report?}` 全部在 normalize 后存活；kill switch 下 `details.outcome:"suppressed"` |
| A7 | 真实 PTY 端到端 | 自动化验证（integration） | 扩展 `test-support/detach-gate-smoke.ts`：新增「tui 仅新 API」场景，真实 node-pty 子进程 | 子 PTY 输入流收到正确 997 恰一次 |
| A8 | 既有面无回归 | 自动化验证（static + build + integration） | `npm run verify`（= typecheck + perf gate + tests + coverage 阈值 lines 85 / funcs 80 / branches 70 + pack:dry，见 AGENTS.md:20-24） | 全绿；c8 分支阈值由 A1/A2/A3 三向覆盖满足；#165 的 `attach-startup-color-smoke` 不受影响 |
| A9 | 失败分支不发 997 | 自动化验证（unit） | A1 同文件：fake 分别返回 timeout（resolve 完全为空对象 `{}`，不触发 late）/ throw / 有应答但无 `background`（resolve 含 foreground 的对象） | 三种降级下 sent 均为空；`details.outcome` 分别为 `timeout` / `error` / `no_background`（判定规则见 §2.3） |
| U1 | 真机 board 重启场景（两条入口路径各验一次） | 用户实测 | 前置（必须）：① 快进运行时副本 `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull --ff-only`（至含本修复的 main）；② **重启宿主 pi**（扩展随宿主启动加载，不重启跑的是旧代码）。然后：浅色 WezTerm 下宿主 pi 起 board → board 级重启 → **两次 attach 各走一条入口**：① dashboard 选中 view 回车 attach（验 agent-board.ts 构造点）；② detach 后用 ← 键盘路径或 bg 命令再 attach（验 attach-flow.ts 构造点）；观察子 pi 首帧配色 + 两次各自 view 的 `diagnostics.jsonl` | 两次首帧均 light-warm 系（userMsg ≈ `#f0f0f0` 而非 `#343541`）；两次的 diagnostics.jsonl 均出现 `code:"attach_settle_scheme"`、`details.probeApi:"colors"`、`details.report:"997;2"` |
| U2 | kill switch 回退 | 用户实测 | 同 U1 前置两步 + `AGENT_BOARD_FORWARD_TERMINAL_QUERIES=0` 起宿主，重复 U1 场景 | 无探测（diagnostics `details.outcome:"suppressed"`）、无报错，行为回到修复前（dark） |

分层说明：A1-A6/A9 用 unit（行为可由注入 fake 完全证明，不跨进程）；A7 必须 fake tui + 真实 PTY
跨组件，用 integration；A8 是类型/构建/既有集成回归（`npm run verify` 是仓约定的 done 门）。
U1/U2 依赖真实终端 + 真实宿主 pi 进程与 board 运行时，无法在自动化环境稳定复现（需要真实
OSC 11 应答方与 board 级重启），故为用户实测；可执行时机 = 修复合入 main 后按前置两步更新
运行时副本并重启宿主 pi。

## 4. 可测性拆分设计（硬约束）

- `resolveProbeApi`：纯检测器，落点 `src/core/terminal-query-sequences.mjs`。三种 tui
  形状（仅新 / 仅旧 / 皆无）直测 → 形成 A1/A2/A3 的测试边界：**API 形状判定不依赖真实
  pi-tui**；参数与返回使用本地结构类型（`TerminalColorsLike` 等），禁止 import pi-tui 的
  `TerminalColors`。
- `backgroundRgbFromTerminalColors`：纯映射函数，独立于探测与发送 → A4 边界。
- `probeAndReportRealTerminalColorScheme`：编排层，副作用序列（query→map→send→diagnose）。
  unit 测试以注入 fake（tui、send 捕获、onDiagnostic 捕获）断言 → A1/A3/A5/A6/A9 边界：
  **编排测试不碰真 PTY / 真 socket**。
- 诊断 wiring（两处 openPtyAttach → appendDiagnostic）：A6 用 `normalizeDiagnostic` 直证
  组件发出的 patch schema 兼容（字段在白名单内存活）；`appendDiagnostic` 本身已有 core
  层测试，不在本期改动范围。
- A7 的真实 PTY 边界：复用 detach-gate-smoke harness（fake tui + 真 node-pty 子进程），
  不新造 harness。
- 实现不得把 resolveProbeApi / backgroundRgbFromTerminalColors 的逻辑内联回编排函数
  （保持可测边界）；不得在编排层引入对 pi-tui 版本的硬编码判断。

## 5. 开放问题

1. devDeps 0.79.8 → 1.0.x 迁移：单独开 issue（类型面变化大：TUI 接口、扩展 API 均有改动；
   迁移后本 spec 的本地结构类型与 cast 可去除）。是否现在开，等用户确认。
2. 「宿主已知 scheme 缓存 + settle 重发」（issue 方向 3 保险丝）：本期不做；若 U1 实测发现
   WezTerm 下探测超时率不为零，再评估。
3. `pendingTerminalColorQueries` 超时条目是否出队（上游细节）：不影响本期决策（每 attach
   一次 + onLateReply 的用量与 pi 自身启动探测同量级）；如后续观察到吞应答再上游报 bug。
