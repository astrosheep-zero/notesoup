/** Host-neutral history operations: one bounded payload for text and structured results. */
import { Type, type Static } from "typebox";
import { DEFAULT_READ_WINDOW_CHARS, MAX_READ_WINDOW_CHARS, HISTORY_PREVIEW_CHARS } from "./output.js";
import { failure, fitsResult, resultSchema, readTextWindow, renderOutcome, renderTextWindow, success, TextWindowSchema, type Operation, type Outcome } from "./result.js";
import { historyRoles, searchQuery } from "./schema.js";
import { HistoryPageSchema, selectPage, type HistoryPage } from "../history/query.js";
import { allItems, eventDocument, toolSummary, HistoryRoleSchema, ToolSummarySchema, type HistoryFilter, type HistoryFoldedRow, type HistoryPageItem, type HistoryProjection, unknownWindowId } from "../history/history.js";

/** One read: identity, tool summary and a flat document slice. */
const HistoryReadDataSchema = Type.Object({
	seq: Type.Integer({ minimum: 1 }),
	window_id: Type.String(),
	role: HistoryRoleSchema,
	created_at: Type.Union([Type.String(), Type.Null()]),
	...ToolSummarySchema.properties,
	...TextWindowSchema.properties,
}, { additionalProperties: false });
type HistoryReadData = Static<typeof HistoryReadDataSchema>;

const HistoryWindowsDataSchema = Type.Object({
	session_id: Type.String(),
	windows: Type.Array(Type.Object({
		window_id: Type.String(),
		created_at: Type.Union([Type.String(), Type.Null()]),
		first_seq: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
		last_seq: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
		item_count: Type.Integer({ minimum: 0 }),
	}, { additionalProperties: false }), { description: "Oldest first." }),
	more: Type.Integer({ minimum: 0, description: "Omitted windows; `history_list` also supplies window ids." }),
}, { additionalProperties: false });
type HistoryWindowsData = Static<typeof HistoryWindowsDataSchema>;

/* ------------------------------------------------------------------ rendering */

function header(item: { seq: number; window_id: string; role: string }): string {
	return `seq ${item.seq} | window ${item.window_id} | ${item.role}`;
}

function toolHeader(item: { role: string; tool?: string; tool_name_omitted?: boolean; tool_status?: string; output_truncated?: boolean; full_output_path?: string; nested_calls?: { call_count: number; complete: boolean } }): string | undefined {
	if (item.role !== "tool") return undefined;
	const parts = [item.tool_name_omitted ? "tool name omitted" : `tool ${item.tool}`, `status ${item.tool_status}`];
	if (item.output_truncated) parts.push(`output truncated${item.full_output_path ? `, full text at ${item.full_output_path}` : ""}`);
	if (item.nested_calls) {
		parts.push(`nested calls ${item.nested_calls.call_count} recorded, ${item.nested_calls.complete ? "complete" : "incomplete"}`);
	}
	return parts.join(" | ");
}

function renderPageItem(item: HistoryPageItem): string {
	const tool = toolHeader(item);
	const lines = tool === undefined ? [header(item)] : [header(item), tool];
	if (item.truncated) lines.push(`[preview of ${item.total_chars} chars from offset ${item.offset_chars ?? 0}; read this seq for the rest]`);
	lines.push(item.content);
	return lines.join("\n");
}

function isFoldedRow(item: HistoryPageItem | HistoryFoldedRow): item is HistoryFoldedRow {
	return "folded" in item;
}

function renderFoldedRow(row: HistoryFoldedRow): string {
	const tools = Object.entries(row.tools).map(([name, count]) => `${name} ${count}`).join(", ");
	const omitted = row.omitted_tools ? ` | ${row.omitted_tools} distinct tool names omitted` : "";
	const expand = `\n\t→ expand: {"after":${row.first_seq - 1},"before":${row.last_seq + 1},"order":"oldest","roles":["tool","context"]}`;
	return `seqs ${row.first_seq}-${row.last_seq} | folded ${row.count} events${tools ? ` | ${tools}` : ""}${omitted}${expand}`;
}

function renderPage(page: HistoryPage): string {
	// An empty selection has no anchors either, so it would otherwise render as nothing at all.
	if (page.items.length === 0) return "no events match this selection";
	const body = page.items.map((item) => (isFoldedRow(item) ? renderFoldedRow(item) : renderPageItem(item))).join("\n\n");
	const cursors = [
		page.page_older === null ? "" : `→ older: ${JSON.stringify(page.page_older)}`,
		page.page_newer === null ? "" : `→ newer: ${JSON.stringify(page.page_newer)}`,
	].filter((line) => line !== "");
	return cursors.length === 0 ? body : `${body}\n\n${cursors.join(" | ")}`;
}

