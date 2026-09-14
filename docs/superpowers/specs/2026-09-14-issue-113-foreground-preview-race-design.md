# Issue 113 Spec — coordinator 写入竞态：前台预览被 agent_end 空投影覆盖

> Issue: zhuxixi/pi-agent-board#113
> 修订版（v2）：吸收 spec 审查 findings（归档站点纠错、测试隔离、测试保真度、规则证据链、备选否决记录、字段边界、U1 前提）。

## 根因（机制链确认）

`syncForegroundEvent` → `syncRowEvent` 每个事件开头 `statusFromRow(row)` **从磁盘 state.json 重新重建**内存 status（`listRows → loadRow → readState` 直读磁盘，已逐行确认）。`message_end` 设置 `latestAssistantPreview`/`lastAgentActivityAt` 后经 `void writeForegroundState(...)` **fire-and-forget** 发往 coordinator；coordinator 先 fsync journal 再 materialize（毫秒级延迟）。`projectViewState` 对 `latestAssistantPreview` 无 previousState fallback（空串 `""` 不被 `??` 遮挡），因此 7ms 后到达的 `agent_end` 重读到未落盘的旧 state → 重建出空投影 → `finalizeRun` 的 `deriveSummary` 兜底 "Needs instructions" → **await 写入把非空 preview 覆盖为 `""`**。

影响面：`sync_foreground` 仅 service.mjs 发送（交互式前台镜像），evidence.json 直写不受影响。0.6.x 子进程直写磁盘（read-your-writes 天然成立），coordinator 间接层（socket RTT + fsync-before-materialize）破坏该不变量。

正交路径（已排查，确认不是同 bug 变体）：手动完成 fence（`isManualCompletion`，agent_end 分支先行返回）；`reconcile()` 的 `reconcile_finalize`（service.mjs:2006）是 PTY host 崩溃恢复判定，payload 不含 preview。

## 修复设计（主修复 = issue 评论区已验证 patch 的规范落地）

### 新模块 `src/core/foreground-preview-cache.mjs`

进程内 read-your-writes 缓存，**模块级单例**——依据：`src/index.ts:88` 的 `serviceFor(ctx)` 无记忆化、每次调用都 `createService`（"reuse one instance" 注释只针对 sweeper 的 `sweepService`，因其构造副作用），闭包级缓存会被每事件新建的实例丢弃。

```js
export function createForegroundPreviewCache() {
  const map = new Map(); // viewId -> { latestAssistantPreview, lastAgentActivityAt }
  return {
    // 记住投影中的已知字段。新鲜度规则（以 lastAgentActivityAt 为序）：
    // 更新时间戳的投影整体获胜；较旧/无时间戳的投影只补空缺，永不降级已有条目。
    remember(viewId, { latestAssistantPreview, lastAgentActivityAt }),
    // 回填：缓存时间戳严格更新于重建 status（含 status 无时间戳的 legacy 行）时
    // 整体采纳缓存两字段；否则仅填空字段（磁盘更新或同静时磁盘优先）。
    backfill(viewId, status),
    forget(viewId),   // 归档时清理，防无界增长
    clear(),          // 测试隔离：清空全部条目（模块级状态跨测试存活）
    size,             // 测试/诊断用
  };
}
export const foregroundPreviewCache = createForegroundPreviewCache(); // 模块级单例
```

判定谓词（与仓库既有约定一致）：`latestAssistantPreview` 判空用 falsy（空串）；`lastAgentActivityAt` 判空用 `== null`。纯逻辑规则可独立测试，副作用（Map 读写）集中在模块内。

### 规则依据（为什么"空值永不覆盖"是安全的）

全仓 `latestAssistantPreview` 赋值只有两处，且都只会写非空值：

- `src/core/events.mjs:132`——`message_end` 分支，位于 `if (text)` 内，只写 `truncate(text)`；
- `src/core/state-commands.mjs:331`——`finalize_run` overlay，其唯一发送方 `runner/job-runner.mjs:272` 用 `if (status.latestAssistantPreview) payload...` 的 truthiness guard 只带非空值。

