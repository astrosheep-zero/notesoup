import { notesIdentityFromPi } from "../plugins/pi/notes/adapter.js";
import { DEFAULT_BOOT_TOOL_NAMES, renderProtocolBlock } from "../src/boot/text.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { loadNotesSnapshot } from "../src/boot/snapshot.js";
import { renderBootBlock } from "../src/boot/render.js";
import type { DreamBeginData } from "../src/tools/dream.js";
import { localIso } from "../src/notes/frontmatter.js";
import { createNotesStore } from "../src/notes/index.js";
import { listNotes, physicalPath, scopeDir } from "./helpers/notes.js";
import { MAX_READ_WINDOW_CHARS, TOOL_OUTPUT_MAX_BYTES } from "../src/tools/output.js";
import { notesUpdate } from "../src/tools/notes.js";
import { notesToolContext } from "../src/tools/notes-context.js";
import type { NotesListData, NotesReadData, NotesSearchData, NotesUpdateData } from "../src/tools/notes.js";
import {
	assertWithinBudget,
	call,
	context,
	makeExtension,
	manager,
	resultData,
	resultError,
	resultRead,
	runHandlers,
} from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

const testEnvironment = installExtensionTestHooks("notesoup-integration");

/** The model-facing text of one tool result. */
function textOf(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first && first.type === "text" ? first.text : "";
}

for (const scanFails of [false, true]) {
	test(`Pi shutdown cancels a pending dream after its gated scan ${scanFails ? "fails" : "resumes"}`, async (t) => {
		const session = manager();
		const captured = makeExtension(session);
		const ctx = context(session);
		const me = notesIdentityFromPi(ctx);
		const otherCtx = context(manager(), undefined, undefined, true, join(testEnvironment.cwd, "other-project"));
		const other = notesIdentityFromPi(otherCtx);
		assert.notEqual(other.projectKey, me.projectKey);
		const lockPath = join(me.home, ".dream.lock");
		const original = fs.readdir;
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>(resolve => { enter = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		let gated = false;
		t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
			if (!gated && args[0] === join(me.home, "project", me.projectKey)) {
				gated = true;
				enter();
				await gate;
				if (scanFails) throw new TypeError("scan failed after shutdown");
			}
			return original(...args);
		});
		syncBuiltinESMExports();
		t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });

		const opening = call(captured, "dream_begin", {}, ctx);
		await entered;
		assert.ok(existsSync(lockPath), "begin acquired ownership before the controlled scan await");
		assert.equal(resultError(await call(captured, "dream_begin", {}, ctx)).code, "already_dreaming");
		await runHandlers(captured, "session_shutdown", { type: "session_shutdown" }, ctx);
		assert.equal(existsSync(lockPath), false, "the registered shutdown handler releases pending ownership");
		assert.equal(resultError(await call(captured, "dream_end", {}, ctx)).code, "not_dreaming");

		const newer = resultData<DreamBeginData>(await call(captured, "dream_begin", {}, otherCtx));
		assert.equal(newer.project, other.projectKey, "another project can immediately begin after shutdown");
		const newerToken = readFileSync(lockPath, "utf8");
		release();
		assert.equal(resultError(await opening).code, "cancelled", "the stale opener cannot return success or resurrect state");
		assert.equal(readFileSync(lockPath, "utf8"), newerToken, "stale cleanup cannot release the newer owner's token");
		assert.equal(resultError(await call(captured, "dream_end", {}, ctx)).code, "not_dreaming");
		resultData(await call(captured, "dream_end", {}, otherCtx));
		assert.equal(existsSync(lockPath), false);
	});
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
	assert.deepEqual(Object.keys(listed).sort(), ["files", "more", "namespaces_unavailable"]);

	const searched = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle", limit: 2 }, ctx));
	assert.deepEqual(searched.files.map((file) => file.address), ["new.md", "@project/design.md"]);
	assert.equal(searched.more, 1);

	const narrowed = resultData<NotesListData>(await call(captured, "notes_list", { glob: "@project/**" }, ctx));
	assert.deepEqual(narrowed.files.map((file) => file.address), ["@project/design.md"]);
	assert.equal(narrowed.more, 0);
});

