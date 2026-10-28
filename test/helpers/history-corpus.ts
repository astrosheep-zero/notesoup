/** Temporary discovery roots for adapter tests; never scan the operator's real transcripts. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

export function isolateHistoryRoots(t: TestContext, home: string) {
	const roots = { pi: join(home, "pi-sessions"), claude: join(home, "claude-projects"), codex: join(home, "sessions") };
	for (const [harness, root] of Object.entries(roots)) {
		const key = `NOTESOUP_HISTORY_${harness.toUpperCase()}_ROOT`;
		const previous = process.env[key];
		process.env[key] = root;
		t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	}
	return roots;
}

export async function writePiTranscript(root: string, id: string, text = "foreign needle") {
	const timestamp = "2026-10-06T01:02:03.000Z";
	const path = join(root, "--workspace--", `2026-10-06T01-02-03_${id}.jsonl`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, [
		{ type: "session", version: 3, id, timestamp, cwd: "/workspace" },
		{ type: "message", id: "u", parentId: null, timestamp, message: { role: "user", content: text } },
	].map((row) => JSON.stringify(row) + "\n").join(""));
	return path;
}
