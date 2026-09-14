# Plan: Attach Switch to Snapshot+Subscribe (issue #91 Phase 4, D2 completion)

Spec: `docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md` (§ D2 attach flow, §8.4, acceptance A5/A5c/A6, §9 snapshot/subscribe protocol layer)
Parent issue: #91 (do NOT close)

## Goal

The dashboard attach switches from「screen.log tail replay + fire-and-forget live + shrink-and-hold jiggle」to「snapshot hydrate + seq-checked subscribe」。After this phase: attach 画面由 runner-owned canonical snapshot 重建（A5/A5c/A6 e2e 收口），UI 本地 buffer 降级为可丢弃缓存，screen.log 退出正确性路径（保留调试/历史），jiggle 降级为旧 runner fallback。Legacy runners（已部署旧二进制）走显式降级路径。

## Non-goals

- 控制命令生命周期 accepted/applied/observed、reconcile 顺序（Phase 5）
- 删 `childInputLooksEmpty()`、`shouldEscapeAttach` 改造（Phase 6）
- screen.log 写入/删除本身（保留 runner 侧写入 + GC，仅 UI 不再依赖）

## Ground truth (verified, do not re-litigate)

- Runner (Phase 3): both mains handle `subscribe_terminal`; snapshot flow = `snapshot_begin{snapshotSeq,cols,rows,frameVersion,empty?,resnapshot?}` → `snapshot_frame{data}` → `snapshot_end{nextSeq}` → live `{type:"output",seq,data}`; `resnapshot_required{lastSeq,missing}` on gap/ring-pressure/interruption; `sinceSeq===evictedThrough` → complete replay; empty model → `begin.empty:true`, nextSeq 1; `frameVersion` mismatch → typed error. Old binaries silently ignore `subscribe_terminal` (no default case).
- Frame: self-contained on dirty terminals (DECSTR+2J/3J+r preamble); wrap-pending/DECOM-safe cursor park; modes closure edges (DECSTBM/SO-SI/tab stops/DECSC) don't round-trip — content-equivalent only.
- UI today (`src/ui/pty-attach.ts`, 1520 lines): constructor does `replayScreenLog()` → own `@xterm/headless` surface; `connect()` → hello + `jiggleRetry.start` + `startAttachSettle`; `onSocketData` → `output`→`pushOutput`+`checkClearSequence`（jiggle clear 检测）; reconnect = re-jiggle; `pushOutput` forwards OSC52/passthrough protocols.
- UI test infra: attach-flow / pty-attach-cold-start-e2e / desync-heal(-e2e) / hot-session-e2e / reconnect / jiggle-* / detach-gate / render — real-runner e2e suites exist and will exercise the new path automatically.

## Architecture

```
src/core/terminal-attach-client.mjs   # NEW: pure client-side protocol state machine (send/onEvent injected)
src/ui/pty-attach.ts                  # switch: protocol mode primary, legacy mode fallback
test/terminal-snapshot.integration.test.mjs  # NEW: A5/A5c real-runner e2e
```

### Client module contract

- `createTerminalAttachClient({send, emit, probeTimeoutMs=1500, frameVersion=1, forceLegacy})`
- `start()` → client sends `hello` (unchanged) then `subscribe_terminal` probe. States: `probing → protocol:collecting → protocol:live` or `probing → legacy` (probe timeout, no `snapshot_begin`).
- `handleMessage(msg)` consumes: snapshot_begin/frame/end (frame assembly), output.seq contiguity (first live seq MUST equal `snapshot_end.nextSeq`; subsequent +1), `resnapshot_required` → emit resubscribe, seq gap → emit resubscribe, `frame_version_mismatch` error → legacy fallback (treat runner as incompatible).
- Emits: `mode(protocol|legacy)` (once decided), `snapshotReady({frame|empty, nextSeq})` (UI: `term.reset()` + `write(frame)`; empty → loading baseline), `output(data)` (live, UI: pushOutput without jiggle feed), `resubscribe(sinceSeq)` (UI: send `subscribe_terminal{sinceSeq}`), `legacy` (UI: start jiggle + keep screen.log replay path).
- `reconnect(lastSeq)`: skip probe (protocol already achieved), subscribe with `sinceSeq`; ring replay → seamless continue (no reset); evicted/empty/foreign cursor → fresh snapshot (reset+hydrate).
- Interruption (`snapshot_begin`+`frame` then `resnapshot_required` instead of `end`): discard partial, emit resubscribe(0). Empty-model `sinceSeq:0` replay = zero messages until first live chunk (documented; client stays live-ready).
- Env `AGENT_BOARD_TERMINAL_SNAPSHOT=0` → forceLegacy (escape hatch + deterministic legacy tests).
- Probe timeout: local socket + capture awaits parser idle (ms-scale between chunks) → 1500ms generous; on timeout the connection still works (legacy output path) — no user-visible failure.

