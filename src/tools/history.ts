/** Host-neutral history operations: one bounded payload for text and structured results. */
import { Type, type Static } from "typebox";
import { HISTORY_PREVIEW_CHARS, MAX_READ_WINDOW_CHARS } from "./output.js";
import { failure, fitsResult, resultSchema, readTextWindow, renderOutcome, renderTextWindow, success, TextWindowRequestSchema, TextWindowSchema, type Operation } from "./result.js";
import { historyRoles, searchQuery } from "./schema.js";
import { HistoryPageSchema, corpusSelection, selectCorpusPage, selectPage, type HistoryPage } from "../history/query.js";
import { currentHistory, loadHistorySession, matchesSession, parseSessionSelector, resolveSession, sessionIdentity, type HistoryContext } from "../history/corpus.js";
import { allItems, eventDocument, nestedCallSummary, toolSummary, HistoryRoleSchema, NestedCallSummarySchema, ToolSummarySchema, type HistoryFoldedRow, type HistoryPageItem } from "../history/history.js";

/** One read: identity, tool summary and a flat document slice. */
const HistoryReadDataSchema = Type.Object({
	session: Type.Optional(Type.String()),
	notice: Type.Optional(Type.String()),
	seq: Type.Integer({ minimum: 1 }),
	role: HistoryRoleSchema,
	created_at: Type.Union([Type.String(), Type.Null()]),
	...ToolSummarySchema.properties,
	nested_calls: Type.Optional(NestedCallSummarySchema),
	...TextWindowSchema.properties,
}, { additionalProperties: false });
type HistoryReadData = Static<typeof HistoryReadDataSchema>;

/* ------------------------------------------------------------------ rendering */

function header(item: { session?: string; seq: number; role: string }): string {
	return `${item.session === undefined ? "" : `session ${item.session} | `}seq ${item.seq} | ${item.role}`;
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
	const identity = row.session === undefined ? {} : { session: row.session };
	const expand = `\n\t→ expand: ${JSON.stringify({ ...identity, after_seq: row.first_seq - 1, before_seq: row.last_seq + 1, from: "oldest", roles: ["tool", "context"] })}`;
	return `${row.session === undefined ? "" : `session ${row.session} | `}seqs ${row.first_seq}-${row.last_seq} | folded ${row.count} events${tools ? ` | ${tools}` : ""}${expand}`;
}

function renderPage(page: HistoryPage): string {
	// An empty selection has no anchors either, so it would otherwise render as nothing at all.
	if (page.items.length === 0) return `${page.notice ?? ""}No events match these filters.`;
	const body = page.items.map((item) => ("folded" in item ? renderFoldedRow(item) : renderPageItem(item))).join("\n\n");
	const cursors = [
		page.page_older === null ? "" : `→ older: ${JSON.stringify(page.page_older)}`,
		page.page_newer === null ? "" : `→ newer: ${JSON.stringify(page.page_newer)}`,
	].filter((line) => line !== "");
	return (page.notice ?? "") + (cursors.length === 0 ? body : `${body}\n\n${cursors.join(" | ")}`);
}

function renderRead(data: HistoryReadData): string {
	const tool = toolHeader(data);
	const afterSeq = data.seq - 10;
	const neighborhood = `neighborhood → \`history_list\`(${JSON.stringify({ ...(data.session === undefined ? {} : { session: data.session }), ...(afterSeq >= 1 ? { after_seq: afterSeq } : {}), before_seq: data.seq + 10 })})`;
	return (data.notice ?? "") + [header(data), ...(tool ? [tool] : []), neighborhood, "", data.total_chars === 0 ? "No visible text recorded for this event." : renderTextWindow(data)].join("\n");
}

/* ------------------------------------------------------------------ shared bounding */

/** Pure host decoration, measured during selection and applied unchanged by the caller at delivery. */
export type HistoryTextWrapper = (text: string) => string;
const plainText: HistoryTextWrapper = (text) => text;

/* ------------------------------------------------------------------ history_list */

const sessionParameter = Type.Optional(Type.String({ minLength: 1, description: "(optional) Session ID or unique prefix, optionally pi:, claude:, codex:, or dsh:. Omit for this session. In history_list, * searches sessions (query required); history_read needs one session." }));

export const historyListParameters = Type.Object({
	session: sessionParameter,
	query: Type.Optional(searchQuery("(optional) Text, or a list of texts (any match). Empty text/list means no search filter; empty entries are ignored. Searches every role, tool arguments and output included; returns only hits.")),
	roles: historyRoles(),
	before_seq: Type.Optional(Type.Integer({ minimum: 1, description: "(optional) Only events with seq below this." })),
	after_seq: Type.Optional(Type.Integer({ minimum: 1, description: "(optional) Only events with seq above this." })),
	since: Type.Optional(Type.String({ minLength: 1, description: "(optional) ISO 8601 time; only events at or after it. UTC if no offset." })),
	until: Type.Optional(Type.String({ minLength: 1, description: "(optional) ISO 8601 time; only events before it. UTC if no offset." })),
	from: Type.Optional(Type.Union([Type.Literal("newest"), Type.Literal("oldest")], { description: "(optional, default newest) Which end `limit` counts from: newest or oldest. Results stay oldest first." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "(optional, default 20) Max events per page; folded rows don't count." })),
	max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `(optional, default ${HISTORY_PREVIEW_CHARS}) Max preview chars per event.` })),
}, { additionalProperties: false });

