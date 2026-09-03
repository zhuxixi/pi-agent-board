# Spec: 收窄 code-refs pr-backlink 提取（issue #65）

- Issue: https://github.com/zhuxixi/pi-agent-board/issues/65
- 日期：2026-09-02
- 状态：已确认（2026-09-03，含 review 修订）

## 1. 背景与根因（已确认）

board 行在「PR 已创建、issue 未关闭」窗口期内把 issue 徽标误显示为 `#1`（正确应为 `#19`）。根因分为直接触发和放大因素：

1. **直接触发是后续证据复用了过宽的正则**：`src/core/code-refs.mjs:510` 的 `PR_BACKLINK_RE` 含 `issue\s+#\d+` 分支，无 closing keyword 锚定。CR 报告模板文本「本轮仅验证上轮 issue #1（no-pushback）」中的 `#1` 是 review finding 编号，却被采为 claim 级 pr-backlink 候选。
2. **放大因素是 4b 的证据归属过宽**：`resolveBacklinkAfter`（:651）会把 `pr create` 后的后续 command 与 assistant 文本都视为同一 PR 的回链候选；误匹配的 lastIndex≈158 比真实 #19 信号（PR 正文回链≈66、worktree 命名=-1）更靠后，同强度按 lastIndex 决胜 → `#1` 胜出。

`buildEngineInput` 将最近 200 条命令与最近 20 条 assistant 文本分别截取，再把两组数组拼成一条“命令在前、assistant 在后”的伪序列；它没有保留两类证据之间的真实 `at` 时序。因此“最后 3 条命令 / 前 3 条 assistant”不能可靠表示“紧随 PR create 的消息”，本 spec 不采用这个索引启发式。

窗口滑动后 winner 回到 #19 的现象，以及旧 #1 通过 `mergeWithExisting` 留在 `allRefs` 的现象均已确认；后者属于历史 artifact 迁移边界，单独列入非目标。

## 2. 修复设计

### F1：按证据上下文拆分 PR 回链正则（主修复）

不再让一个宽正则同时处理 PR create 命令和后续 assistant 文本，改为两个纯数据规则：

