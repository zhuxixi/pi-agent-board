# issue #106 实施计划：终态链仍须学习帧认知

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `feed()` 在链的**两个终态**（`clearDetected` 与 `stopped`）下仍从后续输出学习 TUI 帧认知（`tuiFrameSeen`），使运行期失配自愈（#11）的 gate 2 在「链先停、TUI 后启动」的连接里不再永久关闭；学习本身零副作用（不发 resize、不设 timer、不改 retry state）。

**Architecture:** 改动落在唯一一处——`src/core/pty-attach-jiggle-controller.mjs` 的 `feed()`：把原本的两条终态早退（`:220`/`:221`）合并为一个终态分支，在分支内用既有纯函数 `feedOutput()` 扫本块数据、推进 `carry`、命中 `\x1b[?2026h` 即锁存 `tuiFrameSeen`，然后返回。纯函数层 `pty-attach-jiggle-retry.mjs` 不动；重打开协议仍归 `heal()`（自带 10s 限速与 5 次终身上限）。

**Tech Stack:** Node ESM `.mjs` 控制器 + 注入式副作用（`sendResize`/`setTimeoutFn`/`clearTimeoutFn`）；测试 `node --test`，组件级用 `test-support/desync-heal-smoke.ts`（`node --experimental-transform-types`）。

**Spec:** `docs/superpowers/specs/2026-09-14-issue-106-terminal-frame-cognition-design.md`（根因、两个终态可达性、契约表、备选否决、验收矩阵 A1–A9/U1）。

## 设计决策（本 plan 锁定）

1. **两个终态合并为一个分支**（用户已确认范围 B）：两者对重试协议含义相同（链已结束），对学习需求相同。
2. **`if (tuiFrameSeen) return;` 前置短路**：锁存后终态下的每次扫描是无用功（惰性 shell session 长期输出）；短路后稳态成本为零。
3. **`carry` 仅在未锁存时推进**：帧标记 8 字节可跨 chunk，不推进会「只学一半」。
4. **终态分支不改 `state`**：终态是「协议已结束」的判定，不得被后续输出改写（否则 G2 预算语义与既有 `no re-arm probe` 契约被推翻）。
5. **不新增抽象**：`feedOutput()` 已返回 `frameStartFound` + `carry`，测试边界维持现状（controller = 状态机 + 注入副作用；观测点 `getState()` 与记录的 `resizes`）。
6. **红证用「teeth check」而非提交红测试**：Task 1 先写测试跑出红再实现；Task 2 用「临时 checkout 修复前源码 → 跑红 → 恢复」证明组件级断言有牙齿。每个 commit 结束时树常绿。

## Global Constraints

- `$WT = /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-106-terminal-frame-cognition`；全部操作用 `$WT` 绝对路径（工具 `cwd` 也用 `$WT`），git 用 `git -C $WT`；**禁碰 main**。
- commit message 英文 conventional commits；`git add <file>` 显式 stage，**禁止 `git add -A`**。
- 本次改动不涉及 coordinator/PTY 进程，**不需要** `AGENT_BOARD_ROOT`/`PI_CODING_AGENT_DIR` 隔离（纯单测 + 组件 smoke）。
- 测试层纪律：E2E（真子进程）不做——G2 需真等 56s、G4 需精确卡首帧前 resize（spec「可测性拆分设计」已给理由）。
- 分阶段提交，保持树常绿（每个 task 结束前必须跑绿）。
- `$WT/node_modules` 是指向主 checkout 的符号链接（281M 不做拷贝），**不要在 worktree 里跑 `npm ci`/`npm install`**。
- spec 提交哈希：`1529555`（本分支首个 commit，Task 2 的红证要用它）。

## 验收映射

| Task | 验收 ID | 说明 |
|---|---|---|
| Task 1 | A1 A2 A3 A4 A6 A9(unit 段) | 单测：两个终态锁存、跨 chunk、heal 可达、零副作用、既有 27 条不回归 |
| Task 2 | A5 A9(integration 段) | 组件级 smoke H8：终态 + 晚到帧 → 真实 `checkDesync` 触发一次 heal；H4 仍不 heal |
| Task 3 | A7 A8 + spec 附录 | 文档纠正（可单独 revert）+ 全量 verify（typecheck/test/coverage/pack） |
| U1（无 task） | U1 | 人工观察项，合并后执行，非阻塞（见文末） |

---

### Task 1: 单测红证 + 终态学习实现

