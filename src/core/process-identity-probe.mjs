/**
 * Cross-platform process identity probe (issue #217).
 *
 * Produces the two corroborating signals — process creation time and command
 * line — that `classifyUnverifiableProcess` judges when a recorded start token
 * is missing (Windows, or Linux without `/proc` access). Pure parsers are
 * exported for exhaustive unit tests; `readProcessIdentityProbe` is the only
 * I/O layer (one async `execFile` per pid, never throwing).
 *
 * Linux is deliberately unsupported: the existing `/proc` start token already
 * identifies processes there, so probing would only add latency.
 */
import { execFile } from "node:child_process";

/** Hard cap on one probe: a hung PowerShell/ps must not stall recovery. */
export const PROBE_TIMEOUT_MS = 3_000;

/** Cap on captured stdout — a command line is small; anything larger is junk. */
const PROBE_MAX_BUFFER = 64 * 1024;

/**
 * Format an absolute creation time as the comparable `ct:` identity token
 * (issue #238): two reads of the same process yield the same token regardless
 * of when they happen. Only positive safe integers format — anything else
 * (missing creation time, a fractional or out-of-range value, a coerced
 * string) would produce a token that can never match a recorded one.
 * @param {number} creationTimeMs
 * @returns {string|null}
 */
export function creationTimeToken(creationTimeMs) {
	if (!Number.isSafeInteger(creationTimeMs) || creationTimeMs <= 0) return null;
	return `ct:${creationTimeMs}`;
}

/**
 * Parse an epoch-milliseconds value from CIM JSON output. Accepts decimal
 * digits only: PowerShell can hand back an empty string or a negative number
 * for protected processes, neither of which is a usable creation time.
 * @param {string} text
 * @returns {number|null}
 */
export function parseUnixMillis(text) {
	const trimmed = String(text ?? "").trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const millis = Number(trimmed);
	return Number.isSafeInteger(millis) && millis > 0 ? millis : null;
}

/**
 * Parse the compressed CIM object emitted for a Windows process:
 * `{"creation":<unix ms>|null,"cmd":"<command line>"|null}`. Malformed JSON or
 * a non-object payload yields `null` (the judgment layer reads that as
 * `unknown`, which is always safe).
 * @param {string} text
 * @returns {{creationTimeMs:number|null, commandLine:string|null}|null}
 */
export function parseProbeJson(text) {
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	if (!trimmed) return null;
	/** @type {any} */ let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return {
		creationTimeMs: parseUnixMillis(parsed.creation),
		commandLine: typeof parsed.cmd === "string" && parsed.cmd.trim() ? parsed.cmd : null,
	};
}

/** `[DD-]HH:MM:SS` (ps drops leading units it does not need). */
const PS_ELAPSED_PATTERN = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/;

/**
 * Parse a POSIX `ps` elapsed-time field into milliseconds. Handles the three
 * shapes `ps -o etime=` emits: `MM:SS`, `HH:MM:SS`, and `D-HH:MM:SS`.
 * @param {string} text
 * @returns {number|null}
 */
export function parsePsElapsedMs(text) {
	const match = PS_ELAPSED_PATTERN.exec(String(text ?? "").trim());
	if (!match) return null;
	const days = match[1] == null ? 0 : Number(match[1]);
	const hours = match[2] == null ? 0 : Number(match[2]);
	const minutes = Number(match[3]);
	const seconds = Number(match[4]);
	if (minutes > 59 || seconds > 59) return null;
	return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Parse one `ps -p <pid> -o etime=,command=` line: the first whitespace-
 * separated token is the elapsed time, everything after it is the command.
 * `ps` reports age, not creation time, so callers pass the clock reading.
 * @param {string} text
 * @param {number} nowMs Epoch ms at which the probe output was read.
 * @returns {{creationTimeMs:number|null, commandLine:string|null}|null}
 */
export function parsePsProbeLine(text, nowMs) {
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	if (!trimmed) return null;
	const split = trimmed.search(/\s/);
	const elapsedText = split === -1 ? trimmed : trimmed.slice(0, split);
	const commandLine = split === -1 ? "" : trimmed.slice(split).trim();
	const elapsedMs = parsePsElapsedMs(elapsedText);
	if (elapsedMs == null) return null;
	return {
		creationTimeMs: nowMs - elapsedMs,
		commandLine: commandLine || null,
	};
}

/**
 * Windows CIM query: one round trip returns creation time (converted to Unix
 * milliseconds in PowerShell so the parent needs no date parsing) and the
 * command line. `-ErrorAction SilentlyContinue` keeps a vanished pid from
 * turning into a non-zero exit; the empty result is handled as "unavailable".
 * @param {number} pid
 * @returns {string}
 */
function windowsProbeScript(pid) {
	return "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\" -ErrorAction SilentlyContinue; "
		+ "if ($p) { [pscustomobject]@{creation=[long]([datetimeoffset]$p.CreationDate).ToUnixTimeMilliseconds(); cmd=$p.CommandLine} | ConvertTo-Json -Compress }";
}

/**
 * Resolve the platform-specific probe command. Platforms without a probe
 * (`linux` and everything else) and invalid pids return `null`, so callers
 * never spawn anything for them.
 * @param {string} platform
 * @param {number} pid
 * @returns {{command:string, args:string[]}|null}
 */
export function resolveProbeCommand(platform, pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	if (platform === "win32") {
		return {
			command: "powershell.exe",
			args: ["-NoProfile", "-NonInteractive", "-Command", windowsProbeScript(pid)],
		};
	}
	if (platform === "darwin") {
		return { command: "ps", args: ["-p", String(pid), "-o", "etime=,command="] };
	}
	return null;
}

/**
 * Read `{ creationTimeMs, commandLine }` for `pid`, or `null` when the process
 * cannot be observed (unsupported platform, invalid pid, non-zero exit,
 * timeout, or empty output). `null` means "unverifiable", never "foreign".
 *
 * `execFileFn` is injectable for tests; the default is Node's async
 * `execFile`. `windowsHide` mirrors `launchRun`'s detached spawn (issue #49):
 * without it a console window flashes on Windows 11 25H2.
 *
 * @param {number} pid
 * @param {{ platform?: string, execFileFn?: typeof execFile, timeoutMs?: number, nowMs?: () => number }} [opts]
 * @returns {Promise<{creationTimeMs:number|null, commandLine:string|null}|null>}
 */
export async function readProcessIdentityProbe(pid, {
	platform = process.platform,
	execFileFn = execFile,
	timeoutMs = PROBE_TIMEOUT_MS,
	nowMs = Date.now,
} = {}) {
	const resolved = resolveProbeCommand(platform, pid);
	if (!resolved) return null;
	return new Promise((resolve) => {
		execFileFn(resolved.command, resolved.args, { timeout: timeoutMs, windowsHide: true, maxBuffer: PROBE_MAX_BUFFER }, (error, stdout) => {
			if (error) {
				resolve(null);
				return;
			}
			const text = String(stdout ?? "").trim();
			if (!text) {
				resolve(null);
				return;
			}
			resolve(platform === "win32" ? parseProbeJson(text) : parsePsProbeLine(text, nowMs()));
		});
	});
}
