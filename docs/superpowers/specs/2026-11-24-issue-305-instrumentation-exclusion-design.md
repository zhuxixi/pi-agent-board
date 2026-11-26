# Spec — Issue #305：B/Q 实时预算用例移出 c8 插桩相位

> 状态：**DRAFT 待用户确认**（`stepwise` 档，交叉复核收敛后 ⏸）
> 认领：zhuxixi（2026-11-24）
> 调研：同目录 `research/01-instrumentation-exclusion-mechanisms.md`
> 上游：由 #95 拆出（#95 已关闭，本 issue 是其实时预算线）；与 #306（串行化）互补，不重叠
> 基线 HEAD：起草于 `7fe965c`；复核时 main 已推进到 `3b85421`（v0.14.0 发布合并），被引 9 个文件相对基线仅 package.json 版本号一行差异，全部代码事实仍成立；实现以当时 main 头为准
> Drafted: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-24T08:04:46+08:00

> Revised: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-24T08:15:14+08:00（R1：接受 R1-G1 + R1-D1…D5 全部六条）

> Revised: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-24T08:30:44+08:00（R2：收敛，接受 R2-D1/D2 两条细化；A7/A4 正则改为与先例逐字同构，A6 双命令口径统一）

## 1. 问题陈述

`test/attach-entry-22.test.mjs` 的 B/Q 用例断言 200ms 绝对发布预算（scenario 子进程实测，
`--clock real`）。c8 通过 `NODE_V8_COVERAGE` 插桩整棵进程树，延迟膨胀 2.5–6×（#121 实测），
使该预算在 Coverage 步骤上落进噪声带：PR #300 两次重跑 Node 22+c8 同指纹红，
main run `45292590706` 上 Node 24+c8 也红。裸跑与隔离运行健康（Q 三连 48–108ms）。

这是 #95 两条病灶里"插桩使绝对阈值失效"的那条（另一条"并行争抢"归 #306）。
**修法不是放宽阈值**（#95 的 40→90→150s 教训；放宽到噪声带之上等于失去回归检出），
而是让绝对预算断言不在被插桩的环境里判定——#121 已为 perf gate 确立同一原则。

## 2. 设计决策

### D1：插桩时跳过（opt-out），不做 A11 式全 opt-in

B/Q 的 test 体里除时序断言外还挂着大量正确性断言（completeLiteralGrid、cursor 匹配、
ordered exit、cleanup.ok）。全 opt-in（A11 形态）会把这些正确性覆盖从每次常规运行里拿走；
而失败证据集中在插桩步骤，裸跑双 Node 健康。因此：

- 未被插桩（`NODE_V8_COVERAGE` 未设置）→ B/Q 照常运行（含时序断言）；
- 被插桩（`NODE_V8_COVERAGE` 已设置）→ B/Q 带字符串理由跳过，理由含 `issue #305` 与原因。

罕见裸跑 Unit 步红（并行争抢形态）**不在本切片**——归 #306 串行化。

### D2：判定必须是纯函数，消费形态沿用 #300 的条件式 skip

新模块 `test-support/instrumentation-gate.mjs`，导出纯函数：

```js
/** True when the process tree is under coverage instrumentation (c8 sets NODE_V8_COVERAGE for the whole tree). */
export function underCoverageInstrumentation(env = process.env) {
	return env.NODE_V8_COVERAGE !== undefined;
}
```

- 谓词与 `test-support/perf-gate.mjs:15` / `scripts/run-perf-gate.mjs:17` 的既有判据**逐字一致**
  （`!== undefined`），不发明第二个插桩定义。
- test 文件消费形态与 #300 的条件式 skip 同构：
  `{ skip: underCoverageInstrumentation() ? "issue #305: …" : undefined }`，
  分别落在 B、Q 两条 test 上（该文件是顶层 `test(`，无参数化循环，无需缩进用例解析）。

### D3：守卫三层，防"排除变成删除"也防"静默失效"

1. **真值表单测**（unit）：`underCoverageInstrumentation` 对注入 env 的行为——
   未设置→false；设置为路径→true；设置为空串→true（与谓词 `!== undefined` 一致，空串也算"已设置"，
   显式钉死避免实现漂移成 truthy 判断）。
2. **静态守卫**（static）：读 `test/attach-entry-22.test.mjs` 源码，断言——
   B、Q 两条 test 都带条件式 skip 且理由含 `issue #305`；
   两条的核心断言仍在（`fastAndCorrect`、`target200ms.met`、`completeLiteralGrid`、`cleanup.ok`）
   ——**排除不得变成删除**；
   该文件 import 了 `underCoverageInstrumentation`。