**Files:**
- Modify: `$WT/src/core/pty-attach-jiggle-controller.mjs`（`feed()`，当前 `:219-231`）
- Test: `$WT/test/pty-attach-jiggle-controller.test.mjs`（追加到文件末尾）

**Interfaces:**
- Consumes: `feedOutput(state, data, carry) → { state, carry, clearFound, frameStartFound }`（`src/core/pty-attach-jiggle-retry.mjs`，不改）；`createJiggleRetryState()`/`stopRetry()`/`advanceRetry()`；`fakeScheduler()`/`makeController()`（测试内既有夹具，`resizes` 数组 + `scheduler.timers`）。
- Produces（Task 2 依赖）: `feed()` 终态分支契约——终态（`state.clearDetected || state.stopped`）下：`tuiFrameSeen` 已为 true 时立即返回；否则用 `feedOutput()` 扫本块并推进 `carry`，命中帧标记即置 `tuiFrameSeen = true`；**不调用 `sendResize`、不设/清 timer、不修改 `state`**。

- [ ] **Step 1: 追加三条失败测试**（追加到 `test/pty-attach-jiggle-controller.test.mjs` 末尾）

```js
// --- issue #106: terminal chain states must still learn frame cognition ---

test("issue #106: G2-exhausted chain still learns a late first frame (cognition only, zero side effects)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	scheduler.fireNext(); // G1 fires first in Map order (6000): restore, no frame seen
	for (let i = 0; i < 8; i++) scheduler.fireNext(); // exhaust the 8-entry chain (G2)
	assert.equal(controller.getState().stopped, true);
	assert.equal(controller.getState().tuiFrameSeen, false);
	const resizesBefore = resizes.length;
	const timersBefore = scheduler.timers.size;
	controller.feed("\x1b[?2026h late frame");
	assert.equal(controller.getState().tuiFrameSeen, true, "cognition must be learned after the chain settled");
	assert.equal(resizes.length, resizesBefore, "terminal feed must not probe");
	assert.equal(scheduler.timers.size, timersBefore, "terminal feed must not arm timers");
	assert.equal(controller.getState().stopped, true, "terminal state must not be rewritten");
	assert.equal(controller.heal(170, 36), true, "gate 2 open: heal() must be reachable again");
});

test("issue #106: clearDetected without any frame still learns a late first frame", () => {
	const { controller, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[2J\x1b[Hplain shell output"); // clear wins → terminal, still no frame
	assert.equal(controller.getState().clearDetected, true);
	assert.equal(controller.getState().tuiFrameSeen, false);
	const resizesBefore = resizes.length;
	controller.feed("\x1b[?2026h the TUI boots later");
	assert.equal(controller.getState().tuiFrameSeen, true, "cognition must be learned after clearDetected");
	assert.equal(resizes.length, resizesBefore, "terminal feed must not probe");
	assert.equal(controller.getState().held, false, "terminal feed must not re-arm a hold");
});

test("issue #106: a frame marker split across chunks is still caught in a terminal state", () => {
	const { controller } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[2J"); // terminal via clear, still no frame
	controller.feed("\x1b[?202"); // first half of the 2026h marker
	assert.equal(controller.getState().tuiFrameSeen, false, "a partial marker alone must not latch");
	controller.feed("6h TUI frame");
	assert.equal(controller.getState().tuiFrameSeen, true, "carry must bridge the chunk boundary");
});
```

- [ ] **Step 2: 跑测试确认红**（A9 unit 段证据）

Run: `cd $WT && node --test test/pty-attach-jiggle-controller.test.mjs`
Expected: **FAIL 3 条**（新用例），既有 27 条仍 PASS。失败形态：
- 用例 1：`cognition must be learned after the chain settled`（实际 false）
- 用例 2：`cognition must be learned after clearDetected`（实际 false）
- 用例 3：`carry must bridge the chunk boundary`（实际 false）

把这段输出留档（Task 3 用于 PR 描述的红证）。

- [ ] **Step 3: 实现终态学习分支**

把 `feed()` 开头的两条早退替换为终态分支（`src/core/pty-attach-jiggle-controller.mjs`）：

旧：
```js
	function feed(data) {
		if (state.clearDetected) return; // chain done; nothing left to detect
		if (state.stopped) return; // chain ended (G2/G3/G4); output is inert
		const result = feedOutput(state, data, carry);
```

