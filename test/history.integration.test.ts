import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
import { earliestMatchOffsetChars, TOOL_OUTPUT_MAX_BYTES } from "../src/tools/output.js";
import { historyList, historyRead, historyWindows } from "../src/tools/history.js";
import { historyDocument, projectHistory, type DecodedHistoryItem } from "../src/history/history.js";
import { selectPage, type HistoryPage } from "../src/history/query.js";
import {
	appendText,
	assertWithinBudget,
	call,
	context,
	makeExtension,
	manager,
	resultData,
	resultError,
	resultRead,
} from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

installExtensionTestHooks("notesoup-history-v2");

type Page = { items: Array<Record<string, unknown>>; page_older: { before_seq: number } | null; page_newer: { after_seq: number; from: "oldest" } | null };
type Appendable = Parameters<SessionManager["appendMessage"]>[0];

/** Append a message the way the host records one, without the harness's per-role sugar. */
function append(session: SessionManager, message: Record<string, unknown>): string {
	return session.appendMessage(message as unknown as Appendable);
}

function toolCall(session: SessionManager, id: string, name: string, args: unknown): string {
	return append(session, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: Date.now() });
}

function toolResult(session: SessionManager, id: string, name: string, text: string, extra: Record<string, unknown> = {}): string {
	return append(session, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now(), ...extra });
}

function page(result: Awaited<ReturnType<typeof call>>): Page {
	return resultData<Page>(result);
}

function seqs(result: Awaited<ReturnType<typeof call>>): number[] {
	return page(result).items.map((item) => item.seq as number);
}

/** What the model reads for one result, so a test can check the text surface directly. */
function rendered(result: Awaited<ReturnType<typeof call>>): string {
	return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

test("history_list exposes bounded paging, `from` and a literal query, while notes use snapshot limits", () => {
	const captured = makeExtension(manager());
	const readSchema = captured.tools.get("history_read")?.parameters as { properties?: Record<string, unknown>; required?: string[] };
	const legacyItemKey = ["item", "id"].join("_");
	assert.ok(readSchema.properties?.seq);
	assert.deepEqual(readSchema.required, ["seq"]);
	assert.equal(readSchema.properties?.[legacyItemKey], undefined);
	assert.equal(readSchema.properties?.window_id, undefined);

	const listSchema = captured.tools.get("history_list")!.parameters as TSchema;
	const properties = (listSchema as unknown as { properties: Record<string, { minimum?: number; anyOf?: Array<{ const?: string }>; items?: { anyOf?: Array<{ const?: string }> } }> }).properties;
	assert.equal(properties.before_seq?.minimum, 1, "bounds are positive seqs");
	assert.equal(properties.after_seq?.minimum, 1);
	assert.equal(Check(listSchema, { before_seq: 0 }), false, "before_seq:0 is refused by the schema, not answered with a silent empty page");
	assert.equal(Check(listSchema, { after_seq: 0 }), false);
	assert.deepEqual(properties.from?.anyOf?.map((item) => item.const), ["newest", "oldest"]);
	assert.ok(properties.query);
	assert.equal(properties.around, undefined);
	assert.equal(properties.tool_name, undefined);
	assert.equal(properties.custom_type, undefined);
	assert.equal(properties.cursor, undefined);
	assert.deepEqual(properties.roles?.items?.anyOf?.map((item) => item.const), ["user", "assistant", "tool", "context"], "the role filter carries the four public roles");
	assert.ok(properties.since, "the time filter has a since param");
	assert.ok(properties.until, "the time filter has an until param");
	assert.equal(Check(listSchema, { since: "2026-10-10", until: "2026-10-10T06:00:00Z" }), true);
	assert.equal(Check(listSchema, { since: "" }), false, "an empty time value is refused by the schema");
	assert.equal(Check(listSchema, { query: "needle", from: "oldest", roles: ["tool"] }), true);
	assert.equal(Check(listSchema, { from: "recent" }), false);
	// The retired names are unknown parameters, refused like any other: `additionalProperties: false`.
	for (const retired of [{ before: 5 }, { after: 5 }, { order: "oldest" }, { limit_chars: 10 }]) {
		assert.equal(Check(listSchema, retired), false, `${Object.keys(retired)[0]} is refused as an unknown parameter`);
	}
	assert.equal(Check(listSchema, { query: "" }), true, "an empty literal is schema-valid; the operation refuses it as invalid_query");
	for (const invalid of [{ roles: ["tool_call"] }, { roles: ["system"] }, { tool_name: "bash" }, { roles: [] }]) {
		assert.equal(Check(listSchema, invalid), false, JSON.stringify(invalid));
	}

	const windowsSchema = captured.tools.get("history_windows")?.parameters as { properties?: Record<string, unknown> };
	assert.deepEqual(Object.keys(windowsSchema.properties ?? []), []);

	const notesSchema = captured.tools.get("notes_list")?.parameters as { properties?: Record<string, unknown> };
	assert.equal(notesSchema.properties?.cursor, undefined);
	assert.ok(notesSchema.properties?.limit);
	const notesSearchSchema = captured.tools.get("notes_search")?.parameters as { properties?: Record<string, unknown> };
	assert.equal(notesSearchSchema.properties?.cursor, undefined);
	assert.ok(notesSearchSchema.properties?.limit);
});

test("every history operation declares a result schema its own payload satisfies", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "hello");
	toolCall(session, "call-1", "bash", { command: "pwd" });
	toolResult(session, "call-1", "bash", "/tmp");

	for (const toolName of ["history_windows", "history_list", "history_read"]) {
		const operation = { history_windows: historyWindows, history_list: historyList, history_read: historyRead }[toolName]!;
		const result = await call(captured, toolName, toolName === "history_read" ? { seq: 1 } : toolName === "history_list" ? { query: "hello" } : {}, ctx);
		const structured = result.structuredContent;
		assert.ok(structured !== undefined, `${toolName} carries a structured outcome`);
		assert.equal(Check(operation.outputSchema, structured), true, `${toolName} payload satisfies its own outputSchema`);
		assertWithinBudget(result, `${toolName} page`);
	}
	const conversation = await call(captured, "history_list", {}, ctx);
	assert.equal(Check(historyList.outputSchema, conversation.structuredContent), true);
	const refusal = await call(captured, "history_read", { seq: 999 }, ctx);
	assert.equal(Check(historyRead.outputSchema, refusal.structuredContent), true, "a refusal satisfies the same result schema");
});

