import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { resolveNode, resolvePiInvocation } from "../src/core/invocation.mjs";

test("resolvePiInvocation re-runs the current script under the current runtime", () => {
	const inv = resolvePiInvocation();
	assert.equal(inv.piCommand, process.execPath);
	assert.deepEqual(inv.piArgsPrefix, [process.argv[1]]);
});

test("resolveNode returns the current runtime when it is a generic node/bun binary", () => {
	assert.equal(resolveNode(), process.execPath);
});

test("resolvePiInvocation falls back to pi on PATH when argv[1] is not a real script", () => {
	// With `node --input-type=module -e`, argv[1] is "-e", which does not exist on
	// disk — the same shape as a generic runtime invoked without a script path.
	const code = [
		`const { resolvePiInvocation, resolveNode } = await import(${JSON.stringify(new URL("../src/core/invocation.mjs", import.meta.url).href)});`,
		`console.log(JSON.stringify({ inv: resolvePiInvocation(), node: resolveNode() }));`,
	].join("\n");
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
	const parsed = JSON.parse(out);
	assert.equal(parsed.inv.piCommand, "pi");
	assert.deepEqual(parsed.inv.piArgsPrefix, []);
	assert.equal(parsed.node, process.execPath);
});
