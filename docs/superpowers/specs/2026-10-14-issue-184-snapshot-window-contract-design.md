# Spec — Issue #184: A5 burst 偶红的修法与快照窗口契约对齐

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T08:07:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T08:18:00+08:00

> 状态：**DRAFT v2 待用户确认**（2026-10-14：cross-review 第 1 轮 6 条细化全部处置——验收 ID 换命名空间、`RUNNER_ROWS` 同源化、别名形态写清、D4 改为「文本入参」契约并补静态锚点 ④⑤、D3 补注收紧措辞、`:162`→`:161`）
> 认领：zhuxixi（2026-10-14）；基线 HEAD：本机 main `acc40fd`（`origin/main` 已前移到 `f81949d`；两者在本文档引用的文件上**无差异**——`acc40fd..f81949d` 只动 `README.md`、`src/core/pty-scroll.mjs`、`src/ui/pty-attach.ts`、`test-support/pty-attach-wheel-scenario.ts`、`test/pty-attach-wheel.test.mjs`、`test/pty-scroll.test.mjs`）
> 调研：`research/01-a5-burst-frame-window.md`（代码级证据链）、`research/a5-burst-probe.mjs`（三场景复现脚本）；v1 快照：`research/spec-v1-snapshot.md`
> 上游：issue #184（本 spec 目标，已挂为 #95 的 sub-issue）；#95（umbrella，观察台账）；#178（同源触发前提的兄弟 issue）；#132（同文件 A5 mid-stream 的断言修正先例）；#157（F3 postmortem 工具）
> 路由：测试 flake（根因已在调研阶段完成并确定性复现）→ 本 spec 是设计

## 1. 问题陈述

`test/terminal-snapshot.integration.test.mjs` 的 A5 burst 用例（`:264-355`）自 10-01 起在 CI 上三次红、本地从未复现，是 #95 观察窗内 A5 家族唯一未归因的签名。

| run | 日期(UTC) | commit | 红掉的 job | 耗时 | F3 现场 |
|---|---|---|---|---|---|
| `36884967528` | 10-01 | `9e692f2` | Node 22 | 30574ms | 有 |
| `38007611071` | 10-10 | `0fd1dc5` | Node 22 + Node 24 | 30559ms | 有 |
| `38443309547` | 10-13 | `f81949d` | Node 22 | 30505ms | 有 |

三次失败点相同（`:347-350` 的「400 行全覆盖」等待），都烧满 30s 上限；postmortem 逐字一致（host alive / `attachedClients: 3` / diagnostics 与 journal 皆空）。10-13 那次同批次 1160 pass / 1 fail，同文件邻用例 A5c 395ms、firehose 3.2s 通过——形态是「输出永远不会到」，不是机器慢。

目标：把这条签名的失败**变成不可能**（而不是继续加宽预算），并把它暴露出的快照窗口契约写准。

## 1.5 根因（已完成；不再重复调试）

**快照 frame 的容量上限（viewport rows + scrollback cap）小于用例的 burst 行数；frame 的进度标记 `snapshotSeq` 取在捕获空闲点上，因此窗口外的早期行既不在 frame 也不在补发流里，永久丢失。**

1. 窗口上限：`DEFAULT_SCROLLBACK_SNAPSHOT_CAP = 256`（`src/core/terminal-snapshot.mjs:19`）＋ viewport 24 行；`synthesizeFullRedrawFrame`（同文件 `:324`）只输出 `dto.scrollback + dto.viewport`。
2. 进度标记取在空闲点：`captureTerminalSnapshot()`（同文件 `:141`）先 `await whenIdle(model)`（`:142`），随后 `snapshotSeq: model.lastSeq`（`:161`）——捕获窗口内完成的输出也被算作「已覆盖」。
3. 补发只补空闲点之后：`ringChunksAfter(model, dto.snapshotSeq)`（`src/core/terminal-attach-protocol.mjs:138`）；捕获期间广播是 no-op（同文件 `:222` 附近注释），无第二条通道。
4. 截断对客户端不可见：`snapshot_begin` / `snapshot_frame` 的载荷都不含 `scrollbackTruncated`（`terminal-attach-protocol.mjs:100-109`、`:130-134`），客户端 `snapshotReady` 事件也不含（`src/core/terminal-attach-client.mjs:486`）——而 DTO 本身**是**带 `scrollbackTruncated` 的（`terminal-snapshot.mjs:166`），只是没跨线。
5. 用例内容超过窗口：burst 400 行（`:273` `FAKE_PTY_BURST_LINES: "400"`）> 280 行窗口，故「400 行全覆盖」这条断言（`:349`、`:351`）在「拍摄晚于前 280 行」时数学上必假。