test("seq is stable across branch changes, abandoned entries stay unreadable, and a paired result seq is refused precisely", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const firstId = appendText(session, "user", "first");
	const abandonedId = appendText(session, "assistant", "abandoned reply");
	const before = page(await call(captured, "history_list", { roles: ["user", "assistant"] }, ctx));
	assert.deepEqual(before.items.map((item) => [item.seq, item.content]), [[1, "first"], [2, "abandoned reply"]]);

	session.branch(firstId);
	const branchId = appendText(session, "user", "new branch");
	const after = page(await call(captured, "history_list", { roles: ["user", "assistant"] }, ctx));
	assert.deepEqual(after.items.map((item) => [item.seq, item.content]), [[1, "first"], [3, "new branch"]]);
	assert.equal(branchId !== abandonedId, true);

	const offBranch = resultError(await call(captured, "history_read", { seq: 2 }, ctx));
	assert.equal(offBranch.code, "not_on_branch");
	assert.match(offBranch.message, /another branch/);
	assert.equal(JSON.stringify(offBranch).includes("abandoned"), false, "the refusal does not leak the abandoned entry's text");

	const unknown = resultError(await call(captured, "history_read", { seq: 4 }, ctx));
	assert.equal(unknown.code, "unknown_seq");
	assert.match(unknown.message, /run 1\.\.3/);
});

test("a result address consumed by a pairing names its call instead of serving a second read", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	toolCall(session, "paired", "edit", { path: "a.md" });
	toolResult(session, "paired", "edit", "edited");
	// The assistant message takes seq 1 and its tool call seq 2; the result at seq 3 is absorbed.
	assert.deepEqual(seqs(await call(captured, "history_list", { roles: ["tool"] }, ctx)), [2], "the pairing is one event at the call's address");

	const consumed = resultError(await call(captured, "history_read", { seq: 3 }, ctx));
	assert.equal(consumed.code, "not_an_event");
	assert.match(consumed.message, /already shown inside the call at seq 2/);

	const callSeq = resultRead<{ seq: number; window_id: string }>(await call(captured, "history_read", { seq: 2 }, ctx));
	assert.equal(callSeq.seq, 2);
	assert.equal(callSeq.content, 'edit {"path":"a.md"}\n--- output ---\nedited');
});

test("history_list pages from the end `from` names and returns bounded ranges", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let index = 1; index <= 5; index++) appendText(session, "user", `message-${index}`);

	assert.deepEqual(seqs(await call(captured, "history_list", { limit: 2 }, ctx)), [4, 5], "the default newest page is the highest seqs, ascending");
	assert.deepEqual(seqs(await call(captured, "history_list", { limit: 2, from: "oldest" }, ctx)), [1, 2], "from oldest takes the other end of the same selection");
	appendText(session, "user", "message-6");
	const older = page(await call(captured, "history_list", { before_seq: 5, limit: 2 }, ctx));
	assert.deepEqual(older.items.map((item) => item.seq), [3, 4]);
	assert.deepEqual(older.page_older, { before_seq: 3 });
	assert.equal(older.page_newer, null);
	assert.deepEqual(seqs(await call(captured, "history_list", { after_seq: 5, limit: 2, from: "oldest" }, ctx)), [6]);
	for (let index = 7; index <= 10; index++) appendText(session, "user", `message-${index}`);
	const range = page(await call(captured, "history_list", { after_seq: 2, before_seq: 10, limit: 3, from: "oldest" }, ctx));
	assert.deepEqual(range.items.map((item) => item.seq), [3, 4, 5]);
	assert.equal(range.page_older, null);
	assert.deepEqual(range.page_newer, { after_seq: 5, from: "oldest" }, "both bounds do not imply a direction; the cursor carries one");
	assert.match(rendered(await call(captured, "history_list", { after_seq: 2, before_seq: 10, limit: 3, from: "oldest" }, ctx)), /→ newer: \{"after_seq":5,"from":"oldest"\}/, "the footer prints the exact call to page newer");
	assert.deepEqual(seqs(await call(captured, "history_list", { after_seq: 2, before_seq: 10, limit: 3 }, ctx)), [7, 8, 9], "the same range with the default from starts from the newest end");
	const rangeNext = page(await call(captured, "history_list", { ...range.page_newer!, before_seq: 10, limit: 3 }, ctx));
	assert.deepEqual(rangeNext.items.map((item) => item.seq), [6, 7, 8]);
	const rangeLast = page(await call(captured, "history_list", { ...rangeNext.page_newer!, before_seq: 10, limit: 3 }, ctx));
	assert.deepEqual(rangeLast.items.map((item) => item.seq), [9]);
	assert.equal(rangeLast.page_older, null);
	assert.equal(rangeLast.page_newer, null);
	assert.equal("has_older" in rangeLast, false);
	assert.equal("has_newer" in rangeLast, false);
});

