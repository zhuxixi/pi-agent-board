# Spec：publish.yml 手动恢复后门的 tag 来源修复（issue #154）

日期：2026-09-30 · 状态：**approved（用户确认方案 A，范围 A1–A4 + U1 全量）· 勘误（同日双审后）：A1 拆分为 A1a/A1b、A2 重写为探针 tag 法、A3 断言加严为计数 ≥2，改动点在各条目内注明**
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

- **不变量**：`publish.yml` 中任何需要「本次要发布的 tag」的位置，都必须从 `github.event.release.tag_name || inputs.tag` 派生，**不得**从 ref 名派生。静态测试钉死 `GITHUB_REF_NAME`（见 A3）；`GITHUB_REF` 在语义上同属错误的派生源，但它存在合法用途（如日志），故不做文本级封禁。
- **数据流**：`release.tag_name`（release 事件）或 `inputs.tag`（手动触发）→ `env.RELEASE_TAG` → 去 `v` 前缀 → 与 `package.json.version` 比对。
- **降级**：若未来新增第三种触发方式（如 `push: tags`），该表达式需同步扩展；checkout 与自检必须一起改，二者共用同一表达式是这条降级的唯一保障。
- **非目标**：不改 release 事件路径行为；不改 checkout 表达式；不改 `scripts/release.mjs`；不增加「workflow 是否已重跑成功」类护栏；不引入 workflow 级 lint 基础设施。

## 5. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1a | 手动触发恢复不再红（合并前验证修复本身） | 自动化验证（automated E2E，真实 dispatch） | `gh workflow run publish.yml -f tag=v0.9.0 --ref issue-154-publish-workflow-dispatch-tag-check`——**ref 必须指向修复分支**：`--ref` 决定运行哪份 workflow 定义，合并前从 main 触发跑的是未修复版，自检必红，会把正确的修复误判为失败。随后 `gh run view <id> --log` 取自检步骤输出 | 自检步骤打出 `package.json: 0.9.0, tag: 0.9.0` 并通过；命中「already published — skipping」分支；整 run `success`。选 v0.9.0 因为它已在 npm 上，**零重复发布风险**。注意：本条只验证到 skip 分支，恢复路径的 `npm publish` 环节本次不执行（与 release 路径共用、未改动） |
| A1b | 文档承诺的路径按字面成立（**合并后**补验） | 自动化验证（automated E2E，真实 dispatch，合并后执行） | `docs/RELEASE.md:117-118` 的字面操作：Actions → Publish to npm → Run workflow → 填 `v0.9.0`（等价命令 `gh workflow run publish.yml -f tag=v0.9.0 --ref main`） | 同 A1a 的日志与结论。这一步验证的不是修复本身，而是**文档承诺的路径从用户视角成立**（ref=main、只填 tag） |
| A2 | 版本错配护栏仍然有效（负向） | 自动化验证（automated E2E，负向） | **勘误**：原设计 `-f tag=v0.8.0 --ref main` 不成立——checkout 跟随 `inputs.tag`（`publish.yml:32`），工作区 `package.json` 也随之变成 0.8.0，比对恒等、无法触发失败；更糟的是若该版本不在 npm 上，run 会一路走到 `npm publish` **真实发布旧版本**。错配必须人为制造：在分支 HEAD 打探针 tag `issue-154-mismatch-probe`（**不带 `v` 前缀**，避开 `release.mjs:207` / `release_helper.mjs:182` 的 `v*` 基线通配）并 push（需用户许可），随后 `gh workflow run publish.yml -f tag=issue-154-mismatch-probe --ref issue-154-publish-workflow-dispatch-tag-check`；验后删除本地与远端 tag，`git ls-remote --tags origin` 确认远端无残留 | 自检步骤 exit 1，日志显示 `package.json: 0.9.0, tag: issue-154-mismatch-probe`，run `failure`（证明护栏没被改成「永远通过」） |
| A3 | `GITHUB_REF_NAME` 不再出现在 publish.yml，且 tag 来源表达式在 checkout 与自检两处同源 | 自动化验证（static） | 新增 `test/publish-workflow.test.mjs`：读 `.github/workflows/publish.yml` 文本（**剥掉整行注释**，避免文档性注释误伤），断言不含 `GITHUB_REF_NAME`，且 `github.event.release.tag_name \|\| inputs.tag`（`\|\|` 两侧空白归一）出现 **≥2 次**（checkout + 自检；删掉自检的 `env:` 块必须红） | `npm test` 通过；修复前两条断言都红（`GITHUB_REF_NAME` 存在、表达式只出现 1 次），先写红再修 |
| A4 | 既有代码不被破坏 | 自动化验证（unit + build + static） | `npm run verify`（typecheck + perf gate + 全量测试 + 覆盖率阈值 + pack dry-run） | 全绿，覆盖率不低于阈值（lines 85 / funcs 80 / branches 70） |
| U1 | release 事件自动路径回归 | 用户实测（下个真实发版自然覆盖） | 发布 0.10.0 时走 `prepare → open-pr → merge → finish`，观察 publish.yml 由 release 事件触发的那次 run | 自检步骤通过（`tag: 0.10.0`），publish 步骤成功。本次修复不改变该路径的输入来源，属回归观察项而非新增验证 |

