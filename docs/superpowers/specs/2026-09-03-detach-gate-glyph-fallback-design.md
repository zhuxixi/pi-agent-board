# SPEC：#69 tier-2 字形兜底收紧 —— fallback 路径下 ← 恒可逃生

- Issue: zhuxixi/pi-agent-board#69
- 基线: main @ 9a61dd5（含 PR #71 editor_state 门禁）
- 状态: 已批准（方案 B，2026-09-03）
- 调研依据: `~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-69/research/`（R1 代码影响面 / R2 KB / R3 PR 上下文），结论已评论回 issue

## 1. 背景与根因（已实锤，不再重复调试）

`←` detach 门禁三层结构（#71 后）：

```
handleInput(←)
  └─ connected? ── no ──→ 无条件逃生（#48，不动）
       └─ yes → resolveEditorEmpty(editorEmpty, heuristic)
                  ├─ editorEmpty ≠ null → 权威子进程状态（#71，不动）
                  └─ editorEmpty = null → 启发式 childInputLooksEmpty()
                        ├─ tier-1: 反色假光标锚点（不动）
                        ├─ tier-2: 字形兜底 ← ★ 本次唯一改动点 ★
                        └─ 兜底: return true 逃生
```

**根因**：fallback 模式（子会话无 editor-state reporter：旧版 pi 无 `ctx.ui.getEditorText`、扩展未加载、socket 未建立）下，真实 attach buffer 常零反色 cell → tier-1 落空 → tier-2 自底向上扫到 `isProbablyPiInputLine` 命中的聊天区 markdown 表格行（`│ … │`）或引用行（`> …`）→ `isProbablyEmptyPiInputLine` 判非空 → return false → `←` 被转发给子进程，用户被困。已在 main(9a61dd5) 上以 smoke 场景 K 复现（零反色 + `│ Issue #778 │ open │` + `> quote` + editorEmpty=null → didDetach=false）。

## 2. 修复设计

### 2.1 tier-2 行为决策表（唯一行为变化面）

| tier-2 扫到的行（自底向上首个 glyph 行） | 现行为 | 新行为 | 理由 |
|---|---|---|---|
| 空 glyph 行（`> `、`› `、`┃  `） | true（detach） | true（不变） | 编辑器为空 |
| 内容 glyph 行（`│ table │`、`> quote`、真草稿 `> draft`） | **false（gated，#69 bug）** | **true（detach）** | fallback 下无法区分表格/引用/草稿；可退出性优先 |
| 无 glyph 行 / 扫不到 | true | true（不变） | 既有逃生 |

**收紧后 tier-2 语义恒为 true**（内容行跳过 + 扫不到逃生）——fallback 恒放行，这是有意取舍：草稿保护的可靠路径已由 #71 editor_state 承担；fallback 模式下误判代价不对称（误 detach = 意外退视图、草稿不丢、重新 attach 即回；误 gate = 用户被困）。与 #42/#48「视图必须始终可退出」哲学同向。

### 2.2 改动点（两案行为完全等价，纯代码形态选择）

**方案 B（推荐，与维护者在 #69 评论中已本地验证的实现一致）**：

```ts
// src/ui/pty-attach.ts  childInputLooksEmpty() tier-2 循环
for (let y = active.baseY + active.length - 1; y >= active.baseY; y--) {
    const line = active.getLine(y)?.translateToString(true) ?? "";
    // Only an EMPTY glyph line proves an empty editor. Content glyph lines
    // (markdown table rows `│ … │`, quotes `> …`, or a real draft in a
    // no-fake-cursor Pi variant) cannot be told apart, and trapping the
    // user is worse than a spurious detach (issue #69) — skip and keep
    // scanning; the loop-end escape stays authoritative.
    if (isProbablyPiInputLine(line) && isProbablyEmptyPiInputLine(line)) return true;
}
return true;
```

- 保留扫描骨架：为中期方案（按 pi TUI dock 结构：底部 `─` 分隔线与 footer 间定位编辑器行，可恢复 fallback 草稿保护）留结构；注释固化取舍理由。
- `isProbablyPiInputLine` 继续有生产调用点，不需要删除。

**方案 A（备选）**：直接删循环 `return true` + 注释。语义/测试与 B 完全一致，diff 更小，但丢掉骨架与意图表达。

### 2.3 数据流与组件契约

- 无新组件、无协议消息、无公共 API 变化；`resolveEditorEmpty`、tier-1、editor_state 链路（reporter → runner broadcast → attach 缓存 → hello 重置）一概不动。
- 唯一触碰的生产文件：`src/ui/pty-attach.ts`（tier-2 循环体）。
- 触发窗口说明：收紧只影响 editorEmpty=null 的降级判定（reporter 缺席）；reporter 活跃时 `resolveEditorEmpty` 短路，主路径零变化。

