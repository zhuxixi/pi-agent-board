# Spec: 降权操作保持看板光标原位（issue #254）

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-23T22:52:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-23T23:20:00+08:00（第 1 轮复核处置：R1-D1/D2/D3/D4/D5/D6 全部接受）

> 依据：issue #254 正文 + 两轮调研（`research/round1-root-cause.md`、`research/round2-precedent-testability.md`）
> + JFox permanent `202610290000456264`（ID 选中→光标下沉）、`202610290000473827`（邻位助手）、`202609302208475929`（探针模式三坑）
> **行号基准：`b003dd1`（0.13.1）**

## 1. 目标与非目标

### 1.1 目标

1. 用户用 `h`（hold / unhold）或 `d`+`y`（done）主动降权一行后，光标留在原视觉位置——由原位置补位的那一行被选中，而不是跟着降到 `holding`/`completed` 分组。
2. 批量 done（SELECT 模式 `d`+`y`）同样保持位置：选中「被移走的区块下方那一行」，区块在末尾时取上方一行；不再跳到 `completedIds[0]`。
3. 后台驱动的状态迁移（如会话开始运行时 `idle` → `working`，行移到更靠前的分组）保持既有跟随行为，不受影响。
4. 降权失败（协调器拒绝、busy、超时）或以 0 条完成结束时，光标完全不动。

### 1.2 非目标

- 不改面板内 `x`→`y` 删除目前的「删除后落到 `orderedIds[0]`」行为（与 attach 内删除的邻位语义不一致，属既有分歧，另议）。
- 不改 `service.holdView` / `clearHoldView` / `markCompleted` / `markCompletedMany` 的语义与落库。
- 不改 `nextVisibleIdAfterRemoval`（issue #147）的签名与行为。
- 不清理批量 done 后多选集合里残留的 completed ID。
- 不改分组顺序、折叠、过滤、排序规则。
- 不做键位可配置化。

## 2. 现状审计（实现时按此定位）

| 事实 | 位置 |
| --- | --- |
| 选中状态按 ID 持有 | `src/ui/dashboard.ts:190` |
| `refresh()` 只在选中 ID 从 `orderedIds` 消失时重锚到 `orderedIds[0]`，仍可见则原样保留 | `src/ui/dashboard.ts:211-246`（重锚分支 222-236） |
| `toggleHold()`（`h`，hold / unhold 同一入口） | `src/ui/dashboard.ts:1076-1087` |
| `confirmDone()` 的 `onYes`（`d`+`y`） | `src/ui/dashboard.ts:1056-1072` |
| `confirmDoneSelection()` 的 `onYes`，含主动跟随 `selectedId = res.completedIds[0]` | `src/ui/dashboard.ts:1089-1111`（主动跟随 1102） |
| 确认键处理：`mode` 先复位到 `returnMode` 再调 `onYes` | `src/ui/dashboard.ts:592-610` |
| hold 落库 `semanticState="holding"` / unhold 落库 `"idle"` | `src/runtime/service.mjs:780-825` |
| 分组顺序：`holding`、`completed` 在底部 | `src/core/types.mjs:54-63`；`src/core/rows.mjs:233-258` |
| `d`/`h` 在 peek 与 session 模式也可达；`reply` 是文本模式，不可达 | `src/ui/dashboard.ts:520-521`、`:558-559`、`:398-399` |
| 既有邻位助手（按 rows 重算顺序） | `src/core/rows.mjs:270-277` |
| 轮询每 `POLL_MS` 调 `refresh()` + 渲染 | `src/commands/agent-board.ts:113-117` |
| 探针模板 | `test-support/dashboard-delete-key-probe.ts`；`test/dashboard-delete-key.test.mjs` |

## 3. 设计

### 3.1 决策表

