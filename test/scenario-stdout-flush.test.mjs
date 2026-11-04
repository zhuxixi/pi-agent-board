import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { writeThenExit } from "../test-support/stdout-flush.mjs";

/** Minimal stand-in for a writable: records bytes, then either calls back or fails. */
class FakeStream extends EventEmitter {
	constructor({ failSync = false } = {}) {
		super();
		this.written = "";
		this.failSync = failSync;
	}

	write(text, callback) {
		if (this.failSync) throw new Error("write failed synchronously");
		this.written += text;
		this.callback = callback;
		return true;
	}
}

test("stdout-flush: exit runs once after the write callback fires", () => {
	const stream = new FakeStream();
	const exits = [];
	writeThenExit(stream, "payload\n", 0, (code) => exits.push(code));
	assert.equal(stream.written, "payload\n");
	assert.deepEqual(exits, [], "exit must wait for the write callback");
	stream.callback();
	assert.deepEqual(exits, [0]);
});

test("stdout-flush: a broken pipe still exits with the caller's code, exactly once", () => {
	const stream = new FakeStream();
	const exits = [];
	writeThenExit(stream, "payload\n", 3, (code) => exits.push(code));
	stream.emit("error", new Error("EPIPE"));
	stream.callback();
	assert.deepEqual(exits, [3], "the error path exits once and the late callback is ignored");
});

test("stdout-flush: a synchronous write throw still exits with the caller's code", () => {
	const stream = new FakeStream({ failSync: true });
	const exits = [];
	writeThenExit(stream, "payload\n", 1, (code) => exits.push(code));
	assert.deepEqual(exits, [1]);
});

const PROBE = fileURLToPath(new URL("../test-support/stdout-flush-probe.mjs", import.meta.url));

/**
 * Spawn the probe with stdout on a pipe and attach the reader only after
 * `delayMs`. While nobody reads, the kernel pipe buffer (64 KiB) fills and the
 * child's write goes pending — the exact condition that truncated issue #270.
 * The delay is not a timing assertion: the 256 KiB payload cannot fit either way.
 */
function runProbeWithSlowReader(bytes, delayMs = 250) {
	return new Promise((settle, fail) => {
		const child = spawn(process.execPath, [PROBE, "--bytes", String(bytes)], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks = [];
		let stderr = "";
		// No stdout listener yet: the stream stays paused, nobody reads the pipe,
		// and the kernel buffer (64 KiB) fills — the issue #270 condition. Do NOT
		// add `child.stdout.pause()` here: an explicit pause() sets flowing = false
		// and the delayed `.on("data")` below would never resume the stream.
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", fail);
		child.on("close", (code) => settle({ code, stdout: Buffer.concat(chunks).toString("utf8"), stderr }));
		setTimeout(() => child.stdout.on("data", (chunk) => chunks.push(chunk)), delayMs).unref();
	});
}

test("stdout-flush: a 256 KiB result survives a reader that starts late", async () => {
	const result = await runProbeWithSlowReader(262144);
	assert.equal(result.code, 0, `probe must exit 0; stderr:\n${result.stderr}`);
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.payload.length, 262144, "every byte of the payload must reach the reader");
});

const TEST_SUPPORT_ROOT = fileURLToPath(new URL("../test-support/", import.meta.url));

const isPropertyAccessOn = (node, name, receiver) =>
	ts.isPropertyAccessExpression(node) && node.name.text === name && receiver(node.expression);
const isProcessIdentifier = (node) => ts.isIdentifier(node) && node.text === "process";
const isStdoutReceiver = (node) => isPropertyAccessOn(node, "stdout", isProcessIdentifier);
const isCallStatement = (statement, property, receiver) =>
	ts.isExpressionStatement(statement) &&
	ts.isCallExpression(statement.expression) &&
	isPropertyAccessOn(statement.expression.expression, property, receiver);
