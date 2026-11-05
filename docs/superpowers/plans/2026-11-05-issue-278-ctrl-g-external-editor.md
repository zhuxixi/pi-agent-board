# Ctrl+G External Editor Live Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make non-synchronized external-editor output visible and interactive in modern attach, including reattach during Nvim, while preserving Pi's committed-frame restore guarantees.

**Architecture:** A pure screen-owner reducer and thin xterm adapter define the Pi/external transition. The runner terminal model persists the boolean and snapshots it to late attaching clients; the component switches all visible and interaction consumers between committed and live projections through one predicate. Tests precede each production change, including a real Pi + PTY + Nvim RED run before the component fix.

**Tech Stack:** Node 22+, TypeScript, JavaScript ESM modules, `node:test`, `@xterm/headless`, `node-pty`, managed Pi 1.5.0, Nvim.

**Spec:** `docs/superpowers/specs/2026-11-05-issue-278-ctrl-g-external-editor-design.md`

## Global Constraints

- Work only in the issue worktree; do not edit or stage the main checkout. Use tabs and English comments; stage files by name, never `git add -A`.
- The wire field is exactly `externalOutputActive: boolean`. A present non-boolean value emits `protocolError` with code `external_output_active_invalid`, is omitted from `snapshotBegin`, and does not add a new resync path.
- The component predicate is exactly `modernCommittedMode() && (!externalOutputActive || localHydrationState === "hydrating")`. Hydrating therefore retains committed/blank protection.
- Enter external output only when `?1049l` is observed with `syncOpen=true`; exit on `?2026h`. `?1049h`, unsynchronized `?1049l`, and `?2026$p` do not independently change ownership.
- For combined close CSI such as `?2026;1049l` and `?1049;2026l`, evaluate the entry guard using `syncOpen` at the start of the CSI, then close sync.
- Do not change input forwarding, frame-proof/APC classification, or legacy projection behavior. Do not hard-code the main checkout or executable paths in committed test drivers.
- Acceptance ownership: Task 1 → A1; Task 2 → A2; Task 3 → RED evidence for A3/A4/A5; Task 4 → GREEN A3/A4/A5 and full A6. Every implementation change must retain these test boundaries.

## Review Focus

- Combined parameter order: both `?2026;1049l` and `?1049;2026l` must enter external output from an open block; Task 1 Step 1 pins both.
- Malformed wire input: `"yes"`, `1`, and `null` must not become ownership facts; Task 2 Step 1 pins `protocolError` and omission.
- Late attach while Nvim is active: a second real component must render a second unique edit; Task 3 Step 3 pins this before the UI fix.
- Partial hydration and Pi restore: no live partial snapshot or open Pi restore frame may leak; Task 3 Step 1 pins both states.
- Stale interaction geometry: pre-existing selection, pending click, auto-scroll, and viewport coordinates must clear on ownership change; same-generation resize must not disable live mode; Task 3 Step 1 pins both.

---

### Task 1: Pure screen-owner reducer and xterm adapter

**Files:**
- Create: `src/core/attach-screen-owner.mjs`
- Test: `test/attach-screen-owner.test.mjs`

**Interfaces:**
- Consumes: xterm `term.parser.registerCsiHandler({ prefix: "?", final }, handler)` and disposable observer handles.
- Produces: `createAttachScreenOwnerState(externalOutputActive?)`, `transitionAttachScreenOwner(state, event)`, and `installAttachScreenOwnerObservers(term, { initialState, onTransition })`. The adapter callback receives `{ previous, current, event, syncOpenMarker, syncCloseMarker }`; it returns an array of disposable observers. Task 2 and Task 4 use these exact names.

- [ ] **Step 1: Write the failing reducer and adapter tests**

Create tests that import the three functions and assert this table with `node:test` and `assert/strict`:

```js
const initial = createAttachScreenOwnerState();
assert.deepEqual(initial, { syncOpen: false, externalOutputActive: false });
assert.equal(transitionAttachScreenOwner(initial, {
  type: "csi", final: "h", params: [1049],
}), initial); // Pi startup alt entry is not external ownership.
const stopped = transitionAttachScreenOwner(
  transitionAttachScreenOwner(initial, { type: "csi", final: "h", params: [2026] }),
  { type: "csi", final: "l", params: [1049] },
);
assert.deepEqual(stopped, { syncOpen: true, externalOutputActive: true });
const closed = transitionAttachScreenOwner(stopped, { type: "csi", final: "l", params: [2026] });
assert.deepEqual(closed, { syncOpen: false, externalOutputActive: true });
assert.deepEqual(transitionAttachScreenOwner(closed, { type: "csi", final: "h", params: [2026] }), {
  syncOpen: true, externalOutputActive: false,
});
```

