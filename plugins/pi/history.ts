/** Pi's native reader and pending-boundary addressing use the shared Pi wire decoder. */
import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { SessionReader } from "./session-reader.js";
import { piHistoryFromEntries, piSequenceCount } from "../../src/history/pi.js";
import type { HistoryProjection } from "../../src/history/history.js";

export function nextHistorySeq(ctx: SessionReader, pending: readonly SessionBoundaryDraft[] = []): number {
	return 1 + [...ctx.sessionManager.getEntries(), ...pending].reduce((sum, entry) => sum + piSequenceCount(entry), 0);
}

export function historyFromSession(ctx: SessionReader): HistoryProjection {
	const manager = ctx.sessionManager;
	return piHistoryFromEntries(manager.getSessionId(), manager.getEntries(), manager.getBranch());
}
