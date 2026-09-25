# #140 control-reconcile 偶红收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two load-sensitive assertions in `test/control-reconcile.integration.test.mjs` (signatures A `:295` / B `:383`) deterministic and invariant-true, by windowing the test recorder and realigning assertions to what the design actually guarantees; product change is one comment only.

**Architecture:** The test harness's cross-socket `messages`/`events` accumulators get a `mark()/since()` window API (extracted as a pure `createRecorder()`), assertion logic moves into pure predicates (`distinctSeqsFrom` / `hasWireOverlap` / `isContiguousFrom`), and two deterministic interleaving cases are added via harness-side injection seams (`deferWrite` / `deferFeed`, default 0 = zero behavior change). Spec: `docs/superpowers/specs/2026-09-24-control-reconcile-flake-design.md` (v3, approved).

**Tech Stack:** Node built-ins only (`node:test`, `node:assert/strict`, `node:net`, `node:fs`). No new dependencies.

**Acceptance-ID ↔ Task mapping:** A1,A2→Task1 · A9→Task2 · A3→Task3 · A4→Task4 · A5→Task5 · A6→Task6 · D6,A9→Task7 · A7,A8→Task8. No acceptance item is taskless; no task is acceptance-less.

## Global Constraints

- **Work from:** `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-140-control-reconcile-flake` (absolute paths; never touch the main checkout).
- **Product behavior is frozen:** the ONLY product-file change is the comment realignment in Task 7 (spec D6). No behavioral edits to `src/` or `runner/`.
- New logic (predicates, recorder, injection seams, new test cases) lives in `test/control-reconcile.integration.test.mjs` only.
- Injection seams default to no-op (`0` delay); existing tests must stay byte-for-byte equivalent in behavior when no injection is armed.
- Test names in the affected set keep matching `--test-name-pattern="A2: reconnect|A2 epoch"` (the §10 test is intentionally out of the stability loop).
- Stage per file (`git add <path>`), never `git add -A`. Conventional commits, English.
- Steady tick is 25ms (`test-support/fake-pty-pi.mjs:16`); deferral margins are `150`ms (subscribe write, ≈6 ticks, measured 3/3) and `300`ms (snapshot-path feed). Do not lower them.

---

### Task 1: Seq-window predicates + `createRecorder()` (A1, A2)

**Files:**
- Modify: `test/control-reconcile.integration.test.mjs` (insert after the `listen()` helper, before `let instanceCounter = 0;`)

**Interfaces:**
- Produces (consumed by Tasks 2–6):
  - `distinctSeqsFrom(seqs: number[], from: number): number[]` — distinct seqs strictly `> from`, first-occurrence order.
  - `hasWireOverlap(seqs: number[]): boolean` — true iff any seq repeats.
  - `isContiguousFrom(distinct: number[], from: number, count: number): boolean` — first `count` distinct seqs are exactly `from+1..from+count`.
  - `createRecorder(): { messages: any[]; events: {event: string, payload: any}[]; mark(): {m: number, e: number}; messagesSince(mark): any[]; eventsSince(mark): {event: string, payload: any}[] }`

- [ ] **Step 1: Record the baseline**

Run: `node --test test/control-reconcile.integration.test.mjs 2>&1 | tail -5`
Expected: all tests pass; note the `# pass`/`# fail` counts for the PR description.

- [ ] **Step 2: Write the failing unit tests**

Insert directly above `let instanceCounter = 0;`:

```js
// --- #140: seq-window predicates (pure) and the windowed recorder ----------

test("seq window predicates: distinctSeqsFrom keeps first-occurrence order and drops <= from", () => {
	assert.deepEqual(distinctSeqsFrom([7, 7, 8, 9, 7], 6), [7, 8, 9]);
	assert.deepEqual(distinctSeqsFrom([9, 10, 9, 11], 8), [9, 10, 11]);
	assert.deepEqual(distinctSeqsFrom([13, 14, 15, 16, 17, 18, 13, 14, 15, 16, 17, 18], 12), [13, 14, 15, 16, 17, 18]);
	assert.deepEqual(distinctSeqsFrom([1, 2, 3], 3), []); // boundary: `from` itself excluded
});

test("seq window predicates: hasWireOverlap", () => {
	assert.equal(hasWireOverlap([7, 7, 8]), true);
	assert.equal(hasWireOverlap([7, 8, 9]), false);
	assert.equal(hasWireOverlap([]), false);
});

test("seq window predicates: isContiguousFrom", () => {
	assert.equal(isContiguousFrom([7, 8, 9], 6, 3), true);
	assert.equal(isContiguousFrom([8, 9, 10], 6, 3), false); // replay start too high (gap at 7)
	assert.equal(isContiguousFrom([7, 9, 10], 6, 3), false); // a dropped chunk
	assert.equal(isContiguousFrom([7, 8], 6, 3), false); // not enough yet
});

test("recorder window: since(mark) excludes everything before the mark", () => {
	const rec = createRecorder();
	rec.messages.push({ type: "hello" });
	rec.events.push({ event: "snapshotReady", payload: { nextSeq: 1 } });
	const mark = rec.mark();
	rec.messages.push({ type: "output", seq: 7 });
	rec.events.push({ event: "output", payload: "x" });
	assert.equal(rec.messagesSince(mark).length, 1);
	assert.equal(rec.messagesSince(mark)[0].seq, 7);
	assert.equal(rec.eventsSince(mark)[0].event, "output");
	assert.equal(rec.messages.length, 2); // live arrays: legacy accessors keep working
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test --test-name-pattern="seq window predicates|recorder window" test/control-reconcile.integration.test.mjs`
Expected: FAIL — `ReferenceError: distinctSeqsFrom is not defined` (or equivalent).

- [ ] **Step 4: Implement (same insertion point, above the tests)**

```js
/** Distinct seqs strictly greater than `from`, in first-occurrence order. */
function distinctSeqsFrom(seqs, from) {
	const seen = new Set();
	const out = [];
	for (const s of seqs) {
		if (typeof s !== "number" || s <= from) continue;
		if (!seen.has(s)) {
			seen.add(s);
			out.push(s);
		}
	}
	return out;
}

/** True when the wire repeated at least one seq — the broadcast→replay overlap. */
function hasWireOverlap(seqs) {
	return new Set(seqs).size !== seqs.length;
}

/** The first `count` distinct seqs must be exactly from+1 .. from+count (no gap). */
function isContiguousFrom(distinct, from, count) {
	if (distinct.length < count) return false;
	for (let i = 0; i < count; i += 1) {
		if (distinct[i] !== from + i + 1) return false;
	}
	return true;
}

/**
 * Cross-socket wire/event recorder with windows (#140): `mark()` snapshots the
 * current lengths; `messagesSince(mark)` / `eventsSince(mark)` scope reads to
 * everything recorded AFTER the mark, so pre-reconnect residue can never leak
 * into post-reconnect assertions. `messages` / `events` stay live arrays for
 * the legacy accessors.
 */
function createRecorder() {
	const messages = [];
	const events = [];
	return {
		messages,
		events,
		mark: () => ({ m: messages.length, e: events.length }),
		messagesSince: (mark) => messages.slice(mark.m),
		eventsSince: (mark) => events.slice(mark.e),
	};
}
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test --test-name-pattern="seq window predicates|recorder window" test/control-reconcile.integration.test.mjs`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add test/control-reconcile.integration.test.mjs
git commit -m "test: seq-window predicates + windowed recorder (issue #140, A1/A2)"
```

---

### Task 2: Wire the harness to the recorder + injection seams (A9 regression gate; enabler for A3–A6)

**Files:**
- Modify: `test/control-reconcile.integration.test.mjs` — `attachClientOverSocket()` only

**Interfaces:**
- Consumes: `createRecorder()` (Task 1).
- Produces (consumed by Tasks 3–6):
  - `attachClientOverSocket(socket, { clientId?, deferWrite?: (msg) => number, deferFeed?: (msg) => number })`
  - `h.mark()`, `h.messagesSince(mark)`, `h.eventsSince(mark)` (new accessors; all existing accessors unchanged)

- [ ] **Step 1: Change the harness signature and internals**

Replace the first lines of `attachClientOverSocket`:

```js
function attachClientOverSocket(socket, { clientId = "reconcile-ui", deferWrite = () => 0, deferFeed = () => 0 } = {}) {
	const sent = [];
	const rec = createRecorder();
	const { messages, events } = rec;
	let buf = "";
	let current = socket;
	const route = (msg) => {
		sent.push(msg);
		// Injection seam (#140 A4): defer the WRITE only. `sent` records before
		// the deferral, so wire-order assertions stay truthful.
		const writeDelay = deferWrite(msg);
		if (writeDelay > 0) {
			const target = current;
			setTimeout(() => {
				try { target.write(JSON.stringify(msg) + "\n"); } catch { /* socket death is the close handler's job */ }
			}, writeDelay);
			return;
		}
		try { current.write(JSON.stringify(msg) + "\n"); } catch { /* socket death is the close handler's job */ }
	};
	const feed = (chunk) => {
		buf += chunk.toString("utf8");
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let msg;
			try { msg = JSON.parse(line); } catch { continue; }
			// Injection seam (#140 A6): defer BOTH the recording and the client
			// handling — a slow consumer, for one message class only.
			const feedDelay = deferFeed(msg);
			if (feedDelay > 0) {
				setTimeout(() => {
					messages.push(msg);
					client.handleMessage(msg);
				}, feedDelay);
				continue;
			}
			messages.push(msg);
			client.handleMessage(msg);
		}
	};