const writesStdout = (statement) => isCallStatement(statement, "write", isStdoutReceiver);
const exitsProcess = (statement) => isCallStatement(statement, "exit", isProcessIdentifier);

/** Unwrap `if`/block so `if (ready) process.stdout.write(x)` counts as a write. */
function containsStatement(statement, predicate) {
	if (predicate(statement)) return true;
	if (ts.isIfStatement(statement)) {
		return containsStatement(statement.thenStatement, predicate) ||
			(statement.elseStatement !== undefined && containsStatement(statement.elseStatement, predicate));
	}
	if (ts.isBlock(statement)) return statement.statements.some((child) => containsStatement(child, predicate));
	return false;
}

/**
 * List every statement pair where one writes `process.stdout` and the next one
 * calls `process.exit`. `console.*` is deliberately not matched: those payloads
 * are short human-readable lines, and the spec keeps them out of scope.
 * A write inside `try` with the exit in `finally` is not covered.
 */
export function findUnguardedStdoutExits(sourceText, fileName) {
	const file = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
	const found = [];
	const visit = (node) => {
		if (node.statements !== undefined) {
			for (let index = 0; index + 1 < node.statements.length; index += 1) {
				const previous = node.statements[index];
				const next = node.statements[index + 1];
				// Two sibling conditionals are independent paths, never one drain-then-exit
				// sequence: `if (dryRun) { write; exit; } if (guard) { …; exit(2); }` would
				// otherwise pair the two outer ifs. A real pair inside their blocks is found
				// by the recursion into each block.
				if (ts.isIfStatement(previous) && ts.isIfStatement(next)) continue;
				if (containsStatement(previous, writesStdout) && containsStatement(next, exitsProcess)) {
					const { line } = file.getLineAndCharacterOfPosition(previous.getStart(file));
					found.push({ file: fileName, line: line + 1 });
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

function testSupportFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...testSupportFiles(path));
		else if (/\.(ts|mjs|js)$/.test(entry.name)) files.push(path);
	}
	return files;
}

test("stdout-flush: the detector flags the shape and accepts the guards", () => {
	const violations = [
		["plain write then exit", `process.stdout.write("x");\nprocess.exit(0);`],
		["conditional write then exit", `if (ready) process.stdout.write(carry);\nprocess.exit(1);`],
		["block-wrapped write then exit", `if (ready) { process.stdout.write(token); }\nprocess.exit(0);`],
	];
	for (const [label, source] of violations) {
		assert.equal(findUnguardedStdoutExits(source, "sample.mjs").length, 1, `must flag: ${label}`);
	}
	const accepted = [
		["write with an exit callback", `process.stdout.write("x", () => process.exit(0));`],
		["shared helper", `exitAfterStdout("x", 0);`],
		["console.log then exit", `console.log("x");\nprocess.exit(0);`],
		["then writes, catch exits", `run().then((r) => { process.stdout.write(JSON.stringify(r)); }).catch(() => { process.exit(1); });`],
		["sibling conditionals never pair", `if (dryRun) { process.stdout.write("x"); }\nif (approved !== "1") { process.exit(2); }`],
		["flush, then conditional helper exit", `process.stdout.write("echo:hi\\n");\nif (exiting) exitAfterStdout("", 0);`],
	];
	for (const [label, source] of accepted) {
		assert.deepEqual(findUnguardedStdoutExits(source, "sample.mjs"), [], `must accept: ${label}`);
	}
});

test("stdout-flush: no test-support file writes stdout immediately before process.exit", () => {
	const offenders = [];
	for (const path of testSupportFiles(TEST_SUPPORT_ROOT)) {
		offenders.push(...findUnguardedStdoutExits(readFileSync(path, "utf8"), relative(TEST_SUPPORT_ROOT, path)));
	}
	assert.deepEqual(
		offenders,
		[],
		`write-then-exit must go through exitAfterStdout():\n${offenders.map((entry) => `${entry.file}:${entry.line}`).join("\n")}`,
	);
});
