# Spec: attach 终端能力透传——亮暗探测与颜色方案通知（issue #128）

## 根因（三缺口，调研钉死）

attach 客户端用 headless xterm 重建屏幕，宿主 Pi 的终端能力查询被本地模型消费、从不转发真实终端（缺口 A）；即使转发，996/2031 应答会被本地 pi-tui `consumeTerminalColorSchemeReport` **无条件消费**，到不了宿主（缺口 B）；宿主首次探测发生在 runner spawn 时（attach 前），纯转发只救 /settings 重选，救不了首帧（缺口 C）。

## 设计（四组件，全部在 attach 客户端侧）

### D1 出站转发器：`extractOscQuerySequences`（纯函数）

- 转发：OSC 11 查询 `\x1b]11;?` + BEL/ST 定界；`\x1b[?2031h`、`\x1b[?2031l`
- 不转发：OSC 11 **设置** `\x1b]11;rgb:...`（防污染本地配色）；kitty/DA 协商 `\x1b[>7u`、`\x1b[?u`、`\x1b[c`（见非目标）
- 结构照抄 `extractOsc52Sequences` 的 carry 模式（跨 chunk 前缀保留，独立 `oscQueryCarry`），接入 `forwardTerminalProtocols` 第三提取器
- 转发是追加行为：序列照常喂 headless 屏幕模型（xterm 忽略 OSC 11 查询，无副作用）

### D2 亮暗桥：`onTerminalColorSchemeChange` → 宿主

- attach 时 `this.tui.onTerminalColorSchemeChange(scheme => this.send({type:"input", data: toColorSchemeReport(scheme)}))`；detach 时退订（生命周期对称）
- 原理：本地 pi-tui 消费 996 报告/2031 通知时**同步通知**该监听器——桥把消费事件重打包为颜色方案报告（`\x1b[?997;Ps n`，2=light 1=dark——报告码点是 997，996 是查询 DSR；task 1 实测对齐 pi-tui terminal-colors.js:19）写宿主 pty，宿主 pi-tui 同 parser 消费并通知宿主的 query/2031 监听
- `toColorSchemeReport(scheme)` 纯函数；格式对齐 pi-tui `parseTerminalColorSchemeReport` 的接受形态（实现时从其源码对齐）

### D3 首帧回放：attach settle 时主动发一条探测

- attach settle 后向本地终端写一条 `\x1b]11;?\x07`（`tui.terminal.write`）
- 应答**不需要截获**：本地 pending=0（正常场景）时穿透消费链 → attach 组件 handleInput 兜底 → `send({type:"input"})` → 宿主收到 → 主题翻转
- 失败模式（探测无应答/本地 pending>0 截获）：静默保持现状（dark），不重试
- 仅 settle 时一次；后续宿主自身重探测（/settings 重选）由 D1 转发覆盖

### D4 应答天然路径（零代码，验收依据）

kitty flags/DA/OSC 11 应答不被本地消费链 ①②④ 消费 → 流到 attach 组件兜底转发（既有行为，issue 正文已确认）——D1/D3 的应答回程都靠它。

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 查询提取器 | 自动化验证（unit） | `node --test test/terminal-query-sequences.test.mjs` | 查询（BEL/ST）转发、设置形态不转发、2031h/l 转发、跨 chunk carry 正确 |
| A2 | scheme→报告序列 | 自动化验证（unit） | 同上 | `toColorSchemeReport` 输出与 pi-tui parser 接受形态一致（light/dark 两态） |
| A3 | 出站转发接线 | 自动化验证（smoke） | `node --test test/pty-attach-detach-gate.test.mjs`（扩展场景） | 远端 output 含 OSC 11 查询 → 本地 terminal.write 收到；含 `rgb:` 设置 → 不写 |
| A4 | 亮暗桥接线 | 自动化验证（smoke） | 同上 | 伪 tui 触发 colorScheme listener → socket 收到 `type:"input"` 且 data 为颜色方案报告（`\x1b[?997;2n` / `\x1b[?997;1n`）；detach 后触发不再发 |
| A5 | 首帧回放 | 自动化验证（smoke） | 同上 | attach settle → 本地 terminal.write 恰好一条 `\x1b]11;?\x07`；detach/未 settle 不写 |
| A6 | kitty/DA 不转发 | 自动化验证（smoke） | 同上 | 含 `\x1b[>7u\x1b[?u\x1b[c` 的远端 output 不写本地终端 |
| A7 | 桥生命周期 | 自动化验证（unit） | 同 A4 用例内 | 注册/退订对称，无泄漏监听 |
| U1 | 重选恢复 | 用户实测 | WezTerm Latte 浅色 + attach 会话 → /settings → Theme → Automatic | 主题变 light-warm（accent 色对） |
| U2 | 首帧正确 | 用户实测 | 浅色终端 attach 一个新会话，不进 /settings | 进入即 light-warm（回放生效） |
| U3 | 实时跟随 | 用户实测 | attach 中切系统亮暗（KDE appearance） | 会话主题实时跟随（2031 桥） |

## 可测性拆分设计（硬约束）

- `extractOscQuerySequences(input) → {sequences, carry}`：纯函数，独立文件 `src/core/terminal-query-sequences.mjs`（与提取器家族同址），单测直测（A1）
- `toColorSchemeReport(scheme) → string`：纯函数，同文件，单测直测（A2）；格式常量从 pi-tui `parseTerminalColorSchemeReport` 源码对齐并在测试注释标注来源
- 桥/回放/转发接线：attach 组件内三个小方法（`attachColorSchemeBridge`/`replayBackgroundQuery`/forward 接线），副作用（tui.terminal.write、send）通过既有 smoke harness 的伪 tui/socket 断言（A3-A7），不在单测层 mock 组件内部

## 非目标（已知未覆盖，如实记录）

- **kitty/DA 键盘协议协商**：宿主协商仅在 spawn 时（attach 前已错过，转发无效）；且转发 `\x1b[>7u` 会污染真实终端 kitty 栈顶（本地 pi 与宿主共享 stdin，flags 不一致时本地输入解析错乱）。修饰键编码差异保持现状（modifyOtherKeys 回退）
- **OSC 10/12 查询**：pi 0.87.0 实测不发，不做 speculative 转发
- **本地 pi pending>0 边角**：本地探测超时且上游 counter bug 未清零时，回放应答被本地截走一次（宿主下次重探测即恢复）；修上游（counter 递减）超出本仓范围
- **kill switch**：沿用既有 env 约定（`AGENT_BOARD_FORWARD_TERMINAL_QUERIES=0` 关闭全部新行为，默认开）

## 降级路径

全部新行为 best-effort：转发写失败静默（沿用 forwardTerminalProtocols catch）；桥/回放失败不影响 attach 主体；kill switch 一键回退现状。
