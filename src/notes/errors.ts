export type NoteErrorCode = "not_found" | "already_exists" | "ambiguous_edit" | "no_match" | "invalid_edit" | "nothing_to_do" | "too_large" | "invalid_scope" | "invalid_origin" | "invalid_address" | "invalid_pattern" | "invalid_query" | "invalid_offset" | "io_error" | "internal_error";

/** Typed store refusal. Edit locations are exposed in camelCase. */
export class NoteError extends Error {
	readonly code: NoteErrorCode;
	readonly lineNumbers?: number[];
	readonly editIndex?: number;
	constructor(code: NoteErrorCode, message: string, extra: { lineNumbers?: number[]; editIndex?: number } = {}) {
		super(message);
		this.name = "NoteError";
		this.code = code;
		this.lineNumbers = extra.lineNumbers;
		this.editIndex = extra.editIndex;
	}
}

/** A refusal names the offending input; JSON quoting keeps control chars visible, and stringify misses get String(). */
export function shown(value: unknown): string {
	const json = JSON.stringify(value);
	return json === undefined ? String(value) : json;
}
