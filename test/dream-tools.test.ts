import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createNotesStore, type NotesIdentity } from "../src/notes/index.js";
import { dreamBegin, dreamEnd, dreamForget, dreamingIdentity, type DreamState } from "../src/tools/dream.js";
import { notesRead, notesUpdate, notesWrite } from "../src/tools/notes.js";

function fixture(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "dream-tools-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const mark = (name: string) => {
		mkdirSync(join(home, "project", name), { recursive: true });
		writeFileSync(join(home, "project", name, ".project"), JSON.stringify({ id: name, path: `/work/${name}` }));
	};
	mark("alpha");
	mark("beta");
	const as = (sessionId: string, projectKey: string): NotesIdentity => ({ home, sessionId, projectKey, agent: "root", model: "m" });
	return { home, as };
}

test("a dream opens one other project, writes its notes, deletes only crumpled ones, then closes", async (t) => {
	const { home, as } = fixture(t);
	// Seed: beta's project note and two beta sessions, plus one alpha session.
	await createNotesStore(as("b1", "beta")).write("@project/rule", "keep");
	await createNotesStore(as("b1", "beta")).write("checkpoint", "old");
	await createNotesStore(as("b2", "beta")).write("trash", "x");
	await createNotesStore(as("b2", "beta")).update("trash", undefined, { crumpled: true });
	await createNotesStore(as("a1", "alpha")).write("mine", "alpha only");

	const me = as("now", "alpha");
	const state: DreamState = {};
	const ident = () => dreamingIdentity(me, state);

	// Closed: named homes are read-only and forget refuses.
	assert.equal((await notesWrite.execute({ address: "@projects/beta/rule", content: "x" }, ident())).ok, false);
	assert.equal((await dreamForget.execute({ address: "@sessions/b2/trash" }, me, state)).ok, false);

	const begun = await dreamBegin.execute({ project: "beta" }, me, state);
	assert.ok(begun.ok);
	assert.deepEqual(begun.data.files.map(f => f.address).sort(), ["@projects/beta/rule.md", "@sessions/b1/checkpoint.md", "@sessions/b2/trash.md"]);
	assert.equal((await dreamBegin.execute({}, me, state)).ok, false, "only one dream at a time");
	assert.ok(existsSync(join(home, ".dream.lock.beta")), "the project lock is held");
	assert.equal((await dreamBegin.execute({ project: "beta" }, as("other", "alpha"), {})).ok, false, "another session can't dream the same project");

	assert.ok((await notesWrite.execute({ address: "@projects/beta/rule", content: "merged" }, ident())).ok);
	assert.ok((await notesUpdate.execute({ address: "@sessions/b1/checkpoint", edits: [{ oldText: "old", newText: "new" }] }, ident(), () => "")).ok);
	assert.equal((await notesWrite.execute({ address: "@sessions/a1/mine", content: "x" }, ident())).ok, false, "another project's session stays read-only");
	assert.equal((await notesWrite.execute({ address: "@projects/alpha/x", content: "x" }, ident())).ok, false, "other projects stay read-only");

	const read = await notesRead.execute({ address: "@human/none" }, ident());
	assert.equal(read.ok, false);
	await createNotesStore(me).write("@human/pref", "p");
	const before = (await createNotesStore(me).list({ glob: "@human/**" }))[0]!.meta.accessCount;
	assert.ok((await notesRead.execute({ address: "@human/pref" }, ident())).ok);
	assert.equal((await createNotesStore(me).list({ glob: "@human/**" }))[0]!.meta.accessCount, before, "dream reads leave no stamp");

	assert.equal((await dreamForget.execute({ address: "@sessions/b1/checkpoint" }, me, state)).ok, false, "live notes refuse");
	assert.ok((await dreamForget.execute({ address: "@sessions/b2/trash" }, me, state)).ok);
	assert.equal(existsSync(join(home, "pi", "session", "b2", "trash.md")), false);

	const ended = await dreamEnd.execute({}, me, state);
	assert.ok(ended.ok && ended.data.commit && ended.data.commit !== begun.data.baseline, "dream_end commits the changes");
	assert.equal(existsSync(join(home, ".dream.lock.beta")), false, "the lock is released");
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: home, encoding: "utf8" }), "", "the audit leaves a clean tree");
	assert.equal((await notesWrite.execute({ address: "@projects/beta/rule", content: "x" }, ident())).ok, false, "closed again");
	assert.equal((await dreamEnd.execute({}, me, state)).ok, false);
});

test("dream_begin refuses an unknown project", async (t) => {
	const { as } = fixture(t);
	const state: DreamState = {};
	assert.equal((await dreamBegin.execute({ project: "nope" }, as("s", "alpha"), state)).ok, false);
	assert.equal(state.project, undefined);
});
