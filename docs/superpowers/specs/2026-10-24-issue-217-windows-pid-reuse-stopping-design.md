# issue #217 — 设计：把「身份不可验证」精确化，消除 Windows pid 复用导致的永久 stopping

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T01:52:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T02:18:00+08:00 · 依据 R1 复核（G1–G2 + D1–D7）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T02:37:00+08:00 · 依据 R2 复核（G1 + D1–D4）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T02:55:00+08:00 · 依据 R3 复核（G1 + D1–D3）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T03:12:00+08:00 · 依据 R4 复核（0 真缺口 + D1–D3，收敛轮）

仓库：zhuxixi/pi-agent-board · issue：#217 · 起草轮次：R0（待交叉复核）

---

## 1. 问题与根因（已复现 / 已核实）

**现象**：Windows（以及任何 `captureStartToken()` 返回 `null` 的平台）上，一条新协议 host 记录在 `stopping` 状态下，若 child pid 已被无关进程复用，attach 永远返回
`recovery_pending: host identity unverifiable`，`diagnostics.jsonl` 零记录，记录永久停在 `stopping`。

**根因链**（行号以当前 `main` @ 20b0323 为准）：

| 环节 | 位置 | 事实 |
|---|---|---|
| 记录侧 token | `runner/pty-runner.mjs:1613` 私有 `captureStartToken` | `platform !== "linux"` → `null`；写入 `runnerIdentity` / `childIdentity` |
| 观测侧 token | `src/runtime/service.mjs:2433` 私有 `readProcStartToken` | 同样 `/proc` only；被 `defaultObserveProcess`（:2511）使用 |
| 判定 | `service.mjs:2511` `defaultObserveProcess` | 活但 token 缺失 → `unknown` |
| 死锁 A | `service.mjs:1018` | `unknown` → `recovery_pending`；但记录已在 `:1002` 调用的 `requestHostStop`（定义 `:947`）被翻成 `stopping` |
| 死锁 B | `service.mjs:1307-1308` | resolver 的 `stopping` 分支遇 `unknown` 直接 `pending` |
| 释放侧 | `service.mjs:980` `hostRoleEnded` | 只接受 `not_started` / `dead` / `foreign`；`unknown` 永不放行 |
| 诊断 | 无 | `recovery_pending` 两条返回路径都不写 `diagnostics.jsonl` |

**不对称性**：`dead` 在 token 比对之前判定，所以「进程已死」的残留行都能自愈；只有「活但无法验证」的复用 pid 会死锁。

**关键调研结论（决定修复落点）**：

1. 运行时**没有**走 `src/core/host-coordination.mjs:49` 的 `processIdentityState`（该函数仅被单测引用）。
   因此只改 `src/core/pid.mjs` 的 `captureStartToken` 或 `processIdentityState` **修不好本 issue**。
2. `observeHostRole`（`service.mjs:961`）绕过了 `processIdentityState` 的 `spawnedAt == null → not_started`
   语义，自己实现了一份平行判定 —— 这是第三份漂移点，本次收敛。
3. #70 的保守契约（unknown 绝不猜测）必须保留；本设计只把 `unknown` **精确化**，
   不新增「无证据也释放」的路径。**显式修订声明**：
   `docs/superpowers/specs/2026-09-05-pty-host-stacking-sock-race-design.md:144-145` 把
   「无稳定 token → unknown → recovery_pending」钉成契约；本设计将其修订为
   「无 token → 探测 → owned/foreign/unknown」，探测不可用（`probe == null`）时仍严格保持原契约。
4. #224 spec 把本 issue 划为「另一层，独立修」；其中「Windows 创建时间修不好 #224」的结论针对
   租约判定（从不比对 token），**不适用于**本 issue。

