# Attach Double-Cursor Jiggle Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add jiggle retry logic that re-sends resize jiggle with backoff until a full-clear sequence (`\x1b[2J`) is detected in the PTY output, fixing the double-cursor desync on cold-start/streaming attach.

**Architecture:** Pure state machine in `src/core/pty-attach-jiggle-retry.mjs` handles all retry logic (clear detection, backoff scheduling, stop conditions). The UI component `src/ui/pty-attach.ts` acts as glue — feeding socket data to the state machine and managing the retry timer.

**Tech Stack:** TypeScript (ESM), Node.js `node:test`, `@xterm/headless`

## Global Constraints

- Pure logic must be dependency-free (no socket, no xterm, no timers) — testable in isolation
- Use `node:test` + `node:assert/strict` for tests (existing project pattern)
- Commit messages in English, conventional format (`feat:`/`fix:`/`test:`)
- Worktree: `/home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry`
- Don't touch `main` branch — all work on `issue-2-attach-double-cursor-jiggle-retry`

---

### Task 1: Pure Logic — Jiggle Retry State Machine

**Files:**
- Create: `src/core/pty-attach-jiggle-retry.mjs`
- Test: `test/pty-attach-jiggle-retry.test.mjs`

**Interfaces:**
- Consumes: nothing (standalone module)
- Produces:
  - `BACKOFF_MS: readonly number[]` — `[120, 500, 1500, 3000]`
  - `MAX_RETRIES: number` — `4`
  - `createJiggleRetryState(): JiggleRetryState`
  - `feedOutput(state, data, carry): { state, carry, clearFound }`
  - `nextRetryDelay(state): number | null`
  - `advanceRetry(state): JiggleRetryState`
  - `stopRetry(state): JiggleRetryState`
  - `hasFullClearSequence(data: string): boolean`

- [ ] **Step 1: Write the failing tests**

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import {
	BACKOFF_MS,
	MAX_RETRIES,
	createJiggleRetryState,
	feedOutput,
	nextRetryDelay,
	advanceRetry,
	stopRetry,
	hasFullClearSequence,
} from "../src/core/pty-attach-jiggle-retry.mjs";

// --- hasFullClearSequence ---

test("detects \\x1b[2J in plain data", () => {
	assert.equal(hasFullClearSequence("hello\x1b[2Jworld"), true);
});

test("detects \\x1b[2J at start", () => {
	assert.equal(hasFullClearSequence("\x1b[2J"), true);
});

test("detects \\x1b[2J followed by \\x1b[H", () => {
	assert.equal(hasFullClearSequence("\x1b[2J\x1b[H"), true);
});

test("rejects data without \\x1b[2J", () => {
	assert.equal(hasFullClearSequence("hello world"), false);
});

test("rejects \\x1b[3J (scrollback clear, not full clear)", () => {
	assert.equal(hasFullClearSequence("\x1b[3J"), false);
});

test("rejects partial escape \\x1b[2 (no J)", () => {
	assert.equal(hasFullClearSequence("\x1b[2"), false);
});

// --- createJiggleRetryState ---

test("initial state is fresh", () => {
	const s = createJiggleRetryState();
	assert.equal(s.retryIndex, 0);
	assert.equal(s.clearDetected, false);
	assert.equal(s.stopped, false);
});

// --- feedOutput ---

test("feedOutput detects clear sequence", () => {
	const s = createJiggleRetryState();
	const r = feedOutput(s, "some output \x1b[2J more", "");
	assert.equal(r.clearFound, true);
	assert.equal(r.state.clearDetected, true);
});

test("feedOutput returns clearFound=false when no clear", () => {
	const s = createJiggleRetryState();
	const r = feedOutput(s, "normal output", "");
	assert.equal(r.clearFound, false);
	assert.equal(r.state.clearDetected, false);
});

test("feedOutput handles cross-chunk split: \\x1b[ + 2J", () => {
	const s = createJiggleRetryState();
	const r1 = feedOutput(s, "data\x1b[", "");
	assert.equal(r1.clearFound, false);
	assert.equal(r1.carry, "\x1b[");
	const r2 = feedOutput(r1.state, "2Jrest", r1.carry);
	assert.equal(r2.clearFound, true);
});

