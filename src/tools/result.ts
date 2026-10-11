/** Internal outcomes, compact wire results, and bounded read windows. */
import { Type, type Static, type TSchema } from "typebox";
import { DEFAULT_READ_WINDOW_CHARS, TOOL_OUTPUT_MAX_BYTES, withinTextBudget } from "./output.js";

/** The one refusal shape: `code` is a stable internal identifier, `message` the bounded reading. */
export const OperationErrorSchema = Type.Object({
	code: Type.String(),
	message: Type.String(),
}, { additionalProperties: false });
export type OperationError = Static<typeof OperationErrorSchema>;

/** `data` exists without `error`, never both, never neither. */
export type Outcome<T> = { ok: true; data: T } | { ok: false; error: OperationError };

export function success<T>(data: T): Outcome<T> {
	return { ok: true, data };
}

/** A code is an internal stable identifier and is never clipped; the dynamic message is the bounded surface. */
export const ERROR_MESSAGE_MAX_CHARS = 2000;

function boundedMessage(message: string): string {
	const chars = Array.from(message);
	return chars.length <= ERROR_MESSAGE_MAX_CHARS ? message : `${chars.slice(0, ERROR_MESSAGE_MAX_CHARS).join("")}…[truncated ${chars.length - ERROR_MESSAGE_MAX_CHARS} chars]`;
}

export function failure(code: string, message: string): Outcome<never> {
	return { ok: false, error: { code, message: boundedMessage(message) } };
}

/** Public results have no success envelope. `error` is reserved for a refusal message. */
export const WireErrorSchema = Type.Object({ error: Type.String(), code: Type.String() }, { additionalProperties: false });
export type WireError = Static<typeof WireErrorSchema>;
export type WireResult<T> = T | WireError;

export function wireResult<T>(result: Outcome<T>): WireResult<T> {
	if (result.ok) return result.data;
	const { code, message } = result.error;
	return { error: message, code };
}

export function resultSchema<S extends TSchema>(dataSchema: S) {
	return Type.Union([dataSchema, WireErrorSchema]);
}

/** A refusal reads as one short line; a success is the operation's own reading of its data. */
export function renderOutcome<T>(result: Outcome<T>, renderData: (data: T) => string): string {
	return result.ok ? renderData(result.data) : `error: ${result.error.code}: ${result.error.message}`;
}

/** Bytes of the structured payload as delivered: compact JSON, not the model-facing text. A value with no JSON representation has no size to measure. */
export function structuredBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * The one bound: the rendered text and the structured payload must both fit, and the rendered
 * measure covers everything the renderer puts around the payload, headers and footers included.
 */
export function fitsResult<T>(result: Outcome<T>, render: (result: Outcome<T>) => string): boolean {
	return withinTextBudget(render(result)) && structuredBytes(wireResult(result)) <= TOOL_OUTPUT_MAX_BYTES;
}

/** `text` is verbatim, with no marker inserted, so windows concatenate back into the source. */
export const TextWindowSchema = Type.Object({
	text: Type.String(),
	total_chars: Type.Integer({ minimum: 0 }),
	next_offset_chars: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], { description: "Continue at this code-point offset; null at EOF." }),
}, { additionalProperties: false });
export type TextWindow = Static<typeof TextWindowSchema>;

/**
 * Read one code-point window of `text` and build the operation's data around it. `offset` and
 * `limit` are the integers the parameter schema already admitted; a negative `offset` resolves to
 * `max(0, total + offset)`, and the caller refuses an offset past the end.
 *
 * An envelope that cannot fit even empty is refused instead of returned: a zero-length window
 * would resume at the offset it started from, so paging could never make progress.
 */
export function readTextWindow<T>(
	text: string,
	offset: number | undefined,
	limit: number | undefined,
	makeData: (window: TextWindow) => T,
	render: (result: Outcome<T>) => string,
): Outcome<T> {
	const chars = Array.from(text);
	const requested = offset ?? 0;
	const start = requested < 0 ? Math.max(0, chars.length + requested) : requested;
	const requestedChars = limit ?? DEFAULT_READ_WINDOW_CHARS;
	const range = Math.min(requestedChars, chars.length - start);
	const window = (delivered: number): TextWindow => {
		const end = start + delivered;
		return {
			text: chars.slice(start, end).join(""),
			total_chars: chars.length,
			next_offset_chars: end < chars.length ? end : null,
		};
	};
	const fits = (delivered: number): boolean => fitsResult(success(makeData(window(delivered))), render);
	// Test the full range first: its footer can disappear at the end of the document.
	if (fits(range)) return success(makeData(window(range)));
	let low = 0;
	let high = range;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(mid)) low = mid;
		else high = mid - 1;
	}
	if (low === 0) return failure("output_too_large", "The response metadata leaves no room for a progressing read window.");
	return success(makeData(window(low)));
}

/** The continuation line never becomes part of `window.text`, and a complete window has none. */
export function renderTextWindow(window: TextWindow): string {
	const next = window.next_offset_chars;
	return next === null ? window.text : `${window.text}\n\n[truncated; continue at offset_chars=${next}]`;
}

/** One outcome in, model-facing text out. */
export type Renderer<TData> = (result: Outcome<TData>) => string;

/** What both host adapters register: parameters in, canonical outcome out, and its text. */
export type Operation<TParams extends TSchema, TData, TRest extends readonly unknown[]> = {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TParams;
	/** Absent leaves concurrency to the host default. */
	readonly executionMode?: "sequential" | "parallel";
	/** Schema of wireResult(outcome), not the internal outcome envelope. */
	readonly outputSchema: TSchema;
	readonly execute: (params: Static<TParams>, ...rest: TRest) => Promise<Outcome<TData>>;
	readonly render: Renderer<TData>;
};
