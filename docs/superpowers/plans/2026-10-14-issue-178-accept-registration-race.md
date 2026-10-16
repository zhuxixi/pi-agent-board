# accept-注册竞态修复（issue #178）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `subscribe_terminal` 与 `editor_state` 两条签名在负载下的等待假设，从「一次性 boot banner / TCP connect」改成事件驱动、可证伪的等待，使失败不可能再发生（而不是把预算调大）。

**Architecture:** 只动测试与测试支撑代码，零生产行为改动。核心是一个新的 `test-support/echo-probe.mjs`（sleep 驱动的回声探针，I/O 全注入），用「假 pi 回显每一条输入」这一既有事实替代「等一次性横幅」；`subscribe_terminal`、A5 burst 用例改用它，`editor_state` 补服务端 hello 等待，`control-reconcile` 的等待点补现场覆盖。同时给 `capturePostmortem` 加 `screenLogTail`，让下一次红自带现场。

**Tech Stack:** Node.js（内置 `node:test` + `assert/strict`）、ESM `.mjs`、`@xterm/headless`（经 `src/core/terminal-model.mjs` 间接使用）、无新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-14-issue-178-accept-registration-race-design.md`（v4，sha256 `dce831a192d40c8b70dc234da4b6778cdb5a2cac303123d6cf9ea26354c9c975`）
**Worktree:** `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-178-accept-registration-race`（下称 `$WT`）

## Global Constraints

以下约束对**每个** task 都生效，逐条照抄自 spec：

- **test-only**：不改 `runner/`、`src/` 的生产行为；不改 `.github/workflows/ci.yml`；不做测试串行化；不新增依赖；不重命名任何测试文件。
- **缩进用 Tab**；**注释与 commit message 一律英文**（`AGENTS.md` Conventions）。spec §3.1 的样板 JSDoc 已是英文。
- **`--test-name-pattern` 只允许正模式，且 flag 必须在位置参数文件之前**：`node --test --test-name-pattern <模式> <文件>`。写在文件之后时 node 会静默忽略该 flag 并跑满全文件（本机 node v24.13.0 实测 `pass 7` vs `pass 1`）。**不得使用负模式**（`(?!X)` 类）。
- **等待预算**：新增/改动的等待走各文件既有的 `waitFor`（默认 15000ms）或既有显式值，**不得新增用例级 `timeout` 声明**——`test/budget-audit.test.mjs` 必须继续零违规。
- **覆盖率阈值**：Lines ≥85 / Funcs ≥80 / Branches ≥70（`.c8rc.json` exclude `test/**`、`test-support/**`，故本改动不影响阈值）。
- **断言不变性（硬约束）**：`subscribe_terminal` 用例里的 `frame.data.includes("fake pi ready")` 与 `begin.snapshotSeq >= 1` 两条断言**原样保留、原样通过**。不许删除或弱化。
- **commit 纪律**：本 plan 的 commit 步骤**需要用户明确许可后才执行**（operator 全局规则：不自动 commit）。commit subject 用 conventional 格式；仓的 changelog 生成器允许 `(#N)` 后缀缺省，PR 号在开 PR 后补。
- **禁止** `git add -A`（按文件 stage）；**禁止** `git checkout -b` / `git switch -c`（worktree 已建好）。
- 所有编辑路径以 `$WT` 开头；git 操作用 `git -C $WT`。

## 验收追溯（spec 验收矩阵 ↔ 本 plan 的 task）

双向对账表。左列是 spec 的验收 ID，右列是承载它的 task；反向也成立——每个 task 至少有一个 ID 归属。

| 验收 ID | spec 的功能点 | 承载 task |
|---|---|---|
| A1 | echo-probe helper 行为 | Task 1 |
| A2 | subscribe_terminal 行为不变（含删断言不可变绿） | Task 3（行为）+ Task 7（静态守门） |
| A3 | editor_state 注册证明 + 现场接线 | Task 4（行为与接线）+ Task 7（静态守门） |
| A4 | 确定性复现 before/after（负载无关） | Task 5 |
| A5 | postmortem 的 `screenLogTail` 尾巴 | Task 2 |
| A6① | 补丁前阳性控制轮 | Task 9 Step 1 |
| A6② | 修后全量负载剖面 ≥5 轮 + `verify` ≥2 轮 | Task 9 Step 2 |
| A6b | 隔离冒烟 ≥10 轮 | Task 6 Step 5（A5 迁移后）+ Task 9 Step 3 |
| A7 | 全量与门禁（budget-audit、覆盖率、ci.yml、接线断言） | Task 7（静态）+ Task 8（D7 接线）+ Task 9 Step 4 |
| U1 | 两条签名在 CI 观察窗消失（用户实测） | Task 10（post-merge，不阻塞 PR） |

**命名冲突提醒**：spec 的验收项 `A5`（postmortem 尾巴）与 `test/terminal-snapshot.integration.test.mjs` 里那个叫 `A5: burst …` 的**用例**是两个东西。下文凡指用例一律写「A5 burst 用例」。spec 的 D1 提到的「与 A5 共享」也是指那个用例。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `test-support/echo-probe.mjs` | 回声探针：唯一的职责是「按 interval 发探针」，判定留给调用方 | 新建 |
| `test-support/flake-postmortem.mjs` | 现场黑盒：采集/渲染失败现场；新增 `screenLogTail` 与纯函数 `tailSlice` | 修改 |
| `test/pty-runner.integration.test.mjs` | 三条用例：`subscribe_terminal` 改写、`editor_state` 补等待与接线、新增确定性复现用例 | 修改 |
| `test/terminal-snapshot.integration.test.mjs` | A5 burst 用例的内联探针循环迁到共享 helper | 修改 |
| `test/control-reconcile.integration.test.mjs` | 本地 `waitFor` 扩签名；A2 用例体全部等待点接 capture | 修改 |
| `test/echo-probe.test.mjs` | A1 单测（纯 fake 注入，不依赖真实定时器） | 新建 |
| `test/wait-capture-wiring.test.mjs` | A3/A7 静态接线断言（读真实测试源码） | 新建 |
| `test/flake-postmortem.test.mjs` | A5 的 fixture 单测（文件存在 / 缺失 / 超长截断） | 修改 |

---

## Task 1: echo-probe helper（A1）

**Files:**
- Create: `$WT/test-support/echo-probe.mjs`
- Test: `$WT/test/echo-probe.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces: `createEchoProbe({ send, intervalMs?, sleep? })` → `{ line(), start(), stop() }`。
  - `send: (line: string) => void`，收到的 `line` 形如 `"boot-probe-3\r"`。
  - `intervalMs` 默认 `300`；`sleep` 默认 `(ms) => new Promise((r) => setTimeout(r, ms))`。
  - `start()` 后**同步**发出第一发探针（t≈0，编号 1），随后进入 `await sleep(intervalMs)` 循环。
  - `stop()` 幂等；置停止标志，在途 `sleep` 返回后不再发送。
  - `line()` 返回最近一次已发送的探针行（诊断用；helper 自身不判定、不断言）。
  - `send` 抛错时循环停止并把异常吞掉（不产生 unhandled rejection）——失败语义交给调用方的 `waitFor` 超时 + postmortem。

- [ ] **Step 1: 写失败的测试**

创建 `$WT/test/echo-probe.test.mjs`：

```js
/** A1 unit tests (issue #178): the echo probe is pure logic with injected I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoProbe } from "../test-support/echo-probe.mjs";

/** A controllable sleep: records the requested interval and resolves on demand. */
function manualSleep() {
	const intervals = [];
	let release = null;
	const sleep = (ms) => {
		intervals.push(ms);
		return new Promise((r) => {
			release = r;
		});
	};
	return { intervals, sleep, release: () => release?.() };
}

test("A1: the first probe fires with N=1 at start, before any interval elapses", () => {
	const sent = [];
	const io = manualSleep();
	const probe = createEchoProbe({ send: (line) => sent.push(line), sleep: io.sleep });
	probe.start();
	assert.deepEqual(sent, ["boot-probe-1\r"], "first probe is synchronous and 1-based");
	assert.deepEqual(io.intervals, [300], "default interval is 300ms");
	probe.stop();
	io.release();
});

