import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { loadNotesSnapshot } from "../src/boot/snapshot.js";
import { renderBootBlock } from "../src/boot/render.js";
import { deriveThresholds, remainingBudget } from "../src/budget/policy.js";
import { HistoryPageItemSchema, HistoryRoleSchema, projectHistory } from "../src/history/history.js";
import { createNotesStore } from "../src/notes/store.js";
import type { NotesIdentity } from "../src/notes/identity.js";
import { notesWrite, notesUpdate, notesRead } from "../src/tools/notes.js";
import { historyWindows, historyList, historyRead } from "../src/tools/history.js";
import { historyRoles } from "../src/tools/schema.js";
import { MAX_READ_WINDOW_CHARS, TOOL_OUTPUT_MAX_BYTES } from "../src/tools/output.js";
import {
	ERROR_MESSAGE_MAX_CHARS,
	failure,
	fitsResult,
	resultSchema,
	wireResult,
	readTextWindow,
	renderOutcome,
	renderTextWindow,
	success,
	structuredBytes,
	type OperationError,
	type Outcome,
	type TextWindow,
} from "../src/tools/result.js";

function identity(t: test.TestContext): NotesIdentity {
	const home = mkdtempSync(join(tmpdir(), "host-neutral-notes-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return { home, sessionId: "explicit-session", projectKey: "explicit-12345678", agent: "explicit-agent", model: "explicit-model" };
}

/** The data of a successful outcome, or a failed assertion naming the refusal. */
function data<T>(result: Outcome<T>): T {
	assert.ok(result.ok, `expected success, got ${result.ok ? "" : JSON.stringify(result.error)}`);
	return result.data;
}

/** The refusal of a failed outcome, or a failed assertion naming the data. */
function refusal<T>(result: Outcome<T>): OperationError {
	assert.ok(!result.ok, `expected a refusal, got success ${JSON.stringify(result.ok ? result.data : null)}`);
	return result.error;
}

/** A synthetic read operation: the window is the payload, and the header counts against the budget. */
type ReadData = { header: string; window: TextWindow };
const makeData = (window: TextWindow): ReadData => ({ header: "identity, metadata, cursors, and a footer".repeat(4), window });
const renderData = (result: Outcome<ReadData>): string =>
	result.ok ? `${result.data.header}\n${renderTextWindow(result.data.window)}` : renderOutcome(result, () => "");
const read = (text: string, offset?: number, limit?: number): Outcome<ReadData> => readTextWindow(text, offset, limit, makeData, renderData);

test("shared boot uses only explicit identity, loader, captured time and logical tool bindings", async (t) => {
	const notesIdentity = identity(t);
	const openedAt = 1_700_000_000_000;
	const scopes: string[] = [];
	const snapshot = await loadNotesSnapshot(notesIdentity, openedAt, (scope) => {
		scopes.push(scope);
		if (scope === "human") throw Object.assign(new Error("unavailable"), { code: "EIO" });
		return scope === "session" ? [{ address: "checkpoint.md", path: "checkpoint.md", scope, body: "😀", sizeBytes: 4, meta: { scope, origin: "self", createdAt: openedAt, updatedAt: openedAt - 60_000, lastAccessed: openedAt, accessCount: 0 } }] : [];
	});
	assert.deepEqual(scopes, ["session", "project", "human", "agent", "model"]);
	assert.equal(snapshot.openedAt, openedAt);
	const tools = { notes: "memo_*", notesList: "memo_list", history: "archive_*", remaining: "room", wipe: "forget" };
	const block = { agentName: notesIdentity.agent, modelName: notesIdentity.model, firstWindowId: "root", currentWindowId: "next", notes: snapshot, tools };
	const rendered = renderBootBlock(block);
	assert.equal(renderBootBlock(block), rendered);
	assert.ok(rendered.includes("😀\n  checkpoint.md · 1m ago"), "a feed entry is the note's own first line over its locator");
	assert.ok(rendered.includes("Try `memo_list` again"));
	assert.equal(/notes_\*|notes_list|history_\*|history_list|history_read|get_context_remaining|neuralyze/.test(rendered), false);
});

test("the shared result module bounds both surfaces and resumes by offset", () => {
	const text = `${"a".repeat(120)}😀${"b".repeat(30)}`;
	const chars = Array.from(text);

	// The requested count stops the read, and the footer says only where to continue.
	const first = data(read(text, 0, 10));
	assert.equal(first.window.text, chars.slice(0, 10).join(""));
	assert.equal(first.window.next_offset_chars, 10);
	assert.equal(first.window.total_chars, chars.length);
	assert.match(renderData(success(first)), /\[truncated; continue at offset_chars=10\]$/);

	// Concatenating windows by their cursors reproduces the source, marker-free.
	const second = data(read(text, first.window.next_offset_chars ?? 0, 10));
	assert.equal(`${first.window.text}${second.window.text}`, chars.slice(0, 20).join(""));

	// A negative offset counts back from the end and reaches a complete window: no footer at all.
	const tail = data(read(text, -4));
	assert.equal(tail.window.text, "bbbb");
	assert.equal(tail.window.next_offset_chars, null);
	assert.equal(renderTextWindow(tail.window), "bbbb");

	// The byte cap, not the requested count, is what stops an oversized read, and the rendered
	// header is counted against the same budget as the payload.
	const huge = "b".repeat(4 * MAX_READ_WINDOW_CHARS);
	const capped = data(read(huge, 0, MAX_READ_WINDOW_CHARS));
	const cappedEnd = capped.window.next_offset_chars ?? 0;
	assert.ok(cappedEnd < MAX_READ_WINDOW_CHARS, "the byte cap cut the requested window short");
	assert.equal(fitsResult(success(capped), renderData), true);
	assert.ok(Buffer.byteLength(renderData(success(capped)), "utf8") <= TOOL_OUTPUT_MAX_BYTES, "the model text fits");
	assert.ok(Buffer.byteLength(JSON.stringify(wireResult(success(capped))), "utf8") <= TOOL_OUTPUT_MAX_BYTES, "the structured outcome fits");
	assert.equal(capped.window.text, huge.slice(0, cappedEnd), "the delivered slice is a verbatim prefix");
	assert.match(renderData(success(capped)), new RegExp(`\\[truncated; continue at offset_chars=${cappedEnd}\\]$`));

	// Code points, not UTF-16 units.
	const emoji = data(read("😀😀😀", 1, 1));
	assert.equal(emoji.window.text, "😀");
	assert.equal(emoji.window.total_chars, 3);
	assert.equal(emoji.window.next_offset_chars, 2);

	// An empty source is a complete, footer-free window rather than a refusal.
	const empty = data(read("", 0, 10));
	assert.equal(empty.window.text, "");
	assert.equal(empty.window.total_chars, 0);
	assert.equal(empty.window.next_offset_chars, null);

	assert.equal(renderOutcome(success(first), () => "model text"), "model text");
	assert.equal(renderOutcome(failure("not_found", "note not found"), () => "never"), "error: not_found: note not found");
	assert.equal(renderOutcome(failure("ambiguous_edit", "edit 0: occurs 2 times"), () => "never"), "error: ambiguous_edit: edit 0: occurs 2 times");

	const schema = resultSchema(Type.Object({ name: Type.String() }));
	assert.equal(Check(schema, wireResult(success({ name: "test" }))), true);
	assert.equal(Check(schema, wireResult(failure("not_found", "missing"))), true);
	assert.equal(Check(schema, { name: 123 }), false);
	assert.equal(Check(schema, success({ name: "test" })), false, "the old success envelope is not the wire contract");
	assert.equal(Check(schema, failure("not_found", "missing")), false, "the old error envelope is not the wire contract");
});

test("an envelope that cannot fit is refused rather than resumed forever", () => {
	const text = "c".repeat(1000);
	// An operation whose rendered text is over budget whatever window it delivers.
	const envelope = (header: string) => ({
		makeData: (window: TextWindow) => ({ header, window }),
		render: (result: Outcome<ReadData>) => result.ok ? `${result.data.header}\n${renderTextWindow(result.data.window)}` : renderOutcome(result, () => ""),
	});
	const oversized = envelope("h".repeat(2 * TOOL_OUTPUT_MAX_BYTES));
	const refusing = readTextWindow(text, 0, undefined, oversized.makeData, oversized.render);
	const error = refusal(refusing);
	assert.equal(error.code, "output_too_large");
	assert.ok(structuredBytes(wireResult(refusing)) <= TOOL_OUTPUT_MAX_BYTES, "the refusal that replaces an unresumable window is itself bounded");
	assert.equal(fitsResult(refusing, oversized.render), true);

	// Empty text fitting is insufficient when not even one source character can fit.
	const noProgressRender = (result: Outcome<ReadData>) => result.ok ? "x".repeat(TOOL_OUTPUT_MAX_BYTES) + result.data.window.text : renderOutcome(result, () => "");
	assert.equal(refusal(readTextWindow("😀", 0, 1, makeData, noProgressRender)).code, "output_too_large");

	// At the document end, removing the footer can make the full window fit even though prefixes do not.
	const endFitsRender = (result: Outcome<ReadData>) => result.ok ? (result.data.window.next_offset_chars === null ? result.data.window.text : "x".repeat(TOOL_OUTPUT_MAX_BYTES + 1)) : renderOutcome(result, () => "");
	assert.equal(data(readTextWindow("abc", 0, 3, makeData, endFitsRender)).window.text, "abc");

	// The same text is delivered normally as soon as the envelope fits.
	const fitting = envelope("ok");
	const delivered = data(readTextWindow(text, 0, undefined, fitting.makeData, fitting.render));
	assert.equal(delivered.window.text, text);
	assert.equal(delivered.window.next_offset_chars, null);
});

test("every resumed window advances the cursor and reconstructs the source exactly", () => {
	const text = `${"é".repeat(50)}👨‍👩‍👧${"x".repeat(200_000)}\r\n😀${"漢".repeat(1000)}`;
	const chars = Array.from(text);
	assert.notEqual(text.length, chars.length, "the fixture would not catch UTF-16 counting");

	const windows: TextWindow[] = [];
	for (let offset = 0; offset < chars.length;) {
		const window = data(read(text, offset, MAX_READ_WINDOW_CHARS)).window;
		assert.equal(window.total_chars, chars.length, "one source, one length");
		if (window.next_offset_chars === null) {
			assert.equal(offset + Array.from(window.text).length, window.total_chars, "the last window reaches the true end");
			windows.push(window);
			break;
		}
		assert.ok(window.next_offset_chars > offset, "a window with text left always advances the cursor");
		windows.push(window);
		offset = window.next_offset_chars;
	}
	assert.ok(windows.length > 1, "the fixture needed more than one window");
	assert.equal(windows.map((window) => window.text).join(""), text, "concatenating the windows reproduces the source code point for code point");
	for (const window of windows) {
		assert.ok(structuredBytes(wireResult(success({ window }))) <= TOOL_OUTPUT_MAX_BYTES, "each window fits the structured surface");
	}
});

test("window offsets count code points, not UTF-16 units or graphemes", () => {
	const cases = [
		{ name: "astral", text: "😀😀😀", cursor: 1 },
		{ name: "zwj sequence", text: "👨‍👩‍👧", cursor: 2 },
		{ name: "combining mark", text: "é", cursor: 1 },
		{ name: "cjk", text: "漢字", cursor: 1 },
		{ name: "crlf", text: "a\r\nb", cursor: 3 },
		{ name: "mixed", text: "a😀b👨‍👩‍👧c", cursor: 1 },
	];
	for (const { name, text, cursor } of cases) {
		const chars = Array.from(text);
		const window = data(read(text, cursor, undefined)).window;
		assert.equal(window.total_chars, chars.length, `${name}: totals count code points`);
		assert.equal(window.text, chars.slice(cursor).join(""), `${name}: the slice starts on a code-point boundary`);
		assert.equal(window.text.includes("�"), false, `${name}: no surrogate is split`);
	}

	// Negative offsets resolve from the code-point end, not the byte or unit end.
	const emoji = "😀".repeat(3);
	const tail = data(read(emoji, -1)).window;
	assert.equal(tail.text, "😀");
	assert.equal(tail.next_offset_chars, null);
});

test("a runaway refusal message is clipped with its lost length", () => {
	const long = refusal(failure("internal_error", "m".repeat(50_000)));
	assert.ok(Array.from(long.message).length < ERROR_MESSAGE_MAX_CHARS + 40, "a runaway message is clipped with a marker");
	assert.match(long.message, /…\[truncated \d+ chars\]$/, "the clip says how much was dropped");
	assert.ok(structuredBytes(wireResult(failure("internal_error", "m".repeat(50_000)))) <= TOOL_OUTPUT_MAX_BYTES, "even a pathological refusal fits the budget");
});

test("structuredBytes has no size for a value with no JSON representation", () => {
	assert.throws(() => structuredBytes(undefined), TypeError, "undefined has no structured size");
});

test("shared note operations return canonical outcomes with a body-only read window", async (t) => {
	const notesIdentity = identity(t);
	const written = data(await notesWrite.execute({ address: "@project/test.md", content: "alpha\nbeta" }, notesIdentity));
	assert.equal(written.address, "@project/test.md");
	assert.equal(written.project_key, notesIdentity.projectKey);
	assert.equal(written.outcome, "created");

	const updated = data(await notesUpdate.execute({ address: "@project/test.md", edits: [{ oldText: "alpha", newText: "gamma" }] }, notesIdentity, (change) => {
		assert.equal(change.kind, "body");
		return "caller-rendered-diff";
	}));
	assert.equal(updated.change_kind, "body");
	assert.equal(updated.diff, "caller-rendered-diff");
	const defaultReceipt = data(await notesUpdate.execute({ address: "@project/test.md", edits: [{ oldText: "gamma", newText: "delta" }] }, notesIdentity));
	assert.equal(defaultReceipt.diff, "note body");
	const unchanged = data(await notesUpdate.execute({ address: "@project/test.md", edits: [{ oldText: "delta", newText: "delta" }] }, notesIdentity));
	assert.equal(unchanged.change_kind, "none");
	assert.equal(unchanged.diff, "");

	// Frontmatter is metadata, not body: the window addresses the body and counts only the body.
	const stored = await createNotesStore(notesIdentity).read("@project/test.md");
	assert.ok(stored, "the note is on disk");
	const body = Array.from(stored.body);
	const read = data(await notesRead.execute({ address: "@project/test.md" }, notesIdentity));
	assert.equal(read.text, stored.body, "a complete read is the whole body and nothing else");
	assert.equal(read.total_chars, body.length);
	assert.equal(read.next_offset_chars, null);
	assert.equal(read.metadata.origin, "self");
	assert.equal(notesRead.render(success(read)).includes("READ WINDOW"), false, "a read presents no metadata block");

	// A negative offset resolves against the body, never against the serialized file.
	const tail = data(await notesRead.execute({ address: "@project/test.md", offset_chars: -4 }, notesIdentity));
	assert.equal(tail.text, body.slice(-4).join(""));
	assert.equal(tail.total_chars, body.length, "metadata length never enters the body cursor");
	assert.equal(tail.next_offset_chars, null);

	assert.equal(refusal(await notesRead.execute({ address: "@project/missing.md" }, notesIdentity)).code, "not_found");
	assert.equal(refusal(await notesWrite.execute({ address: "../escape", content: "x" }, notesIdentity)).code, "invalid_address");
	assert.equal(refusal(await notesRead.execute({ address: "@project/test.md", offset_chars: 99_999 }, notesIdentity)).code, "invalid_offset");
});

test("shared history operations read typed events through the addresses the adapter allocated", async () => {
	const projection = projectHistory([{ windowId: "root", items: [
		{ seq: 1, windowId: "root", role: "user", text: "hello there" },
		{ seq: 2, windowId: "root", role: "tool_call", text: "", toolName: "read", toolCallId: "call", arguments: { path: "one.md" } },
		{ seq: 3, windowId: "root", role: "tool", text: "😀 needle output", toolName: "read", toolCallId: "call" },
	] }], 3, new Set([1, 2, 3]));

	const windows = data(await historyWindows.execute({}, projection, "explicit-session"));
	assert.equal(windows.session_id, "explicit-session");
	assert.equal(windows.windows.length, 1);
	assert.deepEqual(windows.windows[0], { window_id: "root", created_at: null, first_seq: 1, last_seq: 2 }, "a call and its result are one event, not two");

	const listed = data(await historyList.execute({ roles: ["tool"] }, projection));
	assert.equal(listed.items.length, 1);
	const item = listed.items[0];
	assert.ok(item && !('folded' in item), "the tool event carries an address");
	const seq = item.seq;
	assert.notEqual(seq, 3, "a paired result address is not an event of its own");

	// A tool event is one typed event whose document carries the call, its arguments, and its result.
	const full = data(await historyRead.execute({ seq }, projection));
	assert.equal(full.seq, seq);
	assert.equal(full.role, "tool");
	assert.match(full.text, /one\.md/, "the document carries the arguments");
	assert.match(full.text, /needle output/, "the document carries the result");
	assert.equal(full.next_offset_chars, null);

	// A query offset addresses that same document, so reading from it resumes inside the result.
	const searched = data(await historyList.execute({ query: "NEEDLE", roles: ["tool"] }, projection));
	assert.equal(searched.items.length, 1);
	const hit = searched.items[0]!;
	if ("folded" in hit) assert.fail("a query returns event rows only");
	assert.equal(hit.seq, seq);
	assert.ok((hit.offset_chars ?? 0) > 0);
	const fromMatch = data(await historyRead.execute({ seq: hit.seq, offset_chars: hit.offset_chars }, projection));
	assert.match(fromMatch.text, /^needle output/, "the match offset lands on the matched text");
	assert.equal(fromMatch.total_chars, full.total_chars, "one document, one length");

	assert.match(refusal(await historyRead.execute({ seq: 9_999 }, projection)).message, /9,?999/, "an unknown address is refused by name");
	assert.equal(refusal(await historyRead.execute({ seq: 3 }, projection)).code, "not_an_event", "a paired result address is refused");
});

test("an unknown window_id names at most five known windows in its message", async () => {
	const windows = Array.from({ length: 7 }, (_, index) => ({ windowId: `pcw:w${index}`, items: [{ seq: index + 1, windowId: `pcw:w${index}`, role: "user" as const, text: `message-${index}` }] }));
	const projection = projectHistory(windows, 7, new Set([1, 2, 3, 4, 5, 6, 7]));
	const outcome = await historyList.execute({ window_id: "pcw:absent" }, projection);
	assert.equal(outcome.ok, false);
	if (!outcome.ok) {
		assert.equal(outcome.error.code, "unknown_window_id");
		assert.match(outcome.error.message, /"pcw:absent".*pcw:w0, pcw:w1, pcw:w2, pcw:w3, pcw:w4\.$/, "the message names the known windows itself");
		assert.equal(outcome.error.message.includes("pcw:w5"), false, "at most five known windows are named");
	}
});

test("one role schema declares the four public roles for the page item, the read payload, and the role filter", () => {
	const read = (role: string) => ({
		seq: 1, window_id: "root", role, created_at: null,
		text: "", total_chars: 0, next_offset_chars: null,
	});
	assert.equal(HistoryPageItemSchema.properties.role, HistoryRoleSchema, "the page item reuses the authoritative role schema");
	assert.deepEqual(historyRoles().items, HistoryRoleSchema, "the role filter carries the authoritative role schema");
	for (const role of ["user", "assistant", "tool", "context"]) {
		assert.equal(Check(HistoryRoleSchema, role), true, `${role} is a public role`);
		assert.equal(Check(historyRead.outputSchema, read(role)), true, `history_read accepts ${role}`);
	}
	assert.equal(Check(HistoryRoleSchema, "developer"), false, "a role outside the four is refused");
	assert.equal(Check(historyRead.outputSchema, read("developer")), false, "history_read refuses a role outside the four");
});

test("history paging bounds are the schema's, and a zero limit still pages one event", async () => {
	const items = Array.from({ length: 3 }, (_, index) => ({ seq: index + 1, windowId: "root", role: "user" as const, text: `message-${index}` }));
	const projection = projectHistory([{ windowId: "root", items }], 3, new Set([1, 2, 3]));
	assert.equal(Check(historyList.parameters, { limit: 0 }), false, "the schema refuses a zero limit");
	assert.equal(Check(historyList.parameters, { limit: 501 }), false, "the schema refuses a limit past its maximum");
	assert.equal(Check(historyList.parameters, { max_chars_per_item: 0 }), false, "the schema refuses a zero preview budget");

	const zero = data(await historyList.execute({ limit: 0, from: "oldest", roles: ["user"] }, projection));
	assert.equal(zero.items.length, 1, "an unvalidated zero limit still returns one row instead of none");
	const negative = data(await historyList.execute({ max_chars_per_item: -5, roles: ["user"] }, projection));
	const row = negative.items[0]!;
	if ("folded" in row) assert.fail("a role filter returns event rows only");
	assert.equal(row.content, "", "a negative budget delivers nothing instead of cutting the tail");
	assert.equal(row.truncated, true, "the empty preview says it was truncated");
});
