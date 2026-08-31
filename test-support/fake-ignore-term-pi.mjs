#!/usr/bin/env node
/** Test child that ignores SIGTERM so runner shutdown must escalate to SIGKILL. */
import { writeFileSync } from "node:fs";

process.stdout.write("ignore-term child ready\n");
if (process.env.FAKE_PTY_PID_PATH) {
	writeFileSync(process.env.FAKE_PTY_PID_PATH, String(process.pid));
}
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
