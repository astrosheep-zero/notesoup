import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { createNotesStore, effectiveNotePolicy, NoteError, type NoteErrorCode, type NotesIdentity } from "../src/notes/index.js";
import { parseNote } from "../src/notes/frontmatter.js";
import { DEFAULT_BOOT_TOOL_NAMES, loadNotesSnapshot, notesList, notesRead, notesSearch, notesToolContext, notesUpdate, notesWrite, renderBootBlock } from "../src/index.js";
import type { Outcome } from "../src/result.js";
import { wireResult } from "../src/tools/result.js";

function fixture(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "note-policy-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const identity: NotesIdentity = { home, sessionId: "session-a", projectKey: "project-12345678", agent: "root", model: "test-model" };
	return { home, identity, notes: createNotesStore(identity), context: notesToolContext(identity, home), file: (path: string) => join(home, "pi/session/session-a", path) };
}

function data<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) assert.fail(JSON.stringify(outcome.error));
	return outcome.data;
}
const refused = (code: NoteErrorCode) => (error: unknown) => error instanceof NoteError && error.code === code;

async function fillPins(notes: ReturnType<typeof createNotesStore>, prefix = "") {
	for (const name of ["CHEATSHEET.md", "MAP.md", "one.md", "two.md", "three.md"]) {
		await notes.write(`${prefix}${name}`, `body ${name}`, ["CHEATSHEET.md", "MAP.md"].includes(name) ? {} : { pinned: true });
	}
}

async function boot(identity: NotesIdentity) {
	return renderBootBlock({
		agentName: identity.agent, modelName: identity.model, tools: DEFAULT_BOOT_TOOL_NAMES,
		tree: { trunk: "policy-test", windows: [{ shortName: "root", isCurrent: true }] },
		notes: await loadNotesSnapshot(identity, Date.now()),
	}).split("YOUR NOTES\n──────────")[1]!;
}

test("frontmatter policy round-trips without materializing defaults; arbitrary extras survive", async t => {
	const { notes, file } = fixture(t);
	await notes.write("MAP", "index");
	const defaults = (await notes.read("MAP"))!.meta;
	assert.equal(defaults.pinned, undefined);
	assert.deepEqual(effectiveNotePolicy(defaults, "MAP.md"), { pinned: true, budget: 2048, readonly: false });
	assert.equal(effectiveNotePolicy(defaults, "nested/MAP.md").pinned, false);
	writeFileSync(file("MAP.md"), readFileSync(file("MAP.md"), "utf8").replace("\n---\n\n", "\npinned: false\nbudget: 3000\nreadonly: true\ncustom: {\"nested\":[1,\"two\"]}\n---\n\n"));
	const meta = (await notes.read("MAP"))!.meta;
	assert.deepEqual(effectiveNotePolicy(meta, "MAP.md"), { pinned: false, budget: 3000, readonly: true });
	await notes.update("MAP", [{ oldText: "index", newText: "new index" }], { readonly: false });
	const persisted = parseNote(readFileSync(file("MAP.md"), "utf8"));
	assert.equal(persisted.meta.pinned, false);
	assert.equal(persisted.meta.budget, 3000);
	assert.equal(persisted.meta.readonly, false);
	assert.deepEqual(persisted.meta.custom, { nested: [1, "two"] });
	assert.equal(persisted.body, "new index");
});

