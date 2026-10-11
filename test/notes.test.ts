/**
 * OWNER: notesoup (adopted).
 * STATUS: tracked acceptance spec for the real-file notes store and its five tools.
 * CLAIM: notes live as markdown files under $PI_NOTES_HOME with harness-owned frontmatter;
 *   the five tools (notes_write/update/read/list/search) are the only note surface, and the
 *   boot index reads the physical store across scopes.
 * HERMETIC: every test points PI_NOTES_HOME at its own temp root; no real ~/.agents is touched.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { parseNote } from "../src/notes/frontmatter.js";
import { projectKey } from "../src/notes/paths.js";
import type { Scope } from "../src/notes/index.js";
import { listNotes, physicalPath, scopeDir } from "./helpers/notes.js";
import type { NotesListData, NotesReadData, NotesSearchData, NotesUpdateData, NotesWriteData } from "../src/tools/notes.js";
import { call, context, explicitBoot, makeExtension, manager, resultData, resultError, resultRead } from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

const testEnvironment = installExtensionTestHooks("notesoup-notes");

function freshRoot(): string {
	return testEnvironment.newNotesRoot();
}

function assertReceiptIdentity(value: { address: string; project_key?: string }, address: string, scope: Scope, ctx: ReturnType<typeof context>): void {
	assert.equal(value.address, address);
	assert.equal(value.project_key, scope === "project" ? projectKey(ctx.cwd) : undefined);
}

test("exactly the five notes tools are registered; the legacy five are gone", () => {
	const captured = makeExtension(manager());
	for (const name of ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"]) {
		assert.ok(captured.tools.get(name), `${name} is registered`);
	}
	for (const legacy of ["notes_write_file", "notes_append_to_file", "notes_read_file", "notes_search_contents", "notes_list_files"]) {
		assert.equal(captured.tools.get(legacy), undefined, `${legacy} is unregistered`);
	}
	assert.equal(captured.tools.get("notes_write")?.executionMode, "sequential");
	assert.equal(captured.tools.get("notes_update")?.executionMode, "sequential");
	assert.equal(captured.tools.get("notes_read")?.executionMode, undefined);
});

test("notes and history tools are grouped under their own namespaces", () => {
	const captured = makeExtension(manager());
	for (const name of ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"]) {
		assert.equal(captured.tools.get(name)?.namespace?.name, "notes", `${name} is in notes`);
	}
	for (const name of ["history_windows", "history_list", "history_read"]) {
		assert.equal(captured.tools.get(name)?.namespace?.name, "history", `${name} is in history`);
	}
});

test("every notes tool declares a result schema that accepts its own structured payload", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "schema.md", content: "needle body" }, ctx);
	const delivered: Array<[string, unknown]> = [
		["notes_write", await call(captured, "notes_write", { address: "schema.md", content: "needle body again" }, ctx)],
		["notes_update", await call(captured, "notes_update", { address: "schema.md", edits: [{ oldText: "again", newText: "once" }] }, ctx)],
		["notes_read", await call(captured, "notes_read", { address: "schema.md" }, ctx)],
		["notes_list", await call(captured, "notes_list", {}, ctx)],
		["notes_search", await call(captured, "notes_search", { query: "needle" }, ctx)],
		["notes_read", await call(captured, "notes_read", { address: "absent.md" }, ctx)],
	];
	for (const [name, result] of delivered) {
		const schema = captured.tools.get(name)!.outputSchema as TSchema | undefined;
		assert.ok(schema, `${name} registers an outputSchema`);
		assert.equal(Check(schema, (result as { structuredContent: unknown }).structuredContent), true, `${name} structured payload matches its declared schema`);
	}
});

test("note schemas drop status/stale and expose crumpled plus wastebasket", () => {
	const captured = makeExtension(manager());
	const schema = (name: string): TSchema => captured.tools.get(name)!.parameters as TSchema;
	const write = schema("notes_write");
	assert.equal(Check(write, { address: "a.md", content: "x" }), true);
	assert.equal(Check(write, { address: "a.md", content: "x", stale: true }), false, "notes_write no longer accepts stale");
	assert.equal(Check(write, { address: "a.md", content: "x", crumpled: true }), false, "notes_write does not accept crumpled");
	const edit = schema("notes_update");
	assert.equal(Check(edit, { address: "a.md", crumpled: true }), true);
	assert.equal(Check(edit, { address: "a.md", stale: true }), false, "notes_update no longer accepts stale");
	assert.equal(Check(edit, { address: "a.md", status: "archived" }), false, "status is gone");
	for (const name of ["notes_list", "notes_search"]) {
		const base = name === "notes_search" ? { query: "x" } : {};
		assert.equal(Check(schema(name), { ...base, wastebasket: true }), true, `${name} accepts wastebasket`);
		assert.equal(Check(schema(name), { ...base, status: "active" }), false, `${name} rejects status`);
	}
});

test("write lands a real markdown file with harness frontmatter and a pure body", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const sessionId = session.getSessionId();

	const result = resultData<NotesWriteData>(await call(captured, "notes_write", { address: "a/b.md", content: "hello" }, ctx));
	assert.deepEqual(Object.keys(result).sort(), ["address", "outcome"]);
	const file = physicalPath("session", "a/b.md", ctx);
	assert.equal(file, join(root, "pi", "session", sessionId, "a", "b.md"));
	assert.ok(existsSync(file), "the note is a real file under the session scope dir");
	const raw = readFileSync(file, "utf8");
	assert.match(raw, /^---\n/, "the file opens with frontmatter");
	assert.match(raw, /\n---\n\nhello$/, "frontmatter is followed by a blank line and the exact body");
	for (const [key, value] of [["origin", "self"], ["accessCount", "0"]]) {
		assert.match(raw, new RegExp(`^${key}: ${value}$`, "m"), `frontmatter carries ${key}=${value}`);
	}
	assert.equal(/^scope:/m.test(raw), false, "scope is derived from the file home, never persisted");
	assert.equal(/^status:/m.test(raw), false, "status is gone from persisted notes");
	assert.equal(/^stale:/m.test(raw), false, "the boolean stale flag is gone from persisted notes");
	assert.equal(/^crumpledAt:/m.test(raw), false, "a fresh note is uncrumpled");
	for (const key of ["createdAt", "updatedAt", "lastAccessed"]) {
		assert.match(raw, new RegExp(`^${key}: \\d{4}-\\d{2}-\\d{2}T`, "m"), `frontmatter renders ${key} via localIso`);
	}
	assert.equal(parseNote(raw).meta.project, projectKey(ctx.cwd), "a newly-created session note records its existing project key");
	assertReceiptIdentity(result, "a/b.md", "session", ctx);
	assert.equal(result.outcome, "created");
	assert.equal(existsSync(join(scopeDir("session", ctx), ".session.json")), false, "ownership is stored in note frontmatter, not a sidecar");

	// A leading YAML block in user content is stripped from the body.
	await call(captured, "notes_write", { address: "stripped.md", content: "---\nscope: human\nnonsense: true\n---\nreal body" }, ctx);
	const stripped = readFileSync(physicalPath("session", "stripped.md", ctx), "utf8");
	assert.match(stripped, /\n---\n\nreal body$/, "the injected block is not part of the body");
	assert.equal(stripped.includes("nonsense"), false, "the injected block never reaches the file");
});

test("session-note project ownership is per note, persistent across sessions, and not reassigned by cwd", async () => {
	freshRoot();
	const cwdA = join(testEnvironment.cwd, "project-a");
	const cwdB = join(testEnvironment.cwd, "project-b");
	mkdirSync(cwdA, { recursive: true });
	mkdirSync(cwdB, { recursive: true });
	const projectA = projectKey(cwdA);
	const projectB = projectKey(cwdB);
	assert.notEqual(projectA, projectB);

	const firstSession = manager();
	const firstCaptured = makeExtension(firstSession);
	const firstCtx = context(firstSession, undefined, undefined, true, cwdA);
	await call(firstCaptured, "notes_write", { address: "first.md", content: "first project session" }, firstCtx);
	const firstFile = physicalPath("session", "first.md", firstCtx);
	assert.equal(parseNote(readFileSync(firstFile, "utf8")).meta.project, projectA);

	const secondSession = manager();
	const secondCaptured = makeExtension(secondSession);
	const secondCtx = context(secondSession, undefined, undefined, true, cwdA);
	await call(secondCaptured, "notes_write", { address: "second.md", content: "same project, another session" }, secondCtx);
	const secondFile = physicalPath("session", "second.md", secondCtx);
	assert.equal(parseNote(readFileSync(secondFile, "utf8")).meta.project, projectA, "another session in the same project carries the matching key");

	const thirdSession = manager();
	const thirdCaptured = makeExtension(thirdSession);
	const thirdCtx = context(thirdSession, undefined, undefined, true, cwdB);
	await call(thirdCaptured, "notes_write", { address: "third.md", content: "different project" }, thirdCtx);
	const thirdFile = physicalPath("session", "third.md", thirdCtx);
	assert.equal(parseNote(readFileSync(thirdFile, "utf8")).meta.project, projectB);
	const projectASessions = [firstFile, secondFile, thirdFile].filter((file) => parseNote(readFileSync(file, "utf8")).meta.project === projectA);
	assert.deepEqual(projectASessions.sort(), [firstFile, secondFile].sort(), "exact frontmatter project matching recognizes only sessions from the same project");

	const movedContext = context(firstSession, undefined, undefined, true, cwdB);
	await call(firstCaptured, "notes_write", { address: "first.md", content: "overwritten from another cwd" }, movedContext);
	assert.equal(parseNote(readFileSync(firstFile, "utf8")).meta.project, projectA, "overwriting an existing note does not silently reassign it");
	await call(firstCaptured, "notes_update", { address: "first.md", edits: [{ oldText: "overwritten", newText: "edited" }] }, movedContext);
	assert.equal(parseNote(readFileSync(firstFile, "utf8")).meta.project, projectA, "editing an existing note preserves its original project key");
	await call(firstCaptured, "notes_read", { address: "first.md" }, movedContext);
	assert.equal(parseNote(readFileSync(firstFile, "utf8")).meta.project, projectA, "reading preserves existing project ownership");

	await call(firstCaptured, "notes_write", { address: "new-from-project-b.md", content: "new note" }, movedContext);
	assert.equal(parseNote(readFileSync(physicalPath("session", "new-from-project-b.md", movedContext), "utf8")).meta.project, projectB, "only a newly-created session note uses the current project key");
	await call(firstCaptured, "notes_write", { address: "@project/project-note.md", content: "project home note" }, movedContext);
	assert.equal(parseNote(readFileSync(physicalPath("project", "project-note.md", movedContext), "utf8")).meta.project, undefined, "project-home notes do not receive session ownership metadata");
	assert.equal((await listNotes(movedContext, { scope: "session" })).length, 2, "project ownership remains frontmatter, not a separate note");
});

test("linked git worktrees share the main checkout's project key", () => {
	freshRoot();
	// realpath keeps the fixture's gitdir pointer and the asserted paths on one spelling
	// (macOS temp roots live under the /var -> /private/var symlink).
	const root = realpathSync(testEnvironment.cwd);
	const main = join(root, "repo");
	mkdirSync(main, { recursive: true });
	const git = (args: string[]): void => {
		execFileSync("git", ["-c", "user.email=test@test", "-c", "user.name=test", ...args], { cwd: main, stdio: "ignore" });
	};
	git(["init", "-q"]);
	git(["commit", "-q", "--allow-empty", "-m", "init"]);
	const worktree = join(root, "wt");
	git(["worktree", "add", "-q", "--detach", worktree]);
	assert.equal(projectKey(worktree), projectKey(main), "a linked worktree resolves to the main checkout's key");
	assert.equal(projectKey(join(worktree, "gone", "deeper")), projectKey(main), "a nonexistent subdirectory still resolves through its worktree");
	assert.equal(scopeDir("project", context(manager(), undefined, undefined, true, worktree)), scopeDir("project", context(manager(), undefined, undefined, true, main)), "@project uses the same physical home from both checkouts");
});

test("unrecognized metadata remains ordinary frontmatter; invalid project ownership stays unknown", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const legacyFile = physicalPath("session", "legacy.md", ctx);
	mkdirSync(scopeDir("session", ctx), { recursive: true });
	writeFileSync(legacyFile, `---
origin: self
created_at: 2026-01-01T00:00:00.000+00:00
updated_at: 2026-01-01T00:00:00.000+00:00
last_accessed: 2026-01-01T00:00:00.000+00:00
access_count: 0
source_window: old-window
recurrence_count: 2
recurrence_windows: old-window
---

legacy body`);
	const parsed = parseNote(readFileSync(legacyFile, "utf8"), Date.parse("2026-02-01T00:00:00Z"));
	assert.equal(parsed.meta.createdAt, Date.parse("2026-02-01T00:00:00Z"), "missing canonical timestamp takes the normal default");
	assert.equal(parsed.meta.created_at, "2026-01-01T00:00:00.000+00:00", "unrecognized fields remain ordinary extras");
	assert.equal((await listNotes(ctx, { scope: "session" }))[0]?.address, "legacy.md");
	assert.match(resultRead(await call(captured, "notes_read", { address: "legacy.md" }, ctx)).content, /legacy body$/);
	await call(captured, "notes_update", { address: "legacy.md", edits: [{ oldText: "legacy body", newText: "edited body" }] }, ctx);
	await call(captured, "notes_write", { address: "legacy.md", content: "overwritten body" }, ctx);
	const rewritten = parseNote(readFileSync(legacyFile, "utf8"));
	assert.equal(rewritten.body, "overwritten body");
	for (const key of ["created_at", "updated_at", "last_accessed", "access_count", "source_window", "recurrence_count", "recurrence_windows"]) {
		assert.deepEqual(rewritten.meta[key], parsed.meta[key], `${key} is preserved as unrecognized frontmatter, not migrated`);
	}

	const invalidFile = physicalPath("session", "invalid.md", ctx);
	writeFileSync(invalidFile, `---
origin: self
createdAt: 2026-01-01T00:00:00.000+00:00
updatedAt: 2026-01-01T00:00:00.000+00:00
lastAccessed: 2026-01-01T00:00:00.000+00:00
accessCount: 0
project: 17
---

invalid owner`);
	assert.equal(parseNote(readFileSync(invalidFile, "utf8")).meta.project, 17);
	assert.notEqual(parseNote(readFileSync(invalidFile, "utf8")).meta.project, projectKey(ctx.cwd), "invalid ownership does not match the current project key");
	await call(captured, "notes_write", { address: "invalid.md", content: "still invalid" }, ctx);
	assert.equal(parseNote(readFileSync(invalidFile, "utf8")).meta.project, 17, "an invalid value remains unknown and is not replaced with cwd-derived ownership");
	assert.equal(existsSync(join(scopeDir("session", ctx), ".session.json")), false, "new notes use no ownership sidecar");
});

test("edit is body-scoped with named failures and a replace_all escape hatch", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { address: "edit.md", content: "alpha\nbeta\nbeta\ngamma" }, ctx);
	const ambiguous = resultError(await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "beta", newText: "B" }] }, ctx));
	assert.match(ambiguous.message, /occurs 2 times/);
	assert.equal(ambiguous.code, "ambiguous_edit");
	assert.match(ambiguous.message, /edit 0: oldText occurs 2 times \(lines 2, 3\)/, "the message names the failing edit index and every match line");

	const missing = resultError(await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "absent", newText: "x" }] }, ctx));
	assert.equal(missing.code, "no_match");
	assert.match(missing.message, /^edit 0:/, "a zero-match anchor names the failing edit index");

	const all = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "beta", newText: "B" }], replace_all: true }, ctx));
	assert.equal(all.address, "edit.md");
	assertReceiptIdentity(all, "edit.md", "session", ctx);
	assert.equal(all.change_kind, "body");
	assert.equal(resultRead(await call(captured, "notes_read", { address: "edit.md" }, ctx)).content, "alpha\nB\nB\ngamma", "replace_all replaces every occurrence");

	// An anchor that occurs only in frontmatter is not matched: edits are body-only.
	const frontmatterOnly = resultError(await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "origin", newText: "x" }] }, ctx));
	assert.match(frontmatterOnly.message, /^edit 0:/, "a frontmatter-only anchor is not a body match");
});

test("nothing-to-do, not-found, atomic batches, and replace_all zero-match are named", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	const nameOnly = resultError(await call(captured, "notes_update", { address: "edit.md" }, ctx));
	assert.match(nameOnly.message, /nothing to do/, "neither edits nor setters is a named error");

	await call(captured, "notes_write", { address: "edit.md", content: "alpha\nbeta" }, ctx);
	const empty = resultError(await call(captured, "notes_update", { address: "edit.md", edits: [] }, ctx));
	assert.match(empty.message, /nothing to do/, "an empty edits list with no setters is also nothing to do");

	const editMissing = resultError(await call(captured, "notes_update", { address: "missing.md", crumpled: true }, ctx));
	assert.equal(editMissing.message, "note not found");
	const readMissing = resultError(await call(captured, "notes_read", { address: "missing.md" }, ctx));
	assert.equal(readMissing.message, "note not found");
	assert.equal(readMissing.code, "not_found");
	assert.deepEqual(Object.keys(readMissing).sort(), ["code", "message"], "a plain refusal carries only a code and message");

	const file = physicalPath("session", "edit.md", ctx);
	const before = readFileSync(file, "utf8");
	const failed = resultError(await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "absent", newText: "x" }] }, ctx));
	assert.match(failed.message, /^edit 1:/, "the failing edit is named");
	assert.equal(readFileSync(file, "utf8"), before, "a failing batch leaves the file byte-identical, frontmatter included");

	const applied = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "beta", newText: "B" }] }, ctx));
	assert.equal(applied.change_kind, "body");
	assert.equal(resultRead(await call(captured, "notes_read", { address: "edit.md" }, ctx)).content, "A\nB");

	const zero = resultError(await call(captured, "notes_update", { address: "edit.md", edits: [{ oldText: "zzz", newText: "y" }], replace_all: true }, ctx));
	assert.match(zero.message, /^edit 0:/, "replace_all with zero matches is the same zero-match error, not a silent no-op");
});

test("notes_update rename_to moves a note and refuses combinations and live targets", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { address: "move-me.md", content: "body" }, ctx);
	const combined = resultError(await call(captured, "notes_update", { address: "move-me.md", rename_to: "moved.md", edits: [{ oldText: "body", newText: "x" }] }, ctx));
	assert.match(combined.message, /rename_to is used alone/, "rename_to rejects being combined with edits");

	await call(captured, "notes_write", { address: "occupied.md", content: "live target" }, ctx);
	const conflict = resultError(await call(captured, "notes_update", { address: "move-me.md", rename_to: "occupied.md" }, ctx));
	assert.match(conflict.message, /live note/, "a live target refuses the move");

	const renamed = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "move-me.md", rename_to: "moved.md" }, ctx));
	assertReceiptIdentity(renamed, "moved.md", "session", ctx);
	assert.equal(renamed.rename_from, "move-me.md");
	assert.equal(renamed.change_kind, "file");
	assert.equal(renamed.address, "moved.md");

	const gone = resultError(await call(captured, "notes_read", { address: "move-me.md" }, ctx));
	assert.equal(gone.message, "note not found", "the old address is gone");
	assert.equal(resultRead(await call(captured, "notes_read", { address: "moved.md" }, ctx)).content, "body");

	// Empty filler values are not a combination: a model passing every parameter still gets its crumple.
	const crumpled = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "moved.md", crumpled: true, edits: [], origin: "self", rename_to: "", replace_all: false }, ctx));
	assert.equal(crumpled.address, "moved.md", "an empty rename_to is ignored as if omitted");
	const basket = resultData<NotesListData>(await call(captured, "notes_list", { wastebasket: true }, ctx));
	assert.equal(basket.files.some((file) => file.address === "moved.md"), true, "the note was crumpled");

	const fillerRename = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "moved.md", rename_to: "moved-again.md", edits: [], replace_all: false }, ctx));
	assert.equal(fillerRename.address, "moved-again.md", "empty edits and replace_all: false ride along with a rename");

	const realCombo = resultError(await call(captured, "notes_update", { address: "moved-again.md", rename_to: "nope.md", replace_all: true }, ctx));
	assert.match(realCombo.message, /rename_to is used alone/, "replace_all: true is a real combination and refuses");
});

test("write and update receipts distinguish outcomes and no-op edits", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const alias = resultData<NotesWriteData>(await call(captured, "notes_write", { address: "@self/alias", content: "body" }, ctx));
	assertReceiptIdentity(alias, "@self/alias.md", "agent", ctx);
	assert.equal(alias.outcome, "created");
	assert.equal(resultData<NotesWriteData>(await call(captured, "notes_write", { address: "@agents/anonymous/alias.md", content: "new body" }, ctx)).outcome, "overwrote");
	await call(captured, "notes_update", { address: "@self/alias", crumpled: true }, ctx);
	assert.equal(resultData<NotesWriteData>(await call(captured, "notes_write", { address: "@self/alias", content: "restored" }, ctx)).outcome, "uncrumpled");
	const noChange = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "@self/alias", edits: [{ oldText: "restored", newText: "restored" }], crumpled: false }, ctx));
	assert.deepEqual([noChange.change_kind, noChange.diff], ["none", ""]);
	const mixed = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "@self/alias", edits: [{ oldText: "restored", newText: "restored" }, { oldText: "restored", newText: "changed" }] }, ctx));
	assert.equal(mixed.change_kind, "body");
	assert.equal(mixed.change_kind, "body");
});

test("empty results distinguish hidden notes and unavailable homes", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const empty = resultData<NotesListData>(await call(captured, "notes_list", { pattern: "@human/**" }, ctx));
	assert.deepEqual(empty, { files: [], more: 0, homes_unavailable: [] });
	await call(captured, "notes_write", { address: "@human/hidden.md", content: "needle" }, ctx);
	await call(captured, "notes_update", { address: "@human/hidden.md", crumpled: true }, ctx);
	const hidden = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle", pattern: "@human/**" }, ctx));
	assert.deepEqual(hidden.files, [], "a crumpled note is hidden from search");
	const broken = scopeDir("project", ctx);
	mkdirSync(join(broken, ".."), { recursive: true });
	writeFileSync(broken, "not a directory");
	const partial = resultData<NotesListData>(await call(captured, "notes_list", { pattern: "**" }, ctx));
	assert.deepEqual(partial.homes_unavailable, ["@project"]);
	assert.deepEqual(partial.files, []);
	const searched = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle", pattern: "**" }, ctx));
	assert.deepEqual(searched.homes_unavailable, ["@project"]);
	writeFileSync(join(process.env.PI_NOTES_HOME!, "agents"), "not a directory");
	const namespace = resultData<NotesListData>(await call(captured, "notes_list", { pattern: "@agents/*/note.md" }, ctx));
	assert.deepEqual(namespace.homes_unavailable, ["@agents"]);
});

