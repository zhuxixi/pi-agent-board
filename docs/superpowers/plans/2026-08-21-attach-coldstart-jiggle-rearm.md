# Attach 冷启动双光标根治（jiggle 重试链编排修复）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 attach 的 jiggle 重试链在冷启动场景可靠落地——首个 TUI 帧（`\x1b[?2026h`）触发一次性 re-arm、退避拉长到 56.12s、jiggle restore 延时 200ms，并用确定性 E2E 验证。

**Architecture:** 纯逻辑层 `src/core/pty-attach-jiggle-retry.mjs` 扩展帧检测；编排逻辑抽成可注入控制器 `src/core/pty-attach-jiggle-controller.mjs`（scheduler/sendJiggle/shouldFire 注入）；`src/ui/pty-attach.ts` 退化为薄 adapter；E2E 用真实 pty-runner + stub 冷启动子进程驱动真实控制器。

**Tech Stack:** Node 24（node:test）、TypeScript（tsc --noEmit）、node-pty、@xterm/headless。

## Global Constraints

- 工作目录必须是 worktree：`/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm`（**禁碰主 checkout**）。
- 退避表精确值：`[120, 500, 1500, 3000, 6000, 10000, 15000, 20000]`（8 次，累计 56120ms）。
- `JIGGLE_RESTORE_MS = 200`。
- 帧开始序列：`\x1b[?2026h`；全清序列：`\x1b[2J`。跨 chunk carry 长度 = 7。
- re-arm 每次连接仅一次（`tuiFrameSeen` 锁存）；同一 chunk 同时出现 frame-start 与 clear 时 **clear 优先**。
- 代码风格跟随仓库：tab 缩进、双引号、core 模块用 `.mjs` + JSDoc typedef（参照 `pty-attach-jiggle-retry.mjs` 现有风格）。
- commit message 用 conventional commits（英文）。
- `git add <file>` 按文件 stage，禁止 `git add -A`。
- Spec：`docs/superpowers/specs/2026-08-21-attach-coldstart-jiggle-rearm-design.md`（已提交 6043f38）。

---

### Task 1: 纯逻辑层扩展 — 帧开始检测 + carry 扩 7 字节 + 新退避表

**Files:**
- Modify: `src/core/pty-attach-jiggle-retry.mjs`
- Test: `test/pty-attach-jiggle-retry.test.mjs`

**Interfaces:**
- Consumes: 现有 `feedOutput(state, data, carry)`、`BACKOFF_MS`、`MAX_RETRIES`。
- Produces:
  - `hasTuiFrameStart(data: string): boolean` — 是否含 `\x1b[?2026h`。
  - `feedOutput(...)` 返回值新增 `frameStartFound: boolean`（Task 2 的控制器依赖此字段）。
  - `BACKOFF_MS = [120, 500, 1500, 3000, 6000, 10000, 15000, 20000]`，`MAX_RETRIES = 8`。
  - `CARRY_LEN = 7`（不导出，行为体现在跨 chunk 检测上）。

- [ ] **Step 1: 写失败测试（追加到 test/pty-attach-jiggle-retry.test.mjs 末尾）**

```js
// --- hasTuiFrameStart ---

test("detects \\x1b[?2026h in plain data", () => {
	assert.equal(hasTuiFrameStart("noise\x1b[?2026hframe"), true);
});

test("rejects data without \\x1b[?2026h", () => {
	assert.equal(hasTuiFrameStart("plain output\x1b[2J"), false);
});

test("feedOutput detects frame start split across chunks", () => {
	const state = createJiggleRetryState();
	const first = feedOutput(state, "abc\x1b[?20", "");
	assert.equal(first.frameStartFound, false);
	const second = feedOutput(first.state, "26h rest", first.carry);
	assert.equal(second.frameStartFound, true);
});

test("feedOutput detects clear split across chunks after carry widening", () => {
	const state = createJiggleRetryState();
	const first = feedOutput(state, "abc\x1b[2", "");
	assert.equal(first.clearFound, false);
	const second = feedOutput(first.state, "J rest", first.carry);
	assert.equal(second.clearFound, true);
});

test("feedOutput reports both flags when one chunk has both sequences", () => {
	const state = createJiggleRetryState();
	const r = feedOutput(state, "\x1b[?2026h\x1b[2J\x1b[H", "");
	assert.equal(r.frameStartFound, true);
	assert.equal(r.clearFound, true);
	assert.equal(r.state.clearDetected, true);
});

test("new backoff table: 8 retries totaling 56120ms", () => {
	assert.deepEqual([...BACKOFF_MS], [120, 500, 1500, 3000, 6000, 10000, 15000, 20000]);
	assert.equal(MAX_RETRIES, 8);
	assert.equal(BACKOFF_MS.reduce((a, b) => a + b, 0), 56120);
	let s = createJiggleRetryState();
	const delays = [];
	for (let d = nextRetryDelay(s); d !== null; d = nextRetryDelay(s)) {
		delays.push(d);
		s = advanceRetry(s);
	}
	assert.deepEqual(delays, [...BACKOFF_MS]);
});
```

