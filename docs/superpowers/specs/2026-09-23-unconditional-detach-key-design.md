# Spec: 终端无关的无条件 detach 逃生键（issue #126）

状态：draft（等用户确认）
日期：2026-09-23

## 问题

`Ctrl+←` 是 attach 表面唯一的无条件 detach 键（#89 引入），但它的可达性依赖「终端愿意把 Ctrl+Left 编码为转义序列发送」——macOS Terminal.app 默认不发任何字节、WezTerm-macOS 把它消费为 tab 切换（#126 实测）。D1（#135）后 `←` 只在 `editorEmpty === true` 时 detach，于是在坏终端 + 草稿/未知编辑器状态下用户无键可逃，只能 Ctrl+C/D 连带杀 child——触碰 #48「attach 永远可退出」红线。

## 设计决策

**新增 `Ctrl+\`（裸字节 0x1c）作为无条件 detach 键**，形成三层逃生梯队：

1. `←` — 智能层：`editorEmpty === true` 时 detach，否则转发（D1 契约不变）
2. `Ctrl+←` — 快捷层：好终端保留（不依赖 child 状态，已实现）
3. `Ctrl+\` — **无条件层**：任何状态（含 editorEmpty=false/null、connected 与否）立即 detach，且不依赖终端对修饰键的编码

### 为什么是 Ctrl+\（被丢弃的选项）

- 0x1c 是单字节 ASCII 控制字符（FS）：raw mode 下**所有**终端原样发送（kitty legacy ctrl-mapping 官方表；pi-tui keys.js 头注释引用同一映射）；没有任何主流终端默认占它做快捷键；SIGQUIT 语义只存在于 cooked mode，board/pi/child 全链路 raw mode 不受影响。
- 实测证据（spec review 全部复验）：pi-tui `matchesKey` 对**三种键盘模式编码**全部原生匹配——裸字节 `\x1c`、kitty CSI-u `\x1b[92;5u`、modifyOtherKeys `\x1b[27;5;92~`（pi 本体开启 modifyOtherKeys/kitty 探测，WezTerm 等真实环境发的正是后两种）；pi 本体 dist 全量 rg 无 `ctrl+\` 绑定；本仓 src/runner/test 无占用。
- **已知限制一（键盘布局）**：「所有终端」的断言只覆盖终端协议层，不覆盖键盘布局层——德式/北欧等布局中 `\` 位于 AltGr 层（如 AltGr+ß），Ctrl+\ 未必产出 0x1c。布局受限场景由梯队兜底：这些布局高发的 Linux 现代终端上 `Ctrl+←`（快捷层）可靠；`editorEmpty=true` 时 `←`（智能层）也始终在。README 已知代价中如实写明。
- **已知限制二（Ctrl+4 别名）**：legacy ASCII 映射中 Ctrl+4 同样产出 0x1c，故 legacy 模式下按 Ctrl+4 也会 detach。Pi 不使用 Ctrl+4，风险可忽略，但属于「从 child 抢键」代价的一部分，文档如实记录。
- 被丢弃：Esc（#89 否决：vim 冲突）、双击 ←（#89 否决：误触）、F 键（零星终端绑定冲突 + Pi 未来可能占用）、鼠标 detach 区（误触 + 可发现性差，不承担红线）、只修文案（不根治）。
- 已知代价（文档化）：从 child 抢 Ctrl+\。Pi 无此绑定；仅 child 内 vim terminal-mode 的 Ctrl+\ Ctrl+N 前缀受影响（极小众）。

### 不做的事（Non-goals)

- 不翻转 D1 的 `editorEmpty=null → 转发` 契约（坏终端由无条件层兜住，不动刚钉死的语义）。
- 不移除 `Ctrl+←`（好终端保留为快捷层）。
- 不改断线路径（`!connected` 已无条件逃生）。
- 不为 0x1c 做可配置化（YAGNI；若未来 child 需要 Ctrl+\，届时加配置项）。

## 组件契约

`src/ui/pty-attach.ts` `handleInput`：在 `Key.ctrl("left")` 分支之前新增分支——
`if (matchesKey(data, "ctrl+\\")) { this.detach(); return; }`（0x1c 裸字节直达，无终端编码依赖）。
header（render）与 loading banner 文案更新：`Ctrl+← detach` → `Ctrl+← / Ctrl+\ detach`；README 按键段（:96/:195 区域）补无条件键说明与已知代价。

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | Ctrl+\ 任何状态无条件 detach | 自动化验证（unit，detach-gate smoke 场景） | `node --test test/pty-attach-detach-gate.test.mjs`：注入 `\x1c` 于 editorEmpty=true/false/null × connected=true/false 四象限 | 四象限全部 detach（唯一无条件断言集） |
| A2 | Ctrl+\ 不受 child 草稿门禁影响 | 自动化验证（unit） | 同 A1 的 editorEmpty=false 用例显式 pin（草稿在、仍 detach） | 草稿态 detach 成功 |
| A3 | 0x1c 与既有键无匹配冲突 | 自动化验证（unit） | 注入 `\x1b[1;5D`（ctrl+left）、`\x1b[D`（left）、`q`、`\x1c` 各自独立断言行为 | ctrl+left 仍 detach；left 按 D1 门禁；q/可打印键转发；0x1c detach |
| A4 | 文案与 README 同步 | 自动化验证（unit + static） | detach-gate 测试断言 header 含 `Ctrl+\`；rg README 两处按键段含无条件键说明 | 断言通过 |
| U1 | 真实坏终端实测 | 用户实测（mac 环境，**pending**：本机 Linux 无法执行） | macOS Terminal.app（默认设置）attach 会话 + 编辑器含草稿 → 按 Ctrl+\ | detach 回 dashboard，child 存活（重新 attach 草稿还在） |
| U1b | Linux 等效实测（U1 的本机可执行替代） | 用户实测 | WezTerm（kitty 开启，CSI-u 路径）与 xterm（legacy 路径）各一次：attach 会话 + 编辑器含草稿 → 按 Ctrl+\ | 两种终端均 detach，child 存活（重新 attach 草稿还在） |

## 可测性拆分设计

- A1-A3 全部走既有 `test-support/detach-gate-smoke.ts` 真组件 harness（真实 xterm buffer → handleInput → didDetach()/转发包内容），新增 4 个场景（四象限）+ 1 个冲突隔离场景组；连接态用 smoke 既有 `connected=true` 显式模式。无需新纯函数（改动是单分支拦截，行为面全部由组件级 harness 覆盖）。
- A1 的四象限注入应同时覆盖**三种编码形态**（裸 `\x1c` / kitty `\x1b[92;5u` / modifyOtherKeys `\x1b[27;5;92~`）至少各一条，防止未来键解析层变更悄悄断掉某一模式（spec review 实测三种编码当前均被 `matchesKey` 原生匹配）。
- A4 的 header 断言沿用既有 `headerMentions*` 模式。
- 测试边界：不改 `shouldEscapeAttach`（它的语义是 ← 门禁，与 Ctrl+\ 分支正交）；smoke 场景不得依赖终端模拟层（0x1c 是裸字节，天然无模拟依赖）。
EOF
