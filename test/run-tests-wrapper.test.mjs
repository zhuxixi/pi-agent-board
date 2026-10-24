import assert from "node:assert/strict";
import { test } from "node:test";
import { main, parseProcessList, runSuite, selectOrphanCoordinators } from "../scripts/run-tests.mjs";

// --- A5: pure process parsing and coordinator selection (issue #241 §3.3) ---

const CIM_ARRAY = JSON.stringify([
	{ ProcessId: 123, CommandLine: "node C:\\repo\\runner\\state-coordinator.mjs C:\\Temp\\agentview-pty-a" },
]);
const CIM_SINGLE = JSON.stringify({ ProcessId: 456, CommandLine: "node other.mjs" });

test("A5 parseProcessList: CIM array and single object", () => {
	assert.deepEqual(parseProcessList(CIM_ARRAY, "win32"), [{ pid: 123, commandLine: "node C:\\repo\\runner\\state-coordinator.mjs C:\\Temp\\agentview-pty-a" }]);
	assert.deepEqual(parseProcessList(CIM_SINGLE, "win32"), [{ pid: 456, commandLine: "node other.mjs" }]);
});

test("A5 parseProcessList: ps lines incl. long command line", () => {
	const long = "/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /tmp/agentview-" + "x".repeat(200);
	const raw = `  123 ${long}\n  456 node other.mjs\nnot-a-line\n`;
	const parsed = parseProcessList(raw, "linux");
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0].pid, 123);
	assert.ok(parsed[0].commandLine.includes("x".repeat(200)), "long command line survives parsing");
	assert.equal(parseProcessList("", "linux").length, 0);
});

test("A5 parseProcessList: malformed input never throws", () => {
	assert.deepEqual(parseProcessList("not json", "win32"), []);
	assert.deepEqual(parseProcessList(JSON.stringify(null), "win32"), []);
	assert.deepEqual(parseProcessList(JSON.stringify({ ProcessId: 0, CommandLine: "x" }), "win32"), []);
	assert.deepEqual(parseProcessList(JSON.stringify([{ ProcessId: 9, CommandLine: null }]), "win32"), []);
	assert.deepEqual(parseProcessList(undefined, "linux"), []);
});

const REPO = "C:\\repo";
const TMP = "C:\\Users\\u\\AppData\\Local\\Temp";
const SCRIPT = `${REPO}\\runner\\state-coordinator.mjs`;

/**
 * A process row shaped the way the coordinator spawn looks in CIM output.
 * @param {number} pid
 * @param {string} root
 * @param {{ script?: string, platform?: string }} [options]
 */
function proc(pid, root, { script = SCRIPT, platform = "win32" } = {}) {
	const cmd = platform === "win32"
		? `"C:\\Program Files\\nodejs\\node.exe" "${script}" "${root}"`
		: `/usr/bin/node ${script} ${root}`;
	return { pid, commandLine: cmd };
}

test("A5 selection: this checkout + temp root only; production/other-checkout excluded", () => {
	const processes = [
		proc(1, `${TMP}\\agentview-pty-abc`),                            // selected
		proc(2, "C:\\Users\\u\\.pi\\agent\\agent-board"),                // production root
		proc(3, `${TMP}\\agentview-pty-def`, { script: "C:\\other\\runner\\state-coordinator.mjs" }), // other checkout
		proc(4, `${TMP}\\agentview-pty-ghi`, { script: SCRIPT.replace(/\\/g, "/") }), // slash variant
		{ pid: 5, commandLine: "node unrelated.mjs" },
	];
	const got = selectOrphanCoordinators({ processes, repoRoot: REPO, tmpRoot: TMP, platform: "win32" });
	assert.deepEqual(got.map((x) => x.pid), [1, 4]);
	assert.ok(got.every((x) => x.root.startsWith(TMP)));
});

test("A5 selection: win32 case-insensitive script path, temp-boundary and dot-segment escapes", () => {
	const processes = [
		proc(21, `${TMP}\\agentview-pty-case`, { script: SCRIPT.toUpperCase() }), // selected: case variant
		proc(22, `${TMP}Evil\\agentview-pty-abc`),                              // excluded: shared prefix, not under tmp
		proc(23, `${TMP}\\..\\Windows\\Temp\\agentview-pty-abc`),               // excluded: dot segments leave tmp
	];
	const got = selectOrphanCoordinators({ processes, repoRoot: REPO, tmpRoot: TMP, platform: "win32" });
	assert.deepEqual(got.map((x) => x.pid), [21]);
});