Add separate cases for unsynchronized `1049l` non-entry, `1049h`/`2026$p` no-op, adoption of explicit true/false, reset, and both combined forms:

```js
for (const params of [[2026, 1049], [1049, 2026], [[2026, 1049]]]) {
  const open = { syncOpen: true, externalOutputActive: false };
  assert.deepEqual(transitionAttachScreenOwner(open, { type: "csi", final: "l", params }), {
    syncOpen: false, externalOutputActive: true,
  });
}
```

Use a real `Terminal` to prove the adapter returns `false` through normal parsing, emits marker facts, and disposed observers receive no later transitions.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/attach-screen-owner.test.mjs`
Expected: FAIL because `src/core/attach-screen-owner.mjs` does not exist. Do not implement before observing this failure.

- [ ] **Step 3: Implement the minimal pure reducer and thin adapter**

Implement the module with this behavior and no I/O beyond xterm handler registration:

```js
function hasParam(params, wanted) {
  return params.some((value) => value === wanted || (Array.isArray(value) && value.includes(wanted)));
}

export function createAttachScreenOwnerState(externalOutputActive = false) {
  return { syncOpen: false, externalOutputActive };
}

export function transitionAttachScreenOwner(state, event) {
  if (event.type === "reset") return createAttachScreenOwnerState();
  if (event.type === "adopt") return { ...state, externalOutputActive: event.active };
  if (event.type !== "csi") return state;
  const has2026 = hasParam(event.params, 2026);
  const has1049 = hasParam(event.params, 1049);
  if (event.final === "h" && has2026) return { syncOpen: true, externalOutputActive: false };
  if (event.final === "l") {
    return {
      syncOpen: has2026 ? false : state.syncOpen,
      externalOutputActive: has1049 && state.syncOpen ? true : state.externalOutputActive,
    };
  }
  return state;
}

export function installAttachScreenOwnerObservers(term, { initialState = createAttachScreenOwnerState(), onTransition = () => {} } = {}) {
  if (!term?.parser || typeof term.parser.registerCsiHandler !== "function") return [];
  let state = initialState;
  const observers = [];
  try {
    for (const final of ["h", "l"]) {
      observers.push(term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        const previous = state;
        const event = { type: "csi", final, params };
        const current = transitionAttachScreenOwner(state, event);
        state = current;
        onTransition({
          previous, current, event,
          syncOpenMarker: final === "h" && hasParam(params, 2026),
          syncCloseMarker: final === "l" && hasParam(params, 2026),
        });
        return false;
      }));
    }
    return observers;
  } catch (error) {
    for (const observer of observers) observer.dispose();
    throw error;
  }
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/attach-screen-owner.test.mjs`
Expected: PASS, including combined order, invalid/no-op controls, real parser callback order, and disposal.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/core/attach-screen-owner.mjs test/attach-screen-owner.test.mjs
git commit -m "feat: add attach screen ownership transitions (#278)"
```

### Task 2: Persist and transport external ownership

**Files:**
- Modify: `src/core/terminal-model.mjs`
- Modify: `src/core/terminal-attach-protocol.mjs`
- Modify: `src/core/terminal-attach-client.mjs`
- Test: `test/terminal-model.test.mjs`
- Test: `test/terminal-attach-protocol.test.mjs`
- Test: `test/terminal-attach-client.test.mjs`

**Interfaces:**
- Consumes: Task 1 `installAttachScreenOwnerObservers()` and its `current.externalOutputActive` callback field.
- Produces: terminal model boolean `externalOutputActive`; optional snapshot-begin wire boolean; `snapshotBegin` payload boolean. Task 3's real reattach and Task 4's UI adoption depend on these names.

- [ ] **Step 1: Add failing model, wire, and client tests**

Add a real-xterm model test:

```js
const model = createTerminalModel({ cols: 80, rows: 22 });
feedOutput(model, "\x1b[?1049h\x1b[?2026hPI\x1b[?2026l");
await whenIdle(model);
assert.equal(model.externalOutputActive, false);
feedOutput(model, "\x1b[?2026h\x1b[?1049l\x1b[?2026l\x1b[?1049hNVIM");
await whenIdle(model);
assert.equal(model.externalOutputActive, true);
feedOutput(model, "\x1b[?1049l\x1b[?1049h\x1b[?2026hPI_RESTORE");
await whenIdle(model);
assert.equal(model.externalOutputActive, false);
```

