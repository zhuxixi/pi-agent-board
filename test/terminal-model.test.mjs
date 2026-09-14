import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createTerminalModel,
	defaultParserFactory,
	feedOutput,
	resizeTerminalModel,
	ringChunksAfter,
	whenIdle,
} from "../src/core/terminal-model.mjs";

/**
 * Fake parser with controllable callback timing: synchronous by default,
 * async when `deferTicks > 0` (callback fires after that many microtask/setImmediate
 * turns). Records every write to assert exact byte order.
 */
function fakeParserFactory({ deferTicks = 0 } = {}) {
	const writes = [];
	let pending = 0;
	let idleWaiters = [];
	const parser = {
		writes,
		write(data, cb) {
			writes.push(data);
			pending += 1;
			const fire = () => {
				pending -= 1;
				if (pending === 0) {
					const waiters = idleWaiters;
					idleWaiters = [];
					for (const w of waiters) w();
				}
				cb();
			};
			if (deferTicks === 0) fire();
			else setImmediate(() => setImmediate(fire));
		},
		isBusy: () => pending > 0,
		onIdle: (cb) => {
			if (pending === 0) cb();
			else idleWaiters.push(cb);
		},
	};
	const factory = () => parser;
	factory.parser = parser;
	return factory;
}

function byteLengthOf(chunks) {
	return chunks.reduce((sum, c) => sum + Buffer.byteLength(c.data, "utf8"), 0);
}

test("feedOutput assigns strictly increasing seq from 1", () => {
	const model = createTerminalModel({ parserFactory: fakeParserFactory() });
	assert.equal(model.lastSeq, 0);
	assert.equal(feedOutput(model, "a"), 1);
	assert.equal(feedOutput(model, "b"), 2);
	assert.equal(feedOutput(model, "c"), 3);
	assert.equal(model.lastSeq, 3);
	const result = ringChunksAfter(model, 0);
	assert.equal(result.evicted, false);
	assert.deepEqual(
		result.chunks.map((c) => c.seq),
		[1, 2, 3],
	);
});

test("ring preserves exact chunk boundaries and byte order across split escape sequences", async () => {
	const factory = fakeParserFactory();
	const model = createTerminalModel({ parserFactory: factory });
	// CSI split across three chunks, OSC split across two.
	const chunks = ["\x1b[3", "1", "mRED\x1b[0m", "\x1b]0;ti", "tle\x07ok"];
	for (const chunk of chunks) feedOutput(model, chunk);
	await whenIdle(model);
	// Ring retains the exact original chunk bytes in order (a snapshot cursor +
	// replay must reproduce the stream byte-exactly, not a merged version).
	const result = ringChunksAfter(model, 0);
	assert.deepEqual(
		result.chunks.map((c) => c.data),
		chunks,
	);
	// The parser received every chunk verbatim, in feed order.
	assert.deepEqual(factory.parser.writes, chunks);
});

test("whenIdle resolves only after deferred parser writes complete", async () => {
	const factory = fakeParserFactory({ deferTicks: 2 });
	const model = createTerminalModel({ parserFactory: factory });
	feedOutput(model, "one");
	feedOutput(model, "two");
	assert.equal(factory.parser.isBusy(), true);
	await whenIdle(model);
	assert.equal(factory.parser.isBusy(), false);
	// whenIdle on an idle model resolves immediately.
	await whenIdle(model);
});

test("chunk-cap eviction advances evictedThrough", () => {
	const model = createTerminalModel({ ringChunkCap: 3, parserFactory: fakeParserFactory() });
	for (const data of ["a", "b", "c", "d", "e"]) feedOutput(model, data);
	assert.equal(model.evictedThrough, 2);
	// Querying from before the eviction boundary has a hole → marker (the
	// genesis chunks 1,2 are gone; caller must resnapshot).
	assert.deepEqual(ringChunksAfter(model, 0), { evicted: true, evictedThrough: 2 });
	// Retained chunks are exactly the ones after evictedThrough.
	const result = ringChunksAfter(model, model.evictedThrough);
	assert.equal(result.evicted, false);
	assert.deepEqual(
		result.chunks.map((c) => c.seq),
		[3, 4, 5],
	);
	assert.equal(model.ringBytes, byteLengthOf(result.chunks));
});

