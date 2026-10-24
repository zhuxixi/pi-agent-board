// Real attach + Pi renderer regression tests, isolated from any live sessions.
// node --experimental-transform-types --test test-support/kitty-images-smoke.ts
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TuiMainScreen, setCapabilities } from "@earendil-works/pi-tui";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const image = "\x1b_Ga=T,f=100,i=42,c=5,r=2,C=1;aGVsbG8=\x1b\\";

function fixture(t: TestContext) {
	const writes: string[] = [];
	const tui = {
		mode: "regular",
		terminal: { rows: 12, cols: 40, columns: 40, write: (s: string) => writes.push(s) },
		requestRender() {},
	};
	const component = new PtyAttachComponent(tui as never, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {} as never, () => {}, { socketPath: "/no/such/socket", title: "image-test" });
	// Intentionally inspect parser/projection state without launching a runner.
	const attach = component as any;
	attach.attaching = false;
	t.after(() => component.dispose());
	return {
		attach, writes,
		async feed(data: string) {
			attach.pushOutput(data, { forwardProtocols: true });
			await new Promise<void>((resolve) => attach.term.write("", resolve));
		},
	};
}

test("attach positions Kitty images in body rows, never directly at the host cursor", async (t) => {
	const { attach, writes, feed } = fixture(t);
	await feed(`\x1b[3;4H${image}\x1b[10;1Hfooter`);
	const lines = attach.render(40);
	assert.ok(lines[3].includes("a=p"), "body row 2 + header row 1");
	assert.ok(lines[3].includes("aGVsbG8="), "payload survives line clipping");
	assert.equal(writes.some((s) => s.includes("\x1b_G")), false);
	await feed("\x1b_Ga=d,d=I,i=42\x1b\\");
	assert.ok(attach.render(40).every((line: string) => !line.includes("\x1b_G")));
});

test("Pi's main renderer deletes placements when images scroll completely out", async (t) => {
	const { attach, feed } = fixture(t);
	await feed(`\x1b[3;4H${image}\x1b[10;1Hfooter`);
	const stream: string[] = [];
	const tui = new TuiMainScreen({ rows: 12, columns: 40, write: (s: string) => stream.push(s), hideCursor() {}, showCursor() {} } as never);
	t.after(() => { (tui as any).stopped = true; });
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	tui.addChild(attach);
	(tui as any).doRender();
	assert.ok(stream.join("").includes("a=p"));
	stream.length = 0;
	await feed("\r\n".repeat(6));
	(tui as any).doRender();
	assert.ok(stream.join("").includes("a=d,d=I,i=42"));
	assert.equal(stream.join("").includes("a=p"), false);
});

test("edge cropping and return to scrollback preserve the original source geometry", async (t) => {
	const { attach, feed } = fixture(t);
	const header = Buffer.alloc(24);
	Buffer.from("89504e470d0a1a0a", "hex").copy(header);
	header.write("IHDR", 12);
	header.writeUInt32BE(500, 16);
	header.writeUInt32BE(800, 20);
	await feed(`\x1b[3;1H\x1b_Ga=T,f=100,i=42,c=5,r=8,C=1;${header.toString("base64")}\x1b\\\x1b[10;1H` + "\r\n".repeat(6));
	const clipped = attach.render(40);
	assert.ok(clipped[1].includes("y=400,h=400"));
	assert.equal(clipped[0].includes("\x1b_G"), false, "header stays clear");
	assert.equal(clipped.at(-1).includes("\x1b_G"), false, "footer stays clear");
	await feed("\r\n".repeat(6));
	assert.ok(attach.render(40).every((line: string) => !line.includes("\x1b_G")));
	assert.equal(attach.tryScrollToTop(), true);
	const restored = attach.render(40)[3];
	assert.ok(restored.includes("a=p"));
	assert.ok(restored.includes("r=8"));
	assert.equal(restored.includes("y="), false);
});

test("history floor resets only for sessions using Kitty graphics", async (t) => {
	const { attach, feed } = fixture(t);
	attach.historyFloor = 100;
	await feed("\x1b[3Jplain text");
	assert.equal(attach.historyFloor, 100, "plain sessions retain existing behavior");
	await feed(image);
	await feed("\x1b[3J\x1b[2J\x1b[H" + "real history\r\n".repeat(20));
	assert.equal(attach.historyFloor, 0);
	assert.equal(attach.tryScrollBy(5), true);
});

test("iTerm2 and clipboard passthrough remain unchanged", async (t) => {
	const { writes, feed } = fixture(t);
	const iterm = "\x1b]1337;File=inline=1:aGVsbG8=\x07";
	const clipboard = "\x1b]52;c;aGk=\x07";
	await feed(iterm + clipboard);
	assert.ok(writes.includes(iterm));
	assert.ok(writes.includes(clipboard));
});

test("the existing image-forwarding kill switch suppresses Kitty projection", async (t) => {
	const previous = process.env.AGENT_BOARD_FORWARD_IMAGES;
	process.env.AGENT_BOARD_FORWARD_IMAGES = "0";
	try {
		const { attach, writes, feed } = fixture(t);
		await feed(image);
		assert.ok(attach.render(40).every((line: string) => !line.includes("\x1b_G")));
		assert.ok(writes.every((s) => !s.includes("\x1b_G")));
	} finally {
		if (previous === undefined) delete process.env.AGENT_BOARD_FORWARD_IMAGES;
		else process.env.AGENT_BOARD_FORWARD_IMAGES = previous;
	}
});
