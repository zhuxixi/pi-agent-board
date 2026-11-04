#!/usr/bin/env node
/**
 * Executable fixture for the stdout-flush integration test (issue #270).
 * Writes a JSON result comfortably past the 64 KiB pipe buffer, then exits
 * through the shared helper so the payload is fully drained first.
 */
import { exitAfterStdout } from "./stdout-flush.mjs";

const index = process.argv.indexOf("--bytes");
const bytes = index === -1 ? 262144 : Number(process.argv[index + 1]);
exitAfterStdout(`${JSON.stringify({ payload: "x".repeat(bytes) })}\n`, 0);