形式化：设拍摄空闲点前模型已有 `R` 行、窗口容量 `W = rows + cap`，则 frame 覆盖 `[R-W+1, R]`、补发覆盖 `(R, ∞)`，丢失量 `= max(0, R - W)`。

**本地确定性复现**（`research/a5-burst-probe.mjs`）：S1（洪流落盘后才 subscribe）→ frame 279 行 `#122–#400`、union 279、缺 121；S3（subscribe 推迟到洪流之后）→ 同上，且 `protocolError` / `resubscribing` 均为 0（与 CI 形态逐字一致）；S2（用例原时序 ×5）→ 全绿。三次实验里**先于洪流连接的 driver 都收齐 400 行**，证明子进程写全了，丢失发生在 frame/补发侧。

**归因强度（必须如实标注）**：机制已证明「充分」且有确定性复现；三次 CI 现场无法逐条实证，因为现有 postmortem 不记录测试侧判据。D4 正是补这个判据——这是本 issue 与「再观察」的分界线。

## 2. 设计决策

### D1：修法取 R2（burst 行数降到窗口内），拒绝 R1 / R3

A5 在 spec 里的定义是「在 snapshot capture 与 subscription 建立之间注入 output」（`docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md:247`）。据此：

- **采纳 R2**：把 burst 行数从 400 降到 **200**（`const BURST_LINES = 200`），保留「洪流中订阅」语义；窗口容量 280 行，200 + 少量杂项行仍有余量，于是「`frame ∪ flush ∪ live` 覆盖全部行」这条断言**与拍摄时机无关**（拍摄早 → 全部走实时；拍摄晚 → frame 装得下全部）。
- **拒绝 R1**（等 B 的 `snapshotReady` 再派发 burst）：它把 B 的场景悄悄改成「洪流**之前**订阅」，与 A5 的定义相悖；且 A5 mid-stream 用例已经覆盖「订阅前就有输出」的形态，R1 之后本条不再提供独立信息。
- **拒绝 R3**（加 `AGENT_BOARD_TEST_*` 旋钮调大 cap）：为测试方便而改变**被测产品的策略**（窗口大小），测出的就不是用户实际运行的配置；且 `src/core/test-knobs.mjs` 的旋钮是「用时读取器」（`:16` `resolveTestMs(env, name, defaultMs)` 一族），为容量再开一个类型不同的旋钮属生产面扩张。本 issue 的病灶是测试断言越界，正确修法是让断言回到契约内。

**必须保留的压力面**（不是被降级掉的东西）：400 行溢出场景由 D5 的新用例**永久保留**，且以确定性方式（先等洪流落盘再订阅）执行。

### D2：窗口不平等守卫（机械保障，防后人把数字调大）

在 A5 burst 用例体内加一条运行期断言，把 D1 的前提写死：

```js
// The coverage assertion below is only valid while the whole burst fits the
// snapshot frame window (viewport rows + scrollback cap) — issue #184. Keep this
// guard so a future BURST_LINES bump fails loudly instead of flaking under load.
assert.ok(
	BURST_LINES + MAX_BURST_MISC_ROWS <= RUNNER_ROWS + DEFAULT_SCROLLBACK_SNAPSHOT_CAP,
	`burst must fit the snapshot frame window: ${BURST_LINES} + ${MAX_BURST_MISC_ROWS} > ${RUNNER_ROWS} + ${DEFAULT_SCROLLBACK_SNAPSHOT_CAP}`,
);
```

- **`RUNNER_ROWS` 必须与 `spawnRunner` 的默认同源**（第 1 轮 R1-D2）：在文件顶部提 `const RUNNER_ROWS = 24;`，让 `spawnRunner` 的默认参数（`:101` 的 `rows = 24`）与守卫共用它——不允许「镜像一个 24」，否则将来改 spawn 默认值会让守卫前提静默漂移。
- `DEFAULT_SCROLLBACK_SNAPSHOT_CAP` 从 `../src/core/terminal-snapshot.mjs` import（不写字面量）。
- `MAX_BURST_MISC_ROWS = 8`：洪流之外可能进入窗口的行数上限（boot banner、探针回显、`burst` 命令回显、光标空行等）；8 是保守值，200 + 8 = 208 ≤ 280 仍有余量。
- **硬约束**：burst 行数与窗口容量的关系一旦被后人改动，这条断言立即失败——这是「让下一次改动必须显式化」的机械保障，不是可选项。

