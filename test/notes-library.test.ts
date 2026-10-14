import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotesStore, NoteError, type NotesIdentity } from "../src/notes/index.js";

function fixture(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "notes-library-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const context: NotesIdentity = { home, sessionId: "session-a", projectKey: "project-12345678", agent: "root", model: "test-model" };
	return { home, context, notes: createNotesStore(context) };
}

test("standalone notes API persists camelCase metadata, edits, lists and searches full results", async (t) => {
	const { home, notes } = fixture(t);
	const first = await notes.write("checkpoint", "alpha\nneedle 😀", { origin: "user" });
	assert.equal(first.meta.project, "project-12345678");
	const read = (await notes.read("checkpoint.md"))!;
	assert.equal(read.body, "alpha\nneedle 😀");
	assert.equal(read.meta.origin, "user");
	assert.equal(read.meta.accessCount, 1);
	assert.equal(await notes.read("missing.md"), undefined);
	const edited = await notes.update("checkpoint", [{ oldText: "alpha", newText: "beta" }]);
	assert.deepEqual(edited.change, { kind: "body", before: "alpha\nneedle 😀", after: "beta\nneedle 😀" });
	assert.equal(edited.resolvedScope, read.resolvedScope);
	assert.equal(edited.applied, 1);
	const updatedBefore = (await notes.read("checkpoint"))!.meta.updatedAt;
	const metadataEdit = await notes.update("checkpoint", undefined, { crumpled: true });
	assert.equal(metadataEdit.change.kind, "metadata");
	assert.equal(metadataEdit.change.before.includes("crumpledAt"), false);
	assert.match(metadataEdit.change.after, /\ncrumpledAt: \d{4}-\d{2}-\d{2}T/);
	assert.equal(metadataEdit.change.after.includes("needle"), false, "metadata-only diff excludes body");
	assert.equal((await notes.list()).some((row) => row.address === "checkpoint.md"), false, "a crumpled note leaves the live list");
	assert.equal((await notes.search(["needle"])).length, 0, "search also skips crumpled notes");
	const basket = (await notes.list({ crumpled: true }))[0]!;
	assert.equal(basket.address, "checkpoint.md");
	assert.ok(basket.meta.crumpledAt);
	assert.equal(basket.meta.updatedAt, updatedBefore, "crumpling does not bump updatedAt");
	const crumpledAt = basket.meta.crumpledAt;
	await notes.update("checkpoint", undefined, { crumpled: true });
	assert.equal((await notes.list({ crumpled: true }))[0]?.meta.crumpledAt, crumpledAt, "re-crumpling keeps the original time");
	await notes.update("checkpoint", undefined, { crumpled: false });
	assert.equal((await notes.list()).some((row) => row.address === "checkpoint.md"), true, "smoothing returns the note to the live list");
	assert.equal((await notes.list({ crumpled: true })).length, 0);
	const matches = await notes.search(["needle"]);
	assert.equal(matches[0]?.matches[0]?.line, 2);
	const body = (await notes.read("checkpoint"))!.body;
	assert.equal(Array.from(body).slice(matches[0]!.matches[0]!.offsetChars).join(""), "needle 😀", "offsets address the body, so they survive the access-counter rewrite a read performs");

	// An existing hand-written extra field and original ownership survive a new caller.
	const path = join(home, "pi/session/session-a/checkpoint.md");
	writeFileSync(path, readFileSync(path, "utf8").replace("\n---\n\n", "\nsourceWindow: pcw:test\nrecurrenceCount: 2\nrecurrenceWindows:\n  - pcw:one\n  - pcw:two\n__proto__: {\"sentinel\":true}\ncustom: preserved\n---\n\n"));
	const moved = createNotesStore({ home, sessionId: "session-a", projectKey: "other-12345678", agent: "root", model: "test-model" });
	const rewritten = await moved.write("checkpoint", "new body");
	assert.equal(rewritten.meta.createdAt, first.meta.createdAt);
	assert.equal(rewritten.meta.project, "project-12345678");
	assert.equal(rewritten.meta.custom, "preserved");
	assert.deepEqual(rewritten.meta["__proto__"], { sentinel: true });
	assert.deepEqual((await moved.read("checkpoint"))?.meta["__proto__"], { sentinel: true }, "unknown __proto__ metadata survives persistence and reread");
	assert.equal(rewritten.meta.sourceWindow, "pcw:test");
	assert.equal(rewritten.meta.recurrenceCount, 2);
	assert.deepEqual(rewritten.meta.recurrenceWindows, ["pcw:one", "pcw:two"]);
	assert.equal(rewritten.meta.crumpledAt, undefined, "writing always produces an uncrumpled note");
	const combined = await moved.update("checkpoint", [{ oldText: "new", newText: "final" }], { crumpled: true });
	assert.equal(combined.change.kind, "body");
	assert.match(combined.change.after, /\ncrumpledAt: \d{4}-\d{2}-\d{2}T/);
	assert.match(combined.change.after, /final body$/);
	assert.deepEqual((await moved.update("checkpoint", undefined, { crumpled: true })).change, { kind: "none", before: "", after: "" });
	assert.equal((await moved.write("checkpoint", "revived body")).meta.crumpledAt, undefined, "writing a crumpled address smooths it");
});

