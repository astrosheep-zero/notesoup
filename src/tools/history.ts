/** Host-neutral history operations: one bounded payload for text and structured results. */
import { Type, type Static } from "typebox";
import { HISTORY_PREVIEW_CHARS, MAX_READ_WINDOW_CHARS, TOOL_OUTPUT_LIMIT } from "./output.js";
import { failure, fitsResult, resultSchema, readTextWindow, renderOutcome, renderTextWindow, success, TextWindowRequestSchema, TextWindowSchema, type Operation, type Outcome } from "./result.js";
import { historyRoles, searchQuery } from "./schema.js";
import { HistoryPageSchema, selectPage, type HistoryPage } from "../history/query.js";
import { allItems, eventDocument, nestedCallSummary, toolSummary, HistoryRoleSchema, NestedCallSummarySchema, ToolSummarySchema, type HistoryFilter, type HistoryFoldedRow, type HistoryPageItem, type HistoryProjection, unknownWindowId } from "../history/history.js";

/** One read: identity, tool summary and a flat document slice. */
const HistoryReadDataSchema = Type.Object({
	seq: Type.Integer({ minimum: 1 }),
	window_id: Type.String(),
	role: HistoryRoleSchema,
	created_at: Type.Union([Type.String(), Type.Null()]),
	...ToolSummarySchema.properties,
	nested_calls: Type.Optional(NestedCallSummarySchema),
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
	}, { additionalProperties: false })),
	more: Type.Integer({ minimum: 0, description: "How many more were left out." }),
}, { additionalProperties: false });
type HistoryWindowsData = Static<typeof HistoryWindowsDataSchema>;

/* ------------------------------------------------------------------ rendering */

function header(item: { seq: number; window_id: string; role: string }): string {
	return `seq ${item.seq} | window ${item.window_id} | ${item.role}`;
}

function toolHeader(item: { role: string; tool?: string; tool_status?: string; output_truncated?: true; full_output_path?: string; nested_calls?: { call_count: number; complete: boolean } }): string | undefined {
	if (item.role !== "tool") return undefined;
	const parts = [`tool ${item.tool}`, `status ${item.tool_status}`];
	if (item.output_truncated) parts.push(`output truncated${item.full_output_path ? `, full text at ${item.full_output_path}` : ""}`);
	if (item.nested_calls) {
		parts.push(`nested calls ${item.nested_calls.call_count} recorded, ${item.nested_calls.complete ? "complete" : "incomplete"}`);
	}
	return parts.join(" | ");
}

function renderPageItem(item: HistoryPageItem): string {
	const tool = toolHeader(item);
	const lines = tool === undefined ? [header(item)] : [header(item), tool];
	if (item.truncated) lines.push(`[truncated; from offset ${item.offset_chars ?? 0}]`);
	lines.push(item.content);
	return lines.join("\n");
}

function renderFoldedRow(row: HistoryFoldedRow): string {
	const tools = Object.entries(row.tools).map(([name, count]) => `${name} ${count}`).join(", ");
	const expand = `\n\t→ expand: {"after_seq":${row.first_seq - 1},"before_seq":${row.last_seq + 1},"from":"oldest","roles":["tool","context"]}`;
	return `seqs ${row.first_seq}-${row.last_seq} | folded ${row.count} events${tools ? ` | ${tools}` : ""}${expand}`;
}

function renderPage(page: HistoryPage): string {
	// An empty selection has no anchors either, so it would otherwise render as nothing at all.
	if (page.items.length === 0) return "No events match these filters.";
	const body = page.items.map((item) => ("folded" in item ? renderFoldedRow(item) : renderPageItem(item))).join("\n\n");
	const cursors = [
		page.page_older === null ? "" : `→ older: ${JSON.stringify(page.page_older)}`,
		page.page_newer === null ? "" : `→ newer: ${JSON.stringify(page.page_newer)}`,
	].filter((line) => line !== "");
	return cursors.length === 0 ? body : `${body}\n\n${cursors.join(" | ")}`;
}

function renderRead(data: HistoryReadData): string {
	const tool = toolHeader(data);
	const afterSeq = data.seq - 10;
	const neighborhood = `neighborhood → \`history_list\`(${JSON.stringify({ ...(afterSeq >= 1 ? { after_seq: afterSeq } : {}), before_seq: data.seq + 10 })})`;
	return [header(data), ...(tool ? [tool] : []), neighborhood, "", renderTextWindow(data)].join("\n");
}

/* ------------------------------------------------------------------ shared bounding */

/** Include rendering and cursors in the budget, not just row contents. */
function pageFits(page: HistoryPage): boolean {
	return fitsResult(success(page), (result) => renderOutcome(result, renderPage));
}

// Sample known ids in the refusal message itself, never as a second listing.
const MAX_REPORTED_WINDOWS = 5;

/** At most `MAX_REPORTED_WINDOWS` known ids, appended to an unknown_window_id message. */
function knownWindowSuffix(known: string[]): string {
	return known.length === 0 ? "" : `; its windows: ${known.slice(0, MAX_REPORTED_WINDOWS).join(", ")}`;
}

export const PREVIOUS_WINDOW = "@previous";

/** Resolve "@previous" against oldest-first windows; every other value passes through. */
function resolveWindowId(projection: HistoryProjection, windowId: string | undefined): { ok: true; window_id: string | undefined } | { ok: false; outcome: Outcome<never> } {
	if (windowId !== PREVIOUS_WINDOW) return { ok: true, window_id: windowId };
	const previous = projection.windows.at(-2);
	if (previous !== undefined) return { ok: true, window_id: previous.windowId };
	const known = projection.windows.map((current) => current.windowId);
	return { ok: false, outcome: failure("unknown_window_id", `"${PREVIOUS_WINDOW}" has nothing to point at: this session has no window before the current one${knownWindowSuffix(known)}.`) };
}

