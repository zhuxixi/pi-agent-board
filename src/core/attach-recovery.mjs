/**
 * Issue #284 attach recovery: pure proof-status classification (spec §3.1.1).
 *
 * classifyProofStatus is the single implementation source for the four
 * proofStatus buckets consumed by decideAttachPresentation's committed-degraded
 * chain. The reason enums are anchored to their producers:
 *
 * - src/core/attach-view-proof.mjs `coverageFor`: `covered` (exact-proof /
 *   safe-trailing), `unavailable` (candidate-open, candidate-aborted,
 *   trailing-pending, trailing-unsafe), `unknown` (no-output, no-proof,
 *   output-gap, journal-gap, journal-evicted, proof-evicted,
 *   snapshot-seq-future, snapshot-before-window, invalid-snapshot-seq).
 * - src/core/terminal-attach-client.mjs `unknownViewProof`: `unknown` +
 *   invalid-view-proof, view-proof-future, records-dropped, proof-output-gap.
 * - src/ui/pty-attach.ts `invalidateViewProof` call sites: `unknown` +
 *   candidate-open (:1319), candidate-aborted (:1326), view-proof-replay-gap,
 *   view-proof-trailing-pending / view-proof-trailing-<reason>.
 *   Other UI-side invalidation reasons reaching the coverage object
 *   (new-empty-baseline, empty-baseline, generation-change, epoch-reset,
 *   geometry-resize) fail closed as invalid; geometry-resize is also
 *   whitelisted for the diagnostic readout.
 *
 * Matching uses exact string tables; any unrecognized status/reason classifies
 * as "invalid" (fail closed — prefer waiting over displaying).
 */

const COVERED_REASONS = new Set(["exact-proof", "safe-trailing"]);

// Runner-protocol candidate states are recoverable "missing evidence": the
// candidate may still end covered, so the degraded path may publish.
const CANDIDATE_REASONS = new Set(["candidate-open", "candidate-aborted"]);

// Coverage-for shapes that mean "output exists but was never proven" — missing
// evidence, degradable like the candidate shapes.
const UNKNOWN_MISSING_REASONS = new Set(["no-proof", "no-output"]);

// Continuity/window/protocol-validation failures: the view was proven once and
// then degraded, or the journal cannot vouch for the window. Never degradable.
const UNKNOWN_INVALID_REASONS = new Set([
	"output-gap",
	"journal-gap",
	"journal-evicted",
	"proof-evicted",
	"snapshot-seq-future",
	"snapshot-before-window",
	"invalid-snapshot-seq",
	"invalid-view-proof",
	"view-proof-future",
	"records-dropped",
	"proof-output-gap",
	"view-proof-replay-gap",
]);

function isCoveredShape(viewProof) {
	return (
		viewProof !== null &&
		typeof viewProof === "object" &&
		!Array.isArray(viewProof) &&
		viewProof.status === "covered" &&
		COVERED_REASONS.has(viewProof.reason)
	);
}

/**
 * Classify the latest view proof for the attach recovery policy.
 *
 * The sticky priority rule runs FIRST: when `stickyInvalid` is true, every
 * input except a recognized covered shape returns "invalid" — a live S/A
 * record, no-proof, a null proof after capability loss, and unrecognized
 * values included. The sticky fact is only cleared by the caller (component
 * layer) when the full-view policy PUBLISHES on the current baseline — a
 * covered shape alone is not recovery, because coverage is established before
 * the policy validates sequence/metadata/geometry/intent/identity — or when
 * the baseline identity changes; this function reports "covered" for exactly
 * the publishable-recovery shape.
 *
 * @param {object|null} latestViewProof coverage object as produced by
 *   coverageFor / unknownViewProof / invalidateViewProof (null = capability
 *   revoked or never received).
 * @param {boolean} stickyInvalid whether the current baseline already recorded
 *   an unrecovered invalid classification.
 * @returns {"none" | "missing" | "invalid" | "covered"}
 */