新：
```js
	function feed(data) {
		// Terminal chain states: a clear was seen (chain done) or the chain ended
		// (G2/G3/G4). Output no longer drives the retry protocol — but frame
		// cognition must still be learned from it (issue #106): a TUI whose first
		// frame lands after the chain settled must still open the runtime desync
		// backstop's gate 2 (issue #11), otherwise heal() stays unreachable for the
		// rest of this connection. Cognition only — no timers, no resizes, and no
		// retry-state change: re-opening the protocol is heal()'s job (rate-limited
		// and lifetime-capped), not an output chunk's.
		if (state.clearDetected || state.stopped) {
			if (tuiFrameSeen) return; // latched already — nothing left to learn
			const terminal = feedOutput(state, data, carry);
			carry = terminal.carry; // keep cross-chunk marker detection intact
			if (terminal.frameStartFound) tuiFrameSeen = true;
			return;
		}
		const result = feedOutput(state, data, carry);
```

同时把 `feed()` 的 doc-comment 补一句终态说明（紧跟「…so the running child still sees a width delta (F1 slow-boot probe).」之后）：

```
	 * Terminal chain states still learn frame cognition from later output
	 * (issue #106) — cognition only; re-opening the protocol stays heal()'s job.
```

注意：本 step **不动** `feed()` 其余任何行、不动 `ensureHold`/`tickChain`/`heal`/`start`。

- [ ] **Step 4: 跑测试确认绿**

Run: `cd $WT && node --test test/pty-attach-jiggle-controller.test.mjs`
Expected: **PASS 30 条**（27 既有 + 3 新增）。特别确认既有 `no re-arm probe after chain exhausted (stopped)` 仍绿（A6：终态零副作用）。

- [ ] **Step 5: 跑相邻回归**

Run: `cd $WT && node --test test/pty-attach-jiggle-retry.test.mjs test/pty-attach-desync-heal.test.mjs test/pty-attach-cold-start-e2e.test.mjs test/pty-attach-reconnect.test.mjs`
Expected: 全 PASS（纯层未改、终态行为只在新增分支上变化）。

- [ ] **Step 6: Commit**

```bash
git -C $WT add src/core/pty-attach-jiggle-controller.mjs test/pty-attach-jiggle-controller.test.mjs
git -C $WT commit -m "fix(attach): learn TUI frame cognition in terminal chain states (issue #106)"
```

---

### Task 2: 组件级 smoke H8（gate 2 真打开 → 真触发一次 heal）

**Files:**
- Modify: `$WT/test-support/desync-heal-smoke.ts`（新增 H8 场景 + 顶部注释与 `out` 记录）
- Test: `$WT/test/pty-attach-desync-heal.test.mjs`（新增一条断言）

**Interfaces:**
- Consumes: `PtyAttachComponent` 真实实例 + `write()`（`pushOutput` + `checkClearSequence`，即真实 socket-data 路径）、`desyncFrame`/`CLEAR` 常量、`resizes(sent)` 辅助、H4 的「无帧」构造形状。
- Produces: smoke 输出字段 `lateFrameHeals: boolean`（供 `test/pty-attach-desync-heal.test.mjs` 断言）。

- [ ] **Step 1: 在 smoke 脚本中新增 H8 场景**（`test-support/desync-heal-smoke.ts`，放在 H7 场景之前的 `main()` 内；同时把 H 列表注释与 `out` 类型注释更新）

