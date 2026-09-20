# Spec — Issue #121: 性能门禁脱离覆盖率插桩（A11）

> 状态：**已确认**（2026-09-20 会话确认；同目录调研件保留在 `~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-121/`）
> 认领：zhuxixi（2026-09-14）；R3 复核于 2026-09-20 HEAD `794c755`
> 调研：`~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-121/research/01-prior-art-and-precedent.md`、`02-measurements.md`、`03-revalidation-at-head.md`
> 上游：issue #121（本 spec 的目标）；#95（真实进程预算与串行化，**不在本 spec 范围**）；#31/PR #32（CI 结构来源）；#117（性能用例引入方）

## 1. 问题陈述

`main` 连续四次 CI 红，失败点全部是 **Coverage 步骤里的 A11 性能断言**，而同一次 run 的 Unit tests 步骤全绿：

```
not ok 809 - A11: paced stream (80ms interval, ~5s wall) stays within thresholds
  error: 'paced feed p99 11.379ms exceeds 8ms'
```

`main` 启用了分支保护（必需检查 `Test (Node 22)` / `Test (Node 24)`，`enforce_admins: true`），所以这道红持续卡住所有后续 PR。

目标：让性能门禁**继续真实生效**，但只在**它能产生有效测量的环境**里决定 CI；把无效环境（覆盖率插桩、并行争抢）下的性能断言从判定路径上移除。

## 1.5 根因（已完成，含实测证据；不再重复调试）

见 `research/02-measurements.md` 与 `research/03-revalidation-at-head.md`。结论两条：

1. **插桩路径是无效测量环境（R3 收紧后的表述）**：同一份代码在 Coverage 步骤测到 `paced p99` = 1.541ms / 3.838ms（绿）与 **11.379ms**（红），跨度 7.5×。R3 在 HEAD `794c755` 上用**单文件、机器空闲、无并行套件竞争**的 c8 运行复现了失败——5 次中 3 次超 8ms（**13.904** / 6.057 / 6.295 / **10.755** / **13.221**），同期无插桩 4 次为 2.376 / 2.073 / 2.659 / 2.107ms（余量 3.0–3.9×，很稳）。→ **插桩本身就是判定失败的充分项，CI 并行只是放大器**；8ms 在插桩下测的是 c8 的采样开销，不是终端模型的代码开销。对照 09-14 本机插桩实测（3.1–6.5ms，4 次全过），余量正在收窄，「偶尔侥幸通过」就是当前形态。
2. **阈值本来就不是为 CI 标定的**：`#117` 的 plan 原文写的是 `… (80×24 + 256 scrollback **on dev hardware**)`，且该 plan 已预设处置规则：`if CI shows systematic misses, **re-baseline with evidence (not silently relax)**`。本 spec 的设计约束即此句。

附带事实（影响设计）：
- 性能用例自 #117 起在 CI 每次运行被执行**两次**（Unit tests + Coverage），且其负载已被证实会拖慢套件内其他真实进程测试（plan 记录：为它把 `pty-runner.integration` 的 `waitFor` 默认值从 3s 提到 10s）。
- 把性能用例排除后，覆盖率**仍远离阈值**（实测 Lines 92.2 / Funcs 91.16 / Branch 79.58，阈值 85/80/70；`terminal-model.mjs` 仍为 100%）→ 「排除会掉阈值」的顾虑已被实测否定。

## 2. 设计决策

### D1：性能断言只在专用 perf 入口里决定 CI（**opt-in 门禁**）

性能断言默认**不测量**，仅在显式开启时测量：

- 新环境变量 `AGENT_BOARD_PERF_GATE=1` 表示「允许性能断言决定结果」。
- 未开启时，三个性能用例以 `{ skip: reason }` 跳过（reason 里写明入口 `npm run test:perf`），**不执行测量循环**（因此也不贡献 CPU 负载）。
- 新入口 `npm run test:perf` 是唯一权威执行路径。

**为什么 opt-in 而不是 opt-out**（备选方案对照）：

