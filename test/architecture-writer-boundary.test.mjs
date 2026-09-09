/**
 * Architecture writer-boundary static test (issue #91, spec D3 / acceptance A7).
 *
 * Production code may only import `writeState`/`writeStatus` (the state.json /
 * status.json materializers) inside the View State Coordinator. Every other
 * importer must appear in the DESIGNED-EXCEPTION registry below with a
 * permanent justification. Since Phase-2b (PR #2) migrated every remaining
 * write site, entries are no longer a shrinking migration queue: each one is
 * an architecture decision that stands until the underlying escape hatch or
 * bootstrap path is removed. Adding an entry remains an architecture
 * regression and must be justified in CR; the non-rotting check keeps entries
 * honest (an entry whose file no longer writes must be deleted).
 *
 * `writeMeta` is intentionally out of scope: meta.json multi-writer behavior
 * is a documented known exception (spec §D3).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Designed-exception registry (Phase-2b end state): the only production write
 * paths outside the coordinator are the documented
 * AGENT_BOARD_COORDINATOR=off escape hatches and the createView bootstrap.
 * Each justification is permanent, not a migration placeholder; ADDING an
 * entry is an architecture regression and must be justified in CR.
 */
const WRITE_STATE_ALLOWLIST = new Map([
	// coordinator_disabled escape hatch (AGENT_BOARD_COORDINATOR=off, designed
	// exception): the *Direct helpers (markQueuedDirect / markVisitedDirect /
	// adoptStateDirect / completeViewDirect / archiveStateDirect) plus the
	// disabled fallbacks inside syncRowEvent and syncForeground. Unreachable on
	// the default path — the normal routes all submit coordinator commands.
	["src/runtime/service.mjs", "coordinator_disabled 逃生门，设计内豁免（debug/降级）：*Direct helper、syncRowEvent/syncForeground 的 disabled 回退分支，以及 reconcile() 的三处 coordinator_disabled 直写回退（host 探测终态 / project 模式 / runner-exited）；默认路径不可达，见各 Direct 函数与 reconcile 的 gating 分支"],
	// Definition module, not an importer: the import scan can never flag it.
	// Its internal createView bootstrap write is permanent by design: the fresh
	// random viewId means no other writer can know the row exists yet, so the
	// write cannot race. The non-rotting check uses mention-level matching only
	// for this entry (import-level never matches a definition module).
	["src/core/store.mjs", "createView bootstrap 不可能竞争（新 viewId 随机生成，无其他写者知情），永久豁免；本模块也是 writeState/writeStatus 的定义模块"],
	// coordinator_disabled escape hatch (designed exception): every legacy
	// direct write (boot/throttle/plan-ready/follow-up/post-exit summary)
	// extracted here in Phase-2b Task 3 so job-runner.mjs itself stays
	// write-free. Unreachable on the default path.
	["runner/job-runner-legacy.mjs", "coordinator_disabled 逃生门，设计内豁免（debug/降级）：job-runner 的全部 legacy 直写收敛于本模块；默认路径不可达，见 job-runner.mjs 的 gating 分支"],
	// coordinator_disabled escape hatch (designed exception): the full legacy
	// classify-persist branch. The normal path submits auto_state_classified
	// and the evidence mirrors route through patch_fields (Phase-2b Task 4).
	["runner/state-runner.mjs", "coordinator_disabled 逃生门，设计内豁免（debug/降级）：完整 legacy 分类持久化分支；默认路径不可达，见 sendStateCommand 结果的 gating 分支"],
	// coordinator_disabled escape hatch (designed exception): markRowFailedDirect
	// — the host-crash row finalization, deliberately without a manual fence
	// (the fenced default path is the host_run_failed command, Phase-2b Task 5).
	["runner/pty-runner-legacy.mjs", "coordinator_disabled 逃生门，设计内豁免（markRowFailedDirect 直写，无 fence——默认配置不可达，默认路径走 fenced host_run_failed 命令）"],
]);

/** The only unconditional writer: the View State Coordinator itself. */
const ALLOWED_WRITER_MODULES = new Set(["runner/state-coordinator.mjs"]);

/** Matches `writeState`/`writeStatus` inside a (possibly multi-line) import statement. */
const WRITE_IMPORT_RE = /import\s*\{[^}]*\bwrite(?:State|Status)\b[^}]*\}\s*from/;
const WRITE_MENTION_RE = /\bwrite(?:State|Status)\b/;

/** Recursively collect .mjs files under src/ and runner/, plus the root index.ts. */
function collectSourceFiles() {
	const files = [];
	for (const dir of ["src", "runner"]) {
		for (const entry of readdirSync(join(PACKAGE_ROOT, dir), { recursive: true })) {
			const full = join(PACKAGE_ROOT, dir, entry);
			if (/\.(mjs|ts)$/.test(String(entry))) files.push(full);
		}
	}
	files.push(join(PACKAGE_ROOT, "index.ts"));
	return files;
}

function rel(file) {
	return relative(PACKAGE_ROOT, file).split(sep).join("/");
}

test("only the coordinator imports writeState/writeStatus in production code (designed exceptions only)", () => {
	const offenders = [];
	for (const file of collectSourceFiles()) {
		const src = readFileSync(file, "utf8");
		if (!WRITE_IMPORT_RE.test(src)) continue;
		const key = rel(file);
		if (ALLOWED_WRITER_MODULES.has(key)) continue;
		if (!WRITE_STATE_ALLOWLIST.has(key)) offenders.push(key);
	}
	assert.deepEqual(offenders, [], `files import writeState/writeStatus without a designed-exception justification: ${offenders.join(", ")}`);
});

/** Entries checked at import level (real importers — the non-rotting check
 *  fails if the import disappears, forcing the entry to be deleted). */
const IMPORT_LEVEL_ENTRIES = new Set([
	"src/runtime/service.mjs",
	"runner/job-runner-legacy.mjs",
	"runner/state-runner.mjs",
	"runner/pty-runner-legacy.mjs",
]);

test("registry entries stay honest — a file that no longer writes must lose its entry", () => {
	for (const [key] of WRITE_STATE_ALLOWLIST) {
		const src = readFileSync(join(PACKAGE_ROOT, key), "utf8");
		// Import-level for real importers (a stale entry fails the moment the
		// import is removed); mention-level only for the definition module, whose
		// exported writer names always mention the functions by design.
		const re = IMPORT_LEVEL_ENTRIES.has(key) ? WRITE_IMPORT_RE : WRITE_MENTION_RE;
		assert.ok(re.test(src), `${key} no longer writes — remove its designed-exception entry`);
	}
	assert.ok(
		WRITE_STATE_ALLOWLIST.has("src/core/store.mjs") && !IMPORT_LEVEL_ENTRIES.has("src/core/store.mjs"),
		"store.mjs is a definition module — it must stay mention-level only",
	);
});

test("mention-level pinning is reserved for the definition module alone (pin/complement symmetry)", () => {
	const mentionLevel = [...WRITE_STATE_ALLOWLIST.keys()].filter((key) => !IMPORT_LEVEL_ENTRIES.has(key));
	assert.deepEqual(
		mentionLevel,
		["src/core/store.mjs"],
		"every non-import-level registry entry must be a definition module — real importers belong in IMPORT_LEVEL_ENTRIES",
	);
});

test("the coordinator itself still imports the state materializers", () => {
	const src = readFileSync(join(PACKAGE_ROOT, "runner", "state-coordinator.mjs"), "utf8");
	assert.ok(WRITE_IMPORT_RE.test(src), "state-coordinator.mjs must remain the (sole) writer module — restoring direct writes elsewhere is the regression this file guards against");
});
