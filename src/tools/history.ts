/** Host-neutral history operations: one bounded payload for text and structured results. */
import { Type, type Static } from "typebox";
import { HISTORY_PREVIEW_CHARS, MAX_READ_WINDOW_CHARS, TOOL_OUTPUT_LIMIT } from "./output.js";
import { failure, success, type Outcome } from "../result.js";
import { fitsResult, resultSchema, readTextWindow, renderOutcome, renderTextWindow, TextWindowRequestSchema, TextWindowSchema, type Operation } from "./result.js";
import { historyRoles, searchQuery } from "./schema.js";
import { InvalidQueryError, searchQueries } from "../text-match.js";
import { HistoryPageSchema, CorpusCollector, isMultiPage, markMultiPage, selectPage, type HistoryPage, type HistoryPageResult, type HistorySelection } from "../history/query.js";
import { currentHistory, loadHistoryRepresentative, loadHistorySession, matchesSession, parseSessionSelector, resolveSession, sessionIdentity, type HistoryContext } from "../history/corpus.js";
import { allItems, eventDocument, nestedCallSummary, toolSummary, HistoryRoleSchema, NestedCallSummarySchema, ToolSummarySchema, type HistoryBound, type HistoryFoldedRow, type HistoryPageItem } from "../history/history.js";

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
	const lines = [header(item) + (item.context ? " | search context" : ""), ...(tool ? [tool] : [])];
	if (item.truncated) lines.push(`[truncated; from offset ${item.offset_chars ?? 0}]`);
	lines.push(item.content);
	return lines.join("\n");
}

function renderFoldedRow(row: HistoryFoldedRow): string {
	const tools = Object.entries(row.tools).map(([name, count]) => `${name} ${count}`).join(", ");
	const identity = row.session === undefined ? {} : { session: row.session };
	const expand = `\n\t→ expand: ${JSON.stringify({ ...identity, after: row.first_seq - 1, before: row.last_seq + 1, roles: ["tool", "context"] })}`;
	return `${row.session === undefined ? "" : `session ${row.session} | `}seqs ${row.first_seq}-${row.last_seq} | folded ${row.count} events${tools ? ` | ${tools}` : ""}${expand}`;
}

function renderPage(page: HistoryPage): string {
	// An empty selection has no anchors either, so it would otherwise render as nothing at all.
	if (page.items.length === 0 && !page.folded_after) return `${page.notice ?? ""}No events match these filters.`;
	const body = [...page.items.flatMap((item) => [...(item.folded_before ? [renderFoldedRow(item.folded_before)] : []), renderPageItem(item)]), ...(page.folded_after ? [renderFoldedRow(page.folded_after)] : [])].join("\n\n");
	if (isMultiPage(page)) {
		const directions = [page.has_older && "older", page.has_newer && "newer"].filter(Boolean).join("|");
		return (page.notice ?? "") + body + (directions ? `\n\n→ more ${directions} results: narrow with time bounds (after/before), query, roles or the session pattern` : "");
	}
	const hits = page.items.filter(item => !item.context);
	const first = hits[0]!;
	const last = hits.at(-1)!;
	const cursors = [
		page.has_older ? `→ older: ${JSON.stringify({ session: first.session, before: first.seq })}` : "",
		page.has_newer ? `→ newer: ${JSON.stringify({ session: last.session, after: last.seq })}` : "",
	].filter((line) => line !== "");
	return (page.notice ?? "") + (cursors.length === 0 ? body : `${body}\n\n${cursors.join(" | ")}`);
}

function renderRead(data: HistoryReadData): string {
	const tool = toolHeader(data);
	const neighborhood = `neighborhood → \`history_list\`(${JSON.stringify({ ...(data.session === undefined ? {} : { session: data.session }), after: Math.max(0, data.seq - 10), before: data.seq + 10 })})`;
	return (data.notice ?? "") + [header(data), ...(tool ? [tool] : []), neighborhood, "", data.total_chars === 0 ? "No visible text recorded for this event." : renderTextWindow(data)].join("\n");
}

/* ------------------------------------------------------------------ shared bounding */

/** Pure host decoration, measured during selection and applied unchanged by the caller at delivery. */
export type HistoryTextWrapper = (text: string) => string;
const plainText: HistoryTextWrapper = (text) => text;