test("same-file read/modify/write operations serialize across stores and markdown aliases", async (t) => {
	const { home, context, notes } = fixture(t);
	const other = createNotesStore(context);
	await notes.write("shared", "alpha\nbeta");

	const firstEdit = notes.update("shared", [{ oldText: "alpha", newText: "A" }]);
	const secondEdit = other.update("shared.md", [{ oldText: "beta", newText: "B" }]);
	await Promise.all([firstEdit, secondEdit]);
	assert.equal((await notes.read("shared"))?.body, "A\nB", "edits through address aliases retain both changes");

	const before = (await notes.read("shared"))!.meta.accessCount;
	const [readA, readB] = await Promise.all([notes.read("shared.md"), other.read("shared")]);
	assert.ok(readA && readB);
	assert.equal((await notes.list())[0]?.meta.accessCount, before + 2, "parallel reads do not lose access-counter updates");

	const file = join(home, "pi/session/session-a/shared.md");
	const stableEdits = [{ oldText: "A", newText: "first" }];
	const operation = notes.update("shared", stableEdits);
	stableEdits[0]!.newText = "mutated after call";
	await operation;
	assert.equal((await notes.read("shared"))?.body, "first\nB", "edit arguments are snapshotted at method entry");
	assert.equal(readFileSync(file, "utf8").includes("mutated after call"), false);
});

test("stores snapshot explicit identity and do not leak homes across instances", async (t) => {
	const { home, context } = fixture(t);
	const mutable = { ...context };
	const notes = createNotesStore(mutable);
	const other = createNotesStore({ ...context, home: join(home, "other"), agent: "other-agent", model: "other-model" });
	assert.equal(existsSync(join(home, "other")), false, "construction does not create the supplied home");
	mutable.agent = "changed-after-construction";
	await notes.write("@self/private", "first");
	await other.write("@self/private", "second");
	assert.equal((await notes.read("@self/private"))?.body, "first");
	assert.equal((await other.read("@self/private"))?.body, "second");
	assert.equal((await notes.list())[0]?.address, "@self/private.md");
	assert.equal((await other.list())[0]?.address, "@self/private.md");

	mkdirSync(join(home, "agents/visitor"), { recursive: true });
	writeFileSync(join(home, "agents/visitor/hello.md"), "visiting");
	assert.equal((await notes.read("@agents/visitor/hello"))?.body, "visiting");
	await assert.rejects(() => notes.write("@agents/visitor/hello", "overwrite"), (error: unknown) => error instanceof NoteError && error.code === "invalid_scope");
});

test("list and search share scoped glob scans and search offsets count Unicode code points", async (t) => {
	const { notes } = fixture(t);
	await notes.write("shared.md", "😀 needle in session");
	await notes.write("@project/shared.md", "needle in project");
	await notes.write("@human/shared.md", "needle in human");
	await notes.write("@project/elsewhere.md", "unrelated");

	const glob = "**/shared.md";
	const listed = await notes.list({ glob });
	const searched = await notes.search(["needle"], { glob });
	const listedAddresses = listed.map((row) => row.address).sort();
	const searchedAddresses = searched.map((row) => row.address).sort();
	assert.deepEqual(searchedAddresses, ["@human/shared.md", "@project/shared.md", "shared.md"]);
	assert.deepEqual(searchedAddresses, listedAddresses, "list and search traverse the same filtered homes and files");

	const sessionMatch = searched.find((row) => row.address === "shared.md")!.matches[0]!;
	const body = (await notes.read("shared.md"))!.body;
	assert.equal(body, "😀 needle in session");
	assert.equal(Array.from(body).slice(sessionMatch.offsetChars).join(""), "needle in session", "the body offset counts the emoji as one code point and lands on the match");
});

