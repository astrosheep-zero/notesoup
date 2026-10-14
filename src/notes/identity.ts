import { resolve } from "node:path";
import { isSessionId, SLUG_PATTERN } from "./paths.js";

/** Explicit, host-neutral identity for one notes store. */
export type NotesIdentity = Readonly<{
	home: string;
	sessionId: string;
	projectKey: string;
	agent: string;
	model: string;
}>;

function requireString(field: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`notes context ${field} must be a non-empty string`);
	return value;
}

/** Validate and snapshot caller identity; no global or environment defaults are consulted. */
export function snapshotNotesIdentity(value: NotesIdentity): NotesIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("notes context must be a plain object");
	const homeValue = requireString("home", value.home);
	const sessionId = requireString("sessionId", value.sessionId);
	const projectKey = requireString("projectKey", value.projectKey);
	const agent = requireString("agent", value.agent);
	const model = requireString("model", value.model);
	if (!isSessionId(sessionId)) throw new TypeError("notes context sessionId must be a safe single directory component");
	if (!SLUG_PATTERN.test(projectKey)) throw new TypeError("notes context projectKey must be a canonical lowercase slug");
	if (!SLUG_PATTERN.test(agent)) throw new TypeError("notes context agent must be a canonical lowercase slug");
	if (!SLUG_PATTERN.test(model)) throw new TypeError("notes context model must be a canonical lowercase slug");
	const home = resolve(homeValue);
	return Object.freeze({ home, sessionId, projectKey, agent, model });
}