**本机实况证据**（2026-10-24）：18 条 `stopping`/`alive` 记录中，所有新协议记录的
`runnerIdentity/childIdentity.startToken` 均为 `null`；`runnerSpawnedAt → childSpawnedAt`
间隔 89–118 ms；现存 `view_8eb60f4ff4`（legacy）的 `childPid 3180` 活着，实为
`SOGOUSmartAssistant.exe`（创建于 2026-10-23T01:21:40Z，远晚于记录的 `startedAt`）。

**平台能力验证**（本机 Windows 11）：

```
powershell -NoProfile -NonInteractive -Command
  '$p = Get-CimInstance Win32_Process -Filter "ProcessId=3180" -ErrorAction SilentlyContinue;
   if($p){ [pscustomobject]@{creation=[long]([datetimeoffset]$p.CreationDate).ToUnixTimeMilliseconds(); cmd=$p.CommandLine} | ConvertTo-Json -Compress }'
→ {"creation":1792718500139,"cmd":"\"E:\\...\\SOGOUSmartAssistant.exe\" --panel=auto"}   # ≈ 470 ms
```

一次查询同时拿到**创建时间**与**命令行**，不依赖 `wmic`（Win11 24H2 起移除）或 `Get-Process` 的两次往返。
child 的真实命令行形如 `node.exe <cli.js> --session <sessionFile>`（`runner/pty-runner.mjs:288`）。

## 2. 范围

**做**：

1. 新增 process-identity 探测层（Windows CIM / macOS `ps`），只在 token 缺失且 observation 为 `unknown`
   时调用（Linux 稳态零成本）。
2. 新增纯判定 `classifyUnverifiableProcess`：用**角色专属路径参数的命令行匹配**（child → `sessionFile`，
   runner → `configPath`；确定性信号）判 `owned` / `foreign`，命令行不可读时退回**创建时间 vs `*SpawnedAt`**
   区间比对。
3. `observeHostRole` 异步化 + 探测 memo：`recoverHost` 单次调用内 ≤2 次；resolver stopping 分支用
   自己的局部 memo（2 次）；单次 attach 最坏 4 次（探测只发生在 token 缺失的恢复路径）。
4. `recovery_pending` 落诊断（去重），消除 #112 同款静默。
5. 把**细化层**判定收敛回 `host-coordination.mjs` 纯函数。保证边界：`observeHostRole` 仍保留 I/O 接线与
   基础判定（`identity → observeProcess` / `not_started` / `unknown`），`processIdentityState` 维持现状
   （运行时仍未引用），本次不承诺「判定全部集中到 core」。

**不做**（明确非目标）：

1. `captureStartToken` 四份拷贝收敛、Windows 记录侧 token 实现（#224 spec 已划为共享底座，另立）。
2. 「强制重置 host 记录」UI 行操作 —— 本修复后不再是唯一出路；独立 UI 功能面。
3. `recoverHost` 先翻 `stopping` 再验证的顺序调整 —— 只改变污染面，不改变可达性；不混入本修复。
4. legacy（`instanceId == null`）记录 —— 已由 `canFinalizeLegacyHost` 覆盖，不受本 bug 影响。
5. 命令行之外的佐证（文件句柄 / 会话文件锁）—— 收益不抵复杂度。

## 3. 设计决策

### D1 判定函数：命令行优先，创建时间兜底（纯函数）

`src/core/host-coordination.mjs`：

```js
/**
 * @param {{ spawnedAt: number|null, probe: {creationTimeMs:number|null, commandLine:string|null}|null,
 *           expectedCommandFragment: string|null, toleranceMs: number }} input
 * @returns {"owned"|"foreign"|"unknown"}
 */
export function classifyUnverifiableProcess({ spawnedAt, probe, expectedCommandFragment, toleranceMs }) {
	if (!probe) return "unknown";                       // 探测不可用：保持 #70 保守契约
	if (probe.commandLine && expectedCommandFragment) {
		return commandLineMentions(probe.commandLine, expectedCommandFragment) ? "owned" : "foreign";
	}
	if (spawnedAt == null || probe.creationTimeMs == null) return "unknown";
	return Math.abs(probe.creationTimeMs - spawnedAt) <= toleranceMs ? "owned" : "foreign";
}

/** 路径比较：反斜杠归一 + 大小写不敏感（Windows 语义）；只匹配路径，不要求 `--session` 前缀。 */
export function commandLineMentions(commandLine, fragment) { /* ... */ }
```