test("A5 selection: POSIX", () => {
	const processes = [
		{ pid: 10, commandLine: `/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /tmp/agentview-pty-abc` },
		{ pid: 11, commandLine: `/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /home/u/.pi/agent/agent-board` },
		{ pid: 12, commandLine: `/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /tmpfoo/agentview-pty-abc` },
	];
	const got = selectOrphanCoordinators({ processes, repoRoot: "/home/u/repo", tmpRoot: "/tmp", platform: "linux" });
	assert.deepEqual(got.map((x) => x.pid), [10]);
});

test("A5 selection: a trailing separator on tmpRoot selects exactly like the un-suffixed form", () => {
	// I2 regression: posix.normalize keeps the trailing separator, so a raw
	// `${tmpRoot}/` prefix check matched nothing and the gate false-greened.
	const processes = [
		proc(41, `${TMP}\\agentview-pty-trailing`),
		proc(42, `${TMP}\\agentview-pty-nested\\view`),
		proc(43, TMP), // the tmp root itself is a valid coordinator root
	];
	for (const tmpRoot of [TMP, `${TMP}\\`, `${TMP}/`]) {
		assert.deepEqual(
			selectOrphanCoordinators({ processes, repoRoot: REPO, tmpRoot, platform: "win32" }).map((x) => x.pid),
			[41, 42, 43],
			`win32 tmpRoot ${JSON.stringify(tmpRoot)}`,
		);
	}
	const posixProcesses = [
		{ pid: 51, commandLine: "/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /tmp/agentview-pty-abc" },
		{ pid: 52, commandLine: "/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /tmpfoo/agentview-pty-abc" },
	];
	for (const tmpRoot of ["/tmp", "/tmp/"]) {
		assert.deepEqual(
			selectOrphanCoordinators({ processes: posixProcesses, repoRoot: "/home/u/repo", tmpRoot, platform: "linux" }).map((x) => x.pid),
			[51],
			`POSIX tmpRoot ${JSON.stringify(tmpRoot)}`,
		);
	}
});

test("A5 selection: filesystem-root tmpRoot keeps its separator", () => {
	// Stripping the separator off a filesystem root would turn "/" into "" and
	// "C:/" into the drive-relative "C:", and a `${directory}/` prefix check
	// would produce "//"/"c://", matching nothing.
	const winProcesses = [
		proc(61, "C:\\Temp\\agentview-pty-root"),
		proc(62, "D:\\Temp\\agentview-pty-other-drive"),
	];
	for (const tmpRoot of ["C:\\", "C:/", "C:\\\\"]) {
		assert.deepEqual(
			selectOrphanCoordinators({ processes: winProcesses, repoRoot: REPO, tmpRoot, platform: "win32" }).map((x) => x.pid),
			[61],
			`win32 tmpRoot ${JSON.stringify(tmpRoot)}`,
		);
	}
	const posixProcesses = [
		{ pid: 71, commandLine: "/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /tmp/agentview-pty-abc" },
	];
	for (const tmpRoot of ["/", "//"]) {
		assert.deepEqual(
			selectOrphanCoordinators({ processes: posixProcesses, repoRoot: "/home/u/repo", tmpRoot, platform: "linux" }).map((x) => x.pid),
			[71],
			`POSIX tmpRoot ${JSON.stringify(tmpRoot)}`,
		);
	}
});

test("A5 selection: missing root argument and unrelated command lines are ignored", () => {
	const processes = [
		{ pid: 30, commandLine: `"node.exe" "${SCRIPT}"` },
		{ pid: 31, commandLine: `"node.exe" "${SCRIPT}.bak" "${TMP}\\agentview-pty-abc"` },
	];
	assert.deepEqual(selectOrphanCoordinators({ processes, repoRoot: REPO, tmpRoot: TMP, platform: "win32" }), []);
	assert.deepEqual(selectOrphanCoordinators({ processes: [], repoRoot: REPO, tmpRoot: TMP, platform: "win32" }), []);
});

// --- A6: runSuite orchestration with injected fakes (nothing real is killed) ---

const SURVIVOR_ROOT = `${TMP}\\agentview-pty-survivor`;

/**
 * One coordinator process shaped like the CIM output for this checkout.
 * @param {number} pid
 * @param {string} root
 */
function coordinatorProcess(pid, root) {
	return { pid, commandLine: `"C:\\Program Files\\nodejs\\node.exe" "${SCRIPT}" "${root}"` };
}

/**
 * Monotonic fake clock: advances `stepMs` per read so a persistent survivor
 * reaches the grace deadline after a bounded number of polls.
 * @param {number} [stepMs]
 */
function fakeClock(stepMs = 1_000) {
	let clock = 0;
	return () => {
		clock += stepMs;
		return clock;
	};
}

