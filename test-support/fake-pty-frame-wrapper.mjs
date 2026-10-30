#!/usr/bin/env node
// Issue #222 step 24: opt-in frame-witness wrapper around an accepted child.
// It forwards stdin/stdout byte-for-byte except for adding S immediately before
// each complete synchronized frame's OPEN and F immediately after its CLOSE.
// Until the real reporter token exists it buffers child output, so a pre-attach
// seed frame is still the first proven frame. No token -> no markers and no
// buffering once the wrapper has started. The child path/token are explicit env
// values; the wrapped child source remains byte-identical.
import { spawn } from "node:child_process";
import { spawn as spawnPty } from "node-pty";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OPEN = "\x1b[?2026h";
const CLOSE = "\x1b[?2026l";
const geometryMode = process.env.FAKE_PTY_FRAME_GEOMETRY === "1";
const childEventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
const innerPath = process.env.FAKE_PTY_FRAME_CHILD_PATH || fileURLToPath(new URL("./fake-pty-pi.mjs", import.meta.url));
const tokenPath = process.env.FAKE_PTY_FRAME_TOKEN ?? "";
process.stdin.setRawMode?.(true);
const inner = geometryMode
	? spawnPty(process.execPath, [innerPath], {
		name: "xterm-256color",
		cols: typeof process.stdout.columns === "number" ? process.stdout.columns : 80,
		rows: typeof process.stdout.rows === "number" ? process.stdout.rows : 24,
		env: process.env,
	})
	: spawn(process.execPath, [innerPath], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
const readToken = () => {
	try { return readFileSync(tokenPath, "utf8").trim(); } catch { return ""; }
};
const marker = (kind, frameId, extra) => `\x1bP> agent-board-frame/1 ; ${readToken()} ; ${kind} ; ${frameId} ; ${extra}\x1b\\`;
const fixedMetadata = {
	protocol: 1,
	cols: 80,
	rows: 22,
	mode: "fullscreen",
	rendererEpoch: 1,
	sessionEpoch: 1,
	focusPresent: true,
	overlayPresent: false,
	intentId: 0,
	geometryRevision: 0,
};
const currentGeometry = () => {
	if (!geometryMode) return { ...fixedMetadata };
	try {
		const events = readFileSync(childEventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const write = [...events].reverse().find((event) => event.event === "stdout-write" && event.dimsUsed);
		if (!write) return { ...fixedMetadata };
		const dims = write.dimsUsed;
		const live = dims.basis === "live-pty";
		return {
			...fixedMetadata,
			cols: typeof dims.cols === "number" ? dims.cols : fixedMetadata.cols,
			rows: typeof dims.rows === "number" ? dims.rows : fixedMetadata.rows,
			geometryRevision: live ? 1 : 0,
			intentId: live ? 1 : 0,
		};
	} catch {
		return { ...fixedMetadata };
	}
};
let frameMetadata = fixedMetadata;
let frameId = 0;
let carry = "";
let tokenReady = tokenPath === "" || readToken() !== "";
let stdinCarry = "";

const suffixPrefix = (text) => {
	let best = 0;
	for (const sequence of [OPEN, CLOSE]) {
		const max = Math.min(sequence.length - 1, text.length);
		for (let length = max; length > 0; length -= 1) {
			if (text.endsWith(sequence.slice(0, length))) {
				best = Math.max(best, length);
				break;
			}
		}
	}
	return best;
};

const transform = (data) => {
	if (!tokenReady) {
		carry += data;
		return;
	}
	carry += data;
	const out = [];
	for (;;) {
		const openAt = carry.indexOf(OPEN);
		const closeAt = carry.indexOf(CLOSE);
		const at = openAt === -1 ? closeAt : closeAt === -1 ? openAt : Math.min(openAt, closeAt);
		if (at === -1) {
			const hold = suffixPrefix(carry);
			const emit = hold === 0 ? carry : carry.slice(0, -hold);
			if (emit.length > 0) out.push(emit);
			carry = hold === 0 ? "" : carry.slice(-hold);
			break;
		}
		if (at > 0) out.push(carry.slice(0, at));
		const sequence = openAt !== -1 && openAt === at ? OPEN : CLOSE;
		carry = carry.slice(at + sequence.length);
		if (sequence === OPEN) {
			frameId += 1;
			frameMetadata = currentGeometry();
			out.push(marker("S", frameId, "0 ; 80"), OPEN);
		} else {
			out.push(CLOSE, marker("F", frameId, Buffer.from(JSON.stringify(frameMetadata)).toString("base64url")));
		}
	}
	if (out.length > 0) process.stdout.write(out.join(""));
};

const tokenTimer = setInterval(() => {
	if (tokenReady) {
		clearInterval(tokenTimer);
		return;
	}
	if (readToken() === "") return;
	tokenReady = true;
	clearInterval(tokenTimer);
	transform("");
}, 20);
tokenTimer.unref?.();

const onInnerData = (chunk) => transform(chunk.toString());
if (geometryMode) {
	inner.onData(onInnerData);
	process.stdout.on("resize", () => {
		const cols = process.stdout.columns;
		const rows = process.stdout.rows;
		if (typeof cols === "number" && typeof rows === "number") inner.resize(cols, rows);
	});
	inner.onExit(({ exitCode }) => {
		if (tokenReady && carry.length > 0) process.stdout.write(carry);
		process.exit(exitCode ?? 0);
	});
} else {
	inner.stdout.on("data", onInnerData);
	inner.on("exit", (code) => {
		if (tokenReady && carry.length > 0) process.stdout.write(carry);
		process.exit(code ?? 0);
	});
	inner.on("error", (error) => {
		process.stderr.write(`frame wrapper child error: ${error.message}\n`);
		process.exit(1);
	});
}

const writeInner = (data) => {
	if (geometryMode) inner.write(data);
	else inner.stdin.write(data);
};
process.stdin.on("data", (chunk) => {
	stdinCarry += chunk.toString();
	for (;;) {
		const start = stdinCarry.indexOf("\x1e");
		if (start === -1) {
			if (stdinCarry.length > 0) writeInner(stdinCarry);
			stdinCarry = "";
			break;
		}
		if (start > 0) {
			writeInner(stdinCarry.slice(0, start));
			stdinCarry = stdinCarry.slice(start);
		}
		const end = stdinCarry.indexOf("\n", 1);
		if (end === -1) break;
		writeInner(stdinCarry.slice(0, end + 1));
		stdinCarry = stdinCarry.slice(end + 1);
	}
});
