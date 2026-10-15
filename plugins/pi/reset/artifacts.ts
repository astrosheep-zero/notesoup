import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BOOT_TYPE, CARRIED_INPUT_TYPE, CONTINUATION_TYPE, RESET_LAST_WORD_TYPE, RESET_MARKER_TYPE } from "../entries.js";
import { selectContinuation, type ResetOrigin } from "../../../src/budget/text.js";
import { isForeignResetTailEntry, isWindowBootEntry, isWindowMarker, markerResetOrigin, type WindowMarker } from "../window.js";
import { buildBootMessage, sendBoot, type IncompleteNotesNotifier } from "../boot.js";

export type ResetTailState = { readonly boot: boolean; readonly continuation: boolean };

/** Original user content, including images; custom boundary messages become LLM user messages. */
export type CarriedInput = Extract<SessionBoundaryDraft, { type: "custom_message" }>["content"];

export function carriedInputDrafts(inputs: readonly CarriedInput[]): Extract<SessionBoundaryDraft, { type: "custom_message" }>[] {
	return inputs.map((content) => ({ type: "custom_message", customType: CARRIED_INPUT_TYPE, content, display: true }));
}

export function isCarriedInputEntry(entry: SessionEntry): boolean {
	return entry.type === "custom_message" && entry.customType === CARRIED_INPUT_TYPE && entry.display === true;
}

/** Advertised size: the description quotes this softer limit so sloppy character counts still fit. */
export const LAST_WORD_ADVERTISED_CHARS = 250;

/** A sticky note, not a letter: over this, empty_brain refuses instead of truncating. */
export const MAX_LAST_WORD_CHARS = 300;

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
function sendContinuation(pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{ customType: CONTINUATION_TYPE, content, display: false },
		{ triggerTurn: false },
	);
}

/**
 * The closed, ordered reset shape: retain-none native checkpoint, marker, matching boot,
 * continuation, then an optional parting line. The lifecycle appends carried inputs in the same
 * boundary after these artifacts. The boot snapshot is acquired asynchronously after capturing
 * this identity. The continuation is drawn from the pool its origin names, here, once: the caller
 * persists the returned text and no read, render, or repair draws it again. The origin defaults to
 * `normal`, the same reading a legacy marker with no origin gets.
 */
export async function buildResetDrafts(
	ctx: ExtensionContext,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
	isCurrent: () => boolean = () => true,
	lastWord?: string,
	firstSeq?: number,
	origin: ResetOrigin = "normal",
): Promise<SessionBoundaryDraft[]> {
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionPrefix = sessionId.slice(0, 8);
	const usedWindowIds = new Set(
		ctx.sessionManager.getBranch().filter(isWindowMarker).map((entry) => entry.data.windowId),
	);
	let windowId: string;
	do {
		windowId = `pcw:${sessionPrefix}:${randomUUID().slice(0, 8)}`;
	} while (usedWindowIds.has(windowId));
	const boot = await buildBootMessage(ctx, windowId, firstSeq, notifyIncompleteNotes, isCurrent);
	return [
		{ type: "compaction", summary: "", firstKeptEntryId: null },
		{ type: "custom", customType: RESET_MARKER_TYPE, data: { windowId, origin } },
		{ type: "custom_message", customType: BOOT_TYPE, content: boot.content, display: false, details: { windowId } },
		{ type: "custom_message", customType: CONTINUATION_TYPE, content: selectContinuation(origin), display: false },
		...(lastWord ? [{ type: "custom_message" as const, customType: RESET_LAST_WORD_TYPE, content: `${LAST_WORD_PREFIX}${lastWord}`, display: true }] : []),
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
	let lastWord = false;
	let carried = false;
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
		if (entry.type === "custom_message" && entry.customType === RESET_LAST_WORD_TYPE) {
			if (!continuation || lastWord || carried || entry.display !== true) return undefined;
			lastWord = true;
			continue;
		}
		if (isCarriedInputEntry(entry)) {
			if (!continuation) return undefined;
			carried = true;
			continue;
		}
		if (isForeignResetTailEntry(entry)) return undefined;
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
	const boot = tail.boot ? undefined : await buildBootMessage(ctx, marker.data.windowId, undefined, notifyIncompleteNotes, isCurrent);
	if (!isCurrent()) return;
	const latest = inspectResetTail(ctx, marker.id, marker.data.windowId);
	if (!latest) return;
	if (!latest.boot && boot) sendBoot(pi, boot);
	if (!latest.continuation && (latest.boot || boot)) sendContinuation(pi, selectContinuation(markerResetOrigin(marker)));
}
