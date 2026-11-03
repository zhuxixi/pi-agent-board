export function parseRunnerArgs(argv) {
	const parsed = { execute: false, artifacts: null, scope: "full" };
	for (let i = 0; i < argv.length; i += 1) {
		const value = argv[i];
		if (value === "--execute-formal") {
			parsed.execute = true;
			continue;
		}
		if (value === "--scope") {
			const next = argv[i + 1];
			if (next !== "full" && next !== "replacement") throw new Error("--scope must be full or replacement");
			parsed.scope = next;
			i += 1;
			continue;
		}
		if (value === "--artifacts") {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error("--artifacts requires a path");
			parsed.artifacts = next;
			i += 1;
			continue;
		}
		throw new Error(`unsupported argument ${JSON.stringify(value)}`);
	}
	return parsed;
}