**角色不对称（R1-G1）**：runner 与 child 的命令行**不同构**，确定性匹配串必须按角色给：

| 角色 | 确定性匹配串 | 依据 |
|---|---|---|
| child | `meta.sessionFile` | `runner/pty-runner.mjs:955` `[...piArgsPrefix, "--session", config.sessionFile]` |
| runner | host 记录的 `configPath` | `src/core/launch.mjs:83` `node <runnerScript> <configPath>` —— **没有** `--session` |

把 `sessionFile` 统一套到 runner 会把「活着的 owned runner」误判 `foreign`，进而在旧 runner 存活时 claim
新 host（双写 session 文件）。匹配串缺失（如 legacy 记录无 `configPath`）时该角色不走命令行分支，退回创建时间。

**为什么命令行优先**：进程命令行是确定性证据 —— 我们 spawn 的每个角色都带自己的唯一路径参数
（child 带 session 文件，runner 带 instance 专属 config 路径），被复用的 pid 命令行不可能同时命中。
创建时间受系统时钟 step 调整影响（长期存活进程的 `creationTimeMs - spawnedAt` 会漂移），只能做兜底。

**不变量**：

- `probe == null` → `unknown`（探测失败/权限不足），绝不 foreign。
- `expectedCommandFragment` 缺失 → 不进入命令行分支（无法比对），退回创建时间。
- `spawnedAt` 缺失 → 创建时间分支返回 `unknown`。

### D2 探测层：一次查询拿两信号（新模块 `src/core/process-identity-probe.mjs`）

```js
// platform/execFileFn/timeoutMs 均有默认值：默认注入点按单参调用 probeProcessIdentityImpl(pid)，
// 不会对 undefined 解构（R3-G1）。execFileFn 默认取 node:child_process 的异步 execFile（本仓首次引入）。
export async function readProcessIdentityProbe(
	pid,
	{ platform = process.platform, execFileFn = execFile, timeoutMs = PROBE_TIMEOUT_MS, nowMs = Date.now } = {},
) -> {creationTimeMs:number|null, commandLine:string|null} | null
```

| 平台 | 命令 | 解析 |
|---|---|---|
| `win32` | `powershell.exe -NoProfile -NonInteractive -Command <CIM 片段>` | `JSON.parse` → `{creation, cmd}`；`creation` 用 `parseUnixMillis` |
| `darwin` | `ps -p <pid> -o etime=,command=` | 首列 `etime`（`DD-HH:MM:SS` / `HH:MM:SS` / `MM:SS`）→ `now - elapsed`；其余为 command |
| 其他 | 不探测，返回 `null` | Linux 已有 `/proc` token |

约束：

- `execFile` **异步**（不阻塞 dashboard 主线程），`timeout: 3000`，`windowsHide: true`
  （出处：`src/core/launch.mjs:40` 的 `spawnDetached` 注释与 issue #49 —— detached spawn 缺此参数会在
  Win11 25H2 触发 WindowsTerminal 闪现）。
- pid 必须是正整数，否则直接返回 `null`（无注入面）。
- macOS 的 `creationTimeMs = nowMs - elapsedMs`，`nowMs` 可注入（与 `createService` 的 `nowImpl` 惯例一致），
  A5 用固定 `nowMs` 断言确定性（R4-D2）。
- 输出解析失败 / 命令非零退出 / 超时 → `null`。`null` 在判定层是 `unknown`，方向安全。
- 纯函数导出（`parseUnixMillis` / `parsePsElapsedMs` / `parseProbeJson` / `parsePsProbeLine` /
  `resolveProbeCommand`）供单测枚举，I/O 只有 `readProcessIdentityProbe` 一层。

