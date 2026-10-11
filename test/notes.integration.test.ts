import { notesIdentityFromPi } from "../src/pi/notes/adapter.js";
import { PI_TOOL_NAMES } from "../src/pi/tool-names.js";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { loadNotesSnapshot } from "../src/boot/snapshot.js";
import { renderBootBlock } from "../src/boot/render.js";
import { localIso } from "../src/notes/frontmatter.js";
import type { NoteRow, Scope } from "../src/notes/index.js";
import { listNotes, physicalPath, scopeDir } from "./helpers/notes.js";
import { MAX_READ_WINDOW_CHARS, TOOL_OUTPUT_MAX_BYTES } from "../src/tools/output.js";
import { notesUpdate } from "../src/tools/notes.js";
import type { NotesListData, NotesReadData, NotesSearchData, NotesUpdateData } from "../src/tools/notes.js";
import {
	assertWithinBudget,
	call,
	context,
	explicitBoot,
	makeExtension,
	manager,
	resultData,
	resultError,
	resultRead,
} from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

const testEnvironment = installExtensionTestHooks("notesoup-integration");

/** The model-facing text of one tool result. */
function textOf(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first && first.type === "text" ? first.text : "";
}

test("notes_list and notes_search are recent-first snapshots with narrowing hints", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const base = 1_700_000_000_000;
	const put = (address: string, updated: number, content = "needle") => {
		const project = address.startsWith("@project/");
		const path = physicalPath(project ? "project" : "session", address.replace(/^@project\//, ""), ctx);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nscope: ${project ? "project" : "session"}\norigin: self\ncreatedAt: ${localIso(updated - 1000)}\nupdatedAt: ${localIso(updated)}\nlastAccessed: ${localIso(updated)}\naccessCount: 0\n---\n\n${content}`);
	};
	put("old.md", base + 1);
	put("new.md", base + 3);
	put("@project/design.md", base + 2);

	const listed = resultData<NotesListData>(await call(captured, "notes_list", { limit: 2 }, ctx));
	assert.deepEqual(listed.files.map((file) => file.address), ["new.md", "@project/design.md"]);
	assert.equal(listed.more, 1);
	assert.deepEqual(Object.keys(listed).sort(), ["files", "homes_unavailable", "more"]);

	const searched = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle", limit: 2 }, ctx));
	assert.deepEqual(searched.files.map((file) => file.address), ["new.md", "@project/design.md"]);
	assert.equal(searched.more, 1);

	const narrowed = resultData<NotesListData>(await call(captured, "notes_list", { pattern: "@project/**" }, ctx));
	assert.deepEqual(narrowed.files.map((file) => file.address), ["@project/design.md"]);
	assert.equal(narrowed.more, 0);
});

test("notes_list reports omitted files when the wire budget truncates the snapshot", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const timestamp = 1_700_000_000_000;
	const total = 1500;
	for (let index = 0; index < total; index++) {
		const address = `bulk/note-${String(index).padStart(4, "0")}.md`;
		const path = physicalPath("session", address, ctx);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nscope: session\norigin: self\ncreatedAt: ${localIso(timestamp)}\nupdatedAt: ${localIso(timestamp + index)}\nlastAccessed: ${localIso(timestamp)}\naccessCount: 0\n---\n\nbody`);
	}
	const result = await call(captured, "notes_list", {}, ctx);
	assertWithinBudget(result, "oversized listing");
	const listed = resultData<NotesListData>(result);
	assert.ok(listed.files.length > 0 && listed.files.length < total, "the snapshot is cut short instead of overflowing either surface");
	assert.equal(listed.more, total - listed.files.length, "omitted rows are named, not silently dropped");
	assert.equal(listed.files[0]?.address, `bulk/note-${String(total - 1).padStart(4, "0")}.md`, "the snapshot retains the newest rows first");
});

test("notes_list is most-recently-updated first across merged scopes", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const put = (scope: "session" | "project" | "human", path: string, updated: number) => {
		const file = physicalPath(scope, path, ctx);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `---\nscope: ${scope}\norigin: self\ncreatedAt: ${localIso(updated - 1000)}\nupdatedAt: ${localIso(updated)}\nlastAccessed: ${localIso(updated)}\naccessCount: 0\n---\n\nbody`);
	};
	const base = 1_700_000_000_000;
	put("session", "b.md", base + 10);
	put("session", "a.md", base + 10);
	put("project", "c.md", base + 5);
	put("human", "e.md", base + 20);
	const files = async (params: Record<string, unknown>) =>
		resultData<NotesListData>(await call(captured, "notes_list", params, ctx)).files;
	assert.deepEqual((await files({})).map((file) => file.address), ["@human/e.md", "a.md", "b.md", "@project/c.md"], "updated_at descending with address ascending as the tiebreak");
	// A same-path pair in two scopes keeps both rows; equal timestamps tie-break by scope name.
	put("human", "a.md", base + 10);
	assert.deepEqual((await files({})).filter((file) => file.address.endsWith("a.md")).map((file) => file.address), ["@human/a.md", "a.md"], "equal timestamps tie-break by full address");
	assert.deepEqual((await files({ pattern: "*.md" })).map((file) => file.address), ["a.md", "b.md"], "a bare pattern narrows to the session home");
});

test("notes are real files that persist across sessions and round-trip Unicode", async () => {
	const original = manager();
	const captured = makeExtension(original);
	const ctx = context(original);
	await call(captured, "notes_write", { address: "@human/checkpoint/进度.md", content: "第一行\nneedle Café" }, ctx);

	// A brand-new session over the same physical root sees the human note: nothing is replayed
	// from session entries, the file itself is the durable artifact.
	const restored = manager();
	const restoredCaptured = makeExtension(restored);
	const restoredCtx = context(restored);
	const rawRead = await call(restoredCaptured, "notes_read", { address: "@human/checkpoint/进度.md", offset_chars: -4 }, restoredCtx);
	const read = resultRead(rawRead);
	assert.equal(read.address, "@human/checkpoint/进度.md");
	assert.equal(read.content, "Café", "a negative offset reads the body tail in one call");
	const searched = resultData<NotesSearchData>(
		await call(restoredCaptured, "notes_search", { pattern: "@human/**", query: "Café" }, restoredCtx),
	);
	assert.equal(searched.files[0]?.matches[0]?.line, 2);
	const listedFiles = resultData<NotesListData>(
		await call(restoredCaptured, "notes_list", { pattern: "@human/checkpoint/**" }, restoredCtx),
	);
	assert.equal(listedFiles.files.length, 1, "glob ** crosses into the checkpoint directory");
	assert.equal(listedFiles.files[0]?.address, "@human/checkpoint/进度.md");
	// A single-segment * never crosses `/`, so a nested-only store matches nothing at the root.
	const rootOnly = resultData<NotesListData>(
		await call(restoredCaptured, "notes_list", { pattern: "@human/*" }, restoredCtx)
	);
	assert.equal(rootOnly.files.length, 0, "glob * stays within one segment");
	assert.equal(searched.files[0]?.updated_at, listedFiles.files[0]?.updated_at);
	assert.equal(resultError(await call(captured, "notes_write", { address: "../escape", content: "x" }, ctx)).code, "invalid_address");
});

test("crumple lifecycle: metadata-only edits close and smooth a note without touching updatedAt", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm);

	await call(captured, "notes_write", { address: "journal.md", content: "log line" }, ctx);
	const updatedBefore = (await listNotes(ctx, { scope: "session" }))[0]!.meta.updatedAt;

	// metadata-only: content unchanged, and the recorded time is the original one
	const markOnly = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "journal.md", crumpled: true }, ctx));
	assert.equal(markOnly.change_kind, "metadata");
	assert.match(markOnly.diff, /^\+\s*\d+\s+crumpledAt: \d{4}-\d{2}-\d{2}T/m);
	assert.deepEqual(await listNotes(ctx, { scope: "session" }), [], "a crumpled note leaves the live list");
	const basket = (await listNotes(ctx, { scope: "session", wastebasket: true }))[0]!;
	assert.ok(basket.meta.crumpledAt);
	assert.equal(basket.meta.updatedAt, updatedBefore, "crumpling does not change updatedAt");
	assert.equal(resultRead(await call(captured, "notes_read", { address: "journal.md" }, ctx)).content.endsWith("log line"), true, "read still reaches a crumpled note");

	// re-crumpling keeps the first time; smoothing empties the basket
	await call(captured, "notes_update", { address: "journal.md", crumpled: true }, ctx);
	assert.equal((await listNotes(ctx, { scope: "session", wastebasket: true }))[0]?.meta.crumpledAt, basket.meta.crumpledAt);
	await call(captured, "notes_update", { address: "journal.md", crumpled: false }, ctx);
	assert.deepEqual(await listNotes(ctx, { scope: "session", wastebasket: true }), []);
	assert.equal((await listNotes(ctx, { scope: "session" }))[0]?.meta.crumpledAt, undefined);

	// writing to a crumpled address always produces an uncrumpled note
	await call(captured, "notes_update", { address: "journal.md", crumpled: true }, ctx);
	await call(captured, "notes_write", { address: "journal.md", content: "reopened" }, ctx);
	assert.equal((await listNotes(ctx, { scope: "session" }))[0]?.meta.crumpledAt, undefined, "writing always produces an uncrumpled note");

	// metadata-only on a missing path is the typed not-found arm
	const missing = resultError(await call(captured, "notes_update", { address: "missing.md", crumpled: true }, ctx));
	assert.equal(missing.message, "note not found");
});

test("the filesystem notes loader treats an absent home as empty but surfaces a real directory read failure", async () => {
	const sm = manager();
	const ctx = context(sm);
	assert.deepEqual(await listNotes(ctx, { scope: "human" }), [], "a home that has not been created is empty");
	const blockedHome = scopeDir("human", ctx);
	writeFileSync(blockedHome, "not a directory");
	await assert.rejects(
		() => listNotes(ctx, { scope: "human" }),
		(error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
		"a non-ENOENT directory failure is not swallowed as an empty home",
	);
});

test("boot note acquisition is one closed snapshot and isolates one or all failed homes", async () => {
	const sm = manager();
	const ctx = context(sm);
	const updated = Date.now();
	const note = (scope: Scope, path: string, address: string, body: string): NoteRow => ({
		address,
		scope,
		path,
		body,
		sizeBytes: Buffer.byteLength(body, "utf8"),
		meta: {
			scope,
			origin: "self",
			createdAt: updated,
			updatedAt: updated,
			lastAccessed: updated,
			accessCount: 0,
		},
	});
	const rows = new Map<Scope, NoteRow[]>([
		["session", [note("session", "MAP.md", "MAP.md", "SESSION_MAP_BODY"), note("session", "session.md", "session.md", "# Session note\n\nSESSION_POCKET_BODY")]],
		["project", [note("project", "MAP.md", "@project/MAP.md", "PROJECT_MAP_BODY")]],
		["human", [note("human", "MAP.md", "@human/MAP.md", "HUMAN_MAP_BODY"), note("human", "human.md", "@human/human.md", "# Human note\n\nHUMAN_POCKET_BODY")]],
		["agent", [note("agent", "MAP.md", "@agents/root/MAP.md", "AGENT_MAP_BODY")]],
		["model", [note("model", "model.md", "@models/default/model.md", "# Model note\n\nMODEL_POCKET_BODY")]],
	]);
	const calls = new Map<Scope, number>();
	const snapshot = await loadNotesSnapshot(notesIdentityFromPi(ctx), Date.now(), (scope) => {
		calls.set(scope, (calls.get(scope) ?? 0) + 1);
		return rows.get(scope) ?? [];
	});
	assert.deepEqual([...calls.entries()], [["session", 1], ["project", 1], ["human", 1], ["agent", 1], ["model", 1]], "each selected home is loaded exactly once");
	const renderData = {
		tools: PI_TOOL_NAMES,
		agentName: "root",
		modelName: "default",
		firstWindowId: "pcw:test:root",
		currentWindowId: "pcw:test:next",
		previousWindowId: "pcw:test:root",
		notes: snapshot,
	};
	const rendered = renderBootBlock(renderData);
	assert.equal(renderBootBlock(renderData), rendered, "rendering the same boot data twice is deterministic");
	assert.ok(rendered.includes("HUMAN_MAP_BODY") && rendered.includes("PROJECT_MAP_BODY") && rendered.includes("AGENT_MAP_BODY") && rendered.includes("SESSION_MAP_BODY"), "all home maps, including session, are pinned");
	assert.ok(rendered.includes("session.md") && rendered.includes("@human/human.md"), "the fresh page carries rows from every home");
	assert.equal(rendered.includes("SESSION_POCKET_BODY"), false, "fresh-page bodies stay excluded");
	assert.equal(rendered.includes("- MAP.md"), false, "a pinned session map does not take a feed seat");
	assert.match(rendered, / {2}Session note\n {2}session\.md · (?:just now|\d+s ago)/, "a feed entry is the note's own title over its locator");
	assert.equal(rendered.includes("UTF-8 bytes"), false, "fresh rows omit implementation-oriented byte counts");
	assert.ok(rendered.indexOf("<context_window_protocol>") < rendered.indexOf("YOUR NOTES"), "the protocol explains the notes before presenting them");
	assert.match(rendered, /THIS PROJECT · @project\n─+/, "shelves carry underlined headers");
	assert.ok(rendered.includes("New pages"), "shelves label their fresh pages");
	assert.ok(rendered.indexOf("THIS SESSION") < rendered.indexOf("New pages"), "the first shelf opens the index");
	const headings = ["THIS SESSION · no @", "THIS PROJECT · @project", "YOU · @self", "THE HUMAN · @human"];
	for (let i = 1; i < headings.length; i++) assert.ok(rendered.indexOf(headings[i - 1]!) < rendered.indexOf(headings[i]!), "shelves proceed from current hands to durable");

	const expanded = await loadNotesSnapshot(notesIdentityFromPi(ctx), Date.now(), (scope) => {
		if (scope === "project" || scope === "human" || scope === "agent" || scope === "model") {
			return Array.from({ length: 6 }, (_, i) => note(scope, `note-${i}.md`, `@${scope === "agent" ? "agents/root" : scope === "model" ? "models/default" : scope}/note-${i}.md`, `body ${i}`));
		}
		return rows.get(scope) ?? [];
	});
	const expandedText = renderBootBlock({ ...renderData, notes: expanded });
	const freshRows = expandedText.match(/^ {2}\S[^\n]* · (?:just now|\d+s ago)$/gm) ?? [];
	assert.equal(freshRows.length, 13, "each shelf keeps three of its own pages; the session shelf keeps its one");
	assert.ok(expandedText.includes("@project/note-2.md"), "the project shelf's third page");
	assert.equal(expandedText.includes("@project/note-3.md"), false, "the project shelf's fourth page stays shelved");
	assert.ok(expandedText.includes("@models/default/note-2.md"), "the model shelf also gets three");
	assert.equal(expandedText.includes("You find"), false, "the old pocket heading is gone");

	const empty = await loadNotesSnapshot(notesIdentityFromPi(ctx), Date.now(), () => []);
	assert.match(renderBootBlock({ ...renderData, notes: empty }), /YOUR NOTES\n──────────\n\nNone yet\. A blank slate is a fine place to start — just don't finish there\./);
	const crumpledNote = note("session", "crumpled.md", "crumpled.md", "SHOULD_NOT_SHOW");
	const mapAndUnicode = await loadNotesSnapshot(notesIdentityFromPi(ctx), Date.now(), (scope) => scope === "session" ? [
		note("session", "MAP.md", "MAP.md", "SESSION_MAP_BODY"),
		note("session", "unicode.md", "unicode.md", "🐑字"),
		{ ...crumpledNote, meta: { ...crumpledNote.meta, crumpledAt: localIso(updated) } },
	] : []);
	const mapAndUnicodeText = renderBootBlock({ ...renderData, notes: mapAndUnicode });
	assert.match(mapAndUnicodeText, / {2}🐑字\n {2}unicode\.md · (?:just now|\d+s ago)/, "a headingless note is announced by its first line");
	assert.ok(mapAndUnicodeText.includes("THIS SESSION · no @\n───────────────────\n\nMAP — MAP.md\n\n  SESSION_MAP_BODY\n\nNew pages\n\n  🐑字\n  unicode.md · just now"), "the session shelf keeps its typography");
	assert.equal(mapAndUnicodeText.includes("crumpled.md"), false);
	assert.equal(/MAP\.md ·/.test(mapAndUnicodeText), false, "maps never take feed seats");
	assert.equal(mapAndUnicodeText.includes("THE HUMAN"), false, "empty shelves are omitted");

	const readFailure = (code: string): NodeJS.ErrnoException => Object.assign(new Error("scripted read failure"), { code });
	const oneFailed = await loadNotesSnapshot(notesIdentityFromPi(ctx), Date.now(), (scope) => {
		if (scope === "human") throw readFailure("EIO");
		return rows.get(scope) ?? [];
	});
	assert.deepEqual(oneFailed.unavailable.map((home) => home.label), ["@human"]);
	const oneFailedText = renderBootBlock({
		tools: PI_TOOL_NAMES,
		agentName: "root",
		modelName: "default",
		firstWindowId: "pcw:test:root",
		currentWindowId: "pcw:test:next",
		notes: oneFailed,
	});
	assert.ok(oneFailedText.includes("PROJECT_MAP_BODY") && oneFailedText.includes("THE HUMAN · @human\n──────────────────\n\n  This drawer wouldn't open — ask `notes_list` to try again."), "healthy homes and a per-section recovery notice survive one failure");
	assert.equal(oneFailedText.includes("HUMAN_POCKET_BODY"), false, "the failed home's index is omitted");
	assert.equal(oneFailedText.includes("Human note"), false, "the failed home takes no feed seats");

	const allFailed = await loadNotesSnapshot(notesIdentityFromPi(ctx), Date.now(), (scope) => {
		throw readFailure(scope === "session" ? "EACCES" : "EIO");
	});
	assert.equal(allFailed.unavailable.length, 5);
	const allFailedText = renderBootBlock({
		tools: PI_TOOL_NAMES,
		agentName: "root",
		modelName: "default",
		firstWindowId: "pcw:test:root",
		currentWindowId: "pcw:test:next",
		previousWindowId: "pcw:test:root",
		notes: allFailed,
	});
	assert.ok(allFailedText.includes("pcw:test:root") && allFailedText.includes("pcw:test:next"), "identity survives an all-home failure");
	assert.ok(allFailedText.includes("Your memory gets wiped when this window ends"), "protocol survives an all-home failure");
	assert.equal(allFailedText.includes("scripted read failure"), false, "the model-facing notice does not expose OS/error details");
	await assert.rejects(
		() => loadNotesSnapshot(notesIdentityFromPi(ctx), Date.now(), () => { throw new TypeError("programmer failure"); }),
		(error: unknown) => error instanceof TypeError,
		"unrelated TypeError construction failures remain visible",
	);
	await assert.rejects(
		() => loadNotesSnapshot(notesIdentityFromPi(ctx), Date.now(), () => { throw Object.assign(new Error("invalid argument"), { code: "ERR_INVALID_ARG_TYPE" }); }),
		(error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_TYPE",
		"Node ERR_* failures are not treated as filesystem errno failures",
	);
});

test("the boot block gives awake agents the notes-home file layout", async () => {
	const session = manager();
	const rendered = await explicitBoot(context(session), "pcw:test:root", undefined);
	assert.equal(rendered.includes(process.env.PI_NOTES_HOME ?? ""), false, "the absolute notes home is never exposed");
	assert.match(rendered, /<path>, no @[\s\S]*@project\/<path>[\s\S]*@human\/<path>/);
});

test("an over-budget note is delivered as a bounded prefix and resumed by next_offset_chars", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const huge = `H${"x".repeat(TOOL_OUTPUT_MAX_BYTES * 2)}`;
	const text = `${huge}\ntail line`;
	await call(captured, "notes_write", { address: "huge.md", content: text }, ctx);
	const rawFirst = await call(captured, "notes_read", { address: "huge.md" }, ctx);
	assertWithinBudget(rawFirst, "single oversized note");
	const first = resultRead(rawFirst);
	assert.ok(first.content.length > 0, "the page is not empty");
	assert.equal(first.content.includes("…"), false, "the window text is a plain prefix with no marker");
	assert.ok(first.content.startsWith("H"), "the body is delivered first, with no frontmatter in the way");
	assert.equal(first.content.length, 12000, "the default window is the full requested count");
	assert.deepEqual(Object.keys(resultData<NotesReadData>(rawFirst)).sort(), ["address", "metadata", "next_offset_chars", "text", "total_chars"], "read fields are flat");
	assert.equal("access_count" in resultData<NotesReadData>(rawFirst).metadata, false, "access bookkeeping stays in storage");
	assert.equal(textOf(rawFirst).endsWith(`\n\n[truncated; continue at offset_chars=${first.next_offset_chars}]`), true, "the footer names the resume cursor");

	// Asking for the largest legal window still cannot exceed the byte budget.
	const rawWide = await call(captured, "notes_read", { address: "huge.md", limit_chars: MAX_READ_WINDOW_CHARS }, ctx);
	assertWithinBudget(rawWide, "widest requested window");
	const wide = resultRead(rawWide);
	assert.ok(Array.from(wide.content).length < MAX_READ_WINDOW_CHARS, "the widest request is cut short");
	assert.match(textOf(rawWide), /\[truncated; continue at offset_chars=\d+\]$/, "a byte-stopped window still says where to continue");

	// Following the cursor reconstructs the body by plain concatenation.
	const parts = [first.content];
	let offset: number | null = first.next_offset_chars;
	while (offset !== null) {
		const rawChunk = await call(captured, "notes_read", { address: "huge.md", offset_chars: offset }, ctx);
		assertWithinBudget(rawChunk, `huge note chunk at ${offset}`);
		const chunk = resultRead(rawChunk);
		parts.push(chunk.content);
		offset = chunk.next_offset_chars;
	}
	assert.equal(parts.join(""), text, "the cursors reconstruct the body exactly");

	// Both surfaces stay inside the budget, and a refusal carries no window at all.
	const missingResult = await call(captured, "notes_read", { address: "no-such.md" }, ctx);
	assertWithinBudget(missingResult, "refused read");
	const root = process.env.PI_NOTES_HOME!;
	for (const result of [
		await call(captured, "notes_write", { address: "@project/receipt", content: "body" }, ctx),
		await call(captured, "notes_update", { address: "@project/receipt", edits: [{ oldText: "body", newText: "changed" }] }, ctx),
		await call(captured, "notes_list", { pattern: "@project/**" }, ctx),
		await call(captured, "notes_search", { query: "changed", pattern: "@project/**" }, ctx),
		await call(captured, "notes_read", { address: "@project/receipt" }, ctx),
	]) {
		assert.equal(JSON.stringify(result).includes(root), false, "notes receipts never expose the absolute home");
		assertWithinBudget(result, "ordinary notes receipt");
	}
	assert.equal(JSON.stringify(missingResult).includes(root), false, "failure receipts never expose the absolute home");
	const missing = resultError(missingResult);
	assert.deepEqual(Object.keys(missing).sort(), ["code", "message"], "the refusal carries a precise code and message");
	assert.equal(missing.message, "note not found");
	assert.equal(missing.code, "not_found");
});

test("an over-budget note search match is a marked prefix with an honest line address", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	// The query sits behind a prefix, so its address is a real body-absolute offset, not line 1.
	const hugeLine = `${'p'.repeat(500)}needle ${"y".repeat(TOOL_OUTPUT_MAX_BYTES * 2)}`;
	await call(captured, "notes_write", { address: "a.md", content: "needle small" }, ctx);
	await call(captured, "notes_write", { address: "search.md", content: hugeLine }, ctx);
	const pages: Array<{ address: string; matches: Array<{ line: number; text: string; offset_chars: number }> }> = [];
	const rawFound = await call(captured, "notes_search", { query: "needle", limit: 10 }, ctx);
	const found = resultData<NotesSearchData>(rawFound);
	assert.ok(Buffer.byteLength(JSON.stringify(found), "utf8") <= TOOL_OUTPUT_MAX_BYTES, "the structured match result stays within budget");
	assert.match(textOf(rawFound), /\[truncated\]/, "the model-facing match line carries the same marker");
	pages.push(...found.files);
	assert.equal(found.more, 1, "the oversized result names the omitted matching file");
	assert.deepEqual(pages.map((file) => file.address), ["search.md"], "the snapshot keeps the most recently updated match");
	const oversized = pages[0]!;
	assert.equal(oversized.matches.length, 1);
	const match = oversized.matches[0]!;
	assert.ok(match.text.endsWith(" [truncated]"), "a shortened match line ends with the ellipsis marker");
	assert.ok(hugeLine.startsWith(match.text.slice(0, -" [truncated]".length)), "the match text is a plain prefix of the line plus its marker");
	assert.equal(match.line, 1, "the informational line number survives");
	assert.equal(match.offset_chars, 500, "the offset addresses the body directly, so the query's real position survives");
	const atMatch = resultRead(await call(captured, "notes_read", { address: "search.md", offset_chars: match.offset_chars }, ctx));
	assert.ok(atMatch.content.startsWith("needle"), "the search offset starts a read at the matched substring");
	// The body is reconstructible by following notes_read's cursor from the start of the file.
	const parts: string[] = [];
	let offset: number | null = 0;
	while (offset !== null) {
		const rawChunk = await call(captured, "notes_read", { address: "search.md", offset_chars: offset }, ctx);
		assertWithinBudget(rawChunk, `search.md chunk at ${offset}`);
		const chunk = resultRead(rawChunk);
		parts.push(chunk.content);
		offset = chunk.next_offset_chars;
	}
	assert.ok(parts.join("").endsWith(hugeLine), "resuming across pages reconstructs the matched body line");
});

test("notes_search ignores case, treats queries literally, and preserves original Unicode offsets", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "case-match.md", content: "😀İ NeEdLe.* tail" }, ctx);
	const found = resultData<NotesSearchData>(await call(captured, "notes_search", { query: ["missing", "needle.*"], pattern: "case-match.md" }, ctx));
	assert.equal(found.files.length, 1);
	assert.equal(found.files[0]!.matches.length, 1);
	const hit = found.files[0]!;
	const read = resultRead(await call(captured, "notes_read", { address: hit.address, offset_chars: hit.matches[0]!.offset_chars }, ctx));
	assert.equal(read.content, "NeEdLe.* tail");
	const absent = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle.+", pattern: "case-match.md" }, ctx));
	assert.deepEqual(absent.files, []);
});

test("notes_search scopes by glob pattern; a non-matching pattern is an empty page, not an error", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "deep/nested/a.md", content: "needle here" }, ctx);
	await call(captured, "notes_write", { address: "top.md", content: "needle there" }, ctx);
	const scoped = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle", pattern: "deep/**" }, ctx));
	assert.deepEqual(scoped.files.map((file) => file.address), ["deep/nested/a.md"], "a glob scopes the search to the subtree");
	const none = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle", pattern: "absent/**" }, ctx));
	assert.deepEqual(none.files, [], "a non-matching pattern is an empty page, not a refusal");
});

test("an over-budget mutation diff is shortened on both surfaces, and the edit still lands whole", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const line = `${"a".repeat(300)}\n`;
	await call(captured, "notes_write", { address: "bulk-edit.md", content: line.repeat(1500) }, ctx);

	const raw = await call(captured, "notes_update", { address: "bulk-edit.md", edits: [{ oldText: "a".repeat(300), newText: "b".repeat(300) }], replace_all: true }, ctx);
	assertWithinBudget(raw, "oversized diff receipt");
	const update = resultData<NotesUpdateData>(raw);
	assert.equal(update.change_kind, "body");
	assert.ok(update.diff.length > 0, "a shortened diff is still delivered, not emptied");
	assert.ok(update.diff.endsWith("[diff truncated; update applied]"), "a shortened diff ends with the marker line");
	assert.match(textOf(raw), /^updated bulk-edit\.md/, "the receipt still names the note it updated");
	assert.ok(textOf(raw).includes("[diff truncated; update applied]"), "the model-facing text carries the same marker");
	assert.equal(textOf(raw).includes(`+${"b".repeat(300)}`), false, "the delivered diff prefix stops inside the first change");

	const body = resultRead(await call(captured, "notes_read", { address: "bulk-edit.md", limit_chars: 300 }, ctx)).content;
	assert.equal(body, "b".repeat(300), "every one of the 1500 replacements was applied, not just the ones that fit the receipt");
});

test("oversized note metadata is named in place instead of riding along in the envelope", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const path = physicalPath("session", "fat-meta.md", ctx);
	mkdirSync(dirname(path), { recursive: true });
	const stamp = localIso(Date.now());
	writeFileSync(path, `---\norigin: external\ncreatedAt: ${stamp}\nupdatedAt: ${stamp}\nlastAccessed: ${stamp}\naccessCount: 4\nsmall: kept\nfat: "${"x".repeat(8000)}"\n---\n\nbody text`);

	const raw = await call(captured, "notes_read", { address: "fat-meta.md" }, ctx);
	assertWithinBudget(raw, "read with oversized metadata");
	const read = resultRead(raw);
	const metadata = resultData<NotesReadData>(raw).metadata;
	assert.equal(read.content, "body text", "metadata size never enters the body window");
	assert.equal(metadata.origin, "external");
	assert.equal("access_count" in metadata, false, "access bookkeeping stays in storage");
	assert.equal(metadata.extra.small, "kept", "a small unrecognized key is delivered");
	assert.equal(metadata.extra.fat, "[omitted: too large]", "an oversized value is named in place, not hidden");
	assert.match(textOf(raw), /\[omitted: too large\]/, "the model-facing metadata carries the marker too");
	assert.equal(read.total_chars, 9, "the window counts the body only, whatever the front weighs");
});

test("a giant frontmatter key is left out of a read instead of riding along in the envelope", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const path = physicalPath("session", "fat-key.md", ctx);
	mkdirSync(dirname(path), { recursive: true });
	const stamp = localIso(Date.now());
	const giantKey = `k${"x".repeat(40_000)}`;
	writeFileSync(path, `---\norigin: self\ncreatedAt: ${stamp}\nupdatedAt: ${stamp}\nlastAccessed: ${stamp}\naccessCount: 0\n${giantKey}: "v"\nsmall: kept\n---\n\n`);

	const raw = await call(captured, "notes_read", { address: "fat-key.md" }, ctx);
	assertWithinBudget(raw, "read beside a giant frontmatter key");
	const read = resultRead(raw);
	const metadata = resultData<NotesReadData>(raw).metadata;
	assert.equal(read.content, "", "an empty body stays empty: nothing was borrowed to pay for the key");
	assert.equal(read.total_chars, 0);
	assert.equal(metadata.extra.small, "kept", "a small key beside a giant one is still delivered");
	assert.equal(Object.prototype.hasOwnProperty.call(metadata.extra, giantKey), false, "the giant key is never partially delivered");
});

test("an extra value beyond the verbatim budget is named in place, not dropped", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const path = physicalPath("session", "many-extras.md", ctx);
	mkdirSync(dirname(path), { recursive: true });
	const stamp = localIso(Date.now());
	const keys = Array.from({ length: 10 }, (_, index) => `k${index}: "${"x".repeat(400)}"`).join("\n");
	writeFileSync(path, `---\norigin: self\ncreatedAt: ${stamp}\nupdatedAt: ${stamp}\nlastAccessed: ${stamp}\naccessCount: 0\n${keys}\n---\n\nbody`);

	const metadata = resultData<NotesReadData>(await call(captured, "notes_read", { address: "many-extras.md" }, ctx)).metadata;
	assert.equal(metadata.extra.k0, "x".repeat(400), "the first extras are delivered verbatim");
	assert.equal(metadata.extra.k9, "[omitted: too large]", "an extra past the verbatim budget is named, not dropped");
	assert.equal(Object.keys(metadata.extra).length, 10, "every key is still accounted for");
});

test("an unexpected notes defect propagates with its own identity while real filesystem refusals stay structured", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const identity = notesIdentityFromPi(ctx);
	await call(captured, "notes_write", { address: "propagate.md", content: "before" }, ctx);

	// The injected renderer is this layer's own collaborator: a defect there is a defect in the
	// program, and it must reach the operator as the same Error, not as a fabricated refusal.
	// Its message deliberately opens with "query " — the wording a refusal classification once
	// matched on, which turned any such defect into a wrong invalid_query.
	const sentinel = new TypeError("query renderer invariant broken");
	await assert.rejects(
		() => notesUpdate.execute({ address: "propagate.md", edits: [{ oldText: "before", newText: "after" }] }, identity, () => { throw sentinel; }),
		(error: unknown) => error === sentinel,
		"an unexpected failure escapes with the identical Error, message and stack",
	);
	assert.equal(resultRead(await call(captured, "notes_read", { address: "propagate.md" }, ctx)).content, "after", "the edit was applied before the receipt failed; the throw claims no rollback");

	const assertion = Object.assign(new Error("assertion failed"), { code: "ERR_ASSERTION" });
	await assert.rejects(
		() => notesUpdate.execute({ address: "propagate.md", edits: [{ oldText: "after", newText: "later" }] }, identity, () => { throw assertion; }),
		(error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_ASSERTION",
		"a Node ERR_ code is a programmer failure, never an io_error",
	);

	// A genuine filesystem refusal is still an expected outcome, and still says nothing about paths.
	rmSync(scopeDir("session", ctx), { recursive: true, force: true });
	writeFileSync(scopeDir("session", ctx), "not a directory");
	const refusal = resultError(await call(captured, "notes_write", { address: "blocked.md", content: "x" }, ctx));
	assert.equal(refusal.code, "io_error");
	assert.equal(refusal.message, "notes operation failed");
});

test("a body that repeats one anchor thousands of times refuses with bounded, counted facts", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const repeats = 5000;
	await call(captured, "notes_write", { address: "many.md", content: `${"beta\n".repeat(repeats)}end` }, ctx);

	const raw = await call(captured, "notes_update", { address: "many.md", edits: [{ oldText: "beta", newText: "B" }] }, ctx);
	assertWithinBudget(raw, "refusal with thousands of match lines");
	const refusal = resultError(raw);
	assert.equal(refusal.code, "ambiguous_edit");
	assert.match(refusal.message, /edit 0:/, "the message names the failing edit index");
	assert.match(refusal.message, /occurs 5000 times \(lines 1, 2, 3, 4, 5, 6, 7, 8, and 4992 more\)/, "the message names a bounded sample and the exact total");
	assert.equal(resultRead(await call(captured, "notes_read", { address: "many.md", limit_chars: 15 }, ctx)).content, "beta\n".repeat(3), "the refused edit changed nothing");

	const replaced = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "many.md", edits: [{ oldText: "beta", newText: "B" }], replace_all: true }, ctx));
	assertWithinBudget(await call(captured, "notes_read", { address: "many.md" }, ctx), "read after replace_all");
	assert.equal(replaced.change_kind, "body");
});
