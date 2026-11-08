# Spec — host 重启不得覆盖会话内 /model 与 /thinking 选择（issue #286）

Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-08T09:30:11+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-08T09:38:00+08:00（R1-D1~D4 四条细化全接受）

调研依据：`research/root-cause-and-pi-restore-semantics.md`（本目录）。本文只写设计与验收，证据细节见调研文件。

## 0. 问题与根因（一句话版）

board 的三条 spawn 路径把 view 创建参数 `meta.defaultModel`/`meta.defaultThinking` 显式拼成 `--model`/`--thinking` 传给子 pi；而 pi 只在**没有**显式 flag 时才从会话恢复模型/thinking（恢复源：branch 上最新 `model_change`，否则最新非虚拟 assistant 消息的物理模型）。进程任何原因重建（warm-host TTL 回收、超额挤掉、崩溃、board 重启、attach 冷启动、后台 job-runner）都会把用户在会话内 `/model`、`/thinking` 的选择悄悄重置回 view 创建时的值。

## 1. 修复设计（方案 A 精化：按「会话可恢复性」决定是否传 flag）

### 1.1 决策表（唯一权威）

对每次 spawn，按会话 JSONL 的 **active branch**（root→leaf 路径，leaf 缺省为文件最后一条 entry）判定：

| active branch 状态 | `--model` | `--thinking` |
| --- | --- | --- |
| 无 message 条目（文件缺失/空/不可解析/仅有非 message 条目） | 传 `meta.defaultModel`（现行为） | 传 `meta.defaultThinking`（现行为） |
| 有 message，且（有 `model_change` 或有 assistant message 条目） | **不传**（pi 从会话恢复） | 见下行 |
| 有 message，但既无 `model_change` 也无 assistant message | 传（pi 恢复不出来，回落 settings 默认会丢 view 意图） | 见下行 |
| 有 message，且有 `thinking_level_change` 条目 | 见上行 | **不传**（pi 从会话恢复） |
| 有 message，但无 `thinking_level_change` 条目 | 见上行 | 传（pi 此时会恢复 settings 默认而非 view 值，传才能保住 view 意图） |

两个维度独立判定（会出现只丢一个 flag 的情况）。

判定依据（pi 1.5.0 `createAgentSession`，源码级核对）：
- 模型恢复门槛 = `!显式model && messages.length>0 && getBranchSelection(branch)≠undefined`；`getBranchSelection` 倒扫 branch：最新 `model_change` 直接胜出，否则最新非虚拟 assistant 消息的物理模型胜出。
- thinking 恢复 = `显式thinking===undefined && messages>0`；但无 `thinking_level_change` 条目时恢复的是 **settings 默认**，不是 view 的 defaultThinking。
- pi 新建会话时无条件写 `model_change` + `thinking_level_change`（记录启动时解析的值）；恢复已有会话时不写 model_change、只在缺 thinking 条目时补写。因此 board 创建的会话「出生即带两个条目」，上表第 2/4 行是常态，第 3/5 行只出现在历史遗留/外部构造的会话上。判定条件镜像 pi 恢复门槛的**正常路径语义**；病态会话（如 `context_edit` 全量擦除投影）不做逐条目精确镜像，差异与方向见 §5。

### 1.2 组件契约

**新增 `src/core/session-entries.mjs`（纯函数，无 I/O）**——从 `session-view.mjs` 抽取的会话结构原语，单一分支语义源：
- `parseSessionEntries(text) -> { header, entries, byId }`：逐行 JSON.parse，坏行/非对象/无 `id` 的行跳过；`type==="session"` 的行提取为 header（不进 entries）。行为与现 `session-view.mjs` 的 parse 循环一致（重构搬运，不改语义）。
- `activeBranchEntries(entries, byId) -> Entry[]`：leaf = `entries[entries.length-1]`，沿 `parentId` 走到根，`seen` 集合防环，返回 root→leaf 顺序。行为与现 `activeBranch` 一致。
- `session-view.mjs` 重构为调用这两个函数（`parseSessionText` 对外签名与返回值不变）。

