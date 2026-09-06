# Spec: issue #38 — document Windows WezTerm IME hardware-cursor requirement

## Problem

With #24/#28 shipped (v0.4.3), the IME candidate window is pinned and
flicker-free on Linux (WezTerm + fcitx5/X11). On **Windows WezTerm (WSL2
backend)** the candidate window stays stuck at the right edge: per upstream
earendil-works/pi#5200, Windows WezTerm only updates the IME candidate
position when the **hardware cursor is visible**, and pi-tui hides it by
default. The visible block cursor in the editor is a fake (reverse-video
content), so "I can see the cursor" does not imply the hardware cursor is on.

Fix (verified on the real environment, per the issue): `PI_HARDWARE_CURSOR=1`
env or `"showHardwareCursor": true` in pi's settings.json. Trade-off: the
real terminal cursor becomes visible in the TUI (cosmetic only; harmless on
Linux).

## Decision

Add one Troubleshooting subsection to README.md:

- Title: IME candidate window stuck at the right edge (Windows WezTerm)
- Content: symptom + platform scope (Windows WezTerm → WSL2, Windows IME/TSF;
  Linux unaffected), root cause in one sentence (hardware cursor hidden by
  default; Windows WezTerm needs it visible to track IME position; the editor
  block cursor is fake content, not the hardware cursor), both fixes with
  sync/scope guidance (machine-local env vs synced settings.json), and the
  cosmetic trade-off.

Placement: after "### Attach is slow or keeps reconnecting" (IME is an
attach-surface concern, keeps related attach topics adjacent).

## Non-goals

- No code changes.
- No upstream comment on earendil-works/pi#5200 (owner's voice, left to the
  repo owner — noted in the issue comment).

## Acceptance matrix

| ID | Feature point | Acceptance | Concrete verification | Pass criteria |
|----|---------------|------------|----------------------|---------------|
| A1 | Troubleshooting entry exists with both fixes | Automated (static) | grep README.md for the new section + `PI_HARDWARE_CURSOR=1` + `showHardwareCursor` | All three present in the Troubleshooting section |
| A2 | Scope: docs-only change | Automated (static) | `git diff main --stat` | Only README.md (plus process docs under docs/superpowers/) |

## Testability split design

Docs-only: verification is content presence + scope, no behavioral seam.
