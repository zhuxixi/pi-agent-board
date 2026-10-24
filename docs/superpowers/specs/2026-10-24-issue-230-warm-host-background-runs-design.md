# Spec — issue #230: warm-host sweeper must not evict hosts running a background workflow

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T09:27:39+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T09:33:48+08:00（round 1 复核后修订）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T09:41:14+08:00（round 2 复核后细化修订：R2-D1..D6）

- Repo: `zhuxixi/pi-agent-board`
- Issue: https://github.com/zhuxixi/pi-agent-board/issues/230
- Research: `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-230/research/2026-10-24-root-cause-and-signal.md`（跨 harness 留档，不进仓）
- Status: **design approved**（spec cross-review 两轮收敛，2026-10-24；轮次报告见 issue #230 评论）

---

## 1. 问题与现状

### 1.1 现象（issue 复述，已验证）

后台 workflow（`workflow({background:true})`）的 agent step 若长于 `AGENT_BOARD_WARM_HOST_TTL_MS`（默认 10 min），未 attach 的宿主会被周期 sweeper 在 TTL 或 `MAX_WARM_HOSTS=4` 分支上驱逐；宿主被 revoke → child pi 收 SIGTERM → in-flight agent 落为 `skipped/interrupted` → run 落 `paused`，且**无任何通知**。用户重新 attach + resume 后再被驱逐，形成 evict/re-run 死循环（重复付费）。

### 1.2 根因（代码级，已定位）

| 位置 | 现状 | 问题 |
|---|---|---|
| `src/core/warm-host-sweeper.mjs:23-27` | `isAgentBusy(row)` = `alive && semanticState ∈ {queued,working}` 或有 `pendingQuestions` | 后台 run 不持有 turn：`workflow()` 返回 `started` 后 turn 结束、`semanticState` 回 `idle` → 判定为"空闲" |
| `src/core/warm-host-sweeper.mjs:57-88` | `selectIdleHostsToEvict` 只看 `hostAlive` / `isAgentBusy` / `attachedClients` / `graceMs` / `keepViewId` | 两个淘汰分支（TTL、maxWarm）都会选中带 running run 的 host |
| `src/runtime/service.mjs:915-939` | `pruneWarmHosts` 的复查循环复用 `isAgentBusy` | 同一盲区，且是真正下发 `stopHostRow` 的地方 |
| `src/index.ts:54-70` | 每个非 child 宿主 pi 都跑 60s sweeper；shutdown 时再 `sweepNow()` | 多个 board 进程并发 sweep，放大误杀概率 |

驱逐后归因也丢失：`requestHostStop` 写 `host.json.stopReason="warm_prune"`，但 pty-runner 收尾时用 `stopReason:"revoked"` 覆盖（`runner/pty-runner.mjs:710-724`），事后无法区分。

### 1.3 可用信号（已验证）

pi-dynamic-workflows 的 v2 run head `<workflowHome>/projects/<slug>-<sha12>/runs/<runId>.json`（~1.6 KB）里 `index` 含：

```json
{ "runId": "...", "status": "running|paused|completed|failed|aborted|pending",
  "parentSessionFile": "<绝对路径>", "startedAt": "...", "updatedAt": "..." }
```

`parentSessionFile` 与 board 的 `row.meta.sessionFile` 是同一路径（实测 `…\agent-board\sessions\view_<id>.jsonl`）。`workflowHome` = `PI_CODING_AGENT_DIR ? <agentDir>/workflows : ~/.pi/workflows`。

---

## 2. 目标 / 非目标

**目标**