test("empty notes queries list scoped notes without fabricated matches", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (const [address, content] of [["empty-query/blank.md", ""], ["empty-query/hit.md", "needle"], ["outside.md", "needle"]]) {
		await call(captured, "notes_write", { address, content }, ctx);
	}
	await call(captured, "notes_write", { address: "empty-query/hidden.md", content: "needle" }, ctx);
	await call(captured, "notes_update", { address: "empty-query/hidden.md", crumpled: true }, ctx);
	for (const crumpled of [false, true]) {
		const filters = { glob: "empty-query/**", crumpled, limit: 1 };
		const listed = resultData<NotesListData>(await call(captured, "notes_list", filters, ctx));
		const expected = { ...listed, files: listed.files.map(file => ({ ...file, matches: [] })) };
		for (const query of [undefined, "", [], ["", ""]]) {
			assert.deepEqual(resultData<NotesSearchData>(await call(captured, "notes_search", { ...filters, query }, ctx)), expected);
		}
	}
	const filters = { glob: "empty-query/**" };
	assert.deepEqual(
		resultData<NotesSearchData>(await call(captured, "notes_search", { ...filters, query: ["", "needle"] }, ctx)),
		resultData<NotesSearchData>(await call(captured, "notes_search", { ...filters, query: "needle" }, ctx)),
	);
	assert.equal(resultError(await call(captured, "notes_search", { query: [42] }, ctx)).code, "invalid_query");
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
	assert.deepEqual((await files({ glob: "*.md" })).map((file) => file.address), ["@human/e.md", "@human/a.md", "a.md", "b.md", "@project/c.md"], "a slashless glob matches filenames across notebooks");
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
		await call(restoredCaptured, "notes_search", { glob: "@human/**", query: "Café" }, restoredCtx),
	);
	assert.equal(searched.files[0]?.matches[0]?.line, 2);
	const listedFiles = resultData<NotesListData>(
		await call(restoredCaptured, "notes_list", { glob: "@human/checkpoint/**" }, restoredCtx),
	);
	assert.equal(listedFiles.files.length, 1, "glob ** crosses into the checkpoint directory");
	assert.equal(listedFiles.files[0]?.address, "@human/checkpoint/进度.md");
	// A single-segment * never crosses `/`, so a nested-only store matches nothing at the root.
	const rootOnly = resultData<NotesListData>(
		await call(restoredCaptured, "notes_list", { glob: "@human/*" }, restoredCtx)
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
	const updatedBefore = (await listNotes(ctx))[0]!.meta.updatedAt;

	// metadata-only: content unchanged, and the recorded time is the original one
	const markOnlyRaw = await call(captured, "notes_update", { address: "journal.md", crumpled: true }, ctx);
	const markOnly = resultData<NotesUpdateData>(markOnlyRaw);
	assert.equal(markOnly.change_kind, "metadata");
	assert.match((markOnlyRaw.details as { diff?: string } | undefined)?.diff ?? "", /^\+\s*\d+\s+crumpledAt: \d{4}-\d{2}-\d{2}T/m);
	assert.deepEqual(await listNotes(ctx), [], "a crumpled note leaves the live list");
	const basket = (await listNotes(ctx, { crumpled: true }))[0]!;
	assert.ok(basket.meta.crumpledAt);
	assert.equal(basket.meta.updatedAt, updatedBefore, "crumpling does not change updatedAt");
	assert.equal(resultRead(await call(captured, "notes_read", { address: "journal.md" }, ctx)).content.endsWith("log line"), true, "read still reaches a crumpled note");

	// re-crumpling keeps the first time; smoothing empties the basket
	await call(captured, "notes_update", { address: "journal.md", crumpled: true }, ctx);
	assert.equal((await listNotes(ctx, { crumpled: true }))[0]?.meta.crumpledAt, basket.meta.crumpledAt);
	await call(captured, "notes_update", { address: "journal.md", crumpled: false }, ctx);
	assert.deepEqual(await listNotes(ctx, { crumpled: true }), []);
	assert.equal((await listNotes(ctx))[0]?.meta.crumpledAt, undefined);

	// writing to a crumpled address always produces an uncrumpled note
	await call(captured, "notes_update", { address: "journal.md", crumpled: true }, ctx);
	await call(captured, "notes_write", { address: "journal.md", content: "reopened" }, ctx);
	assert.equal((await listNotes(ctx))[0]?.meta.crumpledAt, undefined, "writing always produces an uncrumpled note");

	// metadata-only on a missing path is the typed not-found arm
	const missing = resultError(await call(captured, "notes_update", { address: "missing.md", crumpled: true }, ctx));
	assert.equal(missing.code, "not_found");
});

