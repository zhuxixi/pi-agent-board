# Jiggle shrink-and-hold 协议改造 Implementation Plan（issue #25）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 attach 的 jiggle 从"±1 脉冲对"改成"shrink-and-hold"协议——缩住直到见到全清，冷启动自愈 ≤3s，同时以 G1-G5 守卫保证不破坏任何现有功能。

**Architecture:** 协议主体在 `pty-attach-jiggle-controller.mjs`（armed→held→restored 状态 + G1/G2 计时）；`pty-attach-jiggle-retry.mjs` 状态机不动（退避表仅作 G2 计时）；`pty-attach.ts` 替换 forceChildRedraw 胶水并接入 G3/G4/G5；E2E stub 改 hold 语义并新增 shell 兜底用例。

**Tech Stack:** Node 24（node:test）、TypeScript（tsc --noEmit）、node-pty、@xterm/headless。

## Global Constraints

- 工作目录：`/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-25-jiggle-shrink-and-hold`（**禁碰主 checkout**）。
- hold 尺寸 = (cols−1)×(rows−1)；restore = 原始尺寸；restore **幂等（只发一次）**。
- G1 = start 后 6s 无 `\x1b[?2026h` → restore；G2 = 退避表走完（56.12s）无全清 → restore。
- re-arm（首个 TUI 帧）→ **restore 原尺寸且不重排链**（无脉冲）。
- G3：close 时 `restoreAndStop()`；G5：`start()` 前若 held 先 restore；G4：`notifyExternalResize(c,r)` 取消 hold/计时器并把 (c,r) 记为新原尺寸。
- 删除 `JIGGLE_RESTORE_MS`（无脉冲对）。
- 代码风格：tab 缩进、双引号、JSDoc、core 模块 .mjs；commit 用 conventional commits；`git add` 按文件。
- Spec：`docs/superpowers/specs/2026-08-22-jiggle-shrink-and-hold-design.md`（已提交 b9b3aab）。

---

### Task 1: 控制器协议改造（hold 状态机 + G1/G2/G3/G4/G5）

**Files:**
- Modify: `src/core/pty-attach-jiggle-controller.mjs`
- Test: `test/pty-attach-jiggle-controller.test.mjs`

**Interfaces:**
- Consumes: `pty-attach-jiggle-retry.mjs` 的 `createJiggleRetryState/nextRetryDelay/advanceRetry/stopRetry` 与 `feedOutput`（含 frameStartFound/clearFound）——**全部原样使用，不改**。
- Produces（Task 2/3 依赖）:
  - deps: `{ sendResize(cols, rows), setTimeoutFn, clearTimeoutFn }`（`sendJiggle`/`shouldFire` **删除**）
  - 返回 `{ start(cols, rows), feed(data), restoreAndStop(), notifyExternalResize(cols, rows), getState() }`
  - `getState()` → `{ held, clearDetected, stopped, tuiFrameSeen, originalCols, originalRows }`（retryIndex 可保留内部）

**行为规格（精确）：**

```js
start(cols, rows):
  1. 清全部计时器；若 held → sendResize(prevOriginalCols, prevOriginalRows)（G5，幂等标记复位）
  2. originalCols/Rows = (cols, rows)
  3. sendResize(cols, rows); sendResize(cols-1, rows-1); held = true; restored = false
  4. tuiFrameSeen = false; clearDetected = false; stopped = false; state = createJiggleRetryState()
  5. G1 计时器 = 6s：fire 时若 !tuiFrameSeen → restoreIfHeld()
  6. 预算链照常排（nextRetryDelay/advanceRetry 循环），但回调 fire 时 **no-op**（不发脉冲、不 sendResize；仅推进计数）；delay 走完（null）→ stopRetry + restoreIfHeld()（G2）

feed(data):
  1. 若 clearDetected → return（沿用）
  2. feedOutput 扫描（沿用）
  3. clearFound → restoreIfHeld(); 停链（stopRetry+clearTimer）; clearDetected=true; 取消 G1
  4. frameStartFound 且 !tuiFrameSeen → tuiFrameSeen=true; 取消 G1; **restoreIfHeld()**; 不重排链、不碰预算

restoreIfHeld(): if (held && !restored) { sendResize(originalCols, originalRows); restored = true; held = false; }

restoreAndStop(): 清全部计时器; restoreIfHeld(); state = stopRetry(state)

notifyExternalResize(cols, rows):
  清全部计时器; held = false; restored = false（hold 作废，G4）
  originalCols/Rows = (cols, rows)
  state = stopRetry(state)（链终止；本次 attach 语义已让位于真实 resize）
```

