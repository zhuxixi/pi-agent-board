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

A healthy command emits an assistant reply, then an `agent_end` event, and exits. See [VERIFY.md](VERIFY.md) for the complete no-auth, provider-auth, and PTY checks.

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

1. Open the board with `/agent-board` inside Pi.
2. Press `i` to enter INSERT mode.
3. Type a task and press `Enter`.
4. In the **Start session** dialog, review or change the working directory (`cwd`), model, thinking level, and action.
5. Press `Enter` on **Start session** to launch the task.

The row starts in `Queued`, then moves through `Running` to a terminal state such as `Needs answer`, `Needs instructions`, `Done`, `Failed`, or `Stopped`.

From the board:

- Press `Space` to peek at the selected session's summary, blocker, and latest output.
- In Peek, press `r` to reply without attaching.
- Press `v` for a read-only transcript, or `e` for evidence and diagnostics.
- Press `Enter`, `Right`, or `>` to attach to the real Pi session.
- In PTY attach mode, press `Left` or `Ctrl+]` to return to the board.

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

Current baseline: 300+ tests, ~92% line coverage on the core modules.

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
