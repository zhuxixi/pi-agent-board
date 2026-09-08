#!/usr/bin/env node
/**
 * Fake interactive pi child that fails the way a stale `--model` fails (issue #90):
 * prints ANSI/OSC-decorated boot output, then a carriage-return-overwritten error
 * line as the LAST visible line, then exits ($FAKE_PTY_EXIT_CODE, default 1).
 */
const exitCode = Number(process.env.FAKE_PTY_EXIT_CODE || 1);
process.stdout.write("\x1b[2J\x1b[H");
process.stdout.write("\x1b]8;;https://example.com\x1b\\booting model registry...\x1b]8;;\x1b\\\r\n");
process.stdout.write("starting model check...\r");
process.stdout.write('\x1b[1;31mError: Model "glm/glm-5.3" not found. Use --list-models to see available models.\x1b[0m\r\n');
// Delay the exit so the runner's stdout drain (pipe fallback) sees the error
// before the close event — keeps the attribution race-free on CI.
setTimeout(() => process.exit(exitCode), 150);
