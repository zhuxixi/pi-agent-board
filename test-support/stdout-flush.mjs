/**
 * Write `text` to `stream`, then call `exit(code)` once the write has drained.
 *
 * A bare `stream.write(text); exit(code)` tears the process down while the
 * kernel pipe still holds a partial payload: everything past the 64 KiB pipe
 * buffer is lost and the exit code still says 0. Issue #270 hit this with a
 * ~143 KB battery result truncated at exactly 65536 bytes, which turned every
 * PR's CI red while passing locally.
 *
 * `stream` and `exit` are injected so the three paths — flushed, broken pipe,
 * synchronous write error — are unit-testable without spawning a child. Only
 * statement-adjacent `process.stdout.write(...)` followed by `process.exit(...)`
 * is guarded; a write inside `try` with the exit in `finally` is out of scope, as
 * are a write separated from the exit by other statements (`write(x);
 * cleanup(); exit(0)`) and deferred or aliased exits (`write(x);
 * setTimeout(() => process.exit(0))`, `const out = process.stdout; out.write(x);
 * process.exit(0)`).
 *
 * @param {import("node:stream").Writable} stream
 * @param {string} text
 * @param {number} code exit status the caller already decided on
 * @param {(code: number) => void} exit
 */
export function writeThenExit(stream, text, code, exit) {
	let settled = false;
	const finish = () => {
		if (settled) return;
		settled = true;
		exit(code);
	};
	stream.once("error", finish);
	try {
		stream.write(text, finish);
	} catch {
		finish();
	}
}

/**
 * Bind {@link writeThenExit} to the real process. Use this instead of
 * `process.stdout.write(...); process.exit(...)` in every test-support harness.
 *
 * @param {string} text
 * @param {number} [code]
 */
export function exitAfterStdout(text, code = 0) {
	writeThenExit(process.stdout, text, code, (status) => process.exit(status));
}
