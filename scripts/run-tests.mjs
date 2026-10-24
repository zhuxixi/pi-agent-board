#!/usr/bin/env node
/**
 * Suite gate for issue #241: run every test file through `node --test` and fail
 * the run when a detached state-coordinator leaked past the test process.
 *
 * Why this exists: every coordinator integration test creates a throwaway board
 * root under the OS temp dir and spawns a detached coordinator. A coordinator
 * that fails to step down stays alive forever and pins its root, so leaks
 * accumulate on a developer box instead of showing up as a test failure.
 *
 * Design (spec §3.3):
 * - Snapshot the matching coordinators BEFORE the run. Pre-existing ones are
 *   warn-only: they are not this run's fault and are never killed.
 * - After the run, poll up to GRACE_MS for every coordinator above the snapshot
 *   to be gone (the 1 s self-exit window plus load slack).
 * - Survivors: print pid + root, SIGTERM, wait 2 s, SIGKILL leftovers, exit 1.
 * - A test run killed by a signal (`exitCode === null`) is never a success.
 * - Enumeration unavailable: warn and skip the residue check (fail-open). A
 *   missing `pwsh`/`powershell`/`ps` must not turn into a red suite.
 *
 * Selection is deliberately narrow: the command line must contain THIS
 * checkout's absolute `runner/state-coordinator.mjs` and its root argument must
 * resolve under `os.tmpdir()`. Another checkout's test coordinator never
 * matches (its script path differs), and a default production board
 * (`~/.pi/agent/agent-board`) never matches either. Accepted limit (spec §7): a
 * board whose `AGENT_BOARD_ROOT` points under `os.tmpdir()` and whose runner is
 * this checkout is indistinguishable from a test coordinator, so the gate would
 * kill that live board.
 *
 * Known limit (final-review m7): POSIX selection is token-based and `ps` output
 * is unquoted, so a checkout path containing spaces splits and its coordinators
 * are not selected (the gate silently no-ops instead of failing). win32 CIM
 * output quotes paths with spaces, so the tokenizer handles it there.
 *
 * This module must stay import-side-effect free: `test/run-tests-wrapper.test.mjs`
 * imports the pure functions and `runSuite`, and a spurious `main()` at import
 * time would recursively start the whole suite. Only the entry-point guard at
 * the bottom of this file may call `main()`.
 */
import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The only coordinator script this checkout's suite spawns. */
const COORDINATOR_RELATIVE_SCRIPT = "runner/state-coordinator.mjs";
const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_POLL_MS = 100;
/** SIGTERM → SIGKILL pause. On win32 SIGTERM is TerminateProcess; POSIX needs the grace. */
const SIGKILL_DELAY_MS = 2_000;
const SIGTERM = "SIGTERM";
const SIGKILL = "SIGKILL";

/**
 * Normalize a path for comparison without depending on the host platform:
 * forward slashes, dot segments removed, no trailing separator (a `tmpRoot` like
 * `C:\Temp\` or `/tmp/` must select exactly like its un-suffixed form), and (on
 * win32) case-folded. Filesystem roots keep their separator (`/` stays `/`,
 * `C:/` stays `C:/`): stripping it would turn a drive root into the
 * drive-relative `C:`. The platform is explicit so the unit tests can exercise
 * win32 samples on POSIX CI.
 * @param {string} value
 * @param {string} platform
 * @returns {string}
 */
function canonicalPath(value, platform) {
	const text = String(value ?? "").replace(/\\/g, "/");
	if (!text) return "";
	let normalized = posix.normalize(text);
	if (normalized.length > 1 && normalized.endsWith("/")) {
		const trimmed = normalized.replace(/\/+$/, "");
		normalized = trimmed.endsWith(":") ? `${trimmed}/` : trimmed;
	}
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * True when `candidate` is `directory` itself or one of its descendants, using
 * the already-canonical spellings. The trailing-slash check keeps a sibling
 * such as `/tmpfoo` from matching `/tmp`; a filesystem root already ends in the
 * separator, so `${directory}/` would become `//` and match nothing there.
 * @param {string} candidate
 * @param {string} directory
 * @returns {boolean}
 */
function isUnderDirectory(candidate, directory) {
	if (!candidate || !directory) return false;
	if (candidate === directory) return true;
	return candidate.startsWith(directory.endsWith("/") ? directory : `${directory}/`);
}

/**
 * Split a process command line into argv-shaped tokens, honoring the double
 * quotes CIM emits around paths with spaces. Node's own argv never needs
 * backslash-escaped quotes inside a path, so this covers the coordinator shape.
 * @param {string} commandLine
 * @returns {string[]}
 */
function tokenizeCommandLine(commandLine) {
	const tokens = [];
	for (const match of commandLine.matchAll(/"([^"]*)"|(\S+)/g)) tokens.push(match[1] ?? match[2]);
	return tokens;
}

/**
 * Parse the platform's process-enumeration output. Never throws: unparsable
 * output and unparsable lines are skipped.
 * @param {string} raw
 * @param {string} platform
 * @returns {Array<{pid: number, commandLine: string}>}
 */
export function parseProcessList(raw, platform) {
	const text = String(raw ?? "").trim();
	if (!text) return [];
	if (platform === "win32") {
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			return [];
		}
		// ConvertTo-Json emits a single object when exactly one process matches.
		const rows = Array.isArray(data) ? data : [data];
		return rows
			.map((row) => ({ pid: Number(row?.ProcessId ?? 0), commandLine: String(row?.CommandLine ?? "") }))
			.filter((row) => Number.isFinite(row.pid) && row.pid > 0 && row.commandLine);
	}
	const out = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match) out.push({ pid: Number(match[1]), commandLine: match[2] });
	}
	return out;
}