export function classifyProofStatus(latestViewProof, stickyInvalid) {
	if (stickyInvalid === true) {
		return isCoveredShape(latestViewProof) ? "covered" : "invalid";
	}
	const viewProof = latestViewProof;
	if (viewProof === null || viewProof === undefined) return "none";
	if (typeof viewProof !== "object" || Array.isArray(viewProof)) return "invalid";
	if (viewProof.status === "covered") {
		return COVERED_REASONS.has(viewProof.reason) ? "covered" : "invalid";
	}
	if (viewProof.status === "unavailable") {
		// trailing-pending/trailing-unsafe extend a prior covered proof with
		// unsafe trailing bytes: covered-then-degraded, never degradable.
		return CANDIDATE_REASONS.has(viewProof.reason) ? "missing" : "invalid";
	}
	if (viewProof.status === "unknown") {
		if (CANDIDATE_REASONS.has(viewProof.reason) || UNKNOWN_MISSING_REASONS.has(viewProof.reason)) return "missing";
		if (UNKNOWN_INVALID_REASONS.has(viewProof.reason)) return "invalid";
		if (typeof viewProof.reason === "string" && viewProof.reason.startsWith("view-proof-trailing-")) return "invalid";
		return "invalid";
	}
	return "invalid";
}

/** Issue #284 review hardening (settle-diagnostics hygiene): recognized
 *  (status, reason) pairs for the diagnostic layer's latestViewProof readout.
 *  The attach client's sanitizer accepts arbitrary reason strings from the
 *  wire, so anything exposed to onDiagnostic consumers must pass a whitelist
 *  first: recognized producer pairs pass through verbatim, everything else
 *  maps to "unrecognized" (finite enums only — never raw wire strings).
 *  Mirrors the classifier's tables plus the runner's reporter lifecycle
 *  reasons and the snapshot/baseline invalidation reasons that reach the
 *  component's coverage object. */
const DIAGNOSTIC_STATUS_REASONS = {
	covered: new Set(["exact-proof", "safe-trailing"]),
	unavailable: new Set(["candidate-open", "candidate-aborted", "trailing-pending", "trailing-unsafe"]),
	unknown: new Set([
		// coverageFor missing-evidence shapes.
		"candidate-open",
		"candidate-aborted",
		"no-proof",
		"no-output",
		// coverageFor window/continuity failures.
		"output-gap",
		"journal-gap",
		"journal-evicted",
		"proof-evicted",
		"snapshot-seq-future",
		"snapshot-before-window",
		"invalid-snapshot-seq",
		// terminal-attach-client unknownViewProof reasons.
		"invalid-view-proof",
		"view-proof-future",
		"records-dropped",
		"proof-output-gap",
		// pty-attach invalidateViewProof call sites.
		"view-proof-replay-gap",
		"new-empty-baseline",
		"empty-baseline",
		"generation-change",
		"epoch-reset",
		"geometry-resize",
		// runner resetViewProofSubscribers reasons (reporter close/replacement).
		"reporter-replaced",
		"reporter-close",
	]),
};

/** The dynamic noteViewProofOutput family: view-proof-trailing-<reason>, where
 *  <reason> is a trailing-classifier/scanner identifier. Accept it only in its
 *  lowercase-identifier form so arbitrary bytes can never ride the prefix. */
const TRAILING_REASON_PREFIX = "view-proof-trailing-";
const LOWERCASE_IDENTIFIER = /^[a-z][a-z0-9-]*$/;

/**
 * Whitelist a coverage object's (status, reason) pair for diagnostic records.
 *
 * @param {object|null} latestViewProof coverage object as produced by
 *   coverageFor / unknownViewProof / invalidateViewProof (null = capability
 *   revoked or never received).
 * @returns {{status: string, reason: string} | null} the recognized pair
 *   verbatim, {status: "unrecognized", reason: "unrecognized"} for any
 *   non-producer shape, or null when there is no proof object at all.
 */
