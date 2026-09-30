# Spec：publish.yml 手动恢复后门的 tag 来源修复（issue #154）

日期：2026-09-30 · 状态：**approved（用户确认方案 A，范围 A1–A4 + U1 全量）**
基线：`main @ 444199d`
调研：issue #154 评论「调研：根因三源交叉验证」/ `~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-154/research/root-cause.md`

## 1. 问题陈述

`docs/RELEASE.md:117-118` 记载的恢复路径——「Actions → **Publish to npm** → **Run workflow** → enter the tag」——按字面操作 100% 失败：从 `main` 触发手动恢复时，workflow 在第一个自检步骤退出 1，typecheck / 测试 / 发布全部未执行。

后果是「文档承诺的自救路径是死的」：必须知道文档外的 `--ref <tag>` 绕法才能恢复一次发布，而失败信息（`tag: main`）看起来像发布内容出错，会把操作者引向错误方向。

## 2. 根因（systematic-debugging 结论）

### 2.1 一句话根因

`.github/workflows/publish.yml:57` 把 **ref 名**当成 **本次要发布的 tag** 使用：

```yaml
TAG_VERSION="${GITHUB_REF_NAME#v}"
```

`GITHUB_REF_NAME` 的含义随触发方式变化，而该步骤按 release 事件的形状写死：

| 事件 | ref | `GITHUB_REF_NAME` | `${GITHUB_REF_NAME#v}` | 与 `package.json` 版本比对 |
| --- | --- | --- | --- | --- |
| `release: published` | `refs/tags/v0.9.0` | `v0.9.0` | `0.9.0` | 通过 |
| `workflow_dispatch`（从 main 触发） | `refs/heads/main` | `main` | `main` | **恒失败** |

### 2.2 同文件内的正确范例（决定修复形态）

checkout 步骤（`:32`）用事件感知表达式同时覆盖两种触发——手动触发时真正要发布的 tag 在 `inputs.tag` 里：

```yaml
ref: ${{ github.event.release.tag_name || inputs.tag }}
```

即：同一概念（"当前发布的 tag"）在本文件有两处实现，checkout 处对、自检处错。修复应让二者同源，而不是引入第三种解析机制。

### 2.3 溯源：为什么潜伏了 5 天

- `git log -S 'GITHUB_REF_NAME'` 只命中 `d982724`（#144，2026-09-25）——该自检步骤自引入起**从未被改动**，不是回归而是「引入即存在」。
- #144 的 commit body 明确把手动恢复列为设计目标（"a `workflow_dispatch` input re-runs a tag whose publish failed"），但自检只按 release 事件形状写。
- #144 的 PR body 把 npm 侧 trusted-publisher 配置列为 "Required follow-up (web action, not code)"。该配置滞后 → 09-25 发 0.9.0 时 release 事件发布 404 失败 → 0.9.0 卡在 npm 之外 4 天 → 09-30 配好配置后必须用恢复后门补发 → **首次使用后门，bug 当场暴露**。
- #144 的 comments/reviews 均为 0 条，无 CR 讨论可复用。

### 2.4 复现性（确定性，不依赖时序）

9-30 两次真实 run 构成单变量对照，唯一变量是 dispatch 的 ref：