即"非空才带"已是本仓库处理该字段同类时序问题的既有约定，本修复把它延伸到前台镜像路径。此外 viewId↔sessionFile 映射不可变（全仓 src/runner/scripts 无 `.sessionFile =` 赋值；adopt 同文件复用同一 view、新文件新建 viewId），故按 viewId 缓存不会跨会话串值。

**证据链 caveat（终审补充）**：`runner/job-runner.mjs:743` 还有一条不经 truthiness guard 的写入路径——`patch_fields` 命令携带 `state: { summary, latestAssistantPreview }`（字段白名单在 `state-commands.mjs:112`）。该写入方（后台 runner）不在前台缓存的覆盖范围内：缓存只在本进程 `writeForegroundState` 时 remember。因此回填必须"仅当缓存严格更新时才整体采纳"——绝不能用较旧的缓存值覆盖磁盘上更新的 runner 写入（实现已按此新鲜度规则落地）。

### `src/runtime/service.mjs` 改动点

1. `writeForegroundState`：`projected` 计算后、发送/直写前 → `foregroundPreviewCache.remember(row.meta.id, projected)`（coordinator 开/关两模式都执行；直写模式下 backfill 天然 no-op → 零行为变化）。
2. `syncRowEvent`：`statusFromRow(row)` 之后立即 `foregroundPreviewCache.backfill(row.meta.id, status)`（在所有事件分支之前——agent_end 分支的 `finalizeRun`/`deriveSummary`、throughput 分支的投影都从回填后的 status 出发）。
3. 归档清理（**仅两个真实写入点**，全仓 `archived = true` 的写入清单）：
   - `service.mjs:670`（`archiveView`，`archiveMany`/`archive` 均委托到此）
   - `service.mjs:1968`（`archiveByState`，内联写 `row.meta.archived = true`，不经过 archiveView）

   两处均加 `foregroundPreviewCache.forget(row.meta.id)`。

### 数据流（修复后，竞态时序）

```
message_end: 磁盘读(空) → reduceEvent 设 preview=B → writeForegroundState 投影(B) → remember(v, {B}) → 发送
agent_end:   磁盘读(空 preview) → backfill(v, status) 回填 B → finalizeRun → summary=首句B → 投影(B) → 发送 ✓
```

### 边界与降级

- coordinator off（直写）：`writeState` 同步落盘，磁盘读回自己的写 → backfill 不触发，行为与 0.6.x 一致。
- 多轮会话：同一竞态在第 N≥2 轮下磁盘已有上一轮非空 preview，若只"填空"会把行冻结在上一轮回复（终审发现）。落地规则为新鲜度感知合并：缓存条目时间戳严格更新于磁盘重建值时整体采纳，较旧的重建写（agent_end baseline）也不得降级缓存；磁盘更新或同静时磁盘优先。
- 多进程：缓存在单进程内；竞态发生在同进程事件流内，足够。
- 已知边界（非本次修复范围）：coordinator 命令到达乱序（0.7.0 架构既有行为，概率极低，窗口远小于 0.6.x 并发直写）。
- 内存：viewId→2 字段；两个归档站点 forget；模块导出 `clear()` 供测试复位。上限不做额外 LRU（归档清理已覆盖生命周期）。

## 备选方案（考虑并否决，记录理由）

| 备选 | 否决理由 |
|---|---|
| 方案 2：agent_end finalize 复用本轮 message_end 内存投影 | 需跨事件保留整个 status 对象；status 其他字段（lastActivityAt 等）依赖磁盘实时性，易引入新偏差；改动面大 |
| 方案 3：coordinator `sync_foreground` 合并「非空最后写入获胜」 | 改单写者层覆盖语义 = 翻 #107/#91 的契约与测试；且不解决本进程重读决策用旧数据的问题；无第二发送方，暂不引入 |
| 方案 4：per-view await 在途写入（通用 read-your-writes） | 需在每事件前 await 上一笔未落盘写：coordinator 降级时 ensure 窗口最长约 10s，会直接拖慢事件处理；且在发版前改动事件时序语义面过大。保留为未来若出现第二类字段回退问题时的候选 |

## 非目标

