/** Recorded details live once, in the pageable event document; tools expose a small summary. */
import { Type, type Static } from "typebox";

/** The four public roles a history event carries on the wire, in presentation order. */
export const HistoryRoleSchema = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("context")]);
export type HistoryRole = Static<typeof HistoryRoleSchema>;

/** How a recorded tool run ended. A call with no recorded result has not ended. */
export const ToolCallStatusSchema = Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("unfinished")]);
export type ToolCallStatus = Static<typeof ToolCallStatusSchema>;

/** Internal recorded facts, not a second copy in the public read schema. */
export type NestedCallRecord = {
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
	argumentsBytes?: number;
	status: ToolCallStatus;
	durationMs?: number;
	error?: string;
};
export type RecordedNestedCalls = { calls: NestedCallRecord[]; complete: boolean };
export type ToolExecutionFacts = {
	name: string;
	status: ToolCallStatus;
	arguments?: Record<string, unknown>;
	outputTruncated?: boolean;
	fullOutputPath?: string;
	nestedCalls?: RecordedNestedCalls;
};

/** One projection event: its facts, and the document they render to. */
export type HistoryEvent = {
	seq: number;
	windowId: string;
	role: HistoryRole;
	createdAt: string | undefined;
	/** Message body for user/assistant/context; the run's output for a tool event. */
	text: string;
	/** Whole recorded facts, rendered by eventDocument. */
	execution?: ToolExecutionFacts;
};

export type HistoryWindow = { windowId: string; createdAt?: string; items: HistoryEvent[] };

/** Paired result seqs stay on the branch but redirect readers to the call's event. */
export type HistoryProjection = { windows: HistoryWindow[]; highestSeq: number; branchSeqs: Set<number>; pairedResults: Map<number, number> };
/** The filters one selection applies before paging: as-given window and roles, seq bounds, and parsed epoch-ms time bounds. */
export type HistoryFilter = { window_id?: string | null; roles?: HistoryRole[] | null; after_seq?: number; before_seq?: number; sinceMs?: number; untilMs?: number };

/** Native entries after the adapter allocates seqs and selects the active branch. */
export type DecodedHistoryItem = {
	seq: number;
	windowId: string;
	role: "user" | "assistant" | "tool_call" | "tool" | "system" | "developer";
	/** Message body; for a tool call or result, the arguments or output text respectively. */
	text: string;
	createdAt?: string;
	toolName?: string;
	/** Internal pairing key; never serialized. */
	toolCallId?: string;
	/** The recorded arguments object, exactly as the host stored it. */
	arguments?: Record<string, unknown>;
	outputTruncated?: boolean;
	fullOutputPath?: string;
	/** The run reported an error. */
	toolError?: boolean;
	/** Native outcome for a standalone run (e.g. bash exit status). */
	recordedStatus?: ToolCallStatus;
	/** toolResult only: the calls this run made to other tools. */
	nestedCalls?: RecordedNestedCalls;
};

export type DecodedHistoryWindow = { windowId: string; createdAt?: string; items: DecodedHistoryItem[] };

function isTextContent(part: unknown): part is { type: "text"; text: string } {
	return typeof part === "object" && part !== null && (part as { type: "text"; text: string }).type === "text" && typeof (part as { type: "text"; text: string }).text === "string";
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter(isTextContent).map((part) => part.text).join("\n") : "";
}

function argumentText(execution: ToolExecutionFacts): string {
	return execution.arguments === undefined ? "(arguments not recorded)" : JSON.stringify(execution.arguments);
}

function nestedCallLine(call: NestedCallRecord): string {
	const parts = [`${call.id} ${call.name} [${call.status}]`];
	if (call.durationMs !== undefined) parts.push(`${call.durationMs}ms`);
	if (call.error !== undefined) parts.push(`error: ${call.error}`);
	parts.push(call.arguments === undefined ? (call.argumentsBytes === undefined ? "(arguments not recorded)" : `(arguments omitted: ${call.argumentsBytes} bytes)`) : JSON.stringify(call.arguments));
	return `- ${parts.join(" ")}`;
}

/** Canonical searchable/readable text, without UI headers or continuation footers. */
export function historyDocument(event: HistoryEvent): string {
	if (event.execution === undefined) return event.text;
	const sections = [`${event.execution.name} ${argumentText(event.execution)}`];
	// An unfinished call has no recorded output at all, and saying so by omission is truthful.
	if (event.text !== "") sections.push(`--- output ---\n${event.text}`);
	const nested = event.execution.nestedCalls;
	if (nested !== undefined) {
		const header = nested.complete ? "complete" : "incomplete";
		sections.push(`--- nested calls (${header}, ${nested.calls.length} recorded) ---\n${nested.calls.map(nestedCallLine).join("\n")}`);
	}
	return sections.join("\n");
}

