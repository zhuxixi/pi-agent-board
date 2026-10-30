// Issue #222 step 23a production adapter (task-23a-adapter-brief.md): real-Pi probe
// that loads the PRODUCTION adapter (`src/core/attach-frame-reporter.mjs`, copied
// byte-identically next to this file) into an isolated Pi child.
//
// It proves the load from inside, enables the capability through an OWNED FAKE
// reporter endpoint (the real runner does not implement the handshake — that is
// FW-04/23b), and lets the adapter write real DCS markers into the real terminal
// stream. The runner drives it through a control file. No model request, no
// credentials, no global change.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AttachFrameReporter } from "../src/core/attach-frame-reporter.mjs";

const SELF = fileURLToPath(import.meta.url);
const LOG = process.env.PI23A_PROD_LOG ?? join(dirname(SELF), "probe.jsonl");
const CONTROL = process.env.PI23A_PROD_CONTROL ?? join(dirname(SELF), "control.json");
const TOKEN = "prodprobe0token0123456789abcdef"; // 32 chars = 192 bits of base64url

let phase = "boot";
let loadCount = 0;

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function real(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function record(event: Record<string, unknown>): void {
	try {
		appendFileSync(LOG, `${JSON.stringify({ at: process.hrtime.bigint().toString(), wallMs: Date.now(), phase, ...event })}\n`);
	} catch {
		/* diagnostics only */
	}
}

function packages(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const entry = process.argv[1];
	const starts = [entry === undefined ? null : dirname(real(entry) ?? entry), dirname(real(SELF) ?? SELF)].filter((value): value is string => value !== null);
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		for (const start of starts) {
			let dir = start;
			for (let i = 0; i < 8; i += 1) {
				const pkg = join(dir, "node_modules", name, "package.json");
				if (existsSync(pkg)) {
					out[name] = { version: (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version, packageJson: real(pkg) ?? pkg };
					break;
				}
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
			if (out[name] !== undefined) break;
		}
	}
	return out;
}

export default function productionProbe(pi: ExtensionAPI): void {
	loadCount += 1;
	record({
		event: "extension-load",
		loadCount,
		selfRealpath: real(SELF),
		selfSha256: sha256(readFileSync(SELF, "utf8")),
		reporterSha256: sha256(readFileSync(join(dirname(SELF), "..", "src", "core", "attach-frame-reporter.mjs"), "utf8")),
		proofSha256: sha256(readFileSync(join(dirname(SELF), "..", "src", "core", "attach-frame-proof.mjs"), "utf8")),
		pid: process.pid,
		execPath: process.execPath,
		argv: process.argv,
		packages: packages(),
	});
	let reporter: AttachFrameReporter | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	pi.on("session_start", (_event: unknown, ctx: unknown) => {
		phase = "session";
		const typed = ctx as { hasUI?: boolean; ui?: { setWidget: (key: string, factory: unknown, options?: { placement?: string }) => void } };
		record({ event: "session-start", hasUI: typed.hasUI ?? null, uiSeen: typed.ui !== undefined, loadCount });
		if (typed.ui === undefined) return;
		const hello: unknown[] = [];
		reporter = new AttachFrameReporter({
			ui: typed.ui,
			mode: "fullscreen",
			sessionEpoch: 1,
			send: (message: unknown) => {
				hello.push(message);
			},
		});
		reporter.announce();
		// Owned fake reporter endpoint: the ONLY thing that enables the capability here.
		const negotiation = reporter.handleMessage({ type: "frame_witness_enable", protocol: 1, token: TOKEN });
		const installed = reporter.install();
		record({
			event: "reporter-installed",
			installed,
			state: reporter.state,
			negotiation,
			hello,
			markersAtInstall: reporter.markerCount,
			installedKeys: reporter.installedKeys,
			loadCount,
		});
		let last = "";
		timer = setInterval(() => {
			let text = "";
			try {
				text = readFileSync(CONTROL, "utf8");
			} catch {
				return;
			}
			if (text === last) return;
			last = text;
			let cmd: { cmd?: string; mode?: string } = {};
			try {
				cmd = JSON.parse(text) as { cmd?: string; mode?: string };
			} catch {
				return;
			}
			if (reporter === null) return;
			if (cmd.cmd === "flush") {
				record({
					event: "reporter-flush",
					state: reporter.state,
					markerCount: reporter.markerCount,
					markerFailure: reporter.markerFailure,
					unknown: reporter.unknown,
					installedKeys: reporter.installedKeys,
					decisions: reporter.decisions,
					loadCount,
				});
				return;
			}
			if (cmd.cmd === "render") {
				// Drive a NORMAL render through documented public UI API only: registering
				// and clearing a one-line widget forces the real renderer to compose and
				// write again, which is what the post-switch regular witness needs.
				typed.ui?.setWidget("agent-board-probe-poke", [" "], { placement: "aboveEditor" });
				setTimeout(() => typed.ui?.setWidget("agent-board-probe-poke", undefined), 60);
				record({ event: "render-poke", state: reporter.state, markerCount: reporter.markerCount, loadCount });
				return;
			}
			if (cmd.cmd === "mode") {
				const mode = cmd.mode === "regular" ? "regular" : "fullscreen";
				const before = reporter.decisions.length;
				reporter.setMode(mode);
				const reinstalled = reporter.install();
				record({ event: "reporter-mode", mode, reinstalled, state: reporter.state, decisions: reporter.decisions.slice(before), loadCount });
				return;
			}
			if (cmd.cmd === "stop") {
				phase = "stopped";
				const result = reporter.dispose("runner-stop");
				record({
					event: "reporter-stop",
					state: reporter.state,
					restores: result.restores,
					decisions: result.decisions,
					markerCount: reporter.markerCount,
					markerFailure: reporter.markerFailure,
					unknown: reporter.unknown,
					loadCount,
				});
				if (timer !== null) clearInterval(timer);
				return;
			}
		}, 100);
		timer.unref?.();
	});
	pi.on("session_shutdown", (event: unknown) => {
		phase = "shutdown";
		const reason = (event as { reason?: unknown } | undefined)?.reason ?? null;
		const result = reporter === null ? null : reporter.dispose("session-shutdown");
		record({
			event: "session-shutdown",
			reason,
			state: reporter?.state ?? null,
			restores: result?.restores ?? [],
			markerCount: reporter?.markerCount ?? null,
			loadCount,
		});
	});
}
