import { generateDiffString, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notesWrite, notesUpdate, notesRead, notesList, notesSearch } from "../../../src/tools/notes.js";
import { abandonDream, dreamBegin, dreamEnd, dreamForget, dreamingIdentity, type DreamState } from "../../../src/tools/dream.js";
import { notesIdentityFromPi } from "./adapter.js";
import { notesReadRenderers, notesUpdateRenderers, notesWriteRenderers } from "../render.js";
import { DREAM_NAMESPACE, NOTES_NAMESPACE, registerOperation } from "../tool-result.js";
import type { NoteChange } from "../../../src/notes/index.js";
import { notesToolContext } from "../../../src/tools/notes-context.js";

function renderDiff(change: NoteChange): string {
	return change.kind === "none" ? "" : generateDiffString(change.before, change.after, 1).diff;
}

/** Register the five shared note operations and the three hidden dream tools; an open dream widens the note identity. */
export function registerNotesTools(pi: ExtensionAPI) {
	// One pending or open dream per session: shutdown releases ownership without the end commit.
	const dreams = new Map<string, DreamState>();
	pi.on("session_shutdown", () => {
		for (const state of dreams.values()) abandonDream(state);
		dreams.clear();
	});
	const dreamOf = (ctx: ExtensionContext): DreamState => {
		const id = ctx.sessionManager.getSessionId();
		let state = dreams.get(id);
		if (!state) dreams.set(id, state = {});
		return state;
	};
	const identity = (ctx: ExtensionContext) => dreamingIdentity(notesIdentityFromPi(ctx), dreamOf(ctx));
	const toolContext = (ctx: ExtensionContext) => notesToolContext(identity(ctx), ctx.cwd);
	registerOperation(pi, notesWrite, (params, ctx) => notesWrite.execute(params, toolContext(ctx)), NOTES_NAMESPACE, notesWriteRenderers);
	registerOperation(pi, notesUpdate, (params, ctx) => notesUpdate.execute(params, toolContext(ctx), renderDiff), NOTES_NAMESPACE, notesUpdateRenderers);
	registerOperation(pi, notesRead, (params, ctx) => notesRead.execute(params, toolContext(ctx)), NOTES_NAMESPACE, notesReadRenderers);
	registerOperation(pi, notesList, (params, ctx) => notesList.execute(params, toolContext(ctx)), NOTES_NAMESPACE);
	registerOperation(pi, notesSearch, (params, ctx) => notesSearch.execute(params, toolContext(ctx)), NOTES_NAMESPACE);
	registerOperation(pi, dreamBegin, (params, ctx) => dreamBegin.execute(params, notesIdentityFromPi(ctx), dreamOf(ctx)), DREAM_NAMESPACE, undefined, "deferred");
	registerOperation(pi, dreamForget, (params, ctx) => dreamForget.execute(params, notesIdentityFromPi(ctx), dreamOf(ctx)), DREAM_NAMESPACE, undefined, "deferred");
	registerOperation(pi, dreamEnd, (params, ctx) => dreamEnd.execute(params, notesIdentityFromPi(ctx), dreamOf(ctx)), DREAM_NAMESPACE, undefined, "deferred");
}