并把文件头部的 import 改为同时引入 `hasTuiFrameStart`：

```js
import {
	advanceRetry,
	BACKOFF_MS,
	createJiggleRetryState,
	feedOutput,
	hasFullClearSequence,
	hasTuiFrameStart,
	MAX_RETRIES,
	nextRetryDelay,
	stopRetry,
} from "../src/core/pty-attach-jiggle-retry.mjs";
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm && node --test test/pty-attach-jiggle-retry.test.mjs 2>&1 | tail -5`
Expected: FAIL（`hasTuiFrameStart is not a function` / 退避表断言失败）

- [ ] **Step 3: 实现（src/core/pty-attach-jiggle-retry.mjs）**

修改点（保持其余导出与 JSDoc 风格不变）：

```js
export const BACKOFF_MS = Object.freeze([120, 500, 1500, 3000, 6000, 10000, 15000, 20000]);
export const MAX_RETRIES = BACKOFF_MS.length;

const FULL_CLEAR = "\x1b[2J";
const TUI_FRAME_START = "\x1b[?2026h";
/** Carry enough bytes to catch either target sequence split at a chunk boundary. */
const CARRY_LEN = TUI_FRAME_START.length - 1; // 7
```

`feedOutput` 改为：

```js
export function feedOutput(state, data, carry) {
	const combined = carry + data;
	const clearFound = hasFullClearSequence(combined);
	const frameStartFound = hasTuiFrameStart(combined);
	const newCarry = tailCarry(combined);
	const newState = clearFound ? { ...state, clearDetected: true } : state;
	return { state: newState, carry: newCarry, clearFound, frameStartFound };
}
```

（注意：newCarry 不再因 clearFound 置空，统一走 tailCarry——clear 命中后链即停，carry 无影响；frameStart 命中后保留尾部 carry 可避免漏掉紧邻的半条 clear。）

新增导出：

```js
/**
 * Check if data contains the TUI frame-start (synchronized output) sequence.
 * pi-tui begins every frame with \x1b[?2026h; boot-time extension output never
 * contains it, so the first occurrence marks "child TUI has started rendering".
 * @param {string} data
 * @returns {boolean}
 */
export function hasTuiFrameStart(data) {
	return data.includes(TUI_FRAME_START);
}
```

`tailCarry` 注释里的 `CARRY_LEN` 说明同步更新即可（函数体不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm && node --test test/pty-attach-jiggle-retry.test.mjs 2>&1 | tail -5`
Expected: PASS（含既有用例不回归）

- [ ] **Step 5: Commit**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm
git add src/core/pty-attach-jiggle-retry.mjs test/pty-attach-jiggle-retry.test.mjs
git commit -m "feat: detect TUI frame start, widen carry, extend jiggle backoff (issue #10)"
```

---

### Task 2: 新建可注入控制器 `pty-attach-jiggle-controller.mjs` + 单测

