# Issue #279 — Root-cause report & fix spec: dashboard-fold harness flake ('selected session/header must never be hidden by an indicator')

Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-09T08:55:00+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-09T09:02:00+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-09T09:20:00+08:00

Repo: zhuxixi/pi-agent-board · Baseline: origin/main @ 608a22a · Type: bug (test-only) · Refs: #95 (umbrella), #234 (introducing PR)

## 1. Root cause (established, deterministic reproduction)

`frame()` in `test-support/dashboard-fold.ts:52-57` compares **full strings** from two
independent render passes: `dash.render(width)` then `dash.renderRows(width)`, asserting
`lines.includes(body[selectedBodyLine])`. `renderRows()` reads a fresh `Date.now()`
(`src/ui/dashboard.ts:1486`) and every session row ends with the `age` column
(`relativeTime`, whole-second granularity — `src/core/heuristics.mjs:303` via `rowView`,
`src/core/rows.mjs:151`). When the two passes straddle the selected row's age boundary
(phase = `lastActivityAt mod 1000`, recurs once per second), the trailing `1s` becomes
`2s` and the full-string `includes` fails. Header lines carry no age — consistent with
failures landing inside `focusHeader` navigation.

The originally suspected poll/refresh between the two calls is ruled out: the probe is
fully synchronous; the only state advancing between the two calls is the clock.

Evidence (untouched probe, main @ 608a22a; scripts in
`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-279/research/`):

- frozen clock (`--import` loader pinning `Date.now`) → `{"ok":true}`;
- clock advancing +1000ms per `Date.now()` call → red with the **exact CI assertion and
  stack** (`frame` @ dashboard-fold.ts:56 via `focusHeader` @ :64);
- real clock straddling the age boundary → red, no fake clock;
- real clock on a fast local machine → 10/10 green (matches the issue report; c8
  instrumentation + throttled CI runners stretch the render pair into straddle range).

Why CI and not local: c8 instrumentation + parallel load stretch one render pair to tens
of ms; the probe issues 100+ `frame()` calls; any straddle while a row is selected fails.
Blast radius: this full-string cross-pass compare exists **only** at
`dashboard-fold.ts:56`. Sibling probes from the same PR compare a 20-char visible prefix
(`dashboard-scroll.ts:67`, `dashboard-tui-modes.ts:76`), which excludes the trailing age
and therefore never flakes. No production-code defect.

## 2. Fix design (test-only)

Decision table:

| Option | Change | Verdict | Rationale |
|---|---|---|---|
| D1 prefix compare | `frame()` compares a 20-char visible prefix of the selected body line against prefixes of the frame lines (local helper, same shape as `dashboard-scroll.ts:67`) | **adopt** | Matches the sibling-probe convention; asserts exactly what the check means (the selected target is visible in the windowed frame, not replaced by a scroll indicator); immune to trailing-column jitter; minimal diff |
| D2 freeze probe clock | pin `Date.now` for the whole probe | reject (standalone) | Masks future trailing-column nondeterminism instead of making the assertion precise about its meaning; no probe-layer precedent (clock patching exists only at unit-test layer) |
| D3 single snapshot | production `render()` exposes the body it used | reject | Adds statefulness to a production component for a test-only concern |
| D4 deterministic regression leg | a permanent test case runs the probe with a clock that advances +1000ms per `Date.now()` call and must stay green | **adopt** (on top of D1) | Converts the flake into a deterministic guard; precedent: #184's load-independent repro leg. Validated: this exact loader is what turns the current probe red at the CI assertion |

Planned changes (all under `test-support/` + `test/`):

1. `test-support/dashboard-fold.ts` — in `frame()`, replace the full-string
   `includes` with a prefix comparison:
   `const prefix = (line) => line.trimEnd().slice(0, 20);`
   assert `lines.some(line => prefix(line) === prefix(body[selectedBodyLine]))`.
   Keep the existing height and `visibleWidth` assertions unchanged.
2. `test-support/tick-clock.mjs` (new; side-effect-only preload module, no exports) —
   `Date.now` advances +1000ms per call.
3. `test/dashboard-fold.test.mjs` — new test case "folding stays deterministic when the
   clock advances between render passes": spawn the probe with
   `--import <tick-clock.mjs>`, assert `{"ok":true}` (same execFileSync pattern as the
   existing cases).

