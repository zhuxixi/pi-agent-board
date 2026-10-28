import assert from "node:assert/strict";
import test from "node:test";
import xtermHeadless from "@xterm/headless";
import { createPtyKittyImages } from "../src/core/pty-kitty-images.mjs";
const { Terminal } = xtermHeadless;
const apc = (c, data = "") => `\x1b_G${c};${data}\x1b\\`;
const upload = (id = 42) => apc(`a=T,f=100,i=${id},c=5,r=2,C=1`, "aGVsbG8=");
// Only an IHDR is needed by these metadata/projection tests (not a PNG decoder).
function pngHeader(height) {
	const header = Buffer.alloc(24);
	Buffer.from("89504e470d0a1a0a", "hex").copy(header);
	header.write("IHDR", 12);
	header.writeUInt32BE(1200, 16);
	header.writeUInt32BE(height, 20);
	return header.toString("base64");
}
function controlsFor(line, action) {
	return [...line.matchAll(/\x1b_G([^;\x1b]*)/g)]
		.map((match) => Object.fromEntries(match[1].split(",").map((part) => part.split("="))))
		.find((controls) => controls.a === action);
}
function fixture(t) {
	const term = new Terminal({ cols: 40, rows: 10, scrollback: 20, allowProposedApi: true });
	const images = createPtyKittyImages(term);
	t.after(() => { images.dispose(); term.dispose(); });
	return {
		term, images,
		feed: (data, reset = false) => new Promise((resolve) => term.write(images.transform(data, reset), resolve)),
		project: (start = term.buffer.active.baseY, height = 10) => images.project(Array(height).fill(""), start, height),
	};
}

test("image follows the parsed cursor, not the host or final child cursor", async (t) => {
	const f = fixture(t);
	await f.feed(`\x1b[3;4H${upload()}\x1b[10;1Hfooter`);
	const lines = f.project();
	assert.ok(lines[2].includes("\x1b[4G"));
	assert.ok(lines[2].includes("a=p"));
	assert.equal(lines[9], "");
	assert.equal(f.term.buffer.active.cursorY, 9);
});

test("every PTY byte boundary including APC prefixes and terminators is safe", async (t) => {
	const f = fixture(t);
	for (const char of `\x1b[4;2H${upload()}\x1b[9;1Htext`) await f.feed(char);
	assert.ok(f.project()[3].includes("a=p"));
	assert.equal(f.term.buffer.active.getLine(8).translateToString(true), "text");
});

test("chunked upload is retained and projected as a complete valid upload", async (t) => {
	const f = fixture(t);
	const data = "A".repeat(12000);
	await f.feed(`\x1b[2;1H${apc("a=T,f=100,i=42,c=5,r=2,m=1", data.slice(0, 4096))}`);
	assert.equal(f.project().some((line) => line.includes("a=p")), false);
	await f.feed(apc("m=1", data.slice(4096, 8192)) + apc("m=0", data.slice(8192)));
	const line = f.project()[1];
	assert.ok(line.includes("a=t"));
	assert.ok(line.includes("m=0"));
	assert.equal((line.match(/A/g) ?? []).length, 12000);
});

test("separate transmit and cropped placement keeps the placement cursor and geometry", async (t) => {
	const f = fixture(t);
	await f.feed(apc("a=t,f=100,i=42", "aGVsbG8="));
	assert.ok(f.project().every((line) => !line));
	await f.feed(`\x1b[5;3H${apc("a=p,i=42,p=2,c=5,r=3,y=12,h=36,C=1")}`);
	assert.ok(f.project()[4].includes("y=12,h=36"));
	assert.ok(f.project()[4].includes("\x1b[3G"));
});

test("normal-buffer image anchors move with scrollback", async (t) => {
	const f = fixture(t);
	await f.feed(`\x1b[4;1H${upload()}\x1b[10;1H\r\n\r\n`);
	assert.equal(f.term.buffer.active.baseY, 2);
	assert.ok(f.project()[1].includes("a=p"));
	await f.feed("\r\n".repeat(4));
	assert.ok(f.project().every((line) => !line), "offscreen image is not painted on footer");
	assert.ok(f.project(0)[3].includes("a=p"), "scrolling back finds the image at its message");
});

test("placement deletion hides image but retains upload for later placement", async (t) => {
	const f = fixture(t);
	await f.feed(upload() + apc("a=d,d=a"));
	assert.ok(f.project().every((line) => !line));
	await f.feed(`\x1b[3;1H${apc("a=p,i=42,c=5,r=2")}`);
	assert.ok(f.project()[2].includes("a=p"));
	await f.feed(apc("a=d,d=I,i=42") + apc("a=p,i=42,c=5,r=2"));
	assert.ok(f.project().every((line) => !line));
});

test("all-image deletion and snapshot replacement cannot leave ghost placements", async (t) => {
	const f = fixture(t);
	await f.feed(upload() + apc("a=d,d=A"));
	assert.ok(f.project().every((line) => !line));
	await f.feed(upload());
	await f.feed("\x1b[2J\x1b[Hsnapshot", true);
	assert.ok(f.project().every((line) => !line));
});

test("unknown image geometry cannot spill below the attach body", async (t) => {
	const f = fixture(t);
	await f.feed(`\x1b[10;1H${upload()}`);
	assert.ok(f.project().every((line) => !line));
});

