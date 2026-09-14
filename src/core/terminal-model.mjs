import xtermHeadless from "@xterm/headless";

// @xterm/headless is CommonJS; named import from ESM fails, so destructure.
const { Terminal } = /** @type {any} */ (xtermHeadless);

/**
 * Canonical terminal model for one hosted view (issue #91, D2/D5).
 *
 * The PTY runner owns one model per host: every child output chunk is assigned a
 * strictly increasing `outputSeq`, fed to a real terminal state machine
 * (@xterm/headless by default), and retained in a bounded in-memory ring so a
 * late subscriber can replay chunks after a snapshot cursor. This module is the
 * pure-ish core: no fs, no sockets — the runner wires it into `child.onData`.
 *
 * The canonical state lives for the runner's lifetime only; it is never
 * persisted across runner restarts (runner death kills the child; a new child
 * establishes a fresh baseline).
 */

/** Default ring retention: chunk count cap. */
export const DEFAULT_RING_CHUNK_CAP = 2048;
/** Default ring retention: total buffered bytes cap (4 MiB). */
export const DEFAULT_RING_BYTE_CAP = 4 * 1024 * 1024;

/**
 * Default parser factory. `write(data, cb)` callbacks are supported by
 * @xterm/headless v6 and fire after the chunk is fully parsed, which makes
 * `whenIdle` deterministic without polling.
 *
 * @param {{ cols: number, rows: number, scrollback: number }} opts
 */
export function defaultParserFactory({ cols, rows, scrollback }) {
	return new Terminal({ cols, rows, scrollback, allowProposedApi: true });
}

/**
 * @typedef {{
 *   seq: number,
 *   data: string,
 * }} RingChunk
 */

/**
 * @typedef {object} TerminalModel
 * @property {(opts: { cols: number, rows: number, scrollback: number }) => unknown} parserFactory
 * @property {unknown} parser injected terminal state machine
 * @property {number} cols
 * @property {number} rows
 * @property {number} scrollback
 * @property {number} ringChunkCap
 * @property {number} ringByteCap
 * @property {number} lastSeq seq of the last fed chunk; 0 before the first chunk
 * @property {number} pendingWrites in-flight parser writes (write called, callback not yet fired)
 * @property {Array<() => void>} idleWaiters
 * @property {RingChunk[]} ring oldest-first retained chunks
 * @property {number} ringBytes total buffered bytes across ring chunks
 * @property {number} evictedThrough highest seq evicted from the ring; 0 when nothing was evicted
 */

/**
 * Create a canonical terminal model. The parser factory is injectable so tests
 * can drive seq/ring logic with a deterministic fake and render tests can use
 * the real @xterm/headless parser.
 *
 * @param {{
 *   cols?: number,
 *   rows?: number,
 *   scrollback?: number,
 *   ringChunkCap?: number,
 *   ringByteCap?: number,
 *   parserFactory?: typeof defaultParserFactory,
 * }} [opts]
 * @returns {TerminalModel}
 */
export function createTerminalModel({
	cols = 80,
	rows = 24,
	scrollback = 2000,
	ringChunkCap = DEFAULT_RING_CHUNK_CAP,
	ringByteCap = DEFAULT_RING_BYTE_CAP,
	parserFactory = defaultParserFactory,
} = {}) {
	return {
		parserFactory,
		parser: parserFactory({ cols, rows, scrollback }),
		cols,
		rows,
		scrollback,
		ringChunkCap,
		ringByteCap,
		lastSeq: 0,
		pendingWrites: 0,
		idleWaiters: [],
		ring: [],
		ringBytes: 0,
		evictedThrough: 0,
	};
}

/**
 * Feed one child output chunk: assign the next seq, append to the ring (with
 * eviction), and hand the exact bytes to the parser in feed order. Escape
 * sequences split across chunk boundaries stay correct because every chunk is
 * forwarded to the parser verbatim, in order.
 *
 * Fire-and-forget by design; callers that need the parse result await
 * `whenIdle(model)` first (e.g. before capturing a snapshot).
 *
 * @param {TerminalModel} model
 * @param {string} data
 * @returns {number} the seq assigned to this chunk
 */
export function feedOutput(model, data) {
	const seq = model.lastSeq + 1;
	model.lastSeq = seq;
	appendRing(model, { seq, data });
	// Increment before write so a synchronously-firing callback still observes
	// consistent accounting.
	model.pendingWrites += 1;
	model.parser.write(data, () => {
		model.pendingWrites -= 1;
		if (model.pendingWrites === 0 && model.idleWaiters.length > 0) {
			const waiters = model.idleWaiters;
			model.idleWaiters = [];
			for (const resolve of waiters) resolve();
		}
	});
	return seq;
}

/**
 * Evict-then-append retention: trim oldest chunks until both caps hold. The
 * newest chunk is never evicted by its own append (a single oversized chunk
 * alone in the ring is allowed; subscribers needing anything before it get a
 * fresh snapshot instead of a stitched tail).
 *
 * @param {TerminalModel} model
 * @param {RingChunk} chunk
 */
function appendRing(model, chunk) {
	model.ring.push(chunk);
	model.ringBytes += Buffer.byteLength(chunk.data, "utf8");
	while (
		model.ring.length > 1 &&
		(model.ring.length > model.ringChunkCap || model.ringBytes > model.ringByteCap)
	) {
		const evicted = model.ring.shift();
		model.ringBytes -= Buffer.byteLength(evicted.data, "utf8");
		model.evictedThrough = evicted.seq;
	}
}

/**
 * Resolve once every chunk fed so far has been fully parsed. Deterministic:
 * backed by parser write callbacks (no timing-based polling). Safe to call
 * repeatedly and concurrently; waiters are released in registration order.
 *
 * @param {TerminalModel} model
 * @returns {Promise<void>}
 */
export function whenIdle(model) {
	if (model.pendingWrites === 0) return Promise.resolve();
	return new Promise((resolve) => {
		model.idleWaiters.push(resolve);
	});
}

/**
 * Chunks strictly after `seq`, or an eviction marker when part of the requested
 * range `(seq, ...]` is no longer retained. Callers must treat `evicted: true`
 * as "fresh snapshot required" — never stitch from a partial tail.
 *
 * @param {TerminalModel} model
 * @param {number} seq cursor to read from (e.g. a snapshot's snapshotSeq)
 * @returns {{ evicted: false, chunks: RingChunk[] } | { evicted: true, evictedThrough: number }}
 */
export function ringChunksAfter(model, seq) {
	if (seq < model.evictedThrough) {
		return { evicted: true, evictedThrough: model.evictedThrough };
	}
	const chunks = [];
	for (const chunk of model.ring) {
		if (chunk.seq > seq) chunks.push(chunk);
	}
	return { evicted: false, chunks };
}

/**
 * Resize the model and its parser (reflow is the parser's job). Cols/rows on
 * the model are the authoritative post-resize dimensions for snapshot metadata.
 *
 * @param {TerminalModel} model
 * @param {number} cols
 * @param {number} rows
 */
export function resizeTerminalModel(model, cols, rows) {
	model.cols = cols;
	model.rows = rows;
	const parser = /** @type {{ resize: (c: number, r: number) => void }} */ (model.parser);
	parser.resize(cols, rows);
}