test("search offsets address the body and never move when access metadata grows", async (t) => {
	const { notes } = fixture(t);
	await notes.write("counted.md", "needle here");
	const offsetOf = async () => (await notes.search(["needle"])).find((row) => row.address === "counted.md")!.matches[0]!.offsetChars;
	assert.equal(await offsetOf(), 0, "a match at the first body character has body offset 0");
	// Walk the access counter across a digit boundary; an offset into the serialized file
	// would shift by one character here, because the rewrite adds a digit to the frontmatter.
	for (let read = 0; read < 12; read++) await notes.read("counted.md");
	assert.equal((await notes.list()).find((row) => row.address === "counted.md")!.meta.accessCount, 12);
	assert.equal(await offsetOf(), 0, "reads that rewrite access metadata do not move the match");

	await notes.write("front.md", `---\nbig: ${"x".repeat(200)}\n---\n\nneedle later`);
	const frontMatch = (await notes.search(["needle"])).find((row) => row.address === "front.md")!.matches[0]!;
	const frontBody = (await notes.read("front.md"))!.body;
	assert.equal(frontBody, "needle later");
	assert.equal(frontMatch.offsetChars, 0, "frontmatter length is not part of the body offset");
	assert.equal(Array.from(frontBody).slice(frontMatch.offsetChars).join(""), "needle later");
	assert.deepEqual(Object.keys((await notes.read("counted.md"))!).sort(), ["body", "meta", "resolvedScope"], "a read exposes metadata and the body, never a serialized rendering");
});

test("invalid addressing and failed edits leave stored bytes untouched without poisoning the queue", async (t) => {
	const { home, context, notes } = fixture(t);
	assert.throws(() => createNotesStore({ ...context, sessionId: "../escape" }));
	await assert.rejects(() => notes.write("@project/../escape", "bad"), (error: unknown) => error instanceof NoteError && error.code === "invalid_address");
	await assert.rejects(() => notes.list({ glob: "@agents/../escape/**" }));
	await notes.write("edit", "alpha\nbeta\nbeta");
	const path = join(home, "pi/session/session-a/edit.md");
	const before = readFileSync(path, "utf8");
	await assert.rejects(() => notes.update("edit", [{ oldText: "beta", newText: "B" }]), (error: unknown) => error instanceof NoteError && error.code === "ambiguous_edit" && error.lineNumbers?.join(",") === "2,3");
	await assert.rejects(() => notes.update("edit", [{ oldText: "alpha", newText: "A" }, { oldText: "absent", newText: "X" }]), (error: unknown) => error instanceof NoteError && error.code === "no_match" && error.editIndex === 1);
	await assert.rejects(() => notes.update("edit", [{ oldText: "", newText: "X" }]), (error: unknown) => error instanceof NoteError && error.code === "invalid_edit");
	// @ts-expect-error malformed JavaScript callers receive a parameter error, not no_match
	await assert.rejects(() => notes.update("edit", [{ oldText: "alpha", newText: 5 }]), (error: unknown) => error instanceof NoteError && error.code === "invalid_edit");
	assert.equal(readFileSync(path, "utf8"), before);
	await assert.rejects(() => notes.update("absent", undefined, { crumpled: true }), (error: unknown) => error instanceof NoteError && error.code === "not_found");
	await notes.update("edit", [{ oldText: "alpha", newText: "A" }]);
	assert.equal((await notes.read("edit"))?.body, "A\nbeta\nbeta", "failed operations do not poison later queue work");
});