- G1：带 `status === "running"` 后台 run 的宿主，不被 TTL 分支、也不被 maxWarm 分支驱逐；选择阶段与停止前复查阶段都生效（覆盖所有调用点：60s sweep、`ensureHost`/dispatch 惰性、shutdown `sweepNow`、公开 `service.pruneWarmHosts`）。
- G2：当驱逐**仍然发生**（探针失败 / guard 被关闭 / 复查后竞态）时，board 侧留下可追溯痕迹（探针失败 → `warm_prune_probe_failed`；其余 → 事后 `background_run_interrupted`），不让 run 静默变 paused。
- G3：宿主因**任意原因**消失后，若该会话留下 `paused` run，行上出现可读提示（含 runId 与"可 resume"；写入 `state.summary` + `warn` 诊断），不新增 UI 组件、**不依赖** reconcile 的 `looksActive` 门禁与 `reconcile_finalize` 的 `processState === "alive"` 前置（目标场景两者都不成立，见 D9/D12）。
- G4：探测失败一律 fail-open（退回今天的行为），绝不因为外部文件格式变化而让 warm-host 回收整体失效。

**非目标**

- 不修 pi-dynamic-workflows 的"非 usage_limit 暂停不通知"上游缺口（本 issue 只在 board 侧补痕迹）。
- 不改 TTL / maxWarm / grace / sweep 间隔默认值。
- 不让 coordinator / state 命令层感知 workflow；不新增 ViewState 字段。
- 不为 legacy（< v2）run record 做按会话匹配（它们没有 `parentSessionFile`）。
- 不修 `stopReason` 被 runner 覆盖成 `revoked` 的问题（记录为后续 issue 候选，本 spec 的判定不依赖它）。
- 不提供"自动 resume paused run"能力。

---

## 3. 决策表

| ID | 决策 | 备选（否决理由） | 验收 |
|---|---|---|---|
| D1 | 保护条件 = `status === "running"` **且** `run.updatedAt >= host.startedAt`（`host.startedAt` 缺失时只按 status 保护） | ① 文件新鲜度窗口：长 step 期间不落盘，短窗口复现 bug、长窗口让陈旧记录长期豁免（host 泄漏回归）；② 只看 status：上一次宿主崩溃遗留的 running 记录会永久豁免该行 | A2, A3, A4 |
| D2 | `paused` 不保护（paused 无需 host 即可 resume），仅用于 G3 的提示判定 | 连 paused 一起保护：paused run 可能永不被 resume，host 永久不回收 | A4, A13 |
| D3 | 探测方式：遍历 `<workflowHome>/projects/*/runs/*.json`，按 `parentSessionFile` 全量匹配 | 复刻上游 `projectKey = slug + sha256(cwd)[:12]`：上游改算法即静默失效，且需读 `row.meta.cwd` 之外的隐式约定 | A1, A6 |
| D4 | mtime 预筛 `mtimeMs >= min(候选行 host.startedAt) - 2s`；任一候选行缺失 `startedAt` 时禁用预筛（`minMtimeMs = 0`），因为按时间兜底会丢掉分类规则（`hostStartedAt == null → protecting`）本应保护的 head（预筛与分类不一致的 bug）；预筛只是性能优化，判定仍走 D1 | 无预筛：每次 sweep 全量读 head（可接受但没必要）；用 `updatedAt` 预筛：逻辑重复 | A6 |
| D5 | 纯判定与 IO 分离：`selectIdleHostsToEvict` 接受可选 `isProtected(row)` 谓词（默认不保护，行为与今天一致），service 注入真实探测结果 | 在纯函数里读盘：破坏既有 17 个单测的可测性，且违背仓内 pure-core/IO-shell 约定（AGENTS.md） | A7 |
| D6 | 探测失败（目录缺失 / 坏 JSON / 读错误）→ `ok:false` → 按未保护处理（fail-open）+ `appendDiagnosticOnce(code:"warm_prune_probe_failed", level:"warn")` | fail-closed：一次格式变更就会让 warm host 永不回收 | A10 |
| D7 | 逃生门 `AGENT_BOARD_NO_BACKGROUND_RUN_GUARD=1` 关闭保护（与 `AGENT_BOARD_NO_SWEEP` 同款命名），默认开启 | 无开关：出问题只能回滚版本 | A11 |
| D8 | 复查阶段的新鲜探测若发现 running run：**跳过回收**（不 stop），并留痕 `appendDiagnosticOnce(code:"warm_prune_during_background_run", level:"warn", details:{runId, hostStartedAt}, {match:["runId"]})`（记录“保护拦下一次误杀”） | 只保护不留痕：排障时分不清“没有候选”与“候选被保护挡下”，看不到保护是否生效 | A9 |
| D9 | G3 提示通道：`patch_fields`（source=`service` 的 state 白名单新增 `summary`）+ 同步追加 `warn` 诊断 | ① 直接 `writeState`：违反 `test/architecture-writer-boundary.test.mjs`；② **`reconcile_finalize`**：`state-commands.mjs:502` 在 `currentState.processState !== "alive"` 时 `reject("no_change")`，而目标场景 processState 恒为 `exited`（实测真实 view：`semanticState=idle / processState=exited / host=alive`）→ 不可达；③ 新增 `notice` 字段 + badge：设计面过大；④ 只写诊断不写 summary：issue 要的是行级可见提示 | A12, A15 |
| D12 | G3 的触发与节流：放在 `service.reconcile()` 的**独立 pre-pass**（不受 `looksActive` 约束），只对 `row.host.state ∈ {exited, failed}` 且 `!row.hostAlive` 的行探测；按 `(viewId, host.endedAt)` 记忆，`host.endedAt` 变化才重探；summary 已含提示前缀则跳过写入 | ① 放进 `reconcile` 既有循环内：被 `looksActive` 拦住（R1-G1）；② 放进 sweeper：每个宿主 pi 每 60s 做一次全量行扫描 + 探测，职责外溢且多进程重复；③ 每 tick 无记忆探测：dashboard 的 reconcile 间隔约 700ms，会放大 IO | A12 |
| D10 | 工作流根目录解析：`AGENT_BOARD_WORKFLOW_HOME`（显式覆盖）→ `PI_CODING_AGENT_DIR/workflows`（`~` 展开）→ `~/.pi/workflows` | 只用默认路径：自定义 agent dir 的用户保护失效 | A6, A16 |
| D11 | 纯扫描一次、复查停止前再扫一次（每次 sweep 最多 `#stops + 1` 次扫描；`#stops` 实测 0-2） | 只为省 IO 引入自建缓存/增量：与 D9 相比收益小、失效模式多 | A8, A9 |

