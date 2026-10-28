/** Codex-owned decoding; selection, pairing, paging and budgets belong to shared history/tools. */
import { projectHistory, type DecodedHistoryItem, type DecodedHistoryWindow, type HistoryProjection } from "./history.js";
import { nativeObject as obj, nativeString as str, readCodexTranscript, type CodexRecord, type CodexTranscriptSource, type CodexTranscriptState, type NativeObject } from "./codex-transcript.js";
export type { CodexTranscriptSource } from "./codex-transcript.js";
export type CodexHistoryState = CodexTranscriptState & { projection: HistoryProjection };

const DISPLAY_COPIES = new Set(["user_message", "agent_message", "agent_reasoning", "agent_reasoning_raw_content", "context_compacted", "web_search_end", "image_generation_end"]);
const ITEM_COPIES = new Set(["UserMessage", "AgentMessage", "Reasoning", "ContextCompaction", "WebSearch", "ImageGeneration", "HookPrompt"]);
// protocol.rs serializes v1 task_* spellings; turn_* are explicit serde aliases.
const HOST_EVENTS = new Set(["token_count", "thread_goal_updated", "task_started", "task_complete", "turn_started", "turn_complete", "turn_aborted", "thread_settings_applied", "entered_review_mode", "exited_review_mode", "patch_apply_end", "sub_agent_activity"]);
const HOST_ITEMS = new Set(["Plan", "FileChange", "CollabAgentToolCall", "SubAgentActivity", "ImageView", "Extension", "EnteredReviewMode", "ExitedReviewMode"]);
const OPAQUE_RESPONSES = new Set(["reasoning", "compaction", "compaction_summary", "context_compaction", "image_generation_call"]);
const HOST_RESPONSES = new Set(["configuration_update", "tool_search_call", "tool_search_output", "web_search_call"]);
function optionalString(value: unknown, field: string): string | undefined { return value == null ? undefined : str(value, field); }
function array(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`Invalid Codex ${field}: expected an array`);
	return value;
}
/** No image/audio decoding, opaque plaintext recovery, or stringification disguised as message text. */
function textContent(value: unknown): string {
	return array(value, "content").map((value) => {
		const part = obj(value, "content part");
		switch (part.type) {
			case "input_text": case "output_text": return str(part.text, "content text");
			case "input_image": return "[Codex image content omitted]";
			case "input_audio": return "[Codex audio content omitted]";
			case "encrypted_content": return "[Codex encrypted content unavailable]";
			default: throw new Error(`Unsupported Codex content part: ${String(part.type)}`);
		}
	}).join("\n");
}
function output(value: unknown): string { return typeof value === "string" ? value : textContent(value); }
function argumentsOf(raw: string): NativeObject {
	// Custom/invalid/non-object JSON cannot fit the shared object field. Keep the
	// original wire string under an explicit raw label rather than lose it.
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as NativeObject;
	} catch { /* Native tool calls may persist unparseable model arguments. */ }
	return { raw_arguments: raw };
}
function callKey(record: CodexRecord, callId: string): string { return `${record.owner}:${callId}`; }
function context(record: CodexRecord, text: string): DecodedHistoryItem {
	if (!record.windowId) throw new Error(`Unavailable Codex history: native window identity missing at seq ${record.seq}; cannot assign a stable window address`);
	return { seq: record.seq, windowId: record.windowId, role: "system", text, createdAt: record.timestamp };
}
function host(record: CodexRecord, kind: string, payload: unknown): DecodedHistoryItem { return context(record, `Codex ${kind}\n${JSON.stringify(payload)}`); }

