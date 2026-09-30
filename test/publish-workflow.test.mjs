import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The tag a publish run works on comes from the trigger, not from the ref the
 * run was started on: a published GitHub Release carries it in
 * `github.event.release.tag_name`, a manual `workflow_dispatch` recovery run
 * carries it in `inputs.tag`. Deriving it from `GITHUB_REF_NAME` breaks every
 * manual recovery run, because that variable holds the *branch* the run was
 * dispatched from (issue #154).
 *
 * The expression must appear in BOTH the checkout step and the tag-check
 * step: deleting the check step's `env:` block must fail this suite, so the
 * count is asserted, not just presence.
 */
const TAG_SOURCE = /github\.event\.release\.tag_name\s*\|\|\s*inputs\.tag/g;

/**
 * Read a workflow file as text -- the only side effect in this file. Full-line
 * comments are stripped so prose about this invariant (e.g. a comment warning
 * against ref-name derivation) cannot trip the guard.
 */
function readWorkflowSource(name) {
	const raw = readFileSync(join(PACKAGE_ROOT, ".github", "workflows", name), "utf8");
	return raw
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

test("publish.yml never derives the release tag from the run's ref", () => {
	const source = readWorkflowSource("publish.yml");
	assert.equal(
		source.includes("GITHUB_REF_NAME"),
		false,
		"publish.yml must not use GITHUB_REF_NAME: on a workflow_dispatch run it holds the branch name, not the tag (issue #154)",
	);
});

test("publish.yml derives the release tag from the event payload or dispatch input in both places", () => {
	const source = readWorkflowSource("publish.yml");
	const uses = source.match(TAG_SOURCE)?.length ?? 0;
	assert.ok(
		uses >= 2,
		`expected the tag source in both the checkout step and the tag-check step (>= 2 occurrences), found ${uses}`,
	);
});
