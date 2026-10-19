# attach forward Alt modifier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the Alt modifier when the attach view forwards a wheel notch to a fullscreen child, so Alt+wheel keeps its 5× accelerator.

**Architecture:** `encodeWheelReport` gains an optional `alt` flag that sets SGR bit 3 (`+8`); `forwardWheelToChild` passes `event.alt === true` through. Nothing else changes — the local scroll path never rebuilds the report.

**Tech Stack:** ESM `.mjs` pure helper, TypeScript component shell, `node:test` + `assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-19-issue-214-attach-forward-alt-modifier-design.md`

## Global Constraints

- Tabs for indentation; English comments and commit messages (repo AGENTS.md).
- No new dependencies.
- Local `npm run verify` cannot go green on this Windows host (pre-existing ~72-test baseline that also fails on `main`); the authoritative local gates are the targeted suites plus `npm run typecheck` and `npm run pack:dry`. CI is the final gate.
- `alt` must be compared strictly (`=== true`), never by truthiness: a stray `1`/`"yes"` must not set bit 3.
- Do not touch the local scroll path, the reply guard, or the input classifier.

## Review Focus

- **A truthy non-boolean `alt`** — `alt: 1` and `alt: "yes"` must NOT set bit 3, because the component passes `event.alt === true` (an older pi-tui could hand over something unexpected).
- **Plain wheel parity** — with no Alt, the encoded report must stay byte-identical to today's (`\x1b[<64;…M` / `\x1b[<65;…M`); the existing #198/#205 assertions must keep passing untouched.
- **The forward hop is the only seam** — the legacy regular-mode path forwards the raw SGR unchanged and already carries Alt; a change that also rewrote that path would be a scope violation.
- **Down direction** — `alt + down` is `73`, not `72`; an implementation that ORs the bit onto a fixed 64 would break down-scroll.
- **Child-side consumption** — the byte must decode as `button & 8 !== 0` under pi-tui's `parseWheelEvent`; `72`/`73` satisfy that and `64`/`65` do not.

---

### Task 1: Encode the Alt bit in `encodeWheelReport`

**Files:**
- Modify: `src/core/pty-scroll.mjs` (`encodeWheelReport`, ~L370)
- Test: `test/pty-scroll.test.mjs`

**Interfaces:**
- Produces: `encodeWheelReport(direction: "up"|"down", { col?: number, row?: number, alt?: boolean }) -> string`. Default `alt: false` keeps every existing call site identical.

- [ ] **Step 1: Write the failing tests**

Append to `test/pty-scroll.test.mjs`:

```js
// Issue #214: Alt is SGR bit 3 (value 8); the child's pi-tui reads it to apply the
// 5x wheel multiplier, so the forward hop must not strip it.
test("#214-A1: Alt+wheel-up encodes button 72", () => {
	assert.equal(encodeWheelReport("up", { col: 5, row: 3, alt: true }), "\x1b[<72;5;3M");
});

test("#214-A2: Alt+wheel-down encodes button 73", () => {
	assert.equal(encodeWheelReport("down", { col: 5, row: 3, alt: true }), "\x1b[<73;5;3M");
});

test("#214-A3: without a strict boolean true, bit 3 stays clear", () => {
	for (const alt of [false, undefined, null, 0, 1, "yes"]) {
		assert.equal(encodeWheelReport("up", { col: 5, row: 3, alt }), "\x1b[<64;5;3M", `alt=${String(alt)} must not set bit 3`);
		assert.equal(encodeWheelReport("down", { col: 5, row: 3, alt }), "\x1b[<65;5;3M", `alt=${String(alt)} must not set bit 3`);
	}
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL — `#214-A1` gets `\x1b[<64;5;3M` instead of `72`.

- [ ] **Step 3: Implement**