test("notes receipts report resolved identity across scopes", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const notes = [
		{ address: "session.md", body: "session needle", scope: "session" },
		{ address: "@project/project.md", body: "project needle", scope: "project" },
		{ address: "@human/human.md", body: "human needle", scope: "human" },
	] as const;

	for (const note of notes) {
		const written = resultData<NotesWriteData>(await call(captured, "notes_write", { address: note.address, content: note.body }, ctx));
		assertReceiptIdentity(written, note.address, note.scope, ctx);

		const edited = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: note.address, edits: [{ oldText: "needle", newText: "match" }] }, ctx));
		assertReceiptIdentity(edited, note.address, note.scope, ctx);

		const rawRead = await call(captured, "notes_read", { address: note.address }, ctx);
		const read = resultRead(rawRead);
		assertReceiptIdentity(resultData<NotesReadData>(rawRead), note.address, note.scope, ctx);
		assert.equal(read.content, note.body.replace("needle", "match"), "the window carries the body only");
		assert.equal("scope" in read.metadata!, false, "scope is derivable from the address and never echoed");
		assert.equal(read.metadata!.project !== undefined, note.scope === "session", "stored project ownership is exposed as metadata");
		assert.equal(rawRead.content[0]!.type === "text" && rawRead.content[0]!.text.includes("---"), false, "the rendered read carries no frontmatter block");
	}

	const listed = resultData<NotesListData>(await call(captured, "notes_list", { pattern: "**" }, ctx));
	assert.deepEqual(listed.files.map((file) => file.address).sort(), notes.map((note) => note.address).sort(), "notes_list returns each full address");
	for (const row of listed.files) assertReceiptIdentity(row, row.address, notes.find((note) => note.address === row.address)!.scope, ctx);

	const searched = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "match", pattern: "**" }, ctx));
	assert.deepEqual(searched.files.map((file) => file.address), notes.map((note) => note.address).sort(), "notes_search returns each full address");
	for (const row of searched.files) assertReceiptIdentity(row, row.address, notes.find((note) => note.address === row.address)!.scope, ctx);
});

