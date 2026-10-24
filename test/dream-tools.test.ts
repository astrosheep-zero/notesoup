import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { Check } from "typebox/value";
import { createNotesStore, type NotesIdentity } from "../src/notes/index.js";
import { abandonDream, dreamBegin, dreamEnd, dreamForget, dreamingIdentity, type DreamState } from "../src/tools/dream.js";
import { notesRead, notesUpdate, notesWrite } from "../src/tools/notes.js";
import { notesToolContext } from "../src/tools/notes-context.js";

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
	const ident = () => notesToolContext(dreamingIdentity(me, state), "/work/alpha");

	// Closed: named homes are read-only and forget refuses.
	assert.equal((await notesWrite.execute({ address: "@projects/beta/rule", content: "x" }, ident())).ok, false);
	assert.equal((await dreamForget.execute({ address: "@sessions/b2/trash" }, me, state)).ok, false);

	const begun = await dreamBegin.execute({ project: "beta" }, me, state);
	assert.ok(begun.ok);
	assert.deepEqual(begun.data.files.map(f => f.address).sort(), ["@projects/beta/rule.md", "@sessions/b1/checkpoint.md", "@sessions/b2/trash.md"]);
	assert.ok(begun.data.files.every(f => typeof f.last_accessed === "string"), "the dream's list shows each note's last access");
	assert.match(dreamBegin.render(begun), /\| accessed /);
	assert.equal((await dreamBegin.execute({}, me, state)).ok, false, "only one dream at a time");
	assert.ok(existsSync(join(home, ".dream.lock")), "the notes-home lock is held");
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
	assert.equal(existsSync(join(home, ".dream.lock")), false, "the lock is released");
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: home, encoding: "utf8" }), "", "the audit leaves a clean tree");
	assert.equal((await notesWrite.execute({ address: "@projects/beta/rule", content: "x" }, ident())).ok, false, "closed again");
	assert.equal((await dreamEnd.execute({}, me, state)).ok, false);
});

test("pending openings exclude concurrent begins and stale cleanup preserves a newer generation", async (t) => {
	const { home, as } = fixture(t);
	const me = as("s", "alpha");
	const state: DreamState = {};
	const old = dreamBegin.execute({}, me, state);
	const pending = state.pending;
	assert.ok(pending, "ownership is visible before the first await");
	assert.equal(state.project, undefined, "opening does not publish dream permissions yet");
	assert.equal(dreamingIdentity(me, state), me);
	const concurrent = await dreamBegin.execute({ project: "beta" }, me, state);
	assert.ok(!concurrent.ok && concurrent.error.code === "already_dreaming");
	assert.equal(state.pending, pending);

	abandonDream(state);
	assert.equal(existsSync(join(home, ".dream.lock")), false);
	const newer = dreamBegin.execute({ project: "beta" }, me, state);
	const newerPending = state.pending;
	assert.ok(newerPending && newerPending.generation > pending.generation);
	const token = readFileSync(join(home, ".dream.lock"), "utf8");
	const cancelled = await old;
	assert.ok(!cancelled.ok && cancelled.error.code === "cancelled");
	assert.equal(readFileSync(join(home, ".dream.lock"), "utf8"), token);
	const begun = await newer;
	assert.ok(begun.ok);
	assert.equal(state.project, "beta");
	assert.equal(state.pending, undefined);
	assert.ok((await dreamEnd.execute({}, me, state)).ok);
	assert.equal(existsSync(join(home, ".dream.lock")), false);
});

