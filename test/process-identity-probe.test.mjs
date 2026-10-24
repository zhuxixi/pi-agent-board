import test from "node:test";
import assert from "node:assert/strict";
import {
	creationTimeToken,
	parseProbeJson,
	parsePsElapsedMs,
	parsePsProbeLine,
	parseUnixMillis,
	readProcessIdentityProbe,
	readProcessStartToken,
	resolveProbeCommand,
} from "../src/core/process-identity-probe.mjs";
import { captureStartToken } from "../src/core/pid.mjs";

test("parseUnixMillis accepts positive integers only", () => {
	assert.equal(parseUnixMillis("1792718500139"), 1_792_718_500_139);
	assert.equal(parseUnixMillis(""), null);
	assert.equal(parseUnixMillis("abc"), null);
	assert.equal(parseUnixMillis("-5"), null);
});

test("parseProbeJson parses the CIM object and rejects junk", () => {
	assert.deepEqual(parseProbeJson('{"creation":1792718500139,"cmd":"node x"}'),
		{ creationTimeMs: 1_792_718_500_139, commandLine: "node x" });
	assert.deepEqual(parseProbeJson('{"creation":null,"cmd":null}'), { creationTimeMs: null, commandLine: null });
	assert.equal(parseProbeJson("not json"), null);
});

test("parsePsElapsedMs handles every etime shape", () => {
	assert.equal(parsePsElapsedMs("05:03"), 303_000);
	assert.equal(parsePsElapsedMs("01:02:03"), 3_723_000);
	assert.equal(parsePsElapsedMs("2-01:02:03"), 176_523_000);
	assert.equal(parsePsElapsedMs("nope"), null);
});

test("parsePsProbeLine splits elapsed from the command", () => {
	assert.deepEqual(parsePsProbeLine("05:03 node /x --session y z", 1_000_000),
		{ creationTimeMs: 697_000, commandLine: "node /x --session y z" });
	// Command-line capture can fail (protected process) — elapsed alone is still usable.
	assert.deepEqual(parsePsProbeLine("05:03", 1_000_000), { creationTimeMs: 697_000, commandLine: null });
	assert.equal(parsePsProbeLine("", 1_000_000), null);
});

test("readProcessIdentityProbe parses stdout and honors exec options", async () => {
	const calls = [];
	const execFileFn = (cmd, args, opts, cb) => {
		calls.push({ cmd, args, opts });
		cb(null, '{"creation":1792718500139,"cmd":"node x --session y"}\n', "");
	};
	const probe = await readProcessIdentityProbe(123, { platform: "win32", execFileFn });
	assert.deepEqual(probe, { creationTimeMs: 1_792_718_500_139, commandLine: "node x --session y" });
	assert.equal(calls[0].cmd, "powershell.exe");
	assert.match(calls[0].args.at(-1), /ProcessId=123/);
	assert.equal(calls[0].opts.windowsHide, true);
	assert.equal(calls[0].opts.timeout, 3_000);
});

test("readProcessIdentityProbe parses ps output against the injected clock", async () => {
	const execFileFn = (cmd, args, opts, cb) => {
		cb(null, "05:03 node /x --session y\n", "");
	};
	const probe = await readProcessIdentityProbe(123, { platform: "darwin", execFileFn, nowMs: () => 1_000_000 });
	assert.deepEqual(probe, { creationTimeMs: 697_000, commandLine: "node /x --session y" });
});

test("readProcessIdentityProbe returns null on failure/empty output", async () => {
	const nonZeroExit = (cmd, args, opts, cb) => {
		const error = new Error("Command failed");
	error.code = 1;
		cb(error, "", "boom");
	};
	assert.equal(await readProcessIdentityProbe(123, { platform: "win32", execFileFn: nonZeroExit }), null);

	const timedOut = (cmd, args, opts, cb) => {
		const error = new Error("Command failed: powershell.exe");
	error.killed = true;
	error.signal = "SIGTERM";
		cb(error, '{"creation":1,"cmd":"node x"}', "");
	};
	assert.equal(await readProcessIdentityProbe(123, { platform: "win32", execFileFn: timedOut }), null);

	const emptyStdout = (cmd, args, opts, cb) => cb(null, "  \n\t", "");
	assert.equal(await readProcessIdentityProbe(123, { platform: "win32", execFileFn: emptyStdout }), null);
	assert.equal(await readProcessIdentityProbe(123, { platform: "darwin", execFileFn: emptyStdout }), null);

	const unparseable = (cmd, args, opts, cb) => cb(null, "not json", "");
	assert.equal(await readProcessIdentityProbe(123, { platform: "win32", execFileFn: unparseable }), null);
});

