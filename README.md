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
- In PTY attach mode, press `Left` on an empty child input line to return to the board. `Ctrl+]` is not a detach key — it is passed through to the child Pi editor. When the host is disconnected, `Left` always exits.

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
| `Ctrl+N` | Enter INSERT mode with a pre-filled `hello` prompt; press `Enter` to open the Start session dialog. |
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
| `r` or `Enter` | Enter reply mode; type a follow-up and press `Enter` to send it without attaching. |
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

PTY attach opens the real interactive Pi session. On an empty child input line, use `Left` to detach and return to the board; while you are editing text, `Left` is forwarded to the Pi editor, and a disconnected host can always be exited with `Left`. `Ctrl+]` is not a detach key — it is passed through to the child Pi editor. While attached, `PageUp`, `PageDown`, `Home`, `End`, and the mouse wheel scroll local scrollback. Mouse drag or double-click selects and copies text, clicks open detected links, and middle-click paste is available on systems with the required X11 tooling.

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

For internal code platforms (non-github/gitlab hosts) or custom CLIs, add a per-store `providers.json` so claim/action rules exist and sessions stop depending on the low-confidence mention fallback. Example — an internal CLI (`acli`) with claim-strength issue rules:

```json
{
  "providers": [
    {
      "name": "acode",
      "hosts": ["acode.internal.example.com"],
      "rules": [
        { "pattern": "acli\\s+issue\\s+update\\s+#?(\\d+)(?=[\\s\\S]*--assignee)", "kind": "issue", "strength": "claim" },
        { "pattern": "acli\\s+issue\\s+(?:note|comment|close)\\s+#?(\\d+)", "kind": "issue", "strength": "action" },
        { "pattern": "acli\\s+issue\\s+(?:show|view)\\s+#?(\\d+)", "kind": "issue", "strength": "view" }
      ]
    }
  ]
}
```

`hosts` matches the repo's remote host; rules follow the same `pattern`/`kind`/`strength` shape as the built-in `gh`/`glab` tables (`strength`: `claim` > `action` > `view`), and the `#N` capture group supplies the number. Validation errors from a broken file surface in the diagnostics panel and never break extraction — an invalid file is simply ignored.

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

## Persistence, Safety, and Limitations

Agent Board stores its durable roster and per-session artifacts under `~/.pi/agent/agent-board/` by default. Set `AGENT_BOARD_ROOT` to use another location. The store includes the roster, launch preferences, per-session metadata and state, Pi session JSONL, run status/events, evidence, diagnostics, and (for PTY hosts) a replayable screen log.

Rows and session history survive Pi reloads, Pi restarts, and worker exits. When the dashboard opens, it reconciles stale runner or host records and keeps resumable sessions visible. Archiving a row removes it from the board but does not delete its underlying Pi session file.

> **Worktree isolation is currently disabled.** Agent Board does not automatically create or manage Git worktrees. Multiple sessions in the same repository may run concurrently, so avoid overlapping writes or provide your own isolation before starting parallel coding tasks.

Other current limitations:

- Agent Board runs locally; it does not provide cloud execution, multi-user coordination, or shared dashboards.
- Real model output still depends on Pi provider authentication and network access.
- The `--agent-board` startup path opens the dashboard but cannot attach to a managed session; use `/agent-board` from a normal Pi session for attach.
- Pending Pi question or questionnaire tools must be answered in the attached interactive session; inline reply is rejected while one is pending.
- PTY-dependent features require a working `node-pty` installation. Background work can use the JSON-runner fallback when PTY is unavailable, but start & attach then becomes background-only.

## Configuration

Set these variables before starting Pi. Model-backed features fall back gracefully where noted, so disabling them does not prevent the core dashboard from working.

| Variable | Default / values | Purpose |
| --- | --- | --- |
| `AGENT_BOARD_ROOT` | `~/.pi/agent/agent-board/` | Override the durable store location. |
| `AGENT_BOARD_AUTO_STATE` | enabled; `off` disables | Enable automatic terminal-state refinement after a turn. |
| `AGENT_BOARD_AUTO_STATE_MODEL` | `gpt-4o`; `off` uses heuristics | Model for classifying the terminal state of a finished turn. |
| `AGENT_BOARD_AUTO_STATE_NO_DONE` | unset = manual Done; `0`, `false`, `off`, or `no` restores auto-Done | Keep completion manual by default, or restore automatic `Done` classification. |
| `AGENT_BOARD_SUMMARY_MODEL` | `gpt-4o`; `off` disables | Generate short row summaries. Heuristic summaries remain available as a fallback. |
| `AGENT_BOARD_TITLE_MODEL` | `openai-codex/gpt-5.5`; `off` disables | Generate a short session title after dispatch. The initial slug remains if generation fails. |
| `AGENT_BOARD_TITLE_THINKING_LEVEL` | `low`; `off` omits the option | Thinking level used by title generation. |
| `AGENT_BOARD_CODE_REFS` | enabled; `off` disables | Extract issue/PR badges from session evidence. |
| `AGENT_BOARD_DISABLE_PTY` | unset; `1` disables | Disable PTY host and attach mode. |
| `AGENT_BOARD_FORCE_PTY` | unset; `1` forces the PTY path | Force the PTY availability path when diagnosing or controlling fallback behavior. |
| `AGENT_BOARD_ATTACH_MOUSE` | enabled; `0`, `off`, or `false` disables | Disable attach-view mouse handling and use terminal-native selection instead. |
| `AGENT_BOARD_ENABLE_MOUSE_SCROLL` | enabled; `0` disables | Compatibility switch to disable attach-view mouse scrolling. |
| `AGENT_BOARD_WHEEL_LINES` | `1`, clamped to `1..50` | Lines scrolled per mouse-wheel event in attach view. |
| `AGENT_BOARD_MAX_WARM_HOSTS` | `4`, clamped to `0..50` | Maximum number of idle PTY hosts retained for faster attach. |
| `AGENT_BOARD_WARM_HOST_TTL_MS` | `600000` (10 minutes); `0` disables TTL eviction | How long an idle warm host may remain before it is evicted. |
| `AGENT_BOARD_ATTACH_NATIVE_PASTE` | enabled; `0` disables | Disable X11 PRIMARY selection copy and middle-click paste integration. |
| `AGENT_BOARD_FORWARD_OSC52` | enabled; `0` disables | Disable OSC 52 clipboard sequence forwarding from an attached session. |
| `AGENT_BOARD_FORWARD_IMAGES` | enabled; `0` disables | Disable terminal image/file passthrough forwarding from an attached session. |
| `AGENT_BOARD_IME_FIX` | enabled; `0` disables | Disable the attach-view IME cursor coalescer if your terminal has compatibility problems. |

