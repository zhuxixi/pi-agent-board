# Root-cause report / Spec: monotonic foreground state rebuild (stale "Needs answer")

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-22T23:50:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T00:05:00+08:00 — folded in R1-G1..G3 and R1-D1..D4
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T00:20:00+08:00 — R2-D1..D3 (A4 clock pin, timestamp-bound wording, forget wiring acceptance)

- **Issue**: zhuxixi/pi-agent-board#225
- **Date**: 2026-10-22
- **Status**: draft — awaiting cross-review and user confirmation
- **Type**: bug fix (foreground state mirroring); no reducer, schema, or UI change

## 1. Problem

A foreground row that transiently becomes `needs_input` can stay in **Needs answer** for
the rest of the turn after the question is answered. Live evidence (issue #225):

```
22:56:21  needs_input  pending=[call_.../1]
22:56:44  working      pending=[]          ← tool_execution_end cleared it
22:56:44  needs_input  pending=[call_.../1] ← stale projection re-applied
22:57:04  idle         pending=[]          ← agent_end finally rewrote it
```

The reducer is correct (#221); the resurrection happens in the foreground mirror.

## 2. Root cause

1. `syncRowEvent` (`src/runtime/service.mjs:1533`) rebuilds status from disk on every
   event: `statusFromRow(row)` (`:1535`).
2. `statusFromRow` (`:814-843`) copies `semanticState` / `summary` / `question` /
   `pendingQuestions` but **not `updatedAt`**, so the rebuild has no freshness signal.
3. `writeForegroundState` (`:854-880`) stamps a new `updatedAt` through
   `projectViewState(status, Date.now(), …)`, and every caller fires it as
   `void writeForegroundState(...)` (`:1571`, `:1629`). Two events can therefore have two
   `sync_foreground` commands in flight, and the older projection can materialize last.
4. The next event reduces onto that stale status (it cannot tell it is stale) and writes it
   back; the pending entry survives until `agent_end` finalizes the row.
5. `foregroundPreviewCache` (#113) restores only `latestAssistantPreview` and
   `lastAgentActivityAt`, keyed on `lastAgentActivityAt` — tool events never stamp that
   field, so question state is uncovered.

Additional constraint: `mark_completed` / `mark_holding` / `patch_fields`
(`src/core/state-commands.mjs`) do **not** stamp `state.updatedAt`, so a timestamp-only
guard could resurrect a pre-verdict projection over a manual verdict. The manual-verdict
fence (`isManualVerdict`) must gate the adoption.

## 3. Design

### 3.1 New pure module: `src/core/foreground-projection-cache.mjs`

Module-level shared instance, same rationale as `foreground-preview-cache` (service
instances are created per call, so a per-instance cache is discarded between events).

The cache stores a **status-shaped snapshot**, not the `ViewState` projection: the
projection calls the active tool `latestTool`, while `RunStatus` calls it `currentTool` with
a `summary` (`src/core/events.mjs:225`, `src/runtime/service.mjs:826`). Storing the status
keeps the whitelist aligned with `RunStatus` and avoids an implicit shape mapping.

```js
createForegroundProjectionCache(): {
  nextStamp(viewId): number              // strictly increasing per view
  remember(viewId, status, stamp): void  // snapshot the whitelisted fields
  adopt(viewId, status): boolean         // copy the snapshot when strictly newer
  forget(viewId): boolean
  clear(): void
  size(): number
}
```

- `nextStamp(viewId)` returns `max(Date.now(), lastStamp(viewId) + 1)`. Using it for
  `projectViewState`'s `now` argument makes every foreground `updatedAt` strictly increasing
  per view, so two events in the same millisecond can never tie and an older projection can
  never outrank a newer one inside this process.
- `remember` snapshots this whitelist from the status:
  `semanticState`, `processState`, `summary`, `currentTool`, `question`,
  `pendingQuestions`, `error`, `lastActivityAt`, `latestAssistantPreview`,
  `lastAgentActivityAt`, plus the `stamp`. Nested values (`currentTool`,
  `pendingQuestions`) are cloned **on remember**, so a later mutation of the caller's status
  cannot leak into the cache.
- `adopt(viewId, status)` compares `entry.stamp` with `status.updatedAt ?? 0`. Only a
  strictly newer entry is adopted; it copies the same whitelist (cloning nested values
  again, so `adopt` → caller mutation → second `adopt` is stable) and sets
  `status.updatedAt = entry.stamp`. Returns whether anything changed.
- Nothing else (evidence `review`, `diagnostics`, `autoState`, `lastVisitedAt`, `steering`,
  `followUps`) is touched — those have their own writers and freshness rules.

### 3.2 Wiring in `src/runtime/service.mjs`

| Point | Change |
|---|---|
| `statusFromRow` (`:814`) | add `updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0` (in-memory freshness only; `RunStatus` gains an optional `updatedAt` typedef in `src/core/types.mjs`) |
| `writeForegroundState` (`:854`) | `const stamp = foregroundProjectionCache.nextStamp(row.meta.id)`; pass `stamp` instead of `Date.now()` to `projectViewState`; then `foregroundProjectionCache.remember(row.meta.id, status, stamp)` |
| `syncRowEvent` (`:1540`) | after the preview backfill: `foregroundProjectionCache.adopt(row.meta.id, status)` before `reduceEvent` |
| cache eviction (`:775`, `:2131`) | call `foregroundProjectionCache.forget(viewId)` next to the existing `foregroundPreviewCache.forget(viewId)` |

`row` is loaded from disk at the event entry (`rowForSession` → `loadRow`), before any
`await`, so `row.state` is as fresh as `readState(root, viewId)` at that point.

The preview cache stays as-is: its #113 semantics (gap-fill when the timestamp ties) are
still useful, and folding it into the new cache is a separate refactor (non-goal).

### 3.3 Why not serialize the writes (issue option 2)

A module-level write queue would fix the ordering at the source, but it adds a new failure
mode (one stalled coordinator round trip blocks every later event) and needs its own
backoff/timeout policy. The monotonic rebuild fixes the *read* side, so it also covers
future writers (dashboard patches, reconcile) and any out-of-order arrival that is not a
`sync_foreground` command. Option 2 remains a possible follow-up, not this fix.

### 3.4 Manual verdicts (boundary, no new fence)

Adoption is a pure comparison: adopt only when `entry.stamp > status.updatedAt`. Because
`nextStamp` can run ahead of the wall clock during a sub-millisecond burst, a writer that
stamps with a bare `Date.now()` *can* compare older than the cache — the timestamp does not
order against every writer.

Manual verdicts do not rely on that comparison. Under the coordinator, `mark_completed` /
`mark_holding` writes are materialized without stamping `updatedAt`
(`state-commands.mjs:288-334`), and any later `sync_foreground` from `service` is rejected
with `manual_fence` (`state-commands.mjs:282-285`). In coordinator-disabled mode the direct
writers (`completeViewDirect`, `holdViewDirect`, `archiveStateDirect`, reconcile) *do* stamp
`Date.now()`, but that path already lets a foreground event overwrite the semantic state
through `reduceEvent` today, independent of this cache, so adoption adds no new way to
resurrect a verdict. No extra fence is added; the existing `manual_fence` and the
`agent_end` branch fence remain the protections, and A5 pins the observable behavior.

### 3.5 Data flow after the change

| Event | Behavior |
|---|---|
| start question | `reduceEvent` → `needs_input`; write uses stamp S1 and remembers it |
| end question | rebuild from disk (maybe stale) → adopt if cache is newer → `reduceEvent` clears pending → write uses S2 > S1 |
| subsequent tool event | rebuild carries S2 → adopt is a no-op (equal) → `reduceEvent` keeps `working`; never resurrects `needs_input` |
| dashboard write | disk `updatedAt` is newer than the cache → nothing adopted |
| agent_end | finalize as today |

## 4. Acceptance matrix

| ID | Feature point | Verification | Concrete check | Pass criteria |
|----|---------------|--------------|----------------|---------------|
| A1 | `remember`/`adopt` respect strict freshness | automated (unit) | `test/foreground-projection-cache.test.mjs` | newer stamp adopted (`true`); equal and older stamps not adopted (`false`), status unchanged |
| A2 | Whitelist copy is exact and isolated | automated (unit) | same file | all whitelisted fields copied; non-whitelisted untouched; mutating `status.pendingQuestions[0]` after `adopt` does not change a second `adopt`; mutating the status after `remember` does not change the stored snapshot |
| A3 | `nextStamp` is strictly increasing per view | automated (unit) | same file | two calls in a row return `b > a`, even when `Date.now()` is stubbed to a constant; different view ids do not share the counter |
| A4 | Out-of-order materialization no longer resurrects `needs_input` | automated (integration) | `test/service.test.mjs`, coordinator disabled, `Date.now` pinned to a constant for the whole test so the pre-fix same-millisecond tie is deterministic: question start → capture `state.json` (its `updatedAt` is the start stamp) → question end → `writeState(captured snapshot)` (an older stamp) → `tool_execution_start` for `bash` | persisted state is `working`, `pendingQuestions` empty, `needsInput` false. Pre-fix this asserts `needs_input` (the disk rebuild wins the tie), post-fix the monotonic stamp adopts the newer cached status |
| A5 | A manual verdict survives a foreground event | automated (integration) | `test/service.test.mjs`: seed the projection cache with an accepted-but-unmaterialized beat, write `completed` + `autoState: null` with an older `updatedAt`, then a `tool_execution_start` that adopts the cached snapshot | persisted state stays `completed` (coordinator answers `manual_fence`). Pins the fence, not adoption isolation — adoption has no independent observable there |
| A6 | `forget` drops the entry and is wired into archive | automated (unit + integration) | cache test: `remember` → `forget` → `adopt` false; `test/service.test.mjs`: `archiveByState` on a remembered view | `adopt` returns `false` after `forget`; after archiving, `foregroundProjectionCache.size()` no longer counts that view |
| A7 | Existing foreground behavior unchanged | automated (unit/integration) | `npm test` (existing `syncForegroundEvent` and preview-cache tests) | all pass |
| A8 | Repo static gate | automated (static) | `npm run typecheck` | exit 0 (`checkJs:false`, so this is a repo regression gate, not proof of the `.mjs` change) |
| U1 | Live: answering a question returns the row to RUNNING before the turn ends | user test | see §5 | row leaves **Needs answer** within ~1s of the answer and stays RUNNING until the turn ends |

Full gate: `npm run verify` (typecheck + perf + tests + coverage thresholds + pack dry-run).

Failure branches: A1/A2 assert the negative side (equal/older stamps are not adopted, nested
values cannot leak), A5 asserts the manual-verdict boundary, A6 asserts cache eviction. No
new error path is introduced.

## 5. User test (U1)

Executable after merge, on this machine (the board clone at
`~/.pi/agent/git/github.com/zhuxixi/pi-agent-board` is updated to the merged commit and Pi
restarted):

1. In a session, trigger a question (`ask_user_question` or `question`).
2. Watch the row enter **Needs answer**; answer it in the dashboard/attach.
3. Keep watching for the rest of the turn.

Expected: the row returns to **RUNNING** within about a second of the answer — not at
`agent_end`. Repeat with a nested call (question asked from inside `codemode`) to exercise
the wider window.

If the environment cannot be updated at completion time, U1 is reported as `pending`.

## 6. Non-goals

- No change to `reduceEvent`, `deriveSummary`, or the question-tool detection (#221 is done).
- No serialization of `sync_foreground` writes (issue option 2) and no coordinator changes.
- No removal or rewrite of `foreground-preview-cache.mjs` (#113 behavior preserved).
- No changes to manual verdicts, auto-state classification, or evidence/diagnostics writes.

## 7. Risks and boundaries

- **Clock ties**: prevented inside this process by `nextStamp` (strictly increasing per
  view). Ties are still possible with a *different* writer (another Pi process) whose
  `Date.now()` equals ours; then neither side is "strictly newer" and the disk value wins,
  which is the pre-existing behavior. Cross-process ordering is not guaranteed.
- **Cross-process writers**: another Pi process mirroring the same view writes its own
  `updatedAt`; this cache only protects against out-of-order writes from *this* process.
  Outside the supported single-host model; documented, not fixed.
- **In-process writers with a bare `Date.now()`**: the auto-state classifier
  (`applyAutoStateToViewState`, `src/core/auto-state.mjs:254`) stamps a wall-clock
  `updatedAt`, which can compare older than a cache stamp that ran ahead within the same
  millisecond. A late foreground tool event would then adopt the pre-classification
  snapshot — but such an event already clobbers the classification through `reduceEvent`
  today (it sets `working` and `alive`), so this is not a new resurrection path.
- **Manual verdicts**: protected by the coordinator's `manual_fence` and the `agent_end`
  branch fence, not by timestamps. Coordinator materialization does not stamp `updatedAt`
  for verdict writes; coordinator-disabled direct writers do stamp `Date.now()`, which can
  compare older than a cache stamp that ran ahead of the clock — that path is not ordered by
  this cache (see §3.4, A5).
- **Memory**: one small object per view, evicted with the existing `forget` sites.

## 8. Testability split

| Unit | Purity | Test seam |
|---|---|---|
| `createForegroundProjectionCache()` (`nextStamp` / `remember` / `adopt` / `forget`) | pure (Map in/out, tested with a stubbed clock) | direct unit tests (`test/foreground-projection-cache.test.mjs`) |
| `statusFromRow` `updatedAt` passthrough | pure | exercised through `syncForegroundEvent` (A4) |
| adoption in `syncRowEvent` | side-effect-free call + thin I/O shell | `syncForegroundEvent` with coordinator disabled (A4), deterministic `writeState` between events; A5 uses the tracked coordinator |
| stamp assignment in `writeForegroundState` | pure call inside the existing shell | A4 (the repro fails without monotonic stamps: the stale snapshot would tie) |
| write-side `remember` | pure call inside the existing shell | A4 (the repro fails without it) |

Test boundary: new pure module tests + additions to `test/service.test.mjs`; no new exports
from the service.

## 9. Deliverables

- `src/core/foreground-projection-cache.mjs` — new pure module.
- `src/runtime/service.mjs` — `statusFromRow` `updatedAt`; `nextStamp` + `remember` in
  `writeForegroundState`; `adopt` in `syncRowEvent`; `forget` at the eviction sites.
- `src/core/types.mjs` — optional `updatedAt` on the `RunStatus` typedef (in-memory
  freshness field).
- `test/foreground-projection-cache.test.mjs` — new unit tests (A1–A3, A6).
- `test/service.test.mjs` — A4/A5 integration tests.
- `docs/superpowers/specs/2026-10-22-issue-225-monotonic-foreground-state-design.md` — this
  design, committed with the fix.