- 同类 stale rebuild 理论上可回退的其它字段（如 `error` 的清除）不在本规则覆盖范围：「非空获胜」规则修不了 clear 型回退，套用会让陈旧 error 更黏（属设计上不能做的事）。当前无证据表明其造成用户可见问题。
- 多轮乱序到达边界（既有架构行为，非本 issue 回归）。
- legacy 路径行为变更：仅回归验证，不做主动改动。
- coordinator 层防护（方案 3）：见上表。

## 可测性拆分设计（自动化验证类功能点）

| 功能点 | 独立单元 | 测试边界 |
|---|---|---|
| 缓存写入规则（新鲜度胜出、旧写不降级、空值不覆盖非空） | `remember`（覆盖语义） | 新模块单测：构造实例直接断言规则 |
| 回填规则（严格更新时整体采纳；否则仅填空字段，磁盘优先） | `backfill`（字段级选择） | 同上：更新/较旧/同静/无时间戳四类输入 |
| 事件流集成（message_end→agent_end 竞态） | `createService(opts.sendStateCommand)` 注入 fake | service.test.mjs 新用例：fake **延迟 N ms 落盘**（保真真实时序：晚到的 message_end 写不得回退 agent_end 的正确投影），断言最终磁盘状态 |
| 真实 coordinator 不变式 | 既有 `startTrackedCoordinator` + `waitFor` 基座 | service.test.mjs 新用例（同型先例：:862 真实 coordinator 前台测试）：断言不变式，不依赖竞态是否发生 |
| 归档清理 | `forget` + 两个归档站点 | 模块单测 + archiveView/archiveByState 路径断言 |
| 测试隔离 | 模块 `clear()` | 新用例以 beforeEach/finally 复位模块级缓存（service.test.mjs 大量测试共用 viewId "v1"，不复位会跨测污染、掩盖回归） |

关键：**延迟落盘 fake** 使竞态确定性复现（第二事件在延迟窗口内同步读取旧磁盘），且覆盖"晚到写入不回退"的真实语义——无 sleep 竞态、非 flaky。红证：未打缓存修复时 A3 必失败；绿证：修复后必通过。

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 缓存写入规则（新鲜度胜出、旧写不降级、空值不覆盖非空） | 自动化（unit） | `node --test test/foreground-preview-cache.test.mjs` | 规则表断言全部通过 |
| A2 | 回填规则（严格更新时整体采纳；否则仅填空，磁盘优先；preview 用 falsy、时间戳用 `== null`） | 自动化（unit） | 同上 | 四类输入断言通过 |
| A3 | 竞态事件流：延迟落盘 fake，message_end→agent_end | 自动化（integration） | `node --test test/service.test.mjs`（新增用例） | 最终磁盘 state：preview=回复文本、summary=首句（非 "Needs instructions"）；移除缓存修复时该用例失败（红/绿自证）；调用方式与生产一致（每次 `service(root)` 新建实例，验证缓存确在模块级） |
| A4 | 真实 coordinator 不变式 | 自动化（integration） | `node --test test/service.test.mjs`（新增用例，复用 startTrackedCoordinator/waitFor） | 最终磁盘 preview/summary 正确（任何时序下成立） |
| A5 | 直写模式不回归 | 自动化（unit 回归） | `node --test test/service.test.mjs`（既有 syncForegroundEvent 用例） | 全部通过，行为不变 |
| A6 | 归档清理（两个站点） | 自动化（unit + integration） | 缓存单测 + `archiveView`/`archiveByState` 路径断言 | 归档后缓存无该 viewId |
| A7 | 测试隔离 | 自动化（integration） | 新用例 beforeEach/finally 调用 `clear()` | 跨测试无残留（viewId "v1" 复用时行为一致） |
| A8 | 全量回归 | 自动化（build） | `npm run typecheck && npm test` | 全绿 |
| U1 | 真实交互会话端到端 | 用户实测 | 安装后开交互式 pi 会话，完成一轮带 assistant 回复的对话，等 idle，观察 dashboard | idle 行显示回复首句，非 "Needs instructions"；state-journal.jsonl 无空投影覆盖序列（**前提**：修复进程内生效，仅对新代码加载后的事件有效；存量已写坏的行需等下一轮 message_end 才会显示正确预览，不追溯治愈） |