function renderRead(data: HistoryReadData): string {
	const tool = toolHeader(data);
	const after = data.seq - 10;
	const neighborhood = `neighborhood → \`history_list\`(${JSON.stringify({ ...(after >= 1 ? { after } : {}), before: data.seq + 10 })})`;
	return [header(data), ...(tool ? [tool] : []), neighborhood, "", renderTextWindow(data)].join("\n");
}

/* ------------------------------------------------------------------ shared bounding */

/** Include rendering and cursors in the budget, not just row contents. */
function pageFits(page: HistoryPage): boolean {
	return fitsResult(success(page), (result) => renderOutcome(result, renderPage));
}

// Sample known ids on errors without turning the refusal into a second listing.
const MAX_REPORTED_WINDOWS = 25;

export const PREVIOUS_WINDOW = "@previous";

/** Resolve "@previous" against oldest-first windows; every other value passes through. */
function resolveWindowId(projection: HistoryProjection, windowId: string | undefined): { ok: true; window_id: string | undefined } | { ok: false; outcome: Outcome<never> } {
	if (windowId !== PREVIOUS_WINDOW) return { ok: true, window_id: windowId };
	const previous = projection.windows.at(-2);
	if (previous !== undefined) return { ok: true, window_id: previous.windowId };
	const known = projection.windows.map((current) => current.windowId);
	return { ok: false, outcome: failure("unknown_window_id", `unknown window_id "${PREVIOUS_WINDOW}": this session has no window before the current one`, { window_id: windowId, known_windows: known.slice(0, MAX_REPORTED_WINDOWS) }) };
}

function badWindowId(projection: HistoryProjection, params: HistoryFilter): Outcome<never> | undefined {
	const badWindow = unknownWindowId(projection, params);
	if (!badWindow) return undefined;
	const known = badWindow.known;
	return failure("unknown_window_id", badWindow.message, {
		window_id: params.window_id,
		known_windows: known.slice(0, MAX_REPORTED_WINDOWS),
		...(known.length > MAX_REPORTED_WINDOWS ? { known_windows_omitted: known.length - MAX_REPORTED_WINDOWS } : {}),
	});
}

/* ------------------------------------------------------------------ history_windows */

export const historyWindowsParameters = Type.Object({}, { additionalProperties: false });

export const historyWindows: Operation<typeof historyWindowsParameters, HistoryWindowsData, [HistoryProjection, string]> = {
	name: "history_windows",
	label: "History list windows",
	description: "List session-history windows oldest first, with seq ranges. A fork has its own session_id.",
	parameters: historyWindowsParameters,
	outputSchema: resultSchema(HistoryWindowsDataSchema),
	async execute(_params, projection, sessionId) {
		const data: HistoryWindowsData = { session_id: sessionId, windows: [], more: projection.windows.length };
		const fits = (candidate: HistoryWindowsData) => fitsResult(success(candidate), (result) => renderOutcome(result, renderWindows));
		for (const window of projection.windows) {
			let first: number | null = null;
			let last: number | null = null;
			for (const event of window.items) {
				first = first === null ? event.seq : Math.min(first, event.seq);
				last = last === null ? event.seq : Math.max(last, event.seq);
			}
			const row = { window_id: window.windowId, created_at: window.createdAt ?? null, first_seq: first, last_seq: last, item_count: window.items.length };
			if (!fits({ ...data, windows: [...data.windows, row], more: data.more - 1 })) break;
			data.windows.push(row);
			data.more--;
		}
		return fits(data) ? success(data) : failure("output_too_large", "The session identity does not fit one `history_windows` response.");
	},
	render: (result) => renderOutcome(result, renderWindows),
};

function renderWindows(data: HistoryWindowsData): string {
	const lines = [`session ${data.session_id}`, ...data.windows.map((window) => `window ${window.window_id} | seqs ${window.first_seq ?? "-"}-${window.last_seq ?? "-"} | ${window.item_count} events`)];
	if (data.more > 0) lines.push(`${data.more} more windows not shown; \`history_list\` also reports window ids on events`);
	return lines.join("\n");
}

/* ------------------------------------------------------------------ history_list */

