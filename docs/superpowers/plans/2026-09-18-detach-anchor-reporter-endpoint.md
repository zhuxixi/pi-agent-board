# ← detach 锚点反劫持 + editor reporter 端点修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** attach 表面的 `←` 不再被聊天区反色内容吞掉（tier-1 锚点加形态校验），且子 pi 的 editor-state reporter 恢复连接（runner 注入真实端点 + 身份握手，且不污染 warm-host 回收计数）。

**Architecture:** 分两半。A 半：把「哪一行是编辑器行」的判定从 UI 类的私有方法抽成 `src/core/pty-input.mjs` 的纯函数 `pickEditorAnchorLine`，判据是「反色**字符**数 === 1」（宽字符占 2 cell 但 1 字符，故不能用 cell 数），UI 只负责把缓冲行投影成 `{text, inverseCharCount}`。B 半：runner 在 spawn 子进程时注入 `AGENT_BOARD_CONTROL_SOCKET`（legacy 注入稳定端点、owned 注入 per-instance 端点）；reporter 用纯函数 `resolveControlEndpoint` 解析并发送 `clientId:"editor-reporter"` 的 hello；runner 用纯函数 `classifyClientHello` 识别它，把该 socket 移出 `clients` 计数集合转入 `editorReporters`，从而既恢复权威编辑器状态、又不让常驻连接掐死 warm-host 回收。

**Tech Stack:** Node 24（`node --test`）、TypeScript（`tsc --noEmit`）、`@xterm/headless` 6.x、`node-pty`、纯 ESM `.mjs` 核心模块。

**Spec:** `docs/superpowers/specs/2026-09-18-detach-anchor-reporter-endpoint-design.md`

## Global Constraints

- 验收 ID 与 spec §3 一一对应；每个 task 的 commit 前必须跑通该 task 列出的命令。
- **可测性拆分是硬约束**：判定逻辑必须留在纯函数里；`src/ui/pty-attach.ts` 只做缓冲行投影（`BufferLine → {text, inverseCharCount}`），不得把判定逻辑写回 UI。
- **判据是「反色字符数」（累加 `getChars().length`），不是「反色 cell 数」**：`草` 占 2 cell / 1 字符。按 cell 计数会破坏场景 B 的 draft 保护。
- 单元测试命令：`node --test test/<file>.test.mjs`；全量：`npm test`；类型：`npm run typecheck`。
- smoke 命令：`node --experimental-transform-types test-support/detach-gate-smoke.ts`（输出一行 JSON）。
- 不做 spec §5 的非目标：不动 pi 渲染、不引入边框/光标结构锚点、不重构 warm-host 回收策略、不动 `Ctrl+←` 与断开态 `←` 语义。
- `git add <file>` 逐个 stage，**不要** `git add -A`。
- 所有命令在 worktree 根目录执行：`C:\Users\27499\proj\opensource\pi-agent-board\.pi\worktrees\issue-103-detach-anchor-reporter-endpoint`。

---

### Task 1: `pickEditorAnchorLine` 纯函数（A1）

**Files:**
- Modify: `src/core/pty-input.mjs`（文件末尾新增导出函数）
- Test: `test/pty-input.test.mjs`（文件末尾新增用例）

**Interfaces:**
- Consumes: 同文件已有的 `isProbablyPiInputLine(line)` / `isProbablyEmptyPiInputLine(line)`。
- Produces: `pickEditorAnchorLine(candidates) → { empty: boolean } | null`，其中 `candidates: Array<{ text?: string, inverseCharCount?: number }>`，顺序为**自底向上**（缓冲区最后一行在前）。`null` 表示"没有可信的编辑器行，交回调用方继续兜底"。

- [ ] **Step 1: 写失败测试**

在 `test/pty-input.test.mjs` 末尾追加（先把 `pickEditorAnchorLine` 加进文件顶部的 import 列表）：

```js
test("pickEditorAnchorLine trusts a single inverse char on a glyph line (legacy draft)", () => {
	assert.deepEqual(pickEditorAnchorLine([{ text: "> 草稿", inverseCharCount: 1 }]), { empty: false });
	assert.deepEqual(pickEditorAnchorLine([{ text: "> ", inverseCharCount: 1 }]), { empty: true });
});

test("pickEditorAnchorLine trusts a single inverse char on a blank non-glyph line (new-style fake cursor)", () => {
	assert.deepEqual(pickEditorAnchorLine([{ text: "", inverseCharCount: 1 }]), { empty: true });
	assert.deepEqual(pickEditorAnchorLine([{ text: "   ", inverseCharCount: 1 }]), { empty: true });
});

test("pickEditorAnchorLine skips multi-char inverse chat content (issue #103 scenarios H/I)", () => {
	const diff = { text: "+ 65 ## R2 · #822 新 step 挂链顺序调研", inverseCharCount: 15 };
	const banner = { text: " Session saved ", inverseCharCount: 15 };
	assert.equal(pickEditorAnchorLine([diff]), null);
	assert.equal(pickEditorAnchorLine([banner]), null);
	// bottom-up order: the banner sits below the editor line, so a later candidate wins
	assert.deepEqual(pickEditorAnchorLine([banner, { text: "", inverseCharCount: 1 }]), { empty: true });
});

test("pickEditorAnchorLine skips a new-style draft line and keeps scanning (R1 trade-off)", () => {
	// Text + a single inverse fake cursor, no prompt glyph: deliberately untrusted
	// so the escape chain still releases the user (spec §2.1).
	assert.equal(pickEditorAnchorLine([{ text: "草稿", inverseCharCount: 1 }]), null);
	// …but a trusted editor line above it still anchors.
	assert.deepEqual(pickEditorAnchorLine([{ text: "草稿", inverseCharCount: 1 }, { text: "> ", inverseCharCount: 1 }]), { empty: true });
});

test("pickEditorAnchorLine ignores zero-count, malformed and empty input", () => {
	assert.equal(pickEditorAnchorLine([{ text: "  ", inverseCharCount: 0 }]), null);
	assert.equal(pickEditorAnchorLine([{}]), null);
	assert.equal(pickEditorAnchorLine([]), null);
	assert.equal(pickEditorAnchorLine(undefined), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/pty-input.test.mjs`
