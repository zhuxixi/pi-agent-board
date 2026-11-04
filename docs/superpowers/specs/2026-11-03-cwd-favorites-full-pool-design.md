# Spec: cwd 常用目录在全量历史里搜索（issue #262）

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-03T08:21:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-03T08:30:00+08:00

## 1. 问题陈述

cwd picker 的 favorites 候选池在**打开时**就被截断到 8 条（`src/ui/dashboard.ts:755`），后续 `filterCwdCandidates`（`src/core/launch-options.mjs:358`）只在这 8 条上做子串过滤。结果是：`cwd-stats.json` 里已记录、但排名 > 8 的目录，输入其名字片段完全搜不到；过滤为空还会回落 `browse`，browse 以 `launch.cwd` 为基准解析片段，必然找不到，界面只显示 `no matches`，用户误以为项目从未被记录。

排名是「使用强度」排序，不是「用户会去找」的排序；历史越长越容易命中这个窗口。

## 2. 根因（已对真实代码逐行核对）

1. `src/ui/dashboard.ts:755`：`launch.cwdRanked = existingCwdCandidates(rankedCwdCandidates(this.deps.root, 8))` —— 前置截断。
2. `src/core/cwd-stats.mjs:98`：`rankedCwdCandidates(root, limit = 8)` —— 默认值同源，`rows.slice(0, Math.max(1, limit))` 后才追加 home 兜底。
3. `src/core/launch-options.mjs:409`：`nextCwdPickerState` 在传入列表上过滤；无命中即 `browse`（`:413` 之后的 fallback），browse 的 `listDirectorySuggestions`（函数头 `:302`，以 `launch.cwd` 为基准解析在 `:303-305`）解析项目名片段，得到 `[]`。
4. 渲染层 `renderLaunchSuggestions`（`src/ui/dashboard.ts:1685`）本就只画 6 行 + `↓ N more`，候选数组变长不会撑高对话框——**不是**需要截断的原因。

## 3. 方案选择

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| A（选定） | 打开 picker 时加载**全量** ranked 历史；`rankedCwdCandidates` 默认不截断 | 一次性消除「记录存在但搜不到」，渲染层零改动 |
| B | 8 → 20（或任意更大常量） | 只把窗口推后，记录继续增长会复发；且两处常量需同步，易改漏 |
| C | 在 `nextCwdPickerState` 里先过滤再 slice | 状态机拿不到被截掉的条目，等同 B；且会破坏 `↓ N more` 的语义（slice 后总数失真） |

选定 A。`limit` 参数保留（默认 `Number.POSITIVE_INFINITY`），仅供测试或未来明确需要显式封顶的调用方使用；当前唯一生产调用方 dashboard 不传 limit。

## 4. 数据流与契约

```
readCwdStats(root)                      // 全量 entries（已有）
  → rankedCwdCandidates(root)           // 全量排序：count desc → lastUsed desc，末尾补 home（若缺）
  → existingCwdCandidates(...)          // 丢弃已不存在的目录（已有，O(N) statSync）
  → launch.cwdRanked                    // picker 的搜索池
  → nextCwdPickerState(query, pool, cwd) // 纯函数：命中 → favorites；空/无命中 → browse（已有语义）
```

改动点：

- `src/core/cwd-stats.mjs`：`rankedCwdCandidates(root, limit = Number.POSITIVE_INFINITY)`；更新 JSDoc，写明默认不封顶、显式 limit 仅用于调用方需要的封顶。
- `src/ui/dashboard.ts:755`：去掉 `, 8`，改为 `existingCwdCandidates(rankedCwdCandidates(this.deps.root))`。
- 其余（过滤、状态机、browse、渲染）**一行不改**。

行为契约（改后）：

| 输入 | 模式 | 候选 |
| --- | --- | --- |
| 空 query | favorites | 全量 ranked（按 count/lastUsed 排序，home 兜底） |
| 非空 query，历史中任意一条路径含该子串（大小写不敏感） | favorites | 全部命中项，保持排名序 |
| 非空 query，历史中无任何命中 | browse | 与现状一致（以 `launch.cwd` 为基准的文件系统浏览） |
| stats 读取失败 | browse | 与现状一致（`openLaunchPicker` 的 try/catch 置空池） |
| 池中目录全部已删除 | browse | `existingCwdCandidates` 过滤后为空 → 现状 fallback |

## 5. 非目标

- 不修 browse 模式的软链目录枚举缺陷（`src/core/launch-options.mjs:317-318`，`Dirent.isDirectory()` 不跟随软链）——独立 issue 跟踪。
- 不改渲染窗口（6 行）、不改 `↑/↓` 钳制语义、不加 fuzzy 匹配、不引入手动收藏、不改 `cwd-stats.json` 格式与排名规则。
- 不改历史设计文档 `docs/superpowers/specs/2026-08-22-cwd-favorites-design.md` 中的 “Top 8” 记录（历史留档，由本 spec 取代其行为约定）。

## 6. 已知边界与风险

- **O(N) statSync**：打开 picker 时对 N 条历史各做一次 `statSync`（`existingCwdCandidates`）。N = 记录目录数，本机 15、issue 机器 28，量级为微秒到毫秒；perf gate（A11）不覆盖此路径，且打开动作是每 picker 会话一次而非每帧。若未来 N 达到数千，需要另设懒校验/缓存方案，不在本 issue。
- **home 兜底的滚动距离**：home 不在 stats 时仍追加在列表末尾；记录越多，空 query 下按 ↓ 到 home 的距离越长（旧实现固定在 9 位）。home 在真实使用中几乎总是排名第一（本机 187×），故接受；不额外改变排序语义。
- **候选总数上界 = 历史条目数**：无人为 cap，故不存在「再次写死一个数字」的复发点。

