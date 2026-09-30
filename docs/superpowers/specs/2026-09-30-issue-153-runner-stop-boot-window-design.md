# Issue #153 Design — job-runner boot-window stop loss (stop latch)

Status: **approved 2026-09-30 (D2 = (a), split out of #95 per D3)** · Base: `main@444199d`
Parent: issue #95 spec (F1) — this doc is self-contained; executors do not need #95's spec.

## 1. Problem (experimentally proven)

`runner/job-runner.mjs` publishes an observable `working` state (the coordinator's
`run_started` creates `status.json`, `:95-112`) **before** it spawns the worker and **before**
it registers `process.on("SIGTERM", stop)` (`:356-371`). A stop signal landing in that window
dies with Node's default action: the runner exits silently — no `finalizeRun`, no
`run_finalized`, no `endedAt`, not even the `worker_pid` diagnostic. The row stays
`working/alive` forever.

Production reach: `archiveView()` (`src/runtime/service.mjs:726-735`) sends `killProcess(pid)`
(SIGTERM → 4 s → SIGKILL) to a just-started run's pid — exactly the tested path. The CI flake
`stopping the runner finalizes the run as stopped` (burns exactly its 15 s wait; neighbour test
passes in 260 ms; red on 09-25 and 09-30, both re-run green) is this race under slow machines.

Proof (2026-09-30, local, controlled): injecting an 800 ms window between `run_started` and the
spawn → 3/3 deterministic failures with the CI TAP fingerprint; the same window plus a
module-scope SIGTERM latch → 3/3 passes; unmodified runner under load → 2/2 failures. Full
method + preserved failure state in #95's research notes.

## 2. Invariant

**No non-terminal state may be observable before the process can handle a stop, and a
SIGTERM/SIGINT delivered at any time after the module is loaded must produce a terminal
state.**

## 3. Design (decided: module-scope latch, replay into the existing `stop()`)

| Layer | Artifact | Kind |
|---|---|---|
| Pure state machine | `src/core/stop-latch.mjs` — `createStopLatch()` → `{ note(signal), pending(), take() }`; `note` is idempotent (first signal wins, SIGINT/SIGTERM collapse), `take` reads-and-clears once | pure |
| I/O shell | `runner/job-runner.mjs` — latch handlers installed at module scope; `stop_latch_armed` emitted as the run's **first** diagnostic (before `runner_start`); after the real handlers are wired, `if (stopLatch.take() != null) stop()` replays an early stop | side-effectful |
| Test-only window | `AGENT_BOARD_TEST_BOOT_WINDOW_MS` delays the runner between `run_started` and the spawn so the window is hit deterministically, not by timing luck | side-effectful, test-only |

Replay semantics (accepted trade-off, #95 D2=(a)): a stop landing in the window is remembered,
the runner continues, spawns the worker, and the replayed `stop()` kills it immediately after
handler wiring — a doomed worker really is spawned once. Signals after wiring run both the
latch note (harmless bookkeeping) and `stop()`; `take()` fires at most once, and `stop()`
itself is guarded by `worker.killed`, so no double-fire.

Residual window (documented, harmless): a signal during module *import* — before the latch
handlers exist — still exits by default, but at that point nothing has been published, so no
observable state is lost. A3 pins "nothing observable before the latch" via the
first-diagnostic ordering.

Windows platform scope: Node on Windows ignores the signal name and hard-kills, so no handler
can run — this fix is Unix-only and Windows behaviour is unchanged (Non-goal; the durable
stop-intent alternative is parked in #95 spec §7).

## 4. Acceptance (IDs沿用 #95 spec 矩阵)

| ID | Item | Verification type | Concrete check | Pass criterion |
|---|---|---|---|---|
| A1 | A stop inside the boot window still finalizes | integration (deterministic) | `test/runner-stop-window.integration.test.mjs`: leg 1 sets `AGENT_BOARD_TEST_BOOT_WINDOW_MS=800`, SIGTERMs as soon as `working` is observable; leg 2 runs the same flow without the knob | both legs: `status.json.endedAt != null` and `semanticState === "stopped"`; leg 2 also proves the knob is inert when unset |
| A2 | Stop-latch state machine | unit | `test/stop-latch.test.mjs` | note/take/repeat/collapse/empty/independent-instance paths; no double-fire |
| A3 | Nothing observable before the latch | integration | assert the run's first `diagnostics.jsonl` entry is `stop_latch_armed` (single-file observable, ahead of `runner_start`) | any other first entry fails |
| A4 | The regression case survives load | integration (repeat, **one-time procedure — not a recurring CI test**) | 20 consecutive local runs of `test/runner.integration.test.mjs` while the full suite runs in parallel | 20/20 green (pre-fix baseline: failures within the first 2–3 runs under load) |
| A10 | A dead-runner row converges | integration (deterministic) | SIGKILL the runner after `run_started`, then call `service.reconcile()` | `state.json` converges to `semanticState: "failed"`, `processState: "exited"`, summary `Failed (runner exited)` within the same pass (path exists: `service.mjs:2118` reconcile → `reconcile_finalize`) |

`npm run verify` must exit 0 at branch head (A8-level gate inherited from repo convention).
U1/U2 (user acceptance against an installed build) stay with #95.

## 5. Risks / Non-goals

- Windows: unfixable at the signal layer (above); recorded, not addressed here.
- The test knob lives in a production file: `AGENT_BOARD_TEST_*` naming, inert-when-unset
  proven by A1 leg 2, behaviour proven by leg 1.
- Budget-nesting fixes for `runner.integration.test.mjs:282` belong to #95 F2 and **must land
  after this issue** — widening that budget here would paper over the race.
- `pty-runner` / `state-coordinator` boot windows are unaudited (follow-up, #95 §7).