---

## 4. 数据流

```
service.pruneWarmHosts(pruneOpts)                                   [src/runtime/service.mjs:915]
 1. dry = selectIdleHostsToEvict(listRows(root), {ttl,maxWarm,grace,keepViewId})   // 纯，无保护
 2. dry 两列表都空 → return                                        // 无 IO，保持今天的快路径
 3. scan = scanBackgroundRuns({ workflowHome, minMtimeMs })        // IO，一次；scan.ok === false → 该轮跳过保护（fail-open，D6），已读 head 仍参与选择，停前 fresh 探测失败时才报 warm_prune_probe_failed
 4. isProtected = (row) => classifyRunsForRow(scan.heads, { sessionFile: row.meta.sessionFile, hostStartedAt: row.host?.startedAt }).state === "protecting"  // 纯
 5. {ttlEvicted, excessEvicted} = selectIdleHostsToEvict(..., {isProtected})         // 纯
 6. for viewId in [...ttl, ...excess]:
      row = loadRow(root, viewId)                                   // 新鲜快照
      re-verify: hostAlive / isAgentBusy / attachedClients / grace  // 既有
      fresh = probeBackgroundRun({ sessionFile, hostStartedAt, workflowHome })   // 复查，IO
      if fresh.running → appendDiagnosticOnce(warm_prune_during_background_run) + continue   // D8
      if !fresh.ok     → appendDiagnosticOnce(warm_prune_probe_failed) → 继续（fail-open）
      stopHostRow(row, "warm_prune")

service.reconcile()                                                 [src/runtime/service.mjs:2269]
 0. 新增 pre-pass（在 looksActive 门禁之前，独立执行）:
      for row of listRows(root):
        if (!row.host || row.hostAlive) continue
        if (row.host.state !== "exited" && row.host.state !== "failed") continue
        key = `${row.meta.id}:${row.host.endedAt ?? 0}`; if (noticeProbeMemo.has(key)) continue
        res = probeBackgroundRun({ sessionFile: row.meta.sessionFile, hostStartedAt: row.host.startedAt, workflowHome })
        if (!res.ok) continue                     // 探针失败不记 memo：下一 tick 重试（D12）
        if (res.paused || (res.running == null && res.paused == null))   // 仅结论明确时记忆（paused 或 running/paused 皆空）
            noticeProbeMemo.add(key)              // host.endedAt 变化才重探
        if (!res.paused) continue                 // running 非空 → 不记 memo，下一 tick 重探（running 可能翻成 paused）
        paused = res.paused
        summary = `Background workflow ${paused.runId} was interrupted — resume it from this session`
        if (!row.state?.summary?.startsWith("Background workflow "))
            sendLifecycleCommand({kind:"patch_fields", source:"service", payload:{state:{summary}}})   // coordinator_disabled → writeState 回退（现有逃生门）
        appendDiagnosticOnce(code:"background_run_interrupted", level:"warn", details:{runId, hostState, exitCode}, {match:["runId"]})
 1..n. 既有循环（looksActive 门禁与 host 消失分支**保持不变**，本 issue 不改其语义）
```