test("list and search merge scopes and carry addresses; the path jail rejects escapes", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);

	await call(captured, "notes_write", { address: "one.md", content: "needle one" }, ctx);
	await call(captured, "notes_write", { address: "@project/two.md", content: "needle two" }, ctx);
	await call(captured, "notes_write", { address: "@human/three.md", content: "needle three" }, ctx);

	const listed = resultData<NotesListData>(await call(captured, "notes_list", {}, ctx));
	assert.deepEqual([...listed.files].map((file) => file.address).sort(), ["@human/three.md", "@project/two.md", "one.md"], "every merged row carries its full address");
	for (const row of listed.files) {
		assert.deepEqual(Object.keys(row).sort(), ["address", "updated_at", ...(row.address.startsWith("@project/") ? ["project_key"] : [])].sort());
	}
	const scoped = resultData<NotesListData>(await call(captured, "notes_list", { pattern: "@human/**" }, ctx));
	assert.deepEqual(scoped.files.map((file) => file.address), ["@human/three.md"], "an address-pattern filter narrows the set");

	const searched = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle" }, ctx));
	assert.equal(searched.files.length, 3, "literal search finds matches in every scope");
	assert.deepEqual([...searched.files].map((file) => file.address).sort(), ["@human/three.md", "@project/two.md", "one.md"]);
	for (const row of [...listed.files, ...searched.files]) assert.equal("scope" in row, false, "scope is derivable from the address and never echoed");
	assert.equal(searched.files.every((file) => file.matches.length === 1), true);
	const hit = searched.files[0]!.matches[0]!;
	assert.equal(hit.line, 1);
	assert.equal(hit.offset_chars, 0, "the offset counts into the note body, so it does not include serialized frontmatter");
	assert.deepEqual(Object.keys(hit).sort(), ["line", "offset_chars", "text"]);
	assert.equal(resultRead(await call(captured, "notes_read", { address: searched.files[0]!.address, offset_chars: hit.offset_chars }, ctx)).content.startsWith("needle"), true, "the search offset starts a read at the match");

	const escaped = ["../evil", "/abs", "a\\b"];
	for (const tool of ["notes_write", "notes_update", "notes_read"] as const) {
		for (const path of escaped) {
			assert.equal(resultError(await call(captured, tool, { address: path, content: "x", edits: [{ oldText: "a", newText: "b" }] }, ctx)).code, "invalid_address");
		}
	}
	assert.equal(resultError(await call(captured, "notes_search", { query: "" }, ctx)).code, "invalid_query");
	assert.equal(resultError(await call(captured, "notes_read", { address: "one.md", offset_chars: 99999 }, ctx)).code, "invalid_offset");
	assert.equal(resultError(await call(captured, "notes_list", { pattern: "bad\\glob" }, ctx)).code, "invalid_pattern");
	assert.equal(resultError(await call(captured, "notes_search", { query: "needle", pattern: "bad\\glob" }, ctx)).code, "invalid_pattern");
});

