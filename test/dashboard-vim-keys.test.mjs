import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "vim-keys-wrap.ts");

test("vim j/k/l bindings mirror the arrow keys across board modes (issue #229)", () => {
	const out = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", PROBE], { encoding: "utf8", timeout: 30_000 }));
	const { ids } = out;
	assert.equal(ids.length, 3, "probe must see 3 rows");
	// A1: list j/k wrap like the arrows; j/k never pop the INSERT toast.
	assert.deepEqual(out.list, [ids[1], ids[2], ids[0], ids[2], ids[2]], "j down x2, wrap; k wrap; paste no-move");
	assert.deepEqual(out.notices, [true, true], "j: no INSERT toast; J: keeps the printable fallback");
	// A2: select mode j/k move (wrap).
	assert.deepEqual(out.select, [ids[1], ids[0], ids[2]]);
	// A3: peek j/k step (wrap).
	assert.deepEqual(out.peek, [ids[1], ids[0], ids[2]]);
	// A4: l attaches in list / peek / evidence.
	assert.deepEqual(out.attach.map((r) => [r.action, r.viewId, r.stopFirst]), [
		["attach", ids[0], false],
		["attach", ids[1], false],
		["attach", ids[2], false],
	]);
	// A9: l stays unbound in select / session.
	assert.deepEqual(out.negative, [["select-l", "select", 0], ["session-l", "session", 0]]);
	// A6: session / evidence j/k still scroll.
	assert.deepEqual(out.scroll, [1, 0, 1, 0]);
	// A5: text modes keep j/k/l literal.
	for (const m of ["dispatch", "filter", "rename", "reply"]) assert.equal(out.text[m], "jkl", m);
	// RF2: busy row + l -> confirm branch, no direct attach.
	assert.equal(out.busyL.mode, "confirm");
	assert.equal(out.busyL.done, 0);
	assert.match(out.busyL.prompt, /Interrupt and attach/);
});