| 实验 | 触发命令 | 自检步骤结果 |
| --- | --- | --- |
| 失败腿 | `gh workflow run publish.yml -f tag=v0.9.0 --ref main` | `package.json: 0.9.0, tag: main` → exit 1（[run 36726074913](https://github.com/zhuxixi/pi-agent-board/actions/runs/36726074913)） |
| 通过腿 | `gh workflow run publish.yml -f tag=v0.9.0 --ref v0.9.0` | 自检通过，一路 publish 成功（[run 36726192171](https://github.com/zhuxixi/pi-agent-board/actions/runs/36726192171)） |

### 2.5 影响面

- 只影响手动恢复路径；release 事件路径不受影响，故潜伏至今。
- 失败 fail-closed 且发生在最早一步：不会误发布、不污染注册表，代价是一次约 20 秒的无效 run。
- 人因代价是主要危害：文档写的操作失败、文档外的操作可行。

### 2.6 测试覆盖现状（决定可测性边界）

- `test/release-flow.test.mjs` 的 13 个测试全部针对 `scripts/release.mjs`。
- 全仓 grep `publish.yml|GITHUB_REF_NAME`：`test/` 下零命中——**本仓目前没有任何测试触碰 workflow YAML**。

## 3. 方案决策

| 候选 | 做法 | 评价 | 结论 |
| --- | --- | --- | --- |
| **A（采用）** | 自检步骤经 `env:` 接收 `github.event.release.tag_name \|\| inputs.tag`，与 checkout 同源 | 3 行改动；与既有正确写法一致；两种事件都覆盖；不引入新机制 | **采用** |
| B | 改为 `git describe --tags --exact-match`（对已 checkout 的提交取 tag） | 也能对，但引入新失败面（轻量/附注 tag、一提交多 tag），且与 checkout 已解析的 ref 重复表达同一事实 | 否 |
| C | 保留 `GITHUB_REF_NAME`，改为要求操作者必须用 `--ref <tag>` 触发 | 等于把 bug 固化进文档（文档已写 "enter the tag"），恢复路径继续反直觉 | 否 |
| D | 自检改为只校验 `inputs.tag` 存在性、不比对版本 | 削弱护栏（版本错配护栏是 #144 的明确设计目标之一） | 否 |

**改动内容**（`.github/workflows/publish.yml:54-59`）：

```yaml
- name: Check the tag matches package.json
  env:
    RELEASE_TAG: ${{ github.event.release.tag_name || inputs.tag }}
  run: |
    PKG_VERSION=$(node -p "require('./package.json').version")
    TAG_VERSION="${RELEASE_TAG#v}"
    echo "package.json: ${PKG_VERSION}, tag: ${TAG_VERSION}"
    [ "${PKG_VERSION}" = "${TAG_VERSION}" ]
```

用 `env:` 中转而非把 `${{ }}` 直接写进 `run` 脚本，遵循 GitHub Actions 惯例（避免表达式拼接进 shell）。

## 4. 契约与边界

- **不变量**：`publish.yml` 中任何需要「本次要发布的 tag」的位置，都必须从 `github.event.release.tag_name || inputs.tag` 派生，**不得**从 ref 名（`GITHUB_REF_NAME` / `GITHUB_REF`）派生。
- **数据流**：`release.tag_name`（release 事件）或 `inputs.tag`（手动触发）→ `env.RELEASE_TAG` → 去 `v` 前缀 → 与 `package.json.version` 比对。
- **降级**：若未来新增第三种触发方式（如 `push: tags`），该表达式需同步扩展；checkout 与自检必须一起改，二者共用同一表达式是这条降级的唯一保障。
- **非目标**：不改 release 事件路径行为；不改 checkout 表达式；不改 `scripts/release.mjs`；不增加「workflow 是否已重跑成功」类护栏；不引入 workflow 级 lint 基础设施。

## 5. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | 从 main 手动触发恢复不再红 | 自动化验证（automated E2E，真实 dispatch） | `gh workflow run publish.yml -f tag=v0.9.0 --ref main`，随后 `gh run view <id> --log` 取自检步骤输出 | 自检步骤打出 `package.json: 0.9.0, tag: 0.9.0` 并通过；随后命中「already published — skipping」分支；整 run `success`。选 v0.9.0 因为它已在 npm 上，**零重复发布风险**，同时一并验证 skip 路径 |
| A2 | 版本错配护栏仍然有效（负向） | 自动化验证（automated E2E，负向） | `gh workflow run publish.yml -f tag=v0.8.0 --ref main` | 自检步骤 exit 1，日志显示 `package.json: 0.9.0, tag: 0.8.0`，run `failure`（证明护栏没被改成「永远通过」） |
| A3 | `GITHUB_REF_NAME` 不再出现在 publish.yml | 自动化验证（static） | 新增 `test/publish-workflow.test.mjs`：读 `.github/workflows/publish.yml` 文本，断言不含 `GITHUB_REF_NAME`，且含 `github.event.release.tag_name \|\| inputs.tag` 至少两次（checkout + 自检） | `npm test` 通过；该测试在修复前的文件上必须红（先写红再修） |
| A4 | 既有代码不被破坏 | 自动化验证（unit + build + static） | `npm run verify`（typecheck + perf gate + 全量测试 + 覆盖率阈值 + pack dry-run） | 全绿，覆盖率不低于阈值（lines 85 / funcs 80 / branches 70） |
| U1 | release 事件自动路径回归 | 用户实测（下个真实发版自然覆盖） | 发布 0.10.0 时走 `prepare → open-pr → merge → finish`，观察 publish.yml 由 release 事件触发的那次 run | 自检步骤通过（`tag: 0.10.0`），publish 步骤成功。本次修复不改变该路径的输入来源，属回归观察项而非新增验证 |

### 5.1 可测性拆分设计

本改动是 YAML 流程编排，逻辑量近零，可测性设计主要落在「把不变量钉死在可断言的形式上」：

- 修复逻辑本身（表达式替换）无法在本地执行，**其唯一有效验证是真实 dispatch（A1/A2）**——这是本 issue 的核心验收，不设更廉价的替代品，也不因此降级为「用户实测」。
- 唯一可静态化的产物是**不变量 A3**：纯文本断言，无副作用、无外部依赖。做成最小纯函数 `readWorkflowSource()`（读文件）+ 两条字符串断言；副作用（读文件）隔离在单个 helper 内，断言部分保持纯函数式，符合本仓「纯函数 + 薄 I/O 壳」的既有约定（参照 `scripts/release_helper.mjs` 的拆分方式）。
- 该静态测试只断言**否定式不变量**（不含 `GITHUB_REF_NAME`）+ **正向表达式出现次数**，不断言 YAML 结构或步骤名，以避免后续重构过程中的假红。

### 5.2 测试边界

| 边界 | 覆盖 | 不覆盖（明确） |
| --- | --- | --- |
| workflow YAML 文本不变量 | A3（static，新增） | YAML 语法正确性（由 GitHub 解析器在 run 时校验，A1 覆盖） |
| workflow 运行时行为 | A1、A2（真实 dispatch） | release 事件路径（U1，下个真实发版覆盖） |
| 发布脚本逻辑 | A4（既有 13 个 release-flow 测试） | 本次不改 `scripts/release.mjs`，无新增 |

## 6. 风险

- **A1 会消耗一次真实 run**：约 1 分钟、无副作用、不产生发布（版本已在注册表 → skip 分支）。可接受。
- **A2 反向验证依赖 v0.8.0 与 package.json（0.9.0）天然不同**：无需构造假版本，安全。
- **静态测试（A3）的假红风险**：已通过只断言否定式规避。若未来确实需要合法使用 `GITHUB_REF_NAME`，该测试会红并提示重新审视本不变量——这是期望行为，不是缺陷。