### D3 `observeHostRole`：unknown 时才探测，单次恢复内 memo

`service.mjs`：

```js
// sessionFile 来源：recoverHost 新增可选第三参（默认从 row.meta 读取），不破既有测试的
// svc.recoverHost("v1", "i1") 调用；resolver 调用点把自己已有的 sessionFile 传进去。
async function recoverHost(viewId, expectedInstanceId, sessionFile = loadRow(root, viewId)?.meta.sessionFile ?? null) {
	const probeMemo = new Map();          // 单次 recoverHost 内共享（循环 + final 复检）
	// ...
	const runnerObservation = await observeHostRole(host, "runner", { sessionFile, memo: probeMemo });
	const childObservation = await observeHostRole(host, "child", { sessionFile, memo: probeMemo });
}
// final 复检（对应 :1046）同样必须带第三参，否则 undefined 解构抛 TypeError（R3-D2）：
// const finalRunner = await observeHostRole(finalHost, "runner", { sessionFile, memo: probeMemo });

async function observeHostRole(host, role, { sessionFile, memo }) {
	const identity = host?.[`${role}Identity`] ?? null;
	const pid = identity?.pid ?? host?.[`${role}Pid`] ?? null;
	const spawnedAt = host?.[`${role}SpawnedAt`] ?? null;
	const observation = identity ? observeProcessImpl(identity) : spawnedAt == null ? "not_started" : "unknown";
	if (observation !== "unknown" || pid == null) return observation;

	if (!memo.has(pid)) memo.set(pid, await probeProcessIdentityImpl(pid));
	const expectedCommandFragment = role === "child" ? sessionFile : host?.configPath ?? null;
	return classifyUnverifiableProcess({
		spawnedAt, probe: memo.get(pid), expectedCommandFragment,
		toleranceMs: resolveIdentityCreationToleranceMs(),
	});
}
```

- **memo 必须由调用方显式创建并下传**（R1-D1）：默认参数 `= new Map()` 会在每次调用时新建，
  `recoverHost` 循环（`:1014-1015`）与 final 复检（`:1046`）就各自重探测。
  `HOST_RECOVERY_POLL_MS = 150`、`HOST_RECOVERY_GRACE_MS = 5_000`，最坏 33 轮 × 2 角色 → 无 memo 时
  66 次 × ~470 ms 远超 grace；共享 memo 后 ≤2 次（runner + child 各一次）。
- **resolver stopping 分支的接线（R2-G1）**：该分支（`service.mjs:1304-1305`）不是循环，用自己的局部 memo，
  并把分支内已有的 `sessionFile`（`:1260`）传入，不得依赖未定义的解构：

```js
const probeMemo = new Map();
const runnerObs = await observeHostRole(host, "runner", { sessionFile, memo: probeMemo });
const childObs  = await observeHostRole(host, "child",  { sessionFile, memo: probeMemo });
```
- **probe 为 `null` 时保持 `unknown`，不做 `isAlive` 二次判定**（R1-G2）：`isAlive` 在 `service.mjs:28`
  直接 import、不可注入，加这条分支会让既有「unknown → pending」用例（死占位 pid 4242 / 999999）
  翻成 `dead`，与 A11 自相矛盾。代价仅是一次轮询（≤150 ms）后由 `defaultObserveProcess` 判 `dead`。
- 调用点全部在 async 上下文（`recoverHost` 循环、resolver stopping 分支、finalize 前复检），
  逐一补 `await`。
- `probeProcessIdentityImpl` 新注入点（`opts.probeProcessIdentity`），默认 `readProcessIdentityProbe`。

### D4 诊断：`recovery_pending` 必须留痕且去重

- 新增 `src/core/diagnostics.mjs#appendDiagnosticOnce(root, viewId, patch, { match, limit })`：
  读 tail（默认 20 条），若已有同 `code` 且 `match` 各 `details` 键值相同 → 跳过。
