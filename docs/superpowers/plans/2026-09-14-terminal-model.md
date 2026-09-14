# Plan: Canonical Terminal Model (issue #91 Phase 3, D2+D5)

Spec: `docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md` (§ D2, D5, §8.3, §9 terminal model/snapshot layers, acceptance A4/A5b/A11)
Parent issue: #91 (do NOT close)

## Goal

PTY runner owns a canonical terminal state: every child output chunk is parsed by `@xterm/headless` inside the runner, assigned a strictly increasing `outputSeq`, retained in a bounded in-memory ring, and can be serialized as a versioned `TerminalSnapshot` DTO with proven hydrate equivalence. The runner additionally speaks a capture-and-subscribe protocol alongside the legacy fire-and-forget broadcast — **without changing any legacy behavior** (old UI keeps working unchanged; UI switch is Phase 4).

Closes acceptance A4 (snapshot rebuildable), A5b (hydrate/合成帧等价), A11 (perf) — at the layer they live in (unit + fake-transport integration; full attach e2e A5/A5c/A6 land with the Phase 4 UI switch).

## Non-goals (later phases)

- Switching `src/ui/pty-attach.ts` to snapshot+subscribe, deleting screen.log replay as correctness source, jiggle deprecation (Phase 4)
- Control command lifecycle accepted/applied/observed, reconcile ordering (Phase 5)
- Removing `childInputLooksEmpty()` (Phase 6)
- D6 Windows JSON-runner (separate issue)

## Verified ground truth (do not re-litigate)

- `@xterm/headless` v6 exposes: `buffer.active.{cursorX,cursorY,baseY,length,getLine}`, `line.getCell(x)` → `getChars()/isFgPalette()/getFgColor()/isFgRGB()/isBold()/isInverse()...`, `terminal.modes` (insertMode, originMode, bracketedPasteMode, mouseTrackingMode, ...), `reset()`, `resize()`. `write()` parses **asynchronously** (verify callback support; else poll via `setImmediate`).
- Runner currently: `child.onData` → `appendBoundedScreenLog` + `broadcast({type:"output", data})`; socket protocol (runner→client): hello/status/output/editor_state/exit/error; (client→runner): hello/input/resize/interrupt/terminate/detach/get_status/editor_state.
- Canonical terminal state is **runner-lifetime memory only** — never persisted across runner restart (runner death kills child; no old-screen restoration scenario exists).

## Architecture (per spec §9 split)

```
src/core/terminal-model.mjs        # model + ring (parser factory injected)
src/core/terminal-snapshot.mjs     # capture DTO v1 / hydrate / equivalence / synthesizeFullRedrawFrame
src/core/terminal-attach-protocol.mjs # pure subscription state machine (send injected); runner wires it
runner/pty-runner.mjs              # integration: feed model on child.onData, expose subscribe_terminal
```

### DTO v1 (versioned, parser-independent)

```js
{
  version: 1,
  kind: "terminal_snapshot",
  cols, rows,
  snapshotSeq,               // seq of last chunk incorporated into this snapshot
  cursor: { x, y },          // viewport-relative
  modes: { originMode, insertMode, bracketedPasteMode, mouseTrackingMode, ... },  // minimal closure
  viewport: [ { text, cells: [ {ch, fg, bg, flags} ] } ],  // rows of viewport (chars + attrs)
  scrollback: [ ... ],       // up to scrollbackCap lines BEFORE viewport (may be empty)
  scrollbackTruncated: bool, // true if more scrollback existed than the cap
}
```

Design decisions (plan-stage rulings):
- **Scrollback snapshot cap = 256 lines** + viewport, explicit `scrollbackTruncated` flag. Current status quo (screen.log tail hard-cut) recovers far less; unlimited scrollback DTO (2000 lines) would make snapshots heavy. Phase 4 can revisit per attach UX feedback.
- **Ring caps: 2048 chunks / 4 MiB** (whichever hits first), eviction records `evictedThrough` seq; subscriber needing `sinceSeq <= evictedThrough` → fresh snapshot (spec: never stitch from partial tails).
- **Perf thresholds (A11)**: feed p95 ≤ 5ms/chunk, p99 ≤ 8ms; snapshot capture ≤ 50ms; hydrate ≤ 100ms (80×24 + 256 scrollback on dev hardware). Ring overflow must produce a resnapshot signal, never silent data loss.

### Wire route decision (open decision A/B — resolved by Task 2 prototype evidence)

- **Route A**: wire carries the DTO; UI hydrate adapter synthesizes VT locally.
- **Route B**: wire carries a synthesized full-redraw byte frame (from the same canonical state) + minimal meta; UI feeds bytes to existing xterm unchanged.
- Both routes share ONE synthesis implementation in `terminal-snapshot.mjs` (frame synthesis is required for hydrate testing anyway: hydrate == write frame into an independent parser). The decision is only *where synthesis runs* (runner vs UI) and *what the versioned wire contract is*.
- Task 2 must record: equivalence pass rate on torture fixtures, payload size, latency, UI-side delta estimate. Decision + evidence appended to this plan.

### Capture-and-subscribe protocol (additive, legacy-safe)