时序要点（复核视角②）：判定所需的 `row.host.startedAt` 与 `row.meta.sessionFile` 都在 `loadRow` 快照里（`src/core/types.mjs:139`）；`run.updatedAt` 在探测时刻从磁盘读；两者都在**触发时刻**可得，无"上一轮值"依赖。

`minMtimeMs` 计算：`Math.min(...candidates.map(r => r.host?.startedAt)) - CLOCK_EPSILON_MS`；任一候选行缺失 `host.startedAt` 时禁用预筛（`minMtimeMs = 0`），`CLOCK_EPSILON_MS = 2000`（FS mtime 粒度容差）。

---

## 5. 组件契约

### 5.1 新模块 `src/core/background-runs.mjs`

模块 = 决策核心 + 一层薄 IO shell（`scanBackgroundRuns`/`probeBackgroundRun`，见下；模块头已相应更新）。

纯函数（无 IO，直接单测）：

| 导出 | 签名 | 语义 |
|---|---|---|
| `resolveWorkflowHome({ env, home })` | `(o?) => string` | 按 D10 解析，`~` 展开；纯（不读 `process.env` 之外的隐式状态，参数可注入） |
| `parseRunHead(raw)` | `(any) => RunHead \| null` | v2（`format === "pi-workflow-run-v2"` → `index`）与 legacy flat（顶层字段，`parentSessionFile` 视作 null）；结构不合法返回 `null`，**不抛** |
| `isSameSessionFile(a, b, { platform })` | `(string, string, o?) => boolean` | 按 `platform`（默认 `process.platform`，**可注入**）选 `path.win32` / `path.posix` 归一；win32 下大小写不敏感。平台注入是必需的：CI 只跑 Linux（`.github/workflows/ci.yml:14`），否则 win32 分支在 CI 零覆盖 |
| `classifyRunForRow(run, { sessionFile, hostStartedAt })` | `=> "protecting" \| "paused" \| "irrelevant"` | D1/D2 |
| `classifyRunsForRow(runs, { sessionFile, hostStartedAt })` | `=> { state, run }` | 遍历 runs，取"最强"结论（protecting > paused > irrelevant）；`run` 为产生结论的 head（`irrelevant` 时为 null） |

`RunHead`（内部结构，非导出契约）：

```js
{ path, mtimeMs, runId, status, parentSessionFile, updatedAtMs, startedAtMs, hasCheckpoint }
```

IO shell（可用 temp dir 直测）：

