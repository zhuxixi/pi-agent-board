# Issue #294 Snapshot Resize-Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a validated target-geometry F carried inside a snapshot (or a live ordinary frame following it) satisfy the resize intent, so differing-size attaches settle instead of sticking past the 2500 ms cap.

**Architecture:** One new pure predicate (`resizeIntentEvidenceFromRecords`) shared by both evidence sources (snapshot records array, live single record); a sticky evidence lifecycle in `PtyAttachComponent` (`resizeIntentSatisfied` + `resizeIntentProofSeq`, cleared only by a new intent / recomputed per accepted baseline); and an ordinary-head alternative inside the pure `fullViewDecision` gate. No runner, protocol, reporter, or degraded-chain changes.

**Tech Stack:** TypeScript + `.mjs` core modules, `node:test` + `assert/strict`, existing `test-support/attach-recovery-scenario.ts` virtual-clock harness.

**Spec:** `docs/superpowers/specs/2026-11-13-issue-294-snapshot-resize-intent-design.md` (cross-reviewed v4). Acceptance IDs referenced per task: A1a, A1b, A2a, A2b, A2c, A3, A4, U1.

## Global Constraints

- Tabs for indentation; English comments and commit messages; conventional commit subjects (`fix`/`test`/`docs`/`chore`).
- Never weaken existing gates: wrong-size / wrong-revision / wrong-intent / stale evidence / wrong-non-zero revision-intent heads keep waiting (A1b/A3 pin this).
- Single-source matcher: live and snapshot evidence go through the same predicate; do NOT reintroduce a revision/intent-only branch.
- `invalidateViewProof` must no longer clear `resizeIntentSatisfied` (sticky evidence), and nothing else in it changes.
- Work from: `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-294-snapshot-resize-intent` (all paths below are relative to it).
- Full gate: `npm run verify` (typecheck + perf gate + tests + coverage + pack:dry) must exit 0 before step 9.

---

### Task 1: Pure predicate `resizeIntentEvidenceFromRecords` (A1a)

**Files:**
- Modify: `src/core/pty-attach-render.mjs` (add export near `decideAttachPresentation`)
- Test: `test/pty-attach-render.test.mjs`

**Interfaces:**
- Consumes: `validateFrameMetadata` (already imported in `src/core/pty-attach-render.mjs` from `./attach-frame-proof.mjs`).
- Produces: `export function resizeIntentEvidenceFromRecords(intent, records)` where `intent = { required: boolean, geometryRevision: number, intentId: number, cols: number, rows: number }`, `records = unknown`; returns `{ satisfied: boolean, proofSeq: number | null }`.

- [ ] **Step 1: Write the failing tests** — append to `test/pty-attach-render.test.mjs` (extend the existing import from `"../src/core/pty-attach-render.mjs"` with `resizeIntentEvidenceFromRecords`):

```js
// Issue #294 A1a: the single-source intent-evidence predicate.
const INTENT = { required: true, geometryRevision: 1, intentId: 1, cols: 100, rows: 30 };
const MATCH = (seq) => ({
	marker: "F", seq, frameId: seq,
	metadata: { protocol: 1, cols: 100, rows: 30, mode: "fullscreen", rendererEpoch: 1, sessionEpoch: 1, focusPresent: true, overlayPresent: false, intentId: 1, geometryRevision: 1 },
});

test("A1a: a fully matching F yields evidence with its seq (highest wins)", () => {
	assert.deepEqual(resizeIntentEvidenceFromRecords(INTENT, [MATCH(2)]), { satisfied: true, proofSeq: 2 });
	assert.deepEqual(resizeIntentEvidenceFromRecords(INTENT, [{ marker: "S", seq: 1, frameId: 1 }, MATCH(2), MATCH(5)]), { satisfied: true, proofSeq: 5 });
});

test("A1a: a non-required intent is vacuously satisfied without evidence", () => {
	assert.deepEqual(resizeIntentEvidenceFromRecords({ ...INTENT, required: false }, []), { satisfied: true, proofSeq: null });
});

test("A1a: anything short of a full match fails closed", () => {
	const notEvidence = [
		[{ marker: "S", seq: 2, frameId: 2 }],
		[{ marker: "A", seq: 2, frameId: 2, reason: "stop" }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, geometryRevision: 0 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, intentId: 0 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, intentId: 2 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, cols: 140 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, rows: 40 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, protocol: 2 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, extra: 1 } }],
		[{ ...MATCH(2), seq: 0 }],
		[{ ...MATCH(2), seq: 1.5 }],
		[],
		"not-an-array",
		[null],
	];
	for (const records of notEvidence) {
		assert.deepEqual(resizeIntentEvidenceFromRecords(INTENT, records), { satisfied: false, proofSeq: null }, `records=${JSON.stringify(records)}`);
	}
	assert.deepEqual(resizeIntentEvidenceFromRecords(null, [MATCH(2)]), { satisfied: false, proofSeq: null });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/pty-attach-render.test.mjs`
