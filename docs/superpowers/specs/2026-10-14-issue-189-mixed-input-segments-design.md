Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T12:45:00Z
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T13:10:00Z (round-1 findings R1-G1/G2/G3/D1/D2 all accepted)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T13:22:00Z (round-2 finding R2-D1 accepted: report table row 3 relabelled as defensive-only)
Revised: zai-coding-cn/glm-5.3-flash (selected) · zai-coding-cn/glm-5.3-flash (physical) @ 2026-10-15T00:24:50Z (round-2 review follow-up: A9 pinning strengthened)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-16T00:30:00Z (post-merge composition with main's #194 inbound reply guard; zima CR advisory on PR #196)

# Spec: #189 — attach(legacy): dispatch a mixed input read per segment, and stop treating terminal reports as user intent

- Issue: https://github.com/zhuxixi/pi-agent-board/issues/189
- Kind: bug — root-cause report + fix design
- Repo: `zhuxixi/pi-agent-board` · baseline `main` @ `f81949d` · planned worktree `issue-189-mixed-input-segments`
- Route: bug → `systematic-debugging` (Phase 1 root cause + runtime repro in `research/`, this document is the design)
- Research: `~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-189/research/`
  (`01-root-cause-and-reachability.md`, `03-fix-hypothesis-validated.md`, prototype `02-prototype.patch`)
- Scope: **#189 only.** #187 (motion-less drag) and #188 (X10 release) are separate, in-flight
  issues; this fix must work with both still broken. #186 stays the UX umbrella.

## 1. Problem

In the legacy (regular-TUI) attach path the whole input read is classified all-or-nothing:

| Spot | Location | Behaviour |
|---|---|---|
| `parseMouseInputChunk` | `src/core/pty-scroll.mjs:84` | Returns the decoded mouse events only when **every** byte of the chunk is a mouse report; one stray byte → `null`. |
| `handleInput` head | `src/ui/pty-attach.ts:297-298` | `null` means "not a mouse chunk" → the whole chunk enters the keyboard chain. |
| `handleInput` default branch | `src/ui/pty-attach.ts:373-376` | `clearPendingClick(); clearSelection(); scrollToBottom(); send({ type: "input", data })` — the **whole** chunk, mouse bytes included, is forwarded into the hosted session. |

Terminals coalesce a mouse release with bytes they send for their own reasons — focus in/out
reports (`\x1b[I`/`\x1b[O`), query replies, colour-scheme reports, OSC responses. When that happens
the mouse events are dropped (no copy, selection cleared, viewport reset) **and** the raw mouse
bytes are typed into the hosted session.

The keyboard chain has no branch of its own for terminal *reports* either: a spontaneously arriving
report takes the same default branch, so it destroys an in-progress selection and snaps the reading
position to the bottom although it carries no user intent.

### Runtime reproduction (this session, 2026-10-14, main `f81949d`)

Real `PtyAttachComponent` + real runner socket + fake PTY, OSC 52 observed on a fake
`tui.terminal.write`, `{type:"input"}` frames observed on a `Socket.write` tap
(`research/01-root-cause-and-reachability.md`, probes 1+2):

| Input (one `handleInput` call per step) | OSC 52 | selection | forwarded as input |
|---|---|---|---|
| control: press / move / release, separate chunks | `fake pi ready` | retained | — |
| press, move, then `"\x1b[<0;16;2m\x1b[I"` (release + focus-in) | none | **`null`** | **whole chunk** |
| press, move, then `"\x1b[I\x1b[<0;16;2m"` (report first) | none | **`null`** | **whole chunk** |
| press, move, then `"\x1b[I"` (report alone) | none | **`null`** | `"\x1b[I"` |
| `"\x1b[<64;10;3M\x1b[I"` (wheel + report) on a scrollable buffer | none | **`null`** | **whole chunk**, wheel never applied |
| `"\x1b]11;rgb:0d0d/0d0d/0d0d\x07"` (OSC 11 reply) mid-drag | none | **`null`** | the reply (intended) |
| `"\x1b[I"` while scrolled back (200-line buffer) | — | — | viewport `178` → **`null`** |

Two findings beyond the issue text, both reproduced: the split must work in **both orders** (a
report can precede the mouse report in the same read), and a coalesced **wheel** event both stops
scrolling and leaks its bytes into the child.

Why the offending bytes are realistically there: the host pi's own reply filters are whole-chunk
anchored (`/^\x1b\[\?[\d;]*c$/`, `/^\x1b\[6;(\d+);(\d+)t$/`, `COLOR_SCHEME_REPORT_PATTERN`,
`pi-tui terminal-colors.js` OSC pattern), so coalescing defeats them and the bytes land on the
attach component's keyboard path; and the board **deliberately** forwards the child's terminal
queries (`extractOscQuerySequences`, #128) whose replies have no local owner — the code comment at
`src/ui/pty-attach.ts:658-662` states that they fall through `handleInput` into the child PTY.

Not a regression: `git log -S parseMouseInputChunk -- src/` → single hit `ffc2c8c` (2026-08-30).

## 2. Goal / non-goals

**Goal.** One input read is dispatched segment by segment in arrival order: mouse runs go to the
existing mouse path, terminal *reports* are passed through to the child without touching selection
or viewport, everything else keeps today's keyboard semantics byte-for-byte. The issue's exact
mixed chunk (either order) copies the selection again and leaks nothing into the child.

**Non-goals.**

- Mouse decoding itself: `parseMouseEventPrefix`, the SGR/X10 branches, wheel classification. #188
  owns the X10 release bug; #187 owns the motion-less drag classification. Neither is assumed fixed.
- The drag/click/copy/highlight contract (`shouldCopy`, pending click, #172 highlight retention) and
  `handleLocalMouseEvent` — untouched.
- Fullscreen host mode / `handleMouse` / pi-tui selection: in fullscreen `TuiAltScreen` consumes raw
  mouse sequences and focus reports as an input listener before any overlay, so the legacy parser
  never sees them (`tui-alt-screen.js:105,475-527`). Scope is regular TUI mode (and pi < 1.0).
- #186 UX items (selection background colour, 1-cell press selection, `pbcopy` fallback, Shift+drag
  docs).
- Forwarding policy for reports (they are forwarded as today), `childInputReady`/startup echo
  ordering (#165/#180), the run of a *key* clearing the selection and jumping to the bottom (stays).
- No new env knob, no new dependency, no new I/O surface, no change to `parseMouseInputChunk`'s
  contract (its unit tests and #188's planned cases depend on it).

## 3. Design

### 3.1 Pure decision layer — `src/core/pty-scroll.mjs`

**(a) `parseMouseRun(data, offset)`** — module-private: reads a maximal run of concatenated mouse
reports using the existing `parseMouseEventPrefix`. Returns `{ events, length }` or `null`.
`parseMouseInputChunk` is re-expressed on top of it and keeps its exact contract:

```js
export function parseMouseInputChunk(data) {
	if (!data) return null;
	const run = parseMouseRun(data);
	return run && run.length === data.length ? run.events : null;
}
```

**(b) Report table + `parseReportPrefix` / `parseReportRun`** — module-private. A *report* is a
complete byte sequence the real terminal sends in answer to a query, never in answer to a key.
Every pattern is grounded in a query this stack actually issues — except row 3, which is kept as a
defensive extra and labelled as such; anything not listed keeps today's keyboard semantics
(fail-safe direction: an unknown sequence is typing).

| # | Pattern | What produces it |
|---|---|---|
| 1 | `\x1b[I` / `\x1b[O` | focus in/out, DECSET 1004 (pi's fullscreen TUI enables it; regular mode only via leaked terminal state) |
| 2 | `CSI ? <digits[;digits]> c` | DA1 reply to `\x1b[c` — the trailing sentinel of Pi's colour batch (`pi-tui tui.js:57`) |
| 3 | `CSI > <digits[;digits]> c` | **not grounded (defensive only)**: this stack sends no DA2 query — the only DA query is `\x1b[c` (`pi-tui terminal.js:15`), whose reply row 2 covers — and XTVERSION replies are DCS-shaped, i.e. deliberately excluded below. Kept because no keystroke encodes as a `>`-prefixed CSI, and a stray DA2 reply would otherwise reach the keyboard path. |
| 4 | `CSI ? <digits[;digits]> u` | kitty keyboard flag reply to `\x1b[?u` (`pi-tui terminal.js:210`) |
| 5 | `CSI ? <digits[;digits]> n` | mode/status reports, incl. the colour-scheme report `\x1b[?997;1n` Pi parses (`terminal-colors.js:19`) |
| 6 | `CSI <digits[;digits]> t` | XTWINOPS replies — the host asks for the cell size with `\x1b[16t` (`tui.js:603`) and consumes `CSI 6;h;wt` |
| 7 | `OSC <body ≤4096 bytes> BEL\|ST` | colour replies (OSC 10/11/12, OSC 4) and other reply bodies (e.g. program status OSC 7501) |

Deliberately **not** matched (a keystroke can look like them, so they keep key semantics, and the
exclusion is part of the contract): `CSI … R` (cursor-position report, but also modifier-F3),
`u`-final CSI without `?` (kitty key events), `CSI … $ y` (DECRPM — nothing in this stack queries
modes), DCS replies (no in-repo DCS query).

**(c) `splitAttachInput(data)`** — the new public function (the only one):

```js
/** @returns {Array<{kind:"mouse", events:[…]} | {kind:"report", data:string} | {kind:"key", data:string}>} */
export function splitAttachInput(data) {
	if (!data) return [];
	const segments = [];
	let offset = 0;
	while (offset < data.length) {
		const mouse = parseMouseRun(data, offset);
		if (mouse) { pushSegment(segments, { kind: "mouse", events: mouse.events }); offset += mouse.length; continue; }
		const report = parseReportRun(data, offset);
		if (report) { pushSegment(segments, { kind: "report", data: report }); offset += report.length; continue; }
		// Neither: keyboard text up to the next ESC.
		const next = data.indexOf("\x1b", offset + 1);
		const end = next === -1 ? data.length : next;
		pushSegment(segments, { kind: "key", data: data.slice(offset, end) });
		offset = end;
	}
	return segments;
}
```

Decision table (consecutive same-kind segments are merged; a partial/trailing escape sequence is
never recognised and becomes `key`, i.e. the bytes the all-or-nothing parser used to forward):

| Input (one read) | Segments |
|---|---|
| `"\x1b[<64;10;20M\x1b[<65;10;20M"` | `[mouse(2)]` |
| `"\x1b[<0;16;2m\x1b[I"` | `[mouse(1), report]` |
| `"\x1b[I\x1b[<0;16;2m"` | `[report, mouse(1)]` |
| `"\x1b[I\x1b[O\x1b[<0;16;2m"` | `[report ("\x1b[I\x1b[O"), mouse(1)]` |
| `"\x1b[<0;16;2mx"` / `"x\x1b[<0;16;2m"` | `[mouse(1), key "x"]` / `[key "x", mouse(1)]` |
| `"\x1b[Ix"` / `"x\x1b[I"` | `[report, key "x"]` / `[key "x", report]` |
| `"\x1b[5~\x1b[6~"` (adjacent key runs **merge**) | `[key "\x1b[5~\x1b[6~"]` — one segment, so `matchesKey` sees the same concatenation as today |
| `"hello"` | `[key "hello"]` |
| `""` | `[]` |
| `"\x1b[<0;16"` (truncated) | `[key "\x1b[<0;16"]` |
| `"\x1b[?997;1"` (truncated report) | `[key "\x1b[?997;1"]` |
| `"\x1b[1;2R"`, `"\x1b[97;5u"`, `"\x1bP1+r…\x1b\\"` (kept as keys) | `[key …]` |

### 3.2 Component wiring — `src/ui/pty-attach.ts`

`handleInput` becomes a dispatch loop; the existing keyboard chain moves verbatim into a private
`handleKeyInput(segment)` (same branches, same `return`s — no logic change):

```ts
	handleInput(data: string): void {
		for (const segment of splitAttachInput(data)) {
			if (segment.kind === "mouse") {
				this.handleMouseInputChunk(segment.events);
			} else if (!this.consumeByReplyGuard(segment.data)) {
				if (segment.kind === "report") this.send({ type: "input", data: segment.data });
				else this.handleKeyInput(segment.data);
			}
			// A detach/close inside a segment must stop the rest of this read.
			if (this.closed) return;
		}
	}
```

`consumeByReplyGuard(data)` (new private method) runs the issue #170/#194 inbound reply guard over one
non-mouse **segment** and returns true when the guard took it — a complete protocol reply (DA1/DA2,
kitty flags, cell-size, DCS) is dropped, a colour reply is forwarded as one whole sequence. Feeding
segments instead of raw reads is what keeps a reply head from absorbing keys that were coalesced into
the same read (the very case #189 exists for).

- `mouse` → the existing `handleMouseInputChunk` (wheel branch + `handleLocalMouseEvent`), unchanged.
- `report` → passed through the reply guard first; whatever the guard does not own is forwarded to
  the child (it may be the answer the child's own query is waiting for) but **without**
  `clearPendingClick()` / `clearSelection()` / `scrollToBottom()`: it arrives without user intent.
- the reply guard (#170/#194) keeps its drop/forward policy per segment: reports are *not* always
  forwarded unchanged — complete protocol replies stay dropped as before, and colour replies are
  forwarded whole by the guard itself.
- `key` → the existing keyboard chain (`handleKeyInput`), semantics unchanged: typing still clears
  the selection and jumps to the bottom.
- `if (this.closed) return;` after each segment: `detach()` sets `closed` (`:461`, `close():1609`),
  so a detach chord mid-read cannot make the loop act on a closed component. This is **new reachable
  behaviour**: today `"\x1b[1;5D\x1b[I"` (detach chord + report in one read) matches no key as a
  whole chunk and is merely forwarded; after the fix the first segment is an exact `Key.ctrl("left")`
  hit → `detach()`. A9 pins it.

The fullscreen path (`handleMouse`) and everything below `handleKeyInput` are untouched.

### 3.3 Alternatives considered

| Alternative | Verdict |
|---|---|
| Split only a **leading** mouse prefix (the issue's `splitMouseInputPrefix` sketch), forward the remainder through the keyboard path | Rejected: reproduced counter-example — a report *first* (`"\x1b[I\x1b[<0;16;2m"`) still loses the release (probe 1, case D). The split must be order-agnostic. |
| Teach `parseMouseInputChunk` to skip non-mouse bytes | Rejected: breaks its pinned all-or-nothing contract (`test/pty-scroll.test.mjs:83-99`) and #188's acceptance, and leaves the keyboard path unable to tell a report from typing. |
| Route reports into a new dedicated branch of the keyboard chain (check before `matchesKey`) instead of segmenting them | Rejected: reports and keys can share one read; a branch that runs once for the whole chunk cannot keep "report does not clear, key immediately after does" correct. |
| Keep reports on the keyboard path but wrap `clearSelection`/`scrollToBottom` in a flag | Rejected: adds state to the component for a pure input-classification fact, and does not fix the dropped mouse events. |
| Decode the report bytes ourselves / forward only known-good replies | Rejected: out of scope — the child owns reply semantics; forwarding is today's contract. |

## 4. Data flow

```
outer terminal ── stdin ──▶ pi host TUI ──(focused component)──▶ PtyAttachComponent.handleInput(data)
                                                                    │
                                                    splitAttachInput(data)   ← new (pure, pty-scroll.mjs)
                                                                    │
        ┌───────────────────────────┬──────────────────────────────┴───────────────┐
        ▼                           ▼                                             ▼
   mouse segment                report segment                              key segment
   handleMouseInputChunk        send({type:"input"}) (pass-through)         handleKeyInput (unchanged chain)
   wheel / handleLocalMouseEvent  no selection or viewport change            clear selection + scroll to bottom
        │                                                                          │
        └───────────────▶ this.send({type:"input"}) ──▶ runner socket ──▶ child PTY
```

## 5. Behaviour matrix (before → after)

| Read | before | after |
|---|---|---|
| pure mouse reports | mouse path | unchanged |
| mouse + any non-mouse bytes (either order) | keyboard default: gesture dropped, selection cleared, viewport reset, whole read forwarded to the child | mouse run processed; non-mouse run dispatched by kind |
| report-only read with a selection in progress / scrolled back | selection cleared, viewport snapped to bottom | forwarded; local state untouched |
| report followed/preceded by a real key | whole read treated as typing | report forwarded, key handled as typing |
| complete DA1/DA2/kitty/cell-size reply (issue #194 guard) | dropped by the guard | **unchanged**: the guard still owns complete protocol replies, now fed one segment at a time |
| colour reply (OSC 4/10/11/12, 997 report) | forwarded whole by the guard | **unchanged** (the guard forwards it before the kind dispatch) |
| reply head coalesced with keys (guard window) | guard could absorb the keys into its window | keys are a separate segment, so a head can never absorb them |
| wheel coalesced with a report | wheel not applied, bytes leaked to the child | wheel scrolls locally; only the report is forwarded |
| two keys in one read (`"\x1b[5~\x1b[6~"`) | neither recognised → both forwarded to the child | **unchanged**: adjacent key runs merge into one segment, so `matchesKey` still sees the concatenation (a key is only recognised when it is the whole read) |
| key-only read | typing semantics | unchanged |
| truncated/partial escape sequence | forwarded as input | unchanged (becomes `key`) |
| fullscreen host mode | `handleMouse` owns mouse; focus reports consumed by `TuiAltScreen` | unchanged |

## 6. Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 分段决策 `splitAttachInput` 决策表（§3.1 表全部行，含两种顺序、合并同类（含 report\|key 邻接两行）、键段合并、截断序列、`""`） | 自动化验证（unit） | `node --test test/pty-scroll.test.mjs`（新增用例组） | 每行 `kind` 序列与 `data`/`events` 内容逐字匹配；`parseMouseInputChunk` 既有 3 条断言（`:83-99`）不变仍绿 |
| A2 | 报告序列判定表（§3.1 七类正例 + 刻意排除的反例） | 自动化验证（unit，同一文件；只经 `splitAttachInput` 断言，不新增 test-only 导出） | `node --test test/pty-scroll.test.mjs` | ① 七类正例（含 BEL 与 ST 两种 OSC 终止符、`\x1b[?1;2c`、`\x1b[>0;95;0c`、`\x1b[?1u`、`\x1b[?997;1n`、`\x1b[6;24;80t`）每条 → 恰好一个 `{kind:"report"}` 且 `data` 逐字相等；② 反例 `\x1b[1;2R`（shift-F3）、`\x1b[97;5u`（kitty ctrl+a）、`\x1bP1+r…\x1b\\`（DCS）→ `{kind:"key"}`；③ 正例中的 `\x1b[>0;95;0c` 属 §3.1(b) 表第 3 行的防御性保留项，断言它仍为 report |
| A3 | 本 issue 的确切复现：release 与 report 同 chunk（两种顺序，含 OSC 11 reply 变体） | 自动化验证（integration，组件级：真 runner socket + fake PTY + fake TUI 捕获 `terminal.write`） | 新增 `test-support/pty-attach-mixed-input-scenario.ts` + `test/pty-attach-mixed-input.test.mjs`（`node --experimental-transform-types`，模式同 `test/pty-attach-mouse.test.mjs`） | ① 恰好一次 OSC 52 `\x1b]52;c;<base64("fake pi ready")>\x07`；② socket 收到的 input 帧里**不含任何** `\x1b[<` 鼠标字节，report 字节本身仍在；③ 组件 selection 仍非 null（场景 harness 已是白盒 `(component as any)`，另记渲染行仍带 inverse 选中 SGR 作辅助信号） |
| A4 | 纯 report 读取不碰选择：`"\x1b[I"`、`"\x1b]11;rgb:…\x07"` 在拖选中途到达 | 自动化验证（integration，同场景） | 同场景 case 组 | ① selection 保持非 null；② 无 OSC 52 写出；③ report 仍以 `{type:"input"}` 转发给子进程 |
| A5 | 视口语义（需可滚动缓冲：fixture 的 `burst` 输入 → 200 行）：① 读回滚时 report 不跳底；② wheel+report 同 chunk 时 wheel 本地生效 | 自动化验证（integration，同场景） | 同场景 case 组；断言只用公开可见量：`render()` 首行可见的 `burstline-####` 编号（回滚后应为较旧的编号） | ① report 到过后首行编号不变（不是 `burstline-0200`）；② wheel+report 后首行编号比之前更旧（回滚 1 行），且转发的 input 帧只有 report |
| A6 | 键盘语义不回归 + 分类边界：真键 `"x"` 仍清选择并跳底；`"\x1b[1;2R"`（shift-F3）、`"\x1b[97;5u"`（kitty ctrl+a）仍按键入处理 | 自动化验证（integration，同场景） | 同场景 case 组 | ① 真键后 selection 为 null 且该键被转发；② 两个歧义序列都走键入路径（清选择） |
| A7 | 类型 / 构建 / 打包 | 自动化验证（static + build） | `npm run typecheck`；`npm run verify` | exit 0（含 perf gate、coverage 阈值 lines 85 / funcs 80 / branches 70、`pack:dry`） |
| A8 | 既有行为不回归（#167 鼠标分发、#171 中键粘贴、#174 选中镜像、滚轮、attach e2e） | 自动化验证（integration，既有套件） | `npm run test:coverage`（`test/pty-scroll.test.mjs`、`test/pty-attach-mouse.test.mjs`、`test/pty-attach-wheel.test.mjs`、`test/pty-attach-selection-mirror.test.mjs`、`test/pty-attach-*.test.mjs`） | 既有测试全绿，覆盖率不低于阈值 |
| A9 | mid-read detach 守卫（§3.2 的 `if (this.closed) return;`，本轮新识别的可达行为） | 自动化验证（integration，同 A3 场景） | 同场景 case：一次读入三段 `"\x1b[1;5D" + "\x1b[I" + "x"`（ctrl+← / focus report / 尾随 key；report 分隔必不可少——相邻键段会合并（A1），无分隔时 chord 与 key 并成一段键文本、chord 永不匹配） | ① `closed === true`；② 该读取的后续段未被处理（用尾随 key 段作探针，断言 selection 仍存在；无守卫时尾随 key 会 `clearSelection()` 而尾随 report 的 `send()` 只是静默 no-op、无法区分）；③ 无 throw、无渲染报错 |
| U1 | 真机：常规模式下注入本 issue 的确切字节流（两种顺序） | 用户实测（可执行：本机有 tmux + xclip + `DISPLAY=:0`；缺 tmux 时标 `pending`） | **部署前置（必须先做）**：把被测 checkout 装进 pi——合并后首选 `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board stash`（该 checkout 有本地 `package-lock.json` 改动）→ `git pull` → 重启 `pi --tui-mode regular`；合并前试点则按 README:62-75 开发自发现路径 `ln -s <worktree> ~/.pi/agent/extensions/agent-board`，并临时从 `~/.pi/agent/settings.json` 的 `packages` 移除 `git:github.com/zhuxixi/pi-agent-board`（避免同一扩展双加载），测后恢复。**然后**：① tmux 内跑 `pi --tui-mode regular` → `/agent-board` → attach 到任一 session；② 在**一次** `tmux send-keys -H` 里传入全部字节以合成一次读取：`1b 5b 3c 30 3b 31 3b 32 4d`（press）、`1b 5b 3c 33 32 3b 38 3b 32 4d`（move）、`1b 5b 3c 30 3b 31 36 3b 32 6d 1b 5b 49`（release+focus-in）；③ 观察高亮与剪贴板/PRIMARY（复用 `xclip -o -selection primary` 检查） | 高亮保留到下一次点击（#172 契约），选中文本进入剪贴板/PRIMARY，子 session 不出现鼠标字节回显；若 tmux 把字节拆成多帧（合成失败），如实记录分帧观察结果并把该行标 `pending`，A3 仍是主证据（步骤 ①②③ 中仅 ② 依赖 tmux） |
| U2 | 真机（可选）：日常使用中混合读取不再清掉选中 | 用户实测（可选，非阻塞） | 常规模式 attach 内拖选，同时触发焦点切换/主题探测 | 选中与阅读位置不再被无意图的 report 打断；失败如实记录 |

Notes:

- A1–A2 are the lowest level that can prove the classification rules (pure, no TUI/socket). A3–A6
  and A9 are the lowest level that can prove the *effects*, because the dispatch lives behind a private
  handler with TUI + socket + xterm dependencies (§7). A8/A7 are the repo's definition of done.
- A3 is the issue's own reproduction; A4/A5 cover the second half of the issue's suggested fix
  (reports must not cancel an in-progress selection), A6 pins the fail-safe boundary (ambiguous
  sequences stay keys).

## 7. Testability split design (hard constraint for implementation)

- **Pure core** (`src/core/pty-scroll.mjs`): `splitAttachInput` is the single new export; the run
  readers and the report table stay module-private. No env reads, no I/O, no component import, no
  use of `Date.now()`. A1/A2 call it directly; the only other export touched is
  `parseMouseInputChunk`, whose behaviour must be literally unchanged (re-expressed on
  `parseMouseRun`, contract re-pinned by the existing assertions).
- **I/O shell** (`PtyAttachComponent`): owns the socket, the xterm model, selection state, the
  pending-click timer and the viewport. The dispatch loop is the only new logic; `handleKeyInput` is
  the old body moved verbatim (a pure refactor — no branch, guard or ordering may change inside it).
  The report branch adds exactly one `send()` and no state.
- **Test seam** (A3–A6): the public `handleInput` legacy seam + a fake `tui.terminal.write` capture +
  a real runner socket with the fake PTY — the seams `test/pty-attach-mouse.test.mjs` and
  `test/pty-attach-selection-mirror.test.mjs` already use. No test-only export, no injection hook,
  no new env knob. The scenario is white-box by construction (it already casts the component to
  `any` to reach `handleMouse`), so reading the private `selection` field to prove "the highlight
  survived" is allowed there; the behavioural proofs (OSC 52 payload, socket frames) and the
  viewport proof (rendered content) stay black-box and are the primary assertions.
- **Fixtures**: `test-support/fake-pty-pi.mjs` default mode prints exactly one stable line
  (`fake pi ready`) → the expected OSC 52 payload is deterministic; the `burst` input channel emits
  200 numbered lines → the scrollable-viewport cases (A5) need no new fixture. A PATH-stubbed `xclip`
  keeps the scenario off the host clipboard.
- **Boundary to preserve**: "what is a report" lives in exactly one place (the report table in
  `pty-scroll.mjs`). The component must not re-inline report or mouse detection; it only switches on
  the segment kind.

## 8. Boundaries, interactions, risks

**Sibling issues (must not be pre-empted).** #187 edits the release branch of
`handleLocalMouseEvent` and moves `sameMousePoint` into `pty-scroll.mjs`; #188 edits the X10 branch of
`parseMouseEventPrefix` and extends the `parseMouseInputChunk` unit block. #189 touches neither
function body: it adds new private helpers plus one export, and its component edits sit in
`handleInput` (top of the class) — disjoint from #187's release branch. Whichever merges second
rebases and re-runs `npm run verify`; with #187/#188 unfixed this issue's cases still pass because it
does not rely on their fixes (X10-only terminals still lose the copy — documented as their scope).

**Documented guarantee boundaries.**

- Report-shaped bytes inside a bracketed paste are split out as a report run: the byte stream and its
  order are preserved (the child sees the same bytes), and the only local difference is that the
  pasted report-shaped text does not clear the selection. **Mouse-report-shaped bytes are different**
  and are stated here honestly: a pasted `\x1b[<…M` run is consumed by the local mouse path and is
  **not** forwarded to the child (today the whole pasted chunk was forwarded). Pasting a captured
  terminal log that contains mouse reports can therefore create a local selection/click instead of
  reaching the child — a documented consequence of segmenting, not a paste-content loss (nothing is
  dropped from the byte stream for report runs; mouse runs are consumed by design, exactly as they
  are when typed by the terminal).
- A report or mouse sequence **split across two reads** is not recognised and is forwarded as typing
  — exactly today's behaviour for partial sequences; the outer terminal writes complete sequences.
- Unknown/unlisted reply forms (CPR `CSI … R`, DECRPM `CSI … $ y`, DCS replies) keep key semantics:
  they still clear the selection as today. Adding a form later is one line in the report table.
- Reports the reply guard (#170/#194) does not own are forwarded to the child, including while the
  child has not reached raw/bracketed-paste readiness — that is today's behaviour and belongs to
  #165/#180, not here. Complete protocol replies stay dropped by the guard, and colour replies are
  forwarded whole by the guard; #189 does not change that policy, it only feeds it segments.
- No clipboard claim: the copy path (OSC 52 + PRIMARY mirror) is unchanged.
- No claim about fullscreen mode: `handleMouse`/pi-tui still own that path.

**Risks.**

| Risk | Assessment / mitigation |
|---|---|
| The classifier misses a real report → selection still cleared | Fail-safe direction: the child still receives the bytes; the local state difference is a highlight/viewport artefact. A2 pins the excluded forms explicitly, and the table is documented as the extension point. |
| The classifier swallows a key → selection no longer clears on typing | Patterns are grounded in queries this stack issues; A2/A6 pin `\x1b[1;2R`, `\x1b[97;5u`, `\x1bP…` as keys. |
| `handleKeyInput` extraction changes keyboard behaviour | Pure move; A8 + `npm run verify` (the prototype already ran 1161 tests green on the patched tree — `research/03-fix-hypothesis-validated.md`). |
| Extra per-read work (segment scanner) on large pastes | Only ESC positions are probed: one `parseMouseEventPrefix` (single regex) plus the report table (≤7 regexes, all anchored) per ESC, and one linear `indexOf` per key run. |
| Shared file conflicts with #187/#188 | Disjoint functions; whichever lands second rebases and re-runs `npm run verify`. |
| A5's viewport assertion touches component internals | Observed through the public `render()` output (the `burstline-####`编号 of the first visible body line); no private API is added or changed, and the private `selection` read (A3) is a white-box convenience with the OSC 52 payload as the primary evidence. |

## 9. Deliverables

- `src/core/pty-scroll.mjs`: `parseMouseRun` (private) + `parseMouseInputChunk` re-expressed on it;
  report table + `parseReportPrefix` / `parseReportRun` / `pushSegment` (private); `splitAttachInput`
  (new export + JSDoc typedef).
- `src/ui/pty-attach.ts`: import `splitAttachInput` (dropping `parseMouseInputChunk`); `handleInput`
  becomes the dispatch loop; keyboard chain moved into private `handleKeyInput`.
- `test/pty-scroll.test.mjs`: segmentation + report-classification cases (A1, A2).
- `test-support/pty-attach-mixed-input-scenario.ts` + `test/pty-attach-mixed-input.test.mjs`:
  component-level cases (A3–A6, A9), including the `burst`-based viewport cases.
- `docs/superpowers/specs/2026-10-14-issue-189-mixed-input-segments-design.md`: this spec, first
  commit in the worktree (step 5).
- CHANGELOG entry via the release tooling at release time (not in this PR).

## 10. Open question for the design gate

The report pass-through is the second half of the issue's own suggested fix and is reproduced as a
real symptom (selection cleared + reading position lost). If the operator prefers a smaller blast
radius, the dispatch loop alone still fixes the *copy* (the mouse run is processed), and the report
rows can be trimmed to fewer forms (A2/A4/A5 shrink accordingly) — but then the remaining forms
still wipe the just-created highlight and snap the viewport, which is exactly the second symptom of
this issue.