### D3：功能侧裁决——本次**不**给 frame 加截断信号，把口径写准

调研发现 A5 的验收原文（`docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md:247`）写的是「客户端**永不静默丢失**或重复输出」，而快照窗口语义是「frame 只保证当前屏幕 + 256 行历史」；两者在「洪流中订阅且内容超过窗口」这一格上冲突，当前实际行为是**静默截断**。

**裁决：本 issue 不做协议/客户端改动，只把契约说准**，理由三条：① 该条验收的落点是**协议流**（seq 连续、不重不丢、有 `resnapshot_required` 降级路径），快照是**基线**而非流段，窗口外历史从来不在它的保证范围内；② 「窗口外怎么补」是产品问题（是否回填、回填多少、UI 怎么呈现），需要独立的 UX 输入，塞进一条 flake issue 只会让范围失控；③ 本 issue 的价值在于把机制钉住（D5）并让失败自报（D4），而不是顺手改产品行为。

**落地动作**：在设计文档的 A5 行加一段带日期的补注（原文不动），文本如下（实现阶段逐字复制）：

```markdown
> **2026-10-14 补注（issue #184）**：本条的「永不静默丢失或重复输出」适用域为**快照窗口内**——frame 的容量
> 上限为 `viewport rows + DEFAULT_SCROLLBACK_SNAPSHOT_CAP`（当前 24 + 256 = 280 行）。窗口外的更早历史不在
> 本协议保证范围内，协议帧不承载该段内容，客户端也不会收到截断信号（是否显式化另立项）；legacy 降级路径
> 只有 screen.log 尾部回放，且是有界、best-effort 的历史来源，不是正确性来源。机制、复现与依据见 issue #184。
```

（措辞按第 1 轮 R1-D5 收紧：不写「legacy 客户端由 screen.log 侧承担」，因为该路径是 `ATTACH_REPLAY_BYTES` 有界尾部回放、且设计文档 `:131` 明钉「screen.log 不是 attach 正确性的来源」。）

**明确记入后续候选（不在本 issue）**：frame 截断显式化——`snapshot_frame` / `snapshot_begin` 携带窗口或截断标记，或 runner 在截断时改走显式降级路径。注意：DTO 里**已经有** `scrollbackTruncated`（`terminal-snapshot.mjs:166`），缺的只是跨线那一步。若将来落地，D5 leg1 是那条改动的对账点。

### D4：F3 强化——失败必须自报机制（测试侧判据）

现有 `capture` 闭包只打基础设施状态（`:271` `formatPostmortem(capturePostmortem(root, viewId, null))`），所以「子进程没写」与「frame 截断」在失败现场不可分辨。本条把三个数打进失败输出：

- `driverRows`：先于洪流连接的老客户端收到多少行（**排除「子进程没写」**的关键读数）；
- `frameRows` / 帧内 `burstline` 编号区间：窗口实际承载了多少；
- `liveRows` / `unionRows` / `missing`：客户端 B 从 frame ∪ 实时各拿到多少、缺哪些。

分层与契约（按第 1 轮 R1-D4 收紧）：**helper 直接吃已展平的文本**（`driverTexts` / `frameText` / `liveTexts`），把「聚合 + 渲染」整体纳入单测；用例的 `capture` 闭包只做「消息数组 → 文本数组」的薄适配，并由 V2 的静态断言锚住三个键名。这样「接线接错但断言全过」的空间被压到只剩键名映射本身，而那部分有静态锚点兜底。

### D5：新增确定性用例（把窗口语义变成机械事实）

新增 `A5w` 用例（同文件，紧跟 A5 burst 用例之后），两条腿，**都不依赖拍摄时机**（先让已订阅的 driver 收齐全部行，再订阅 B）：

- **leg1（窗口溢出，400 行）**：断言 union 是 burst 编号的**连续尾段**、`union < total`、**头部缺失**（最早的若干行确实拿不到）、`protocolError` 与 `resubscribing` 为空。它把「窗口截断」从「机制理解」变成 CI 上的回归钉子。
- **leg2（窗口内，`BURST_LINES` = 200）**：断言 union **完整等于 total**。这是 D1 那条断言在**最坏拍摄时机**下的确定性证明（V1 的 20 轮连跑只是佐证，leg2 才是结构性证据）。