export function sanitizeViewProofEnumPair(latestViewProof) {
	if (latestViewProof === null || latestViewProof === undefined) return null;
	if (typeof latestViewProof !== "object" || Array.isArray(latestViewProof)) {
		return { status: "unrecognized", reason: "unrecognized" };
	}
	const status = latestViewProof.status;
	const reason = latestViewProof.reason;
	if (typeof status !== "string" || typeof reason !== "string") {
		return { status: "unrecognized", reason: "unrecognized" };
	}
	const known = DIAGNOSTIC_STATUS_REASONS[status];
	if (known === undefined) return { status: "unrecognized", reason: "unrecognized" };
	if (known.has(reason)) return { status, reason };
	if (status === "unknown" && reason.startsWith(TRAILING_REASON_PREFIX) && LOWERCASE_IDENTIFIER.test(reason)) {
		return { status, reason };
	}
	return { status: "unrecognized", reason: "unrecognized" };
}

// --- Issue #288 D1: invalid-family classification for the cap floor ---

// Runner-snapshot trailing shapes (coverageFor): a prior covered proof
// extended by unsafe trailing bytes — the trailing family's snapshot arrival
// shape, distinct from the UI's unknown + view-proof-trailing-* shapes.
const UNAVAILABLE_TRAILING_REASONS = new Set(["trailing-pending", "trailing-unsafe"]);

/** Trailing-family identifier form for the UI arrival shape: the suffix
 *  after view-proof-trailing- accepts lowercase alphanumerics and hyphens
 *  only (spec I9 — malformed/empty/uppercase/special-character suffixes
 *  classify as hard, never trailing). */
const TRAILING_FAMILY_IDENTIFIER = /^[a-z0-9-]+$/;

function isTrailingFamilyReason(reason) {
	return (
		typeof reason === "string" &&
		reason.startsWith(TRAILING_REASON_PREFIX) &&
		TRAILING_FAMILY_IDENTIFIER.test(reason.slice(TRAILING_REASON_PREFIX.length))
	);
}

/**
 * Classify an invalid proof classification into its recovery family (issue
 * #288 D1): "trailing" shapes may still be admitted by the attach cap floor
 * once the deadline expires; "hard" shapes never can.
 *
 * The family is a property of the arrival shape, so the sticky fact is not
 * consulted: null is returned exactly when classifyProofStatus (without
 * sticky) would NOT classify the shape as "invalid" — covered shapes, the
 * missing-evidence candidate/no-proof/no-output shapes, and a null/absent
 * proof object. The trailing family covers the two real arrival shapes of
 * issue #288:
 * - runner snapshot `coverageFor`: unavailable + trailing-pending /
 *   trailing-unsafe;
 * - UI local paths (`noteViewProofOutput` live output and post-F replay via
 *   `invalidateViewProof`): unknown + view-proof-trailing-pending and
 *   unknown + view-proof-trailing-<identifier> in strict identifier form.
 * Every other invalid classification — the window/continuity/validation
 * reasons, non-object payloads, and any unrecognized status/reason — is
 * "hard" (fail closed: the cap floor must not unlock it).
 *
 * @param {object|null} viewProof coverage object as produced by
 *   coverageFor / unknownViewProof / invalidateViewProof (null = capability
 *   revoked or never received).
 * @returns {"trailing" | "hard" | null}
 */
export function classifyProofInvalidFamily(viewProof) {
	if (classifyProofStatus(viewProof, false) !== "invalid") return null;
	if (typeof viewProof !== "object" || Array.isArray(viewProof)) return "hard";
	if (viewProof.status === "unavailable" && UNAVAILABLE_TRAILING_REASONS.has(viewProof.reason)) return "trailing";
	if (viewProof.status === "unknown" && isTrailingFamilyReason(viewProof.reason)) return "trailing";
	return "hard";
}