/** Translate query budget facts into this tool's bounded refusal; successful pages are unchanged. */
function pageOutcome(result: HistoryPageResult): Outcome<HistoryPage> {
	if (!("pageTooLarge" in result)) return result;
	const { count, multi } = result.pageTooLarge;
	const narrow = multi ? "narrow the session pattern, query, roles or time bounds (`after`/`before`), or read one session/seq with `history_read`" : "narrow with `after`/`before`, pass `roles` to skip folding, or `history_read` one seq";
	return failure("page_too_large", `Even trimmed to their shortest, these ${count} rows${multi ? "" : " and their folded runs"} fill the ${TOOL_OUTPUT_LIMIT} a call can carry; ${narrow}.`);
}

/* ------------------------------------------------------------------ history_list */

const boundParameter = (description: string) => Type.Optional(Type.Union([Type.String(), Type.Number()], { description: `${description} Use a seq (number or digits) or ISO 8601 time (UTC without offset); wildcards take only times.` }));
export const historyListParameters = Type.Object({
	session: Type.Optional(Type.String({ minLength: 1, description: "Whose record: a session ID or prefix (pi:, claude:, codex:, dsh: allowed). Leave it out for this one. `*` means every recent session." })),
	roles: historyRoles(),
	query: Type.Optional(searchQuery("Text to look for, or a list (any match). Searches what was said, tool arguments and output.")),
	after: boundParameter("Start strictly after this bound, paging forward; 0 starts at the oldest event."),
	before: boundParameter("Stop strictly before this bound; without `after`, take the newest eligible events."),
	context: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Neighboring events on each side of a hit in its own session; requires a query." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "How many events or hits per page; folds and search context don't count." })),
	max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: "How much of each entry to show." })),
}, { additionalProperties: false });

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function parseBound(name: "after" | "before", value?: number | string): Outcome<HistoryBound | undefined> {
	if (value === undefined) return success(undefined);
	if (typeof value === "number" || /^\d+$/.test(value)) {
		const seq = Number(value);
		if (Number.isSafeInteger(seq) && seq >= 0) return success({ seq });
	} else if (typeof value === "string") {
		const match = ISO_8601.exec(value);
		const at = match ? Date.parse(match[1] ? value : `${value}Z`) : NaN;
		if (!Number.isNaN(at) && new Date(value.slice(0, 10)).toISOString().startsWith(value.slice(0, 10))) return success({ at });
	}
	return failure("invalid_bounds", `\`${name}\` must be a non-negative integer seq or an ISO 8601 time; got ${JSON.stringify(value)}.`);
}

function parseSelection(params: Static<typeof historyListParameters>): Outcome<HistorySelection> {
	const after = parseBound("after", params.after);
	if (!after.ok) return after;
	const before = parseBound("before", params.before);
	if (!before.ok) return before;
	try {
		const query = searchQueries(params.query);
		if (!query.length && params.context !== undefined) return failure("invalid_params", "`context` requires a non-empty `query`.");
		return success({ after: after.data, before: before.data, query: query.length ? query : undefined, roles: params.roles, context: params.context, limit: params.limit });
	} catch (error) {
		if (error instanceof InvalidQueryError) return failure("invalid_query", error.message);
		throw error;
	}
}

