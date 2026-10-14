import { generateDiffString, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notesWrite, notesUpdate, notesRead, notesList, notesSearch } from "../../../src/tools/notes.js";
import { notesIdentityFromPi } from "./adapter.js";
import { NOTES_NAMESPACE, registerOperation } from "../tool-result.js";
import type { NoteChange } from "../../../src/notes/index.js";

function renderDiff(change: NoteChange): string {
	return change.kind === "none" ? "" : generateDiffString(change.before, change.after).diff;
}

/** Register the five shared note operations; each one supplies Pi's session identity and nothing else. */
export function registerNotesTools(pi: ExtensionAPI) {
	registerOperation(pi, notesWrite, (params, ctx) => notesWrite.execute(params, notesIdentityFromPi(ctx)), NOTES_NAMESPACE);
	registerOperation(pi, notesUpdate, (params, ctx) => notesUpdate.execute(params, notesIdentityFromPi(ctx), renderDiff), NOTES_NAMESPACE);
	registerOperation(pi, notesRead, (params, ctx) => notesRead.execute(params, notesIdentityFromPi(ctx)), NOTES_NAMESPACE);
	registerOperation(pi, notesList, (params, ctx) => notesList.execute(params, notesIdentityFromPi(ctx)), NOTES_NAMESPACE);
	registerOperation(pi, notesSearch, (params, ctx) => notesSearch.execute(params, notesIdentityFromPi(ctx)), NOTES_NAMESPACE);
}