export const historyListParameters = Type.Object({
	query: Type.Optional(searchQuery("Optional. Case-insensitive literal, or an array of literals (OR), matched across all roles including tool arguments and output. Returns only hits; each preview starts at its match.")),
	roles: historyRoles(),
	before: Type.Optional(Type.Integer({ minimum: 1, description: "Optional. Upper bound: only events with seq strictly below this." })),
	after: Type.Optional(Type.Integer({ minimum: 1, description: "Optional. Lower bound: only events with seq strictly above this." })),
	since: Type.Optional(Type.String({ minLength: 1, description: "Optional. ISO 8601 time; only events at or after it. No offset means UTC; untimed events are dropped." })),
	until: Type.Optional(Type.String({ minLength: 1, description: "Optional. ISO 8601 time; only events before it. No offset means UTC; untimed events are dropped." })),
	order: Type.Optional(Type.Union([Type.Literal("newest"), Type.Literal("oldest")], { description: "Optional. Which end limit counts from: newest (default) or oldest. Items are always ascending by seq." })),
	window_id: Type.Optional(Type.String({ minLength: 1, description: `Optional. Limit to one context window. Values come from \`history_windows\` or any event; "${PREVIOUS_WINDOW}" names the window before the current one.` })),
	limit: Type.Optional(Type.Integer({ description: "Optional. Maximum visible items per page; folded rows do not count. Default 20." })),
	max_chars_per_item: Type.Optional(Type.Integer({ description: `Optional. Maximum preview characters per item (default ${HISTORY_PREVIEW_CHARS}); use \`history_read\` for full content.` })),
}, { additionalProperties: false });

export const historyList: Operation<typeof historyListParameters, HistoryPage, [HistoryProjection]> = {
	name: "history_list",
	label: "History list items",
	description: "Browse or search this session's events a page at a time. The footer prints the next call; read one event in full with `history_read`.",
	parameters: historyListParameters,
	outputSchema: resultSchema(HistoryPageSchema),
	async execute(params, projection) {
		const resolved = resolveWindowId(projection, params.window_id);
		if (!resolved.ok) return resolved.outcome;
		const scoped = { ...params, window_id: resolved.window_id };
		const badWindow = badWindowId(projection, scoped);
		if (badWindow) return badWindow;
		return selectPage(projection, scoped, pageFits, scoped.max_chars_per_item ?? HISTORY_PREVIEW_CHARS);
	},
	render: (result) => renderOutcome(result, renderPage),
};

/* ------------------------------------------------------------------ history_read */

export const historyReadParameters = Type.Object({
	seq: Type.Integer({ minimum: 1, description: "Event address from `history_list`." }),
	offset_chars: Type.Optional(Type.Integer({ description: "Code-point offset (default 0); negative counts from EOF." })),
	limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Max code points (default ${DEFAULT_READ_WINDOW_CHARS}); also bounded by output bytes.` })),
}, { additionalProperties: false });

export const historyRead: Operation<typeof historyReadParameters, HistoryReadData, [HistoryProjection]> = {
	name: "history_read",
	label: "History read item",
	description: "Read an event document by seq with a tool summary. Arguments, output and nested-call evidence are in the pageable text. Pass next_offset_chars as offset_chars until null. The footer prints a `history_list` call for the surrounding events.",
	parameters: historyReadParameters,
	outputSchema: resultSchema(HistoryReadDataSchema),
	async execute(params, projection) {
		const item = allItems(projection).find((event) => event.seq === params.seq);
		// Address checks run in one order: past the end of the file, off this branch, then
		// consumed by a pairing. Only the last two can mention what is at the address.
		if (item === undefined && params.seq > projection.highestSeq) {
			return failure("unknown_seq", `unknown seq ${params.seq}: this session's items run 1..${projection.highestSeq}`, { seq: params.seq, highest_seq: projection.highestSeq });
		}
		if (!projection.branchSeqs.has(params.seq)) {
			return failure("not_on_branch", `seq ${params.seq} is on another branch and is not readable here`, { seq: params.seq });
		}
		if (item === undefined) {
			const callSeq = projection.pairedResults.get(params.seq);
			if (callSeq !== undefined) {
				return failure("not_an_event", `seq ${params.seq} is a tool result already shown inside the call at seq ${callSeq}; read that seq instead`, { seq: params.seq, read_seq: callSeq });
			}
			return failure("unknown_seq", `seq ${params.seq} is on this branch but carries no readable event`, { seq: params.seq });
		}
		const document = eventDocument(item);
		const totalChars = Array.from(document).length;
		if (typeof params.offset_chars === "number" && params.offset_chars > totalChars) {
			return failure("invalid_offset", `offset_chars ${params.offset_chars} is past the end: the item has ${totalChars} chars; the largest legal offset is ${totalChars} (an empty end-read)`, { seq: item.seq, window_id: item.windowId, offset_chars: params.offset_chars, total_chars: totalChars });
		}
		return readTextWindow(
			document,
			params.offset_chars,
			params.limit_chars,
			(window) => ({
				seq: item.seq,
				window_id: item.windowId,
				role: item.role,
				created_at: item.createdAt ?? null,
				...toolSummary(item),
				...window,
			}),
			(result) => renderOutcome(result, renderRead),
		);
	},
	render: (result) => renderOutcome(result, renderRead),
};