test("a one-row page budget admits the newest candidate first", () => {
	const windowId = "w1";
	const items: DecodedHistoryItem[] = [1, 2, 3].map((seq) => ({ seq, windowId, role: "user", text: `message-${seq}`, createdAt: undefined }));
	const projection = projectHistory([{ windowId, items }], 12, new Set([1, 2, 3]));
	const keptSeqs = (fitsRows: number, from?: "newest" | "oldest"): number[] => {
		const outcome = selectPage(projection, { limit: 3, ...(from === undefined ? {} : { from }) }, (candidate: HistoryPage) => candidate.items.length <= fitsRows, 200);
		assert.equal(outcome.ok, true);
		return outcome.ok ? outcome.data.items.map((item) => ("folded" in item ? item.first_seq : item.seq)) : [];
	};
	assert.deepEqual(keptSeqs(1), [3], "a budget for one row admits the newest candidate, not the oldest");
	assert.deepEqual(keptSeqs(2), [2, 3], "a truncated prefix is the newest rows, delivered in chronological order");
	assert.deepEqual(keptSeqs(1, "oldest"), [1], "from oldest keeps the other end when the budget is short");
});

test("since and until select a half-open time range, compose with query and paging, and refuse bad bounds", async () => {
	const items: DecodedHistoryItem[] = [
		{ seq: 1, windowId: "w1", role: "user", text: "first needle", createdAt: "2026-10-10T00:00:00.000Z" },
		{ seq: 2, windowId: "w1", role: "assistant", text: "second", createdAt: "2026-10-10T06:00:00.000Z" },
		{ seq: 3, windowId: "w1", role: "user", text: "third needle", createdAt: "2026-10-10T12:00:00.000Z" },
		{ seq: 4, windowId: "w1", role: "assistant", text: "fourth", createdAt: "2026-10-10T18:00:00.000Z" },
		{ seq: 5, windowId: "w1", role: "user", text: "fifth needle", createdAt: undefined },
	];
	const projection = projectHistory([{ windowId: "w1", items }], 5, new Set([1, 2, 3, 4, 5]));
	const selected = async (params: Parameters<typeof historyList.execute>[0]): Promise<number[]> => {
		const outcome = await historyList.execute(params, projection);
		assert.equal(outcome.ok, true, JSON.stringify(outcome));
		return outcome.ok ? outcome.data.items.map((item) => ("folded" in item ? item.first_seq : item.seq)) : [];
	};

	assert.deepEqual(await selected({ roles: ["user", "assistant"], from: "oldest", since: "2026-10-10T06:00:00Z" }), [2, 3, 4], "since keeps later events and drops one with no time");
	assert.deepEqual(await selected({ roles: ["user", "assistant"], from: "oldest", until: "2026-10-10T12:00:00Z" }), [1, 2], "until is exclusive");
	assert.deepEqual(await selected({ roles: ["user", "assistant"], from: "oldest", since: "2026-10-10T06:00:00Z", until: "2026-10-10T18:00:00Z" }), [2, 3], "both bounds make a half-open range");
	assert.deepEqual(await selected({ query: "needle", from: "oldest", since: "2026-10-10T06:00:00Z" }), [3], "a query composes with the time range");
	assert.deepEqual(await selected({ roles: ["user", "assistant"], from: "oldest", since: "2026-10-10T00:00:00Z", until: "2026-10-10T18:00:00Z", after_seq: 1, before_seq: 4 }), [2, 3], "seq paging composes with the time range");
	assert.deepEqual(await selected({ roles: ["user", "assistant"], from: "oldest", since: "2026-10-10" }), [1, 2, 3, 4], "a date-only since is inclusive UTC midnight, not local midnight");
	assert.deepEqual(await selected({ roles: ["user", "assistant"], from: "oldest", until: "2026-10-10T12:00" }), [1, 2], "a time without an offset is UTC");

	const malformed = await historyList.execute({ since: "yesterday" }, projection);
	assert.equal(malformed.ok, false);
	if (!malformed.ok) {
		assert.equal(malformed.error.code, "invalid_time");
		assert.match(malformed.error.message, /"yesterday"/, "the refusal names the offending param and value");
	}
	const inverted = await historyList.execute({ since: "2026-10-11", until: "2026-10-10" }, projection);
	assert.equal(inverted.ok, false);
	if (!inverted.ok) assert.equal(inverted.error.code, "invalid_time");
});

test("time bounds also keep untimed events out of the folded conversation view", async () => {
	const items: DecodedHistoryItem[] = [
		{ seq: 1, windowId: "w1", role: "user", text: "before", createdAt: "2026-10-10T00:00:00.000Z" },
		{ seq: 2, windowId: "w1", role: "tool", text: "output", createdAt: undefined },
		{ seq: 3, windowId: "w1", role: "user", text: "after", createdAt: "2026-10-10T12:00:00.000Z" },
	];
	const projection = projectHistory([{ windowId: "w1", items }], 3, new Set([1, 2, 3]));
	const bounded = await historyList.execute({ since: "2026-10-10T00:00:00Z" }, projection);
	assert.equal(bounded.ok, true);
	if (bounded.ok) assert.deepEqual(bounded.data.items.map((item) => ("folded" in item ? `folded ${item.count}` : `seq ${item.seq}`)), ["seq 1", "seq 3"], "an untimed tool event is not folded into a bounded selection");
	const unbounded = await historyList.execute({}, projection);
	assert.equal(unbounded.ok, true);
	if (unbounded.ok) assert.equal(unbounded.data.items.some((item) => "folded" in item), true, "without bounds the untimed run still folds");
});