**Files:**
- Create: `src/core/pty-attach-jiggle-controller.mjs`
- Test: `test/pty-attach-jiggle-controller.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `createJiggleRetryState / feedOutput / nextRetryDelay / advanceRetry / stopRetry`。
- Produces（Task 3 组件与 Task 4 E2E 都依赖）：
  - `createJiggleRetryController(deps)`，deps:
    - `sendJiggle: () => void` — 触发一次对子端的 resize jiggle。
    - `setTimeoutFn: (fn: () => void, ms: number) => unknown` — 注入计时器。
    - `clearTimeoutFn: (timer: unknown) => void`。
    - `shouldFire?: () => boolean` — 重试计时器触发时的守卫；返回 false 则不开枪并停链。
  - 返回 `{ start, feed, stop, getState }`：
    - `start(): void` — 重置全部状态（含 carry、`tuiFrameSeen`），按退避表排第一个重试。
    - `feed(data: string): void` — 喂 socket output；clear 优先停链；否则首个 frame-start 且未锁存时 re-arm（重置链、预算计满）。
    - `stop(): void` — 清计时器并 stopRetry。
    - `getState(): { retryIndex, clearDetected, stopped, tuiFrameSeen }`。

- [ ] **Step 1: 写失败测试 test/pty-attach-jiggle-controller.test.mjs**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiggleRetryController } from "../src/core/pty-attach-jiggle-controller.mjs";

/** Fake scheduler: 记录计时器，手动触发。 */
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
		clearTimeoutFn(id) {
			timers.delete(id);
		},
		/** 触发当前唯一（或指定）计时器 */
		fireNext() {
			const first = timers.entries().next().value;
			assert.ok(first, "expected a pending timer");
			timers.delete(first[0]);
			first[1].fn();
		},
		get pendingDelays() {
			return [...timers.values()].map((t) => t.ms);
		},
	};
}

function makeController(overrides = {}) {
	const scheduler = fakeScheduler();
	const jiggles = [];
	const controller = createJiggleRetryController({
		sendJiggle: () => jiggles.push(Date.now()),
		setTimeoutFn: scheduler.setTimeoutFn,
		clearTimeoutFn: scheduler.clearTimeoutFn,
		...overrides,
	});
	return { controller, scheduler, jiggles };
}

test("start schedules first retry at 120ms and firing sends jiggle + advances", () => {
	const { controller, scheduler, jiggles } = makeController();
	controller.start();
	assert.deepEqual(scheduler.pendingDelays, [120]);
	scheduler.fireNext();
	assert.equal(jiggles.length, 1);
	assert.deepEqual(scheduler.pendingDelays, [500]);
	assert.equal(controller.getState().retryIndex, 1);
});

test("feed with clear stops chain and marks clearDetected", () => {
	const { controller, scheduler } = makeController();
	controller.start();
	controller.feed("prefix\x1b[2J\x1b[H");
	const s = controller.getState();
	assert.equal(s.clearDetected, true);
	assert.equal(s.stopped, true);
	assert.equal(scheduler.timers.size, 0);
});

test("first TUI frame re-arms the chain with a fresh budget (latch)", () => {
	const { controller, scheduler, jiggles } = makeController();
	controller.start();
	scheduler.fireNext(); // retry 1 fired, budget now at 500ms
	controller.feed("\x1b[?2026h first frame");
	assert.equal(controller.getState().tuiFrameSeen, true);
	assert.equal(controller.getState().retryIndex, 0);
	assert.deepEqual(scheduler.pendingDelays, [120]);
	// second frame does NOT re-arm again
	controller.feed("\x1b[?2026h another frame");
	assert.deepEqual(scheduler.pendingDelays, [120]);
	scheduler.fireNext();
	assert.equal(jiggles.length, 2);
});

test("clear wins when one chunk contains both frame-start and clear", () => {
	const { controller } = makeController();
	controller.start();
	controller.feed("\x1b[?2026h\x1b[2J");
	const s = controller.getState();
	assert.equal(s.clearDetected, true);
	assert.equal(s.stopped, true);
	assert.equal(s.tuiFrameSeen, false);
});

test("re-arm fires even after the chain exhausted (cold-boot case)", () => {
	const { controller, scheduler, jiggles } = makeController();
	controller.start();
	for (let i = 0; i < 8; i++) scheduler.fireNext(); // drain all retries
	assert.equal(controller.getState().stopped, true);
	assert.equal(jiggles.length, 8);
	controller.feed("late frame \x1b[?2026h");
	assert.equal(controller.getState().stopped, false);
	assert.deepEqual(scheduler.pendingDelays, [120]);
});

test("shouldFire=false stops the chain without firing", () => {
	const { controller, scheduler, jiggles } = makeController({
		shouldFire: () => false,
	});
	controller.start();
	scheduler.fireNext();
	assert.equal(jiggles.length, 0);
	assert.equal(controller.getState().stopped, true);
});

test("full backoff schedule matches spec table then stops", () => {
	const { controller, scheduler } = makeController();
	controller.start();
	const seen = [];
	for (let i = 0; i < 8; i++) {
		seen.push(...scheduler.pendingDelays);
		scheduler.fireNext();
	}
	assert.deepEqual(seen, [120, 500, 1500, 3000, 6000, 10000, 15000, 20000]);
	assert.equal(scheduler.timers.size, 0);
	assert.equal(controller.getState().stopped, true);
});

test("start() resets latch and carry for a fresh connection", () => {
	const { controller } = makeController();
	controller.start();
	controller.feed("\x1b[?2026h frame");
	controller.start();
	assert.equal(controller.getState().tuiFrameSeen, false);
	assert.equal(controller.getState().retryIndex, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm && node --test test/pty-attach-jiggle-controller.test.mjs 2>&1 | tail -3`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/core/pty-attach-jiggle-controller.mjs**

