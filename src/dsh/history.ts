import type { Context } from "@deepseek-ai/cordis";
import type { SessionId, SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-query";
import { projectHistory, type DecodedHistoryItem, type DecodedHistoryWindow, type HistoryProjection } from "../history/history.js";
import { checkpointSnapshot, recordSnapshot, windowId } from "./window.js";

/** Preserve every recorded block; attachments/reasoning have JSON evidence rather than invented text. */
function blockText(content: unknown, omitCalls = false): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content) ?? "";
	return content.filter((block) => !omitCalls || block.type !== "tool-call").map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
}
function argumentsOf(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch { return undefined; }
}

/** Native seq zero becomes public seq one. Forks contain only their selected seed prefix. */
export function decodeHistory(sessionId: string, events: readonly SessionEvent[]): HistoryProjection {
	let current: DecodedHistoryWindow = { windowId: windowId(sessionId, 0), items: [] };
	const windows = [current];
	const branchSeqs = new Set<number>();
	for (const event of events) {
		const seq = event.seq + 1;
		branchSeqs.add(seq);
		const checkpoint = checkpointSnapshot(event);
		const snapshot = checkpoint ?? recordSnapshot(event);
		if (snapshot && current.windowId !== snapshot.windowId) {
			// A root snapshot identifies the initial window; it does not create an empty extra window.
			if (snapshot.window === 0 && windows.length === 1 && current.items.length === 0) current.windowId = snapshot.windowId;
			else { current = { windowId: snapshot.windowId, createdAt: new Date(event.time).toISOString(), items: [] }; windows.push(current); }
		}
		const base = { seq, windowId: current.windowId, createdAt: new Date(event.time).toISOString() };
		let item: DecodedHistoryItem | undefined;
		switch (event.type) {
			case "user/message": item = { ...base, role: checkpoint ? "system" : "user", text: blockText(event.data.content) }; break;
			case "system/message": item = { ...base, role: "system", text: blockText(event.data.message.content) }; break;
			case "developer/message": item = { ...base, role: "developer", text: blockText(event.data.message.content) }; break;
			case "assistant/message": {
				const text = blockText(event.data.message.content, true);
				if (text) item = { ...base, role: "assistant", text };
				break;
			}
			case "assistant/attempt": item = { ...base, role: "assistant", text: JSON.stringify(event.data.stream) }; break;
			case "tool/call": item = { ...base, role: "tool_call", text: event.data.arguments, toolName: event.data.name, toolCallId: event.data.callId, ...(argumentsOf(event.data.arguments) ? { arguments: argumentsOf(event.data.arguments) } : {}) }; break;
			case "tool/result": item = { ...base, role: "tool", text: blockText(event.data.message.content), toolCallId: event.data.message.source.callId, toolError: event.data.message.isError }; break;
		}
		if (item) current.items.push(item);
	}
	return projectHistory(windows, events.at(-1) === undefined ? 0 : events.at(-1)!.seq + 1, branchSeqs);
}

export async function historyProjection(ctx: Context, sessionId: SessionId): Promise<HistoryProjection> {
	const log = await ctx.sessionQuery.readSession(sessionId);
	return decodeHistory(sessionId, log.events);
}