test("conversation view folds tools and injected messages, while explicit roles expand them", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "please inspect");
	const turnId = append(session, {
		role: "assistant",
		content: [
			{ type: "text", text: "I will inspect" },
			{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "pwd" } },
			{ type: "toolCall", id: "tc-2", name: "read", arguments: { path: "README.md" } },
		],
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	toolResult(session, "tc-1", "bash", "ok");
	toolResult(session, "tc-2", "read", "contents");
	session.appendCustomMessageEntry("square", "injected event", false);
	append(session, { role: "assistant", content: [], stopReason: "toolUse", timestamp: Date.now() });

	const conversation = page(await call(captured, "history_list", {}, ctx));
	const legacyItemKey = ["item", "id"].join("_");
	assert.equal(conversation.items.some((item) => item.folded === true), true);
	assert.equal(conversation.items.some((item) => item.role === "developer"), false);
	assert.equal(conversation.items.some((item) => item.role === "tool"), false);
	assert.equal(conversation.items.some((item) => item.role === "assistant" && item.content === ""), false);
	assert.equal(conversation.items.every((item) => legacyItemKey in item === false), true);
	const folded = conversation.items.find((item) => item.folded === true)!;
	assert.equal(folded.count, 3, "two tool events and one injected context are folded, not the empty assistant message");
	assert.deepEqual(folded.tools, { bash: 1, read: 1 });
	assert.equal("custom_types" in folded, false);

	const empty = page(await call(captured, "history_list", { roles: ["context"], before_seq: 2 }, ctx));
	assert.deepEqual(empty.items, []);
	const hiddenOnly = page(await call(captured, "history_list", { after_seq: 2, before_seq: 6 }, ctx));
	assert.deepEqual(hiddenOnly.items, [{ folded: true, first_seq: 3, last_seq: 4, count: 2, tools: { bash: 1, read: 1 } }]);

	const expanded = page(await call(captured, "history_list", { roles: ["tool"] }, ctx));
	assert.deepEqual(expanded.items.map((item) => [item.seq, item.role, item.tool, item.tool_status]), [[3, "tool", "bash", "ok"], [4, "tool", "read", "ok"]]);
	assert.equal(expanded.items[0]!.content, 'bash {"command":"pwd"}\n--- output ---\nok');
	assert.equal(expanded.items[1]!.content, 'read {"path":"README.md"}\n--- output ---\ncontents');
	assert.equal(expanded.items.every((item) => !("call_seq" in item || "result_seq" in item || "tool_name" in item)), true);

	assert.deepEqual(seqs(await call(captured, "history_list", { query: "bash", roles: ["tool"] }, ctx)), [3]);
	const injected = page(await call(captured, "history_list", { roles: ["context"] }, ctx));
	assert.deepEqual(injected.items.map((item) => [item.role, item.content]), [["context", "injected event"]]);
	assert.equal(turnId.length > 0, true);
});

test("tool summaries and documents preserve pending, errored, and orphan runs", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	append(session, { role: "assistant", content: [{ type: "toolCall", id: "paired", name: "edit", arguments: { path: "😀.md", oldText: "before" } }], stopReason: "toolUse", timestamp: Date.now() });
	toolResult(session, "paired", "edit", "replacement OK", { isError: true });
	append(session, { role: "assistant", content: [{ type: "toolCall", id: "pending", name: "edit", arguments: { path: "pending.md" } }], stopReason: "toolUse", timestamp: Date.now() });
	toolResult(session, "orphan", "edit", "orphan output", {
		nestedCalls: { complete: true, calls: [{ id: "orphan/1", name: "read", arguments: { path: "orphan-nested.md" }, status: "ok" }] },
	});

	const events = page(await call(captured, "history_list", { roles: ["tool"] }, ctx));
	// The orphan result ran and succeeded; nothing about its missing call changes that. Only the
	// pending call, which no result ended, is unfinished.
	assert.deepEqual(events.items.map((item) => [item.seq, item.tool_status]), [[2, "error"], [5, "unfinished"], [6, "ok"]]);
	assert.equal(events.items[0]!.content, 'edit {"path":"😀.md","oldText":"before"}\n--- output ---\nreplacement OK');
	assert.equal(events.items[1]!.content, 'edit {"path":"pending.md"}', "an unfinished call claims no output");
	assert.equal(events.items[2]!.content, 'edit (arguments not recorded)\n--- output ---\norphan output\n--- nested calls (complete, 1 recorded) ---\n- orphan/1 read [ok] {"path":"orphan-nested.md"}', "an orphan result invents no arguments, and keeps the nested evidence the host recorded");

	const errored = resultRead<{ tool: string; tool_status: string }>(await call(captured, "history_read", { seq: 2 }, ctx));
	assert.equal(errored.tool, "edit");
	assert.equal(errored.tool_status, "error");
	assert.equal(errored.text, events.items[0]!.content);
	assert.equal("execution" in errored, false, "arguments are delivered once, in the document");

	const pending = resultRead<{ tool_status: string }>(await call(captured, "history_read", { seq: 5 }, ctx));
	assert.equal(pending.tool_status, "unfinished");

	const orphan = resultRead<{ nested_calls: { call_count: number; complete: boolean } }>(await call(captured, "history_read", { seq: 6 }, ctx));
	assert.deepEqual(orphan.nested_calls, { call_count: 1, complete: true });
	assert.equal(orphan.text, events.items[2]!.content, "an orphan's nested evidence stays readable despite the missing call");

	assert.deepEqual(seqs(await call(captured, "history_list", { query: "edit", roles: ["tool"] }, ctx)), [2, 5, 6]);
	assert.deepEqual(seqs(await call(captured, "history_list", { query: "pending.md", roles: ["tool"] }, ctx)), [5]);
	assert.deepEqual(seqs(await call(captured, "history_list", { query: "orphan output", roles: ["tool"] }, ctx)), [6]);
	assert.deepEqual(seqs(await call(captured, "history_list", { query: "orphan-nested.md", roles: ["tool"] }, ctx)), [6], "nested evidence stays findable even when the call it belongs to was never recorded");
});

