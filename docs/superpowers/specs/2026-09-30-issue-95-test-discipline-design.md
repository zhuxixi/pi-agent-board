# Spec — issue #95: real-process tests must not flake (runner stop-safety + budget/diagnosis discipline)

Status: **branch spec (refreshed 2026-09-30 late): tonight's scope = F3 → F2 → F4 only** · Base: `main@43dca95` (2026-09-30) · Route: bug → systematic-debugging

## Delivery status (2026-09-30)

- **F1 delivered by #153 / PR #155** (squash `43dca95`, merged 23:34): stop latch + `stop_latch_replayed`; A1–A4 and A10 all green there, CR two-stream Round-1 PASS.
- **A10's convergence fix also landed in #153** (`loadRow` recorded-pid-wins-over-mirror).
- Acceptance matrix below is narrowed to what remains on THIS branch: **A5, A6, A7, A8** (+ A9 stays open as the 14-day CI observation; A11 N/A while D4 = defer; A12 N/A while D1 = O3).
- F5 (serialization) stays deferred per D1 = O3 — the observation window is running; tonight's three flake observations are its first baseline samples.
- F7 (issue trail) is complete: research conclusions + falsified-claim corrections are on the issue thread.
Research: `research/2026-09-30-runner-stop-window-race.md`, `research/2026-09-30-flake-inventory-and-cost.md`

## 1. Root-cause revision (this round's main result)

The issue's previous framing — "CI machine is slow, the tests need bigger wall-clock budgets"
(comment 1 §三) — is **falsified for the highest-frequency failure**
(`stopping the runner finalizes the run as stopped`).

`runner/job-runner.mjs` publishes an observable `working` state (via the coordinator's
`run_started`, which creates `status.json`) **before** it spawns the worker and **before** it
installs `process.on("SIGTERM", stop)` (`:95-112` vs `:356-371`). A stop request that lands in
that window kills the runner with Node's default action: no `finalizeRun`, no `run_finalized`,
no `endedAt`, no diagnostics. Proven by a controlled experiment (inject the window → 3/3
deterministic failures; add an early stop latch → 3/3 passes; unmodified runner under load →
2/2 failures locally, and the same signature appears in CI on 09-25 and 09-30 with
`duration_ms ≈ 15200` against a 15 s internal wait).

Sample-size honesty: each experiment arm is n = 2–3. The claim rests on the mechanism closing
the loop — widen the window and the failure becomes deterministic, arm the latch and it
disappears — not on the counts themselves.

This is reachable in production: `archiveView()` kills the current run pid with SIGTERM
(`src/runtime/service.mjs:726-735` → `killProcess`), so archiving/stopping a **just-started**
run can leave the row pinned at `working/alive`. Whether anything then converges such a row
(reconcile / pid-liveness watching) is **unverified** — promoted to acceptance item A10.

The other three known signatures (the host-concurrency `A10` resolver burn,
`subscribe_terminal` 15 s, `A5 burst` 30 s) were **not** re-proven; they stay in scope as "unexplained until the failure can name its
own blocked step" (→ F3).

## 2. Deliverables

### F1 — Runner stop-safety (production fix) — *primary*

Invariant: **no non-terminal state may be observable before the process can handle a stop, and
a SIGTERM/SIGINT delivered at any time after the module is loaded must produce a terminal
state.**

Platform scope: the latch/handler mechanism is **Unix-only**. On Windows, Node's `process.kill`
ignores the signal name and hard-kills the target — no handler can ever run — so the
boot-window loss is unfixable at the signal layer there. Either Windows stays out of scope
(current behaviour unchanged, recorded in Non-goals) or D2 option (d) is chosen, which does not
depend on signals being catchable.

Design (testability split):

| Layer | Artifact | Kind |
|---|---|---|
| Pure state machine | `src/core/stop-latch.mjs` — `createStopLatch()` → `{ note(signal), pending(), take() }` (idempotent note, single take, SIGINT/SIGTERM collapse) | pure |
| I/O shell | `runner/job-runner.mjs` — handlers installed at module scope; `take()` replayed into the existing `stop()` once it exists; emits a `stop_latch_armed` diagnostic as the run's **first** diagnostic, before the coordinator bootstrap | side-effectful |
| Test-only window | `AGENT_BOARD_TEST_BOOT_WINDOW_MS` delaying the runner between `run_started` and the spawn, so the window can be hit deterministically instead of by luck | side-effectful, test-only |

The test knob lives in a production file, so it carries the same guard as F4's knobs:
`AGENT_BOARD_TEST_*` naming, a unit test proving it is inert when unset, and a behaviour test
proving it actually widens the window (it must not be able to rot into a no-op).