- [ ] **Step 1: 重写单测**（全量替换 test/pty-attach-jiggle-controller.test.mjs，fake scheduler 记录 sendResize 调用序列）：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiggleRetryController } from "../src/core/pty-attach-jiggle-controller.mjs";

function fakeScheduler() {
	const timers = new Map();
	let nextId = 1;
	return {
		timers,
		setTimeoutFn(fn, ms) {
			const id = nextId++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimeoutFn(id) { timers.delete(id); },
		fire(id) { const t = timers.get(id); assert.ok(t, "no such timer"); timers.delete(id); t.fn(); },
		fireNext() { const first = timers.entries().next().value; assert.ok(first, "no pending timer"); this.fire(first[0]); },
		delays() { return [...timers.values()].map((t) => t.ms); },
		findByDelay(ms) { for (const [id, t] of timers) if (t.ms === ms) return id; return null; },
	};
}

function makeController() {
	const scheduler = fakeScheduler();
	const resizes = [];
	const controller = createJiggleRetryController({
		sendResize: (c, r) => resizes.push([c, r]),
		setTimeoutFn: scheduler.setTimeoutFn,
		clearTimeoutFn: scheduler.clearTimeoutFn,
	});
	return { controller, scheduler, resizes };
}

test("start() arms hold: sends original then shrunk size, holds", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	assert.deepEqual(resizes, [[170, 36], [169, 35]]);
	assert.equal(controller.getState().held, true);
	assert.notEqual(scheduler.findByDelay(6000), null, "G1 timer armed"); // 6000 in delays
	assert.ok(scheduler.delays().includes(6000), "G1 timer present");
});

test("feed with clear restores original size exactly once and stops", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("x\x1b[2J\x1b[Hy");
	assert.deepEqual(resizes.slice(-1), [[170, 36]]);
	assert.equal(controller.getState().clearDetected, true);
	assert.equal(controller.getState().stopped, true);
	assert.equal(controller.getState().held, false);
	// 幂等：后续 feed 不再发
	controller.feed("more\x1b[2J");
	assert.equal(resizes.filter(([c]) => c === 170).length, 2); // start 的 + restore 的，无第三发
});

test("re-arm (first TUI frame) restores size and does NOT reschedule chain", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	const budgetBefore = scheduler.delays().length;
	controller.feed("\x1b[?2026h first frame");
	assert.deepEqual(resizes.slice(-1), [[170, 36]]);
	assert.equal(controller.getState().tuiFrameSeen, true);
	assert.equal(scheduler.delays().length, budgetBefore, "no new timers scheduled");
	// G1 已取消
	assert.equal(scheduler.findByDelay(6000), null);
});

test("G1: no TUI frame within 6s restores original size", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	const g1 = scheduler.findByDelay(6000);
	assert.ok(g1);
	scheduler.fire(g1);
	assert.deepEqual(resizes.slice(-1), [[170, 36]]);
	assert.equal(controller.getState().held, false);
});

test("G1 cancelled once a frame arrives (no double restore)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[?2026h frame");
	const g1 = scheduler.findByDelay(6000);
	assert.equal(g1, null);
});

test("G2: backoff budget exhausted without clear restores original size", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[?2026h frame"); // re-arm restores, cancels G1
	const before = resizes.length;
	// 排干全部退避计时器（无脉冲 fire 均为推进）
	for (let i = 0; i < 8; i++) scheduler.fireNext();
	assert.equal(controller.getState().stopped, true);
	// hold 已在 re-arm 时恢复，G2 无需再发（幂等）
	assert.equal(resizes.length, before);
});

test("G2 without any frame: budget exhausted restores", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	const g1 = scheduler.findByDelay(6000);
	scheduler.fireNext(); // 第一个退避计时器（120ms）推进，no-op
	for (let i = 0; i < 7; i++) scheduler.fireNext();
	assert.equal(controller.getState().stopped, true);
	assert.deepEqual(resizes.slice(-1), [[170, 36]], "G2 restore fired");
});

