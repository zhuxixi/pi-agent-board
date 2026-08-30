# Pi Agent Board

<p align="center">
  <img src="https://raw.githubusercontent.com/zhuxixi/pi-agent-board/main/assets/banner.png" alt="Pi Agent Board" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/zhuxixi/pi-agent-board/blob/main/assets/demo.mp4"><strong>30s demo</strong></a>
  | <a href="https://pi.dev/packages?name=@zhuxixi/pi-agent-board">Pi package gallery</a>
  | <a href="https://www.npmjs.com/package/@zhuxixi/pi-agent-board">npm</a>
</p>

Pi Agent Board is a full-screen TUI dashboard for [Pi](https://github.com/earendil-works/pi-mono) that manages durable background Pi sessions. Use one global board to dispatch work across projects, watch progress, triage summaries and evidence, reply without opening a transcript, and attach to a real interactive session when hands-on work is needed.

## What It Does

- Run several Pi tasks at once without losing track of their current state.
- Keep each task as a real, resumable Pi session that survives `/reload`, closing Pi, or restarting the terminal.
- Triage the latest output, blockers, evidence, and diagnostics before opening a full transcript.
- Reply to a session without attaching; replies sent while a session is busy are preserved for later delivery.
- Fall back to a JSON runner for eligible background work when live PTY support is unavailable.

> **Write-safety note:** Worktree isolation is currently disabled. Multiple sessions in the same repository may run concurrently, so avoid overlapping writes or provide your own isolation.

## Requirements

- [Pi](https://github.com/earendil-works/pi-mono) installed and working.
- Node.js 20 or newer.
- Working Pi provider authentication for real model execution. Agent Board does not have a separate login or credential store.
- PTY support from `node-pty` for live attach and **start & attach**. Background work can use a JSON-runner fallback when PTY support is unavailable.

If rows remain in `Running`, first verify that Pi itself can complete a one-shot model call:

```bash
pi --mode json -p --no-session "Reply with exactly: DONE"
```

A healthy command emits an assistant `message_end`, then an `agent_end` event, and exits. See [VERIFY.md](VERIFY.md) for the complete no-auth, provider-auth, and PTY checks.

## Install

### Published package

```bash
pi install npm:@zhuxixi/pi-agent-board
```

Start Pi normally and run `/agent-board`, or use one of the startup entry points below.

### Local checkout

```bash
npm install
pi install "$(pwd)"
```

This installs the current checkout as a Pi package. Remove that path installation with:

```bash
pi remove "$(pwd)"
```

### Development auto-discovery

To have Pi load the checkout directly while developing:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/agent-board
pi
```

Remove the symlink when you no longer want Pi to auto-load the checkout:

```bash
rm ~/.pi/agent/extensions/agent-board
```

## Quick Start

Open the board with `/agent-board` inside Pi, then:

1. Press `i` to enter INSERT mode.
2. Type a task.
3. Press `Enter` to open the **Start session** dialog.
4. Review or change the working directory (`cwd`), model, thinking level, and action.
5. Press `Enter` on **Start session** to launch the task.

With a draft in the input, `Enter` opens **Start session**; with an empty input, `Enter` attaches/resumes the selected session. The row starts in `Queued`, then moves through `Running` to a terminal state such as `Needs answer`, `Needs instructions`, `Done`, `Failed`, or `Stopped`.

From the board:

- Press `Space` to peek at the selected session's summary, blocker, and latest output.
- In Peek, press `r` to reply without attaching.
- Press `v` for a read-only transcript, or `e` for evidence and diagnostics.
- Press `Enter`, `Right`, or `>` to attach to the real Pi session.
- In PTY attach mode, press `Left` or `Ctrl+]` to return to the board.

## Dashboard Workflow

The dashboard has two input modes:

- **Normal mode** owns dashboard shortcuts such as navigation, peek, attach, and filtering.
- **INSERT mode** owns text editing. Press `i` before typing or pasting a task; `/` is literal while editing a prompt.

When you submit a task, the **Start session** dialog lets you review:

- `cwd`: an existing-directory picker with usage-ranked favorites, filesystem browsing, and Tab completion;
- `model`: models available to Pi, including models scoped by the current directory's Pi settings;
- `thinking`: a level supported by the selected model;
- `action`: **start in background** or **start & attach**.

Launch preferences are persisted and reused for later sessions. **Start & attach** requires PTY support; if PTY is unavailable, Agent Board launches the session in the background and shows a warning instead.

Session actions are deliberately confirmation-aware:

- `d` confirms moving an inactive session to **Done**. Manual completion is the default.
- Press `Ctrl+X` twice quickly to archive/delete the selected row. Archiving removes the row from the board but preserves its underlying Pi session file.
- `X` archives inactive rows in the selected state; live work is skipped.
- `m` enters multi-select mode. Use `Space` to toggle rows, `a` to select all visible rows, `u` to clear the selection, `d` to mark inactive rows Done, or `Ctrl+X` to delete selected Done rows.

## Views and Actions

Shortcuts are scoped to the view where they are available:

### Main list

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move the selection. |
| `i` | Enter INSERT mode for a new task. |
| `Enter` | Open Start session for a draft, or attach/resume when the input is empty. |
| `Right` / `>` | Attach to the selected session. |
| `Space` | Open Peek. |
| `v` | Open the read-only transcript. |
| `e` | Open Evidence / Diagnostics. |
| `/` | Enter filter mode. |
| `Ctrl+N` | Open a new-session dialog with a pre-filled prompt. |
| `Ctrl+R` | Rename the selected session. |
| `Ctrl+T` | Pin or unpin the selected session. |
| `Ctrl+S` | Stop the selected active session. |
| `d` | Confirm marking the selected inactive session Done. |
| `Ctrl+X` twice quickly | Archive/delete the selected row. |
| `X` | Delete inactive rows in the selected state. |
| `m` | Enter multi-select mode. |
| `!` | Open node-pty diagnostics and repair hints. |
| `?` | Open the help overlay. |
| `Esc` | Clear a draft, or exit when the input is empty. |

### Peek

Peek shows the selected session's summary, blocker or question, latest output, and available issue/PR references.

| Key | Action |
| --- | --- |
| `r` or `Enter` | Enter reply mode and send a follow-up without attaching. |
| `a`, `Right`, or `>` | Attach to the session. |
| `v` | Open the read-only transcript. |
| `e` | Open Evidence / Diagnostics. |
| `Up` / `Down` | Move to the previous or next session. |
| `Esc` | Return to the main list. |

When a Pi question or questionnaire tool is pending, inline reply is rejected; attach to answer that interactive question in the real Pi session.

### Transcript

The `v` view is a read-only projection of the durable Pi session JSONL. It does not interrupt a running worker.

| Key | Action |
| --- | --- |
| `Up` / `Down` | Scroll one line. |
| `PageUp` / `PageDown` | Scroll one page. |
| `Space` | Open Peek. |
| `r` | Enter reply mode. |
| `Enter` or `a` | Attach to the session. |
| `e` | Open Evidence / Diagnostics. |
| `d` | Confirm marking the inactive session Done. |
| `Left` / `Esc` / `<` | Return to the main list. |

### Evidence / Diagnostics

The `e` view shows durable session evidence, including changed files, commands and their outcomes, command output previews, assistant evidence, errors, diagnostics, and artifact paths. Press `x` to clear diagnostics while preserving the evidence artifacts.

| Key | Action |
| --- | --- |
| `Up` / `Down` | Scroll one line. |
| `PageUp` / `PageDown` | Scroll one page. |
| `r` | Enter reply mode. |
| `v` | Open the read-only transcript. |
| `Enter`, `a`, or `Right` | Attach to the session. |
| `x` | Clear diagnostics; evidence is preserved. |
| `Left` / `Esc` / `<` | Return to the main list. |

### PTY attach

PTY attach opens the real interactive Pi session. Use `Left` or `Ctrl+]` to detach and return to the board. While attached, `PageUp`, `PageDown`, `Home`, `End`, and the mouse wheel scroll local scrollback. Mouse drag or double-click selects and copies text, clicks open detected links, and middle-click paste is available on systems with the required X11 tooling.

The attach surface can forward terminal clipboard and image/file passthrough sequences. These behaviors can be disabled individually in [Configuration](#configuration). Cold hosts may briefly show a loading/reconnect surface while their PTY becomes ready.

## States, Grouping, and Filters

Agent Board separates a session's semantic task state from whether a worker process is currently alive. An exited worker can therefore leave a durable row that is still resumable or attachable.

| Display state | Meaning |
| --- | --- |
| **Queued** | A run has been scheduled but has not started processing. |
| **Running** | The session is actively processing. |
| **Needs answer** | The session is waiting for user input or an answer to a question. |
| **Needs instructions** | The run ended without being marked complete and needs the next directive. |
| **Done** | The user marked the inactive session complete; this is the default completion path. |
| **Failed** | The worker or host ended with an error. |
| **Stopped** | The user stopped the active work. |

Rows are grouped by state. When a state contains sessions from multiple directories, rows are grouped by folder within that state. Pinned rows and folders come first, then creation order remains stable; activity does not reshuffle the list. New agent activity is marked unread with stronger row glyphs and header/footer counts. Replies sent while a session is busy enter a durable FIFO follow-up queue and are delivered when the session is ready; a `qN` badge shows queued follow-ups.

Press `/` to enter filter mode. Filter tokens are case-insensitive and can be combined with free-text terms:

```text
s:running
review:ready
diag:stalled
evidence:error
queued:true
steer:awaiting-approval
```

- `s:<state>` matches a state prefix, including display-label aliases such as `needs-answer`.
- `review:ready` finds sessions with review-ready evidence.
- `evidence:error` finds sessions whose evidence contains errors.
- `queued:true` (also `yes` or `1`) finds sessions with queued follow-ups.
- `steer:<state>` filters by a persisted steering state.
- Bare words match name, summary, and working directory; multiple words use AND matching.

`diag:stalled` can consume persisted stalled diagnostics, but the current runner does not provide a general provider-stall detector. It should not be read as a complete automatic stall-detection feature.

## Evidence and Code References

Evidence is collected locally from session events. Agent Board can extract issue and pull-request references from that evidence and show badges such as `#40` or `▸#45` on rows; Peek includes the provider, confidence, source, and URL when available. Built-in GitHub/GitLab-style providers are available, and an optional per-store `providers.json` can extend the provider rules. The `AGENT_BOARD_CODE_REFS=off` setting disables extraction.

