/**
 * Atomic + crash-tolerant file helpers used across the extension and the runner.
 *
 * Writes go to a temp sibling then `rename()` (atomic on the same filesystem) so a
 * reader never observes a half-written JSON file. Reads tolerate missing/corrupt files.
 */
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

/** Retry backoff (ms) for rename retries; index i is the delay after attempt i. */
export const RENAME_RETRY_BACKOFF_MS = [10, 50, 250];
/** Error codes that mean "transient sharing violation" — retryable on Windows. */
export const RENAME_RETRY_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** @param {string} dir */
export function ensureDir(dir) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * rename() with retries for Windows sharing-violation races.
 *
 * On Windows, libuv opens files without FILE_SHARE_DELETE, so replacing an
 * existing target while any other process holds it open for reading throws
 * EPERM/EBUSY/EACCES. The reader window is microseconds, so a few retries
 * with a short backoff succeed almost always. Non-whitelisted errors
 * (e.g. EISDIR) are configuration errors and throw immediately.
 * @param {string} tmp
 * @param {string} file
 * @param {{ rename?: (a: string, b: string) => void, delays?: number[], errorCodes?: Set<string> }} [opts]
 */
export function renameWithRetry(tmp, file, opts = {}) {
	const rename = opts.rename ?? renameSync;
	const delays = opts.delays ?? RENAME_RETRY_BACKOFF_MS;
	const errorCodes = opts.errorCodes ?? RENAME_RETRY_ERROR_CODES;
	for (let attempt = 0; ; attempt++) {
		try {
			rename(tmp, file);
			return;
		} catch (err) {
			const code = /** @type {NodeJS.ErrnoException} */ (err).code;
			if (!errorCodes.has(code) || attempt >= delays.length) {
				// Exhausted or non-transient: leave no .tmp litter behind, then
				// surface the original error so callers can degrade deliberately.
				try { unlinkSync(tmp); } catch { /* best effort */ }
				throw err;
			}
		}
		// Synchronous sleep (Atomics.wait) — atomicWrite is a sync API.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
	}
}

/**
 * Atomically write a string to `file` (creates parent dirs).
 * @param {string} file
 * @param {string} data
 */
export function atomicWrite(file, data) {
	ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, data, "utf8");
	renameWithRetry(tmp, file);
}

/**
 * Atomically write a value as pretty JSON.
 * @param {string} file
 * @param {unknown} value
 */
export function atomicWriteJson(file, value) {
	atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read and parse JSON, returning `fallback` when the file is missing or unparseable.
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(file, fallback) {
	try {
		if (!existsSync(file)) return fallback;
		const raw = readFileSync(file, "utf8");
		if (!raw.trim()) return fallback;
		return /** @type {T} */ (JSON.parse(raw));
	} catch {
		return fallback;
	}
}

/**
 * Append one line (a trailing newline is added) to a log/jsonl file.
 * @param {string} file
 * @param {string} line
 */
export function appendLine(file, line) {
	ensureDir(path.dirname(file));
	appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`, "utf8");
}

/**
 * Append one JSON value as a JSONL record.
 * @param {string} file
 * @param {unknown} value
 */
export function appendJsonl(file, value) {
	appendLine(file, JSON.stringify(value));
}

/**
 * Read a JSONL file into parsed objects, skipping blank/corrupt lines.
 * @param {string} file
 * @returns {any[]}
 */
export function readJsonl(file) {
	try {
		if (!existsSync(file)) return [];
		const out = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				out.push(JSON.parse(t));
			} catch {
				/* skip corrupt line */
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Read the newest `limit` JSONL records. Corrupt lines are skipped.
 * @param {string} file
 * @param {number} [limit]
 * @returns {any[]}
 */
export function readJsonlTail(file, limit = 50) {
	const all = readJsonl(file);
	const n = Math.max(0, Math.floor(Number(limit) || 0));
	return n > 0 ? all.slice(-n) : all;
}

/**
 * Best-effort delete helper used by cleanup actions.
 * @param {string} file
 * @returns {boolean}
 */
export function removeFile(file) {
	try {
		if (!existsSync(file)) return false;
		unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read a file's text, returning `fallback` if missing.
 * @param {string} file
 * @param {string} [fallback]
 * @returns {string}
 */
export function readText(file, fallback = "") {
	try {
		return existsSync(file) ? readFileSync(file, "utf8") : fallback;
	} catch {
		return fallback;
	}
}
