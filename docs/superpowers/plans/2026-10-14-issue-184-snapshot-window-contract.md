# Issue #184: A5 burst 窗口契约对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `A5: burst through the snapshot window` 用例的覆盖率断言回到快照窗口契约内（不再依赖拍摄时机），并把「失败必须自报机制」的诊断与「窗口边界」的确定性钉子落进测试套件。

**Architecture:** 纯测试改动。新增一个纯函数诊断模块（`test-support/burst-diagnostics.mjs`）承载「聚合 + 渲染」，用例侧只留一层薄接线（消息数组 → 文本数组）；A5 burst 的 burst 行数降到 frame 窗口内，并用一条运行期守卫把「burst 必须装得进窗口」这条不等式钉住；新增 `A5w` 用例，用确定性双腿（先让老客户端收齐再订阅）把「窗口内必达 / 窗口外截断」变成机械事实；设计文档的 A5 行下方补一段带日期的口径补注。

**Tech Stack:** Node.js（`node --test`，本机 v24.13.0）、`node:assert/strict`、既有 `test-support/flake-postmortem.mjs`、既有 `src/core/terminal-snapshot.mjs` 常量。

## Global Constraints

- **test-only + docs**：不改 `src/`、`runner/`、`.github/workflows/ci.yml`；不新增依赖；不重命名任何测试文件。
- **不调预算**：文件默认 `waitFor` 15000 与 A5 既有 30000 保持原样；不新增用例级 timeout；`npm run verify` 的 budget-audit 必须零违规。
- **按名字隔离只用正模式**，且 `--test-name-pattern` 必须写在位置参数（测试文件）**之前**：`node --test --test-name-pattern "<模式>" <文件>`。写在文件之后会被 node 静默忽略并跑满全文件。
- **注释与 commit message 一律英文**；缩进用 **tab**（仓规 AGENTS.md）。
- **窗口不等式（硬约束）**：`BURST_LINES + MAX_BURST_MISC_ROWS <= RUNNER_ROWS + DEFAULT_SCROLLBACK_SNAPSHOT_CAP`。`RUNNER_ROWS` 必须与 `spawnRunner` 的默认参数**同源**（禁止写镜像的 `24`）；`DEFAULT_SCROLLBACK_SNAPSHOT_CAP` 从 `src/core/terminal-snapshot.mjs` import（禁止字面量 `256`）。
- **三层不得合并**：解析（`collectBurstIds`）↔ 聚合 + 渲染（`formatBurstDiagnostics`）↔ 判定（用例内断言）。helper 里出现 `assert` 即违约。
- **工作目录**：本 plan 全部路径以 worktree 为根 `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-184-snapshot-window-contract`；所有 `git` 命令用 `git -C <worktree>`，禁止在主 checkout 提交。
- **spec 验收归属（双向追溯）**：

  | spec 验收 ID | 落在哪个 task |
  |---|---|
  | V1（A5 burst 用例 + 窗口守卫） | Task 2（常量 + 守卫）、Task 3（诊断接线） |
  | V2（纯函数单测 + 接线静态断言） | Task 1（纯函数）、Task 3（静态断言 ①–⑤） |
  | V3（`A5w` 双腿） | Task 4 |
  | V4（全量剖面佐证） | Task 6 |
  | V5（门禁与预算审计） | Task 6 |
  | U1（设计文档 A5 行补注，人工核对） | Task 5 |

**Spec:** `docs/superpowers/specs/2026-10-14-issue-184-snapshot-window-contract-design.md`（同 worktree 内，v2 稿）。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `test-support/burst-diagnostics.mjs` | 纯函数：`burstline-NNNN` id 解析 + 失败诊断块渲染（无 I/O、无定时器、不断言） | 新建 |
| `test/burst-diagnostics.test.mjs` | 上述纯函数的单测 + 对集成用例的接线静态断言（源码文本级） | 新建 |
| `test/terminal-snapshot.integration.test.mjs` | 窗口常量与守卫、A5 burst 的诊断接线与行数、新增 `A5w` 用例与 `measureLateSubscribe` 辅助 | 修改 |
| `docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md` | A5 行的日期化口径补注（追加，不改原文） | 修改 |

---

