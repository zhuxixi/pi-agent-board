# Attach Settle Scheme Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make attach settle deliver the real terminal's light/dark scheme to the child Pi on every host pi version (issue #161), with full observability.

**Architecture:** Feature-detect the terminal color query API on the attach TUI (`queryTerminalColors` on pi-tui ≥0.99, `queryTerminalBackgroundColor` on ≤0.87), probe once at settle, map the background RGB to a scheme, deliver it as an unconditional 997 report on the child PTY, and emit DiagnosticEvent-compatible patches through a new `onDiagnostic` option wired into both `openPtyAttach` construction sites. Late replies (pi-tui `onLateReply`) deliver only when the scheme differs from what was already sent.

**Tech Stack:** TypeScript (`src/ui/pty-attach.ts`, `src/commands/*.ts`), JSDoc-typed ESM (`src/core/terminal-query-sequences.mjs`, `src/core/diagnostics.mjs`), `node:test` + driver-spawned TS smoke scripts (`--experimental-transform-types`), real `node-pty` for the integration scenario.

**Spec:** `docs/superpowers/specs/2026-10-06-attach-settle-scheme-delivery-design.md` (v3, sha256 `4488581928e75f20a2ecfd4750a4949480e95a9b51f73520f7b76221a552a534`). The plan argues from the spec; executors read both.

**Plan-level refinement of one internal signature (spec §2.3):** `resolveProbeApi().invoke` returns `Promise<{ rgb?: RgbColor, anyColors: boolean }>` instead of bare `RgbColor|undefined` — the spec's own outcome rule (§2.3, timeout vs no_background distinguished by "any color field answered") requires the distinction to cross this boundary. Observable contracts (A1–A9) are unchanged.

## Acceptance-ID ↔ Task Map (bidirectional)

| Acceptance ID | Task(s) | | Task | Acceptance ID(s) |
|---|---|---|---|---|
| A1 | 2 | | 1 | A4, parts of A6 (patch builder), feeds A1–A3 |
| A2 | 2 | | 2 | A1, A2, A3, A9, A6 |
| A3 | 2 | | 3 | A5 |
| A4 | 1 | | 4 | wiring for U1/U2; A8 (typecheck) |
| A5 | 3 | | 5 | A7 |
| A6 | 1 (builder), 2 (emission) | | 6 | A8, U1/U2 manual checklist |
| A7 | 5 | | | |
| A8 | 6 (gate), 2–5 (targeted runs) | | | |
| A9 | 2 | | | |
| U1, U2 | 6 (post-implementation manual verification) | | | |

## Global Constraints

- Tabs for indentation; comments and commit messages in English.
- Tests use `node:test` + `assert/strict`; component tests are driver `.test.mjs` files spawning a `test-support/*.ts` script with `node --experimental-transform-types` (existing pattern: `test/pty-attach-startup-color.test.mjs`).
- **Compile face is pi-tui 0.79.8**: never `import type { TerminalColors }` or reference `queryTerminalColors` on the typed `TUI` interface; use local structural typedefs in the `.mjs` and `as never` casts at the pty-attach boundary.
- Diagnostic patches must land inside `normalizeDiagnostic`'s whitelist (`source/level/code/runId/message/details`); `code:"attach_settle_scheme"`; `level` warn only for `timeout/error/no_background/no_probe_api`; suppressed events omit `probeApi`.
- Do NOT inline `resolveProbeApi`, `backgroundRgbFromTerminalColors`, or `buildSettleSchemePatch` logic into the orchestration (spec §4 hard constraint).
- Kill switch `AGENT_BOARD_FORWARD_TERMINAL_QUERIES=0` skips probe AND bridge, emits one `suppressed` (info) event.
- `sentScheme` starts `null`; `null` never matches the duplicate check (the timeout→late-delivery path must deliver).
- One probe per attach (settle is single-shot) — never add retries.
- No `git push` / PR creation without explicit user permission (flow step 9 gate).
- Done gate is `npm run verify` (typecheck + perf gate + tests + coverage lines 85 / funcs 80 / branches 70 + pack:dry).

## Review Focus

