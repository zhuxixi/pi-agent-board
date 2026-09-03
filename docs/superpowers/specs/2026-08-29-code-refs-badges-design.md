# Spec: 行内展示 session 关联的 issue / PR 编号（code-refs）

- Issue: https://github.com/zhuxixi/pi-agent-board/issues/40
- 日期：2026-08-29
- 状态：待用户确认

## 1. 背景与目标

Dashboard 每行（一个后台 pi session）目前只有 name + summary + age，看不到「这行在处理哪个 issue、它提交了哪个 PR」。本特性在行内徽章区展示这两个编号，peek 视图给完整信息。

**平台无关是硬约束**：GitHub、GitLab、公司内网代码平台都有 issue/PR（MR）概念但 CLI 与 URL 不同。平台差异全部做成正则规则数据，提取引擎保持通用。

### 目标（Goals）

1. 行内徽章显示最近一个 issue 编号 + 最近一个 PR 编号（如 `#40 ▸#45`），前缀随平台规则（GitLab MR 用 `!`）。
2. peek 视图显示完整引用列表（编号 + 置信度 + 平台链接）。
3. 平台规则可由用户配置扩展（内网平台 = 加一段 JSON，引擎零改动）。
4. 纯本地提取，零网络调用；实时性 = 事件驱动（session 跑到相关命令时徽章即出现）。

### 非目标（Non-goals）

- 不做网络补全（`gh pr list --head` 查分支对应 PR、抓取 issue/PR 标题与状态）——列为 v2 候选，本期不做。
- 不做 PR 状态着色（open/merged）、不做 `refs:has` 过滤器——v2 候选。
- 不修 `outputPreview` 的 `[object Object]` bug——拆独立 issue #41。
- 不识别「无编号」的平台对象（如纯分支名）。

## 2. 决策表（已与用户对齐）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 评分规则 | 信号分四级（认领/worktree 命名/PR 回链 = 最强；动作 = 强；查看 = 中；裸引用 = 弱兜底），平局时最近的最强信号赢 |
| D2 | 多候选显示 | 行内只显示最近一个 issue + 一个 PR；完整列表进 peek |
| D3 | 用户规则与内置同名 provider 冲突 | 按规则追加（用户规则优先匹配，其后是内置规则） |
| D4 | outputPreview bug | 拆独立 issue #41，本特性不含 |
| D5 | 隔离测试 | `PI_CODING_AGENT_DIR` + `AGENT_BOARD_ROOT` 双变量隔离，不动 `~/.pi`；软链开发方式不用 |

## 3. 架构

复刻仓库既有「artifact → summarize → 合并进 Row → renderRow 徽章」模式（evidence/diagnostics/followUps/steering 同构）。新增一个纯函数引擎模块、一个 per-view artifact、五处写入钩子、两处渲染改动。

```
事件流 → reduceEvidence → evidence.json ──┐
                                          ├─→ extractCodeRefs() → github.json → Row.github → 徽章/peek
providers.json（用户规则）+ 内置规则 ──────┘        ▲
repo.mjs remoteHost()（带缓存）───────────────────┘
```

### 组件契约

**C1 `src/core/code-refs.mjs`（新，纯函数，零 I/O，主测试对象）**

- `extractCodeRefs(input, providerSet) → CodeRefsResult`
  - `input`: `{ commands: EvidenceCommand[], assistantTexts: string[], worktreePath: string|null, branch: string|null }`
  - `providerSet`: 解析后的规则包列表（已按 host 选好 + 用户规则已合并）
  - 输出: `{ issue: {number, confidence, source} | null, pr: {number, confidence, source} | null, repoUrl: string|null }`
- `loadProviders(builtIns, userConfig) → provider 列表`（实现 D3 追加语义：同名 provider 时用户规则排在内置规则前面）
- `matchProvider(providers, remoteHost) → provider | null`（host 匹配；无匹配返回 null，调用方走兜底规则）
- 信号强度枚举：`claim > action > view > mention`，每级带置信度 high/medium/low。

**C2 信号来源与评分规则（D1 落地）**

| 强度 | 信号 | 检测方式 |
|---|---|---|
| claim（最强） | 认领命令：provider 规则里 `strength: "claim"` 的命令模式（GitHub 内置：`gh issue edit N --add-assignee`） | commands 正则 |
| claim | worktree 命名：`issue-<N>-<slug>`（issue-driven 工作流强制规范） | worktreePath / branch 结构化解析（非正则配置，引擎内置） |
| claim | PR 回链（按证据上下文拆分，issue #65）：`gh pr create` body 中的 `Closes #N` / `fixes issue #N` / 兼容裸 `issue #N`；后续 assistant 文本仅认 canonical `Closes/Fixes/Resolves #N`（带单词边界与 7 位编号边界）；仅在恰好一个 PR create 命令时扫描 assistant，后续 command 不参与回链 | create 命令自身 + assistantTexts |
| action（强） | `issue comment/edit/close N`、`pr checkout/view/merge N`、`pr create`（编号从 outputUrl 或后续 URL 反查，见 D4 限制） | commands 正则 |
| view（中） | `issue view N` / `pr view N` | commands 正则，要求频次 ≥2，取最近一次 |
| mention（弱，兜底） | 裸 `#N` | assistantTexts，要求频次显著最高（≥3 且 ≥ 第二名的 2 倍） |

平局：命令序列中位置最靠后的最高强度信号赢（commands 有序，按数组下标比较，不用时间戳）。置信度：claim/action → high；view → medium；mention → low。渲染时 low 用 dim 色（宁可不显示也不错显示——mention 级仅在无任何更强信号时出现）。

