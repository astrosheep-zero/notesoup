import type { SessionReader } from "../session-reader.js";
import { isCheckpointBackedReset, isForeignResetTailEntry, isWindowBootEntry, isWindowMarker } from "../window.js";
import { isWindowContinuationEntry } from "./artifacts.js";

/**
 * Confirm a native boundary on this branch, independent of whether its suffix is still
 * repairable. Later conversation cannot uncommit a checkpoint -> marker -> boot ->
 * continuation already persisted by Pi. No shadow commit state is maintained here.
 */
export function resetBoundaryCommitted(ctx: SessionReader, markerId: string, windowId: string): boolean {
	const branch = ctx.sessionManager.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.id === markerId);
	const marker = branch[markerIndex];
	if (!marker || !isWindowMarker(marker) || marker.data.windowId !== windowId || !isCheckpointBackedReset(ctx, marker)) return false;
	let boot = false;
	for (const entry of branch.slice(markerIndex + 1)) {
		if (isWindowBootEntry(entry, windowId)) {
			if (boot || entry.type !== "custom_message" || entry.display !== false) return false;
			boot = true;
			continue;
		}
		if (isWindowContinuationEntry(entry)) return boot && entry.type === "custom_message" && entry.display === false;
		if (isForeignResetTailEntry(entry)) return false;
	}
	return false;
}