const documents = new WeakMap<HistoryEvent, string>();

/** Memoized `historyDocument`: search, preview, and read must agree on the same characters. */
export function eventDocument(event: HistoryEvent): string {
	const cached = documents.get(event);
	if (cached !== undefined) return cached;
	const text = historyDocument(event);
	documents.set(event, text);
	return text;
}

/** Pair a call with its result, or preserve a standalone run's recorded outcome. */
function toolEvent(item: DecodedHistoryItem, result?: DecodedHistoryItem): HistoryEvent {
	const run = result ?? item;
	// Only a call without a result is unfinished; standalone results carry their own outcome.
	const status: ToolCallStatus = item.role === "tool_call" && result === undefined
		? "unfinished"
		: run.recordedStatus ?? (run.toolError === true ? "error" : "ok");
	const truncated = run.outputTruncated === true;
	return {
		seq: item.seq,
		windowId: item.windowId,
		role: "tool",
		text: result?.text ?? (item.role === "tool" ? item.text : ""),
		createdAt: item.createdAt,
		execution: {
			name: item.toolName ?? "unknown",
			status,
			// A call records its arguments; a bare result records none, and gets none invented.
			...(item.arguments === undefined ? {} : { arguments: item.arguments }),
			...(truncated ? { outputTruncated: true, ...(run.fullOutputPath ? { fullOutputPath: run.fullOutputPath } : {}) } : {}),
			...(run.nestedCalls ? { nestedCalls: run.nestedCalls } : {}),
		},
	};
}

/** Pair results into call events; consumed result seqs are not alternate read addresses. */
export function projectHistory(rawWindows: DecodedHistoryWindow[], highestSeq: number, branchSeqs: Set<number>): HistoryProjection {
	const raw = rawWindows.flatMap((current) => current.items);
	const resultsById = new Map<string, DecodedHistoryItem>();
	for (const item of raw) {
		if (item.role === "tool" && item.toolCallId && !resultsById.has(item.toolCallId)) resultsById.set(item.toolCallId, item);
	}
	const pairedResults = new Map<number, number>();
	const consumed = new Set<number>();
	const windows: HistoryWindow[] = rawWindows.map((current) => ({
		windowId: current.windowId,
		...(current.createdAt ? { createdAt: current.createdAt } : {}),
		items: current.items.flatMap((item): HistoryEvent[] => {
			if (consumed.has(item.seq)) return [];
			if (item.role === "tool_call") {
				const result = item.toolCallId ? resultsById.get(item.toolCallId) : undefined;
				const paired = result && result.seq > item.seq && !consumed.has(result.seq) ? result : undefined;
				if (paired) {
					consumed.add(paired.seq);
					pairedResults.set(paired.seq, item.seq);
				}
				return [toolEvent(item, paired)];
			}
			if (item.role === "tool") return [toolEvent(item)];
			return [{ seq: item.seq, windowId: item.windowId, role: item.role === "system" || item.role === "developer" ? "context" : item.role, text: item.text, createdAt: item.createdAt }];
		}),
	}));
	return { windows, highestSeq, branchSeqs, pairedResults };
}

/** Summary shared by list, search and read. Full arguments/calls are in the document. */
export const NestedCallSummarySchema = Type.Object({
	call_count: Type.Integer({ minimum: 0 }),
	complete: Type.Boolean({ description: "true = every nested call was recorded." }),
}, { additionalProperties: false });

