/**
 * Native history decoder. This lane owns nothing but the host boundary: it allocates the stable
 * file-order seq, selects the active branch, and decodes session entries into typed facts. Pairing,
 * bounding, and the readable projection belong to the shared domain in ../history/history.ts.
 *
 * The address contract is deliberate and unchanged in spirit: a seq is allocated from entry kind and
 * role alone, never from visible content, so appending or branching never renumbers an existing
 * address. What changed is that a result folded into a pairing no longer doubles as a second
 * readable address for its call.
 */
import type { ToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionReader } from "./session-reader.js";
import { isWindowMarker, rootWindowId } from "./window.js";
import { contentText, projectHistory, type DecodedHistoryItem, type DecodedHistoryWindow, type HistoryProjection, type NestedCallRecord, type ToolCallStatus } from "../../src/history/history.js";

function mapRole(role: AgentMessage["role"]): DecodedHistoryItem["role"] | undefined {
	if (role === "user" || role === "assistant") return role;
	if (role === "toolResult" || role === "bashExecution") return "tool";
	if (role === "custom") return "developer";
	if (role === "compactionSummary" || role === "branchSummary") return "system";
	return undefined;
}

function isToolCall(part: unknown): part is ToolCall {
	return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall";
}

/** Seq allocation depends on entry kind and role, never on visible content. */
function sequenceCount(entry: SessionEntry | SessionBoundaryDraft): number {
	if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message") return 1;
	if (entry.type !== "message" || mapRole(entry.message.role) === undefined) return 0;
	if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return 1;
	return 1 + entry.message.content.filter(isToolCall).length;
}

/** Pending boundary drafts use the same slots as persisted entries. */
export function nextHistorySeq(ctx: SessionReader, pending: readonly SessionBoundaryDraft[] = []): number {
	return 1 + [...ctx.sessionManager.getEntries(), ...pending].reduce((sum, entry) => sum + sequenceCount(entry), 0);
}

function messageContent(message: AgentMessage): string {
	switch (message.role) {
		case "bashExecution":
			return message.output;
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return contentText(message.content);
	}
}

/**
 * Pass the host's nested-call record through as recorded. It is evidence about calls this run made,
 * not a second transcript: the host stores no nested results, and this lane invents none.
 */
function nestedCallsOf(message: AgentMessage): { calls: NestedCallRecord[]; complete: boolean } | undefined {
	if (message.role !== "toolResult" || message.nestedCalls === undefined) return undefined;
	return { calls: message.nestedCalls.calls, complete: message.nestedCalls.complete };
}

function toolInfo(message: AgentMessage): Pick<DecodedHistoryItem, "toolName" | "arguments" | "outputTruncated" | "fullOutputPath" | "toolError" | "toolCallId" | "nestedCalls" | "recordedStatus"> {
	if (message.role === "bashExecution") {
		// A standalone bash run records its own outcome, so its status is read here rather than
		// inferred from a result message that will never arrive: a cancelled or nonzero run is an
		// error, and a run with no recorded exit code stays unknown instead of being called ok.
		const status: ToolCallStatus = message.cancelled === true ? "error" : typeof message.exitCode === "number" ? (message.exitCode === 0 ? "ok" : "error") : "unfinished";
		// A truncated run is only half the record without the on-disk path: surface both.
		return { toolName: "bash", arguments: { command: message.command }, recordedStatus: status, outputTruncated: message.truncated || undefined, fullOutputPath: message.truncated ? message.fullOutputPath : undefined };
	}
	if (message.role !== "toolResult") return {};
	const nestedCalls = nestedCallsOf(message);
	return {
		toolName: message.toolName,
		toolCallId: message.toolCallId,
		toolError: message.isError === true ? true : undefined,
		...(nestedCalls ? { nestedCalls } : {}),
	};
}

function toolCallItems(windowId: string, entry: { id: string; timestamp?: string }, message: AgentMessage, entrySeq: number): DecodedHistoryItem[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const items: DecodedHistoryItem[] = [];
	let callIndex = 0;
	for (const part of message.content) {
		if (!isToolCall(part)) continue;
		items.push({
			seq: entrySeq + callIndex + 1,
			windowId,
			role: "tool_call",
			text: "",
			createdAt: entry.timestamp,
			toolName: part.name,
			toolCallId: part.id,
			arguments: part.arguments,
		});
		callIndex += 1;
	}
	return items;
}

/** Build stable internal addresses, then project the active branch into public events. */
export function historyFromSession(ctx: SessionReader): HistoryProjection {
	const seqByEntryId = new Map<string, number>();
	let nextSeq = 1;
	for (const entry of ctx.sessionManager.getEntries()) {
		const count = sequenceCount(entry);
		if (count === 0) continue;
		seqByEntryId.set(entry.id, nextSeq);
		nextSeq += count;
	}
	const highestSeq = nextSeq - 1;

	const sessionId = ctx.sessionManager.getSessionId();
	let window: DecodedHistoryWindow = { windowId: rootWindowId(sessionId), items: [] };
	const rawWindows = [window];
	const branchSeqs = new Set<number>();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (isWindowMarker(entry)) {
			window = { windowId: entry.data.windowId, createdAt: entry.timestamp, items: [] };
			rawWindows.push(window);
			continue;
		}
		const entrySeq = seqByEntryId.get(entry.id);
		if (entrySeq === undefined) continue;
		branchSeqs.add(entrySeq);

		if (entry.type === "compaction" || entry.type === "branch_summary") {
			window.items.push({ seq: entrySeq, windowId: window.windowId, role: "system", text: entry.summary, createdAt: entry.timestamp });
			continue;
		}
		if (entry.type === "message") {
			const role = mapRole(entry.message.role);
			if (!role) continue;
			window.items.push({
				seq: entrySeq,
				windowId: window.windowId,
				role,
				text: messageContent(entry.message),
				createdAt: entry.timestamp,
				...toolInfo(entry.message),
			});
			const calls = toolCallItems(window.windowId, entry, entry.message, entrySeq);
			for (const call of calls) branchSeqs.add(call.seq);
			window.items.push(...calls);
			continue;
		}
		if (entry.type === "custom_message") {
			window.items.push({
				seq: entrySeq,
				windowId: window.windowId,
				role: "developer",
				text: contentText(entry.content),
				createdAt: entry.timestamp,
			});
		}
	}

	return projectHistory(rawWindows, highestSeq, branchSeqs);
}