1. **Kill switch set at startup** → no probe, no 997, exactly one info `suppressed` event — pinned in Task 2 Step 1 (killSwitch scenario).
2. **Terminal answers nothing, then answers late** → timeout event first, late reply still delivers (sentScheme null) — pinned in Task 3 Step 1 (lateAfterTimeout scenario).
3. **Old-pi host (only the old API)** keeps #149 behavior (997 still sent) — pinned in Task 2 Step 1 (oldApi scenario).
4. **TUI with neither API** must not fall back to an unowned raw query (#165 echo regression) — pinned in Task 2 Step 1 (noApi scenario asserts `writes` empty) and Task 6 (existing `attach-startup-color-smoke` stays green).
5. **Late reply racing detach (component closed)** → dropped, recorded as `dropped_closed`, nothing written to the dead transport — pinned in Task 3 Step 1 (lateAfterClose scenario).
6. **Routine outcomes must not pollute warningCount** — pinned in Task 1 Step 1 (builder level mapping) and Task 2 Step 1 (scenario level assertions).

---

### Task 1: Core pure helpers (probe API detection, color mapping, diagnostic patch builder)

**Files:**
- Modify: `src/core/terminal-query-sequences.mjs` (append after `colorSchemeForBackgroundRgb`)
- Test: `test/terminal-query-sequences.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new (existing `RgbColor`-shaped `{r,g,b}` values).
- Produces (JSDoc-typed, all plain-data, zero side effects — the `invoke` lambdas only call the passed-in surface):
  - `resolveProbeApi(tuiLike) → { api: "colors"|"background"|"none", invoke(tui, timeoutMs, onLateReply?) → Promise<{rgb?: {r,g,b}, anyColors: boolean}> }`
  - `backgroundRgbFromTerminalColors(colors) → {r,g,b}|undefined`
  - `buildSettleSchemePatch({probeApi?, outcome, report?, late?}) → { source:"attach", level:"info"|"warn", code:"attach_settle_scheme", message:string, details:{outcome, probeApi?, report?, late?} }`

- [ ] **Step 1: Write the failing tests**

Append to `test/terminal-query-sequences.test.mjs` (import the three new exports plus `normalizeDiagnostic` from `../src/core/diagnostics.mjs` at the top of the appended block; reuse this file's existing light/dark RGB constants if present, else `{ r: 0.94, g: 0.94, b: 0.94 }` for light and `{ r: 0.16, g: 0.16, b: 0.21 }` for dark — both sit clearly either side of pi's `>= 0.5` luminance threshold):

```js
import { normalizeDiagnostic } from "../src/core/diagnostics.mjs";
import {
	backgroundRgbFromTerminalColors,
	buildSettleSchemePatch,
	resolveProbeApi,
} from "../src/core/terminal-query-sequences.mjs";

test("resolveProbeApi detects colors-only / background-only / neither surfaces", async () => {
	const light = { r: 0.94, g: 0.94, b: 0.94 };
	const colorsOnly = { queryTerminalColors: async () => ({ background: light }) };
	const backgroundOnly = { queryTerminalBackgroundColor: async () => light };
	const neither = {};

	const a = resolveProbeApi(colorsOnly);
	assert.equal(a.api, "colors");
	assert.deepEqual(await a.invoke(colorsOnly, 500), { rgb: light, anyColors: true });

	const b = resolveProbeApi(backgroundOnly);
	assert.equal(b.api, "background");
	assert.deepEqual(await b.invoke(backgroundOnly, 500), { rgb: light, anyColors: true });

	const c = resolveProbeApi(neither);
	assert.equal(c.api, "none");
	assert.deepEqual(await c.invoke(neither, 500), { rgb: undefined, anyColors: false });
});

test("resolveProbeApi colors adapter distinguishes empty from answered-but-no-background", async () => {
	const empty = { queryTerminalColors: async () => ({}) };
	const answered = { queryTerminalColors: async () => ({ foreground: { r: 0.1, g: 0.1, b: 0.1 } }) };
	const probe = resolveProbeApi(empty);
	assert.deepEqual(await probe.invoke(empty, 500), { rgb: undefined, anyColors: false });
	const probe2 = resolveProbeApi(answered);
	assert.deepEqual(await probe2.invoke(answered, 500), { rgb: undefined, anyColors: true });
});

test("resolveProbeApi forwards onLateReply through the colors adapter", async () => {
	let captured;
	const tui = { queryTerminalColors: async (opts) => { captured = opts; return {}; } };
	const probe = resolveProbeApi(tui);
	const onLate = () => {};
	await probe.invoke(tui, 500, onLate);
	assert.equal(captured.onLateReply, onLate);
});

test("backgroundRgbFromTerminalColors maps defensively", () => {
	assert.equal(backgroundRgbFromTerminalColors(undefined), undefined);
	assert.equal(backgroundRgbFromTerminalColors({}), undefined);
	assert.deepEqual(backgroundRgbFromTerminalColors({ background: { r: 1, g: 2, b: 3 } }), { r: 1, g: 2, b: 3 });
});

test("buildSettleSchemePatch maps levels and survives normalizeDiagnostic", () => {
	const failure = buildSettleSchemePatch({ probeApi: "colors", outcome: "timeout" });
	assert.equal(failure.level, "warn");
	const routine = buildSettleSchemePatch({ probeApi: "colors", outcome: "duplicate_skipped" });
	assert.equal(routine.level, "info");
	const reported = buildSettleSchemePatch({ probeApi: "colors", outcome: "reported", report: "997;2", late: true });
	assert.equal(reported.level, "info");
	const suppressed = buildSettleSchemePatch({ outcome: "suppressed" });
	assert.equal(suppressed.details.probeApi, undefined);

	for (const patch of [failure, routine, reported, suppressed]) {
		const normalized = normalizeDiagnostic("view-test", patch);
		assert.equal(normalized.code, "attach_settle_scheme");
		assert.equal(normalized.source, "attach");
		assert.equal(normalized.details.outcome, patch.details.outcome);
		assert.deepEqual(normalized.details, patch.details);
	}
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/terminal-query-sequences.test.mjs`
Expected: FAIL — the three exports do not exist (SyntaxError / undefined is not a function).

- [ ] **Step 3: Implement the helpers**

Append to `src/core/terminal-query-sequences.mjs` (tabs, English comments):

```js
// --- Attach settle scheme probe (issue #161) -------------------------------
// pi-tui >= 0.99 renamed queryTerminalBackgroundColor -> queryTerminalColors.
// This repo compiles against pi-tui 0.79.8 but the extension runs against the
// host pi's pi-tui (peerDependencies "*"), so the probe feature-detects at
// runtime. Local structural typedefs only — TerminalColors does not exist on
// the 0.79.8 compile face and must not be imported.

/** @typedef {{ r: number, g: number, b: number }} SettleRgb */
/** @typedef {{ background?: SettleRgb, foreground?: SettleRgb, palette?: SettleRgb[] }} TerminalColorsLike */
/** @typedef {{ queryTerminalColors?: (opts: { timeoutMs: number, onLateReply?: (colors: TerminalColorsLike) => void }) => Promise<TerminalColorsLike>, queryTerminalBackgroundColor?: (opts: { timeoutMs: number }) => Promise<SettleRgb|undefined> }} SettleProbeSurface */
/** @typedef {{ rgb?: SettleRgb, anyColors: boolean }} SettleProbeResult */

/**
 * Issue #161: detect which terminal color query API a TUI surface exposes.
 * Detection is pure; the returned adapter only calls the passed-in surface.
 * @param {SettleProbeSurface} tuiLike
 * @returns {{ api: "colors"|"background"|"none", invoke: (tui: SettleProbeSurface, timeoutMs: number, onLateReply?: (colors: TerminalColorsLike) => void) => Promise<SettleProbeResult> }}
 */
export function resolveProbeApi(tuiLike) {
	if (tuiLike && typeof tuiLike.queryTerminalColors === "function") {
		return {
			api: "colors",
			invoke: async (tui, timeoutMs, onLateReply) => {
				const colors = await tui.queryTerminalColors({ timeoutMs, onLateReply });
				return { rgb: backgroundRgbFromTerminalColors(colors), anyColors: hasAnyColor(colors) };
			},
		};
	}
	if (tuiLike && typeof tuiLike.queryTerminalBackgroundColor === "function") {
		return {
			api: "background",
			invoke: async (tui, timeoutMs) => {
				const rgb = await tui.queryTerminalBackgroundColor({ timeoutMs });
				return { rgb, anyColors: rgb !== undefined };
			},
		};
	}
	return { api: "none", invoke: async () => ({ rgb: undefined, anyColors: false }) };
}

/** @param {TerminalColorsLike} colors @returns {SettleRgb|undefined} */
export function backgroundRgbFromTerminalColors(colors) {
	return colors && typeof colors === "object" ? colors.background : undefined;
}

/** @param {TerminalColorsLike} colors @returns {boolean} */
function hasAnyColor(colors) {
	if (!colors || typeof colors !== "object") return false;
	if (colors.background !== undefined || colors.foreground !== undefined) return true;
	return Array.isArray(colors.palette) && colors.palette.some((c) => c !== undefined);
}

const SETTLE_SCHEME_WARN_OUTCOMES = new Set(["timeout", "error", "no_background", "no_probe_api"]);

/**
 * Issue #161: build the DiagnosticEvent-compatible patch for the settle scheme
 * flow. Field names MUST stay inside normalizeDiagnostic's whitelist
 * (level/code/runId/source/message/details) — anything else is silently
 * dropped. Warn only when delivery was expected but failed; routine outcomes
 * (dedup, quick detach, kill switch) stay info so warningCount stays meaningful.
 * @param {{ probeApi?: "colors"|"background"|"none", outcome: "reported"|"timeout"|"error"|"no_background"|"no_probe_api"|"dropped_closed"|"duplicate_skipped"|"suppressed", report?: string, late?: boolean }} details
 */
export function buildSettleSchemePatch(details) {
	const parts = [details.outcome];
	if (details.probeApi) parts.push(`via ${details.probeApi}`);
	if (details.report) parts.push(details.report);
	if (details.late) parts.push("late");
	const patch = {
		source: "attach",
		level: SETTLE_SCHEME_WARN_OUTCOMES.has(details.outcome) ? "warn" : "info",
		code: "attach_settle_scheme",
		message: `attach settle scheme: ${parts.join(" ")}`,
		details: { outcome: details.outcome },
	};
	if (details.probeApi !== undefined) patch.details.probeApi = details.probeApi;
	if (details.report !== undefined) patch.details.report = details.report;
	if (details.late !== undefined) patch.details.late = details.late;
	return patch;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/terminal-query-sequences.test.mjs`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/terminal-query-sequences.mjs test/terminal-query-sequences.test.mjs
git commit -m "fix(core): add settle probe API detection and diagnostic patch helpers"
```

---

### Task 2: Settle orchestration rewrite + scenario tests (A1, A2, A3, A9, A6)

**Files:**
- Modify: `src/ui/pty-attach.ts` — replace `reportRealTerminalColorScheme` / `probeAndReportRealTerminalColorScheme` (currently around lines 647–672); extend `PtyAttachOptions` (line 24); add `sentScheme` field near the settle-timer fields (~line 226); extend the import from `../core/terminal-query-sequences.mjs` (line 14).
- Create: `test-support/attach-settle-scheme-smoke.ts`
- Create: `test/pty-attach-settle-scheme.test.mjs`

**Interfaces:**
- Consumes: Task 1's `resolveProbeApi`, `backgroundRgbFromTerminalColors`, `buildSettleSchemePatch`; existing `colorSchemeForBackgroundRgb`, `toColorSchemeReport`, `RgbColor`, `TerminalColorScheme`, `REAL_TERMINAL_SCHEME_PROBE_TIMEOUT_MS`, `this.send`, `this.closed`.
- Produces: `PtyAttachOptions.onDiagnostic?: (event: AttachSettleDiagnosticPatch) => void`; `export interface AttachSettleDiagnosticPatch { source: string; level: "info"|"warn"; code: string; message: string; details: { probeApi?: string; outcome: string; report?: string; late?: boolean } }` (exported from `src/ui/pty-attach.ts` — Task 4's wiring imports it implicitly via the options type).

- [ ] **Step 1: Write the failing tests**

Create `test-support/attach-settle-scheme-smoke.ts` (scenarios run the real component with fake TUIs; the driver asserts on the JSON):

```ts
// Attach settle scheme probe scenarios (issue #161). Driver: test/pty-attach-settle-scheme.test.mjs.
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const LIGHT = { r: 0.94, g: 0.94, b: 0.94 };
const DARK = { r: 0.16, g: 0.16, b: 0.21 };

interface Captures { sent: string[]; diagnostics: any[]; writes: string[]; }

function makeTui(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		terminal: { rows: 24, cols: 80, columns: 80, write: (_d: string) => {} },
		requestRender: () => {},
		onTerminalColorSchemeChange: () => () => {},
		...overrides,
	};
}

async function runSettle(tui: Record<string, unknown>, opts: { env?: Record<string, string> } = {}): Promise<Captures> {
	const captures: Captures = { sent: [], diagnostics: [], writes: [] };
	(tui.terminal as { write: (d: string) => void }).write = (d) => captures.writes.push(d);
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
	try {
		const attach = new PtyAttachComponent(tui as never, theme as never, {} as never, () => {}, {
			socketPath: "/nonexistent/settle-scheme.sock",
			title: "settle-scheme",
			onDiagnostic: (event) => captures.diagnostics.push(event),
		});
		const internals = attach as unknown as { send: (m: { type: string; data?: string }) => void; finishAttachTransition: () => void };
		internals.send = (m) => { if (m?.type === "input" && m.data) captures.sent.push(m.data); };
		internals.finishAttachTransition();
		await new Promise((r) => setImmediate(r));
		return captures;
	} finally {
		for (const k of Object.keys(opts.env ?? {})) delete process.env[k];
	}
}

const out: Record<string, unknown> = {};
const dump = (c: Captures) => ({ sent: c.sent, diagnostics: c.diagnostics, writes: c.writes });

// A1: new API, light and dark backgrounds.
out.newApiLight = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({ background: LIGHT }) })));
out.newApiDark = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({ background: DARK }) })));
// A2: old API fallback keeps #149 behavior.
out.oldApi = dump(await runSettle(makeTui({ queryTerminalBackgroundColor: async () => LIGHT })));
// A3: neither API — no probe, no raw write.
out.noApi = dump(await runSettle(makeTui({})));
// A9: three failure branches.
out.timeout = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({}) })));
out.error = dump(await runSettle(makeTui({ queryTerminalColors: async () => { throw new Error("boom"); } })));
out.noBackground = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({ foreground: DARK }) })));
// Kill switch: suppressed, info level, no probeApi.
out.killSwitch = dump(await runSettle(makeTui({ queryTerminalColors: async () => ({ background: LIGHT }) }), { env: { AGENT_BOARD_FORWARD_TERMINAL_QUERIES: "0" } }));

console.log(JSON.stringify(out));
```

Create `test/pty-attach-settle-scheme.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../test-support/attach-settle-scheme-smoke.ts", import.meta.url));

test("attach settle scheme probe: new/old/none APIs, failures, kill switch", () => {
	const out = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", script], {
		encoding: "utf-8",
		timeout: 20000,
	}));

	// A1 — new API delivers light and dark once each.
	assert.deepEqual(out.newApiLight.sent, ["\x1b[?997;2n"], "A1 light: one 997;2");
	assert.deepEqual(out.newApiDark.sent, ["\x1b[?997;1n"], "A1 dark: one 997;1");
	assert.equal(out.newApiLight.diagnostics[0].details.probeApi, "colors");
	assert.equal(out.newApiLight.diagnostics[0].details.outcome, "reported");
	assert.equal(out.newApiLight.diagnostics[0].details.report, "997;2");
	assert.equal(out.newApiLight.diagnostics[0].level, "info");

	// A2 — old API fallback still delivers.
	assert.deepEqual(out.oldApi.sent, ["\x1b[?997;2n"], "A2 old API delivers");
	assert.equal(out.oldApi.diagnostics[0].details.probeApi, "background");

	// A3 — neither API: no probe, no raw write, no send.
	assert.deepEqual(out.noApi.sent, [], "A3 sends nothing");
	assert.deepEqual(out.noApi.writes, [], "A3 never writes an unowned raw query");
	assert.equal(out.noApi.diagnostics[0].details.probeApi, "none");
	assert.equal(out.noApi.diagnostics[0].details.outcome, "no_probe_api");
	assert.equal(out.noApi.diagnostics[0].level, "warn");

	// A9 — failure branches send nothing and classify.
	for (const [key, outcome] of [["timeout", "timeout"], ["error", "error"], ["noBackground", "no_background"]]) {
		assert.deepEqual(out[key].sent, [], `${key}: no 997 on failure`);
		assert.equal(out[key].diagnostics[0].details.outcome, outcome);
		assert.equal(out[key].diagnostics[0].level, "warn");
	}

	// Kill switch — suppressed, info, no probeApi.
	assert.deepEqual(out.killSwitch.sent, [], "kill switch sends nothing");
	assert.equal(out.killSwitch.diagnostics[0].details.outcome, "suppressed");
	assert.equal(out.killSwitch.diagnostics[0].details.probeApi, undefined);
	assert.equal(out.killSwitch.diagnostics[0].level, "info");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/pty-attach-settle-scheme.test.mjs`
Expected: FAIL — `onDiagnostic` is not read yet, so `newApiLight.diagnostics` is empty (probe still calls the old API name on the fake → TypeError swallowed → no sends). Assertions on `sent` fail.

- [ ] **Step 3: Implement the orchestration**

In `src/ui/pty-attach.ts`:

(a) Extend the core import (line 14):

```ts
import {
	backgroundRgbFromTerminalColors,
	buildSettleSchemePatch,
	colorSchemeForBackgroundRgb,
	extractOscQuerySequences,
	resolveProbeApi,
	toColorSchemeReport,
} from "../core/terminal-query-sequences.mjs";
```

(b) Add to `PtyAttachOptions` (line 24 region) and export the patch type above it:

```ts
/** Diagnostic patch emitted at attach settle (DiagnosticEvent-compatible; built by buildSettleSchemePatch). */
export interface AttachSettleDiagnosticPatch {
	source: string;
	level: "info" | "warn";
	code: string;
	message: string;
	details: { probeApi?: string; outcome: string; report?: string; late?: boolean };
}
```

and inside the interface:

```ts
	/** Issue #161: receives settle-scheme diagnostic patches. Default: no-op. */
	onDiagnostic?: (event: AttachSettleDiagnosticPatch) => void;
```

(c) Add a field near `attachSettleTimer` (~line 226):

```ts
	// Last scheme delivered to the child at settle (issue #161). Starts null:
	// null never matches the duplicate check, so a timeout-then-late sequence
	// still delivers. Single-shot per attach — settle runs at most once.
	private sentScheme: TerminalColorScheme | null = null;
```

(d) Replace `reportRealTerminalColorScheme` and `probeAndReportRealTerminalColorScheme` (keep and update the existing doc comment: #148's probe design, #161's API-rename root cause, one probe only):

```ts
	/** Issue #148/#161: at settle, ask the REAL terminal itself (feature-detected
	 * public query API — pi-tui >= 0.99 renamed it to queryTerminalColors) and
	 * hand the child an unconditional 997 color-scheme report. One probe per
	 * attach; the pre-#148 silence on failure is now observable via
	 * onDiagnostic. Same kill switch as #128 D1-D3. */
	private reportRealTerminalColorScheme(): void {
		if (process.env.AGENT_BOARD_FORWARD_TERMINAL_QUERIES === "0") {
			this.opts.onDiagnostic?.(buildSettleSchemePatch({ outcome: "suppressed" }));
			return;
		}
		void this.probeAndReportRealTerminalColorScheme();
	}

	private async probeAndReportRealTerminalColorScheme(): Promise<void> {
		const probe = resolveProbeApi(this.tui as never);
		if (probe.api === "none") {
			this.opts.onDiagnostic?.(buildSettleSchemePatch({ probeApi: "none", outcome: "no_probe_api" }));
			return;
		}
		let result: { rgb?: RgbColor; anyColors: boolean };
		try {
			result = await probe.invoke(
				this.tui as never,
				REAL_TERMINAL_SCHEME_PROBE_TIMEOUT_MS,
				(colors) => this.handleLateSettleColors(probe.api, colors),
			);
		} catch {
			/* best-effort: a failed probe keeps the pre-#148 behavior, but recorded */
			this.opts.onDiagnostic?.(buildSettleSchemePatch({ probeApi: probe.api, outcome: "error" }));
			return;
		}
		const rgb = result?.rgb;
		if (!rgb) {
			// Outcome rule (spec §2.3): any color answered but no background =>
			// no_background; nothing answered at all => timeout. The old API only
			// queries OSC 11, so its undefined is always a timeout.
			const outcome = result && result.anyColors ? "no_background" : "timeout";
			this.opts.onDiagnostic?.(buildSettleSchemePatch({ probeApi: probe.api, outcome }));
			return;
		}
		this.deliverSettleScheme(colorSchemeForBackgroundRgb(rgb) ?? undefined, probe.api, false);
	}

	/** pi-tui >= 0.99 late replies: deliver only when the scheme differs from
	 * what was already sent (sentScheme starts null and never matches, so the
	 * timeout-then-late path delivers). Closed => dropped, but recorded. */
	private handleLateSettleColors(api: "colors" | "background" | "none", colors: unknown): void {
		if (this.closed) {
			this.opts.onDiagnostic?.(buildSettleSchemePatch({ probeApi: api, outcome: "dropped_closed" }));
			return;
		}
		const rgb = backgroundRgbFromTerminalColors(colors as never);
		const scheme = rgb ? colorSchemeForBackgroundRgb(rgb) ?? undefined : undefined;
		if (!scheme) return;
		if (this.sentScheme === scheme) {
			this.opts.onDiagnostic?.(buildSettleSchemePatch({ probeApi: api, outcome: "duplicate_skipped" }));
			return;
		}
		this.deliverSettleScheme(scheme, api, true);
	}

	private deliverSettleScheme(scheme: TerminalColorScheme | undefined, api: "colors" | "background" | "none", late: boolean): void {
		if (!scheme || this.closed) return;
		const data = toColorSchemeReport(scheme);
		if (!data) return;
		this.sentScheme = scheme;
		this.send({ type: "input", data });
		const details: { probeApi: "colors" | "background" | "none"; outcome: "reported"; report: string; late?: boolean } = {
			probeApi: api,
			outcome: "reported",
			report: scheme === "light" ? "997;2" : "997;1",
		};
		if (late) details.late = true;
		this.opts.onDiagnostic?.(buildSettleSchemePatch(details));
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pty-attach-settle-scheme.test.mjs && npm run typecheck`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/ui/pty-attach.ts test-support/attach-settle-scheme-smoke.ts test/pty-attach-settle-scheme.test.mjs
git commit -m "fix(attach): settle scheme probe uses the detected terminal query API"
```

---

### Task 3: Late-reply path (A5) — dedup, closed guard, timeout-then-late

**Files:**
- Modify: `test-support/attach-settle-scheme-smoke.ts` (add scenarios)
- Modify: `test/pty-attach-settle-scheme.test.mjs` (add assertions)

**Interfaces:**
- Consumes: Task 2's `handleLateSettleColors` behavior (no signature change — this task only proves it).
- Produces: none (behavior verification only).

- [ ] **Step 1: Write the failing tests**

Add to `attach-settle-scheme-smoke.ts` (before the `console.log`); these need control over the late callback, so they inline the setup instead of using `runSettle`:

```ts
async function runLateScenario(kind: "same" | "different" | "afterTimeout" | "closed") {
	const captures: Captures = { sent: [], diagnostics: [], writes: [] };
	// firstReply: "same"/"different"/"closed" deliver LIGHT up front; "afterTimeout"
	// answers nothing so the late reply is the only source.
	const firstReply = kind === "afterTimeout" ? {} : { background: LIGHT };
	let late: ((colors: unknown) => void) | undefined;
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (d: string) => captures.writes.push(d) },
		requestRender: () => {},
		onTerminalColorSchemeChange: () => () => {},
		queryTerminalColors: async (opts: { onLateReply?: (c: unknown) => void }) => {
			// Capture the late callback instead of auto-firing it: the "closed"
			// scenario must close the component BEFORE the late reply arrives.
			late = opts.onLateReply;
			return firstReply;
		},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const attach = new PtyAttachComponent(tui as never, theme as never, {} as never, () => {}, {
		socketPath: "/nonexistent/settle-scheme.sock",
		title: "settle-scheme-late",
		onDiagnostic: (event) => captures.diagnostics.push(event),
	});
	const internals = attach as unknown as { send: (m: { type: string; data?: string }) => void; finishAttachTransition: () => void };
	internals.send = (m) => { if (m?.type === "input" && m.data) captures.sent.push(m.data); };
	internals.finishAttachTransition();
	await new Promise((r) => setImmediate(r));
	if (kind === "closed") (attach as unknown as { close(): void }).close();
	// Late payload: same scheme as delivered for "same"; a dark scheme for
	// "different"/"afterTimeout" (differs from the LIGHT already sent — or from
	// nothing, since sentScheme starts null); anything for "closed" (must drop).
	const latePayload = kind === "same" ? { background: LIGHT } : { background: { r: 0.16, g: 0.16, b: 0.21 } };
	late?.(latePayload);
	await new Promise((r) => setImmediate(r));
	return captures;
}

out.lateSame = dump(await runLateScenario("same"));
out.lateDifferent = dump(await runLateScenario("different"));
out.lateAfterTimeout = dump(await runLateScenario("afterTimeout"));
out.lateClosed = dump(await runLateScenario("closed"));
```

Add to the driver's test body:

```js
	// A5 — late replies: dedup, closed guard, timeout-then-late delivery.
	assert.deepEqual(out.lateSame.sent, ["\x1b[?997;2n"], "same-scheme late reply is deduped");
	assert.equal(out.lateSame.diagnostics.at(-1).details.outcome, "duplicate_skipped");
	assert.equal(out.lateSame.diagnostics.at(-1).level, "info");

	assert.deepEqual(out.lateDifferent.sent, ["\x1b[?997;2n", "\x1b[?997;1n"], "different-scheme late reply delivers");
	const lateDiff = out.lateDifferent.diagnostics.at(-1);
	assert.equal(lateDiff.details.outcome, "reported");
	assert.equal(lateDiff.details.late, true);
	assert.equal(lateDiff.details.report, "997;1");

	assert.deepEqual(out.lateAfterTimeout.sent, ["\x1b[?997;1n"], "timeout-then-late still delivers (sentScheme null)");
	assert.equal(out.lateAfterTimeout.diagnostics[0].details.outcome, "timeout");
	assert.equal(out.lateAfterTimeout.diagnostics.at(-1).details.outcome, "reported");

	assert.deepEqual(out.lateClosed.sent, ["\x1b[?997;2n"], "closed late reply sends nothing beyond the initial delivery");
	assert.equal(out.lateClosed.diagnostics.at(-1).details.outcome, "dropped_closed");
	assert.equal(out.lateClosed.diagnostics.at(-1).level, "info");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/pty-attach-settle-scheme.test.mjs`
Expected: FAIL on `lateSame`/`lateDifferent`/`lateClosed` — Task 2's implementation wires `onLateReply` already, so if all pass immediately, verify the assertions actually exercise the path (temporarily break `handleLateSettleColors`'s dedup line and re-run; it must fail). Document the mutation check in the commit-free scratch, then restore.

- [ ] **Step 3: Fix only what the failures show (expected: none — this task proves Task 2's late path)**

If a scenario fails, fix `handleLateSettleColors` / `deliverSettleScheme` in `src/ui/pty-attach.ts` until green. Do not weaken assertions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pty-attach-settle-scheme.test.mjs && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test-support/attach-settle-scheme-smoke.ts test/pty-attach-settle-scheme.test.mjs
git commit -m "test(attach): cover late color reply dedup, closed guard, timeout-then-late"
```

---

### Task 4: Wire diagnostics into both openPtyAttach construction sites

**Files:**
- Modify: `src/commands/attach-flow.ts:24-45` (exported `openPtyAttach` — keyboard/bg paths)
- Modify: `src/commands/agent-board.ts:226-251` (private `openPtyAttach` — dashboard path)

**Interfaces:**
- Consumes: Task 2's `PtyAttachOptions.onDiagnostic`; existing `appendDiagnostic(root, viewId, patch)` from `src/core/diagnostics.mjs`; both factories already hold `root` and `viewId`.
- Produces: diagnostics.jsonl entries per attach for U1/U2.

- [ ] **Step 1: Implement the wiring (no unit — U1 verifies end-to-end; A8's typecheck gates the compile)**

In BOTH files: add the import next to the existing `screenLogPath` import:

```ts
import { appendDiagnostic } from "../core/diagnostics.mjs";
```

and extend the options object passed to `new PtyAttachComponent(...)` identically in both factories:

```ts
				{
					socketPath,
					screenLogPath: root ? screenLogPath(root, viewId) : undefined,
					title: name,
					onDiagnostic: root
						? (event) => {
								// Best effort, like every other diagnostics writer.
								try {
									appendDiagnostic(root, viewId, event as never);
								} catch {
									/* diagnostics must never break attach */
								}
							}
						: undefined,
				},
```

- [ ] **Step 2: Run the gates**

Run: `npm run typecheck && node --test test/attach-flow.test.mjs test/pty-attach-detach-gate.test.mjs`
Expected: PASS both (no behavior change without onDiagnostic consumers).

- [ ] **Step 3: Commit**

```bash
git add src/commands/attach-flow.ts src/commands/agent-board.ts
git commit -m "fix(attach): record settle scheme diagnostics in the view's diagnostics.jsonl"
```

---

### Task 5: Real-PTY integration scenario with the new API (A7)

**Files:**
- Modify: `test-support/detach-gate-smoke.ts` (the settle-probe scenario block — search `settleProbeReportsRealTerminalScheme`, currently around lines 544–561)
- Modify: `test/pty-attach-detach-gate.test.mjs` (add one assertion)

**Interfaces:**
- Consumes: existing harness (fake tui + real `node-pty` child + captured `sent`); Task 2's component behavior.
- Produces: `out.settleProbeNewApiReportsRealTerminalScheme` boolean in the smoke JSON.

- [ ] **Step 1: Write the failing test**

In the driver (`test/pty-attach-detach-gate.test.mjs`), add to the existing detach-gate test's assertions:

```js
	assert.equal(parsed.settleProbeNewApiReportsRealTerminalScheme, true, "A7: new-API tui delivers a 997;2 to the real child PTY exactly once");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pty-attach-detach-gate.test.mjs`
Expected: FAIL — `settleProbeNewApiReportsRealTerminalScheme` is `undefined` in the smoke JSON.

- [ ] **Step 3: Add the scenario to the smoke script**

Mirror the existing `settleProbeReportsRealTerminalScheme` scenario: same real-`node-pty` child and `sent` capture, but the fake tui exposes ONLY the new API (reuse the file's existing light RGB constant, e.g. the Catppuccin Latte background used by the current scenario):

```ts
// A7 (issue #161): tui with only the new pi-tui API (>= 0.99) still delivers
// the settle scheme to the real child PTY — exactly one 997;2 report.
{
	const newApiTui = makeSmokeTui({
		queryTerminalColors: async () => ({ background: LIGHT_BACKGROUND_RGB }),
	});
	const sent = await runSettleProbeScenario(newApiTui);
	out.settleProbeNewApiReportsRealTerminalScheme =
		sent.length === 1 && sent[0] === "\x1b[?997;2n";
}
```

(Use the actual helper/constant names from the file — `makeSmokeTui`/`runSettleProbeScenario`/`LIGHT_BACKGROUND_RGB` stand for the existing local helpers; if the scenario block is inlined rather than helper-based, copy the block and swap the fake's query method, keeping everything else identical.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/pty-attach-detach-gate.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test-support/detach-gate-smoke.ts test/pty-attach-detach-gate.test.mjs
git commit -m "test(attach): new query API settle delivery over a real PTY"
```

---

### Task 6: Full gate + post-implementation manual verification (A8, U1/U2)

**Files:**
- No code files. Produces the U1/U2 execution record (kept for the PR body / step 9's acceptance reconciliation).

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: typecheck + perf gate + tests + coverage (lines 85 / funcs 80 / branches 70 — the three-way API detection and all outcome branches are covered by Tasks 1–3) + pack:dry, all green. Fix whatever it reports; re-run until green.

- [ ] **Step 2: Reconcile the acceptance matrix (automated part)**

For each of A1–A9, record the command actually run and its result (from Tasks 1–5 runs + `npm run verify`). Any A-item that did not actually run is NOT done — do not claim it.

- [ ] **Step 3: U1/U2 manual verification (user-executed, after merge)**

Post these steps to the user (they require the merged main and a real light WezTerm):

- U1 前置: `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull --ff-only` + restart host pi. Then light WezTerm → start board → board-level restart → attach twice (① dashboard enter on a view; ② detach, ← keyboard or bg path). Pass: both first frames light-warm (userMsg ≈ `#f0f0f0`), both views' `diagnostics.jsonl` contain `code:"attach_settle_scheme"` with `details.probeApi:"colors"`, `details.report:"997;2"`.
- U2: same preconditions + `AGENT_BOARD_FORWARD_TERMINAL_QUERIES=0`; pass: no probe (diagnostics `details.outcome:"suppressed"`), no errors, dark child (pre-fix behavior).

Record results as they come; `pending` until then — automated greens do NOT replace U1/U2.

- [ ] **Step 4: No commit (verification task)**
