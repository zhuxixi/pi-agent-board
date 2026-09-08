# issue #90 spec：defaultModel 失效防护（launch 前校验 + child exit 归因）

日期：2026-09-08 · 状态：已授权全自动推进（用户 2026-09-08 决策）

## 背景与问题

session 创建时记录的 `meta.defaultModel` 失效后（provider 前缀改名/移除），attach 走「launchHost → child --model 失效 → exit 1 → host exited → 再 attach 再 launch」死循环（实录单 view 数百次 launch_host）。且 runner child exit 不写 error 字段（pty-runner.mjs L217），host.json 只有 exitCode:1 无任何归因线索。

## 核心设计

### D1：launch 前模型校验（断死循环）

1. **core 导出匹配函数**（`src/core/launch-options.mjs`）：
```js
/**
 * Whether a stored model reference resolves to a currently-available model.
 * Same rule as the dashboard launch picker: case-insensitive exact "provider/id".
 * @param {string|null|undefined} modelRef
 * @param {Array<{provider: string, id: string}>|undefined|null} availableModels
 * @returns {boolean} true when modelRef is empty/null (no constraint) or matched.
 */
export function modelRefAvailable(modelRef, availableModels)
```
`modelRef` 空 → true（无校验对象）；`availableModels` 空/undefined → true（调用方无法判断时保守放行，不制造新阻塞）。

2. **service 注入**：`createService` 新增 `opts.availableModels`（`() => Array<{provider,id}>`，每次调用实时取值；默认 undefined → 跳过校验）。`src/index.ts` serviceFor 与 `src/commands/agent-board.ts` flag 路径注入 `() => ctx.modelRegistry.getAvailable()`（try/catch → undefined，对齐 agent-board.ts L75-79 现有防御模式）。

3. **统一校验 helper**（service.mjs 模块内）：`validateViewModelMeta(meta) → null | string`（null=通过；string=错误消息）。错误消息明确可行动：`Model "X" configured for this session is no longer available — update the view's model or clear defaultModel, then retry attach.`

4. **两个校验点**（service.mjs 仅有的 host spawn 路径）：
   - `startHostUnderLease`：在 claim 之前校验（首选；若代码结构上 claim 已发生，则落 failed 清理后返回）→ `{ ok: false, error }`；
   - `adoptClaimedHost`：claim 是既有废弃记录 → 校验失败时 `updateOwnedHost` 落 failed（error 带模型消息）+ 返回 pending。
   - resolver 链路无需改动：ensureHostImpl 的 `{ ok:false, error }` 走现有 `pending(sessionFile, res.error)` → attach-flow notify 展示（渠道现成）。

5. **dashboard.ts L1738 `findLaunchModelByRef` 改为复用 core 导出**（单一事实源；LaunchModel 结构类型 JSDoc 化）。

### D2：child exit 错误归因（补线索）

1. **纯函数**（`src/core/heuristics.mjs` 新增导出）：`lastVisibleLogLine(text, maxLen = 200)`——strip ANSI（CSI `\x1b\[[0-9;?]*[ -/]*[@-~]` + OSC `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)` + 杂项转义），按行切分，返回最后一个非空可见行（`\r` 处理：取每行最后一个 `\r` 段），截断 maxLen。空输入/全空 → null。
2. **runner 接线**（`runner/pty-runner.mjs` child exit 回调 L213-223）：`exitCode != null && exitCode !== 0` 时 best-effort（try/catch 包裹，绝不影响 exit 路径）读 screen.log 尾部 ~8KB（openSync/readSync seek 尾部，不整文件读）→ `lastVisibleLogLine` → 非 null 则 `update({ ..., error })`。exitCode=0 不改 error。

## 非目标

- **失败退避**（issue 建议 2）：D1 已断 spawn 死循环；通用退避需跨 claim 持久计数，复杂度/收益不划算，未来场景再单开；
- **run 路径模型校验**（launchRun 的 model）：detach run 失败是一次性的，不循环——观察项；
- **UI 改动**：notify 渠道现成；
- 自动 fallback 到其他模型：静默换模型会让用户不知 session 行为已变，fail-fast + 明确提示更安全（issue 建议 1 的两个选项中选 fail-fast）。

## 可测性拆分设计

| 单元 | 位置 | 性质 | 测法 |
|---|---|---|---|
| `modelRefAvailable` | launch-options.mjs | 纯函数 | 真值表：大小写/null/空列表/部分匹配不匹配 |
| `validateViewModelMeta` + ensure 路径 | service.mjs | 副作用隔离（注入 availableModels + launchHost spy） | integration：失效模型 → ok:false + launchHost 零调用 + 无 starting claim 残留；有效/null/未注入三对照 |
| adopt 路径校验 | service.mjs | 同上 | integration：废弃 claim + 失效模型 → 落 failed + 不 spawn |
| `lastVisibleLogLine` | heuristics.mjs | 纯函数 | 单测：ANSI/OSC/`\r`/空行/截断/空输入 |
| runner exit 归因 | pty-runner.mjs | 集成 | pty-runner.integration.test.mjs 模式：fake child exit 1 + 预置 screen.log → host.json.error 含错误行；exit 0 → error 不变 |

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | modelRefAvailable 匹配规则 | 自动化（unit） | `node --test test/launch-options.test.mjs`（或既有对应文件） | 真值表全过 |
| A2 | 失效模型 attach 不再 spawn | 自动化（integration） | `node --test test/host-resolver.test.mjs` / service 测试 | ok:false、launchHost spy 零调用、无 starting claim 残留、error 消息含模型名 |
| A3 | 有效模型/null 模型回归 | 自动化（integration） | 同上 | 正常 launch（claim → spawn） |
| A4 | 未注入 availableModels 向后兼容 | 自动化（integration） | 同上 | 跳过校验正常 launch |
| A5 | adopt 路径失效模型 | 自动化（integration） | 同上 | 落 failed + 不 spawn |
| A6 | lastVisibleLogLine 提取 | 自动化（unit） | heuristics 测试 | ANSI/截断/空行用例全过 |
| A7 | runner exit≠0 归因 | 自动化（integration） | runner 测试 | host.json.error 含 screen.log 尾部错误行；exit 0 不写 |
| A8 | 全量回归 | 自动化（static/build） | `npm test` + `npm run typecheck` | 608+ 全绿 |
| U1 | 真实失效 view 实测 | 用户实测 | 合并后：view_539a5e9e20 恢复失效 defaultModel=glm/glm-5.3 → attach → 观察 notify 与 diagnostics | notify 明确提示模型失效；diagnostics 不再累积 launch_host；改回有效模型后 attach 成功 |

U1 需重启 pi（git 包不热重载），合并后由用户执行并回 issue 记录。

## 风险与降级

- availableModels 为空数组时保守放行（不制造新阻塞）——校验仅在能确定"失效"时拦截；
- 校验失败路径每次 attach 仅一次文件级操作，无进程开销；
- D2 全 try/catch best-effort，exit 路径行为不变。