Expected: FAIL — `resizeIntentEvidenceFromRecords` is not exported.

- [ ] **Step 3: Implement** — add to `src/core/pty-attach-render.mjs`:

```js
/**
 * Issue #294: derive the resize-intent evidence from view-proof records.
 * One matcher for every evidence source — snapshotReady's records array and
 * the live single-record path both call this; no revision/intent-only
 * shortcut may exist anywhere. Fail-closed: anything short of a fully
 * matching target F yields no evidence.
 * @param {{ required: boolean, geometryRevision: number, intentId: number, cols: number, rows: number } | null} intent
 * @param {unknown} records
 * @returns {{ satisfied: boolean, proofSeq: number | null }}
 */
export function resizeIntentEvidenceFromRecords(intent, records) {
	if (intent === null || typeof intent !== "object") return { satisfied: false, proofSeq: null };
	if (intent.required !== true) return { satisfied: true, proofSeq: null };
	if (!Array.isArray(records)) return { satisfied: false, proofSeq: null };
	let best = null;
	for (const record of records) {
		if (record === null || typeof record !== "object") continue;
		if (record.marker !== "F") continue;
		if (!Number.isInteger(record.seq) || record.seq < 1) continue;
		const validation = validateFrameMetadata(record.metadata);
		if (!validation.ok) continue;
		const metadata = validation.value;
		if (metadata.geometryRevision !== intent.geometryRevision) continue;
		if (metadata.intentId !== intent.intentId) continue;
		if (metadata.cols !== intent.cols || metadata.rows !== intent.rows) continue;
		if (best === null || record.seq > best) best = record.seq;
	}
	return best === null ? { satisfied: false, proofSeq: null } : { satisfied: true, proofSeq: best };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/pty-attach-render.test.mjs`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-attach-render.mjs test/pty-attach-render.test.mjs
git commit -m "feat(attach): single-source resize-intent evidence predicate (issue #294)"
```

---

### Task 2: Ordinary-head bypass in `fullViewDecision` (A1b)

**Files:**
- Modify: `src/core/pty-attach-render.mjs` (`fullViewDecision`, the `requiredGeometryRevision` + intent blocks)
- Test: `test/pty-attach-render-decision.test.mjs`

**Interfaces:**
- Consumes: Task 1's predicate semantics (state field `resizeIntentProofSeq: number | null`, passed by the component in Task 4).
- Produces: `decideAttachPresentation` accepts `resizeIntentProofSeq`; publishes `complete` when the head is ordinary (0/0) at target dims with fresh evidence.

- [ ] **Step 1: Write the failing tests** — append to `test/pty-attach-render-decision.test.mjs` (reuse the file's existing `view(over)` helper; `META`/`COVERED` are the file's constants):

```js
// Issue #294 A1b: the intent-evidence / ordinary-head alternative.
const ORD_HEAD = { ...META, intentId: 0, geometryRevision: 0 };
const ordCovered = () => ({
	...COVERED,
	proof: { ...COVERED.proof, metadata: ORD_HEAD },
	throughSeq: 10,
});
const armed = (over = {}) => view({
	resizeIntentRequired: true,
	resizeIntentSatisfied: true,
	resizeIntentProofSeq: 9,
	intentId: 7,
	viewProof: ordCovered(),
	...over,
});

test("A1b: fresh evidence + ordinary 0/0 head at target dims publishes", () => {
	assert.deepEqual(decide(armed()), { action: "publish", reason: "complete" });
});