Expected: FAIL —— `pickEditorAnchorLine is not a function`（import 报 undefined）。

- [ ] **Step 3: 实现**

在 `src/core/pty-input.mjs` 末尾追加：

```js
/**
 * Pick the editor anchor line out of the buffer's inverse-video lines.
 *
 * Pi draws the editor's fake cursor as exactly ONE inverse CHARACTER (an
 * inverse space on an empty line, an inverse glyph inside a draft). Chat-area
 * inverse content — diff hunks from renderDiff, the inverse notification
 * banner, search highlights — is always a multi-character run. That difference
 * is the discriminator, because the editor line is frequently absent from the
 * buffer entirely (differential frames skip unchanged lines), which is what
 * made the old "bottom-most inverse line wins" anchor read chat content as a
 * draft and swallow ← (issue #103).
 *
 * Candidates are scanned bottom-up; anything that is not a single inverse
 * character is chat content and is skipped rather than trusted. A glyph row
 * keeps the pre-existing semantics of scenarios B/B3. A blank non-glyph row is
 * the new-style fake cursor. A single-inverse-character row that carries text
 * but no glyph is the new-style draft line: R1 deliberately does NOT trust it,
 * so the escape chain still releases the user (spec §2.1).
 *
 * Count characters, not cells: wide glyphs occupy two cells but yield one
 * `getChars()` entry (`草` = 2 cells / 1 char), so a cell-based rule would skip
 * every CJK fake cursor and break draft protection.
 *
 * @param {Array<{ text?: string, inverseCharCount?: number }>} candidates bottom-up
 * @returns {{ empty: boolean } | null} null = no trusted editor line (fall through)
 */
export function pickEditorAnchorLine(candidates) {
	for (const candidate of candidates ?? []) {
		if (Number(candidate?.inverseCharCount ?? 0) !== 1) continue;
		const text = String(candidate?.text ?? "");
		if (isProbablyPiInputLine(text)) return { empty: isProbablyEmptyPiInputLine(text) };
		if (text.trim().length === 0) return { empty: true };
	}
	return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/pty-input.test.mjs`
Expected: PASS（原有 5 个用例 + 新增 5 个）。

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-input.mjs test/pty-input.test.mjs
git commit -m "feat(core): add pickEditorAnchorLine inverse-character anchor rule (issue #103)"
```

---

### Task 2: tier-1 接入 + smoke 场景 O1/O2/O3（A2–A5）

**Files:**
- Modify: `src/ui/pty-attach.ts`（`:8` import、`:357-370` `findLastInverseCellLine` → `collectInverseCellLines`、`:372-400` `childInputLooksEmpty`）
- Modify: `test-support/detach-gate-smoke.ts`（K2 之后插入 O1/O2/O3）
- Modify: `test/pty-attach-detach-gate.test.mjs`（新增 3 条断言）

**Interfaces:**
- Consumes: Task 1 的 `pickEditorAnchorLine`。
- Produces: `PtyAttachComponent.collectInverseCellLines(active) → Array<{ text: string, inverseCharCount: number }>`（private；UI 侧唯一的副作用隔离点）。

- [ ] **Step 1: 写失败场景（smoke）**

在 `test-support/detach-gate-smoke.ts` 的 K2 场景块之后（`// L. Issue #89:` 之前）插入：

