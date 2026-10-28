import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { readCodexHistory } from "../plugins/codex/src/history.js";
import { readCodexTranscriptState } from "../plugins/codex/src/transcript.js";
import { allItems, eventDocument } from "../src/history/history.js";
import { historyList, historyRead } from "../src/tools/history.js";

/* Producer-shaped synthetic fixtures, not captured/private transcripts.
 * Frozen official rust-v0.160.1, d27764b82f7118f674371e6d6e76271d9d606edb:
 * - history/src/{lib.rs,rollout_payload.rs}: flattened JSONL envelope, top-level
 *   metadata, raw replacement_history + aligned replacement_history_metadata.
 * - protocol/src/{protocol.rs,models.rs,items.rs,mcp.rs}: exact case/field shapes;
 *   item_completed's TurnItem is PascalCase; McpToolCall fields are camelCase;
 *   legacy MCP Result uses {Ok:{...}}/{Err:string}, not flattened MCP fields.
 * - rollout/src/{ordinal.rs,policy.rs,compression.rs}: legacy omits ordinals,
 *   paginated uses native (possibly gapped) ordinals, .jsonl.zst decoded offsets.
 * - thread-store/src/local/{rollout_lineage.rs,revert_thread.rs}: history_base
 *   is an exclusive physical rollout-ID + ordinal + decoded byte coordinate;
 *   replacement filename has stable thread ID and distinct _rollout-id suffix.
 * - core/src/agent/control_tests.rs: paginated full-history children COPY only
 *   inference context and mark subagent_history_start_ordinal, not history_base.
 */
