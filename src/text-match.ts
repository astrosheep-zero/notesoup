/** Expected search-query refusal, distinct from any other Error an operation may raise. */
export class InvalidQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidQueryError";
	}
}

/** Missing/empty queries disable filtering; empty list entries are ignored, not OR wildcards. */
export function searchQueries(query: unknown): string[] {
	const candidates = query === undefined ? [] : typeof query === "string" ? [query] : query;
	if (!Array.isArray(candidates)) throw new InvalidQueryError("`query` must be a string or a list of strings.");
	if (!candidates.every((candidate) => typeof candidate === "string")) throw new InvalidQueryError("Every item in the `query` list must be a string.");
	return candidates.filter((candidate) => candidate !== "") as string[];
}

/** Longest fitting code-point prefix, without inserted markers. Callers report omissions. */
export function prefixFit(text: string, fits: (content: string) => boolean): string {
	if (fits(text)) return text;
	const chars = Array.from(text);
	// Serialized size is non-decreasing in the kept count, so the largest fitting prefix is
	// found by a monotone binary search instead of a quadratic shrink loop.
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(chars.slice(0, mid).join(""))) low = mid;
		else high = mid - 1;
	}
	return chars.slice(0, low).join("");
}

/**
 * Code-point offset of the earliest case-insensitive literal match, or -1 when
 * none occurs. Match against the original text so Unicode casing cannot shift offsets.
 */
export function earliestMatchOffsetChars(text: string, queries: string[]): number {
	let earliest = -1;
	for (const query of queries) {
		const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const index = new RegExp(literal, "iu").exec(text)?.index ?? -1;
		if (index < 0) continue;
		if (earliest < 0 || index < earliest) earliest = index;
	}
	return earliest < 0 ? -1 : Array.from(text.slice(0, earliest)).length;
}