leg1 的边界断言写成范围而非精确值（窗口内的杂项行数与光标空行会让精确值漂移）：
`union` 连续、`1 < min(union)`、`union.size <= RUNNER_ROWS + DEFAULT_SCROLLBACK_SNAPSHOT_CAP`、`union.size >= RUNNER_ROWS + DEFAULT_SCROLLBACK_SNAPSHOT_CAP - MISC_TOLERANCE`（`MISC_TOLERANCE = 8`，理由同 D2）。

### D6：范围

test-only + 文档；不改 `runner/`、`src/` 的生产行为；不改 `ci.yml`；不调任何等待上限（机制不是预算问题）；不动 A5 mid-stream / A5c / A6 / firehose / parser containment 的断言与预算；不做 #95 的 F5 串行化 / F6 卫生 / U1/U2；不新增依赖；不重命名测试文件。

### D7：继承既有硬约束（不重新论证）

- 按名字隔离**只能用正模式**，且 `--test-name-pattern` **必须写在位置参数之前**（#178 D6/R2-D2 实证：写在文件之后会被 node v24.13.0 静默忽略、跑满全文件）。本文档所有命令均为 `node --test --test-name-pattern <模式> <文件>` 形态。
- 失败语义不变：`waitForWithPostmortem` 的 `timed out waiting` 前缀与成功语义原样保留（`test-support/flake-postmortem.mjs:73-84`），本次只在 `capture` 返回值上**追加**一段文本。
- 实现期注释与 commit message 一律英文（仓规 AGENTS.md）。

## 3. 组件契约

### 3.1 `test-support/burst-diagnostics.mjs`（新）

```js
/**
 * Extract `burstline-NNNN` ids from arbitrary chunk text (a chunk may carry many
 * lines, a partial line, or no burst content at all). Pure: no I/O, no timers.
 * @param {string} text
 * @returns {number[]} unique ids, ascending
 */
export function collectBurstIds(text)

/**
 * Render the test-side judgement block appended to a failing wait's postmortem.
 * Takes already-flattened texts so the whole aggregation + rendering path is
 * unit-testable; the caller's only job is mapping its message arrays to texts.
 * Pure: never throws on empty input (a failure before the client is wired must
 * still print, with zeros).
 * @param {{ expectedRows: number, driverTexts: string[], frameText: string, liveTexts: string[] }} input
 * @returns {string}
 */
export function formatBurstDiagnostics(input)
```

输出形态（`missing` 最多列 10 个 id，超出只给计数）：

```text
--- burst coverage (test-side judgement, issue #184) ---
expectedRows: 200
driverRows: 200 [1..200]
frameRows: 12 [189..200]
liveRows: 188
unionRows: 200
missing: <none>
```

- `driverRows` 的行为语义必须写在函数 JSDoc 里：**先于洪流建立订阅的 socket** 收到的行数与其编号区间——区间完整（`[1..expectedRows]`）即证明子进程把行全写出来了，丢失在服务端的 frame/补发侧。
- 渲染不负责判定、不断言；判定留在用例里（与 `flake-postmortem.mjs` 的分层一致）。

### 3.2 `test/terminal-snapshot.integration.test.mjs`（改）

1. **常量与守卫**（D1/D2）：文件顶部提 `const RUNNER_ROWS = 24;` 供 `spawnRunner` 默认参数（`:101`）与守卫共用；用例体顶部提 `BURST_LINES`（200）、`MAX_BURST_MISC_ROWS`（8）；`:273` 的 `FAKE_PTY_BURST_LINES: "400"` 改用 `String(BURST_LINES)`；`:349`/`:351` 的 `400` 改用 `BURST_LINES`；加 D2 的守卫断言。
2. **诊断接线**（D4）：`capture`（`:271`）追加诊断块。用例内用**可变持有对象**保存观测数据，且**保留既有别名**（避免让 `:295` 的 `driverMessages.find(...)` 悬空）：

   ```js
   const observed = { driver: [], b: null };
   const capture = () =>
       formatPostmortem(capturePostmortem(root, viewId, null))
       + "\n"
       + formatBurstDiagnostics({
           expectedRows: BURST_LINES,
           driverTexts: observed.driver.filter((m) => m.type === "output").map((m) => String(m.data)),
           frameText: observed.b?.snapshotReady?.[0]?.frame ?? "",
           liveTexts: (observed.b?.output ?? []).map((d) => (typeof d === "string" ? d : (d?.data ?? ""))),
       });
   // :279 keeps the alias, so :295's predicate is untouched:
   const driverMessages = (observed.driver = listen(driver).messages);
   // B wiring: const wiredB = wireClient(socketB); observed.b = wiredB.events;
   ```

   改动的只有赋值形态，不动任何断言与等待条件。
