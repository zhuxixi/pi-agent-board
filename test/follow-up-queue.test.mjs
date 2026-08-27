import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	claimNextFollowUp,
	clearQueuedFollowUps,
	completeFollowUp,
	enqueueFollowUp,
	readFollowUpQueue,
	removeLastFollowUp,
	summarizeFollowUpQueue,
} from "../src/core/follow-up-queue.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-queue-"));
}

test("follow-up queue is FIFO and durable", () => {
	const root = freshRoot();
	try {
		assert.equal(readFollowUpQueue(root, "v1").items.length, 0);
		assert.equal(enqueueFollowUp(root, "v1", "").ok, false);
		enqueueFollowUp(root, "v1", "first");
		enqueueFollowUp(root, "v1", "second");
		assert.equal(summarizeFollowUpQueue(readFollowUpQueue(root, "v1")).queuedCount, 2);
		const claimed = claimNextFollowUp(root, "v1", { runId: "r1" });
		assert.equal(claimed.ok, true);
		assert.equal(claimed.item.text, "first");
		completeFollowUp(root, "v1", claimed.item.id);
		assert.equal(claimNextFollowUp(root, "v1").item.text, "second");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("queue ops return {ok:false} when the lock path is unusable", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const fileRoot = join(root, "notadir");
		writeFileSync(fileRoot, "x", "utf8"); // ensureDir under a file path -> ENOTDIR, unrecoverable
		const enq = enqueueFollowUp(fileRoot, "v1", "hello");
		assert.equal(enq.ok, false);
		assert.match(String(enq.error), /lock unavailable/);
		const claim = claimNextFollowUp(fileRoot, "v1");
		assert.equal(claim.ok, false);
		assert.match(String(claim.error), /lock unavailable/);
		const removed = removeLastFollowUp(fileRoot, "v1");
		assert.equal(removed.ok, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("follow-up queue remove last and clear only queued items", () => {
	const root = freshRoot();
	try {
		enqueueFollowUp(root, "v1", "one");
		enqueueFollowUp(root, "v1", "two");
		assert.equal(removeLastFollowUp(root, "v1").item.text, "two");
		assert.equal(summarizeFollowUpQueue(readFollowUpQueue(root, "v1")).queuedCount, 1);
		assert.equal(clearQueuedFollowUps(root, "v1").cancelled, 1);
		assert.equal(summarizeFollowUpQueue(readFollowUpQueue(root, "v1")).queuedCount, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
