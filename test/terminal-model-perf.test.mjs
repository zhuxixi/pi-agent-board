import test from "node:test";
import assert from "node:assert/strict";

import {
	createTerminalModel,
	feedOutput,
	whenIdle,
	ringChunksAfter,
} from "../src/core/terminal-model.mjs";
import {
	captureTerminalSnapshot,
	hydrateTerminalSnapshot,
	assertSnapshotEquivalence,
} from "../src/core/terminal-snapshot.mjs";
import { createTerminalSubscription } from "../src/core/terminal-attach-protocol.mjs";
import { perfGateDecision } from "../test-support/perf-gate.mjs";

/**
 * A11 (spec acceptance matrix): 12.5fps output stream sustained for the
 * equivalent of 60s, measuring parser lag (per-chunk feed latency), snapshot
 * generation latency, and ring overflow behavior. Plan-stage thresholds:
 * feed p95 ≤ 5ms / p99 ≤ 8ms, capture ≤ 50ms, hydrate ≤ 100ms (80×24 + 256
 * scrollback).
 */

// ---- deterministic chunk generator (fixed pattern, index-derived variation) ----

const WORDS = ["pi", "agent", "board", "runner", "attach", "snapshot", "seq", "frame", "mode", "grid"];
const CJK = "终端快照协议测试光标滚动";

/**
 * One realistic 12.5fps burst: printable runs with \r\n, SGR attribute bursts
 * (palette + RGB), cursor addressing, occasional full-screen scroll, wide
 * chars, and occasional mode toggles. Pure function of the chunk index — the
 * stream is fully reproducible.
 * @param {number} i chunk index (0-based)
 * @returns {string}
 */
function makeChunk(i) {
	const parts = [];
	const lineLen = 40 + (i % 9) * 20; // 40..200 chars per printable run
	const lineCount = i % 7 === 0 ? 30 : 3 + (i % 5); // every 7th chunk forces scroll
	for (let l = 0; l < lineCount; l++) {
		let line = "";
		while (line.length < lineLen) {
			const w = WORDS[(i + l) % WORDS.length];
			if (i % 3 === 0) {
				// SGR burst: palette fg+bg, bold/inverse/underline rotating
				const style = 1 + ((i + l) % 3); // 1 bold, 2 dim-ish, 3 italic
				const fg = 30 + ((i + l) % 8);
				const bg = 40 + ((i + l * 3) % 8);
				line += `\x1b[${style};${fg};${bg}m${w}\x1b[0m `;
			} else if (i % 5 === 2) {
				// truecolor bursts
				const r = (i * 7 + l * 13) % 256;
				const g = (i * 11 + l * 3) % 256;
				const b = (i * 5 + l * 29) % 256;
				line += `\x1b[38;2;${r};${g};${b}m${w}\x1b[0m `;
			} else {
				line += w + " ";
			}
		}
		if (i % 11 === 5 && l === 1) line = CJK + line.slice(CJK.length); // wide chars
		parts.push(line);
	}
	parts.push(""); // trailing newline for the last line
	let chunk = parts.join("\r\n");
	if (i % 4 === 1) {
		// cursor addressing: absolute CUP + relative moves
		const row = 1 + (i % 24);
		const col = 1 + ((i * 3) % 80);
		chunk += `\x1b[${row};${col}H\x1b[${i % 3}A\x1b[${(i % 5) + 1}C`;
	}
	if (i % 13 === 0) chunk = "\x1b[?2004h" + chunk + "\x1b[?2004l"; // bracketed paste toggle
	return chunk;
}

/** Nearest-rank percentile of a latency sample array (ms). */
function percentile(samples, p) {
	const sorted = [...samples].sort((a, b) => a - b);
	const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[idx];
}

const FEED_P95_LIMIT = 5;
const FEED_P99_LIMIT = 8;
const CAPTURE_LIMIT = 50;
const HYDRATE_LIMIT = 100;

// Perf assertions are opt-in (issue #121): they only measure via
// `npm run test:perf`. Under the default/parallel/coverage suites they skip —
// c8 instrumentation inflates latency ~2.5–6× and parallel contention is
// noise, so measuring there would decide CI on runner busy-ness, not code.
const GATE = perfGateDecision(process.env);
const PERF_SKIP = { skip: GATE.run ? false : GATE.reason };

