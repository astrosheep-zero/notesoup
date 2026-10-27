import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { historyWindows, historyList, historyRead } from "../../src/tools/history.js";
import { historyFromSession } from "./history.js";
import { HISTORY_NAMESPACE, registerOperation } from "./tool-result.js";

/** Register the three deferred history operations; the adapter allocates addresses and supplies them. */
export function registerHistoryTools(pi: ExtensionAPI) {
	registerOperation(pi, historyWindows, (params, ctx) => historyWindows.execute(params, historyFromSession(ctx), ctx.sessionManager.getSessionId()), HISTORY_NAMESPACE, undefined, "deferred");
	registerOperation(pi, historyList, (params, ctx) => historyList.execute(params, historyFromSession(ctx)), HISTORY_NAMESPACE, undefined, "deferred");
	registerOperation(pi, historyRead, (params, ctx) => historyRead.execute(params, historyFromSession(ctx)), HISTORY_NAMESPACE, undefined, "deferred");
}