| 方案 | 优点 | 为什么不选 / 代价 |
|---|---|---|
| **opt-in（选定）** | 测量环境受控；默认套件不含性能负载；语义明确「只有专用入口才是判定」 | 本地 `npm test` 不再顺带守性能 → 由 `verify` + CI step 兜住 |
| opt-out（默认测，CI 覆盖率步骤关掉） | 本地默认守性能 | CI 的 Unit tests 步骤仍在并行环境里判定同一阈值 → 噪声问题原样保留；且默认路径依旧把性能负载压给其他测试 |
| 放宽阈值 | 改动最小 | **被 plan 明文禁止**（not silently relax）；放宽到噪声带之上等于失去回归检出能力 |
| `--test-skip-pattern` 按名字排除 | 不动测试文件 | 名字耦合（改名即静默失效）；只治 CI，不治本地 `npm run test:coverage` |

### D2：覆盖率与并行套件都不测量性能（不改 glob）

`test` / `test:coverage` 两个脚本**保持原样**（`node --test test/*.test.mjs`）——因为 D1 的门禁会让性能断言在未 opt-in 时自然跳过。这样：

- 覆盖率步骤不再被性能断言判定；
- 并行套件不再承担性能用例的 CPU 负载（消除 #117 已实测过的那类连带 flake）；
- 不改文件路径 → **不使 #91 的 A11 验收行、plan、VERIFY.md 中已记录的命令路径失效**，也把与 #95 的 `ci.yml` 冲突面缩到「新增一个 step」这一处。

### D3：权威测量跑在「独立 step、单文件、串行」环境

CI 新增一个 step（**不新增 job**，避免改分支保护配置）：

```yaml
      - name: "Perf gate (serial, no coverage)"
        run: npm run test:perf
```

- 位置：`Typecheck` 之后、`Unit tests` 之前——此时机器最安静（本 job 尚无可争抢的测试进程），且失败快速暴露。
- step 内只跑 `test/terminal-model-perf.test.mjs` 一个文件；**首轮不携带 `--test-concurrency=1`**——该 flag 需 Node 21+，而 `package.json` 声明 `engines: node>=20`，且单文件时它是 no-op（2026-09-20 用户裁决：YAGNI，删掉；将来新增第二个 perf 文件时加回，并行测量必须保持不可能）。
- **升级路径（写进 plan 的残留账）**：若该 step 在连续 5 次运行中仍抖动 → (a) 先按 D4 用证据重设界；(b) 仍不行才升级为独立 job（独立 runner）并把它加入必需检查（需改分支保护，属人工配置步骤）。

### D4：基线按证据重设，禁止静默放宽

- 首轮**维持现有数值**（feed p95 ≤ 5ms / p99 ≤ 8ms、capture ≤ 50ms、hydrate ≤ 100ms）。
- perf step 必须保留现有 `burst:` / `paced:` 数值日志行（趋势证据，本次已存在，不新增打印）。
- 规则：**任何阈值调整必须附证据**——至少包含连续 N≥5 次专用 step 的实测分布，且新界需高于实测噪声上限并留有 ≥2× 系数；调整记录写回本 issue。禁止出现「阈值悄悄变大」的 diff。

### D5：`NODE_V8_COVERAGE` 作为机械兜底门禁

c8 会给子进程设置 `NODE_V8_COVERAGE`（本机实测值 `<repo>/coverage/tmp`，与 KB 笔记 `202608250830231905` 一致）。因此：

- 门禁判定为**两个环境变量的纯函数**：即使有人开了 `AGENT_BOARD_PERF_GATE=1`，只要 `NODE_V8_COVERAGE` 存在就**拒绝测量**（reason 写明「正在被覆盖率插桩」）。
- 入口脚本在此情形下**不静默跳过，而是响亮失败**（退出码非 0 + 明确错误），避免「在插桩下跑 perf 门禁得到全绿」这种假信号。

## 3. 组件契约

### 3.1 门禁纯函数（新文件 `test-support/perf-gate.mjs`）

`test-support/**` 已在 `.c8rc.json` 的 exclude 中，不影响覆盖率口径。

```js
/**
 * @param {Record<string,string|undefined>} env
 * @returns {{run: boolean, reason: string}}
 */
export function perfGateDecision(env = process.env)
```

