# Issue #170 Attach Inbound Reply Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop fragmented terminal replies (DA1/DA2/DA3, kitty flags, cell size, DCS) from leaking into the attached child's input box, while still forwarding color replies (OSC 4/10/11/12 and the `997` scheme report) as one whole sequence.

**Architecture:** A new pure module `src/core/terminal-reply-guard.mjs` owns a classifier (`classifyReplyEvent`) and a timer-free state machine (`createReplyGuard`) that absorbs reply fragments inside a 250ms / 64-byte window anchored at a reply head. `PtyAttachComponent.handleInput` gets a three-way first-line wiring (pass / swallow / forward-whole) plus one window timer, all disabled by `AGENT_BOARD_REPLY_GUARD=0`.

**Tech Stack:** ESM `.mjs` pure module (no deps, no pi-tui import), TypeScript wiring (tabs), `node:test` + `assert/strict` unit tests, `node --experimental-transform-types` component smoke following the #180 pattern.

**Spec:** `docs/superpowers/specs/2026-10-14-issue-170-attach-reply-guard-design.md` — acceptance IDs **A1–A9** (automated) and **U1–U3** (user-observed). Line numbers below are at branch base `f81949d`.

**Dry run (authoring evidence):** the Task 1–2 module code and every A1–A5/A7 unit assertion below were executed as written in a scratch directory before this plan was committed — 15 tests pass, c8 reports 100% statements / 97.8% branches / 100% functions on `terminal-reply-guard.mjs`. The snippets are verified, not illustrative; only the Task 3 wiring snippets are unexecuted.

## Global Constraints

- Work ONLY inside the worktree `<WT>` = `<repo>/.pi/worktrees/issue-170-attach-reply-guard` (branch `issue-170-attach-reply-guard`); never touch main.
- Every edit path starts with `<WT>`; git commands use `git -C <WT>` (the session cwd cannot change).
- Tabs for indentation; English comments and commit messages; conventional commit subjects.
- Constants verbatim from the spec: `REPLY_GUARD_WINDOW_MS = 250`, `REPLY_GUARD_MAX_ABSORB_BYTES = 64`. They are NOT configurable — the kill switch is the only new knob.
- `src/core/terminal-reply-guard.mjs` is pure: no I/O, no timers, no `process.env`, no pi-tui import. Time is always injected as a `now` argument.
- The guard runs FIRST in `handleInput`, before `parseMouseInputChunk` and every key interception. Text/keys it does not classify as a reply must reach the existing fallback unchanged.
- No changes to #128 forwarding semantics, the #180 `childInputReady` gate, the jiggle controller, `detachColorSchemeBridge`, or the detach chords.
- Test names carry their acceptance ID (`test("A1: …")`).
- Branch gate is `npm run verify` (A8); a task's own gate is the command listed in its steps.

## Known boundaries (do NOT "fix" these without a new spec)

- DSR/CPR (`ESC[<r>;<c>R`) is explicitly out of scope (shares a prefix with key encodings).
- A reply tail that arrives after the window closed still leaks into the child — the guard lowers the rate, it cannot eliminate it.
- An `other` event (key/mouse/paste) always ends an open window and is passed: user keys win over absorbing one more fragment.
- Consequence of the point above: a lone `ESC \` (ST) arriving as its own fragment classifies as `other` and is passed. It is not in the A-item matrix; treat it as the documented cost of never swallowing keys.

---

### Task 1: Pure classifier (A1, A4 pass side, A5 complete forms)

**Files:**
- Create: `<WT>/src/core/terminal-reply-guard.mjs`
- Create: `<WT>/test/terminal-reply-guard.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `classifyReplyEvent(data) → { kind: "reply-complete", family, action: "drop" | "forward" } | { kind: "reply-head", family } | { kind: "plain" } | { kind: "other" }`, plus `REPLY_GUARD_WINDOW_MS`, `REPLY_GUARD_MAX_ABSORB_BYTES`. Tasks 2–3 import from `../core/terminal-reply-guard.mjs`.

- [ ] **Step 1: Write the failing tests**

