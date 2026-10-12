import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/value";
import { createNotesStore, type NotesIdentity } from "../src/notes/index.js";
import { assertAddress } from "../src/notes/address.js";
import { normalizeRemote, projectKey } from "../src/notes/project-home.js";
import { notesList, notesRead, notesSearch, notesUpdate, notesWrite } from "../src/tools/notes.js";
import { success, type Outcome } from "../src/tools/result.js";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "notesoup-project-home-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "notes");
	const repo = (path: string, origin?: string): string => {
		const cwd = join(root, path);
		mkdirSync(join(cwd, ".git"), { recursive: true });
		writeFileSync(join(cwd, ".git/config"), origin ? `[remote "origin"]\n\turl = ${origin}\n` : "");
		return cwd;
	};
	const marker = (key: string): { id: string; path: string } => JSON.parse(readFileSync(join(home, "project", key, ".project"), "utf8"));
	const identity = (cwd: string): NotesIdentity => ({ home, projectKey: projectKey(cwd, home), sessionId: "session", agent: "test", model: "test" });
	return { root, home, repo, marker, identity };
}

function data<T>(result: Outcome<T>): T {
	if (!result.ok) assert.fail(result.error.message);
	return result.data;
}

function refused(result: Outcome<unknown>): string {
	if (result.ok) assert.fail("expected refusal");
	return result.error.message;
}

test("origin identity normalizes https, scp and port-less ssh without invoking Git", t => {
	const { home, repo, marker } = fixture(t);
	for (const remote of ["https://user:secret@GitHub.COM/team/api.git/", "git@GitHub.COM:team/api.git", "ssh://git@GitHub.COM/team/api.git"]) {
		assert.equal(normalizeRemote(remote), "github.com/team/api");
	}
	assert.equal(normalizeRemote("ssh://git@EXAMPLE.com:2222/team/api.git"), "example.com:2222/team/api");
	const first = repo("one/api", "git@GitHub.COM:team/api.git");
	const second = repo("two/renamed", "https://github.com/team/api.git");
	assert.equal(projectKey(first, home), "api");
	assert.equal(projectKey(second, home), "api");
	assert.deepEqual(marker("api"), { id: "github.com/team/api", path: second });
});

test("same-basename repositories get readable suffixes and unmarked legacy names are taken", t => {
	const { home, repo } = fixture(t);
	const first = repo("one/x", "https://host/one/x");
	const second = repo("two/x", "https://host/two/x");
	assert.equal(projectKey(first, home), "x");
	assert.equal(projectKey(second, home), "x-1");
	mkdirSync(join(home, "project", "legacy"));
	writeFileSync(join(home, "project", "legacy", "keep.md"), "old notes");
	assert.equal(projectKey(repo("legacy"), home), "legacy-1");
	assert.equal(readFileSync(join(home, "project", "legacy", "keep.md"), "utf8"), "old notes");
});

test("linked worktrees and nested directories share the main checkout home and origin", t => {
	const { root, home, repo, marker } = fixture(t);
	const main = repo("api", "ssh://git@HOST/team/api.git");
	const worktree = join(root, "worktree");
	mkdirSync(worktree);
	mkdirSync(join(main, ".git/worktrees/wt"), { recursive: true });
	writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git/worktrees/wt")}\n`);
	writeFileSync(join(main, ".git/worktrees/wt/commondir"), "../..\n");
	assert.equal(projectKey(main, home), "api");
	assert.equal(projectKey(join(worktree, "missing/subdir"), home), "api");
	assert.deepEqual(marker("api"), { id: "host/team/api", path: main });
});

test("a moved checkout reuses its remote home and updates only the display root", async t => {
	const { root, home, repo, marker, identity } = fixture(t);
	const old = repo("api", "https://host/team/api.git");
	await createNotesStore(identity(old)).write("@project/decision", "keep me");
	const moved = join(root, "new-name");
	renameSync(old, moved);
	const current = identity(moved);
	assert.equal(current.projectKey, "api");
	assert.deepEqual(marker("api"), { id: "host/team/api", path: moved });
	assert.equal((await createNotesStore(current).read("@project/decision"))?.body, "keep me");
	assert.equal(projectKey(moved, home), "api");
});

test("adding origin adopts the canonical path identity without orphaning notes", async t => {
	const { home, repo, marker, identity } = fixture(t);
	const cwd = repo("api");
	await createNotesStore(identity(cwd)).write("@project/decision", "still here");
	assert.deepEqual(marker("api"), { id: cwd, path: cwd });
	writeFileSync(join(cwd, ".git/config"), '[remote "backup"]\nurl = https://host/wrong\n[remote "origin"]\nurl = git@HOST:team/api.git\n');
	assert.equal(projectKey(cwd, home), "api");
	assert.deepEqual(marker("api"), { id: "host/team/api", path: cwd });
	assert.equal((await createNotesStore(identity(cwd)).read("@project/decision"))?.body, "still here");
});

test("named projects read/list/search with root and sibling receipts, without touching stored bytes", async t => {
	const { home, repo, identity } = fixture(t);
	const first = repo("one/api", "https://host/one/backend");
	const second = repo("two/api", "https://host/two/service");
	const own = identity(first);
	const other = identity(second);
	await createNotesStore(own).write("@project/decision", "needle first");
	await createNotesStore(other).write("@project/decision", "needle second");
	const address = "@projects/api-1/decision.md";
	const file = join(home, "project/api-1/decision.md");
	const before = readFileSync(file, "utf8");
	const read = data(await notesRead.execute({ address }, own));
	assert.equal(read.text, "needle second");
	assert.equal(read.project_root, second);
	assert.deepEqual(read.project_siblings, [{ name: "api", path: first }]);
	assert.equal(Check(notesRead.outputSchema, read), true);
	assert.match(notesRead.render(success(read)), /Same-basename projects: api \(/);
	const listed = data(await notesList.execute({ glob: "@projects/*/**" }, own));
	assert.deepEqual(listed.files.map(row => [row.address, row.project_root]).sort(), [["@projects/api-1/decision.md", second], ["@projects/api/decision.md", first]].sort());
	assert.equal(Check(notesList.outputSchema, listed), true);
	const searched = data(await notesSearch.execute({ glob: "@projects/api-1/**", query: "needle" }, own));
	assert.equal(searched.files[0]?.project_root, second);
	assert.equal(Check(notesSearch.outputSchema, searched), true);
	assert.equal(readFileSync(file, "utf8"), before, "named-home reads never rewrite access metadata");
});

test("named project writes, edits, crumples and both move endpoints refuse, including the current home", async t => {
	const { repo, identity } = fixture(t);
	const own = identity(repo("api"));
	await createNotesStore(own).write("@project/decision", "body");
	const address = "@projects/api/decision";
	for (const result of [
		await notesWrite.execute({ address, content: "replacement" }, own),
		await notesUpdate.execute({ address, edits: [{ oldText: "body", newText: "changed" }] }, own, () => ""),
		await notesUpdate.execute({ address, crumpled: true }, own, () => ""),
		await notesUpdate.execute({ address, rename_to: "@project/moved" }, own, () => ""),
		await notesUpdate.execute({ address: "@project/decision", rename_to: "@projects/api/moved" }, own, () => ""),
	]) assert.match(refused(result), /read-only; use @project\//);
	assert.equal(data(await notesRead.execute({ address }, own)).text, "body");
	assert.throws(() => assertAddress("@projects/api/../decision"));
	assert.throws(() => assertAddress("@projects/api"));
});