3. **运行时双向实证**（integration，新 `test/attach-entry-22-instrumentation.test.mjs`）：
   spawn `node --test test/attach-entry-22.test.mjs` 两次并解析 TAP 结果行——
   - **运行方向**：子 env 删除 `NODE_V8_COVERAGE`（无论外层是否被插桩，守卫自己构造干净 env）
     → B、Q 均为 `ok` 且非 SKIP；
   - **跳过方向**：子 env 设置 `NODE_V8_COVERAGE` 指向临时目录 → B、Q 均 `ok … # SKIP issue #305`。
   - 两个方向都清除继承的 `NODE_TEST_CONTEXT`（#300 实证：不清除则嵌套 runner 空跑）；
     TAP 解析只认 `ok`/`not ok` 结果行（排除 `# Subtest:` 头）；skip 理由匹配容忍 `\#` 转义。

**预算与代价声明**：本机实测目标文件全量约 20s 级（B/Q 各 ~9s、其余秒级；实现期以实测记录为准），
运行方向 + 跳过方向合计 < 30s，守卫 `{ timeout: 120_000 }`（4× 余量）附 `// budget:` 豁免。
**套件级代价**：运行方向使 B/Q 真钟用例每次套件多跑一遍——`npm test` 与 `npm run test:coverage`
各 +~20s 墙钟（实现期实测入账）。
**A4 争抢红分诊规则**：运行方向若因并行争抢红（非插桩、非断言删除），属 #306 域，按已知家族处置；
**禁止以削弱守卫（去掉运行方向、放宽断言）来"修"它**。
`NODE_V8_COVERAGE` 临时目录由守卫自建自清（V8 会向该目录写 coverage JSON，属预期副作用）。

### D4：范围与硬边界

- **只动测试**：不改 `src/`、`runner/`、`ci.yml`、依赖、用例名；不改 200ms 阈值本身。
**范围界标（收窄后的真命题）**：在 **spawn 的 `--clock real` scenario 子进程内判定的紧绝对预算（≤200ms）**仅 B/Q。
仓内另有三处宽余量绝对毫秒断言，已核对、明列为例外，插桩膨胀（2.5–6×）不使其失效（无 Coverage 步红记录，且典型值距预算远）：
`attach-frame-witness.integration` 的 `settledMs < 1500 / <= 4000`（宽调度窗口）、`terminal-snapshot` 的进程内 <500/<1000ms。
若它们的余量将来被消费到噪声带，属新切片，不在本 spec 外推。
- **不做 c8 相位重构、不做串行化**——那是 #306 的域；本切片与它互补（插桩失效 vs 并行争抢）。
- **不放宽任何预算**；预算纪律仍由 #157/F2 的 budget-audit 门禁把守（B/Q 无 `{ timeout: }` 声明，
  新增 skip 选项不影响审计输入，实现后以 `test/budget-audit.test.mjs` 绿证明）。

### D5：200ms 的"为什么是这个数"入档

B/Q 用例头部补一行注释：200ms 是热附着（hot-attach）体验目标、单次试验是 witness 不是分布
（scenario 输出里 `target200ms.note` 已有此口径，测试侧同步钉一句），并注明"该预算只在未插桩环境判定
（issue #305）"。这是 #95 关门时"每条预算都要能回答为什么是这个数"纪律的落点。

## 3. 组件契约

### 3.1 `test-support/instrumentation-gate.mjs`（新，纯函数）

仅一个导出 `underCoverageInstrumentation(env = process.env)`，无 I/O、无副作用。
不与 `perf-gate.mjs` 合并：A11 的判定含 opt-in 轴，语义不同；两处谓词逐字一致由真值表单测 + 静态引用共同钉住。

### 3.2 `test/attach-entry-22.test.mjs`（改）

- import `underCoverageInstrumentation`；
- B、Q 两条 test 加条件式 skip（字符串理由含 `issue #305: real-time budget is invalid under coverage instrumentation (NODE_V8_COVERAGE); asserted in plain runs` 要素）；
- 其余断言、scenario 调用、超时结构零改动；
- 头部补 D5 的预算口径注释。

### 3.3 `test/attach-entry-22-instrumentation.test.mjs`（新，integration）

唯一 spawn 子进程的守卫（D3 第 3 层）。子 env 由守卫完全构造（基线 = 外层 env 去掉
`NODE_TEST_CONTEXT`；运行方向再去掉 `NODE_V8_COVERAGE`，跳过方向再设 `NODE_V8_COVERAGE=<tmpdir>`）。

### 3.4 `test/instrumentation-gate.test.mjs`（新，unit + static 合一文件）

真值表单测 + D3 第 2 层静态守卫（读目标文件源码断言 skip 形态与核心断言在位）。

### 3.5 非组件

不新增 `src/` 模块、不改 `scripts/`、不动 `package.json` 脚本与 `ci.yml`。

## 4. 可测性拆分设计（实现阶段硬约束）

| 单元 | 性质 | 怎么测 | 验收 |
|---|---|---|---|
| `underCoverageInstrumentation(env)` | **纯函数**（无 I/O） | 注入 env 真值表：未设 / 路径 / 空串 / 明确 undefined | A1 |
| 条件式 skip 接线 | 声明式 test 选项 | 静态守卫钉形态（B、Q 都带，理由含 issue #305） | A2 |
| 核心断言未被削弱 | 静态 | 静态守卫按真实源文本钉四条核心断言在位 | A3 |
| 双向运行时实证 | integration（spawn + TAP 解析） | 运行方向 ok 非 SKIP；跳过方向 `# SKIP issue #305` | A4 |
| 覆盖率阈值安全 | build | `npm run test:coverage` exit 0（B/Q 在插桩下跳过后全仓阈值仍过） | A5 |
| 预算审计相容 | 自动化 | `node --test test/budget-audit.test.mjs` 绿（与 §5 A6 的 `npm run verify` 同 ID 双命令，对账时两条都要记录） | A6 |

