# Issue #278 — Ctrl+G external editor invisible in modern attach: root cause and design

Drafted: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-05T22:01:37+08:00
Revised: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-05T22:25:23+08:00
Revised: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-05T23:23:04+08:00
Revised: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-05T23:27:52+08:00

- Issue: https://github.com/zhuxixi/pi-agent-board/issues/278
- Target base: `origin/main` `4bb836e9c9bb25c653bb6160e0d45a26e9348078` (approved design reviewed at `c71add85130d760684135c07d9ad2178d548a924`; intervening attach change is a one-line Kitty projection optimization with no contract impact)
- Research: `research/01-projection-history.md`, `research/02-reproduction-transition.md`

## 1. Conclusion

The defect is a projection-ownership gap. Modern protocol attach always renders the last immutable `committedView`, but Nvim owns the child terminal without emitting Pi's synchronized-output frame boundaries. The xterm buffer and input path are healthy; the visible projection and all committed-view interaction consumers remain attached to the old Pi frame.

The fix is a scoped external/live projection interval backed by an explicit terminal-ownership transition, plus a runner-owned boolean snapshot fact so a client that attaches while Nvim is already running can enter the same interval. Normal Pi rendering remains committed and fail-closed.

## 2. Evidence and root cause

### 2.1 Code path

- `src/ui/pty-attach.ts` `installParserObservers()` observes `CSI ?2026h/l`; only a real close calls `commitCommittedView()`.
- `modernCommittedMode()` is true for protocol attach with frame witness.
- `project()` selects `projectCommitted()` whenever that mode is true. Ordinary output schedules another render after parsing, but the render reads the same old immutable view.
- `interactionLine()`, `interactionNullCell()`, `mousePointForEvent()`, and `tryScrollBy()` independently select the committed view using the same mode. Changing only `render()` would leave mouse hit-testing, selection/copy, and scrolling on stale Pi coordinates.

### 2.2 Reproduction

A component reproduction (`research/component-result.json`) and a real managed Pi 1.5.0 + real runner/PTY + real Nvim reproduction (`research/real-nvim-result.json`) both produce:

```json
{
  "modern": true,
  "liveProbeVisible": true,
  "renderedProbeVisible": false,
  "parserSyncOpen": false
}
```

The real driver sends Ctrl+G through `PtyAttachComponent.handleInput()`, types `NVIM_VISIBLE_PROBE_1` into Nvim, and exits with `:q!`. After exit, the actual attach render shows Pi again and omits the Nvim probe.

### 2.3 Historical constraint

PR #261 introduced committed views to prevent partial Pi frames; #263 rolled them back; #265 restored them with idle downgrade. The #222 design intentionally makes synchronized close boundaries the normal modern publish mechanism. This issue must not weaken that mechanism globally.

## 3. Observed ownership protocol

The retained real screen log (`research/real-nvim-screen.log`) shows:

| Phase | Relevant order |
|---|---|
| Pi initial startup | Unframed `?1049h` before any Pi committed frame |
| Pi stops for Ctrl+G | `?2026h … ?1049l … ?2026l` |
| Nvim owns terminal | Unframed `?1049h`, one `?2026$p`, ordinary non-synchronized drawing |
| Nvim exits | Unframed `?1049l` |
| Pi restarts | Unframed `?1049h`, then `?2026h … ?2026l` |

Therefore alternate-screen state alone is not an ownership signal. A synchronized Pi `?1049l` is the entry signal; the next synchronized-output open is the return boundary. Nvim's own unframed `?1049h/l` and `?2026$p` do not change ownership.