test("tools set policy, validate values, and visibly report effective policy and code-point warnings", async t => {
	const { context, notes, file } = fixture(t);
	for (const tool of [notesWrite, notesUpdate]) {
		const required = tool === notesWrite ? { address: "x", content: "body" } : { address: "x" };
		assert.equal(Check(tool.parameters, { ...required, pinned: false, budget: 2048, readonly: true }), true);
		for (const invalid of [{ pinned: "false" }, { readonly: 1 }, { budget: 0 }, { budget: 1.5 }, { budget: Number.MAX_SAFE_INTEGER + 1 }]) {
			assert.equal(Check(tool.parameters, { ...required, ...invalid }), false);
		}
	}
	const written = await notesWrite.execute({ address: "custom", content: "😀".repeat(2048), pinned: true, readonly: true }, context);
	assert.equal(Check(notesWrite.outputSchema, wireResult(written)), true);
	assert.deepEqual(data(written).warnings, [], "2048 astral characters are within budget");
	assert.equal(data(written).budget, 2048);
	assert.match(notesWrite.render(written), /pinned true \| budget 2048 \| readonly true/);
	const updated = await notesUpdate.execute({ address: "custom", readonly: false, edits: [{ oldText: "😀".repeat(2048), newText: "😀".repeat(2049) }] }, context);
	assert.equal(Check(notesUpdate.outputSchema, wireResult(updated)), true);
	assert.equal(data(updated).warnings.length, 1);
	assert.match(notesUpdate.render(updated), /2049 Unicode code points, over budget 2048/);
	assert.equal((await notes.read("custom"))!.body, "😀".repeat(2049), "over budget saves the entire body");

	const read = await notesRead.execute({ address: "custom", max_chars: 10 }, context);
	assert.equal(Check(notesRead.outputSchema, wireResult(read)), true);
	assert.deepEqual({ pinned: data(read).metadata.pinned, budget: data(read).metadata.budget, readonly: data(read).metadata.readonly }, { pinned: true, budget: 2048, readonly: false });
	assert.match(notesRead.render(read), /pinned true \| budget 2048 \| readonly false/);
	assert.match(notesRead.render(read), /Warning: note body is 2049/);
	const list = await notesList.execute({}, context);
	assert.equal(Check(notesList.outputSchema, wireResult(list)), true);
	assert.equal(data(list).files[0]!.pinned, true);
	assert.match(notesList.render(list), /pinned true \| budget 2048 \| readonly false/);
	assert.match(notesList.render(list), /Warning: note body is 2049/);
	const search = await notesSearch.execute({ query: "😀", max_matches_per_file: 1 }, context);
	assert.equal(Check(notesSearch.outputSchema, wireResult(search)), true);
	assert.equal(data(search).files[0]!.budget, 2048);
	assert.match(notesSearch.render(search), /pinned true \| budget 2048 \| readonly false/);
	assert.match(notesSearch.render(search), /Warning: note body is 2049/);

	const larger = await notesUpdate.execute({ address: "custom", budget: 2050, pinned: false }, context);
	assert.deepEqual(data(larger).warnings, []);
	assert.equal(data(larger).change_kind, "metadata");
	const before = readFileSync(file("custom.md"), "utf8");
	// Runtime JavaScript callers bypass schemas; the real store still validates before saving.
	for (const invalid of [{ pinned: "false" }, { budget: null }, { readonly: "yes" }]) {
		// @ts-expect-error intentionally malformed runtime input
		await assert.rejects(() => notes.update("custom", undefined, invalid), refused("invalid_policy"));
		assert.equal(readFileSync(file("custom.md"), "utf8"), before);
	}
	writeFileSync(file("custom.md"), before.replace("budget: 2050", "budget: -1"));
	const badFrontmatter = await notesRead.execute({ address: "custom" }, context);
	assert.equal(badFrontmatter.ok, false);
	if (!badFrontmatter.ok) assert.equal(badFrontmatter.error.code, "invalid_policy");
});