Older `AGENT_VIEW_*` names are still read in selected compatibility paths. Prefer `AGENT_BOARD_*` for new setups. Internal child markers are managed by Agent Board and are not user settings.

The `providers.json` file under the configured store root can extend the built-in issue/PR reference providers; see the [Evidence and Code References](#evidence-and-code-references) section for the feature overview.

## Troubleshooting

### Rows stay in `Running`

First verify that Pi itself can complete a one-shot model call:

```bash
pi --mode json -p --no-session "Reply with exactly: DONE"
```

The command should emit an assistant reply, then an `agent_end` event, and exit. If it hangs before the assistant reply, fix Pi provider authentication or network access first. Agent Board cannot produce live model results until Pi works independently.

### `node-pty unavailable`

Press `!` in the dashboard to open the diagnostic panel and follow its repair hints. Common causes include a missing native `node-pty` binary, a Node/architecture mismatch, a missing or non-executable macOS `spawn-helper`, or macOS quarantine. You can temporarily set `AGENT_BOARD_DISABLE_PTY=1` to use background JSON-runner behavior where supported.

### Attach is slow or keeps reconnecting

A cold PTY host may briefly show a loading or reconnecting surface while it starts. Check the PTY status in the dashboard with `!`; stale hosts are diagnosed separately from active task workers. If the host never becomes healthy, repair `node-pty` or use background mode for eligible managed sessions.

### IME candidate window is stuck at the window edge (Windows WezTerm)

On Windows WezTerm with a WSL2 backend, the IME candidate window may stay pinned to the right edge instead of following the text cursor in an attached session. Windows WezTerm only tracks the IME candidate position from the visible hardware cursor, and Pi hides the hardware cursor by default — the block cursor you see in the editor is drawn content, not the hardware cursor. Linux terminals are not affected.

Make the hardware cursor visible, either way:

```bash
export PI_HARDWARE_CURSOR=1    # machine-local, e.g. ~/.zshrc.local
```

or set `"showHardwareCursor": true` in Pi's `settings.json` (syncs across machines if the config is version-controlled; harmless on Linux).

Trade-off: the real terminal cursor becomes visible inside the TUI. This is cosmetic only.

### Start & attach falls back to background

Start & attach requires PTY support. When PTY is unavailable, the task is still dispatched in the background and the dashboard displays a warning. Repair PTY and retry attach from the normal `/agent-board` command path.

### Inline reply is rejected

A pending Pi question or questionnaire requires the real interactive session. Attach to the row and answer it there; ordinary replies can be sent from Peek and are queued while a session is busy.

### Sessions in the same repository conflict

Worktree isolation is not enabled. Stop overlapping writers, separate their working directories, or create and manage Git worktrees yourself before running concurrent coding tasks.

See [VERIFY.md](VERIFY.md) for no-auth checks, extension loading checks, provider checks, persistence checks, and the manual dashboard flow.

## Development

For local development:

```bash
npm install
npm run verify
```

`npm run verify` runs typecheck, tests, coverage, and a package dry-run. The same checks run in CI on Node 22 and Node 24. See [VERIFY.md](VERIFY.md) for the full verification checklist and known environment-dependent limitations.

## Publishing

Before publishing a release, verify the package, bump the version, and publish it:

```bash
npm run verify
npm version patch
npm publish
```

Use `npm version minor` or `npm version major` when appropriate. If the version is already bumped, skip `npm version patch`. After publishing, users install the scoped package with:

```bash
pi install npm:@zhuxixi/pi-agent-board
```

The Pi package gallery uses the `pi.video` and `pi.image` URLs from `package.json`.

## Further Reading

- [Manual verification](VERIFY.md) — static checks, Pi loading, provider authentication, persistence, and dashboard flows.
- [Product requirements](PRD.md) — original product scope and design context.
- [Progress log](PROGRESS.md) — implementation checkpoints and known environment notes.
- [Exploration notes](docs/EXPLORATION.md) — Pi API and integration research.
