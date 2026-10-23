# Issue #231 — full-row highlight for the selected board row

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T19:10:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T19:24:00+08:00 — cross-review round 1 (R1-G1/G2/G3, R1-D1..D5 accepted)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T19:40:00+08:00 — cross-review round 2 (R2-G1, R2-D1, R2-D2 accepted)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-23T20:00:00+08:00 — cross-review round 3 details applied (R3-D1 stale width, R3-D2 abridged-code-block label)

Repo: `zhuxixi/pi-agent-board` · base `main` @ `d41a16b` · issue #231 (enhancement)

## Problem & intent

The board list marks the selected row with a 1-cell `›` and `bold`, both of which sit in the
same stage colour as the neighbouring glyph. At rest the cursor is not locatable; the user has
to tap ↑/↓ and watch which line changes.

Intent: the selected row must be identifiable **without moving the selection**, on both dark
and light themes, for CJK session names, and for every stage colour.

## Decisions (confirmed with the user before drafting)

| # | Decision | Choice | Why |
| --- | --- | --- | --- |
| D1 | Background colour source | `theme.bg("selectedBg", …)` | Theme-aware by construction: `dark` → `okhsl(233 41% 24%)`, `light` → `okhsl(235 19% 91%)`. Also degrades through `backgroundAnsi(mode)` for truecolor / 256 / 16-colour terminals. A hardcoded RGB is unreadable on light themes (`text` resolves dark there). |
| D2 | Extra cue | keep the `›` marker, **no** `▌` rail | Background answers "which row", `›` still answers "where is the cursor". A rail would collide semantically with the folder-header `▌` (`:1450-1451`, meaning "selection is inside this folder"). |
| D3 | Highlight extent | full row, **covering `indent`** | lazygit/fzf convention; the indent still conveys hierarchy because the glyphs stay in place. |
| D4 | Unselected contrast | keep `muted` | Minimal change; do not trade unselected readability for relative contrast. Revisit only if the bg proves insufficient. |