/**
 * Keep only coordinators this checkout's suite could have spawned: the command
 * line runs `<repoRoot>/runner/state-coordinator.mjs` and the token after that
 * script (the root argument, quotes stripped by the tokenizer) resolves under
 * `tmpRoot`. Production roots and other checkouts never match.
 * @param {{
 *   processes?: Array<{pid: number, commandLine: string}>,
 *   repoRoot: string,
 *   tmpRoot: string,
 *   platform: string,
 * }} args
 * @returns {Array<{pid: number, root: string}>} deterministic order by pid
 */
export function selectOrphanCoordinators({ processes, repoRoot, tmpRoot, platform }) {
	const scriptPath = canonicalPath(`${repoRoot}/${COORDINATOR_RELATIVE_SCRIPT}`, platform);
	const tmpPath = canonicalPath(tmpRoot, platform);
	if (!scriptPath || !tmpPath) return [];
	const out = [];
	for (const proc of processes ?? []) {
		const pid = Number(proc?.pid ?? 0);
		if (!Number.isFinite(pid) || pid <= 0) continue;
		const tokens = tokenizeCommandLine(String(proc?.commandLine ?? ""));
		const scriptIndex = tokens.findIndex((token) => canonicalPath(token, platform) === scriptPath);
		if (scriptIndex < 0) continue;
		const root = tokens[scriptIndex + 1];
		if (!root) continue;
		if (!isUnderDirectory(canonicalPath(root, platform), tmpPath)) continue;
		out.push({ pid, root });
	}
	return out.sort((left, right) => left.pid - right.pid);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Orchestrate one suite run and its residue check. Every side effect is
 * injected so the unit tests drive every branch without spawning or killing
 * anything; the real shell lives in `main()`.
 * @param {{
 *   spawnTest: () => Promise<{exitCode: number|null, signal?: string|null}>,
 *   listProcesses: () => Array<{pid: number, commandLine: string}>|Promise<Array<{pid: number, commandLine: string}>>,
 *   kill: (pid: number, signal: string) => void,
 *   sleep: (ms: number) => Promise<void>,
 *   log: (line: string) => void,
 *   repoRoot: string,
 *   tmpRoot: string,
 *   platform: string,
 *   graceMs?: number,
 *   pollMs?: number,
 *   now?: () => number,
 * }} deps
 * @returns {Promise<{exitCode: number, survivors: number[]}>}
 */
export async function runSuite(deps) {
	const {
		spawnTest,
		listProcesses,
		kill,
		sleep,
		log,
		repoRoot,
		tmpRoot,
		platform,
		graceMs = DEFAULT_GRACE_MS,
		pollMs = DEFAULT_POLL_MS,
		now = Date.now,
	} = deps;
	const select = (processes) => selectOrphanCoordinators({ processes, repoRoot, tmpRoot, platform });

	// Snapshot first: pre-existing coordinators predate this run, so they are
	// warned about but never killed and never fail the suite.
	/** @type {Set<number>} */
	const preexisting = new Set();
	let canCheckResidue = true;
	try {
		for (const proc of select(await listProcesses())) preexisting.add(proc.pid);
	} catch (error) {
		canCheckResidue = false;
		log(`run-tests: WARNING: cannot enumerate node processes (${describeError(error)}); skipping the coordinator residue check`);
	}
	if (preexisting.size > 0) {
		log(`run-tests: WARNING: ${preexisting.size} pre-existing state-coordinator process(es) before the run; not killed, not a failure`);
	}

	const run = await spawnTest();

	// Poll for post-run residue. The last successful enumeration is kept when a
	// later poll fails: an already observed survivor still fails the run, while
	// never having enumerated at all stays fail-open.
	/** @type {Array<{pid: number, root: string}>} */
	let survivors = [];
	let residueChecked = false;
	if (canCheckResidue) {
		const deadline = now() + graceMs;
		for (;;) {
			let current;
			try {
				current = select(await listProcesses());
				residueChecked = true;
			} catch (error) {
				canCheckResidue = false;
				log(`run-tests: WARNING: cannot enumerate node processes (${describeError(error)}); skipping the coordinator residue check`);
				break;
			}
			survivors = current.filter((proc) => !preexisting.has(proc.pid));
			if (survivors.length === 0) break;
			if (now() >= deadline) break;
			await sleep(pollMs);
		}
	}

	/** @type {number[]} */
	const survivorPids = [];
	if (survivors.length > 0) {
		for (const proc of survivors) log(`run-tests: leaked state-coordinator pid=${proc.pid} root=${proc.root}`);
		for (const proc of survivors) kill(proc.pid, SIGTERM);
		await sleep(SIGKILL_DELAY_MS);
		let leftovers = survivors;
		if (canCheckResidue) {
			try {
				leftovers = select(await listProcesses()).filter((proc) => !preexisting.has(proc.pid));
			} catch (error) {
				log(`run-tests: WARNING: cannot enumerate node processes after SIGTERM (${describeError(error)}); sending SIGKILL to the known survivors`);
			}
		}
		for (const proc of leftovers) {
			log(`run-tests: survivor pid=${proc.pid} ignored SIGTERM; sending SIGKILL`);
			kill(proc.pid, SIGKILL);
		}
		survivorPids.push(...survivors.map((proc) => proc.pid));
	} else if (residueChecked) {
		log("run-tests: no leaked coordinators");
	}

	let exitCode;
	if (run.exitCode === null) {
		log(`run-tests: the test run ended by signal ${run.signal ?? "unknown"}; treating it as a failure`);
		exitCode = 1;
	} else {
		exitCode = run.exitCode;
	}
	if (survivors.length > 0) exitCode = 1;
	return { exitCode, survivors: survivorPids };
}

/**
 * Enumerate node processes with their command lines. Throws when the platform's
 * enumeration tool is unavailable; `runSuite` turns that into a warning and
 * skips the residue check (fail-open).
 * @returns {Array<{pid: number, commandLine: string}>}
 */
function listNodeProcesses() {
	if (process.platform === "win32") {
		// Forced UTF-8: ConvertTo-Json otherwise emits code-page text that mangles
		// non-ASCII root paths, and CIM may quote paths containing spaces.
		const prefix = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8;";
		const query = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
		const args = ["-NoProfile", "-NonInteractive", "-Command", `${prefix} ${query}`];
		for (const shell of ["pwsh", "powershell"]) {
			try {
				return parseProcessList(execFileSync(shell, args, { encoding: "utf8" }), process.platform);
			} catch (error) {
				// Only a missing shell falls through to the next candidate; an
				// enumeration failure is not masked by retrying another binary.
				if (error?.code !== "ENOENT") throw error;
			}
		}
		throw new Error("neither pwsh nor powershell is available");
	}
	// -ww matters: without unlimited width, ps truncates the command line before
	// the root argument and a leaked coordinator silently escapes selection.
	return parseProcessList(execFileSync("ps", ["-e", "-ww", "-o", "pid=,args="], { encoding: "utf8" }), process.platform);
}

/**
 * Run the suite files through `node --test` with inherited stdio.
 * @param {string} repoRoot
 * @param {string[]} files repoRoot-relative test paths
 * @returns {Promise<{exitCode: number|null, signal: string|null}>}
 */
function spawnSuite(repoRoot, files) {
	return new Promise((settle) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			settle(value);
		};
		const child = spawn(process.execPath, ["--test", ...files], { cwd: repoRoot, stdio: "inherit", windowsHide: true });
		child.on("error", (error) => {
			console.error(`run-tests: failed to spawn the test runner: ${describeError(error)}`);
			finish({ exitCode: 1, signal: null });
		});
		child.on("exit", (code, signal) => finish({ exitCode: code, signal: signal ?? null }));
	});
}

/**
 * Real shell: derive this checkout from the module location, enumerate the test
 * files, run the suite, grade the residue, and set `process.exitCode`.
 * @returns {Promise<{exitCode: number, survivors: number[]}>}
 */
export async function main() {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	// Sorted so a failing run's file ordering is stable across platforms.
	const files = readdirSync(join(repoRoot, "test"))
		.filter((name) => name.endsWith(".test.mjs"))
		.sort()
		.map((name) => join("test", name));
	const result = await runSuite({
		repoRoot,
		tmpRoot: tmpdir(),
		platform: process.platform,
		spawnTest: () => spawnSuite(repoRoot, files),
		listProcesses: () => listNodeProcesses(),
		kill: (pid, signal) => {
			try {
				process.kill(pid, signal);
			} catch { /* already gone */ }
		},
		sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
		log: (line) => console.log(line),
	});
	process.exitCode = result.exitCode;
	return result;
}

// Import safety: see the module JSDoc. `main()` must never run while a test
// imports the pure functions, or `node --test` would recurse into itself.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
	await main();
}