test("A11: 750-chunk burst (60s × 12.5fps equivalent) meets feed/capture/hydrate thresholds", PERF_SKIP, async () => {
	const model = createTerminalModel({ cols: 80, rows: 24, scrollback: 2000 });
	const feedLatencies = [];
	let lastSeq = 0;

	// Back-to-back burst: feed chunk, await parser idle, measure round-trip.
	const burstStart = performance.now();
	for (let i = 0; i < 750; i++) {
		const data = makeChunk(i);
		const t0 = performance.now();
		lastSeq = feedOutput(model, data);
		await whenIdle(model);
		feedLatencies.push(performance.now() - t0);
	}
	const burstWall = performance.now() - burstStart;

	assert.equal(lastSeq, 750, "every chunk gets a strictly increasing seq");
	const p50 = percentile(feedLatencies, 50);
	const p95 = percentile(feedLatencies, 95);
	const p99 = percentile(feedLatencies, 99);
	console.log(`  burst: 750 chunks in ${burstWall.toFixed(0)}ms | feed p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms`);

	assert.ok(p95 <= FEED_P95_LIMIT, `feed p95 ${p95.toFixed(3)}ms exceeds ${FEED_P95_LIMIT}ms`);
	assert.ok(p99 <= FEED_P99_LIMIT, `feed p99 ${p99.toFixed(3)}ms exceeds ${FEED_P99_LIMIT}ms`);

	// End-state precondition: the stream must have scrolled well past the
	// viewport + 256-line capture cap so the capture claim is the real one.
	await whenIdle(model);
	const capStart = performance.now();
	const dto = await captureTerminalSnapshot(model);
	const captureMs = performance.now() - capStart;
	assert.equal(dto.snapshotSeq, 750);
	assert.equal(dto.cols, 80);
	assert.equal(dto.rows, 24);
	assert.equal(
		dto.scrollback.length,
		256,
		"precondition: end-state must saturate the scrollback capture cap",
	);
	console.log(`  capture (80×24 + 256sb): ${captureMs.toFixed(2)}ms`);

	const hydrateStart = performance.now();
	const hydrated = await hydrateTerminalSnapshot(dto);
	const hydrateMs = performance.now() - hydrateStart;
	console.log(`  hydrate: ${hydrateMs.toFixed(2)}ms`);

	// Numbers are only meaningful if the end-state round-trip is still correct.
	assertSnapshotEquivalence(model, hydrated);

	assert.ok(captureMs <= CAPTURE_LIMIT, `capture ${captureMs.toFixed(2)}ms exceeds ${CAPTURE_LIMIT}ms`);
	assert.ok(hydrateMs <= HYDRATE_LIMIT, `hydrate ${hydrateMs.toFixed(2)}ms exceeds ${HYDRATE_LIMIT}ms`);
});

test("A11: paced stream (80ms interval, ~5s wall) stays within thresholds", PERF_SKIP, async () => {
	const model = createTerminalModel({ cols: 80, rows: 24, scrollback: 2000 });
	const feedLatencies = [];
	const ticks = 60; // ~4.8s at 80ms
	let tick = 0;
	await new Promise((resolve) => {
		const timer = setInterval(async () => {
			const data = makeChunk(tick);
			const t0 = performance.now();
			feedOutput(model, data);
			await whenIdle(model);
			feedLatencies.push(performance.now() - t0);
			tick += 1;
			if (tick >= ticks) {
				clearInterval(timer);
				resolve(undefined);
			}
		}, 80);
	});

	const p95 = percentile(feedLatencies, 95);
	const p99 = percentile(feedLatencies, 99);
	console.log(`  paced: ${ticks} ticks × 80ms | feed p50=${percentile(feedLatencies, 50).toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms`);
	assert.ok(p95 <= FEED_P95_LIMIT, `paced feed p95 ${p95.toFixed(3)}ms exceeds ${FEED_P95_LIMIT}ms`);
	assert.ok(p99 <= FEED_P99_LIMIT, `paced feed p99 ${p99.toFixed(3)}ms exceeds ${FEED_P99_LIMIT}ms`);
});

test("A11: ring overflow mid-stream degrades to resnapshot, never silent loss", PERF_SKIP, async () => {
	// Tiny ring: overflow is guaranteed mid-stream.
	const model = createTerminalModel({ cols: 80, rows: 24, scrollback: 2000, ringChunkCap: 8, ringByteCap: 16 * 1024 });
	for (let i = 0; i < 200; i++) {
		feedOutput(model, makeChunk(i));
	}
	await whenIdle(model);

	// Overflow happened and is tracked, not silent.
	assert.ok(model.evictedThrough > 0, "stream past caps must evict");
	assert.equal(model.lastSeq, 200);
	const after = ringChunksAfter(model, 0);
	assert.equal(after.evicted, true, "pre-overflow cursors must be reported as evicted");
	assert.ok(after.evictedThrough > 0);

	// Protocol layer: a subscriber presenting the evicted cursor gets the
	// fresh-snapshot path with the resnapshot marker (never a stitched tail).
	const messages = [];
	const subscription = createTerminalSubscription({ model, send: (m) => messages.push(m) });
	assert.equal(subscription.handleMessage({ type: "subscribe_terminal", sinceSeq: 0 }), true);
	await whenIdle(model);
	await new Promise((r) => setImmediate(r));

	const begin = messages.find((m) => m.type === "snapshot_begin");
	assert.ok(begin, "snapshot_begin sent");
	assert.equal(begin.resnapshot, true, "evicted cursor must be marked resnapshot");
	assert.equal(begin.empty, undefined, "non-empty model must carry a frame");
	const frame = messages.find((m) => m.type === "snapshot_frame");
	assert.ok(frame && typeof frame.data === "string" && frame.data.length > 0, "snapshot_frame carries redraw bytes");
	const end = messages.find((m) => m.type === "snapshot_end");
	assert.ok(end, "snapshot_end sent");
	assert.ok(!messages.some((m) => m.type === "resnapshot_required"), "evicted cursor takes the begin/end path, not the in-flight redo path");

	// No silent loss: the fresh snapshot fully describes the end state —
	// hydrate it and compare against the model.
	const dto = await captureTerminalSnapshot(model);
	const hydrated = await hydrateTerminalSnapshot(dto);
	assertSnapshotEquivalence(model, hydrated);
});
