// Cursor-visibility regression harness (issue #102): the attach projection must
// honor the child terminal's DECTCEM state. A hidden cursor must never be painted
// as a solid inverse block, while the zero-width CURSOR_MARKER (hardware cursor
// positioning for IME and PI_HARDWARE_CURSOR=1) must survive either way.
// Run via `node --experimental-transform-types` (TS parameter properties).
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const CURSOR_MARKER = "\x1b_pi:c\x07";

const tui = {
	terminal: { rows: 12, cols: 40, columns: 40, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const keybindings = {} as never;

function makeAttach(): PtyAttachComponent {
	return new PtyAttachComponent(
		tui as never,
		theme,
		keybindings,
		() => {},
		{ socketPath: "/no/such/socket", title: "cursor-visibility" },
	);
}

/** Feed raw PTY bytes, then settle the attach transition so render() projects the buffer. */
async function writeToTerm(attach: PtyAttachComponent, data: string): Promise<void> {
	await new Promise<void>((resolve) => {
		(attach as unknown as { term: { write: (d: string, cb: () => void) => void } }).term.write(data, resolve);
	});
	(attach as unknown as { receivedOutput: boolean }).receivedOutput = true;
	(attach as unknown as { finishAttachTransition: () => void }).finishAttachTransition();
}

/** SGR parameter list emitted right after the CURSOR_MARKER, or null when no marker is rendered. */
function markerSgrFields(lines: string[]): string[] | null {
	for (const line of lines) {
		const at = line.indexOf(CURSOR_MARKER);
		if (at === -1) continue;
		const sgr = line.slice(at + CURSOR_MARKER.length).match(/^\x1b\[([\d;]*)m/);
		return sgr ? sgr[1].split(";") : [];
	}
	return null;
}

function hasInverseAttribute(lines: string[]): boolean {
	return markerSgrFields(lines)?.includes("7") ?? false;
}

function hasInverseSpace(lines: string[]): boolean {
	return lines.some((line) => line.includes("\x1b[7m"));
}

async function hiddenOnContentCell(): Promise<boolean> {
	const attach = makeAttach();
	// Cursor parked on the "e" of "hello" (row 0, col 1); the child says HIDDEN.
	await writeToTerm(attach, "hello\r\x1b[2G\x1b[?25l");
	const lines = attach.render(40);
	const ok = markerSgrFields(lines) !== null && !hasInverseAttribute(lines) && !hasInverseSpace(lines);
	attach.dispose();
	return ok;
}

async function hiddenOnEmptyLine(): Promise<boolean> {
	const attach = makeAttach();
	// Cursor on the empty line below "hello": the empty-line early-return path.
	await writeToTerm(attach, "hello\r\n\x1b[?25l");
	const lines = attach.render(40);
	const ok = markerSgrFields(lines) !== null && !hasInverseAttribute(lines) && !hasInverseSpace(lines);
	attach.dispose();
	return ok;
}

async function hiddenPastEndOfLine(): Promise<boolean> {
	const attach = makeAttach();
	// Cursor one column past "abc": the past-end-of-content branch.
	await writeToTerm(attach, "abc\x1b[?25l");
	const lines = attach.render(40);
	const ok = markerSgrFields(lines) !== null && !hasInverseSpace(lines);
	attach.dispose();
	return ok;
}

async function visibleOnContentCell(): Promise<boolean> {
	const attach = makeAttach();
	await writeToTerm(attach, "hello\r\x1b[2G\x1b[?25h");
	const lines = attach.render(40);
	const ok = hasInverseAttribute(lines);
	attach.dispose();
	return ok;
}

async function visibleByDefaultOnContentCell(): Promise<boolean> {
	const attach = makeAttach();
	// No DECTCEM sequence at all: an unknown state must keep today's behavior.
	await writeToTerm(attach, "hello\r\x1b[2G");
	const lines = attach.render(40);
	const ok = hasInverseAttribute(lines);
	attach.dispose();
	return ok;
}

async function visiblePastEndOfLine(): Promise<boolean> {
	const attach = makeAttach();
	await writeToTerm(attach, "abc\x1b[?25h");
	const lines = attach.render(40);
	const ok = markerSgrFields(lines) !== null && hasInverseSpace(lines);
	attach.dispose();
	return ok;
}

const out: Record<string, boolean> = {
	hiddenOnContentCellOmitsInverseBlock: await hiddenOnContentCell(),
	hiddenOnEmptyLineKeepsMarkerWithoutBlock: await hiddenOnEmptyLine(),
	hiddenPastEndOmitsInverseSpace: await hiddenPastEndOfLine(),
	visibleOnContentCellPaintsInverseBlock: await visibleOnContentCell(),
	visibleByDefaultOnContentCell: await visibleByDefaultOnContentCell(),
	visiblePastEndPaintsInverseSpace: await visiblePastEndOfLine(),
};

console.log(JSON.stringify(out));