test("a thrown scan releases pending ownership before propagating the defect", async (t) => {
	const { home, as } = fixture(t);
	const state: DreamState = {};
	const sentinel = new TypeError("scan defect");
	const original = fs.readdir;
	t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
		if (args[0] === join(home, "project", "alpha")) throw sentinel;
		return original(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	await assert.rejects(dreamBegin.execute({}, as("s", "alpha"), state), error => error === sentinel);
	assert.equal(existsSync(join(home, ".dream.lock")), false);
	assert.equal(state.pending, undefined);
	assert.equal(state.project, undefined);
	assert.equal(state.lock, undefined);
	t.mock.restoreAll();
	syncBuiltinESMExports();
	assert.ok((await dreamBegin.execute({}, as("s", "alpha"), state)).ok, "the same state can retry after a failed scan");
	assert.ok((await dreamEnd.execute({}, as("s", "alpha"), state)).ok);
});

test("baseline failure releases pending ownership and permits a retry", async (t) => {
	const { home, as } = fixture(t);
	const me = as("s", "alpha");
	const state: DreamState = {};
	writeFileSync(join(home, ".git"), "not a Git repository");
	const failed = await dreamBegin.execute({}, me, state);
	assert.ok(!failed.ok && failed.error.code === "audit_failed");
	assert.equal(existsSync(join(home, ".dream.lock")), false);
	assert.equal(state.pending, undefined);
	assert.equal(state.project, undefined);
	assert.equal(state.lock, undefined);
	const ended = await dreamEnd.execute({}, me, state);
	assert.ok(!ended.ok && ended.error.code === "not_dreaming");
	rmSync(join(home, ".git"));
	assert.ok((await dreamBegin.execute({}, me, state)).ok);
	assert.ok((await dreamEnd.execute({}, me, state)).ok);
});

test("notes_read reports the access before itself, so reading never makes an unread note look fresh", async (t) => {
	const { home, as } = fixture(t);
	const me = as("s", "alpha");
	const old = "2026-01-01T08:00:00.000+08:00";
	mkdirSync(join(home, "human"), { recursive: true });
	writeFileSync(join(home, "human", "stale.md"), `---\norigin: self\ncreatedAt: ${old}\nupdatedAt: ${old}\nlastAccessed: ${old}\naccessCount: 0\n---\n\nbody`);
	const first = await notesRead.execute({ address: "@human/stale" }, notesToolContext(me, "/work/alpha"));
	assert.ok(first.ok);
	assert.equal(Date.parse(first.data.metadata.last_accessed), Date.parse(old), "the first read shows the old access");
	const second = await notesRead.execute({ address: "@human/stale" }, notesToolContext(me, "/work/alpha"));
	assert.ok(second.ok);
	assert.ok(Date.parse(second.data.metadata.last_accessed) > Date.parse(old), "the first read still counted as an access");
});

test("dream_begin refuses an unknown project", async (t) => {
	const { as } = fixture(t);
	const state: DreamState = {};
	assert.equal((await dreamBegin.execute({ project: "nope" }, as("s", "alpha"), state)).ok, false);
	assert.equal(state.project, undefined);
});

test("dream_forget resolves address aliases before authorizing deletion", async (t) => {
	const { home, as } = fixture(t);
	const alpha = as("alpha-session", "alpha");
	await createNotesStore(alpha).write("@project/precious", "keep alpha");
	await createNotesStore(alpha).update("@project/precious", undefined, { crumpled: true });
	await createNotesStore(alpha).write("local", "keep alpha session");
	await createNotesStore(alpha).update("local", undefined, { crumpled: true });
	await createNotesStore(as("beta-session", "beta")).write("@project/trash", "delete beta");
	await createNotesStore(as("beta-session", "beta")).update("@project/trash", undefined, { crumpled: true });

	const state: DreamState = {};
	assert.ok((await dreamBegin.execute({ project: "beta" }, alpha, state)).ok);
	for (const address of ["@projects/alpha/precious", "@project/precious", "local"]) {
		const refused = await dreamForget.execute({ address }, alpha, state);
		assert.equal(refused.ok, false, `${address} is outside the beta dream`);
		assert.ok(!refused.ok && refused.error.code === "invalid_scope");
	}
	assert.equal(await createNotesStore(alpha).read("@project/precious").then(note => note?.body), "keep alpha");
	assert.equal(await createNotesStore(alpha).read("local").then(note => note?.body), "keep alpha session");
	assert.ok((await dreamForget.execute({ address: "@projects/beta/trash" }, alpha, state)).ok, "the named note in the dreamed project remains deletable");
	assert.equal(existsSync(join(home, "project", "beta", "trash.md")), false);
	assert.ok((await dreamEnd.execute({}, alpha, state)).ok);
});

test("named-project mutation receipts carry their project metadata and fit their own schemas", async (t) => {
	const { home, as } = fixture(t);
	// A same-basename checkout makes the dreamed home carry a sibling hint.
	mkdirSync(join(home, "project", "beta-1"), { recursive: true });
	writeFileSync(join(home, "project", "beta-1", ".project"), JSON.stringify({ id: "host/two/beta", path: "/work/two/beta" }));
	const me = as("now", "alpha");
	const state: DreamState = {};
	const ident = () => notesToolContext(dreamingIdentity(me, state), "/work/alpha");

	assert.equal((await notesWrite.execute({ address: "@projects/beta-1/rule", content: "x" }, ident())).ok, false, "named projects stay read-only outside a dream");
	assert.ok((await dreamBegin.execute({ project: "beta-1" }, me, state)).ok);

	const written = await notesWrite.execute({ address: "@projects/beta-1/rule", content: "merged" }, ident());
	assert.ok(written.ok);
	assert.equal(written.data.project_root, "/work/two/beta");
	assert.deepEqual(written.data.project_siblings, [{ name: "beta", path: "/work/beta" }]);
	assert.equal(Check(notesWrite.outputSchema, written.data), true, "notes_write accepts its own named-project receipt");

	const updated = await notesUpdate.execute({ address: "@projects/beta-1/rule", edits: [{ oldText: "merged", newText: "done" }] }, ident(), () => "");
	assert.ok(updated.ok);
	assert.equal(updated.data.project_root, "/work/two/beta");
	assert.deepEqual(updated.data.project_siblings, [{ name: "beta", path: "/work/beta" }]);
	assert.equal(Check(notesUpdate.outputSchema, updated.data), true, "notes_update accepts its own named-project receipt");

	assert.ok((await notesUpdate.execute({ address: "@projects/beta-1/rule", crumpled: true }, ident(), () => "")).ok);
	const forgotten = await dreamForget.execute({ address: "@projects/beta-1/rule" }, me, state);
	assert.ok(forgotten.ok);
	assert.equal(forgotten.data.project_root, "/work/two/beta");
	assert.deepEqual(forgotten.data.project_siblings, [{ name: "beta", path: "/work/beta" }]);
	assert.equal(Check(dreamForget.outputSchema, forgotten.data), true, "dream_forget accepts its own named-project receipt");
	assert.ok((await dreamEnd.execute({}, me, state)).ok);
});

test("a notes-home lock prevents interleaved dream Git audits", async (t) => {
	const { home, as } = fixture(t);
	const alpha = as("alpha-session", "alpha"), beta = as("beta-session", "beta");
	await createNotesStore(alpha).write("@project/note", "before alpha");
	await createNotesStore(beta).write("@project/note", "before beta");
	const alphaState: DreamState = {}, betaState: DreamState = {};
	const begun = await dreamBegin.execute({ project: "alpha" }, alpha, alphaState);
	assert.ok(begun.ok);
	assert.ok((await notesWrite.execute({ address: "@project/note", content: "after alpha" }, notesToolContext(dreamingIdentity(alpha, alphaState), "/work/alpha"))).ok);

	const refused = await dreamBegin.execute({ project: "beta" }, beta, betaState);
	assert.equal(refused.ok, false, "a different project cannot share the home's Git audit");
	assert.ok(!refused.ok && refused.error.code === "already_dreaming");
	assert.deepEqual(betaState, {}, "a refused dream publishes no state");
	assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: home, encoding: "utf8" }).trim(), begun.data.baseline, "a refused begin creates no baseline");

	const ended = await dreamEnd.execute({}, alpha, alphaState);
	assert.ok(ended.ok && ended.data.commit !== undefined);
	assert.notEqual(ended.data.commit, begun.data.baseline);
	const changed = execFileSync("git", ["show", "--format=", "--name-only", ended.data.commit], { cwd: home, encoding: "utf8" });
	assert.match(changed, /project\/alpha\/note\.md/);
	assert.doesNotMatch(changed, /project\/beta\/note\.md/);
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: home, encoding: "utf8" }), "");
	assert.ok((await dreamBegin.execute({ project: "beta" }, beta, betaState)).ok, "the next dream can start after the home lock is released");
	assert.ok((await dreamEnd.execute({}, beta, betaState)).ok);
});