| 导出 | 签名 | 语义 |
|---|---|---|
| `scanBackgroundRuns({ workflowHome, minMtimeMs })` | `=> { ok, heads, error }` | 遍历 `<home>/projects/*/runs/`，只收 `*.json`（排除 `.bak`、`.events.jsonl`、`.log`、`.result-*`）；`stat.mtimeMs < minMtimeMs` 跳过。`ok === (error === null)`：目录不可读 / runs 目录不可读 / 文件不可读 / 坏 JSON → 记 `error` 并 `ok:false`（已读到的 head 仍返回，仅作诊断）；store 缺失 → `ok:true, heads:[]`。`workflowHome` 先 `stat`：缺失 → 视为无 store（`ok:true`）；存在但不是目录 → `ok:false` |
| `probeBackgroundRun({ sessionFile, hostStartedAt, workflowHome })` | `=> { ok, running: RunHead\|null, paused: RunHead\|null, error }` | 同一份 scan 上**独立**计算 `running` 与 `paused`（同一会话可同时持有一个旧 paused run 与当前 running run）；`paused` 取 `updatedAtMs` 最大者（并列按 `path` 排序）；`ok:false` 仅表示读失败（D6） |

### 5.2 `src/core/warm-host-sweeper.mjs`

```diff
-export function selectIdleHostsToEvict(rows, { now, maxWarm, ttlMs, graceMs = 0, keepViewId = null })
+export function selectIdleHostsToEvict(rows, { now, maxWarm, ttlMs, graceMs = 0, keepViewId = null, isProtected = null })
```

在候选循环中，`isAgentBusy` 之后加：

```js
if (isProtected && isProtected(row)) continue; // 后台 run 保护（issue #230）
```

默认 `null` → 既有 21 个单测（`rg -c '^test\(' test/warm-host-sweeper.test.mjs` = 21）与 `canAutoDrain`/`isAgentBusy` 语义零改动。

### 5.3 `src/runtime/service.mjs`

- `createService(opts)` 新增注入项（测试用，遵循既有 `opts.X ?? default` 约定）：
  - `opts.backgroundRuns`（默认 `{ scanBackgroundRuns, probeBackgroundRun }`）
  - `opts.workflowHome`（默认 `resolveWorkflowHome()`，每次 service 例化时解析一次）
- `pruneWarmHosts`：按 §4 的第 1-6 步重写；新增 env `AGENT_BOARD_NO_BACKGROUND_RUN_GUARD`（D7）。
- `reconcile`：新增 §4 的第 0 步 pre-pass（G3/D12）；既有 `looksActive` 与宿主消失分支不动。
- `src/core/state-commands.mjs:113` `PATCHABLE_FIELDS["service"].state` 增加 `"summary"`（附注释说明用途），并同步更新 `test/state-commands.test.mjs:118` 的白名单断言。这是本 issue 唯一触及协调器契约的改动（见 §8 保证边界 #8）。
- `coordinator_disabled` 回退：pre-pass 的 summary 写入是该逃生门下的**第 4 处** `writeState` 直写（`summaryDirect`）。`test/architecture-writer-boundary.test.mjs:39` 的豁免理由字符串写死了「三处」，需同步改为「四处（host 探测终态 / project 模式 / runner-exited / paused-run summary notice）」，否则豁免说明会漂移，后续 CR 会把第 4 处误判为未登记回归。

### 5.4 诊断契约（对外可观察）

| code | level | 何时 | details | `opts.match` |
|---|---|---|---|---|
| `warm_prune_probe_failed` | warn | 探测失败且发生了候选淘汰（D6） | `{ error }` | `["error"]`（`error` 先归一成字符串） |
| `warm_prune_during_background_run` | warn | 复查发现 running run 仍要停（D8） | `{ runId, hostStartedAt }` | `["runId"]` |
| `background_run_interrupted` | warn | reconcile pre-pass 发现 paused run（D9/D12） | `{ runId, hostState, exitCode }` | `["runId"]` |

`appendDiagnosticOnce` 的去重**不是默认行为**：`src/core/diagnostics.mjs:29-46` 只有显式传 `opts.match`（detail 键数组，值为原始类型）才按 code + 这些键去重；`match: []` 永不 dedupe。三条都必须传 `match`，否则 60s sweep / 700ms reconcile 会刷爆 `diagnostics.jsonl`。

---

## 6. 可测性拆分设计（实现阶段的硬约束）

