import { Type, type TSchema } from "typebox";
import { Errors } from "typebox/value";
import { HistoryRoleSchema } from "../history/history.js";
export const nullableString = (description?: string) => Type.Optional(Type.Union([Type.String(), Type.Null()], description === undefined ? {} : { description }));
export const historyRoles = () => Type.Optional(Type.Array(HistoryRoleSchema, { minItems: 1, description: "(optional) Only these roles: user, assistant, tool, context. Omit to see the conversation with tool and context runs folded." }));

/** First parameter violation; skip false subschemas so additionalProperties can name the field. */
export function paramProblem(schema: TSchema, params: unknown): string {
	const first = Errors(schema, params).find((error) => error.keyword !== "boolean");
	if (!first) return "unrecognized shape";
	const extra = first.keyword === "additionalProperties" ? `: ${(first.params as { additionalProperties: string[] }).additionalProperties.join(", ")}` : "";
	const field = first.instancePath.replace(/^\//, "").replaceAll("/", ".");
	return `${field ? `${field} ` : ""}${first.message}${extra}`;
}

/** Search query parameter: one literal, or several literals combined with OR. */
export const searchQuery = (description = "(optional) Literal text, or texts combined with OR. Empty text or list means no search filter.") => Type.Union([Type.String(), Type.Array(Type.String())], { description });
