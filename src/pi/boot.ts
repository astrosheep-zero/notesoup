import { PI_TOOL_NAMES } from "./tool-names.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notesIdentityFromPi } from "./notes/adapter.js";
import { loadNotesSnapshot, type NotesSnapshot } from "../boot/snapshot.js";
import { BOOT_TYPE } from "./entries.js";
import { renderBootBlock } from "../boot/render.js";
import { currentReset, currentWindowId, isWindowBoot, rootWindowId } from "./window.js";
import { repairResetTail } from "./reset/artifacts.js";

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
	const identity = notesIdentityFromPi(ctx);
	const notes = await loadNotesSnapshot(identity, Date.now());
	if (isCurrent()) notifyIncompleteNotes?.(ctx, windowId, notes);
	return {
		customType: BOOT_TYPE,
		content: renderBootBlock({ agentName: identity.agent, modelName: identity.model, firstWindowId: rootWindowId(identity.sessionId), currentWindowId: windowId, previousWindowId: previousId, notes, tools: PI_TOOL_NAMES }),
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

/**
 * Boot entry point for `session_start` / `session_tree`. Ordinary startup ensures one root
 * boot; a reset marker instead asks reset-artifact repair to complete its persisted tail.
 */
export async function ensureBoot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	const reset = currentReset(ctx);
	const windowId = reset?.data.windowId ?? rootWindowId(sessionId);
	const stillCurrent = () => isCurrent() &&
		ctx.signal?.aborted !== true &&
		ctx.sessionManager.getSessionId() === sessionId &&
		currentWindowId(ctx) === windowId;
	if (reset) {
		await repairResetTail(pi, ctx, reset, notifyIncompleteNotes, stillCurrent);
		return;
	}
	if (ctx.sessionManager.buildSessionProjection().messages.some((message) => isWindowBoot(message, windowId))) return;
	const boot = await buildBootMessage(ctx, windowId, undefined, notifyIncompleteNotes, stillCurrent);
	if (!stillCurrent()) return;
	if (ctx.sessionManager.buildSessionProjection().messages.some((message) => isWindowBoot(message, windowId))) return;
	sendBoot(pi, boot);
}