| 逻辑 | 拆分方式 | 测试边界 |
|---|---|---|
| 记录解析（v2 / legacy / 垃圾） | 纯函数 `parseRunHead` | 表驱动单测，输入 JSON 字符串，零文件系统 |
| 匹配与保护判定 | 纯函数 `classifyRunForRow` / `classifyRunsForRow` | 表驱动单测：sessionFile 匹配、`updatedAt` vs `startedAt`、paused、path 归一 |
| 工作流根目录解析 | 纯函数 `resolveWorkflowHome({env,home})` | 单测注入 `env`/`home`，不碰真实 homedir |
| 目录枚举/预筛/坏文件容错 | IO shell `scanBackgroundRuns` | `mkdtempSync` fixture 造 `projects/*/runs/`，断言 heads 与 `ok` |
| 淘汰纯判定 | `selectIdleHostsToEvict` + 注入谓词 | 既有文件追加用例；fake 谓词，零 IO |
| 端到端淘汰/复查/竞态/逃生门 | service + 注入 `backgroundRuns` + temp `workflowHome` | 复用 `test/warm-host-sweep.integration.test.mjs` 的 net-server 捕获 terminate 模式 |
| reconcile 提示文案 | service + 注入 probe | 断言 `reconcile_finalize` payload / 直写 summary + diagnostics |

禁止在实现阶段把上述纯函数折叠回 service（否则 §8 的 A 项无法保持 unit 级）。

---

## 7. 验收矩阵

自动化命令在仓库根执行。既有基线：`npm run verify`（typecheck + perf gate + `node --test test/*.test.mjs` + c8 门槛 + pack:dry）。

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | v2 head 解析；legacy flat 无 `parentSessionFile`；垃圾输入不抛 | 自动化（unit） | `node --test test/background-runs.test.mjs` | 三类输入返回预期结构 / `null` |
| A2 | running + 同会话 + `updatedAt ≥ host.startedAt` → `protecting` | 自动化（unit） | 同上 | `classifyRunForRow` 返回 `protecting` |
| A3 | 陈旧 running（`updatedAt < host.startedAt`）→ 不保护；`host.startedAt` 缺失 → 保护 | 自动化（unit） | 同上 | 前者 `irrelevant`，后者 `protecting` |
| A4 | `paused` / `completed` / `failed` / `aborted` / `pending` 均不保护；`paused` 被单独分类 | 自动化（unit） | 同上 | 非 `protecting`，`paused` 返回 `paused` |
| A5 | path 归一：win32 大小写/分隔符差异判同；不同文件判异 | 自动化（unit） | 同上 | 断言 `isSameSessionFile` 双向 |
| A6 | 目录枚举：跳过 `.bak`/`.events.jsonl`/`.log`；mtime 预筛生效；坏 JSON 不抛；目录缺失 `ok:true` | 自动化（unit + fs fixture） | 同上 | 断言 heads 数量与 `ok` |
| A7 | `selectIdleHostsToEvict` 尊重 `isProtected`：TTL 与 maxWarm 两分支都跳过；不传谓词时行为与今天一致 | 自动化（unit） | `node --test test/warm-host-sweeper.test.mjs` | 既有用例全绿 + 新用例 |
| A8 | 端到端：running run 的 host 不收 terminate；无 run 的 host 收 terminate | 自动化（integration） | `node --test test/warm-host-sweep.integration.test.mjs` | socket 上只出现后者 |
| A9 | 复查竞态：选择后新出现的 run（注入 probe 首次空、二次命中）→ 不 terminate | 自动化（integration） | 同上 | 无 terminate，且有 `warm_prune_during_background_run` 诊断 |
| A10 | 探测失败 fail-open + 去重 warn 诊断 | 自动化（integration） | 同上 | 仍 terminate；`diagnostics.jsonl` 恰一条 `warm_prune_probe_failed`（连续两次 sweep） |
| A11 | `AGENT_BOARD_NO_BACKGROUND_RUN_GUARD=1` 回到今天行为 | 自动化（integration） | 同上 | 有 running run 也 terminate |
| A12 | reconcile pre-pass：**生产真实态**（`semanticState:"idle"`——**不用 `completed`**：`completed`/`holding` 且 `autoState==null` 命中 `isManualVerdict`（`src/core/auto-state.mjs:202-204`）会被 `manual_fence` 拒；`processState:"exited"`、`currentRunId:null`、`host.state:"exited"`、`hostAlive:false`）+ paused run → 行 summary 被 patch 为含 runId 的提示；连续 reconcile 不重复写。手工判决行（completed/holding + autoState==null）不在本项覆盖范围，按 §8#8 跳过 | 自动化（unit/service） | `node --test test/background-run-notice.test.mjs` | summary 断言（`patch_fields` payload 或 coordinator_disabled 直写）+ 诊断计数 = 1 |
| A15 | 协调器契约：`PATCHABLE_FIELDS["service"].state` 含 `summary`，非白名单字段仍被拒 `field_not_allowed`；服务侧仍无新增 `writeState` import | 自动化（unit + static） | `node --test test/state-commands.test.mjs` + `node --test test/architecture-writer-boundary.test.mjs` | 更新断言后全绿 |
| A16 | `resolveWorkflowHome` 优先级与 `~` 展开：`AGENT_BOARD_WORKFLOW_HOME` > `PI_CODING_AGENT_DIR/workflows` > `~/.pi/workflows` | 自动化（unit） | `node --test test/background-runs.test.mjs` | 三种 env 组合 + `~dir` 注入 home 的断言全绿 |
| A13 | 类型与静态约束（新模块 JSDoc、无新 `writeState` import） | 自动化（static） | `npm run typecheck` + `node --test test/architecture-writer-boundary.test.mjs` | 全绿 |
| A14 | 全仓回归 + 覆盖率门槛 | 自动化 | `npm run verify` | 退出码 0（lines 85 / funcs 80 / branches 70） |
| U1 | 真实长 step（> TTL）运行中宿主不被驱逐 | 用户实测 | 见 §9 U1 | 观察窗内 host `state` 保持 `alive`、run 事件无 `skipped/interrupted` |
| U2 | 驱逐/宿主真死后，行摘要有 paused 提示且 resume 成功 | 用户实测 | 见 §9 U2 | summary 含 runId，resume 后 run 完成 |