type ToolFact = { error?: boolean; text?: string };
/** Presentation records contribute OUTCOME evidence, never duplicate raw tool dialogue. */
function fact(item: NativeObject): ToolFact {
	if (item.type === "CommandExecution") {
		const status = str(item.status, "CommandExecution.status");
		if (!["completed", "failed", "declined", "in_progress"].includes(status)) throw new Error(`Unsupported Codex command status: ${status}`);
		return { error: status === "failed" || status === "declined" || (typeof item.exit_code === "number" && item.exit_code !== 0), text: optionalString(item.formatted_output, "formatted_output") };
	}
	if (item.type === "McpToolCall") {
		const result = item.result == null ? undefined : obj(item.result, "MCP result");
		if (result?.isError != null && typeof result.isError !== "boolean") throw new Error("Invalid Codex MCP isError");
		return { error: item.status === "failed" || item.error != null || result?.isError === true, ...(result === undefined ? {} : { text: JSON.stringify(result) }) };
	}
	if (item.type === "DynamicToolCall") return { error: item.success === false || item.status === "failed" || item.error != null };
	if (item.type === "FileChange" || item.type === "CollabAgentToolCall") return { error: item.status === "failed" || item.status === "declined" || item.status === "interrupted" };
	return {};
}
function toolDisplay(item: NativeObject): boolean {
	return ["CommandExecution", "McpToolCall", "DynamicToolCall", "CollabAgentToolCall", "FileChange", "ImageView", "Extension"].includes(String(item.type));
}
function response(record: CodexRecord, facts: Map<string, ToolFact>): DecodedHistoryItem {
	const p = record.payload, type = str(p.type, "response_item.type"), base = context(record, "");
	if (type === "message") {
		if (!["user", "assistant", "system", "developer"].includes(str(p.role, "message.role"))) throw new Error(`Unsupported Codex message role: ${String(p.role)}`);
		return { ...base, role: record.metadata?.compaction_output === true ? "system" : p.role as "user" | "assistant" | "system" | "developer", text: textContent(p.content) };
	}
	if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
		const callId = optionalString(p.call_id, "call_id") ?? (type === "local_shell_call" ? optionalString(p.id, "local shell id") : undefined);
		if (!callId) throw new Error("Invalid Codex tool call: missing native call ID");
		const name = type === "local_shell_call" ? "local_shell" : str(p.name, "tool name");
		const args = type === "local_shell_call" ? obj(p.action, "local shell action") : type === "custom_tool_call" ? { input: str(p.input, "custom tool input") } : argumentsOf(str(p.arguments, "function arguments"));
		return { ...base, role: "tool_call", toolName: p.namespace ? `${str(p.namespace, "namespace")}.${name}` : name, toolCallId: callKey(record, callId), arguments: args };
	}
	if (type === "function_call_output" || type === "custom_tool_call_output") {
		const callId = optionalString(p.call_id, "output.call_id"), recorded = callId ? facts.get(callKey(record, callId)) : undefined;
		return { ...base, role: "tool", text: output(p.output), ...(callId ? { toolCallId: callKey(record, callId) } : {}), ...(p.name == null ? {} : { toolName: str(p.name, "output.name") }), ...(recorded?.error === undefined ? {} : { toolError: recorded.error }) };
	}
	if (type === "agent_message") return host(record, "agent_message", { author: p.author, recipient: p.recipient, text: textContent(p.content) });
	if (OPAQUE_RESPONSES.has(type)) {
		// Preserve recorded summaries and available metadata, not encrypted blobs or image bytes.
		const { encrypted_content: _encrypted, result: _image, ...readable } = p;
		return host(record, `${type} (opaque content omitted; not recovered plaintext)`, readable);
	}
	if (HOST_RESPONSES.has(type)) return host(record, type, p);
	throw new Error(`Unsupported Codex response item: ${type}`);
}

/** One display record without a raw equivalent (e.g. user-shell command). */
function standaloneTool(record: CodexRecord, item: NativeObject): DecodedHistoryItem {
	const base = context(record, ""), recorded = fact(item);
	if (item.type === "CommandExecution") {
		array(item.command, "command").forEach((part) => str(part, "command argument"));
		return { ...base, role: "tool", toolName: "terminal", arguments: { command: item.command, cwd: item.cwd, source: item.source, ...(item.interaction_input == null ? {} : { interaction_input: item.interaction_input }) }, text: recorded.text ?? JSON.stringify({ stdout: item.stdout, stderr: item.stderr, aggregated_output: item.aggregated_output }), recordedStatus: item.status === "in_progress" ? "unfinished" : recorded.error ? "error" : "ok" };
	}
	const name = `${str(item.server, "MCP server")}/${str(item.tool, "MCP tool")}`;
	return { ...base, role: "tool", toolName: name, arguments: obj(item.arguments, "MCP arguments"), text: recorded.text ?? (item.error == null ? "" : JSON.stringify(item.error)), recordedStatus: item.status === "inProgress" ? "unfinished" : recorded.error ? "error" : "ok" };
}