test("A1b: no evidence / not satisfied keeps the original waits", () => {
	assert.deepEqual(decide(armed({ viewProof: COVERED, resizeIntentProofSeq: undefined })), { action: "wait", reason: "resize-intent" });
	assert.deepEqual(decide(armed({ viewProof: COVERED, resizeIntentSatisfied: false })), { action: "wait", reason: "resize-intent" });
	assert.deepEqual(decide(view({ resizeIntentRequired: true, resizeIntentSatisfied: false, intentId: 7, viewProof: COVERED })), { action: "wait", reason: "resize-intent" });
	// Gate order pin: an ordinary 0/0 head WITHOUT evidence stops at the earlier geometry-revision gate.
	assert.deepEqual(decide(view({ resizeIntentRequired: true, resizeIntentSatisfied: false, intentId: 7, viewProof: ordCovered() })), { action: "wait", reason: "geometry-revision" });
});

test("A1b: stale evidence (proofSeq > throughSeq) keeps waiting on the head checks", () => {
	assert.deepEqual(decide(armed({ viewProof: ordCovered() , resizeIntentProofSeq: 11 })), { action: "wait", reason: "geometry-revision" });
});

test("A1b: a wrong-non-zero head is NOT ordinary — gates stay even with valid evidence", () => {
	assert.deepEqual(decide(armed({ viewProof: { ...ordCovered(), proof: { ...ordCovered().proof, metadata: { ...ORD_HEAD, geometryRevision: 5 } } } })), { action: "wait", reason: "geometry-revision" });
	assert.deepEqual(decide(armed({ viewProof: { ...COVERED, proof: { ...COVERED.proof, metadata: { ...META, intentId: 3 } } } })), { action: "wait", reason: "resize-intent" });
});

test("A1b: a wrong-size ordinary head still waits on proof-geometry-mismatch", () => {
	assert.deepEqual(decide(armed({ viewProof: { ...ordCovered(), proof: { ...ordCovered().proof, metadata: { ...ORD_HEAD, cols: 140 } } } })), { action: "wait", reason: "proof-geometry-mismatch" });
});

test("A1b: a head carrying the intent itself keeps the original publish path", () => {
	const intentMeta = { ...META, intentId: 7, geometryRevision: 2 };
	assert.deepEqual(decide(armed({ viewProof: { ...COVERED, proof: { ...COVERED.proof, metadata: intentMeta } } })), { action: "publish", reason: "complete" });
});
```

Note: `view()`'s base has `targetCols: 80, targetRows: 24, geometryRevision: 2, requiredGeometryRevision: 2` and `META.geometryRevision: 2` — `armed()` overrides `intentId: 7` and uses the ordinary head (0/0), so `requiredGeometryRevision !== undefined && metadata.geometryRevision(0) !== 2` must be bypassed for the first test to pass. Adjust the helper names/overrides only if the file's actual base differs; do not weaken the asserts.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/pty-attach-render-decision.test.mjs`
Expected: the "fresh evidence + ordinary head publishes" test FAILs with `geometry-revision`; the wrong-non-zero ones may initially pass for the wrong reason.

- [ ] **Step 3: Implement** — in `src/core/pty-attach-render.mjs` `fullViewDecision`, replace the two checks:

```js
	if (state.requiredGeometryRevision !== undefined && metadata.value.geometryRevision !== state.requiredGeometryRevision) return wait("geometry-revision");
	if (state.resizeIntentRequired === true) {
		if (state.resizeIntentSatisfied !== true) return wait("resize-intent");
		if (metadata.value.intentId !== state.intentId || metadata.value.intentId === 0) return wait("resize-intent");
	}
```

with:

```js
	// Issue #294: a validated intent proof (snapshot-carried or live) that is
	// fresh against the covered window, plus an ordinary post-intent (0/0)
	// coverage head at the target size, is an acceptable alternative to the
	// head itself carrying the intent metadata. Everything else fails closed
	// to the original waits.
	const intentEvidenceHeadOk =
		state.resizeIntentRequired === true &&
		state.resizeIntentSatisfied === true &&
		Number.isInteger(state.resizeIntentProofSeq) &&
		state.resizeIntentProofSeq <= coverage.throughSeq &&
		metadata.value.intentId === 0 &&
		metadata.value.geometryRevision === 0 &&
		metadata.value.cols === state.targetCols &&
		metadata.value.rows === state.targetRows;
	if (state.requiredGeometryRevision !== undefined && metadata.value.geometryRevision !== state.requiredGeometryRevision && !intentEvidenceHeadOk) return wait("geometry-revision");
	if (state.resizeIntentRequired === true) {
		if (state.resizeIntentSatisfied !== true) return wait("resize-intent");
		const headCarriesIntent = metadata.value.intentId === state.intentId && metadata.value.intentId !== 0;
		if (!headCarriesIntent && !intentEvidenceHeadOk) return wait("resize-intent");
	}
```