### 5.1 可测性拆分设计

本改动是 YAML 流程编排，逻辑量近零，可测性设计主要落在「把不变量钉死在可断言的形式上」：

- 修复逻辑本身（表达式替换）无法在本地执行，**其唯一有效验证是真实 dispatch（A1/A2）**——这是本 issue 的核心验收，不设更廉价的替代品，也不因此降级为「用户实测」。
- 唯一可静态化的产物是**不变量 A3**：纯文本断言，无副作用、无外部依赖。做成最小纯函数 `readWorkflowSource()`（读文件）+ 两条字符串断言；副作用（读文件）隔离在单个 helper 内，断言部分保持纯函数式，符合本仓「纯函数 + 薄 I/O 壳」的既有约定（参照 `scripts/release_helper.mjs` 的拆分方式）。
- 该静态测试断言**否定式不变量**（剥整行注释后不含 `GITHUB_REF_NAME`）+ **正向表达式计数 ≥2**（钉住「checkout 与自检同源」——删掉自检的 `env:` 块必须红），不断言 YAML 结构或步骤名。剥注释与归一空白是为了让文档性注释、无害格式调整不触发假红；而计数断言的有意严苛（把表达式上提成 job 级 `env:` 会红）正是守卫测试的期望行为——改架构就必须重审本不变量。

### 5.2 测试边界

| 边界 | 覆盖 | 不覆盖（明确） |
| --- | --- | --- |
| workflow YAML 文本不变量 | A3（static，新增） | YAML 语法正确性（由 GitHub 解析器在 run 时校验，A1 覆盖） |
| workflow 运行时行为 | A1a、A2（真实 dispatch）；A1b（合并后） | release 事件路径（U1，下个真实发版覆盖） |
| 发布脚本逻辑 | A4（既有 13 个 release-flow 测试） | 本次不改 `scripts/release.mjs`，无新增 |

## 6. 风险

- **A1a/A1b 各消耗一次真实 run**：约 1 分钟、无副作用、不产生发布（版本已在注册表 → skip 分支）。可接受。
- **A2 的错配必须人为制造**：checkout 跟随 `inputs.tag`，dispatch 路径下 tag 与工作区 `package.json` 恒同源，用既有 tag 造不出错配；更危险的是若误选未发布过的版本号，run 会一路走到 `npm publish` 真实发布。因此探针 tag 指向分支 HEAD（其 `package.json` 与 tag 名必然不一致），且**不带 `v` 前缀**——`release.mjs` / `release_helper.mjs` 以 `v*` 通配 tag 定 changelog 基线，`v*` 探针泄漏会污染下一次发版。
- **静态测试（A3）的假红风险**：剥整行注释 + 空白归一已规避文档性假红；保留的假红面（计数 ≥2 对上提重构敏感）是守卫测试的期望行为，见 §5.1。