- Client → runner: `{type:"subscribe_terminal", sinceSeq?: number}`.
- First subscribe (no sinceSeq): runner synchronously captures snapshot at current seq S, sends `{type:"snapshot_begin", snapshotSeq:S, cols, rows}` + payload chunk(s) + `{type:"snapshot_end", nextSeq:S+1}`, then live `{type:"output", seq, data}` for seq > S.
- Reconnect with sinceSeq=X: if `X+1 > evictedThrough` → replay ring X+1..now (bounded write, then live); else send fresh snapshot with `{resnapshot:true}` marker.
- Atomicity: subscription registration + capture happen in the same synchronous tick (single-threaded JS ⇒ no output can interleave); ring retains the gap window by construction.
- Legacy `output` broadcast gains an additive `seq` field (old clients ignore unknown fields). No legacy message semantics change.
- Runner restart: model empty ⇒ snapshot payload `{empty:true}` ("host starting" baseline — new child's first output establishes the new baseline; per spec, no old-screen restoration).

## Tasks (bite-sized, commit per task)

### Task 1 — terminal model core (`src/core/terminal-model.mjs`)
- `createTerminalModel({cols, rows, scrollback, ringChunkCap=2048, ringByteCap=4MiB, parserFactory})` — parserFactory injectable (default: `@xterm/headless` Terminal).
- `feedOutput(model, chunk)` → assigns `seq` (strict monotonic from 1), feeds parser (async write — model exposes `whenIdle()`/write-callback accounting), appends `{seq, data}` to ring with eviction accounting (`evictedThrough`, `ringBytes`).
- `ringChunksAfter(model, seq)` → chunks with seq > given, or `{evicted:true}` marker.
- Pure-ish: no fs, no sockets.
- Tests (`test/terminal-model.test.mjs`): seq monotonicity across split escape sequences (chunks that split CSI/OSC across feeds — parser must still get exact byte order); ring eviction advances `evictedThrough`; byte-cap eviction; `ringChunksAfter` boundaries.
- **Commit early**: land model + passing unit tests before touching anything else.

### Task 2 — snapshot DTO + hydrate + frame synthesis + ROUTE DECISION (`src/core/terminal-snapshot.mjs`)
- `captureTerminalSnapshot(model, {scrollbackCap=256})` → DTO v1 (grid walk: chars + fg/bg/flags; cursor; modes minimal closure; `await model.whenIdle()` before capture).
- `synthesizeFullRedrawFrame(model|dto)` → VT bytes: DECSET mode set, scrollback replay via ordered writes + newlines to push into scrollback, then viewport rows with absolute cursor positioning (CUP) + SGR attrs per run, cursor to saved position. One implementation, used by both hydrate and (if chosen) the wire.
- `hydrateTerminalSnapshot(dto, parserFactory)` → independent model fed by the frame; `assertSnapshotEquivalence(a, b)` grid/cursor/modes walker for tests.
- Torture fixtures (A4/A5b): split CSI/OSC across chunk boundaries, relative cursor moves (CUB/CUP/CUP-relative), scroll-up + scrollback spillover, SGR attrs (bold/inverse/palette/RGB fg+bg), wide/combining chars smoke, cursor park, resize-after-content.
- Perf micro-checks folded into Task 4.
- **Record route decision** (A vs B) + evidence table appended to this plan → gates Task 3 wire payload shape.

### Task 3 — runner integration + capture-and-subscribe protocol (`src/core/terminal-attach-protocol.mjs`, `runner/pty-runner.mjs`)
- Pure state machine: `createTerminalSubscription({model, send, now})`; `handleTerminalMessage(msg)` for `subscribe_terminal`; internal `onOutput(seq, data)` fan-out (per-socket lastSeq tracking; gap → resnapshot marker once).
- Runner: create model per host (cols/rows from host config, scrollback 2000 parser-side); `child.onData` additionally feeds model (screen.log + legacy broadcast unchanged); `resize` also `model.resize()`; wire `subscribe_terminal` via the state machine; `output` broadcast gains additive `seq`.
- Backpressure note: per-socket writes are stream-buffered by node; slow consumer just grows its socket buffer (same as today's broadcast) — acceptable, unchanged semantics.
- Tests (`test/terminal-attach-protocol.test.mjs`, fake send/transport): first-subscribe snapshot+S+1 continuity; output injected between capture and live switch lands exactly once (A5 gap/dup at protocol layer); reconnect sinceSeq replay; ring-evicted → fresh snapshot + resnapshot marker; legacy `output` messages still carry data (compat pin); runner-restart empty snapshot `{empty:true}`.
- Keep zero behavior change for legacy clients (full suite green is the gate).

### Task 4 — perf A11 + acceptance sweep
- `test/terminal-model-perf.test.mjs`: 750 chunks (60s × 12.5fps equivalent) back-to-back + paced variant (setInterval 80ms, shortened to ~5s wall); measure per-chunk feed latency (p95/p99), snapshot capture + hydrate latency at end-state; assert thresholds; ring overflow behavior (feed past caps mid-stream, assert resnapshot signal + no crash).
- Full regression: `node --test test/*.test.mjs` (note: NOT `test/`), `npm run typecheck`, zero stray coordinators.
- Update this plan's "Route decision" section with final Task 2/4 evidence if anything shifted.

## Verification per task

Every task: targeted tests green → full suite green → typecheck → conventional commit (explicit `git add <files>`). Task reviews per SDD; whole-branch final review before PR.

## Risks

- **xterm write-async accounting**: if the write callback is unavailable, poll `setImmediate` until parser idle; model must expose deterministic `whenIdle()` for capture correctness (capture reads buffer post-parse).
- **Frame synthesis completeness** (route B risk): modes/scrollback edge fidelity — torture fixtures exist precisely to quantify; route A is the fallback if equivalence < 100% on any fixture.
- **Perf thresholds too tight on CI hardware**: thresholds are p95/p99 with generous headroom; if CI shows systematic misses, re-baseline with evidence (not silently relax).