Create `<WT>/test/terminal-reply-guard.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyReplyEvent,
	REPLY_GUARD_MAX_ABSORB_BYTES,
	REPLY_GUARD_WINDOW_MS,
} from "../src/core/terminal-reply-guard.mjs";

// Real bytes from upstream earendil-works/pi#10657 (WezTerm 20240203 + ConPTY):
// a DA1 reply delivered as four reads, more than 50ms apart.
const DA1 = "\x1b[?61;6;7;22;23;24;28;32;42c";
const DA1_CHUNKS = ["\x1b[?61;6;", "7;22;23;", "24;28;32", ";42c"];
const OSC11_REPLY = "\x1b]11;rgb:2887/2a18/353c\x1b\\";

test("A1: complete drop-family replies classify as drop", () => {
	for (const [family, seq] of [
		["device-attributes", DA1],
		["device-attributes", "\x1b[?c"],
		["device-attributes", "\x1b[=1;2c"],
		["device-attributes", "\x1b[>41;330;0c"],
		["kitty-flags", "\x1b[?1u"],
		["kitty-flags", "\x1b[?61;6u"],
		["cell-size", "\x1b[6;24;80t"],
		["dcs", "\x1bP>|WezTerm 20240203\x1b\\"],
	]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "reply-complete", family, action: "drop" }, JSON.stringify(seq));
	}
});

test("A1: near-miss shapes keep the designed classification", () => {
	// Complete but parameterless DA1 → drop (complete shape wins over "incomplete").
	assert.deepEqual(classifyReplyEvent("\x1b[?c"), { kind: "reply-complete", family: "device-attributes", action: "drop" });
	// Unknown third value on the scheme report → forward (the child's parser rejects it).
	assert.deepEqual(classifyReplyEvent("\x1b[?997;3n"), { kind: "reply-complete", family: "color-scheme", action: "forward" });
	// Complete but unknown CSI (DSR) → not a reply family: pass as "other".
	assert.deepEqual(classifyReplyEvent("\x1b[1;2R"), { kind: "other" });
});

test("A5: color replies are forward-family, both terminators", () => {
	for (const seq of [
		OSC11_REPLY,
		"\x1b]11;rgb:efef/f1f1/f5f5\x07",
		"\x1b]10;rgb:ffff/ffff/ffff\x07",
		"\x1b]12;rgb:0000/0000/0000\x1b\\",
		"\x1b]4;0;rgb:0000/0000/0000\x07",
	]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "reply-complete", family: "osc-color", action: "forward" }, JSON.stringify(seq));
	}
	for (const seq of ["\x1b[?997;1n", "\x1b[?997;2n"]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "reply-complete", family: "color-scheme", action: "forward" }, JSON.stringify(seq));
	}
});

test("A4: non-reply input is 'other' (escape-led) or 'plain' (text), never a reply", () => {
	for (const seq of [
		"\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F", "\x1b[3~", "\x1b[<35;20;5M",
		"\x1bOA", "\x1bOB", "\x1b", "\x1bz", "\x1b[27;5;92~", "\x1b[92;5u",
		"\x1b[200~paste\x1b[201~", "\x1b[1;5D", "\x1b[1;2R",
	]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "other" }, JSON.stringify(seq));
	}
	for (const seq of ["hello", "7;22;23;", ";42c", "24;28;32"]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "plain" }, JSON.stringify(seq));
	}
	assert.deepEqual(classifyReplyEvent(""), { kind: "plain" }, "an empty event is inert");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd <WT> && node --test test/terminal-reply-guard.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/terminal-reply-guard.mjs'`.

- [ ] **Step 3: Write the module skeleton + classifier**

Create `<WT>/src/core/terminal-reply-guard.mjs`:

