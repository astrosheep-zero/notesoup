/** Pi's persisted entry/message wire format, independent of the Pi SDK. */
import { contentText, projectHistory, type DecodedHistoryItem, type DecodedHistoryWindow, type HistoryProjection, type RecordedNestedCalls, type ToolCallStatus } from "./history.js";

type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
/** Structural views also accept native SDK values without converting or allocating seqs twice. */
type Message = {
	role: string; content?: unknown; output?: string; summary?: string; command?: string;
	cancelled?: boolean; exitCode?: number; truncated?: boolean; fullOutputPath?: string;
	toolName?: string; toolCallId?: string; isError?: boolean; nestedCalls?: RecordedNestedCalls;
};
export type PiHistoryEntry = {
	type: string; id: string; parentId?: string | null; timestamp?: string;
	message?: Message; summary?: string; customType?: string; data?: unknown; content?: unknown;
};

function mapRole(role: string): DecodedHistoryItem["role"] | undefined {
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
export function piSequenceCount(entry: Pick<PiHistoryEntry, "type" | "message">): number {
	if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message") return 1;
	if (entry.type !== "message" || !entry.message || mapRole(entry.message.role) === undefined) return 0;
	if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return 1;
	return 1 + entry.message.content.filter(isToolCall).length;
}

function messageContent(message: Message): string {
	switch (message.role) {
		case "bashExecution":
			return message.output ?? "";
		case "branchSummary":
		case "compactionSummary":
			return message.summary ?? "";
		default:
			return contentText(message.content);
	}
}

/**
 * Pass the host's nested-call record through as recorded. It is evidence about calls this run made,
 * not a second transcript: the host stores no nested results, and this lane invents none.
 */
function nestedCallsOf(message: Message): RecordedNestedCalls | undefined {
	if (message.role !== "toolResult" || message.nestedCalls === undefined) return undefined;
	return { calls: message.nestedCalls.calls, complete: message.nestedCalls.complete };
}

function toolInfo(message: Message): Pick<DecodedHistoryItem, "toolName" | "arguments" | "outputTruncated" | "fullOutputPath" | "toolError" | "toolCallId" | "nestedCalls" | "recordedStatus"> {
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

function toolCallItems(windowId: string, entry: { id: string; timestamp?: string }, message: Message, entrySeq: number): DecodedHistoryItem[] {
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
export function piHistoryFromEntries(sessionId: string, entries: readonly PiHistoryEntry[], branch: readonly PiHistoryEntry[]): HistoryProjection {
	const seqByEntryId = new Map<string, number>();
	let nextSeq = 1;
	for (const entry of entries) {
		const count = piSequenceCount(entry);
		if (count === 0) continue;
		seqByEntryId.set(entry.id, nextSeq);
		nextSeq += count;
	}
	const highestSeq = nextSeq - 1;

	let window: DecodedHistoryWindow = { windowId: `pcw:${sessionId.slice(0, 8)}:root`, items: [] };
	const rawWindows = [window];
	const branchSeqs = new Set<number>();

	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === "notesoup/reset-marker" && typeof entry.data === "object" && entry.data !== null && "windowId" in entry.data && typeof entry.data.windowId === "string" && entry.data.windowId.length > 0) {
			window = { windowId: entry.data.windowId, createdAt: entry.timestamp, items: [] };
			rawWindows.push(window);
			continue;
		}
		const entrySeq = seqByEntryId.get(entry.id);
		if (entrySeq === undefined) continue;
		branchSeqs.add(entrySeq);

		if (entry.type === "compaction" || entry.type === "branch_summary") {
			window.items.push({ seq: entrySeq, windowId: window.windowId, role: "system", text: entry.summary ?? "", createdAt: entry.timestamp });
			continue;
		}
		if (entry.type === "message" && entry.message) {
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

/** Offline files persist append order and parent links; select the final tree entry's ancestry. */
export function piHistoryFromJsonl(text: string, sessionId: string): HistoryProjection {
	const lines = text.split("\n");
	const entries: PiHistoryEntry[] = [];
	let header = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim() === "") continue;
		let row: PiHistoryEntry;
		try { row = JSON.parse(line) as PiHistoryEntry; }
		catch {
			if (index === lines.length - 1 && !text.endsWith("\n")) break;
			throw new Error(`malformed Pi transcript JSON at line ${index + 1}`);
		}
		if (!row || typeof row !== "object" || typeof row.type !== "string" || typeof row.id !== "string") throw new Error("invalid Pi transcript entry");
		if (!header) {
			if (row.type !== "session" || row.id !== sessionId) throw new Error("Pi transcript belongs to a different session or has no header");
			header = true;
			continue;
		}
		if (row.parentId !== null && typeof row.parentId !== "string") throw new Error("Pi transcript has no tree parent link (unsupported legacy format)");
		if (row.type === "message" && (!row.message || typeof row.message.role !== "string")) throw new Error("invalid Pi transcript message");
		entries.push(row);
	}
	if (!header) throw new Error("Pi transcript has no session header");
	const byId = new Map<string, PiHistoryEntry>();
	for (const entry of entries) {
		if (byId.has(entry.id)) throw new Error(`duplicate Pi entry ID: ${entry.id}`);
		byId.set(entry.id, entry);
	}
	const branch: PiHistoryEntry[] = [], seen = new Set<string>();
	let cursor = entries.at(-1);
	while (cursor) {
		if (seen.has(cursor.id)) throw new Error("cyclic Pi transcript ancestry");
		seen.add(cursor.id);
		branch.push(cursor);
		if (cursor.parentId === null) break;
		const parent = byId.get(cursor.parentId!);
		if (!parent) throw new Error(`Pi transcript missing parent: ${cursor.parentId}`);
		cursor = parent;
	}
	return piHistoryFromEntries(sessionId, entries, branch.reverse());
}
