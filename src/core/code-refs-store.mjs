/**
 * Per-view code-refs artifact (`github.json`) plus the evidence→extraction
 * hook helper.
 *
 * Mirrors evidence.mjs's normalize/read/write/summarize shape. Extraction is
 * delegated to the pure engine in code-refs.mjs; this module only composes the
 * engine input from a view's meta + evidence and persists the snapshot
 * atomically. `meta` is passed in by callers (they already hold it) so this
 * module never imports store.mjs — keeping the store ↔ artifact imports free
 * of cycles.
 */
import { execFileSync } from "node:child_process";
import { atomicWriteJson, readJson } from "./atomic.mjs";
import * as P from "./paths.mjs";
import {
	extractCodeRefs,
	loadProviders,
	matchProvider,
	parseRemoteHost,
	parseRemotePath,
} from "./code-refs.mjs";
import { gitRemoteUrl } from "./repo.mjs";
import { appendDiagnostic } from "./diagnostics.mjs";

/**
 * @typedef {Object} CodeRefsSnapshot
 * @property {number} version
 * @property {string} viewId
 * @property {number} updatedAt
 * @property {string|null} provider
 * @property {string} issuePrefix Issue-number prefix resolved from the matched provider (default "#").
 * @property {string} prPrefix PR/MR-number prefix resolved from the matched provider (default "▸#").
 * @property {import("./code-refs.mjs").Ref|null} issue
 * @property {import("./code-refs.mjs").Ref|null} pr
 * @property {import("./code-refs.mjs").Ref[]} allRefs
 */

/** @param {{ viewId:string, now?:number }} opts @returns {CodeRefsSnapshot} */
export function emptyCodeRefsSnapshot(opts) {
	const now = opts.now ?? Date.now();
	return {
		version: 1,
		viewId: opts.viewId,
		updatedAt: now,
		provider: null,
		issuePrefix: "#",
		prPrefix: "▸#",
		issue: null,
		pr: null,
		allRefs: [],
	};
}

/**
 * Defensive shape guard mirroring evidence's normalize: missing/garbage input
 * yields an empty snapshot; valid fields pass through.
 * @param {any} raw
 * @param {{ viewId:string }} fallback
 * @returns {CodeRefsSnapshot}
 */
export function normalizeCodeRefsSnapshot(raw, fallback) {
	const base = emptyCodeRefsSnapshot({ viewId: fallback.viewId });
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
	return {
		...base,
		...raw,
		viewId: typeof raw.viewId === "string" ? raw.viewId : base.viewId,
		provider: typeof raw.provider === "string" ? raw.provider : (raw.provider === null ? null : base.provider),
		issuePrefix: typeof raw.issuePrefix === "string" ? raw.issuePrefix : base.issuePrefix,
		prPrefix: typeof raw.prPrefix === "string" ? raw.prPrefix : base.prPrefix,
		issue: isRefObject(raw.issue) ? raw.issue : null,
		pr: isRefObject(raw.pr) ? raw.pr : null,
		allRefs: Array.isArray(raw.allRefs) ? raw.allRefs : [],
	};
}

/** @param {any} value @returns {boolean} */
function isRefObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {string} root @param {string} viewId @returns {CodeRefsSnapshot} */
export function readCodeRefs(root, viewId) {
	return normalizeCodeRefsSnapshot(readJson(P.codeRefsPath(root, viewId), null), { viewId });
}

/** @param {string} root @param {CodeRefsSnapshot} snapshot @returns {CodeRefsSnapshot} */
export function writeCodeRefs(root, snapshot) {
	const normalized = normalizeCodeRefsSnapshot(snapshot, { viewId: snapshot.viewId });
	normalized.updatedAt = Date.now();
	atomicWriteJson(P.codeRefsPath(root, normalized.viewId), normalized);
	return normalized;
}

/** @param {any} snapshot @returns {import("./types.mjs").CodeRefsSummary} */
export function summarizeCodeRefs(snapshot) {
	const s = normalizeCodeRefsSnapshot(snapshot, { viewId: snapshot?.viewId ?? "" });
	return {
		provider: s.provider,
		issuePrefix: s.issuePrefix,
		prPrefix: s.prPrefix,
		issue: s.issue,
		pr: s.pr,
		allRefs: s.allRefs,
	};
}

/**
 * Current branch of a working dir via `git branch --show-current`, cached per
 * cwd for 60s. Best-effort like repo.mjs: off-repo or git failures yield null
 * (also cached), but the TTL means a newly created branch shows up within a
 * minute without needing an explicit cache clear.
 * @type {Map<string, { at:number, branch:string|null }>}
 */