export const historyList: Operation<typeof historyListParameters, HistoryPage, [HistoryContext, HistoryTextWrapper?]> = {
	name: "history_list",
	label: "History list items",
	description: "Browse or search events, a page at a time. Omit session for this session; pass an ID/prefix for another, or * with query to search across local harnesses. Read one in full with `history_read`.",
	parameters: historyListParameters,
	outputSchema: resultSchema(HistoryPageSchema),
	async execute(params, context, wrapText = plainText) {
		// Charge wrapped rendering, identities, notices and recipes, not only event previews.
		const fits = (page: HistoryPage) => fitsResult(success(page), (result) => wrapText(renderOutcome(result, renderPage)));
		const maxChars = params.max_chars_per_item ?? HISTORY_PREVIEW_CHARS;
		if (params.session === undefined) return selectPage(await currentHistory(context), params, fits, maxChars);
		const selector = parseSessionSelector(params.session);
		if (!selector.ok) return selector;
		const corpus = "corpus" in context ? context.corpus : undefined;
		if (selector.data.wildcard) {
			const scoped = corpusSelection(params);
			if (!scoped.ok) return scoped;
			if (corpus === undefined) return failure("unknown_session", "This host supplied no cross-session history corpus.");
			const sessions = (await corpus.sessions(selector.data.harness)).filter((session) => matchesSession(session, selector.data));
			const loaded = [];
			const notices: string[] = [];
			for (const session of sessions) {
				const result = await loadHistorySession(session);
				if (!result.ok) return result;
				loaded.push({ session: sessionIdentity(session), projection: result.data.projection });
				if (result.data.notice) notices.push(`session ${sessionIdentity(session)}: ${result.data.notice}`);
			}
			const notice = notices.length ? { notice: notices.join("") } : {};
			const result = selectCorpusPage(loaded, scoped.data, (page) => fits({ ...page, ...notice }), maxChars);
			return result.ok ? success({ ...result.data, ...notice }) : result;
		}
		const target = await resolveSession(corpus, selector.data);
		if (!target.ok) return target;
		const loaded = await loadHistorySession(target.data);
		if (!loaded.ok) return loaded;
		const notice = loaded.data.notice === undefined ? {} : { notice: loaded.data.notice };
		const result = selectPage(loaded.data.projection, { ...params, session: sessionIdentity(target.data) }, (page) => fits({ ...page, ...notice }), maxChars);
		return result.ok ? success({ ...result.data, ...notice }) : result;
	},
	render: (result) => renderOutcome(result, renderPage),
};

/* ------------------------------------------------------------------ history_read */

export const historyReadParameters = Type.Object({ session: sessionParameter, seq: Type.Integer({ minimum: 1, description: "Event seq, from `history_list`. Pass its session too when present." }), ...TextWindowRequestSchema }, { additionalProperties: false });

export const historyRead: Operation<typeof historyReadParameters, HistoryReadData, [HistoryContext, HistoryTextWrapper?]> = {
	name: "history_read",
	label: "History read item",
	description: "Read one event in full: tool arguments, output, and nested calls.",
	parameters: historyReadParameters,
	outputSchema: resultSchema(HistoryReadDataSchema),
	async execute(params, context, wrapText = plainText) {
		let projection;
		let identity: { session?: string; notice?: string } = {};
		if (params.session === undefined) projection = await currentHistory(context);
		else {
			const selector = parseSessionSelector(params.session);
			if (!selector.ok) return selector;
			if (selector.data.wildcard) return failure("invalid_session", "`history_read` reads one session; pass a specific `session` ID, not a wildcard.");
			const target = await resolveSession("corpus" in context ? context.corpus : undefined, selector.data);
			if (!target.ok) return target;
			const loaded = await loadHistorySession(target.data);
			if (!loaded.ok) return loaded;
			projection = loaded.data.projection;
			identity = { session: sessionIdentity(target.data), ...(loaded.data.notice === undefined ? {} : { notice: loaded.data.notice }) };
		}
		const item = allItems(projection).find((event) => event.seq === params.seq);
		// Address checks run in one order: past the end of the file, off this branch, then
		// consumed by a pairing. Only the last two can mention what is at the address.
		if (item === undefined && params.seq > projection.highestSeq) {
			return failure("unknown_seq", `There is no seq ${params.seq}; this session runs from seq 1 to ${projection.highestSeq}.`);
		}
		if (!projection.branchSeqs.has(params.seq)) {
			if (identity.notice) return failure("unconfirmed_seq", `Seq ${params.seq} is outside the confirmed selected history; it may be on another branch or beyond an unresolved ancestry gap.`);
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
				...identity,
				seq: item.seq,
				role: item.role,
				created_at: item.createdAt ?? null,
				...toolSummary(item),
				...nestedCallSummary(item),
				...window,
			}),
			(result) => wrapText(renderOutcome(result, renderRead)),
		);
	},
	render: (result) => renderOutcome(result, renderRead),
};
