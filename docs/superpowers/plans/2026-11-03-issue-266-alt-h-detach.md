# Alt+H detach chord Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Alt+H` as a third unconditional detach chord in the attach view, reusing the exact code path of `Ctrl+←` / `Ctrl+\`.

**Architecture:** Extract the "is this key a detach chord?" decision into a pure resolver (`src/core/attach-detach.mjs`) that the component calls once, replacing the two inline `matchesKey` branches. Encoding behaviour is pinned by a unit matrix; behaviour per editor/socket state is pinned by the existing `detach-gate-smoke` probe. No protocol, storage, or dashboard change.

**Tech Stack:** TypeScript (`src/ui/pty-attach.ts`), plain ESM resolver (`.mjs`), `node:test` + `assert/strict`, pi-tui `matchesKey`, existing c8 coverage gate.

**Spec:** `docs/superpowers/specs/2026-11-03-issue-266-alt-h-detach-design.md`

## Global Constraints

- Tabs for indentation; English comments and commit messages.
- Commit subjects: `feat`/`fix`/`perf`/`refactor`/`docs`/`test`/`chore`, with `(issue #266)` while the PR number does not exist yet.
- No new dependencies; the resolver imports only `@earendil-works/pi-tui`.
- `Alt+H` must reuse `detach()` verbatim — no new teardown path, no protocol change.
- Bare `h`, `Alt+Shift+H`, `Alt+←` stay unbound; the board's `h` = Hold is out of scope.
- Final gate is `npm run verify` (typecheck + perf gate + tests + coverage + `pack:dry`).

## Review Focus

Inputs/conditions the spec implies but no acceptance row names directly; each gets a test in the task that owns the code.

1. A chord coalesced with other bytes in one read must be forwarded unchanged, never half-applied (R8).
2. A bracketed paste containing `ESC h` must stay one segment and never detach (A4).
3. While the host is disconnected the chord must still end the surface with no `input` packet (R4).
4. With the `#147` delete confirm armed, the chord must cancel and detach, never archive (R5).
5. `h`, `Alt+Shift+H` and ordinary text must still reach the child (R6).

---

### Task 1: Pure chord resolver + encoding matrix

**Files:**
- Create: `src/core/attach-detach.mjs`
- Test: `test/attach-detach-chord.test.mjs`

**Interfaces:**
- Produces: `resolveAttachDetachChord(data: string): boolean` — `true` for `ctrl+\`, `ctrl+left`, `alt+h` in any real encoding; `false` for everything else. Task 2 imports it.

- [ ] **Step 1: Write the failing test**

Create `test/attach-detach-chord.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAttachDetachChord } from "../src/core/attach-detach.mjs";
import { splitAttachInput } from "../src/core/pty-scroll.mjs";

// Issue #266 A1: the three unconditional detach chords, each in the encodings a
// real terminal can emit (legacy ESC-prefix / kitty CSI-u / modifyOtherKeys),
// plus the negative matrix that keeps ordinary typing out of the chord set.
const POSITIVE = [
	["ctrl+\\ raw 0x1c", "\x1c"],
	["ctrl+\\ kitty CSI-u", "\x1b[92;5u"],
	["ctrl+\\ modifyOtherKeys", "\x1b[27;5;92~"],
	["ctrl+left xterm", "\x1b[1;5D"],
	["ctrl+left SS3", "\x1bOd"],
	["ctrl+left kitty KP", "\x1b[57417;5u"],
	["alt+h legacy ESC prefix", "\x1bh"],
	["alt+h kitty CSI-u", "\x1b[104;3u"],
	["alt+h kitty alternate key", "\x1b[104:104;3u"],
	["alt+h kitty event type", "\x1b[104;3:1u"],
	["alt+h modifyOtherKeys", "\x1b[27;3;104~"],
];

const NEGATIVE = [
	["bare h", "h"],
	["shifted legacy alt+H", "\x1bH"],
	["ctrl+x", "\x18"],
	["ctrl+alt+h kitty", "\x1b[104;7u"],
	["shift+alt+h kitty", "\x1b[104;4u"],
	["alt+h with text codepoint", "\x1b[104;3;104u"],
	["plain text", "abc"],
	["lone escape", "\x1b"],
	["ctrl+] passthrough", "\x1d"],
];

