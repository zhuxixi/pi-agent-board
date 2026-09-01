# pty-attach.ts Legacy Quality Debt Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the 10 legacy quality issues in `src/ui/pty-attach.ts` flagged by issue #8 — document 9 intentional empty catches, add a SAFETY comment to 1 as-cast, drop 1 unused parameter. Zero behavior change.

**Architecture:** Single-file comment/signature cleanup. Empty catches are expanded to the repo's documented-catch house style (see `dashboard.ts` precedent); the as-cast gets an invariant comment; `project()` loses its unused `width` parameter. Existing test suite is the regression net — no new tests (no behavior change to test).

**Tech Stack:** TypeScript (strict), `node --test`, tab indentation.

**Spec:** `docs/superpowers/specs/2026-08-30-pty-attach-quality-debt-design.md`

## Global Constraints

- Touch ONLY `src/ui/pty-attach.ts` (plus this plan file's checkboxes).
- Zero behavior change: no logic added/removed except the parameter deletion and its call-site argument.
- Indentation is TABS. Comment style: expand `} catch {}` to multi-line with the comment INSIDE the braces, exactly like `dashboard.ts` (`} catch {` / `\t/* best effort: ... */` / `}`).
- Locate sites by method name, not line number (lines drift).
- `git add` per file only; NEVER `git add -A` (main checkout has untracked files that must not be swept — the worktree is clean, but keep the habit).
- Run all commands from the worktree root: `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-8-pty-attach-quality-debt`

---

### Task 1: Document the 9 empty catches + the as-cast invariant

**Files:**
- Modify: `src/ui/pty-attach.ts` (9 catch sites + 1 as-cast site, by method)

**Interfaces:** none changed (comments only).

There are exactly 9 single-line `} catch {}` sites in the file. Each becomes a 3-line documented catch. The edits, by method (old → new). Match surrounding context exactly; indentation is tabs.

1. `enableMouseScroll()` — inside `try { this.tui.terminal.write(XTSHIFTESCAPE_SELECT); this.tui.terminal.write(MOUSE_ENABLE); }`:

```ts
// OLD
		} catch {}
	}

	private mouseScrollEnabled(): boolean {
// NEW
		} catch {
			/* best-effort: some terminals reject these sequences; mouse reporting is optional */
		}
	}

	private mouseScrollEnabled(): boolean {
```

2. `disableMouseScroll()`:

```ts
// OLD
	private disableMouseScroll(): void {
		try {
			this.tui.terminal.write(MOUSE_DISABLE);
		} catch {}
	}
// NEW
	private disableMouseScroll(): void {
		try {
			this.tui.terminal.write(MOUSE_DISABLE);
		} catch {
			/* best-effort: terminal may already be gone at teardown */
		}
	}
```

3. `copySelectionToClipboard()` — the OSC52 write:

```ts
// OLD
		if (seq) {
			try {
				this.tui.terminal.write(seq);
			} catch {}
		}
// NEW
		if (seq) {
			try {
				this.tui.terminal.write(seq);
			} catch {
				/* best-effort: OSC52 clipboard support is optional */
			}
		}
```

4. `pastePrimarySelection()` — inner timer kill:

```ts
// OLD
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, 800);
// NEW
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* the child may have already exited before the timeout fired */
				}
			}, 800);
```

5. `pastePrimarySelection()` — outer catch, at end of method (the `} catch {}` right before the method's closing `}`):

```ts
// OLD
			child.on("close", () => {
				clearTimeout(timer);
				if (!this.closed && out) this.send({ type: "input", data: out });
			});
		} catch {}
	}
// NEW
			child.on("close", () => {
				clearTimeout(timer);
				if (!this.closed && out) this.send({ type: "input", data: out });
			});
		} catch {
			/* silent no-op when xclip is absent — documented contract of this helper */
		}
	}
```

6. `writePrimarySelection()`:

```ts
// OLD
			child.stdin?.on("error", () => {});
			child.on("error", () => {});
			child.stdin?.end(text);
		} catch {}
	}
// NEW
			child.stdin?.on("error", () => {});
			child.on("error", () => {});
			child.stdin?.end(text);
		} catch {
			/* silent no-op when xclip is absent */
		}
	}
```

7. `forwardTerminalProtocols()` — the per-sequence write loop:

```ts
// OLD
		for (const seq of toWrite) {
			try {
				this.tui.terminal.write(seq);
			} catch {}
		}
// NEW
		for (const seq of toWrite) {
			try {
				this.tui.terminal.write(seq);
			} catch {
				/* best-effort: forwarded sequences are enhancements, never critical */
			}
		}
```

8. `replayScreenLog()` — outer catch at end of method:

```ts
// OLD
			} finally {
				closeSync(fd);
			}
		} catch {}
	}
// NEW
			} finally {
				closeSync(fd);
			}
		} catch {
			/* best-effort: a missing or racing screen.log must not block attach */
		}
	}
```

9. `close()` — socket destroy:

```ts
// OLD
		try {
			this.socket?.destroy();
		} catch {}
		this.socket = null;
// NEW
		try {
			this.socket?.destroy();
		} catch {
			/* best-effort teardown: socket may already be destroyed */
		}
		this.socket = null;
```

10. `currentSize()` — SAFETY comment above the as-cast:

```ts
// OLD
	private currentSize(): { cols: number; rows: number } {
		const term = this.tui.terminal as unknown as { cols?: number; columns?: number; rows?: number } | undefined;
// NEW
	private currentSize(): { cols: number; rows: number } {
		// SAFETY: duck-typed read — Pi TUI's Terminal type does not consistently expose
		// cols/columns/rows across versions (see resizeIfNeeded below). Runtime
		// fallbacks (120/24) keep this safe when the fields are absent.
		const term = this.tui.terminal as unknown as { cols?: number; columns?: number; rows?: number } | undefined;
```

- [ ] **Step 1: Apply all 10 edits** (by method, exact old→new above)

- [ ] **Step 2: Assert no bare `catch {}` remains**

Run: `grep -c "catch {}" src/ui/pty-attach.ts`
Expected: `0`

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean exit

- [ ] **Step 4: Tests**

Run: `npm test`
Expected: all pass (no behavior change)

- [ ] **Step 5: Commit**

```bash
git add src/ui/pty-attach.ts
git commit -m "chore: document intentional empty catches and as-cast invariant in pty-attach (issue #8)"
```

---

### Task 2: Drop the unused `width` parameter from `project()`

**Files:**
- Modify: `src/ui/pty-attach.ts` (signature + single call site)

**Interfaces:**
- Changes: `private project(height: number, width: number)` → `private project(height: number)` (private; one caller)

The parameter `width` is never read in the method body. `width` at the call site remains used by `resizeIfNeeded(width)` / `renderLoading(...)` / `clip(...)` — only the `project()` argument goes away.

```ts
// OLD (signature)
	private project(height: number, width: number): { lines: string[]; cursor: { row: number; col: number } | null } {
// NEW (signature)
	private project(height: number): { lines: string[]; cursor: { row: number; col: number } | null } {
```

```ts
// OLD (call site, in render(width: number))
			const projected = this.project(bodyHeight, width);
// NEW (call site)
			const projected = this.project(bodyHeight);
```

- [ ] **Step 1: Apply both edits**

- [ ] **Step 2: Assert single-arg signature and call**

Run: `grep -n "project(" src/ui/pty-attach.ts`
Expected: exactly 2 hits — `render(...)`'s `this.project(bodyHeight);` and `private project(height: number): ...`

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean exit (a missed call site would fail here)

- [ ] **Step 4: Tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/ui/pty-attach.ts
git commit -m "chore: drop unused width param from PtyAttachComponent.project (issue #8)"
```

---

### Task 3: Final verification sweep

**Files:** none modified.

- [ ] **Step 1: Full verify pipeline (same as CI)**

Run: `npm run verify`
Expected: typecheck + tests + coverage thresholds (lines 85 / funcs 80 / branches 70) + pack dry-run all pass.

- [ ] **Step 2: Zero-behavior diff audit**

Run: `git diff main...HEAD -- src/ui/pty-attach.ts | grep -E "^[+-]" | grep -vE "^(\+\+\+|---)" | grep -vE "^\+\s*(/\*|//|\*/?)" | grep -vE "^-.*catch \{\}" | grep -vE "^\+\s*} catch \{" | grep -vE "^\+\s*}"`
Expected: exactly 4 lines — the `project` signature and call site (`-`/`+` pairs). Everything else in the raw diff must be comment additions or `catch {}` expansions; any other code line appearing here means behavior changed — investigate before proceeding.

- [ ] **Step 3: Confirm working tree clean**

Run: `git status --short`
Expected: empty (nothing uncommitted, nothing swept in)

No commit in this task (verification only).
