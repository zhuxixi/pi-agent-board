#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Env-driven stream modes (phase 4 e2e: terminal-snapshot.integration.test.mjs).
// All modes are additive — default behavior (boot banner + echo) is untouched
// when the env vars are absent, so the existing fixture consumers are unaffected.
// "controlled-frames" (issue #222 step 15 producer) is selected through the
// same FAKE_PTY_STREAM_MODE convention; it owns the whole screen and stdin, so
// it suppresses the default boot banner and echo handler for that mode only.
const controlledMode = process.env.FAKE_PTY_STREAM_MODE === "controlled-frames";
const hold = process.env.FAKE_PTY_HOLD === "1" || controlledMode;
if (!hold) process.stdout.write("fake pi ready\n");

// "steady": a tick line every 25ms — continuous moderate output so a test can
// subscribe mid-stream with the model guaranteed non-empty.
if (process.env.FAKE_PTY_STREAM_MODE === "steady") {
	let n = 0;
	const timer = setInterval(() => {
		n += 1;
		process.stdout.write(`steady-${n}\n`);
	}, 25);
	timer.unref?.();
}

// "alt": enter the alternate screen once (exactly what a real fullscreen TUI
// does) and keep repainting one line — the attach's headless xterm lands in the
// alternate buffer as long as the enable still sits inside the 100 KB
// screen-log replay window (issue #185's topology).
if (process.env.FAKE_PTY_STREAM_MODE === "alt") {
	process.stdout.write("\x1b[?1049h\x1b[H\x1b[2Kalt-frame-0\r\nalt-frame-0b");
	let n = 0;
	const timer = setInterval(() => {
		n += 1;
		process.stdout.write(`\x1b[H\x1b[2Kalt-frame-${n}\r\nalt-frame-${n}b`);
	}, 25);
	timer.unref?.();
}

// "alt-flood": one-shot alternate-screen entry followed by absolute-positioned
// frame repaints with enough volume to push that enable sequence out of the
// attach's 100 KB replay window — the production topology of issue #198 (a real
// session is almost always older than the window). No newline ever leaves the
// last row, so the attach's buffer gains no scrollback either.
if (process.env.FAKE_PTY_STREAM_MODE === "alt-flood") {
	const rows = Number(process.env.FAKE_PTY_ALT_ROWS ?? 22);
	const frame = (n) => {
		let s = "\x1b[H";
		for (let r = 1; r <= rows; r++) s += `\x1b[${r};1H\x1b[2Kalt-flood-${n}-row-${r}-${"x".repeat(40)}`;
		return s;
	};
	process.stdout.write("\x1b[?1049h" + frame(0));
	let n = 0;
	const timer = setInterval(() => {
		n += 1;
		process.stdout.write(frame(n));
	}, 5);
	timer.unref?.();
}

// "firehose": ~1.1KB mixed chunks (printable + SGR runs + escape noise) every 1ms
// for FAKE_PTY_STREAM_MS (default 3000) — sustained multi-MB/s stress, then a
// done marker so tests know the flood ended.
if (process.env.FAKE_PTY_STREAM_MODE === "firehose") {
	const durationMs = Number(process.env.FAKE_PTY_STREAM_MS ?? 3000);
	const startedAt = Date.now();
	let row = 0;
	const chunk = () => {
		row += 1;
		let s = "";
		for (let i = 0; i < 12; i++) {
			s += `fh-${row}-${i} \x1b[1;32m${"x".repeat(48)}\x1b[0m \x1b[2K\x1b[7m rev \x1b[27m \x1b[1A`;
		}
		return s;
	};
	const timer = setInterval(() => {
		if (Date.now() - startedAt > durationMs) {
			clearInterval(timer);
			process.stdout.write("firehose-done\n");
			return;
		}
		process.stdout.write(chunk());
	}, 1);
	timer.unref?.();
}

