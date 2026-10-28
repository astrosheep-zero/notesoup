import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piSequenceCount } from "../../src/history/pi.js";
import { BOOT_TYPE, MARKER_TYPE } from "./entries.js";
import { nextHistorySeq } from "./history.js";
import { inspectResetTail } from "./reset/artifacts.js";
import { markerContent } from "./text.js";
import { currentReset } from "./window.js";

/** Spacing between durable seq breadcrumbs, in projected history seq. */
export const MARKER_INTERVAL = 120;

/** Highest seq already anchored by a window boot or marker; 0 before the first. */
function lastMarkerSeq(ctx: ExtensionContext): number {
	let last = 0;
	let nextSeq = 1;
	for (const entry of ctx.sessionManager.getEntries()) {
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
export function maybeSendMarker(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const reset = currentReset(ctx);
	if (reset) {
		const tail = inspectResetTail(ctx, reset.id, reset.data.windowId);
		if (tail && (!tail.boot || !tail.continuation)) return;
	}
	const seq = nextHistorySeq(ctx);
	if (seq - lastMarkerSeq(ctx) < MARKER_INTERVAL) return;
	pi.sendMessage(
		{ customType: MARKER_TYPE, content: markerContent(seq), display: false, details: { seq } },
		{ triggerTurn: false },
	);
}