| 决策点 | 选择 | 理由 | 被拒备选 |
| --- | --- | --- | --- |
| 邻位计算落点 | 新增**纯函数** `neighborAfterRemoval(orderedIds, removedIds, anchorId)` 放 `src/core/rows.mjs` | 输入只需看板顺序 ID 数组，不依赖 UI 状态，可在 `test/rows.test.mjs` 用 unit 覆盖全部边界 | 复用 `nextVisibleIdAfterRemoval`（它吃 `rows` 并自己调 `groupRowsByFolder`，不知道 filter/折叠，且无法表达「整块移除」） |
| 锚点计算时点 | mutation **之前**用当时的 `orderedIds` 算 | 状态命令是异步的，落地后顺序已变，只剩「新位置」没有「原位置」 | mutation 后按 `res.completedIds` 反推（拿不到原视觉位置） |
| 锚点应用时点 | 成功分支里、`refresh()` **之后**同步应用 | `refresh()` 会先把选中留在被降权行（或重锚到顶部），必须在它之后覆盖 | 在 `refresh()` 之前设置（会被 `refresh()` 的可见性判定覆盖） |
| 失败时 | 不应用锚点 | 行没动，应用锚点等于把光标从仍在原位的行上挪走 | 无条件应用（会产生「操作失败但光标跳走」） |
| 邻居失效兜底 | 邻居不在 `orderedIds` 时按**原下标 clamp** 取行 | 直接赋不可见 ID 会被 `refresh()` 判为「选中行消失」而回落到顶部第 1 行 | 赋 null / 交给 `refresh()` 兜底 |
| unhold（holding 行按 `h`） | 同样保持位置 | 「某行移走后下一行补位」与移动方向无关，同一套逻辑零成本；「h 不移动光标」心智一致 | 跟随回 idle 组（需要第二套逻辑，且与 hold 不对称） |
| 模式处理 | 所有模式统一应用锚点，不加模式判断 | 一条规则覆盖全部可达入口；`peekId` 独立于 `selectedId`，peek 面板仍停在被降权的会话上，不受影响，退出 peek 后光标已在原位置。`d`/`h` 实际可达的模式是 `list`、`select`（仅 `d`）、`peek`、`session`；`reply` 是文本输入模式，`h`/`d` 只是字面字符，不可能触发降权，无需特判 | 按模式特判（`d`+`y` 会先把 mode 复位成 `list` 再执行、`h` 则留在 `peek`，特判会让两条命令在 peek 下行为不一致） |
| 批量 done 的锚点 | 取「`doneIds` 在看板顺序中最靠前的那一行」，其后的非 `doneIds` 行优先 | `selectedBatchRows()` 遍历 Set 插入序，与看板顺序无关，不能取 `[0]` | 取 `selectedIds` 首个（随选择顺序抖动） |
| 批量 done 的补位 | 扫描时跳过全部 `doneIds` | 连续区块整体下移时，区块内下一行同样会沉底，不能当选 | 只排除锚点自身（连续区块会选到另一个沉底行） |

### 3.2 纯函数契约（`src/core/rows.mjs`）

```js
/**
 * Issue #254: the row the board should select after `removedIds` leave their
 * current positions. Mirrors issue #147 delete semantics — the next visible row
 * after the anchor's slot, else the previous one, else null — but works on the
 * dashboard's already-filtered, already-folded `orderedIds`.
 *
 * @param {readonly string[]} orderedIds visible row ids in board order
 * @param {Iterable<string>} removedIds ids that will leave their positions
 * @param {string} anchorId the id whose slot must be kept
 * @returns {{ neighborId: string | null, anchorIndex: number } | null}
 *   null when anchorId is not visible
 */
export function neighborAfterRemoval(orderedIds, removedIds, anchorId)
```

语义细则：

1. `anchorId` 不在 `orderedIds` → 返回 `null`（调用方不动光标）。
2. `anchorIndex = orderedIds.indexOf(anchorId)`。
3. 向后扫描 `anchorIndex+1 .. len-1`，返回第一个不在 `removedIds` 里的 ID；没有则向前扫描 `anchorIndex-1 .. 0`，返回第一个不在 `removedIds` 里的 ID。
4. 两向都没有 → `{ neighborId: null, anchorIndex }`。
5. 纯函数：不读时钟、不碰文件、不改入参。

### 3.3 dashboard 薄层（`src/ui/dashboard.ts`）

两个私有方法，只做状态读写，不含排序逻辑：

```ts
private capturePositionAnchor(id: string, removedIds: string[] = [id]) {
	return neighborAfterRemoval(this.orderedIds, removedIds, id);
}

private applyPositionAnchor(anchor: { neighborId: string | null; anchorIndex: number } | null): void {
	if (!anchor) return;
	if (anchor.neighborId && this.orderedIds.includes(anchor.neighborId)) {
		this.selectedId = anchor.neighborId;
		this.selectedSection = null;
		this.prewarmSelected();
		return;
	}
	const last = this.orderedIds.length - 1;
	if (last < 0) return;
	const fallback = this.orderedIds[Math.min(anchor.anchorIndex, last)] ?? null;
	if (!fallback) return;
	this.selectedId = fallback;
	this.selectedSection = null;
	this.prewarmSelected();
}
```

- `selectedSection` 必须清空：降权行可能迁入折叠分组，`refresh()` 此时已把焦点转成分区标题（`selectedId=null`、`selectedSection=state`），再设置 `selectedId` 而不清 `selectedSection` 会形成「两者同时有值」的非法态。
- `prewarmSelected()` 补齐预热：`refresh()` 只在 `selectedId` 变化时排程，锚点是在它之后改的。

### 3.4 三个调用点

