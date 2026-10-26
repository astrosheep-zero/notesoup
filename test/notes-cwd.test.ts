import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/value";
import { createNotesStore, projectKey, snapshotNotesIdentity, type NotesIdentity } from "../src/notes/index.js";
import { parseNote } from "../src/notes/frontmatter.js";
import { notesList, notesRead, notesSearch, notesUpdate, notesWrite } from "../src/tools/notes.js";
import { notesToolContext } from "../src/tools/notes-context.js";
import type { Outcome } from "../src/tools/result.js";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "notesoup-notes-cwd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "notes");
	const alpha = join(root, "alpha");
	const beta = join(root, "beta");
	const nested = join(alpha, "one", "two");
	mkdirSync(nested, { recursive: true });
	mkdirSync(beta);
	const identity = (cwd: string, sessionId = "session"): NotesIdentity => snapshotNotesIdentity({
		home, sessionId, projectKey: projectKey(cwd, home), agent: "agent", model: "model",
	});
	return { root, home, alpha, beta, nested, identity };
}

function data<T>(result: Outcome<T>): T {
	if (!result.ok) assert.fail(result.error.message);
	return result.data;
}

function refusal(result: Outcome<unknown>): { code: string; message: string } {
	if (result.ok) assert.fail("expected refusal");
	return result.error;
}

test("all five notes schemas accept one optional non-empty cwd", () => {
	for (const operation of [notesWrite, notesUpdate, notesRead, notesList, notesSearch]) {
		const base = operation === notesWrite ? { address: "a", content: "x" }
			: operation === notesUpdate ? { address: "a", edits: [{ oldText: "x", newText: "y" }] }
			: operation === notesSearch ? { query: "x" }
			: operation === notesRead ? { address: "a" } : {};
		assert.equal(Check(operation.parameters, { ...base, cwd: "../other" }), true, operation.name);
		assert.equal(Check(operation.parameters, { ...base, cwd: "" }), false, `${operation.name} rejects empty cwd`);
	}
});

test("one relative cwd retargets every operation without changing later calls", async (t) => {
	const f = fixture(t);
	const alpha = f.identity(f.alpha);
	const beta = f.identity(f.beta);
	await createNotesStore(alpha).write("@project/decision", "alpha needle");
	await createNotesStore(beta).write("@project/decision", "beta before");
	const context = notesToolContext(alpha, f.nested);
	const cwd = "../../../beta";

	const written = data(await notesWrite.execute({ address: "@project/other", content: "beta other needle", cwd }, context));
	assert.equal(written.project_key, beta.projectKey);
	assert.equal((await createNotesStore(alpha).read("@project/other")), undefined);
	assert.equal(data(await notesRead.execute({ address: "@project/other", cwd }, context)).text, "beta other needle");
	assert.equal(data(await notesRead.execute({ address: "@project/decision", cwd }, context)).text, "beta before");

	const moved = data(await notesUpdate.execute({ address: "@project/decision", rename_to: "@project/renamed", edits: [{ oldText: "before", newText: "after" }], cwd }, context));
	assert.equal(moved.project_key, beta.projectKey);
	assert.equal(moved.address, "@project/renamed.md");
	assert.equal((await createNotesStore(beta).read("@project/renamed"))?.body, "beta after");
	assert.equal((await createNotesStore(alpha).read("@project/decision"))?.body, "alpha needle");

	const defaultListed = data(await notesList.execute({ cwd }, context));
	assert.deepEqual(defaultListed.files.map(file => file.address).sort(), ["@project/other.md", "@project/renamed.md"], "an omitted glob selects the override's current notebooks");
	assert.ok(defaultListed.files.every(file => file.project_key === beta.projectKey));
	const listed = data(await notesList.execute({ glob: "@project/**", cwd }, context));
	assert.deepEqual(listed.files.map(file => file.address).sort(), ["@project/other.md", "@project/renamed.md"]);
	assert.ok(listed.files.every(file => file.project_key === beta.projectKey));
	const searched = data(await notesSearch.execute({ query: "needle", glob: "@project/**", cwd }, context));
	assert.deepEqual(searched.files.map(file => file.address), ["@project/other.md"]);

	// The captured context is unchanged: omitting cwd still means alpha.
	assert.equal(data(await notesRead.execute({ address: "@project/decision" }, context)).text, "alpha needle");
	assert.deepEqual(data(await notesList.execute({ glob: "@project/**" }, context)).files.map(file => file.address), ["@project/decision.md"]);
	assert.equal(context.identity.projectKey, alpha.projectKey);
});

test("a cwd override changes only new session-note ownership, not its physical session", async (t) => {
	const f = fixture(t);
	const alpha = f.identity(f.alpha);
	const beta = f.identity(f.beta);
	const context = notesToolContext(alpha, f.alpha);
	data(await notesWrite.execute({ address: "checkpoint", content: "first", cwd: f.beta }, context));
	const file = join(f.home, "pi", "session", alpha.sessionId, "checkpoint.md");
	assert.equal(parseNote(readFileSync(file, "utf8")).meta.project, beta.projectKey);
	data(await notesWrite.execute({ address: "checkpoint", content: "second" }, context));
	assert.equal(parseNote(readFileSync(file, "utf8")).meta.project, beta.projectKey, "an overwrite preserves existing ownership");
});

test("invalid explicit cwd refuses before a write", async (t) => {
	const f = fixture(t);
	const context = notesToolContext(f.identity(f.alpha), f.alpha);
	const file = join(f.root, "file");
	writeFileSync(file, "not a directory");
	for (const cwd of [join(f.root, "missing"), file]) {
		const result = refusal(await notesWrite.execute({ address: "@project/refused", content: "no", cwd }, context));
		assert.equal(result.code, "invalid_cwd");
		assert.match(result.message, /resolved to/);
	}
	assert.equal((await createNotesStore(f.identity(f.alpha)).read("@project/refused")), undefined);
});

test("cwd cannot escape or erase the active dream jail", async (t) => {
	const f = fixture(t);
	const alpha = f.identity(f.alpha);
	const beta = f.identity(f.beta);
	const gammaCwd = join(f.root, "gamma");
	mkdirSync(gammaCwd);
	const gamma = f.identity(gammaCwd);
	await createNotesStore(beta).write("@project/rule", "beta");
	const context = notesToolContext({ ...alpha, dreaming: beta.projectKey }, f.alpha);

	const escaped = refusal(await notesWrite.execute({ address: "@project/rule", content: "gamma", cwd: gammaCwd }, context));
	assert.equal(escaped.code, "invalid_scope");
	assert.equal((await createNotesStore(gamma).read("@project/rule")), undefined);
	const dreamed = await notesWrite.execute({ address: `@projects/${beta.projectKey}/rule`, content: "edited", cwd: gammaCwd }, context);
	assert.equal(dreamed.ok, true, "the original dreamed project remains writable through its named address");
	assert.equal((await createNotesStore(beta).read("@project/rule"))?.body, "edited");
});