**新增 `src/core/session-launch-prefs.mjs`（纯函数，无 I/O）**——策略层：
- `resolveLaunchModelPrefs(defaults, text) -> { model, thinkingLevel, droppedModel, droppedThinking }`
  - `defaults = { model: string|null, thinkingLevel: string|null }`（来自 meta）
  - `text`：会话 JSONL 全文；`null`/`""` 视为不可恢复
  - 返回 effective 值：可恢复维度 → `null`（并置 dropped=true），不可恢复 → 原值透传
  - 判定只依赖 1.1 决策表，不读文件、不看时钟

**`src/runtime/service.mjs`（薄 I/O 壳）**：
- 闭包内新增 `resolveViewLaunchPrefs(meta)`：读 `meta.sessionFile`（缺失/读失败 → text=null），调 `resolveLaunchModelPrefs`；若 droppedModel||droppedThinking，`appendDiagnostic(root, meta.id, { source:"service", code:"launch_prefs_from_session", message:"Launch model/thinking left to session restore", details:{ droppedModel, droppedThinking } })`。
- 三处 spawn 点接入（effective 值进 config）：
  1. `launchForView`（RunConfig 的 `model`/`thinkingLevel`，:253-254）
  2. `startHostUnderLease`（HostConfig 的 `model`/`thinkingLevel`，:368-369）
  3. `adoptClaimedHost`（HostConfig，:1445-1446）
- 守卫改造：`validateViewModelMeta(meta)` 改为接收 **effective model**（签名变为 `validateViewModelMeta(effectiveModel)`）：effective 为 `null` → 直接放行（此时不传 flag，子进程不存在 exit-1 死循环风险，且顺带缓解 #90 的「dead defaultModel + 会话可恢复」场景）；非 null → 与今天语义一致（`modelRefAvailable` 判定不变）。`startHostUnderLease` 在 claim 前、`adoptClaimedHost` 在组 config/spawn 前（它接管的是已存在的废弃 claim，没有「claim 前」时点；`service.mjs:1413-1446` 顺序：tryAcquireLock → readHost 复核 → validateViewModelMeta → 组 config → spawn），各自先算 effective 再过守卫；`launchForView` 路径今天无守卫，保持无守卫。
- **runner 零改动**：`pty-runner.mjs`（:525-526/:1366-1367）与 `job-runner.mjs`（:168-169）已是 `if (config.model) push("--model", ...)` 的 falsy 跳过语义，config 值为 null 时自然不拼 flag。

### 1.3 数据流（不变部分省略）

```
attach/reply/dispatch → service spawn 点
  → resolveViewLaunchPrefs(meta)          [读 sessionFile，一次]
  → resolveLaunchModelPrefs(defaults,text)[纯函数，按决策表]
  → effective model 过 #90 守卫（startHost/adopt 路径）
  → config.model / config.thinkingLevel   [null 或原值]
  → runner: config.model 为 falsy → argv 不含 --model
  → 子 pi: 无显式 flag → createAgentSession 走会话恢复分支
```

### 1.4 降级与边界

- 会话文件读取失败（IO 错误/权限）：`text=null` → 两个 flag 照传（完全等于今天的行为，fail-safe 到现状）。
- 半写行（spawn 时理论上无并发写；极端时序下最后一行撕裂）：坏行被 parse 跳过，判定基于完整行；最坏效果是多传一次 flag（=今天行为），不会错丢。
- 大会话文件（数 MB）：冷启动路径上一次性 `readFileSync`+逐行 parse，`session-view` 预览已同样做法，量级可接受；不做流式优化（非目标）。
- pi 恢复失败（会话里的模型已不可用）：pi 自身有 `modelFallbackMessage` + `findInitialModel` 兜底，子进程正常启动，不会 exit-1 循环——这正是丢 flag 比硬传 dead id 更安全的原因。
- 外部 adopt 的会话（`isExternalSession`）：走同一 `startHostUnderLease`，判定同样生效——adopt 后会话自身的模型选择优先于 adopt 时快照，符合本 issue 的意图。
- `piArgsPrefix` 里若被人为配置了 `--model`，本修复不覆盖（该前缀语义是用户级注入，保持原样）——保证边界，见 §5。

