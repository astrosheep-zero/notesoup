/** Budget primitives. Notes/history use result.ts; reset/budget tools retain output(). */
export const TOOL_OUTPUT_MAX_BYTES = 32 * 1024;
/** The per-call limit as the model reads it in refusals. */
export const TOOL_OUTPUT_LIMIT = `${TOOL_OUTPUT_MAX_BYTES / 1024} KB`;
export const DEFAULT_READ_WINDOW_CHARS = 12000;
export const MAX_READ_WINDOW_CHARS = 50000;
export const HISTORY_PREVIEW_CHARS = 1200;

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
 * Encode a structured result through the common tool result boundary. `details` is slim
 * metadata for logs/UI (pi convention: never a second copy of the payload) and stays
 * undefined unless the tool has metadata worth persisting.
 */
export function output(value: unknown, details?: unknown, terminate = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details, terminate };
}