test("a read offsets the body in code points, not bytes or frontmatter", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "emoji.md", content: "🐑字\nneedle tail" }, ctx);

	const search = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle", pattern: "emoji.md" }, ctx));
	const match = search.files[0]!.matches[0]!;
	assert.equal(match.line, 2);
	assert.equal(match.offset_chars, 3, "the emoji and CJK line above contribute two code points plus the newline, not their bytes");
	const atMatch = resultRead(await call(captured, "notes_read", { address: "emoji.md", offset_chars: match.offset_chars }, ctx));
	assert.equal(atMatch.text.startsWith("needle"), true, "the offset lands on the match even with multi-byte characters above it");
	assert.equal(atMatch.total_chars, Array.from("🐑字\nneedle tail").length);

	const negative = resultRead(await call(captured, "notes_read", { address: "emoji.md", offset_chars: -4 }, ctx));
	assert.equal(negative.text, "tail", "a negative offset counts back from the end of the body");
	assert.equal(negative.next_offset_chars, null, "a tail read has no continuation");
	const start = resultRead(await call(captured, "notes_read", { address: "emoji.md", limit_chars: 3 }, ctx));
	assert.equal(start.text, "🐑字\n");
	assert.equal(start.next_offset_chars, 3);
	assert.equal(resultRead(await call(captured, "notes_read", { address: "emoji.md", offset_chars: 14 }, ctx)).text, "", "the exact end is an empty window, not a refusal");
});