Add empty and non-empty subscription cases that capture sent messages and assert `snapshot_begin.externalOutputActive` is the model boolean. Add client cases for true, false, absent, and invalid values:

```js
assert.equal(events.find((event) => event.event === "snapshotBegin").payload.externalOutputActive, true);
// Present "yes", 1, or null:
assert.ok(events.some((event) => event.event === "protocolError" && event.payload.code === "external_output_active_invalid"));
assert.equal(Object.hasOwn(events.find((event) => event.event === "snapshotBegin").payload, "externalOutputActive"), false);
```

Keep existing sequence, frame, view-proof, and recovery assertions unchanged.

- [ ] **Step 2: Run the three suites and verify RED**

Run: `node --test test/terminal-model.test.mjs test/terminal-attach-protocol.test.mjs test/terminal-attach-client.test.mjs`
Expected: FAIL on missing model state, missing wire field, or missing client forwarding/validation; record the exact first failure.

- [ ] **Step 3: Implement model observation and additive wire transport**

In `createTerminalModel()`, construct the model first with `externalOutputActive:false`, then install Task 1's adapter on the real parser and update the model in `onTransition`. Keep fake parsers without `registerCsiHandler` supported through the adapter's empty-array path.

In both empty and non-empty `startSnapshot()` paths, add:

```js
begin.externalOutputActive = model.externalOutputActive === true;
```

In `beginCollecting()`, validate before emitting:

```js
const external = msg.externalOutputActive;
const externalValid = external === undefined || typeof external === "boolean";
if (!externalValid) emit("protocolError", {
  code: "external_output_active_invalid",
  message: "snapshot_begin.externalOutputActive",
});
```

Include `externalOutputActive` in `snapshotBegin` only when `typeof external === "boolean"`; do not resync or coerce invalid values.

- [ ] **Step 4: Run focused and existing protocol tests**