test("A1: each interval sends the next probe with an incrementing N", () => {
	const sent = [];
	const io = manualSleep();
	const probe = createEchoProbe({ send: (line) => sent.push(line), sleep: io.sleep });
	probe.start();
	io.release();
	return new Promise((r) => setImmediate(r)).then(() => {
		assert.deepEqual(sent, ["boot-probe-1\r", "boot-probe-2\r"]);
		io.release();
		return new Promise((r) => setImmediate(r));
	}).then(() => {
		assert.deepEqual(sent, ["boot-probe-1\r", "boot-probe-2\r", "boot-probe-3\r"]);
		probe.stop();
		io.release();
	});
});

test("A1: stop() halts sending and is idempotent", async () => {
	const sent = [];
	const io = manualSleep();
	const probe = createEchoProbe({ send: (line) => sent.push(line), sleep: io.sleep });
	probe.start();
	probe.stop();
	probe.stop();
	io.release();
	await new Promise((r) => setImmediate(r));
	assert.equal(sent.length, 1, "no probe after stop()");
});

test("A1: a custom intervalMs is passed to sleep verbatim", () => {
	const io = manualSleep();
	const probe = createEchoProbe({ send: () => {}, intervalMs: 50, sleep: io.sleep });
	probe.start();
	assert.deepEqual(io.intervals, [50]);
	probe.stop();
	io.release();
});

test("A1: line() reports the most recently sent probe", () => {
	const io = manualSleep();
	const probe = createEchoProbe({ send: () => {}, sleep: io.sleep });
	assert.equal(probe.line(), "", "no probe sent yet");
	probe.start();
	assert.equal(probe.line(), "boot-probe-1\r");
	probe.stop();
	io.release();
});