function badWindowId(projection: HistoryProjection, params: HistoryFilter): Outcome<never> | undefined {
	const badWindow = unknownWindowId(projection, params);
	if (!badWindow) return undefined;
	return failure("unknown_window_id", `${badWindow.message}${knownWindowSuffix(badWindow.known)}.`);
}

/* ------------------------------------------------------------------ history_windows */

export const historyWindowsParameters = Type.Object({}, { additionalProperties: false });

export const historyWindows: Operation<typeof historyWindowsParameters, HistoryWindowsData, [HistoryProjection, string]> = {
	name: "history_windows",
	label: "History list windows",
	description: "List this session's context windows, oldest first, with seq ranges.",
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
			const row = { window_id: window.windowId, created_at: window.createdAt ?? null, first_seq: first, last_seq: last };
			if (!fits({ ...data, windows: [...data.windows, row], more: data.more - 1 })) break;
			data.windows.push(row);
			data.more--;
		}
		return fits(data) ? success(data) : failure("output_too_large", `The session id alone fills the ${TOOL_OUTPUT_LIMIT} a call can carry.`);
	},
	render: (result) => renderOutcome(result, renderWindows),
};

function renderWindows(data: HistoryWindowsData): string {
	const lines = [`session ${data.session_id}`, ...data.windows.map((window) => `window ${window.window_id} | seqs ${window.first_seq ?? "-"}-${window.last_seq ?? "-"}`)];
	if (data.more > 0) lines.push(`${data.more} more windows not shown; every \`history_list\` event also names its window.`);
	return lines.join("\n");
}

/* ------------------------------------------------------------------ history_list */

export const historyListParameters = Type.Object({
	query: Type.Optional(searchQuery("(optional) Text, or a list of texts (any match). Empty text/list means no search filter; empty entries are ignored. Searches every role, tool arguments and output included; returns only hits.")),
	roles: historyRoles(),
	before_seq: Type.Optional(Type.Integer({ minimum: 1, description: "(optional) Only events with seq below this." })),
	after_seq: Type.Optional(Type.Integer({ minimum: 1, description: "(optional) Only events with seq above this." })),
	since: Type.Optional(Type.String({ minLength: 1, description: "(optional) ISO 8601 time; only events at or after it. UTC if no offset." })),
	until: Type.Optional(Type.String({ minLength: 1, description: "(optional) ISO 8601 time; only events before it. UTC if no offset." })),
	from: Type.Optional(Type.Union([Type.Literal("newest"), Type.Literal("oldest")], { description: "(optional, default newest) Which end `limit` counts from: newest or oldest. Results stay oldest first." })),
	window_id: Type.Optional(Type.String({ minLength: 1, description: `(optional) Only this context window. From \`history_windows\` or any event; \`${PREVIOUS_WINDOW}\` is the one before this.` })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "(optional, default 20) Max events per page; folded rows don't count." })),
	max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `(optional, default ${HISTORY_PREVIEW_CHARS}) Max preview chars per event.` })),
}, { additionalProperties: false });

export const historyList: Operation<typeof historyListParameters, HistoryPage, [HistoryProjection]> = {
	name: "history_list",
	label: "History list items",
	description: "Browse or search this session's events, a page at a time. Read one in full with `history_read`.",
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

export const historyReadParameters = Type.Object({ seq: Type.Integer({ minimum: 1, description: "Event seq, from `history_list`." }), ...TextWindowRequestSchema }, { additionalProperties: false });

export const historyRead: Operation<typeof historyReadParameters, HistoryReadData, [HistoryProjection]> = {
	name: "history_read",
	label: "History read item",
	description: "Read one event in full: tool arguments, output, and nested calls.",
	parameters: historyReadParameters,
	outputSchema: resultSchema(HistoryReadDataSchema),
	async execute(params, projection) {
		const item = allItems(projection).find((event) => event.seq === params.seq);
		// Address checks run in one order: past the end of the file, off this branch, then
		// consumed by a pairing. Only the last two can mention what is at the address.
		if (item === undefined && params.seq > projection.highestSeq) {
			return failure("unknown_seq", `There is no seq ${params.seq}; this session runs from seq 1 to ${projection.highestSeq}.`);
		}
		if (!projection.branchSeqs.has(params.seq)) {
			return failure("not_on_branch", `Seq ${params.seq} is on another branch of this session; it can't be read from here.`);
		}
		if (item === undefined) {
			const callSeq = projection.pairedResults.get(params.seq);
			if (callSeq !== undefined) {
				return failure("not_an_event", `Seq ${params.seq} is a tool result, shown together with its call; read seq ${callSeq} instead.`);
			}
			return failure("unknown_seq", `Seq ${params.seq} holds nothing to read.`);
		}
		const document = eventDocument(item);
		const totalChars = Array.from(document).length;
		if (typeof params.offset_chars === "number" && params.offset_chars > totalChars) {
			return failure("invalid_offset", `This event ends at char ${totalChars}; offset_chars ${params.offset_chars} is past the last word.`);
		}
		return readTextWindow(
			document,
			params.offset_chars,
			params.max_chars,
			(window) => ({
				seq: item.seq,
				window_id: item.windowId,
				role: item.role,
				created_at: item.createdAt ?? null,
				...toolSummary(item),
				...nestedCallSummary(item),
				...window,
			}),
			(result) => renderOutcome(result, renderRead),
		);
	},
	render: (result) => renderOutcome(result, renderRead),
};
