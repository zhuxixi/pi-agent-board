#!/usr/bin/env node
// Issue #222 step 23b2c3b (C fixture ONLY): a thin marker wrapper around the
// accepted controlled-frames child. It forwards stdin/stdout byte-for-byte so
// the accepted cold topology (BOOT, raw-mode, partial E1, child events, exact
// final literal/cursor) is unchanged. Only a framed step 4 gets an opt-in
// S marker immediately before the child's final complete-editor chunk and an
// F marker immediately after its CLOSE. BOOT, raw-mode and the partial E1
// stage therefore never carry a candidate/proof. The marker token comes from
// the real reporter handshake file written by the scenario and is used only to
// form markers, which the runner strips before canonical xterm/screenLog/outer output.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tokenPath = process.env.FAKE_PTY_C_FRAME_TOKEN ?? "";
const childPath = fileURLToPath(new URL("./fake-pty-pi.mjs", import.meta.url));
process.stdin.setRawMode?.(true);
const inner = spawn(process.execPath, [childPath], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
const marker = (kind, extra) => `\x1bP> agent-board-frame/1 ; ${readToken()} ; ${kind} ; 1 ; ${extra}\x1b\\`;
const metadata = Buffer.from(JSON.stringify({
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
})).toString("base64url");
const readToken = () => {
	try { return readFileSync(tokenPath, "utf8").trim(); } catch { return ""; }
};
let awaitingClose = false;
let tail = "";
let stdinCarry = "";

process.stdin.on("data", (chunk) => {
	stdinCarry += chunk.toString();
	for (;;) {
		const start = stdinCarry.indexOf("\x1e");
		if (start === -1) {
			if (stdinCarry.length > 0) {
				inner.stdin.write(stdinCarry);
				stdinCarry = "";
			}
			break;
		}
		if (start > 0) {
			inner.stdin.write(stdinCarry.slice(0, start));
			stdinCarry = stdinCarry.slice(start);
		}
		const end = stdinCarry.indexOf("\n", 1);
		if (end === -1) break;
		const raw = stdinCarry.slice(1, end);
		const frame = stdinCarry.slice(0, end + 1);
		stdinCarry = stdinCarry.slice(end + 1);
		let command = null;
		try { command = JSON.parse(raw); } catch { /* pass through non-command protocol bytes */ }
		if (command?.cmd === "step" && command.step === 4 && readToken() !== "") {
			awaitingClose = true;
			process.stdout.write(marker("S", "0 ; 80"));
		}
		inner.stdin.write(frame);
	}
});

inner.stdout.on("data", (chunk) => {
	process.stdout.write(chunk);
	if (!awaitingClose) return;
	tail = (tail + chunk.toString()).slice(-32);
	if (tail.includes("\x1b[?2026l")) {
		awaitingClose = false;
		tail = "";
		process.stdout.write(marker("F", metadata));
		process.stdout.write("\x1b[?25l");
	}
});

inner.on("exit", (code) => process.exit(code ?? 0));
inner.on("error", (error) => {
	process.stderr.write(`C frame wrapper child error: ${error.message}\n`);
	process.exit(1);
});
