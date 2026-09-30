# publish.yml dispatch 恢复后门 tag 来源修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `publish.yml` 的 tag 自检步骤从事件负载 / dispatch 输入取 tag（而非 ref 名），使 `docs/RELEASE.md` 记载的手动恢复路径按字面操作即可成功。

**Architecture:** 三行 YAML 改动（自检步骤经 `env:` 接收与 checkout 同源的表达式）+ 一个新静态测试锁定不变量「publish.yml 不得从 ref 名派生 tag」。行为验证靠真实 `workflow_dispatch` run（正向 + 护栏负向），因为本仓无 YAML 级测试设施。

**Tech Stack:** GitHub Actions workflow YAML（`workflow_dispatch` + `release: published` 双触发）、`node:test` + `assert/strict`、`gh` CLI。

**Spec:** `docs/superpowers/specs/2026-09-30-publish-dispatch-tag-check-design.md`

**Worktree:** `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-154-publish-workflow-dispatch-tag-check`（分支 `issue-154-publish-workflow-dispatch-tag-check`，基线 `444199d`）。下文所有路径以 `$WT` 代指该 worktree 根。

## Global Constraints

- 只改 `.github/workflows/publish.yml` 的自检步骤（`:54-59`）与新增 `test/publish-workflow.test.mjs`；**不改** checkout 表达式、`scripts/release.mjs`、`docs/RELEASE.md`、release 事件路径行为。
- 表达式必须经 `env:` 中转，不得把 `${{ }}` 直接写进 `run` 脚本（避免表达式拼接进 shell）。
- tag 派生表达式逐字使用：`${{ github.event.release.tag_name || inputs.tag }}`；去 `v` 前缀方式保持 `${RELEASE_TAG#v}`。
- 测试文件遵循既有约定：`node:test` + `assert/strict`、**Tab 缩进**、文件名 `test/*.test.mjs`、仓库根用 `fileURLToPath(new URL("..", import.meta.url))`。
- 静态测试只断言「否定式不变量 + 正向表达式存在」，不断言 YAML 结构 / 步骤名（避免重构假红）。
- TDD：Task 1 的测试必须在当前未修复文件上先红，Task 2 修完再绿。
- 提交按文件 `git add <file>`，不用 `git add -A`；commit message 用英文 conventional 格式。
- push / 开 PR 前必须获得用户明确许可（用户 AGENTS.md 硬规则）。

## Review Focus

本改动的输入类别与失败模式，按最可能踩到的顺序：

1. **dispatch 的 ref 是分支、而 tag 输入是 tag**（原始 bug 形状）→ 期望：自检通过。由 Task 3 的 A1 覆盖（`--ref issue-154-...` + `-f tag=v0.9.0`）。
2. **tag 输入与 checkout 出来的 `package.json` 不一致** → 期望：自检 fail-closed，不得静默发布。由 Task 3 的 A2 覆盖（探针 tag `v0.0.0-mismatch-probe`）。
3. **回归：有人把 tag 来源重新写成 ref 名派生** → 期望：静态测试红。由 Task 1 的 A3 覆盖。
4. **release 事件自动路径被改坏** → 期望：行为不变（原 `GITHUB_REF_NAME` 在该路径恰好等于 tag）。本 fix 不改变该路径的输入来源，但**无法在本地验证**，只能由下一次真实发版观察（Task 3 的 U1，标注 pending）。
5. **`-f tag=` 传了不带 `v` 前缀的值**（如 `0.9.0`）：`${RELEASE_TAG#v}` 成为空操作。期望：因本仓所有 tag 均带 `v` 前缀，checkout 无法解析该 ref 而 fail-closed，不会走到自检或发布。此行为**不由本 fix 引入也不受其影响**，故不新增测试，记录于此以免被误认为遗漏。

---

### Task 1: 静态守卫测试（A3 · 先红）

