import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BOOT_TYPE, CONTINUATION_TYPE, RESET_LAST_WORD_TYPE, RESET_MARKER_TYPE, RESET_PROMPT_TYPE } from "../entries.js";
import { CONTINUATION } from "../../budget/text.js";
import { currentWindowId, isForeignResetTailEntry, isWindowBootEntry, isWindowMarker, previousWindowId, type WindowMarker } from "../window.js";
import { buildBootMessage, sendBoot, type IncompleteNotesNotifier } from "../boot.js";

export type ResetTailState = { readonly boot: boolean; readonly continuation: boolean };

/** A sticky note, not a letter: over this, neuralyze refuses instead of truncating. */
export const MAX_LAST_WORD_CHARS = 250;

/** How the next window finds the note. */
export const LAST_WORD_PREFIX = "*You peel a sticky note off your forehead.*\n";

/** Trim a parting line; blank input leaves no last word. Length is checked by the caller. */
export function sanitizeLastWord(raw: string | undefined): string | undefined {
	return raw?.trim() || undefined;
}

/** Match the hidden continuation entry that carries the one reset message. */
export function isWindowContinuationEntry(entry: SessionEntry): boolean {
	return entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE;
}

/** The single continuation sender: the only reset prose persisted for a window. */
function sendContinuation(pi: ExtensionAPI): void {
	pi.sendMessage(
		{ customType: CONTINUATION_TYPE, content: CONTINUATION, display: false },
		{ triggerTurn: false },
	);
}

/**
 * The closed, ordered reset shape: retain-none native checkpoint, marker, matching boot,
 * continuation, then an optional parting line and command prompt. The boot snapshot is acquired asynchronously after capturing this identity.
 */
export async function buildResetDrafts(
	ctx: ExtensionContext,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
	isCurrent: () => boolean = () => true,
	prompt?: string,
	lastWord?: string,
): Promise<SessionBoundaryDraft[]> {
	const sessionId = ctx.sessionManager.getSessionId();
	const previousId = currentWindowId(ctx);
	const sessionPrefix = sessionId.slice(0, 8);
	const usedWindowIds = new Set(
		ctx.sessionManager.getBranch().filter(isWindowMarker).map((entry) => entry.data.windowId),
	);
	let windowId: string;
	do {
		windowId = `pcw:${sessionPrefix}:${randomUUID().slice(0, 8)}`;
	} while (usedWindowIds.has(windowId));
	const boot = await buildBootMessage(ctx, windowId, previousId, notifyIncompleteNotes, isCurrent);
	return [
		{ type: "compaction", summary: "", firstKeptEntryId: null },
		{ type: "custom", customType: RESET_MARKER_TYPE, data: { windowId } },
		{ type: "custom_message", customType: BOOT_TYPE, content: boot.content, display: false, details: { windowId } },
		{ type: "custom_message", customType: CONTINUATION_TYPE, content: CONTINUATION, display: false },
		...(lastWord ? [{ type: "custom_message" as const, customType: RESET_LAST_WORD_TYPE, content: `${LAST_WORD_PREFIX}${lastWord}`, display: true }] : []),
		...(prompt ? [{ type: "custom_message" as const, customType: RESET_PROMPT_TYPE, content: prompt, display: true }] : []),
	];
}

/**
 * Inspect the persisted tail of a reset marker. It reports which reset messages are present
 * only while the tail stays repairable: metadata may follow the marker, but real conversation,
 * a foreign message, a later marker, or a misordered/duplicate reset artifact refuses repair.
 */
export function inspectResetTail(ctx: ExtensionContext, markerId: string, windowId: string): ResetTailState | undefined {
	const branch = ctx.sessionManager.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.id === markerId);
	if (markerIndex < 0) return undefined;
	let boot = false;
	let continuation = false;
	for (const entry of branch.slice(markerIndex + 1)) {
		if (isWindowBootEntry(entry, windowId)) {
			// The boot is unique and must precede the continuation; a repeat or a late
			// boot would move the provider boundary or misorder the reset shape.
			if (boot || continuation) return undefined;
			boot = true;
			continue;
		}
		if (isWindowContinuationEntry(entry)) {
			if (continuation || !boot) return undefined;
			continuation = true;
			continue;
		}
		if (isForeignResetTailEntry(entry)) {
			return undefined;
		}
	}
	return { boot, continuation };
}

/** Emit only the reset artifacts an incomplete tail is missing, in the closed order. */
export async function repairResetTail(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	marker: WindowMarker,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	const tail = inspectResetTail(ctx, marker.id, marker.data.windowId);
	if (!tail || (tail.boot && tail.continuation)) return;
	const boot = tail.boot ? undefined : await buildBootMessage(ctx, marker.data.windowId, previousWindowId(ctx, marker.id), notifyIncompleteNotes, isCurrent);
	if (!isCurrent()) return;
	const latest = inspectResetTail(ctx, marker.id, marker.data.windowId);
	if (!latest) return;
	if (!latest.boot && boot) sendBoot(pi, boot);
	if (!latest.continuation && (latest.boot || boot)) sendContinuation(pi);
}