test("native nested-call records are searchable, readable, and never gain a result or an address", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	toolCall(session, "codemode", "codemode", { script: "run()" });
	toolResult(session, "codemode", "codemode", "script finished", {
		nestedCalls: {
			complete: false,
			calls: [
				{ id: "codemode/1", name: "read", arguments: { path: "nested-needle.md" }, status: "ok", durationMs: 12 },
				{ id: "codemode/2", name: "bash", status: "error", durationMs: 4, error: "exit 1" },
				{ id: "codemode/3", name: "spawn", status: "unfinished" },
			],
		},
	});

	const found = page(await call(captured, "history_list", { query: "nested-needle" }, ctx));
	assert.deepEqual(found.items.map((item) => item.seq), [2], "nested arguments are part of the searchable document");

	const read = resultRead<{ nested_calls: { call_count: number; complete: boolean } }>(await call(captured, "history_read", { seq: 2 }, ctx));
	assert.deepEqual(read.nested_calls, { call_count: 3, complete: false }, "the host's completeness flag stays unchanged");
	assert.equal(read.text, 'codemode {"script":"run()"}\n--- output ---\nscript finished\n--- nested calls (incomplete, 3 recorded) ---\n- codemode/1 read [ok] 12ms {"path":"nested-needle.md"}\n- codemode/2 bash [error] 4ms error: exit 1 (arguments not recorded)\n- codemode/3 spawn [unfinished] (arguments not recorded)');
	assert.equal(read.next_offset_chars, null);
	assert.equal("execution" in read, false, "nested records are not duplicated outside the document");
	const rendered = read.content;
	for (const [needle, offset] of [["nested-needle.md", earliestMatchOffsetChars(read.content, ["nested-needle.md"])], ["exit 1", earliestMatchOffsetChars(read.content, ["exit 1"])], ["unfinished", earliestMatchOffsetChars(read.content, ["unfinished"])]] as const) {
		assert.ok(offset >= 0 && rendered.slice(offset).startsWith(needle), `nested evidence "${needle}" is readable in the document`);
	}
});

test("absent nested calls mean unavailable, not a known-empty record", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	toolCall(session, "plain", "read", { path: "a.md" });
	toolResult(session, "plain", "read", "contents");
	const listed = page(await call(captured, "history_list", { roles: ["tool"] }, ctx));
	assert.equal("nested_calls" in listed.items[0]!, false, "a page row never carries nested-call evidence; one read does");
	const read = resultRead(await call(captured, "history_read", { seq: 2 }, ctx));
	assert.equal("nested_calls" in read, false);
	assert.equal(read.content.includes("nested calls"), false);
});

test("oversized arguments and long nested records remain fully pageable and searchable", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const huge = "x".repeat(TOOL_OUTPUT_MAX_BYTES * 2);
	toolCall(session, "big", "write", { path: "big.md", content: huge });
	toolResult(session, "big", "write", "written", {
		nestedCalls: {
			complete: true,
			calls: Array.from({ length: 400 }, (_, index) => ({ id: `big/${index}`, name: "read", arguments: { path: `p${index}.md` }, status: "ok" as const, durationMs: 1 })),
		},
	});

	let read = resultRead<{ nested_calls: { call_count: number; complete: boolean } }>(await call(captured, "history_read", { seq: 2, max_chars: 50_000 }, ctx));
	assert.deepEqual(read.nested_calls, { call_count: 400, complete: true }, "the read counts every recorded call, not only the records one page can carry");
	let document = read.text;
	while (read.next_offset_chars !== null) {
		const next = read.next_offset_chars;
		const result = await call(captured, "history_read", { seq: 2, offset_chars: next, max_chars: 50_000 }, ctx);
		assertWithinBudget(result, "bounded document page");
		read = resultRead(result);
		assert.ok(read.text.length > 0, "every continuation makes progress");
		document += read.text;
	}
	const expectedCalls = Array.from({ length: 400 }, (_, index) => `- big/${index} read [ok] 1ms {"path":"p${index}.md"}`).join("\n");
	assert.equal(document, `write ${JSON.stringify({ path: "big.md", content: huge })}\n--- output ---\nwritten\n--- nested calls (complete, 400 recorded) ---\n${expectedCalls}`, "paging reconstructs all arguments and all recorded calls exactly");
	assertWithinBudget(await call(captured, "history_read", { seq: 2 }, ctx), "bounded first read");
	assertWithinBudget(await call(captured, "history_list", { roles: ["tool"] }, ctx), "bounded list row");

	const hit = page(await call(captured, "history_list", { query: "big.md", max_chars_per_item: 40 }, ctx));
	assert.deepEqual(hit.items.map((item) => item.seq), [2], "the document still carries the real arguments, so a query still finds them");
	const late = page(await call(captured, "history_list", { query: "p399.md" }, ctx)).items[0]!;
	assert.equal(late.seq, 2);
	const resumed = resultRead(await call(captured, "history_read", { seq: 2, offset_chars: late.offset_chars }, ctx));
	assert.ok(resumed.text.startsWith("p399.md"), "a query can jump directly to evidence beyond the first read");
});