test("restoreAndStop() restores then stops (G3)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.restoreAndStop();
	assert.deepEqual(resizes.slice(-1), [[170, 36]]);
	assert.equal(controller.getState().stopped, true);
	assert.equal(scheduler.timers.size, 0);
});

test("start() after a held start restores previous hold first (G5)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.start(196, 39); // 新连接
	assert.deepEqual(resizes.slice(0, 4), [[170, 36], [169, 35], [170, 36], [196, 39]]);
	assert.deepEqual(resizes.slice(-1), [[195, 38]]);
});

test("notifyExternalResize cancels hold, adopts new size, stops chain (G4)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	resizes.length = 0;
	controller.notifyExternalResize(200, 50);
	assert.equal(scheduler.timers.size, 0, "all timers cleared");
	assert.equal(controller.getState().held, false);
	assert.equal(controller.getState().stopped, true);
	assert.equal(controller.getState().originalCols, 200);
	// 再 feed clear 不再触发任何 restore
	controller.feed("\x1b[2J");
	assert.equal(resizes.length, 0);
});

test("full G1 window passes while frames keep arriving → held restored by G2 only", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[?2026h frame"); // restores once
	const before = resizes.length;
	// 无全清的持续输出
	for (let i = 0; i < 8; i++) scheduler.fireNext();
	assert.equal(resizes.length, before, "no extra resizes");
	assert.equal(controller.getState().stopped, true);
});
```

- [ ] **Step 2: 跑测试确认失败**（接口不匹配即失败）
  Run: `node --test test/pty-attach-jiggle-controller.test.mjs` → FAIL

- [ ] **Step 3: 实现控制器改造**（按上方行为规格重写 `src/core/pty-attach-jiggle-controller.mjs`；保留模块头注释并更新为 hold 协议描述；G1 常量 `NO_FRAME_RESTORE_MS = 6000`）

- [ ] **Step 4: 跑测试确认通过** → PASS（此时 pty-attach.ts 尚未接线，typecheck 可能因 deps 变化报错——本任务只保证控制器单测绿；组件接线在 Task 2）

- [ ] **Step 5: Commit**
```bash
git add src/core/pty-attach-jiggle-controller.mjs test/pty-attach-jiggle-controller.test.mjs
git commit -m "feat: shrink-and-hold jiggle protocol with G1-G5 guards (issue #25)"
```

---

### Task 2: 组件接线（forceChildRedraw → start；G3/G4/G5 接入）

**Files:**
- Modify: `src/ui/pty-attach.ts`

**Interfaces:**
- Consumes: Task 1 的 `{ start(cols, rows), feed, restoreAndStop, notifyExternalResize, getState }`；deps `{ sendResize, setTimeoutFn, clearTimeoutFn }`。

**精确改动：**
1. 控制器字段初始化改为：
```ts
	private readonly jiggleRetry = createJiggleRetryController({
		sendResize: (cols, rows) => this.sendResize(cols, rows),
		setTimeoutFn: (fn, ms) => {
			const t = setTimeout(fn, ms);
			t.unref?.();
			return t;
		},
		clearTimeoutFn: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
	});
