import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionReader } from "./session-reader.js";
import { GUIDANCE_TYPE, WARNING_TYPE } from "./entries.js";

/**
 * Budget reminders reach the model inside the request that crosses a threshold, but
 * Pi can only persist them at turn_end, after that request's assistant reply. Each
 * durable copy records the reply it preceded; projections move it back before that
 * reply so later requests see the same prefix the first one did, and only one copy.
 */
export type AnchorDetails = { anchorEntryId: string };

const ANCHORED_TYPES = new Set([GUIDANCE_TYPE, WARNING_TYPE]);

function anchorOf(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || !ANCHORED_TYPES.has(message.customType)) return undefined;
	const details = message.details as { anchorEntryId?: unknown } | undefined;
	return typeof details?.anchorEntryId === "string" ? details.anchorEntryId : undefined;
}

/**
 * Move each durable reminder directly before the reply it preceded. Only an anchor on
 * the active branch and visible in `messages` counts; any other reminder stays put.
 */
export function arrangeAnchoredReminders(messages: AgentMessage[], ctx: SessionReader): AgentMessage[] {
	if (!messages.some((message) => anchorOf(message) !== undefined)) return messages;
	// Replies are cloned into `messages`, so match by timestamp. Fast turns can share a
	// millisecond; rank equal timestamps from the newest, since projections only drop
	// older messages.
	const replies = new Map<string, string>();
	const seen = new Map<number, number>();
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const rank = seen.get(entry.message.timestamp) ?? 0;
		seen.set(entry.message.timestamp, rank + 1);
		replies.set(entry.id, `${entry.message.timestamp}#${rank}`);
	}
	const keys = new Map<AgentMessage, string>();
	seen.clear();
	for (const message of [...messages].reverse()) {
		if (message.role !== "assistant") continue;
		const rank = seen.get(message.timestamp) ?? 0;
		seen.set(message.timestamp, rank + 1);
		keys.set(message, `${message.timestamp}#${rank}`);
	}
	const visible = new Set(keys.values());
	const before = new Map<string, AgentMessage[]>();
	const rest = messages.filter((message) => {
		const anchorId = anchorOf(message);
		const key = anchorId ? replies.get(anchorId) : undefined;
		if (key === undefined || !visible.has(key)) return true;
		before.set(key, [...(before.get(key) ?? []), message]);
		return false;
	});
	return rest.flatMap((message) => {
		const key = keys.get(message);
		const moved = key ? before.get(key) : undefined;
		if (!moved) return [message];
		before.delete(key!);
		return [...moved, message];
	});
}