### Task 1: `test-support/burst-diagnostics.mjs` + 单测

**Files:**
- Create: `test-support/burst-diagnostics.mjs`
- Test: `test/burst-diagnostics.test.mjs`

**Interfaces:**
- Consumes: 无（纯函数，零依赖）
- Produces:
  - `collectBurstIds(text: string): number[]` —— 去重、升序的 `burstline-NNNN` id
  - `formatBurstDiagnostics({ expectedRows: number, driverTexts?: string[], frameText?: string, liveTexts?: string[] }): string`

- [ ] **Step 1: 先写失败测试**

创建 `test/burst-diagnostics.test.mjs`：

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectBurstIds, formatBurstDiagnostics } from "../test-support/burst-diagnostics.mjs";

// issue #184: the A5 burst failure used to be undiagnosable — the durable-state
// postmortem cannot tell "the child never wrote the rows" from "the snapshot
// frame window truncated them". These counters can.

test("collectBurstIds extracts unique ascending ids from arbitrary chunks", () => {
	assert.deepEqual(collectBurstIds(""), []);
	assert.deepEqual(collectBurstIds("nothing to see here\n"), []);
	assert.deepEqual(collectBurstIds("burstline-0001-pppp\nburstline-0002-pppp"), [1, 2]);
	// chunks may repeat ids (frame + catch-up flush) — the union must dedupe and sort
	assert.deepEqual(collectBurstIds("burstline-0400-a\nburstline-0001-b\nburstline-0400-c"), [1, 400]);
	assert.deepEqual(collectBurstIds("prefix burstline-0012-txt suffix burstline-0013"), [12, 13]);
});