Why the tick leg passes after D1 (and only then): with the prefix compare, the only
column that differs between the two passes (trailing age) is outside the compared
prefix; all other fixture content is time-invariant (no host → `staleHost` constant;
`unread` static; no age-string assertions in the probe).

## 3. Acceptance matrix

| ID | Function point | Acceptance | Concrete verification | Pass standard |
|----|---|---|---|---|
| A1 | `frame()` visibility assertion is immune to clock advancing between the two render passes | Automated (integration — probe subprocess) | From repo root: `for i in $(seq 1 20); do node --test test/dashboard-fold.test.mjs >/dev/null || { echo "fail run $i"; exit 1; }; done; echo 20/20` (fail-fast; every round exit 0) | 20/20 green |
| A2 | Deterministic regression leg for this flake | Automated (integration — new test case) | `node --test test/dashboard-fold.test.mjs` includes the tick-clock case; on the unfixed probe it must be able to fail (verified pre-fix in research), post-fix green | New case passes; `npm test` green |
| A3 | The D1 rewrite keeps the assertion's teeth (it still fails when the selected line is actually hidden) | Automated (one-off mutation check, evidence recorded) | In the worktree, temporarily remove `windowBody`'s selected-line guard (make it slice from line 0 unconditionally), run the probe, confirm the prefix assertion fails; then revert | Probe red under the mutation; green after revert |
| A4 | Suite regression + stress per issue acceptance | Automated (integration + coverage) | `npm test` once; `npm run test:coverage` once (the full-suite 85/80/70 threshold gate; repo c8 entry `c8 node scripts/run-tests.mjs`, config `.c8rc.json`); probe-under-c8 stress from repo root with the coverage check disabled (thresholds are the full-suite gate's job, and `.c8rc.json`'s `check-coverage: true` would otherwise fail every single-probe round): `for i in $(seq 1 20); do npx c8 --check-coverage=false node --experimental-transform-types test-support/dashboard-fold.ts >/dev/null || { echo "fail run $i"; exit 1; }; done; echo 20/20` (note: `--silent` is not a valid c8 flag and usage-errors the invocation; verified forms: with `--check-coverage=false` the probe runs and exits 0, without it the probe passes but c8 exits 1 on thresholds) | All green, thresholds met, stress 20/20 |
| A5 | Repo gates | Automated (build/verify) | `npm run verify` | Passes |
| U1 | The issue's acceptance holds on main's CI for the carrying merge commit | User observation (post-merge window) | After merge, locate the main **push** CI run whose head SHA equals this fix's merge commit; record the run URL; check `Test (Node 22)` and `Test (Node 24)` job conclusions and grep their logs for the target signature | Both Node jobs `success` AND zero occurrences of 'must never be hidden by an indicator' in that run. If that run goes red on a *different* #95-family signature, U1 stays **pending** (that signature is logged to the #95 ledger, not here) until a green run on a subsequent head; other-family reds never satisfy U1 |

## 4. Testability split (design constraint for implementation)

- `prefix(line)` is a pure function local to the probe (same shape as the sibling
  helper); no I/O. Test boundary: the probe subprocess itself (public key input driving
  + white-box `frame()`).
- `tick-clock.mjs` is a side-effect-only preload module (patches `Date.now` at preload
  time, exports nothing). Test boundary: full subprocess isolation; the clock dimension
  is exercised independently of the real-clock legs, so a regression in either dimension
  fails a distinct named case.
- The `.test.mjs` layer owns only process spawning and JSON assertion (thin I/O shell
  over pure probe logic) — matching `scripts/release_helper.mjs`'s pure-core/thin-shell
  convention.

## 5. Non-goals

- No production `src/` changes.
- No suite-wide clock freezing or CI workflow changes.
- No new #95 umbrella accounting beyond a pointer comment (root cause + fix live here).
- Not touching `dashboard-scroll.ts` / `dashboard-tui-modes.ts` (already immune).

## 6. Risks

- Prefix window (20 cols) will not detect corruption beyond column 20 — accepted; same
  acceptance as both sibling probes, and the assertion's intent is visibility, not
  content equality.
- The tick leg assumes no other time-sensitive assertion exists in the probe —
  verified against the current probe (age strings are never asserted); if a future
  assert becomes time-sensitive, the tick leg will catch it loudly, which is desired.
