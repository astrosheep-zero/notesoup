import { NoteError, shown } from "./errors.js";
import type { NotesIdentity } from "./identity.js";
import { assertVirtualPath, SLUG_PATTERN, type Scope } from "./paths.js";

export type NoteAddress = { scope: Scope; path: string; who?: string };

export const ADDRESS_FORMS = "Use <path> for this session, or @project/, @human/, @self/, or @model/ followed by a path; @projects/<name>/<path> reads a named project home.";

/** The one home-head vocabulary: the scope each public `@head` names, and the home directory family a head with `home` lists. */
export const HOME_HEADS: ReadonlyMap<string, { readonly scope: Scope; readonly home?: "project" | "agents" | "models" }> = new Map([
	["project", { scope: "project" }],
	["human", { scope: "human" }],
	["self", { scope: "agent" }],
	["model", { scope: "model" }],
	["projects", { scope: "project", home: "project" }],
	["agents", { scope: "agent", home: "agents" }],
	["models", { scope: "model", home: "models" }],
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
 * Decode one public note address into its physical home and virtual path. @self and @model
 * are relative; explicit projects/agents/models addresses always name one canonical slug.
 */
export function assertAddress(value: unknown): NoteAddress {
	if (typeof value !== "string") throw new NoteError("invalid_address", `${shown(value)} isn't a note address. ${ADDRESS_FORMS}`);
	let scope: Scope = "session";
	let path = value;
	let who: string | undefined;
	if (value.startsWith("@")) {
		const [rawHead, ...tail] = value.slice(1).split("/");
		const head = HOME_HEADS.get(rawHead!);
		if (head === undefined) throw new NoteError("invalid_address", `${shown(value)} isn't a note address. ${ADDRESS_FORMS}`);
		scope = head.scope;
		if (head.home === undefined) path = tail.join("/");
		else {
			who = tail[0] ?? "";
			if (!SLUG_PATTERN.test(who)) throw new NoteError("invalid_address", `${shown(value)} isn't a note address. ${ADDRESS_FORMS}`);
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
	if (scope === "session") return path;
	if (scope === "project") return who === undefined ? `@project/${path}` : `@projects/${who}/${path}`;
	if (scope === "human") return `@human/${path}`;
	if (scope === "agent") return `@agents/${who ?? identity.agent}/${path}`;
	return `@models/${who ?? identity.model}/${path}`;
}

/**
 * Render the address a caller sees. The current agent and model homes read as @self/ and
 * @model/ so ordinary sessions are not taught explicit ids; only other homes (dream) name one.
 */
export function addressFor(identity: NotesIdentity, scope: Scope, path: string, who?: string): string {
	if (scope === "agent" && (who === undefined || who === identity.agent)) return `@self/${path}`;
	if (scope === "model" && (who === undefined || who === identity.model)) return `@model/${path}`;
	return canonicalAddressFor(identity, scope, path, who);
}
