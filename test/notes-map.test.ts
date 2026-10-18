import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadNotesSnapshot } from "../src/boot/snapshot.js";
import { renderBootBlock } from "../src/boot/render.js";
import { createNotesStore, NoteError, type NotesIdentity } from "../src/notes/index.js";
import { notesWrite, notesRead, notesUpdate } from "../src/tools/notes.js";
import type { Outcome } from "../src/tools/result.js";

function fixture(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "notes-map-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const identity: NotesIdentity = { home, sessionId: "session-a", projectKey: "project-a", agent: "agent-a", model: "model-a" };
	const root = join(home, "pi/session/session-a");
	mkdirSync(root, { recursive: true });
	return { identity, root, notes: createNotesStore(identity) };
}

function data<T>(result: Outcome<T>): T {
	assert.ok(result.ok, JSON.stringify(result));
	return result.data;
}

async function boot(identity: NotesIdentity): Promise<string> {
	return renderBootBlock({
		agentName: identity.agent, modelName: identity.model,
		tree: { trunk: "test", windows: [{ shortName: "root", isCurrent: true }] },
		notes: await loadNotesSnapshot(identity, Date.now()),
		tools: { notes: "notes_*", notesList: "notes_list", history: "history_*", remaining: "get_context_remaining", wipe: "empty_brain" },
	});
}

test("lowercase tool addresses update the root MAP that the next boot loads", async (t) => {
	const { identity, root } = fixture(t);
	data(await notesWrite.execute({ address: "MAP.md", content: "old checkpoint" }, identity));
	const read = data(await notesRead.execute({ address: "map" }, identity));
	assert.equal(read.address, "MAP.md");
	assert.equal(read.text, "old checkpoint");
	assert.deepEqual(data(await notesWrite.execute({ address: "map", content: "new checkpoint" }, identity)), { address: "MAP.md", outcome: "overwrote" });
	assert.deepEqual(readdirSync(root), ["MAP.md"]);
	const rendered = await boot(identity);
	assert.match(rendered, /map\n\n  new checkpoint/);
	assert.doesNotMatch(rendered, /old checkpoint/);
});

test("boot recovers a lone legacy map.md without rewriting it", async (t) => {
	const { identity, root } = fixture(t);
	const path = join(root, "map.md");
	writeFileSync(path, "legacy checkpoint");
	assert.match(await boot(identity), /map\n\n  legacy checkpoint/);
	assert.equal(readFileSync(path, "utf8"), "legacy checkpoint");
	assert.equal(existsSync(join(root, "MAP.md")), false);
});

for (const prefix of ["", "@project/", "@human/", "@self/", "@model/"]) {
	test(`root MAP aliases share CRUD and canonical receipts in ${prefix || "session"}`, async (t) => {
		const { identity, notes } = fixture(t);
		const canonical = `${prefix}MAP.md`;
		for (const alias of ["map", "MAP", "Map", "map.md", "Map.md", "MAP.MD", "mAp.Md"]) {
			assert.equal(data(await notesWrite.execute({ address: prefix + alias, content: "before" }, identity)).address, canonical);
			const updated = data(await notesUpdate.execute({ address: prefix + alias, edits: [{ oldText: "before", newText: "after" }], rename_to: canonical }, identity));
			assert.equal(updated.address, canonical);
			assert.equal(updated.rename_from, undefined, "an alias rename does not remove the file");
			assert.equal(updated.change_kind, "body");
			const read = data(await notesRead.execute({ address: prefix + alias }, identity));
			assert.equal(read.address, canonical);
			assert.equal(read.text, "after");
		}
		assert.deepEqual((await notes.list()).map(row => row.address), [canonical]);
		assert.deepEqual((await notes.search(["after"])).map(row => row.address), [canonical]);
		assert.match(await boot(identity), /map\n\n  after/);
	});
}

for (const filename of ["map.md", "Map.md", "mAp.MD"]) {
	test(`legacy ${filename} stays a single file through reads, writes and renames`, async (t) => {
		const { identity, root, notes } = fixture(t);
		await notes.write("seed", "legacy", { origin: "user" });
		const raw = readFileSync(join(root, "seed.md"), "utf8").replace("\n---\n\n", "\ncustom: preserved\n---\n\n");
		rmSync(join(root, "seed.md"));
		writeFileSync(join(root, filename), raw);
		assert.match(await boot(identity), /map\n\n  legacy/);
		assert.equal(readFileSync(join(root, filename), "utf8"), raw, "boot does not stamp access metadata");
		const read = (await notes.read("MAP"))!;
		assert.equal(read.body, "legacy");
		assert.equal(read.meta.custom, "preserved");
		const written = await notes.write("map", "updated");
		assert.equal(written.outcome, "overwrote");
		assert.equal(written.meta.origin, "user");
		assert.equal(written.meta.createdAt, read.meta.createdAt);
		assert.equal(written.meta.custom, "preserved");
		await notes.rename("MAP.md", "map");
		await notes.update("map", [{ oldText: "updated", newText: "edited" }]);
		assert.deepEqual(readdirSync(root), [filename]);
		assert.deepEqual((await notes.list()).map(row => [row.path, row.address, row.body]), [["MAP.md", "MAP.md", "edited"]]);
		assert.deepEqual((await notes.search(["edited"])).map(row => row.address), ["MAP.md"]);
		await notes.rename("map", "features/map.md");
		assert.equal(existsSync(join(root, filename)), false);
		assert.equal((await notes.read("features/map"))?.body, "edited");
		await notes.rename("features/map", "mAp.MD");
		assert.equal((await notes.read("MAP"))?.body, "edited");
		assert.equal(existsSync(join(root, "MAP.md")), true);
	});
}