test("feedOutput handles cross-chunk split: \\x1b + [2J", () => {
	const s = createJiggleRetryState();
	const r1 = feedOutput(s, "data\x1b", "");
	assert.equal(r1.clearFound, false);
	assert.equal(r1.carry, "\x1b");
	const r2 = feedOutput(r1.state, "[2Jrest", r1.carry);
	assert.equal(r2.clearFound, true);
});

test("feedOutput clears carry after successful detection", () => {
	const s = createJiggleRetryState();
	const r1 = feedOutput(s, "data\x1b[", "");
	const r2 = feedOutput(r1.state, "2Jrest", r1.carry);
	assert.equal(r2.carry, "");
});

test("feedOutput keeps carry for non-matching partial", () => {
	const s = createJiggleRetryState();
	const r = feedOutput(s, "data\x1b[3", "");
	assert.equal(r.clearFound, false);
	assert.ok(r.carry.length > 0);
});

// --- nextRetryDelay ---

test("nextRetryDelay returns BACKOFF_MS in order", () => {
	let s = createJiggleRetryState();
	for (let i = 0; i < MAX_RETRIES; i++) {
		assert.equal(nextRetryDelay(s), BACKOFF_MS[i]);
		s = advanceRetry(s);
	}
});

test("nextRetryDelay returns null after MAX_RETRIES", () => {
	let s = createJiggleRetryState();
	for (let i = 0; i < MAX_RETRIES; i++) s = advanceRetry(s);
	assert.equal(nextRetryDelay(s), null);
});

test("nextRetryDelay returns null when clearDetected", () => {
	const s = createJiggleRetryState();
	const r = feedOutput(s, "\x1b[2J", "");
	assert.equal(nextRetryDelay(r.state), null);
});

test("nextRetryDelay returns null when stopped", () => {
	const s = stopRetry(createJiggleRetryState());
	assert.equal(nextRetryDelay(s), null);
});

// --- advanceRetry ---

test("advanceRetry increments retryIndex", () => {
	const s0 = createJiggleRetryState();
	const s1 = advanceRetry(s0);
	assert.equal(s1.retryIndex, 1);
	const s2 = advanceRetry(s1);
	assert.equal(s2.retryIndex, 2);
});

// --- stopRetry ---

test("stopRetry sets stopped=true", () => {
	const s = stopRetry(createJiggleRetryState());
	assert.equal(s.stopped, true);
});

// --- Immutability ---

test("feedOutput does not mutate original state", () => {
	const s = createJiggleRetryState();
	feedOutput(s, "\x1b[2J", "");
	assert.equal(s.clearDetected, false);
});

test("advanceRetry does not mutate original state", () => {
	const s = createJiggleRetryState();
	advanceRetry(s);
	assert.equal(s.retryIndex, 0);
});