Explicitly **not** doing: per-stage desaturated backgrounds (8 states × 2 appearances to
validate, and a selected `working` bar would compete with the flash banner's bg bar), and the
`muted → dim` demotion.

## Current behaviour (measured, `src/ui/dashboard.ts` @ d41a16b) — **abridged**: the real body also composes a `badge` (batch marker / pin / worktree / status / refs) into `nameText` (:1468, :1473) and joins the marker with a literal space (:1478); neither changes the padding/colour conclusion

`renderRow` (:1459-1482):

```
marker   = stageFg(state, selected ? `›${glyph}` : ` ${glyph}`)
name     = selected ? fg("text", bold(nameText)) : fg("muted", nameText)
summary  = selected ? fg("text", summary)        : fg("muted", summary)
line     = padTo(marker + name + folder + summary, contentWidth - width(age)) + fg("dim", age)
return     clip(" ".repeat(indent) + clip(line, contentWidth), width)
```

No `bg` call anywhere in the row path. `ThemeLike.bg` is already declared at `:52` but unused
by `renderRow`.

## Design

### Component contract

```ts
// module-scope pure helper in src/ui/dashboard.ts (exported for the harness)
export function applyRowHighlight(
	theme: Pick<ThemeLike, "bg">,
	selected: boolean,
	text: string,
): string {
	return selected ? theme.bg("selectedBg", text) : text;
}
```

`renderRow` composes the row body exactly as today, then wraps **`indent + clipped body`**
(not the body alone) so the highlight starts at column 0:

```ts
const body = clip(line, contentWidth);
const paint = applyRowHighlight(t, selected, `${" ".repeat(indent)}${body}`);
return clip(paint, width);
```

Ordering constraints (verified against `pi-tui` `utils.js`):

1. `theme.bg(...)` emits `opener + text + "\x1b[49m"`, so the closing sequence is always inside
   the clipped string; nothing bleeds into the next row.
2. Nested `fg` codes (`\x1b[38;2;…m…\x1b[39m` from `stageFg`/`ansiFg`, and the theme's
   `\x1b[39m`) reset the foreground only — the background survives.
3. `clip` = `truncateToWidth(..., "")`; when a line fits, it returns the string byte-identical
   (the `\x1b[49m` survives). On overflow it appends a full `\x1b[0m`, which also guarantees no
   leak — the only visible cost is that an ultra-narrow row's highlight stops at the clip point.
4. The body is already padded to `contentWidth` by `padTo` (:1479) and `age` is appended after
   the pad, so the bg span necessarily includes the trailing pad **and** the age column.

### Data flow

```
renderRows → renderRow(rv, width, {indent}) → applyRowHighlight(theme, rv.id === selectedId, indent + body) → clip
```

No state, persistence, or protocol changes. `selectedId` remains the single source of truth.

### Non-goals

- No change to `select` mode's `◉/○`, `peek`/`reply`/`session`/`evidence`/`launch` layouts,
  `help`, the flash banner, the folder-header rail, or scroll-marker lines.
- No theme/config option. No per-stage colours. No new dependency.
- No viewport changes — that is open PR #226's territory (`windowBody()` only).

### Failure behaviour / degradation

`ThemeLike` declares `bg` as required, and pi's `Theme` always implements it; a theme missing
`selectedBg` throws inside `bg()` rather than silently dropping the highlight. There is therefore
**no defensive fallback** — a host without `bg` must fail loudly, and the test harnesses are
updated to supply it. (Deliberate: a silent identity fallback would hide a real theme-contract
break and make the highlight mysteriously vanish.)

## Acceptance matrix

| ID | Feature point | Mode | Concrete verification | Pass criteria |
| --- | --- | --- | --- | --- |
| A1 | Selected row emits a bg span that opens at column 0 and closes with `\x1b[49m` | automated — integration (`DashboardComponent.render` harness) | `node --experimental-transform-types test-support/dashboard-selection-render.ts` (invoked from `test/dashboard-selection.test.mjs`) | selected line starts with the stub's bg opener, contains exactly one closer, and `visibleWidth(line) === width` |
| A2 | Highlight covers the trailing pad and the age column | automated — integration (same harness) | same script: strip ANSI, assert the visible text before `padTo` (name/summary/folder, i.e. the un-padded body) is shorter than `width`, while the painted line's `visibleWidth === width`; assert the age column's cells are inside the bg span by checking the bg closer is the last visible token | bg span covers columns `[0, width)` — the pre-pad text is shorter than `width` and the painted line is exactly `width` wide |
| A3 | Folder-group indent is inside the highlight | automated — integration (same harness, two rows under one folder header) | same script, `indent = 4` case | selected line's bg opener is at index 0, i.e. before the 4-space indent |
| A4 | Unselected rows carry no bg | automated — integration | same script | zero bg openers in unselected lines |
| A5 | `bg` is called exactly once per rendered list frame | automated — unit (spy) | same script: `bgCalls` counter in the stub theme | `bgCalls === 1` with one selected row; `0` when `selectedId` matches no visible row |
| A6 | `select` mode batch marker survives | automated — integration | same script: press `m` to enter select mode (`dashboard.ts:371`), press space to toggle the current row's batch marker (`dashboard.ts:403-405`), render | the selected row contains `◉`, the other row contains `○`, and the selected row's bg span is unchanged |
| A7 | Peek header unchanged | automated — integration | same script: open peek, assert the header line | header has no bg opener and keeps `accent + bold` name |
| A8 | Ultra-narrow width does not leak bg into following lines | automated — integration | same script at `width = 23` with `indent = 4` (`contentWidth = max(20, 23-4) = 20`, so `indent + contentWidth = 24 > 23` and `clip` really truncates) | every returned line's `visibleWidth <= 23`; no unselected line contains an opener; the selected line may lose its closer (documented degradation) but must not leak |
| A9 | Type + full suite still pass | automated — static / suite | `npm run typecheck`; `npm test`; `npm run test:perf`; `npm run test:coverage`; `npm run pack:dry` (all via `npm run verify`) | exit 0, existing thresholds 85/80/70 hold |
| A10 | D2: the `›` cursor marker is kept and only on the selected row | automated — integration (same harness) | same script: render list, compare marker positions | selected line contains `›` immediately before the state glyph; unselected lines contain a space in that cell |
| A11 | D4: unselected rows keep `muted`, not `dim` | automated — unit (spy) | same script: stub theme records `(token, text)` pairs | unselected name/summary calls use `fg("muted", …)`; no `fg("dim", …)` call wraps a name/summary (the age column's `dim` is expected) |
| U1 | Selected row is locatable at rest on a dark theme | user test | **prerequisite:** `git fetch && git checkout <PR branch> && npm install && pi install "$(pwd)"` (README.md:53-54; dev alternative: `ln -s "$(pwd)" ~/.pi/agent/extensions/agent-board`, README.md:68 — `npm link` does **not** load a pi extension). The extension loads from the installed path / working tree, so a stale checkout validates old code. Then restart pi, open `/agent-board` on a board with ≥5 rows, don't touch the keyboard | selected row identifiable within ~1 s without moving the cursor |
| U2 | Same on a light theme | user test | switch pi theme to `light`, repeat U1 | row identifiable and the name/summary stay readable (no dark-on-dark) |
| U3 | CJK names stay readable on the highlight | user test | rename a session to a Chinese name (e.g. `修复面板高亮`), repeat U1 | name legible at 100 % zoom, no clipped glyphs or colour fringe |
| U4 | All stage colours remain legible on the highlight | user test | bring one row to each of `working` / `needs answer` / `idle` / `failed` / `stopped` (dispatch or stop a session), repeat U1 | state glyph and row text readable on top of the bg for every stage |
| U5 | Highlight is distinguishable from existing strong signals | user test | trigger a flash banner with a real notice-producing action (dispatch a session, or stop one — the list `r`/`ctrl+r` are reply/rename, not refresh) and put the selection inside a folder group | flash bar, folder `▌`, and row highlight read as three different things |

Failure branches are covered by A4/A5 (bg must not leak to unselected or absent selections) and
A8 (overflow). The "theme lacks `bg`" branch is intentionally a hard failure, exercised by the
harness itself.

D1 (colour source) is owned by A1 + A2 for the mechanics and U1 + U2 for the visual outcome;
there is no separate automated check on the resolved RGB because the harness stub deliberately
substitutes its own colour (the theme token itself is pi's contract, pinned by
`theme.d.ts`).

### Guarantee boundaries

- **Guaranteed:** the built-in `dark` and `light` themes resolve `selectedBg` to a low-saturation
  bg with adequate contrast against `text`/`muted`; verified visually by U1/U2.
- **Not guaranteed:** chroma fidelity on 16-colour terminals — `backgroundAnsi(mode)` downgrades
  to the nearest palette entry, so the hue may shift. The highlight stays visible; the exact
  shade does not.
- **Not guaranteed:** user-authored themes that override `selectedBg` with a low-contrast colour.
  That is the theme author's contract, not this change's.
- **Not guaranteed:** terminals that ignore 24-bit SGR backgrounds entirely (extremely old
  emulators). `backgroundAnsi` handles the standard colour modes; a terminal outside them is out
  of scope.

## Testability split (design constraint for the implementation)

| Boundary | Artifact | How it is tested | Why this split |
| --- | --- | --- | --- |
| Highlight application (pure) | `applyRowHighlight(theme, selected, text)` — module scope, exported | unit assertions inside the harness: unselected returns input unchanged (identity/`===`), selected wraps once | Pure function, no `this`, no I/O; a regression in the wrap/close logic fails without rendering a whole frame |
| Row composition (impure: theme + view model) | `renderRow` | integration via `DashboardComponent.render`: A1–A4, A6–A8 | Needs the real row view model (`rows.mjs`), grouping, and `clip`/`padTo` interaction; only a rendered frame can prove pad coverage |
| Theme call accounting | stub theme with `bgCalls` counter | A5 | Proves the highlight is applied once, not per nested fragment |
| Asset/build | none | A9 | Repo gate |

The pure helper must stay free of `this`, `selectedId`, and row-view imports so the unit
assertions stay meaningful; `renderRow` keeps the single `selected` comparison and delegates the
painting. Implementation must not re-inline the ternary back into `renderRow` (that would break
the split and reintroduce an untested branch).

Harness file: `test-support/dashboard-selection-render.ts`, invoked by
`test/dashboard-selection.test.mjs` with `node --experimental-transform-types` (same pattern as
`dashboard-refs-render.ts`). Test file name follows the existing `dashboard-*.test.mjs`
convention.

### Harness stub contract (two distinct stubs, on purpose)

| Harness | Stub shape | Its assertions |
| --- | --- | --- |
| `dashboard-selection-render.ts` (new) | `bg: (_c, t) => "\x1b[48;2;1;2;3m" + t + "\x1b[49m"` with `bgCalls++`; **recording** `fg: (c, t) => { fgCalls.push([c, t]); return t; }`; identity `bold` | A1–A11 (the recording `fg` is what makes A11's `muted`-vs-`dim` assertion possible; `bgCalls` serves A5) |
| the 8 pre-existing `DashboardComponent` harnesses listed in the risk table | `bg: (_c, t) => t` (identity) | none — they keep rendering and their existing assertions unchanged |

An identity stub in the **new** harness would make A1–A4/A8 vacuous (no opener, no closer), which
is exactly what review round 1 flagged; the two-stub split keeps old harnesses untouched while
the new one asserts real ANSI.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Existing harnesses stub `{ fg, bold }` only, so adding a `bg` call breaks them with `theme.bg is not a function` | The **new** harness uses a real stub (`bg: (c, t) => "\x1b[48;2;1;2;3m" + t + "\x1b[49m"`, plus a `bgCalls` counter) so the ANSI assertions are meaningful. **8 harnesses construct `DashboardComponent` directly** and all get the identity stub `bg: (_c, t) => t`: `dashboard-delete-key-probe.ts`, `cwd-browse-tab-probe.ts`, `dashboard-shrink-render.ts`, `dashboard-refs-render.ts`, `dashboard-prewarm-smoke.ts`, `navigation-wrap.ts`, `hold-key-wrap.ts`, `ui-smoke.ts`. Of these, only **5 actually call `.render(`** and therefore reach `renderRow` → `theme.bg`: `cwd-browse-tab-probe.ts`, `dashboard-delete-key-probe.ts`, `dashboard-refs-render.ts`, `dashboard-shrink-render.ts`, `ui-smoke.ts`; the other 3 are construct-only. `attach-delete-flow-probe.ts` constructs a real `DashboardComponent` through a factory (it never imports the class directly), so it also gets the identity stub defensively. `npm run typecheck` does **not** cover any of them (`tsconfig.json` excludes `test` and `test-support`), so a missing method surfaces as a runtime failure under `npm test` — not at typecheck. |
| `selectedBg` may be too subtle on some custom themes | U1/U2 cover the two built-in themes; custom themes can override the token themselves (that is a feature of D1, not a bug). If a built-in theme reads too weak, the follow-up is a token change in pi, not a hardcoded colour here. |
| Conflict with open PR #226 (same file, `windowBody`) | Orthogonal regions. If #226 merges first, rebase; if this merges first, #226's harness asserts line counts/presence only and is unaffected. |
| `\x1b[0m` from an overflowing `clip` could kill the bg on very narrow terminals | A8 pins the behaviour at `width = 23`; visual degradation is acceptable and leak-free. |

## Rollout

Single PR against `main`, no release action required in this issue (release is a separate
manual step per `docs/RELEASE.md`).
