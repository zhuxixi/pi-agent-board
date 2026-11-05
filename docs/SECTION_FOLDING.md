# Section folding and terminal-mode checks

## Behavior

- In Normal mode, Up/Down visit section headings as well as sessions, wrapping at both ends. Initial focus remains on a session when one is visible.
- Tab toggles the current section, including when a session inside it is selected. Folding focuses the header rather than leaving a hidden session selected.
- On a header, Enter (without a draft) or Space toggles; Left collapses; Right expands.
- Folded headers retain their session counts. New activity updates counts but does not discard the user's fold choices.
- Session-level actions never target a hidden session from a header. Multi-select and Peek navigation visit expanded sessions only.
- Search temporarily expands matching sections; saved folds return when the filter is cleared. Folding is disabled while a filter is active.
- Choices live in `<board-root>/dashboard-prefs.json`. A missing or malformed file means all sections expanded. Failed writes leave the current UI usable and report that the preference could not be saved.
- Folding is display-only: no session status, archive state, or runner state changes.

The feature branch includes the scrolling fixes from PR #226. The same viewport follows selected headers and sessions; selection positions are recorded structurally during rendering rather than inferred from user-visible text.

## Automated coverage

- `test/dashboard-prefs.test.mjs`: normalization, read/write roundtrips, malformed files, board-root isolation, failed writes.
- `test/dashboard-fold.test.mjs`: real dashboard key handling, header action safety, persistence, all-folded and empty boards, wraparound, resizing, search, multi-select, Peek, polling/state changes, and preference-write failure.
- Its `dashboard-tui-modes.ts` probe uses **both actual Pi TUI renderers**, `TuiMainScreen` and `TuiAltScreen`, with the same full-size overlay options as the command. Input travels through the TUI's terminal callback; rendered ANSI output is replayed into `@xterm/headless` and checked for visible selection and stale folded rows. It covers fold/unfold, differential repaint, resizing, no-running layouts, overlay recreation, and a disappearing section.
- `test/dashboard-navigation.test.mjs`: selection remains visible at both viewport boundaries and short terminal heights; the first section/folder headings remain reachable without a Running section.
- Existing attach mouse-mode and paste tests separately exercise regular/fullscreen ownership and input differences. These are not a substitute for the real-renderer folding checks.

Run the focused tests with:

```sh
node --test test/dashboard-*.test.mjs test/ui-smoke.test.mjs
```

`npm run verify` remains the complete project gate.

## Short manual check

Automated renderer/emulator tests cannot fully model terminal fonts, key negotiation, tmux passthrough, clipboard integration, or terminal-specific image handling. A brief manual test is still worthwhile.

Keep terminal application and window size fixed. Try one mode at a time without changing persisted settings:

```sh
pi --tui-mode regular
pi --tui-mode fullscreen
```

In each mode:

1. Open `/agent-board` with enough rows to overflow, ideally across multiple folders.
2. Fold Done and On hold with Tab. Verify counts remain and Up/Down never select hidden rows.
3. Re-expand through the header using Tab, Enter, or Right.
4. Navigate to the true top with nothing Running, then while something is Running.
5. Resize the window while scrolled; look for hidden selection, duplicate rows, or stale text.
6. Close/reopen the board, and attach/detach a session. Verify fold choices survive.
7. Search for a folded session, then clear the filter; the saved fold should return.

Only after that, repeat the failing case inside tmux. If something fails, record Pi version, TUI mode, terminal application/version, tmux presence/version, dimensions, and the shortest reproduction. This isolates variables rather than testing every combination at once.