**C3 `providers.json` 规则 schema（用户配置）**

- 位置：`$AGENT_BOARD_ROOT/providers.json`（随 store root 隔离，E2E 天然不污染真实配置）。
- 结构：`{ providers: [{ name, hosts[], issuePrefix, prPrefix, urlTemplates: { issue, pr }, rules[] }] }`；每条 rule = `{ pattern, kind: "issue"|"pr", strength: "claim"|"action"|"view", numberFrom?: "capture"|"outputUrl" }`。urlTemplates 用占位符拼链接，如 `"https://{host}/{owner}/{repo}/-/issues/{number}"`（owner/repo 从 remote URL 解析）。
- 内置默认：GitHub + GitLab 两份（含 hosts、URL 正则、CLI 正则、前后缀、链接模板）。
- 加载失败（JSON 语法错 / 单条正则非法）：跳过该条并记 diagnostics（`code_refs_config` 码），不炸 dashboard。

**C4 `repo.mjs` 增补**

- `gitRemoteHost(repoRoot) → string|null`：`git remote get-url origin` 解析 host，支持 ssh（`git@host:path`）与 https 两种形式；结果按 repoRoot 缓存在模块级 Map（一个仓库只查一次，失败也缓存 null）。

**C5 artifact `github.json`（per-view）**

- `paths.mjs` 加 `codeRefsPath(root, viewId)` → `views/<id>/github.json`。
- 内容：`{ version: 1, viewId, updatedAt, provider: string|null, issue: {...}|null, pr: {...}|null, allRefs: [...]（peek 用，最多 10 条） }`。
- 读写走 `atomicWriteJson`（并发写者多，KB 已有教训）。
- `readViewArtifactSummaries` 增加 `codeRefs:` 汇总；`Row`/`RowView` 加 `codeRefs` 字段。

**C6 写入钩子（5 处，`writeEvidence` 的全部调用点）**

`runner/job-runner.mjs` ×2（共用 persist()）、`src/runtime/service.mjs` ×2、`runner/state-runner.mjs` ×1。统一收敛为一个 helper：`updateCodeRefsFromEvidence(root, viewId, evidence, meta)`——增量不重算：引擎输入只取 evidence 的 commands + 最近若干条 assistantTexts + meta.worktreePath/branch，纯正则，实测成本微秒级；每次 evidence 写入后顺带调用。失败只记 diagnostics，不影响主流程。

**C7 渲染**

- `rows.mjs` `rowView`：透传 `codeRefs`。
- `dashboard.ts` `renderRow`：statusBadges 追加 `issuePrefix+number`（issue）与 `prPrefix+number`（PR），low 置信度用 `dim` 色；宽度沿用现有「从 name 预算扣」机制。
- peek 视图：新增 "Refs" 段（复刻 Auto-state 段模式）：provider 名、issue/PR 编号 + 置信度 + 由 `urlTemplate` 拼出的终端超链接、allRefs 完整列表。

## 4. 错误处理与降级

- 无 git 仓库 / 无 remote / host 不认识 → 只用「通用 URL 兜底规则」（匹配任意 host 的 `/issues/N`、`/pull/N`、`/-/issues/N`、`/-/merge_requests/N`）+ worktree 命名解析；都没有则不显示徽章。
- 用户 providers.json 损坏 → 内置规则仍生效，diagnostics 记一条 warn。
- 提取过程任何异常 → catch 后记 diagnostics，evidence 主流程不受影响（与既有 artifact 容错一致）。
- 无任何引用 → `github.json` 写空结果（`issue: null, pr: null`），渲染跳过徽章，不留 stale 数据。

## 5. 测试策略（四层，详见 issue 评论）

1. **单元**：`code-refs.mjs` 全分支覆盖——每级信号命中、强度排序、平局规则、mention 兜底阈值、provider 追加合并（D3）、host 匹配、损坏配置容错。
2. **真实数据回测**：脱敏后的真实 evidence.json 命令序列做 fixture（`moc 439` 行的多引用歧义场景是核心用例）。
3. **集成**：fake-pi.mjs 注入含 `gh issue edit 40 --add-assignee` / `gh pr create` 的事件流 → 断言 `github.json` 内容与渲染徽章字符串。
4. **手工 E2E**：`PI_CODING_AGENT_DIR` + `AGENT_BOARD_ROOT` 隔离环境；scratch 仓库换 remote host 验证 provider 匹配；PR 编号用 `echo <url>` 模拟（全程零真实 GitHub 变更）。
5. 验收：`npm run verify` 全绿（typecheck + test + c8 行 85%/分支 70% + pack dry-run）。

## 6. 分阶段

- **v1（本 issue）**：C1–C7 全部（纯本地提取 + 渲染 + 配置）。
- **v2（另开 issue，不在本期）**：网络补全（`pr list --head`、标题/状态）、PR 状态着色、`refs:has` 过滤器、outputPreview 修复后的 `outputUrl` 反查增强（依赖 #41）。

## 7. 实现顺序（供 plan 参考）

1. `repo.mjs` `gitRemoteHost` + 缓存（含单测）
2. `code-refs.mjs` 引擎 + 内置规则 + schema 校验（含单测，覆盖率大头）
3. `github.json` artifact 读写 + `readViewArtifactSummaries` 汇总 + Row/RowView 字段
4. 5 处写入钩子
5. 渲染：徽章 + peek Refs 段
6. 四层测试补齐 + `npm run verify`