```js
/**
 * Inbound terminal reply guard for the PTY attach client (issue #170).
 *
 * pi-tui hands replies to forwarded terminal queries to this overlay as input
 * fragments: the prefix arms a 50ms sequence timeout in StdinBuffer and a
 * 150ms negotiation flush in ProcessTerminal, so a CSI-shaped reply head is
 * emitted as an input event and the remaining fragments arrive as plain text.
 * The overlay's passthrough then feeds that garbage into the child's editor
 * (upstream earendil-works/pi#10657 — a DA1 reply arrives as four reads and
 * shows up in the child as a stable `c7c`).
 *
 * This module classifies every inbound event and the state machine below
 * swallows reply fragments until the sequence completes. Color replies (OSC
 * 4/10/11/12 and the 997 scheme report) are forwarded as ONE whole sequence,
 * because the child's pi-tui parsers anchor `^...$`; everything else falls
 * through untouched (issue #128 decision: the child negotiates at spawn, a late
 * DA/kitty reply is meaningless to it, and forwarding kitty flags would retune
 * the shared real-terminal keyboard stack).
 *
 * Pure only: no I/O, no timers, no `process.env`, no pi-tui import. Time is
 * injected by the caller (see `armReplyGuardTimer` in src/ui/pty-attach.ts).
 */

/** How long an open reply window stays open for trailing fragments (spec §3.3). */
export const REPLY_GUARD_WINDOW_MS = 250;

/** Bound on how much of a user's fast typing an open window may absorb. */
export const REPLY_GUARD_MAX_ABSORB_BYTES = 64;

// Complete reply shapes that are dropped. The child's negotiation happened at
// spawn, before any attach client existed, so a late reply can only pollute its
// input or retune keyboards that no longer asked.
const DROP_SHAPES = [
	// DA1 / DA3 (`\x1b[?...c`, `\x1b[=...c`) and DA2 (`\x1b[>...c`).
	{ family: "device-attributes", pattern: /^\x1b\[[?>=][0-9;]*c$/ },
	// kitty keyboard flags reply.
	{ family: "kitty-flags", pattern: /^\x1b\[\?[0-9;]*u$/ },
	// XTWINOPS cell-size report (`\x1b[6;<rows>;<cols>t`).
	{ family: "cell-size", pattern: /^\x1b\[6;[0-9]+;[0-9]+t$/ },
	// DCS replies such as XTVersion.
	{ family: "dcs", pattern: /^\x1bP[\s\S]*\x1b\\$/ },
];

// Complete reply shapes that are forwarded whole: the child's pi-tui parsers
// consume them (automatic light/dark theme) and only as one sequence.
const FORWARD_SHAPES = [
	// `\x1b[?997;<n>n` color-scheme report. Any single digit is forwarded — value
	// validation belongs to the child's parser, not to this guard.
	{ family: "color-scheme", pattern: /^\x1b\[\?997;[0-9]+n$/ },
	// OSC 4 palette / 10 foreground / 11 background / 12 cursor color replies,
	// BEL- or ST-terminated.
	{ family: "osc-color", pattern: /^\x1b\](?:4;[0-9]+|10|11|12);[\s\S]*(?:\x07|\x1b\\)$/ },
];

// Prefixes that can only start a reply and can never be a key/mouse/paste
// encoding — only these arm an absorption window. Deliberately absent: bare
// `\x1b`, `\x1b[`, `\x1b[5`/`\x1b[6` (PageUp/PageDown heads), `\x1b[<` (SGR
// mouse), `\x1bO` (SS3).
const REPLY_HEADS = [
	{ family: "device-attributes", prefix: "\x1b[?" },
	{ family: "device-attributes", prefix: "\x1b[>" },
	{ family: "cell-size", prefix: "\x1b[6;" },
	{ family: "dcs", prefix: "\x1bP" },
	{ family: "osc-color", prefix: "\x1b]1" },
	{ family: "osc-color", prefix: "\x1b]4" },
];

/**
 * Classify one inbound input event. Complete reply shapes win over head
 * prefixes (a complete kitty reply also starts with `\x1b[?`); escape-led
 * events that are neither are keys, mouse or paste data.
 */
export function classifyReplyEvent(data) {
	if (typeof data !== "string" || data.length === 0) return { kind: "plain" };
	for (const shape of DROP_SHAPES) {
		if (shape.pattern.test(data)) return { kind: "reply-complete", family: shape.family, action: "drop" };
	}
	for (const shape of FORWARD_SHAPES) {
		if (shape.pattern.test(data)) return { kind: "reply-complete", family: shape.family, action: "forward" };
	}
	for (const head of REPLY_HEADS) {
		if (data.startsWith(head.prefix)) return { kind: "reply-head", family: head.family };
	}
	// Everything else that starts with ESC is a key/mouse/paste encoding; plain
	// text may be a reply tail fragment (those never start with ESC after the
	// upstream split, see the field evidence in the issue).
	return data.startsWith("\x1b") ? { kind: "other" } : { kind: "plain" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd <WT> && node --test --test-name-pattern="A1" test/terminal-reply-guard.test.mjs && node --test --test-name-pattern="A4" test/terminal-reply-guard.test.mjs && node --test --test-name-pattern="A5" test/terminal-reply-guard.test.mjs`
Expected: PASS, 3 matching test blocks.

- [ ] **Step 5: Commit**

```bash
git -C <WT> add src/core/terminal-reply-guard.mjs test/terminal-reply-guard.test.mjs
git -C <WT> commit -m "feat(attach): classify inbound terminal reply events (#170)"
```

---

### Task 2: Pure state machine + kill switch parser (A2, A3, A5 fragment forms, A7 unit half)

**Files:**
- Modify: `<WT>/src/core/terminal-reply-guard.mjs` (append)
- Modify: `<WT>/test/terminal-reply-guard.test.mjs` (extend import + append)

**Interfaces:**
- Consumes: `classifyReplyEvent`, `REPLY_GUARD_WINDOW_MS`, `REPLY_GUARD_MAX_ABSORB_BYTES` (Task 1).
- Produces: `createReplyGuard({ windowMs, maxAbsorbBytes }) → { feed(data, now) → { action: "pass" } | { action: "swallow" } | { action: "forward", data }, expire(now) → decision | null, pendingSince() → number | null, reset() → void }` and `isReplyGuardEnabled(value) → boolean`. Task 3 imports `createReplyGuard`, `isReplyGuardEnabled`, `REPLY_GUARD_WINDOW_MS`.

- [ ] **Step 1: Write the failing tests**

In `<WT>/test/terminal-reply-guard.test.mjs`, extend the import with `createReplyGuard` and `isReplyGuardEnabled`, then append:

```js
test("A2: a four-read DA1 reply is absorbed end to end", () => {
	const guard = createReplyGuard();
	let now = 1000;
	for (const chunk of DA1_CHUNKS.slice(0, 3)) {
		assert.deepEqual(guard.feed(chunk, now), { action: "swallow" }, JSON.stringify(chunk));
		now += 60;
	}
	assert.deepEqual(guard.feed(DA1_CHUNKS[3], now), { action: "swallow" });
	assert.equal(guard.pendingSince(), null, "completion closes the window");
	assert.deepEqual(guard.feed("hello", now + 1), { action: "pass" }, "the guard is idle again");
});

test("A3: the window absorbs plain fragments, expires on time, and resets", () => {
	const guard = createReplyGuard();
	assert.deepEqual(guard.feed("\x1b[?61;6;", 1000), { action: "swallow" });
	assert.deepEqual(guard.feed("7;22;", 1060), { action: "swallow" });
	assert.equal(guard.pendingSince(), 1000, "the window is anchored at the head, not at the last fragment");
	assert.equal(guard.expire(1249), null, "an early timer must not close the window");
	assert.equal(guard.pendingSince(), 1000);
	assert.deepEqual(guard.expire(1250), { action: "swallow" }, "expiry drops the incomplete prefix");
	assert.equal(guard.pendingSince(), null);
	assert.deepEqual(guard.feed("plain", 1300), { action: "pass" }, "state is idle after expiry");
});

test("A3: the absorb cap bounds the loss and drops the overflowing event", () => {
	const guard = createReplyGuard({ maxAbsorbBytes: 16 });
	assert.deepEqual(guard.feed("\x1b[6;", 1000), { action: "swallow" });
	assert.deepEqual(guard.feed("0123456789", 1010), { action: "swallow" }, "14 bytes: still absorbed");
	assert.deepEqual(guard.feed("XYZ", 1020), { action: "swallow" }, "overflow is dropped, not passed");
	assert.equal(guard.pendingSince(), null, "overflow closes the window");
	assert.deepEqual(guard.feed("after", 1030), { action: "pass" });
});

test("A3: reset() leaves no residue and windows do not leak across events", () => {
	const guard = createReplyGuard();
	guard.feed("\x1b[?1;", 1000);
	guard.reset();
	assert.equal(guard.pendingSince(), null);
	assert.deepEqual(guard.feed("tail", 1010), { action: "pass" }, "a reset window must not absorb");
	assert.deepEqual(guard.feed("\x1b[?61;6;", 1100), { action: "swallow" }, "a later head arms normally");
	assert.deepEqual(guard.expire(1400), { action: "swallow" });
	assert.deepEqual(guard.feed("\x1b]11;rgb:", 1500), { action: "swallow" }, "the next window is independent");
	assert.deepEqual(guard.feed("2887/2a18/353c\x07", 1510), { action: "forward", data: "\x1b]11;rgb:2887/2a18/353c\x07" });
});

test("A3: an 'other' event ends the window, passes, and protects later text", () => {
	for (const seq of ["\x1b[5~", "\x1b[<35;20;5M", "\x1b[200~hi\x1b[201~"]) {
		const guard = createReplyGuard();
		guard.feed("\x1b[?61;6;", 1000);
		assert.deepEqual(guard.feed(seq, 1010), { action: "pass" }, JSON.stringify(seq));
		assert.equal(guard.pendingSince(), null, JSON.stringify(seq));
		assert.deepEqual(guard.feed("hello", 1020), { action: "pass" }, "the dropped buffer must not swallow later text");
	}
});

test("A3: a new reply head re-arms and the stale buffer is gone", () => {
	const guard = createReplyGuard();
	assert.deepEqual(guard.feed("\x1b[?61;6;", 1000), { action: "swallow" });
	assert.deepEqual(guard.feed("\x1b]11;", 1100), { action: "swallow" }, "the new head wins");
	assert.equal(guard.pendingSince(), 1100, "the window restarts at the new head");
	assert.equal(guard.expire(1250), null, "not yet 250ms after the new head");
	assert.deepEqual(guard.feed("rgb:2887/2a18/353c\x07", 1300), { action: "forward", data: "\x1b]11;rgb:2887/2a18/353c\x07" }, "the forwarded bytes carry no stale DA prefix");
	assert.equal(guard.pendingSince(), null);
});

test("A3: a complete reply inside an open window is handled alone, never joined", () => {
	const guard = createReplyGuard();
	guard.feed("\x1b]11;rgb:", 1000);
	assert.deepEqual(guard.feed(OSC11_REPLY, 1050), { action: "forward", data: OSC11_REPLY }, "byte-for-byte, without the stale prefix");
	assert.equal(guard.pendingSince(), null);
	const dropped = createReplyGuard();
	dropped.feed("\x1b[?61;6;", 1000);
	assert.deepEqual(dropped.feed("\x1b[?1u", 1010), { action: "swallow" }, "a stale buffer plus a fresh kitty reply still drops");
	assert.equal(dropped.pendingSince(), null);
});

test("A3: the spec's window and cap are pinned", () => {
	assert.equal(REPLY_GUARD_WINDOW_MS, 250);
	assert.equal(REPLY_GUARD_MAX_ABSORB_BYTES, 64);
});

test("A4: near-miss prefixes arm the window, unknown complete CSI does not", () => {
	for (const seq of ["\x1b[?1;", "\x1b[6;", "\x1b[6;24;80", "\x1b]11;", "\x1bP"]) {
		const guard = createReplyGuard();
		assert.deepEqual(guard.feed(seq, 1000), { action: "swallow" }, JSON.stringify(seq));
		assert.equal(guard.pendingSince(), 1000, JSON.stringify(seq));
	}
	const guard = createReplyGuard();
	assert.deepEqual(guard.feed("\x1b[1;2R", 1000), { action: "pass" });
	assert.equal(guard.pendingSince(), null, "a complete unknown CSI must not arm the guard");
});

test("A5: a fragmented color reply is joined and forwarded whole", () => {
	const guard = createReplyGuard();
	assert.deepEqual(guard.feed("\x1b]11;rgb:", 1000), { action: "swallow" });
	assert.deepEqual(guard.feed("2887/2a18/", 1060), { action: "swallow" });
	assert.deepEqual(guard.feed("353c\x1b\\", 1120), { action: "forward", data: "\x1b]11;rgb:2887/2a18/353c\x1b\\" });
	assert.equal(guard.pendingSince(), null);
});

test("A7: the kill switch accepts 0/off/false and defaults to enabled", () => {
	assert.equal(isReplyGuardEnabled(undefined), true);
	assert.equal(isReplyGuardEnabled(""), true);
	assert.equal(isReplyGuardEnabled("1"), true);
	assert.equal(isReplyGuardEnabled(" ON "), true);
	for (const off of ["0", "off", "false", " 0 ", "OFF", "False"]) {
		assert.equal(isReplyGuardEnabled(off), false, JSON.stringify(off));
	}
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd <WT> && node --test test/terminal-reply-guard.test.mjs`
Expected: FAIL — `createReplyGuard is not a function` (and `isReplyGuardEnabled is not a function`).

- [ ] **Step 3: Append the state machine**

Append to `<WT>/src/core/terminal-reply-guard.mjs`:

```js
const SWALLOW = Object.freeze({ action: "swallow" });
const PASS = Object.freeze({ action: "pass" });

/**
 * Issue #170 kill switch: `0`, `off` or `false` (case/space-insensitive)
 * disable the guard; unset or anything else keeps it enabled.
 */
export function isReplyGuardEnabled(value) {
	if (value === undefined) return true;
	return !["0", "off", "false"].includes(value.trim().toLowerCase());
}

/**
 * Pure reply-fragment state machine (spec §3.3). Two states only — idle and
 * armed — and no timer of its own: the caller feeds `now` and arms a host
 * timer from `pendingSince()`.
 *
 *   idle  + head            → armed (buffer = event, since = now)  → swallow
 *   idle  + complete        → idle                                  → drop/forward
 *   idle  + plain | other   → idle                                  → pass
 *   armed + plain           → armed, buffer += event                → swallow
 *   armed + plain over cap  → idle (buffer and event are dropped)   → swallow
 *   armed + joined complete → idle                                  → drop/forward joined
 *   armed + head            → armed (stale buffer dropped)          → swallow
 *   armed + complete        → idle (stale buffer dropped)           → handle event alone
 *   armed + other           → idle (stale buffer dropped)           → pass
 *   armed + expire in time  → idle                                  → swallow
 */
export function createReplyGuard({
	windowMs = REPLY_GUARD_WINDOW_MS,
	maxAbsorbBytes = REPLY_GUARD_MAX_ABSORB_BYTES,
} = {}) {
	let armed = false;
	let buffer = "";
	let since = null;

	const reset = () => {
		armed = false;
		buffer = "";
		since = null;
	};
	const decisionFor = (event, data) => (event.action === "forward" ? { action: "forward", data } : SWALLOW);

	return {
		feed(data, now) {
			const event = classifyReplyEvent(data);
			if (!armed) {
				if (event.kind === "reply-head") {
					armed = true;
					buffer = data;
					since = now;
					return SWALLOW;
				}
				if (event.kind === "reply-complete") return decisionFor(event, data);
				return PASS;
			}
			if (event.kind === "other") {
				// Keys, mouse and paste win over absorbing one more fragment.
				reset();
				return PASS;
			}
			if (event.kind === "reply-head") {
				// A fresh head means the previous sequence will never complete.
				buffer = data;
				since = now;
				return SWALLOW;
			}
			if (event.kind === "reply-complete") {
				reset();
				return decisionFor(event, data);
			}
			const joined = buffer + data;
			if (joined.length > maxAbsorbBytes) {
				reset();
				return SWALLOW;
			}
			const joinedEvent = classifyReplyEvent(joined);
			if (joinedEvent.kind === "reply-complete") {
				reset();
				return decisionFor(joinedEvent, joined);
			}
			buffer = joined;
			return SWALLOW;
		},
		expire(now) {
			if (!armed || now - since < windowMs) return null;
			reset();
			return SWALLOW;
		},
		pendingSince() {
			return armed ? since : null;
		},
		reset,
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd <WT> && node --test --test-name-pattern="A2" test/terminal-reply-guard.test.mjs && node --test --test-name-pattern="A3" test/terminal-reply-guard.test.mjs && node --test --test-name-pattern="A5" test/terminal-reply-guard.test.mjs && node --test --test-name-pattern="A7" test/terminal-reply-guard.test.mjs && node --test test/terminal-reply-guard.test.mjs`
Expected: PASS for every pattern and for the whole file (no stale failures).

- [ ] **Step 5: Commit**

```bash
git -C <WT> add src/core/terminal-reply-guard.mjs test/terminal-reply-guard.test.mjs
git -C <WT> commit -m "feat(attach): absorb fragmented terminal replies in a pure state machine (#170)"
```

---

### Task 3: Component wiring + README kill switch (A6, A7 component half, A9)

**Files:**
- Modify: `<WT>/src/ui/pty-attach.ts` (imports; fields after `private oscQueryCarry`; constructor before `this.connect()`; `handleInput` first lines at :297; two helpers after `clearGracefulSocketCloseTimer()`; `close()` after `this.detachColorSchemeBridge()`; the `msg.type === "exit"` branch at :1385)
- Modify: `<WT>/README.md` (one row at the end of the `## Configuration` table, after the `AGENT_BOARD_TERMINAL_SNAPSHOT` row at :327)
- Create: `<WT>/test-support/attach-reply-guard-smoke.ts`
- Create: `<WT>/test/pty-attach-reply-guard.test.mjs`

**Interfaces:**
- Consumes: `createReplyGuard`, `isReplyGuardEnabled`, `REPLY_GUARD_WINDOW_MS` (Task 2); the existing `PtyAttachComponent.send`, `nowFn`, and `close()` cleanup block.
- Produces: `AGENT_BOARD_REPLY_GUARD` env contract; no new public exports.

- [ ] **Step 1: Write the failing smoke + assertion shell**

Create `<WT>/test-support/attach-reply-guard-smoke.ts`:

```ts
// Issue #170 component smoke: the REAL PtyAttachComponent with only the socket
// transport replaced, so the guard wiring — not a stub — decides what reaches
// the child. Shape follows test-support/attach-scheme-readiness-smoke.ts (#180).
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

// Real bytes from upstream #10657: a DA1 reply delivered as four reads.
const DA1_CHUNKS = ["\x1b[?61;6;", "7;22;23;", "24;28;32", ";42c"];
const OSC11_REPLY = "\x1b]11;rgb:2887/2a18/353c\x1b\\";

function fixture() {
	const sent: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	const attach = new PtyAttachComponent(
		tui as never,
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
		{} as never,
		() => {},
		{ socketPath: "/nonexistent/reply-guard.sock", title: "reply-guard" },
	);
	// SAFETY: the production component's real private members; only socket
	// delivery and the connection flag are replaced.
	const internals = attach as unknown as {
		send: (msg: { type: string; data?: string }) => void;
		connected: boolean;
		replyGuard: { pendingSince: () => number | null } | null;
		replyGuardTimer: unknown;
	};
	internals.connected = true;
	internals.send = (msg) => {
		if (msg.type === "input" && msg.data) sent.push(msg.data);
	};
	return { attach, sent, internals };
}

const out: Record<string, unknown> = {};
{
	const f = fixture();
	try {
		for (const chunk of DA1_CHUNKS) f.attach.handleInput(chunk);
		out.guardedFragments = [...f.sent];
		f.attach.handleInput(OSC11_REPLY);
		out.guardedColorReply = [...f.sent];
	} finally {
		f.attach.dispose();
	}
}
{
	process.env.AGENT_BOARD_REPLY_GUARD = "0";
	const f = fixture();
	try {
		for (const chunk of DA1_CHUNKS) f.attach.handleInput(chunk);
		out.killSwitchFragments = [...f.sent];
	} finally {
		f.attach.dispose();
		delete process.env.AGENT_BOARD_REPLY_GUARD;
	}
}
{
	const f = fixture();
	f.attach.handleInput("\x1b[?61;6;");
	out.armedFrames = [...f.sent];
	out.pendingBeforeDispose = f.internals.replyGuard?.pendingSince() ?? null;
	f.attach.dispose();
	out.pendingAfterDispose = f.internals.replyGuard?.pendingSince() ?? null;
	out.timerAfterDispose = f.internals.replyGuardTimer ?? null;
}
console.log(JSON.stringify(out));
```

Create `<WT>/test/pty-attach-reply-guard.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../test-support/attach-reply-guard-smoke.ts", import.meta.url));
const DA1_CHUNKS = ["\x1b[?61;6;", "7;22;23;", "24;28;32", ";42c"];
let cached = null;
const run = () => (cached ??= JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", script], {
	encoding: "utf8", timeout: 15000,
})));

test("A6: fragmented DA1 never reaches the child, color replies still do", () => {
	const out = run();
	assert.deepEqual(out.guardedFragments, [], "four DA1 reads through the real handleInput must emit no input frame");
	assert.deepEqual(out.guardedColorReply, ["\x1b]11;rgb:2887/2a18/353c\x1b\\"], "a complete color reply is forwarded byte-for-byte");
	assert.deepEqual(out.killSwitchFragments, DA1_CHUNKS, "AGENT_BOARD_REPLY_GUARD=0 restores the pre-#170 passthrough");
});

test("A7: an armed window sends nothing and dispose() cleans it up", () => {
	const out = run();
	assert.deepEqual(out.armedFrames, [], "an armed guard must not emit frames");
	assert.notEqual(out.pendingBeforeDispose, null, "the smoke needs an open window for the cleanup assertion");
	assert.equal(out.pendingAfterDispose, null, "dispose() resets the guard");
	assert.equal(out.timerAfterDispose, null, "dispose() clears the window timer");
});
```

- [ ] **Step 2: Run the smoke to verify it fails**

Run: `cd <WT> && node --test test/pty-attach-reply-guard.test.mjs`
Expected: FAIL — `guardedFragments` holds the four DA1 chunks (pre-#170 passthrough), and `killSwitchFragments` may already pass.

- [ ] **Step 3: Wire the guard into the component**

In `<WT>/src/ui/pty-attach.ts`, in this order:

1. Import next to the other `../core/…` imports (after the `terminal-query-sequences.mjs` import at :14):

```ts
import { REPLY_GUARD_WINDOW_MS, createReplyGuard, isReplyGuardEnabled } from "../core/terminal-reply-guard.mjs";
```

2. Fields directly after `private oscQueryCarry = "";`:

```ts
	// Issue #170: inbound reply fragments (device attributes, kitty flags, cell
	// size, DCS) are swallowed, and color replies are forwarded as one whole
	// sequence instead of leaking into the child as garbage. Null when
	// AGENT_BOARD_REPLY_GUARD=0 — the pre-#170 passthrough is the escape hatch.
	private readonly replyGuard: ReturnType<typeof createReplyGuard> | null;
	private replyGuardTimer: ReturnType<typeof setTimeout> | null = null;
```

3. In the constructor body, immediately before `this.connect();`:

```ts
		this.replyGuard = isReplyGuardEnabled(process.env.AGENT_BOARD_REPLY_GUARD) ? createReplyGuard() : null;
```

4. `handleInput` (:297) — the guard goes first, before `parseMouseInputChunk`:

```ts
	handleInput(data: string): void {
		const guard = this.replyGuard;
		if (guard) {
			const decision = guard.feed(data, this.nowFn());
			if (guard.pendingSince() !== null) this.armReplyGuardTimer();
			if (decision.action === "forward") {
				// Color replies only work for the child's parsers as one sequence.
				this.send({ type: "input", data: decision.data });
				return;
			}
			if (decision.action === "swallow") return;
		}
		const mouseInput = parseMouseInputChunk(data);
		// …existing body unchanged from here…
```

5. Two helpers immediately after `clearGracefulSocketCloseTimer()`:

```ts
	/** Issue #170: an open reply window arms exactly one timer. Fragments do not
	 * re-arm it (the window is anchored at the head); a timer that fires while
	 * the window is still open — a newer head moved `since` forward — re-arms
	 * instead of dropping the still-open sequence. */
	private armReplyGuardTimer(): void {
		if (this.replyGuardTimer) return;
		this.replyGuardTimer = setTimeout(() => {
			this.replyGuardTimer = null;
			this.replyGuard?.expire(this.nowFn());
			if (this.replyGuard?.pendingSince() !== null) this.armReplyGuardTimer();
		}, REPLY_GUARD_WINDOW_MS);
		this.replyGuardTimer.unref?.();
	}

	private clearReplyGuardTimer(): void {
		if (!this.replyGuardTimer) return;
		clearTimeout(this.replyGuardTimer);
		this.replyGuardTimer = null;
	}
```

6. `close()` — directly after `this.detachColorSchemeBridge();`:

```ts
		this.clearReplyGuardTimer();
		this.replyGuard?.reset();
```

7. The host-exit branch (`msg.type === "exit"`, :1385) — directly after its `this.detachColorSchemeBridge();`:

```ts
					this.clearReplyGuardTimer();
					this.replyGuard?.reset();
```

- [ ] **Step 4: Run the smoke and the guard unit tests**

Run: `cd <WT> && node --test test/pty-attach-reply-guard.test.mjs && node --test test/terminal-reply-guard.test.mjs`
Expected: PASS (A6 and A7 now green).

- [ ] **Step 5: Document the kill switch (A9)**

Append one row to the `## Configuration` table in `<WT>/README.md`, directly after the `AGENT_BOARD_TERMINAL_SNAPSHOT` row at :327:

```markdown
| `AGENT_BOARD_REPLY_GUARD` | enabled; `0`, `off`, or `false` disables | Discard terminal reply fragments (device attributes, kitty flags, cell size, DCS) that pi-tui delivers as input, and forward color replies whole. While a reply head is open, up to 64 bytes / 250ms of following input is absorbed. |
```

Verify the landing point:

Run: `cd <WT> && rg -n "AGENT_BOARD_REPLY_GUARD" README.md && rg -n "^## Configuration" README.md`
Expected: the row is at a line AFTER the `## Configuration` heading line, inside the variable table (not in prose).

- [ ] **Step 6: Run the full suite and typecheck**

Run: `cd <WT> && npm run typecheck && npm test`
Expected: typecheck clean; all tests pass. Watch specifically for `test/pty-attach-scheme-readiness.test.mjs` and whatever test drives `test-support/attach-startup-color-smoke.ts` — the latter feeds a complete OSC 11 reply through `handleInput` and must still see exactly one forwarded frame.

- [ ] **Step 7: Commit**

```bash
git -C <WT> add src/ui/pty-attach.ts README.md test-support/attach-reply-guard-smoke.ts test/pty-attach-reply-guard.test.mjs
git -C <WT> commit -m "feat(attach): guard the inbound passthrough against terminal reply fragments (#170)"
```

---

### Task 4: Branch verification sweep (A8, A9 evidence, U1–U3 handoff)

**Files:** none modified unless a step fails.

- [ ] **Step 1: Run the repository gate (A8)**

Run: `cd <WT> && npm run verify`
Expected: `typecheck` clean, perf gate passes, `npm test` green, coverage thresholds met, `npm pack --dry-run` lists no unexpected files. The new module must appear in the coverage report with no uncovered decision branch that changes behaviour.

- [ ] **Step 2: Record the A9 evidence**

Run: `cd <WT> && rg -n "AGENT_BOARD_REPLY_GUARD" README.md src/ui/pty-attach.ts src/core/terminal-reply-guard.mjs`
Expected: three hits — README table row, the `handleInput`/constructor wiring, and the `isReplyGuardEnabled` docblock.

- [ ] **Step 3: Hand off the manual acceptance items (U1–U3) — report as `pending`**

Deployment precondition (spec §5): install the modified checkout into the host Pi before observing anything —
`pi install "<WT>"` (per `VERIFY.md:55`) then restart Pi, or `/reload` (per `VERIFY.md:101`); confirm the extension loads without errors and `/agent-board` opens. Then:

| ID | Steps | Pass criterion |
|----|-------|----------------|
| U1 | In a slow-replying terminal (WezTerm+WSL2/ConPTY, mintty), attach to a Pi child and a zsh child, ≥5 times each | The child's composer / shell prompt shows no literal `c7c`-style fragment |
| U2 | Attach a child configured with a light-warm/dark theme from a light terminal | Theme follows the terminal correctly; `attach_settle_scheme` diagnostics still have an outcome (a `timeout` outcome is acceptable) |
| U3 | Attach, then: type normally, PageUp/PageDown, middle-click paste, drag-select copy, and type 10 characters inside 250ms | Five behaviours unchanged; the fast-typing loss never exceeds 64 bytes (record the actual shape otherwise) |

**Do not** mark U1–U3 as passed from unit tests alone; they stay `pending` until a human observes them in a real terminal. Report this as the only open item when the implementation tasks are green.

---

## Traceability (spec acceptance ID → plan location)

| Spec ID | Covered by | Verification command |
|---|---|---|
| A1 | Task 1 steps 1–4 | `node --test --test-name-pattern="A1" test/terminal-reply-guard.test.mjs` |
| A2 | Task 2 steps 1–4 | `node --test --test-name-pattern="A2" test/terminal-reply-guard.test.mjs` |
| A3 (①–⑧) | Task 2 steps 1–4 | `node --test --test-name-pattern="A3" test/terminal-reply-guard.test.mjs` |
| A4 (idle baseline + near-miss prefixes) | Task 1 (pass side), Task 2 (arm side) | `node --test --test-name-pattern="A4" test/terminal-reply-guard.test.mjs` |
| A5 (complete + fragmented) | Task 1 (complete), Task 2 (fragments) | `node --test --test-name-pattern="A5" test/terminal-reply-guard.test.mjs` |
| A6 | Task 3 steps 1, 2, 4 | `node --test test/pty-attach-reply-guard.test.mjs` |
| A7 (kill switch + cleanup) | Task 2 step 1 (unit), Task 3 steps 1, 2, 4 (smoke) | `node --test test/terminal-reply-guard.test.mjs test/pty-attach-reply-guard.test.mjs` |
| A8 | Task 3 step 6, Task 4 step 1 | `npm run typecheck && npm test` / `npm run verify` |
| A9 | Task 3 step 5, Task 4 step 2 | `rg -n "AGENT_BOARD_REPLY_GUARD" README.md` + landing-point check |
| U1–U3 | Task 4 step 3 (user-observed, reported `pending`) | manual, after `pi install "<WT>"` + restart |

No task above exists without an acceptance ID, and every automated ID maps to at least one task step.

## Testability split (spec §6, held as a hard constraint)

- `classifyReplyEvent` — pure, no state, no time: only classification is tested here (A1, A4 pass side, A5 complete forms).
- `createReplyGuard` — pure state machine, `now` injected: fragments, window, cap, reset, kill-switch parsing (A2, A3, A5 fragment forms, A7 unit half).
- `PtyAttachComponent.handleInput` — thin wiring only: three-way decision landing in `send`/`return`, the kill switch, and teardown (A6, A7 smoke half). It must NOT re-implement classification or re-absorb the byte matrix that the pure module already covers.
