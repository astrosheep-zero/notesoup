import { statSync } from "node:fs";
import { resolve } from "node:path";
import { NoteError } from "../notes/errors.js";
import { projectKey, snapshotNotesIdentity, type NotesIdentity } from "../notes/index.js";

/** Host-supplied facts for one notes tool registration; overrides never mutate this context. */
export type NotesToolContext = Readonly<{
	identity: NotesIdentity;
	cwd: string;
}>;

/** Capture the host's base cwd alongside its default identity. */
export function notesToolContext(identity: NotesIdentity, cwd: string): NotesToolContext {
	if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("notes tool cwd must be a non-empty string");
	return Object.freeze({ identity: snapshotNotesIdentity(identity), cwd: resolve(cwd) });
}

/** Resolve the current-project override once, before any address, receipt, or ownership decision. */
export function notesIdentityForCall(context: NotesToolContext, cwd?: string): NotesIdentity {
	if (cwd === undefined) return context.identity;
	const resolved = resolve(context.cwd, cwd);
	let directory = false;
	try { directory = statSync(resolved).isDirectory(); } catch { /* Report one typed refusal below. */ }
	if (!directory) throw new NoteError("invalid_cwd", `cwd is not an existing directory: ${JSON.stringify(cwd)} (resolved to ${resolved}).`);
	return snapshotNotesIdentity({
		...context.identity,
		projectKey: projectKey(resolved, context.identity.home),
	});
}