/**
 * Build `runSuite` deps with fakes. `listProcesses` returns `before` on the
 * first call (the pre-run snapshot) and `after` on every later call.
 * @param {{
 *   before?: Array<{pid: number, commandLine: string}>,
 *   after?: Array<{pid: number, commandLine: string}>,
 *   spawnResult?: {exitCode: number|null, signal?: string|null},
 *   listProcesses?: () => Promise<Array<{pid: number, commandLine: string}>>,
 *   graceMs?: number,
 *   pollMs?: number,
 * }} [options]
 */
function fakeDeps({ before = [], after = [], spawnResult = { exitCode: 0, signal: null }, listProcesses, graceMs = 1_000, pollMs = 100 } = {}) {
	const kills = [];
	const logs = [];
	let calls = 0;
	const deps = {
		repoRoot: REPO,
		tmpRoot: TMP,
		platform: "win32",
		graceMs,
		pollMs,
		now: fakeClock(),
		spawnTest: async () => spawnResult,
		listProcesses: listProcesses ?? (async () => (++calls === 1 ? before : after)),
		kill: (pid, signal) => {
			kills.push({ pid, signal });
		},
		sleep: async () => {},
		log: (line) => {
			logs.push(line);
		},
	};
	return { deps, kills, logs };
}

test("A6 runSuite: clean run passes the test exit code through and kills nothing", async () => {
	const { deps, kills, logs } = fakeDeps();
	const result = await runSuite(deps);
	assert.deepEqual(result, { exitCode: 0, survivors: [] });
	assert.deepEqual(kills, []);
	assert.ok(logs.some((line) => /no leaked coordinators/.test(line)), `success line printed (got ${JSON.stringify(logs)})`);
});

test("A6 runSuite: a post-run survivor is reported, SIGTERM+SIGKILLed, and fails the run", async () => {
	const leaked = coordinatorProcess(4242, SURVIVOR_ROOT);
	const { deps, kills, logs } = fakeDeps({ after: [leaked] });
	const result = await runSuite(deps);
	assert.equal(result.exitCode, 1, "a leak fails the run even though the tests passed");
	assert.deepEqual(result.survivors, [4242]);
	assert.deepEqual(kills, [
		{ pid: 4242, signal: "SIGTERM" },
		{ pid: 4242, signal: "SIGKILL" },
	]);
	assert.ok(logs.some((line) => line.includes("pid=4242") && line.includes(SURVIVOR_ROOT)), "pid and root are printed");
});

test("A6 runSuite: a pre-existing coordinator is warn-only, never killed", async () => {
	const stale = coordinatorProcess(777, `${TMP}\\agentview-pty-stale`);
	const { deps, kills, logs } = fakeDeps({ before: [stale], after: [stale] });
	const result = await runSuite(deps);
	assert.deepEqual(result, { exitCode: 0, survivors: [] });
	assert.deepEqual(kills, []);
	const warning = logs.find((line) => /pre-existing/i.test(line));
	assert.ok(warning, `pre-existing warning printed (got ${JSON.stringify(logs)})`);
	assert.match(warning, /\b1\b/, "the warning carries the count");
});

test("A6 runSuite: a signal-killed test run is a failure", async () => {
	const { deps, logs } = fakeDeps({ spawnResult: { exitCode: null, signal: "SIGINT" } });
	const result = await runSuite(deps);
	assert.deepEqual(result, { exitCode: 1, survivors: [] });
	assert.ok(logs.some((line) => /SIGINT/.test(line)), "the signal is printed");
});

test("A6 runSuite: enumeration failure warns and fails open", async () => {
	const { deps, kills, logs } = fakeDeps({
		listProcesses: async () => {
			throw new Error("pwsh: command not found");
		},
	});
	const result = await runSuite(deps);
	assert.deepEqual(result, { exitCode: 0, survivors: [] });
	assert.deepEqual(kills, []);
	assert.ok(logs.some((line) => /WARNING/.test(line) && /residue check/.test(line)), `warning printed (got ${JSON.stringify(logs)})`);
});

test("A6 runSuite: a non-zero test exit is passed through", async () => {
	const { deps } = fakeDeps({ spawnResult: { exitCode: 3, signal: null } });
	assert.deepEqual(await runSuite(deps), { exitCode: 3, survivors: [] });
});

test("A6 import safety: importing twice is inert and resolves the same namespace", async () => {
	// A spurious main() at import time would recursively start the whole suite
	// here, so this test is the guard for the entry-point check itself.
	const first = await import("../scripts/run-tests.mjs");
	const second = await import("../scripts/run-tests.mjs");
	assert.equal(first, second, "ESM caches the module namespace");
	assert.equal(first.main, main);
	assert.equal(typeof first.main, "function");
	assert.equal(first.parseProcessList, parseProcessList);
	assert.equal(first.selectOrphanCoordinators, selectOrphanCoordinators);
	assert.equal(first.runSuite, runSuite);
});