边界声明：**判定（纯）↔ 接线（声明式）↔ 实证（integration）三层不得合并**；
不允许在目标文件里内联第二个插桩谓词，也不允许守卫只测单方向。

## 5. 验收矩阵

### 自动化验证

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 插桩谓词真值表 | 自动化（unit，`test/instrumentation-gate.test.mjs`） | `node --test test/instrumentation-gate.test.mjs` | 未设→false；路径/空串→true；与 perf-gate 谓词形态一致 |
| A2 | skip 只落插桩态且可追溯 | 自动化（static，同上） | 静态守卫断言 B、Q 带条件式 skip、理由含 `issue #305` | 拍平成恒跳或删 skip 均红 |
| A3 | 排除未变成删除 | 自动化（static，同上） | 静态守卫断言 `fastAndCorrect`、`target200ms.met`、`completeLiteralGrid`、`cleanup.ok` 仍在 B/Q 体 | 任一被删即红 |
| A4 | 双向运行时实证 | 自动化（integration，`test/attach-entry-22-instrumentation.test.mjs`） | `node --test test/attach-entry-22-instrumentation.test.mjs` | 干净 env：B/Q `ok` 非 SKIP；插桩 env：B/Q `ok … # SKIP`，理由匹配正则 `/issue \\?#305/`（同 A7 口径） |
| A5 | 覆盖率阈值不倒退 | 自动化（build） | `npm run test:coverage` | exit 0，All files ≥ 85/80/70 |
| A6 | 预算审计相容与全量门禁 | 自动化（unit + build + integration） | `node --test test/budget-audit.test.mjs`（审计相容）；`npm run verify`（全量门禁） | 两条命令均 exit 0；verify 含 typecheck + perf + 裸跑 + c8 + pack |
| A7 | CI 双矩阵 | 自动化（CI） | PR 的 `Test (Node 22)` / `Test (Node 24)` | 两个必需检查均绿；Coverage 步骤日志（CI 非 TTY 下 `node --test` 默认 TAP reporter，`scripts/run-tests.mjs:331` 未显式指定 reporter）中 B/Q 显示为 SKIP，理由匹配正则 `/issue \\?#305/`（`\\?` 为可选字面反斜杠，兼容 TAP 的 `\#305` 转义；与 `test/frame-witness-quarantine-tap.test.mjs:47` 的 `/issue \\?#95/` 逐字同构） |
| A8 | 200ms 预算口径入档（D5） | 自动化（static，`test/instrumentation-gate.test.mjs`） | 静态守卫断言目标文件头部注释含 `200` 与 `issue #305` 及 witness-非分布口径 | 注释被删或口径丢失即红 |

### 用户实测 / 合并后观测

| ID | 功能点 | 验收方式 | 步骤与观察 | 通过标准 |
|----|--------|----------|------------|----------|
| U1 | 该家族不再阻塞绿 main | 用户实测（合并后 CI 观测） | `gh run list --branch main --limit 8` 逐 run 看失败点 | 合并后 ≥5 次 main run 中 `attach-entry-22` B/Q 零命中（插桩下已 SKIP）；若裸跑 Unit 步红，属 #306 域并记录到该 issue |

**诚实声明**：A6/A7 全绿不能证明裸跑路径的时序断言永远稳定（并行争抢偶发红归 #306）；
本切片只消除"插桩使绝对预算失效"这一失效模式。

## 6. 非目标

- 不做 #306 的串行化 / 双相位。
- 不迁移其余 4 个 `--clock real` 文件（无绝对预算断言）。
- 不改 200ms 阈值、不放宽任何预算。
- 不改 CI job 结构、不新增 step。

## 7. 交付物清单

1. `test-support/instrumentation-gate.mjs`（新，~15 行）
2. `test/attach-entry-22.test.mjs`（skip 接线 + 注释，~10 行）
3. `test/instrumentation-gate.test.mjs`（新，unit+static，~90 行）
4. `test/attach-entry-22-instrumentation.test.mjs`（新，integration，~70 行）
5. spec 落 worktree `docs/superpowers/specs/2026-11-24-issue-305-instrumentation-exclusion-design.md`（首个 commit）
6. plan 落 worktree `docs/superpowers/plans/2026-11-24-issue-305-instrumentation-exclusion.md`
7. issue #305 评论：交付对账（**机械形状**：`git diff --name-only <base>..HEAD` 必须恰为交付物 1–4 的四个代码文件 + 交付物 5/6 的两个 docs 文件，多一个即对账失败——D4 边界的核对不靠自觉）+ U1 观察起点
