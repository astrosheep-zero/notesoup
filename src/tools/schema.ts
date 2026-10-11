import { Type } from "typebox";
import { HistoryRoleSchema } from "../history/history.js";
export const nullableString = (description?: string) => Type.Optional(Type.Union([Type.String(), Type.Null()], description === undefined ? {} : { description }));
export const positiveInteger = () => Type.Optional(Type.Integer({ minimum: 1 }));
export const historyRoles = () => Type.Optional(Type.Array(HistoryRoleSchema, { minItems: 1, description: "(optional) Only these roles: user, assistant, tool, context. Omit to see the conversation with tool and context runs folded." }));

/** Search query parameter: one literal, or several literals combined with OR. */
export const searchQuery = (description?: string) => Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], description === undefined ? {} : { description });

/** Expected search-query refusal, distinct from any other Error an operation may raise. */
export class InvalidQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidQueryError";
	}
}

/**
 * Normalize a search `query` parameter into the literal needles to match.
 * A bare string is a one-element list, so single-query behavior is unchanged.
 * An empty list, a non-string element, or an empty string is refused rather than silently
 * searching for nothing: those are argument errors, not empty result sets. An empty string
 * matches every line and every item, so it can never be what the caller meant.
 */
export function searchQueries(query: unknown): string[] {
	const candidates = typeof query === "string" ? [query] : query;
	if (!Array.isArray(candidates) || candidates.length === 0) throw new InvalidQueryError("query must be a string or a non-empty array of strings");
	if (!candidates.every((candidate) => typeof candidate === "string")) throw new InvalidQueryError("query array elements must be strings");
	if (candidates.some((candidate) => candidate === "")) throw new InvalidQueryError("query strings must be non-empty: an empty query matches everything");
	return candidates as string[];
}