export async function readCodexHistory(source: CodexTranscriptSource): Promise<CodexHistoryState> {
	const { state, records, highestSeq } = await readCodexTranscript(source);
	const facts = new Map<string, ToolFact>(), callsSeen = new Set<string>(), responseIdsSeen = new Set<string>();
	const windows = new Map<string, DecodedHistoryWindow>(), branchSeqs = new Set<number>();
	const addWindow = (nativeId: string, createdAt?: string): DecodedHistoryWindow => {
		const windowId = `codex:${source.threadId}:${nativeId}`;
		let window = windows.get(windowId);
		if (!window) { window = { windowId, createdAt, items: [] }; windows.set(windowId, window); }
		return window;
	};
	// Outcome inventory can enrich the raw result even when ItemCompleted follows it.
	for (const record of records) {
		const p = record.payload;
		if (record.type === "event_msg" && p.type === "item_completed") {
			if (p.thread_id !== record.owner) throw new Error("Invalid Codex ItemCompleted thread identity");
			const item = obj(p.item, "ItemCompleted.item");
			if (toolDisplay(item)) facts.set(callKey(record, str(item.id, "TurnItem.id")), fact(item));
		} else if (record.type === "event_msg" && p.type === "patch_apply_end") {
			if (typeof p.success !== "boolean") throw new Error("Invalid Codex patch_apply_end.success");
			facts.set(callKey(record, str(p.call_id, "patch call_id")), { error: !p.success });
		} else if (record.type === "event_msg" && p.type === "mcp_tool_call_end") {
			const result = obj(p.result, "MCP Result envelope");
			const ok = result.Ok == null ? undefined : obj(result.Ok, "MCP Result.Ok");
			if (ok === undefined && typeof result.Err !== "string") throw new Error("Invalid Codex MCP Result: expected Ok or Err");
			facts.set(callKey(record, str(p.call_id, "MCP call_id")), { error: result.Err != null || ok?.isError === true, text: JSON.stringify(result) });
		}
	}
	for (const record of records) {
		branchSeqs.add(record.seq);
		if (record.windowId) addWindow(record.windowId, record.type === "session_meta" || record.type === "compacted" ? record.timestamp : undefined);
		const p = record.payload;
		let item: DecodedHistoryItem | undefined;
		switch (record.type) {
			case "session_meta":
				if (p.subagent_history_start_ordinal != null) item = context(record, `Codex copied subagent inference prefix omitted: child-local history starts at native ordinal ${String(p.subagent_history_start_ordinal)}. Copied model context does not prove original parent event addresses.`);
				break;
			case "response_item": {
				item = response(record, facts);
				if (p.id != null) responseIdsSeen.add(callKey(record, str(p.id, "response item id")));
				if (item.role === "tool_call" && item.toolCallId) {
					if (callsSeen.has(item.toolCallId)) throw new Error(`Unavailable Codex history: duplicate native call ID ${item.toolCallId}`);
					callsSeen.add(item.toolCallId);
				}
				break;
			}
			case "compacted": item = context(record, `Codex compaction boundary\n${JSON.stringify({ message: p.message, window_number: p.window_number, first_window_id: p.first_window_id, previous_window_id: p.previous_window_id, window_id: p.window_id, replacement_history_items: Array.isArray(p.replacement_history) ? p.replacement_history.length : null })}\nreplacement_history is an inference checkpoint, not new conversation events.`); break;
			case "event_msg": {
				const type = str(p.type, "event_msg.type");
				if (DISPLAY_COPIES.has(type)) break;
				// A rollback changes the native selected window retrospectively. Until its
				// turn semantics are decoded, don't return stale-but-plausible boot facts.
				if (type === "thread_rolled_back") throw new Error("Unavailable Codex history: thread_rolled_back selection is not supported");
				if (type === "patch_apply_end" && callsSeen.has(callKey(record, str(p.call_id, "patch call_id")))) break;
				if (type === "mcp_tool_call_end") {
					const call = callKey(record, str(p.call_id, "MCP call_id"));
					if (!callsSeen.has(call)) item = host(record, "MCP completion without a recorded raw call", p);
					break;
				}
				if (type === "item_completed") {
					const display = obj(p.item, "ItemCompleted.item"), kind = str(display.type, "TurnItem.type");
					if (ITEM_COPIES.has(kind)) break;
					if (toolDisplay(display) && callsSeen.has(callKey(record, str(display.id, "TurnItem.id")))) break;
					if (kind === "CommandExecution" || kind === "McpToolCall") {
						item = standaloneTool(record, display);
					} else if (kind === "FunctionCallOutput") {
						// hook_runtime.rs record_pending_input persists raw output FIRST,
						// then emits this presentation copy with the SAME response-item ID.
						if (!responseIdsSeen.has(callKey(record, str(display.id, "FunctionCallOutput.id")))) item = host(record, "FunctionCallOutput display without raw output", display);
					} else if (HOST_ITEMS.has(kind) || kind === "DynamicToolCall") item = host(record, kind, display);
					else throw new Error(`Unsupported Codex TurnItem: ${kind}`);
				} else if (HOST_EVENTS.has(type)) {
					// Lifecycle's repeated final answer isn't a second assistant message.
					const { last_agent_message: _displayCopy, ...facts } = p;
					item = host(record, type, facts);
				}
				else throw new Error(`Unsupported Codex persisted event: ${type}`);
				break;
			}
			case "turn_context": case "token_usage_record": case "security_risk_score": case "inter_agent_communication_metadata": break;
			case "world_state": item = context(record, "Codex world_state snapshot/patch omitted from the text projection; not a newly spoken message."); break;
			case "inter_agent_communication": item = host(record, "inter-agent communication", { author: p.author, recipient: p.recipient, content: p.encrypted_content == null ? p.content : "[encrypted content unavailable]", trigger_turn: p.trigger_turn }); break;
			case "retained_context": case "realtime_item": item = context(record, `Codex ${record.type} omitted from text projection; native structured/retained context is not newly spoken dialogue.`); break;
		}
		if (item) addWindow(record.windowId!).items.push({ ...item, windowId: `codex:${source.threadId}:${record.windowId}` });
	}
	return { ...state, projection: projectHistory([...windows.values()], highestSeq, branchSeqs) };
}
