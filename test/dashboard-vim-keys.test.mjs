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

test("help overlay and hint lines document j/k/l (issue #229 A7)", () => {
	const out = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", PROBE], { encoding: "utf8", timeout: 30_000 }));
	const { help120, listRender, selectRender, help80Lines } = out.copy;
	assert.match(help120, /↑\/↓ or j\/k/);
	assert.match(help120, /→ \/ > \/ l/);
	assert.match(help120, /In select.*j\/k/);
	assert.match(help120, /In peek.*↑↓\/j\/k/);
	assert.match(help120, /In peek.*→\/l attach/);
	assert.match(help120, /In session.*↑↓\/j\/k scroll/);
	assert.match(help120, /In evidence.*↑↓\/j\/k scroll/);
	assert.match(help120, /In evidence.*→\/l attach/);
	// Negative: stale pre-change wording is gone from every row that named bare arrows.
	assert.doesNotMatch(help120, /In peek.*· ↑↓ adjacent/);
	assert.doesNotMatch(help120, /In session.*· ↑↓ scroll/);
	assert.doesNotMatch(help120, /In evidence.*· ↑↓ scroll/);
	assert.match(listRender, /→\/l attach/);
	assert.match(selectRender, /↑↓\/j\/k move/);
	assert.ok(help80Lines > 0, "80-col help render must not throw (RF3)");
});