const ROOT = "019a0000-0000-7000-8000-000000000001";
const CHILD = "019a0000-0000-7000-8000-000000000002";
const FORK = "019a0000-0000-7000-8000-000000000003";
const REVERT = "019a0000-0000-7000-8000-000000000004";
const W0 = "019a0000-0000-7000-8000-000000000010";
const W1 = "019a0000-0000-7000-8000-000000000011";
const W2 = "019a0000-0000-7000-8000-000000000012";
const WC = "019a0000-0000-7000-8000-000000000013";
const AT = "2026-10-06T01:02:03.000Z";
type Row = Record<string, unknown>;
const row = (type: string, payload: Row, ordinal?: number, metadata?: Row): Row => ({ timestamp: AT, ...(ordinal === undefined ? {} : { ordinal }), type, payload, ...(metadata ? { metadata } : {}) });
function meta(id = ROOT, extra: Row = {}): Row {
	return { session_id: ROOT, id, timestamp: AT, cwd: "/workspace/native", originator: "codex_cli_rs", cli_version: "0.160.1", source: "cli", model_provider: "openai", base_instructions: { text: "base" }, history_mode: "paginated", context_window: { window_id: W0 }, ...extra };
}
function settings(model: string): Row {
	return { model, model_provider_id: "openai", approval_policy: "on-request", approvals_reviewer: "user", permission_profile: { type: "managed", file_system: { type: "restricted", entries: [] }, network: "restricted" }, cwd: "/workspace/native", collaboration_mode: { mode: "default", settings: { model, reasoning_effort: null, developer_instructions: null } }, disabled_plugin_ids: [] };
}
function turnContext(model: string): Row {
	return { turn_id: "turn-1", cwd: "/workspace/native", approval_policy: "on-request", sandbox_policy: { type: "read-only" }, model, summary: "auto" };
}
const message = (role: string, text: string, id = `msg-${role}`): Row => ({ type: "message", id, role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const completed = (item: Row, thread = ROOT): Row => ({ type: "item_completed", thread_id: thread, turn_id: "turn-1", item, started_at_ms: 1791248523000, completed_at_ms: 1791248524000 });
const command = (id: string, extra: Row = {}): Row => ({ type: "CommandExecution", id, command: ["bash", "-lc", "printf output"], cwd: "file:///workspace/native", parsed_cmd: [], source: "agent", status: "failed", stdout: "partial", stderr: "error", aggregated_output: "partial\nerror", exit_code: 2, duration: { secs: 0, nanos: 1000000 }, formatted_output: "partial\nerror", ...extra });
function compact(window: string, previous: string, number: number, replacement: Row[] = []): Row {
	return { message: "", replacement_history: replacement, replacement_history_metadata: replacement.map(() => ({ client_authored: false })), window_number: number, first_window_id: W0, previous_window_id: previous, window_id: window, compaction_response_id: null, latest_token_usage_record: null };
}
const jsonl = (rows: Row[]): string => rows.map((r) => JSON.stringify(r) + "\n").join("");
const nativeName = (thread: string, rollout?: string): string => `rollout-2026-10-06T01-02-03-${thread}${rollout ? `_${rollout}` : ""}.jsonl`;
async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "notesoup-codex-history-test-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const day = join(home, "sessions", "2026", "10", "06");
	await mkdir(day, { recursive: true });
	return { home, day, path: join(day, nativeName(ROOT)) };
}

test("root: raw messages, top-level envelope metadata, native tool pairing and no display duplicates", async (t) => {
	const f = await fixture(t);
	await writeFile(f.path, jsonl([
		row("session_meta", meta(), 0),
		row("turn_context", turnContext("gpt-5.4"), 1),
		row("response_item", message("system", "system context"), 2),
		row("response_item", message("developer", "developer context"), 3, { client_authored: true, user_input_order: 1 }),
		row("response_item", message("user", "please run this"), 4),
		row("event_msg", completed({ type: "UserMessage", id: "user-ui", content: [{ type: "text", text: "please run this", text_elements: [] }] }), 5),
		row("response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"printf output"}', call_id: "cmd-1" }, 6),
		row("event_msg", completed(command("cmd-1")), 7),
		row("response_item", { type: "function_call_output", call_id: "cmd-1", output: "partial\nerror" }, 8),
		row("response_item", message("assistant", "finished", "a1"), 9),
		row("event_msg", completed({ type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "finished" }], phase: "final_answer" }), 10),
	]));
	const before = await readFile(f.path), info = await stat(f.path);
	const result = await readCodexHistory({ transcriptPath: f.path, threadId: ROOT });
	assert.equal(result.threadId, ROOT);
	assert.equal(result.rootSessionId, ROOT);
	assert.equal(result.model, "gpt-5.4");
	assert.equal(result.currentWindowId, W0);
	assert.equal(result.currentWindowNumber, 0);
	assert.equal(result.firstWindowId, W0);
	assert.equal(result.previousWindowId, undefined);
	const { projection } = result, items = allItems(projection);
	assert.deepEqual(items.map((i) => i.seq), [3, 4, 5, 7, 10]);
	assert.deepEqual(items.map((i) => i.role), ["context", "context", "user", "tool", "assistant"]);
	const tool = await historyRead.execute({ seq: 7 }, projection);
	assert.ok(tool.ok);
	assert.equal(tool.data.tool, "exec_command");
	assert.equal(tool.data.tool_status, "error");
	assert.match(historyRead.render(tool), /printf output/);
	assert.match(historyRead.render(tool), /partial\nerror/);
	assert.equal(tool.data.output_truncated, undefined);
	assert.equal(tool.data.nested_calls, undefined);
	const paired = await historyRead.execute({ seq: 9 }, projection);
	assert.equal(paired.ok, true);
	if (paired.ok) assert.equal(paired.data.seq, 7);
	const omitted = await historyRead.execute({ seq: 6 }, projection);
	assert.match(historyRead.render(omitted), /holds nothing/);
	const page = await historyList.execute({ query: "printf output" }, projection);
	assert.ok(page.ok);
	assert.equal(page.data.items.length, 1);
	assert.match(historyList.render(page), /seq 7/);
	assert.deepEqual(await readFile(f.path), before);
	assert.equal((await stat(f.path)).mtimeMs, info.mtimeMs);
});