```

(The rest of the function — `createTerminalAttachClient`, `bind`, the return object — is unchanged.)

- [ ] **Step 2: Extend the returned object**

Inside the existing return object of `attachClientOverSocket`, add after `eventsOf`:

```js
		mark: () => rec.mark(),
		messagesSince: (mark) => rec.messagesSince(mark),
		eventsSince: (mark) => rec.eventsSince(mark),
```

- [ ] **Step 3: Zero-behavior-change regression gate**

Run: `node --test test/control-reconcile.integration.test.mjs`
Expected: all tests pass (same counts as Task 1 Step 1). If any test differs, the seams are not no-ops — fix before proceeding.

- [ ] **Step 4: Recorder-use audit (spec §4 plan-stage audit item)**

Run: `rg -n "h\.(messages|events|outputSeqs|echoCount|eventsOf|mark|messagesSince|eventsSince)" test/control-reconcile.integration.test.mjs`
Classify every hit: (a) in-window (same socket era) → leave; (b) cross-reconnect → must go through a window or a count-growth wait. Expected conclusions to record in the task report:
- `:293-295` region → Task 3 rewrites.
- `:379-384` region → Task 5 rewrites.
- `echoCount("echo:resume-probe")` is safe *by coincidence* (the echo chunk's seq ≤ both disconnect cursors, so no replay re-sends it) — document, do not change.
- `eventsOf("hello")` lookups are already scoped by `generation` / `status.instanceId` → safe.
- The §10 test uses its own `mon.messages` listener, not this recorder → out of scope.

- [ ] **Step 5: Commit**

```bash
git add test/control-reconcile.integration.test.mjs
git commit -m "test: windowed recorder wiring + deferWrite/deferFeed seams (issue #140)"
```

---

### Task 3: Signature A assertion → no-gap over distinct seqs (A3)

**Files:**
- Modify: `test/control-reconcile.integration.test.mjs:288-295` (the A2 reconnect test's continuation block)

**Interfaces:**
- Consumes: `distinctSeqsFrom`, `isContiguousFrom` (Task 1).

- [ ] **Step 1: Replace the assertion block**

Replace:

```js
		// Gap-free, duplicate-free continuation after the reconnect.
		await waitFor(() => h.outputSeqs().filter((s) => s > disconnectSeq).length >= 3);
		const resumed = h.outputSeqs().filter((s) => s > disconnectSeq).slice(0, 3);
		assert.deepEqual(resumed, [disconnectSeq + 1, disconnectSeq + 2, disconnectSeq + 3], "no gap, no duplicate after reconnect");