test("readonly is a soft lock: all mutations require explicit unlock, reads still stamp access", async t => {
	const { notes, file, identity } = fixture(t);
	await notes.write("locked", "body", { readonly: true });
	const before = readFileSync(file("locked.md"), "utf8");
	for (const change of [
		() => notes.write("locked", "overwrite"),
		() => notes.update("locked", [{ oldText: "body", newText: "edit" }]),
		() => notes.update("locked", undefined, { crumpled: true }),
		() => notes.update("locked", undefined, { pinned: true }),
		() => notes.update("locked", undefined, { budget: 3000 }),
		() => notes.rename("locked", "moved"),
	]) {
		await assert.rejects(change, refused("readonly"));
		assert.equal(readFileSync(file("locked.md"), "utf8"), before);
	}
	assert.equal((await notes.read("locked"))!.meta.accessCount, 1, "soft lock does not prohibit access stamps");
	await notes.update("locked", undefined, { readonly: false });
	await notes.update("locked", [{ oldText: "body", newText: "edit" }], { readonly: true });
	await notes.update("locked", [{ oldText: "edit", newText: "unlocked and moved" }], { readonly: false, renameTo: "moved", crumpled: true });
	await notes.write("moved", "locked again", { readonly: true });
	await notes.write("moved", "explicit overwrite", { readonly: false });
	assert.equal((await notes.read("moved"))!.body, "explicit overwrite");
	await notes.update("moved", undefined, { crumpled: true, readonly: true });
	await notes.write("source", "source body");
	await assert.rejects(() => notes.rename("source", "moved"), refused("readonly"));
	await notes.update("source", undefined, { renameTo: "moved", readonly: false });
	assert.equal((await notes.read("moved"))!.body, "source body");
	await notes.update("moved", undefined, { crumpled: true, readonly: true });
	const dream = createNotesStore({ ...identity, dreaming: identity.projectKey });
	await assert.rejects(() => dream.forget("moved"), refused("readonly"));
	await dream.update("moved", undefined, { readonly: false });
	await dream.forget("moved");
});

test("five-pin cap includes defaults per notebook, and failed writes/restores/moves do not mutate", async t => {
	const { notes, file } = fixture(t);
	await fillPins(notes);
	await fillPins(notes, "@project/");
	await assert.rejects(() => notes.write("sixth", "six", { pinned: true }), refused("pin_limit"));
	assert.equal(await notes.read("sixth"), undefined);
	await notes.write("ordinary", "not pinned");
	const ordinary = readFileSync(file("ordinary.md"), "utf8");
	await assert.rejects(() => notes.update("ordinary", undefined, { pinned: true }), refused("pin_limit"));
	assert.equal(readFileSync(file("ordinary.md"), "utf8"), ordinary);
	await notes.update("three", undefined, { crumpled: true });
	await notes.write("sixth", "six", { pinned: true });
	const crumpled = readFileSync(file("three.md"), "utf8");
	await assert.rejects(() => notes.update("three", undefined, { crumpled: false }), refused("pin_limit"));
	await assert.rejects(() => notes.write("three", "restore"), refused("pin_limit"));
	assert.equal(readFileSync(file("three.md"), "utf8"), crumpled);
	await assert.rejects(() => notes.rename("sixth", "@project/sixth"), refused("pin_limit"));
	assert.equal(await notes.read("@project/sixth"), undefined);
	assert.equal((await notes.read("sixth"))!.body, "six");
	await notes.rename("sixth", "renamed"); // same notebook, no additional pin
	await notes.update("three", undefined, { crumpled: false, pinned: false });
	await notes.update("renamed", undefined, { renameTo: "@project/moved-unpinned", pinned: false });
	await notes.update("MAP", undefined, { pinned: false });
	await notes.write("replacement", "replacement", { pinned: true });
	assert.equal((await notes.list()).filter(row => row.scope === "session" && effectiveNotePolicy(row.meta, row.path).pinned).length, 4);
});

test("pin admission serializes across store instances without blocking reads or opposite-direction moves", async t => {
	const { notes, identity } = fixture(t);
	const other = createNotesStore(identity);
	for (let n = 0; n < 4; n++) await notes.write(`pin-${n}`, "pin", { pinned: true });
	const admission = await Promise.allSettled([
		notes.write("first", "one", { pinned: true }),
		other.write("second", "two", { pinned: true }),
		notes.list(), other.read("pin-0"),
	]);
	assert.equal(admission.slice(0, 2).filter(result => result.status === "fulfilled").length, 1);
	const failure = admission.slice(0, 2).find(result => result.status === "rejected");
	assert.ok(failure?.status === "rejected" && refused("pin_limit")(failure.reason));
	await notes.write("@project/from-project", "project");
	await notes.write("from-session", "session");
	await Promise.all([
		notes.rename("from-session", "@project/to-project"),
		other.rename("@project/from-project", "to-session"),
	]);
	assert.equal((await notes.read("@project/to-project"))!.body, "session");
	assert.equal((await notes.read("to-session"))!.body, "project");
});