失败分支覆盖：A3（陈旧记录）、A4（非 running）、A6（坏 JSON / 目录缺失）、A10（探测失败）、A11（逃生门）均有独立验收项。

---

## 8. 保证边界（明确做不到的事）

1. **依赖他人磁盘格式**：保护依赖 `pi-workflow-run-v2` 的 `index` 字段。上游改格式后保护静默失效（fail-open + 诊断），**不会**崩溃、也**不会**让回收停摆。
2. **竞态窗口仍在**：最后一次复查与 `requestHostStop` 之间（毫秒级）启动的 run 仍会被杀——这类 run 在复查时还不存在，D8 探不到，唯一痕迹是事后 reconcile 的 `background_run_interrupted`（D12/G3）；run 依旧变 paused（需人工 resume）。
3. **保护是"运行期"且无上限的**：受保护 host 完全豁免 TTL 与 maxWarm、不计入 idle 池 → 保护期间 warm 池可随 running 后台 run 的数量**无界增长**（不是"最多 4 个"）。实际约束只有两条：D1 的 `updatedAt ≥ host.startedAt`（防陈旧记录永久豁免）与 run 结束后下一轮 sweep（≤60s）恢复回收。极端情况下（多个长 run 同时挂着）只能靠人工停止宿主。
4. **只有非 child 宿主会执行该逻辑**（`isHostedChild` / `AGENT_BOARD_NO_SWEEP=1` 仍是 no-op），与既有 sweeper 的边界一致。
5. **G3 提示依赖 reconcile 被跑到**：用户不打开 dashboard（无 service 实例跑 reconcile）时，paused 提示不会生成；run 仍在磁盘上可 resume。
6. **不识别 legacy 记录**：v2 之前的 run record 没有 `parentSessionFile`，一律按"无关"处理（不会误保护）。
7. **只看 head 记录**：不解析 `.events.jsonl`，因此不判断"run 是否卡死"；卡死但 status=running 的 run 会持续保护其宿主（与"宁可少回收，不可再杀工作流"的取向一致）。
8. **手工判决的行不写提示**：协调器对非 `dashboard-user` 源在 `isManualVerdict(currentState)` 时 `reject("manual_fence")`（`state-commands.mjs:284`）→ 用户手工 completed/holding 的行拿不到 paused 提示；`warn` 诊断仍会写。
9. **G3 提示由 dashboard 侧驱动**：只有 service 实例（打开 dashboard / footer 状态刷新）会跑 `reconcile()`；不开 dashboard 时提示不写，但 paused run 仍在磁盘上可 resume。