```

with:

```js
		// Gap-free continuation after the reconnect. The WIRE may legally repeat
		// seqs at the broadcast→replay handoff (#140 signature A): a stray the
		// runner raw-wrote before processing our subscribe can only be DELIVERED
		// after we sent it, so the client cannot fold it into the cursor — the
		// ring replay re-sends it and seq-checked consumption dedups. The
		// invariant is "no gap over the distinct seqs"; a UI-level duplicate is
		// the marker guard's job below.
		await waitFor(() => distinctSeqsFrom(h.outputSeqs(), disconnectSeq).length >= 3);
		const distinct = distinctSeqsFrom(h.outputSeqs(), disconnectSeq);
		assert.ok(
			isContiguousFrom(distinct, disconnectSeq, 3),
			`no gap after reconnect: distinct seqs past the cursor were ${JSON.stringify(distinct.slice(0, 8))}`,
		);
		await waitFor(() => h.client.getLastSeq() >= disconnectSeq + 3, 10000);
```

(Leave the marker-guard block that follows untouched — it is the UI-level authority.)

- [ ] **Step 2: Run the test 5 times**

Run: `for i in 1 2 3 4 5; do node --test --test-name-pattern="A2: reconnect wires" test/control-reconcile.integration.test.mjs 2>&1 | grep -c "^not ok"; done`
Expected: `0` five times.

- [ ] **Step 3: Commit**

```bash
git add test/control-reconcile.integration.test.mjs
git commit -m "test: reconnect continuation asserts no-gap over distinct seqs (issue #140, A3)"
```

---

### Task 4: Deterministic overlap interleaving — second reconnect phase (A4)

**Files:**
- Modify: `test/control-reconcile.integration.test.mjs` — the A2 reconnect test: declaration line (`let socket2 = null;` → add `let socket3 = null;`), harness creation, the tail of the test body, and the `finally` block.

**Interfaces:**
- Consumes: `deferWrite` seam (Task 2), `distinctSeqsFrom`, `hasWireOverlap`, `isContiguousFrom` (Task 1), `h.mark()/messagesSince` (Task 2).

- [ ] **Step 1: Declare the arming flag and pass the seam**

Above `const h = attachClientOverSocket(socket1);` add:

```js
	let deferSecondSubscribe = false;
```

and change the creation to:

```js
	const h = attachClientOverSocket(socket1, {
		deferWrite: (msg) => (deferSecondSubscribe && msg.type === "subscribe_terminal" ? 150 : 0),
	});
