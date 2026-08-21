# Spec: 运行中提问归类 needs_input + 永不自动 done（issue #14）

- Date: 2026-08-21
- Issue: https://github.com/zhuxixi/pi-agent-board/issues/14
- Status: design approved by user (2026-08-21 23:49)

## 1. 背景与现状（research 已闭环）

- hosted/foreground 场景的 `ask_questions` 工具提问 → `needs_input` **已实现**（#42, commit 752db70，`preservePendingQuestion()`），测试已覆盖。
- **Gap A**：自然语言文本提问（`detectNeedsInput` 命中）运行中只写 `status.question`，`semanticState` 仍强制 `working`（`events.mjs` `message_end` 分支）。
- **Gap B**：detached（job-runner）场景 `ask_questions` 不 track——**用户确认不用管**（headless 不会提问，也回复不了）。非目标。
- **Gap C**：进程退出后 auto-state（`heuristicAutoState().hasDoneSignal()` + state-runner 模型分类）会把行自动归类 `completed`。`finalizeSemanticState()` 本身不产生 completed。

## 2. 需求

1. 运行中（`processState === "alive"`）session 的**文本提问**也归类为 `needs_input`（面板 input 类型），覆盖 hosted / detached / foreground 全部场景。
2. **永不自动归类 `completed`（done）**；`completed` 只由用户手动 mark completed 产生。

## 3. 设计决策

| 决策点 | 结论 | 依据 |
|--------|------|------|
| 提问检测 | 复用现有 `detectNeedsInput`（保守：结尾问号或短语命中） | 已在 `finalizeRun` 长期使用，行为成熟 |
| 恢复机制 | 依赖既有 `message_start` / `tool_execution_start` / 无问题 `message_end` 设回 `working` | 天然存在，不加新状态机 |
| pending 优先 | `preservePendingQuestion()` 保持最后调用，pending 存在时覆盖为 `needs_input` | #42 并行语义不回退 |
| 不自动 done 的强度 | **彻底**：auto-state 永不产出 done（启发式 + 模型输出均降级为 in_progress/idle） | 用户拍板 |
| 回退开关 | `AGENT_BOARD_AUTO_STATE_NO_DONE`，默认开（不自动 done）；`0`/`false`/`off` 恢复旧行为 | 保守可回退 |
| detached 回复路径 | 不改（保持 #42 现状） | 用户确认不用管 |
| alive guard | 不改（运行中分类全由 events.mjs 负责；auto-state 仅在 run 结束后触发，无运行中调用路径） | 改动面最小 |

## 4. 改动点（文件级）

### 4.1 `src/core/events.mjs` — `reduceEvent()` `message_end` 分支

现状：
```js
if (text) {
    status.latestAssistantPreview = truncate(text, PREVIEW_MAX);
    const nb = detectNeedsInput(text);
    status.question = nb.question;
}
status.semanticState = "working";
preservePendingQuestion(status);
```

改为（仅一行条件）：
```js
if (text) {
    status.latestAssistantPreview = truncate(text, PREVIEW_MAX);
    const nb = detectNeedsInput(text);
    status.question = nb.question;
}
status.semanticState = nb.needsInput ? "needs_input" : "working";
preservePendingQuestion(status);
```

注意 `nb` 需提到 `if (text)` 作用域外（`let nb = { needsInput: false, question: null }` 初始值，空文本时不误判）。

### 4.2 `src/core/auto-state.mjs` — 永不自动 done

1. `autoStateDoneDisabled(env)` 辅助：读 `AGENT_BOARD_AUTO_STATE_NO_DONE`（默认**开**=禁用自动 done）。
2. `heuristicAutoState()`：`done && !pending` 分支移除；`hasDoneSignal` 命中时返回 `in_progress`（reason 说明"completion detected but auto-done disabled"）。
3. `parseAutoStateModelOutput()`：解析到 `done` 且开关开 → 降级 `in_progress`；开关关 → 保持 `done`。
4. `buildAutoStatePrompt()`：开关开时 prompt 只有两态（`needs_input` / `in_progress`），并提示"completed 由用户手动标记"；开关关时恢复原三态 prompt。
5. `applyAutoStateToStatus()` / `applyAutoStateToViewState()`：guard 增加 `semanticState === "completed"` 直接 return false（**手动完成的 state 不被自动分类覆盖**，现有 guard 只排除 failed/stopped）。

（开关关 = 全部旧行为，保证可回退。）

### 4.3 测试

1. `test/events.test.mjs` 新增：
   - "message_end 文本以问号结尾 → semanticState=needs_input，question 非空（无 pending 场景）"
   - "needs_input 后下一条无问题 message_end → 回 working"
   - "pending question 存在时 message_end 文本无问题 → 仍 needs_input（pending 优先回归）"
2. `test/auto-state.test.mjs` 更新：
   - L6-11 模型输出 done → 默认降级 in_progress；开关关 → done（新增开关关用例）
   - L25 启发式 "Done. Fixed the bug and tests pass." → in_progress
   - L29-42 applyAutoStateToStatus → 默认 idle（不再 completed）；开关关 → completed（保持旧断言）
3. 全量 `npm run verify` 绿。

## 5. 验收标准（Success Criteria）

1. 运行中 hosted session，assistant 文本以问题结尾 → 面板归类 input（`needs_input`），glyph ◇，分组进 needs_input。
2. 运行中 detached session 文本提问 → 同上。
3. `ask_questions` 工具提问归类 needs_input 不回退（现有测试仍绿）。
4. 提问后 agent 继续工作（新消息/工具）→ 自动回 working。
5. run 结束后启发式/模型分类**不产生** completed；行停留在 idle 或 needs_input。
6. 手动 mark completed 仍可用，且手动完成的 state 不被 auto-state 覆盖。
7. `AGENT_BOARD_AUTO_STATE_NO_DONE=0` 时恢复旧行为（可自动 done）。
8. `npm run verify`（typecheck + test + pack dry-run）全绿。

## 6. 非目标

- detached 场景的回复路径改造。
- auto-state alive guard 放宽（无调用路径，不加死代码）。
- UI 分组/排序/颜色变化（`semanticState` 已驱动全部显示）。
- 模型分类器更换或精度调优。

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| 文本提问误报（引用问句） | 低 | 检测器只认结尾问号/短语；下一条消息自动恢复 working |
| pre-existing flaky 集成测试干扰 verify | 低 | 单文件重跑验证；与本改动无关的失败单独记录 |
| 模型降级路径缓存 | 低 | prompt 变化 → textHash 变化 → 自动重分类一次，无害 |

## 8. 成功率评估（用户已确认）

核心实现成功率 ~90-95%；残余风险为自然语言边缘判定与 pre-existing flaky 测试。流程保障：TDD → 本地 CR → Zima 单 Bot CR → merge。