```js
/**
 * Injectable orchestration for the attach jiggle-retry chain.
 *
 * Owns the retry state machine, backoff timers, cross-chunk scanning, and the
 * one-shot re-arm on the child TUI's first frame (\x1b[?2026h). The attach
 * component (and the cold-start E2E) drive it through injected callbacks, so
 * the whole choreography is testable without a TUI or socket.
 *
 * Cold-start design (issue #10): the chain starts at socket connect, but a cold
 * child pi-tui installs its SIGWINCH listener only ~5s in — every early jiggle
 * is lost. When the first TUI frame arrives we re-arm once with a fresh budget,
 * so the next jiggle lands on a live TUI and its fullRender emits \x1b[2J,
 * which stops the chain. If pi-tui ever drops the 2026h sequence, this degrades
 * to the plain connect-time chain (still better than the old one-shot).
 */
import {
	advanceRetry,
	createJiggleRetryState,
	feedOutput,
	nextRetryDelay,
	stopRetry,
} from "./pty-attach-jiggle-retry.mjs";

/**
 * @typedef {Object} JiggleRetryControllerDeps
 * @property {() => void} sendJiggle - Fire one resize jiggle at the child.
 * @property {(fn: () => void, ms: number) => unknown} setTimeoutFn - Timer factory.
 * @property {(timer: unknown) => void} clearTimeoutFn - Timer canceller.
 * @property {() => boolean} [shouldFire] - Guard on retry fire; false stops the chain without firing.
 */

/**
 * @param {JiggleRetryControllerDeps} deps
 */
export function createJiggleRetryController(deps) {
	const { sendJiggle, setTimeoutFn, clearTimeoutFn, shouldFire } = deps;
	let state = createJiggleRetryState();
	let carry = "";
	let tuiFrameSeen = false;
	/** @type {unknown | null} */
	let timer = null;

	function clearTimer() {
		if (timer === null) return;
		clearTimeoutFn(timer);
		timer = null;
	}

	function scheduleNext() {
		const delay = nextRetryDelay(state);
		if (delay === null) {
			state = stopRetry(state);
			return;
		}
		timer = setTimeoutFn(() => {
			timer = null;
			if (shouldFire && !shouldFire()) {
				state = stopRetry(state);
				return;
			}
			sendJiggle();
			state = advanceRetry(state);
			scheduleNext();
		}, delay);
	}

	/** Reset everything (fresh connection) and schedule the first retry. */
	function start() {
		clearTimer();
		state = createJiggleRetryState();
		carry = "";
		tuiFrameSeen = false;
		scheduleNext();
	}

	/**
	 * Feed one socket output chunk. Clear detection wins over re-arm when both
	 * sequences appear in one chunk (a hot attach's first frame is often the
	 * fullRender we were waiting for). Re-arm fires at most once per start().
	 * @param {string} data
	 */
	function feed(data) {
		const result = feedOutput(state, data, carry);
		state = result.state;
		carry = result.carry;
		if (result.clearFound) {
			clearTimer();
			state = stopRetry({ ...state, clearDetected: true });
			return;
		}
		if (result.frameStartFound && !tuiFrameSeen) {
			tuiFrameSeen = true;
			clearTimer();
			state = createJiggleRetryState();
			scheduleNext();
		}
	}

	/** Stop the chain (component closed, etc.). */
	function stop() {
		clearTimer();
		state = stopRetry(state);
	}

	return {
		start,
		feed,
		stop,
		getState: () => ({ ...state, tuiFrameSeen }),
	};
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm && node --test test/pty-attach-jiggle-controller.test.mjs 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm
git add src/core/pty-attach-jiggle-controller.mjs test/pty-attach-jiggle-controller.test.mjs
git commit -m "feat: injectable jiggle retry controller with one-shot TUI-frame rearm (issue #10)"
```

