import test from "node:test";
import assert from "node:assert/strict";
import { attachPrLabel } from "../src/core/attach-pr-label.mjs";

test("attach header labels the winning GitHub PR and GitLab MR", () => {
	assert.equal(attachPrLabel({ provider: "github", prPrefix: "▸#", pr: { kind: "pr", number: 271 } }), "PR #271");
	assert.equal(attachPrLabel({ provider: "gitlab", prPrefix: "!", pr: { kind: "pr", number: 42 } }), "MR !42");
	assert.equal(attachPrLabel({ provider: "custom", prPrefix: "!", pr: { kind: "pr", number: 7 } }), "MR !7");
});

test("attach header omits missing, issue-only and malformed PR references", () => {
	assert.equal(attachPrLabel(null), "");
	assert.equal(attachPrLabel({ issue: { kind: "issue", number: 271 }, pr: null }), "");
	assert.equal(attachPrLabel({ pr: { kind: "issue", number: 271 } }), "");
	for (const number of [0, -1, 2.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
		assert.equal(attachPrLabel({ pr: { kind: "pr", number } }), "");
	}
});