## 4. Design decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | Add a pure screen-owner reducer shared by runner terminal model and attach component. | One tested definition prevents runner/UI transition drift. |
| D2 | Enter external/live only on `?1049l` observed while synchronized output is open; leave on the next `?2026h`. | Matches real Pi/Nvim order and does not misclassify Pi's startup alternate screen. |
| D3 | Runner retains the boolean for its whole child lifetime and includes it as optional `externalOutputActive` in `snapshot_begin`; client forwards it to `snapshotBegin`. | Supports attach/resnapshot while the editor is already open without process-name heuristics. |
| D4 | Add one component predicate for visible committed projection: modern mode AND (NOT external/live OR hydrating). Use it at every visible/interaction fork. | Rendering and interaction must address the same surface; hydration must retain committed/blank protection rather than exposing a partial live snapshot. |
| D5 | Keep `commitCommittedView()`, readiness, proof, recovery, and identity mechanisms in modern mode; only visible projection ownership changes. | A synchronized Pi stop can still commit a complete view; Pi restore must not publish its open/partial frame. |
| D6 | On external/live entry and exit, clear selection, pending click, auto-scroll, and stale viewport coordinates; follow the live bottom. | Old Pi/Nvim buffer offsets are not valid across screen ownership changes. |
| D7 | Preserve external/live across same-generation resize and parser replacement, but suspend it while hydration is in progress. Adopt the runner boolean at each new snapshot; reset on new generation, epoch reset, close/dispose, or legacy fallback. | Resize must not make Nvim invisible again; reconnect must not show a partial or stale surface. |
| D8 | Keep all input forwarding unchanged. | The defect is not in the input path. |
| D9 | Cover but do not alter Kitty APC proof classification in this issue. | Real evidence shows committed render restores before a new F; the APC proof gap is independent. |

## 5. Component and protocol contracts

### 5.1 Pure reducer and thin xterm adapters

Add a core module (working name `src/core/attach-screen-owner.mjs`) with a pure transition function over:

```ts
interface AttachScreenOwnerState {
	syncOpen: boolean;
	externalOutputActive: boolean;
}
```

Accepted events are `sync-open`, `sync-close`, `alternate-screen-exit`, `adopt-external`, and `reset`. The transition table is:

| Event | Guard | Next state |
|---|---|---|
| `sync-open` (`?2026h`) | none | `syncOpen=true`, `externalOutputActive=false` |
| `sync-close` (`?2026l`) | none | `syncOpen=false`; preserve external flag |
| `alternate-screen-exit` (`?1049l`) | `syncOpen === true` | set `externalOutputActive=true` |
| `alternate-screen-exit` | `syncOpen === false` | preserve state |
| `adopt-external` | snapshot boolean is present | replace only external flag with that boolean |
| `reset` | new generation/epoch/close/legacy | initial false/false state |

Unrelated CSI, `?1049h`, and `?2026$p` produce no transition. Parameter handling must recognize combined xterm parameter forms exactly as the current `?2026` observer does. For a combined CSI, the adapter evaluates the `alternate-screen-exit` guard against `syncOpen` **at the start of that CSI**, then applies the synchronized close/open transition; thus both `CSI ?2026;1049l` and `CSI ?1049;2026l` entered from an open block finish with `syncOpen=false` and `externalOutputActive=true`. A1 must pin both parameter orders and the corresponding unsynchronized non-entry case. The pure module has no terminal, socket, filesystem, timer, or UI dependency.

A thin adapter registers `? h/l` xterm handlers, returns `false` to preserve default parsing, and reports transitions to its caller. UI adapters retain existing closed/term/epoch fences and observer disposal. The runner adapter owns no timers or I/O beyond updating terminal-model state.

### 5.2 Runner and wire compatibility

`createTerminalModel()` installs the adapter on its real xterm parser and exposes the current boolean as model state. Both legacy and owned runners already share this model, so no duplicated child-output state machine is added.

`createTerminalSubscription()` copies the model boolean into non-empty and empty `snapshot_begin` messages as `externalOutputActive`. The value is sampled with the snapshot metadata after parser idle. Catch-up output remains authoritative for any transition after that sample.

`terminal-attach-client` validates the field as an optional boolean and includes it in `snapshotBegin`. A present non-boolean value (for example `"yes"` or `1`) is a protocol error: emit `protocolError`, omit the field from `snapshotBegin`, and leave the existing recovery state machine unchanged; never silently treat the value as absent or true. A2 must pin this failure branch in `test/terminal-attach-client.test.mjs`. The client does not invent `true` when the field is absent. For an older runner with no field, a same-generation component preserves its locally observed state; a fresh component starts false. This is the compatibility boundary, not a claim that an old runner can identify an already-open editor retrospectively.