## 2. 非目标

- 方案 B（子进程上报 `model_select`/thinking 变更回写 `meta.defaultModel/defaultThinking`，让 dashboard 与后续 launch 反映当前选择）——独立增强，不属本 issue。
- #90 的完整修复（dead defaultModel 且会话**不可**恢复时的 UX 引导）——本修复只让守卫输入变为 effective model，空会话行为不变。
- dashboard 行的 model 展示（`statusFromRow` :880 仍显示 defaultModel）——展示语义随方案 B 一并考虑。
- 大会话文件的流式/增量读取优化。
- `piArgsPrefix` 注入 flag 的清理。

## 3. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A0 | `session-entries` 底座（parse + branch 走查） | 自动化验证（unit） | `node --test test/session-entries.test.mjs`（新文件） | 解析：header（`type==="session"`）提取、无 `id` 行跳过、坏行跳过；走查：root→leaf 顺序、废弃分支条目被排除、`parentId` 断链时止于可达段、环防护生效 |
| A1 | `resolveLaunchModelPrefs` 全分支策略 | 自动化验证（unit） | `node --test test/session-launch-prefs.test.mjs`（新文件，构造 JSONL 文本直接喂纯函数，含分叉树用例） | 1.1 决策表每一行至少一个用例：缺文件代 null/空文本/纯垃圾行→透传；user-only→透传 model；assistant（无 model_change）→丢 model；model_change+message→丢 model；model_change 无 message→透传；thinking 条目+message→丢 thinking；thinking 条目无 message→透传 thinking；混合→两丢；defaults 本身为 null→返回 null 且 dropped 语义正确；分叉树（废弃分支上有 model_change、active 链上没有→透传；active 链上有→丢） |
| A2 | `session-view.mjs` 重构回归（对外行为不变） | 自动化验证（unit） | `node --test test/session-view.test.mjs`（现有用例）+ 新增 2 个用例：header 提取、无 `id` 行跳过（搬运中最易丢的两点语义） | 新旧用例全部通过 |
| A3 | 三条 spawn 路径 config 生效 | 自动化验证（integration） | 扩展 `test/service.test.mjs` / `test/host-resolver.test.mjs` 现有 harness（temp root + `createView` + 写 session fixture + 覆写注入的 `launch`/`launchHost` 捕获 config）：可恢复会话 vs 空/不可恢复会话两组，覆盖 `ensureHost`（→ startHostUnderLease）、adopt 恢复路径、`launchForView`（dispatch 与 json-runner reply 路径） | 可恢复 → 捕获的 config.model/thinkingLevel 为 null 且 diagnostics 有 `launch_prefs_from_session`；不可恢复 → 原值透传且无该 diagnostic |
| A4 | #90 守卫按 effective model 判定 | 自动化验证（integration） | 现有守卫用例（`host-resolver.test.mjs` 两处，fixture 为空会话）必须原样通过；新增用例：dead defaultModel + 可恢复会话 fixture（model_change+assistant）→ `ensureHost` 放行且 config.model=null | 空会话守卫行为与 main 一致；可恢复会话不再被 dead defaultModel 拦截 |
| A5 | runner argv 映射 | 自动化验证（unit） | `test/runner.integration.test.mjs` 的 fake-worker 模式新增断言：config.model=null → 记录的子进程 argv 不含 `--model`/`--thinking`；config 有值 → 含（证明映射方向） | null → argv 无两个 flag；非 null → 有 |
| U1 | 真实冷启动恢复（模型） | 用户实测 | 合并后（部署前置：扩展从本仓 symlink 加载，需 `git pull` 主 checkout 后新起 board）：取一个「最后 `/model`=B、defaultModel=A」的会话，stop host（或等 TTL 回收）→ attach 冷启动 | 子 pi footer 显示 B；会话 JSONL 不新增 model_change；该 view 的 diagnostics 出现 `launch_prefs_from_session` |
| U2 | 真实冷启动恢复（thinking）+ 长期不再回退 | 用户实测 | 同 U1 会话先 `/thinking` 调档再冷启动验证 thinking；之后日常使用数天（跨 warm-host 回收/board 重启）抽查 footer | thinking 保持会话内最后选择；模型数天内不再自动回退到 A（对照 issue 里的 5–24s 重置现象消失） |