/** Tool-run facts shared by list rows and reads; full arguments and calls live in the document. */
export const ToolSummarySchema = Type.Object({
	tool: Type.Optional(Type.String()),
	tool_status: Type.Optional(ToolCallStatusSchema),
	output_truncated: Type.Optional(Type.Literal(true)),
	full_output_path: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function toolSummary(event: HistoryEvent): Static<typeof ToolSummarySchema> {
	const execution = event.execution;
	if (!execution) return {};
	return {
		tool: execution.name,
		tool_status: execution.status,
		...(execution.outputTruncated ? { output_truncated: true } : {}),
		...(execution.fullOutputPath ? { full_output_path: execution.fullOutputPath } : {}),
	};
}

/** Nested-call evidence is read with one event, not listed on every page row. */
export function nestedCallSummary(event: HistoryEvent): { nested_calls?: Static<typeof NestedCallSummarySchema> } {
	const nested = event.execution?.nestedCalls;
	return nested === undefined ? {} : { nested_calls: { call_count: nested.calls.length, complete: nested.complete } };
}

/** Stable identity and a verbatim preview, starting at the search match when present. */
export const HistoryPageItemSchema = Type.Object({
	seq: Type.Integer({ minimum: 1 }),
	window_id: Type.String(),
	role: HistoryRoleSchema,
	created_at: Type.Union([Type.String(), Type.Null()]),
	...ToolSummarySchema.properties,
	content: Type.String(),
	truncated: Type.Boolean({ description: "Preview is partial." }),
	offset_chars: Type.Optional(Type.Integer({ minimum: 0, description: "Where the preview starts." })),
}, { additionalProperties: false });
export type HistoryPageItem = Static<typeof HistoryPageItemSchema>;

/** A run of tool/context events the conversation view replaces with counts. */
export const HistoryFoldedRowSchema = Type.Object({
	folded: Type.Literal(true),
	first_seq: Type.Integer({ minimum: 1 }),
	last_seq: Type.Integer({ minimum: 1 }),
	count: Type.Integer({ minimum: 1 }),
	tools: Type.Record(Type.String(), Type.Integer({ minimum: 1 }), { description: "Count per tool name." }),
}, { additionalProperties: false });
export type HistoryFoldedRow = Static<typeof HistoryFoldedRowSchema>;

/** Bound fold summaries; `count` stays exact even when some tool names do not fit. */
export const MAX_FOLD_TOOL_NAMES = 20;

/** Longest tool name a fold row lists. */
export const MAX_FOLD_TOOL_NAME_CHARS = 120;

/** A bounded preview of one event from `matchOffset` on, plus its identity facts. */
export function visibleItem(event: HistoryEvent, maxChars: number, matchOffset?: number): HistoryPageItem {
	const document = eventDocument(event);
	const chars = Array.from(document);
	const start = matchOffset ?? 0;
	const truncated = start > 0 || start + maxChars < chars.length;
	return {
		seq: event.seq,
		window_id: event.windowId,
		role: event.role,
		created_at: event.createdAt ?? null,
		...toolSummary(event),
		content: truncated ? chars.slice(start, start + maxChars).join("") : document,
		truncated,
		...(matchOffset === undefined ? {} : { offset_chars: matchOffset }),
	};
}

export function allItems(projection: HistoryProjection): HistoryEvent[] {
	return projection.windows.flatMap((current) => current.items);
}

export function unknownWindowId(projection: HistoryProjection, params: HistoryFilter): { message: string; known: string[] } | undefined {
	if (typeof params.window_id !== "string") return undefined;
	const known = projection.windows.map((current) => current.windowId);
	return known.includes(params.window_id) ? undefined : { message: `unknown window_id "${params.window_id}"`, known };
}

/**
 * Whether one event is inside the selection: its window, its seq bounds, and a half-open
 * [sinceMs, untilMs) window on created_at. A bounded time window drops events with no recorded
 * time or a time that cannot be read.
 */
export function inSelection(event: HistoryEvent, params: HistoryFilter): boolean {
	if (typeof params.window_id === "string" && params.window_id !== event.windowId) return false;
	if (params.after_seq !== undefined && event.seq <= params.after_seq) return false;
	if (params.before_seq !== undefined && event.seq >= params.before_seq) return false;
	if (params.sinceMs === undefined && params.untilMs === undefined) return true;
	if (event.createdAt === undefined) return false;
	const at = Date.parse(event.createdAt);
	return !Number.isNaN(at) && (params.sinceMs === undefined || at >= params.sinceMs) && (params.untilMs === undefined || at < params.untilMs);
}

/** Without roles or query a call shows the conversation; either one shows the requested events. */
export function filteredItems(projection: HistoryProjection, params: HistoryFilter, conversation: boolean): HistoryEvent[] {
	let items = allItems(projection).filter((item) => inSelection(item, params));
	if (params.roles) items = items.filter((item) => params.roles!.includes(item.role));
	if (!params.roles && conversation) items = items.filter((item) => (item.role === "user" || item.role === "assistant") && eventDocument(item) !== "");
	return items.sort((a, b) => a.seq - b.seq);
}