test("A1: a throwing send stops the loop instead of rejecting unhandled", async () => {
	let calls = 0;
	const probe = createEchoProbe({
		send: () => {
			calls += 1;
			if (calls === 2) throw new Error("dead socket");
		},
		sleep: async () => {},
	});
	probe.start();
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	assert.equal(calls, 2, "the throwing send was the last call");
	probe.stop();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test $WT/test/echo-probe.test.mjs`
Expected: FAIL —— `Cannot find module '../test-support/echo-probe.mjs'`（6 个用例全失败）。

- [ ] **Step 3: 写最小实现**

创建 `$WT/test-support/echo-probe.mjs`：

```js
/**
 * Echo-probe wait helper for the accept-registration race (issue #178).
 *
 * A client's TCP `connect` completes before the server registers it in the
 * broadcast set, so a one-shot boot banner can be broadcast before accept and
 * is never replayed. The fake PTY echoes every input line, so a probe line
 * always produces output on a live host: sending probes until the caller
 * observes the echo is the event-driven replacement for "wait for the banner".
 *
 * Pure logic with injected I/O. The caller owns the transport, the wait loop
 * and the verdict; this helper only sends.
 */

/**
 * @param {{
 * 	send: (line: string) => void,
 * 	intervalMs?: number,
 * 	sleep?: (ms: number) => Promise<void>,
 * }} io
 * @returns {{ line: () => string, start: () => void, stop: () => void }}
 */
export function createEchoProbe({ send, intervalMs = 300, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
	let stopped = false;
	let n = 0;
	let last = "";
	const loop = async () => {
		try {
			while (!stopped) {
				n += 1;
				last = `boot-probe-${n}\r`;
				send(last);
				await sleep(intervalMs);
			}
		} catch {
			// A dead transport must not crash the suite with an unhandled rejection:
			// the caller's wait still fails loudly at its own deadline and carries
			// the postmortem. Stop probing instead of throwing.
			stopped = true;
		}
	};
	return {
		line: () => last,
		start: () => {
			void loop();
		},
		stop: () => {
			stopped = true;
		},
	};
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test $WT/test/echo-probe.test.mjs`
Expected: PASS —— `pass 6`。

- [ ] **Step 5: 跑门禁确认没踩预算规则**

Run: `node --test --test-name-pattern "the real test tree audits clean" $WT/test/budget-audit.test.mjs`
Expected: PASS —— 新测试文件无 `waitFor`/`timeout` 声明，零违规。
（注意 flag 在文件**之前**；若写成文件之后会被忽略而跑满全文件。）

- [ ] **Step 6: Commit**

```bash
cd $WT
git add test-support/echo-probe.mjs test/echo-probe.test.mjs
git commit -m "test: add echo-probe helper for the accept-registration race"
```

---

## Task 2: postmortem 的 screen.log 尾巴（A5）

**Files:**
- Modify: `$WT/test-support/flake-postmortem.mjs`
- Test: `$WT/test/flake-postmortem.test.mjs`

**Interfaces:**
- Consumes: 现有的 `readFileSync`、`screenLogPath(root, viewId)`（`src/core/paths.mjs:110`）。
- Produces:
  - `tailSlice(text, maxBytes): string` —— 纯函数，按 **UTF-8 字节**保留尾部，不劈开多字节字符；短于上限原样返回。
  - `SCREEN_LOG_TAIL_BYTES = 2048` —— 导出常量，测试与调用方共用，避免魔法数字。
  - `capturePostmortem(root, viewId, runId?)` 返回值新增 `screenLogTail: string | null`（缺失/读失败为 `null`）。
  - `formatPostmortem(snapshot)` 新增一行 `screenLogTail: "<tail>"` / `screenLogTail: <absent>`。

**为什么不用既有的 `readScreenLogTail`（设计决策，请在 CR 里按此核对）**：`src/core/screen-log.mjs` 已有 `readScreenLogTailBytes/readScreenLogTail`，但它返回的是**裸字节切片**，其 `toString("utf8")` 在切片头部落在字符中间时会产出 U+FFFD——正是 A5 要求禁止的「劈开多字节字符」。且 `capturePostmortem` 直接读文件还能走 spec 要求的纯函数分层（`tailSlice` 可单测、I/O 只有一次 `readFileSync`）。故**按 spec 新建 `tailSlice`，不复用 `readScreenLogTail`**。

- [ ] **Step 1: 写失败的测试**

在 `$WT/test/flake-postmortem.test.mjs` 顶部补 import（现有 import 保留不动）：

```js
import * as P from "../src/core/paths.mjs";
import { SCREEN_LOG_TAIL_BYTES, capturePostmortem, formatPostmortem, tailSlice, waitForWithPostmortem } from "../test-support/flake-postmortem.mjs";
```

在文件末尾追加：

```js
test("A5: tailSlice keeps short text verbatim and truncates to the byte budget", () => {
	assert.equal(tailSlice("abc", 10), "abc");
	assert.equal(tailSlice("abcdef", 3), "def", "keeps the tail, measured in bytes");
	assert.equal(tailSlice("", 3), "");
});

test("A5: tailSlice never splits a multi-byte character at the cut point", () => {
	// Each CJK character is 3 bytes; a 4-byte budget must not emit a partial char.
	const text = "中文字符";
	assert.equal(Buffer.byteLength(text, "utf8"), 12);
	const sliced = tailSlice(text, 4);
	assert.equal(sliced, "符", "cuts at the character boundary, not mid-sequence");
	assert.doesNotMatch(sliced, /\uFFFD/, "no replacement character from a split character");
	// 3 bytes is exactly one whole character: the last one survives intact.
	assert.equal(tailSlice(text, 3), "符");
	// 2 bytes lands inside that character: it is dropped, never half-emitted.
	assert.equal(tailSlice(text, 2), "");
	assert.doesNotMatch(tailSlice(text, 2), /\uFFFD/);
});

test("A5: formatPostmortem renders the screenLogTail line and marks it absent", () => {
	const present = formatPostmortem({
		status: null,
		state: null,
		host: null,
		diagnosticsTail: [],
		journalTail: [],
		screenLogTail: "fake pi ready\n",
	});
	assert.match(present, /screenLogTail: "fake pi ready\\n"/);
	const absent = formatPostmortem({ status: null, state: null, host: null, diagnosticsTail: [], journalTail: [] });
	assert.match(absent, /screenLogTail: <absent>/, "a snapshot without the field renders <absent>");
	assert.doesNotMatch(absent, /undefined/);
});

test("A5: capturePostmortem tails a real screen.log without splitting characters", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pm-log-"));
	try {
		createView(root, { id: "v", name: "t", cwd: root });
		const oversized = "x".repeat(SCREEN_LOG_TAIL_BYTES + 500) + "中文字符";
		writeFileSync(P.screenLogPath(root, "v"), oversized);
		const snap = capturePostmortem(root, "v", null);
		assert.ok(typeof snap.screenLogTail === "string", "tail captured");
		assert.ok(Buffer.byteLength(snap.screenLogTail, "utf8") <= SCREEN_LOG_TAIL_BYTES, "bounded by the byte budget");
		assert.equal(snap.screenLogTail.endsWith("中文字符"), true, "the tail is the newest output");
		assert.doesNotMatch(snap.screenLogTail, /\uFFFD/);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("A5: capturePostmortem reports an absent screen.log as null", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pm-nolog-"));
	try {
		createView(root, { id: "v", name: "t", cwd: root });
		assert.equal(capturePostmortem(root, "v", null).screenLogTail, null);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test $WT/test/flake-postmortem.test.mjs`
Expected: FAIL —— `tailSlice`/`SCREEN_LOG_TAIL_BYTES` 不是导出成员（`SyntaxError`/`undefined`），新增 5 个用例失败；原 6 个用例仍通过。

- [ ] **Step 3: 写实现**

编辑 `$WT/test-support/flake-postmortem.mjs`。

3a. 在文件顶部 import 区补 `screenLogPath`：

```js
import { screenLogPath } from "../src/core/paths.mjs";
```

3b. 在 `formatPostmortem` 之前插入常量与纯函数：

```js
/** Bytes of the screen log tail attached to a postmortem (spec D3: last ~2KB). */
export const SCREEN_LOG_TAIL_BYTES = 2048;

/**
 * Keep at most `maxBytes` bytes of the tail of a UTF-8 string without cutting
 * a multi-byte character in half. Shorter-than-limit text is returned as-is.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function tailSlice(text, maxBytes) {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let start = buf.length - maxBytes;
	// Walk forward past continuation bytes (10xxxxxx) so the slice starts at a
	// leading byte; the tail itself is intact because we only cut the head.
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
	return buf.subarray(start).toString("utf8");
}
```

3c. 在 `formatPostmortem` 的 `lines` 数组里，`journalTail` 之后追加一行：

```js
		`screenLogTail: ${snapshot.screenLogTail == null ? "<absent>" : JSON.stringify(snapshot.screenLogTail)}`,
```

3d. 更新 `formatPostmortem` 的 JSDoc `@param` 块，补一个字段（保持既有风格）：

```js
 * 	screenLogTail?: string | null,
```

3e. 更新 `capturePostmortem` 的返回值类型注释并补采集逻辑。在返回对象之前插入：

```js
	let screenLogTail = null;
	try {
		screenLogTail = tailSlice(readFileSync(screenLogPath(root, viewId), "utf8"), SCREEN_LOG_TAIL_BYTES);
	} catch {
		/* absent or unreadable screen log */
	}
```

并在 `return {` 的对象里加一项：

```js
		screenLogTail,
```

3f. 把 `capturePostmortem` 的 `@returns` 注释补上 `screenLogTail: string | null`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test $WT/test/flake-postmortem.test.mjs`
Expected: PASS —— `pass 11`（原 6 + 新 5）。

- [ ] **Step 5: Commit**

```bash
cd $WT
git add test-support/flake-postmortem.mjs test/flake-postmortem.test.mjs
git commit -m "test: add screen.log tail to the flake postmortem"
```

---

## Task 3: subscribe_terminal 改用 echo-probe（A2）

**Files:**
- Modify: `$WT/test/pty-runner.integration.test.mjs`（用例 `subscribe_terminal: snapshot + live continuity alongside legacy clients`，当前 `:1777-1875`）

**Interfaces:**
- Consumes: `createEchoProbe`（Task 1）；文件已有的 `send`、`listen`、`waitFor`、`capture`。
- Produces: 无新导出；用例行为按 D1 三条不变量保持不变。

**本 task 的关键约束**：`:1838` 与 `:1839` 两条断言（`begin.snapshotSeq >= 1`、`frame.data.includes("fake pi ready")`）**一字不改**。它们成立的理由已核实：`synthesizeFullRedrawFrame`（`src/core/terminal-snapshot.mjs:324`）把 `scrollback`（上限 `DEFAULT_SCROLLBACK_SNAPSHOT_CAP = 256` 行）与视口拼成一条连续重绘流，所以横幅只要还在尾部 256+24=280 行内就仍在 `frame.data` 里；探针收敛最多产生个位数到几十行回显，远小于该余量。

- [ ] **Step 1: 先跑一次现状，记录基线**

Run: `node --test --test-name-pattern subscribe_terminal $WT/test/pty-runner.integration.test.mjs`
Expected: PASS（隔离跑本来就绿，实测约 200ms 上下）。记下 `duration_ms` 作为对照。

- [ ] **Step 2: 加 import**

在 `$WT/test/pty-runner.integration.test.mjs` 的 import 区（`../test-support/flake-postmortem.mjs` 那一行之后）加：

```js
import { createEchoProbe } from "../test-support/echo-probe.mjs";
```

- [ ] **Step 3: 替换一次性横幅等待**

把这块（当前 `:1817-1825`）：

```js
		const legacyMessages = listen(legacy).messages;
		send(legacy, { type: "hello" });
		// Wait for the first child output on the legacy socket: it proves the
		// runner has fed its canonical model, so the subscribe below cannot hit
		// the "host starting" empty-baseline race.
		await waitFor(() => legacyMessages.find((m) => m.type === "output" && String(m.data).includes("fake pi ready")), 15000, capture);
```

改为：

```js
		const legacyMessages = listen(legacy).messages;
		send(legacy, { type: "hello" });
		// accept-registration race (issue #178): the one-shot boot banner is
		// broadcast when the child starts, which can be *before* this socket is
		// accepted — and legacy output has no replay, so waiting for it can burn
		// the whole budget. Probe with an echo instead: the fake pty echoes every
		// input, and the banner precedes any echo by construction, so an echo also
		// proves the runner has fed its canonical model (which is what keeps the
		// subscribe below off the "host starting" empty-baseline race).
		const probe = createEchoProbe({ send: (line) => send(legacy, { type: "input", data: line }) });
		probe.start();
		try {
			await waitFor(() => legacyMessages.find((m) => m.type === "output" && /boot-probe-\d/.test(String(m.data))), 15000, capture);
		} finally {
			probe.stop();
		}
```

其余一字不动。特别地：`:1838`/`:1839` 的断言、`echo:ping` 等待（`:1845`）、`frame_version_mismatch` 等待（`:1864`）都不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-name-pattern subscribe_terminal $WT/test/pty-runner.integration.test.mjs`
Expected: PASS —— `pass 1`。
（注意 flag 在文件**之前**。写成 `node --test <file> --test-name-pattern ...` 会跑满整文件，混入尚未改写的 `editor_state` 用例，负载下的红会被误归因。）

- [ ] **Step 5: 反证检查——确认断言真的还在跑**

Run: `grep -n "snapshotSeq >= 1\|includes(\"fake pi ready\")" $WT/test/pty-runner.integration.test.mjs`
Expected: 仍能命中 `:1838`、`:1839` 两处（证明没有靠删断言变绿）；Task 7 会把这条变成机械守门。

- [ ] **Step 6: Commit**

```bash
cd $WT
git add test/pty-runner.integration.test.mjs
git commit -m "test: replace the racy boot-banner wait with an echo probe in subscribe_terminal"
```

---

## Task 4: editor_state 补注册证明 + 全用例 capture 接线（A3）

**Files:**
- Modify: `$WT/test/pty-runner.integration.test.mjs`（用例 `pty-runner routes editor_state between clients, seeds hello, resets on exit`，当前 `:511-587`）

**Interfaces:**
- Consumes: 已有的 `capturePostmortem`/`formatPostmortem`、`waitFor`（第三参 `capture`，`:31`）。
- Produces: 该用例 6 处等待全部带 capture；client2 在收到服务端 hello 之后才允许 client1 推送 `editor_state`。

**依据**：跨模型复核第 1 轮真缺口 R1-G1（editor_state 是本 issue 第二条目标签名，却全程零现场）。`runner/pty-runner.mjs:375` 在 accept 回调里 `clients.add(socket)`、`:380` 立即回写 hello，所以「收到 hello」就是「已注册」的事件驱动证明。

- [ ] **Step 1: 先跑一次现状**

Run: `node --test --test-name-pattern editor_state $WT/test/pty-runner.integration.test.mjs`
Expected: PASS —— `pass 1`（当前隔离跑绿；这一步只是确认改动前基线）。

- [ ] **Step 2: 加 capture 常量**

在用例体开头（当前 `:512-513` 的 `const root = freshRoot();` / `let runner;` 之后）插入：

```js
	// issue #178 (cross-review R1-G1): this is one of the issue's two target
	// signatures, so its waits carry the same flake postmortem as
	// subscribe_terminal's — a red must arrive with a scene, not just
	// "timed out waiting".
	const capture = () => formatPostmortem(capturePostmortem(root, "v1", null));
```

- [ ] **Step 3: 给 client2 加注册证明**

把（当前 `:552-557`）：

```js
		// A second client must receive the pushed state as a broadcast.
		const client2 = createConnection(P.controlSocketPath(root, "v1"));
		await once(client2, "connect");
		const messages2 = readMessages(client2);
		send(client1, { type: "editor_state", empty: false });
		await waitFor(() => messages2.find((m) => m.type === "editor_state"));
```

改为：

```js
		// A second client must receive the pushed state as a broadcast.
		const client2 = createConnection(P.controlSocketPath(root, "v1"));
		await once(client2, "connect");
		const messages2 = readMessages(client2);
		// Registration proof (issue #178): `connect` only proves the TCP handshake.
		// The runner registers the socket and writes this unsolicited hello inside
		// the accept callback (runner/pty-runner.mjs:375/:380), so receiving it
		// means client2 is already in the broadcast set. Without this wait the push
		// below can be broadcast before registration and is never replayed.
		await waitFor(() => messages2.find((m) => m.type === "hello"), 15000, capture);
		send(client1, { type: "editor_state", empty: false });
		await waitFor(() => messages2.find((m) => m.type === "editor_state"), 15000, capture);
```

- [ ] **Step 4: 给其余 4 处等待接上 capture**

逐处把第三参补上（**只加 `, 15000, capture`，不改谓词**）：

| 当前行 | 现在 | 改为 |
|---|---|---|
| `:532` | `await waitFor(() => hostReady(root, "v1"));` | `await waitFor(() => hostReady(root, "v1"), 15000, capture);` |
| `:550` | `await waitFor(() => messages1.find((m) => m.type === "hello"));` | `await waitFor(() => messages1.find((m) => m.type === "hello"), 15000, capture);` |
| `:568` | `await waitFor(() => messages3.find((m) => m.type === "hello" && "editorEmpty" in m));` | `await waitFor(() => messages3.find((m) => m.type === "hello" && "editorEmpty" in m), 15000, capture);` |
| `:573` | `await waitFor(() => messages2.find((m) => m.type === "editor_state" && m.empty === null));` | `await waitFor(() => messages2.find((m) => m.type === "editor_state" && m.empty === null), 15000, capture);` |
| `:574` | `await waitFor(() => readHost(root, "v1")?.endedAt);` | `await waitFor(() => readHost(root, "v1")?.endedAt, 15000, capture);` |

（`:557` 已在 Step 3 覆盖，合计 6 处等待全部带电。）

`15000` 是该文件 `waitFor` 的既有默认值，显式写出不改变预算，故仍满足 budget-audit 规则 (a)。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test --test-name-pattern editor_state $WT/test/pty-runner.integration.test.mjs`
Expected: PASS —— `pass 1`。若红，读失败信息里的 postmortem 段（`screenLogTail:` 行就是本 task 刚接上的现场）。

- [ ] **Step 6: 跑门禁确认没踩预算规则**

Run: `node --test --test-name-pattern "the real test tree audits clean" $WT/test/budget-audit.test.mjs`
Expected: PASS（等待点显式写了 15000，与文件默认同值，规则 (a) 不触发；也未新增用例级 timeout）。

- [ ] **Step 7: Commit**

```bash
cd $WT
git add test/pty-runner.integration.test.mjs
git commit -m "test: wait for the server hello before pushing editor_state, and wire its postmortem"
```

---

## Task 5: 确定性复现用例（A4）

**Files:**
- Modify: `$WT/test/pty-runner.integration.test.mjs`（**追加**到文件末尾）

**Interfaces:**
- Consumes: `createEchoProbe`（Task 1）；文件已有的 `freshRoot`、`hostReady`、`waitFor`、`waitForExit`、`send`，以及已 import 的 `readFileSync`/`createConnection`/`once`/`spawn`/`resolve`/`atomicWriteJson`/`P.*`。
- 本用例**不接 capture**（它的失败形态是断言失败而非超时，且 spec 的 A4 行未要求接线）——这是**有意保持 spec 范围**的取舍，若 CR 认为新用例也该自带现场，就在两个前置等待上加 `, 15000, capture`。

**为何不能只等横幅就连接（已核实的启动顺序，别踩这个坑）**：`runner/pty-runner.mjs` 先 spawn 子进程（`:312`）后才 `server.listen`（`:407`），所以「横幅已落 screen.log」也可能早于控制 socket 绑定。直接 `createConnection` 会因 ENOENT 抛错（`events.once(socket, "connect")` 会把 `error` 事件转成 rejection）。因此 Leg 0 先等 `hostReady`（`host.state === "alive"` 只在 `listen` 回调里写，故它等价于「socket 已绑定」），再等横幅，最后才连接。两个前置等待都不影响确定性：「横幅已广播」仍由 screen.log 给出，「无重放」仍由 echo 事件驱动。
- Produces: 一条**负载无关**的用例，钉住「legacy 输出无重放」这一设计事实。它不是修复证据的替代，而是防止日后有人把横幅等待写回来的回归锁。

**关键设计点**：负断言（没收到横幅）必须由**事件**驱动——先轮询 `screen.log` 证明横幅已经广播过，再连接客户端，最后用 echo 到达证明「连接活着、输出正在流」，然后才断言没收到横幅。全程零墙钟等待，故负载无关。

- [ ] **Step 1: 写用例（追加到文件末尾）**

在 `$WT/test/pty-runner.integration.test.mjs` 末尾（`subscribe_terminal` 用例结束之后）追加：

```js
// issue #178 spec D4: the reproduction case for the accept-registration race.
// Load-independent by construction — every leg is event-driven, never a wall
// clock: poll screen.log until the banner has been broadcast, connect only
// then, and prove liveness with an echo before asserting the banner never
// arrived. This pins the design fact "legacy output has no replay"; do not
// "fix" it by waiting for the banner again.
test("accept-registration race: a legacy client that connects late never receives the already-broadcast banner", async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "v1", name: "late-join", cwd: process.cwd() });
		const configPath = P.hostConfigPath(root, "v1");
		atomicWriteJson(configPath, {
			root,
			viewId: "v1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
			model: null,
			tools: null,
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });

		// Leg 0: the runner spawns the child before it binds the control socket
		// (runner/pty-runner.mjs:312 vs :407), so gate on hostReady first —
		// host.state becomes "alive" in the listen callback, i.e. the socket is
		// bound. Connecting earlier would fail with ENOENT.
		await waitFor(() => hostReady(root, "v1"), 15000);

		// Leg 1: the banner is already out. screen.log is written from the same
		// onData path that feeds the canonical model (runner/pty-runner.mjs:333),
		// so once it contains the banner the broadcast has happened — with no
		// subscriber and no client attached.
		await waitFor(() => {
			try {
				return readFileSync(P.screenLogPath(root, "v1"), "utf8").includes("fake pi ready");
			} catch {
				return false;
			}
		}, 15000);

		// Leg 2: only now connect a legacy client. No reply carries the banner.
		const late = createConnection(P.controlSocketPath(root, "v1"));
		await once(late, "connect");
		let buf = "";
		/** @type {any[]} */
		const lateMessages = [];
		late.on("data", (chunk) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) lateMessages.push(JSON.parse(line));
		});
		send(late, { type: "hello" });

		// Leg 3: probe until the echo arrives — proof the connection is live and
		// output is flowing right now. The probe stops on convergence, so it adds
		// no load for the rest of the case.
		const probe = createEchoProbe({ send: (line) => send(late, { type: "input", data: line }) });
		probe.start();
		try {
			await waitFor(() => lateMessages.find((m) => m.type === "output" && /boot-probe-\d/.test(String(m.data))), 15000);
		} finally {
			probe.stop();
		}

		// Leg 4: both halves of the race are pinned. The echo proves output flows
		// to this socket; the missing banner proves there is no replay.
		assert.ok(
			lateMessages.some((m) => m.type === "output" && /boot-probe-\d/.test(String(m.data))),
			"the echo-probe converged: output reaches this connection",
		);
		assert.ok(
			!lateMessages.some((m) => m.type === "output" && String(m.data).includes("fake pi ready")),
			"legacy clients get no replay: the banner broadcast before accept never arrives",
		);

		late.end();
	} finally {
		try { runner?.kill("SIGTERM"); } catch {}
		await waitForExit(runner, 5000);
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 2: 记录实测耗时**

Run: `node --test --test-name-pattern accept-registration $WT/test/pty-runner.integration.test.mjs`
Expected: PASS —— `pass 1`。把输出里的 `duration_ms` 抄进 Task 9 的记录（spec A4 要求「用例在 15s 内完成（记录本地实测耗时）」）。

- [ ] **Step 3: 反向验证——负断言真的会咬人吗**

临时把 `fake-pty-pi.mjs` 的 `FAKE_PTY_HOLD` 无关改动**不要做**；改为临时把 Leg 1 的轮询删掉（即不等 screen.log 就直接连接），确认用例**仍然通过**（说明负断言不依赖轮询运气），然后**把轮询加回来**。

这一步只用于本机自查，不产生任何提交；目的是证明「负断言由事件驱动」不是空话。若删掉轮询后用例开始随机失败，说明设计退化成墙钟竞态，必须回到 Step 1 的写法。

- [ ] **Step 4: 跑整个文件确认没有互相干扰**

Run: `node --test $WT/test/pty-runner.integration.test.mjs`
Expected: PASS（全文件）。这一步同时覆盖 Task 3/4 的改动在同一文件内的相互作用。

- [ ] **Step 5: Commit**

```bash
cd $WT
git add test/pty-runner.integration.test.mjs
git commit -m "test: pin the accept-registration race with a load-independent reproduction case"
```

---

## Task 6: A5 burst 用例迁移到共享 helper（A6b）

**Files:**
- Modify: `$WT/test/terminal-snapshot.integration.test.mjs`（import 区 + `A5: burst through the snapshot window …` 用例）

**Interfaces:**
- Consumes: `createEchoProbe`（Task 1）。
- Produces: A5 burst 用例的内联 `setInterval` 循环消失，行为按 D1 三条不变量不变（间隔恒 300ms、判定正则 `/boot-probe-\d/`、结束即停）。**已知且允许的差异**：首探针从 t≈300ms 提前到 t≈0（spec D1 明写）。

**为何这个迁移安全（已核实，请在 CR 里按此对账）**：A5 burst 用例的后续断言全部是**内容化**的——`burstline-\d{4}` 正则收集与 seq 连续性——没有任何探针计数或时序断言；等待上限 30s 不动，首探针更早只会让收敛更早；探针在 `finally` 里停，早于 socketC 的 `subscribe_terminal`，不会落进 flush 窗口断言。

- [ ] **Step 1: 先跑一次现状，记录基线**

Run: `node --test --test-name-pattern "burst through the snapshot window" $WT/test/terminal-snapshot.integration.test.mjs`
Expected: PASS —— `pass 1`。记下 `duration_ms`。

- [ ] **Step 2: 加 import**

在 `$WT/test/terminal-snapshot.integration.test.mjs` 的 import 区（`../test-support/flake-postmortem.mjs` 之后）加：

```js
import { createEchoProbe } from "../test-support/echo-probe.mjs";
```

- [ ] **Step 3: 替换内联探针循环**

把（当前 `:283-294`）：

```js
		let probeN = 0;
		const probeTimer = setInterval(() => {
			probeN += 1;
			send(driver, { type: "input", data: `boot-probe-${probeN}\r` });
		}, 300);
		try {
			await waitFor(() => driverMessages.find((m) => m.type === "output" && /boot-probe-\d/.test(String(m.data))), 30000, capture);
		} finally {
			clearInterval(probeTimer);
		}
```

改为：

```js
		const probe = createEchoProbe({ send: (line) => send(driver, { type: "input", data: line }) });
		probe.start();
		try {
			await waitFor(() => driverMessages.find((m) => m.type === "output" && /boot-probe-\d/.test(String(m.data))), 30000, capture);
		} finally {
			probe.stop();
		}
```

上面那段注释（`// One-shot boot banner is racy against socket accept …`）原样保留，它现在描述的是 helper 的存在理由。

- [ ] **Step 4: 确认没有残留**

Run: `grep -n "probeN\|probeTimer\|clearInterval" $WT/test/terminal-snapshot.integration.test.mjs`
Expected: 无输出（迁移干净）。若还有命中，说明别处也在用同名变量，回到 Step 3 只改 A5 burst 用例那一处。

- [ ] **Step 5: 跑 A5 用例 10 轮（A6b 的一半）**

Run:
```bash
cd $WT
for i in $(seq 1 10); do
  node --test --test-name-pattern "burst through the snapshot window" test/terminal-snapshot.integration.test.mjs || echo "ROUND $i FAILED"
done
```
Expected: 10/10 通过。
**声明（照抄 spec A6b）**：这不构成修复证据——A5 burst 在修复前隔离跑也绿，它只作廉价回归冒烟。

- [ ] **Step 6: Commit**

```bash
cd $WT
git add test/terminal-snapshot.integration.test.mjs
git commit -m "test: migrate the A5 burst probe loop to the shared echo-probe helper"
```

---

## Task 7: 静态接线断言（A3 / A7）

**Files:**
- Create: `$WT/test/wait-capture-wiring.test.mjs`

**Interfaces:**
- Consumes: 三个真实测试文件的源码文本（`test/pty-runner.integration.test.mjs`、`test/control-reconcile.integration.test.mjs`）。
- Produces:
  - `waitForCalls(body): string[]` —— 纯函数，返回源码里每个 `await waitFor(` 的**实参文本**（平衡括号 + 字符串感知）。**必须真平衡扫描**：`String(m.data).includes("fake pi ready")` 这类实参里含括号前缀，正则非贪婪切法会在 `ready"))` 处提前收尾，把带 capture 的调用误判成裸等待。
  - `testCaseBody(source, marker): string` —— 纯函数，返回某个顶层 `test("…", …)` 用例的源码切片，**界取「列 0 的 `\n});`」而非括号配平**（理由见下）。
  - 三条断言（见 Step 3）。

**为何用例体定界不用括号配平（已实测的教训，请 CR 核实）**：第一版实现用括号配平找 `test(...)` 的收尾，结果在 `subscribe_terminal` 用例上直接报 `unbalanced` —— 源码注释里有不配对的 `(`（如 `// The runner also sends an unsolicited hello on connect (now with the`），而纯文本扫描器分不出注释与代码。要处理对就得写完整 tokenizer（含注释与正则字面量），得不偿失。本仓的顶层用例一律以 **列 0 的 `});`** 收尾，而用例之间的 helper 函数以**列 0 的 `}`** 收尾，两者不会混——用它定界既简单又精确（已对三个目标用例实测：切出 75 / 99 / 154 行，等待数 6 / 5 / 13，收尾行均为 `});`）。

**边界声明（写进文件头注释，也请 CR 核对）**：这是**源码文本级**断言，不证明运行时真的会打印现场——那由 Task 2 的 fixture 单测与 Task 3/4 的 integration 兜底。它的唯一职责是防止「接线被后人删掉」这类静默回归。仓内先例：`test/architecture-writer-boundary.test.mjs`（读真实树、仓根用 `fileURLToPath(new URL("..", import.meta.url))` 定位）、`test/budget-audit.test.mjs`（读真实树做审计）。

- [ ] **Step 1: 写失败的测试**

创建 `$WT/test/wait-capture-wiring.test.mjs`：

```js
/**
 * Static capture-wiring test (issue #178 spec §3.5, acceptance A3/A7).
 *
 * The flake postmortem only prints when a wait passes a capture thunk, so a
 * wait that silently loses its wiring re-opens the "red with no scene" gap
 * this issue exists to close. This test reads the real test sources and pins
 * three invariants:
 *
 *   1. every `await waitFor(` in the editor_state case carries a capture;
 *   2. the subscribe_terminal snapshot assertions are still present (deleting
 *      an assertion is not a way to go green);
 *   3. every `await waitFor(` in the control-reconcile A2 case carries a capture.
 *
 * Boundary: source-text level only. It does not prove that a failure actually
 * prints a scene — the flake-postmortem fixture tests and the integration
 * cases cover that. Its single job is to block silent rewiring regressions.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(PACKAGE_ROOT, rel), "utf8");

/**
 * Return the source of one top-level `test("<marker>", …)` case.
 *
 * The end is the first column-0 `});`, not a parenthesis balance: real source
 * comments in these files carry unbalanced parentheses (subscribe_terminal's
 * "…unsolicited hello on connect (now with the"), and a text scanner cannot
 * tell a comment from code. Top-level cases always end with a column-0 `});`
 * while the helper functions between them end with a column-0 `}`, so this
 * boundary is exact.
 * @param {string} source
 * @param {string} marker
 * @returns {string}
 */
export function testCaseBody(source, marker) {
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `case not found: ${marker}`);
	assert.ok(start === 0 || source[start - 1] === "\n", `marker is not at top level: ${marker}`);
	const close = source.indexOf("\n});", start);
	assert.notEqual(close, -1, `case end not found: ${marker}`);
	return source.slice(start, close + 4);
}

/**
 * Return the argument text of every `await waitFor(` call, with string literals
 * skipped and nested parentheses balanced.
 * @param {string} body
 * @returns {string[]}
 */
export function waitForCalls(body) {
	const needle = "await waitFor(";
	/** @type {string[]} */
	const calls = [];
	let i = 0;
	while ((i = body.indexOf(needle, i)) !== -1) {
		let depth = 1;
		let j = i + needle.length;
		/** @type {string | null} */
		let quote = null;
		for (; j < body.length && depth > 0; j += 1) {
			const ch = body[j];
			if (quote) {
				if (ch === "\\") j += 1;
				else if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") quote = ch;
			else if (ch === "(") depth += 1;
			else if (ch === ")") depth -= 1;
		}
		calls.push(body.slice(i + needle.length, j - 1));
		i = j;
	}
	return calls;
}

const PTY_RUNNER = "test/pty-runner.integration.test.mjs";
const CONTROL_RECONCILE = "test/control-reconcile.integration.test.mjs";

test("A7: waitForCalls parses nested calls, strings and a trailing capture", () => {
	const source = [
		'await waitFor(() => x.find((m) => m.type === "a, )(b"));',
		"await waitFor(() => hostReady(root, \"v1\"), 15000, capture);",
	].join("\n");
	const calls = waitForCalls(source);
	assert.equal(calls.length, 2);
	assert.match(calls[0], /^\(\) => x\.find/);
	assert.match(calls[1], /,\s*15000,\s*capture$/);
});

test("A7: testCaseBody stops at the case's own closing brace, not the next case", () => {
	const source = [
		'test("one", () => {',
		"\tconst a = 1;",
		"});",
		"",
		"// a helper defined between cases, with an unbalanced ( paren in a comment",
		"function helper() {",
		"\treturn await waitFor(() => x, 15000, capture);",
		"}",
		"",
		'test("two", () => {});',
		"",
	].join("\n");
	const body = testCaseBody(source, 'test("one"');
	assert.match(body, /const a = 1/);
	assert.doesNotMatch(body, /function helper/, "a trailing helper must not be swallowed");
	assert.doesNotMatch(body, /test\("two"/);
	assert.equal(waitForCalls(body).length, 0, "no wait belongs to this case");
});

test("A3/A7: every wait in the editor_state case carries a capture thunk", () => {
	const body = testCaseBody(read(PTY_RUNNER), 'test("pty-runner routes editor_state');
	const calls = waitForCalls(body);
	assert.ok(calls.length >= 6, `found the editor_state waits (${calls.length})`);
	for (const args of calls) {
		assert.match(args, /,\s*15000,\s*capture\s*$/, `wait without capture: ${args.trim().slice(0, 120)}`);
	}
});

test("A2/A7: the subscribe_terminal snapshot assertions are still executed", () => {
	const body = testCaseBody(read(PTY_RUNNER), 'test("subscribe_terminal:');
	assert.match(body, /includes\("fake pi ready"\)/, "the frame assertion must not be deleted");
	assert.match(body, /begin\.snapshotSeq >= 1/, "the baseline assertion must not be deleted");
});

test("A7: every wait in the control-reconcile A2 case carries a capture thunk", () => {
	const body = testCaseBody(read(CONTROL_RECONCILE), 'test("A2: reconnect wires hello');
	const calls = waitForCalls(body);
	assert.ok(calls.length >= 13, `found the A2 waits (${calls.length})`);
	for (const args of calls) {
		assert.match(args, /,\s*capture\s*$/, `wait without capture: ${args.trim().slice(0, 120)}`);
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test $WT/test/wait-capture-wiring.test.mjs`
Expected: 前 2 个用例（解析器）PASS；后 3 个 FAIL —— `editor_state` 的等待**此时已经带电**（Task 4 做完）所以应 PASS，而 control-reconcile 的 A2 用例**尚未接线**（Task 8 未做）必然 FAIL，报 `wait without capture: () => hostReady(root, "v1")`。

若 `editor_state` 那条也 FAIL，说明 Task 4 有漏网的等待点——回到 Task 4 Step 4 对齐。

- [ ] **Step 3: 确认新文件被 budget-audit 自动纳入**

Run: `node --test --test-name-pattern "the real test tree audits clean" $WT/test/budget-audit.test.mjs`
Expected: PASS（`budget-audit.test.mjs` 用 `readdirSync` 扫真实 `test/` 目录，新文件自动纳入；它无等待预算声明，天然零违规）。

- [ ] **Step 4: 等 Task 8 完成后回到这里跑绿**

本 task 的最后 1 个用例（control-reconcile）依赖 Task 8。**Task 7 不单独提交绿**——先做 Task 8，再回来一次跑：

Run: `node --test $WT/test/wait-capture-wiring.test.mjs`
Expected: PASS —— `pass 5`。

- [ ] **Step 5: Commit（与 Task 8 合并成一个提交，见 Task 8 Step 5）**

不单独 commit：`test/wait-capture-wiring.test.mjs` 与 control-reconcile 的接线是同一件事的两半，分开提交会让中间那个提交的门禁是红的。提交命令见 Task 8 Step 5。

---

## Task 8: control-reconcile 补现场覆盖（A7）

**Files:**
- Modify: `$WT/test/control-reconcile.integration.test.mjs`（import 区 + 本地 `waitFor`（`:38`）+ `A2: reconnect wires hello → reconcile → subscribe in order` 用例体 `:335-489`）

**Interfaces:**
- Consumes: `waitForWithPostmortem`（`test-support/flake-postmortem.mjs`）、`capturePostmortem`、`formatPostmortem`。
- Produces: 该文件本地 `waitFor` 获得第三参 `capture`，委托给共享实现；A2 用例体 13 处等待全部带电。

**顺序不可颠倒**：该文件的 `waitFor`（`:38`）是 `async function waitFor(predicate, timeoutMs = 15000)`——**没有** capture 槽（对照 `test/pty-runner.integration.test.mjs:31`）。所以必须先扩签名，再接线。这不是「只传个参数」的改动。

**已知且接受的语义对齐**：本地实现调 `predicate()`（未 await）且先判超时；共享实现调 `await predicate()` 且后判超时。对同步谓词两者同形；对异步谓词共享实现是修正（本地会把 pending Promise 当成真值直接返回）。这是 D7「不改等待条件与预算」允许的范围——条件与预算值一字不动。

- [ ] **Step 1: 加 import**

在 `$WT/test/control-reconcile.integration.test.mjs` 的 import 区加：

```js
import { capturePostmortem, formatPostmortem, waitForWithPostmortem } from "../test-support/flake-postmortem.mjs";
```

- [ ] **Step 2: 扩 waitFor 签名**

把（当前 `:38-47`）：

```js
async function waitFor(predicate, timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting");
}
```

改为：

```js
// issue #178 (spec D7): this file's waits carried no scene on a red. Delegate
// to the shared implementation, mirroring pty-runner.integration.test.mjs's
// three-argument shape — the wait condition and the budget are unchanged.
async function waitFor(predicate, timeoutMs = 15000, capture = null) {
	return waitForWithPostmortem(predicate, { timeoutMs, intervalMs: 25, capture });
}
```

- [ ] **Step 3: 在 A2 用例体开头加 capture 常量**

在 `test("A2: reconnect wires hello → reconcile → subscribe in order…", async () => {` 之后的变量声明区插入：

```js
	// issue #178 spec D7: this adjacent signature has flaked (10-11, 15.7s) with
	// no scene at all; wire the postmortem in so the next red explains itself.
	const capture = () => formatPostmortem(capturePostmortem(root, "v1", null));
```

（`root` 在该用例内已存在；若 `capture` 常量定义处还看不到 `root`，就把它放在 `root` 赋值之后一行。）

- [ ] **Step 4: 给 13 处等待接上 capture**

逐处追加 capture 为**最后一个实参**，**timeout 值一律不改**：

| 当前行 | 现在 | 改为 |
|---|---|---|
| `:344` | `await waitFor(() => hostReady(root, "v1"));` | `await waitFor(() => hostReady(root, "v1"), 15000, capture);` |
| `:352` | `await waitFor(() => h.messages.some((m) => m.type === "hello" && m.generation));` | `…, 15000, capture);` |
| `:356` | `const ready = await waitFor(() => h.eventsOf("snapshotReady")[0]);` | `const ready = await waitFor(() => h.eventsOf("snapshotReady")[0], 15000, capture);` |
| `:358` | `await waitFor(() => h.client.getLastSeq() >= ready.nextSeq + 2, 10000);` | `…, 10000, capture);` |
| `:364` | `await waitFor(() => h.messages.some((m) => m.type === "cmd_ack" && m.commandId === "follow-1" && m.stage === "applied"));` | `…, 15000, capture);` |
| `:365` | `await waitFor(() => h.echoCount("echo:resume-probe") >= 1);` | `…, 15000, capture);` |
| `:376` | `const reconciled = await waitFor(() => h.eventsOf("reconciled")[0]);` | `const reconciled = await waitFor(() => h.eventsOf("reconciled")[0], 15000, capture);` |
| `:412` | `await waitFor(() => coversRange(h.outputSeqs(), disconnectSeq, 3));` | `…, 15000, capture);` |
| `:417` | `await waitFor(() => h.client.getLastSeq() >= disconnectSeq + 3, 10000);` | `…, 10000, capture);` |
| `:440` | `await waitFor(() => h.messages.filter((m) => m.type === "cmd_ack" && m.commandId === "follow-1" && m.stage === "applied").length >= 2);` | `…, 15000, capture);` |
| `:460` | `await waitFor(() => hasWireOverlap(h.outputSeqs().filter((s) => s > drop2)), 5000);` | `…, 5000, capture);` |
| `:461` | `await waitFor(() => coversRange(h.outputSeqs(), drop2, 3));` | `…, 15000, capture);` |
| `:466` | `await waitFor(() => h.client.getLastSeq() >= drop2 + 3, 10000);` | `…, 10000, capture);` |

同文件其余用例（`:490` 的 `A2 epoch`、`:567` 的 `A2 epoch (slow consumer)`、`:662` 的 `A2 §10`）**不在本次范围**，一行都不动。

- [ ] **Step 5: 跑 A2 用例 + 静态守门 + 一起提交**

Run: `node --test --test-name-pattern "A2: reconnect wires hello" $WT/test/control-reconcile.integration.test.mjs`
Expected: PASS —— `pass 1`。

Run: `node --test $WT/test/wait-capture-wiring.test.mjs`
Expected: PASS —— `pass 5`（Task 7 的最后一条现在绿灯）。

Run: `node --test --test-name-pattern "the real test tree audits clean" $WT/test/budget-audit.test.mjs`
Expected: PASS。

```bash
cd $WT
git add test/control-reconcile.integration.test.mjs test/wait-capture-wiring.test.mjs
git commit -m "test: wire the flake postmortem into control-reconcile and guard the wiring statically"
```

---

## Task 9: 验收扫尾（A6① / A6② / A6b / A7）

**Files:** 无改动（纯运行与记录）。

**Interfaces:**
- Consumes: 前面所有 task 的提交。
- Produces: 逐轮签名数据（写回 issue 台账）、门禁结论。

**判据（照抄 spec §5）**：**按签名对账，不按「套件全绿」**。范围外签名（A5 burst、A2 reconnect）仍可能红，如实记录、不阻塞本 issue；本 issue 的两条目标签名（`subscribe_terminal`、`editor_state`）必须零命中。且「全绿」只在剖面仍有判别力时才算证据——这正是 Step 1 控制轮的用途。

- [ ] **Step 1: A6① 补丁前阳性控制轮**

先在**补丁前的 merge-base**上跑（当前即 `f47766c`；若合并前 main 前移，用当时的 merge-base，不要写死）：

```bash
REPO=/home/elling/git-repo/github/pi-agent-board
BASE=$(git -C "$REPO" merge-base main "$REPO/.pi/worktrees/issue-178-accept-registration-race") 2>/dev/null || BASE=$(git -C "$REPO" rev-parse main)
echo "control base: $BASE"
git -C "$REPO" worktree add /tmp/issue-178-control "$BASE"
cd /tmp/issue-178-control
npm ci                       # 裸 worktree 没有 node_modules；目标用例静态依赖 @xterm/headless
npm test 2>&1 | tee /tmp/issue-178-control-r1.log
```

Expected: 记下结果。**控制轮的目的就是看它红不红**：
- 若日志里出现 `subscribe_terminal` 或 `editor_state` 失败（各烧 ~15s）→ 剖面仍有判别力，Step 2 的绿才是阳性证据。
- 若两条都没出现（控制轮未复红）→ **如实记录**「剖面此刻不具判别力」，Step 2 的全绿**不构成阳性证据**，必须在 issue 台账降级标注其证据强度。**不得**静默当作修好了。

**禁止**为绕过依赖问题回主 checkout 用 `git stash` / `git checkout` 切换——那会制造补丁态/基线态混淆，正是 worktree 要避免的。

记录格式（抄进 issue）：
```
A6① 控制轮 | base=<sha> | run=<本次日期时间> | subscribe_terminal=<命中/未命中> | editor_state=<命中/未命中> | 套件时长=<…>
```

- [ ] **Step 2: A6② 修后全量负载剖面**

```bash
cd $WT
for i in $(seq 1 5); do
  npm test 2>&1 | tee /tmp/issue-178-load-r$i.log
done
npm run verify 2>&1 | tee /tmp/issue-178-verify-r1.log
npm run verify 2>&1 | tee /tmp/issue-178-verify-r2.log
```

逐轮记录（每轮一行，抄进 issue）：
```
A6② 第 <i> 轮 | pass=<n> fail=<n> skipped=<n> | 耗时=<…> | 失败签名=<逐个列出 / 无>
```
通过标准：5 轮里两条目标签名零命中；范围外签名如实记录、不阻塞。另 `verify` 2 轮全过。

- [ ] **Step 3: A6b 隔离冒烟**

```bash
cd $WT
for i in $(seq 1 10); do
  node --test test/pty-runner.integration.test.mjs || echo "ROUND $i FAILED"
done
```
Expected: 10/10 通过。
**声明**：这不构成修复证据（修复前隔离跑也全绿），只作廉价回归冒烟。

- [ ] **Step 4: A7 门禁逐项**

```bash
cd $WT
npm run typecheck                                  # tsc --noEmit
node --test test/wait-capture-wiring.test.mjs      # 接线断言
node --test test/budget-audit.test.mjs             # 零违规（整文件跑，无 flag）
node --test --test-name-pattern "the real test tree audits clean" test/budget-audit.test.mjs
git -C $WT diff --name-only "$(git -C $WT merge-base main HEAD)" HEAD -- .github/workflows/ci.yml
```
Expected:
- `typecheck` 无输出即通过；
- 接线断言 `pass 5`；
- budget-audit `pass 8`；
- 最后一条 `git diff --name-only … -- .github/workflows/ci.yml` **无输出** —— 即 PR diff 不含 `ci.yml`（**判据对照 merge-base，不是 spec 头部的 `f47766c` 字面值**：两者当前恰好等价，但合并前 main 若另动 ci.yml，按旧锚点比字节会假失败）；
- 覆盖率阈值：`npm run test:coverage` 的 `Lines ≥85 / Funcs ≥80 / Branches ≥70` 仍过（`.c8rc.json` 排除 `test/**`，本改动结构性不影响）。

- [ ] **Step 5: 写回 issue 台账**

把 Step 1–4 的记录整理成一条 issue 评论，附 A6① 控制轮结论（含「未复红」时的降级标注）、A6② 逐轮签名分布、A6b 与 A7 结论。合并后还要回 #95 更新观察台账（Task 10）。

- [ ] **Step 6: Commit（仅当 Step 1–4 有产物需要落库时）**

验收本身不产生代码改动，通常**无需提交**。若为记录数据新增了文件（例如把日志摘要落进 `docs/`），再单独提交；否则跳过本步。

---

## Task 10: post-merge 用户实测（U1）

**Files:** 无。合并后执行，属 spec 的「用户实测 / 合并后观测」类。

**为什么单独成 task**：U1 是用户实测项，**自动化命令通过不能替代它**。它不阻塞 PR 合并，但必须执行并记录，否则 issue 不能宣告验收完成。

- [ ] **Step 1: 窗口定义（先与用户确认取值）**

窗口 = #95 台账当前观察窗，或合并后 ≥10 次 main CI run，取先到者。该数值是 spec 里的**建议值**，用户可在验收时改写。

- [ ] **Step 2: 只读 main CI 日志，逐次记录**

证据源 = main 上 CI 的日志，**无需**本地拉取 / 重启 / 路径指向（故本项无部署前置）：

```bash
gh run list --repo zhuxixi/pi-agent-board --branch main --limit 20 --json databaseId,conclusion,createdAt,url
gh run view <run-id> --repo zhuxixi/pi-agent-board --log-failed | grep -E "subscribe_terminal|editor_state" || echo "no target signature in this run"
```

- [ ] **Step 3: 判定与记录**

通过标准：窗口内 `subscribe_terminal` / `editor_state` 在 main CI **零出现**；若出现，现场必须能区分「banner 没落盘」与「落盘未转发」（读增强 postmortem 的 `screenLogTail` 行）。
把逐次结果记回 #95 观察台账与 #178。

- [ ] **Step 4: 流程收尾（合并后）**

```bash
git_worktree remove ./.pi/worktrees/issue-178-accept-registration-race
git -C /home/elling/git-repo/github/pi-agent-board worktree prune
git -C /home/elling/git-repo/github/pi-agent-board branch -D issue-178-accept-registration-race
git -C /home/elling/git-repo/github/pi-agent-board push origin --delete issue-178-accept-registration-race || true
git -C /home/elling/git-repo/github/pi-agent-board checkout main && git -C /home/elling/git-repo/github/pi-agent-board pull
rm -rf /tmp/issue-178-control          # A6① 的控制轮 worktree（先 git worktree remove 再删目录）
```
调研与 spec 目录 `~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-178/` **不清理**（跨 harness 留档）。

---

## 自检记录（写完 plan 后按 writing-plans 要求做的三轮自查）

1. **spec 覆盖**：spec §9 的 9 步迁移顺序 ↔ Task 1–9 一一对应（第 9 步「验收扫尾」= Task 9）；spec §5 的 A1–A7 + U1 全部有 task 归属（见表）；§3.5 的静态测试 = Task 7。无遗漏项。
2. **占位符扫描**：无 TBD / TODO / 「类似 Task N」/ 无代码块的代码步骤。每个实现步骤都给了可直接粘贴的完整代码与命令。
3. **命名与类型一致性**：`createEchoProbe({ send, intervalMs, sleep })` 的入参与返回（`line`/`start`/`stop`）在 Task 1 定义，在 Task 3/5/6 三处调用形状一致；`tailSlice(text, maxBytes)` 与 `SCREEN_LOG_TAIL_BYTES` 在 Task 2 定义并同 task 内使用；Task 7 的 `waitForCalls` / `testCaseBody` 在 task 内定义并使用；control-reconcile 的 `waitFor` 三参形状与 `pty-runner` 的 `:31` 一致。

## 自查中实测发现并已处理的四件事（供 CR 复核）

1. **`frame.data` 的余量已核实**：D1 的断言不变性依赖「收到 echo ⟹ banner 仍在帧里」。`captureTerminalSnapshot` 返回 `scrollback`（上限 256 行）+ 视口，`synthesizeFullRedrawFrame` 把两者拼成一条连续重绘流，故横幅只要在尾部 280 行内就仍在 `frame.data`。探针回显行数远小于该余量 → 断言成立。已在 Task 3 记录。
2. **不复用 `readScreenLogTail`**：既有实现返回裸字节切片，其 `toString("utf8")` 会在切片头部落入字符中间时产出 U+FFFD，恰是 A5 禁止的「劈开多字节字符」。故按 spec 新建纯函数 `tailSlice`。已在 Task 2 记录理由，避免 CR 时被当成重复造轮子。
3. **静态测试的用例体定界不能用括号配平**：实测第一版在 `subscribe_terminal` 用例上报 `unbalanced` —— 该用例注释里有不配对的 `(`，文本扫描器分不出注释与代码。改用「列 0 的 `});`」定界，并对三个目标用例实测切出 **75 / 99 / 154 行**、等待数 **6 / 5 / 13**、收尾行均为 `});`。同时用真实文件预演了两条断言：`editor_state` 当前 6 处**全裸**（Task 4 要改的正是它）、`subscribe_terminal` 5 处**全带电**、control-reconcile A2 13 处**全裸**——与本 plan 的预期完全一致。另外 `waitForCalls` 必须真平衡扫描（正则非贪婪会在 `includes("fake pi ready"))` 处提前收尾）。
4. **A4 用例的连接时序**：runner 先 spawn 子进程（`runner/pty-runner.mjs:312`）后才 `server.listen`（`:407`），所以「横幅已落 screen.log」可能早于控制 socket 绑定，直接 `createConnection` 会因 ENOENT 抱错。已在 Task 5 加 Leg 0：先等 `hostReady`（`host.state === "alive"` 只在 listen 回调里写）。

此外 Task 2 的 `tailSlice` 期望值已用内联实测逐项校对（`tailSlice("中文字符", 3)` 得 `"符"`——3 字节恰是完整一字；真正跨字符的是 `2` 字节，得 `""`；截断后无 U+FFFD；`oversized` 用例得 2048 字节且 `endsWith("中文字符")`）。