test("byte-cap eviction evicts oldest until the ring fits", () => {
	// Each "aaaa" chunk is 4 bytes; cap 10 bytes → at most 2 chunks retained.
	const model = createTerminalModel({ ringByteCap: 10, parserFactory: fakeParserFactory() });
	for (let i = 0; i < 5; i++) feedOutput(model, "aaaa");
	assert.equal(model.evictedThrough, 3);
	assert.deepEqual(ringChunksAfter(model, 0), { evicted: true, evictedThrough: 3 });
	const result = ringChunksAfter(model, model.evictedThrough);
	assert.equal(result.evicted, false);
	assert.deepEqual(
		result.chunks.map((c) => c.seq),
		[4, 5],
	);
	assert.equal(model.ringBytes, 8);
});

test("a single oversized chunk is retained alone; eviction never drops the newest chunk", () => {
	const model = createTerminalModel({ ringByteCap: 4, parserFactory: fakeParserFactory() });
	feedOutput(model, "ab");
	feedOutput(model, "x".repeat(100));
	assert.equal(model.evictedThrough, 1);
	assert.deepEqual(ringChunksAfter(model, 0), { evicted: true, evictedThrough: 1 });
	const result = ringChunksAfter(model, model.evictedThrough);
	assert.equal(result.evicted, false);
	assert.deepEqual(
		result.chunks.map((c) => c.seq),
		[2],
	);
});

test("ringChunksAfter boundary semantics", () => {
	const model = createTerminalModel({ ringChunkCap: 3, parserFactory: fakeParserFactory() });
	for (const data of ["a", "b", "c", "d", "e"]) feedOutput(model, data);
	// evictedThrough = 2, ring = {3,4,5}.

	// Strictly-after semantics: seq=3 yields 4,5 (not 3 itself).
	assert.deepEqual(
		ringChunksAfter(model, 3).chunks.map((c) => c.seq),
		[4, 5],
	);
	// At the last seq: empty but NOT evicted.
	const atHead = ringChunksAfter(model, 5);
	assert.deepEqual(atHead, { evicted: false, chunks: [] });
	// Exactly at evictedThrough: everything needed is still present.
	assert.deepEqual(
		ringChunksAfter(model, 2).chunks.map((c) => c.seq),
		[3, 4, 5],
	);
	// Below evictedThrough: the requested range has a hole → marker.
	const holed = ringChunksAfter(model, 1);
	assert.deepEqual(holed, { evicted: true, evictedThrough: 2 });
});

test("real @xterm/headless parser renders text split across chunk boundaries correctly", async () => {
	const model = createTerminalModel({
		cols: 20,
		rows: 4,
		scrollback: 50,
		parserFactory: defaultParserFactory,
	});
	feedOutput(model, "hello\r\nwor");
	feedOutput(model, "\x1b[31mld\x1b[0m plain");
	await whenIdle(model);
	const buffer = /** @type {any} */ (model.parser).buffer.active;
	const rowText = (y) => {
		let s = "";
		for (let x = 0; x < model.cols; x++) s += buffer.getLine(buffer.baseY + y).getCell(x).getChars() || " ";
		return s;
	};
	assert.equal(rowText(0), "hello               ");
	assert.equal(rowText(1), "world plain         ");
	// "ld" picked up the red SGR from the first (split) chunk.
	const redCell = buffer.getLine(buffer.baseY + 1).getCell(4);
	assert.equal(redCell.getChars(), "d");
	assert.equal(redCell.isFgPalette(), true);
	assert.equal(redCell.getFgColor(), 1);
});

test("resizeTerminalModel updates dimensions and parser", async () => {
	const model = createTerminalModel({
		cols: 20,
		rows: 4,
		scrollback: 50,
		parserFactory: defaultParserFactory,
	});
	feedOutput(model, "resize me");
	await whenIdle(model);
	resizeTerminalModel(model, 30, 6);
	assert.equal(model.cols, 30);
	assert.equal(model.rows, 6);
	feedOutput(model, "\x1b[6;30HX");
	await whenIdle(model);
	const buffer = /** @type {any} */ (model.parser).buffer.active;
	// CUP landed on the resized grid: X written at row 6, col 30 (0-based 5,29).
	const cell = buffer.getLine(buffer.baseY + 5).getCell(29);
	assert.equal(cell.getChars(), "X");
	assert.equal(buffer.cursorY, 5);
});
