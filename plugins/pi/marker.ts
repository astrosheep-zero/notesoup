import type { CustomMessageEntryDraft, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { piSequenceCount } from "../../src/history/pi.js";
import { BOOT_TYPE, MARKER_TYPE, RESET_MARKER_TYPE } from "./entries.js";
import { nextHistorySeq } from "./history.js";
import { inspectResetTail } from "./reset/artifacts.js";
import { markerContent } from "./text.js";
import { currentReset } from "./window.js";

/** Spacing between durable seq breadcrumbs, in projected history seq. */
export const MARKER_INTERVAL = 100;

/** Highest seq already anchored by a window boot or marker; 0 before the first. */
function lastMarkerSeq(ctx: ExtensionContext, pending: readonly SessionBoundaryDraft[]): number {
	let last = 0;
	let nextSeq = 1;
	for (const entry of [...ctx.sessionManager.getEntries(), ...pending]) {
		const count = piSequenceCount(entry);
		if (count === 0) continue;
		if (entry.type === "custom_message" && (entry.customType === MARKER_TYPE || entry.customType === BOOT_TYPE)) {
			last = nextSeq;
		}
		nextSeq += count;
	}
	return last;
}

/**
 * Stamp the current seq every MARKER_INTERVAL seqs. The marker names the seq it occupies, so a
 * model paging history_list meets a breadcrumb that tells it where it is. Skipped while a reset
 * tail still awaits boot or continuation: a foreign message there would close the repair shape.
 */
export function buildMarkerDraft(ctx: ExtensionContext, pending: readonly SessionBoundaryDraft[] = []): CustomMessageEntryDraft | undefined {
	if (pending.some((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE)) return;
	const reset = currentReset(ctx);
	if (reset) {
		const tail = inspectResetTail(ctx, reset.id, reset.data.windowId);
		if (tail && (!tail.boot || !tail.continuation)) return;
	}
	const seq = nextHistorySeq(ctx, pending);
	if (seq - lastMarkerSeq(ctx, pending) < MARKER_INTERVAL) return;
	return { type: "custom_message", customType: MARKER_TYPE, content: markerContent(seq), display: false, details: { seq } };
}

/** Run-start fallback; active runs append the same draft through the turn-end boundary. */
export function maybeSendMarker(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const draft = buildMarkerDraft(ctx);
	if (!draft) return;
	const { type: _type, ...message } = draft;
	pi.sendMessage(message, { triggerTurn: false });
}