test("standalone bash execution retains command, output, and truncation path", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	append(session, { role: "bashExecution", command: "echo needle", output: "needle output", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/tmp/bash-output.txt", timestamp: Date.now() });
	const raw = await call(captured, "history_list", { roles: ["tool"] }, ctx);
	const found = page(raw);
	assert.equal(found.items.length, 1);
	assert.deepEqual(found.items[0], {
		seq: 1,
		window_id: found.items[0]!.window_id,
		role: "tool",
		created_at: found.items[0]!.created_at,
		tool: "bash",
		tool_status: "ok",
		output_truncated: true,
		full_output_path: "/tmp/bash-output.txt",
		truncated: false,
		content: 'bash {"command":"echo needle"}\n--- output ---\nneedle output',
	});
	assert.match(rendered(raw), /output truncated, full text at \/tmp\/bash-output\.txt/, "a truncation with a path names both");
	const query = page(await call(captured, "history_list", { roles: ["tool"], query: "NEEDLE OUTPUT" }, ctx));
	assert.deepEqual(query.items.map((item) => item.seq), [1]);
	const read = resultRead<{ seq: number }>(await call(captured, "history_read", { seq: 1, offset_chars: query.items[0]!.offset_chars as number }, ctx));
	assert.equal(read.content, "needle output");
	assert.equal(read.seq, 1);
});

test("a truncated tool run without a recorded path still reports output_truncated", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	append(session, { role: "bashExecution", command: "echo big", output: "big output", exitCode: 0, cancelled: false, truncated: true, timestamp: Date.now() });
	const raw = await call(captured, "history_list", { roles: ["tool"] }, ctx);
	const found = page(raw);
	assert.equal(found.items.length, 1);
	const item = found.items[0]!;
	assert.equal(item.output_truncated, true, "the truncation is reported even with no path");
	assert.equal("full_output_path" in item, false, "no path is invented");
	assert.match(rendered(raw), /output truncated/, "the header still says the output was truncated");
	assert.equal(rendered(raw).includes("full text at"), false, "the header claims no path");
	const read = resultRead<{ output_truncated?: true; full_output_path?: string }>(await call(captured, "history_read", { seq: 1 }, ctx));
	assert.equal(read.output_truncated, true, "the read reports the same truncation");
	assert.equal("full_output_path" in read, false);
});

test("list renders paging and fold recipes, read renders a neighborhood call, and @previous resolves", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let i = 0; i < 30; i++) appendText(session, "user", `older window ${i}`);
	session.appendCustomEntry("notesoup/reset-marker", { windowId: "pcw:test:w2" });
	appendText(session, "user", "current window");

	const listed = await call(captured, "history_list", {}, ctx);
	assert.match(rendered(listed), /→ older: \{"before_seq":\d+\}/, "the footer prints the exact call to page older");

	const windows = resultData<{ windows: Array<{ window_id: string }> }>(await call(captured, "history_windows", {}, ctx));
	assert.equal(windows.windows.length, 2);
	const previous = page(await call(captured, "history_list", { window_id: "@previous" }, ctx));
	assert.ok(previous.items.length > 0 && previous.items.every((item) => item.window_id === windows.windows[0]!.window_id), "@previous names the window before the current one");
	const previousQuery = page(await call(captured, "history_list", { query: "older window", window_id: "@previous" }, ctx));
	assert.ok(previousQuery.items.length > 0, "a query resolves the alias too");

	toolCall(session, "t1", "bash", { command: "ls" });
	toolResult(session, "t1", "bash", "done");
	appendText(session, "user", "after tools");
	const folded = await call(captured, "history_list", {}, ctx);
	assert.match(rendered(folded), /→ expand: \{"after_seq":\d+,"before_seq":\d+,"from":"oldest","roles":\["tool","context"\]\}/, "a folded row prints its own expand recipe");

	appendText(session, "user", "needle read target");
	const hits = page(await call(captured, "history_list", { query: "needle read target" }, ctx));
	const read = await call(captured, "history_read", { seq: hits.items[0]!.seq }, ctx);
	assert.match(rendered(read), /neighborhood → `history_list`\(\{"after_seq":\d+,"before_seq":\d+\}\)/, "a read prints the call for surrounding events");

	const solo = manager();
	const soloCaptured = makeExtension(solo);
	appendText(solo, "user", "only window");
	const soloWindows = resultData<{ windows: Array<{ window_id: string }> }>(await call(soloCaptured, "history_windows", {}, context(solo)));
	const noPrevious = resultError(await call(soloCaptured, "history_list", { window_id: "@previous" }, context(solo)));
	assert.equal(noPrevious.code, "unknown_window_id");
	assert.match(noPrevious.message, /@previous/);
	assert.match(noPrevious.message, new RegExp(`; known: ${soloWindows.windows[0]!.window_id}$`), "the refusal names the window the session does have");
});

test("compaction summary becomes context and is folded in the default list", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "before checkpoint");
	session.appendCompaction("summary needle", session.getLeafId()!, 100);
	appendText(session, "assistant", "after checkpoint");
	const regular = page(await call(captured, "history_list", {}, ctx));
	assert.deepEqual(regular.items.map((item) => item.folded ? "folded" : item.role), ["user", "folded", "assistant"]);
	const folded = regular.items[1]!;
	assert.equal(folded.count, 1);
	assert.deepEqual(folded.tools, {});
	const contextItems = page(await call(captured, "history_list", { roles: ["context"] }, ctx));
	assert.deepEqual(contextItems.items.map((item) => [item.role, item.content]), [["context", "summary needle"]]);
});

