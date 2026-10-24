# Issue #232 — attach drops trailing background-only cells (design)

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T22:58:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T23:20:00+08:00 — R1-G1, R1-D1, R1-D2, R1-D3
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T23:35:00+08:00 — R2-G1, R2-D1, R2-D2
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T23:45:00+08:00 — R3-D1, R3-D2, R3-D3

Repo: `zhuxixi/pi-agent-board` · base `main` @ `759d659` · issue #232 (bug)

## 1. Problem

In attach mode a full-screen TUI whose theme background differs from the host
terminal's default renders with the host background showing through every
character-less region (nvim's empty buffer, tab-bar gaps). Colours survive into
the xterm buffer; they are destroyed when the buffer is serialized back to ANSI.

## 2. Root cause (verified against `759d659`)

`lineToAnsi()` (`src/ui/pty-attach.ts:1962`) computes `last` = last cell whose
`getChars()` is non-empty, returns `""` when `last < 0`, and renders
`x <= last`. Background-only cells therefore never reach the output:

- blank line + painted bg → `""` (whole line's bg dropped);
- content line → everything right of the last character dropped.

## 3. Design

Three surgical changes inside `lineToAnsi()`, no signature/module changes.

**C1 — track the painted extent.** During the existing per-line scan, also
record `lastBg` = last cell with `!cell.isBgDefault()`. Compute
`renderEnd = Math.max(last, lastBg)`. The scan keeps skipping
`getWidth() === 0` continuation cells and never reads `extended`, so the
reusable-cell contract from issue #158 stays satisfied.

**C2 — render through `renderEnd`.** Replace both bounds derived from `last`:
the main render loop (`x <= renderEnd`) and the empty-line guard
(`if (renderEnd < 0)`). Blank default-bg lines still return `""`, so ordinary
shell output stays byte-identical. Blank painted lines now enter the normal
loop, which emits their cells' SGR bg plus `" "` padding; content lines pad
through their last painted column.

**C3 — cursor bound.** The post-loop "cursor past content" check compares
`cursor.col > renderEnd` instead of `> last`, so a cursor inside the newly
painted region is drawn exactly once by the in-loop `isCursor` path.

### Why this is sufficient

pi-tui renders a component line as-is; the SGR run in the line paints the row's
bg. Padding exists only to give the SGR run cells to apply to. For an nvim
screen the bg covers the full width, so each line serializes to full width.

## 4. Decisions

| Decision | Rationale |
| --- | --- |
| Follow the reporter's patch shape (3 changes) | Matches the verified root cause; smallest diff; reported as visually fixed. |
| Selection over padded cells becomes inverse-video | Correction to the issue comment: `pointWithinSelection` is evaluated per column, not per char. Drawing a selection over blank area matches real terminal behaviour; copied text is built from the selection model, not from padding, so copy output is unchanged. |
| `isBgDefault()` only — `isInverse()` deliberately excluded | Keeps the fix inside the reported class (explicit bg). Reversed-video-only blank regions are a separate, unmeasured case; see follow-up. |
| No pure-helper extraction | The defect is the emission bound, not the arithmetic; extracted-helper unit tests would not observe it. See §6. |
| Byte cost accepted | Painted screens now emit full-width lines, but the attach renderer is differential and only rewrites changed lines. |

## 5. Non-goals

- No separate legacy/replay acceptance item: legacy attach is the **same**
  `PtyAttachComponent` and the same renderer (`replayScreenLog()` feeds the same
  `this.term`, `project()` always calls `lineToAnsi`), so C1–C3 apply to it
  automatically — that is an expected benefit, not a boundary. The byte-cost
  trade-off applies there too; A1–A5 exercise the same serialization path.
- Inverse-video-only blank regions (`SGR 7` with default bg) — same bug class,
  different trigger; file a follow-up if a real app hits it.
- Capping padding at a viewport edge instead of the last painted column.
- Dashboard peek (text view) and web dashboard (real xterm.js frontend).

## 6. Testability split (design constraint)

**Test boundary:** `PtyAttachComponent.render(width)` — the public surface
already used by `test-support/hyperlink-cell-smoke.ts`. Height comes from the
stub TUI (`tui.terminal.rows`), not from the argument. The fixture
constructs terminal state by writing ANSI into the component's real
`@xterm/headless` terminal, isolates all side effects (socket path
`/no/such/socket`, stub TUI, `dispose()` in `finally`), and returns the raw
rendered lines as JSON. Assertions live in `node:test` and never touch the
terminal directly.

**Pieces:**

| Piece | Kind | Test |
| --- | --- | --- |
| `test-support/attach-bg-paint-smoke.ts` | fixture (side effects isolated here) | driven by the .mjs test via `--experimental-transform-types` |
| `test/pty-attach-bg-paint.test.mjs` | assertions | `npm test` |

**Why no pure function is split out:** `lineToAnsi` is already pure given
`(line, reusable, term, selection, cursor)`; the only thing that can regress is
*which cells reach the output*. A helper returning `renderEnd` would be unit
tested while the actual loop bound could still be reverted to `last`, i.e. the
test would pass with the bug present. The render-boundary test fails if any of
C1/C2/C3 is reverted. If a future change makes this loop hot enough to justify
extraction, the same smoke test remains valid.

**Red-green proof (A8):** the fixture must produce cells with
`getChars() === ""` **and** a non-default bg — only erase sequences (EL `\x1b[K`
/ ED `\x1b[2J`) under an active bg create those. Writing literal spaces would
make `getChars()` non-empty and the unpatched code would pass. Before
committing, revert C2's bound to `last` temporarily and confirm A1/A2 fail, then
restore; record both runs in the PR description.

## 7. Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | 空白行的非默认背景不再被丢弃 | 自动化验证（integration，组件 render 输出） | `node --test test/pty-attach-bg-paint.test.mjs`；fixture 先发 `\x1b[48;2;30;30;46m` 再对空行发 `\x1b[K`（EL擦除，生成 `getChars()===""` 的 bg-only 单元格） | 该行渲染结果非空且含 `48;2;30;30;46` |
| A2 | 内容行尾部背景渲染到最后被涂色的列 | 同上 | 写 `AB` → `\x1b[41G`（1-based 第 41 列 = 0-based col 40）→ `\x1b[K` | `AB` 后有 38 个默认背景空格（0-based col 2–39），其后 40 个空格带 `48;2;30;30;46`（col 40–79）；尾部 `\x1b[0m` 不计 |
| A3 | 默认背景的空白行保持空串（零字节开销路径不回退） | 同上 | fixture 中纯文本屏幕的空白行 | 对应行 `=== ""` |
| A4 | 宽字符行的背景填充列数正确 | 同上 | 写 `中`（宽字符）→ 在 bg 激活下 `\x1b[K` 擦到行尾 | 渲染行显示宽度 === 40，且 `中` 之后紧跟 38 个涂色空格（续列 `getWidth()===0` 不计入输出） |
| A5 | 光标落在填充区内只绘制一次 | 同上 | 光标置于涂色空白行的中部，`cursorHidden=false`（fixture 形状照抄 `test-support/cursor-visibility-smoke.ts`） | 该行恰含一个 `CURSOR_MARKER` 与一个反显块 |
| A6 | 类型与模块契约不破 | 自动化验证（static） | `npm run typecheck`（注意：tsconfig 排除 `test`/`test-support`，fixture 类型由 A1 运行时暴露） | 退出码 0 |
| A7 | 全量门禁 | 自动化验证（build/test suite/coverage/pack） | `npm run verify` | 全部通过（覆盖率阈值 lines 85 / funcs 80 / branches 70） |
| A8 | 测试对修复有判别力（防「未修复也绿」） | 自动化验证（mutation，一次性，非 CI） | 临时把 C2 的边界改回 `x <= last` → 跑 A1/A2 → 还原 | 回退时 A1/A2 均失败，还原后均通过；两次输出记入 PR 描述 |
| A9 | 填充区参与选区时仍可反显 | 自动化验证（integration，组件 render 输出） | fixture 通过私有字段 `selection = { anchor: { line, col: 20 }, focus: { line, col: 60 } }` 选中涂色区（形状照抄 `MouseSelection`，`src/ui/pty-attach.ts:159`） | 该行在 col 20–60 的渲染片段含反显属性 `7`；复制文本（`selectionText()`）不受 padding 影响 |
| U1 | 真实 nvim/catppuccin attach 观感 | 用户实测 | 见下方「U1 执行前置」，时机：PR 分支可安装之后、合并之前 | 空区域为 `#1e1e2e`；光标行高亮横贯整行 |

**U1 执行前置**（否则 attach 的是 npm 旧包，看不到修复）：

0. 确认 payload 是 PR head：`git log -1` 与 PR 的 head commit 对齐（worktree 就是 PR 分支时天然满足）。
1. 在 worktree 内 `npm install`。
2. 让 Pi 加载该 checkout：`pi install "$(pwd)"`（README「Local checkout」）或临时软链
   `ln -s "$PWD" ~/.pi/agent/extensions/agent-board`（README「Development auto-discovery」）。
3. **重启 pi** —— 扩展只在启动时加载。
4. `/agent-board` → attach 到 nvim/catppuccin 会话，观察空缓冲区与光标行。
5. 收尾：`pi remove "$(pwd)"` 或 `rm ~/.pi/agent/extensions/agent-board`。

> 记录：报告者已在 issue 评论中对该补丁做过一次视觉验证；U1 在合并前按上述步骤
> 在 PR 构建上复确认一次即可，不必重复造场景。A5 的 `CURSOR_MARKER`
> （`\x1b_pi:c\x07`）路径已由 `test-support/cursor-visibility-smoke.ts` 证明稳定。

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Full-width serialization increases bytes for painted screens | Differential renderer; A2/A3 pin the cheap path. |
| Selection highlight now covers padding | Intentional and documented; copy path unaffected. |
| Cursor double-block regression | C3 + A5. |
| Wide-char padding misalignment | A4. |
| Test fixture drifts from the component's private API | Same pattern as existing smoke fixtures (`hyperlink-cell-smoke.ts`); only `term`, `receivedOutput`, `finishAttachTransition` are touched. `test-support/` is outside `tsconfig` (`exclude: ["node_modules", "test", "test-support"]`), so fixture type errors surface at A1's test run, not at A6 — same as every existing smoke fixture. |
| Test passes on unpatched code | A1/A2 use EL/ED-erased bg-only cells (literal spaces would keep `getChars()` non-empty); A8 records the red-green proof. |