3. **新增 `A5w`**（D5）：插在 A5 burst 用例之后、A5c 之前。
4. 逐字保留：C 的 wire pin（`:322-332`）、B 的无恢复断言（`:339-340`）、「exactly once」断言句（`:351`，数字改常量）。

### 3.3 `test/burst-diagnostics.test.mjs`（新）

两件事：

1. **纯函数单测**（V2）：`collectBurstIds` 的提取/去重/排序/无关文本/多行块；`formatBurstDiagnostics` 的完整命中、缺行（列 missing）、空输入（打印零值不抛）、多文本块合并。
2. **接线静态断言**（V2 的第二半，按第 1 轮 R1-D4/R1-D6 扩到五条）：读真实测试源 `test/terminal-snapshot.integration.test.mjs`，断言——① `capture` 闭包含 `formatBurstDiagnostics(`；② 该闭包实参出现 `driverTexts` / `frameText` / `liveTexts` 三个键（锚住观测源映射，防接错）；③ A5 burst 用例体内每个 `await waitFor(` 调用都带 `capture` 实参；④ 守卫断言存在且含 `DEFAULT_SCROLLBACK_SNAPSHOT_CAP` 与 `RUNNER_ROWS`；⑤ 既有判据仍在（字符串锚点：`"flush chunks contiguous after the snapshot cursor"`、`assert.deepEqual(eventsB.protocolError, [])`、`assert.deepEqual(eventsB.resubscribing, [])`）——⑤ 直接回应「不许靠删断言变绿」。

仓内先例：`test/budget-audit.test.mjs`、`test/architecture-writer-boundary.test.mjs`（都读真实树做断言）。**边界声明**：静态断言是源码文本级，只防「接线被后人删掉/接错源」这类静默回归，不证明运行时真的打印；运行时打印由 V1 的失败路径与 V2 的纯函数单测分别兜底（该边界是第 1 轮 R1-D4 明确要求写出的）。

### 3.4 设计文档（改，D3）

`docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md` 的 A5 行（`:247`）下方插入 D3 的补注；原文一字不动（只追加，不改写历史结论）。

## 4. 可测性拆分设计（硬约束，实现阶段不得重新耦合）

| 单元 | 性质 | 怎么测 | 覆盖验收项 |
|---|---|---|---|
| `collectBurstIds` | **纯函数** | 注入字符串：多行块 / 无关文本 / 去重 / 排序 | V2 |
| `formatBurstDiagnostics` | **纯函数**（吃已展平文本：聚合 + 渲染） | 注入文本数组：全命中 / 缺行 / 空输入 / 多块合并 | V2 |
| `capture` 闭包的接线 | 副作用薄层（消息数组 → 文本数组） | 静态断言 ①②③⑤（源码文本）+ 失败路径真实打印 | V1 / V2 |
| A5 burst 用例（改后） | integration（真实 spawn） | V1 连跑 20 轮 + V4 全量剖面 | V1 / V4 |
| `A5w` 用例（新） | integration（确定性，先落盘再订阅） | leg1 + leg2 | V3 |
| 窗口不平等守卫 | 用例体内的运行期断言 | V1 的每次执行 | V1 |
| 设计文档补注 | 人工核对（CR） | 见 U1 | U1 |

边界声明：**解析（`collectBurstIds`）↔ 聚合/渲染（`formatBurstDiagnostics`）↔ 判定（用例内断言）**三层不得合并；不允许把判定塞进 helper（helper 里出现 assert 即为违约）。

## 5. 验收矩阵

> **ID 命名空间说明**（第 1 轮 R1-D1）：本文档用 `V1–V5` / `U1`，与设计文档（#91）的 `A1–A11` 验收编号、以及测试用例名（`A5:` / `A5c:` / 新增 `A5w:`）三套编号分开，避免混读。三者的对应关系如下：