test("a query covers every role, carries match offsets and refuses an empty literal", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "visible needle");
	session.appendCustomMessageEntry("notesoup/boot", "developer needle", false);
	appendText(session, "assistant", "assistant needle");
	const all = page(await call(captured, "history_list", { query: "needle" }, ctx));
	assert.deepEqual(all.items.map((item) => item.role), ["user", "context", "assistant"]);
	assert.ok(all.items.every((item) => typeof item.seq === "number" && typeof item.offset_chars === "number"));
	const developers = page(await call(captured, "history_list", { query: "needle", roles: ["context"] }, ctx));
	assert.deepEqual(developers.items.map((item) => item.role), ["context"]);
	assert.equal("custom_type" in developers.items[0]!, false);
	const first = page(await call(captured, "history_list", { query: "needle", after_seq: 1, limit: 1, from: "oldest" }, ctx));
	assert.deepEqual(first.items.map((item) => item.seq), [2]);
	assert.deepEqual(first.page_newer, { after_seq: 2, from: "oldest" });
	const next = page(await call(captured, "history_list", { query: "needle", ...first.page_newer!, limit: 2 }, ctx));
	assert.deepEqual(next.items.map((item) => item.seq), [3]);
	const absent = await call(captured, "history_list", { query: "absent" }, ctx);
	assert.deepEqual(page(absent).items, []);
	assert.equal(rendered(absent), "no events match this selection", "an empty page says so instead of rendering nothing");
	assert.deepEqual(resultError(await call(captured, "history_list", { query: "" }, ctx)).code, "invalid_query");
});

test("page_older and page_newer round-trip a session with no duplicates and no gaps", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	for (let seq = 1; seq <= 10; seq++) appendText(session, "user", `needle ${seq}`);

	const forward: number[] = [];
	let current = page(await call(captured, "history_list", { query: "needle", from: "oldest", limit: 3 }, ctx));
	assert.deepEqual(current.items.map((item) => item.seq), [1, 2, 3]);
	assert.equal(current.page_older, null, "the first page in `from` oldest has nothing older");
	assert.deepEqual(current.page_newer, { after_seq: 3, from: "oldest" });
	forward.push(...current.items.map((item) => item.seq as number));
	while (current.page_newer !== null) {
		const cursor = current.page_newer;
		current = page(await call(captured, "history_list", { query: "needle", ...cursor, limit: 3 }, ctx));
		forward.push(...current.items.map((item) => item.seq as number));
	}
	assert.deepEqual(forward, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "page_newer visits every event exactly once, in order");

	const backward: number[] = [];
	current = page(await call(captured, "history_list", { query: "needle", limit: 3 }, ctx));
	assert.deepEqual(current.items.map((item) => item.seq), [8, 9, 10]);
	assert.deepEqual(current.page_older, { before_seq: 8 });
	backward.push(...current.items.map((item) => item.seq as number));
	while (current.page_older !== null) {
		const cursor = current.page_older;
		current = page(await call(captured, "history_list", { query: "needle", ...cursor, limit: 3 }, ctx));
		backward.push(...current.items.map((item) => item.seq as number));
	}
	assert.deepEqual(backward, [8, 9, 10, 5, 6, 7, 2, 3, 4, 1], "page_older walks back with no duplicates and no gaps");
	assert.equal(current.page_older, null);
});

test("query previews start at case-insensitive literal matches and offsets read the same Unicode document", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const prefix = "😀İ".repeat(1000);
	appendText(session, "user", prefix + "NeEdLe.* trailing");
	const found = page(await call(captured, "history_list", { query: ["absent", "needle.*"], max_chars_per_item: 8 }, ctx));
	assert.equal(found.items.length, 1);
	const hit = found.items[0]!;
	assert.equal(hit.offset_chars, 2000);
	assert.equal("match_offset_chars" in hit, false);
	assert.equal(hit.content, "NeEdLe.*");
	assert.equal(hit.truncated, true);
	const read = resultRead<{ seq: number }>(await call(captured, "history_read", { seq: hit.seq as number, offset_chars: hit.offset_chars as number, max_chars: 8 }, ctx));
	assert.equal(read.content, hit.content);
	const listed = page(await call(captured, "history_list", { max_chars_per_item: 8 }, ctx));
	assert.equal(listed.items.length, 1);
	assert.equal("offset_chars" in listed.items[0]!, false, "a list preview reports no match offset");
	const atStart = page(await call(captured, "history_list", { query: "😀", max_chars_per_item: 4 }, ctx));
	const zero = atStart.items[0]!;
	assert.equal(zero.offset_chars, 0, "a match at the document start reports an explicit zero offset");
	assert.equal(zero.content, "😀İ😀İ", "an explicit zero offset still previews from the document start");
	assert.equal(zero.truncated, true);
	assert.deepEqual(page(await call(captured, "history_list", { query: "needle.+" }, ctx)).items, []);
});