真值表（域：`AGENT_BOARD_PERF_GATE` ∈ {未设置, `"1"`, `"0"`, 其它值} × `NODE_V8_COVERAGE` ∈ {未设置, 已设置} = **8 种组合**；下表按规则合并成 5 行，A1 必须覆盖全部 8 种）：

| `AGENT_BOARD_PERF_GATE` | `NODE_V8_COVERAGE` | `run` | `reason` 要点 |
|---|---|---|---|
| 未设置 | 未设置 | false | 需要 `AGENT_BOARD_PERF_GATE=1`（指向 `npm run test:perf`） |
| 未设置 | 已设置 | false | 同上（插桩不改变「未 opt-in」的判定） |
| `"1"` | 未设置 | **true** | 空 |
| `"1"` | 已设置 | false | 正在被覆盖率插桩，拒绝测量 |
| `"0"` / 其它值 | 任意 | false | 需要 `AGENT_BOARD_PERF_GATE=1` |

### 3.2 入口脚本（新文件 `scripts/run-perf-gate.mjs`）

- 副作用隔离层：只做「读环境 → 判定插桩 → 执行或拒绝」，**不含**测量/断言逻辑，也**不**调用 `perfGateDecision` 做静默跳过——入口是 opt-in 路径，进来的人就是来测量的。
- 分层契约（硬约束）：`perfGateDecision` 只服务**测试文件**（决定用例跳过与否）；入口脚本只做**插桩检测**——`NODE_V8_COVERAGE` 存在 → 打印错误并 `exit 1`（响亮失败，**不**清除该变量后照跑）。若实现成「调纯函数得 run=false → 静默 exit 0」，插桩下的 perf 门禁就会假绿，这正是 D5 要堵的洞。
- 否则 `spawn(process.execPath, ["--test", "--test-concurrency=1", "test/terminal-model-perf.test.mjs"], { stdio: "inherit", env: { ...process.env, AGENT_BOARD_PERF_GATE: "1" } })` 并透传退出码。
- 跨平台：脚本内设置环境变量，**不用** npm 脚本里的内联 `VAR=1 cmd` 写法（Windows cmd 不支持；本仓库有 Windows 支持面）。

### 3.3 性能测试文件（改 `test/terminal-model-perf.test.mjs`）

- 顶层求值 `const gate = perfGateDecision(process.env)`，三个用例各自 `test(name, { skip: gate.run ? false : gate.reason }, fn)`。
- 阈值常量（`FEED_P95_LIMIT` 等）**留在本文件**，不下移到 helper：它们是被测契约，helper 只决定「是否测量」。
- 断言与测量逻辑其余部分不动（含 ring overflow 用例：它无延迟断言，但因同文件跳过而一并跳过——记录为已知取舍，见 §6）。

### 3.4 脚本与 CI（改 `package.json`、`.github/workflows/ci.yml`）

```json
"test":          "node --test test/*.test.mjs",                 // 不变
"test:coverage": "c8 node --test test/*.test.mjs",              // 不变
"test:perf":     "node scripts/run-perf-gate.mjs",              // 新增
"verify":        "npm run typecheck && npm run test:perf && npm test && npm run test:coverage && npm run pack:dry"
```

`verify` 把 perf 放在覆盖率之前（先安静测量，再插桩跑全量），并保持与 CI 步骤顺序一致。

## 4. 可测性拆分设计（硬约束，实现阶段不得重新耦合）

| 单元 | 性质 | 怎么测 | 覆盖的验收项 |
|---|---|---|---|
| `perfGateDecision(env)` | **纯函数**，无副作用、不读全局 | 直接传 env 对象遍历真值表 | A1 |
| `scripts/run-perf-gate.mjs` | **副作用层**（spawn / env / 退出码），不含决策逻辑与测量 | 用 `child_process` 注入 `NODE_V8_COVERAGE` 验证拒绝路径（A2）；正常路径由 A3 端到端验证 | A2 / A3 |
| `test/terminal-model-perf.test.mjs` | 消费门禁 + 执行测量与断言 | 跳过路径由 A4 验证（默认套件汇总里出现 skipped 与 reason）；测量路径由 A3 验证（真实数值行 + 3 passed） | A3 / A4 |
| CI 接线与脚本契约 | 静态 | 读 `ci.yml` / `package.json` 断言关键行（A5） | A5 |