// "malformed": broken/partial CSI, dangling OSC, truncated UTF-8, control
// bytes and a stray CSI-intro byte — parser containment probe. Buffers are
// written raw so invalid UTF-8 actually reaches the PTY.
if (process.env.FAKE_PTY_STREAM_MODE === "malformed") {
	const durationMs = Number(process.env.FAKE_PTY_STREAM_MS ?? 2000);
	const startedAt = Date.now();
	const pieces = [
		Buffer.from("\x1b[12;34", "latin1"), // partial CSI, no final byte
		Buffer.from("\x1b]0;dangling-title", "latin1"), // unterminated OSC
		Buffer.from([0xe4, 0xb8]), // truncated 3-byte UTF-8
		Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x9b]), // C0 controls + binary + stray CSI intro
		Buffer.from([0xf0, 0x9f, 0x92]), // truncated 4-byte emoji
		Buffer.from("\x1b[38;2;200;100;", "latin1"), // partial SGR argument
		Buffer.from("\x1bP1;2|~", "latin1"), // partial DCS
	];
	const timer = setInterval(() => {
		if (Date.now() - startedAt > durationMs) {
			clearInterval(timer);
			process.stdout.write(Buffer.from("malformed-done\n"));
			return;
		}
		for (let k = 0; k < 16; k++) process.stdout.write(pieces[(Math.random() * pieces.length) | 0]);
	}, 1);
	timer.unref?.();
}