```js
// Explicit PR-create command: preserve the legacy `issue #N` body form.
const PR_CREATE_BACKLINK_RE =
    /\b(?:(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+(?:issue\s+)?|issue\s+)#(\d{1,7})(?!\w)/i;

// Later assistant evidence: accept only canonical closing-keyword syntax.
const PR_FOLLOWUP_BACKLINK_RE =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+#(\d{1,7})(?!\w)/i;
```

- 两个规则都增加单词边界，避免 `prefix #1`、`disclose #2`、`unresolved #3` 这类长单词子串误命中；编号后的 `(?!\w)` 防止把超过 7 位的数字或紧随字母/下划线的 token 截断成前 7 位。
- `applyPrBacklink` 只在 provider 命中的 PR create 命令上使用 `PR_CREATE_BACKLINK_RE`。PR create 命令中的 `issue #N` 是用户显式提供的 body 内容，保留原 PR #43 的兼容契约。
- `resolveBacklinkAfter` 只对 assistant 文本使用 `PR_FOLLOWUP_BACKLINK_RE`。后续 assistant 仅接受 `close/closed/closes #N`、`fix/fixed/fixes #N`、`resolve/resolved/resolves #N`，不接受裸 `issue #N`，也不接受 `fixes issue #N`。
- 两类规则都保留 `claim` 强度；不通过降级强度掩盖误报。

### F2：去掉后续 command 的通用回链扫描，不实现伪时序窗口

当前输入模型无法安全实现“PR create 后 N 条证据”这样的时间窗口，因此本 issue 采用可证明的来源边界，而不是增加固定数量常量：

- PR create 命令自身仍由 `PR_CREATE_BACKLINK_RE` 处理。
- `resolveBacklinkAfter` **只遍历 assistantTexts**，不再遍历 marker 后的任意 command。`gh issue close #21`、`gh pr comment 20 --body "fixes #21"`、`echo "closes #40"` 都不能被升级成 `pr-backlink` claim；它们若命中 provider 自己的 command 规则，仍保留其原本的 issue/pr action 语义，但 source 不得是 `pr-backlink`。
- **只有恰好一个不同 command index 的 PR create marker 时**，Rule 4b 才调用 assistant backlink resolver；同一条 create 命令若因用户规则与内置规则同时命中，仍只算一个 marker。没有 marker 或存在多个不同 PR create 命令时不产生 assistant `pr-backlink` 候选。这样在当前缺少真实时序的输入模型下，宁可漏掉多 PR 场景的 assistant 回链，也不把一条文本错误归属给某个 PR。
- resolver 接收 `assistantTexts` 与 `commands.length` 这个 `baseIndex`，按 assistantTexts 保留顺序返回第一个 canonical 命中，并以 `baseIndex + assistantIndex` 记录 `lastIndex`。这里的 `baseIndex` 仅用于保持现有排序契约，不表示真实时间。
- 不按当前扁平索引增加固定 assistant 数量或固定时间窗口。即使只有一个 PR marker，assistant 的真实 `at` 时序目前仍未进入 `buildEngineInput`，晚到的 canonical 句式仍可能被误归属；这是明确记录的残余风险。若要做到“紧邻 assistant 总结”的严格归属，必须先引入保留 `kind/text/at/sequence` 的 timestamped ordered-evidence 输入，另开 issue 设计。
- 后续 `gh pr edit --body/--body-file` 的回链归属不在本 issue 承诺范围内；只有被纳入 assistant evidence 且符合 canonical closing 语法的文本才可能被识别。

### F3：同步文档、测试和历史边界

- 更新 `src/core/code-refs.mjs` 注释，以及 `docs/superpowers/specs/2026-08-29-code-refs-badges-design.md` 中关于 PR 回链语法和 4b 来源的描述：create body 可兼容 `issue #N`；后续 assistant 只认 canonical closing 语法；任意后续 command 不属于 PR 回链。原始 design doc 是已提交历史文档，本次同步更新必须在 worktree 中与代码、测试同一提交完成。
- 通过 extractor 测试和 store 组合测试验证新 extraction 不会产生 issue #1；不改变 store/渲染运行逻辑。
- 本 issue 只保证**新一轮 extraction**不再从 CR 文本产生 `#1`；已有 `github.json` 中的旧 `pr-backlink` ref 不回溯清理，`mergeWithExisting` 的 carry-forward 语义不变。若要求升级后立即清除历史误 ref，需要另一个 artifact migration 设计。

### 不采纳的方向

- **按扁平索引加“最后 3 条”窗口**：时序信息不存在，边界不可证明，可能同时漏掉真实 assistant 总结并误收更晚文本。不采纳。
- **把 4b 降级为 action**：改变 spec D1 设计语义（PR 回链 = claim），且误 ref 仍会残留在 `allRefs`/peek。不采纳。
- **本 issue 内引入 timestamped ordered-evidence**：这是解决长期归属准确性的正确方向，但会扩大 evidence 输入契约和迁移面；作为后续独立设计，不与本次精确误报修复捆绑。

## 3. 验收矩阵

以下验收同时覆盖“候选没有产生”和“用户可见 winner 没被错误候选抢走”两层；表中命令均可在本地纯数据 fixture 中执行。

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | issue #65 的真实误报路径不再产生 #1 | 自动化验证（unit） | `node --test test/code-refs-extract.test.mjs` | fixture 含 PR body `Closes #19`、worktree `issue-19-*`、assistant 文本「上轮 issue #1」「pushback verdict for issue #1」；`result.issue.number === 19`，且 `result.allRefs` 完全不含 `kind=issue, number=1`（无论 source） |
| A2 | create body 兼容性与严格 follow-up 语法 | 自动化验证（unit） | 同上 | create 命令中的裸 `issue #40` 仍得到 `source=pr-body`；create body 与 assistant 中的 `Closes/Fixes/Resolves #40` 按各自上下文正确命中；assistant 中裸 `issue #1`、`fixes issue #1`、`prefix #1`、`disclose #2`、`unresolved #3` 及超过 7 位编号均不作为 follow-up backlink，且上述负例不进入 `allRefs` |
| A3 | 后续 command 不被冒充为 PR 回链；多 PR assistant 不产生歧义归属 | 自动化验证（unit） | 同上 | create `#19` 后的 `gh issue close #21`、`gh pr comment ... fixes #21`、`echo "closes #21"` 不产生 `source=pr-backlink, number=21`；存在两个 PR create marker 时，后续 assistant 的 canonical 回链不产生任何 `pr-backlink` 候选（不猜测归属） |
| A4 | 持久化组合路径不产生新的误 ref | 自动化验证（integration） | `node --test test/code-refs-store.test.mjs` | 通过 `updateCodeRefsFromEvidence` 写入新 `github.json` 后，winner 为 #19，`allRefs` 不含新产生的 `pr-backlink #1`；不要求清理预先存在的历史 artifact |
| A5 | 全量回归与发布包完整性 | 自动化验证（unit + static + build） | `npm run verify` | typecheck、全测试、c8 coverage（lines ≥85%、functions ≥80%、branches ≥70%）及 `npm pack --dry-run` 全部通过 |

无用户实测项：本次行为改动限定在 `code-refs.mjs` 纯函数提取器、对应测试和文档，零网络、零新的持久化协议；历史 artifact 清理明确不属于本次验收。

## 4. 可测性拆分设计

改动主体落在 `src/core/code-refs.mjs`（既有纯函数模块，零 I/O、无副作用），并更新 extractor 测试、store 组合测试和设计文档；不修改 store/渲染运行逻辑：

- **`PR_CREATE_BACKLINK_RE` + `matchPrCreateBacklink(text)`**：只负责 PR create 命令自身的回链语法（包括兼容的 legacy `issue #N`）。输入/输出为字符串与正整数或 `null`；通过 `extractCodeRefs` 测 body 正例、closing keyword 单词边界和 7 位编号边界。
- **`PR_FOLLOWUP_BACKLINK_RE` + `matchPrFollowupBacklink(text)`**：只负责后续 assistant 的 canonical closing 语法。测试 `Closes/Fixes/Resolves #N` 正例，以及裸 `issue #N`、`fixes issue #N`、嵌入长单词、超过 7 位编号等负例；同时验证命中后只产生 `source=pr-backlink`，不会把同一文本中的其他裸 `#N` 误升级。
- **`resolveBacklinkAfter(assistantTexts, baseIndex)`**：保持纯函数，只遍历 assistant 文本并使用 follow-up matcher；不再接收或扫描 command，也不再需要 marker/`stopBefore`。调用方仅在不同 PR create command index 恰好为 1 时调用一次；多 PR 场景直接跳过 resolver，通过 `extractCodeRefs` 黑盒测试这一保守边界，不为内部细节新增公共导出。
- **store 组合边界**：使用临时 root 和脱敏 evidence 调用 `updateCodeRefsFromEvidence`，确认 extractor 结果经过 artifact 合并后仍不新增 #1；单独断言“历史 artifact 不自动清理”，避免把非目标误写成已修复。
- **副作用隔离**：不读网络、不改变 `github.json` schema、不改 `mergeWithExisting`；timestamped ordered-evidence 归属模型和 artifact migration 另行设计。

## 5. 非目标

- 不按当前扁平 `commands + assistantTexts` 索引实现固定数量/时间窗口；不在本 issue 改造 timestamped ordered-evidence 输入。
- 不扫描任意后续 command 作为 `pr-backlink`；不承诺多 PR 场景的 assistant 回链归属；不承诺后续 `gh pr edit --body/--body-file` 的独立归属。
- 不清理已经写入 `github.json` 的旧误 ref；carry-forward 机制本身不变，升级后的历史清理另开 artifact migration issue。
- 不动 mention 兜底（issue #61 是独立问题）。
- 不改变 providers.json schema；两个 backlink 正则是引擎内置的上下文规则，不能由 provider 规则配置覆盖。