---

## 9. 部署 / 用户实测步骤（U1、U2）

**部署前置（必做，否则验的是旧代码）**：本机 board 扩展从 git 安装的 clone 加载（`~/.pi/agent/settings.json` → `git:github.com/zhuxixi/pi-agent-board`，实际路径 `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board`），**不是**本工作副本。

1. 在 clone 内 `git fetch origin && git checkout <PR 分支>`（合并后 `git pull`）。
2. 重启运行 board 的 pi 进程（dashboard host）与所有 warm host（旧 host 仍跑旧代码）：`/agent-board` 中先逐行 `k`/停止宿主，或等 TTL 回收后再起。
3. 压缩时间线（可选，在启动 pi 前设）：`AGENT_BOARD_WARM_HOST_TTL_MS=60000`、`AGENT_BOARD_SWEEP_INTERVAL_MS=15000`、`AGENT_BOARD_MAX_WARM_HOSTS=1`。

**U1（保护生效）**

1. dispatch 一个新会话，prompt 让它 `workflow({background:true})` 跑一个单个 agent step ≥ 3 min 的 run（与大 diff 的 code review 等价）。
2. 关闭 attach 窗口，等 turn 结束（行 `idle`）。
3. 等待 ≥ 2×TTL（默认 10 min ×2；压缩后 2 min）。
4. 观察：`<root>/views/<id>/host.json` 的 `state` 仍为 `alive`；run 事件无 `skipped/interrupted`；`<workflowHome>/projects/*/runs/<runId>.json` 的 `status` 仍为 `running`。
   通过标准：以上三条同时成立。

**U2（痕迹 + resume）**

1. 重复 U1 步骤 1-2，这次**故意**让驱逐发生：`AGENT_BOARD_NO_BACKGROUND_RUN_GUARD=1` 重启 pi 后跑同样的 run，等待被驱逐。
2. 打开 dashboard：目标行的 summary 应含 `Background workflow <runId> was interrupted — resume it from this session`；证据面板（`!`/diagnostics）应含 `background_run_interrupted`（或驱逐时刻的 `warm_prune_during_background_run`）。
3. attach 该会话并 resume 该 run。
   注：提示由 dashboard 侧的 `reconcile()` pre-pass 写出（每次宿主 `endedAt` 变化探测一次），打开 dashboard 后等一个 tick（<1s）再读行摘要；若仍未变，重开 dashboard 触发新 service 实例。
   通过标准：摘要文案出现且 resume 后 run 跑到 `completed`。

**回滚**：`AGENT_BOARD_NO_BACKGROUND_RUN_GUARD=1`（无需改代码）；或回退版本。

---

## 10. 命名

- 模块：`src/core/background-runs.mjs`（kebab-case，与 `warm-host-sweeper.mjs` 对齐）
- 测试：`test/background-runs.test.mjs`（unit）、`test/background-run-notice.test.mjs`（service 级 reconcile 提示）；淘汰相关用例追加进既有 `test/warm-host-sweeper.test.mjs` / `test/warm-host-sweep.integration.test.mjs`
- env：`AGENT_BOARD_NO_BACKGROUND_RUN_GUARD`、`AGENT_BOARD_WORKFLOW_HOME`
- commit：`fix(host): keep warm hosts alive while a background workflow run is active (issue #230)`
