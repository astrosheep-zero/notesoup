/** Stable-anchor paging, folding and literal matching. The operation supplies the full-response budget check. */
import { Type, type Static } from "typebox";
import { failure, success, type Outcome } from "../tools/result.js";
import { prefixFit, TOOL_OUTPUT_LIMIT } from "../tools/output.js";
import { earliestMatchOffsetChars } from "../text-match.js";
import { InvalidQueryError, searchQueries } from "../tools/schema.js";
import { eventDocument, filteredItems, visibleItem, HistoryFoldedRowSchema, HistoryPageItemSchema, MAX_FOLD_TOOL_NAMES, MAX_FOLD_TOOL_NAME_CHARS, type HistoryEvent, type HistoryFilter, type HistoryFoldedRow, type HistoryPageItem, type HistoryProjection } from "./history.js";

type Candidate = { event: HistoryEvent; session?: string; matchOffset?: number; preview?: HistoryPageItem; before?: HistoryFoldedRow };
type PreparedSelection = { candidates: Candidate[]; tail?: HistoryFoldedRow; session?: string; multi?: boolean };

/** Which end of one selection `limit` is taken from; page items always come back ascending. */
export type HistoryOrder = "newest" | "oldest";

/**
 * What one list call selects. `before_seq`/`after_seq` choose a seq range and `since`/`until` a time
 * range; `from` chooses the end `limit` counts from; a `query` keeps only matching events, across
 * every role, with no folded rows.
 */
export type HistorySelection = HistoryFilter & {
	session?: string;
	from?: HistoryOrder;
	limit?: number;
	query?: string | string[];
	since?: string;
	until?: string;
	max_chars_per_item?: number;
};

/** ISO 8601 date or date-time; the offset is optional (group 1) and a missing one is read as UTC. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Epoch ms for one optional time param, or a refusal naming it. */
function timeBound(name: "since" | "until", value: string | undefined): Outcome<number | undefined> {
	if (value === undefined) return success(undefined);
	const match = ISO_8601.exec(value);
	const at = match === null ? undefined : Date.parse(match[1] === undefined ? `${value}Z` : value);
	return at === undefined || Number.isNaN(at) ? failure("invalid_time", `\`${name}\` isn't an ISO 8601 time: "${value}".`) : success(at);
}

/** Parse `since`/`until`; a malformed or inverted pair refuses here. */
function resolveTimeBounds(params: HistorySelection): Outcome<{ sinceMs?: number; untilMs?: number }> {
	const since = timeBound("since", params.since);
	if (!since.ok) return since;
	const until = timeBound("until", params.until);
	if (!until.ok) return until;
	if (since.data !== undefined && until.data !== undefined && since.data >= until.data) {
		return failure("invalid_time", "`since` must be earlier than `until`.");
	}
	return success({ ...(since.data === undefined ? {} : { sinceMs: since.data }), ...(until.data === undefined ? {} : { untilMs: until.data }) });
}