## 3. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | #69 真实场景放行：零反色 + 聊天区 `│` 表格行/`>` 引用行 + editorEmpty=null + connected=true → `←` detach | 自动化验证（integration：detach-gate smoke，经 `test/pty-attach-detach-gate.test.mjs` 驱动） | `npm test`；新增 smoke key `leftDetachesOnTableRowsWithoutFakeCursor` | 新 key 断言 true，全量测试通过 |
| A2 | 有意回归被钉住：内容 glyph 行（真草稿形态 `> draft`）+ 零反色 + editorEmpty=null → `←` detach（fallback 草稿保护失效是有意取舍，防止未来被"顺手修"）。**与既有 smoke B 互为对照**：同为草稿形态，B 带 inverse 走 tier-1 → gated，A2 零反色走 fallback → detach——两种判定不矛盾，正是本取舍的教科书示例（smoke 场景注释中须写明此对照） | 自动化验证（integration：同上） | 新增 smoke key `leftDetachesOnContentGlyphFallback` | 新 key 断言 true |
| A3 | 既有行为零回归：B（tier-1 草稿 gate）、J（hello null 重置）、空 glyph 行 detach、editor_state 系列（H/J 全部 key）、ctrl+] 透传、断线逃生等 | 自动化验证（integration + unit 全量） | `npm test`（基线 437；新 smoke key 是既有 test 块内的新断言，node:test 计数不变） | 全量 437 全绿，既有 key 结果不变 |
| A4 | 类型/静态约束 | 自动化验证（static/build） | `npm run typecheck` | 0 错误（CI Node 22/24 等价覆盖） |
| U1 | 真实仪表盘复测 #69 场景：attach 一个聊天区含 markdown 表格输出的 warm 会话，输入框空时按 `←` | 用户实测 | 在运行副本 `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board` 里 `git fetch && git checkout <PR 分支>`（#67 实测已验证的本地加载法），重启 pi 后打开 dashboard → attach → 空输入按 `←`；测完 checkout 回 main 并重启 | 回到 dashboard，不被困（可执行时机：实现完成、PR 分支推送后、合并前） |
| U2 | 主路径草稿保护不受影响：reporter 活跃会话输入草稿后按 `←` | 用户实测 | 同 U1 环境，attach 后输入草稿，按 `←` | 光标在草稿内左移，不 detach（复测 #67 U3 同款；可执行时机同 U1） |

**用户实测不可自动化的原因（U1/U2）**：真实 dashboard attach 涉及宿主 pi TUI 差分渲染 + pty-runner + editor-state reporter socket 的全链路，headless harness 用内存 xterm 无法复现真实终端渲染与扩展加载，只能人测。注意：实测需重启 pi，当前开发会话所在的 pi 实例会中断——在另一个终端/pi 实例里执行。

## 4. 可测性拆分设计（自动化项）

- **纯函数层（不变）**：`isProbablyEmptyPiInputLine` / `isProbablyPiInputLine` / `resolveEditorEmpty` 已在 `test/pty-input.test.mjs` 有 unit 钉语义；本次不改其行为，不新增纯函数——收紧后 tier-2 决策恒为 true，为常量行为建纯函数无判别价值，强行抽取只会产生恒真断言的空转测试。
- **组件决策层（改动面）**：`childInputLooksEmpty()` 本身无副作用（只读 xterm buffer + 纯判定），判别性（detach vs forward）落在组件级 smoke harness（`test-support/detach-gate-smoke.ts`，经 `test/pty-attach-detach-gate.test.mjs` 以子进程运行并断言全部 key）——沿用 #42/#48/#66/#68 的既有测试边界，不引入新测试形态。
- **测试边界总结**：unit 钉 helper 语义（A3 覆盖）→ integration smoke 钉组件门禁决策（A1/A2/A3）→ static/typecheck 钉类型（A4）。A1/A2 ↔ smoke 新场景；A3 ↔ smoke 既有 key + unit 全量；A4 ↔ typecheck。双向可追溯。
- **smoke 惯例**：在线 gate 场景必须显式 pin `connected=true`（B 段既有惯例；不 pin 时断线逃生语义会抢跑，测不到在线门禁）；新场景 K1（A1）/K2（A2）同样遵守。

## 5. 非目标

- ❌ 中期 dock 结构锚点（底部 `─` 分隔线与 footer 间定位编辑器行）——未来若要恢复 fallback 草稿保护再立项
- ❌ 触碰 tier-1 反色锚点、editor_state 链路（#71 成果）
- ❌ 删除渲染启发式整体（继续作为 #71 的 fallback 层存在）
- ❌ 方案 A 下的 `isProbablyPiInputLine` 去留不在本 spec 讨论（选 B 则无此问题）
- ❌ 不改 README：line 96/195 的 `←` 行为描述以受支持主路径（reporter 活跃）为准，fallback 降级细节属实现层，由 A2 钉住——此为明确决定，防止未来被当成文档漂移

## 6. 风险与降级

- 风险 1：fallback 下真草稿按 `←` 变为 detach（有意回归，A2 钉住；草稿不丢，重新 attach 即回）。
- 风险 2：`←` 在 attach 初建窗口（hello 尚未带回 editorEmpty、reporter 首推未达）若子进程恰有草稿，会 detach——窗口极短且后果同上，接受。
- 无运行时降级路径需求：本改动本身就是降级路径的加固；不合并时现状是「fallback 可被困」（更差）。
- **post-merge 生效**：运行副本 `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board`（当前停在 0.5.1 / fac9e91，连 #66 都没有）需 `git pull`（或 `pi update`）并重启 pi 后才带本修复——人工部署步骤，不在自动化环内。