## Attach and Fallback Behavior

When PTY support is healthy, Agent Board uses an interactive PTY host for attach and start-and-attach. If PTY support is unavailable, eligible managed sessions can still run in the background through the JSON runner; start-and-attach falls back to background launch with a warning. Adopted external foreground sessions require PTY to continue safely. Press `!` in the dashboard for diagnosis and repair hints.

On Windows, PTY host control uses a named pipe and spawned child console windows are hidden. Terminal behavior can still vary between terminal emulators.

## Entry Points

| Entry point | What it does |
| --- | --- |
| `/agent-board` | Opens the dashboard from an interactive Pi session. Use this command path to attach to managed sessions. |
| `pi /agent-board` | Starts Pi by invoking the dashboard command. Quitting the standalone dashboard shuts down Pi instead of dropping into a normal chat session. |
| `pi --agent-board` | Opens the dashboard through the extension startup flag. This startup path cannot attach to a managed session; use `/agent-board` from a normal Pi session for attach. |
| `/bg [prompt]` | Adopts the current interactive Pi session into Agent Board. An optional prompt is added to its follow-up queue before the dashboard opens. |

The board is global across projects by default. Rows are stored under `~/.pi/agent/agent-board/`; archiving a row removes it from the board but preserves the underlying Pi session file.