/** The params to merge into the previous call to continue toward older events. */
export const HistoryOlderSchema = Type.Object({
	session: Type.Optional(Type.String()),
	before_seq: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
/** The params to merge into the previous call to continue toward newer events. */
export const HistoryNewerSchema = Type.Object({
	session: Type.Optional(Type.String()),
	after_seq: Type.Integer({ minimum: 1 }),
	from: Type.Literal("oldest"),
}, { additionalProperties: false });

export const HistoryPageSchema = Type.Object({
	notice: Type.Optional(Type.String()),
	items: Type.Array(Type.Union([HistoryPageItemSchema, HistoryFoldedRowSchema])),
	page_older: Type.Union([HistoryOlderSchema, Type.Null()]),
	page_newer: Type.Union([HistoryNewerSchema, Type.Null()]),
}, { additionalProperties: false });

/** One whole page payload, before it becomes an outcome. */
export type HistoryPage = Static<typeof HistoryPageSchema>;

/** Shorten preview text first; omit an oversized tool name rather than invent a partial name. */
function truncateHistoryItem(item: HistoryPageItem, fits: (candidate: HistoryPageItem) => boolean): HistoryPageItem {
	if (fits(item)) return item;
	const shrinkContent = (base: HistoryPageItem): HistoryPageItem => ({
		...base,
		truncated: true,
		content: prefixFit(base.content, (candidate) => fits({ ...base, truncated: true, content: candidate })),
	});
	const withContent = shrinkContent(item);
	if (fits(withContent)) return withContent;
	if (item.tool === undefined) return withContent;
	const { tool: _dropped, ...withoutName } = item;
	return fits(withoutName) ? withoutName : shrinkContent(withoutName);
}

/** Summarize one already ordered gap; omitted tool names never change its exact count. */
function foldedRun(events: HistoryEvent[], session?: string): HistoryFoldedRow | undefined {
	if (events.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const event of events) {
		if (event.role !== "tool") continue;
		const name = event.execution?.name ?? "unknown";
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const entries = [...counts].filter(([name]) => name.length <= MAX_FOLD_TOOL_NAME_CHARS).slice(0, MAX_FOLD_TOOL_NAMES);
	// fromEntries preserves __proto__ as an ordinary key without mutating the prototype.
	const tools = Object.fromEntries(entries);
	return { ...(session === undefined ? {} : { session }), folded: true, first_seq: events[0]!.seq, last_seq: events.at(-1)!.seq, count: events.length, tools };
}

/** Filter and order once. Conversation candidates own the folded gap immediately before them. */
function prepareSelection(projection: HistoryProjection, params: HistorySelection): PreparedSelection {
	const folds = !params.roles && params.query === undefined;
	const candidates: Candidate[] = [];
	let run: HistoryEvent[] = [];
	for (const event of filteredItems(projection, params, false)) {
		if (folds && (event.role === "tool" || event.role === "context")) {
			run.push(event);
			continue;
		}
		// Tool/thinking-only envelopes are not dialogue, even with explicit roles.
		if ((event.role === "user" || event.role === "assistant") && eventDocument(event) === "") continue;
		const matchOffset = params.query === undefined ? undefined : earliestMatchOffsetChars(eventDocument(event), params.query as string[]);
		if (matchOffset !== undefined && matchOffset < 0) continue;
		candidates.push({ event, ...(params.session === undefined ? {} : { session: params.session }), matchOffset, before: foldedRun(run, params.session) });
		run = [];
	}
	return { candidates, session: params.session, tail: foldedRun(run, params.session) };
}

/** Assemble only the admitted interval. Edge folds belong only to a page reaching that edge. */
function pageData(prepared: PreparedSelection, start: number, end: number, maxChars: number, preview?: HistoryPageItem): HistoryPage {
	const { candidates, tail } = prepared;
	const identity = prepared.session === undefined ? {} : { session: prepared.session };
	const items: HistoryPage["items"] = [];
	for (let index = start; index < end; index++) {
		const candidate = candidates[index]!;
		if (candidate.before && (index > start || start === 0)) items.push(candidate.before);
		items.push(preview ?? (candidate.preview ??= { ...visibleItem(candidate.event, maxChars, candidate.matchOffset), ...(candidate.session === undefined ? {} : { session: candidate.session }) }));
	}
	if (end === candidates.length && tail) items.push(tail);
	return {
		items,
		page_older: !prepared.multi && start > 0 && start < end ? { ...identity, before_seq: candidates[start]!.event.seq } : null,
		page_newer: !prepared.multi && end < candidates.length && start < end ? { ...identity, after_seq: candidates[end - 1]!.event.seq, from: "oldest" } : null,
	};
}

/**
 * Resolve the time bounds once, then filter and fold against the same [sinceMs, untilMs) window.
 * Grow the page in selection order; shorten the first preview only when no full row fits.
 */
function resolveSelection(params: HistorySelection): Outcome<HistorySelection> {
	const bounds = resolveTimeBounds(params);
	if (!bounds.ok) return bounds;
	try {
		const queries = searchQueries(params.query);
		return success({ ...params, ...bounds.data, query: queries.length ? queries : undefined });
	} catch (error) {
		if (error instanceof InvalidQueryError) return failure("invalid_query", error.message);
		throw error;
	}
}

export function selectPage(projection: HistoryProjection, params: HistorySelection, fits: (page: HistoryPage) => boolean, maxChars: number): Outcome<HistoryPage> {
	const scoped = resolveSelection(params);
	if (!scoped.ok) return scoped;
	return selectPrepared(prepareSelection(projection, scoped.data), scoped.data, fits, maxChars);
}

/** Validate before corpus discovery or I/O: per-session seqs cannot bound a multi-session search. */
export function corpusSelection(params: HistorySelection): Outcome<HistorySelection> {
	if (params.before_seq !== undefined || params.after_seq !== undefined) return failure("invalid_bounds", "`before_seq` and `after_seq` are per-session; omit them for wildcard session search.");
	return resolveSelection(params);
}

/** One topic per session, after role/time filtering; empty dialogue envelopes are not visible. */
export function sessionRepresentative(projection: HistoryProjection, scoped: HistorySelection): HistoryEvent | undefined {
	const events = filteredItems(projection, scoped, false).filter((event) =>
		(event.role !== "user" && event.role !== "assistant") || eventDocument(event) !== "");
	if (scoped.roles) return events.at(-1);
	return events.find((event) => event.role === "user")
		?? events.filter((event) => event.role === "assistant").at(-1)
		?? events.at(-1);
}

/** Merge hits or session representatives, never folds or per-session cursors. Timestamp ties use identity. */
export function selectCorpusPage(sessions: { session: string; projection: HistoryProjection }[], scoped: HistorySelection, fits: (page: HistoryPage) => boolean, maxChars: number): Outcome<HistoryPage> {
	const candidates = sessions.flatMap(({ session, projection }): Candidate[] => {
		if (scoped.query !== undefined) return prepareSelection(projection, { ...scoped, session }).candidates;
		const event = sessionRepresentative(projection, scoped);
		return event === undefined ? [] : [{ session, event }];
	});
	const time = (event: HistoryEvent) => event.createdAt === undefined || Number.isNaN(Date.parse(event.createdAt)) ? -Infinity : Date.parse(event.createdAt);
	candidates.sort((a, b) => (time(a.event) - time(b.event) || a.session!.localeCompare(b.session!) || a.event.seq - b.event.seq));
	return selectPrepared({ candidates, multi: true }, scoped, fits, maxChars);
}

function selectPrepared(prepared: PreparedSelection, scoped: HistorySelection, fits: (page: HistoryPage) => boolean, maxChars: number): Outcome<HistoryPage> {
	const { candidates } = prepared;
	// Grow a contiguous interval from the requested end; even a byte-limited newest page stays ascending.
	const newest = scoped.from !== "oldest";
	let start = newest ? candidates.length : 0;
	let end = start;
	const limit = Math.max(1, scoped.limit ?? 20);
	for (let count = 0; count < limit && (newest ? start > 0 : end < candidates.length); count++) {
		const nextStart = newest ? start - 1 : start;
		const nextEnd = newest ? end : end + 1;
		if (fits(pageData(prepared, nextStart, nextEnd, maxChars))) {
			start = nextStart;
			end = nextEnd;
			continue;
		}
		if (start === end) {
			start = nextStart;
			end = nextEnd;
			const candidate = candidates[start]!;
			candidate.preview = truncateHistoryItem(candidate.preview!, (preview) => fits(pageData(prepared, start, end, maxChars, preview)));
		}
		break;
	}
	const page = pageData(prepared, start, end, maxChars);
	if (!fits(page)) {
		const narrow = prepared.multi ? "narrow the session pattern, query, roles or `since`/`until`, or read one session/seq with `history_read`" : "narrow with `before_seq`/`after_seq` or `since`/`until`, pass `roles` to skip folding, or `history_read` one seq";
		return failure("page_too_large", `Even trimmed to their shortest, these ${page.items.length} rows${prepared.multi ? "" : " and their folded runs"} fill the ${TOOL_OUTPUT_LIMIT} a call can carry; ${narrow}.`);
	}
	return success(page);
}
