# Issue #188 — X10 mouse release (`Cb=3`) parsed as press: selection cleared, never copied

- Issue: https://github.com/zhuxixi/pi-agent-board/issues/188
- Kind: bug — root-cause report + fix design
- Repo: `zhuxixi/pi-agent-board` · baseline `main` @ `7cf0853` (drafted and cross-reviewed against `f81949d`; rebase is citation-only) · worktree `issue-188-x10-release`
- Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T12:34:15Z
- Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T12:52:00Z — after round-1 review (R1-G1/R1-G2/R1-D1 accepted; findings in `research/spec-review-round-1.md`)
- Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T13:03:00Z — after round-2 review (R2-D1 accepted; 0 real gaps, converged; findings in `research/spec-review-round-2.md`)
- Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-15T00:00:00Z — rebased onto `main` @ `7cf0853` (#190/#191 merged): line citations moved (+4 from `handleInput`, +25 from `handleMouseInputChunk`, osc52 +42); no design or boundary change, the X10 branch and the legacy handler are byte-identical to `f81949d`
- Research: `research/01-root-cause-and-reachability.md` (root cause, reachability, fix validation)
- Route: bug → `systematic-debugging` (Phase 1 root cause + live repro done in `research/`; this document is the design)

## 1. Problem

In the legacy (regular-TUI) mouse path, an X10/normal-encoded release — `Cb = 3` — is decoded as
`action: "press"`. `handleLocalMouseEvent` then takes its non-primary press branch and clears the
pending click and the selection, so the real release branch (the one that calls
`copySelectionToClipboard()`) never runs: on a terminal that speaks only X10 the user drags, sees the
highlight, and loses it the instant the button comes up — nothing is copied.

Affected scope is narrow but real: X10 bytes reach the parser only from terminals that ignore the
`?1006` SGR request while still reporting `?1000`/`?1002` mouse events (`MOUSE_ENABLE`,
`src/ui/pty-attach.ts:45`), and only in regular TUI mode (in fullscreen, pi-tui's `TuiAltScreen`
consumes raw mouse input and its own parser accepts SGR only). The defect is latent, not a
regression: the X10 branch has been unchanged since it was introduced in `b1ee950`
(2026-06-01).

## 2. Root cause (evidence in `research/01-root-cause-and-reachability.md`)

X10/normal encoding is `ESC [ M Cb Cx Cy`, one byte per field, each byte = value + 32. Per xterm
ctlseqs, for the low two bits of `Cb`: `0 = MB1 pressed, 1 = MB2 pressed, 2 = MB3 pressed,
3 = release` — release is a *button code*, not a bit, and it carries no button identity. Bits 2–4
are shift/meta/ctrl, bit 5 (`32`) is motion, bit 6 (`64`) is wheel (wheel releases are never
reported).

`parseMouseEventPrefix` (`src/core/pty-scroll.mjs:53-66`) maps every X10 event that lacks the motion
bit to `"press"`. A `Cb = 3` event therefore enters `handleLocalMouseEvent`
(`src/ui/pty-attach.ts:1033`) with `button = 3`: `primary = (3 & 3) === 0` is `false`,
`middleButton` is `false`, so the press branch runs `!primary` → `clearPendingClick()` +
`clearSelection()` (`:1047-1051`).

Live component-level repro on `f81949d` (real `PtyAttachComponent` + real runner socket + fake PTY,
OSC 52 observed on `tui.terminal.write`): canonical SGR press → move → release copies
(`osc52 = ["fake pi ready"]`); the same gesture encoded as X10 emits **no** OSC 52 and the selection
is `null` synchronously at the release.

## 3. Fix design

### 3.1 Classification contract for the X10 branch (`parseMouseEventPrefix`)

| `Cb` bits | `Cb` example | `action` |
|---|---|---|
| `(button & 96) === 0` and `(button & 3) === 3` | 3, 7 (shift), 19 (ctrl) | `"release"` |
| `button & 32` (motion), not the above | 32, 35, 64\|32… | `"move"` |
| otherwise | 0, 1, 2, 64, 65 | `"press"` |

Bit 6 (`64`) is excluded from the release rule: wheel events (`64`/`65`, with or without modifiers)
keep the `"press"` classification that the wheel path reads. Bit 5 (`32`) is excluded as well, so
"motion with no button" (`35`) stays `"move"`. Modifier bits 4/8/16 leave `button & 3 === 3` intact,
so a modifier-carrying release is still a release. The SGR branch (`M`/`m` suffix) and the passive
branch are unchanged — see §6.

Byte literals used from here on follow that encoding: `ESC [ M` + `chr(Cb + 32)` + `chr(col + 32)` +
`chr(row + 32)`, six bytes total. Worked examples for body row 0 (= terminal row 2, `chr(34) = "`):
press at col 1 = `\x1b[M !"`, motion at col 8 = `\x1b[M@("` (`"(" = 40 = 8 + 32`), release at col 20 =
`\x1b[M#4"` (`"4" = 52 = 20 + 32`). A release report is therefore exactly six bytes — a seven-byte
string is not an X10 report and `parseMouseInputChunk` rejects the whole chunk (all-or-nothing, §6.2).

Intended implementation shape (behaviour above is normative; the exact shape may be adjusted in the
plan as long as the decision table holds):

```js
	// X10/normal mouse: ESC [ M Cb Cx Cy. Cb is encoded as button + 32.
	if (input.startsWith("\x1b[M") && input.length >= 6) {
		// Cb packs the button (bits 0-1), modifiers (2-4), motion (5) and wheel (6).
		// Bit value 3 in bits 0-1 is the protocol's release code: it carries no
		// button identity, so treating it as a press cleared the drag selection on
		// release instead of copying it (issue #188).
		const button = input.charCodeAt(3) - 32;
		const motion = (button & 32) !== 0;
		const wheel = (button & 64) !== 0;
		const release = !motion && !wheel && (button & 3) === 3;
		return {
			length: 6,
			raw: input.slice(0, 6),
			mouse: {
				encoding: "x10",
				button,
				col: input.charCodeAt(4) - 32,
				row: input.charCodeAt(5) - 32,
				action: release ? "release" : motion ? "move" : "press",
			},
		};
	}
```

### 3.2 Why the parser layer, not the handler

`mouse.action` has exactly three consumers, all in `handleLocalMouseEvent`
(`src/ui/pty-attach.ts:1036`, `:1065`, `:1075`), and the SGR branch already expresses release
through this same field. Classifying in the parser keeps one source of truth for "what did the
terminal report", leaves the handler's protocol-agnostic branches untouched, and keeps the decision
inside a pure function (see §7). A handler-side patch (e.g. treating `button === 3` presses as
releases) is rejected: it would make the same fact true in two places and would misfire on the SGR
path, where `button` is carried on release with its real identity.

### 3.3 Alternatives considered

| Alternative | Verdict |
|---|---|
| Classify in the parser with the bit test above (chosen) | One edit site, pure, testable at the existing unit seam |
| Detect release in `handleLocalMouseEvent` by `mouse.button === 3` | Rejected: duplicates truth, misfires for SGR releases that carry `button = 0/1/2`, and hides the protocol fact from the parser's unit tests |
| Infer "release" from a stateful "a press is pending" flag in the component | Rejected: adds state to fix a stateless decoding bug; a lost press (e.g. mixed-chunk drop, #189) would invert the mapping |
| Treat any non-primary press as a release | Rejected: right/middle presses are real events and must keep clearing/acting as they do today |

## 4. Data flow

`outer terminal → pi input pipeline → PtyAttachComponent.handleInput(data)` (`:301`) →
`parseMouseInputChunk` (`src/core/pty-scroll.mjs:84`) → `parseMouseEventPrefix` per report →
`{ raw, mouse }` → `handleMouseInputChunk` (`:981`) → wheel branch by `button & 64` **or**
`handleLocalMouseEvent` by `action`. The fix changes only the `action` value produced for `Cb = 3`;
everything downstream is unchanged.

## 5. Acceptance matrix

| ID | Functional point | Verification | Concrete check | Pass criterion |
|---|---|---|---|---|
| A1 | X10 press / motion / release / modifier-release classification | automated — **unit** | extend `test/pty-scroll.test.mjs` `parseMouseEvent` cases: `\x1b[M !"` → press, `\x1b[M@!"` → move, `\x1b[M#!"` → release, `\x1b[M'!"` (7 = shift+release) → release, `\x1b[M3!"` (19 = ctrl+release) → release; run `node --test test/pty-scroll.test.mjs` | every case decodes `button`, `col`, `row` and the `action` from §3.1 |
| A2 | Failure and unchanged branches do not shift | automated — **unit** | same file: X10 wheel `\x1b[M\`!"` (64) and `\x1b[Ma!"` (65) → press and `mouseWheelDirection` still +1/−1; middle button `\x1b[M!!"` (1) → press, button 1 (backs §6.1's middle-press claim: the component path it feeds — `middleButton` → `pastePrimarySelection` — is already driven SGR-encoded by `test/pty-attach-mouse.test.mjs`, so classification is the only X10-specific link); motion-with-button-3 `\x1b[MC!"` (35) → move; right button `\x1b[M"!"` (2) → press; `parseMouseEvent("x")` → null; passive `\x1b[?32;7;8M` → move and `\x1b[?0;7;8m` → release; run `node --test test/pty-scroll.test.mjs` | values identical to `f81949d` except the intended release rows |
| A3 | Multi-report X10 chunk decodes in order | automated — **unit** | same file: `parseMouseInputChunk` over the concatenation of three X10 reports — press col 1 row 2 `\x1b[M !"`, motion col 8 row 2 `\x1b[M@("`, release col 20 row 2 `\x1b[M#4"` (byte rule in §3.1) | 3 entries with exact `raw` slices and `action` = press / move / release |
| A4 | X10 drag release copies the selection | automated — **component E2E** | new `test-support/pty-attach-x10-scenario.ts` (real `PtyAttachComponent` + real runner socket + fake PTY, modelled on `test-support/pty-attach-mouse-scenario.ts`) driven by new `test/pty-attach-x10.test.mjs` via `node --experimental-transform-types`; feed the same three reports as A3 (`\x1b[M !"` → `\x1b[M@("` → `\x1b[M#4"`) through `handleInput`, waiting for the fixture line to render first | exactly one OSC 52 (`\x1b]52;c;<base64>\x07`) write, whose payload is the selected line text (`fake pi ready`) |
| A5 | Non-drag branches keep today's behaviour | automated — **component E2E** | same harness: same-point X10 click (`\x1b[M !"` → `\x1b[M#!"`), X10 right press + release (`\x1b[M"!"` → `\x1b[M#!"`), X10 wheel (`\x1b[M\`!"`) with a viewport that cannot scroll | click and right-button gestures emit **no** OSC 52; the click's 1-cell highlight is gone after the pending-click window; the wheel sequence is forwarded to the child as `{type:"input"}` and the process stays alive |
| A6 | No regression across the repo, build integrity | automated — **static + full suite** | `npm run verify` (`package.json`) | exit code 0 (typecheck, perf gate, `node --test test/*.test.mjs`, coverage thresholds, `pack:dry`) |
| U1 | Real-world X10-only terminal behaviour | manual — **optional, non-blocking** | see §6.3 | drag in the attach view of a terminal that reports X10 copies on release; recorded as `pending` unless executed |

Notes on the matrix:

- A1–A3 are the lowest-cost level that can prove the decoding rule; A4/A5 are the lowest level that
  can prove the *effect* (copy on release), because the effect lives behind a private handler with
  TUI + socket + xterm dependencies (see §7).
- A4 asserts the copy effect only. Highlight persistence after a copy is today's behaviour and the
  subject of the open bug #172, so #188 neither pins it nor changes it (see §6.2).
- Failure branches are covered by A2 (unrecognised input → `null`, unchanged classifications) and A5
  (click / right button / wheel).
- A6 is the repo's definition of done (`AGENTS.md`); it is not a substitute for A4/A5, which pin the
  new behaviour.

## 6. Boundaries and non-goals

### 6.1 Explicitly not changed

- **Wheel** (`Cb` with bit 6), including wheel-with-modifier: classification stays `"press"`, which
  is what the wheel branch (`button & 64`) and `mouseWheelDirection` read.
- **Click semantics**: same-point press + release still schedules the pending click and clears the
  1-cell highlight after `DOUBLE_CLICK_MS` (260 ms) — the release branch's `shouldCopy === false`
  path is untouched.
- **Middle press** (PRIMARY paste) and **right press** (selection clear) keep their behaviour; a
  right release (`Cb = 3` after `Cb = 2`) now reaches the release branch, which, with no selection,
  returns at `:1064` (`if (!this.selection) return;`) — same observable result as before (nothing
  copied), verified by A5.
- **SGR and passive branches.** SGR releases are already marked by the `m` suffix. The passive form
  (`CSI ? … M/m`, contour-terminal passive mouse tracking, `CSI ? 2029 h`) marks release with the
  lowercase `m` as well and a passive terminal "will ONLY allow SGR transport mode", so the X10
  button-code rule does not apply there — A2 pins that the passive rows are unchanged.
- **Fullscreen path** (`handleMouse`, pi-tui `TuiAltScreen`): untouched. pi-tui parses SGR only, so
  X10 non-wheel reports are dropped upstream in that mode; that is an upstream limitation, not this
  issue.
- **Cutting back the X10 branch, or adding 1005/1015 encodings**: no.

### 6.2 Interaction with sibling issues (must not be pre-empted)

- **#187 (motion-less drags)** stays separate. With this fix, an X10 gesture *without* motion events
  still lands in the release branch with `shouldCopy === false` and is cleared by the pending click;
  #187 owns the geometry rule (`anchor ≠ release point` ⇒ drag). This spec must not add geometry
  logic, and #188's acceptance does not depend on #187 landing. After #187 lands, the motion-less X10
  case copies as a side effect — that row is explicitly out of #188's matrix.
- **#172 (highlight survives a copy-on-release)** is an open bug asking to *clear* the selection in
  the very `shouldCopy` branch this issue exercises (`src/ui/pty-attach.ts:1081-1088`). Retention is
  today's behaviour, not a contract; #188 must not add an assertion that pins it and must not add the
  clearing either — that call belongs to #172. A4 therefore asserts the copy effect only. Whichever
  of the two merges second rebases and re-runs A6.
- **#189 (mixed chunks)** stays separate: `parseMouseInputChunk` keeps its all-or-nothing contract;
  A3 pins a pure-mouse chunk only. A4's three reports are exactly six bytes each for this reason.

### 6.3 Guarantee boundary and the manual item U1

- **No release, no copy**: terminals in X10 *compatibility* mode (`?9`, press-only reports) never
  send a release, so nothing changes for them; xterm encodes MB3 presses there as `Cb = 2`
  ("`Cb` is button−1"), so the new release rule cannot capture a real press.
- The mapping in §3.1 is the protocol definition, not a heuristic: xterm ctlseqs states the low two
  bits are `0 = MB1 pressed, 1 = MB2 pressed, 2 = MB3 pressed, 3 = release`.
- **U1 (optional, non-blocking, expected status `pending`)**: the operator has no X10-only terminal,
  so the real-terminal check cannot gate this change. Recipe if it is ever run: start the board
  (`pi`) inside a PTY wrapper that strips `\x1b[?1006h` from the byte stream on its way to the real
  terminal (so the terminal falls back to the X10/normal encoding while the board still reports
  `?1000`/`?1002`), then drag-select in an attach view and paste. Prerequisites: (a) the wrapper
  (about 30 lines using the repo's `node-pty` dependency), a terminal that accepts `?1000`/`?1002`,
  regular TUI mode (`tuiMode: "regular"`), and a session with selectable text; (b) the code under
  test — point the dev symlink at the #188 worktree (`ln -s "$(pwd)" ~/.pi/agent/extensions/agent-board`,
  `README.md:68`) or run U1 after the merge on a release that contains it, otherwise the run validates
  whatever checkout the symlink already points at. Observation: on release the OSC 52 copy lands in
  the clipboard (this is the acceptance); whether the highlight then stays is today's behaviour and an
  open bug (#172), so it is not an acceptance criterion here. Failing an execution window, the
  component-level E2E (A4/A5) drives the exact byte stream through the real component and socket, and
  is the strongest evidence available.

### 6.4 Rollback

Single-commit revert of the parser change; no persisted state, no config, no env flag, no migration.
Reverting restores today's (broken) X10 release classification and changes nothing else.

## 7. Testability split design

- **Pure decision layer (must stay pure)**: the rule lives inside `parseMouseEventPrefix`
  (`src/core/pty-scroll.mjs:31`), reachable through the already-exported pure functions
  `parseMouseEvent(data)` and `parseMouseInputChunk(data)`. A1–A3 drive those directly: no I/O, no
  TUI, no socket. The implementation must not move the classification out of the parser (no new
  export, no new helper needed, no new env flag or config key).
- **Effect layer (private, covered at the component seam)**: `handleLocalMouseEvent`
  (`src/ui/pty-attach.ts:1033`) is private and depends on the TUI, the runner socket and the inner
  xterm instance; it is not unit-testable and gets no new seam. A4/A5 cover it through the public
  `handleInput(data)` entry point with observable effects only: OSC 52 written to
  `tui.terminal.write`, `{type:"input"}` frames written to the socket, and `render()` output.
  Selection *state* is deliberately not asserted through private fields, and A4 asserts the copy
  (OSC 52 payload) rather than the highlight's fate — its persistence is #172's contested subject
  (§6.2). In A5, "the click's highlight is gone" is observed through the pending-click window
  (`DOUBLE_CLICK_MS = 260`, `src/ui/pty-attach.ts:48`) plus the absence of a copy.
- **Test boundary**: parser classification (A1–A3) / component reaction (A4–A5). The split mirrors
  the existing pair `test/pty-scroll.test.mjs` (pure) + `test-support/pty-attach-mouse-scenario.ts`
  with `test/pty-attach-mouse.test.mjs` (component, `node --experimental-transform-types` scenario
  printing one JSON line consumed by the test). Naming follows those files
  (`test-support/pty-attach-x10-scenario.ts`, `test/pty-attach-x10.test.mjs`).
- **Fixture realism**: the scenario reuses `test-support/fake-pty-pi.mjs` (default mode prints
  `fake pi ready`, stable, one body line) and a PATH-stubbed `xclip` so `writePrimarySelection()`
  never touches the host clipboard.

## 8. Risks

| Risk | Assessment / mitigation |
|---|---|
| Misclassifying a real press as release | `Cb = 3` is defined as release by xterm; X10 compatibility mode encodes MB3 presses as 2 and sends no releases. A2 pins right-button press. |
| Wheel regression | The release rule excludes bit 6; A2 pins both wheel directions and `mouseWheelDirection`. |
| Changing shared file `src/core/pty-scroll.mjs` while #187 is in flight | Both changes are small and in different helpers; whichever merges second rebases and re-runs A6. No shared lines are claimed by both designs. |
| A4's OSC 52 payload depends on the fixture line | The harness waits for the fixture line to render before the gesture (same pattern as the existing mouse scenario) and asserts the exact payload string. |
| #172 lands and clears the selection in the copy branch | A4 carries no retention clause, so #172 does not invalidate it; only the rebase (same file, `src/ui/pty-attach.ts` release branch region) and a re-run of A6 are needed. |
| Coverage thresholds (`npm run verify`) | New pure branches are exercised by A1/A2; the scenario adds one integration test. If coverage dips, the parser cases (not the assertions) are extended. |