```ts
// O1. Issue #103: a chat-area diff hunk paints its changed fragments with
// inverse video (renderDiff) and there is no fake-cursor line in the buffer.
// The old tier-1 anchor grabbed that hunk and read "draft", so ← was forwarded
// and the user was trapped. Chat content must never veto detach.
{
	const { attach, sent, didDetach } = makeAttach();
	const DIFF_LINE = "\x1b[48;2;230;233;239m \x1b[38;2;64;160;43m+ 65 ## \x1b[7mR2 · \x1b[27m#\x1b[7m822 新 step 挂链顺序调研\x1b[27m";
	await writeToTerm(attach, "chat\r\n" + DIFF_LINE + "\r\n  ");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesWithDiffHighlightInChat = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// O2. Issue #103: the notification banner renders the whole entry inverse
// (`\x1b[7m … \x1b[27m`) — same hijack, same requirement.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat\r\n\x1b[7m Session saved \x1b[27m\r\n  ");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesWithInverseBannerInChat = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// O3. The R1 trade-off, pinned on purpose (spec §2.1; same spirit as K2): a
// new-style draft line (text + one inverse fake cursor, no prompt glyph) with
// no pushed editor_state is NOT trusted by the anchor rule, so ← escapes
// instead of being forwarded. Detach keeps the child session running, so the
// draft is not lost — a spurious detach beats a trapped user (#42/#48).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n\x1b[7m草\x1b[27m稿");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesOnNewStyleDraftWithoutReporter = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}
```

- [ ] **Step 2: 跑 smoke 确认 O1/O2 失败、O3 也失败**

Run: `node --experimental-transform-types test-support/detach-gate-smoke.ts`
Expected: 输出的 JSON 中 `leftDetachesWithDiffHighlightInChat: false`、`leftDetachesWithInverseBannerInChat: false`（当前 bug）；`leftDetachesOnNewStyleDraftWithoutReporter` 可能为 `true`（旧 tier-1 把该行当编辑器行 → 判非空 → 不 detach，所以也是 `false`）—— 三个键都要记下来，修完必须都为 `true`。

- [ ] **Step 3: 实现（UI 投影 + 判定接入）**

`src/ui/pty-attach.ts` 第 8 行 import 改为：

```ts
import { isProbablyEmptyPiInputLine, isProbablyPiInputLine, pickEditorAnchorLine, resolveEditorEmpty } from "../core/pty-input.mjs";
```

把 `:357-370` 的 `findLastInverseCellLine` 整体替换为：

```ts
	/** Bottom-up projection of every buffer line carrying inverse-video cells,
	 * with the inverse CHARACTER count. Pi's editor fake cursor is exactly one
	 * inverse character; chat-area diff hunks (renderDiff) and the inverse
	 * notification banner are multi-character runs — pickEditorAnchorLine does
	 * the discrimination. Counting characters rather than cells keeps wide
	 * glyphs (2 cells, 1 char) counted once (issue #103). */
	private collectInverseCellLines(active: {
		baseY: number;
		length: number;
		getLine(index: number): BufferLineLike | undefined;
	}): Array<{ text: string; inverseCharCount: number }> {
		const lines: Array<{ text: string; inverseCharCount: number }> = [];
		for (let y = active.baseY + active.length - 1; y >= active.baseY; y--) {
			const line = active.getLine(y);
			if (!line) continue;
			let inverseCharCount = 0;
			for (let x = 0; x < line.length; x++) {
				const cell = line.getCell(x);
				if (cell?.isInverse()) inverseCharCount += cell.getChars().length;
			}
			if (inverseCharCount > 0) lines.push({ text: line.translateToString(true) ?? "", inverseCharCount });
		}
		return lines;
	}
```

`childInputLooksEmpty()` 中的 tier-1 段（注释 + `findLastInverseCellLine` + `isProbablyEmptyPiInputLine`）替换为：

```ts
		// The terminal cursor is not a reliable anchor for the editor line:
		// while Pi streams output (or right after attach) the cursor rests on
		// working/output lines, never the input line, so a genuinely empty
		// editor was misread as non-empty and ← stopped detaching (issue #66).
		// Pi's editor line carries an inverse fake cursor, but the chat area is
		// full of inverse content too (diff hunks, the notification banner), and
		// the editor line is often missing from the buffer entirely — so the
		// anchor must also look like an editor line, and chat content must be
		// skipped rather than trusted (issue #103).
		const anchor = pickEditorAnchorLine(this.collectInverseCellLines(active));
		if (anchor !== null) return anchor.empty;
```

（tier-2 的字形扫描段与末尾 `return true` 保持不变。）

- [ ] **Step 4: 跑 smoke 确认全绿**

Run: `node --experimental-transform-types test-support/detach-gate-smoke.ts`
Expected: JSON 中 `leftDetachesWithDiffHighlightInChat`、`leftDetachesWithInverseBannerInChat`、`leftDetachesOnNewStyleDraftWithoutReporter` 全为 `true`，且既有键（`leftStaysGatedOnNonEmptyLine`、`leftDetachesWhenCursorOffEmptyInputLine`、`leftDetachesOnGlyphLineWithoutFakeCursor`、`leftDetachesOnTableRowsWithoutFakeCursor`、`leftDetachesOnContentGlyphFallback` 等）保持 `true`。

- [ ] **Step 5: 把 smoke 键接进单测**

在 `test/pty-attach-detach-gate.test.mjs` 的 `assert.equal(parsed.staleSocketEventsDoNotClearCurrent, ...)` 之前插入：

```js
	assert.equal(parsed.leftDetachesWithDiffHighlightInChat, true, "← must detach when chat-area diff inverse content sits above an empty editor line (issue #103)");
	assert.equal(parsed.leftDetachesWithInverseBannerInChat, true, "← must detach when an inverse notification banner sits above an empty editor line (issue #103)");
	assert.equal(parsed.leftDetachesOnNewStyleDraftWithoutReporter, true, "← must escape on an untrusted new-style draft rather than trap the user (issue #103, R1 trade-off)");
```

- [ ] **Step 6: 跑测试与类型检查**

Run: `node --test test/pty-attach-detach-gate.test.mjs test/pty-input.test.mjs && npm run typecheck`
Expected: 全 PASS，typecheck 0 error。

- [ ] **Step 7: Commit**

```bash
git add src/ui/pty-attach.ts test-support/detach-gate-smoke.ts test/pty-attach-detach-gate.test.mjs
git commit -m "fix(attach): stop chat-area inverse content from hijacking the ← gate (issue #103)"
```

---

### Task 3: `resolveControlEndpoint` 纯函数（A6）

**Files:**
- Modify: `src/core/paths.mjs`（`controlSocketPathFor` 之后新增导出函数）
- Test: `test/socket-path.test.mjs`（末尾新增用例）

**Interfaces:**
- Produces: `resolveControlEndpoint({ envSocketPath, platform, root, viewId }) → string`。Task 5 的 reporter 接线消费它。

- [ ] **Step 1: 写失败测试**

`test/socket-path.test.mjs` 顶部 import 追加 `resolveControlEndpoint`，末尾追加：

```js
// ---- hosted child control endpoint discovery (issue #103) -------------------

test("resolveControlEndpoint prefers the runner-injected endpoint (issue #103)", () => {
	const injected = "/tmp/root/views/view_1/control.i1.sock";
	assert.equal(
		resolveControlEndpoint({ envSocketPath: injected, platform: "linux", root: "/tmp/root", viewId: "view_1" }),
		injected,
	);
	const pipe = "\\\\.\\pipe\\pi-agent-board-view_1-deadbeef";
	assert.equal(
		resolveControlEndpoint({ envSocketPath: pipe, platform: "win32", root: "C:\\root", viewId: "view_1" }),
		pipe,
		"a win32 pipe name is passed through verbatim",
	);
});

test("resolveControlEndpoint falls back to the stable per-view endpoint (issue #103)", () => {
	const expected = controlSocketPathFor("linux", "/tmp/root", "view_abc123");
	for (const envSocketPath of [undefined, null, "", "   "]) {
		assert.equal(
			resolveControlEndpoint({ envSocketPath, platform: "linux", root: "/tmp/root", viewId: "view_abc123" }),
			expected,
			`env value ${JSON.stringify(envSocketPath)} must fall back to the stable endpoint`,
		);
	}
	assert.equal(
		resolveControlEndpoint({ platform: "win32", root: "C:\\root", viewId: "view_abc123" }),
		controlSocketPathFor("win32", "C:\\root", "view_abc123"),
	);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/socket-path.test.mjs`
Expected: FAIL —— `resolveControlEndpoint is not a function`。

- [ ] **Step 3: 实现**

在 `src/core/paths.mjs` 的 `controlSocketPath` 定义之后插入：

```js
/**
 * Endpoint a hosted child's editor-state reporter should connect to.
 *
 * The runner knows which endpoint it actually bound and injects it into the
 * child env as AGENT_BOARD_CONTROL_SOCKET (issue #103): since #70 the owned
 * runner binds a per-instance address, while the reporter kept dialing the
 * stable per-view one, so it never connected and the attach gate lost its
 * authoritative editor state. The injected value wins; the stable address
 * remains the fallback for legacy hosts and older runners that predate the key.
 * @param {{ envSocketPath?: string | null, platform: "win32"|"linux"|"darwin", root: string, viewId: string }} args
 */
export function resolveControlEndpoint({ envSocketPath, platform, root, viewId }) {
	const injected = typeof envSocketPath === "string" ? envSocketPath.trim() : "";
	return injected.length > 0 ? injected : controlSocketPathFor(platform, root, viewId);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/socket-path.test.mjs`
Expected: PASS（原有用例 + 新增 2 个）。

- [ ] **Step 5: Commit**

```bash
git add src/core/paths.mjs test/socket-path.test.mjs
git commit -m "feat(core): resolve the hosted control endpoint from the runner env (issue #103)"
```

---

### Task 4: `classifyClientHello` 协议助手（A8/A9 的前置）

**Files:**
- Create: `src/core/host-protocol.mjs`
- Test: `test/host-protocol.test.mjs`

**Interfaces:**
- Produces: `CLIENT_ID_PROBE = "probe"`、`CLIENT_ID_EDITOR_REPORTER = "editor-reporter"`、`classifyClientHello(msg) → "probe" | "editor-reporter" | "client"`。Task 6 的 runner 与 Task 5 的 reporter 各自引用常量，保证两端字符串不漂移。

- [ ] **Step 1: 写失败测试**

新建 `test/host-protocol.test.mjs`：

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_ID_EDITOR_REPORTER, CLIENT_ID_PROBE, classifyClientHello } from "../src/core/host-protocol.mjs";

test("classifyClientHello recognizes the read-only probe handshake", () => {
	assert.equal(classifyClientHello({ type: "hello", clientId: CLIENT_ID_PROBE }), "probe");
});

test("classifyClientHello recognizes the resident editor reporter (issue #103)", () => {
	assert.equal(classifyClientHello({ type: "hello", clientId: CLIENT_ID_EDITOR_REPORTER }), "editor-reporter");
});

test("classifyClientHello treats every other hello as a real client", () => {
	assert.equal(classifyClientHello({ type: "hello", clientId: "ui-test" }), "client");
	assert.equal(classifyClientHello({ type: "hello" }), "client");
	assert.equal(classifyClientHello({ type: "hello", clientId: 42 }), "client");
	assert.equal(classifyClientHello({}), "client");
	assert.equal(classifyClientHello(null), "client");
	assert.equal(classifyClientHello(undefined), "client");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/host-protocol.test.mjs`
Expected: FAIL —— `Cannot find module '../src/core/host-protocol.mjs'`。

- [ ] **Step 3: 实现**

新建 `src/core/host-protocol.mjs`：

```js
/** Control-socket client identity helpers (issue #103).
 *
 * Client ids travel in the `hello` handshake. The runner uses them to keep
 * bookkeeping-only connections out of `attachedClients` / `attachedEver`:
 * the attach resolver's probes are read-only, and the hosted child's
 * editor-state reporter is a resident connection — counting either would pin
 * every host against warm-host reclaim (issue #75 / #103 §C).
 */

/** Read-only endpoint probe (attach resolver); never counts as attached. */
export const CLIENT_ID_PROBE = "probe";
/** Resident editor-state reporter inside a hosted child; never counts as attached. */
export const CLIENT_ID_EDITOR_REPORTER = "editor-reporter";

/**
 * @param {{ type?: string, clientId?: string } | null | undefined} msg
 * @returns {"probe" | "editor-reporter" | "client"}
 */
export function classifyClientHello(msg) {
	const clientId = msg && typeof msg.clientId === "string" ? msg.clientId : "";
	if (clientId === CLIENT_ID_PROBE) return "probe";
	if (clientId === CLIENT_ID_EDITOR_REPORTER) return "editor-reporter";
	return "client";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/host-protocol.test.mjs`
Expected: PASS（3 个用例）。

- [ ] **Step 5: Commit**

```bash
git add src/core/host-protocol.mjs test/host-protocol.test.mjs
git commit -m "feat(core): classify control-socket client hellos (issue #103)"
```

---

### Task 5: reporter 身份握手 + 端点接线（A7）

**Files:**
- Modify: `src/core/editor-state-reporter.mjs`（`connect` 事件处理器）
- Modify: `src/index.ts`（`:12` import、`:115-123` reporter 构造）
- Test: `test/editor-state-reporter.test.mjs`（新增 1 个用例 + 修正既有 `sent.length` 断言）

**Interfaces:**
- Consumes: Task 3 的 `resolveControlEndpoint`、Task 4 的 `CLIENT_ID_EDITOR_REPORTER`。
- Produces: reporter 在每次 `connect` 成功后发送 `{ type: "hello", clientId: "editor-reporter" }`，随后才推 `editor_state`。

- [ ] **Step 1: 写失败测试**

在 `test/editor-state-reporter.test.mjs` 末尾追加：

```js
test("reporter identifies itself with a hello on every (re)connect (issue #103)", () => {
	const sched = fakeScheduler();
	const first = fakeSocket();
	const second = fakeSocket();
	let call = 0;
	const reporter = createEditorStateReporter({
		getEditorText: () => "",
		connect: () => (++call === 1 ? first : second),
		scheduler: sched,
		intervalMs: 100,
	});
	reporter.start();
	first.emitConnect();
	assert.deepEqual(JSON.parse(first.sent[0]), { type: "hello", clientId: "editor-reporter" });
	sched.fireOne(100);
	assert.deepEqual(JSON.parse(first.sent[1]), { type: "editor_state", empty: true });
	// A reconnect must re-announce: the runner needs the id to keep this socket
	// out of attachedClients (issue #103 §C).
	first.emit("close");
	sched.fireOne(1100);
	second.emitConnect();
	assert.deepEqual(JSON.parse(second.sent[0]), { type: "hello", clientId: "editor-reporter" });
	reporter.stop();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/editor-state-reporter.test.mjs`
Expected: FAIL —— 新用例首帧是 `editor_state` 而非 hello。

- [ ] **Step 3: 实现 reporter 握手**

`src/core/editor-state-reporter.mjs`：在文件顶部 import 区之后加入（该文件目前无 import，直接放常量定义）：

```js
import { CLIENT_ID_EDITOR_REPORTER } from "./host-protocol.mjs";
```

并把 `tryConnect()` 中的 connect 处理器：

```js
		s?.on?.("connect", () => { if (socket === s) { backoffMs = 1000; startPolling(); } });
```

改为：

```js
		s?.on?.("connect", () => {
			if (socket !== s) return;
			backoffMs = 1000;
			// Announce the client id before any state: the runner keeps this
			// resident socket out of attachedClients/attachedEver so warm-host
			// reclaim still sees an idle host (issue #103 §C).
			send({ type: "hello", clientId: CLIENT_ID_EDITOR_REPORTER });
			startPolling();
		});
```

注意 `send()` 内部检查 `if (!socket) return;` —— 此时 `socket === s` 已赋值，故 hello 一定发出。

- [ ] **Step 4: 修正既有断言（hello 使帧数 +1）**

`test/editor-state-reporter.test.mjs` 中这些断言按新协议更新：

1. `"reporter polls and sends only on text change (A1)"`：把
   `assert.deepEqual(socket.sent.map((l) => JSON.parse(l)), [{ type: "editor_state", empty: true }]);`
   改为
   `assert.deepEqual(socket.sent.map((l) => JSON.parse(l)), [{ type: "hello", clientId: "editor-reporter" }, { type: "editor_state", empty: true }]);`
   并把该用例后续的 `assert.equal(socket.sent.length, 2)` / `3` 各 +1（变成 3 / 4）。
2. `"reporter stop is idempotent and ends polling (A1)"`：`assert.equal(socket.sent.length, 1)` → `2`。
3. `"reporter retries connect with capped backoff then recovers (A2)"`：`assert.equal(socket.sent.length, 0)`（connect 前）保持 `0`；末尾 `assert.equal(socket.sent.length, 1)` → `2`。
4. `"reporter reconnects after socket close (A2)"`：`assert.equal(first.sent.length, 1)` → `2`；`assert.equal(second.sent.length, 1)` → `2`。
5. `"reporter survives a throwing getEditorText (A1 hardening)"`：`assert.equal(socket.sent.length, 0)` → `1`（hello 已发，editor_state 因抛错未发）；末尾 `assert.equal(socket.sent.length, 1)` → `2`，且 `assert.deepEqual(JSON.parse(socket.sent[0]), ...)` → `JSON.parse(socket.sent[1])`。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/editor-state-reporter.test.mjs`
Expected: PASS（6 个用例）。

- [ ] **Step 6: 接线 `src/index.ts`**

第 12 行 import 改为：

```ts
import { controlSocketPathFor, defaultRoot, resolveControlEndpoint } from "./core/paths.mjs";
```

reporter 构造里的 `connect` 改为：

```ts
			connect: () => createConnection(resolveControlEndpoint({
				// The runner injects the endpoint it actually bound (issue #103);
				// falling back to the stable per-view address keeps older runners
				// and legacy hosts working.
				envSocketPath: process.env.AGENT_BOARD_CONTROL_SOCKET,
				platform: process.platform as "win32" | "linux" | "darwin",
				root,
				viewId: hostedViewId,
			})),
```

（若 `controlSocketPathFor` 因此在该文件不再被使用，从 import 中移除它。）

- [ ] **Step 7: 类型检查**

Run: `npm run typecheck`
Expected: 0 error。（若有 "unused import" 报错，删掉未使用的 `controlSocketPathFor`。）

- [ ] **Step 8: Commit**

```bash
git add src/core/editor-state-reporter.mjs src/index.ts test/editor-state-reporter.test.mjs
git commit -m "fix(reporter): identify as editor-reporter and dial the injected endpoint (issue #103)"
```

---

### Task 6: runner 反污染 + env 注入（A8/A9）

**Files:**
- Modify: `runner/pty-runner.mjs`（import、legacy spawn env `:226-236`、legacy server handler `:302-330`、legacy hello case `:340-343`、legacy shutdown `:403-408`、owned spawn env `:784-796`、owned server handler `:702-732`、owned hello case `:906-916`、owned finishHost `:558-564`）
- Modify: `test-support/fake-pty-pi.mjs`（新增可选 env 捕获）
- Test: `test/pty-runner.integration.test.mjs`（新增 1 个用例）

**Interfaces:**
- Consumes: Task 4 的 `CLIENT_ID_*` / `classifyClientHello`。
- Produces: 两处 spawn env 中的 `AGENT_BOARD_CONTROL_SOCKET`（= 该宿主实际绑定的端点）；runner 端 `editorReporters: Set<Socket>`（reporter socket 不计入 `clients`、不翻 `attachedEver`）。

- [ ] **Step 1: fake pi 支持 env 捕获（供 A8 的端到端断言）**

`test-support/fake-pty-pi.mjs` 在 `FAKE_PTY_ARGV_CAPTURE_PATH` 块之后插入：

```js
if (process.env.FAKE_PTY_ENV_CAPTURE_PATH) {
	appendFileSync(process.env.FAKE_PTY_ENV_CAPTURE_PATH, `${process.env.AGENT_BOARD_CONTROL_SOCKET ?? ""}\n`);
}
```

- [ ] **Step 2: 写失败测试**

在 `test/pty-runner.integration.test.mjs` 的 `"probe connections leave host.json untouched; real clients flip attachedEver (CR r1 f3)"` 用例之后插入：

```js
test("editor reporter connections leave attachedClients/attachedEver untouched (issue #103)", async () => {
	const root = freshRoot();
	const envCapture = join(root, "child-env.txt");
	let runner;
	let childPid;
	try {
		// NOTE: launchOwnedRunner spreads opts.config over its defaults, and the default
		// env is `{ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" }` — pass the whole env object,
		// or the pipe fallback disappears on Windows.
		const { runner: r, socketPath } = await launchOwnedRunner(root, "v1", "i103", {
			config: { env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_ENV_CAPTURE_PATH: envCapture } },
		});
		runner = r;
		const host = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h?.readyAt != null && h?.childPid ? h : false;
		});
		childPid = host.childPid;

		// The runner must hand the child the endpoint it actually bound (#103 §B).
		const injected = await waitFor(() => {
			try {
				return readFileSync(envCapture, "utf8").trim() || false;
			} catch {
				return false;
			}
		}, 5000);
		assert.equal(injected, socketPath, "the child env must carry the per-instance control endpoint");

		// Resident reporter: identity hello, then editor_state keeps flowing.
		const reporter = createConnection(socketPath);
		reporter.on("error", () => {});
		await once(reporter, "connect");
		const reporterMessages = [];
		let buf = "";
		reporter.on("data", (chunk) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) reporterMessages.push(JSON.parse(line));
		});
		reporter.write(JSON.stringify({ type: "hello", clientId: "editor-reporter" }) + "\n");
		await waitFor(() => reporterMessages.find((m) => m.type === "hello"));

		const afterReporter = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.attachedClients === 0 && h.attachedEver !== true ? h : false;
		}, 3000);
		assert.equal(afterReporter.attachedClients, 0, "a resident reporter must not count as an attached client");
		assert.notEqual(afterReporter.attachedEver, true, "a resident reporter must not mark the host attached");
		reporter.write(JSON.stringify({ type: "editor_state", empty: true }) + "\n");

		// A real UI client still counts, and detaching it releases the host even
		// though the reporter stays connected (the warm-host reclaim guard).
		const client = createConnection(socketPath);
		client.on("error", () => {});
		await once(client, "connect");
		client.write(JSON.stringify({ type: "hello", clientId: "ui-test" }) + "\n");
		const counted = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.attachedClients === 1 ? h : false;
		}, 3000);
		assert.equal(counted.attachedClients, 1, "a real client still counts as attached");
		client.destroy();
		const released = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.attachedClients === 0 ? h : false;
		}, 3000);
		assert.equal(released.attachedClients, 0, "reporter-only host must read as detached for warm-host reclaim");
		reporter.destroy();

		// Cleanup stays on the tested path: natural child exit.
		const exitClient = createConnection(socketPath);
		exitClient.on("error", () => {});
		await once(exitClient, "connect");
		send(exitClient, { type: "input", data: "exit\r" });
		await waitForExit(runner, 5000);
		exitClient.destroy();
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