- `recovery_pending` 共 5 个返回面（R1-D3）：`service.mjs:1018`（recoverHost 循环）、`:1047`（recoverHost
  final 复检）、`:1308`（resolver stopping 分支自主判定）、`:1315` 与 `:1383`（转述 `recoverHost` 的
  `recovery_pending`）。**只有产生方**（1018 / 1047 / 1308）写诊断；转述方不重复写（去重也会拦，但不必依赖）。

```js
{ source:"service", level:"warn", code:"host_recovery_pending",
  message:"Host recovery is pending: process identity unverifiable",
  details:{ instanceId, role, observation, probe: probe ? "available" : "unavailable", path: "recover"|"attach" } }
```

- 去重键：`code + details.instanceId + details.role`。同一 instance 的 runner/child 各留一条，反复点击不刷屏。

### D5 常量与测试旋钮

```js
export const HOST_IDENTITY_CREATION_TOLERANCE_MS = 5_000;
export function resolveIdentityCreationToleranceMs(env = process.env) {
	return resolveTestMs(env, "AGENT_BOARD_TEST_IDENTITY_CREATION_TOLERANCE_MS", HOST_IDENTITY_CREATION_TOLERANCE_MS);
}
```

容差取 5 s：覆盖 `spawn → childSpawnedAt 写盘` 的实测 89–118 ms 与常见时钟调整；
命令行分支命中时不依赖该容差。env 旋钮的覆盖行为由 **A15** 验证。

**模块归属（R3-D1）**：`HOST_IDENTITY_CREATION_TOLERANCE_MS` 与 `resolveIdentityCreationToleranceMs`
落在 `src/runtime/service.mjs`（与 `resolveHostStartGraceMs:80` / `resolveHostRecoveryGraceMs:85` /
`resolveHostRecoveryPollMs:90` 并列），**不**放进 `host-coordination.mjs`——该模块文件头明确
「no fs/net/process I/O」，且 `resolveTestMs` 对非法值会写 stderr。A15 在 `test/test-knobs.test.mjs` 覆盖。

## 4. 数据流（修复后）

```
attach 点击
  └─ resolveAttachTargetInner: host.state === "stopping" 且超 grace
       └─ observeHostRole(runner/child)  [async]
            ├─ isAlive=false               → dead   ✓（现状）
            ├─ token 可用且不匹配          → foreign ✓（现状，Linux）
            ├─ token 缺失 → probe(pid)
            │    ├─ 命令行含 sessionFile   → owned  → SIGTERM/SIGKILL（既有升级逻辑）
            │    ├─ 命令行不含 sessionFile → foreign → 不发信号，释放并 claim 新 host
            │    └─ 探测失败              → unknown → pending + 诊断（现状行为 + 留痕）
            └─ observed 都 ended → recoverHost finalize + 新 claim → 下一次 attach 冷启动
```

## 5. 可测性拆分设计