Also extend the JSDoc `@param` state comment above `decideAttachPresentation` with `resizeIntentProofSeq?: number,`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/pty-attach-render-decision.test.mjs`
Expected: PASS (all, including the pre-existing intent tests — they pass `resizeIntentProofSeq` never, so `intentEvidenceHeadOk` is false for them).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-attach-render.mjs test/pty-attach-render-decision.test.mjs
git commit -m "feat(attach): ordinary-head intent-evidence alternative in the publish gate (issue #294)"
```

---

### Task 3: Harness observability — `protocolErrorCount` + `coverageHead` (enables A2c)

**Files:**
- Modify: `test-support/attach-recovery-scenario.ts`

**Interfaces:**
- Produces: two new step-readout fields: `protocolErrorCount` (number) and `coverageHead` (`{ seq, frameId, intentId, geometryRevision, cols, rows } | null`).

- [ ] **Step 1: Implement** — in `createHarness`, after the component is constructed, wrap `handleAttachEvent` (the channel every client event — including `protocolError` — flows through; `installSpy` in the same file is the precedent):

```ts
	const protocolErrors: unknown[] = [];
	const originalHandleAttachEvent = (component as any).handleAttachEvent.bind(component);
	(component as any).handleAttachEvent = (event: string, payload?: unknown) => {
		if (event === "protocolError") protocolErrors.push(payload ?? null);
		return originalHandleAttachEvent(event, payload);
	};
```

Return `protocolErrors` from `createHarness` (add to the returned object). In `readout(h, state)` add:

```ts
		const proof = (c.latestViewProof as { proof?: Record<string, unknown> | null } | null)?.proof;
		const headMeta = (proof?.metadata ?? {}) as Record<string, unknown>;
		// ...inside the returned object:
		protocolErrorCount: h.protocolErrors.length,
		coverageHead: proof === null || proof === undefined || typeof proof !== "object" ? null : {
			seq: (proof as { seq?: unknown }).seq ?? null,
			frameId: (proof as { frameId?: unknown }).frameId ?? null,
			intentId: headMeta.intentId ?? null,
			geometryRevision: headMeta.geometryRevision ?? null,
			cols: headMeta.cols ?? null,
			rows: headMeta.rows ?? null,
		},
```

(Adapt to the file's actual structure: `readout` already destructures `h`; `Harness` type picks up the new field automatically via `ReturnType`.)

- [ ] **Step 2: Verify with the existing research program**

Run: `node --experimental-transform-types test-support/attach-recovery-scenario.ts "$(cat /home/elling/.github-issue-driven/zhuxixi/pi-agent-board/issue-294/research/repro-live-f0-after.json)" 2>/dev/null | tail -1` then pipe through `node -e '...'` to print `protocolErrorCount` and `coverageHead` per step.
Expected: all steps `protocolErrorCount: 0`; after the F0 record step, `coverageHead` = `{ seq: 3, frameId: 3, intentId: 0, geometryRevision: 0, cols: 100, rows: 30 }`.

- [ ] **Step 3: Run the existing component suite to prove no regression**

Run: `node --test test/attach-recovery-component.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test-support/attach-recovery-scenario.ts
git commit -m "test(attach): protocolError and coverageHead readouts in the recovery harness (issue #294)"
```

---

### Task 4: Component wiring + component tests (A2a, A2b, A2c, A3)

**Files:**
- Modify: `src/ui/pty-attach.ts` (field ~`:476`, `noteGeometryIntent` ~`:2541`, `snapshotReady` ~`:2918`, `viewProofRecord` branch ~`:2982-2992`, `invalidateViewProof` ~`:1520-1525`, decision-facts assembly ~`:1677-1680`, import line `:14`)
- Test: `test/attach-recovery-component.test.mjs`

**Interfaces:**
- Consumes: Task 1 `resizeIntentEvidenceFromRecords`; Task 2 state field `resizeIntentProofSeq`; Task 3 readout fields.
- Produces: sticky evidence lifecycle per spec §2.

- [ ] **Step 1: Write the failing component tests** — append to `test/attach-recovery-component.test.mjs`, following the file's `runScenario`/`readouts`/`assertScenarioOk` pattern (see T8 at `:1298` for the geometry-gate precedent). Reuse these step-program builders (metadata literals as in T8's `target`):

