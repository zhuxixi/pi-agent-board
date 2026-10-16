# Issue #185 — attach wheel cannot scroll a fullscreen child session (alternate buffer)

- Issue: https://github.com/zhuxixi/pi-agent-board/issues/185
- Kind: bug — root-cause report + fix design (delta on top of the merged #183)
- Repo: `zhuxixi/pi-agent-board` · baseline: `main` @ `f81949d5` (#183) · worktree `issue-185-attach-wheel-alt-screen`
- Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T00:06:01Z
- Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T00:23:30Z — after round-1 review (mode: degraded same-model, user-confirmed; findings R1-D1..R1-D5 in `research/spec-review-round-1.md`)
- Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T00:52:00Z — after local code-review (workflow `code-review`, run `code-review-mv7dz229-mrt1ay`): the disconnected alternate-buffer wheel now falls through instead of consuming a drop-bound forward (consume-only-on-effect invariant restored); §3.1/§8 updated

## 1. Problem

`#183` fixed the fullscreen wheel by consuming it in `handleMouse` and scrolling the attach's own xterm
viewport, falling through when that viewport cannot move. For a child that holds the alternate screen —
i.e. **every session this board launches by default** — the attach-local scrollback collapses to about
two lines, so the wheel travels those two lines and then falls through to a transcript scroll hidden
behind the overlay. To the user the wheel still looks dead while `PageUp`/`PageDown` keep working.

Out of scope here: the normal-buffer case, which #183 already fixed and pins with tests.

## 2. Root cause

**2.1 Alternate buffers have no scrollback.** Measured with the extension's own `@xterm/headless` and the live 36×120 geometry (`scrollback: 2000`, `bodyHeight = rows - 2 = 34`):

| buffer | `baseY` | `length` | `min(length, baseY + rows) - bodyHeight` |
| --- | --- | --- | --- |
| normal | 65 | 101 | 67 |
| alternate (`\x1b[?1049h` + 200 lines) | 0 | 36 | **2** |

`bottomViewportTop()` (`src/ui/pty-attach.ts:1340-1344`) and the projection (`:854`, `:1121`, `:1142`, `:1237`) all read `this.term.buffer.active`, so an alternate-screen child is exactly the state where the attach's local scrolling is inert.

**2.2 The hosted child is in that state.** Board host-configs carry no `--tui-mode` and `env: {}`, so the child inherits `tuiMode: "fullscreen"`. A probe pi spawned under the same env/settings in a 36×120 PTY emitted `\x1b[?1049h`, `\x1b[?1000h`, `\x1b[?1006h`, `\x1b[?2004h` at startup.

**2.3 #183's fall-through ends in an invisible scroll.** `src/ui/pty-attach.ts:386-395`: `wheelScrollLinesUp(event)` → `if (this.mouseScrollEnabled() && this.tryScrollBy(wheelLinesUp)) return {handled:true, render:false}` → `return undefined`. Returning `undefined` hands the event to pi's `routeWheel`, which scrolls the transcript underneath the full-screen overlay — no visible effect. The behaviour is pinned as intentional (`test/pty-attach-wheel.test.mjs:29`, `test-support/pty-attach-wheel-scenario.ts:16,92`), so this issue must not regress it for the normal-buffer case.

**2.4 The keyboard path already forwards, the wheel does not.** `handleInput`'s `PageUp`/`PageDown` branches (`src/ui/pty-attach.ts:300`, `:307`) call `tryScrollBy` and, when it returns false, `this.send({ type: "input", data })` — the child scrolls its own viewport and its redraw flows back through the attach. The raw-SGR wheel path does the same (`:967`). The fullscreen wheel branch is the only scroll path without that fallback.

## 3. Fix design

### 3.1 Behaviour contract — `PtyAttachComponent.handleMouse`, wheel branch (`src/ui/pty-attach.ts:386-395`)

| Condition | Behaviour |
| --- | --- |
| `wheelLinesUp === 0` (not a wheel, or unusable delta) | unchanged: `undefined` (falls through) |
| `mouseScrollEnabled() === false` (`AGENT_BOARD_ATTACH_MOUSE=0` / `AGENT_BOARD_ENABLE_MOUSE_SCROLL=0`) | unchanged: `undefined`, no forwarding |
| active buffer is `alternate` | **new**: skip the local viewport entirely; forward one synthesized SGR wheel report to the child; `return { handled: true, render: false }` |
| active buffer is `normal`, `tryScrollBy(linesUp)` moved | unchanged #183: `{ handled: true, render: false }` |
| active buffer is `normal`, viewport cannot move | unchanged #183: `undefined` |

The alternate case deliberately skips `tryScrollBy`: letting the local viewport travel its two lines would pin the attach's projection while the child repaints its own scrolled frame, producing a two-line-jump artefact rather than a scroll.

Two edge notes on the alternate branch:

- While the attach is disconnected, the branch falls through (`undefined`) instead of forwarding — `send()` would silently drop the report (`src/ui/pty-attach.ts`), and the pre-#185 branch likewise consumed the wheel only when it had an effect. The event goes back to pi, whose own handling is equally inert behind the overlay; acceptable, since the attach shows a reconnect surface.
- `README.md:201`'s sentence ("While attached, `PageUp`, `PageDown`, `Home`, `End`, and the mouse wheel scroll local scrollback") must be updated in the same PR: in the alternate case the wheel scrolls the child's own viewport, same as `PageUp`/`PageDown`.

### 3.2 Wire format and coordinates

- Report shape: `\x1b[<64;{col};{row}M` (up) / `\x1b[<65;{col};{row}M` (down) — the plain SGR wheel report a terminal sends; the child's own TuiAltScreen (or any mouse-aware alt-screen program) parses it exactly as it parses the real terminal's.
- One report per received event, not one per line, so the child applies its own acceleration (`WheelScrollAccelerator`); `#183`'s `wheelScrollLinesUp()` decides direction and validity, and `AGENT_BOARD_WHEEL_LINES` stays a regular-mode-only knob as #183 documented.
- Coordinates are the **child screen** frame, not the attach buffer's absolute row: `handleMouse` events are zero-based local (pi-tui `TuiMouseEvent`), the attach body starts at local row 1 (header row 0, footer last row), and the child's screen is the body 1:1. So `col = clampInt(event.x + 1, 1, this.cols)` and `row = clampInt(event.y, 1, Math.max(1, this.bodyHeight()))` (SGR is one-based). This mirrors what the raw path assumes when it maps a 1-based SGR column to `col - 1` (`:1090`).

### 3.3 Testability split (implementation constraint)

| Unit | Kind | Contract |
| --- | --- | --- |
| `resolveAttachWheelRoute({ bufferType, wheelLinesUp, mouseEnabled })` (**new**, `src/core/pty-scroll.mjs`) | pure | `"none"` when the switch is off or `wheelLinesUp === 0`; `"child"` when `bufferType === "alternate"`; else `"local"`. The `"local"`→`"none"` downgrade when `tryScrollBy` cannot move stays in the shell (it needs the live viewport). |
| `encodeWheelReport(direction, { col, row })` (**new**, same module) | pure | `"up" \| "down"` → the SGR string above, coordinates clamped to ≥ 1. |
| `handleMouse` wheel branch | shell | `resolveAttachWheelRoute` → `"child"`: `send({type:"input", data: encodeWheelReport(...)})`; `"local"`: `tryScrollBy(...) ? handled : undefined`; `"none"`: `undefined`. |

Both helpers are pure and belong next to `wheelScrollLinesUp()` (`src/core/pty-scroll.mjs:175`), which stays as the delta gate.

Seams for the component-level tests: `test-support/pty-attach-mouse-scenario.ts` already provides a real runner plus a `Socket.prototype.write` interception that observes component→runner `{type:"input"}` messages, plus `as any` private access — the same harness that asserts the middle-click paste payload reaches the runner. The alternate-screen branch needs one new additive fixture mode in `test-support/fake-pty-pi.mjs` (`FAKE_PTY_STREAM_MODE=alt`, writing `\x1b[?1049h` before its lines — same additive shape as the existing `steady`/`firehose`/`malformed` modes) — a test-support change, no runtime impact. The new scenario's fake TUI declares `mode: "fullscreen"` (same as `test-support/pty-attach-wheel-scenario.ts`), so the component is exercised in production's dispatch shape.

## 4. Rejected alternatives

| Alternative | Evidence against |
| --- | --- |
| Keep the local scroll first and forward only after the two lines | The attach projection would pin at `viewportTop = 0` while the child scrolls its own frame — a two-line artefact plus divergent frames; also invisible in practice. |
| Forward at the normal-buffer boundary too (full parity with the raw path) | Changes a contract #183 pinned (`test/pty-attach-wheel.test.mjs:29`) for a case where local scrolling does work; keep it as a separate decision, not part of this fix. |
| Mirror the child's transcript into attach-local history for alternate-screen children | Large redesign of the projection model; unnecessary once forwarding matches the keyboard path. |
| Ask the user to run sessions with `--tui-mode regular` | Workaround; leaves the default topology broken. |
| Re-assert the outer mouse mode / bypass `handleMouse` | #169/#173 already settled that `TuiAltScreen` owns the mode in fullscreen. |

## 5. Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | 路由决策与报文编码（纯函数） | 自动化验证（unit） | `node --test test/pty-scroll.test.mjs` | `resolveAttachWheelRoute`：`mouseEnabled:false` → `"none"`；`wheelLinesUp:0` → `"none"`；`alternate` → `"child"`；`normal` → `"local"`。`encodeWheelReport`：up → `"\x1b[<64;5;3M"`、down → `"\x1b[<65;5;3M"`，`col/row < 1` 夹到 1 |
| A2 | alternate 子进程：转发报文而非本地滚动 | 自动化验证（integration） | 新场景 `test-support/pty-attach-alt-wheel-scenario.ts` + `test/pty-attach-alt-wheel.test.mjs`（真实 runner + `Socket.prototype.write` 拦截 + 新 `FAKE_PTY_STREAM_MODE=alt`） | 子进程收到 `{"type":"input","data":"\x1b[<64;…M"}`（下滑为 65，坐标为 1-based 且落在 `[1, cols] × [1, bodyHeight]`）；`handleMouse` 返回 `{handled:true, render:false}`；`viewportTop` 保持 `null` |
| A3 | normal 子进程：不回归 #183 | 自动化验证（integration） | `npm test`（`test/pty-attach-wheel.test.mjs` 原样） | 既有多条断言全绿，含 `atBottomFallsThrough === true` |
| A4 | 关闭开关与不可用 delta 不转发 | 自动化验证（integration） | A2 场景内设 `AGENT_BOARD_ATTACH_MOUSE=0` / `AGENT_BOARD_ENABLE_MOUSE_SCROLL=0` / 无 delta 的 wheel | 三者都返回 `undefined` 且 socket 上无新的 `{type:"input"}` |
| A5 | 既有鼠标行为不回归 | 自动化验证（integration） | `npm test`（`pty-attach-mouse`、`pty-attach-mouse-mode`、`pty-attach-selection-mirror`） | 全绿：中键粘贴、fullscreen 零 mouse-mode 写入、selection mirror |
| A6 | 类型、构建与全量门禁 | 自动化验证（static + suite） | `npm run verify` | typecheck / perf gate / `npm test` / coverage 阈值（lines 85 / funcs 80 / branches 70）/ `pack:dry` 全过 |
| A7 | 文档同步（README 的滚轮声明） | 自动化验证（static） | `rg -n "mouse wheel" README.md` | `README.md:201` 的句子不再只承诺 "scroll local scrollback"——必须说明滚轮与 PageUp/PageDown 一致：本地有 scrollback 滚本地，否则转发给子进程滚它自己的视口 |
| U1 | 真实 fullscreen attach 里滚轮与键盘一致 | 用户实测 | 合并并入 git checkout 后重启 pi：attach 一个长输出会话，先 `PageUp`/`PageDown` 再滚轮上下 | 滚轮能连续回看历史并回到跟随底部，与 `PageUp`/`PageDown` 一致；无两行跳变或闪烁；时机：PR 合并 → `git pull` → 重启 pi 后任意时刻 |
| U2 | 中键粘贴与拖拽选择无回归 | 用户实测 | 同一会话中键粘贴 + 左键拖选 | 与改动前一致（X11 PRIMARY 粘贴内容正确、选中高亮） |
| U3 | regular 模式冒烟（本次改动未触碰的路径） | 用户实测 | 全局 `tuiMode: regular` 重启外层 pi 后 attach 一个长会话并滚轮 | 滚轮走原始路径（本地 scrollback + 边界转发）不变；时机同 U1 |

## 6. Verification path (deployment truth)

- The outer pi loads the extension from `~/.pi/agent/settings.json` → `git:github.com/zhuxixi/pi-agent-board` → `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board`. U-items need that checkout at the merge commit **and** a pi restart (the module is loaded at startup); no build step (`main: ./index.ts`).
- Implementation baseline: the dev checkout `/home/elling/git-repo/github/pi-agent-board` is at `acc40fd`, i.e. **behind #183**; the worktree must be created from a refreshed `main` (fetch first) so the change builds on `f81949d5` rather than reintroducing the previous wheel branch.
- A2's `FAKE_PTY_STREAM_MODE=alt` is new fixture surface (`test-support/fake-pty-pi.mjs`, alongside `steady`/`firehose`/`malformed`); keep it additive so existing fixture consumers are unaffected.

## 7. Non-goals

- Changing the normal-buffer boundary behaviour #183 pinned (fall-through) or `AGENT_BOARD_WHEEL_LINES` semantics.
- Mirroring child history into attach-local scrollback; horizontal wheel; touch/kinetic input.
- Any pi-tui change (the child parses standard SGR reports; nothing new is required upstream).

## 8. Guarantee boundaries

- The forwarded report is synthesized, not a byte replay: coordinates are best-effort (the child uses them for scroll-view hit testing and falls back to its primary scroll view) and modifier bits are not carried; the child applies its own acceleration.
- In the alternate case there is deliberately no local fallback: if the child ignores mouse reports, the wheel does nothing in that session (the same class of limitation `PageUp` has today if the child ignores paging keys).
- The attach cannot observe whether the child actually scrolled; parity with `PageUp` is the contract, not a guarantee about the child's own limits.
- In the disconnected state the alternate branch falls through rather than consuming the wheel (see §3.1): a forward that `send()` would silently drop is not an effect, so the event is handed back — restoring the pre-#185 consume-only-on-effect invariant.

## 9. Risks

- Sending an escape sequence into a child that does not parse mouse reports (non-pi alt-screen programs with mouse mode off) — accepted, scoped to the alternate buffer, and identical in kind to what the raw path already forwards for wheel/keys in regular mode.
- A quickly spinning wheel now produces one forwarded report per event, which the child's accelerator may amplify up to ~6 lines (×5 with Alt) per event — same as a real terminal, and #183's README note already explains the fullscreen line count is the TUI's decision.
- Momentum bursts arriving while the child repaints can interleave; the attach's projection re-renders from the buffer, so no state is lost.

## 10. Next step after approval

Step 5 of `github-issue-driven`: create worktree `issue-185-attach-wheel-alt-screen` from refreshed `main`, land this spec as the first commit at `docs/superpowers/specs/2026-10-14-issue-185-attach-wheel-alt-screen-design.md`, then plan (`writing-plans`) → implement (`subagent-driven-development`) → local CR → PR with Zima single-bot CR.
