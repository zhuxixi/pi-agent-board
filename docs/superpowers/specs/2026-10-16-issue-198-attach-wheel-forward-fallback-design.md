# Issue #198 — attach wheel forward-fallback (production topology)

- Issue: https://github.com/zhuxixi/pi-agent-board/issues/198
- Kind: bug — root-cause report + fix design (follow-up to #183 / #185)
- Baseline: `main` @ `eab48d0` · worktree `issue-198-attach-wheel-forward-fallback`
- Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-16T00:1xZ

## 1. Problem

#185 shipped and the fullscreen wheel was still dead in the reporter's real session, while `PageUp`/`PageDown` and middle-click paste both worked. That combination rules out the input channel (mouse events reach `handleMouse`, keys reach the child) and points at the wheel's own routing decision.

## 2. Root cause

`#185` routes on `this.term.buffer.active.type`, and that signal is structurally unavailable in production:

1. **The screen-log replay is a 100 KB tail** (`SCREEN_LOG_REPLAY_BYTES = 100_000`, `src/core/screen-log.mjs:15`). A real fullscreen child sends `\x1b[?1049h` once at startup, long before the window.
2. **The snapshot path carries no alternate-screen state.** `src/core/terminal-model.mjs`, `src/core/terminal-snapshot.mjs` and `src/core/terminal-attach-protocol.mjs` have no `alternate` / `1049` / `altScreen` handling; the synthesized frame carries rendered content only.
3. **Measured:** the reporter's live `screen.log` (420 KB) contains **zero** `\x1b[?1049h`; the new fallback scenario pins the consequence — with the enable outside the window the attach reads `buffer.active.type === "normal"` with `bottomViewportTop(bodyHeight) === 0`.

So the wheel routes `"local"`, finds no attach-local scrollback (a fullscreen TUI paints with absolute positioning, so the normal buffer never scrolls and `baseY` stays 0), and #183's contract returns `undefined`: pi then scrolls the transcript hidden behind the overlay. The `"alternate"` → `"child"` route is effectively **unreachable in production** today; #185's local test only saw it because its fixture re-asserted the enable on every tick, which put the sequence back into the live stream. Removing that hack is part of this fix.

## 3. Fix design

Route order inside `handleMouse` (`src/ui/pty-attach.ts`), unchanged helpers (`wheelScrollLinesUp`, `resolveAttachWheelRoute`, `encodeWheelReport`):

| Condition | Behaviour |
| --- | --- |
| `wheelLinesUp === 0`, or the kill switches are off (`route === "none"`) | unchanged: `undefined` |
| `route === "local"` and `tryScrollBy(linesUp)` moved | unchanged #183: `{handled:true, render:false}` |
| `route === "child"`, or `route === "local"` with a viewport that cannot move | **new**: forward one synthesized SGR report — the same fallback the raw-SGR path and `PageUp`/`PageDown` already use |
| any forward, attach disconnected | unchanged #185 CR rule: `undefined` (a forward `send()` would drop is not an effect) |

The `"child"` fast path is kept: when the type *is* known, skipping the inert local viewport avoids a two-line jitter before the child takes over. Correctness no longer depends on it.

README (`PTY attach` paragraph) states the parity rule: local scrollback while it can move, otherwise forwarded to the session.

## 4. Testability split

No new pure helper: the decision is a reordering of existing branches. Coverage instead pins the two topologies:

| Scenario | Topology | Asserts |
| --- | --- | --- |
| `test-support/pty-attach-wheel-fallback-scenario.ts` (**new**) | child enters the alternate screen once, floods >130 KB with absolute-positioned frames, then the attach connects — i.e. the enable is outside the replay window | `buffer.type === "normal"`, local room `0`, wheel up/down forwarded as `\x1b[<64;4;3M` / `\x1b[<65;4;3M`, `{handled:true, render:false}`, viewport stays `null`, kill switch falls through |
| `test-support/pty-attach-alt-wheel-scenario.ts` (updated) | same child, young log, **legacy replay path forced** (`AGENT_BOARD_TERMINAL_SNAPSHOT=0`) so the enable is replayed | the `"child"` route still skips the local viewport; documents *why* it needs the legacy path |
| `test-support/pty-attach-wheel-scenario.ts` (#183, updated comment) | socketless/ disconnected | the disconnected half of the rule: falls through instead of dropping a forward |

## 5. Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | 生产拓扑下滚轮转发 | 自动化（integration） | `node --test test/pty-attach-wheel-fallback.test.mjs` | 拓扑断言（normal + room 0）成立；up/down 各转发一条精确 SGR 报文；`{handled:true,render:false}`；视口保持 null |
| A2 | `"child"` 分支仍覆盖 | 自动化（integration） | `node --test test/pty-attach-alt-wheel.test.mjs` | legacy 重放路径下 `bufferType === "alternate"`，视口不动，报文转发 |
| A3 | 断连不消费 | 自动化（integration） | `node --test test/pty-attach-wheel.test.mjs` | socketless 场景仍返回 `undefined` |
| A4 | 既有行为不回归 | 自动化（integration） | `npm test`（mouse / mouse-mode / selection-mirror / wheel 套件） | 全绿 |
| A5 | 门禁 | 自动化（static + suite） | `npm run verify` | typecheck / perf / tests / coverage / pack:dry 全过 |
| A6 | 文档同步 | 自动化（static） | `rg -n "mouse wheel" README.md` | 描述为「本地能滚就滚本地，滚不动就转发」 |
| U1 | 真实会话里滚轮可用 | 用户实测 | 合并 → `git pull` → 重启 pi → attach 长会话滚轮上下 | 与 `PageUp`/`PageDown` 等效；中键与拖选不变 |

## 6. Non-goals / boundaries

- Not fixing the signal itself (teaching the runner's terminal model + snapshot DTO the alternate-screen flag) — a protocol change that is no longer needed for correctness; recorded as a possible follow-up.
- The `"alternate"` route stays as a fast path; in today's production it is usually not taken, which is documented here and in the scenario header.
- No change to `AGENT_BOARD_WHEEL_LINES` semantics, the kill switches, or the middle-click/selection paths.

## 7. Next step

Step 5 of `github-issue-driven`: land this spec in the worktree, plan, implement (done, TDD red → green), local CR, PR with Zima single-bot CR.