```js
// Issue #294: the target after a differing resize to 100x30 — revision 1, intent 1.
const i294Target = { protocol: 1, cols: 100, rows: 30, mode: "fullscreen", rendererEpoch: 1, sessionEpoch: 1, focusPresent: true, overlayPresent: false, intentId: 1, geometryRevision: 1 };
const i294Ord = { ...i294Target, intentId: 0, geometryRevision: 0 };
const i294F = (metadata, seq) => ({ marker: "F", seq, frameId: seq, metadata });
const i294Covered = (proof, throughSeq) => ({ status: "covered", reason: "exact-proof", proof, throughSeq, cursorVisible: true });
```

Test A2a (snapshot-carried target F, head = target F):

```js
test("A2a (#294): a snapshot-carried target F settles like the live control", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "I294 80" },
			{ op: "geometry", cols: 100, rows: 30 },
			{ op: "snapshot", resnapshot: true, generation: "gen-2", text: "I294 100", beginSeq: 2,
				records: [i294F(i294Target, 2)],
				proof: i294Covered(i294F(i294Target, 2), 2) },
			{ op: "advance", ms: 2500 },
		],
	});
	assertScenarioOk("i294-a2a", run);
	const [afterResnapshot, afterAdvance] = readouts(run.parsed).slice(4);
	assert.equal(afterResnapshot.attaching, false, "settles at the hydration commit");
	assert.equal(afterResnapshot.readyReason, "complete");
	assert.equal(afterResnapshot.settledAt, 0);
	assert.equal(afterAdvance.attaching, false, "stays settled");
});
```

Test A2b (capture window F1+F0, head = F0):

```js
test("A2b (#294): target F + ordinary F0 in the capture window, coverage head F0, settles", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "I294 80" },
			{ op: "geometry", cols: 100, rows: 30 },
			{ op: "snapshot", resnapshot: true, generation: "gen-2", text: "I294 100", beginSeq: 2,
				records: [i294F(i294Target, 2), i294F(i294Ord, 2)],
				proof: i294Covered(i294F(i294Ord, 2), 2) },
			{ op: "advance", ms: 2500 },
		],
	});
	assertScenarioOk("i294-a2b", run);
	const [afterResnapshot] = readouts(run.parsed).slice(4);
	assert.equal(afterResnapshot.attaching, false);
	assert.equal(afterResnapshot.readyReason, "complete");
});
```

Test A2c (real ordinary frame after the snapshot):

```js
test("A2c (#294): real output -> S0 -> F0 after the snapshot settles via the evidence bypass", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "I294 80" },
			{ op: "geometry", cols: 100, rows: 30 },
			{ op: "snapshot", resnapshot: true, generation: "gen-2", text: "I294 100", beginSeq: 2,
				records: [i294F(i294Target, 2)],
				proof: { status: "unknown", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null } },
			{ op: "output", seq: 3, text: "POST-SNAPSHOT OUTPUT" },
			{ op: "record", marker: "S", seq: 3, frameId: 3 },
			{ op: "record", marker: "F", seq: 3, metadata: i294Ord },
		],
	});
	assertScenarioOk("i294-a2c", run);
	const [afterOutput, afterS0, afterF0] = readouts(run.parsed).slice(5);
	assert.equal(afterOutput.protocolErrorCount, 0);
	assert.equal(afterS0.protocolErrorCount, 0);
	assert.equal(afterS0.latestViewProof.reason, "candidate-open", "S0 opens a candidate");
	assert.equal(afterF0.protocolErrorCount, 0);
	assert.deepEqual(afterF0.coverageHead, { seq: 3, frameId: 3, intentId: 0, geometryRevision: 0, cols: 100, rows: 30 });
	assert.equal(afterF0.attaching, false, "the ordinary head publishes via fresh evidence");
	assert.equal(afterF0.readyReason, "complete");
});
```