test("moves resolve absent policy at the new path, preserving explicit false/true", async t => {
	const { notes, file } = fixture(t);
	await notes.write("MAP", "default");
	await notes.rename("MAP", "ordinary");
	assert.deepEqual(effectiveNotePolicy((await notes.read("ordinary"))!.meta, "ordinary.md"), { pinned: false, budget: 2048, readonly: false });
	await notes.rename("ordinary", "CHEATSHEET");
	assert.equal(effectiveNotePolicy((await notes.read("CHEATSHEET"))!.meta, "CHEATSHEET.md").pinned, true);
	assert.equal(parseNote(readFileSync(file("CHEATSHEET.md"), "utf8")).meta.pinned, undefined);
	await notes.update("CHEATSHEET", undefined, { pinned: false, renameTo: "MAP" });
	assert.equal(effectiveNotePolicy((await notes.read("MAP"))!.meta, "MAP.md").pinned, false);
	await notes.update("MAP", undefined, { pinned: true, renameTo: "explicit" });
	assert.equal(effectiveNotePolicy((await notes.read("explicit"))!.meta, "explicit.md").pinned, true);
	for (let n = 0; n < 4; n++) await notes.write(`extra-${n}`, "pin", { pinned: true });
	await notes.write("candidate", "candidate");
	await assert.rejects(() => notes.rename("candidate", "MAP"), refused("pin_limit"));
	assert.equal((await notes.read("candidate"))!.body, "candidate");
	await notes.update("candidate", undefined, { renameTo: "MAP", pinned: false });
	assert.equal(effectiveNotePolicy((await notes.read("MAP"))!.meta, "MAP.md").pinned, false);
});

test("boot uses metadata pins, full bodies, explicit false and visible legacy over-cap omissions", async t => {
	const { identity, notes, file } = fixture(t);
	await notes.write("CHEATSHEET", "default rules");
	await notes.write("MAP", "# Unpinned map\nMAP_NOT_INJECTED", { pinned: false });
	await notes.write("custom", "😀".repeat(2049) + "TAIL_IS_HERE", { pinned: true });
	await notes.write("nested/MAP", "# Nested map\nNESTED_NOT_INJECTED");
	await notes.write("roomy", "R".repeat(3000), { pinned: true, budget: 3000 });
	let rendered = await boot(identity);
	assert.ok(rendered.indexOf("CHEATSHEET.md\n\n  default rules") < rendered.indexOf("custom.md\n\n"));
	assert.ok(rendered.includes("😀".repeat(2049) + "TAIL_IS_HERE"));
	assert.match(rendered, /Warning: note body is 2061 Unicode code points, over budget 2048/);
	assert.ok(rendered.includes("R".repeat(3000)));
	assert.equal(rendered.includes("MAP_NOT_INJECTED"), false);
	assert.equal(rendered.includes("NESTED_NOT_INJECTED"), false);
	assert.match(rendered, /MAP.md ·/); // explicit false gets a normal recent seat

	await notes.write("a", "body a", { pinned: true });
	await notes.write("b", "body b", { pinned: true });
	await notes.write("z", "OMITTED_PIN_BODY");
	writeFileSync(file("z.md"), readFileSync(file("z.md"), "utf8").replace("\n---\n\n", "\npinned: true\n---\n\n"));
	rendered = await boot(identity);
	assert.match(rendered, /Warning: only 5 pinned notes per notebook are injected; omitted pins: z.md/);
	assert.equal(rendered.includes("OMITTED_PIN_BODY"), false);
	assert.ok(rendered.includes("TAIL_IS_HERE"));
});