test("history_read paginates one document with an accurate limit and a bounded byte cap", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	const content = "z".repeat(TOOL_OUTPUT_MAX_BYTES * 2);
	appendText(session, "user", content);
	const seq = seqs(await call(captured, "history_list", { max_chars_per_item: 1 }, ctx))[0]!;

	// 50k requested chars of 64 KiB of text exceeds the byte cap, so the delivered slice stops short
	// of the request rather than at it.
	const full = await call(captured, "history_read", { seq, max_chars: 50_000 }, ctx);
	assertWithinBudget(full, "history_read page");
	const read = resultRead<{ seq: number; window_id: string }>(full);
	assert.equal(read.seq, seq);
	assert.ok(read.window_id.length > 0);
	assert.equal(read.total_chars, content.length);
	assert.equal(read.content, content.slice(0, read.content.length), "the delivered slice is a verbatim prefix");
	assert.equal(read.next_offset_chars !== null, true);
	const text = full.content[0]!;
	assert.equal(text.type === "text" && text.text.includes("READ WINDOW"), false, "no READ WINDOW block survives");
	assert.match(text.type === "text" ? text.text : "", /\[truncated; continue at offset_chars=\d+\]$/, "a byte-capped window states where to continue");

	const next = resultRead(await call(captured, "history_read", { seq, offset_chars: read.next_offset_chars!, max_chars: 50_000 }, ctx));
	assert.equal(read.content + next.content, content.slice(0, read.content.length + next.content.length));
	assert.equal(Array.from(read.content).length, read.next_offset_chars, "the cursor addresses the first undelivered character");

	const limited = resultRead(await call(captured, "history_read", { seq, max_chars: 10 }, ctx));
	assert.equal(limited.content, "z".repeat(10));
	const limitedText = (await call(captured, "history_read", { seq, max_chars: 10 }, ctx)).content[0]!;
	const limitedSuffix = "\n\n[truncated; continue at offset_chars=10]";
	assert.equal(limitedText.type === "text" && limitedText.text.endsWith(limitedSuffix), true, "a count-limited window states where to resume");

	const tail = resultRead(await call(captured, "history_read", { seq, offset_chars: -10 }, ctx));
	assert.equal(tail.content, "z".repeat(10));
	assert.equal(tail.next_offset_chars, null, "the true end has no continuation");
	const past = resultError(await call(captured, "history_read", { seq, offset_chars: content.length + 1 }, ctx));
	assert.equal(past.code, "invalid_offset");
	assert.match(past.message, new RegExp(`${content.length} chars`), "the refusal names the real length");
});

test("history windows expose stable ranges and session identity", async () => {
	const session = manager();
	const captured = makeExtension(session);
	const ctx = context(session);
	appendText(session, "user", "before");
	const windows = resultData<{ session_id: string; windows: Array<{ window_id: string; first_seq: number | null; last_seq: number | null }> }>(await call(captured, "history_windows", {}, ctx));
	assert.equal(windows.session_id, session.getSessionId());
	assert.equal(windows.windows.length, 1);
	assert.deepEqual(windows.windows[0], { window_id: windows.windows[0]!.window_id, created_at: null, first_seq: 1, last_seq: 1 });
});

test("historyDocument is one deterministic projection of the facts, with no UI header or continuation suffix", async () => {
	const windowId = "w1";
	const items: DecodedHistoryItem[] = [
		{ seq: 2, windowId, role: "user", text: "hello", createdAt: undefined },
		{ seq: 5, windowId, role: "tool_call", text: "", toolName: "read", toolCallId: "call", createdAt: undefined, arguments: { path: "one" } },
		{ seq: 6, windowId, role: "tool", text: "😀 needle", toolName: "read", toolCallId: "call", createdAt: undefined },
		{ seq: 9, windowId, role: "assistant", text: "done", createdAt: undefined },
	];
	const projection = projectHistory([{ windowId, items }], 12, new Set([2, 5, 6, 9]));
	assert.deepEqual([...projection.pairedResults], [[6, 5]], "the pairing consumes the result address instead of aliasing it");
	assert.deepEqual(projection.windows[0]!.items.map((event) => event.seq), [2, 5, 9], "projection does not allocate or renumber native addresses");
	const tool = projection.windows[0]!.items[1]!;
	assert.equal(historyDocument(tool), 'read {"path":"one"}\n--- output ---\n😀 needle');
	assert.equal(historyDocument(projection.windows[0]!.items[0]!), "hello");
	assert.equal(historyDocument(tool).includes("READ WINDOW"), false);
	assert.equal(historyDocument(tool).includes("offset_chars"), false);
	assert.equal(historyDocument(tool).includes("seq "), false, "the document carries no UI identity block");

	const found = await historyList.execute({ query: "NEEDLE" }, projection);
	assert.equal(found.ok, true);
	if (found.ok) {
		const hit = found.data.items[0] as { seq: number; offset_chars?: number };
		assert.equal(hit.seq, 5);
		assert.equal(hit.offset_chars, earliestMatchOffsetChars('read {"path":"one"}\n--- output ---\n😀 needle', ["NEEDLE"]));
	}
	const consumed = await historyRead.execute({ seq: 6 }, projection);
	assert.equal(consumed.ok, false);
	if (!consumed.ok) assert.equal(consumed.error.code, "not_an_event");
	const offBranch = await historyRead.execute({ seq: 12 }, projection);
	assert.equal(offBranch.ok, false);
	if (!offBranch.ok) assert.match(offBranch.error.message, /another branch/);
	const unknown = await historyRead.execute({ seq: 13 }, projection);
	assert.equal(unknown.ok, false);
	if (!unknown.ok) assert.match(unknown.error.message, /unknown seq/);
	const listed = await historyList.execute({}, projection);
	assert.equal(listed.ok, true);
	if (listed.ok) assert.equal(listed.data.items.some((item) => "folded" in item && item.count === 1), true);
	const windows = await historyWindows.execute({}, projection, "session-x");
	assert.equal(windows.ok, true);
	if (windows.ok) assert.equal(windows.data.session_id, "session-x");
});