| 单元 | 位置 | 性质 | 测法 |
|---|---|---|---|
| `commandLineMentions` | `host-coordination.mjs` | 纯函数 | 绝对路径 `\`/`/`、大小写、引号包裹、路径前缀陷阱（`session-2.jsonl` 不得匹配 `session.jsonl` 之外的假阳性需专门用例） |
| `classifyUnverifiableProcess` | `host-coordination.mjs` | 纯函数 | 真值表：probe null / 命令行匹配（含 `spawnedAt:null` 时仍 owned）/ 命令行不匹配 / 命令行空 + 时间窗内 / 窗外 / 命令行空且 `spawnedAt:null` → unknown（R4-D3） |
| `parseUnixMillis` / `parseProbeJson` | `process-identity-probe.mjs` | 纯函数 | 正常、空串、非数字、负值、缺字段 |
| `parsePsElapsedMs` / `parsePsProbeLine` | 同上 | 纯函数 | `05:03` / `01:02:03` / `2-01:02:03` / 非法输入；command 含空格 |
| `resolveProbeCommand` | 同上 | 纯函数 | win32 / darwin / linux 返回；pid 非法 → null |
| `readProcessIdentityProbe` | 同上 | I/O 外壳（注入 `execFileFn`） | 成功 stdout、非零退出、超时、空 stdout、`windowsHide` 参数断言 |
| 探测次数上限 | `service.mjs` | 集成（注入计数桩） | 单次 `recoverHost` 内探测桩调用 ≤2 次（memo 共享） |
| `appendDiagnosticOnce` | `diagnostics.mjs` | 文件 I/O（临时目录） | 首写、重复跳过、键不同再写、无 match 时退化为 append |
| `recoverHost` 判定接线 | `service.mjs` | 集成（注入探测桩） | A6/A7/A8 |
| resolver stopping 分支 | `service.mjs` | 集成（注入探测桩） | A9 |

**测试边界**：判定与解析全部在纯函数层可枚举；平台差异被压缩到 `resolveProbeCommand` +
`readProcessIdentityProbe` 两个函数；`service.mjs` 只做「何时调用」的接线，不承载解析逻辑。

**既有测试的确定性**：`test/host-recovery.test.mjs:179`、`test/host-resolver.test.mjs:350` 等
使用 `observeProcess: () => "unknown"` 的用例必须显式注入 `probeProcessIdentity: () => null`，
否则默认探测会查询真实 pid 表（测试 pid 恰好存在时结果依赖宿主机），破坏确定性。
`probeProcessIdentity: () => null` 时 `classifyUnverifiableProcess` 必返回 `unknown`，原断言（pending）成立——
前提是**不**在 `probe == null` 时额外做 `isAlive` 二次判定（见 D3）。

**签名变更清单**：`recoverHost(viewId, expectedInstanceId, sessionFile?)` 增加可选第三参；
既有测试的两参调用保持兼容。

## 6. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | 命令行匹配语义 | 自动化验证（unit） | `node --test test/host-coordination.test.mjs` | 大小写/斜杠/引号/前缀陷阱用例全通过 |
| A2 | 不可验证进程分类真值表 | 自动化验证（unit） | 同上 | probe null → unknown；命令行匹配 → owned；不匹配 → foreign；时间窗边界 ±tolerance |
| A3 | 平台探测命令构造 | 自动化验证（unit） | `node --test test/process-identity-probe.test.mjs` | win32/darwin 命令形态；其他平台 null；非法 pid null |
| A4 | 探测输出解析（Windows / macOS） | 自动化验证（unit） | 同上 | 三种 etime 形态、JSON 形态、非法输入 → null |
| A5 | 探测执行层 | 自动化验证（unit） | 同上（注入 `execFileFn`） | 成功/非零退出/超时/空输出；参数含 `windowsHide: true`、`timeout` |
| A6 | recoverHost：unknown + 命令行不匹配 → 释放重建 | 自动化验证（integration） | `node --test test/host-recovery.test.mjs` | 不发任何信号；claim 新 instance；记录 `starting` |
| A7 | recoverHost：unknown + 命令行匹配 → 发信号重建 | 自动化验证（integration） | 同上 | 恰好一次 SIGTERM 指向该 identity |
| A8 | recoverHost：探测不可用 → 保持 pending（#70 不回归） | 自动化验证（integration） | 同上 | `recovery_pending`，记录仍 `stopping` |
| A9 | resolver stopping 分支：foreign 可推进 | 自动化验证（integration） | `node --test test/host-resolver.test.mjs` | 不再返回 `recovery_pending`，最终 `pty` 或进入恢复 |
| A10 | `recovery_pending` 诊断 + 去重 | 自动化验证（integration） | host-recovery / host-resolver 测试 | JSONL 出现 `host_recovery_pending`；同键第二次点击不新增 |
| A11 | 既有 unknown 用例仍 pending | 自动化验证（integration） | `node --test test/host-recovery.test.mjs test/host-resolver.test.mjs`（用例显式注入 `probeProcessIdentity: () => null` 桩） | 原断言不变 |
| A12 | 类型检查 | 自动化验证（static） | `npm run typecheck` | 0 error |
| A13 | 单次恢复探测次数 ≤2（memo 共享） | 自动化验证（integration） | `node --test test/host-recovery.test.mjs` | 注入计数桩，`recoverHost` 一次调用内 ≤2 次探测 |
| A14 | 相关测试套件 | 自动化验证（integration） | `node --test test/host-recovery.test.mjs test/host-resolver.test.mjs test/host-coordination.test.mjs test/process-identity-probe.test.mjs test/diagnostics.test.mjs` | 全通过 |
| A15 | 容差 env 旋钮（D5） | 自动化验证（unit） | `node --test test/test-knobs.test.mjs` | `resolveIdentityCreationToleranceMs` 已加入 reader 断言；`AGENT_BOARD_TEST_IDENTITY_CREATION_TOLERANCE_MS` 覆盖生效；未设时回退 5000 |
| U1 | Windows 实机：真实 stranded 记录 attach 恢复 | 用户实测 | **前置**：修复 PR 已合并并 `git pull`、重载 Pi/dashboard、确认加载到 `src/core/process-identity-probe.mjs`。**步骤**：手改 `views/<viewId>/host.json` 造 stranded 记录（`state=stopping`、`stopRequestedAt` 早于 recovery grace、`runnerPid` 填已死 pid、`runnerIdentity.startToken=null`、`childPid` 填一个存活的无关进程 pid、`childIdentity.startToken=null`、`childSpawnedAt` 填与该 pid 创建时间相距超过容差的值），点击行 | 进入 attach，host.json 出现新 instance 且 `state` 推进到 `starting`/`alive`；diagnostics 无静默 |
| U2 | Windows 实机：真孤儿 child 被识别为 owned 并回收 | 用户实测 | **前置**：同 U1。**步骤**：启动 host 后 `kill -9` runner（保留 child），点击 attach | child 进程结束，新 host 启动，会话续接 |

U1/U2 需要真实 Windows 交互环境；本机可构造，但 U 级结果以实际执行记录为准，无法执行时标记 `pending`。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 误判 `foreign` → 释放后新 host 与真孤儿同时写 session 文件 | 命令行匹配是确定性证据；只有命令行不可读时才依赖时间窗；探测失败一律 `unknown` |
| 误判 `owned` → 向复用 pid 发信号（杀无辜） | owned 仅在命令行匹配（确定性）或时间窗内成立；时间窗 5 s 远小于实测 pid 复用跨度（天级） |
| 异步化改变 recovery 时序 / 竞态 | memo 把探测压到 ≤2 次；所有调用点已在 async 上下文；`recoverHost` 的 owner 复检逻辑不变 |
| Windows 杀软/组策略禁用 PowerShell | 探测返回 `null` → 维持现状 `unknown` + 诊断，不回归 |
| 测试依赖宿主机 pid 表 | 所有 unknown 用例显式注入探测桩 |

**回滚**：改动集中在 `host-coordination.mjs`、`process-identity-probe.mjs`（新）、`service.mjs`、
`diagnostics.mjs` 与对应测试；`git revert` 单 commit 即恢复原行为。

## 8. 测试命令与已知环境限制

- 本机（Windows）验证：`npm run typecheck` + 上表列出的单测/集成测试文件。
- `npm run verify`（含 perf gate + coverage）在无控制台环境可能因 node-pty 的
  `AttachConsole failed`（已知本地限制，见 JFox permanent `202609051440498495`）出现既有失败；
  CI（Linux）为准。若本机 verify 失败，需区分「本改动引入」与「既有环境失败」并在 PR 中列明。