自动化验证层级选择说明：A0–A2 是纯函数 → unit；A3/A4 跨 service/文件系统/守卫多组件 → integration（沿用现有 service 级 harness，不起真子进程）；A5 需要真 runner 进程产 argv → 现有 runner 集成测试同层级；完整「真 pi 子进程恢复」依赖真实终端 UI 与真实模型目录，属外部系统 → U1/U2 用户实测（合并后、主 checkout 拉取后可执行，时机与前置已写明），不用假 E2E 冒充。所有自动化验收项（A0–A5）在实现完成时随全量 `npm test`（含 coverage 门，出处 AGENTS.md「Commands」）整体回归一遍，作为重构类改动的总闸。

## 4. 可测性拆分设计（实现阶段的硬约束）

- `parseSessionEntries(text)` / `activeBranchEntries(entries, byId)`：纯函数，`test/session-entries.test.mjs`（新，验收 A0）直测解析/走查/坏行容错/防环；`session-view` 重构的对外行为回归由验收 A2 承接（现有 `test/session-view.test.mjs` + 补 header/无-id 两用例）；分叉树下的策略行为归 A1（经 `resolveLaunchModelPrefs` 端到端喂分叉文本）。
- `resolveLaunchModelPrefs(defaults, text)`：纯函数，A1/A2 的唯一被测对象；不碰 fs/时钟。
- service 闭包 `resolveViewLaunchPrefs(meta)`：唯一 I/O 点（readFileSync + diagnostic）；不经单测直接 mock，而由 A3/A4 integration 用真实临时文件穿过（I/O 壳保持薄到不值得单测）。
- 测试边界：策略正确性全部压在纯函数层；integration 层只验证「config 真的带上了 effective 值」与「守卫真的按 effective 判定」，两层各自独立失败、互不重复。
- 实现不得把策略判定内联进三个 spawn 点（会三处漂移），也不得把 fs 读取塞进 `session-launch-prefs.mjs`（破坏纯函数边界）。

## 5. 保证边界（明说做不到/不保证的）

- 本修复让「重启后与会话内最后选择一致」依赖 **pi 自身的恢复正确性**；pi 恢复行为的正确性是 pi 的契约，本仓只保证「不再用创建参数覆盖它」。
- 虚拟模型的路由语义由 pi 的 `model_change`（含创建时写入的虚拟选择）承载，本仓不解析、不判断虚拟性（布尔判定无需感知虚拟模型，见调研 §2 推论③）。
- 历史 pi 版本创建、无 `model_change`/`thinking_level_change` 条目的会话：按决策表 3/5 行透传 view 默认值，不尝试补写会话。
- 病态会话（`context_edit` 置空 replacement 等全量擦除投影）：pi 侧 `buildSessionContext().messages` 可能为 0（视作新会话），而 board 按原始条目判定可恢复而丢 flag——此时首轮模型取 pi 的回落值（settings 默认），不保证等于 view 默认；接受此角落差异（fail 方向是「一轮模型异常、用户可 `/model` 纠正」，仍优于硬传 dead id）。反向（branch 上只有 custom/summary 类投影条目、board 视为不可恢复而透传 flag）等于今天的行为，fail-safe。
- 若用户在**空会话**（从未有过消息）上重启，行为与今天完全一致（传创建参数）。
- diagnostics 的 `launch_prefs_from_session` 只在冷启动判定时写，不承诺实时反映会话内选择（那是方案 B）。
