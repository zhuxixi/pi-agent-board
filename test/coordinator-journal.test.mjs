import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	appendCommand,
	defaultJournalFs,
	findProcessedCommand,
	gcJournal,
	journalPath,
	readCheckpoint,
	readJournal,
	writeCheckpoint,
} from "../src/core/coordinator-journal.mjs";

function freshDir() {
	return mkdtempSync(join(tmpdir(), "agent-board-coordinator-journal-"));
}

/** @param {string} commandId @param {number} revision @param {number} at */
function record(commandId, revision, at) {
	return {
		command: {
			type: "state_command",
			commandId,
			viewId: "v1",
			runId: "r1",
			source: "state-runner",
			expectedRevision: null,
			kind: "auto_state_classified",
			payload: { classification: { classifiedAt: at } },
		},
		result: { status: "applied", reason: commandId },
		materializedRevision: revision,
		at,
	};
}

test("append + read round-trips records with increasing revisions", () => {
	const dir = freshDir();
	try {
		appendCommand(dir, record("cmd-1", 1, 100));
		appendCommand(dir, record("cmd-2", 2, 200));
		appendCommand(dir, record("cmd-3", 3, 300));

		const entries = readJournal(dir);
		assert.deepEqual(
			entries.map((entry) => entry.materializedRevision),
			[1, 2, 3],
		);
		assert.equal(entries[0].command.commandId, "cmd-1");
		assert.equal(entries[2].result.status, "applied");
		assert.equal(journalPath(dir), join(dir, "state-journal.jsonl"));
		// JSONL: every record ends with a newline so appends never glue together.
		assert.equal(readFileSync(journalPath(dir), "utf8").endsWith("\n"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("appendCommand fsyncs each record before returning", () => {
	const dir = freshDir();
	let fsyncs = 0;
	const countingFs = {
		...defaultJournalFs,
		fsyncSync() {
			fsyncs += 1;
			return defaultJournalFs.fsyncSync(...arguments);
		},
	};
	try {
		appendCommand(dir, record("cmd-1", 1, 100), countingFs);
		appendCommand(dir, record("cmd-2", 2, 200), countingFs);
		assert.equal(fsyncs, 2);
		assert.equal(readJournal(dir).length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("appendCommand creates missing root directories", () => {
	const dir = freshDir();
	try {
		const nested = join(dir, "views", "v1");
		appendCommand(nested, record("cmd-1", 1, 100));
		assert.equal(readJournal(nested).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("findProcessedCommand returns the original result for a processed commandId", () => {
	const dir = freshDir();
	try {
		appendCommand(dir, record("cmd-1", 1, 100));
		appendCommand(dir, record("cmd-2", 2, 200));
		const result = findProcessedCommand(dir, "cmd-1");
		assert.deepEqual(result, { status: "applied", reason: "cmd-1" });
		assert.equal(findProcessedCommand(dir, "cmd-missing"), null);

		// Duplicates must not happen (coordinator checks before applying), but if
		// they do, the FIRST result is the original one.
		const duplicate = { ...record("cmd-1", 9, 900), result: { status: "rejected", reason: "manual_fence" } };
		appendCommand(dir, duplicate);
		assert.deepEqual(findProcessedCommand(dir, "cmd-1"), { status: "applied", reason: "cmd-1" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readJournal skips a corrupt tail line", () => {
	const dir = freshDir();
	try {
		appendCommand(dir, record("cmd-1", 1, 100));
		appendCommand(dir, record("cmd-2", 2, 200));
		// Crash mid-append: half a JSON object with no trailing newline.
		appendFileSync(journalPath(dir), '{"command":{"commandId":"cmd-3"');
		const entries = readJournal(dir);
		assert.deepEqual(
			entries.map((entry) => entry.command.commandId),
			["cmd-1", "cmd-2"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readCheckpoint returns null for missing or corrupt checkpoints", () => {
	const dir = freshDir();
	try {
		assert.equal(readCheckpoint(dir), null);
		appendFileSync(join(dir, "state-journal.checkpoint.json"), "{not json");
		assert.equal(readCheckpoint(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeCheckpoint round-trips { materializedRevision, journalBytes }", () => {
	const dir = freshDir();
	try {
		assert.equal(writeCheckpoint(dir, { materializedRevision: 7, journalBytes: 512 }), true);
		assert.deepEqual(readCheckpoint(dir), { materializedRevision: 7, journalBytes: 512 });
		assert.equal(join(dir, "state-journal.checkpoint.json"), join(dir, "state-journal.checkpoint.json"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gcJournal without a checkpoint does not truncate", () => {
	const dir = freshDir();
	try {
		appendCommand(dir, record("cmd-1", 1, 100));
		appendCommand(dir, record("cmd-2", 2, 200));
		const sizeBefore = statSync(journalPath(dir)).size;
		assert.equal(gcJournal(dir), sizeBefore);
		assert.equal(readJournal(dir).length, 2);
		assert.equal(statSync(journalPath(dir)).size, sizeBefore);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gcJournal truncates only the checkpointed prefix", () => {
	const dir = freshDir();
	try {
		const sizeAfterFirst = appendCommand(dir, record("cmd-1", 1, 100));
		appendCommand(dir, record("cmd-2", 2, 200));
		appendCommand(dir, record("cmd-3", 3, 300));
		const sizeBefore = statSync(journalPath(dir)).size;

		assert.equal(writeCheckpoint(dir, { materializedRevision: 1, journalBytes: sizeAfterFirst }), true);
		const sizeAfterGc = gcJournal(dir);
		assert.equal(sizeAfterGc, sizeBefore - sizeAfterFirst);
		assert.equal(statSync(journalPath(dir)).size, sizeAfterGc);
		assert.deepEqual(
			readJournal(dir).map((entry) => entry.command.commandId),
			["cmd-2", "cmd-3"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gcJournal is a no-op when the checkpoint already covers the whole journal", () => {
	const dir = freshDir();
	try {
		const size = appendCommand(dir, record("cmd-1", 1, 100));
		writeCheckpoint(dir, { materializedRevision: 1, journalBytes: size });
		assert.equal(gcJournal(dir), size);
		assert.equal(readJournal(dir).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
