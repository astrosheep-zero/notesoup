import { DEFAULT_BOOT_TOOL_NAMES, PI_PRE_RESET_HINTS } from "../boot/text.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentSlug, modelSlug, notesIdentityFromPi } from "./notes/adapter.js";
import { loadNotesSnapshot, unavailableNotesSnapshot, type NotesSnapshot } from "../boot/snapshot.js";
import { isFilesystemError } from "../notes/index.js";
import { BOOT_TYPE } from "./entries.js";
import { renderBootBlock } from "../boot/render.js";
import { historyFromSession, nextHistorySeq } from "./history.js";

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
	firstSeq: number | undefined,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
	isCurrent: () => boolean = () => true,
): Promise<BootMessage> {
	const agentName = agentSlug();
	const modelName = modelSlug(ctx);
	const windows = historyFromSession(ctx).windows.map((window) => {
		const seqs = window.items.map((item) => item.seq);
		return {
			shortName: window.windowId.slice(window.windowId.lastIndexOf(":") + 1),
			firstSeq: firstSeq === undefined || seqs.length === 0 ? undefined : Math.min(...seqs),
			lastSeq: firstSeq === undefined || seqs.length === 0 ? undefined : Math.max(...seqs),
			isCurrent: window.windowId === windowId,
		};
	});
	if (firstSeq !== undefined) {
		// An empty old window will consume the pending boundary before its marker is written.
		const last = windows.at(-1)!;
		last.firstSeq ??= last.isCurrent ? firstSeq : nextHistorySeq(ctx);
	}
	if (!windows.some((window) => window.isCurrent)) {
		windows.push({ shortName: windowId.slice(windowId.lastIndexOf(":") + 1), firstSeq, lastSeq: undefined, isCurrent: true });
	}
	// A closing boundary includes folded result slots, pending warnings and the old checkpoint.
	for (let index = 0; index < windows.length - 1; index++) {
		const nextFirst = windows[index + 1]!.firstSeq;
		if (nextFirst !== undefined) windows[index]!.lastSeq = nextFirst - 1;
	}
	const tree = { trunk: windowId.slice(0, windowId.lastIndexOf(":")), windows };
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
		content: renderBootBlock({ agentName, modelName, tree, notes, tools: { ...DEFAULT_BOOT_TOOL_NAMES, preResetHints: PI_PRE_RESET_HINTS } }),
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