`launchOwnedRunner(root, viewId, instanceId, { config })` 会把 `config` 键覆盖进 host-config（定义见 `test/pty-runner.integration.test.mjs:592-626`），断言本身不依赖其它覆盖项。

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/pty-runner.integration.test.mjs`
Expected: FAIL —— `injected` 为空（env 未注入）、或 `attachedClients` 为 1（reporter 被计数）。

- [ ] **Step 4: 实现 runner 改动**

`runner/pty-runner.mjs`：

(a) 顶部 import 区新增：

```js
import { classifyClientHello } from "../src/core/host-protocol.mjs";
```

(b) **legacy spawn env**（`:226-236` 的 `const env = {...}`）在 `AGENT_BOARD_HOSTED: "pty",` 之后插入一行：

```js
		// The endpoint this host actually bound: the child's editor-state reporter
		// dials it instead of guessing the stable per-view address (issue #103).
		AGENT_BOARD_CONTROL_SOCKET: socketPath,
```

(c) **owned spawn env**（`:784-796`，同样结构）插入同样的 `AGENT_BOARD_CONTROL_SOCKET: socketPath,`。

(d) **legacy 客户端集合**：`:123` 的 `const clients = new Set();` 之后新增：

```js
	/** Resident editor-state reporters: connected but never "attached" (#103). */
	const editorReporters = new Set();