// "controlled-frames": issue #222 step 15 producer — a scripted, test-only
// fullscreen child for the attach-ready half-frame diagnosis. Selected via
// FAKE_PTY_STREAM_MODE="controlled-frames" with FAKE_PTY_CONTROLLED_SCRIPT =
// plain | same-write | split and a per-trial FAKE_PTY_EVENTS_PATH JSONL log
// (outside the terminal stream). The child owns literal frame identities
// F0/F1/F2 on an 80x22 work area: every screen write uses absolute cursor
// addressing, clears each touched row, and leaves an explicit cursor state
// (DECTCEM hidden, parked right after the INPUT prompt), so wrapping or
// scrollback cannot masquerade as frame identity. Startup seeds one complete
// F0 as a single synchronized frame through actual stdout; afterwards the
// child advances ONLY on framed stdin commands (RS 0x1E + JSON + LF 0x0A):
// {"cmd":"step","step":N} executes script step N strictly in order,
// {"cmd":"exit"} terminates. Bytes outside a frame (e.g. terminal replies)
// and out-of-order/duplicate commands are logged and ignored; control bytes
// are never echoed into the work area. No child-side timer can complete an
// open frame — the integration owner controls every hold. Event times are
// child-clock emission/write-callback facts (process.hrtime.bigint ns with an
// arbitrary origin, plus Date.now wall ms); no common origin with any parent
// clock is claimed. Each stdout write is logged with byte length and sha256
// (plus full hex for tiny fragment writes) so same-write and split-delimiter
// claims can be audited against the exact received byte stream.
if (controlledMode) {
	const scriptName = process.env.FAKE_PTY_CONTROLLED_SCRIPT ?? "";
	const eventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
	const OPEN = "\x1b[?2026h";
	const CLOSE = "\x1b[?2026l";
	const COLS = 80; // documented work-area width; the child never queries the terminal
	const ROWS = 22;
	const CURSOR = { x: 10, y: 21 }; // 0-based park position: cell right after "Fn INPUT >"
	const rowsText = (id) => [
		`${id} HEADER controlled work area`,
		`${id} UPPER reply history one`,
		`${id} UPPER reply history two`,
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		`${id} MIDDLE divider`,
		`${id} LOWER reply history three`,
		`${id} LOWER reply history four`,
		"",
		"",
		"",
		"",
		"",
		"",
		`${id} TAIL assistant final answer`,
		"",
		`${id} INPUT >`,
	];
	// Upper half = rows 0..10, lower half = rows 11..21 (0-based).
	const regionBody = (id, from, to) => {
		const rows = rowsText(id);
		let body = "";
		for (let y = from; y <= to; y++) body += `\x1b[${y + 1};1H\x1b[2K${rows[y]}`;
		return `${body}\x1b[?25l\x1b[${CURSOR.y + 1};${CURSOR.x + 1}H`;
	};
	const upperBody = (id) => regionBody(id, 0, 10);
	const lowerBody = (id) => regionBody(id, 11, 21);
	const OPEN_F1_UPPER = { step: 1, frame: "F1", phase: "open", data: () => `${OPEN}${upperBody("F1")}` };
	// --- step 16 additions (ADDITIVE; the plain/same-write/split contract ---
	// --- above, including every byte, command and event, is unchanged) ------
	//
	// Step 16 (task-16-brief.md) adds three diagnostic scripts backing the
	// A4/A5/T cases. Contract declared BEFORE any consumer:
	//
	// "resize" (A4 geometry): the child's work area is the ACTUAL PTY size,
	// read from process.stdout.columns/rows — never an echo of a commanded
	// target. Every frame write logs dimsUsed {cols, rows, basis} where basis
	// is "live-pty-start" (G0 seed), "stale-seed" (G1: composed from the dims
	// captured at seed time, representing an old/in-flight frame) or
	// "live-pty" (G2: read at composition time, after the real resize). A
	// "pty-resize" event logs the ACTUAL dims observed on every stdout
	// 'resize' (SIGWINCH) event. Frame content is dimension-sensitive: the
	// header row is padded with "." to cols-1 and ends with "#" at the last
	// column; the last row carries `${id} BOTTOM edge INPUT >` plus "#" at
	// the last column; the cursor parks hidden right after the INPUT prompt
	// of the last row. Steps: 1 opens G1 (stale geometry, upper half only),
	// 2 closes G1 (stale geometry), 3 emits G2 as one complete synchronized
	// frame at the live size. The script refuses to start without observable
	// PTY dimensions (exit 3) so a pipe-spawned probe can never be mistaken
	// for a real resize observation.
	//
	// "cold" (A5 cold/empty baseline): NO seed frame — the child is silent
	// until commanded, so the runner baseline is empty. Steps release one
	// declared phase each: 1 emits unframed boot text, 2 enters the
	// alternate screen and enables bracketed paste (raw/input-mode enable;
	// no editor content), 3 opens a framed E1 editor and paints only its
	// upper half (an incomplete framed pre-editor/editor state), 4 paints
	// the lower half and closes E1. E1 is the literal 80x22 editor contract
	// below (TAIL at row 19, INPUT at row 21, hidden cursor at (10,21)).
	//
	// "theme" (T-on-time/T-late): seeds one complete T0 at 80x22 with the
	// alternate screen AND bracketed paste enabled in the same write (so the
	// attach's live-bytes input-readiness scan can observe it). The child
	// then watches NON-command stdin bytes for a real color-scheme report
	// (CSI ? 997 ; 1|2 n): each report logs a "theme-report" event (scheme
	// dark/light) and queues one complete synchronized repaint T<n> whose
	// row 18 reads `${id} THEME <scheme> applied`. Non-report noise is still
	// logged as ignored input exactly like the other scripts.
	const geometryCursor = (id, rows) => ({ x: `${id} BOTTOM edge INPUT >`.length, y: rows - 1 });
	const geometryRowsText = (id, cols, rows) => {
		const out = Array.from({ length: rows }, () => "");
		out[0] = `${id} HEADER geometry ${cols}x${rows}`.padEnd(cols - 1, ".") + "#";
		out[1] = `${id} UPPER reply history one`;
		out[2] = `${id} UPPER reply history two`;
		out[rows - 3] = `${id} TAIL assistant final answer`;
		out[rows - 1] = `${id} BOTTOM edge INPUT >`.padEnd(cols - 1, " ") + "#";
		return out;
	};
	const geometryRegionBody = (id, cols, rows, from, to) => {
		const rowsText2 = geometryRowsText(id, cols, rows);
		let body = "";
		for (let y = from; y <= to; y++) body += `\x1b[${y + 1};1H\x1b[2K${rowsText2[y]}`;
		const cursor = geometryCursor(id, rows);
		return `${body}\x1b[?25l\x1b[${cursor.y + 1};${cursor.x + 1}H`;
	};
	const livePtyDims = () => ({
		cols: typeof process.stdout.columns === "number" ? process.stdout.columns : null,
		rows: typeof process.stdout.rows === "number" ? process.stdout.rows : null,
	});
	// 22 rows, same layout contract as rowsText: TAIL at index 19, INPUT at
	// index 21 (P16-DRAFT-ROWS: an earlier 21-row draft shifted TAIL/INPUT up
	// one row and interpolated undefined into row 21; the step-16 cold
	// contract regression pins the full 22-row shape).
	const editorRowsText = (id) => [
		`${id} HEADER controlled cold editor`,
		`${id} UPPER reply history one`,
		`${id} UPPER reply history two`,
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		`${id} MIDDLE divider`,
		`${id} LOWER reply history three`,
		`${id} LOWER reply history four`,
		"",
		"",
		"",
		"",
		"",
		"",
		`${id} TAIL assistant final answer`,
		"",
		`${id} INPUT >`,
	];
	const editorRegionBody = (id, from, to) => {
		const rows2 = editorRowsText(id);
		let body = "";
		for (let y = from; y <= to; y++) body += `\x1b[${y + 1};1H\x1b[2K${rows2[y]}`;
		return `${body}\x1b[?25l\x1b[${CURSOR.y + 1};${CURSOR.x + 1}H`;
	};
	const themeRowsText = (id, label) => {
		const rows2 = rowsText(id).slice();
		rows2[0] = `${id} HEADER theme surface`;
		rows2[18] = `${id} THEME ${label}`;
		return rows2;
	};
	const themeRegionBody = (id, label, from, to) => {
		const rows2 = themeRowsText(id, label);
		let body = "";
		for (let y = from; y <= to; y++) body += `\x1b[${y + 1};1H\x1b[2K${rows2[y]}`;
		return `${body}\x1b[?25l\x1b[${CURSOR.y + 1};${CURSOR.x + 1}H`;
	};
	const SCRIPTS = {
		plain: {
			steps: [
				OPEN_F1_UPPER,
				{ step: 2, frame: "F1", phase: "closed", data: () => `${lowerBody("F1")}${CLOSE}` },
			],
		},
		"same-write": {
			steps: [
				OPEN_F1_UPPER,
				{ step: 2, frame: "F1>F2", phase: "close-open", data: () => `${lowerBody("F1")}${CLOSE}${OPEN}${upperBody("F2")}` },
				{ step: 3, frame: "F2", phase: "closed", data: () => `${lowerBody("F2")}${CLOSE}` },
			],
		},
		split: {
			steps: [
				{ step: 1, frame: "F1", phase: "open-fragment-1", data: () => "\x1b[?202" },
				{ step: 2, frame: "F1", phase: "open", data: () => `6h${upperBody("F1")}` },
				{ step: 3, frame: "F1", phase: "close-fragment-1", data: () => `${lowerBody("F1")}\x1b[?202` },
				{ step: 4, frame: "F1", phase: "closed", data: () => "6l" },
			],
		},
		resize: {
			geometry: true,
			steps: [
				{
					step: 1,
					frame: "G1",
					phase: "open-stale",
					data: () => `${OPEN}${geometryRegionBody("G1", seedDims.cols, seedDims.rows, 0, Math.floor(seedDims.rows / 2) - 1)}`,
					dimsUsed: () => ({ cols: seedDims.cols, rows: seedDims.rows, basis: "stale-seed" }),
				},
				{
					step: 2,
					frame: "G1",
					phase: "closed-stale",
					data: () => `${geometryRegionBody("G1", seedDims.cols, seedDims.rows, Math.floor(seedDims.rows / 2), seedDims.rows - 1)}${CLOSE}`,
					dimsUsed: () => ({ cols: seedDims.cols, rows: seedDims.rows, basis: "stale-seed" }),
				},
				{
					step: 3,
					frame: "G2",
					phase: "closed-live",
					data: () => {
						g2Dims = livePtyDims();
						return `${OPEN}${geometryRegionBody("G2", g2Dims.cols, g2Dims.rows, 0, g2Dims.rows - 1)}${CLOSE}`;
					},
					dimsUsed: () => ({ cols: g2Dims.cols, rows: g2Dims.rows, basis: "live-pty" }),
				},
			],
		},
		cold: {
			seed: "none",
			steps: [
				{ step: 1, frame: "BOOT", phase: "boot", data: () => "fake pi boot: core ready\r\nfake pi boot: extensions loaded\r\n" },
				{ step: 2, frame: "MODES", phase: "input-mode", data: () => "\x1b[?1049h\x1b[?2004h" },
				{ step: 3, frame: "E1", phase: "open", data: () => `${OPEN}${editorRegionBody("E1", 0, 10)}` },
				{ step: 4, frame: "E1", phase: "closed", data: () => `${editorRegionBody("E1", 11, 21)}${CLOSE}` },
			],
		},
		theme: {
			seed: "theme",
			themeRepaint: true,
			steps: [],
		},
	};
	// P15-CONFIG-1: only OWN declared script names are valid — inherited
	// Object.prototype keys (toString, constructor, __proto__, ...) must be
	// rejected like any unknown name.
	const script = Object.hasOwn(SCRIPTS, scriptName) ? SCRIPTS[scriptName] : undefined;
	if (!script) {
		process.stderr.write(`controlled-frames: unknown FAKE_PTY_CONTROLLED_SCRIPT ${JSON.stringify(scriptName)}\n`);
		process.exit(2);
	}
	if (!eventsPath) {
		process.stderr.write("controlled-frames: FAKE_PTY_EVENTS_PATH is required\n");
		process.exit(2);
	}
	// The A4 geometry script attests REAL PTY dimensions; without an
	// observable size (e.g. plain pipes) there is nothing honest to report.
	if (script.geometry && (typeof process.stdout.columns !== "number" || typeof process.stdout.rows !== "number")) {
		process.stderr.write("controlled-frames: resize script requires a real PTY with observable dimensions (process.stdout.columns/rows missing)\n");
		process.exit(3);
	}
	const seedDims = script.geometry ? livePtyDims() : null;
	let g2Dims = null;
	const clockNow = () => ({ monoNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
	const logEvent = (event) => {
		appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
	};
	logEvent({
		event: "start",
		script: scriptName,
		pid: process.pid,
		cols: COLS,
		rows: ROWS,
		protocol: 'RS(0x1E) + JSON + LF(0x0A); commands: {"cmd":"step","step":N} strictly in order, {"cmd":"exit"}',
		clock: {
			mono: "process.hrtime.bigint (ns, arbitrary origin)",
			wall: "Date.now (ms)",
			note: "child clock has no proven common origin with any parent clock; timings are emission/write-callback facts only",
		},
		// Geometry scripts only: the ACTUAL PTY size observed at start
		// (process.stdout.columns/rows), never a commanded value.
		...(script.geometry ? { ptyDims: seedDims, ptyDimsSource: "process.stdout.columns/rows at child start" } : {}),
		...clockNow(),
	});
	if (script.geometry) {
		// A4: every REAL PTY resize (SIGWINCH) is logged with the dims the OS
		// actually reports afterwards — the child-side observation the
		// production resize ack can never provide.
		process.stdout.on("resize", () => {
			logEvent({ event: "pty-resize", cols: process.stdout.columns ?? null, rows: process.stdout.rows ?? null, ...clockNow() });
		});
	}
	let writeIndex = 0;
	const performWrite = (record, done) => {
		const data = record.data();
		const index = writeIndex;
		writeIndex += 1;
		const bytes = Buffer.byteLength(data, "utf8");
		const event = {
			event: "stdout-write",
			script: scriptName,
			step: record.step,
			frame: record.frame,
			phase: record.phase,
			writeIndex: index,
			bytes,
			sha256: createHash("sha256").update(data, "utf8").digest("hex"),
			...clockNow(),
		};
		// Geometry scripts only: which dimensions THIS frame was composed at,
		// with an honest basis label (stale-seed vs live-pty). Old scripts carry
		// no dimsUsed field at all — their event shape is unchanged.
		if (record.dimsUsed) event.dimsUsed = record.dimsUsed();
		if (bytes <= 32) event.dataHex = Buffer.from(data, "utf8").toString("hex");
		logEvent(event); // emission fact, recorded before the write call
		process.stdout.write(data, () => {
			logEvent({ event: "stdout-write-flushed", writeIndex: index, ...clockNow() }); // write-callback fact
			done();
		});
	};
	// Commands execute one at a time; the next command is handled only after
	// the previous write's callback fired, so writes never overlap and the
	// event log stays ordered.
	const queue = [];
	let busy = false;
	let nextStep = 1;
	let themeSeq = 0;
	const drain = () => {
		if (busy) return;
		const cmd = queue.shift();
		if (!cmd) return;
		busy = true;
		if (cmd.cmd === "exit") {
			logEvent({ event: "exit", ...clockNow() });
			// Flush pending stdout before exiting so the byte stream and the
			// event log stay complete and ordered even for coalesced input.
			process.stdout.write("", () => process.exit(0));
			return;
		}
		if (cmd.cmd === "theme-repaint") {
			// T: the child-originated color-scheme redraw — one complete
			// synchronized frame at the fixed 80x22 theme surface, triggered by
			// the real 997 report (not by a framed step command).
			themeSeq += 1;
			const id = `T${themeSeq}`;
			performWrite(
				{ step: "theme", frame: id, phase: "theme-repaint", data: () => `${OPEN}${themeRegionBody(id, `${cmd.scheme} applied`, 0, ROWS - 1)}${CLOSE}` },
				() => {
					busy = false;
					drain();
				},
			);
			return;
		}
		performWrite(script.steps[cmd.step - 1], () => {
			busy = false;
			drain();
		});
	};
	const handleRawCommand = (raw) => {
		let cmd;
		try {
			cmd = JSON.parse(raw);
		} catch {
			cmd = null;
		}
		const validStep = cmd !== null && typeof cmd === "object" && cmd.cmd === "step" && Number.isInteger(cmd.step);
		const validExit = cmd !== null && typeof cmd === "object" && cmd.cmd === "exit";
		if ((validStep && cmd.step === nextStep && cmd.step <= script.steps.length) || validExit) {
			if (validStep) nextStep += 1;
			logEvent({ event: "command", ...(validStep ? { step: cmd.step } : {}), raw, ...clockNow() });
			queue.push(cmd);
			drain();
		} else {
			logEvent({ event: "command-rejected", raw, expectedStep: nextStep, ...clockNow() });
		}
	};
	const logIgnored = (noise) => {
		logEvent({
			event: "input-ignored",
			bytes: Buffer.byteLength(noise, "utf8"),
			sha256: createHash("sha256").update(noise, "utf8").digest("hex"),
			...clockNow(),
		});
	};
	// T scripts: non-command stdin bytes may carry a real color-scheme report
	// (CSI ? 997 ; 1|2 n) delivered by the attach bridge. Each report is
	// logged and triggers one child-originated repaint through the normal
	// serialized write queue. All noise is still logged as ignored input; for
	// non-theme scripts this wrapper is exactly logIgnored.
	const handleNoise = (noise) => {
		if (script.themeRepaint) {
			for (const match of noise.matchAll(/\x1b\[\?997;([12])n/g)) {
				const scheme = match[1] === "1" ? "dark" : "light";
				logEvent({ event: "theme-report", scheme, ...clockNow() });
				queue.push({ cmd: "theme-repaint", scheme });
			}
			drain();
		}
		logIgnored(noise);
	};
	let inputBuffer = "";
	process.stdin.on("data", (chunk) => {
		inputBuffer += chunk.toString();
		for (;;) {
			const start = inputBuffer.indexOf("\x1e");
			if (start === -1) {
				if (inputBuffer.length > 0) {
					handleNoise(inputBuffer);
					inputBuffer = "";
				}
				break;
			}
			if (start > 0) {
				handleNoise(inputBuffer.slice(0, start));
				inputBuffer = inputBuffer.slice(start);
			}
			const end = inputBuffer.indexOf("\n", 1);
			if (end === -1) break;
			const raw = inputBuffer.slice(1, end);
			inputBuffer = inputBuffer.slice(end + 1);
			handleRawCommand(raw);
		}
	});
	// Seed through actual stdout before any command runs; commands received
	// while the seed flush is pending stay queued. Old scripts seed the
	// complete F0 frame (byte-identical to step 15). Step-16 scripts declare
	// their own seed: "theme" seeds T0 WITH bracketed-paste enabled (the
	// attach's live-bytes input-readiness scan must be able to observe it),
	// geometry scripts seed G0 at the ACTUAL start size, and "cold" seeds
	// nothing (an empty authoritative baseline is the whole point of A5).
	const seedRecord =
		script.seed === "none"
			? null
			: script.seed === "theme"
				? { step: 0, frame: "T0", phase: "seed", data: () => `\x1b[?1049h\x1b[?2004h${OPEN}${themeRegionBody("T0", "pending", 0, ROWS - 1)}${CLOSE}` }
				: script.geometry
					? {
							step: 0,
							frame: "G0",
							phase: "seed",
							data: () => `\x1b[?1049h${OPEN}${geometryRegionBody("G0", seedDims.cols, seedDims.rows, 0, seedDims.rows - 1)}${CLOSE}`,
							dimsUsed: () => ({ cols: seedDims.cols, rows: seedDims.rows, basis: "live-pty-start" }),
						}
					: { step: 0, frame: "F0", phase: "seed", data: () => `\x1b[?1049h${OPEN}${regionBody("F0", 0, ROWS - 1)}${CLOSE}` };
	busy = true;
	if (seedRecord) {
		performWrite(seedRecord, () => {
			busy = false;
			drain();
		});
	} else {
		busy = false;
	}
}

if (process.env.FAKE_PTY_ARGV_CAPTURE_PATH) {
	try {
		appendFileSync(process.env.FAKE_PTY_ARGV_CAPTURE_PATH, `${process.argv.at(-1) ?? ""}`);
	} catch {}
}
if (process.env.FAKE_PTY_ENV_CAPTURE_PATH) {
	try {
		appendFileSync(process.env.FAKE_PTY_ENV_CAPTURE_PATH, `${process.env.AGENT_BOARD_CONTROL_SOCKET ?? ""}\n`);
	} catch {}
}
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
// Step-16 A5 (cold script ONLY): observe the ACTUAL stdin raw state AFTER the
// shared startup setRawMode above — raw mode is already true before any
// command phase, so the cold step-2 bytes (alt-screen + bracketed paste) are
// NOT an OS raw transition. nextTick keeps this after the synchronous start
// event. Under non-TTY stdin isRaw is unavailable and stays null (unknown);
// every other script's events/bytes are unchanged.
if (process.env.FAKE_PTY_STREAM_MODE === "controlled-frames" && process.env.FAKE_PTY_CONTROLLED_SCRIPT === "cold") {
	process.nextTick(() => {
		try {
			appendFileSync(
				process.env.FAKE_PTY_EVENTS_PATH ?? "",
				`${JSON.stringify({
					event: "stdin-raw-at-start",
					isRaw: typeof process.stdin.isRaw === "boolean" ? process.stdin.isRaw : null,
					note: "actual process.stdin.isRaw after the shared footer's startup setRawMode(true); null under non-TTY stdin",
					monoNs: process.hrtime.bigint().toString(),
					wallMs: Date.now(),
				})}\n`,
			);
		} catch {
			/* best-effort observation only */
		}
	});
}
// The controlled-frames mode registered its own framed-command stdin handler
// above; the boot/echo handler below serves every other (default) mode.
if (!controlledMode) {
	process.stdin.on("data", (chunk) => {
		const text = chunk.toString();
		const visible = text
			.replace(/\x1b\[200~/g, "<BP>")
			.replace(/\x1b\[201~/g, "<EP>")
			.replace(/\r/g, "<CR>")
			.replace(/\n/g, "<NL>");
		process.stdout.write(`echo:${visible}\n`);
		// "burst": emit FAKE_PTY_BURST_LINES numbered lines through a setImmediate
		// chain — a multi-chunk stream arriving over several ms, so a snapshot
		// capture started mid-burst has chunks land inside its window.
		if (text.includes("burst")) {
			const burstLines = Number(process.env.FAKE_PTY_BURST_LINES ?? 200);
			let i = 0;
			const step = () => {
				if (i >= burstLines) return;
				i += 1;
				process.stdout.write(`burstline-${String(i).padStart(4, "0")}-${"p".repeat(28)}\n`);
				setImmediate(step);
			};
			step();
		}
		if (text.includes("exit")) process.exit(0);
	});
}
setInterval(() => {}, 1000);
