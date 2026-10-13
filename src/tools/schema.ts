import { Type } from "typebox";
import { HistoryRoleSchema } from "../history/history.js";
export const nullableString = (description?: string) => Type.Optional(Type.Union([Type.String(), Type.Null()], description === undefined ? {} : { description }));
export const historyRoles = () => Type.Optional(Type.Array(HistoryRoleSchema, { minItems: 1, description: "(optional) Only these roles: user, assistant, tool, context. Omit to see the conversation with tool and context runs folded." }));

/** Search query parameter: one literal, or several literals combined with OR. */
export const searchQuery = (description = "(optional) Literal text, or texts combined with OR. Empty text or list means no search filter.") => Type.Union([Type.String(), Type.Array(Type.String())], { description });

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
