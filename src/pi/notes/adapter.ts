import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NotesIdentity } from "../../notes/identity.js";
import { projectKey, slugify } from "../../notes/paths.js";

/** Pi's default notes root; environment access stays on the host side of the library boundary. */
export function notesRoot(): string {
	const override = process.env.PI_NOTES_HOME;
	return override && override.length > 0 ? resolve(override) : join(homedir(), ".agents", "notes");
}

/** Translate the current Pi runtime into a fresh, explicit identity snapshot. */
export function agentSlug(): string {
	return slugify(process.env.PI_NOTES_AGENT ?? "anonymous");
}

/** Pi's active model identity is resolved live so a mid-session switch retargets @model. */
export function modelSlug(ctx: ExtensionContext): string {
	const id = ctx.model?.id;
	return id ? slugify(id.split("/").pop() ?? id) : "default";
}

/** Translate the current Pi runtime into one explicit notes identity snapshot. */
export function notesIdentityFromPi(ctx: ExtensionContext, home = notesRoot()): NotesIdentity {
	return {
		home,
		sessionId: ctx.sessionManager.getSessionId(),
		projectKey: projectKey(ctx.cwd),
		agent: agentSlug(),
		model: modelSlug(ctx),
	};
}