```ts
	// H8 (issue #106): the chain reached a terminal state before ANY TUI frame
	// (shell clear, H4 shape); a first frame arriving later must still open gate 2
	// and let checkDesync() heal exactly once.
	{
		const { attach, sent, clock } = makeAttach();
		await write(attach, CLEAR + "plain shell output, no TUI frame"); // terminal, no frame
		await write(attach, `${ESC}[?2026h`); // the TUI boots later
		await write(attach, desyncFrame);
		attach.finishAttachTransition();
		clock.now += 10_000; // all other gates open — only gate 2 could block the heal
		attach.checkDesync();
		out.lateFrameHeals = attach.jiggleRetry.getState().healCount === 1 && resizes(sent) === 1;
	}
```

- [ ] **Step 2: 在测试文件里断言 H8**（`test/pty-attach-desync-heal.test.mjs`，紧随既有 `out.noFrameNoHeal` 断言之后）

```js
	assert.equal(parsed.lateFrameHeals, true, "H8 late first frame must open gate 2 and heal once (issue #106)");
```

- [ ] **Step 3: teeth check —— 证明 H8 有牙齿（红证）**

```bash
cd $WT
git checkout 1529555 -- src/core/pty-attach-jiggle-controller.mjs   # 临时回到修复前源码（spec 提交）
node --test test/pty-attach-desync-heal.test.mjs                    # 期望 FAIL：H8 断言
git status --short                                                  # 期望仅 src/... 显示为 staged 的修改
git checkout HEAD -- src/core/pty-attach-jiggle-controller.mjs      # 恢复修复
git status --short                                                  # 期望干净
```

Expected（红）：`H8 late first frame must open gate 2 and heal once (issue #106)` 失败；其余 H1–H7 断言仍 true。
把这段输出留档（A9 integration 段证据）。

- [ ] **Step 4: 跑测试确认绿**

Run: `cd $WT && node --test test/pty-attach-desync-heal.test.mjs`
Expected: **PASS**，且 `parsed.noFrameNoHeal === true`（H4 回归：无帧仍不 heal）。

- [ ] **Step 5: Commit**

```bash
git -C $WT add test-support/desync-heal-smoke.ts test/pty-attach-desync-heal.test.mjs
git -C $WT commit -m "test(attach): component-level coverage for terminal-state frame cognition (issue #106)"
```

---

### Task 3: 文档纠正 + 全量 verify

**Files:**
- Modify: `$WT/src/core/pty-attach-jiggle-controller.mjs`（`feed()` doc-comment 一处陈述）

**Interfaces:**
- Consumes: 无新增。
- Produces: 无（纯注释；spec 附录条目）。

- [ ] **Step 1: 纠正 doc-comment 里的错误成因**

旧（`feed()` doc-comment 内）：
```
	 * chunk: a clear only proves the child redraws, not that it isn't a TUI
	 * (screen-log replay bundles historical frames with clears, issue #11).
```
新：
```
	 * chunk: a clear only proves the child redraws, not that it isn't a TUI
	 * (a live fullRender chunk bundles a frame start with its clear, issue #11).
```
依据（spec 附录）：`replayScreenLog()`（`src/ui/pty-attach.ts:1091`）只调 `pushOutput()`，replay 不喂 controller；`checkClearSequence()` 只在 `onSocketData` 的 live `output` 分支被调（`:1050`）。

- [ ] **Step 2: 全量静态与测试**（A7、A8）

Run: `cd $WT && npm run typecheck && npm test`
Expected: typecheck 无错误；`npm test` 全绿（既有总数 + 3 条新单测）。

- [ ] **Step 3: 全量 verify**（A8）

Run: `cd $WT && npm run verify`
Expected: `typecheck` + `test` + `test:coverage` + `pack:dry` 全通过；无新增未覆盖分支告警。

- [ ] **Step 4: Commit**

```bash
git -C $WT add src/core/pty-attach-jiggle-controller.mjs
git -C $WT commit -m "docs(attach): correct the clear-wins rationale in feed() (issue #106)"
```

（若 review 要求最小 diff，此 commit 可单独 revert，不影响修复正确性。）

---

### Task 4: 对账与 PR 准备（无代码改动）

- [ ] **Step 1: 逐条对账验收矩阵**

对 A1–A9 逐项贴出实际命令与结果（A1–A4/A6：Task 1 Step 4 输出；A5：Task 2 Step 4 输出；A9 红证：Task 1 Step 2 与 Task 2 Step 3 输出；A7/A8：Task 3 Step 2–3 输出）；U1 标 `pending`（见下）。

- [ ] **Step 2: 确认工作区干净且提交序列正确**

Run: `git -C $WT status --short && git -C $WT log --oneline main..HEAD`
Expected: 干净；4 个 commit（spec / fix+tests / smoke / docs）。

- [ ] **Step 3: 暂停等用户许可**（流程硬门）

push 与开 PR 前**必须**获得用户明确许可（用户 AGENTS.md：不自动 commit/push 除非明确许可；本仓库流程：push/开 PR 前暂停）。许可后按 zima-pr-monitor 流程：push → 开 PR（正文标注「`clearDetected` 分支为推断场景 + 代码依据」）→ 打 `zima:needs-review` → 同 turn 前台阻塞等待 CR → 逐件修复 → 收敛后合并。

---

## U1（人工观察项，合并后执行，非阻塞）

步骤：1) attach 到一个 shell 型或长静默的 host session；2) 让链走完预算（>60s 无帧无 clear）或先真实 resize 一次（G4）；3) 在该 session 内启动 pi；4) 观察画面是否出现周期性全清重绘。

通过标准：无周期性全清重绘（无误触发）；若此时发生真失配，限速周期（10s）内自愈。

pending 理由（与 spec 一致）：复现需真实 ≥56s 无帧窗口 + 人为构造失配，脚本化成本高、收益低；与 #11 的 U1 同性质，合并观察。