export const historyList: Operation<typeof historyListParameters, HistoryPage, [HistoryContext, HistoryTextWrapper?]> = {
	name: "history_list",
	label: "History list items",
	description: "Flip back through the record, a page at a time. Another session: its ID. `*` pulls every recent session off the shelf; add `query` to search them.",
	parameters: historyListParameters,
	outputSchema: resultSchema(HistoryPageSchema),
	async execute(params, context, wrapText = plainText) {
		const selection = parseSelection(params);
		if (!selection.ok) return selection;
		const scoped = selection.data;
		// Charge wrapped rendering, identities, notices and recipes, not only event previews.
		const fits = (page: HistoryPage) => fitsResult(success(page), (result) => wrapText(renderOutcome(result, renderPage)));
		const maxChars = params.max_chars_per_item ?? HISTORY_PREVIEW_CHARS;
		if (params.session === undefined) return pageOutcome(selectPage(await currentHistory(context), scoped, fits, maxChars));
		const selector = parseSessionSelector(params.session);
		if (!selector.ok) return selector;
		const corpus = "corpus" in context ? context.corpus : undefined;
		if (selector.data.wildcard) {
			const { after, before, query, roles } = scoped;
			if ((after && "seq" in after) || (before && "seq" in before)) return failure("invalid_bounds", "Wildcard history requires times, not seqs, for `after` and `before`.");
			if (corpus === undefined) return failure("unknown_session", "This host supplied no cross-session history corpus.");
			const sessions = (await corpus.sessions(selector.data.harness)).filter((session) => matchesSession(session, selector.data));
			if (!query) sessions.sort((a, b) => (after ? a.modifiedAt - b.modifiedAt : b.modifiedAt - a.modifiedAt) || sessionIdentity(a).localeCompare(sessionIdentity(b)));
			const representative = !query && !roles && !after && !before;
			const collector = new CorpusCollector(scoped);
			let qualifying = 0;
			const notices: string[] = [];
			let unvisited = false;
			for (const [index, session] of sessions.entries()) {
				const result = representative ? await loadHistoryRepresentative(session) : await loadHistorySession(session, query);
				if (!result.ok || !result.data) continue;
				const added = "projection" in result.data ? collector.add(sessionIdentity(session), result.data.projection) : collector.addRepresentative(sessionIdentity(session), result.data.event);
				if (!added) continue;
				qualifying++;
				if (result.data.notice) notices.push(`session ${sessionIdentity(session)}: ${result.data.notice}`);
				if (!query && qualifying >= Math.min(500, Math.max(1, params.limit ?? 20))) {
					unvisited = index + 1 < sessions.length;
					break;
				}
			}
			const notice = notices.length ? { notice: notices.join("") } : {};
			const result = pageOutcome(collector.page((page) => fits(markMultiPage({ ...page, ...notice })), maxChars, unvisited));
			return result.ok ? success(markMultiPage({ ...result.data, ...notice })) : result;
		}
		const target = await resolveSession(corpus, selector.data);
		if (!target.ok) return target;
		const loaded = await loadHistorySession(target.data);
		if (!loaded.ok) return loaded;
		const notice = loaded.data.notice === undefined ? {} : { notice: loaded.data.notice };
		const result = pageOutcome(selectPage(loaded.data.projection, { ...scoped, session: sessionIdentity(target.data) }, (page) => fits({ ...page, ...notice }), maxChars));
		return result.ok ? success({ ...result.data, ...notice }) : result;
	},
	render: (result) => renderOutcome(result, renderPage),
};

/* ------------------------------------------------------------------ history_read */

export const historyReadParameters = Type.Object({ session: Type.Optional(Type.String({ minLength: 1, description: "Whose record: a session ID or prefix. Leave it out for this one." })), seq: Type.Integer({ minimum: 1, description: "Which entry, by its seq from `history_list`; bring its session along if it had one." }), ...TextWindowRequestSchema }, { additionalProperties: false });

export const historyRead: Operation<typeof historyReadParameters, HistoryReadData, [HistoryContext, HistoryTextWrapper?]> = {
	name: "history_read",
	label: "History read item",
	description: "Open one entry: what was called, what came back, the calls nested inside. Long entries come in slices; follow `next_offset_chars`.",
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
		// Address checks run in one order: past the end of the file, off this branch, then
		// resolved through any tool-result pairing to its call event.
		if (params.seq > projection.highestSeq) {
			return failure("unknown_seq", `There is no seq ${params.seq}; this session runs from seq 1 to ${projection.highestSeq}.`);
		}
		if (!projection.branchSeqs.has(params.seq)) {
			if (identity.notice) return failure("unconfirmed_seq", `Seq ${params.seq} is outside the confirmed selected history; it may be on another branch or beyond an unresolved ancestry gap.`);
			return failure("not_on_branch", `Seq ${params.seq} is on another branch of this session; it can't be read from here.`);
		}
		const targetSeq = projection.pairedResults.get(params.seq) ?? params.seq;
		const item = allItems(projection).find((event) => event.seq === targetSeq);
		if (item === undefined) {
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
