// Issue #222 step 23a (task-23a-smoke-brief.md): owned, ISOLATED real-Pi PTY
// smoke runner (FW-08 load proof + FW-02 public-interface probe + FW-05 empty
// baseline/editor observation).
//
// What is REAL here: the actual managed Pi launcher (`~/.pi/agent/bin/pi`, whose
// realpath/version is re-measured every run), a real PTY (node-pty), the real
// fullscreen TUI, and the repo-local probe extension loaded by Pi itself.
// ISOLATION: a fresh temp root with its own PI_CODING_AGENT_DIR; `--no-extensions
// --no-mcp --extension <abs probe> --tui-mode fullscreen --verbose --offline -na`;
// a minimal env allowlist (no credentials, no user sessions); no `pi install`,
// no global config/symlink change, no auth read/copy, no prompt, no model or
// network provider request.
//
// It drives the probe ONLY through documented public extension APIs and actual
// terminal key input; every operation is recorded by the probe. Headless PTY is
// NOT physical-pixel evidence and this is NOT A4/A5 acceptance.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE = resolve(REPO_ROOT, "test-support/pi23a-probe-extension.ts");
const EVALUATOR = resolve(REPO_ROOT, "test-support/pi23a-candidate-evaluator.ts");
const ARTIFACT_DIR = process.argv[2] === undefined ? null : resolve(process.argv[2]);
const TUI_MODE = process.env.PI23A_TUI_MODE === "regular" ? "regular" : "fullscreen";
const WITNESS_CELL = process.env.PI23A_WITNESS === "1";
if (ARTIFACT_DIR === null) {
	process.stderr.write("pi23a-smoke-runner: missing <artifact-dir>\n");
	process.exit(2);
}
if (existsSync(ARTIFACT_DIR)) {
	process.stderr.write(`pi23a-smoke-runner: artifact dir already exists (overwrite refused): ${ARTIFACT_DIR}\n`);
	process.exit(2);
}
mkdirSync(ARTIFACT_DIR, { recursive: true });
const write = (name, value) => writeFileSync(join(ARTIFACT_DIR, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
const sha256File = (path) => {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
};
const realpath = (path) => {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ---- FW-08: re-measure the ACTUAL launcher / managed release ----------------
const which = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" });
const launcherCandidate = which.stdout.trim();
const launcher = launcherCandidate === "" ? null : realpath(launcherCandidate);
const agentDir = launcher === null ? null : dirname(dirname(launcher));
let managedVersion = null;
let releaseBin = null;
if (agentDir !== null) {
	try {
		managedVersion = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
		releaseBin = join(agentDir, "install", "releases", managedVersion, "node_modules", ".bin", "pi");
	} catch {
		managedVersion = null;
	}
}
const versionProbe = spawnSync(launcher ?? "pi", ["--version"], { encoding: "utf8", timeout: 60000 });
const launcherFacts = {
	whichPi: launcherCandidate,
	launcherRealpath: launcher,
	launcherSha256: launcher === null ? null : sha256File(launcher),
	agentDir,
	managedVersionFile: managedVersion,
	releaseBin,
	releaseBinExists: releaseBin === null ? null : existsSync(releaseBin),
	releaseBinRealpath: releaseBin === null ? null : realpath(releaseBin),
	versionStdout: versionProbe.stdout?.trim() ?? null,
	versionStderr: versionProbe.stderr?.trim() ?? null,
	versionExit: versionProbe.status,
	node: process.version,
	probeRealpath: realpath(PROBE),
	probeSha256: sha256File(PROBE),
};
write("launcher.json", launcherFacts);
if (launcher === null || versionProbe.status !== 0) {
	write("result.json", { status: "infrastructure-unavailable", reason: "no working pi launcher", launcherFacts });
	process.exit(1);
}

// ---- isolation root ---------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "pi23a-"));
const isolatedAgentDir = join(root, "agent");
const cwd = join(root, "cwd");
mkdirSync(isolatedAgentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
const rawPath = join(ARTIFACT_DIR, "raw.ansi");
const rawEventsPath = join(ARTIFACT_DIR, "raw-events.jsonl");
const probeLog = join(ARTIFACT_DIR, "probe.jsonl");
const controlFile = join(ARTIFACT_DIR, "control.json");
writeFileSync(rawPath, "");
writeFileSync(rawEventsPath, "");
writeFileSync(controlFile, "{\"cmd\":\"none\"}");
writeFileSync(probeLog, "");

const ownedProbeDir = join(isolatedAgentDir, "probe");
mkdirSync(ownedProbeDir, { recursive: true });
const ownedProbe = join(ownedProbeDir, "agent-board-probe-extension.ts");
const ownedEvaluator = join(ownedProbeDir, "pi23a-candidate-evaluator.ts");
copyFileSync(PROBE, ownedProbe);
copyFileSync(EVALUATOR, ownedEvaluator);
const argv = [
	"--no-extensions",
	"--no-mcp",
	"--extension",
	ownedProbe,
	"--tui-mode",
	TUI_MODE,
	"--verbose",
	"--offline",
	"-na",
];
const envAllowlist = {
	PATH: process.env.PATH ?? "",
	HOME: process.env.HOME ?? "",
	TERM: "xterm-256color",
	LANG: process.env.LANG ?? "C.UTF-8",
	PI_CODING_AGENT_DIR: isolatedAgentDir,
	PI23A_PROBE_LOG: probeLog,
	PI23A_CONTROL_FILE: controlFile,
	PI_OFFLINE: "1",
};
write("invocation.json", { cell: WITNESS_CELL ? "witness" : TUI_MODE, tuiMode: TUI_MODE, launcher, repoProbe: PROBE, repoProbeSha256: launcherFacts.probeSha256, ownedProbe, ownedProbeSha256: sha256File(ownedProbe), argv, envAllowlistKeys: Object.keys(envAllowlist), envAllowlist: { ...envAllowlist, PATH: "<redacted>", HOME: "<redacted>" }, cwd, isolatedAgentDir: "<owned temp>", probe: PROBE });

const startedAt = Date.now();
const term = pty.spawn(launcher, argv, { name: "xterm-256color", cols: 80, rows: 24, cwd, env: envAllowlist });
let rawBytes = 0;
let rawText = "";
term.onData((data) => {
	const at = Date.now();
	rawBytes += Buffer.byteLength(data, "utf8");
	appendFileSync(rawPath, data);
	appendFileSync(rawEventsPath, `${JSON.stringify({ at: at - startedAt, bytes: Buffer.byteLength(data, "utf8"), hasSyncOpen: data.includes("\u001b[?2026h"), hasSyncClose: data.includes("\u001b[?2026l"), head: data.slice(0, 60) })}\n`);
	rawText += data;
});
let exited = false;
let exitCode = null;
term.onExit(({ exitCode: code }) => {
	exited = true;
	exitCode = code;
});

const readProbe = () => {
	try {
		return readFileSync(probeLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
const sendControl = async (cmd) => {
	writeFileSync(controlFile, JSON.stringify({ cmd, at: Date.now() }));
	await sleep(250);
};
const sendKeys = async (text, waitMs = 400) => {
	term.write(text);
	await sleep(waitMs);
};

const result = { status: "unknown", steps: {}, unknown: [], unsupported: [], errors: [] };
try {
	// 1. FW-08: the extension is ACTUALLY loaded by Pi (inside-extension record).
	const loadEvents = await waitProbe((events) => events.some((event) => event.event === "extension-load" && event.event !== undefined), 30_000, "extension-load");
	const load = loadEvents.find((event) => event.event === "extension-load");
	result.steps.load = {
		loadCount: load.loadCount,
		selfRealpath: load.selfRealpath,
		selfSha256: load.selfSha256,
		execPath: load.execPath,
		argv: load.argv,
		packages: load.packages,
		expectedOwnedProbeRealpath: realpath(ownedProbe),
		expectedRepoProbeRealpath: launcherFacts.probeRealpath,
		evaluatorSha256: load.evaluatorSha256,
		expectedEvaluatorSha256: sha256File(EVALUATOR),
		expectedProbeSha256: launcherFacts.probeSha256,
		realpathMatches: load.selfRealpath === realpath(ownedProbe),
		repoCopyByteIdentical: load.selfSha256 === launcherFacts.probeSha256,
		hashMatches: load.selfSha256 === launcherFacts.probeSha256,
	};
	// 2. Editor rendered: session_start + sentinel renders + real synchronized output.
	const renderEvents = await waitProbe(
		(events) => events.some((event) => event.event === "sentinel-render") && events.some((event) => event.event === "terminal-op" && event.hasSyncOpen === true),
		30_000,
		"editor render (sentinel + synchronized frame output)",
	);
	const sessionStart = renderEvents.find((event) => event.event === "session-start");
	const sentinelRenders = renderEvents.filter((event) => event.event === "sentinel-render");
	const syncWrites = renderEvents.filter((event) => event.event === "terminal-op" && event.hasSyncOpen === true);
	result.steps.bootAndEditor = {
		tuiMode: TUI_MODE,
		sessionStart,
		sentinelRenderCount: sentinelRenders.length,
		firstSentinelRender: sentinelRenders[0] ?? null,
		syncWrites: syncWrites.length,
		focusApi: sentinelRenders[0]?.focusApi ?? "unknown",
		focusPresent: sentinelRenders[0]?.focusPresent ?? null,
		mode: sentinelRenders[0]?.mode ?? null,
		// BOOT (raw bytes before the first synchronized frame) vs editor stage.
		bootBytesBeforeFirstSync: (() => {
			const idx = rawText.indexOf("\u001b[?2026h");
			return idx < 0 ? null : Buffer.byteLength(rawText.slice(0, idx), "utf8");
		})(),
		rawBytesTotal: rawBytes,
	};
	if (result.steps.bootAndEditor.focusApi === "absent") {
		result.unsupported.push({ what: "getFocusedComponent", reason: "public TUI instance does not expose a focus accessor; focus evidence UNKNOWN" });
	}
	// 3. FW-02: NON-RENDER size reads must not emit any terminal write/marker.
	const beforeReads = readProbe();
	const opsBeforeReads = beforeReads.filter((event) => event.event === "terminal-op").length;
	await sendControl("reads");
	const afterReads = readProbe();
	const readCommand = afterReads.filter((event) => event.event === "non-render-size-reads").at(-1) ?? null;
	const readEvents = afterReads.filter((event) => event.event === "size-read");
	const opsAfterReads = afterReads.filter((event) => event.event === "terminal-op").length;
	result.steps.nonRenderReads = {
		commandReads: readCommand === null ? null : readCommand.sizeReadsAfter - readCommand.sizeReadsBefore,
		sizeReadCountTotal: readEvents.length,
		attribution: "UNKNOWN: the probe never wraps component.render, so reads cannot be attributed to a pass",
		terminalOpsDelta: opsAfterReads - opsBeforeReads,
		readCommand,
	};
	// 4. FW-02: a REAL public overlay (ctx.ui.custom) through the renderer.
	await sendControl("overlay");
	const overlayEvents = await waitProbe((events) => events.some((event) => event.event === "overlay-render"), 20_000, "overlay render");
	result.steps.overlay = {
		openRequested: overlayEvents.some((event) => event.event === "overlay-open-request"),
		mounted: overlayEvents.some((event) => event.event === "overlay-mounted"),
		rendered: overlayEvents.filter((event) => event.event === "overlay-render").length,
		sentinelRendersDuringOverlay: overlayEvents.filter((event) => event.event === "sentinel-render").length,
	};
	await sendControl("close-overlay");
	const closedEvents = await waitProbe((events) => events.some((event) => event.event === "overlay-closed"), 20_000, "overlay close");
	result.steps.overlay.closed = closedEvents.some((event) => event.event === "overlay-closed");
	// 5. DOCUMENTED in-session mode switch (fix1). docs/usage.md: "Choose a mode
	// through `/settings` or `--tui-mode`". The documented public UI path is
	// `/settings` -> search "tui" -> Enter (SettingsList cycles the value) -> Esc,
	// which calls InteractiveMode.switchTuiMode(). That function passes
	// `previousUi.terminal` to the new renderer, so the shared Terminal instance
	// must survive; the probe re-checks it when the widget factory is re-invoked.
	const modeBefore = readProbe().filter((event) => event.event === "sentinel-render").at(-1)?.mode ?? null;
	result.steps.modeSwitch = { startupMode: TUI_MODE, initialObservedMode: modeBefore, documentedPath: "/settings -> type 'tui' -> Enter (cycle TUI mode) -> Esc", attempts: [] };
	const switchMode = async (label) => {
		const probeEvents = () => readProbe();
		const before = {
			mode: probeEvents().filter((event) => event.event === "sentinel-render").at(-1)?.mode ?? null,
			altLeaveCount: (rawText.match(/\u001b\[\?1049l/g) ?? []).length,
			lifecycleEvents: probeEvents().filter((event) => event.event === "terminal-lifecycle").length,
			candidateDecisions: probeEvents().filter((event) => event.event === "candidate-decision").length,
		};
		await sendKeys("/settings", 700);
		await sendKeys("\r", 1500); // submit the documented /settings command
		await sendKeys("tui", 900); // search filter in the settings list
		await sendKeys("\r", 1600); // cycle the TUI mode value (documented control)
		await sendKeys("\u001b", 900); // close the selector
		const refreshIndex = probeEvents().length;
		await sendControl("refresh-widget");
		await sleep(1000);
		const afterEvents = probeEvents();
		const refactory = afterEvents.slice(refreshIndex).filter((event) => event.event === "sentinel-refactory").at(-1) ?? null;
		const identityCheck = afterEvents.slice(refreshIndex).filter((event) => event.event === "terminal-identity-check").at(-1) ?? null;
		const after = {
			mode: refactory?.mode ?? probeEvents().filter((event) => event.event === "sentinel-render").at(-1)?.mode ?? null,
			altLeaveCount: (rawText.match(/\u001b\[\?1049l/g) ?? []).length,
			lifecycleEvents: probeEvents().filter((event) => event.event === "terminal-lifecycle").length,
			sameTerminalInstance: identityCheck?.sameTerminalInstance ?? null,
			rendererEpoch: refactory?.rendererEpoch ?? null,
			refactorySeen: refactory !== null,
			settingsFrameSeen: rawText.includes("TUI mode") || rawText.includes("tui"),
		};
		const attempt = { label, before, after, changed: before.mode !== null && after.mode !== null && before.mode !== after.mode };
		result.steps.modeSwitch.attempts.push(attempt);
		return attempt;
	};
	await switchMode("switch-1 (documented /settings path)");
	if (!WITNESS_CELL) await switchMode("switch-2 (switch back to the startup mode)");
	const attempts = result.steps.modeSwitch.attempts;
	result.steps.modeSwitch.publicApiForInSessionSwitch = "none in the 1.4.0 extension types; the documented control is /settings -> SettingsSelectorComponent 'tui-mode' -> onTuiModeChange -> InteractiveMode.switchTuiMode()";
	result.steps.modeSwitch.allSwitchesChangedMode = attempts.length > 0 && attempts.every((attempt) => attempt.changed);
	result.steps.modeSwitch.sharedTerminalPreserved = attempts.every((attempt) => attempt.after.sameTerminalInstance === true);
	result.steps.modeSwitch.returnedToStartupMode = !WITNESS_CELL && attempts.length === 2 && attempts[1].after.mode === TUI_MODE;
	result.steps.modeSwitch.verdict =
		result.steps.modeSwitch.allSwitchesChangedMode && result.steps.modeSwitch.sharedTerminalPreserved
			? "supported-by-documented-ui-control"
			: "UNKNOWN";
	if (result.steps.modeSwitch.verdict !== "supported-by-documented-ui-control") {
		result.unknown.push({ what: "fullscreen<->regular in-session switch", reason: "documented /settings path did not change the observed renderer mode and preserve the shared terminal in every attempt; see steps.modeSwitch.attempts" });
	}
	// 6. REAL open-stop witness (parent decision 3). Only the dedicated witness cell
	// runs it: the real `terminal.stop()` removes stdin listeners, so no key-driven
	// step can follow in the same session. The cell then ends with a real graceful
	// SIGTERM shutdown (which emits session_shutdown before touching the terminal).
	if (!WITNESS_CELL) {
		result.steps.openStopWitness = {
			skipped: true,
			reason: "real terminal.stop() removes stdin listeners; the witness runs in the dedicated PI23A_WITNESS=1 cell",
		};
		await sendControl("noop");
	} else {
	await sendControl("open-stop-witness");
	await sleep(1200);
	const witnessEvents = readProbe();
	const witness = witnessEvents.filter((event) => event.event === "open-stop-witness").at(-1) ?? null;
	const witnessResumed = witnessEvents.filter((event) => event.event === "open-stop-witness-resumed").at(-1) ?? null;
	const expectedKind = witness?.sEmittedBeforeStop === true ? "A" : "none";
	const witnessSatisfied =
		witness !== null &&
		witness.supported === true &&
		witness.openFrameId !== null &&
		witness.stopDecisionFrameId === witness.openFrameId &&
		witness.stopDecisionKind === expectedKind &&
		witness.finishForFrame === 0;
	result.steps.openStopWitness = {
		witness,
		resumed: witnessResumed,
		expectedDecisionKind: expectedKind,
		satisfied: witnessSatisfied,
		rule: "S -> A with matching frameId; otherwise silent invalidation with no later S/F",
	};
	if (!witnessSatisfied) {
		result.unknown.push({ what: "real open-stop invalidation", reason: "the public Terminal lifecycle did not invalidate an open candidate in this run; see steps.openStopWitness" });
	}
	}
	// 7. Stop / invalidation + restore-on-stop, then the ACTUAL shutdown event.
	await sendControl("stop");
	const stopEvents = readProbe();
	result.steps.stop = {
		probeStop: stopEvents.some((event) => event.event === "probe-stop"),
		shadowRestores: stopEvents.filter((event) => event.event === "shadow-restore").map((event) => ({ key: event.key, result: event.result, protoUnchanged: event.protoUnchanged, ownAfter: event.ownAfter === null ? null : "present" })),
		stopVerified: stopEvents.filter((event) => event.event === "stop-verified").at(-1) ?? null,
		candidateAbortsAtStop: stopEvents.filter((event) => event.event === "candidate-decision" && event.reason === "stop").length,
	};
	const exitPath = [];
	if (WITNESS_CELL) {
		// stdin is dead after the real stop; SIGTERM is Pi's documented graceful path.
		term.kill("SIGTERM");
		exitPath.push({ input: "SIGTERM", exited });
		await sleep(2500);
		exitPath.push({ input: "SIGTERM-wait", exited });
	} else {
	await sendKeys("/exit\r", 1500);
	exitPath.push({ input: "/exit\\r", exited });
	}
	if (!exited && !WITNESS_CELL) {
		await sendKeys("\u0004", 1500);
		exitPath.push({ input: "Ctrl+D", exited });
	}
	if (!exited && !WITNESS_CELL) {
		await sendKeys("\u0003", 1500);
		exitPath.push({ input: "Ctrl+C", exited });
	}
	const exitDeadline = Date.now() + 10000;
	while (!exited && Date.now() < exitDeadline) await sleep(100);
	// Give the shutdown-side channel a moment to flush the actual event.
	const shutdownDeadline = Date.now() + 5000;
	let shutdownEvent = readProbe().filter((event) => event.event === "session-shutdown").at(-1) ?? null;
	while (shutdownEvent === null && Date.now() < shutdownDeadline) {
		await sleep(150);
		shutdownEvent = readProbe().filter((event) => event.event === "session-shutdown").at(-1) ?? null;
	}
	result.steps.exit = { exited, exitCode, exitPath, shutdownEvent: shutdownEvent ?? null, shutdownReason: shutdownEvent?.reason ?? null };
	result.steps.stop.shutdownAfterStop = shutdownEvent !== null;
	if (shutdownEvent === null) {
		result.unknown.push({ what: "session_shutdown event", reason: "the process exited without a recorded session-shutdown event; cleanup is evidenced only by stop-verified + exit code" });
	}
	// 8. Candidate decisions from the live stream.
	const allEvents = readProbe();
	const decisions = allEvents.filter((event) => event.event === "candidate-decision");
	const candidateEvents = decisions.filter((event) => event.kind === "candidate");
	const frameIdOrder = candidateEvents.map((event) => event.frameId);
	const frameIdStrictlyIncreasing = frameIdOrder.every((frameId, index) => index === 0 || frameId > frameIdOrder[index - 1]);
	const byKind = decisions.reduce((acc, event) => {
		acc[event.kind] = (acc[event.kind] ?? 0) + 1;
		return acc;
	}, {});
	result.steps.candidates = {
		counts: byKind,
		frameIds: frameIdOrder,
		epochsAlongFrameIds: candidateEvents.map((event) => event.rendererEpoch),
		frameIdStrictlyIncreasingAcrossEpochs: frameIdStrictlyIncreasing,
		frameIdDomain: "one reporter token: strictly increasing across rendererEpoch changes (no reset on evaluator rebind)",
		published: decisions.filter((event) => event.kind === "S" || event.kind === "F" || event.kind === "A").map((event) => ({ kind: event.kind, frameId: event.frameId, reason: event.reason, source: event.source })),
		sWithoutF: (() => {
			const openS = new Set();
			for (const event of decisions) {
				if (event.kind === "S") openS.add(event.frameId);
				if (event.kind === "F" || event.kind === "A") openS.delete(event.frameId);
			}
			return [...openS];
		})(),
	};
	result.status = "completed";
} catch (err) {
	result.status = "failed";
	result.errors.push(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
	try {
		term.kill();
	} catch {
		/* already exited */
	}
	const finalEvents = readProbe();
	result.probeEventCounts = finalEvents.reduce((acc, event) => {
		acc[event.event] = (acc[event.event] ?? 0) + 1;
		return acc;
	}, {});
	result.probeTail = finalEvents.slice(-12);
	result.cell = WITNESS_CELL ? "witness" : TUI_MODE;
	result.raw = { bytes: rawBytes, sha256: createHash("sha256").update(rawText).digest("hex"), syncOpenCount: (rawText.match(/\u001b\[\?2026h/g) ?? []).length, syncCloseCount: (rawText.match(/\u001b\[\?2026l/g) ?? []).length, tuiMode: TUI_MODE, altScreenEntered: rawText.includes("\u001b[?1049h") };
	result.isolation = { rootOwned: root, agentDirOwned: isolatedAgentDir, rootWillBeRemoved: true };
	result.launcher = launcherFacts;
	write("result.json", result);
	write("probe-final.jsonl", finalEvents);
	try {
		copyFileSync(probeLog, join(ARTIFACT_DIR, "probe-retained.jsonl"));
	} catch {
		/* retained via probe-final.jsonl */
	}
	writeFileSync(join(ARTIFACT_DIR, "raw.ansi"), rawText);
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
		result.isolation.rootRemoved = true;
	} catch {
		result.isolation.rootRemoved = false;
	}
	write("result.json", result);
}
process.stdout.write(`${JSON.stringify({ status: result.status, artifactDir: ARTIFACT_DIR, steps: Object.keys(result.steps) })}\n`);
process.exit(result.status === "completed" ? 0 : 1);