```

- [ ] **Step 2: Add the phase-2 block**

Replace the trailing `socket2.destroy();` of the test body (the one after `assert.equal(h.echoCount("echo:resume-probe"), 1, ...)`) with:

```js
		// --- #140 signature A: deterministic overlap interleaving (A4) --------
		// Second reconnect on the SAME runner, with the subscribe WRITE deferred
		// past ~6 steady ticks (150ms >= 4x the 25ms tick; 40ms measured only
		// 2/5). During the deferral the runner keeps raw-broadcasting to the
		// unsubscribed socket — exactly the CI window. `sent` records before the
		// deferral, so the wire-order assertion above stays truthful.
		const drop2 = h.client.getLastSeq();
		socket2.destroy();
		socket3 = await connectControl(socketPath);
		h.switchSocket(socket3);
		const phase2 = h.mark();
		deferSecondSubscribe = true;
		h.hello();
		h.client.reconnect(drop2);

		// Non-vacuity: the overlap must actually appear (in-flight strays the
		// client could not fold in, re-sent by the ring replay).
		await waitFor(() => hasWireOverlap(h.outputSeqs().filter((s) => s > drop2)), 5000);
		const distinct2 = distinctSeqsFrom(h.outputSeqs(), drop2);
		assert.ok(
			isContiguousFrom(distinct2, drop2, 3),
			`no gap under the wire overlap: distinct seqs were ${JSON.stringify(distinct2.slice(0, 8))}`,
		);
		await waitFor(() => h.client.getLastSeq() >= drop2 + 3, 10000);
		// UI exactly-once still holds under the overlap (marker guard, phase 2).
		{
			const wireMarkers2 = h.messagesSince(phase2)
				.filter((m) => m.type === "output" && typeof m.seq === "number" && m.seq > drop2)
				.flatMap((m) => String(m.data ?? "").match(/steady-\d+/g) ?? []);
			const uiMarkers2 = h.events
				.filter((e) => e.event === "output")
				.flatMap((e) => String(e.payload ?? "").match(/steady-\d+/g) ?? []);
			const uiCounts2 = new Map();
			for (const mk of uiMarkers2) uiCounts2.set(mk, (uiCounts2.get(mk) ?? 0) + 1);
			for (const mk of new Set(wireMarkers2)) {
				assert.equal(uiCounts2.get(mk) ?? 0, 1, `steady marker ${mk} delivered to the UI exactly once (overlap phase)`);
			}
		}
		socket3.destroy();
```

In the `finally` block, extend the cleanup line to:

```js
		try { socket2?.destroy(); socket3?.destroy(); } catch {}
```

- [ ] **Step 3: Run the test 5 times**

Run: `for i in 1 2 3 4 5; do node --test --test-reporter=tap --test-name-pattern="A2: reconnect wires" test/control-reconcile.integration.test.mjs 2>&1 | grep -c "^not ok"; done`
Expected: `0` five times, and each run exercises the overlap (the `waitFor(hasWireOverlap)` must not time out). If the non-vacuity wait proves flaky, apply spec D7: remove this phase, record the reason in the PR description, and note it in the issue.

- [ ] **Step 4: Commit**

```bash
git add test/control-reconcile.integration.test.mjs
git commit -m "test: deterministic broadcast/replay overlap phase in A2 reconnect (issue #140, A4)"
```

---

### Task 5: Signature B assertion → condition-based fresh-baseline wait (A5)

**Files:**
- Modify: `test/control-reconcile.integration.test.mjs` — the A2 epoch test: one insertion before `h.client.reconnect(disconnectSeq);`, one replacement at `:379-384`.

**Interfaces:**
- Consumes: none new (plain count-growth wait).

- [ ] **Step 1: Capture the baseline count BEFORE the reconnect**

Directly above `h.client.reconnect(disconnectSeq);` insert:

```js
		// Taken before the reconnect can possibly fire the epoch reset: the
		// fresh snapshotReady must be counted from HERE, not from assertion
		// time (the old `.at(-1)`-on-existence wait returned the stale
		// pre-restart event instantly — #140 signature B).
		const readyCountBeforeReconnect = h.eventsOf("snapshotReady").length;
```

- [ ] **Step 2: Replace the assertion block**

Replace:

```js
		// The fresh baseline: snapshot (empty or framed) then live continuation
		// from ITS nextSeq — the old cursor is gone.
		const ready2 = await waitFor(() => h.eventsOf("snapshotReady").at(-1));
		assert.equal(typeof ready2.nextSeq, "number");
		await waitFor(() => h.outputSeqs().length >= 1, 10000);
		assert.ok(h.outputSeqs().at(-1) >= ready2.nextSeq, "live output continues from the new baseline");
		assert.ok(h.client.getLastSeq() >= ready2.nextSeq - 1);