```

(e) **legacy server handler**（`:302-330`）：

- 删除 `update({ attachedEver: true });`（连接即翻是 #103 §C 的污染源）；
- `close` 与 `error` 两个处理器里，在 `clients.delete(socket);` 之后各加一行 `editorReporters.delete(socket);`。

(f) **legacy hello case**（`:340-343`）替换为：

```js
			case "hello": {
				// Bookkeeping-only clients must never pin the host against warm-host
				// reclaim (issue #103 §C): probes are read-only, the editor reporter
				// is resident. A reporter socket leaves `clients` (the attachedClients
				// source) but stays writable so editor_state keeps flowing.
				const kind = classifyClientHello(msg);
				if (kind === "client") update({ attachedEver: true });
				if (kind === "editor-reporter") {
					clients.delete(socket);
					editorReporters.add(socket);
					update();
				}
				send(socket, { type: "hello", status: host, editorEmpty });
				break;
			}
```

(g) **legacy shutdown**（`:403-408` 的 `for (const client of clients) { ... client.end(); }`）之后新增：

```js
		for (const reporter of editorReporters) {
			try { reporter.end(); } catch { /* best effort */ }
		}
		editorReporters.clear();
```

(h) **owned 客户端集合**：`:449` 的 `const clients = new Set();` 之后新增同样的 `editorReporters` 集合定义（含注释）。

(i) **owned server handler**（`:702-732`）：

- `socket.on("close")` 与 `socket.on("error")` 中，在 `terminalSubscriptions.delete(socket);` 之后各加 `editorReporters.delete(socket);`。

(j) **owned hello case**（`:906-916`）替换为：

```js
			case "hello": {
				// Probe and reporter sockets are bookkeeping-only: neither may flip
				// attachedEver nor keep attachedClients non-zero, or warm-host reclaim
				// never fires and hosts leak (issue #103 §C).
				const kind = classifyClientHello(msg);
				if (kind === "probe") {
					socket.markProbe?.();
				} else if (kind === "editor-reporter") {
					clients.delete(socket);
					terminalSubscriptions.delete(socket);
					editorReporters.add(socket);
					ownedUpdate((cur) => ({ ...cur }));
				} else {
					ownedUpdate((cur) => ({ ...cur, attachedEver: true }));
				}
				send(socket, { type: "hello", status: host, editorEmpty });
				break;
			}