test("stopRetry does not mutate original state", () => {
	const s = createJiggleRetryState();
	stopRetry(s);
	assert.equal(s.stopped, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
node --test test/pty-attach-jiggle-retry.test.mjs
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement the state machine**

```javascript
/** Pure logic for attach jiggle-retry: detect full-clear, schedule backoff retries. */

export const BACKOFF_MS = Object.freeze([120, 500, 1500, 3000]);
export const MAX_RETRIES = BACKOFF_MS.length;

const FULL_CLEAR = "\x1b[2J";
/** Carry enough bytes to catch a split escape sequence at chunk boundary. */
const CARRY_LEN = FULL_CLEAR.length - 1; // 3 bytes: \x1b, \x1b[, \x1b[2

/**
 * @typedef {Object} JiggleRetryState
 * @property {number} retryIndex - Current retry round (0 = initial, not yet retried).
 * @property {boolean} clearDetected - Whether a full-clear sequence was seen.
 * @property {boolean} stopped - Whether the retry chain has been stopped.
 */

/** Create initial retry state. */
export function createJiggleRetryState() {
	return { retryIndex: 0, clearDetected: false, stopped: false };
}

/**
 * Feed PTY output data into the state machine.
 * Returns new state, updated carry buffer, and whether a clear was found.
 * @param {JiggleRetryState} state
 * @param {string} data - New output data chunk.
 * @param {string} carry - Leftover partial escape sequence from previous chunk.
 * @returns {{ state: JiggleRetryState, carry: string, clearFound: boolean }}
 */
export function feedOutput(state, data, carry) {
	const combined = carry + data;
	const clearFound = hasFullClearSequence(combined);
	const newCarry = clearFound ? "" : tailCarry(combined);
	const newState = clearFound
		? { ...state, clearDetected: true }
		: state;
	return { state: newState, carry: newCarry, clearFound };
}

/**
 * Get the delay before the next retry, or null if no more retries.
 * @param {JiggleRetryState} state
 * @returns {number | null}
 */
export function nextRetryDelay(state) {
	if (state.stopped || state.clearDetected) return null;
	if (state.retryIndex >= MAX_RETRIES) return null;
	return BACKOFF_MS[state.retryIndex];
}

/**
 * Advance to the next retry round.
 * @param {JiggleRetryState} state
 * @returns {JiggleRetryState}
 */
export function advanceRetry(state) {
	return { ...state, retryIndex: state.retryIndex + 1 };
}

/**
 * Stop the retry chain (attach settled, component closed, etc.).
 * @param {JiggleRetryState} state
 * @returns {JiggleRetryState}
 */
export function stopRetry(state) {
	return { ...state, stopped: true };
}

/**
 * Check if data contains the full-clear escape sequence.
 * @param {string} data
 * @returns {boolean}
 */
export function hasFullClearSequence(data) {
	return data.includes(FULL_CLEAR);
}

/** Extract the tail carry for cross-chunk boundary detection. */
function tailCarry(data) {
	// We only need to carry up to CARRY_LEN bytes to catch a split \x1b[2J.
	const tail = data.slice(-CARRY_LEN);
	// Find the last \x1b in the tail — everything before it can't be part of
	// a split escape sequence.
	const escIdx = tail.lastIndexOf("\x1b");
	return escIdx >= 0 ? tail.slice(escIdx) : "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
node --test test/pty-attach-jiggle-retry.test.mjs
```

Expected: All 18 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
git add src/core/pty-attach-jiggle-retry.mjs test/pty-attach-jiggle-retry.test.mjs
git commit -m "feat: add jiggle retry state machine with clear-sequence detection"
```

---

### Task 2: Integrate Retry Chain into PtyAttachComponent

**Files:**
- Modify: `src/ui/pty-attach.ts`

**Interfaces:**
- Consumes: `createJiggleRetryState`, `feedOutput`, `nextRetryDelay`, `advanceRetry`, `stopRetry`, `BACKOFF_MS` from `src/core/pty-attach-jiggle-retry.mjs`
- Produces: no new exports — internal behavior change only

- [ ] **Step 1: Add import and new private fields**

In `src/ui/pty-attach.ts`, add to the imports at top:
```typescript
import {
	createJiggleRetryState,
	feedOutput as feedJiggleRetry,
	nextRetryDelay,
	advanceRetry,
	stopRetry,
} from "../core/pty-attach-jiggle-retry.mjs";
```

Add new private fields to the class (after existing fields, near `forcedRedrawAfterLiveOutput`):
```typescript
// Jiggle retry chain: re-send resize jiggle until we see a full-clear sequence
// in the PTY output, proving the child pi-tui did a fullRender and the replay
// garbage has been flushed. Replaces the one-shot forceChildRedrawAfterLiveOutput.
private jiggleRetryState = createJiggleRetryState();
private jiggleRetryTimer: ReturnType<typeof setTimeout> | null = null;
private clearCarry = "";
```

- [ ] **Step 2: Add new private methods**

Add these methods to the class (near `forceChildRedraw`):

```typescript
/** Start the jiggle retry chain after initial jiggle. */
private startJiggleRetry(): void {
	this.jiggleRetryState = createJiggleRetryState();
	this.clearCarry = "";
	this.scheduleNextJiggleRetry();
}

/** Check socket output for full-clear sequence; cancel retry if found. */
private checkClearSequence(data: string): void {
	const result = feedJiggleRetry(this.jiggleRetryState, data, this.clearCarry);
	this.jiggleRetryState = result.state;
	this.clearCarry = result.carry;
	if (result.clearFound) this.cancelJiggleRetry();
}

/** Schedule the next jiggle retry with backoff. */
private scheduleNextJiggleRetry(): void {
	const delay = nextRetryDelay(this.jiggleRetryState);
	if (delay === null) return;
	this.jiggleRetryTimer = setTimeout(() => {
		this.jiggleRetryTimer = null;
		if (this.closed || !this.connected) return;
		this.forceChildRedraw();
		this.jiggleRetryState = advanceRetry(this.jiggleRetryState);
		this.scheduleNextJiggleRetry();
	}, delay);
	this.jiggleRetryTimer.unref?.();
}

/** Cancel the jiggle retry chain. */
private cancelJiggleRetry(): void {
	if (this.jiggleRetryTimer) {
		clearTimeout(this.jiggleRetryTimer);
		this.jiggleRetryTimer = null;
	}
	this.jiggleRetryState = stopRetry(this.jiggleRetryState);
}
```

- [ ] **Step 3: Wire into connect() — start retry after initial jiggle**

In `connect()`, after `this.forceChildRedraw()` (around line 309), add:
```typescript
this.startJiggleRetry();
```

- [ ] **Step 4: Wire into onSocketData() — check for clear sequence**

In `onSocketData()`, inside the `msg.type === "output"` branch, after `this.pushOutput(msg.data, ...)`, replace the `this.forceChildRedrawAfterLiveOutput()` call with:
```typescript
this.checkClearSequence(msg.data);
```

- [ ] **Step 5: finishAttachTransition() — do NOT cancel retry (updated post-review)**

**Update (final review, commit 806bf3e):** the retry chain intentionally survives the settle transition. Originally this step wired `cancelJiggleRetry()` into `finishAttachTransition()`, but review found that kills the chain at ~410ms in the silent cold-start case — the exact failure mode this feature fixes — leaving only retry 1 reachable. The chain now self-terminates on: clear detected / max retries / close(). Post-settle jiggles only fire when the child consumed all earlier jiggles (screen already stale), trading a brief full-render flicker for self-healing.

- [ ] **Step 6: Wire into close() — cancel retry**

In `close()`, add (alongside other cleanup):
```typescript
this.cancelJiggleRetry();
```

- [ ] **Step 7: Remove old one-shot logic**

Delete the `forcedRedrawAfterLiveOutput` field declaration.

Delete the `forceChildRedrawAfterLiveOutput()` method entirely.

Delete the `liveRedrawTimer` field declaration.

In `close()`, remove `this.liveRedrawTimer` cleanup if present (it was cleaned by `clearRedrawTimer()` which also clears `liveRedrawTimer` — verify and clean up).

- [ ] **Step 8: Verify TypeScript compiles**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 9: Run all existing tests**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
node --test test/*.test.mjs
```

Expected: All tests PASS (no regressions)

- [ ] **Step 10: Commit**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
git add src/ui/pty-attach.ts
git commit -m "feat: integrate jiggle retry chain into attach component"
```

---

### Task 3: Final Verification — Full Test Suite + Lint

**Files:**
- No new files; verification only

- [ ] **Step 1: Run full test suite**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
node --test test/*.test.mjs
```

Expected: All PASS

- [ ] **Step 2: TypeScript check**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Check for lint issues**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
npx biome check src/core/pty-attach-jiggle-retry.mjs src/ui/pty-attach.ts test/pty-attach-jiggle-retry.test.mjs 2>&1 || true
```

Expected: No new issues (fix if any)

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.claude/worktrees/issue-2-attach-double-cursor-jiggle-retry
git add -p  # stage only relevant fixes
git commit -m "fix: address lint/type issues from final verification"
```