| 本文档 ID | 对应测试用例名 | 设计文档（#91）验收编号 |
|---|---|---|
| V1 | `A5: burst through the snapshot window …` | A5（snapshot/subscribe 无 gap、无重复） |
| V2 | 新文件 `test/burst-diagnostics.test.mjs`（无 e2e 用例名） | —（本 issue 新增） |
| V3 | 新增 `A5w: …` | A5（窗口语义边界的补充） |
| V4 | 全量套件 | —（#95 观察台账口径） |
| V5 | 门禁 `npm run verify` | —（#95 的 F2 预算门禁 / F4 旋钮） |
| U1 | 设计文档补注 | A5（口径补注） |

> **判据按签名对账，不按「套件全绿」**：范围为 `A5: burst through the snapshot window` 与新增 `A5w`；同族其他签名（A6、firehose、parser containment）与范围外签名（`subscribe_terminal` / `editor_state` 属 #178、`A2 reconnect` 属 #95 台账）如实记录、不阻塞本 issue。
> 证据强度分层：**结构性证据**＝ V3（两条腿确定性覆盖「窗口内必达」「窗口外截断」）＋ V1 的守卫断言；**佐证**＝ 连跑与全量剖面（V1 轮次、V4）。不得把佐证当结构性证据陈述。

### 自动化验证

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| V1 | burst 覆盖断言（窗口内、洪流中订阅） | 自动化（integration） | `node --test --test-name-pattern "A5: burst through the snapshot window" test/terminal-snapshot.integration.test.mjs`，隔离连跑 20 轮 | 每轮通过；`union === BURST_LINES`（200）；C 的 wire pin 与 B 的无恢复断言逐字仍在；守卫断言（D2）在每轮被执行且成立 |
| V2 | 纯函数 + 接线 | 自动化（unit + static，新文件） | `node --test test/burst-diagnostics.test.mjs` | 纯函数单测全过（含空输入不抛、missing 列表上限 10、多文本块合并）；静态断言 ①–⑤ 全部命中 |
| V3 | 窗口语义（确定性双腿） | 自动化（integration，新用例） | `node --test --test-name-pattern "A5w:" test/terminal-snapshot.integration.test.mjs`（连跑 ≥5 轮） | leg1：union 为连续尾段、`1 < min(union)`、`union.size <= RUNNER_ROWS + cap`、`>= RUNNER_ROWS + cap - MISC_TOLERANCE`、`protocolError` 与 `resubscribing` 为空；leg2：`union === BURST_LINES` 完整；每轮耗时记录留档 |
| V4 | 全量剖面（佐证） | 自动化（重复） | 全量 `npm test` ≥3 轮（逐轮记 `pass/fail/skipped`、耗时、失败签名）＋ `npm run verify` ≥1 轮 | `A5 burst` 与 `A5w` 零命中；范围外签名如实记录不阻塞；逐轮数据留档回 issue |
| V5 | 全量与门禁 | 自动化（build + static） | `npm run verify`（typecheck + perf gate + tests + coverage + pack:dry）；budget-audit | 退出码 0；budget-audit 零违规；覆盖率阈值仍过（Lines ≥85 / Funcs ≥80 / Branches ≥70）；PR diff 不含 `.github/workflows/ci.yml` |

### 用户实测 / 人工核对

| ID | 功能点 | 验收方式 | 步骤与观察 | 通过标准 |
|----|--------|----------|------------|----------|
| U1 | 口径补注落位 | 用户实测（CR 阶段人工核对） | 打开 `docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md` 的 A5 行（`:247` 附近），确认其下有 2026-10-14 补注、指向 issue #184、写明窗口 = `viewport rows + DEFAULT_SCROLLBACK_SNAPSHOT_CAP`、写明窗口外历史不在协议保证范围内且 legacy 路径是有界 best-effort | 补注存在且表述与本 spec D3 逐字一致；原文未被改写 |

U1 不做成持久化测试的理由：这是文档行存在性核对，固化成测试后任何文档重排都会误报，收益极低；改为 CR 阶段人工核对 + 补注自带日期与 issue 号可追溯。

## 6. 非目标

