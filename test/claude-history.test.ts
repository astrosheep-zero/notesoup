import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeHistoryFromJsonl, readClaudeHistory } from "../plugins/claude/src/history.js";
import { renderBootBlock } from "../src/boot/render.js";
import { unavailableNotesSnapshot } from "../src/boot/snapshot.js";
import { DEFAULT_BOOT_TOOL_NAMES } from "../src/boot/text.js";
import { allItems, eventDocument } from "../src/history/history.js";
import { historyList, historyRead, historyWindows } from "../src/tools/history.js";
import { TOOL_OUTPUT_MAX_BYTES } from "../src/tools/output.js";
import { dispatch, type ClaudeToolResult } from "../plugins/claude/src/helper.js";

type Row = Record<string, unknown>;
const sessionId = "synthetic-session";
function row(uuid: string, parentUuid: string | null, type: string, content: unknown, extra: Row = {}): Row {
	return { uuid, parentUuid, type, sessionId, timestamp: "2026-01-01T00:00:00Z", isSidechain: false,
		...(type === "system" ? { content } : { message: { role: type, content } }), ...extra };
}
const user = (uuid: string, parent: string | null, text: string) => row(uuid, parent, "user", text);
const assistant = (uuid: string, parent: string, content: unknown) => row(uuid, parent, "assistant", content);
const call = (id: string, name = "bash") => ({ type: "tool_use", id, name, input: { command: `echo ${id}` } });
const result = (id: string, text: unknown, error = false) => ({ type: "tool_result", tool_use_id: id, content: text, is_error: error });
const jsonl = (rows: Row[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const project = (rows: Row[], headUuid: string) => claudeHistoryFromJsonl(jsonl(rows), { sessionId, headUuid });

// Complete boot shape, not a real/private transcript fixture. `context_window` is the pre-rename
// spelling that transcripts already on disk carry; both spellings must yield the same ordinal.
const bootText = (ordinal: number, spelling: "legacy" | "current" = "legacy") => spelling === "legacy"
	? `<context_window>\nAgent name: claude (brain: claude)\n\nclaude:${sessionId}\n</context_window>\n\n<context_window_protocol>\nSynthetic reset protocol\n</context_window_protocol>\nCurrent context window id: claude:${sessionId}:${ordinal}`
	: `<notesoup:window_identity>\nAgent name: claude (brain: claude)\n\nclaude:${sessionId}\n</notesoup:window_identity>\n\n<notesoup:notes_protocol>\nSynthetic reset protocol\n</notesoup:notes_protocol>\nCurrent context window id: claude:${sessionId}:${ordinal}`;
function compact(uuid: string, logical: string, metadata: Row = {}): Row {
	return row(uuid, null, "system", "Conversation compacted", { subtype: "compact_boundary", logicalParentUuid: logical, compactMetadata: metadata });
}

test("Claude append and result arrival preserve call addresses and use the shared paired read", async () => {
	const rows = [user("u", null, "run tools"), assistant("a", "u", [{ type: "thinking", thinking: "private thought" }, { type: "text", text: "working" }, call("one"), call("two")])];
	const pending = project(rows, "a");
	assert.equal(pending.highestSeq, 4);
	assert.equal(allItems(pending).find((event) => event.seq === 3)?.execution?.status, "unfinished");
	assert.doesNotMatch(allItems(pending).map(eventDocument).join("\n"), /private thought/);
	rows.push(row("r", "a", "user", [result("two", "failure", true), result("one", [{ type: "text", text: "output one" }, { type: "thinking", thinking: "hidden result thinking" }])]));
	const completed = project(rows, "r");
	assert.equal(completed.highestSeq, 7);
	const read = await historyRead.execute({ seq: 3 }, completed);
	assert.ok(read.ok);
	assert.equal(read.data.tool_status, "ok");
	assert.match(read.data.text, /bash \{"command":"echo one"\}\n--- output ---\noutput one/);
	assert.doesNotMatch(read.data.text, /hidden/);
	assert.equal(allItems(completed).find((event) => event.seq === 4)?.execution?.status, "error");
	const resultRead = await historyRead.execute({ seq: 7 }, completed);
	assert.ok(!resultRead.ok);
	assert.equal(resultRead.error.code, "not_an_event");
	assert.match(resultRead.error.message, /read seq 3/);
	const search = await historyList.execute({ query: "output one" }, completed);
	assert.ok(search.ok);
	assert.deepEqual(search.data.items.map((item) => "seq" in item ? item.seq : -1), [3]);
});

test("Claude dialogue paging skips tool/thinking envelopes without losing array text or changing addresses", async () => {
	const rows = [row("u", null, "user", [{ type: "text", text: "human question" }]),
		assistant("reply", "u", [{ type: "text", text: "assistant answer" }]),
		assistant("thinking", "reply", [{ type: "thinking", thinking: "private thought" }]),
		assistant("call", "thinking", [call("one")]), row("result", "call", "user", [result("one", "tool output")]),
		row("last", "result", "user", [{ type: "text", text: "human followup" }]),
		compact("boundary", "last"), row("boot", "boundary", "user", bootText(1))];
	const projection = project(rows, "boot");
	assert.equal(projection.highestSeq, 10);
	const listed = await historyList.execute({ window_id: "@previous", roles: ["user", "assistant"], limit: 3 }, projection);
	assert.ok(listed.ok);
	assert.deepEqual(listed.data.items.map((item) => "seq" in item ? [item.seq, item.content] : []), [[1, "human question"], [2, "assistant answer"], [8, "human followup"]]);
	const read = await historyRead.execute({ seq: 2 }, projection);
	assert.ok(read.ok);
	assert.equal(read.data.text, "assistant answer");
	const envelope = await historyRead.execute({ seq: 6 }, projection);
	assert.ok(envelope.ok);
	assert.equal(envelope.data.text, "", "a tool-result envelope has no dialogue text to invent");
	assert.match(historyRead.render(envelope), /No visible text recorded/);
	const tool = await historyRead.execute({ seq: 5 }, projection);
	assert.ok(tool.ok);
	assert.match(tool.data.text, /tool output/);
	assert.doesNotMatch(historyList.render(listed), /private thought|tool output/);
});

test("Claude file-history deltas do not become events or change history addresses", () => {
	const rows = [user("u", null, "hello"), assistant("a", "u", [{ type: "text", text: "reply" }])];
	const delta = { type: "file-history-delta", messageId: "u", snapshotMessageId: "u", trackingPath: "private-file.txt",
		backup: { backupFileName: "private-backup", version: 1, backupTime: "2026-01-01T00:00:00Z", realParentDir: "/private" }, timestamp: "2026-01-01T00:00:00Z" };
	const baseline = project(rows, "a");
	assert.deepEqual(project([delta, rows[0]!, delta, rows[1]!, delta], "a"), baseline);
	assert.equal(baseline.highestSeq, 2);
});

test("Claude skips unknown record types and treats required skipped UUIDs as gaps, not content", () => {
	const u = user("u", null, "hello"), a = assistant("a", "u", [{ type: "text", text: "reply" }]);
	const unknown = { type: "future-record", uuid: "future", parentUuid: "not-on-disk", content: "private metadata" };
	assert.deepEqual(project([unknown, u, unknown, a, unknown], "a"), project([u, a], "a"));
	const incomplete = project([u, unknown, { ...a, parentUuid: "future" }], "a");
	assert.deepEqual(incomplete.missingAncestors, ["future"]);
	assert.equal(incomplete.currentWindowOrdinal, undefined);
	assert.deepEqual(allItems(incomplete).map((event) => event.seq), [2]);
	assert.doesNotMatch(allItems(incomplete).map(eventDocument).join("\n"), /private metadata|hello/);
});

test("Claude duplicate UUID records do not allocate again or move addresses on reload", () => {
	const u = user("u", null, "hello"), a = assistant("a", "u", [call("one")]);
	const original = project([u, a], "a");
	const repeated = [u, a, { ...u, cwd: "/new/provenance" }, { ...a, cwd: "/new/provenance" }];
	const reloaded = project(repeated, "a");
	assert.equal(reloaded.highestSeq, original.highestSeq);
	assert.deepEqual(reloaded, original);
	assert.deepEqual(project(repeated, "a"), reloaded);
});

test("Claude branch selection is bound to committed head, not append order or last-prompt", async () => {
	const rows = [user("u", null, "root"), assistant("left", "u", [call("left-call")]), row("left-result", "left", "user", [result("left-call", "left output")]), assistant("right", "u", [{ type: "text", text: "right branch" }]), { type: "last-prompt", leafUuid: "right", sessionId }];
	const left = project(rows, "left-result"), right = project(rows, "right");
	assert.equal(left.highestSeq, right.highestSeq);
	assert.ok(!allItems(left).some((event) => event.text === "right branch"));
	assert.equal(left.pairedResults.get(5), 3);
	assert.deepEqual(allItems(right).map((event) => event.seq), [1, 6]);
	const offBranch = await historyRead.execute({ seq: 3 }, right);
	assert.ok(!offBranch.ok);
	assert.equal(offBranch.error.code, "not_on_branch");
	assert.throws(() => claudeHistoryFromJsonl(jsonl(rows), { sessionId }), /no confirmed active head/);
	assert.throws(() => project(rows, "not-written-yet"), /not persisted yet/);
});

test("a persisted boot yields its ordinal under both tag spellings", () => {
	// Three boundaries but one boot: only a recognised boot explains the ordinal.
	const rowsFor = (boot: string) => [user("u", null, "old request"), assistant("a", "u", [{ type: "text", text: "answered" }]), compact("boundary", "a"), row("boot", "boundary", "user", boot), user("after", "boot", "after reset")];
	const legacy = project(rowsFor(bootText(3)), "after");
	const current = project(rowsFor(bootText(3, "current")), "after");
	assert.equal(allItems(legacy).find((event) => event.text === "after reset")?.windowId, `claude:${sessionId}:3`, "an old-spelling boot numbers the window it opens");
	assert.deepEqual(current.windows.map((window) => window.windowId), legacy.windows.map((window) => window.windowId));
	const rendered = renderBootBlock({
		agentName: "claude",
		modelName: "claude",
		tree: { trunk: `claude:${sessionId}`, windows: [{ shortName: "3", isCurrent: true }] },
		notes: unavailableNotesSnapshot(Date.now()),
		tools: DEFAULT_BOOT_TOOL_NAMES,
	});
	const real = project(rowsFor(`${rendered}\nCurrent context window id: claude:${sessionId}:3`), "after");
	assert.deepEqual(real.windows.map((window) => window.windowId), current.windows.map((window) => window.windowId));
	const partial = `<notesoup:window_identity>\nAgent name: claude (brain: claude)\n\nclaude:${sessionId}\n</notesoup:window_identity>\nCurrent context window id: claude:${sessionId}:3`;
	assert.equal(allItems(project(rowsFor(partial), "after")).find((event) => event.text === "after reset")?.windowId, `claude:${sessionId}:1`, "an identity line without the protocol block is not a trusted boot");
});

test("Claude forked transcripts retain copied boot ordinals but use the new session's window ids", () => {
	const rows = [user("u", null, "old request"), compact("boundary", "u"), row("boot", "boundary", "user", bootText(3)), user("after", "boot", "after fork")];
	const forkId = "forked-session";
	const projection = claudeHistoryFromJsonl(jsonl(rows.map((row) => ({ ...row, sessionId: forkId }))), { sessionId: forkId, headUuid: "after" });
	assert.equal(allItems(projection).find((event) => event.text === "after fork")?.windowId, `claude:${forkId}:3`);
	assert.ok(projection.windows.every((window) => window.windowId.startsWith(`claude:${forkId}:`)));
});

test("Claude native compaction and reset keep pre-reset history, preserved rewrites and matching boot windows", async () => {
	const old = assistant("old", "u", [{ type: "text", text: "before first reset" }]);
	const reset = row("boot", "boundary", "user", bootText(1));
	const rows = [user("u", null, "old request"), old,
		compact("boundary", "old", { preservedSegment: { headUuid: "old", tailUuid: "old", anchorUuid: "boot" }, preservedMessages: { allUuids: ["old", "virtual-unpersisted-attachment"] } }), reset,
		{ ...old, parentUuid: "boot" }, assistant("new", "old", [{ type: "text", text: "after first reset" }]),
		compact("second", "new"), row("boot2", "second", "user", bootText(2)), user("latest", "boot2", "after second reset")];
	const projection = project(rows, "latest");
	assert.deepEqual(projection.windows.map((window) => window.windowId), [0, 1, 2].map((ordinal) => `claude:${sessionId}:${ordinal}`));
	assert.equal(allItems(projection).filter((event) => event.text === "before first reset").length, 1);
	assert.equal(allItems(projection).find((event) => event.text === "before first reset")?.windowId, `claude:${sessionId}:0`);
	assert.equal(allItems(projection).find((event) => event.text === "after first reset")?.windowId, `claude:${sessionId}:1`);
	assert.equal(projection.highestSeq, 8);
	const previous = await historyList.execute({ window_id: "@previous", roles: ["assistant"] }, projection);
	assert.ok(previous.ok);
	assert.deepEqual(previous.data.items.map((item) => "content" in item ? item.content : ""), ["after first reset"]);
	const windows = await historyWindows.execute({}, projection, sessionId);
	assert.ok(windows.ok);
	assert.equal(windows.data.windows[0]?.first_seq, 1);
	assert.deepEqual(project(rows, "latest"), projection, "reload does not need an in-memory seq cache");
});

test("Claude reset crosses native turn_duration graph metadata with no message content", async () => {
	const duration = { type: "system", subtype: "turn_duration", uuid: "duration", parentUuid: "old", sessionId, durationMs: 123, messageCount: 2 };
	const rows = [user("u", null, "marker before reset"), assistant("old", "u", [{ type: "text", text: "finished turn" }]), duration,
		compact("boundary", "duration"), row("boot", "boundary", "user", bootText(1)), user("continuation", "boot", "continue")];
	const projection = project(rows, "continuation");
	assert.equal(projection.highestSeq, 5, "duration metadata does not allocate a message address");
	assert.equal(projection.windows.length, 2);
	assert.ok(allItems(projection).some((event) => event.text === "marker before reset"));
	assert.ok((await historyList.execute({ window_id: "@previous" }, projection)).ok);
	assert.ok((await historyRead.execute({ seq: 2 }, projection)).ok);
	assert.ok((await historyWindows.execute({}, projection, sessionId)).ok);
});

test("Claude api_error retry metadata keeps compact ancestry without allocating seq or exposing internals", async () => {
	const retry = { type: "system", subtype: "api_error", uuid: "retry", parentUuid: "old", sessionId, isSidechain: false,
		level: "error", error: { message: "Connection error.", formatted: "Connection dropped (ECONNRESET)",
			connection: { code: "ECONNRESET", message: "PRIVATE_RETRY_PAYLOAD", isSSLError: false }, isNetworkDown: false, rateLimits: null, noResponse: null },
		retryInMs: 620, retryAttempt: 1, maxRetries: 10, source: "request_retry", timestamp: "2026-10-22T03:20:21.859Z", version: "2.1.295" };
	const prefix = [user("u", null, "before retry"), assistant("old", "u", "finished turn")];
	const rows = [...prefix, retry, compact("boundary", "retry"), row("boot", "boundary", "user", bootText(1)), user("after", "boot", "after reset")];
	const projection = project(rows, "after");
	assert.deepEqual(projection.missingAncestors, []);
	assert.equal(projection.highestSeq, 5, "retry metadata allocates no message or seq");
	assert.equal(projection.windows.length, 2);
	assert.equal(projection.currentWindowOrdinal, 1);
	assert.deepEqual(project([...prefix, { ...rows[3]!, logicalParentUuid: "old" }, ...rows.slice(4)], "after"), projection, "metadata leaves all addresses and windows unchanged");
	assert.doesNotMatch(allItems(projection).map(eventDocument).join("\n"), /PRIVATE_RETRY_PAYLOAD|ECONNRESET|request_retry/);
	assert.ok((await historyList.execute({}, projection)).ok);
	const previous = await historyList.execute({ window_id: "@previous" }, projection);
	assert.ok(previous.ok);
	assert.match(JSON.stringify(previous), /before retry|finished turn/);
	assert.ok((await historyRead.execute({ seq: 2 }, projection)).ok);
	assert.ok((await historyWindows.execute({}, projection, sessionId)).ok);
	assert.deepEqual(project(rows, "after"), projection, "reload preserves seq");
	assert.deepEqual(project([...prefix, { ...retry, subtype: "future_metadata" }, ...rows.slice(3)], "after"), projection, "metadata does not depend on a subtype whitelist");
	const withBody = project([...prefix, { ...retry, content: "visible system notice" }], "retry");
	assert.match(allItems(withBody).map(eventDocument).join("\n"), /visible system notice/, "a body is read regardless of subtype");
	assert.throws(() => project([...prefix, row("broken", "old", "system", { invalid: true })], "broken"), /invalid Claude transcript message content/);
});

test("Claude resolves forward persisted ancestry without renumbering or using later rewritten parent versions", () => {
	const notice = row("notice", "attachment", "system", "hook notice");
	const attachment = { type: "attachment", uuid: "attachment", parentUuid: "u", sessionId };
	const rows = [user("u", null, "root"), notice, attachment, compact("boundary", "notice"),
		row("boot", "boundary", "user", bootText(1), { isCompactSummary: true }), { ...attachment, parentUuid: "boot" }, user("new", "attachment", "after reset")];
	const projection = project(rows, "new");
	assert.equal(projection.highestSeq, 6);
	assert.equal(allItems(projection).find((event) => event.text === "hook notice")?.seq, 2);
	assert.equal(allItems(projection).find((event) => event.text === "hook notice")?.windowId, `claude:${sessionId}:0`);
	assert.equal(allItems(projection).find((event) => event.text === "after reset")?.windowId, `claude:${sessionId}:1`);
	assert.deepEqual(project(rows, "new"), projection);
	assert.deepEqual(project([notice], "notice").missingAncestors, ["attachment"]);
	assert.equal(project([user("u", null, bootText(9))], "u").windows.length, 1, "ordinary user text is not a trusted retained boot");
});

test("Claude attachments expose recorded renderings only and keep non-rendered nodes in ancestry", () => {
	const rows = [user("u", null, "hi"), { type: "attachment", uuid: "raw", parentUuid: "u", sessionId, attachment: { type: "prompt_snapshot", content: "must not invent raw payload" } },
		{ type: "attachment", uuid: "rendered", parentUuid: "raw", sessionId, renderedRole: "user", rendered: [{ content: [{ type: "text", text: "visible injection" }] }] }];
	const projection = project(rows, "rendered");
	assert.deepEqual(allItems(projection).map((event) => event.seq), [1, 2, 3]);
	assert.equal(allItems(projection).at(-1)?.role, "context");
	assert.match(allItems(projection).map(eventDocument).join("\n"), /visible injection/);
	assert.doesNotMatch(allItems(projection).map(eventDocument).join("\n"), /must not invent/);
});

test("Claude tolerates only the uncommitted JSONL tail, not malformed committed lines or unknown message shapes", () => {
	const text = jsonl([user("u", null, "first")]);
	assert.deepEqual(claudeHistoryFromJsonl(`${text}{\"type\":\"user\"`, { sessionId, headUuid: "u" }), project([user("u", null, "first")], "u"));
	assert.equal(claudeHistoryFromJsonl(text.trimEnd(), { sessionId, headUuid: "u" }).highestSeq, 1);
	assert.throws(() => claudeHistoryFromJsonl(`${text}{broken}\n`, { sessionId, headUuid: "u" }), /malformed.*line 2/);
	assert.throws(() => project([row("u", null, "user", [{ type: "new-block-schema" }])], "u"), /unsupported.*content block/);
	assert.throws(() => project([row("u", null, "user", { type: "text", text: "not an array" })], "u"), /message content/);
	assert.throws(() => project([user("u", null, "first"), user("u", null, "conflict")], "u"), /conflicting.*duplicate UUID/);
	assert.throws(() => project([{ ...user("u", null, "first"), isSidechain: true }], "u"), /only the main/);
	assert.throws(() => project([user("u", "a", "cycle"), assistant("a", "u", "cycle")], "a"), /cyclic Claude transcript ancestry/);
	assert.throws(() => project([user("u", "missing", "gap"), assistant("a", "a", "cycle")], "a"), /cyclic Claude transcript ancestry/);
	assert.throws(() => project([{ ...user("u", null, "first"), sessionId: "another-session" }], "u"), /different session/);
});

test("Claude gaps retain only confirmed suffixes, keep pairing/seqs, and disappear when the ancestor is appended", async () => {
	const rows = [user("prefix", null, "unconfirmed prefix"), assistant("sibling", "prefix", "unrelated sibling"),
		assistant("suffix", "missing", [{ type: "text", text: "searchable suffix" }, call("one")]),
		row("output", "suffix", "user", [result("one", "confirmed output")]),
		assistant("gap-sibling", "missing", "unrelated gap sibling")];
	const incomplete = project(rows, "output");
	assert.deepEqual(incomplete.missingAncestors, ["missing"]);
	assert.equal(incomplete.currentWindowOrdinal, undefined);
	assert.deepEqual(allItems(incomplete).map((event) => event.seq), [3, 4, 5]);
	assert.equal(incomplete.pairedResults.get(6), 4);
	assert.equal(incomplete.highestSeq, 7);
	assert.match(incomplete.windows[0]!.windowId, /:unknown:missing$/);
	const suffix = await historyList.execute({ query: "searchable suffix" }, incomplete);
	assert.ok(suffix.ok);
	assert.deepEqual(suffix.data.items.map((item) => "seq" in item ? item.seq : -1), [3]);
	const tool = await historyRead.execute({ seq: 4 }, incomplete);
	assert.ok(tool.ok);
	assert.match(tool.data.text, /confirmed output/);
	assert.doesNotMatch(allItems(incomplete).map(eventDocument).join("\n"), /unconfirmed prefix|unrelated sibling|unrelated gap sibling/);

	// A later first occurrence gets the next append seq, never an inserted seq.
	const recovered = project([...rows, user("missing", "prefix", "recovered ancestor")], "output");
	assert.deepEqual(recovered.missingAncestors, []);
	assert.equal(recovered.currentWindowOrdinal, 0);
	assert.equal(recovered.highestSeq, 8);
	assert.deepEqual(allItems(recovered).map((event) => event.seq), [1, 3, 4, 5, 8]);
	assert.equal(recovered.pairedResults.get(6), 4);
	assert.ok(!recovered.branchSeqs.has(2) && !recovered.branchSeqs.has(7), "recovery never selects either sibling");
});

test("Claude helper reports gaps on list/read/windows and re-anchors reset state only with a retained boot", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "claude-history-gap-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const transcriptPath = join(root, "transcript.jsonl");
	const identity = { home: join(root, "notes"), sessionId, cwd: root, agent: "claude", model: "claude" };
	const rows = [user("prefix", null, "do not expose disconnected prefix"),
		{ type: "future-record", uuid: "missing", parentUuid: "prefix", content: "do not expose metadata" },
		assistant("suffix", "missing", "confirmed suffix")];
	const history = { sessionId, transcriptPath, headUuid: "suffix" };
	const invoke = (tool: string, params: unknown = {}) => dispatch({ op: "tool", tool, params, identity, history }) as Promise<ClaudeToolResult>;
	writeFileSync(transcriptPath, jsonl(rows));
	for (const [tool, params] of [["history_list", {}], ["history_read", { seq: 2 }], ["history_windows", {}],
		["history_list", { query: "no matches" }], ["history_read", { seq: 99 }]] as const) {
		const response = await invoke(tool, params);
		assert.match(response.text, /history is incomplete: missing ancestor UUID\(s\): "missing"/);
		assert.doesNotMatch(response.text, /do not expose/);
	}
	assert.match((await invoke("history_list")).text, /confirmed suffix/);
	const excluded = await invoke("history_read", { seq: 1 });
	assert.equal(excluded.ok, false);
	assert.match(excluded.text, /outside the confirmed selected history/);
	assert.match((await invoke("history_list", { window_id: "@previous" })).text, /Cannot resolve "@previous"/);
	await assert.rejects(invoke("history_list", { window_id: "@previous", before_seq: "invalid" }), /invalid history_list parameters: before_seq/);
	await assert.rejects(invoke("history_read", { seq: "2" }), /invalid history_read parameters: seq/);
	await assert.rejects(dispatch({ op: "history_state", identity, history }), /cannot determine the current window ordinal/);

	// A native boundary alone cannot count the missing earlier resets. A quoted
	// identity without the full retained protocol is not a new ordinal anchor.
	rows.push(compact("boundary", "suffix"), row("partial", "boundary", "user", "Current context window id: claude:synthetic-session:8"));
	writeFileSync(transcriptPath, jsonl(rows));
	history.headUuid = "partial";
	await assert.rejects(dispatch({ op: "history_state", identity, history }), /cannot determine the current window ordinal/);
	rows.push(row("boot", "partial", "user", bootText(8), { isCompactSummary: true }), user("after", "boot", "after anchored reset"));
	writeFileSync(transcriptPath, jsonl(rows));
	history.headUuid = "after";
	const anchored = await readClaudeHistory(history);
	assert.equal(anchored.currentWindowOrdinal, 8);
	assert.deepEqual(anchored.windows.map((window) => window.windowId), [`claude:${sessionId}:8`, `claude:${sessionId}:unknown:missing`], "unknown segments are listed separately, not inserted into the numbered timeline");
	assert.deepEqual(await dispatch({ op: "history_state", identity, history }), { window: 8 }, "never windows.length - 1");
	assert.match((await invoke("history_read", { seq: 6 })).text, /window claude:synthetic-session:8/);
	assert.match((await invoke("history_windows")).text, /history is incomplete/);
	assert.match((await invoke("history_list", { window_id: "@previous" })).text, /Cannot resolve "@previous"/);
	rows.push(compact("next", "after"), row("next-boot", "next", "user", bootText(9)), user("latest", "next-boot", "latest"));
	writeFileSync(transcriptPath, jsonl(rows));
	history.headUuid = "latest";
	const previous = await invoke("history_list", { window_id: "@previous" });
	assert.ok(previous.ok);
	assert.match(previous.text, /after anchored reset/);
	assert.doesNotMatch(previous.text, /confirmed suffix/);

	// Restore the record as a supported message: warning disappears on the next
	// read, without any in-memory repair state or changed existing addresses.
	rows.push(user("missing", "prefix", "recovered ancestor"));
	writeFileSync(transcriptPath, jsonl(rows));
	assert.doesNotMatch((await invoke("history_windows")).text, /history is incomplete|:unknown:/);
	assert.deepEqual(await dispatch({ op: "history_state", identity, history }), { window: 9 });
});

test("Claude gap windows sort by confirmed ordinal despite forward references, without duplicating paired output", async () => {
	const rows = [row("notice", "boot9", "system", "notice"),
		row("boot8", "missing", "user", bootText(8), { isCompactSummary: true }),
		assistant("call", "boot8", [call("t")]), compact("boundary9", "call"),
		row("boot9", "boundary9", "user", bootText(9)), row("result", "notice", "user", [result("t", "output")])];
	const projection = project(rows, "result");
	const windows = await historyWindows.execute({}, projection, sessionId);
	assert.ok(windows.ok);
	assert.deepEqual(windows.data.windows.map((window) => window.window_id), [8, 9].map((ordinal) => `claude:${sessionId}:${ordinal}`));
	assert.equal(projection.currentWindowOrdinal, 9);
	assert.equal(projection.highestSeq, 8);
	assert.deepEqual(allItems(projection).filter((event) => event.role === "tool").map((event) => [event.seq, event.text]), [[4, "output"]]);
	assert.equal(projection.pairedResults.get(8), 4);
	const alias = await historyRead.execute({ seq: 8 }, projection);
	assert.ok(!alias.ok);
	assert.equal(alias.error.code, "not_an_event");
	assert.match(alias.error.message, /read seq 4/);
});

test("Claude gap notices participate in list/read budgets without changing read coordinates", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "claude-history-budget-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const transcriptPath = join(root, "transcript.jsonl"), text = "x".repeat(50000);
	writeFileSync(transcriptPath, jsonl([assistant("head", "missing", text)]));
	const identity = { home: join(root, "notes"), sessionId, cwd: root, agent: "claude", model: "claude" };
	const history = { sessionId, transcriptPath, headUuid: "head" };
	const invoke = async (tool: string, params: unknown): Promise<string> => {
		const response = await dispatch({ op: "tool", tool, params, identity, history }) as ClaudeToolResult;
		assert.ok(response.ok);
		assert.match(response.text, /history is incomplete.*"missing"/);
		assert.ok(Buffer.byteLength(response.text, "utf8") <= TOOL_OUTPUT_MAX_BYTES, `${tool}: ${Buffer.byteLength(response.text, "utf8")} bytes`);
		return response.text;
	};
	const first = await invoke("history_read", { seq: 1, max_chars: 50000 });
	const offset = Number(/\[truncated; continue at offset_chars=(\d+)\]$/.exec(first)?.[1]);
	assert.ok(offset > 0 && offset < text.length);
	const firstBody = /\n\n(x+)\n\n\[truncated;/.exec(first)?.[1];
	assert.equal(firstBody, text.slice(0, offset), "the footer addresses the first undelivered character, not the decorated text");
	const rest = await invoke("history_read", { seq: 1, offset_chars: offset, max_chars: 50000 });
	assert.equal(/\n\n(x+)$/.exec(rest)?.[1], text.slice(offset));
	assert.doesNotMatch(rest, /\[truncated;/);
	await invoke("history_list", { max_chars_per_item: 50000 });
});

test("Claude helper history tools reuse shared schemas, outcomes and text rendering from a supplied path", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "claude-history-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const transcriptPath = join(root, "transcript.jsonl"), rows = [user("u", null, "remember this"), assistant("a", "u", [call("one")]), row("r", "a", "user", [result("one", "recorded output")])];
	writeFileSync(transcriptPath, jsonl([...rows,
		{ type: "file-history-delta", messageId: "r", snapshotMessageId: "u", trackingPath: "file.txt", backup: null, timestamp: "2026-01-01T00:00:00Z" },
		{ type: "future-record", content: "private metadata" },
	]));
	const identity = { home: join(root, "notes"), sessionId, cwd: root, agent: "claude", model: "claude" };
	const history = { sessionId, transcriptPath, headUuid: "r" };
	const projection = await readClaudeHistory(history);
	const operations = [historyList, historyRead, historyWindows];
	for (const operation of operations) {
		const params = operation.name === "history_read" ? { seq: 3 } : {};
		const actual = await dispatch({ op: "tool", tool: operation.name, params, identity, history }) as ClaudeToolResult;
		const expected = operation.name === "history_read" ? { text: historyRead.render(await historyRead.execute({ seq: 3 }, projection)), ok: true }
			: operation.name === "history_list" ? { text: historyList.render(await historyList.execute({}, projection)), ok: true }
			: { text: historyWindows.render(await historyWindows.execute({}, projection, sessionId)), ok: true };
		assert.deepEqual(actual, expected);
	}
	assert.deepEqual(await dispatch({ op: "history_state", identity, history }), { window: 0 });
	await assert.rejects(dispatch({ op: "tool", tool: "history_windows", params: {}, identity }), /transcript_path is unavailable/);
	await assert.rejects(dispatch({ op: "tool", tool: "history_windows", params: {}, identity, history: { ...history, sessionId: "other" } }), /different session/);
});
