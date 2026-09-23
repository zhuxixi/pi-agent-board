# Plan: attach 终端能力透传（issue #128）

Spec: `docs/superpowers/specs/2026-09-23-terminal-query-forwarding-design.md`（commit a3a7374）
Base: main 4ccb427

## Task 1: 提取器与纯函数（A1, A2）

**Files:**
- 新建 `src/core/terminal-query-sequences.mjs`：
  - `extractOscQuerySequences(input) → { sequences, carry }` — 转发 `\x1b]11;?` + BEL(`\x07`)/ST(`\x1b\\`) 定界、`\x1b[?2031h`、`\x1b[?2031l`；**排除** `\x1b]11;rgb:...` 设置形态与 kitty/DA（`\x1b[>7u`/`\x1b[?u`/`\x1b[c`）；carry 模式照抄 `extractOsc52Sequences` 结构（部分前缀保留、carry 上限）
  - `toColorSchemeReport(scheme) → string` — light/dark → 颜色方案报告序列（997）；**格式先读 pi-tui `parseTerminalColorSchemeReport`（node_modules/@earendil-works/pi-tui/dist/tui.js）源码对齐**，来源在测试注释标注
  - `OSC_QUERY_CARRY_MAX_BYTES` 常量（对齐既有家族取值）
- 新建 `test/terminal-query-sequences.test.mjs`（unit）：
  - A1: 查询 BEL/ST 各转发一次；设置形态不转发；2031h/l 转发；跨 chunk（查询截半 → carry 拼接后识别）；carry 不含完整序列时丢弃防积压
  - A2: toColorSchemeReport light/dark 两态输出与 pi-tui parser 双向验证（序列喂 parser 能解回 scheme）

**Verify:** `node --test test/terminal-query-sequences.test.mjs` 全绿

**Constraints:** 纯函数零副作用；不 import pi-tui（格式对齐靠测试里 parser 交叉验证，生产代码硬编码序列——避免对 pi-tui 内部结构的运行时依赖）

## Task 2: attach 组件接线（A3, A4, A5, A6, A7）

**Files:**
- `src/ui/pty-attach.ts`:
  - import 提取器；`forwardTerminalProtocols` 增加第三段（独立 `oscQueryCarry` 字段，kill switch `AGENT_BOARD_FORWARD_TERMINAL_QUERIES !== "0"` 默认开）
  - `attachColorSchemeBridge()` — settle 时 `this.tui.onTerminalColorSchemeChange(...)` 注册，回调 `this.send({type:"input", data: toColorSchemeReport(scheme)})`；`done()`/detach 路径退订（A7 对称）
  - `replayBackgroundQuery()` — settle 后一次性 `this.tui.terminal.write("\x1b]11;?\x07")`；不截获应答（靠既有兜底穿透）；仅在本次 attach 从未发过时发（防重复 settle 重放）
  - settle 路径接线两方法；确认 settle 判定处（attach loading banner 消失点）只调一次
- `test-support/detach-gate-smoke.ts` 扩展场景（P8-P11）+ `test/pty-attach-detach-gate.test.mjs` 断言：
  - A3: 远端 output 含 `\x1b]11;?\x07` → localTerminalWrites 含之；含 `\x1b]11;rgb:ffff/ffff/ffff\x07` → 不写
  - A4: 伪 tui 触发 colorScheme listener("light") → socket 收到 `type:"input"` + 997 报告；模拟 detach 后再触发 → 不发（A7）
  - A5: attach settle → localTerminalWrites 恰一条 `\x1b]11;?\x07`；kill switch=0 时零条
  - A6: 远端 output 含 `\x1b[>7u\x1b[?u\x1b[c` → localTerminalWrites 不含任何一段

**Verify:** 定向 `node --test test/pty-attach-detach-gate.test.mjs` + 全量 `node --test test/*.test.mjs`（账本 flake 除外）+ `npm run typecheck`

**Constraints:** 转发写失败静默（沿用既有 catch）；桥/回放不影响 attach 主流程；kill switch 覆盖全部新行为

## Task 3: 文档同步（A 矩阵文案面, U1-U3 步骤引用）

**Files:**
- `README.md` attach 特性两段：新增「终端能力透传」小节——亮暗探测转发/桥接/首帧回放的行为描述 + kill switch + 已知未覆盖（kitty/DA 协商、OSC 10/12）
- spec 验收矩阵 U1/U3 的实测步骤引用 README 步骤

**Verify:** 文案与实现行为一致（reviewer 对照）；无自动化新增

## Review 焦点预设

- T1: carry 边界（截半在定界符处/前缀处）、设置形态误匹配（`\x1b]11;?` 前缀是 rgb 设置的前缀吗——不是，`?` vs `r` 第一字符即分岔，测试钉死）
- T2: settle 只触发一次的路径证明；桥退订覆盖所有 done 路径（exit/error/detach/kill）；kill switch 三处（转发/桥/回放）全覆盖
- T3: 文案不过度承诺（OSC 11「正常场景穿透」而非「总是」——本地 pending>0 边角如实）