```js
export function encodeWheelReport(direction, { col, row, alt = false } = {}) {
	const base = direction === "up" ? 64 : 65;
	// Issue #214: SGR bit 3 (value 8) is Alt. pi-tui multiplies by 5 when it is set,
	// so the forward hop must carry it. Strict comparison: a truthy non-boolean must
	// not flip the bit.
	const button = alt === true ? base + 8 : base;
	const cell = (v) => (Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1);
	return `\x1b[<${button};${cell(col)};${cell(row)}M`;
}
```

Keep the existing JSDoc's description of the direction/coordinates; add one line about `alt`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/pty-scroll.test.mjs`
Expected: PASS (three new tests plus the existing suite).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-scroll.mjs test/pty-scroll.test.mjs
git commit -m "feat(attach): carry the Alt modifier in the forwarded wheel report (issue #214)"
```

---

### Task 2: Pass `event.alt` through the forward hop

**Files:**
- Modify: `src/ui/pty-attach.ts` (`forwardWheelToChild`, ~L1477)
- Modify: `test-support/pty-attach-wheel-fallback-scenario.ts` (new alt round)
- Modify: `test/pty-attach-wheel-fallback.test.mjs` (new assertions)

**Interfaces:**
- Consumes: `encodeWheelReport(…, { alt })` from Task 1.
- Produces: scenario result fields `forwardedAltUp` / `forwardedAltDown`.

- [ ] **Step 1: Write the failing assertion**

In `test/pty-attach-wheel-fallback.test.mjs`, after the existing plain-wheel assertions (which must stay untouched):

```js
assert.equal(parsed.forwardedAltUp, "\x1b[<72;4;3M", "Alt+wheel-up must reach the child as button 72");
assert.equal(parsed.forwardedAltDown, "\x1b[<73;4;3M", "Alt+wheel-down must reach the child as button 73");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pty-attach-wheel-fallback.test.mjs`
Expected: FAIL — `parsed.forwardedAltUp` is `undefined`.

- [ ] **Step 3: Implement**

In `src/ui/pty-attach.ts` `forwardWheelToChild`, add the flag:

```ts
			data: encodeWheelReport(linesUp > 0 ? "up" : "down", {
				col: clampInt(event.x + 1, 1, this.cols),
				row: clampInt(event.y, 1, Math.max(1, this.bodyHeight())),
				// Issue #214: the overlay already received the Alt bit from pi-tui; carry it
				// into the synthesized report so the child keeps its 5x wheel accelerator.
				alt: event.alt === true,
			}),
```

In `test-support/pty-attach-wheel-fallback-scenario.ts`, add one more round using the existing `mouseBase` (do not modify the existing rounds, whose assertions are #198's regression pins):

```ts
	// Issue #214: Alt must survive the forward hop.
	let beforeAlt = forwardedInputs().length;
	(component as any).handleMouse({ ...wheelEvent(-3), alt: true });
	if (await waitFor(() => forwardedInputs().length > beforeAlt, 3000)) {
		result.forwardedAltUp = forwardedInputs().at(-1) ?? null;
	}
	beforeAlt = forwardedInputs().length;
	(component as any).handleMouse({ ...wheelEvent(2), alt: true });
	if (await waitFor(() => forwardedInputs().length > beforeAlt, 3000)) {
		result.forwardedAltDown = forwardedInputs().at(-1) ?? null;
	}
```

Declare both fields in the scenario's `result` object (`null as string | null`).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/pty-attach-wheel-fallback.test.mjs`
Expected: PASS — the two new assertions and every existing #198 assertion.

- [ ] **Step 5: Commit**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-wheel-fallback-scenario.ts test/pty-attach-wheel-fallback.test.mjs
git commit -m "fix(attach): forward the Alt modifier on the wheel hop (issue #214)"
```

---

### Task 3: Regression gate

**Files:** none.

- [ ] **Step 1: Targeted suites**

Run: `node --test test/pty-scroll.test.mjs test/pty-attach-wheel-fallback.test.mjs test/pty-attach-wheel.test.mjs test/pty-attach-frame-overflow.test.mjs test/pty-attach-alt-wheel.test.mjs test/pty-attach-mouse-mode.test.mjs test/terminal-reply-guard.test.mjs`
Expected: all green.

- [ ] **Step 2: Static gates**

Run: `npm run typecheck && npm run pack:dry`
Expected: both clean.

- [ ] **Step 3: Baseline comparison**

Run: `node --test test/pty-attach-*.test.mjs` and compare the failing set against the known Windows-host baseline. Expected: no new names.

---

### Task 4: Manual verification (U1)

**Files:** none.

- [ ] **Step 1: Load this checkout into pi**

`pi install "$(pwd)"` (README.md:54) or symlink to `~/.pi/agent/extensions/agent-board` — **not** the `~/.pi/agent/git/...` cache clone.

- [ ] **Step 2: Restart pi completely**, open a new attach session on a fullscreen child.

- [ ] **Step 3: Hold Alt and roll one wheel notch** in the attach view.
Expected: the child scrolls 5 lines, matching the behaviour outside attach.

- [ ] **Step 4: Record the outcome** in the issue.
