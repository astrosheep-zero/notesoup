/** Stable-anchor paging, folding and literal matching. The operation supplies the full-response budget check. */
import { Type, type Static } from "typebox";
import { failure, success, type Outcome } from "../tools/result.js";
import { earliestMatchOffsetChars, prefixFit } from "../tools/output.js";
import { InvalidQueryError, searchQueries } from "../tools/schema.js";
import { allItems, eventDocument, filteredItems, visibleItem, HistoryFoldedRowSchema, HistoryPageItemSchema, MAX_FOLD_TOOL_NAMES, MAX_FOLD_TOOL_NAME_CHARS, type HistoryEvent, type HistoryFilter, type HistoryFoldedRow, type HistoryPageItem, type HistoryProjection } from "./history.js";

type PageRow = HistoryPageItem | HistoryFoldedRow;
type Candidate = { event: HistoryEvent; matchOffset?: number; preview?: HistoryPageItem };

/** Which end of one selection `limit` is taken from; page items always come back ascending. */
export type HistoryOrder = "newest" | "oldest";

/**
 * What one list call selects. Bounds choose a range; `order` chooses the end `limit` counts from;
 * a `query` keeps only matching events, across every role, with no folded rows.
 */
export type HistorySelection = HistoryFilter & {
	before?: number;
	after?: number;
	order?: HistoryOrder;
	limit?: number;
	query?: string | string[];
	max_chars_per_item?: number;
};

