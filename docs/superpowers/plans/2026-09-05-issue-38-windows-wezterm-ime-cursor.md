# Issue #38 Windows WezTerm IME Docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document that Windows WezTerm attach sessions need a visible hardware cursor (`PI_HARDWARE_CURSOR=1` / `"showHardwareCursor": true`) for IME candidate tracking.

**Architecture:** One new Troubleshooting subsection in README.md, placed after "### Attach is slow or keeps reconnecting".

**Tech Stack:** Markdown only.

## Global Constraints

- Docs-only: README.md is the only non-process file touched (spec A2).
- Both fixes documented with scope guidance; cosmetic trade-off stated.
- No upstream comment on earendil-works/pi#5200 (owner's voice).

**Execution mode:** inline (executing-plans).

---

### Task 1: Add the Troubleshooting subsection

**Files:**
- Modify: `README.md` (Troubleshooting section, after the "### Attach is slow or keeps reconnecting" block)

- [ ] **Step 1: Insert the subsection**

Insert after the "### Attach is slow or keeps reconnecting" paragraph, before "### Start & attach falls back to background":

```markdown
### IME candidate window is stuck at the window edge (Windows WezTerm)

On Windows WezTerm with a WSL2 backend, the IME candidate window may stay
pinned to the right edge instead of following the text cursor in an attached
session. Windows WezTerm only tracks the IME candidate position from the
visible hardware cursor, and Pi hides the hardware cursor by default — the
block cursor you see in the editor is drawn content, not the hardware cursor.
Linux terminals are not affected.

Make the hardware cursor visible, either way:

```bash
export PI_HARDWARE_CURSOR=1    # machine-local, e.g. ~/.zshrc.local
```

or set `"showHardwareCursor": true` in Pi's `settings.json` (syncs across
machines if the config is version-controlled; harmless on Linux).

Trade-off: the real terminal cursor becomes visible inside the TUI. This is
cosmetic only.
```

- [ ] **Step 2: Verify A1 (content presence)**

Run: `grep -n "PI_HARDWARE_CURSOR=1\|showHardwareCursor\|IME candidate window is stuck" README.md`
Expected: 3+ hits inside the Troubleshooting section.

- [ ] **Step 3: Verify A2 (scope)**

Run: `git diff main --stat`
Expected: README.md + process docs under docs/superpowers/ only.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: Windows WezTerm IME needs a visible hardware cursor (issue #38)"
```

## Self-Review

- Spec coverage: A1 (Step 2), A2 (Step 3). Covered.
- Placeholder scan: full markdown shown.