test("resolveAttachDetachChord: encoding matrix (issue #266 A1)", () => {
	for (const [label, data] of POSITIVE) {
		assert.equal(resolveAttachDetachChord(data), true, `${label} must detach`);
	}
	for (const [label, data] of NEGATIVE) {
		assert.equal(resolveAttachDetachChord(data), false, `${label} must not detach`);
	}
});

// A4: a bracketed paste is one key segment; ESC h inside it must never resolve.
test("resolveAttachDetachChord: paste containing ESC h never detaches (issue #266 A4)", () => {
	const segments = splitAttachInput("\x1b[200~a\x1bhb\x1b[201~");
	assert.equal(segments.length, 1);
	assert.equal(segments[0].kind, "key");
	assert.equal(resolveAttachDetachChord(segments[0].data), false);
});

test("resolveAttachDetachChord: ESC and h in separate reads are not the chord (issue #266 A4)", () => {
	const escSegments = splitAttachInput("\x1b");
	const hSegments = splitAttachInput("h");
	assert.equal(resolveAttachDetachChord(escSegments[0].data), false);
	assert.equal(resolveAttachDetachChord(hSegments[0].data), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/attach-detach-chord.test.mjs`

Expected: FAIL — `Cannot find module '../src/core/attach-detach.mjs'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/core/attach-detach.mjs`:

```js
import { Key, matchesKey } from "@earendil-works/pi-tui";

/**
 * Issue #266: the attach view's unconditional detach chords. Pure — no
 * component state, no socket, no editor cache: a chord is exit intent or it is
 * forwarded. Callers must run the #147 delete-confirm resolver first, so an
 * armed confirm still cancels before the chord closes the surface.
 *
 * - `ctrl+\` (raw 0x1c) — the terminal-independent escape (issue #126): one raw
 *   ASCII byte every terminal forwards unchanged in raw mode; the kitty CSI-u
 *   and modifyOtherKeys encodings of the same chord match too.
 * - `ctrl+left` — unambiguous intent while a draft sits in the editor
 *   (issue #89); a single ← stays gated on the pushed editorEmpty channel.
 * - `alt+h` — vim's h is "left" (issue #266). The bare letter must keep
 *   reaching the child editor, so the chord is the modified key; a segment
 *   that coalesces the chord with other bytes does not match and is forwarded
 *   unchanged.
 * @param {string} data one key segment from splitAttachInput
 * @returns {boolean}
 */
export function resolveAttachDetachChord(data) {
	return (
		matchesKey(data, "ctrl+\\") ||
		matchesKey(data, Key.ctrl("left")) ||
		matchesKey(data, Key.alt("h"))
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/attach-detach-chord.test.mjs`

Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/core/attach-detach.mjs test/attach-detach-chord.test.mjs
git commit -m "feat(attach): pure detach-chord resolver incl. Alt+H (issue #266)"
```

---

### Task 2: Wire the resolver into the attach view + state scenarios

**Files:**
- Modify: `src/ui/pty-attach.ts` (import block near line 8; replace old lines 434–455)
- Modify: `test-support/detach-gate-smoke.ts` (append `R1`–`R6`, `R8` before the final `console.log`)
- Modify: `test/pty-attach-detach-gate.test.mjs` (assertions for the new keys)

**Interfaces:**
- Consumes: `resolveAttachDetachChord(data)` from Task 1.
- Produces: new smoke-report keys `altHDetachesOnDraft`, `altHDetachesOnEmptyEditor`, `altHDetachesWithoutEditorState`, `altHDetachesWhileDisconnected`, `altHCancelsThenDetaches`, `altHLeavesOtherKeysToTheChild`, `altHCoalescedSegmentForwards`.

- [ ] **Step 1: Write the failing scenarios and assertions**

In `test-support/detach-gate-smoke.ts`, append these blocks immediately before the final `console.log(JSON.stringify(out))` line (the file currently ends with that print):

```ts
// R1. Issue #266: Alt+H detaches unconditionally while a draft sits in the
// editor — the same guarantee as Ctrl+← (#89), with no editor gate.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(fixtureInternals<{ onSocketData: (t: string) => void }>(attach)).onSocketData(JSON.stringify({ type: "editor_state", empty: false }) + "\n");
	(fixtureInternals<{ connected: boolean }>(attach)).connected = true;
	attach.handleInput("\x1bh");
	out.altHDetachesOnDraft = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// R2. Issue #266: the chord also detaches from a genuinely empty editor —
// same unconditional guarantee on the other side of the gate.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m \x1b[27m");
	(fixtureInternals<{ onSocketData: (t: string) => void }>(attach)).onSocketData(JSON.stringify({ type: "editor_state", empty: true }) + "\n");
	(fixtureInternals<{ connected: boolean }>(attach)).connected = true;
	attach.handleInput("\x1bh");
	out.altHDetachesOnEmptyEditor = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// R3. Issue #266: the null quadrant — no editor_state ever pushed — still
// detaches: the chord never consults the gate.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(fixtureInternals<{ connected: boolean }>(attach)).connected = true;
	attach.handleInput("\x1bh");
	out.altHDetachesWithoutEditorState = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// R4. Issue #266: while disconnected the chord still ends the surface and the
// key is never forwarded as input (same contract as Ctrl+\ on a dead socket).
{
	const { attach, sent, resultAction } = makeAttach();
	attach.handleInput("\x1bh");
	out.altHDetachesWhileDisconnected = resultAction() === "detached" && !sent.some((m) => m.type === "input");
	attach.dispose();
}

// R5. Issue #266 + #147: with the delete confirm armed the chord cancels the
// confirm and detaches — it never archives and never forwards the chord.
{
	const { attach, sent, resultAction } = makeAttach();
	attach.handleInput("\x18");
	attach.handleInput("\x1bh");
	out.altHCancelsThenDetaches = resultAction() === "detached"
		&& !sent.some((m) => m.type === "input")
		&& sent.filter((m) => m.type === "detach").length === 1;
	attach.dispose();
}

// R6. Issue #266 isolation: keys that are NOT the chord still reach the child
// unchanged — bare h, shifted Alt+H and ordinary text.
{
	let allForwarded = true;
	for (const data of ["h", "\x1bH", "abc"]) {
		const probe = makeAttach();
		(fixtureInternals<{ connected: boolean }>(probe.attach)).connected = true;
		probe.attach.handleInput(data);
		allForwarded = allForwarded && !probe.didDetach()
			&& probe.sent.length === 1 && probe.sent[0].type === "input" && probe.sent[0].data === data;
		probe.attach.dispose();
	}
	out.altHLeavesOtherKeysToTheChild = allForwarded;
}

// R8. Issue #266 review focus: a chord coalesced with another chord in ONE read
// is not a match — the whole segment is forwarded unchanged, never half-applied.
{
	const { attach, sent, didDetach } = makeAttach();
	(fixtureInternals<{ connected: boolean }>(attach)).connected = true;
	attach.handleInput("\x1bh\x1bh");
	out.altHCoalescedSegmentForwards = !didDetach()
		&& sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1bh\x1bh";
	attach.dispose();
}
```

Update the harness header comment block (the `//   P1-P7 …` list near the top) by appending one line:

```ts
//   R1-R6/R8. Issue #266: Alt+H detaches unconditionally in every
//       editor/socket quadrant, cancels an armed delete confirm first, leaves
//       other keys to the child, and never half-applies a coalesced segment.
```

In `test/pty-attach-detach-gate.test.mjs`, add these assertions at the end of the existing `test("attach detach gate: …")` body, right after the `printableQStillForwardsToChild` assertion:

```js
	// Issue #266: Alt+H joins the unconditional detach set (vim h = left).
	assert.equal(parsed.altHDetachesOnDraft, true, "Alt+H must detach with a pushed draft (issue #266)");
	assert.equal(parsed.altHDetachesOnEmptyEditor, true, "Alt+H must detach from an empty editor (issue #266)");
	assert.equal(parsed.altHDetachesWithoutEditorState, true, "Alt+H must detach with no editor_state at all (issue #266)");
	assert.equal(parsed.altHDetachesWhileDisconnected, true, "Alt+H must end the surface while disconnected (issue #266)");
	assert.equal(parsed.altHCancelsThenDetaches, true, "Alt+H must cancel an armed delete confirm and detach, never archive (issue #266)");
	assert.equal(parsed.altHLeavesOtherKeysToTheChild, true, "h, Alt+Shift+H and text must still reach the child (issue #266)");
	assert.equal(parsed.altHCoalescedSegmentForwards, true, "a coalesced chord segment must be forwarded unchanged (issue #266)");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pty-attach-detach-gate.test.mjs`

Expected: FAIL — `parsed.altHDetachesOnDraft` is `false` (the chord is forwarded as input today), and `parsed.altHCoalescedSegmentForwards` may already pass. The assertions for R1–R5 fail before the wiring.

- [ ] **Step 3: Wire the resolver**

In `src/ui/pty-attach.ts`, after the existing `import { resolveAttachDeleteKey } from "../core/attach-delete.mjs";` line add:

```ts
import { resolveAttachDetachChord } from "../core/attach-detach.mjs";
```

Replace the two consecutive branches (old lines 434–455: `if (matchesKey(data, "ctrl+\\")) { … }` and `if (matchesKey(data, Key.ctrl("left"))) { … }`) with:

```ts
		if (resolveAttachDetachChord(data)) {
			// Issue #266: unconditional detach chords — Ctrl+\ (raw 0x1c, #126),
			// Ctrl+← (#89) and Alt+H (vim h = left). Bare ← stays gated on the
			// pushed editor_state; a chord needs no gate. Rationale and the
			// encoding matrix live in src/core/attach-detach.mjs.
			this.detach();
			return;
		}
```

Ordering must not change: the block stays after the `resolveAttachDeleteKey` section and before the `Key.left` branch.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/pty-attach-detach-gate.test.mjs`

Expected: PASS.

Then: `node --test test/attach-detach-chord.test.mjs` — PASS (Task 1 unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/ui/pty-attach.ts test-support/detach-gate-smoke.ts test/pty-attach-detach-gate.test.mjs
git commit -m "feat(attach): Alt+H detaches via the shared chord resolver (issue #266)"
```

---

### Task 3: Advertise the chord in the view and the README

**Files:**
- Modify: `src/ui/pty-attach.ts:575` (header) and `:591` (loading hint)
- Modify: `README.md:96` and `:219`
- Modify: `test-support/detach-gate-smoke.ts` (append `R7`)
- Modify: `test/pty-attach-detach-gate.test.mjs`

**Interfaces:**
- Produces: smoke key `headerMentionsAltH`, plus a README that documents the chord and its terminal prerequisites. No new functions.

- [ ] **Step 1: Write the failing hint scenario**

Append to `test-support/detach-gate-smoke.ts` (before the final print, after `R8`):

```ts
// R7. Issue #266: the surface advertises the chord — the live header and the
// loading hint both name Alt+H next to the existing chords.
{
	const loading = makeAttach();
	const loadingLines = loading.attach.render(80).join("\n");
	const loadingMentions = loadingLines.includes("Alt+H");
	loading.attach.dispose();
	const live = makeAttach();
	await writeToTerm(live.attach, "chat content\r\n");
	out.headerMentionsAltH = live.attach.render(80)[0].includes("Alt+H") && loadingMentions;
	live.attach.dispose();
}
```

Add the assertion in `test/pty-attach-detach-gate.test.mjs` right after the `headerMentionsCtrlBackslash` assertion:

```js
	assert.equal(parsed.headerMentionsAltH, true, "the live header and loading hint must advertise the Alt+H chord (issue #266)");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pty-attach-detach-gate.test.mjs`

Expected: FAIL — `parsed.headerMentionsAltH` is `false`.

- [ ] **Step 3: Update the two hints**

In `src/ui/pty-attach.ts:575`, change the muted header text to:

```ts
			  this.theme.fg("muted", `${this.status} · opens links · drag selects+copies · Ctrl+←/Ctrl+\\/Alt+H detach`);
```

In `src/ui/pty-attach.ts:591`, change the centered loading hint to:

```ts
		out.push(center(this.theme.fg("dim", "Ctrl+←/Ctrl+\\/Alt+H to detach"), width));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pty-attach-detach-gate.test.mjs`

Expected: PASS.

- [ ] **Step 5: Update the README**

In `README.md:96`, after the sentence fragment `or `Ctrl+\` — the unconditional escape: it detaches regardless of editor state on any terminal that forwards the raw 0x1c byte (raw, kitty, and modifyOtherKeys keyboard modes all work).` insert:

```text
 `Alt+H` is the vim-style third escape (`h` = left) and detaches with the same unconditional contract — draft or empty editor, known or unknown editor state, live or dead host; the key is captured from the child while attached (the child Pi binds no `alt+h`). It needs a terminal that delivers Alt as Meta: macOS Terminal.app and iTerm2 require "Use Option as Meta key", and GNOME Terminal's `_Help` menu mnemonic takes Alt+H before the app sees it.
```

In `README.md:219`, after the fragment `and `Ctrl+\` is the unconditional escape — a single raw ASCII byte (0x1c) that terminals forward unchanged in raw mode (kitty CSI-u and modifyOtherKeys encodings included), honored no matter what the child editor reports.` insert:

```text
 `Alt+H` (vim's `h` = left) is the third unconditional escape, with the same guarantee and the same capture-from-the-child trade-off; it needs Alt delivered as Meta (macOS Terminal.app / iTerm2: "Use Option as Meta key"; GNOME Terminal reserves Alt+H for its `_Help` menu).
```

- [ ] **Step 6: Verify the static acceptance check**

Run: `grep -n 'Alt+H' README.md` and `grep -n 'Option as Meta' README.md`

Expected: two `Alt+H` hits (one per paragraph) and at least two `Option as Meta` hits.

- [ ] **Step 7: Commit**

```bash
git add src/ui/pty-attach.ts README.md test-support/detach-gate-smoke.ts test/pty-attach-detach-gate.test.mjs
git commit -m "docs(attach): advertise the Alt+H detach chord in hints and README (issue #266)"
```

---

### Task 4: Full verification gate

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`

Expected: typecheck clean; perf gate passes; the whole `test/*.test.mjs` suite passes with no leaked coordinators; c8 thresholds (lines 85 / funcs 80 / branches 70) hold; `pack:dry` lists the same file set as before this branch (the new `src/core/attach-detach.mjs` is included by the `src` glob).

- [ ] **Step 2: Confirm the new files ship**

Run: `npm run pack:dry 2>&1 | grep -n 'attach-detach'`

Expected: `src/core/attach-detach.mjs` appears in the tarball listing.

- [ ] **Step 3: Fix or report**

If coverage drops below threshold, add the missing negative case to `test/attach-detach-chord.test.mjs` rather than raising thresholds. If anything else fails, fix it in this branch and commit with a `fix`/`test` subject referencing `(issue #266)`.

---

### Task 5: Manual verification (post-PR, blocks merge)

**Files:** none. Copied from spec §9 so the executor does not need to reopen the spec.

**Interfaces:** none.

- [ ] **Step 1: Launch the worktree build**

```bash
WT=/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-266-alt-h-detach
pi -ne -e "$WT/src/index.ts"
```

`-ne` disables extension discovery (so the installed copy at `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board` cannot load alongside), `-e` loads the worktree entry.

- [ ] **Step 2: Four observations**

1. Attach a session, press `Alt+H` → back on the board; re-attach shows the child session still alive with its history.
2. Re-attach, type a draft into the child editor, press `Alt+H` → back on the board (bare `←` would have been forwarded instead).
3. Re-attach, press `Ctrl+X` (header shows `Delete "…"?`), then `Alt+H` → back on the board and the row is **not** archived.
4. Re-attach, press `Alt+Shift+H` → the child receives it as ordinary input; no detach.

- [ ] **Step 3: Record the result**

Post the four observations on the PR (or issue #266) as the U1 evidence line, including terminal name and version (this box: WezTerm). Any mismatch is a U1 failure: fix before merge, do not mark it `pending`.
