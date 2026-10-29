// Issue #222 step 23a production adapter (task-23a-adapter-brief.md): owned, isolated
// real-Pi runner for the PRODUCTION adapter smoke.
//
// Real: the managed Pi 1.4.0 launcher in a real PTY, the repo-authored probe extension
// and the two production core modules (copied byte-identically into the owned root), the
// real fullscreen/regular renderer, a real documented `/settings` mode switch, and the
// REAL DCS markers the adapter writes into the ordered terminal stream.
//
// Isolated: own PI_CODING_AGENT_DIR, 8-key env allowlist, `--no-extensions --no-mcp
// --extension <abs> --tui-mode fullscreen --verbose --offline -na`, no credentials, no
// prompt, no model/network request, owned root removed afterwards. The capability is
// enabled ONLY by the probe's owned fake reporter endpoint; the real runner protocol is
// untouched (FW-04/23b).
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { decodeFrameMarker, MAX_FRAME_MARKER_BYTES } from "../src/core/attach-frame-proof.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE = resolve(REPO_ROOT, "test-support/pi23a-production-probe-extension.ts");
const CORE_FILES = ["attach-frame-proof.mjs", "attach-frame-reporter.mjs"].map((name) => resolve(REPO_ROOT, "src/core", name));
const ARTIFACT_DIR = process.argv[2] === undefined ? null : resolve(process.argv[2]);
if (ARTIFACT_DIR === null) {
	process.stderr.write("pi23a-production-smoke-runner: missing <artifact-dir>\n");
	process.exit(2);
}
if (existsSync(ARTIFACT_DIR)) {
	process.stderr.write(`pi23a-production-smoke-runner: artifact dir exists (overwrite refused): ${ARTIFACT_DIR}\n`);
	process.exit(2);
}
mkdirSync(ARTIFACT_DIR, { recursive: true });
const write = (name, value) => writeFileSync(join(ARTIFACT_DIR, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const realpath = (path) => {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- launcher (re-measured every run) ---------------------------------------
const which = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" });
const launcher = which.stdout.trim() === "" ? null : realpath(which.stdout.trim());
const agentHome = launcher === null ? null : dirname(dirname(launcher));
let managedVersion = null;
if (agentHome !== null) {
	try {
		managedVersion = readFileSync(join(agentHome, "install", "current-version"), "utf8").trim();
	} catch {
		managedVersion = null;
	}
}
const versionProbe = spawnSync(launcher ?? "pi", ["--version"], { encoding: "utf8", timeout: 60_000 });
const launcherFacts = {
	whichPi: which.stdout.trim(),
	launcherRealpath: launcher,
	launcherSha256: launcher === null ? null : sha256File(launcher),
	managedVersionFile: managedVersion,
	versionStdout: versionProbe.stdout?.trim() ?? null,
	versionExit: versionProbe.status,
	node: process.version,
};
write("launcher.json", launcherFacts);
if (launcher === null || versionProbe.status !== 0) {
	write("result.json", { status: "infrastructure-unavailable", launcherFacts });
	process.exit(1);
}

// ---- isolation root ---------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "pi23a-prod-"));
const isolatedAgentDir = join(root, "agent");
const cwd = join(root, "cwd");
mkdirSync(isolatedAgentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
// Mirror the repo layout inside the owned root so the probe's relative imports are
// identical in both worlds (and the standalone type check resolves them).
const ownedRoot = join(isolatedAgentDir, "probe");
const ownedProbeDir = join(ownedRoot, "test-support");
const ownedCoreDir = join(ownedRoot, "src", "core");
mkdirSync(ownedProbeDir, { recursive: true });
mkdirSync(ownedCoreDir, { recursive: true });
const ownedProbe = join(ownedProbeDir, "pi23a-production-probe-extension.ts");
copyFileSync(PROBE, ownedProbe);
for (const file of CORE_FILES) copyFileSync(file, join(ownedCoreDir, file.split("/").at(-1)));
const rawPath = join(ARTIFACT_DIR, "raw.ansi");
const probeLog = join(ARTIFACT_DIR, "probe.jsonl");
const controlFile = join(ARTIFACT_DIR, "control.json");
writeFileSync(rawPath, "");
writeFileSync(probeLog, "");
writeFileSync(controlFile, JSON.stringify({ cmd: "none" }));
const argv = ["--no-extensions", "--no-mcp", "--extension", ownedProbe, "--tui-mode", "fullscreen", "--verbose", "--offline", "-na"];
const env = {
	PATH: process.env.PATH ?? "",
	HOME: process.env.HOME ?? "",
	TERM: "xterm-256color",
	LANG: process.env.LANG ?? "C.UTF-8",
	PI_CODING_AGENT_DIR: isolatedAgentDir,
	PI23A_PROD_LOG: probeLog,
	PI23A_PROD_CONTROL: controlFile,
	PI_OFFLINE: "1",
};
write("invocation.json", {
	launcher,
	argv,
	envAllowlistKeys: Object.keys(env),
	repoProbeSha256: sha256File(PROBE),
	repoCoreSha256: Object.fromEntries(CORE_FILES.map((file) => [file.split("/").at(-1), sha256File(file)])),
	ownedProbeSha256: sha256File(ownedProbe),
	ownedCoreSha256: Object.fromEntries(CORE_FILES.map((file) => [file.split("/").at(-1), sha256File(join(ownedCoreDir, file.split("/").at(-1)))])),
	cwd: "<owned temp>",
});

const startedAt = Date.now();
const term = pty.spawn(launcher, argv, { name: "xterm-256color", cols: 80, rows: 24, cwd, env });
let rawText = "";
term.onData((data) => {
	rawText += data;
	appendFileSync(rawPath, data);
});
let exited = false;
let exitCode = null;
term.onExit(({ exitCode: code }) => {
	exited = true;
	exitCode = code;
});

const readProbe = () => {
	try {
		return readFileSync(probeLog, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
};
async function waitProbe(predicate, timeoutMs, label) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const events = readProbe();
		if (predicate(events)) return events;
		if (exited) throw new Error(`child exited (${exitCode}) while waiting for ${label}`);
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}
const sendControl = async (payload) => {
	writeFileSync(controlFile, JSON.stringify({ ...payload, at: Date.now() }));
	await sleep(350);
};
const sendKeys = async (text, waitMs = 500) => {
	term.write(text);
	await sleep(waitMs);
};

const result = { status: "unknown", steps: {}, unknown: [], errors: [] };
try {
	const loadEvents = await waitProbe((events) => events.some((event) => event.event === "extension-load"), 30_000, "extension-load");
	const load = loadEvents.find((event) => event.event === "extension-load");
	result.steps.load = {
		loadCount: load.loadCount,
		selfRealpath: load.selfRealpath,
		selfSha256: load.selfSha256,
		reporterSha256: load.reporterSha256,
		proofSha256: load.proofSha256,
		expectedProbeSha256: sha256File(PROBE),
		expectedReporterSha256: sha256File(CORE_FILES[1]),
		expectedProofSha256: sha256File(CORE_FILES[0]),
		realpathMatches: load.selfRealpath === realpath(ownedProbe),
		byteIdentical: load.selfSha256 === sha256File(PROBE) && load.reporterSha256 === sha256File(CORE_FILES[1]) && load.proofSha256 === sha256File(CORE_FILES[0]),
		packages: load.packages,
		execPath: load.execPath,
		argv: load.argv,
	};
	const installEvents = await waitProbe((events) => events.some((event) => event.event === "reporter-installed"), 30_000, "reporter-installed");
	const installed = installEvents.find((event) => event.event === "reporter-installed");
	result.steps.install = {
		installed: installed.installed,
		state: installed.state,
		negotiation: installed.negotiation,
		hello: installed.hello,
		installedKeys: installed.installedKeys,
	};
	// Editor frames: the real renderer samples, the sentinel confirms and the adapter
	// writes real markers into the same ordered stream.
	await sleep(1500);
	await sendControl({ cmd: "flush" });
	const flush1 = readProbe().filter((event) => event.event === "reporter-flush").at(-1) ?? null;
	result.steps.editor = {
		markerCount: flush1?.markerCount ?? null,
		state: flush1?.state ?? null,
		markerFailure: flush1?.markerFailure ?? null,
		unknown: flush1?.unknown ?? [],
		decisions: flush1?.decisions ?? [],
	};
	// Documented in-session mode switch, then the adapter rebinds (carrying frameIds).
	await sendKeys("/settings", 700);
	await sendKeys("\r", 1500);
	await sendKeys("tui", 900);
	await sendKeys("\r", 1600);
	await sendKeys("\u001b", 900);
	await sendControl({ cmd: "mode", mode: "regular" });
	await sleep(800);
	// Drive real post-switch regular frames. In regular mode an idle incremental repaint
	// carries no synchronized write, so open/close the documented selector (a full
	// repaint) and also poke a normal render through the public widget API.
	await sendKeys("/settings", 700);
	await sendKeys("\r", 1500);
	await sendKeys("\u001b", 1200);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		await sendControl({ cmd: "render" });
		await sleep(600);
	}
	await sendControl({ cmd: "flush" });
	const flush2 = readProbe().filter((event) => event.event === "reporter-flush").at(-1) ?? null;
	const allDecisions = flush2?.decisions ?? [];
	const regularProofs = allDecisions.filter((decision) => (decision.kind === "S" || decision.kind === "F") && decision.mode === "regular");
	result.steps.modeSwitch = {
		markerCount: flush2?.markerCount ?? null,
		state: flush2?.state ?? null,
		modeEvent: readProbe().find((event) => event.event === "reporter-mode") ?? null,
		decisions: allDecisions.slice(-10),
		regularS: regularProofs.filter((decision) => decision.kind === "S").map((decision) => decision.frameId),
		regularF: regularProofs.filter((decision) => decision.kind === "F").map((decision) => decision.frameId),
	};
	// Stop: the adapter must restore every own shadow and stop proving.
	await sendControl({ cmd: "stop" });
	const stopEvent = readProbe().filter((event) => event.event === "reporter-stop").at(-1) ?? null;
	result.steps.stop = {
		state: stopEvent?.state ?? null,
		restores: stopEvent?.restores ?? [],
		markerCount: stopEvent?.markerCount ?? null,
		unknown: stopEvent?.unknown ?? [],
	};
	await sendKeys("\r", 200);
	await sendKeys("/exit\r", 1500);
	if (!exited) await sendKeys("\u0004", 1500);
	const deadline = Date.now() + 10_000;
	while (!exited && Date.now() < deadline) await sleep(100);
	const shutdown = readProbe().filter((event) => event.event === "session-shutdown").at(-1) ?? null;
	result.steps.exit = { exited, exitCode, shutdown };
	if (shutdown === null) result.unknown.push({ what: "session_shutdown", reason: "no session-shutdown record" });
	if (result.steps.modeSwitch.regularS.length === 0 || result.steps.modeSwitch.regularF.length === 0) {
		result.unknown.push({ what: "post-switch regular witness", reason: "no regular S/F was observed after the documented switch" });
	}
	result.status = "completed";
} catch (error) {
	result.status = "failed";
	result.errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	try {
		term.kill();
	} catch {
		/* already gone */
	}
	// Markers are extracted from the REAL ordered stream.
	const markers = [];
	let index = 0;
	while (true) {
		const start = rawText.indexOf("\u001bP> agent-board-frame/1 ; ", index);
		if (start < 0) break;
		const end = rawText.indexOf("\u001b\\", start);
		if (end < 0) break;
		const literal = rawText.slice(start, end + 2);
		markers.push({
			offset: start,
			bytes: Buffer.byteLength(literal, "utf8"),
			withinLimit: Buffer.byteLength(literal, "utf8") <= MAX_FRAME_MARKER_BYTES,
			literalHead: literal.slice(0, 60),
			decoded: decodeFrameMarker(literal),
		});
		index = end + 2;
	}
	result.markers = {
		count: markers.length,
		allWithinLimit: markers.every((marker) => marker.withinLimit),
		allValid: markers.every((marker) => marker.decoded !== null),
		sequence: markers.map((marker) => (marker.decoded === null ? { kind: "invalid" } : { kind: marker.decoded.kind, frameId: marker.decoded.frameId })),
		literals: markers.map((marker) => marker.literalHead),
		details: markers,
	};
	// Candidate identity is per frame: S and F legitimately share one frameId, so the
	// sequence is checked on distinct consecutive frame ids.
	const framedIds = result.markers.sequence
		.filter((entry) => entry.kind === "S" || entry.kind === "F")
		.map((entry) => entry.frameId)
		.filter((frameId, position, all) => position === 0 || frameId !== all[position - 1]);
	result.markers.frameIdsStrictlyIncreasing = framedIds.every((frameId, position) => position === 0 || frameId > framedIds[position - 1]);
	result.markers.distinctFrameIds = framedIds;
	result.markers.sBeforeFPerFrame = result.markers.sequence.every((entry, position, all) => {
		if (entry.kind !== "F") return true;
		const sIndex = all.findIndex((candidate) => candidate.kind === "S" && candidate.frameId === entry.frameId);
		return sIndex >= 0 && sIndex < position;
	});
	result.raw = { bytes: rawText.length, sha256: createHash("sha256").update(rawText).digest("hex") };
	result.probeEvents = readProbe().reduce((acc, event) => {
		acc[event.event] = (acc[event.event] ?? 0) + 1;
		return acc;
	}, {});
	result.isolation = { rootOwned: root, rootRemoved: false };
	write("markers.json", result.markers);
	write("result.json", result);
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
		result.isolation.rootRemoved = true;
	} catch {
		result.isolation.rootRemoved = false;
	}
	write("result.json", result);
}
process.stdout.write(`${JSON.stringify({ status: result.status, artifactDir: ARTIFACT_DIR, markers: result.markers?.count ?? 0 })}\n`);
process.exit(result.status === "completed" ? 0 : 1);