test("a read keeps its body window verbatim under the new presentation", async () => {
	freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "present.md", content: "0123456789" }, ctx);

	const limited = await call(captured, "notes_read", { address: "present.md", limit_chars: 4 }, ctx);
	const text = limited.content[0]!.type === "text" ? limited.content[0]!.text : "";
	assert.equal(text.includes("READ WINDOW"), false, "the old READ WINDOW block is gone");
	assert.equal(text.includes("chars: ["), false, "no parsed range block stands between the header and the body");
	assert.equal(text.endsWith("\n\n[truncated; continue at offset_chars=4]"), true, "a limit-stopped window names the resume cursor");
	const header = text.slice(0, text.indexOf("\n\n"));
	assert.match(header, /^present\.md\norigin self \| created \d{4}-/, "identity and metadata lead, body first in the window itself");

	const whole = await call(captured, "notes_read", { address: "present.md" }, ctx);
	const wholeText = whole.content[0]!.type === "text" ? whole.content[0]!.text : "";
	assert.equal(wholeText.endsWith("\n\n0123456789"), true, "a complete window carries no continuation footer");
	assert.equal(wholeText.includes("more characters"), false);
});

test("@ addresses select one home, reject illegal sigils, and never fall back", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "same.md", content: "session" }, ctx);
	await call(captured, "notes_write", { address: "@project/same.md", content: "project" }, ctx);
	await call(captured, "notes_write", { address: "@human/same.md", content: "human" }, ctx);
	assert.ok(existsSync(physicalPath("project", "same.md", ctx)), "@project writes to the current project home");
	assert.ok(existsSync(physicalPath("human", "same.md", ctx)), "@human writes to the human home");
	assert.match(resultRead(await call(captured, "notes_read", { address: "same.md" }, ctx)).content, /session$/);
	assert.equal(resultError(await call(captured, "notes_read", { address: "@project/missing.md" }, ctx)).message, "note not found");
	assert.match(resultError(await call(captured, "notes_read", { address: "@glboal/same.md" }, ctx)).message, /no @ for this session.*@project\/.*@human\//);
	assert.equal(resultError(await call(captured, "notes_write", { address: "bad@name.md", content: "no" }, ctx)).code, "invalid_address");
	assert.equal(existsSync(join(root, "human", "bad@name.md")), false, "a bad sigil creates nothing anywhere");
});

