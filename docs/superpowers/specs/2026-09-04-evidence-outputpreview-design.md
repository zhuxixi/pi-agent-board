# Design: evidence outputPreview 从 AgentToolResult 正确提取文本（issue #41）

状态：approved（用户确认于 2026-09-04）
仓库：zhuxixi/pi-agent-board · 调研留档：`~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-41/research/pi-tool-result-structure.md`

## 1. 问题与根因（调研已闭环）

- 现象：`evidence.json` 的 `commands[].outputPreview` 对 bash 命令一律为 `"[object Object]"`，真实输出丢失（`~/.pi/agent/agent-board/views/` 抽样 100% 复现）。
- 根因：`src/core/evidence.mjs` `reduceEvidence` 的 `tool_execution_end` → bash 分支用 `String(event.result ?? "")`；pi 的 `result` 是 `AgentToolResult` 对象（`{ content: (TextContent|ImageContent)[], details, ... }`），文本在 `content[]` 的 `type==="text"` block 里。
- 漏网原因：现有单测 fixture 把 `result` 写成字符串 `"ok"`，与真实事件结构不符。
- pi 官方提取模式（`convertToolResultOutput`）：`content.filter(c => c.type === "text").map(c => c.text).join("\n")`。

## 2. 设计决策表

| ID | 决策 | 理由 |
|----|------|------|
| D1 | 新增纯函数 `toolResultText(result)`，放 `src/core/heuristics.mjs`，与既有 `assistantText`（message.content text-block 提取）同文件、同防御模式 | 模式对称，仓库先例；不新建文件 |
| D2 | 行为：`null/undefined → ""`；`string → 原样`（兼容旧 fixture/历史回放）；`对象 + Array.isArray(content) → filter(type==="text" && typeof text==="string") → map → join("\n") → trim`（纯 image → ""）；**对象无 content 数组 / 无 text block → `""`（宁缺毋滥）**；标量（number/bool 等）→ `String()` | 照抄 `assistantText` 防御式 + pi 官方 join("\n") 语义；兜底遵循 #40「宁可不显示也不错显示」原则——未知形状对象不再产生 `[object Object]`（即本 bug 的兜底复现路径，见 Review F1） |
| D3 | `reduceEvidence` 仅改一行：`outputPreview: truncate(toolResultText(event.result), 500)` | 单点修复，先提全文再截 500（与现状顺序一致） |
| D4 | 不动 `EvidenceCommand` 数据结构、不动其他工具分支、不迁移历史 evidence.json | 历史输出物理丢失无法恢复；其他工具本就无 outputPreview 提取 |
| D5 | 向后兼容：旧字符串 `result` 的既有 fixture `"ok"` 必须继续通过 | 防止修复破坏旧事件回放语义 |

## 3. 可测性拆分设计（硬约束）

- `toolResultText(result)`：**纯函数**，零副作用、零依赖 pi 运行时，输入任意 → 输出 string。测试边界：unit 直接构造各形状输入断言输出（单 text block / 多 text block join "\n" / 纯 image → "" / **对象无 content 字段 → ""** / string 原样 / null/undefined → "" / number/bool 标量 → String()）。
- `reduceEvidence` bash 分支：保持现有快照式测试模式（构造 event → 断言 snapshot），仅补真实 `AgentToolResult` 形状 fixture；**不得**把提取逻辑内联进 reduceEvidence（保持函数已拆分，实现阶段不得耦合回去）。
- 测试层级选择：全部行为 unit 层可证（纯函数 + 快照），无需 integration/E2E mock 整个 pi runtime（成本高于收益）。真实 pi 进程链路（extension 加载 → bash 工具执行 → evidence 落盘）无法在单测内稳定脚本化，划给 U1 用户实测。

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `toolResultText` 纯函数各形状行为 | 自动化验证（unit） | `node --test test/heuristics.test.mjs` | 新增用例全过：AgentToolResult 形状提取、多 block join("\n")、纯 image → ""、对象无 content → ""（F1 兜底）、string 原样、null → ""、标量 String() 兜底 |
| A2 | `reduceEvidence` bash 分支用真实结构 | 自动化验证（unit） | `node --test test/evidence.test.mjs` | 真实 AgentToolResult fixture → outputPreview 为提取文本且 ≠ "[object Object]"；既有字符串 fixture `"ok"` 断言不回归（D5） |
| A3 | 全量回归 | 自动化验证（unit+static） | `npm run verify` | 全部通过（注意勿用 `npm test -- <file>`，glob 会展开全量） |
| U1 | 真实 board 运行链路 | 用户实测 | 真实 pi session 里跑若干 bash 命令 → 查 `~/.pi/agent/agent-board/views/<view>/evidence.json`（**可执行时机：merge 发布、board 随日常 pi session 重启加载新版 extension 后**） | 新记录的 bash 命令 outputPreview 含真实输出文本（如 `gh pr create` 的 URL），不再出现 `[object Object]` |

## 5. 非目标

- 不修历史 evidence.json（数据已丢）；不清理历史 `[object Object]` 记录。
- 不动其他工具的 result 处理与 code-refs 引擎（#41 修复后解锁 #40 的 outputUrl 路径，属后续工作）。
- 不改 500 字符截断长度与 `upsertEvidenceCommand` 覆盖语义。
- **不处理 powershell 工具**（Windows 下 pi 的 shell 工具是 powershell，其命令本就不进 commands 列表——既有行为，与本 bug 无关）。

## 6. 改动文件清单

- `src/core/heuristics.mjs`：+`toolResultText`（~12 行）
- `src/core/evidence.mjs`：import + 改 1 行
- `test/heuristics.test.mjs`：+纯函数用例
- `test/evidence.test.mjs`：+真实结构 fixture 用例