Replay semantics (this is what D2 weighs): with the latch alone, a stop landing in the window
is *remembered*, the runner continues, spawns the worker, and the replayed `stop()` kills it
immediately after the handlers are wired — i.e. a doomed worker really is spawned once.
D2 (b) avoids that wasted spawn by publishing `run_started` only after spawn + handler wiring,
at the cost of reordering the bootstrap (the coordinator's `run_progress` needs a materialized
status).

### F2 — Budget audit gate (mechanical discipline)

`scripts/budget-audit.mjs` with pure exports `parseTestBudgets(source)` / `auditBudgets(files)`:
- rule (a): a test declaring `{ timeout: T }` must satisfy `T ≥ max(single explicit wait in the
  body) + margin`, where **`margin = max(5 000 ms, wait / 3)`** (a named constant in the audit
  script, unit-tested). Summing all waits would demand 120 s+ timeouts for multi-wait files
  (`terminal-snapshot` alone has four 30 s waits) — re-inflating the very budgets this issue
  retires;
- rule (b): a test that drives an app-level deadline ≥ 30 s must declare a timeout ≥ that
  deadline **unless** it goes through an F4 knob, in which case `// budget: knob` exempts it
  (static analysis cannot know a runtime knob compressed the deadline);
- escape hatch: an inline `// budget: <reason>` comment exempts the line (audited by the unit test).

Known tension, stated openly: derived budgets are still wall-clock numbers. The audit buys
*accountability* — no unsatisfiable nesting, every number carries a recorded reason — not
immunity to slow machines; that part is F1/F3/F4's job.

Amends the two inversions the spec predicted rather than fixing them as written:
`test/runner.integration.test.mjs:282` already satisfies rule (a) under max+margin
(20000 ≥ 15000 + 5000) and needed no change; the delivered fixes are the two rule-derived
widenings (`test/pty-attach-cold-start-e2e.test.mjs`'s slow-boot test 30000 → 35000 and
`test/runner.integration.test.mjs:489` 30000 → 35000) plus `host-concurrency A10`'s explicit
`// budget:` escape. Wired as `test/budget-audit.test.mjs` so `npm test` enforces it, plus
unit fixtures that must fail.

### F3 — Failure self-diagnosis (the next red names its own blocked step)

`test-support/flake-postmortem.mjs`: pure `formatPostmortem({ status, state, host, diagnosticsTail, journalTail })`
→ human-readable "last observed" block; I/O shell `capturePostmortem(root, viewId, runId)`; the
four flaky helpers' `waitFor` wrappers attach it to the assertion error on timeout.
Unit tested with fixtures (missing file, truncated tail, absent diagnostics).

### F4 — Test-only ladder knobs (stop paying production grace)

Expose test-scoped overrides for the wall-clock ladders that tests currently have to wait out:
`HOST_START_GRACE_MS`, `HOST_RECOVERY_GRACE_MS`, `HOST_RECOVERY_POLL_MS`,
`ATTACH_RESOLVE_TIMEOUT_MS` (`src/runtime/service.mjs:61-69`), `HOST_PROBE_TIMEOUT_MS`,
`ATTACH_RECONNECT_TIMEOUT_MS`. Names are `AGENT_BOARD_TEST_*`-scoped; production defaults stay
byte-identical when unset (unit-tested), and a test asserts the knob actually changes behaviour
(so it can never rot into a no-op).

Testability split: each constant gains a pure reader beside its definition — e.g.
`resolveHostStartGraceMs(env = process.env)` returning override-or-default — and the I/O shell
is reduced to passing `process.env` at the call site. Unit tests: unset ⇒ default byte-identical;
set ⇒ override used; invalid value ⇒ default plus one warn diagnostic. The integration proof
(A7) drives the host-concurrency `A10` recovery chain under the knob with a shortened budget.

### F5 — Serialization (only if D1 says so)

- O1: two-phase runner (`scripts/run-tests.mjs`) used by `test` / `test:coverage`: phase 1 =
  real-process files (concurrency 1 or 2), phase 2 = the rest. No `ci.yml` change.
