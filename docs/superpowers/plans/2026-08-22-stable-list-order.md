# Stable List Order Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard list order stable — rows must never reshuffle while sessions are running, so the cursor never loses its target (issue #20).

**Architecture:** Replace activity-time sort keys with fixed creation-time keys. `lastActivityAt` stays in `RowView` for the "3s ago" display only, never for ordering. Rows sort by `pinned desc → createdAt asc → id asc`; folders sort by `pinned desc → min(createdAt) asc → name asc`, so a folder's position is anchored by its first-created row and doesn't jump when any row inside gets busy. New sessions append at the bottom (createdAt ascending).

**Tech Stack:** Node 20+, ESM JavaScript (`.mjs` core), `node --test` test runner, no new dependencies.

## Global Constraints

- No new npm dependencies.
- All commits in this worktree branch `issue-20-stable-list-order`; never touch `main` checkout.
- `git add` per-file; never `git add -A`.
- Commit messages in English, conventional-commits format, reference `issue #20`.
- `npm run verify` (typecheck + tests + pack dry-run) must pass before the PR.

---

### Task 1: Stable row sort in `sortRowViews`

**Files:**
- Modify: `src/core/rows.mjs` (function `sortRowViews`)
- Test: `test/rows.test.mjs`

- [x] Add `createdAt` to `RowView` typedef and `rowView()` output (fallback `meta.updatedAt ?? 0`).
- [x] Change sort keys to `pinned desc → createdAt asc → id asc`.
- [x] Update `groupRows` doc comment ("pinned first, then creation order").
- [x] Rewrite `groupRows sorts pinned first then recent` test → creation order, plus new regression test `groupRows ignores activity recency so order stays stable`.

### Task 2: Stable folder sort in `groupRowsByFolder`

**Files:**
- Modify: `src/core/rows.mjs` (function `groupRowsByFolder`)
- Test: `test/rows.test.mjs`

- [x] Folder key `lastActivityAt` → `createdAt`, computed as `Math.min` over folder rows (first-created row anchors the folder).
- [x] Folder sort keys → `pinned desc → createdAt asc → name asc`; update JSDoc return type.
- [x] Update `groupRowsByFolder nests rows by folder inside each stage` expectations, plus new regression test `groupRowsByFolder keeps folder order stable regardless of activity`.

### Task 3: Verify

- [x] `node --test test/rows.test.mjs` — 18 pass.
- [x] `npm run verify` — typecheck + full suite (200 pass) + pack dry-run.

## Non-goals

- Display of relative age ("3s ago") unchanged — still activity-based.
- State-group order (`GROUP_ORDER`) unchanged — already fixed.
- No reordering of the roster on disk; ordering is a pure view-model concern.