Test A3 (negatives; one test per group):

```js
test("A3-1 (#294): snapshot-carried wrong-dims/revision/intent F records keep the gate", () => {
	for (const bad of [
		{ ...i294Target, cols: 140 },
		{ ...i294Target, geometryRevision: 0 },
		{ ...i294Target, intentId: 0 },
	]) {
		const run = runScenario({
			steps: [
				{ op: "connect" },
				{ op: "hello", witness: true, generation: "gen-1" },
				{ op: "snapshot", proof: "unavailable-candidate-open", text: "I294 80" },
				{ op: "geometry", cols: 100, rows: 30 },
				{ op: "snapshot", resnapshot: true, generation: "gen-2", text: "I294 100", beginSeq: 2,
					records: [i294F(bad, 2)],
					proof: { status: "unknown", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null } },
				{ op: "advance", ms: 250 },
				{ op: "advance", ms: 2250 },
				{ op: "record", marker: "F", seq: 3, metadata: i294Target },
			],
		});
		assertScenarioOk("i294-a3n", run);
		const [atBudget, atCap, afterRescue] = readouts(run.parsed).slice(5);
		assert.equal(atBudget.attaching, true, `bad=${JSON.stringify(bad)} waits at budget`);
		assert.equal(atCap.attaching, true);
		assert.equal(atCap.deadlineState, "expired");
		assert.equal(afterRescue.attaching, false, "a real live target F still rescues");
		assert.equal(afterRescue.readyReason, "complete");
	}
});

test("A3-2 (#294): no evidence — live S0/F0 keeps waiting as today", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "I294 80" },
			{ op: "geometry", cols: 100, rows: 30 },
			{ op: "snapshot", resnapshot: true, generation: "gen-2", text: "I294 100", beginSeq: 2,
				proof: { status: "unknown", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null } },
			{ op: "output", seq: 3, text: "POST-SNAPSHOT OUTPUT" },
			{ op: "record", marker: "S", seq: 3, frameId: 3 },
			{ op: "record", marker: "F", seq: 3, metadata: i294Ord },
			{ op: "advance", ms: 250 },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("i294-a3-2", run);
	const final = run.parsed.final;
	assert.equal(final.attaching, true, "no evidence -> ordinary F0 head keeps waiting");
	assert.equal(final.deadlineState, "expired");
});

test("A3-3 (#294): a second differing resize clears the old evidence", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "I294 80" },
			{ op: "geometry", cols: 100, rows: 30 },
			{ op: "snapshot", resnapshot: true, generation: "gen-2", text: "I294 100", beginSeq: 2,
				records: [i294F(i294Target, 2)],
				proof: i294Covered(i294F(i294Target, 2), 2) },
			{ op: "geometry", cols: 120, rows: 40 },
			{ op: "snapshot", resnapshot: true, generation: "gen-3", cols: 120, rows: 40, text: "I294 120", beginSeq: 3,
				proof: { status: "unknown", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null } },
			{ op: "output", seq: 4, text: "MORE OUTPUT" },
			{ op: "record", marker: "F", seq: 4, metadata: { ...i294Ord, cols: 120, rows: 40 } },
			{ op: "advance", ms: 2500 },
		],
	});
	assertScenarioOk("i294-a3-3", run);
	const final = run.parsed.final;
	assert.equal(final.attaching, true, "superseded evidence must not publish the new intent");
});

test("A3-4 (#294): live wrong-dims F1 -> S0 -> target F0 does not publish", () => {
	const run = runScenario({
		steps: [
			{ op: "connect" },
			{ op: "hello", witness: true, generation: "gen-1" },
			{ op: "snapshot", proof: "unavailable-candidate-open", text: "I294 80" },
			{ op: "geometry", cols: 100, rows: 30 },
			{ op: "snapshot", resnapshot: true, generation: "gen-2", text: "I294 100", beginSeq: 2,
				proof: { status: "unknown", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null } },
			{ op: "record", marker: "F", seq: 2, metadata: { ...i294Target, cols: 140 } },
			{ op: "output", seq: 3, text: "POST OUTPUT" },
			{ op: "record", marker: "S", seq: 3, frameId: 3 },
			{ op: "record", marker: "F", seq: 3, metadata: i294Ord },
			{ op: "advance", ms: 250 },
			{ op: "advance", ms: 2250 },
		],
	});
	assertScenarioOk("i294-a3-4", run);
	const final = run.parsed.final;
	assert.equal(final.attaching, true, "wrong-dims live F1 is not evidence");
	assert.equal(final.deadlineState, "expired");
});
```

