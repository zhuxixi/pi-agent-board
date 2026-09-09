/**
 * Architecture writer-boundary static test (issue #91, spec D3 / acceptance A7).
 *
 * Production code may only import `writeState`/`writeStatus` (the state.json /
 * status.json materializers) inside the View State Coordinator. Every other
 * importer must appear in the shrinking allowlist below with a one-line
 * justification grounded in the actual remaining call sites. PR #2 migrates
 * the remaining sites and MUST delete the corresponding entries — the
 * non-rotting test below fails while a stale entry lingers after migration.
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
 * PR #1 allowlist: pre-coordinator write sites not yet migrated.
 * Each entry needs a justification grounded in real call sites; ADDING an
 * entry is an architecture regression and must be justified in CR.
 * Call-site inventory verified against the worktree at Task 9 time
 * (2026-09-09); PR #2 migrates the remaining sites and deletes entries.
 */
const WRITE_STATE_ALLOWLIST = new Map([
	// Remaining non-finalization semantic sites: markQueued / markVisited /
	// archiveView / adopt / reconcile row mirrors, plus the explicit
	// coordinator_disabled legacy branches (e.g. completeViewDirect).
	["src/runtime/service.mjs", "PR #1: 非终态站点（markQueued/markVisited/archive/adopt/reconcile 镜像）+ coordinator_disabled 遗留分支（completeViewDirect），待 PR #2 迁移"],
	// Definition module, not an importer: the import scan can never flag it.
	// Listed to document that its internal createView bootstrap write is also
	// a PR #2 migration item. The non-rotting test passes trivially here (the
	// exported definitions always mention the writers) — by design.
	["src/core/store.mjs", "定义模块（非 importer）：createView bootstrap 初始化写在本模块内部，PR #2 迁移；此条目仅作记录，导入扫描永不命中"],
	// AGENT_BOARD_COORDINATOR=off escape hatch only (documented designed
	// exception): boot/throttle/plan-ready/follow-up direct writes live here so
	// job-runner.mjs itself stays write-free. PR #2 Task 3.
	["runner/job-runner-legacy.mjs", "PR #2: coordinator_disabled 逃生门的全部直写（boot/热路径/plan-ready/follow-up bootstrap 的 legacy 分支），设计内豁免"],
	// Two groups, both manually-fenced: (1) the full legacy classify-persist
	// inside the coordinator_disabled escape hatch; (2) post-decision evidence
	// mirrors (status.evidenceSummary / state.review) written from FRESH reads
	// taken after the coordinator's verdict (Task 7 deferral).
	["runner/state-runner.mjs", "PR #1: coordinator_disabled 遗留分支的完整分类持久化 + 决策后 evidence 镜像（新读取 + isManualCompletion 围栏，Task 7 延期），待 PR #2 迁移"],
	// markCompleted compatibility fallback: only reachable when the dashboard
	// process holds a service object created by a pre-Task-6 module instance
	// (live-reload window). The normal path routes through the coordinator.
	["src/ui/dashboard.ts", "PR #1: markCompleted 对已打开 dashboard 旧 service 对象的兼容回退（热重载窗口）；正常路径已走 coordinator，待 PR #2 清理"],
	// markRowFailed moved to the fenced host_run_failed command in Phase-2b
	// Task 5; this module now only holds the coordinator_disabled escape-hatch
	// direct write (markRowFailedDirect) — no manual-completion fence by design.
	["runner/pty-runner-legacy.mjs", "coordinator_disabled 逃生门（markRowFailedDirect 直写，无 fence——默认配置不可达），设计内豁免"],
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

test("only the coordinator imports writeState/writeStatus in production code (allowlisted exceptions)", () => {
	const offenders = [];
	for (const file of collectSourceFiles()) {
		const src = readFileSync(file, "utf8");
		if (!WRITE_IMPORT_RE.test(src)) continue;
		const key = rel(file);
		if (ALLOWED_WRITER_MODULES.has(key)) continue;
		if (!WRITE_STATE_ALLOWLIST.has(key)) offenders.push(key);
	}
	assert.deepEqual(offenders, [], `files import writeState/writeStatus without an allowlist justification: ${offenders.join(", ")}`);
});

test("allowlist does not shrink silently (update the map when migrating)", () => {
	for (const [key] of WRITE_STATE_ALLOWLIST) {
		const src = readFileSync(join(PACKAGE_ROOT, key), "utf8");
		assert.ok(WRITE_MENTION_RE.test(src), `${key} no longer writes — remove its allowlist entry`);
	}
});

test("the coordinator itself still imports the state materializers", () => {
	const src = readFileSync(join(PACKAGE_ROOT, "runner", "state-coordinator.mjs"), "utf8");
	assert.ok(WRITE_IMPORT_RE.test(src), "state-coordinator.mjs must remain the (sole) writer module — restoring direct writes elsewhere is the regression this file guards against");
});