No token, process name, command line, editor content, or host credential enters this field.

### 5.3 Component projection and lifecycle

Add a single internal predicate (working name `usesCommittedProjection()`):

```text
modernCommittedMode()
&& (!externalOutputActive || localHydrationState === "hydrating")
```

Use this predicate in:

- `project()`;
- `interactionLine()`;
- `interactionNullCell()`;
- `mousePointForEvent()`;
- `tryScrollBy()`.

`render()` retains its existing attaching/loading and empty-baseline guards. External/live output uses the existing live projection, including cursor, Kitty-image projection, viewport clamping, and the existing 40 ms output scheduler. No extra per-chunk committed snapshot is introduced.

On entry/exit, interaction-state cleanup is a side effect outside the pure reducer. It clears the selection and pending mouse gesture, stops selection auto-scroll, clears pending click/double-click state, and sets `viewportTop=null`. It does not send input or request an unscheduled parser read.

At Pi restore, `?2026h` immediately returns visible rendering to the last valid committed view (or the existing blank/loading guard if none); live Pi redraw bytes are not exposed. Only `?2026l` commits and displays the restored Pi grid. The existing identity and geometry checks remain in force.

## 6. Restore-phase Kitty APC boundary

The real run observed Kitty image-deletion APC in Pi's first restored full redraw. That redraw did not increment `frameWitness.proofs`; a subsequent ordinary input incremented it from 1 to 2 and produced a new F at the new renderer epoch.

This issue's tests must therefore prove:

1. A restore synchronized frame containing `ESC _G … ESC \` still commits the actual restored Pi render.
2. No Nvim probe survives in that render.
3. A subsequent ordinary Pi input can still produce a later F proof.

The APC scanner/classifier itself remains unchanged. A separate issue can address proof coverage if desired.

## 7. Non-goals and guarantee boundaries

- Do not project every unframed write globally and do not remove Pi's complete-frame gate.
- Do not change Ctrl+G, editor configuration, key forwarding, mouse forwarding, or runner input protocol.
- Do not change legacy attach rendering except for the additive, inert model observation shared with protocol attach.
- Do not classify external applications that emit their own `?2026` synchronized frames; this contract targets the observed non-synchronized external-editor interval.
- Do not fix the independent Kitty APC proof-classification gap.
- The oracle is the actual `PtyAttachComponent.render()` plus interaction buffer addressing, as requested by the issue; it is not a physical-pixel screenshot claim.
- An old runner lacking the snapshot boolean cannot provide retrospective ownership to a fresh new client. Matching new runner/new client and locally observed transitions are the supported paths.

## 8. Testability decomposition (implementation constraint)

1. **Pure reducer:** exhaustive table tests for entry, non-entry, exit, adoption, reset, combined parameters, and unrelated controls. No xterm needed for the decision table; one real-xterm adapter test proves callback ordering and `return false` behavior.
2. **Terminal-model adapter:** feed real xterm output through `feedOutput()` and await `whenIdle()`; assert the persisted boolean at Pi start, Pi stop, Nvim output, Nvim exit, and Pi sync open. This is independently testable without sockets.
3. **Snapshot protocol:** drive `createTerminalSubscription()` with a terminal model and injected `send`; assert the optional boolean on empty/non-empty begins and catch-up ordering. Client tests drive `snapshot_begin` and assert `snapshotBegin` forwarding plus absent-field behavior.
4. **Component adapter and projection:** a dedicated transform-types scenario constructs the real `PtyAttachComponent`, drives real parser output through its attach events, waits for parser callbacks, and inspects actual `render()`. Input is spied at the existing socket/send seam; no input rewrite is needed.
5. **Interaction boundary:** in the same scenario, set non-default viewport/selection before entry; assert they are cleared, live interaction lines contain the Nvim probe, and restored Pi no longer uses Nvim coordinates. Test the open restore frame before its close to prove no partial Pi content is projected.
6. **Real E2E:** an opt-in `.mjs` test spawns a transform-types driver, following `attach-frame-witness.real.test.mjs` cleanup/isolation patterns. The driver discovers Pi with the existing `command -v pi` mechanism and discovers Nvim with `command -v nvim`, then uses real managed Pi, real runner/PTY, real component, and real `nvim -u NONE -i NONE`; it makes no model request and uses isolated roots and `PI_CODING_AGENT_DIR`. If either executable is missing, the real case reports a skip and A5 remains `pending` in the final report. The driver derives the repository root from its own `test-support/` location (or an explicit worktree root supplied by the test), and must not hard-code the main checkout path used by the research script.

Implementation must preserve these boundaries; parser observation, transition decisions, UI side effects, and wire transport must not be recoupled into an untestable monolithic handler.

## 9. Acceptance matrix

| ID | Feature / contract | Method | Concrete verification | Pass standard |
|---|---|---|---|---|
| A1 | Ownership reducer and parser transitions | Automated (unit) | `node --test test/attach-screen-owner.test.mjs` | All table cases pass: Pi startup alt entry does not activate; synced Pi alt exit activates; Nvim controls do not exit; next sync open exits; split/combined CSI and adapter disposal behave correctly. |
| A2 | Runner persistence + snapshot/client compatibility | Automated (unit + integration) | `node --test test/terminal-model.test.mjs test/terminal-attach-protocol.test.mjs test/terminal-attach-client.test.mjs` | Model retains correct boolean; empty/non-empty snapshots carry it; catch-up order remains intact; client forwards booleans, rejects present non-boolean values through `protocolError`, and preserves absent-field compatibility; existing protocol assertions pass. |
| A3 | Actual Nvim live render, input, and shared interaction projection | Automated (component + integration) | `node --test test/pty-attach-external-editor.test.mjs` | Before fix this scenario is RED. After fix actual `render()` contains `NVIM_VISIBLE_PROBE_1`; forwarded input is unchanged; live interaction reads the probe; normal Pi before/after uses committed view; no stale selection/viewport remains. |
| A4 | Restore, hydration, resize, generation, legacy, and disposal fences | Automated (component + integration + static) | Same component test plus `node --test test/pty-attach-parser-replacement.test.mjs test/pty-attach-ready.test.mjs` and `npm run typecheck` | Open Pi restore is never shown as a live partial frame; close restores Pi; same-generation resize/replacement preserve live after hydration; new generation/reset/fallback/close cannot leak stale state; existing suites and typecheck pass. |
| A5 | Full real Ctrl+G/Nvim round trip, reattach, Kitty restore observation, later proof | Automated E2E (opt-in real toolchain) | `PI278_REAL_NVIM=1 node --test test/attach-external-editor.real.test.mjs` | Real Pi + PTY + Nvim discovered through `command -v`: Pi prefill marker renders before Ctrl+G; Nvim unique probe appears in actual attach render; a fresh attach during Nvim also renders subsequent edits; `:q!` restores the original Pi marker at correct 80x22 body geometry and removes the Nvim probe; restore APC is recorded/covered; a later ordinary input produces a later F; cleanup leaves no runner/child. Missing executables produce skip plus A5 `pending`, never a false pass. |
| A6 | Repository-wide non-regression and ship gates | Automated (static + perf + full tests + coverage + build/package) | `npm run verify` | Typecheck, perf gate, all tests, coverage thresholds, and dry-run package pass in the issue worktree. Real E2E evidence is reported separately and is not replaced by the default suite. |

No acceptance item is classified as manual-only: the requested observable is programmatically inspectable component output. The opt-in real E2E must actually be executed on the development machine before merge; if it cannot run, A5 remains `pending` and the final report must say so.

## 10. Implementation scope

Expected production surfaces are the new pure owner module, `src/core/terminal-model.mjs`, `src/core/terminal-attach-protocol.mjs`, `src/core/terminal-attach-client.mjs`, and `src/ui/pty-attach.ts`. Tests and transform-types drivers are added under `test/` and `test-support/`. No dashboard layout, release tooling, or unrelated plans are in scope.

The implementation plan must map every task to at least one of A1–A6 and preserve the test boundaries above. RED evidence for A3 and the real A5 round trip is collected before the production fix; then the single ownership/projection change is implemented and verified without bundling unrelated fixes.