- [ ] **Step 2: Run to verify failures**

Run: `node --test test/attach-recovery-component.test.mjs`
Expected: A2a/A2b/A2c FAIL (stuck at `resize-intent`), A3-2/A3-3/A3-4 PASS on current main (they pin today's behavior; A3-1's rescue assertion FAILs because the rescue F arrives post-cap — if the rescue assertion is the only failure there, that is expected to flip once wired).

- [ ] **Step 3: Implement the wiring** — in `src/ui/pty-attach.ts`:

1. Import: extend line 14's import list with `resizeIntentEvidenceFromRecords`.
2. Field (next to `resizeIntentSatisfied` ~`:475`):

```ts
	private resizeIntentProofSeq: number | null = null;
```

3. `invalidateViewProof` (~`:1520-1525`): delete the line `this.resizeIntentSatisfied = false;` (leave the coverage resets; add the comment `// Issue #294: intent evidence is sticky — see noteGeometryIntent/snapshotReady/viewProofRecord.`).
4. `noteGeometryIntent` (~`:2541`): after `this.resizeIntentSatisfied = false;` add `this.resizeIntentProofSeq = null;`.
5. `snapshotReady` (~`:2918`): replace `this.resizeIntentSatisfied = false;` with:

```ts
			const evidence = resizeIntentEvidenceFromRecords(
				{ required: this.resizeIntentRequired, geometryRevision: this.geometryRevision, intentId: this.resizeIntentId, cols: this.cols, rows: this.rows },
				records,
			);
			this.resizeIntentSatisfied = evidence.satisfied;
			this.resizeIntentProofSeq = evidence.proofSeq;
```

6. `viewProofRecord` branch (~`:2982-2992`): replace the `if (record.marker === "F") { ... }` body with:

```ts
				if (record.marker === "F") {
					// Issue #294: one matcher for every evidence source — a live F
					// re-evaluates through the same pure predicate (full validation
					// incl. target dims); a non-match leaves the evidence untouched.
					const evidence = resizeIntentEvidenceFromRecords(
						{ required: this.resizeIntentRequired, geometryRevision: this.geometryRevision, intentId: this.resizeIntentId, cols: this.cols, rows: this.rows },
						[record],
					);
					if (evidence.satisfied) {
						this.resizeIntentSatisfied = true;
						this.resizeIntentProofSeq = evidence.proofSeq;
					}
				}
```

7. Decision-facts assembly (~`:1677-1680`): add `resizeIntentProofSeq: this.resizeIntentProofSeq,` after `resizeIntentSatisfied`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/attach-recovery-component.test.mjs`
Expected: PASS (all, including the pre-existing T8 geometry-gate test — its wrong-F sequence never creates evidence).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/ui/pty-attach.ts test/attach-recovery-component.test.mjs
git commit -m "fix(attach): satisfy resize intent from snapshot-carried and live evidence (issue #294)"
```

---

### Task 5: Full regression gate (A4)

**Files:** none (verification only; fixes if genuinely caused by this change).

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: exit 0 (typecheck + perf gate + tests + coverage + pack:dry). If the known-flaky `attach-entry-22` 200 ms wall-clock assertion fails (`#95`), rerun once to confirm flake vs regression; do NOT weaken assertions. Any other failure is a regression from this change: fix and re-run.

- [ ] **Step 2: Commit** (only if fixes were needed)

```bash
git add -u && git commit -m "fix(attach): verify-gate fallout from issue #294 wiring"
```

---

### Task 6: U1 handoff (post-merge manual verification — not implementable now)

U1 executes only after merge + deployment (see spec §U1): pull `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board`, restart pi, differing-size attach, check `diagnostics.jsonl`. It is tracked on the issue, not in this plan's tasks; do not mark it done here.