test("two native checkpoints retain old raw history; replacement_history is not new dialogue", async (t) => {
	const f = await fixture(t);
	const prefix = [row("session_meta", meta(), 0), row("response_item", message("user", "old raw text"), 1), row("response_item", message("assistant", "old answer"), 2)];
	await writeFile(f.path, jsonl(prefix));
	const first = await readCodexHistory({ transcriptPath: f.path, threadId: ROOT });
	await appendFile(f.path, jsonl([
		row("compacted", compact(W1, W0, 1, [message("user", "COPIED CHECKPOINT TEXT")]), 3),
		row("event_msg", completed({ type: "ContextCompaction", id: "ui-compact" }), 4),
		row("response_item", message("user", "middle text"), 5),
		row("compacted", compact(W2, W1, 2), 6),
		row("response_item", message("assistant", "current text"), 7),
	]));
	const second = await readCodexHistory({ transcriptPath: f.path, threadId: ROOT });
	assert.equal(second.currentWindowId, W2);
	assert.equal(second.currentWindowNumber, 2);
	assert.equal(second.previousWindowId, W1);
	assert.equal(second.firstWindowId, W0);
	assert.deepEqual(allItems(second.projection).filter((i) => i.seq <= 3), allItems(first.projection));
	assert.doesNotMatch(allItems(second.projection).map(eventDocument).join("\n"), /COPIED CHECKPOINT TEXT/);
	assert.deepEqual(second.projection.windows.map((w) => [w.windowId, w.items[0]?.seq, w.items.at(-1)?.seq]), [
		[`codex:${ROOT}:${W0}`, 2, 3], [`codex:${ROOT}:${W1}`, 4, 6], [`codex:${ROOT}:${W2}`, 7, 8],
	]);
	const earlier = await historyList.execute({ after_seq: 3, before_seq: 7, roles: ["user"] }, second.projection);
	assert.match(historyList.render(earlier), /^seq 6 \| user\nmiddle text$/);
	const old = await historyRead.execute({ seq: 2 }, second.projection);
	assert.match(historyRead.render(old), /old raw text/);
	const { projection: _projection, ...facts } = second;
	assert.deepEqual(await readCodexTranscriptState({ transcriptPath: f.path, threadId: ROOT }), facts);
	assert.deepEqual(await readCodexHistory({ transcriptPath: f.path, threadId: ROOT }), second);
});

test("legacy source coordinates stay append-stable including a pending call and incomplete/valid JSON append tails", async (t) => {
	const f = await fixture(t);
	const head = jsonl([
		row("session_meta", meta(ROOT, { history_mode: "legacy" })),
		row("response_item", { type: "function_call", call_id: "pending", name: "lookup", arguments: '{"q":"needle"}' }),
	]);
	await writeFile(f.path, head + '{"timestamp":');
	const source = { transcriptPath: f.path, threadId: ROOT };
	const pending = await readCodexHistory(source);
	assert.equal(allItems(pending.projection)[0]?.execution?.status, "unfinished");
	const result = row("response_item", { type: "function_call_output", call_id: "pending", output: [{ type: "input_text", text: "answer" }, { type: "input_image", image_url: "data:omitted" }] });
	await writeFile(f.path, head + JSON.stringify(result));
	assert.deepEqual(await readCodexHistory(source), pending); // JSON without delimiter is not committed
	await appendFile(f.path, "\n");
	const complete = await readCodexHistory(source);
	assert.equal(allItems(complete.projection)[0]?.seq, 2);
	assert.equal(allItems(complete.projection)[0]?.execution?.status, "ok");
	assert.match(eventDocument(allItems(complete.projection)[0]!), /answer\n\[Codex image content omitted\]/);
	await appendFile(f.path, jsonl([row("response_item", message("assistant", "later"))]));
	assert.deepEqual(allItems((await readCodexHistory(source)).projection).slice(0, 1), allItems(complete.projection));
});

test("paginated native ordinal gaps never become mutable display ranks", async (t) => {
	const f = await fixture(t);
	await writeFile(f.path, jsonl([row("session_meta", meta(), 0), row("response_item", message("user", "one"), 20), row("response_item", message("assistant", "two"), 49)]));
	const result = await readCodexHistory({ transcriptPath: f.path, threadId: ROOT });
	assert.deepEqual(allItems(result.projection).map((i) => i.seq), [21, 50]);
	await appendFile(f.path, jsonl([row("response_item", message("user", "three"), 100)]));
	const appended = await readCodexHistory({ transcriptPath: f.path, threadId: ROOT });
	assert.deepEqual(allItems(appended.projection).slice(0, 2), allItems(result.projection));
	assert.equal(appended.projection.highestSeq, 101);
});