- **不改 `runner/`、`src/` 的生产行为**（含 D3 的截断显式化：明确记为后续候选，另立项）。
- **不给 legacy 客户端加重放**、不动 `snapshotSeq` 语义、不动 `rescan`/`resnapshot_required` 路径。
- **不动任何等待上限与预算**（15s 文件默认、30s 用例上限照旧）；不新增用例级 timeout。
- **不动 A5 mid-stream / A5c / A6 / firehose / parser containment** 的断言与用例体。
- **不做 #95 的 F5 串行化决策、F6 卫生项、U1/U2 实测、非阻塞残留清单**。
- **不改 `ci.yml`**、不新增依赖、不重命名测试文件。
- **不引入 `AGENT_BOARD_TEST_*` 旋钮**（R3 已拒绝，理由见 D1）。

## 7. 风险与回退

| 风险 | 缓解 |
|---|---|
| burst 从 400 降到 200 削弱压力覆盖 | 400 行溢出场景由 `A5w` leg1 永久保留（且改为确定性执行）；burst 的分块压力来自 PTY coalescing 而非行数 |
| 断言依赖窗口常量，后人改 cap 会红 | 这是有意设计：D2 守卫 + `A5w` 两组边界断言让窗口变更必须显式化；实现一律引用 `DEFAULT_SCROLLBACK_SNAPSHOT_CAP` / `RUNNER_ROWS`，不写字面量 |
| 诊断闭包接错观测源而验收全过（第 1 轮 R1-D4） | helper 改为吃已展平文本（聚合+渲染入单测）；静态断言 ② 锚住三个键名；`A5w` 与 V1 的失败路径都走同一个闭包 |
| 静态接线断言被无关重构误报 | 只锚 `formatBurstDiagnostics(`、三个键名、`await waitFor(` 实参形态、守卫断言与 ⑤ 的判据字符串；误报即改断言，不得删断言 |
| `A5w` leg1 的边界断言写成精确值而漂移 | 已设计为范围 + 连续性断言（`MISC_TOLERANCE = 8`），理由与取值写进用例注释 |
| 新等待点触发 budget-audit 违规 | 新用例只用文件默认 15000 与既有 30000 形态、不声明用例级 timeout；V5 跑 `verify` 确认零违规（门禁是权威，若报违规按门禁要求改声明） |
| 补注被 CR 视为改写历史文档 | 只追加、不改写原文，且带日期与 issue 号；CR 反对则退化为「只在本 issue 记录口径，不改旧文档」，并在 §8 留痕 |
| 「修后全绿」被误读为修复证据 | §5 开头已分层：结构性证据＝V3 + 守卫；连跑/剖面只作佐证；V4 逐轮签名留档 |
| 三次 CI 现场仍未被逐条实证 | 已在 §1.5 如实标注；D4 的诊断块保证下一次红能自报机制（这是本 issue 的交付边界） |

**回退**：全部改动在 `test/`、`test-support/`、`docs/` → 回退 = revert 单个 PR。

## 8. 文档更新

- 设计文档 A5 行加 D3 补注（唯一文档改动，追加式）。
- 合并后回 #184 记录验收证据（V1 轮次、V3 两条腿读数、V4 逐轮签名）；回 #95 台账把 `A5 burst` 签名标注为已处理（结掉或转为「机制已知、窗口契约已对齐」）。
- 后续候选（独立 issue 输入，不在本 PR）：**frame 截断显式化**（`snapshot_frame` / `snapshot_begin` 携带窗口或截断标记；DTO 已有 `scrollbackTruncated`，缺的是跨线）。`A5w` leg1 是那条改动的对账点。
- KB 建议沉淀（另行确认，不在本 PR）：快照 frame 的窗口语义与 `snapshotSeq` 的覆盖口径（「快照 vs 流」的通用陷阱）。

## 9. 迁移顺序（step 6 的 plan 将据此拆 task）

1. `RUNNER_ROWS` 同源化 + `BURST_LINES`/`MAX_BURST_MISC_ROWS` 常量 + 守卫断言 + 断言数字改常量（V1）
2. `test-support/burst-diagnostics.mjs`（两个纯函数）+ 接入 `capture` 闭包（别名形态见 §3.2）（V1 / V2）
3. `test/burst-diagnostics.test.mjs`（纯函数单测 + 接线静态断言 ①–⑤）（V2）
4. 新增 `A5w` 双腿用例（V3）
5. 设计文档 A5 行补注（D3 / U1）
6. 验收扫尾：V1 隔离 20 轮 → V3 连跑 ≥5 轮 → V4 全量 ≥3 轮 + `verify` ≥1 轮 → V5 门禁，逐轮数据记录回 issue
