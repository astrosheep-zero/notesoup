/** Stable-anchor paging, folding and literal matching. The operation supplies the full-response budget check. */
import { Type, type Static } from "typebox";
import { failure, success, type Outcome } from "../tools/result.js";
import { prefixFit, TOOL_OUTPUT_LIMIT } from "../tools/output.js";
import { earliestMatchOffsetChars } from "../text-match.js";
import { InvalidQueryError, searchQueries } from "../tools/schema.js";
import { allItems, eventDocument, filteredItems, inSelection, visibleItem, HistoryFoldedRowSchema, HistoryPageItemSchema, MAX_FOLD_TOOL_NAMES, MAX_FOLD_TOOL_NAME_CHARS, type HistoryEvent, type HistoryFilter, type HistoryFoldedRow, type HistoryPageItem, type HistoryProjection } from "./history.js";

type PageRow = HistoryPageItem | HistoryFoldedRow;
type Candidate = { event: HistoryEvent; matchOffset?: number; preview?: HistoryPageItem };

/** Which end of one selection `limit` is taken from; page items always come back ascending. */
export type HistoryOrder = "newest" | "oldest";

/**
 * What one list call selects. `before_seq`/`after_seq` choose a seq range and `since`/`until` a time
 * range; `from` chooses the end `limit` counts from; a `query` keeps only matching events, across
 * every role, with no folded rows.
 */
export type HistorySelection = HistoryFilter & {
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
	before_seq: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
/** The params to merge into the previous call to continue toward newer events. */
export const HistoryNewerSchema = Type.Object({
	after_seq: Type.Integer({ minimum: 1 }),
	from: Type.Literal("oldest"),
}, { additionalProperties: false });

export const HistoryPageSchema = Type.Object({
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
	return [{ folded: true, first_seq: sorted[0]!.seq, last_seq: sorted.at(-1)!.seq, count: sorted.length, tools }];
}

/** A cursor exists only when the same selection still has a visible event past that end. */
function pageCursors(vis: HistoryEvent[], selected: HistoryEvent[], beforeSeq: number | undefined, afterSeq: number | undefined): Pick<HistoryPage, "page_older" | "page_newer"> {
	if (selected.length === 0) return { page_older: null, page_newer: null };
	const lower = afterSeq ?? 0;
	const upper = beforeSeq ?? Number.POSITIVE_INFINITY;
	// Selected events are in seq order.
	const first = selected[0]!.seq;
	const last = selected.at(-1)!.seq;
	return {
		page_older: vis.some((event) => event.seq > lower && event.seq < first) ? { before_seq: first } : null,
		page_newer: vis.some((event) => event.seq > last && event.seq < upper) ? { after_seq: last, from: "oldest" } : null,
	};
}

function foldRows(projection: HistoryProjection, params: HistorySelection, selected: HistoryEvent[], cursors: Pick<HistoryPage, "page_older" | "page_newer">): HistoryFoldedRow[] {
	if (selected.length === 0) {
		// Even a range with no conversation can contain tool/context events.
		return foldedRuns(allItems(projection).filter((event) => inSelection(event, params) && isFoldableEvent(event)));
	}
	const windowEvents = allItems(projection).filter((event) => inSelection(event, params)).sort((a, b) => a.seq - b.seq);
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
	const cursors = pageCursors(vis, selectedEvents, params.before_seq, params.after_seq);
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
 * Resolve the time bounds once, then filter and fold against the same [sinceMs, untilMs) window.
 * Grow the page in selection order; shorten the first preview only when no full row fits.
 */
export function selectPage(projection: HistoryProjection, params: HistorySelection, fits: (page: HistoryPage) => boolean, maxChars: number): Outcome<HistoryPage> {
	const bounds = resolveTimeBounds(params);
	if (!bounds.ok) return bounds;
	const scoped = { ...params, ...bounds.data };
	const candidates = selectionCandidates(projection, scoped);
	if (!candidates.ok) return candidates;
	const vis = candidates.data;
	// Take the limit from the end `from` names, so a budget for one row keeps the most important one.
	// At least one: `slice(-0)` would otherwise return the whole selection.
	const limit = Math.max(1, scoped.limit ?? 20);
	const folds = foldsRuns(scoped);
	const ascending = [...vis].sort((a, b) => a.event.seq - b.event.seq);
	const ordered = scoped.from === "oldest" ? ascending.slice(0, limit) : ascending.slice(-limit).reverse();
	const allVisible = vis.map((candidate) => candidate.event).sort((a, b) => a.seq - b.seq);
	const kept: Candidate[] = [];
	for (const candidate of ordered) {
		if (fits(pageData(projection, scoped, allVisible, [...kept, candidate], maxChars, folds))) {
			kept.push(candidate);
			continue;
		}
		if (kept.length === 0) kept.push({ ...candidate, preview: truncateHistoryItem(visibleItem(candidate.event, maxChars, candidate.matchOffset), (preview) => fits(pageData(projection, scoped, allVisible, [{ ...candidate, preview }], maxChars, folds))) });
		break;
	}
	const page = pageData(projection, scoped, allVisible, kept, maxChars, folds);
	if (!fits(page)) {
		return failure("page_too_large", `Even trimmed to their shortest, these ${page.items.length} rows and their folded runs fill the ${TOOL_OUTPUT_LIMIT} a call can carry; narrow with \`before_seq\`/\`after_seq\` or \`since\`/\`until\`, pass \`roles\` to skip folding, or \`history_read\` one seq.`);
	}
	return success(page);
}