test("rename moves a note with metadata intact across scopes and refuses live targets", async (t) => {
	const { context, notes } = fixture(t);
	const written = await notes.write("old-name", "body text", { origin: "user" });
	await notes.read("old-name.md");
	const moved = await notes.rename("old-name.md", "@project/new-name.md");
	assert.equal(moved.meta.createdAt, written.meta.createdAt, "createdAt survives the move");
	assert.equal(moved.meta.origin, "user");
	assert.equal(moved.meta.accessCount, 1, "accessCount survives the move");
	assert.ok(moved.meta.updatedAt >= written.meta.updatedAt, "updatedAt is bumped");
	assert.equal(moved.meta.project, undefined, "leaving the session scope drops project ownership");
	assert.equal(moved.replacedCrumpledTarget, false);
	assert.equal(await notes.read("old-name.md"), undefined, "the old address is gone");
	assert.equal((await notes.read("@project/new-name.md"))?.body, "body text");

	const back = await notes.rename("@project/new-name.md", "back.md");
	assert.equal(back.meta.project, context.projectKey, "entering the session scope stamps current project ownership");
	assert.equal((await notes.read("back.md"))?.meta.createdAt, written.meta.createdAt);

	const within = await notes.rename("back.md", "still-back.md");
	assert.equal(within.meta.project, context.projectKey, "a same-scope rename keeps project ownership untouched");

	await notes.write("occupied", "live target");
	await assert.rejects(() => notes.rename("still-back.md", "occupied.md"), (error: unknown) => error instanceof NoteError && error.code === "already_exists");
	await notes.update("occupied", undefined, { crumpled: true });
	const replaced = await notes.rename("still-back.md", "occupied.md");
	assert.equal(replaced.replacedCrumpledTarget, true, "a crumpled target is replaced");
	assert.equal((await notes.read("occupied.md"))?.meta.createdAt, written.meta.createdAt, "the moved note keeps its identity, not the target's");

	const beforeAlias = (await notes.read("occupied"))!.meta.updatedAt;
	assert.equal((await notes.rename("occupied", "occupied.md")).meta.updatedAt, beforeAlias, "a same-file move is a successful no-op");
	await assert.rejects(() => notes.rename("occupied.md", "@models/other-model/stolen.md"), (error: unknown) => error instanceof NoteError && error.code === "invalid_scope");
	await assert.rejects(() => notes.rename("@agents/someone-else/private.md", "mine.md"), (error: unknown) => error instanceof NoteError && error.code === "invalid_scope");
	await assert.rejects(() => notes.rename("absent.md", "anywhere.md"), (error: unknown) => error instanceof NoteError && error.code === "not_found");
});

test("combined moves validate everything before saving either endpoint", async (t) => {
	const { home, notes } = fixture(t);
	await notes.write("source", "alpha alpha", { origin: "user" });
	await notes.write("target", "keep me");
	const sourcePath = join(home, "pi/session/session-a/source.md");
	const targetPath = join(home, "pi/session/session-a/target.md");
	const sourceBefore = readFileSync(sourcePath, "utf8");
	const targetBefore = readFileSync(targetPath, "utf8");
	await assert.rejects(() => notes.update("source", [{ oldText: "alpha", newText: "A" }], { replaceAll: true, renameTo: "target" }), (error: unknown) => error instanceof NoteError && error.code === "already_exists");
	await notes.update("target", undefined, { crumpled: true });
	const crumpledBefore = readFileSync(targetPath, "utf8");
	await assert.rejects(() => notes.update("source", [{ oldText: "missing", newText: "A" }], { renameTo: "target", origin: "external", crumpled: false }), (error: unknown) => error instanceof NoteError && error.code === "no_match");
	assert.equal(readFileSync(sourcePath, "utf8"), sourceBefore);
	assert.notEqual(crumpledBefore, targetBefore);
	assert.equal(readFileSync(targetPath, "utf8"), crumpledBefore, "a failed edit does not consume a crumpled destination");
	const result = await notes.update("source", [{ oldText: "alpha", newText: "A" }], { renameTo: "@project/moved", replaceAll: true, origin: "external", crumpled: true });
	assert.equal(result.moved, true);
	assert.equal(result.meta.origin, "external");
	assert.ok(result.meta.crumpledAt);
	assert.equal(result.meta.project, undefined);
	assert.equal(existsSync(sourcePath), false);
	assert.equal((await notes.read("@project/moved"))!.body, "A A");
	const same = await notes.update("@project/moved", [{ oldText: "A A", newText: "B" }], { renameTo: "@project/moved.md", crumpled: false });
	assert.equal(same.moved, false);
	assert.equal(same.change.kind, "body");
	assert.equal(same.meta.crumpledAt, undefined);
});