| 入口 | 捕获 | 应用 |
| --- | --- | --- |
| `toggleHold()` | 调 `service.holdView` / `clearHoldView` **之前**：`const anchor = this.capturePositionAnchor(row.meta.id)` | `.then` 里 `res.ok` 分支、`this.refresh()` **之后**：`this.applyPositionAnchor(anchor)` |
| `confirmDone()` | `onYes` 内、`this.markCompleted(row)` **之前** | `.then` 里 `res.ok` 分支、`this.refresh()` **之后** |
| `confirmDoneSelection()` | `onYes` 内、`markCompletedMany` **之前**；锚点 ID 取 `doneIds` 中 `orderedIds` 下标最小者，`removedIds = doneIds` | `.then` 里 `res.ok && res.completed > 0` 时、`this.refresh()` **之后**；删除 `selectedId = res.completedIds[0]`。`completed === 0`（全部被跳过）时不应用锚点，光标不动 |

时序（以 `d`+`y` 为例）：

```text
key y → mode 复位 → onYes
  anchor = capturePositionAnchor(row.id)        # 用 mutation 前的 orderedIds
  await markCompleted(row)                      # 协调器写状态（可能耗时）
  if ok:
    refresh()                                   # 重排，选中暂时仍在被降权行
    applyPositionAnchor(anchor)                 # 覆盖为补位行（或 clamp 兜底）
  else:
    refresh()                                   # 忽略锚点；光标留在原行
```

`refresh()` 与 `applyPositionAnchor()` 在同一个 `.then` 回调里同步执行，两者之间不可能插入渲染或轮询，因此不会出现「先画在旧位置再跳」的闪烁帧；无需额外 `requestRender`（轮询 `POLL_MS` 与输入驱动渲染已覆盖）。

## 4. 边界与降级

| 场景 | 行为 |
| --- | --- |
| 被降权行是列表中唯一的一行 | `neighborId=null`；clamp 后仍取到该行（行仍在列表里），保持选中 |
| 被降权行是末行 | 向前扫描取上一行 |
| 批量 done 覆盖末尾连续区块 | 向后无可用行，向前取区块上一行 |
| 批量 done 覆盖全部行 | 行迁入 `DONE` 分组后仍然可见（`completed` 在 `GROUP_ORDER` 内），`neighborId=null`，clamp 到原下标处的已完成行；只有 `DONE` 分区被折叠时 `orderedIds` 才可能为空，此时 `applyPositionAnchor` 空操作 |
| 批量 done 全部被服务跳过（`completed=0`） | 不应用锚点（`res.completed > 0` 才应用），光标留在原行 |
| 过滤生效时降权 | 锚点按过滤后的 `orderedIds` 算；若邻居也被过滤掉，clamp 到原下标，下标越界取末行 |
| 邻居在 mutation 落地前被轮询移走 | `orderedIds.includes(neighborId)` 为假 → clamp 兜底 |
| 被降权行迁入折叠分组 | `refresh()` 把焦点转成分区标题；锚点设置 `selectedId` 并清空 `selectedSection`，光标回到行列表 |
| 批量 done 中有行被服务跳过（busy） | 该行仍在原位但被当作已移除而跳过，锚点可能落到更远一行——可接受的视觉容差，不做二次修正 |
| 协调器拒绝（busy / timeout） | 不应用锚点，光标留在原行 |
| peek 模式下降权 | 应用锚点；`peekId` 不变，peek 面板仍指向该会话 |

无降级路径：本改动不涉及外部服务、网络或配置，没有需要降级的能力。