## 7. 可测性拆分设计（必答）

保持既有分层，**不新增生产 helper、不在 dashboard 里加逻辑**：

| 单元 | 位置 | 形态 | 测试层级 |
| --- | --- | --- | --- |
| 排名 + home 兜底 | `rankedCwdCandidates`（`src/core/cwd-stats.mjs`） | 读 stats（I/O 壳）+ 纯排序；不碰 fs 目录校验 | unit（临时 root 写 `cwd-stats.json`） |
| stale 目录过滤 | `existingCwdCandidates`（`src/core/launch-options.mjs`） | 纯函数 + `statSync` 谓词 | unit（既有测试覆盖） |
| 子串过滤 | `filterCwdCandidates` | 纯函数 | unit（既有） |
| 模式状态机 | `nextCwdPickerState` | 纯函数 | unit（新增「>8 条列表、命中第 10 条」用例） |
| dashboard 接线 | `openLaunchPicker`（`src/ui/dashboard.ts:749-762`） | 薄 I/O 壳：加载池 → 调状态机 | integration（TS 探针 + `handleInput`，沿用 `test-support/cwd-browse-tab-probe.ts` 模式） |

测试边界：排名/过滤/状态机的语义全部由纯函数单测钉住；「打开 picker 时池子是否被截断」只能由 dashboard 探针钉住（单测对传入列表一视同仁，无法发现调用方的 `, 8`）。渲染层不新增逻辑，故不加渲染断言。

## 8. 验收矩阵（必答）

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | 排名默认返回全量历史 | 自动化验证（unit） | `node --test test/cwd-stats.test.mjs`：临时 root 写 10 条 stats，调 `rankedCwdCandidates(root)`（不传 limit） | 返回 10 条按 count desc / lastUsed desc 排列 + home 兜底；不出现 8 条截断 |
| A2 | picker 能搜到排名 > 8 的已记录目录（issue 主场景） | 自动化验证（integration，探针） | `node --test test/dashboard-cwd-favorites-pool.test.mjs`：临时 root 建 10 个真实目录并写入 stats（目标为第 10 名）；先 `dash.input = "go"`（`openLaunchDialog` 在空 prompt 时直接回 list，`launch` 为 null，见 `dashboard.ts:676-678`、`:750-751`），再 `openLaunchDialog()` → `openLaunchPicker("cwd", "")` → 逐字符 `handleInput("a"/"l"/"e"/"r")` | `cwdPickerMode === "favorites"`，`cwdSuggestions` 含目标路径（修复前为 `browse` + `[]`） |
| A3 | 状态机在超 8 条列表上仍按子串匹配 | 自动化验证（unit） | `node --test test/launch-options.test.mjs`：12 条 ranked，query 命中第 10 条 | `mode === "favorites"`，suggestions 含该条且保持排名序 |
| A4 | 既有行为不回归（空 query、无命中回 browse、stale 过滤、browse/favorites Tab） | 自动化验证（unit + integration） | `node --test test/launch-options.test.mjs test/cwd-stats.test.mjs test/dashboard-cwd-tab.test.mjs` | 全绿；空 query 仍 favorites、无命中仍 browse、Tab 语义不变 |
| A5 | 类型与套件门禁 | 自动化验证（static + build） | `npm run typecheck`、`npm run verify` | 零类型错误；套件、覆盖率、perf gate、pack:dry 全过 |
| A6 | 失败分支：stats 不可读 / 目录全失效 | 自动化验证（unit） | `node --test test/cwd-stats.test.mjs test/launch-options.test.mjs`（既有 corrupt stats 用例 + `existingCwdCandidates` + 空池回 browse） | 读取失败降级为空/仅 home；池为空时仍回落 browse，不抛异常 |
| U1 | 真实 TUI 手感（本机 15 条 stats，目标排名第 11） | 用户实测 | 前置：更新 pi 的 git 安装副本并重启 pi——`git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull --ff-only origin main`，再 `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board log -1 --oneline` 确认含修复 commit（若 pi 有自身更新机制如 `pi install`/update，以它为准）。步骤：重启后 board → `i` 输入 prompt → `Enter` → `cwd` 字段 `Enter` → 输入 `commit` | favorites 模式出现 `~/git-repo/github/pi-commit-lint  1×`（第 11 名）；再输 `github-watching` 出现 `~/workspace/proj/github-watching/pi-agent-board  2×`（第 10 名）；空 query 榜单顺序不变 |

U1 可执行时机：合并 + 安装副本更新后。合并前以 A2 的探针作为等价自动化证据；U1 在合并后由用户执行，未执行前记为 `pending`，不得宣称全部验收完成。

## 9. 文件清单

| 文件 | 改动 |
| --- | --- |
| `src/core/cwd-stats.mjs` | `rankedCwdCandidates` 默认 limit 改为 `Number.POSITIVE_INFINITY`；JSDoc 更新 |
| `src/ui/dashboard.ts` | `openLaunchPicker` 去掉 `, 8`（仅 1 行） |
| `test/cwd-stats.test.mjs` | 新增 A1 全量用例 |
| `test/launch-options.test.mjs` | 新增 A3「>8 条列表命中第 10 条」用例 |
| `test-support/cwd-favorites-pool-probe.ts` | 新增 A2 探针（沿用 #127 探针模式） |
| `test/dashboard-cwd-favorites-pool.test.mjs` | 新增 A2 集成测试 |

命名遵循仓内约定：测试文件 kebab-case，探针放 `test-support/`，commit 用 conventional commits 并在 subject 末尾带 `(#<PR>)`。
