/**
 * Durable command journal for the View State Coordinator (issue #91, spec D3).
 *
 * Write order contract: the coordinator appends a command record here and
 * fsyncs BEFORE materializing state.json/status.json, so a crash between the
 * two can be repaired by replaying the journal on restart. The checkpoint
 * records how much of the journal (`journalBytes`) is already reflected in
 * materialized state; GC may only drop that prefix after the checkpoint write
 * itself succeeded. Full-coverage GC truncates the journal to empty: the
 * covered commands leave the journal, so post-GC idempotency dedupe is owned
 * by the coordinator's in-memory ring of recent commandIds (older commandIds
 * fall back to current-state re-decision, whose apply paths are idempotent).
 * `screen.log`'s fs-injection and temp+rename patterns are
 * reused so every fs call is injectable in tests.
 */
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const JOURNAL_FILE_NAME = "state-journal.jsonl";
export const CHECKPOINT_FILE_NAME = "state-journal.checkpoint.json";

export const defaultJournalFs = Object.freeze({
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
});

/** @param {string} root @returns {string} */
export function journalPath(root) {
	return join(root, JOURNAL_FILE_NAME);
}

/** @param {string} root @returns {string} */
export function checkpointPath(root) {
	return join(root, CHECKPOINT_FILE_NAME);
}

/**
 * Append one processed-command record and fsync it before returning.
 * @param {string} root
 * @param {{ command: object, result: { status: string, reason: string|null }, materializedRevision: number, at: number }} record
 * @param {typeof defaultJournalFs} [fs]
 * @returns {number} journal size in bytes after the append (usable as the next
 *   checkpoint's `journalBytes`).
 */
export function appendCommand(root, record, fs = defaultJournalFs) {
	const file = journalPath(root);
	fs.mkdirSync(dirname(file), { recursive: true });
	const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
	let fd;
	try {
		fd = fs.openSync(file, "a");
		let offset = 0;
		while (offset < payload.length) offset += fs.writeSync(fd, payload, offset, payload.length - offset);
		fs.fsyncSync(fd);
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* already closed */ }
		}
	}
	return fileSize(file, 0, fs);
}

/**
 * Read every parseable journal record. A corrupt line (crash mid-append) is
 * skipped — same semantics as atomic.mjs readJsonl, but with injectable fs.
 * @param {string} root
 * @param {typeof defaultJournalFs} [fs]
 * @returns {Array<{ command: object, result: { status: string, reason: string|null }, materializedRevision: number, at: number }>}
 */
export function readJournal(root, fs = defaultJournalFs) {
	const data = readAllBytes(journalPath(root), fs);
	const entries = [];
	for (const line of data.toString("utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			/* skip corrupt line */
		}
	}
	return entries;
}

/**
 * Idempotency lookup: the recorded result of an already-processed commandId,
 * or null. On the (never-intended) duplicate, the FIRST entry is the original.
 * @param {string} root
 * @param {string} commandId
 * @param {typeof defaultJournalFs} [fs]
 * @returns {{ status: string, reason: string|null } | null}
 */
export function findProcessedCommand(root, commandId, fs = defaultJournalFs) {
	for (const entry of readJournal(root, fs)) {
		if (entry?.command?.commandId === commandId) return entry.result ?? null;
	}
	return null;
}

/**
 * @param {string} root
 * @param {typeof defaultJournalFs} [fs]
 * @returns {{ materializedRevision: number, journalBytes: number } | null}
 */