```

with:

```js
		// The fresh baseline: snapshot (empty or framed) then live continuation
		// from ITS nextSeq — the old cursor is gone. Wait for the snapshotReady
		// COUNT to grow (the old existence-check never waited), and assert the
		// invariant client-level: the applied cursor reaches the new baseline
		// and then advances with a live chunk beyond it. The old wire-level
		// `.at(-1)` compared a cross-socket accumulator against a possibly
		// stale baseline — not a valid invariant (#140 signature B).
		const ready2 = await waitFor(
			() => (h.eventsOf("snapshotReady").length > readyCountBeforeReconnect ? h.eventsOf("snapshotReady").at(-1) : null),
			10000,
		);
		assert.equal(typeof ready2.nextSeq, "number");
		await waitFor(() => h.client.getLastSeq() >= ready2.nextSeq, 10000);
```

- [ ] **Step 3: Run the epoch test 5 times**

Run: `for i in 1 2 3 4 5; do node --test --test-reporter=tap --test-name-pattern="A2 epoch" test/control-reconcile.integration.test.mjs 2>&1 | grep -c "^not ok"; done`
Expected: `0` five times.

- [ ] **Step 4: Commit**

```bash
git add test/control-reconcile.integration.test.mjs
git commit -m "test: epoch fresh baseline waits for count growth, client-level invariant (issue #140, A5)"
```

---

### Task 6: Deterministic slow-consumer epoch case (A6)

**Files:**
- Modify: `test/control-reconcile.integration.test.mjs` — new test inserted after the existing A2 epoch test.

**Interfaces:**
- Consumes: `deferFeed` seam (Task 2), count-growth wait pattern (Task 5).

- [ ] **Step 1: Add the test**

```js
test("A2 epoch (slow consumer): the fresh baseline lags behind the epoch reset — stale-baseline window pinned (#140 A6)", async () => {
	const root = freshRoot();
	let runner;
	let runner2;
	let socket2 = null;
	try {
		// Same shape as the epoch test above, but the snapshot-path messages on
		// the new socket are fed late (RELATIVE delay — a uniform delay shifts
		// everything equally and proves nothing). The epoch reset fires
		// immediately; the fresh baseline lags 300ms behind. That is exactly
		// the window in which the old :383 assertion read a stale baseline.
		let slowSnapshots = false;
		const first = spawnOwnedRunner(root, "v1");
		runner = first.runner;
		await waitFor(() => hostReady(root, "v1"));
		const socket1 = await connectControl(first.socketPath);
		const h = attachClientOverSocket(socket1, {
			deferFeed: (msg) => (slowSnapshots && typeof msg.type === "string" && msg.type.startsWith("snapshot") ? 300 : 0),
		});
		h.hello();
		await waitFor(() => h.messages.some((m) => m.type === "hello" && m.generation));
		h.client.start();
		await waitFor(() => h.eventsOf("snapshotReady")[0]);
		await waitFor(() => h.client.getLastSeq() >= 3, 10000);
		const disconnectSeq = h.client.getLastSeq();

		await stopRunner(runner);
		reapChild(root, "v1");
		const second = spawnOwnedRunner(root, "v1");
		runner2 = second.runner;
		await waitFor(() => hostReady(root, "v1"));

		socket2 = await connectControl(second.socketPath);
		h.switchSocket(socket2);
		h.hello();
		await waitFor(() => h.messages.some((m) => m.type === "hello" && m.status?.instanceId === second.instanceId));
		const readyCount = h.eventsOf("snapshotReady").length;
		slowSnapshots = true;
		h.client.reconnect(disconnectSeq);

		const reset = await waitFor(() => h.eventsOf("epochReset")[0]);
		assert.equal(typeof reset.current, "string");
		// Non-vacuity: we proceeded past the epoch reset while the fresh
		// baseline was still in flight — the relative delay guarantees it. (A
		// stray landing in resyncing can flip the client to live early; the
		// delayed snapshot_begin then triggers a resync and the flow still
		// converges — the 10s waits absorb that extra round trip.)
		assert.equal(h.eventsOf("snapshotReady").length, readyCount, "no fresh snapshotReady yet (the lag window is real)");

		const ready2 = await waitFor(
			() => (h.eventsOf("snapshotReady").length > readyCount ? h.eventsOf("snapshotReady").at(-1) : null),
			10000,
		);
		assert.equal(typeof ready2.nextSeq, "number");
		await waitFor(() => h.client.getLastSeq() >= ready2.nextSeq, 10000);

		socket2.destroy();
	} finally {
		await stopRunner(runner);
		await stopRunner(runner2);
		reapChild(root, "v1");
		try { socket2?.destroy(); } catch {}
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 2: Run 5 times**

Run: `for i in 1 2 3 4 5; do node --test --test-reporter=tap --test-name-pattern="A2 epoch" test/control-reconcile.integration.test.mjs 2>&1 | grep -c "^not ok"; done`
Expected: `0` five times (both epoch tests run). If the non-vacuity assertion proves flaky, apply spec D7 (remove the test, record why).

- [ ] **Step 3: Commit**

```bash
git add test/control-reconcile.integration.test.mjs
git commit -m "test: slow-consumer epoch case pins the stale-baseline window (issue #140, A6)"
```

---

### Task 7: Product comment realignment + static/full-suite gate (D6, A9)

**Files:**
- Modify: `src/core/terminal-attach-client.mjs` — two comment blocks only.

**Interfaces:**
- Consumes: none. Produces: none (comment-only; no signature changes).

- [ ] **Step 1: Fix the over-promising comment in `issueReconnectSubscribe`**

Replace:

```js
		// The cursor must clear every stray the legacy broadcast already
		// delivered to this socket during the gate (wire-level no-dup).
```

with:

```js
		// The cursor must clear every stray the legacy broadcast already
		// DELIVERED to this socket during the gate. Strays still in flight when
		// the subscribe is written cannot be folded in: the ring replay re-sends
		// them and seq-checked consumption dedups — the guarantee is UI-level
		// exactly-once; a wire-level repeat at the broadcast→replay handoff is
		// expected (#140).
```

- [ ] **Step 2: Align the state-doc wording (`reconciling` block, ~:46-48)**

In the `reconciling` state doc comment, replace:

```js
	 * they are legacy-broadcast strays that must reach the UI exactly once
	 * (strays cover (cursor, strayHighWater]; the replay starts past the
	 * high-water; see the reconciling output branch). Resolution:
```

with:

```js
	 * they are legacy-broadcast strays that must reach the UI exactly once
	 * (OBSERVED strays cover (cursor, strayHighWater]; the replay starts past
	 * the high-water; in-flight strays are re-sent by the replay and deduped —
	 * see the reconciling output branch). Resolution:
```

(If the exact wording differs, apply the same edit semantically: mark the coverage as *observed* strays only.)

- [ ] **Step 3: Static + full-suite gate**

Run: `npm run typecheck && node --test`
Expected: typecheck 0 errors; suite passes (any failure must be an existing flake — isolate-rerun before attributing; record the final pass/fail counts against the Task 1 baseline).

- [ ] **Step 4: Commit**

```bash
git add src/core/terminal-attach-client.mjs
git commit -m "docs: client comment states UI-level exactly-once, not wire-level no-dup (issue #140, D6)"
```

---

### Task 8: Detection-power and stability evidence (A7, A8) — verification only, no commit

**Files:**
- Modify (temporarily, then revert): `src/core/terminal-attach-protocol.mjs`, `src/core/terminal-attach-client.mjs`

**Interfaces:** none (evidence gathering; results go into the PR description and the issue).

- [ ] **Step 1: Mutation 1 — a dropped replay chunk must redden the no-gap assertion**

Only `startReplay` is mutated (a bare `sed` would also hit the snapshot flush's identical loop):

```bash
python3 - << 'EOF'
p = "src/core/terminal-attach-protocol.mjs"
s = open(p).read()
anchor = "function startReplay(sinceSeq) {"
i = s.index(anchor)
old = "for (const chunk of after.chunks) {"
j = s.index(old, i)
s = s[:j] + "for (const chunk of after.chunks.slice(1)) {" + s[j + len(old):]
assert "after.chunks.slice(1)" in s
open(p, "w").write(s)
print("mutated startReplay only")
EOF
node --test --test-name-pattern="A2: reconnect" test/control-reconcile.integration.test.mjs 2>&1 | grep -E "^not ok|no gap" | head -3
git checkout -- src/core/terminal-attach-protocol.mjs
```
Expected: FAIL with `no gap after reconnect` (the mutated replay skips the first retained chunk → distinct starts at cursor+2).

- [ ] **Step 2: Mutation 2 — a UI double-emit must redden the marker guard**

In `src/core/terminal-attach-client.mjs`, in the `live` output branch, duplicate the emit:

```bash
python3 - << 'EOF'
import re
p = "src/core/terminal-attach-client.mjs"
s = open(p).read()
old = """				if (state === "live") {
					if (typeof msg.seq !== "number") {"""
assert s.count(old) == 1
s = s.replace("""					if (msg.seq === lastSeq + 1) {
						lastSeq = msg.seq;
						emit("output", msg.data);
						return true;
					}""", """					if (msg.seq === lastSeq + 1) {
						lastSeq = msg.seq;
						emit("output", msg.data);
						emit("output", msg.data); // MUTATION (#140 A7)
						return true;
					}""")
open(p, "w").write(s)
assert "MUTATION (#140 A7)" in open(p).read(), "mutation did not apply — check the anchor text"
print("mutated")
EOF
node --test --test-name-pattern="A2: reconnect" test/control-reconcile.integration.test.mjs 2>&1 | grep -E "^not ok|exactly once" | head -3
git checkout -- src/core/terminal-attach-client.mjs
git status --short   # must be empty
```
Expected: FAIL with `delivered to the UI exactly once`.

- [ ] **Step 3: A8 stability loop — 100 isolated runs of the affected set**

```bash
fails=0
for i in $(seq 1 100); do
	if ! timeout 120 node --test --test-reporter=tap --test-name-pattern="A2: reconnect|A2 epoch" test/control-reconcile.integration.test.mjs > /tmp/a8-$i.log 2>&1; then
		fails=$((fails+1)); echo "FAIL run $i"; grep -m3 "^not ok\|error:" /tmp/a8-$i.log
	fi
done
echo "A8: $fails failures / 100 runs"
```
Expected: `A8: 0 failures / 100 runs` (~10 minutes). Statistical bound: at the pre-fix baseline failure rate (1/10), 100 green runs have probability ≈ 0.003%.

- [ ] **Step 4: Record the evidence**

No commit. Put A7 (both mutations reddened the right assertions) and A8 (`0/100`) into the PR description; also comment the outcome on issue #140.

---

## Self-Review (done at plan time)

- **Spec coverage:** D1→T1/T2, D2→T1, D3→T3, D4→T5, D5①→T4, D5②→T6, D6→T7, D7→contingency in T4/T6 steps; A1,A2→T1, A3→T3, A4→T4, A5→T5, A6→T6, A7,A8→T8, A9→T2(gate)/T7(static/full). No taskless acceptance, no acceptance-less task.
- **Placeholders:** none — every step carries exact code or exact commands.
- **Type consistency:** `distinctSeqsFrom`/`hasWireOverlap`/`isContiguousFrom`/`createRecorder`/`mark()/messagesSince/eventsSince`/`deferWrite`/`deferFeed` used with identical signatures across tasks; `socket3` declared in T4 and cleaned in T4's finally edit.