test("readProcessIdentityProbe spawns nothing for unsupported platforms or invalid pids", async () => {
	let spawned = 0;
	const execFileFn = (cmd, args, opts, cb) => {
		spawned += 1;
		cb(null, "", "");
	};
	assert.equal(await readProcessIdentityProbe(123, { platform: "linux", execFileFn }), null);
	assert.equal(await readProcessIdentityProbe(0, { platform: "win32", execFileFn }), null);
	assert.equal(await readProcessIdentityProbe(0), null, "single-argument call must not throw");
	assert.equal(spawned, 0);
});

test("resolveProbeCommand is platform- and pid-aware", () => {
	assert.match(resolveProbeCommand("win32", 123).args.at(-1), /ProcessId=123/);
	assert.deepEqual(resolveProbeCommand("darwin", 123), { command: "ps", args: ["-p", "123", "-o", "etime=,command="] });
	assert.equal(resolveProbeCommand("linux", 123), null);
	assert.equal(resolveProbeCommand("win32", 0), null);
	assert.equal(resolveProbeCommand("win32", 1.5), null);
});

test("creationTimeToken formats only positive safe integers", () => {
	assert.equal(creationTimeToken(1792811668715), "ct:1792811668715");
	assert.equal(creationTimeToken(1), "ct:1");
	assert.equal(creationTimeToken(0), null);
	assert.equal(creationTimeToken(-1), null);
	assert.equal(creationTimeToken(1.5), null);
	assert.equal(creationTimeToken(NaN), null);
	assert.equal(creationTimeToken(Infinity), null);
	assert.equal(creationTimeToken(Number.MAX_SAFE_INTEGER + 1), null);
	assert.equal(creationTimeToken("1792811668715"), null);
	assert.equal(creationTimeToken(null), null);
	assert.equal(creationTimeToken(undefined), null);
});

test("readProcessStartToken: linux delegates to captureStartToken", async () => {
	let probed = false;
	const token = await readProcessStartToken(process.pid, { platform: "linux", probe: async () => { probed = true; return null; } });
	assert.equal(probed, false);
	assert.equal(token, captureStartToken(process.pid));
});

test("readProcessStartToken: win32 converts the probe creation time", async () => {
	let seenPid = null;
	const token = await readProcessStartToken(4242, {
		platform: "win32",
		probe: async (pid) => { seenPid = pid; return { creationTimeMs: 1792811668715, commandLine: "node x" }; },
	});
	assert.equal(seenPid, 4242);
	assert.equal(token, "ct:1792811668715");
});

test("readProcessStartToken: darwin never probes and returns null", async () => {
	let probed = false;
	const token = await readProcessStartToken(4242, { platform: "darwin", probe: async () => { probed = true; return { creationTimeMs: 1, commandLine: null }; } });
	assert.equal(probed, false);
	assert.equal(token, null);
});

test("readProcessStartToken: probe failure and bad pids degrade to null", async () => {
	assert.equal(await readProcessStartToken(4242, { platform: "win32", probe: async () => null }), null);
	assert.equal(await readProcessStartToken(4242, { platform: "win32", probe: async () => ({ creationTimeMs: null, commandLine: null }) }), null);
	assert.equal(await readProcessStartToken(0, { platform: "win32", probe: async () => { throw new Error("must not probe"); } }), null);
	assert.equal(await readProcessStartToken(null, { platform: "win32", probe: async () => { throw new Error("must not probe"); } }), null);
});