## Configuration

Useful environment variables:

| Variable | Use |
| --- | --- |
| `AGENT_BOARD_ROOT` | Store location. Defaults to `~/.pi/agent/agent-board/`. |
| `AGENT_BOARD_AUTO_STATE=off` | Disable automatic terminal-state moves. |
| `AGENT_BOARD_AUTO_STATE_MODEL=<model>` | Model for classifying finished turns. Defaults to `gpt-4o`; use `off` for heuristic-only. |
| `AGENT_BOARD_AUTO_STATE_NO_DONE` | Disables automatic `completed` classification (default: enabled). Set to `0`/`false`/`off`/`no` to restore auto-done. |
| `AGENT_BOARD_CODE_REFS=off` | Disable issue/PR badge extraction from session evidence. |
| `AGENT_BOARD_SUMMARY_MODEL=<model>` | Model for short row summaries. Defaults to `gpt-4o`; use `off` to disable. |
| `AGENT_BOARD_TITLE_MODEL=<model>` | Model for generated session titles. Defaults to `openai-codex/gpt-5.5`; use `off` to disable. |
| `AGENT_BOARD_TITLE_THINKING_LEVEL=<level>` | Thinking level for title generation. Defaults to `low`; use `off` to omit it. |
| `AGENT_BOARD_DISABLE_PTY=1` | Disable PTY attach mode. |
| `AGENT_BOARD_IME_FIX=0` | Disable the IME cursor-rect coalescer (issue #28). The coalescer folds pi-tui's per-frame cursor-park writes into the frame's synchronized-output block so terminals report one stable IME cursor position per frame instead of two (candidate-window flicker in busy sessions). |
| `AGENT_BOARD_FORCE_PTY=1` | Force PTY attach mode. |
| `AGENT_BOARD_ATTACH_MOUSE=0` | Disable attach-view mouse handling and use terminal-native selection. |
| `AGENT_BOARD_WHEEL_LINES=<1-50>` | Lines scrolled per mouse-wheel event in attach view. Defaults to `1`. |

Legacy `AGENT_VIEW_*` variables are still honored for migration.

If the board reports `node-pty unavailable`, press `!` in the dashboard for diagnosis and fix steps.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run test:coverage
npm run pack:dry
```

Run all checks with:

```bash
npm run verify
```

`npm run verify` runs typecheck, tests, coverage, and a dry npm pack.

### QA baseline

Every push and PR runs the same checks in CI (`.github/workflows/ci.yml`, Node 22 + 24),
and `main` branch protection requires both CI checks to pass before merging.

Coverage is enforced by `c8` with thresholds configured in `.c8rc.json`
(lines ≥ 85%, functions ≥ 80%, branches ≥ 70%). The TS UI layer
(`src/ui/*.ts`, `src/commands/*.ts`) is covered by a smoke test
(`test/ui-smoke.test.mjs`) that constructs and renders the real entrypoints;
it is excluded from the coverage thresholds by design.

Run `npm run verify` locally before submitting changes; CI is the authoritative source for the current test and coverage results.

## Publish

Before publishing a new release, bump the package version, run verification, then publish:

```bash
npm run verify
npm version patch
npm publish
```

If the version is already bumped, skip `npm version patch`.

Use `npm version minor` or `npm version major` instead when the release warrants it. After publish, users install with:

```bash
pi install npm:@zhuxixi/pi-agent-board
```

The Pi package gallery uses the `pi.video` and `pi.image` URLs from `package.json`.