Run: `node --test test/attach-screen-owner.test.mjs test/terminal-model.test.mjs test/terminal-attach-protocol.test.mjs test/terminal-attach-client.test.mjs test/terminal-snapshot.integration.test.mjs`
Expected: PASS with no duplicate/gap output and unchanged legacy recovery.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/core/terminal-model.mjs src/core/terminal-attach-protocol.mjs src/core/terminal-attach-client.mjs test/terminal-model.test.mjs test/terminal-attach-protocol.test.mjs test/terminal-attach-client.test.mjs
git commit -m "feat: carry external output ownership in attach snapshots (#278)"
```

### Task 3: Add component and real-Nvim regression tests before the UI fix

**Files:**
- Create: `test-support/pty-attach-external-editor-scenario.ts`
- Create: `test/pty-attach-external-editor.test.mjs`
- Create: `test-support/attach-external-editor-real.ts`
- Create: `test/attach-external-editor.real.test.mjs`

**Interfaces:**
- Consumes: Task 2 snapshot boolean; real `PtyAttachComponent.handleInput()`, `handleAttachEvent()`, `render()`, and the existing transform-types child-process test pattern.
- Produces: executable RED evidence for Task 4. No production file is changed in this task.

- [ ] **Step 1: Build the component scenario and failing wrapper**

Use an isolated `/no/such/socket` component harness like `pty-attach-parser-replacement-scenario.ts`. Hydrate an 80x22 synchronized Pi frame containing `PI_BEFORE_NVIM`, enter modern mode with `attaching=false`, then drive:

```js
const PI_STOP = "\x1b[?2026h\x1b[?1049l\x1b[?2026l";
const NVIM_START = "\x1b[?1049h\x1b[?2026$p\x1b[2J\x1b[HNVIM_VISIBLE_PROBE_1";
const NVIM_QUIT = "\x1b[?1049l";
const PI_RESTORE_OPEN = "\x1b[?1049h\x1b[?2026hPI_PARTIAL_MUST_NOT_SHOW";
const PI_RESTORE_CLOSE = "\x1b_Ga=d,d=A,q=2\x1b\\PI_RESTORED\x1b[?2026l";
```

Before Pi stop, seed non-null viewport/selection and pending-click state. After Nvim starts, assert all of these in the scenario (the current code must fail the render assertion):

```js
assert.ok(bufferText().includes("NVIM_VISIBLE_PROBE_1"));
assert.ok(component.render(80).join("\n").includes("NVIM_VISIBLE_PROBE_1"));
assert.equal(internals.externalOutputActive, true);
assert.equal(internals.viewportTop, null);
assert.equal(internals.selection, null);
assert.ok(internals.interactionLine(probeLine).translateToString(true).includes("NVIM_VISIBLE_PROBE_1"));
```

Spy the existing socket write seam around `handleInput("\x07")` and `handleInput("iNVIM_VISIBLE_PROBE_1")`; assert decoded input messages contain exactly those bytes. After restore-open but before close, assert render omits `PI_PARTIAL_MUST_NOT_SHOW`; after close, assert it contains `PI_RESTORED`, omits both Nvim/partial markers, and retains 80x22 geometry. Add same-generation parser replacement, hydration, resize, new-generation/epoch reset, legacy fallback, and disposal checks using the actual existing events and fields.

The `.mjs` wrapper runs the scenario with `node --experimental-transform-types`, parses its final JSON line, writes failure output to a fresh temp artifact, and exits nonzero when `ok=false`.

- [ ] **Step 2: Run the component regression and record expected RED**

Run: `node --test test/pty-attach-external-editor.test.mjs`
Expected: FAIL specifically because the actual render omits `NVIM_VISIBLE_PROBE_1` while the underlying buffer contains it. If it errors for a harness reason, fix only the harness and rerun until the assertion is the failure.

- [ ] **Step 3: Build the opt-in real Pi/Nvim round-trip driver and wrapper**

The `.mjs` wrapper registers a test only when `PI278_REAL_NVIM=1`; inside that lane it discovers executables with `command -v pi` and `command -v nvim`, skips with an explicit reason if either is unavailable, and spawns the driver using `--experimental-transform-types`. The driver derives `REPO_ROOT` from `fileURLToPath(new URL("../", import.meta.url))` and never names the main checkout.

The driver follows `attach-frame-witness.real.test.mjs`: isolated root and `PI_CODING_AGENT_DIR`, owned real runner, `node-pty`, no model request, `--offline`, production `index.ts`, bounded cleanup, and optional fresh `PI278_ARTIFACT_DIR`. Write isolated `settings.json` with `externalEditor` set to the discovered Nvim path plus `-u NONE -i NONE`; set `NVIM_NOTTYFAST=1` in the child environment.

Drive this sequence through real components:

```text
attach and settle → type PI_RESTORE_PROBE → Ctrl+G → wait for Nvim ?2026$p
→ ggiNVIM_VISIBLE_PROBE_1 → assert actual render contains the probe
→ dispose and attach a fresh component → type NVIM_REATTACH_PROBE_2
→ assert the second render contains both probes
→ Escape, :q! → assert PI_RESTORE_PROBE restored and both Nvim probes absent
→ assert 80x22 body/committed identity and record the restore Kitty APC
→ type x → require a later F proof
→ Ctrl+U, Ctrl+D → require natural child and runner exit with no forced kill
```

Capture actual render, underlying buffer, host frameWitness, and cleanup evidence. Failure must still reap the owned child/runner and retain the error before exiting nonzero.

- [ ] **Step 4: Run the real regression and record expected RED**

Run: `PI278_REAL_NVIM=1 PI278_ARTIFACT_DIR=/tmp/pi278-real-red node --test test/attach-external-editor.real.test.mjs`
Expected: FAIL because the first actual Nvim render never contains `NVIM_VISIBLE_PROBE_1`; the artifact must show live buffer=true and render=false, with cleanup complete. Remove only a pre-existing artifact directory owned by this test before a deliberate rerun, or choose a fresh path.

- [ ] **Step 5: Commit the RED regression harnesses**

```bash
git add test-support/pty-attach-external-editor-scenario.ts test/pty-attach-external-editor.test.mjs test-support/attach-external-editor-real.ts test/attach-external-editor.real.test.mjs
git commit -m "test: reproduce external editor attach invisibility (#278)"
```

The intermediate branch is intentionally RED at A3/A5; Task 4 owns the fix. Do not weaken assertions to make this task green.

### Task 4: Switch component projection and complete acceptance

**Files:**
- Modify: `src/ui/pty-attach.ts`
- Modify only if harness defects are demonstrated: Task 3 test drivers (without weakening behavior assertions)
- Test: all Task 1–3 tests plus the repository suite

**Interfaces:**
- Consumes: Task 1 reducer/adapter and Task 2 `snapshotBegin.externalOutputActive`.
- Produces: `externalOutputActive` component state, `usesCommittedProjection()` visible-surface predicate, and ownership-change interaction cleanup. No new public API or input protocol.

- [ ] **Step 1: Implement the minimal component ownership/projection change**

Add `private externalOutputActive = false` and:

```ts
private usesCommittedProjection(): boolean {
  return this.modernCommittedMode() &&
    (!this.externalOutputActive || this.localHydrationState === "hydrating");
}
```

Replace `modernCommittedMode()` with `usesCommittedProjection()` only at visible/interaction forks: `project()`, `interactionLine()`, `interactionNullCell()`, `mousePointForEvent()`, and `tryScrollBy()`. Keep readiness, commit, recovery, identity, and proof decisions on `modernCommittedMode()`.

Replace the existing `?2026` observer body with Task 1's adapter. Initialize it from the component state; preserve closed/term/epoch fences and `parserObserverEvents`; copy `current.syncOpen` to `parserSyncOpen`; call `commitCommittedView(term, epoch)` for every `syncCloseMarker` exactly as before. On an actual external-flag change, run this side-effect boundary without sending input or forcing a parser read:

```ts
private resetExternalProjectionInteraction(): void {
  this.clearSelectionAutoScroll();
  this.clearPendingClick();
  this.selection = null;
  this.selectionDragging = false;
  this.lastClickPoint = null;
  this.lastClickAt = 0;
  this.viewportTop = null;
}
```

At `snapshotBegin`, new-generation state first resets to false; then a validated boolean adopts the runner value and runs interaction cleanup on change. An absent field preserves same-generation local state. Preserve external state across same-generation parser replacement and resize. Reset it on epoch reset, legacy fallback, and close/dispose. The existing output scheduler performs post-parse rendering; do not add a synchronous partial-hydration render.

- [ ] **Step 2: Run component and focused regression suites to GREEN**

Run: `node --test test/attach-screen-owner.test.mjs test/terminal-model.test.mjs test/terminal-attach-protocol.test.mjs test/terminal-attach-client.test.mjs test/pty-attach-external-editor.test.mjs test/pty-attach-parser-replacement.test.mjs test/pty-attach-ready.test.mjs`
Expected: PASS. In particular, Nvim is visible and interactive, Pi restore-open is not visible, restore-close commits the APC-containing frame, hydration/resize/reset cases pass, and existing 32 parser-replacement checks remain intact.

- [ ] **Step 3: Run the real Nvim round trip to GREEN**

Run: `PI278_REAL_NVIM=1 PI278_ARTIFACT_DIR=/tmp/pi278-real-green node --test test/attach-external-editor.real.test.mjs`
Expected: PASS; both initial and reattached renders show live Nvim edits, `:q!` restores `PI_RESTORE_PROBE` at 80x22 without Nvim residue, the restore Kitty APC is recorded, a later ordinary input produces a later F, and natural cleanup succeeds. If Pi/Nvim is missing, record A5 as pending rather than claiming success; on this development machine both are present, so execute the real run before merge.

- [ ] **Step 4: Run all repository acceptance gates**

Run: `npm run verify`
Expected: typecheck, perf, full tests, coverage thresholds, and pack dry-run all pass. Report test/pass/skip counts and any pre-existing flaky failure honestly; do not call a targeted green run full verification.

- [ ] **Step 5: Commit the fix and any harness-only corrections**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-external-editor-scenario.ts test/pty-attach-external-editor.test.mjs test-support/attach-external-editor-real.ts test/attach-external-editor.real.test.mjs
git commit -m "fix: show external editor output in modern attach (#278)"
```

If no Task 3 harness correction was needed, stage only `src/ui/pty-attach.ts`. Do not include unrelated files or the SDD workspace.

## Plan Self-Review Record

- Spec coverage: D1/A1 → Task 1; D2/D3/A2 → Task 2; D4–D8/A3/A4 → Tasks 3–4; D9 and Kitty restore/A5 → Tasks 3–4; A6 → Task 4. No acceptance ID lacks a task.
- Type consistency: Task 1 callback `{ previous, current, event, syncOpenMarker, syncCloseMarker }` is consumed by Tasks 2 and 4; Task 2's `snapshotBegin.externalOutputActive` is consumed by Tasks 3–4; the component predicate matches the corrected spec verbatim.
- Placeholder scan: every task has named files, executable commands, explicit expected RED/GREEN evidence, concrete interfaces, and commit scope. No task relies on an undefined helper or an unnamed future test.
- Review focus: combined CSI, malformed fields, late reattach, partial frames, and stale interaction geometry each have an owning test step.