test("fork + reverted physical lineage resolves only bounded ancestry, including archived zstd", async (t) => {
	const f = await fixture(t);
	const ancestor = jsonl([row("session_meta", meta(), 0), row("response_item", message("user", "父前缀 🦈"), 1), row("response_item", message("assistant", "kept answer"), 2)]);
	const archived = join(f.home, "archived_sessions");
	await mkdir(archived);
	await writeFile(join(archived, nativeName(ROOT) + ".zst"), zstdCompressSync(Buffer.from(ancestor + jsonl([row("response_item", message("assistant", "EXCLUDED ROOT SUFFIX"), 3)]))));
	const base = { thread_id: ROOT, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(ancestor) };
	const forkPath = join(f.day, nativeName(FORK));
	const forkPrefix = jsonl([
		row("session_meta", meta(FORK, { forked_from_id: ROOT, forked_from_ordinal_exclusive: 3, history_base: base, context_window: { window_id: WC } }), 3),
		row("response_item", message("user", "fork-local kept"), 4),
	]);
	await writeFile(forkPath, forkPrefix + jsonl([row("response_item", message("assistant", "EXCLUDED FORK SUFFIX"), 5)]));
	// Same thread ID, NEW physical rollout ID, cutoff addresses the prior file.
	const replacementPath = join(f.day, nativeName(FORK, REVERT));
	await writeFile(replacementPath, jsonl([
		row("session_meta", meta(FORK, { forked_from_id: ROOT, forked_from_ordinal_exclusive: 3, history_base: { thread_id: FORK, end_ordinal_exclusive: 5, end_byte_offset: Buffer.byteLength(forkPrefix) }, context_window: { window_id: WC } }), 5),
		row("response_item", message("assistant", "new branch"), 6),
	]));
	await writeFile(join(f.day, nativeName(CHILD)), "THIS SIBLING MUST NEVER BE PARSED\n");
	const result = await readCodexHistory({ transcriptPath: replacementPath, threadId: FORK });
	const text = allItems(result.projection).map(eventDocument).join("\n");
	assert.match(text, /父前缀 🦈/);
	assert.match(text, /fork-local kept/);
	assert.match(text, /new branch/);
	assert.doesNotMatch(text, /EXCLUDED|SIBLING/);
	assert.deepEqual(allItems(result.projection).map((i) => i.seq), [2, 3, 5, 7]);
	assert.equal(result.currentWindowId, WC);
	assert.equal(result.threadId, FORK);
	assert.ok(result.projection.windows.every((w) => w.windowId.startsWith(`codex:${FORK}:`)));
});

test("child root session_id isn't thread identity; copied inference prefix isn't child dialogue", async (t) => {
	const f = await fixture(t), path = join(f.day, nativeName(CHILD));
	await writeFile(path, jsonl([
		row("session_meta", meta(CHILD, { parent_thread_id: ROOT, forked_from_id: ROOT, source: { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1, agent_path: "/root/worker", agent_nickname: "worker", agent_role: "default" } } }, subagent_history_start_ordinal: 3, context_window: { window_id: WC } }), 0),
		row("response_item", message("user", "INHERITED MODEL CONTEXT"), 1, { inherited_user_message: true }),
		row("response_item", message("developer", "INHERITED DEVELOPER"), 2),
		row("event_msg", { type: "thread_settings_applied", thread_id: CHILD, thread_settings: settings("child-model") }, 3),
		row("response_item", message("user", "child task"), 4),
	]));
	const result = await readCodexHistory({ transcriptPath: path, threadId: CHILD });
	assert.equal(result.rootSessionId, ROOT);
	assert.equal(result.threadId, CHILD);
	assert.equal(result.model, "child-model");
	assert.equal(result.currentWindowId, WC);
	assert.doesNotMatch(allItems(result.projection).map(eventDocument).join("\n"), /INHERITED/);
	assert.equal(allItems(result.projection).at(-1)?.seq, 5);
	await assert.rejects(readCodexHistory({ transcriptPath: path, threadId: ROOT }), /not requested threadId.*session_id is root-scoped/);
});