test("a top-clipped pumpkin stays visible using its PNG source height", async (t) => {
	const f = fixture(t);
	await f.feed(`\x1b[3;1H${apc("a=T,f=100,i=42,c=60,r=30,C=1", pngHeader(1141))}`);
	const lines = f.project(4, 10);
	const placement = controlsFor(lines[0], "p");
	assert.equal(placement.y, "76");
	assert.equal(placement.h, "381");
	assert.equal(placement.r, "10");
	assert.equal(controlsFor(lines[0], "t").r, "10", "outer renderer reserves only visible rows");
	assert.ok(lines.slice(1).every((line) => !line));
});

test("bottom-clipped image stops exactly above the attach footer", async (t) => {
	const f = fixture(t);
	await f.feed(`\x1b[8;1H${apc("a=T,f=100,i=42,c=5,r=6,C=1", pngHeader(600))}`);
	const placement = controlsFor(f.project()[7], "p");
	assert.equal(placement.y, "0");
	assert.equal(placement.h, "300");
	assert.equal(placement.r, "3");
});

test("cropping both edges and scrolling back never mutates the stored placement", async (t) => {
	const f = fixture(t);
	await f.feed(`\x1b[3;1H${apc("a=T,f=100,i=42,c=5,r=6,C=1", pngHeader(600))}`);
	const clipped = controlsFor(f.project(4, 2)[0], "p");
	assert.equal(clipped.y, "200");
	assert.equal(clipped.h, "200");
	assert.equal(clipped.r, "2");
	const restored = controlsFor(f.project()[2], "p");
	assert.equal(restored.r, "6");
	assert.equal(restored.y, undefined);
	assert.equal(restored.h, undefined);
	assert.ok(f.project(8).every((line) => !line), "fully offscreen image is still omitted");
	assert.equal(controlsFor(f.project()[2], "p").r, "6", "returning redraws the whole image");
});

test("viewport clipping composes with an existing source crop", async (t) => {
	const f = fixture(t);
	await f.feed(apc("a=t,f=100,i=42", pngHeader(1000)));
	await f.feed(`\x1b[3;1H${apc("a=p,i=42,c=5,r=8,y=100,h=400,C=1")}`);
	const placement = controlsFor(f.project(4, 4)[0], "p");
	assert.equal(placement.y, "200");
	assert.equal(placement.h, "200");
	assert.equal(placement.r, "4");
});

test("alternate-buffer placement does not leak to the normal buffer", async (t) => {
	const f = fixture(t);
	await f.feed(`\x1b[?1049h\x1b[3;1H${upload()}`);
	assert.ok(f.project()[2].includes("a=p"));
	await f.feed("\x1b[?1049l");
	assert.ok(f.project().every((line) => !line));
});

test("clipboard and ordinary OSC sequences pass through unchanged", async (t) => {
	const f = fixture(t);
	const input = "hi\x1b]52;c;aGk=\x07\x1b]11;?\x1b\\";
	assert.equal(f.images.transform(input), input);
});

test("plain ANSI and iTerm2 streams remain byte-equivalent across fragmented reads", (t) => {
	const f = fixture(t);
	const input = "text\x1b[31mred\x1b[0m\x1b]1337;File=inline=1:aGVsbG8=\x07\x1b]11;?\x1b\\\x1b[3J";
	const output = [...input].map((char) => f.images.transform(char)).join("");
	assert.equal(output, input);
	assert.ok(f.project().every((line) => !line));
});

test("scrollback callbacks are inactive until this session actually uploads Kitty graphics", async (t) => {
	const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
	let clears = 0;
	const images = createPtyKittyImages(term, () => clears++);
	t.after(() => { images.dispose(); term.dispose(); });
	const feed = (data) => new Promise((resolve) => term.write(images.transform(data), resolve));
	await feed("plain text\x1b[3J\x1b]1337;File=inline=1:aGVsbG8=\x07");
	assert.equal(clears, 0, "non-Kitty sessions keep their existing history handling");
	await feed(upload() + "\x1b[2J\x1b[3J");
	assert.equal(clears, 1);
	await feed(apc("a=d,d=A") + "\x1b[3J");
	assert.equal(clears, 2, "a full redraw can delete images before clearing history");
});

test("raw RGB/RGBA source dimensions support clipping too", async (t) => {
	for (const format of [24, 32]) {
		const f = fixture(t);
		await f.feed(apc(`a=T,f=${format},s=20,v=600,i=42,c=5,r=2,C=1`, "aGVsbG8="));
		const placement = controlsFor(f.project(1, 10)[0], "p");
		assert.equal(placement.y, "300");
		assert.equal(placement.h, "300");
		assert.equal(placement.r, "1");
	}
});

test("unsupported file transfers, missing dimensions and virtual placements are not projected", async (t) => {
	const f = fixture(t);
	await f.feed(apc("a=T,t=f,f=100,i=42,c=5,r=2", "L3RtcC9pbWFnZS5wbmc="));
	await f.feed(apc("a=q,i=42") + apc("a=p,i=42,c=5,r=2"));
	await f.feed(apc("a=T,f=100,i=43", "aGVsbG8="));
	await f.feed(apc("a=T,f=100,i=44,c=5,r=2,U=1", "aGVsbG8="));
	assert.ok(f.project().every((line) => !line));
});

test("image cache evicts oldest uploads rather than growing without bound", async (t) => {
	const f = fixture(t);
	for (let id = 1; id <= 33; id++) await f.feed(upload(id));
	const line = f.project()[0];
	assert.equal(/(?:^|,)i=1(?:,|;)/.test(line), false);
	assert.equal([...line.matchAll(/a=p,/g)].length, 32);
	assert.ok(line.includes("i=33,"));
});