test("Pi adapter defaults to anonymous agent identity", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await withAgent(undefined, async () => {
		await call(captured, "notes_write", { address: "@self/private.md", content: "anonymous agent note" }, ctx);
		const listed = resultData<NotesListData>(await call(captured, "notes_list", {}, ctx));
		assert.deepEqual(listed.files.map((row) => row.address), ["@self/private.md"]);
		const explicit = resultData<NotesListData>(await call(captured, "notes_list", { pattern: "@agents/*/private.md" }, ctx));
		assert.deepEqual(explicit.files.map((row) => row.address), ["@self/private.md"], "explicit-id patterns still match the current home");
		assert.equal(existsSync(join(root, "agents", "anonymous", "private.md")), true);
	});
});

test("Pi adapter resolves agent and switched model identity on each notes call and boot", async () => {
	const root = freshRoot();
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session, undefined, undefined, true, testEnvironment.cwd, true, "provider/First.Model");
	await withAgent("Test Agent", async () => {
		await call(captured, "notes_write", { address: "@self/private.md", content: "agent note" }, ctx);
		await call(captured, "notes_write", { address: "@model/private.md", content: "first model note" }, ctx);
		ctx.model = context(session, undefined, undefined, true, testEnvironment.cwd, true, "other/Second.Model").model;
		assert.equal(resultError(await call(captured, "notes_read", { address: "@model/private.md" }, ctx)).message, "note not found", "switched model does not fall back to previous home");
		await call(captured, "notes_write", { address: "@model/private.md", content: "second model note" }, ctx);
		const listed = resultData<NotesListData>(await call(captured, "notes_list", {}, ctx));
		assert.deepEqual(listed.files.map((row) => row.address).sort(), ["@model/private.md", "@self/private.md"]);
		const boot = await explicitBoot(ctx, "test-window", undefined);
		assert.ok(boot.includes("@model/private.md"));
		assert.equal(boot.includes("@models/first-model/private.md"), false);
		assert.match(resultRead(await call(captured, "notes_read", { address: "@models/first-model/private.md" }, ctx)).content, /first model note$/);
		const refused = resultError(await call(captured, "notes_update", { address: "@models/first-model/private.md", crumpled: true }, ctx));
		assert.match(refused.message, /not your home/);
		assert.match(readFileSync(join(root, "models/first-model/private.md"), "utf8"), /first model note$/);
	});
});

async function withAgent(name: string | undefined, run: () => Promise<void>): Promise<void> {
	const previous = process.env.PI_NOTES_AGENT;
	if (name === undefined) delete process.env.PI_NOTES_AGENT;
	else process.env.PI_NOTES_AGENT = name;
	try {
		// A plain `return run()` would run the finally block the moment the promise pends,
		// restoring the env while the callback still has awaits ahead of it.
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_NOTES_AGENT;
		else process.env.PI_NOTES_AGENT = previous;
	}
}
