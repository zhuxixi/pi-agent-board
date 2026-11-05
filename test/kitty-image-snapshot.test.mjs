import assert from 'node:assert/strict';
import test from 'node:test';
import xtermHeadless from '@xterm/headless';
import { createTerminalModel, feedOutput, whenIdle } from '../src/core/terminal-model.mjs';
import { captureTerminalSnapshot, synthesizeFullRedrawFrame } from '../src/core/terminal-snapshot.mjs';
import { createPtyKittyImages } from '../src/core/pty-kitty-images.mjs';
const { Terminal } = xtermHeadless;
const image = '\x1b_Ga=T,f=100,i=42,c=5,r=2,C=1;aGVsbG8=\x1b\\';

test('snapshot preserves image placement after raw upload left the replay ring', async (t) => {
	const model = createTerminalModel({ cols: 40, rows: 10, ringChunkCap: 1 });
	t.after(() => model.parser.dispose());
	feedOutput(model, `\x1b[3;4H${image}\x1b[10;1Hfooter`);
	feedOutput(model, '\x1b[?25l');
	await whenIdle(model);
	assert.equal(model.ring.some((c) => c.data.includes('a=T')), false);
	const dto = await captureTerminalSnapshot(model);
	assert.ok(dto.kittyImageLines[2].includes('a=p'));
	const frame = await synthesizeFullRedrawFrame(JSON.parse(JSON.stringify(dto)));
	const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
	const bridge = createPtyKittyImages(term);
	t.after(() => { bridge.dispose(); term.dispose(); });
	await new Promise((resolve) => term.write(bridge.transform(frame, true), resolve));
	const lines = bridge.project(Array(10).fill(''), term.buffer.active.baseY, 10);
	assert.ok(lines[2].includes('a=p'));
	assert.ok(lines[2].includes('\x1b[4G'));
	assert.equal(term.buffer.active.cursorY, 9, 'graphics do not move restored cursor');
	// A second resnapshot must reconstruct placements, not just retain empty rows.
	await new Promise((resolve) => term.write(bridge.transform(frame, true), resolve));
	assert.ok(bridge.project(Array(10).fill(''), term.buffer.active.baseY, 10)[2].includes('a=p'));
});

test('snapshots omit deleted images but retain offscreen images with their history', async (t) => {
	const model = createTerminalModel({ cols: 40, rows: 10 });
	t.after(() => model.parser.dispose());
	feedOutput(model, image + '\x1b_Ga=d,d=I,i=42\x1b\\');
	assert.equal((await captureTerminalSnapshot(model)).kittyImageLines, undefined);
	feedOutput(model, image + '\x1b[10;1H' + '\r\n'.repeat(10));
	const dto = await captureTerminalSnapshot(model);
	assert.ok(dto.kittyImageLines.some(Boolean), 'image data retained for scrollback');
	const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
	const bridge = createPtyKittyImages(term);
	t.after(() => { bridge.dispose(); term.dispose(); });
	const frame = await synthesizeFullRedrawFrame(dto);
	await new Promise((resolve) => term.write(bridge.transform(frame, true), resolve));
	assert.ok(bridge.project(Array(10).fill(''), term.buffer.active.baseY, 10).every((line) => !line), 'not painted at current footer');
	assert.ok(bridge.project(Array(10).fill(''), 0, 10)[0].includes('a=p'), 'scrolling back recovers image');
});

test('non-Kitty snapshots and wire frames match an unmodified xterm parser', async (t) => {
	const tracked = createTerminalModel({ cols: 40, rows: 10 });
	const plain = createTerminalModel({ cols: 40, rows: 10,
		parserFactory: (options) => new Terminal({ ...options, allowProposedApi: true }) });
	t.after(() => { tracked.parser.dispose(); plain.parser.dispose(); });
	const input = 'first\r\n\x1b[31mred\x1b[0m\x1b]52;c;aGk=\x07\x1b]1337;File=inline=1:aGVsbG8=\x07\x1b[3J' + '\r\nmore'.repeat(12);
	for (const char of input) {
		feedOutput(tracked, char);
		feedOutput(plain, char);
	}
	const actual = await captureTerminalSnapshot(tracked);
	const expected = await captureTerminalSnapshot(plain);
	assert.equal(actual.kittyImageLines, undefined);
	assert.deepEqual(actual, expected);
	assert.equal(await synthesizeFullRedrawFrame(actual), await synthesizeFullRedrawFrame(expected));
	assert.deepEqual(tracked.ring, plain.ring, 'raw ring bytes and sequence numbers are unchanged');
});