/** The params to merge into the previous call to continue toward older events. */
export const HistoryOlderSchema = Type.Object({
	before: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
/** The params to merge into the previous call to continue toward newer events. */
export const HistoryNewerSchema = Type.Object({
	after: Type.Integer({ minimum: 1 }),
	order: Type.Literal("oldest"),
}, { additionalProperties: false });

export const HistoryPageSchema = Type.Object({
	items: Type.Array(Type.Union([HistoryPageItemSchema, HistoryFoldedRowSchema])),
	page_older: Type.Union([HistoryOlderSchema, Type.Null()], { description: "Merge into your params to page older; null at the oldest end." }),
	page_newer: Type.Union([HistoryNewerSchema, Type.Null()], { description: "Merge into your params to page newer; null at the newest end." }),
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
	const named = { ...withoutName, tool_name_omitted: true };
	if (fits(named)) return named;
	return shrinkContent(named);
}

function isFoldableEvent(event: HistoryEvent): boolean {
	return event.role === "tool" || event.role === "context";
}

/** Only a call without roles or query folds tool/context runs. */
function foldsRuns(params: HistorySelection): boolean {
	return !params.roles && params.query === undefined;
}

/** Folded counts stay exact even when some distinct tool names must be omitted. */
function foldedRuns(events: HistoryEvent[]): HistoryFoldedRow[] {
	if (events.length === 0) return [];
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	const counts = new Map<string, number>();
	for (const event of sorted) {
		if (event.role !== "tool") continue;
		const name = event.execution?.name ?? "unknown";
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const entries = [...counts].filter(([name]) => name.length <= MAX_FOLD_TOOL_NAME_CHARS).slice(0, MAX_FOLD_TOOL_NAMES);
	// fromEntries preserves __proto__ as an ordinary key without mutating the prototype.
	const tools = Object.fromEntries(entries);
	const omitted = counts.size - entries.length;
	return [{ folded: true, first_seq: sorted[0]!.seq, last_seq: sorted.at(-1)!.seq, count: sorted.length, tools, ...(omitted > 0 ? { omitted_tools: omitted } : {}) }];
}

/** A cursor exists only when the same selection still has a visible event past that end. */
function pageCursors(vis: HistoryEvent[], selected: HistoryEvent[], before: number | undefined, after: number | undefined): Pick<HistoryPage, "page_older" | "page_newer"> {
	if (selected.length === 0) return { page_older: null, page_newer: null };
	const lower = after ?? 0;
	const upper = before ?? Number.POSITIVE_INFINITY;
	// Selected events are in seq order.
	const first = selected[0]!.seq;
	const last = selected.at(-1)!.seq;
	return {
		page_older: vis.some((event) => event.seq > lower && event.seq < first) ? { before: first } : null,
		page_newer: vis.some((event) => event.seq > last && event.seq < upper) ? { after: last, order: "oldest" } : null,
	};
}

function foldRows(projection: HistoryProjection, params: HistorySelection, selected: HistoryEvent[], cursors: Pick<HistoryPage, "page_older" | "page_newer">): HistoryFoldedRow[] {
	const lower = params.after ?? 0;
	const upper = params.before ?? Number.POSITIVE_INFINITY;
	if (selected.length === 0) {
		// Even a range with no conversation can contain tool/context events.
		const hidden = allItems(projection).filter((event) => (typeof params.window_id !== "string" || params.window_id === event.windowId) && event.seq > lower && event.seq < upper && isFoldableEvent(event));
		return foldedRuns(hidden);
	}
	const windowEvents = allItems(projection)
		.filter((event) => (typeof params.window_id !== "string" || params.window_id === event.windowId) && event.seq > lower && event.seq < upper)
		.sort((a, b) => a.seq - b.seq);
	const folded: HistoryFoldedRow[] = [];
	const firstSeq = selected[0]!.seq;
	const lastSeq = selected.at(-1)!.seq;
	if (cursors.page_older === null) folded.push(...foldedRuns(windowEvents.filter((event) => event.seq < firstSeq && isFoldableEvent(event))));
	// pageData already ordered selected by seq.
	for (let i = 0; i + 1 < selected.length; i++) {
		const left = selected[i]!.seq;
		const right = selected[i + 1]!.seq;
		folded.push(...foldedRuns(windowEvents.filter((event) => event.seq > left && event.seq < right && isFoldableEvent(event))));
	}
	if (cursors.page_newer === null) folded.push(...foldedRuns(windowEvents.filter((event) => event.seq > lastSeq && isFoldableEvent(event))));
	return folded;
}

function pageData(projection: HistoryProjection, params: HistorySelection, vis: HistoryEvent[], selected: Candidate[], maxChars: number, folds: boolean): HistoryPage {
	const orderedSelected = [...selected].sort((a, b) => a.event.seq - b.event.seq);
	const selectedEvents = orderedSelected.map((candidate) => candidate.event);
	const cursors = pageCursors(vis, selectedEvents, params.before, params.after);
	const visible = orderedSelected.map((candidate) => candidate.preview ?? visibleItem(candidate.event, maxChars, candidate.matchOffset));
	let rows: PageRow[] = visible;
	if (folds) {
		const folded = foldRows(projection, params, selectedEvents, cursors);
		rows = [...visible, ...folded].sort((a, b) => ("folded" in a ? a.first_seq : a.seq) - ("folded" in b ? b.first_seq : b.seq));
	}
	return { items: rows, ...cursors };
}

/** Filter, then keep only literal matches when a query is present. Query shape errors refuse here. */
function selectionCandidates(projection: HistoryProjection, params: HistorySelection): Outcome<Candidate[]> {
	let queries: string[] | undefined;
	if (params.query !== undefined) {
		try {
			queries = searchQueries(params.query);
		} catch (error) {
			if (error instanceof InvalidQueryError) return failure("invalid_query", error.message);
			throw error;
		}
	}
	const events = filteredItems(projection, params, queries === undefined);
	if (queries === undefined) return success(events.map((event) => ({ event })));
	const needles = queries;
	return success(events
		.map((event) => ({ event, matchOffset: earliestMatchOffsetChars(eventDocument(event), needles) }))
		.filter((candidate) => candidate.matchOffset >= 0));
}

/**
 * Take the limit from the end `order` names, starting there so a budget for one row keeps the most
 * important row. Bounds select a range; they never state a direction.
 */
function orderedCandidates(vis: Candidate[], params: HistorySelection, limit: number): Candidate[] {
	const ascending = [...vis]
		.sort((a, b) => a.event.seq - b.event.seq)
		.filter((candidate) => (params.after === undefined || candidate.event.seq > params.after) && (params.before === undefined || candidate.event.seq < params.before));
	const selected = params.order === "oldest" ? ascending.slice(0, limit) : ascending.slice(-limit);
	return params.order === "oldest" ? selected : selected.reverse();
}

/** Grow the page in selection order; shorten the first preview only when no full row fits. */
export function selectPage(projection: HistoryProjection, params: HistorySelection, fits: (page: HistoryPage) => boolean, maxChars: number): Outcome<HistoryPage> {
	const candidates = selectionCandidates(projection, params);
	if (!candidates.ok) return candidates;
	const vis = candidates.data;
	const limit = params.limit ?? 20;
	const folds = foldsRuns(params);
	const ordered = orderedCandidates(vis, params, limit);
	const allVisible = vis.map((candidate) => candidate.event).sort((a, b) => a.seq - b.seq);
	const kept: Candidate[] = [];
	for (const candidate of ordered) {
		if (fits(pageData(projection, params, allVisible, [...kept, candidate], maxChars, folds))) {
			kept.push(candidate);
			continue;
		}
		if (kept.length === 0) kept.push({ ...candidate, preview: truncateHistoryItem(visibleItem(candidate.event, maxChars, candidate.matchOffset), (preview) => fits(pageData(projection, params, allVisible, [{ ...candidate, preview }], maxChars, folds))) });
		break;
	}
	const page = pageData(projection, params, allVisible, kept, maxChars, folds);
	if (!fits(page)) {
		return failure("page_too_large", `${page.items.length} history rows and their fold summary do not fit one response even at their smallest; narrow the range with before/after or read one seq`, { rows: page.items.length });
	}
	return success(page);
}