```
2. connect 处理器：删除 `this.forceChildRedraw()` 与其前独立 `this.sendResize()`（协议已在 start 内含 sendResize 原尺寸）；改为 `this.jiggleRetry.start(this.cols, this.rows);`
3. `forceChildRedraw()` 方法整个删除；`JIGGLE_RESTORE_MS` 常量及其注释删除；`clearRedrawTimer()` 若仅被 forceChildRedraw/close 使用则一并删除（先 grep 确认无他引用；close() 中 `this.clearRedrawTimer()` 调用改为无操作或删除该行）。
4. `resizeIfNeeded`：在 `this.term.resize(...)` 前插入 `this.jiggleRetry.notifyExternalResize(size.cols, size.rows);`（G4）——注意它必须在确认尺寸真的变化后调用（函数内 size 更新之后、sendResize 之前）。
5. `close()`：`this.jiggleRetry.stop()` 改为 `this.jiggleRetry.restoreAndStop()`（G3）。
6. `checkClearSequence` → `this.jiggleRetry.feed(data)` 不变。

- [ ] **Step 1: 应用上述 6 处改动**
- [ ] **Step 2: 验证**
  Run: `npm run typecheck`（必须干净）；`node --test test/*.test.mjs`（除 E2E 外全绿；E2E 在 Task 3 重写）
- [ ] **Step 3: Commit**
```bash
git add src/ui/pty-attach.ts
git commit -m "feat: wire shrink-and-hold controller into attach component (issue #25)"
```

---

### Task 3: E2E 重写（hold 语义）+ shell 兜底用例

**Files:**
- Modify: `test-support/fake-coldstart-tui-pi.mjs`
- Test: `test/pty-attach-cold-start-e2e.test.mjs`（重写）

**stub 新语义（精确）：**

```js
#!/usr/bin/env node
// Fake cold-booting pi for the attach shrink-and-hold E2E (issue #25).
// Boot noise first; after STUB_TUI_DELAY_MS "starts the TUI": installs the
// resize listener and emits \x1b[?2026h-wrapped frames. Holds the protocol:
// whenever the PTY size becomes (cols, rows) where cols/rows differ from the
// size at TUI start (the hold's promised width delta), the running TUI
// responds with a fullRender containing \x1b[2J — because pi-tui's
// widthChanged path fires for ANY width change from its baseline.
const delay = Number(process.env.STUB_TUI_DELAY_MS ?? 8000);
process.stdout.write("boot: loading extensions...\n");
let started = false;
let baseline = null;
function startTui() {
	if (started) return;
	started = true;
	process.stdout.on("resize", () => {
		const c = process.stdout.columns;
		const r = process.stdout.rows;
		if (baseline === null) baseline = [c, r]; // 首个见到的尺寸=基线
		if (c === baseline[0] && r === baseline[1]) return; // 无变化不全清
		baseline = [c, r]; // 全清后新基线
		process.stdout.write(
			`\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jframe@${c}x${r}\x1b[?2026l`,
		);
	});
	process.stdout.write("\x1b[?2004h\x1b[?25l");
	frame();
}
function frame() { process.stdout.write("\x1b[?2026hstub: working...\x1b[?2026l"); }
setTimeout(startTui, delay);
setInterval(() => { if (started) frame(); }, 100);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
```

**E2E 用例 1（冷启动 ≤3s 自愈 + 终态原尺寸）**：runner + stub（delay 8000）+ 真控制器。connect 时仅 `controller.start(196, 39)`（不再手动 sendResize/jiggle——协议在 start 内）。喂全部 output 给 feed。断言：
- 首个 `\x1b[2J` 到达时刻 − 首帧（tuiFrameSeen 翻转）时刻 ≤ **3000ms**（frameAt/clearAt 都取自 controller.getState() 翻转的采样点，沿用 #10 的采样法）
- `getState().held === false` 且收到过 resize(196,39)（终态原尺寸；从 runner 侧回读 host.json cols/rows == 196/39 亦可作证）

**E2E 用例 2（shell 型子进程 G1 兜底）**：piArgsPrefix 指向 `test-support/fake-pty-pi.mjs`（既有，无 2026h、无 resize 响应）。connect 后 `controller.start(120, 36)`；喂 output；**手动 fire G1**不可行（真计时器）——改为等真 6s：断言 8s 内收到 sendResize(120, 36)（G1 restore）。测试时长 ~8s 可接受。

**E2E 用例 3（可选，若前两个已覆盖 G4 则略）**：略——G4 由单测覆盖，不在 E2E 层重复。

- [ ] **Step 1: 重写 stub 与 E2E**（保留 node-pty skip 守卫、freshRoot/waitFor/send 约定）
- [ ] **Step 2: 跑 E2E**
  Run: `node --test test/pty-attach-cold-start-e2e.test.mjs` → 两用例 PASS（用例 1 ~10-12s；用例 2 ~8s）
- [ ] **Step 3: Commit**
```bash
git add test-support/fake-coldstart-tui-pi.mjs test/pty-attach-cold-start-e2e.test.mjs
git commit -m "test: hold-protocol E2E cold-start and shell-fallback cases (issue #25)"
```

---

### Task 4: 全量验证 + spec 对照

- [ ] **Step 1**: `npm run typecheck` 干净；`npm test` 全绿（含新 E2E）
- [ ] **Step 2**: 对照 spec 验收 1/2/3/4：E2E ≤3s ✓；shell G1 兜底 ✓；8 风险面守卫测试映射清单（写进 commit 后的验证评论）✓
- [ ] **Step 3**: `git status --short` 空；`git log --oneline main..HEAD` = 5 commits（spec+plan+3 任务）
