import { NoteError, shown } from "./errors.js";
import type { NotesIdentity } from "./identity.js";
import { assertVirtualPath, isSessionId, SLUG_PATTERN, type Scope } from "./paths.js";

export type NoteAddress = { scope: Scope; path: string; who?: string };

export const ADDRESS_FORMS = "Use <path> for this session, or @project/, @human/, @self/, or @model/ followed by a path; @projects/<name>/<path> and @sessions/<id>/<path> read named notebooks.";

/** The one namespace-head vocabulary: the scope each public `@head` names, and the directory family a head with `dir` lists. */
export const NAMESPACE_HEADS: ReadonlyMap<string, { readonly scope: Scope; readonly dir?: "sessions" | "project" | "agents" | "models" }> = new Map([
	["project", { scope: "project" }],
	["human", { scope: "human" }],
	["self", { scope: "agent" }],
	["model", { scope: "model" }],
	["sessions", { scope: "session", dir: "sessions" }],
	["projects", { scope: "project", dir: "project" }],
	["agents", { scope: "agent", dir: "agents" }],
	["models", { scope: "model", dir: "models" }],
]);

/**
 * Minimal glob over virtual note paths: `*` matches any run within a segment (never
 * `/`), `**` matches any run across segments (a leading double-star followed by a
 * slash also matches zero segments, so it covers the root too), `?` matches exactly
 * one non-`/` character. Everything else is literal and the match is anchored to the
 * whole path.
 */
export function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				const followedBySlash = pattern[index + 2] === "/";
				source += followedBySlash ? "(?:[^]*\\/)?" : "[^]*";
				index += followedBySlash ? 2 : 1;
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`);
}

/** Glob patterns are not virtual paths (`*` is legal), so they get their own guard. */
export function assertGlobPattern(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new NoteError("invalid_pattern", `glob ${shown(value)} must be a string.`);
	if (value.includes("\0") || value.includes("\\")) throw new NoteError("invalid_pattern", `glob ${shown(value)} can't contain "\\" or NUL.`);
	return value;
}

/**
 * Decode one public note address into its physical namespace and virtual path. @self and @model
 * are relative; projects/agents/models name a canonical slug, sessions a directory component.
 */
export function assertAddress(value: unknown): NoteAddress {
	if (typeof value !== "string") throw new NoteError("invalid_address", `${shown(value)} isn't a note address. ${ADDRESS_FORMS}`);
	let scope: Scope = "session";
	let path = value;
	let who: string | undefined;
	if (value.startsWith("@")) {
		const [rawHead, ...tail] = value.slice(1).split("/");
		const head = NAMESPACE_HEADS.get(rawHead!);
		if (head === undefined) throw new NoteError("invalid_address", `${shown(value)} isn't a note address. ${ADDRESS_FORMS}`);
		scope = head.scope;
		if (head.dir === undefined) path = tail.join("/");
		else {
			who = tail[0] ?? "";
			if (!(scope === "session" ? isSessionId(who) : SLUG_PATTERN.test(who))) throw new NoteError("invalid_address", `${shown(value)} isn't a note address. ${ADDRESS_FORMS}`);
			path = tail.slice(1).join("/");
		}
		if (path === "" && scope !== "agent" && scope !== "model") throw new NoteError("invalid_address", `${shown(value)} isn't a note address. ${ADDRESS_FORMS}`);
		if (path === "" && who === undefined) throw new NoteError("invalid_address", `${shown(value)} isn't a note address. ${ADDRESS_FORMS}`);
	}
	assertVirtualPath(path);
	return { scope, path, who };
}

/** Render a virtual path in its one unambiguous address form, used to match patterns. */
export function canonicalAddressFor(identity: NotesIdentity, scope: Scope, path: string, who?: string): string {
	if (scope === "session") return `@sessions/${who ?? identity.sessionId}/${path}`;
	if (scope === "project") return `@projects/${who ?? identity.projectKey}/${path}`;
	if (scope === "human") return `@human/${path}`;
	if (scope === "agent") return `@agents/${who ?? identity.agent}/${path}`;
	return `@models/${who ?? identity.model}/${path}`;
}

/**
 * Render the address a caller sees. The current agent and model notebooks read as @self/ and
 * @model/. Current session and project notebooks retain bare paths and @project/; explicitly
 * named session/project notebooks keep their read-only addresses, even for the current identity.
 */
export function addressFor(identity: NotesIdentity, scope: Scope, path: string, who?: string): string {
	if (scope === "session" && who === undefined) return path;
	if (scope === "project" && who === undefined) return `@project/${path}`;
	if (scope === "agent" && (who === undefined || who === identity.agent)) return `@self/${path}`;
	if (scope === "model" && (who === undefined || who === identity.model)) return `@model/${path}`;
	return canonicalAddressFor(identity, scope, path, who);
}