```

(k) **owned finishHost**（`:558-564` 的 `for (const c of clients) { ... } clients.clear();`）之后新增：

```js
		for (const reporter of editorReporters) {
			try { reporter.destroy(); } catch { /* best effort */ }
		}
		editorReporters.clear();
```

注：probe clientId 的比较改由 `classifyClientHello` 统一，`CLIENT_ID_PROBE` 常量与 `"probe"` 字面量语义一致，故既有 probe 集成测试必须继续通过。

- [ ] **Step 5: 确认 legacy `attachedEver` 没有生产消费方**

Run: `grep -rn "attachedEver" src runner | grep -v node_modules`
Expected: 只有 `src/core/types.mjs:144`（类型注释）与 `runner/pty-runner.mjs:159`（初始化）、`:304`（legacy connect）、`:914`（owned hello）—— **没有任何生产代码读取它**，读取方只有测试断言。
Action: 若 grep 出现计划外的读取方，停下来报告，不要继续推迟 legacy 的翻转。

- [ ] **Step 6: 跑集成测试与相关单测**

Run: `node --test test/pty-runner.integration.test.mjs test/host-protocol.test.mjs test/warm-host-sweeper.test.mjs test/warm-host-sweep.integration.test.mjs`
Expected: 全 PASS —— 新用例的三个 `attachedClients`/`attachedEver` 断言成立，且既有 probe 用例（`"probe connections leave host.json untouched; real clients flip attachedEver"`）仍然通过。

- [ ] **Step 7: Commit**

```bash
git add runner/pty-runner.mjs test-support/fake-pty-pi.mjs test/pty-runner.integration.test.mjs
git commit -m "fix(host): keep the editor reporter out of attachedClients (issue #103)"
```

---

### Task 7: 全量验证与验收对账（A10 + U1–U4 准备）

**Files:**
- 无代码改动（只跑门禁 + 记录）

**Interfaces:**
- Consumes: Task 1–6 的全部产物。
- Produces: 验收矩阵的执行记录（给 CR / issue 评论用）。

- [ ] **Step 1: 静态 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: typecheck 0 error；全量测试 0 fail（若出现与本改动无关的既有 flaky，按 issue #95/#121 的已知不稳定性记录，并单独重跑该文件确认）。

- [ ] **Step 2: smoke 复跑**

Run: `node --experimental-transform-types test-support/detach-gate-smoke.ts`
Expected: 全键 `true`。

- [ ] **Step 3: 覆盖率门禁**

Run: `npm run test:coverage`
Expected: 通过（若覆盖率阈值因新增文件未覆盖而失败，补测对应纯函数的边界用例，而不是放宽阈值）。

- [ ] **Step 4: 记录验收对账**

把 A1–A10 的实际命令与结果、以及 U1–U4 的"待实机执行"状态写进 issue #103 评论（U 项在合并前无法自动执行时保留 `pending`，不得宣称全部验收完成）。

- [ ] **Step 5: Commit（仅在产生了文档改动时）**

```bash
git add <changed-docs>
git commit -m "docs: record issue #103 acceptance evidence"
```

## 验收矩阵 → Task 映射

| 验收 ID | Task |
|---|---|
| A1 | Task 1 |
| A2 / A3 / A4 / A5 | Task 2（smoke O1/O2/O3 + 既有场景回归） |
| A6 | Task 3 |
| A7 | Task 5 |
| A8 / A9 | Task 6 |
| A10 | Task 7 |
| U1–U4 | Task 7 Step 4 记录，合并前由用户在真机执行 |