边界声明：**决策（纯）↔ 执行（副作用）↔ 测量（断言）三层不得合并**；不允许把 `perfGateDecision` 内联回测试文件，也不允许把阈值下移到 helper。

## 5. 验收矩阵

### 自动化验证

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | 门禁真值表 | 自动化（unit，新文件 `test/perf-gate.test.mjs`） | `node --test test/perf-gate.test.mjs` | §3.1 域的 **8 种组合**全部覆盖，`{run, reason}` 与表逐行一致（`reason` 只断言关键子串，不锁全文） |
| A2 | 插桩下拒绝执行 | 自动化（unit/integration，同文件内 `child_process`） | 以 `NODE_V8_COVERAGE=/tmp/x` 跑 `node scripts/run-perf-gate.mjs` | 退出码 ≠ 0，stderr 含明确拒绝说明，且**没有**执行测量 |
| A3 | 权威入口真实测量 | 自动化（integration） | `npm run test:perf` | 退出码 0；输出含 `burst:` 与 `paced:` 数值行；`pass 3 / fail 0 / skipped 0` |
| A4 | 默认套件不再测量性能 | 自动化（static + 行为） | `npm test` 与 `npm run test:coverage` 各跑一次 + `rg "perfGateDecision" test/terminal-model-perf.test.mjs` | 3 个 perf 用例出现在 skipped 列表且 reason 指向 `npm run test:perf`（reason 可见性已实测：Node 24 spec reporter 与 Node 22 TAP 均显示 `# SKIP <reason>`）；**不对 skipped 总数做硬断言**（套件将来新增其它 skip 属正常）；无 perf 断言失败；grep 命中 |
| A5 | CI 接线与脚本契约 | 自动化（static） | 读 `.github/workflows/ci.yml` + `package.json` | perf step 存在且位于 Unit tests 之前；`test`/`test:coverage` 两行为原值（glob 未改）；`test:perf` 指向入口脚本 |
| A6 | 覆盖率阈值仍过 | 自动化（build） | `npm run test:coverage` | 退出码 0；All files：Lines ≥ 85、Functions ≥ 80、Branches ≥ 70；R3 在 HEAD `794c755` 实测基线 92.46 / 91.41 / 80.07（Lines / Functions / Branches），排除 perf 文件后 941 pass / 0 fail |
| A7 | 并行套件稳定性不倒退 | 自动化（多次运行） | `npm test` 连续 3 轮 | 3 轮全绿；记录每轮 `pass/fail/skipped` 计数。若出现失败，只允许落在既有 flake 台账（#95 家族、#122 引入的 A5 mid-stream 断言）内且逐条对账——凡涉及本改动触及文件（perf-gate / run-perf-gate / terminal-model-perf / package.json / ci.yml）的失败即不通过 |
| A8 | 文档与脚本契约一致 | 自动化（static） | 读 `README.md` / `VERIFY.md` / `package.json` | README 的 `npm run verify` 说明行与 VERIFY.md §0 静态检查块均含 `npm run test:perf` 及「性能断言默认跳过、需专用入口」说明；`package.json` 的 `verify` 含 `test:perf` 且顺序在 `test` / `test:coverage` 之前 |

### 用户实测 / 合并后观测

| ID | 功能点 | 验收方式 | 步骤与观察 | 通过标准 |
|---|---|---|---|---|
| U1 | 合并后 main 连续绿 | 用户实测（合并后 CI 观测） | `gh run list --branch main --limit 5`；对绿 run 执行 `gh run view <id> --log \| grep -E "burst:\|paced:"` | main 连续 ≥2 次绿，且 perf step 日志中能看到真实 `burst:` / `paced:` 数值行（证明门禁在跑而非 skip）。**前置条件：A5 mid-stream 断言缺陷（#122 引入的独立 issue，见 research/03 §四）也必须已合入——否则红与本 issue 无关，会误判验收失败。** |
| U2 | 基线证据收集与判定 | 用户实测（合并后证据汇总） | 收集 perf step 连续 5 次运行的 `paced p99` 值，写入本 issue | 5 次全部通过 → 维持现阈值并记录分布；若仍抖动 → 按 D4 用证据重设界（或按 D3 升级为独立 job） |