## 5. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | 纯函数邻位语义：中间行 / 末行 / 单行 / 未知 ID / 整块移除 / 全部移除 | 自动化（unit） | `node --test test/rows.test.mjs`（新增 `neighborAfterRemoval` 用例） | 7 类断言全过 |
| A2 | `h` 降权中间行后光标留在原槽位 | 自动化（integration，探针） | `node --test test/dashboard-position-keep.test.mjs` | `selectedId` == 原位置下方的行，不是被降权行 |
| A3 | `h` 降权末行后选中上一行 | 自动化（integration，探针） | 同上 | `selectedId` == 上一行 |
| A4 | `h` 降权唯一行后仍选中该行 | 自动化（integration，探针） | 同上 | `selectedId` == 该行 |
| A5 | `d`+`y` 降权中间行后光标留在原槽位 | 自动化（integration，探针） | 同上 | `selectedId` == 补位行 |
| A6 | unhold（holding 行按 `h`）同样保持位置 | 自动化（integration，探针） | 同上 | `selectedId` == 原槽位补位行 |
| A7 | 批量 done 选中补位行，而非 `completedIds[0]` | 自动化（integration，探针） | 同上 | `selectedId` == 区块下方第一个非选中行；区块在末尾时为区块上一行 |
| A8 | 单条降权失败时光标不动（`h` 与 `d`+`y` 两条入口） | 自动化（integration，探针） | 同上（分别 patch `service.markCompleted` 与 `service.holdView` 返回 `{ok:false}`） | 两次的 `selectedId` 都等于操作前行 |
| A9 | 过滤生效时降权仍保持位置 | 自动化（integration，探针） | 同上（设置 `filterQuery` 后驱动 `h`） | `selectedId` == 过滤结果中的补位行 |
| A10 | peek 模式下降权不改变 peek 目标 | 自动化（integration，探针） | 同上 | `peekId` 不变；`selectedId` == 补位行 |
| A11 | 后台状态迁移（非用户操作）仍跟随 | 自动化（integration，探针） | 同上（改行状态后 `refresh()`） | `selectedId` 仍是被迁移的行 |
| A12 | 类型与既有测试不被破坏 | 自动化（static + 回归） | `npm run typecheck`；`npm test` | 无类型错误；既有测试全绿（含 `test/dashboard-delete-key.test.mjs` 对删除回落 `orderedIds[0]` 的断言） |
| A13 | 批量 done 全部被跳过时不应用锚点 | 自动化（integration，探针） | 同上（patch `service.markCompletedMany` 返回 `{ok:true, completed:0, skipped:N, completedIds:[]}`） | `selectedId` == 操作前行 |
| U1 | 真终端手感（可选实测） | 用户实测 | 时机：A1–A13 全绿之后、合并之前。前置：在本仓 PR 的 worktree 上 `pi install <worktree 绝对路径>`（或把 `~/.pi/agent/extensions/agent-board` 的 symlink 指向该 worktree）并重启 pi，确认加载的是改动后的代码；然后打开 board，选中中部行依次按 `h`、`d`+`y`，观察光标与滚动位置 | 光标不跳到 `ON HOLD`/`DONE` 分组，滚动不动 |

说明：批量 done 的 `!res.ok` 分支在现有 `markCompletedMany` 实现下不可达（恒返回 `ok:true`，`src/runtime/service.mjs:2488`），不设独立验收项；对应场景由 A13（`completed=0`）覆盖。

## 6. 可测性拆分设计

### 6.1 纯函数层（unit）

- `neighborAfterRemoval(orderedIds, removedIds, anchorId)`：输入全是字符串数组/可迭代集合，无 I/O、无时钟。测试放 `test/rows.test.mjs`，与既有 `nextVisibleIdAfterRemoval` 用例相邻。
- 用例矩阵：`[a,b,c]` 锚 `b` → `c`；锚 `c` → `b`；`[a]` 锚 `a` → `null` 邻居、`anchorIndex=0`；未知锚 → `null`；`[a,b,c,d]` 移除 `{b,c}` 锚 `b` → `d`；移除全部 → `null` 邻居；移除末行锚末行 → 前驱。

### 6.2 UI 薄层（integration，探针）

- 探针 `test-support/dashboard-position-keep-probe.ts`：照 `dashboard-delete-key-probe.ts` 的模式，构造真实 service + 真实 `DashboardComponent`，用 `handleInput()` 驱动，白盒读 `selectedId` / `peekId` / `orderedIds`，末尾 `console.log(JSON.stringify(report))`。
- 测试 `test/dashboard-position-keep.test.mjs`：`execFileSync` 跑一次探针，对同一份报告做 A2–A13 的逐条断言。
- 边界放在同一份报告里（不同的小节），避免多次起进程。
- 三处已知坑按 JFox `202609302208475929` 处理：`keybindings = { matches: () => false }`；行补丁同时包 `service.rows()` 与 `service.row(id)`；断言宽度 240。

### 6.3 由此形成的测试边界

- 纯函数测「选谁」的全部数学；探针测「三个入口是否在正确的时点捕获/应用、失败分支是否不动、各模式是否一致」。两层不重叠：探针不重复枚举邻位组合，unit 不碰组件状态。

## 7. 风险

1. **异步窗口内的顺序假设**：锚点在 mutation 前捕获，若 mutation 期间用户又按了导航键（`j`/`k`），应用锚点会覆盖用户刚刚的移动。缓解：概率低（确认流程需要连按），且宽限期只有一次状态命令；接受该行为并在实现注释中写明。
2. **批量 done 的锚点与实际不一致**：服务可能跳过部分行（busy / 已 completed），跳过行仍在原位但被当作已移除。缓解：可接受容差，A7 只断言「等价于整块移除」的主路径；全部被跳过（`completed=0`）时不应用锚点（A13），避免「什么都没动、光标却跳走」。
3. **`prewarmSelected()` 的额外调用**可能导致一次多余的预热请求（指向补位行而非降权行）。缓解：预热本身是幂等缓存，代价可忽略。