---

### Task 3: 组件接入控制器 + `JIGGLE_RESTORE_MS = 200`

**Files:**
- Modify: `src/ui/pty-attach.ts`

**Interfaces:**
- Consumes: Task 2 的 `createJiggleRetryController`。
- Produces: 常量 `JIGGLE_RESTORE_MS = 200`（模块级，靠近其他常量）；组件不再直接 import `pty-attach-jiggle-retry.mjs`。

- [ ] **Step 1: 改 import（替换整个 jiggle-retry import 块）**

把：

```ts
import {
	createJiggleRetryState,
	feedOutput as feedJiggleRetry,
	nextRetryDelay,
	advanceRetry,
	stopRetry,
} from "../core/pty-attach-jiggle-retry.mjs";
```

替换为：

```ts
import { createJiggleRetryController } from "../core/pty-attach-jiggle-controller.mjs";
```

- [ ] **Step 2: 替换字段（删除旧重试字段，加控制器与常量）**

删除这三个字段：

```ts
	// Jiggle retry chain: re-send resize jiggle until we see a full-clear sequence
	// in the PTY output, proving the child pi-tui did a fullRender and the replay
	// garbage has been flushed. Replaces the one-shot forceChildRedrawAfterLiveOutput.
	private jiggleRetryState = createJiggleRetryState();
	private jiggleRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private clearCarry = "";
```

替换为：

```ts
	// Jiggle retry chain: re-send resize jiggle until we see a full-clear sequence
	// in the PTY output, proving the child pi-tui did a fullRender and the replay
	// garbage has been flushed. The controller re-arms once on the child TUI's
	// first frame so cold-start attaches get a fresh budget exactly when the
	// child can finally observe a resize (issue #10).
	private readonly jiggleRetry = createJiggleRetryController({
		sendJiggle: () => this.forceChildRedraw(),
		shouldFire: () => !this.closed && this.connected,
		setTimeoutFn: (fn, ms) => {
			const t = setTimeout(fn, ms);
			t.unref?.();
			return t;
		},
		clearTimeoutFn: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
	});
```

在模块常量区（`TERMINAL_PASSTHROUGH_CARRY_MAX_BYTES` 附近）加：

```ts
/** Delay between the shrink and restore halves of a resize jiggle. 200ms keeps
 * the two SIGWINCHs apart well beyond pi-tui's 16ms render throttle, so a busy
 * (booting) child processes them as two separate renders instead of coalescing
 * the pair into a net-zero size change. */
const JIGGLE_RESTORE_MS = 200;
```

- [ ] **Step 3: 替换 connect/output/close 三处调用点**

connect 处理器里把 `this.startJiggleRetry();` 改为 `this.jiggleRetry.start();`。

`checkClearSequence` 整方法替换为：

```ts
	/** Feed socket output into the jiggle retry controller (clear/frame detection). */
	private checkClearSequence(data: string): void {
		this.jiggleRetry.feed(data);
	}
```

`close()` 里把 `this.cancelJiggleRetry();` 改为 `this.jiggleRetry.stop();`。

删除以下三个方法（全部被控制器接管）：`startJiggleRetry`、`scheduleNextJiggleRetry`、`cancelJiggleRetry`。

