import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotesStore, type NoteRow, type NotesQuery, type Scope } from "../../src/notes/index.js";
import { notesIdentityFromPi } from "../../plugins/pi/notes/adapter.js";
import { physicalPath as corePhysicalPath, scopeDir as coreScopeDir } from "../../src/notes/paths.js";

/** Test-only conveniences for fixtures that still model notes through a live Pi context. */
export function physicalPath(scope: Scope, path: string, ctx: ExtensionContext, who?: string): string {
	return corePhysicalPath(scope, path, notesIdentityFromPi(ctx), who);
}

export function scopeDir(scope: Scope, ctx: ExtensionContext, who?: string): string {
	return coreScopeDir(scope, notesIdentityFromPi(ctx), who);
}

export function listNotes(ctx: ExtensionContext, query: NotesQuery = {}): Promise<NoteRow[]> {
	return createNotesStore(notesIdentityFromPi(ctx)).list(query);
}