test("rename targets cannot bypass a live MAP; crumpled replacement and receipts stay canonical", async (t) => {
	const { identity, root, notes } = fixture(t);
	writeFileSync(join(root, "map.md"), "existing");
	await notes.write("draft", "replacement");
	await assert.rejects(notes.rename("draft", "MAP.MD"), { code: "already_exists" });
	assert.equal(readFileSync(join(root, "map.md"), "utf8"), "existing");
	await notes.update("MAP", undefined, { crumpled: true });
	const moved = data(await notesUpdate.execute({ address: "draft", rename_to: "mAp" }, identity));
	assert.equal(moved.address, "MAP.md");
	assert.equal(moved.rename_from, "draft.md");
	assert.equal(moved.change_kind, "moved");
	assert.deepEqual(readdirSync(root), ["map.md"]);
	const away = data(await notesUpdate.execute({ address: "map", rename_to: "archive" }, identity));
	assert.equal(away.rename_from, "MAP.md");
	assert.equal(away.address, "archive.md");
});

test("nested map notes and ordinary filename case are unchanged", async (t) => {
	const { root, notes } = fixture(t);
	for (const address of ["features/map.md", "features/MAP.md", "roadmap.md", "Other.md", "map.txt", "other.MD"]) {
		await notes.write(address, address);
		assert.equal((await notes.read(address))?.body, address);
	}
	assert.equal(existsSync(join(root, "MAP.md")), false);
	assert.equal(existsSync(join(root, "other.MD.md")), true, "ordinary extension behavior is unchanged");
	assert.equal((await notes.list()).length, readdirSync(join(root, "features")).length + 4);
});

test("named read-only homes resolve legacy aliases without modifying metadata", async (t) => {
	const { identity } = fixture(t);
	for (const [directory, address] of [["pi/session/other", "@sessions/other/map"], ["project/other", "@projects/other/mAp.MD"]] as const) {
		const root = join(identity.home, directory);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "map.md"), "foreign checkpoint");
		assert.equal(data(await notesRead.execute({ address }, identity)).address, address.replace(/[^/]+$/, "MAP.md"));
		assert.equal(readFileSync(join(root, "map.md"), "utf8"), "foreign checkpoint");
		const write = await notesWrite.execute({ address, content: "forbidden" }, identity);
		assert.ok(!write.ok);
		assert.equal(write.error.code, "invalid_scope");
	}
});

test("root aliases serialize read/modify/write operations across stores, including legacy files", async (t) => {
	const { identity, root, notes } = fixture(t);
	writeFileSync(join(root, "map.md"), "alpha beta");
	const other = createNotesStore(identity);
	await Promise.all([
		notes.update("map", [{ oldText: "alpha", newText: "A" }]),
		other.update("MAP.MD", [{ oldText: "beta", newText: "B" }]),
	]);
	assert.equal((await notes.read("Map"))?.body, "A B");
	const before = (await notes.list())[0]!.meta.accessCount;
	await Promise.all([notes.read("map"), other.read("MAP.md")]);
	assert.equal((await notes.list())[0]!.meta.accessCount, before + 2);
	assert.deepEqual(readdirSync(root), ["map.md"]);
});

for (const variant of ["different", "identical", "crumpled"] as const) {
	test(`${variant} legacy collisions refuse tools, moves, deletion and boot without touching either file`, async (t) => {
		const { identity, root, notes } = fixture(t);
		await notes.write("MAP.md", "canonical checkpoint");
		if (variant === "crumpled") await notes.update("MAP", undefined, { crumpled: true });
		const canonical = readFileSync(join(root, "MAP.md"), "utf8");
		const legacy = variant === "identical" ? canonical : "legacy checkpoint";
		writeFileSync(join(root, "map.md"), legacy);
		if (readdirSync(root).length !== 2) return t.skip("requires a case-sensitive filesystem");
		await notes.write("draft", "unrelated");
		const draft = readFileSync(join(root, "draft.md"), "utf8");
		const conflict = (error: unknown): boolean => {
			assert.ok(error instanceof NoteError);
			assert.equal(error.code, "map_conflict");
			assert.match(error.message, /MAP\.md, map\.md/);
			assert.match(error.message, /Back up and compare/);
			assert.match(error.message, /one MAP\.md/);
			return true;
		};
		for (const action of [
			() => notes.read("MAP.md"), () => notes.read("map"),
			() => notes.write("map", "overwrite"),
			() => notes.update("map", [{ oldText: "checkpoint", newText: "changed" }]),
			() => notes.rename("MAP", "archive"), () => notes.rename("draft", "map"),
			() => notes.rename("map", "MAP.md"),
			() => createNotesStore({ ...identity, dreaming: identity.projectKey }).forget("map"),
			() => notes.list(), () => notes.search(["checkpoint"]),
			() => notes.listWithStatus(), () => notes.searchWithStatus([]),
			() => boot(identity),
		]) await assert.rejects(action(), conflict);
		for (const result of [
			await notesRead.execute({ address: "map" }, identity),
			await notesWrite.execute({ address: "MAP", content: "overwrite" }, identity),
			await notesUpdate.execute({ address: "draft", rename_to: "map" }, identity),
		]) {
			assert.ok(!result.ok);
			assert.equal(result.error.code, "map_conflict");
			assert.match(result.error.message, /Back up and compare/);
		}
		assert.equal(readFileSync(join(root, "MAP.md"), "utf8"), canonical);
		assert.equal(readFileSync(join(root, "map.md"), "utf8"), legacy);
		assert.equal(readFileSync(join(root, "draft.md"), "utf8"), draft);
		assert.deepEqual(readdirSync(root).sort(), ["MAP.md", "draft.md", "map.md"]);
	});
}