test("custom calls, MCP error envelopes, standalone terminal facts and opaque omissions", async (t) => {
	const f = await fixture(t);
	await writeFile(f.path, jsonl([
		row("session_meta", meta(ROOT, { history_mode: "legacy" })),
		row("response_item", { type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }),
		row("response_item", { type: "custom_tool_call_output", call_id: "patch", output: "patched" }),
		row("response_item", { type: "function_call", call_id: "mcp-1", name: "mcp__repo__read", arguments: '{"path":"nope"}' }),
		row("event_msg", { type: "mcp_tool_call_end", call_id: "mcp-1", invocation: { server: "repo", tool: "read", arguments: { path: "nope" } }, duration: { secs: 0, nanos: 1 }, result: { Ok: { content: [{ type: "text", text: "not found" }], isError: true } } }),
		row("response_item", { type: "function_call_output", call_id: "mcp-1", output: "not found" }),
		row("event_msg", completed(command("user-shell", { source: "user_shell" }))),
		row("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "recorded summary" }], encrypted_content: "SECRET OPAQUE BYTES" }),
		row("response_item", { type: "function_call", call_id: "bad-json", name: "bad", arguments: "{broken" }),
	]));
	const { projection } = await readCodexHistory({ transcriptPath: f.path, threadId: ROOT });
	const items = allItems(projection);
	assert.equal(items[0]?.execution?.arguments?.input, "*** Begin Patch\n*** End Patch");
	assert.equal(items[1]?.execution?.status, "error");
	assert.equal(items[2]?.execution?.name, "terminal");
	assert.equal(items[2]?.execution?.status, "error");
	assert.match(eventDocument(items[2]!), /partial\nerror/);
	assert.match(eventDocument(items[3]!), /recorded summary/);
	assert.doesNotMatch(items.map(eventDocument).join("\n"), /SECRET OPAQUE BYTES/);
	assert.equal(items.at(-1)?.execution?.arguments?.raw_arguments, "{broken");
});

test("native lifecycle and hook-runtime persisted output use wire spellings and shared raw identities", async (t) => {
	const f = await fixture(t);
	// From protocol.rs EventMsg serde renames and hook_runtime.rs record_pending_input:
	// raw FunctionCallOutput(id/name, no call_id) -> ItemCompleted(FunctionCallOutput).
	// HookStarted/HookCompleted themselves are transient in rollout/src/policy.rs.
	await writeFile(f.path, jsonl([
		row("session_meta", meta(), 0),
		row("event_msg", { type: "thread_settings_applied", thread_id: ROOT, thread_settings: settings("current-settings-model") }, 1),
		row("event_msg", { type: "task_started", turn_id: "turn-1", model_context_window: 272000, collaboration_mode_kind: "default" }, 2),
		row("response_item", { ...message("developer", "hook additional context", "hook-context"), internal_chat_message_metadata_passthrough: { content_item_kinds: ["hooks.additional_context"] } }, 3),
		row("response_item", { type: "function_call_output", id: "hook-result", name: "hook_tool", output: "hook output only once" }, 4),
		row("event_msg", completed({ type: "FunctionCallOutput", id: "hook-result", name: "hook_tool", output: "hook output only once" }), 5),
		row("response_item", { type: "function_call", call_id: "mcp-native", name: "mcp__repo__read", arguments: '{"path":"x"}' }, 6),
		row("response_item", { type: "function_call_output", call_id: "mcp-native", output: "MCP wire error only once" }, 7),
		row("event_msg", completed({ type: "McpToolCall", id: "mcp-native", server: "repo", tool: "read", arguments: { path: "x" }, status: "failed", result: { content: [{ type: "text", text: "MCP wire error only once" }], isError: true }, error: { message: "failure" } }), 8),
		row("response_item", message("assistant", "final answer only once"), 9),
		row("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: "final answer only once" }, 10),
		row("turn_context", turnContext("frozen-companion-model"), 11),
	]));
	const result = await readCodexHistory({ transcriptPath: f.path, threadId: ROOT });
	assert.equal(result.model, "current-settings-model");
	const items = allItems(result.projection), text = items.map(eventDocument).join("\n");
	assert.match(text, /Codex task_started/);
	assert.match(text, /Codex task_complete/);
	assert.equal(text.match(/hook output only once/g)?.length, 1);
	assert.equal(text.match(/MCP wire error only once/g)?.length, 1);
	assert.equal(text.match(/final answer only once/g)?.length, 1);
	assert.equal(items.find((i) => i.seq === 7)?.execution?.status, "error");
	assert.equal(items.find((i) => i.seq === 5)?.execution?.name, "hook_tool");
});

test("header-only native facts exist before any compaction, but absent facts are never fabricated", async (t) => {
	const f = await fixture(t), source = { transcriptPath: f.path, threadId: ROOT };
	await writeFile(f.path, jsonl([row("session_meta", meta(), 0)]));
	assert.equal((await readCodexTranscriptState(source)).currentWindowId, W0);
	assert.equal((await readCodexHistory(source)).projection.windows.length, 1);
	await writeFile(f.path, jsonl([row("session_meta", meta(ROOT, { context_window: null }), 0)]));
	const facts = await readCodexTranscriptState(source);
	assert.equal(facts.currentWindowId, undefined);
	assert.equal(facts.currentWindowNumber, undefined);
	assert.equal(facts.firstWindowId, undefined);
	assert.equal((await readCodexHistory(source)).projection.windows.length, 0);
	await appendFile(f.path, jsonl([row("response_item", message("user", "unaddressable"), 1)]));
	await assert.rejects(readCodexHistory(source), /native window identity missing/);
});

test("committed malformed, unsupported, unsafe and unproved native shapes refuse explicitly", async (t) => {
	const f = await fixture(t), source = { transcriptPath: f.path, threadId: ROOT };
	await assert.rejects(readCodexHistory(source), /ENOENT/);
	const head = row("session_meta", meta(), 0);
	for (const [rows, expected] of [
		[[row("session_meta", meta(ROOT, { cli_version: "0.161.0" }), 0)], /Unsupported Codex producer/],
		[[head, row("future_record", {}, 1)], /Unsupported Codex rollout record/],
		[[head, row("response_item", { type: "future_item" }, 1)], /Unsupported Codex response/],
		[[head, row("response_item", message("user", "x"))], /paginated record ordinal/],
		[[head, row("response_item", message("user", "x"), 0)], /non-increasing/],
		[[head, row("response_item", message("user", "x"), Number.MAX_SAFE_INTEGER + 1)], /unsafe/],
		[[head, row("response_item", { item: message("user", "wrong envelope") }, 1)], /response_item.type/],
		[[head, row("compacted", { ...compact(W1, W0, 1), replacement_history_metadata: [{}] }, 1)], /metadata alignment/],
		[[head, row("event_msg", { type: "thread_rolled_back", num_turns: 1 }, 1)], /thread_rolled_back/],
		[[head, row("session_meta", meta(CHILD), 1)], /copied session_meta ancestry/],
	] as [Row[], RegExp][]) {
		await writeFile(f.path, jsonl(rows));
		await assert.rejects(readCodexHistory(source), expected);
	}
	await writeFile(f.path, jsonl([head]) + "{broken}\n");
	await assert.rejects(readCodexHistory(source), /Malformed committed.*line 2/);
});

test("missing or mismatched ancestry and unsafe cutoff pairs never fall back to concatenation", async (t) => {
	const f = await fixture(t), path = join(f.day, nativeName(CHILD));
	const ancestor = jsonl([row("session_meta", meta(), 0), row("response_item", message("user", "kept"), 1)]);
	const base = { thread_id: ROOT, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(ancestor) };
	const writeChild = async (history_base: Row, extra: Row = {}) => writeFile(path, jsonl([row("session_meta", meta(CHILD, { history_base, forked_from_id: ROOT, ...extra }), history_base.end_ordinal_exclusive as number)]));
	await writeChild(base);
	await assert.rejects(readCodexHistory({ transcriptPath: path, threadId: CHILD }), /no local source file/);
	await writeFile(f.path, ancestor);
	await writeChild({ ...base, end_byte_offset: base.end_byte_offset - 1 });
	await assert.rejects(readCodexHistory({ transcriptPath: path, threadId: CHILD }), /complete decoded JSONL boundary/);
	await writeChild({ ...base, end_ordinal_exclusive: 3 });
	await assert.rejects(readCodexHistory({ transcriptPath: path, threadId: CHILD }), /ordinal cutoff is beyond the proved prefix/);
	await writeChild(base, { forked_from_ordinal_exclusive: 1 });
	await assert.rejects(readCodexHistory({ transcriptPath: path, threadId: CHILD }), /exceeds the logical fork cutoff/);
	await writeChild(base);
	await writeFile(f.path, jsonl([row("session_meta", meta(FORK), 0), row("response_item", message("user", "kept"), 1)]));
	await assert.rejects(readCodexHistory({ transcriptPath: path, threadId: CHILD }), /identity mismatch/);
});