test("formatBurstDiagnostics renders counts, ranges and missing ids", () => {
	const full = formatBurstDiagnostics({
		expectedRows: 3,
		driverTexts: ["burstline-0001-a\nburstline-0002-b\nburstline-0003-c"],
		frameText: "burstline-0002-b\nburstline-0003-c",
		liveTexts: ["burstline-0001-a"],
	});
	assert.match(full, /--- burst coverage \(test-side judgement, issue #184\) ---/);
	assert.match(full, /expectedRows: 3/);
	assert.match(full, /driverRows: 3 \[1\.\.3\]/);
	assert.match(full, /frameRows: 2 \[2\.\.3\]/);
	assert.match(full, /liveRows: 1/);
	assert.match(full, /unionRows: 3/);
	assert.match(full, /missing: <none>/);

	const truncated = formatBurstDiagnostics({
		expectedRows: 5,
		driverTexts: ["burstline-0001-a\nburstline-0002-b\nburstline-0003-c\nburstline-0004-d\nburstline-0005-e"],
		frameText: "burstline-0004-d\nburstline-0005-e",
		liveTexts: [],
	});
	assert.match(truncated, /unionRows: 2/);
	assert.match(truncated, /missing: 3 \[1, 2, 3\]/);
});

test("formatBurstDiagnostics prints zeros when nothing was observed yet", () => {
	const empty = formatBurstDiagnostics({ expectedRows: 200 });
	assert.match(empty, /driverRows: 0/);
	assert.match(empty, /frameRows: 0/);
	assert.match(empty, /liveRows: 0/);
	assert.match(empty, /unionRows: 0/);
	assert.match(empty, /missing: 200 \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …\]/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/burst-diagnostics.test.mjs`
Expected: FAIL —— `Cannot find module .../test-support/burst-diagnostics.mjs`（模块尚不存在）

- [ ] **Step 3: 实现模块**

创建 `test-support/burst-diagnostics.mjs`：

```js
/**
 * Test-side judgement block for the A5 burst case (issue #184).
 *
 * The durable-state postmortem cannot tell "the child never emitted the rows"
 * from "the snapshot frame window truncated them": both end as an empty
 * diagnostics/journal with a healthy host. These counters can — the driver is
 * subscribed BEFORE the burst, so a complete driver range proves the child wrote
 * every row and the loss sits in the frame / catch-up path.
 *
 * Pure: no I/O, no timers, no assertions (judgement stays in the test case).
 */

/**
 * @param {string} text arbitrary chunk text (many lines, a partial line, or no
 *   burst content at all)
 * @returns {number[]} unique `burstline-NNNN` ids, ascending
 */
export function collectBurstIds(text) {
	const ids = new Set();
	for (const m of String(text ?? "").matchAll(/burstline-(\d{4})/g)) ids.add(Number(m[1]));
	return [...ids].sort((a, b) => a - b);
}

/**
 * @param {number[]} ids ascending ids
 * @returns {string} `3 [1..3]`, or `0` when empty
 */
function formatRange(ids) {
	if (ids.length === 0) return "0";
	return `${ids.length} [${ids[0]}..${ids[ids.length - 1]}]`;
}

/**
 * Render the block appended to a failing wait's postmortem.
 * @param {{
 *   expectedRows: number,
 *   driverTexts?: string[],
 *   frameText?: string,
 *   liveTexts?: string[],
 * }} input `expectedRows` is the burst size the case asserts; `driverTexts` come
 *   from the client that was subscribed BEFORE the burst, `frameText`/`liveTexts`
 *   from the client under test.
 * @returns {string}
 */
export function formatBurstDiagnostics({ expectedRows, driverTexts = [], frameText = "", liveTexts = [] }) {
	const driverIds = collectBurstIds(driverTexts.join("\n"));
	const frameIds = collectBurstIds(frameText);
	const liveIds = collectBurstIds(liveTexts.join("\n"));
	const union = new Set([...frameIds, ...liveIds]);
	const missing = [];
	for (let i = 1; i <= expectedRows; i += 1) {
		if (!union.has(i)) missing.push(i);
	}
	const shown = missing.slice(0, 10).join(", ");
	const missingText = missing.length === 0
		? "<none>"
		: `${missing.length} [${shown}${missing.length > 10 ? ", …" : ""}]`;
	return [
		"--- burst coverage (test-side judgement, issue #184) ---",
		`expectedRows: ${expectedRows}`,
		`driverRows: ${formatRange(driverIds)}`,
		`frameRows: ${formatRange(frameIds)}`,
		`liveRows: ${liveIds.length}`,
		`unionRows: ${union.size}`,
		`missing: ${missingText}`,
	].join("\n");
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test test/burst-diagnostics.test.mjs`
Expected: PASS —— 3 个测试全过（`# pass 3` / `# fail 0`）

- [ ] **Step 5: 提交**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-184-snapshot-window-contract
git add test-support/burst-diagnostics.mjs test/burst-diagnostics.test.mjs
git commit -m "test(attach): add burst diagnostics formatter for the A5 burst case (issue #184)"
```

---

### Task 2: 窗口常量、同源 `RUNNER_ROWS` 与守卫断言

**Files:**
- Modify: `test/terminal-snapshot.integration.test.mjs`（顶部 import/常量、`spawnRunner:101`、A5 burst 用例 `:273` / `:349` / `:351` 与守卫）

**Interfaces:**
- Consumes: `DEFAULT_SCROLLBACK_SNAPSHOT_CAP`（`src/core/terminal-snapshot.mjs`）
- Produces: 模块常量 `RUNNER_ROWS` / `BURST_LINES` / `MAX_BURST_MISC_ROWS` / `MISC_TOLERANCE`（Task 3 的接线与 Task 4 的用例都引用它们）

- [ ] **Step 1: 加 import 与模块常量**

在 import 区追加（放在 `flake-postmortem` 那行之后）：

```js
import { DEFAULT_SCROLLBACK_SNAPSHOT_CAP } from "../src/core/terminal-snapshot.mjs";
```

在 `function freshRoot()` 之前插入：

```js
// Snapshot frame capacity (issue #184): the frame carries the viewport rows plus
// the scrollback cap, so a late subscriber can only recover the TAIL of that
// window. RUNNER_ROWS is shared with spawnRunner's default — never mirror it, or
// the window guard below drifts away from the real viewport.
const RUNNER_ROWS = 24;
// The burst must FIT the window, otherwise "frame ∪ flush ∪ live covers every
// row" becomes a capture-timing race instead of a property (issue #184).
const BURST_LINES = 200;
const MAX_BURST_MISC_ROWS = 8;
// Non-burst rows (boot banner, probe echo, cursor line) can eat a few window
// slots in the overflow leg; the boundary assertion tolerates this much drift.
const MISC_TOLERANCE = 8;
```

- [ ] **Step 2: 让 `spawnRunner` 与 `RUNNER_ROWS` 同源**

把 `:101` 的

```js
function spawnRunner(root, viewId, { env = {}, cols = 80, rows = 24 } = {}) {
```

改为

```js
function spawnRunner(root, viewId, { env = {}, cols = 80, rows = RUNNER_ROWS } = {}) {
```

- [ ] **Step 3: A5 burst 用例改用常量并加守卫**

`:273`：

```js
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_BURST_LINES: String(BURST_LINES) } }));
```

在 `const capture = ...` 之前插入守卫：

```js
	// issue #184: the coverage assertion in this case is valid only while the whole
	// burst fits the snapshot frame window (viewport rows + scrollback cap). Keep
	// this guard so a future BURST_LINES bump fails loudly instead of flaking.
	assert.ok(
		BURST_LINES + MAX_BURST_MISC_ROWS <= RUNNER_ROWS + DEFAULT_SCROLLBACK_SNAPSHOT_CAP,
		`burst must fit the snapshot frame window: ${BURST_LINES} + ${MAX_BURST_MISC_ROWS} > ${RUNNER_ROWS} + ${DEFAULT_SCROLLBACK_SNAPSHOT_CAP}`,
	);
```

`:349` 与 `:351`：

```js
			return seen.size >= BURST_LINES;
```

```js
		assert.equal(seen.size, BURST_LINES, "every burst line delivered exactly once across frame+flush+live");
```

- [ ] **Step 4: 跑 A5 burst 用例**

Run: `node --test --test-name-pattern "A5: burst through the snapshot window" test/terminal-snapshot.integration.test.mjs`
Expected: PASS —— `# pass 1` / `# fail 0`（200 行 < 窗口 280 行，任何拍摄时机都覆盖得到）

- [ ] **Step 5: 当场验证守卫会咬人（临时改，改完必须还原）**

把 `BURST_LINES` 临时改成 `400`，Run 同一条命令。
Expected: FAIL —— 报 ``burst must fit the snapshot frame window: 400 + 8 > 24 + 256``。
随后把 `BURST_LINES` **改回 `200`**，重跑确认 PASS。

- [ ] **Step 6: 提交**

```bash
git add test/terminal-snapshot.integration.test.mjs
git commit -m "test(attach): keep the A5 burst inside the snapshot frame window (issue #184)"
```

---

### Task 3: 诊断接线 + 接线静态断言

**Files:**
- Modify: `test/terminal-snapshot.integration.test.mjs:271`（`capture` 闭包）、`:279`（`driverMessages` 赋值）、`:300-301`（B 的 wireClient 拆包）
- Modify: `test/burst-diagnostics.test.mjs`（追加静态断言）

**Interfaces:**
- Consumes: Task 1 的 `collectBurstIds` / `formatBurstDiagnostics`；Task 2 的 `BURST_LINES`
- Produces: 模块级辅助 `outputText(messages): string`（Task 4 复用）

- [ ] **Step 1: 先加静态断言（此时必然失败）**

在 `test/burst-diagnostics.test.mjs` 顶部补 import 与源码读取，并在文件末尾追加断言：

```js
import { readFileSync } from "node:fs";
```

```js
// Static wire checks read the real integration suite: they cannot prove the
// runtime prints, only that the wiring (and the pre-existing judgement calls)
// cannot be deleted silently. Runtime printing is covered by the case itself.
const snapshotSource = readFileSync(new URL("./terminal-snapshot.integration.test.mjs", import.meta.url), "utf8");

/** @param {string} source @param {string} name top-level case name */
function caseBody(source, name) {
	const start = source.indexOf(`test(${JSON.stringify(name)}`);
	assert.notEqual(start, -1, `case not found: ${name}`);
	const next = source.indexOf("\ntest(", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

const A5_BURST_CASE = "A5: burst through the snapshot window — frame→flush→end interleaving pinned on the wire, client converges in order";

test("A5 burst case wires the burst diagnostics and keeps its pinned assertions", () => {
	const body = caseBody(snapshotSource, A5_BURST_CASE);
	// 1. the diagnostics block is composed into the failure capture
	assert.match(body, /formatBurstDiagnostics\(/);
	// 2. every observation source is mapped (guards against wiring the wrong side)
	for (const key of ["driverTexts", "frameText", "liveTexts"]) {
		assert.match(body, new RegExp(`${key}:`), `capture closure must map ${key}`);
	}
	// 3. every wait in this case carries the capture thunk
	const waits = body.match(/await waitFor\(/g) ?? [];
	const captured = body.match(/,\s*capture\)/g) ?? [];
	assert.ok(waits.length > 0, "the A5 burst case must contain waits");
	assert.equal(captured.length, waits.length, "every waitFor in the A5 burst case must pass `capture`");
	// 4. the frame-window guard is present and derives from shared constants
	assert.match(body, /DEFAULT_SCROLLBACK_SNAPSHOT_CAP/);
	assert.match(body, /RUNNER_ROWS/);
	// 5. the pre-existing judgement calls are still there — no green by deletion
	assert.match(body, /flush chunks contiguous after the snapshot cursor/);
	assert.match(body, /assert\.deepEqual\(eventsB\.protocolError, \[\]\)/);
	assert.match(body, /assert\.deepEqual\(eventsB\.resubscribing, \[\]\)/);
});
```

- [ ] **Step 2: 跑测试，确认新断言失败**

Run: `node --test test/burst-diagnostics.test.mjs`
Expected: FAIL —— 新用例报 `The input did not match the regular expression /formatBurstDiagnostics\(/`（接线还没做）

- [ ] **Step 3: 接线（改 3 处）**

在模块级辅助函数区（`function freshRoot()` 附近）新增：

```js
/** Concatenate the text of every `output` message (wire chunks may hold many lines). */
function outputText(messages) {
	return messages.filter((m) => m.type === "output").map((m) => String(m.data)).join("\n");
}
```

把 `:271` 的单行 `capture` 闭包替换为：

```js
	// issue #184: the failure must name its mechanism (child side vs frame side),
	// so the postmortem carries test-side counters next to the durable state.
	const observed = { driver: [], b: null };
	const capture = () =>
		formatPostmortem(capturePostmortem(root, viewId, null))
		+ "\n"
		+ formatBurstDiagnostics({
			expectedRows: BURST_LINES,
			driverTexts: outputText(observed.driver),
			frameText: observed.b?.snapshotReady?.[0]?.frame ?? "",
			liveTexts: (observed.b?.output ?? []).map((data) => (typeof data === "string" ? data : (data?.data ?? ""))),
		});
```

把 `:279` 的 `const driverMessages = listen(driver).messages;` 替换为（**保留别名**，`:295` 的谓词因此不必改动）：

```js
		const driverMessages = (observed.driver = listen(driver).messages);
```

把 `:300-301` 替换为：

```js
		const wiredB = wireClient(socketB);
		const { client: clientB, events: eventsB } = wiredB;
		observed.b = eventsB;
		clientB.start();
```

顶部 import 追加：

```js
import { collectBurstIds, formatBurstDiagnostics } from "../test-support/burst-diagnostics.mjs";
```

- [ ] **Step 4: 跑两条验证**

Run: `node --test test/burst-diagnostics.test.mjs`
Expected: PASS —— 4 个测试全过（3 个单测 + 1 个静态断言）

Run: `node --test --test-name-pattern "A5: burst through the snapshot window" test/terminal-snapshot.integration.test.mjs`
Expected: PASS —— `# pass 1` / `# fail 0`（burst 已在 Task 2 降到窗口内的 200 行，不受拍摄时机影响）

- [ ] **Step 5: 提交**

```bash
git add test/terminal-snapshot.integration.test.mjs test/burst-diagnostics.test.mjs
git commit -m "test(attach): wire burst diagnostics into the A5 burst failure path (issue #184)"
```

---

### Task 4: `A5w` 确定性双腿用例

**Files:**
- Modify: `test/terminal-snapshot.integration.test.mjs`（在 A5 burst 用例之后、A5c 之前插入辅助函数与用例）

**Interfaces:**
- Consumes: `RUNNER_ROWS` / `BURST_LINES` / `MISC_TOLERANCE` / `DEFAULT_SCROLLBACK_SNAPSHOT_CAP`（Task 3）；`outputText`（Task 2）；`collectBurstIds`（Task 1）；文件既有辅助 `freshRoot` / `spawnRunner` / `waitFor` / `hostReady` / `listen` / `send` / `wireClient` / `cleanup`
- Produces: `measureLateSubscribe(totalLines): Promise<{ union: Set<number>, protocolError: unknown[], resubscribing: unknown[] }>`

- [ ] **Step 1: 写用例（leg2 先用溢出值，让它红）**

在 A5 burst 用例的 `});` 之后、`test("A5c: ...` 之前插入：

```js
/** Spawn a runner, drain a full burst on an ALREADY-SUBSCRIBED legacy driver, then
 *  subscribe a fresh wire client — the worst-case capture timing for the frame
 *  window contract (issue #184). Returns only the client-side observations. */
async function measureLateSubscribe(totalLines) {
	const root = freshRoot();
	const viewId = `a5w-${totalLines}`;
	const sockets = [];
	let runner;
	try {
		({ runner } = spawnRunner(root, viewId, { env: { FAKE_PTY_BURST_LINES: String(totalLines) } }));
		await waitFor(() => hostReady(root, viewId), 30000);

		const driver = createConnection(P.controlSocketPath(root, viewId));
		await once(driver, "connect");
		sockets.push(driver);
		const driverMessages = listen(driver).messages;
		send(driver, { type: "hello" });
		let probeN = 0;
		const probeTimer = setInterval(() => {
			probeN += 1;
			send(driver, { type: "input", data: `boot-probe-${probeN}\r` });
		}, 300);
		try {
			await waitFor(() => driverMessages.find((m) => m.type === "output" && /boot-probe-\d/.test(String(m.data))), 30000);
		} finally {
			clearInterval(probeTimer);
		}

		// Drain the whole burst BEFORE subscribing: the capture is then guaranteed to
		// land after every row exists, which is what makes both legs deterministic.
		send(driver, { type: "input", data: "burst\r" });
		await waitFor(() => collectBurstIds(outputText(driverMessages)).length >= totalLines, 30000);

		const socketB = createConnection(P.controlSocketPath(root, viewId));
		await once(socketB, "connect");
		sockets.push(socketB);
		const { client: clientB, events } = wireClient(socketB);
		clientB.start();
		await waitFor(() => events.snapshotReady.length > 0, 30000);
		// No settle delay: the runner sends the catch-up flush chunks BEFORE snapshot_end
		// (src/core/terminal-attach-protocol.mjs:138-150), and the client emits the flush
		// while handling snapshot_end — so observing snapshotReady means the whole window
		// is already in `events` (CR round 1, advisory).

		const union = new Set([
			...collectBurstIds(events.snapshotReady[0]?.frame ?? ""),
			...collectBurstIds(events.output.map((data) => (typeof data === "string" ? data : (data?.data ?? ""))).join("\n")),
		]);
		return { union, protocolError: events.protocolError, resubscribing: events.resubscribing };
	} finally {
		await cleanup(root, viewId, sockets, [runner]);
	}
}

test("A5w: window contract — a late subscriber gets the frame-window tail, and content inside the window arrives complete", async () => {
	const window = RUNNER_ROWS + DEFAULT_SCROLLBACK_SNAPSHOT_CAP;

	// leg 1: burst larger than the window — the head is unrecoverable by design.
	const overTotal = window + 120;
	const leg1 = await measureLateSubscribe(overTotal);
	assert.ok(leg1.union.size < overTotal, `expected truncation: union ${leg1.union.size} of ${overTotal}`);
	assert.ok(leg1.union.size <= window, `union ${leg1.union.size} must not exceed the window ${window}`);
	assert.ok(
		leg1.union.size >= window - MISC_TOLERANCE,
		`union ${leg1.union.size} must fill the window (tolerance ${MISC_TOLERANCE})`,
	);
	const leg1Ids = [...leg1.union].sort((a, b) => a - b);
	assert.ok(leg1Ids[0] > 1, "the window truncates the head of the burst");
	assert.equal(
		leg1Ids[leg1Ids.length - 1] - leg1Ids[0] + 1,
		leg1Ids.length,
		"the union is a contiguous tail, never a stitched subset",
	);
	assert.deepEqual(leg1.protocolError, []);
	assert.deepEqual(leg1.resubscribing, []);

	// leg 2: burst that fits the window — complete coverage even at the worst capture
	// timing. This is the deterministic proof behind the A5 burst coverage assertion.
	const leg2 = await measureLateSubscribe(BURST_LINES);
	assert.equal(leg2.union.size, BURST_LINES, "content inside the window must arrive complete");
	assert.deepEqual(leg2.protocolError, []);
	assert.deepEqual(leg2.resubscribing, []);
});
```

> 本步的 leg2 先写 `const leg2 = await measureLateSubscribe(overTotal);`（即 400 行），**故意让它红**——这正是原 CI 失败的形态。

- [ ] **Step 2: 跑用例，确认 leg2 失败（机制当场复现）**

Run: `node --test --test-name-pattern "A5w:" test/terminal-snapshot.integration.test.mjs`
Expected: FAIL —— `content inside the window must arrive complete`（`union.size` 约 279 < 400）。leg1 应在此前已通过。

- [ ] **Step 3: 把 leg2 改回窗口内，确认转绿**

把 leg2 行改成：

```js
	const leg2 = await measureLateSubscribe(BURST_LINES);
```

Run: `node --test --test-name-pattern "A5w:" test/terminal-snapshot.integration.test.mjs`
Expected: PASS —— `# pass 1` / `# fail 0`

- [ ] **Step 4: 连跑 5 轮确认确定性（V3）**

```bash
for i in 1 2 3 4 5; do
  node --test --test-name-pattern "A5w:" test/terminal-snapshot.integration.test.mjs | tail -3
done
```

Expected: 5/5 全过；记下每轮 `duration_ms`（写进 Task 6 的验收记录）。

- [ ] **Step 5: 提交**

```bash
git add test/terminal-snapshot.integration.test.mjs
git commit -m "test(attach): pin the snapshot frame window contract with A5w (issue #184)"
```

---

### Task 5: 设计文档 A5 行的口径补注

**Files:**
- Modify: `docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md`（`§7 验收矩阵` 表格之后、`可测性拆分设计见第 9 节。` 之前）

**Interfaces:**
- Consumes: spec v2 的 D3 补注文本（逐字）
- Produces: 无代码接口（供 U1 人工核对）

- [ ] **Step 1: 插入补注**

在 `:259`（表格最后一行 `| U3 | …`）与 `:260`（`可测性拆分设计见第 9 节。`）之间插入：

```markdown
> **2026-10-14 补注（issue #184）**：上表 A5 的「客户端永不静默丢失或重复输出」适用域为**快照窗口内**——
> frame 的容量上限为 `viewport rows + DEFAULT_SCROLLBACK_SNAPSHOT_CAP`（当前 24 + 256 = 280 行）。窗口外的
> 更早历史不在本协议保证范围内，协议帧不承载该段内容，客户端也不会收到截断信号（是否显式化另立项）；
> legacy 降级路径只有 screen.log 尾部回放，且是有界、best-effort 的历史来源，不是正确性来源。
> 机制、复现与依据见 issue #184。
```

- [ ] **Step 2: 人工核对（U1）**

对照检查：补注在表格之外（不破坏 markdown 表格）；原文一字未改（`git diff` 只应看到新增行）；文本与 spec v2 的 D3 逐字一致。

Run: `git -C /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-184-snapshot-window-contract diff docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md`
Expected: 只出现 `+` 行，无 `-` 行。

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md
git commit -m "docs(attach): note the snapshot window contract on the A5 acceptance row (issue #184)"
```

---

### Task 6: 验收扫尾（V4 / V5）

**Files:** 无预期改动（只跑命令与记录数据）；若发现缺陷，按 SDD 的 fix loop 处理。

- [ ] **Step 1: V1 —— A5 burst 用例隔离连跑 20 轮**

```bash
pass=0
for i in $(seq 1 20); do
  if node --test --test-name-pattern "A5: burst through the snapshot window" test/terminal-snapshot.integration.test.mjs >/tmp/a5-r$i.log 2>&1; then pass=$((pass+1)); else echo "FAIL round $i"; tail -30 /tmp/a5-r$i.log; fi
done
echo "A5 burst: $pass/20"
```

Expected: `20/20`；把每轮耗时与结果写进验收记录。

- [ ] **Step 2: V4 —— 全量剖面 ≥3 轮**

```bash
for i in 1 2 3; do
  echo "=== full run $i ==="
  npm test 2>&1 | tail -20
done
```

Expected: 逐轮记录 `pass/fail/skipped`、耗时与失败签名；`A5 burst` 与 `A5w` 零命中。范围外签名（`subscribe_terminal` / `editor_state` / `A2 reconnect`）如实记录、不阻塞本 issue。

- [ ] **Step 3: V5 —— 门禁**

```bash
npm run verify
```

Expected: 退出码 0（typecheck + perf gate + tests + coverage + pack:dry）；budget-audit 零违规；覆盖率仍过阈值。

- [ ] **Step 4: 记录验收数据**

把 Step 1–3 的逐轮数据（命令、轮次、结果、耗时、失败签名）整理成文本，回帖到 issue #184；`A5w` 的每轮 `duration_ms` 一并记录。

## Self-Review（作者自查，已执行）

- **spec 覆盖**：D1→Task 3；D2→Task 3（守卫 + 同源常量）；D3→Task 5；D4→Task 1+2；D5→Task 4；D6（范围）→ 全 plan 的 Global Constraints；V1–V5/U1 见开头追溯表，无遗漏项。
- **占位符扫描**：无 `TBD`/`TODO`/「适当处理」类描述；每个代码步骤都给了可直接落盘的完整代码。
- **类型/命名一致性**：`collectBurstIds` / `formatBurstDiagnostics` / `outputText` / `measureLateSubscribe` / `RUNNER_ROWS` / `BURST_LINES` / `MAX_BURST_MISC_ROWS` / `MISC_TOLERANCE` 在各 task 间命名一致；`formatBurstDiagnostics` 的入参键名（`driverTexts`/`frameText`/`liveTexts`）与 Task 2 静态断言 ② 锚定的键名一致。
- **执行顺序与依赖**：Task 1 → 2 → 3 → 4 → 5 → 6；每个 task 只消费前序 task 已产出的接口（Task 2 产出窗口常量；Task 3 消费它们并产出 `outputText`；Task 4 消费两者）。无跨 task 的前向引用。

## Amendments（实现后修订；两份都是 plan 自身的缺陷，非实现者失误）

1. **Task 3 的 `caseBody` 切片边界（acceptance sweep 发现，commit `987f96d`）**：原片段只切到下一个 `\ntest(`，而 Task 4 按本 plan 的要求把 `measureLateSubscribe` 插在两个用例之间，切片因此包含了 helper 的 4 个无 capture 的等待（静态断言 `4 !== 8`，全量套件下 3/3 红、单跑绿）。现改为切到「下一个顶层声明」（`\ntest(` / `\nfunction ` / `\nasync function `）。
2. **Task 4 的 500ms settle delay 删除（CR round 1 advisory）**：协议保证 catch-up flush chunk 先于 `snapshot_end` 发出（`src/core/terminal-attach-protocol.mjs:138-150`），客户端在处理 `snapshot_end` 时同步 emit flush，因此观察到 `snapshotReady` 即意味着整个窗口已在 `events` 里；固定睡眠是多余的时序运气。代码与本文档的 Task 4 片段已同步为不睡眠 + 注明该不变量。

**commit subject 约定备注（CR round 1 blocking finding 的核实结论）**：本 plan 的 `git commit` 命令给提交主语加 `(issue #<N>)` —— 这是本仓 plan 文档的历史惯例（`docs/superpowers/plans/` 里 `(issue #145)` 等出现 50+ 次），因为**写 plan 时只知道 issue 号、不知道 PR 号**。最终进 changelog 的是 squash 主语，其 `(#<PR>)` 由 GitHub 在 squash 时按 PR 标题自动追加（实证：PR #183 标题无 `(#183)`，而 main 上 `f81949d` 的主语有）；`scripts/release_helper.mjs` 读取的是 main 上「上一个 tag..HEAD」的主语（`commitSubjects()`），分支内主语不参与生成，因此不影响 changelog 与 release verify。PR 开出后新增的 commit 可以用 `(#<PR>)`（此时号码已知）。
