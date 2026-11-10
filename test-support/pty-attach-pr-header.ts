// The real attach component renders the header before a socket connects.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agent-board-attach-pr-header-"));
const tui = { terminal: { rows: 24, cols: 120, columns: 120, write: () => {} }, requestRender: () => {} };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const headers: string[] = [];
try {
	for (const prLabel of [undefined, "PR #271", "MR !42"]) {
		const attach = new PtyAttachComponent(tui as never, theme, {} as never, () => {}, {
			socketPath: join(root, "missing.sock"), title: "nick whatsapp", prLabel,
		});
		try {
			headers.push(attach.render(120)[0]);
		} finally {
			attach.dispose();
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(headers) + "\n");