export function readCheckpoint(root, fs = defaultJournalFs) {
	const file = checkpointPath(root);
	if (!fs.existsSync(file)) return null;
	let raw;
	try {
		raw = readAllBytes(file, fs).toString("utf8");
	} catch {
		return null;
	}
	if (!raw.trim()) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Atomically replace the checkpoint (temp file + fsync + rename, screen-log
 * pattern). Callers may only run gcJournal after this returns true.
 * @param {string} root
 * @param {{ materializedRevision: number, journalBytes: number }} checkpoint
 * @param {typeof defaultJournalFs} [fs]
 * @returns {boolean} whether the checkpoint is durably on disk
 */
export function writeCheckpoint(root, checkpoint, fs = defaultJournalFs) {
	const file = checkpointPath(root);
	fs.mkdirSync(dirname(file), { recursive: true });
	return replaceFile(file, Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`, "utf8"), fs);
}

/**
 * Drop the journal prefix already covered by a successful checkpoint. Without
 * a checkpoint this is a no-op (nothing proves the prefix is materialized).
 * A checkpoint covering the whole journal truncates the file to empty — every
 * covered record is materialized, and keeping it would grow the journal (and
 * every findProcessedCommand/boot-replay scan) without bound.
 * @param {string} root
 * @param {typeof defaultJournalFs} [fs]
 * @returns {number} journal size in bytes after the call
 */
export function gcJournal(root, fs = defaultJournalFs) {
	const file = journalPath(root);
	const size = fileSize(file, 0, fs);
	if (size === 0) return 0;
	const checkpoint = readCheckpoint(root, fs);
	if (!checkpoint || typeof checkpoint.journalBytes !== "number") return size;
	const journalBytes = Math.floor(checkpoint.journalBytes);
	if (journalBytes <= 0) return size;
	if (journalBytes >= size) {
		// Full coverage: everything in the file is materialized per the
		// checkpoint. Truncate to empty; dedupe for covered commandIds is the
		// coordinator's in-memory ring's job now.
		if (!replaceFile(file, Buffer.alloc(0), fs)) return fileSize(file, size, fs);
		return 0;
	}
	// journalBytes < size means the file exists with an un-checkpointed tail.
	const tail = readAllBytes(file, fs, journalBytes);
	if (!replaceFile(file, tail, fs)) return fileSize(file, size, fs);
	return fileSize(file, tail.length, fs);
}

/**
 * Truncate a crash-torn journal tail so the next append stays parseable.
 *
 * `appendCommand` writes `JSON+\n` in a partial-write loop; a process killed
 * mid-append leaves bytes without a trailing newline. Without repair, the next
 * append concatenates onto that torn line and the merged line is unparseable — the
 * freshly fsynced+acked record becomes invisible to every readJournal /
 * boot-replay / revision scan. The repair is byte-exact and cheap: scan
 * backwards for the last newline and drop everything after it (a journal with
 * no newline at all is torn from byte 0 and truncates to empty). Complete but
 * corrupt lines are kept — readJournal already skips them.
 * @param {string} root
 * @param {typeof defaultJournalFs} [fs]
 * @returns {number} journal size in bytes after the call
 */
export function repairJournalTail(root, fs = defaultJournalFs) {
	const file = journalPath(root);
	const size = fileSize(file, 0, fs);
	if (size === 0) return 0;
	const data = readAllBytes(file, fs);
	const lastNewline = data.lastIndexOf("\n");
	if (lastNewline === data.length - 1) return size;
	const keep = lastNewline + 1;
	if (!replaceFile(file, data.subarray(0, keep), fs)) return fileSize(file, size, fs);
	return keep;
}

/**
 * Read the file from `position` (default 0) to EOF via injectable readSync.
 * @param {string} file
 * @param {typeof defaultJournalFs} fs
 * @param {number} [position]
 * @returns {Buffer}
 */
function readAllBytes(file, fs, position = 0) {
	if (!fs.existsSync(file)) return Buffer.alloc(0);
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const size = Math.max(0, fs.fstatSync(fd).size - position);
		if (size === 0) return Buffer.alloc(0);
		const output = Buffer.allocUnsafe(size);
		let offset = 0;
		while (offset < size) {
			const read = fs.readSync(fd, output, offset, size - offset, position + offset);
			if (read === 0) break;
			offset += read;
		}
		return offset === size ? output : output.subarray(0, offset);
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* already closed */ }
		}
	}
}

/**
 * Temp file + fsync + rename replacement (screen-log replaceScreenLog pattern).
 * @param {string} file
 * @param {Buffer} data
 * @param {typeof defaultJournalFs} fs
 * @returns {boolean}
 */
function replaceFile(file, data, fs) {
	const temp = `${file}.${process.pid}.${tempSequence++}.tmp`;
	let fd;
	try {
		fs.mkdirSync(dirname(file), { recursive: true });
		fd = fs.openSync(temp, "w");
		let offset = 0;
		while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset, offset);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temp, file);
		return true;
	} catch {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* already closed */ }
		}
		try { fs.unlinkSync(temp); } catch { /* best effort */ }
		return false;
	}
}

/** @param {string} file @param {number} fallback @param {typeof defaultJournalFs} fs */
function fileSize(file, fallback, fs) {
	try {
		return fs.statSync(file).size;
	} catch {
		return fallback;
	}
}

let tempSequence = 0;
