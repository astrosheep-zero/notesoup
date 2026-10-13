import { DEFAULT_BOOT_TOOL_NAMES } from "../boot/text.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentSlug, modelSlug, notesIdentityFromPi } from "./notes/adapter.js";
import { loadNotesSnapshot, unavailableNotesSnapshot, type NotesSnapshot } from "../boot/snapshot.js";
import { isFilesystemError } from "../notes/index.js";
import { BOOT_TYPE } from "./entries.js";
import { renderBootBlock } from "../boot/render.js";
import { rootWindowId } from "./window.js";

export type IncompleteNotesNotifier = (ctx: ExtensionContext, windowId: string, snapshot: NotesSnapshot) => void;

/** The boot custom message: identity, notes snapshot, and static protocol; never reset prose. */
export type BootMessage = {
	readonly customType: string;
	readonly content: string;
	readonly display: false;
	readonly details: { windowId: string };
};

/**
 * Acquire one notes snapshot and build the boot custom message for a window. All identity
 * fields are captured synchronously before the first filesystem await.
 */
export async function buildBootMessage(
	ctx: ExtensionContext,
	windowId: string,
	previousId: string | undefined,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
	isCurrent: () => boolean = () => true,
): Promise<BootMessage> {
	const agentName = agentSlug();
	const modelName = modelSlug(ctx);
	const sessionId = ctx.sessionManager.getSessionId();
	const openedAt = Date.now();
	let notes: NotesSnapshot;
	try {
		notes = await loadNotesSnapshot(notesIdentityFromPi(ctx), openedAt);
	} catch (error) {
		if (!isFilesystemError(error)) throw error;
		notes = unavailableNotesSnapshot(openedAt);
	}
	if (isCurrent()) notifyIncompleteNotes?.(ctx, windowId, notes);
	return {
		customType: BOOT_TYPE,
		content: renderBootBlock({ agentName, modelName, firstWindowId: rootWindowId(sessionId), currentWindowId: windowId, previousWindowId: previousId, notes, tools: DEFAULT_BOOT_TOOL_NAMES }),
		display: false,
		details: { windowId },
	};
}

/** Persist one hidden boot message without triggering a model turn. */
export function sendBoot(pi: ExtensionAPI, boot: BootMessage): void {
	pi.sendMessage(
		{ customType: boot.customType, content: boot.content, display: boot.display, details: boot.details },
		{ triggerTurn: false },
	);
}
