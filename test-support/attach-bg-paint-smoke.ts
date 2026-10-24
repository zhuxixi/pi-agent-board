// Attach background-paint regression harness (issue #232): a line that carries a
// non-default background but no characters must still reach the attach view.
// Background-only cells are produced ONLY by erase sequences (EL/ED) under an
// active bg — literal spaces keep getChars() non-empty and would pass even while
// lineToAnsi() trims at the last character.
// Run via `node --experimental-transform-types` (TS parameter properties).
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const BG = "\x1b[48;2;30;30;46m";
const HIDE_CURSOR = "\x1b[?25l";

const tui = {
	terminal: { rows: 12, cols: 80, columns: 80, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };

type AttachInternals = {
	term: { write: (data: string, callback: () => void) => void };
	receivedOutput: boolean;
	finishAttachTransition: () => void;
	selection: { anchor: { line: number; col: number }; focus: { line: number; col: number } } | null;
};

function makeAttach(): PtyAttachComponent {
	return new PtyAttachComponent(tui as never, theme, {} as never, () => {}, {
		socketPath: "/no/such/socket",
		title: "attach-bg-paint",
	});
}

async function project(data: string, beforeSettle?: (internals: AttachInternals) => void): Promise<string[]> {
	const attach = makeAttach();
	try {
		// SAFETY: these are the component's real private members; the fixture bypasses the socket to feed PTY output.
		const internals = attach as unknown as AttachInternals;
		// Settle the viewport (80x10) before painting: the terminal starts at 120x24 and
		// the reflow of the resize would rewrite the cells erased below.
		attach.render(80);
		await new Promise<void>((resolve) => internals.term.write(data, resolve));
		beforeSettle?.(internals);
		internals.receivedOutput = true;
		internals.finishAttachTransition();
		return attach.render(80).slice(1, -1);
	} finally {
		attach.dispose();
	}
}

async function projectSelectionText(): Promise<string> {
	const attach = makeAttach();
	try {
		// SAFETY: private member; the fixture exercises the copy path without a socket.
		const internals = attach as unknown as AttachInternals & { selectionText: () => string };
		attach.render(80);
		await new Promise<void>((resolve) => internals.term.write(`${BG}\x1b[2J${HIDE_CURSOR}`, resolve));
		internals.selection = { anchor: { line: 5, col: 20 }, focus: { line: 5, col: 60 } };
		internals.receivedOutput = true;
		internals.finishAttachTransition();
		return internals.selectionText();
	} finally {
		attach.dispose();
	}
}

console.log(JSON.stringify({
	// Whole screen erased under an active bg: every body cell is background-only.
	blankPainted: await project(`${BG}\x1b[2J${HIDE_CURSOR}`),
	// "AB" at cols 0-1, paint from col 40 to the right edge: cols 2-39 stay default.
	// The cursor returns home so its marker does not sit on the paint boundary.
	contentPainted: await project(`first line\r\nsecond line\r\nAB\x1b[41G${BG}\x1b[K\x1b[1;1H${HIDE_CURSOR}`),
	// Ordinary default-background screen: the cheap path must stay byte-identical.
	plain: await project(`hello\r\nworld${HIDE_CURSOR}`),
	// Wide char at cols 0-1 (its continuation cell has width 0), paint from col 2.
	wide: await project(`中${BG}\x1b[K${HIDE_CURSOR}`),
	// Painted blank screen with the cursor parked VISIBLY at row 5 / col 30.
	cursor: await project(`${BG}\x1b[2J\x1b[6;31H`),
	// Painted blank screen with a mouse selection over cols 20-60 of row 5.
	selection: await project(`${BG}\x1b[2J${HIDE_CURSOR}`, (internals) => {
		internals.selection = { anchor: { line: 5, col: 20 }, focus: { line: 5, col: 60 } };
	}),
	// Copy text for that selection: blank painted cells carry no characters.
	selectionText: await projectSelectionText(),
}));