- O2: split the CI step into two steps (`ci.yml` change).
- O3: defer; re-measure after F1–F4 (the issue's own "若再红则升级串行方案" clause).
  Measurement plan so O3 is falsifiable: count in-scope CI reds (failures matching the research
  note's §3 signatures, or any new real-process red) per week, recorded in the issue thread;
  observation window 14 days. Zero in-scope reds ⇒ close the issue; any in-scope red ⇒
  revisit D1 with the accumulated evidence.
Cost, recomputed from the same TAP model with honest makespan arithmetic (today's 67.7 s ≈
max(45 s largest file, 321 s ÷ 3); the two phases are **sequential, they do not overlap**):
two-lane ≈ 110 s (phase 1 at c=2) + 35–50 s (phase 2 at c=3) = 150–175 s → **+80–105 s
(≈ +1.5 min) per CI job**; fully serial ≈ 260 s → **+3–3.5 min per job**. The same delta lands
on every local `npm test` run. CI re-measurement stays mandatory before these numbers are
treated as final.

### F6 (optional) — Test hygiene

924 leaked `/tmp/agentview-*` roots (9.7 MB) and one observed leaked detached coordinator.
Scope if chosen: remove the roots in the leaking suites, add a static "no unremoved mkdtemp root"
check, and a post-run assertion that no detached coordinator survives a test file.

### F7 — Issue trail & fact correction (documentation, no code)

Two actions inside the plan (not commit content): (1) post this round's research conclusions —
the root-cause experiment table and the revised framing — as comments on issue #95; (2) correct
the now-falsified claims in the thread, chiefly comment 1 §三's "环境问题而不是生产缺陷" and the
budget-widening direction, so a future reader cannot re-derive the wrong design from the
thread. This recovers the "comment-fact correction" decision point referenced in issue comment 3
(the 09-25 spec draft it pointed to never landed on disk and was lost).

## 3. Acceptance matrix

| ID | Item | Verification type | Concrete check | Pass criterion |
|---|---|---|---|---|
| A1 | A stop signal inside the boot window still finalizes the run | integration (deterministic) | new `test/runner-stop-window.integration.test.mjs`: inject `AGENT_BOARD_TEST_BOOT_WINDOW_MS`, SIGTERM inside the window, and a second leg without injection | both legs: `status.json.endedAt != null` and `semanticState === "stopped"` |
| A2 | Stop latch state machine | unit | `test/stop-latch.test.mjs` | note/take/repeat/no-signal paths covered; no double-fire |
| A3 | "Nothing observable before stop is handleable" ordering | integration | assert `stop_latch_armed` is the **first entry** of the run's `diagnostics.jsonl` (ahead of the existing `runner_start`) — a single-file observable, no cross-file timestamp comparison | any other first entry fails the test |
| A4 | The regression case survives load | integration (repeat) | 20 consecutive local runs of `test/runner.integration.test.mjs` while the full suite runs in parallel — **one-time acceptance procedure, not a recurring CI test** | 20/20 green (baseline: 2–3 failures in the first few runs before the fix) |
| A5 | Budget audit gate | unit + static | `test/budget-audit.test.mjs` over fixtures **and** the real `test/` tree | fixtures with known inversions are reported; real tree reports zero violations |
| A6 | Failure self-diagnosis | unit + integration | `formatPostmortem` fixtures (missing file, truncated tail) + the wrapped `waitFor` exercised with a **stubbed always-false predicate and a tiny real timeout** — no 15 s burn inside `npm test` | the failure message contains status/state/host/diagnostics excerpts and a "last observed state" line |
| A7 | Ladder knobs | unit + integration | knob set/unset comparison, then the host-concurrency `A10` chain re-driven under the knob | unset ⇒ production defaults unchanged; set ⇒ same assertions pass with a shorter budget |
| A8 | Full gate | static + build | `npm run verify` (typecheck, perf gate, tests, coverage thresholds, pack:dry) | exit 0 |
| A9 | CI observation | automated E2E (CI) | ≥5 consecutive CI runs **or ≥2 days**, whichever comes first, after merge (matches the issue's original acceptance direction) | no in-scope red (other issues excluded explicitly) |
| A10 | A dead-runner row is converged | integration | construct the boot-window death (runner killed after `run_started`, no `endedAt`); **locate** whichever convergence path actually exists (reconcile / refresh / sweeper) and drive it | a located path converges the row within 15 s; no path found, or no convergence ⇒ **blocking finding** and F1's scope extends with the convergence fix — U1 depends on it |
| A11 | No leaked roots / processes (enforced only if D4 = yes) | static + integration | leak audit over `test/` + post-run process check | zero unremoved temp roots; zero surviving detached coordinators |
| A12 | Two-phase runner is faithful (enforced only if D1 ≠ O3) | static + integration | one local run of the two-phase wrapper: aggregated test count vs the single-phase run; `npm run test:coverage`; record the wall-clock delta | identical test count (no double-run, no skip); coverage thresholds still pass; measured wall-clock delta within the bound declared in F5 |
| U1 | User-observed: stop/delete a just-started run | user | on an installed build, archive/stop a row seconds after its run starts | the row reaches a terminal state (stopped/archived), never stuck at `working` |
| U2 | User-observed: two days of normal use | user | daily board use | no row stuck at `working` without an error and without a converge/reconcile step |

Automated items must be executed and recorded with their real commands in the PR; U1/U2 stay
`pending` until the user runs them (they cannot be replaced by A-items).

## 4. Decisions requested

- **D1 (scope of serialization)**: O1 two-phase local-runner (no `ci.yml`) / O2 CI split /
  O3 defer until F1–F4 are measured. Cost: see F5. **Recommendation: O3** — the proven defect
  is F1, and the measurement plan makes revisiting D1 cheap and evidence-based.
- **D2 (F1 shape)**: (a) module-scope latch replaying into `stop()` — a stop in the window
  results in spawn-then-immediate-kill of a doomed worker (cheap, experimentally proven);
  (b) publish `run_started` only after spawn + handler wiring — no wasted spawn, but reorders
  the bootstrap and must re-prove the progress-beat path; (c) both; (d) durable stop-intent
  marker (file / coordinator command) instead of a signal — the only option that also fixes
  Windows, at materially higher design cost. **Recommendation: (a) now** — cheap and
  experimentally proven; (d) stays parked as the long-term open question (§7).
- **D3 (packaging)**: does F1 ship as **its own issue/PR** (it is a production defect found via
  the test) with #95 keeping only the test-discipline work F2–F5, or does everything ride one
  branch? Recommendation: split — F1's review question ("can a stop be lost?") is unrelated to
  #95's review question ("is the suite stable?"), and F1 can merge first. If split: A1–A4 and
  A10 travel with the F1 issue (they verify F1 alone); A5–A8, A11 stay here; ordering
  constraint — **F2's budget fix for `runner.integration.test.mjs:282` must land after F1**, or
  the budget change papers over the race again; and F7's comments cover both issues.
- **D4 (optional F6 hygiene)**: include or defer. **Recommendation: defer** — cheap but
  orthogonal; fold it into whichever branch lands last.

## 5. Non-goals

- No further wall-clock widening (40 → 90 → 150 s is the pattern being retired).
- `ci.yml` untouched unless D1 chooses O2.
- No reopening of #121 / #132 / #140; no changes to the attach subsystem's behaviour.
- If D2 ≠ (d), Windows stop-safety is explicitly out of scope: signals are uncatchable there,
  current Windows behaviour is unchanged, and that limitation is documented.
- Serialization is not allowed to double-run tests or to break coverage aggregation.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Residuum: a SIGTERM during module *import* (before the latch exists) still exits by default — but nothing has been published yet, so no observable state is lost | Documented as a known window; A3 pins "no observable state before the latch" |
| F2's source regex mis-parses an exotic test shape | Minimal rules + explicit `// budget:` escape hatch + fixtures; audit is unit-tested |
| F4 knobs leaking into production semantics | `AGENT_BOARD_TEST_*` naming, unit test asserting defaults are unchanged when unset, and a behaviour-change test |
| F1 changes runner startup order (D2 b/c) and breaks the progress beat | Only considered if D2 = b/c; the coordinator's `run_progress` requires a materialized status, so the bootstrap order must be re-verified by the integration suite before landing |
| Windows: signals cannot be caught at all (Node hard-kills on `process.kill`), so F1's mechanism cannot restore stop-safety there | D2 (d) is the only complete fix; with D2 = a/b/c the Windows behaviour is unchanged and recorded as a Non-goal |
| The boot-window knob is a test hook inside a production file | Same guard as F4: `AGENT_BOARD_TEST_*` naming + inert-when-unset unit test + behaviour test (see F1) |
| "Reconcile converges the stuck row" turns out to be false | A10 verifies it explicitly and is a blocking gate for U1; a negative result extends F1 rather than shipping a silent gap |

## 7. Open questions (explicitly not scope)

- Do `runner/pty-runner.mjs` (handlers at `:530`/`:754`) and `runner/state-coordinator.mjs`
  (`:199`) have the same boot window — an observable state published before their handlers
  exist? Not audited this round; F1 covers `job-runner` only. If the audit finds the same
  pattern, that is a follow-up issue, not scope growth here.
- Should the stop path migrate to a durable stop-intent marker for all platforms long-term
  (supersedes D2 (d))? Parked until F1 lands and the residual failure modes are known.