- [ ] **Step 4: jiggle restore 延时 40 → JIGGLE_RESTORE_MS**

`forceChildRedraw` 里把：

```ts
		}, 40);
```

改为：

```ts
		}, JIGGLE_RESTORE_MS);
```

- [ ] **Step 5: typecheck + 全量单测**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm && npm run typecheck 2>&1 | tail -5 && node --test test/*.test.mjs 2>&1 | tail -8`
Expected: typecheck 无错误；全部测试 PASS（pty-attach-render 等既有用例不回归）

- [ ] **Step 6: Commit**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm
git add src/ui/pty-attach.ts
git commit -m "feat: wire jiggle controller into attach component, 200ms jiggle restore (issue #10)"
```

---

### Task 4: 冷启动 E2E — stub 子进程 + 真 runner + 真控制器

**Files:**
- Create: `test-support/fake-coldstart-tui-pi.mjs`
- Test: `test/pty-attach-cold-start-e2e.test.mjs`

**Interfaces:**
- Consumes: Task 2 控制器；`runner/pty-runner.mjs`（config 协议参照 `test/pty-runner.integration.test.mjs`）；`src/core/paths.mjs` 的 `controlSocketPath/hostConfigPath`；`src/core/store.mjs` 的 `createView/readHost`；`src/core/atomic.mjs` 的 `atomicWriteJson`。
- Produces: 证明"延迟 8s 启动 TUI 的冷子进程，在控制器编排下 30s 内发出 \x1b[2J 且被链检测到自停"。

- [ ] **Step 1: 写 stub 子进程 test-support/fake-coldstart-tui-pi.mjs**

```js
#!/usr/bin/env node
/**
 * Fake cold-booting pi for the attach jiggle E2E (issue #10).
 *
 * Prints boot noise immediately, then after STUB_TUI_DELAY_MS "starts the TUI":
 * installs the stdout resize listener (SIGWINCHes before this point are lost,
 * exactly like a booting pi-tui) and emits frames wrapped in \x1b[?2026h/l.
 * Any resize observed after start triggers a fullRender-style write containing
 * the full clear sequence \x1b[2J\x1b[H\x1b[3J.
 */
const delay = Number(process.env.STUB_TUI_DELAY_MS ?? 8000);

process.stdout.write("boot: loading extensions...\n");

let started = false;
function startTui() {
	if (started) return;
	started = true;
	process.stdout.on("resize", () => {
		process.stdout.write(
			`\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jframe@${process.stdout.columns}x${process.stdout.rows}\x1b[?2026l`,
		);
	});
	process.stdout.write("\x1b[?2004h\x1b[?25l");
	frame();
}
function frame() {
	process.stdout.write("\x1b[?2026hstub: working...\x1b[?2026l");
}
setTimeout(startTui, delay);
setInterval(() => {
	if (started) frame();
}, 100);
setInterval(() => {}, 1000); // keep alive
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
```

- [ ] **Step 2: 写 E2E 测试 test/pty-attach-cold-start-e2e.test.mjs**

```js
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { createJiggleRetryController } from "../src/core/pty-attach-jiggle-controller.mjs";

const hasNodePty = await import("node-pty").then(
	() => true,
	() => false,
);

function send(socket, msg) {
	socket.write(JSON.stringify(msg) + "\n");
}

async function waitFor(predicate, timeoutMs = 10000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting");
}