### UI switch rules

- Protocol mode: no jiggle (never `jiggleRetry.start`), no `checkClearSequence`; `snapshotReady` → `term.reset()` + frame write + settle/loading end at `snapshot_end`; `output` → `pushOutput(data, {forwardProtocols:true})` only; `resubscribe` → resend; reconnect → `client.reconnect(lastSeq)` (seamless replay or fresh snapshot — NO re-jiggle, NO screen.log re-replay in protocol mode).
- Legacy mode (probe timeout / mismatch / env): exact current behavior (screen.log replay at constructor, jiggle on connect, clear detection) — zero regression for mixed fleet.
- `editor_state`/`exit`/`error`/`hello`/`status` handling unchanged in both modes. Detach/Ctrl+Left unchanged (Phase 6).
- Loading ticker: protocol mode ends at `snapshot_end` (or first live output if empty baseline); legacy unchanged.

## Tasks (bite-sized, commit per task)

### Task 1 — client protocol module + unit matrix (`src/core/terminal-attach-client.mjs`, `test/terminal-attach-client.test.mjs`)
Full matrix: probe→protocol happy path (frame assembly, nextSeq continuity); probe timeout→legacy; forceLegacy env; mismatch error→legacy; gap→resubscribe(+1 from lastSeq); resnapshot_required→resubscribe; interrupted snapshot→resubscribe(0); empty baseline→snapshotReady(empty)+live seq 1; reconnect replay (no reset) vs fresh (resnapshot flag); duplicate/stale seq ignored; output before snapshot_end (tolerate? no — protocol violation→resubscribe(0), pin it); legacy `output` (no seq) never counted in protocol mode. Pure logic, fake send/emit.

### Task 2 — real-runner e2e + stress/containment pre-flight (`test/terminal-snapshot.integration.test.mjs`)
A5: subscribe mid-stream over real socket; no gap/dup from nextSeq through live; second subscriber + legacy client concurrently. A5c: kill runner → new runner+child → empty:true baseline → new baseline from new child output (no old screen). Reconnect replay vs evicted→resnapshot over real socket. Firehose probe (pre-flight from Phase 3 final review): sustained multi-MB/s garbage+mixed stream ~3s → bounded lag, no crash, snapshot still capturable; parser containment: malformed byte flood cannot escape into uncaughtException (assert runner alive + document observed behavior). Reuse the pty-runner integration fixture pattern (AGENT_BOARD_ROOT/PI_CODING_AGENT_DIR isolation, tracked coordinator helper, finally-kill).

### Task 3 — UI switch (`src/ui/pty-attach.ts`)
Per Architecture rules. Inventory existing UI e2e: jiggle-specific suites (jiggle-retry, desync-heal*) force legacy via env; hot-session/cold-start/reconnect/render must pass in protocol mode (adapt fixtures only if they pin legacy-only specifics — no assertion weakening). Typecheck mandatory.

### Task 4 — A6 e2e + acceptance sweep
A6 (client+real socket): kill-runner mid-stream → reconnect → fresh snapshot hydrate; local-buffer pollution (garbage into term) → next fresh frame overwrites (self-contained preamble already proven; assert via client events + independent parser compare where feasible). Full regression `node --test test/*.test.mjs` + typecheck + zero strays. Update acceptance table (A5/A5c/A6 → CLOSED) + residual ledger in this plan.

## Verification per task

Targeted tests green → FULL suite green → typecheck → conventional commit (explicit git add). SDD task reviews; whole-branch final review before PR.

## Risks

- **Settle/loading interactions**: `startAttachSettle` assumes jiggle redraws; protocol mode needs its own settle end — read both before wiring (Task 3 first step).
- **Protocol-mode UI e2e fixtures**: existing suites assume jiggle/clear sequences — misclassified pins would either break (visible) or silently weaken (reviewer checks assertion equivalence, not just green).
- **Probe timeout under parser busy**: heavy stream may delay snapshot_begin; 1500ms + no user-visible failure on fallback keeps it safe.
- **Two-mode complexity is TEMPORARY**: legacy path gets deleted only after fleet refresh — document as Phase 6+ cleanup, don't gold-plate.
