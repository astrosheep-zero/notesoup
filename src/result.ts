/** Shared outcomes and bounded refusals, independent of tool transport and output budgets. */
import { Type, type Static } from "typebox";

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

/** Bounded refusal: a runaway message is clipped with a marker instead of filling the wire. */
export function failure(code: string, message: string): Outcome<never> {
	const chars = Array.from(message);
	const bounded = chars.length <= ERROR_MESSAGE_MAX_CHARS ? message : `${chars.slice(0, ERROR_MESSAGE_MAX_CHARS).join("")}…[truncated ${chars.length - ERROR_MESSAGE_MAX_CHARS} chars]`;
	return { ok: false, error: { code, message: bounded } };
}