test("glob is the single query selector for a named project home", async (t) => {
	const { home, notes } = fixture(t);
	mkdirSync(join(home, "project/other"), { recursive: true });
	writeFileSync(join(home, "project/other/decision.md"), "needle");
	const rows = await notes.list({ glob: "@projects/other/**" });
	assert.deepEqual(rows.map(row => row.address), ["@projects/other/decision.md"]);
	assert.equal((await notes.search(["needle"], { glob: "@projects/other/**" }))[0]?.matches[0]?.text, "needle");
	await assert.rejects(() => notes.write(rows[0]!.address, "overwrite"), (error: unknown) => error instanceof NoteError && error.code === "invalid_scope", "named project queries do not grant writes");
});

test("ambiguous multiline anchors report each starting line", async (t) => {
	const { notes } = fixture(t);
	await notes.write("multiline", "a\nb\na\nb\na\nb");
	await assert.rejects(() => notes.update("multiline", [{ oldText: "a\nb", newText: "x" }]), (error: unknown) => {
		assert.ok(error instanceof NoteError);
		assert.deepEqual(error.lineNumbers, [1, 3, 5]);
		return true;
	});
});

test("a massively ambiguous edit still reports every match line to a library caller", async (t) => {
	const { notes } = fixture(t);
	await notes.write("many", `${"beta\n".repeat(2000)}end`);
	await assert.rejects(
		() => notes.update("many", [{ oldText: "beta", newText: "B" }]),
		(error: unknown) => {
			assert.ok(error instanceof NoteError);
			assert.equal(error.code, "ambiguous_edit");
			assert.equal(error.lineNumbers?.length, 2000, "the domain keeps every match line rather than a sample");
			assert.deepEqual(error.lineNumbers?.slice(0, 3), [1, 2, 3]);
			assert.equal(error.lineNumbers?.[1999], 2000);
			assert.match(error.message, /2000 times \(lines 1, 2, 3, 4, 5, 6, 7, 8, and 1992 more\)/, "the message names the exact total and a bounded sample");
			assert.ok(Buffer.byteLength(error.message, "utf8") < 300, "the message stays small however many lines matched");
			return true;
		},
	);
	assert.equal((await notes.read("many"))?.body.startsWith("beta\nbeta"), true, "the refused edit left the body alone");
});

test("one unreadable note is named without hiding its readable siblings", async (t) => {
	if (process.getuid?.() === 0 || process.platform === "win32") return t.skip("chmod 000 is not a read refusal for this user");
	const { home, notes } = fixture(t);
	await notes.write("@project/bad.md", "bad body");
	await notes.write("@project/good.md", "good body");
	chmodSync(join(home, "project", "project-12345678", "bad.md"), 0o000);
	const result = await notes.listWithStatus({ glob: "@project/**" });
	assert.deepEqual(result.rows.map((row) => row.address), ["@project/good.md"], "the readable sibling still lists");
	assert.deepEqual(result.status.homesUnavailable, ["@project/bad.md"], "the unreadable note is named on its own");
	await assert.rejects(() => notes.list({ glob: "@project/**" }), (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES", "a caller that asked for no status still sees the failure");
});

test("a hand-written quoted numeric extra survives a rewrite as a string", async (t) => {
	const { home, notes } = fixture(t);
	await notes.write("typed", "body");
	const path = join(home, "pi/session/session-a/typed.md");
	writeFileSync(path, readFileSync(path, "utf8").replace("\n---\n\n", "\ncount: \"1\"\n---\n\n"));
	assert.equal((await notes.read("typed"))?.meta.count, "1", "a quoted scalar is read as text");
	const raw = readFileSync(path, "utf8");
	assert.match(raw, /^count: "1"$/m, "a bare 1 would read back as a number");
	assert.match(raw, /^origin: self$/m, "an ordinary string still stays bare");
});

test("writing keeps an existing note's origin unless the caller names one", async (t) => {
	const { notes } = fixture(t);
	await notes.write("owned", "first", { origin: "user" });
	assert.equal((await notes.write("owned", "second")).meta.origin, "user", "a rewrite does not re-attribute the note");
	assert.equal((await notes.write("owned", "third", { origin: "external" })).meta.origin, "external", "an explicit origin still wins");
	assert.equal((await notes.write("fresh", "new")).meta.origin, "self", "a new note still defaults to self");
});
