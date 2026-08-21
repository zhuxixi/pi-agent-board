# Spec: Launch 对话框 cwd 常用目录榜（频率排名 + 模糊补全）

- Date: 2026-08-22
- Status: draft（待 review）

## Background

Ctrl+N 打开 launch 对话框后，`cwd` 字段进入目录选择器，目前只能从 `~` 开始逐层
浏览 + 输入过滤（`src/core/launch-options.mjs` 的 `listDirectorySuggestions`，
`src/ui/dashboard.ts` 的 launch picker）。launch-prefs.json 只记忆上一次的 cwd，
没有「常用目录」概念。

本机现状（2026-08-22 实测）：agent-board 共 177 个 view，cwd 分布高度集中——
`/home/elling` 107 次、`zima-blue-cli` 20、`jfox` 17、`.pi/agent/extensions` 10、
`pi-agent-board` 10，其余个位数。用户每次起 session 都要手动浏览目录，重复劳动。

用户需求：按**真实使用频率自动排名**的候选目录榜，用得越多排越前；纯键盘快速
选择；并且输入时能做**路径补全**（输入 `jfox` → 出现完整路径 → tab/回车补全），
类似 zsh 的 cd 补全体验。

## Goals

1. 持久化的 cwd 使用统计：每次成功发起 session 时对 cwd 计数 +1；统计独立于
   session 生命周期（删 view 不减计数）。
2. 首次使用时从现有 view 的 meta.json 一次性导入计数，立即有榜单数据。
3. cwd 选择器交互升级：
   - 打开选择器（未输入）时显示频率榜 Top 8，↑↓ 选 + 回车直接确认；
   - 输入时先对候选榜做大小写不敏感子串匹配（路径任意部分）；
   - 有匹配 → 候选模式显示匹配项；无匹配 → 回落现有文件系统浏览（旧能力完整保留）；
   - tab 把高亮项的完整路径补全进输入框（picker 保持打开，可继续微调），
     回车最终确认；输入框内容本身就是有效路径时回车直接生效。
4. 候选行显示 `~` 简写路径 + 使用次数（如 `107×`）。

## Non-goals

- 不做手动收藏/置顶编辑（无配置文件 UI）。
- 不做模糊 subsequence 匹配（先做子串，不够再升级）。
- 不改 launch-prefs.json 结构。
- 不改 launch 对话框的其他字段（model/thinking/action）。

## Design

### 新模块：`src/core/cwd-stats.mjs`

- 新文件 `~/.pi/agent/agent-board/cwd-stats.json`（root 由现有
  `paths.mjs` 的 `defaultRoot()` 派生，尊重 `$AGENT_BOARD_ROOT`）：

```json
{
  "version": 1,
  "entries": {
    "/home/elling": { "count": 107, "lastUsed": 1756332000000 }
  }
}
```

- `paths.mjs` 增加 `cwdStatsPath(root)`，风格与 `launchPrefsPath` 一致。
- 函数：
  - `readCwdStats(root)`：缺失/损坏 → 返回空 entries（沿用 store.mjs 的容错读风格）。
  - `seedCwdStatsFromViews(root)`：仅当 cwd-stats.json 不存在时执行；遍历
    roster 全部 view 的 meta.json，按 cwd 聚合计数，lastUsed 取该 cwd 下 view 的
    updatedAt 最大值（缺失则用当前时间）；原子写（`atomicWriteJson`）。
  - `recordCwdLaunch(root, cwd)`：count +1、lastUsed 更新，原子写；cwd 非法
    （空/不存在）直接忽略。
  - `rankedCwdCandidates(root, limit)`：count 降序、lastUsed 降序；末尾始终补
    home 目录兜底（若不在榜内则 count 0 排最后），保证「用户根目录」永远可一键选。
- 写入用 `src/core/atomic.mjs` 的 `atomicWriteJson`（temp + rename，防并发写坏），
  与 board 现有 meta.json 写入同款。

### 埋点

- `src/ui/dashboard.ts` 的 `submitDispatch`：`res.ok` 分支内
  `recordCwdLaunch(root, launchCwd)`，try/catch 尽力而为，失败不影响派发。
- lazy seed：launch 对话框首次打开（`openLaunchDialog`）时若 cwd-stats.json
  不存在则调用 `seedCwdStatsFromViews`（同步、一次性、容错）。

### 选择器交互

`LaunchState` 增加字段：
- `cwdRanked: string[]`：打开 picker 时由 `rankedCwdCandidates(root, 8)` 生成；
- `cwdPickerMode: "favorites" | "browse"`：候选模式 / 文件系统浏览模式。

行为规则（`openLaunchPicker("cwd")` 与 `handleLaunchPickerKey`）：

| 输入（cwdQuery） | 模式 | 建议列表 |
| --- | --- | --- |
| 空 | favorites | 频率榜 Top 8，首项高亮 |
| 非空，候选榜有子串匹配（大小写不敏感、路径任意部分） | favorites | 匹配项（保持排名序） |
| 非空，无匹配 | browse | 现有 `listDirectorySuggestions` 文件系统浏览 |

- 打开 picker 时 cwdQuery 置空（不再 seed 成 `~`）；在 launch 主对话框 cwd 字段上
  直接打字进入 picker 时，query = 已输入字符（现有 type-to-jump 行为保留）。
  输入 `~` 等无候选匹配时自然进入 browse 模式，旧浏览能力保留。
- tab（favorites 模式）：`cwdQuery = 高亮项完整路径`，picker 保持打开；
  此时输入框即完整路径，回车经现有 `resolveDirectoryValue` 直接生效。
- 回车（favorites 模式）：选中高亮项。
- esc：关闭 picker（现有行为）。
- ↑↓：移动高亮（现有逻辑复用）。

### 渲染

- favorites 模式候选行：`displayPath(value)`（`~` 简写）+ 右侧 dim 次数
  （`{count}×`）；browse 模式渲染不变。
- 底部提示区分文案：
  - favorites：`常用目录 · type to search · tab complete · enter choose · esc back`
  - browse：现有 `type to filter folders · enter choose · esc back`

## Error handling

- 统计读写全部容错：损坏的 cwd-stats.json 视为空表，永不抛到 UI。
- seed 与 record 的失败静默忽略（console 调试输出可选）。
- 榜单为空（无 stats、无 home）时 picker 直接进入 browse 模式，行为与现状一致。

## Testing

- `test/cwd-stats.test.mjs`（新）：seed 从 views 导入、record 累加与 lastUsed、
  排序（count 优先、lastUsed tie-break）、损坏文件容错、home 兜底、空表行为。
- 候选匹配逻辑（新函数，放 launch-options.mjs 或 cwd-stats.mjs）：大小写不敏感、
  路径任意部分匹配、无匹配判定。
- `test/dashboard-render.test.mjs` 按现有模式补断言：favorites 模式渲染行
  （路径 + 次数）、browse 模式渲染不变。
- 所有测试用 tmp dir 作 root（沿 paths.mjs「显式 root 可测」约定）。

## Verification

- 启动后打开 launch 对话框 cwd 选择器：Top 榜应为 `~`（107×）、zima-blue-cli 等，
  与现有 view 统计一致。
- 输入 `jfox`：`~/git-repo/github/jfox` 出现在榜中；tab 补全完整路径；回车发起
  session；再次打开选择器 jfox 计数 +1。
- 输入 `~`：回落文件系统浏览，旧行为不变。
- 删除某 view 后计数不变（stats 独立于 view 生命周期）。