// The stub TUI starts 8s in — beyond the OLD chain's ~5.12s window, so only the
// TUI-frame re-arm (issue #10) can produce a clear. Old choreography fails this.
test(
	"cold-start attach: chain re-arms on first TUI frame and sees full clear",
	{ skip: !hasNodePty && "node-pty unavailable", timeout: 45000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "agentview-coldstart-"));
		let runner;
		let socket;
		const t0 = Date.now();
		try {
			const meta = createView(root, { id: "cold1", name: "cold", cwd: process.cwd() });
			atomicWriteJson(P.hostConfigPath(root, "cold1"), {
				root,
				viewId: "cold1",
				sessionFile: meta.sessionFile,
				cwd: process.cwd(),
				initialPrompt: null,
				piCommand: process.execPath,
				piArgsPrefix: [resolve("test-support/fake-coldstart-tui-pi.mjs")],
				model: null,
				tools: null,
				env: { STUB_TUI_DELAY_MS: "8000" },
				cols: 120,
				rows: 36,
			});
			runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), P.hostConfigPath(root, "cold1")], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			await waitFor(() => existsSync(P.controlSocketPath(root, "cold1")) && readHost(root, "cold1")?.state === "alive");

			socket = createConnection(P.controlSocketPath(root, "cold1"));
			await once(socket, "connect");

			let clearAt = null;
			const controller = createJiggleRetryController({
				sendJiggle: () => {
					send(socket, { type: "resize", cols: 195, rows: 38 });
					setTimeout(() => send(socket, { type: "resize", cols: 196, rows: 39 }), 200);
				},
				setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
				clearTimeoutFn: (t) => clearTimeout(t),
			});
			controller.start(); // connect-time chain, like the component
			send(socket, { type: "hello", clientId: "e2e", wantOutput: true });
			send(socket, { type: "resize", cols: 196, rows: 39 }); // initial sendResize

			let buf = "";
			socket.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line);
						if (msg.type === "output" && typeof msg.data === "string") {
							controller.feed(msg.data);
							if (clearAt === null && msg.data.includes("\x1b[2J")) {
								clearAt = Date.now() - t0;
							}
						}
					} catch {}
				}
			});

			await waitFor(() => clearAt !== null, 30000);
			// 下界证明清屏来自 TUI 启动之后；上界 <11.1s 证明是 re-arm（首帧+120ms）
			// 而非退避尾部第 6 档（11.12s 才能命中）——旧表最后一档 5.12s 注定失败。
			assert.ok(clearAt >= 7800, `clear arrived too early (${clearAt}ms) — not from the re-armed chain`);
			assert.ok(clearAt <= 10000, `clear arrived too late (${clearAt}ms) — re-arm did not fire`);
			const s = controller.getState();
			assert.equal(s.clearDetected, true);
			assert.equal(s.stopped, true);
			assert.equal(s.tuiFrameSeen, true);
			controller.stop();
		} finally {
			try { socket?.end(); } catch {}
			try { runner?.kill("SIGTERM"); } catch {}
			rmSync(root, { recursive: true, force: true });
		}
	},
);
```

- [ ] **Step 3: 跑 E2E 确认通过**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm && node --test test/pty-attach-cold-start-e2e.test.mjs 2>&1 | tail -6`
Expected: PASS（总时长约 9-12s；若环境无 node-pty 则显示 skip，不 FAIL）

- [ ] **Step 4: Commit**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm
git add test-support/fake-coldstart-tui-pi.mjs test/pty-attach-cold-start-e2e.test.mjs
git commit -m "test: cold-start attach E2E with delayed-TUI stub child (issue #10)"
```

---

### Task 5: 全量验证 + 收尾

**Files:**
- 无新增（仅验证）

**Interfaces:**
- Consumes: Task 1-4 全部产物。

- [ ] **Step 1: 完整验证**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm && npm run typecheck 2>&1 | tail -3 && npm test 2>&1 | tail -8`
Expected: typecheck 干净；全部测试 PASS（E2E 在内；总时长 <60s）

- [ ] **Step 2: 复核 spec 验收标准逐条对照**

对照 `docs/superpowers/specs/2026-08-21-attach-coldstart-jiggle-rearm-design.md` 验收标准 1/2/4：
1. E2E 通过且 stub 8s > 旧窗口 5.12s（旧编排必失败）✓
2. 新增单测通过、既要不回归、typecheck 过 ✓
4. 热 session 行为：控制器在 connect 链照常启动、见 clear 自停（Task 2 单测覆盖）✓
（验收 3 为人工实机验证，合并前由用户确认。）

- [ ] **Step 3: 提交收尾（如有遗漏文件）**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-10-attach-coldstart-jiggle-rearm
git status --short
# 应为空；若有遗漏，按文件 git add 后 git commit -m "chore: ..." 
git log --oneline main..HEAD
```

Expected: 5 个 commit（spec + 4 个任务 commit）