test("the filesystem notes loader treats an absent notebook as empty but surfaces a real directory read failure", async () => {
	const sm = manager();
	const ctx = context(sm);
	assert.deepEqual(await listNotes(ctx, { glob: "@human/**" }), [], "a notebook that has not been created is empty");
	const blockedHome = scopeDir("human", ctx);
	writeFileSync(blockedHome, "not a directory");
	await assert.rejects(
		() => listNotes(ctx, { glob: "@human/**" }),
		(error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
		"a non-ENOENT directory failure is not swallowed as an empty notebook",
	);
});

test("boot acquisition isolates filesystem failures but not programmer errors", async () => {
	const identity = notesIdentityFromPi(context(manager()));
	const notes = createNotesStore(identity);
	await notes.write("@project/available", "AVAILABLE_NOTE");
	const [available] = await notes.list();
	assert.ok(available);
	for (const failures of [["human"], ["session", "project", "human", "agent", "model"]] as const) {
		const snapshot = await loadNotesSnapshot(identity, Date.now(), scope => {
			if ((failures as readonly string[]).includes(scope)) throw Object.assign(new Error("private filesystem detail"), { code: "EIO" });
			return scope === "project" ? [available] : [];
		});
		assert.deepEqual(snapshot.unavailable.map(namespace => namespace.scope), failures);
		assert.deepEqual(snapshot.namespaces.get("project"), failures.length === 1 ? [available] : []);
		const rendered = renderBootBlock({
			tools: DEFAULT_BOOT_TOOL_NAMES, agentName: "root", modelName: "default",
			tree: { trunk: "snapshot-test", windows: [{ shortName: "root", isCurrent: true }] }, notes: snapshot,
		});
		assert.ok(rendered.includes("snapshot-test"));
		assert.ok(rendered.includes(renderProtocolBlock(DEFAULT_BOOT_TOOL_NAMES, "root")));
		assert.equal(rendered.includes("private filesystem detail"), false);
	}
	for (const error of [new TypeError("programmer failure"), Object.assign(new Error("invalid argument"), { code: "ERR_INVALID_ARG_TYPE" })]) {
		await assert.rejects(() => loadNotesSnapshot(identity, Date.now(), () => { throw error; }), thrown => thrown === error);
	}
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
	assert.deepEqual(Object.keys(resultData<NotesReadData>(rawFirst)).sort(), ["address", "metadata", "next_offset_chars", "text", "total_chars", "warnings"], "read fields are flat");
	assert.equal("access_count" in resultData<NotesReadData>(rawFirst).metadata, false, "access bookkeeping stays in storage");
	assert.equal(textOf(rawFirst).endsWith(`\n\n[truncated; continue at offset_chars=${first.next_offset_chars}]`), true, "the footer names the resume cursor");

	// Asking for the largest legal window still cannot exceed the byte budget.
	const rawWide = await call(captured, "notes_read", { address: "huge.md", max_chars: MAX_READ_WINDOW_CHARS }, ctx);
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
	const root = process.env.NOTESOUP_HOME!;
	for (const result of [
		await call(captured, "notes_write", { address: "@project/receipt", content: "body" }, ctx),
		await call(captured, "notes_update", { address: "@project/receipt", edits: [{ oldText: "body", newText: "changed" }] }, ctx),
		await call(captured, "notes_list", { glob: "@project/**" }, ctx),
		await call(captured, "notes_search", { query: "changed", glob: "@project/**" }, ctx),
		await call(captured, "notes_read", { address: "@project/receipt" }, ctx),
	]) {
		assert.equal(JSON.stringify(result).includes(root), false, "notes receipts never expose the absolute home");
		assertWithinBudget(result, "ordinary notes receipt");
	}
	assert.equal(JSON.stringify(missingResult).includes(root), false, "failure receipts never expose the absolute home");
	const missing = resultError(missingResult);
	assert.deepEqual(Object.keys(missing).sort(), ["code", "message"], "the refusal carries a precise code and message");
	assert.equal(missing.code, "not_found");
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
	const found = resultData<NotesSearchData>(await call(captured, "notes_search", { query: ["missing", "needle.*"], glob: "case-match.md" }, ctx));
	assert.equal(found.files.length, 1);
	assert.equal(found.files[0]!.matches.length, 1);
	const hit = found.files[0]!;
	const read = resultRead(await call(captured, "notes_read", { address: hit.address, offset_chars: hit.matches[0]!.offset_chars }, ctx));
	assert.equal(read.content, "NeEdLe.* tail");
	const absent = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle.+", glob: "case-match.md" }, ctx));
	assert.deepEqual(absent.files, []);
});

test("notes_search scopes by glob; a non-matching glob is an empty page, not an error", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	await call(captured, "notes_write", { address: "deep/nested/a.md", content: "needle here" }, ctx);
	await call(captured, "notes_write", { address: "top.md", content: "needle there" }, ctx);
	const scoped = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle", glob: "deep/**" }, ctx));
	assert.deepEqual(scoped.files.map((file) => file.address), ["deep/nested/a.md"], "a glob scopes the search to the subtree");
	const none = resultData<NotesSearchData>(await call(captured, "notes_search", { query: "needle", glob: "absent/**" }, ctx));
	assert.deepEqual(none.files, [], "a non-matching glob is an empty page, not a refusal");
});

test("a large mutation keeps a receipt and budget warning while details.diff carries the UI diff", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const line = `${"a".repeat(300)}\n`;
	await call(captured, "notes_write", { address: "bulk-edit.md", content: line.repeat(1500) }, ctx);

	const raw = await call(captured, "notes_update", { address: "bulk-edit.md", edits: [{ oldText: "a".repeat(300), newText: "b".repeat(300) }], replace_all: true }, ctx);
	assertWithinBudget(raw, "bulk edit receipt");
	const update = resultData<NotesUpdateData>(raw);
	assert.equal(update.change_kind, "body");
	assert.match(textOf(raw), /^updated bulk-edit\.md\b/);
	assert.ok(update.warnings.length > 0);
	for (const warning of update.warnings) assert.ok(textOf(raw).includes(warning), "budget warnings remain visible");
	assert.match((raw.details as { diff?: string } | undefined)?.diff ?? "", new RegExp(`\\+.*?${"b".repeat(300)}`), "details.diff carries the UI diff");

	const body = resultRead(await call(captured, "notes_read", { address: "bulk-edit.md", max_chars: 300 }, ctx)).content;
	assert.equal(body, "b".repeat(300), "every one of the 1500 replacements was applied");
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
	const count = Math.ceil(TOOL_OUTPUT_MAX_BYTES / 400) + 1;
	const keys = Array.from({ length: count }, (_, index) => `k${index}: "${"x".repeat(400)}"`).join("\n");
	writeFileSync(path, `---\norigin: self\ncreatedAt: ${stamp}\nupdatedAt: ${stamp}\nlastAccessed: ${stamp}\naccessCount: 0\n${keys}\n---\n\nbody`);

	const metadata = resultData<NotesReadData>(await call(captured, "notes_read", { address: "many-extras.md" }, ctx)).metadata;
	assert.equal(metadata.extra.k0, "x".repeat(400), "the first extras are delivered verbatim");
	assert.equal(metadata.extra[`k${count - 1}`], "[omitted: too large]", "an extra past the verbatim budget is named, not dropped");
	assert.equal(Object.keys(metadata.extra).length, count, "every key is still accounted for");
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
		() => notesUpdate.execute({ address: "propagate.md", edits: [{ oldText: "before", newText: "after" }] }, notesToolContext(identity, "/work/current"), () => { throw sentinel; }),
		(error: unknown) => error === sentinel,
		"an unexpected failure escapes with the identical Error, message and stack",
	);
	assert.equal(resultRead(await call(captured, "notes_read", { address: "propagate.md" }, ctx)).content, "after", "the edit was applied before the receipt failed; the throw claims no rollback");

	const assertion = Object.assign(new Error("assertion failed"), { code: "ERR_ASSERTION" });
	await assert.rejects(
		() => notesUpdate.execute({ address: "propagate.md", edits: [{ oldText: "after", newText: "later" }] }, notesToolContext(identity, "/work/current"), () => { throw assertion; }),
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
	assert.match(refusal.message, /edits\[0\]/, "the message names the failing edit index");
	assert.match(refusal.message, /5000 times/, "the message names the exact total");
	assert.ok(refusal.message.length < repeats, "the message summarizes rather than enumerating every line");
	assert.equal(resultRead(await call(captured, "notes_read", { address: "many.md", max_chars: 15 }, ctx)).content, "beta\n".repeat(3), "the refused edit changed nothing");

	const replaced = resultData<NotesUpdateData>(await call(captured, "notes_update", { address: "many.md", edits: [{ oldText: "beta", newText: "B" }], replace_all: true }, ctx));
	assertWithinBudget(await call(captured, "notes_read", { address: "many.md" }, ctx), "read after replace_all");
	assert.equal(replaced.change_kind, "body");
});
