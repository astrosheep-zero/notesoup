import assert from "node:assert/strict";
import { main } from "../plugins/pi/dream/cli.js";
import { doctor } from "../src/dream/doctor.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const note = "---\norigin: self\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\nlastAccessed: 2026-01-01T00:00:00Z\naccessCount: 0\n---\n\n";

test("doctor ignores unknown frontmatter keys while validating canonical metadata", (t) => {
	const root = mkdtempSync(join(tmpdir(), "dream-doctor-extra-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "human"));
	writeFileSync(join(root, "human/extra.md"), note.replace("accessCount: 0", "accessCount: 0\ncreated_at: 2025-01-01\nupdated_at: 2025-01-01\nlast_accessed: 2025-01-01\naccess_count: 7\nsource_window: old\nrecurrence_count: 2\nrecurrence_windows: old"));
	assert.deepEqual(doctor(root), [], "unknown fields have no special diagnostics");
});

test("doctor validates crumpledAt as an optional ISO timestamp", (t) => {
	const root = mkdtempSync(join(tmpdir(), "dream-doctor-crumpled-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "human"));
	writeFileSync(join(root, "human/valid.md"), note.replace("accessCount: 0", "accessCount: 0\ncrumpledAt: 2026-01-02T00:00:00Z"));
	writeFileSync(join(root, "human/bad.md"), note.replace("accessCount: 0", "accessCount: 0\ncrumpledAt: yesterday"));
	assert.deepEqual(doctor(root), ["human/bad.md: missing/invalid crumpledAt; use an ISO timestamp"]);
});

test("doctor validates without repairing files or running the dreamer", async () => {
	const root = mkdtempSync(join(tmpdir(), "dream-doctor-test-"));
	mkdirSync(join(root, "human"));
	writeFileSync(join(root, "human/a.md"), note);
	writeFileSync(join(root, "human/MAP.md"), `${note}- \`a.md\``);
	const before = readFileSync(join(root, "human/a.md"));
	assert.deepEqual(doctor(root), []);
	assert.equal(await main(["doctor", "--notes-home", root], { runDreamer: async () => { throw new Error("must not run"); } }), 0);
	assert.deepEqual(readFileSync(join(root, "human/a.md")), before);
	assert.deepEqual(readdirSync(root), ["human"]);
	const missing = join(root, "absent");
	assert.equal(await main(["doctor", "--notes-home", missing]), 1);
	assert.equal(existsSync(missing), false);
});