## 6. 非目标

- **不改阈值数值**（除非 U2/D4 触发，且必须附证据）。
- **不碰 #95 范围**：真实进程用例的墙钟预算、并行套件串行化、A10 恢复链验证方式，均不在本 spec。
- **不新增依赖**、不改生产代码（`src/`、`runner/`）。
- **不新增 CI job、不改分支保护配置**（首轮；升级路径见 D3）。
- **不引入 `--test-skip-pattern`**（理由见 D1 对照表第 4 行）。
- 已知取舍（记录、不视为缺陷）：ring overflow 用例无延迟断言，但同文件跳过 → 默认套件里它也不再跑；其行为由 `test/terminal-model.test.mjs` 与 `test/terminal-snapshot.test.mjs` 覆盖，A6 的实测证明本模块覆盖率不降。
- 已知取舍（记录）：`scripts/run-perf-gate.mjs` 会随 `package.json` 的 `files` 字段发布到 npm（`scripts/` 目录已有 `patch-vulns.mjs` / `release_helper.mjs` 的先例）；它只被 `npm run test:perf` 调用，不影响扩展运行时。

## 7. 风险与回退

| 风险 | 缓解 |
|---|---|
| opt-in 门禁被遗忘（有人删掉 CI step） | skip reason 写明入口；README/VERIFY.md 记录；A5 静态断言把接线钉在 `ci.yml` |
| 覆盖率口径变化 | 已实测（§1.5 附带事实 + A6 基线），余量 ≥7 点 |
| CI 上 perf step 仍抖动 | 两级升级路径（D3）：先证据重设界，再独立 job + 必需检查 |
| 本地 `npm run verify` 变重（+~7s）且机器繁忙时 perf 门禁可能 flake | R3 无插桩实测 2.07–2.66ms（≥3× 余量）；真撞上按 D4 处理，不静默放宽 |
| 与 #95 改同一 `ci.yml` 区域 | 两 issue 均已写明**串行合入**；本改动把冲突面压到「新增一个 step」 |
| U1 被 A5 断言红挟持 | A5（`test/terminal-snapshot.integration.test.mjs:179`，测试断言过严）已认定为独立缺陷；其修复**必须同期合入**才能观测到「main 连续绿」，否则 U1 会误判。本 issue 自身的绿的判据是「perf step 通过 + Coverage 步骤不再判定性能断言」 |
| Windows 兼容 | 入口用脚本设环境变量，不写内联 env；不新增依赖 |

**回退**：本改动只涉及测试文件、新脚本、`package.json` 脚本、`ci.yml` 与文档，无数据迁移、无生产行为变化 → 回退 = revert 单个 PR。

## 8. 文档更新

- `README.md`：`npm run verify` 说明行补上 perf 门禁（现文仅写 typecheck/tests/coverage/pack）。
- `VERIFY.md` §0「Static checks」：补 `npm run test:perf`（并说明「性能断言默认跳过，需专用入口」）。
- 本 issue 评论：U2 的基线分布与最终判定。

## 9. 迁移顺序（step 6 的 plan 将据此拆 task）

1. `perf-gate.mjs` 纯函数 + 真值表单测（A1）
2. `scripts/run-perf-gate.mjs` 入口脚本 + 拒绝路径测试（A2）
3. `test/terminal-model-perf.test.mjs` 接门禁、skip reason（A4 前半）
4. `package.json` 脚本与 `verify`（A3/A5 前半）
5. `ci.yml` 新增 perf step，置于 Unit tests 之前（A5 后半）
6. 文档（README / VERIFY.md）→ A8
7. 验收扫尾：A3 / A4 / A6 / A7 / A8 逐条执行并记录；提交 spec/plan 之外的证据到 issue