const branchCache = new Map();
const BRANCH_CACHE_TTL_MS = 60_000;

/** @param {string|null} cwd @returns {string|null} */
function currentBranch(cwd) {
	if (typeof cwd !== "string" || !cwd) return null;
	const cached = branchCache.get(cwd);
	if (cached && Date.now() - cached.at < BRANCH_CACHE_TTL_MS) return cached.branch;
	let branch = null;
	try {
		const out = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		branch = out.trim() || null;
	} catch {
		// not a repo or git unavailable
	}
	branchCache.set(cwd, { at: Date.now(), branch });
	return branch;
}

/**
 * Extract issue/PR refs from view evidence and persist the per-view snapshot.
 * The hook helper for every `writeEvidence` call site: never throws, writes only
 * when the serialized ref content actually changed, and is disabled entirely
 * by `AGENT_BOARD_CODE_REFS=off` (returns false without writing).
 *
 * `meta` is a parameter (callers pass `row.meta` / the runner's readMeta
 * result) so this module never imports store.mjs. repoRoot falls back to
 * meta.cwd when the view has no recorded repo root.
 * @param {string} root
 * @param {string} viewId
 * @param {import("./types.mjs").EvidenceSnapshot|any} evidence
 * @param {{repoRoot?: string|null, cwd?: string|null, worktreePath?: string|null}|null|undefined} meta
 * @returns {boolean} true when extraction ran and the snapshot is current; false when off or failed.
 */
export function updateCodeRefsFromEvidence(root, viewId, evidence, meta) {
	if (process.env.AGENT_BOARD_CODE_REFS === "off") return false;
	try {
		const repoRoot = meta?.repoRoot ?? meta?.cwd ?? null;
		const remoteUrl = repoRoot ? gitRemoteUrl(repoRoot) : null;
		const host = remoteUrl ? parseRemoteHost(remoteUrl) : null;
		const repoUrl = remoteUrl ? parseRemotePath(remoteUrl) : null;
		const provider = matchProvider(loadProviders(root), host);
		const cwd = typeof meta?.cwd === "string" ? meta.cwd : null;
		const worktreePath = typeof meta?.worktreePath === "string" ? meta.worktreePath : null;
		const branch = currentBranch(cwd);
		const input = buildEngineInput(evidence, { worktreePath, branch, repoUrl, host });
		const result = extractCodeRefs(input, provider);
		const next = {
			version: 1,
			viewId,
			updatedAt: Date.now(),
			provider: result.provider,
			issuePrefix: provider.issuePrefix,
			prPrefix: provider.prPrefix,
			issue: result.issue,
			pr: result.pr,
			allRefs: result.allRefs,
		};
		// Avoid churning the artifact (and its mtime) when the refs are unchanged.
		if (contentOf(readCodeRefs(root, viewId)) === contentOf(next)) return true;
		writeCodeRefs(root, next);
		return true;
	} catch (e) {
		try {
			appendDiagnostic(root, viewId, {
				runId: evidence?.runId ?? null,
				source: "evidence",
				level: "error",
				code: "code_refs_extract_failed",
				message: `code-refs extraction failed: ${e instanceof Error ? e.message : String(e)}`,
			});
		} catch {
			// diagnostics must never break the evidence flow either
		}
		return false;
	}
}

/** @param {any} s @returns {string} serialized ref content (updatedAt excluded) */
function contentOf(s) {
	return JSON.stringify({
		provider: s.provider,
		issuePrefix: s.issuePrefix,
		prPrefix: s.prPrefix,
		issue: s.issue,
		pr: s.pr,
		allRefs: s.allRefs,
	});
}

/**
 * Compose the pure engine input from evidence: all commands plus the last 20
 * assistant claim texts.
 * @param {any} evidence
 * @param {{ worktreePath: string|null, branch: string|null, repoUrl: string|null, host: string|null }} ctx
 */
function buildEngineInput(evidence, ctx) {
	const commands = Array.isArray(evidence?.commands) ? evidence.commands : [];
	const claims = Array.isArray(evidence?.assistantEvidence) ? evidence.assistantEvidence : [];
	const assistantTexts = claims
		.slice(-20)
		.map((claim) => (claim && typeof claim.text === "string" ? claim.text : ""))
		.filter((text) => text !== "");
	return { commands, assistantTexts, worktreePath: ctx.worktreePath, branch: ctx.branch, repoUrl: ctx.repoUrl, host: ctx.host };
}