**Files:**
- Create: `$WT/test/publish-workflow.test.mjs`

**Interfaces:**
- Consumes: 无（直接读仓库文件）
- Produces: 无（测试文件内部 helper，不被其他任务消费）

- [ ] **Step 1: 写测试文件**

创建 `$WT/test/publish-workflow.test.mjs`（注意 Tab 缩进）：

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The tag a publish run works on comes from the trigger, not from the ref the
 * run was started on: a published GitHub Release carries it in
 * `github.event.release.tag_name`, a manual `workflow_dispatch` recovery run
 * carries it in `inputs.tag`. Deriving it from `GITHUB_REF_NAME` breaks every
 * manual recovery run, because that variable holds the *branch* the run was
 * dispatched from (issue #154).
 */
const TAG_SOURCE = "github.event.release.tag_name || inputs.tag";

/** Read a workflow file as text -- the only side effect in this file. */
function readWorkflowSource(name) {
	return readFileSync(join(PACKAGE_ROOT, ".github", "workflows", name), "utf8");
}

test("publish.yml never derives the release tag from the run's ref", () => {
	const source = readWorkflowSource("publish.yml");
	assert.equal(
		source.includes("GITHUB_REF_NAME"),
		false,
		"publish.yml must not use GITHUB_REF_NAME: on a workflow_dispatch run it holds the branch name, not the tag (issue #154)",
	);
});

test("publish.yml resolves the release tag from the event payload or the dispatch input", () => {
	const source = readWorkflowSource("publish.yml");
	assert.ok(
		source.includes(TAG_SOURCE),
		`publish.yml must resolve the release tag via "${TAG_SOURCE}"`,
	);
});
```

- [ ] **Step 2: 运行，确认第一个测试红、第二个绿**

Run:
```bash
cd $WT && node --test test/publish-workflow.test.mjs
```
Expected: `pass 1` / `fail 1` —— 失败的必是 `publish.yml never derives the release tag from the run's ref`（当前 `:57` 仍含 `GITHUB_REF_NAME`）；`resolves the release tag from ...` 通过（`:32` 的 checkout 已含该表达式）。

- [ ] **Step 3: 提交（红态）**

```bash
cd $WT && git add test/publish-workflow.test.mjs && git commit -m "test(ci): pin publish.yml tag source invariant (issue #154)"
```

---

### Task 2: 修自检步骤的 tag 来源（A1 核心 · 转绿）

**Files:**
- Modify: `$WT/.github/workflows/publish.yml:54-59`

**Interfaces:**
- Consumes: Task 1 的静态测试（作为绿灯判据）
- Produces: 环境变量 `RELEASE_TAG`（仅该 step 内可见），值来自 `github.event.release.tag_name || inputs.tag`

- [ ] **Step 1: 改自检步骤**

把 `.github/workflows/publish.yml` 的自检步骤替换为（原文 5 行 → 新文 6 行，新增 `env:` 块、`GITHUB_REF_NAME` 换成 `RELEASE_TAG`）：

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

- [ ] **Step 2: 单独跑静态测试，确认双绿**

Run:
```bash
cd $WT && node --test test/publish-workflow.test.mjs
```
Expected: `pass 2` / `fail 0`。

- [ ] **Step 3: 跑全量测试，确认无回归**

Run:
```bash
cd $WT && npm test
```
Expected: 全绿（含既有 13 个 release-flow 测试）。

- [ ] **Step 4: 目视确认 diff 只碰这两处**

Run:
```bash
cd $WT && git diff --stat && git diff .github/workflows/publish.yml
```
Expected: 只有 `publish.yml` 一处改动（另加 Task 1 已提交的测试文件不在本次 diff 内）；diff 中除 `env:` 块与 `${RELEASE_TAG#v}` 外无其他变化。

- [ ] **Step 5: 提交**

```bash
cd $WT && git add .github/workflows/publish.yml && git commit -m "fix(ci): read the dispatch recovery tag from inputs, not the ref name (issue #154)"
```

---

### Task 3: 验收取证（A4 · A1 · A2 · U1）

**Files:**
- 不修改任何文件；产出证据记录（写入 issue 评论，必要时追加到 spec 的验收结论段）

**Interfaces:**
- Consumes: Task 2 的分支状态（`--ref` 必须指向本分支，才能跑到修好的 workflow 定义）
- Produces: 每个验收 ID 的实际命令与结果字符串

> **机制说明（决定命令怎么写）**：`gh workflow run --ref <ref>` 运行的**是该 ref 上的 workflow 定义**，而 checkout 用的是 `inputs.tag`。所以验收 dispatch 必须 `--ref issue-154-publish-workflow-dispatch-tag-check`（本分支，含修复）；这正是原始 bug 的形状——ref 是分支、tag 来自输入。

- [ ] **Step 1: A4 —— 完整校验**

Run:
```bash
cd $WT && npm run verify
```
Expected: typecheck + perf gate + 全量测试 + 覆盖率阈值 + pack dry-run 全绿。记录覆盖率三行数字。

- [ ] **Step 2: A1 —— 正向：从分支 ref 触发、tag=v0.9.0 应通过并走 skip 分支**

Run:
```bash
cd $WT && gh workflow run publish.yml -f tag=v0.9.0 --ref issue-154-publish-workflow-dispatch-tag-check
sleep 8 && gh run list --workflow=publish.yml --limit 4
```
Expected: 新 run 出现；随后取该 run 的日志：
```bash
gh run view <run-id> --log | grep -E "package.json:|already published|Publishing to"
```
Expected: `package.json: 0.9.0, tag: 0.9.0`；`@zhuxixi/pi-agent-board@0.9.0 is already published — skipping the publish step`；**无** `Publishing to https://registry.npmjs.org`（证明零发布风险）。整 run `success`。

- [ ] **Step 3: A2 —— 负向：护栏仍然会对不一致的 tag fail-closed**

先建探针 tag（指向分支 HEAD，该提交的 `package.json` 是 0.9.0，而 tag 名是 `v0.0.0-mismatch-probe`，二者必然不一致）：

```bash
cd $WT && git tag v0.0.0-mismatch-probe && git push origin v0.0.0-mismatch-probe
```
> ⚠️ 这一步 push 需要用户许可；与开 PR 的许可一并取得。

```bash
cd $WT && gh workflow run publish.yml -f tag=v0.0.0-mismatch-probe --ref issue-154-publish-workflow-dispatch-tag-check
sleep 8 && gh run list --workflow=publish.yml --limit 4
gh run view <run-id> --log-failed | grep -E "package.json:|error|exit code"
```
Expected: 自检步骤 `package.json: 0.9.0, tag: 0.0.0-mismatch-probe` → `##[error]Process completed with exit code 1`；run `failure`。**证明护栏没被改成「永远通过」。**

清理探针 tag（本地 + 远端）：

```bash
cd $WT && git push origin --delete v0.0.0-mismatch-probe && git tag -d v0.0.0-mismatch-probe
```
Expected: 远端与本地均删除成功；`git tag --list 'v0.0.0*'` 为空。

- [ ] **Step 4: U1 —— release 事件路径（本任务不执行，标注 pending）**

记录：release 事件路径的输入来源未被本 fix 改变（仍为 `github.event.release.tag_name`），但**无法在不真实发版的前提下验证**。因此 U1 在 PR 描述与 issue 评论中标记为 `pending`，由下一个版本（0.10.0）的真实发版观察 `tag: 0.10.0` 且 publish 成功。**不得宣称 U1 已通过。**

- [ ] **Step 5: 证据登记**

把 Step 1–4 的实际命令与结果（含 run id、run URL、关键日志行）评论到 issue #154，并对每个验收 ID 标注 `passed` / `pending`。
