import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { historyList, historyRead } from "../../src/tools/history.js";
import { historyFromSession } from "./history.js";
import { localHistoryCorpus } from "../../src/history/local.js";
import type { SessionReader } from "./session-reader.js";
import { HISTORY_NAMESPACE, registerOperation } from "./tool-result.js";

function historyContext(ctx: SessionReader) {
	const current = () => historyFromSession(ctx);
	return { current, corpus: localHistoryCorpus({ current: { harness: "pi", id: ctx.sessionManager.getSessionId(), load: async () => ({ projection: current() }) } }) };
}

/** Register the two deferred history operations; the adapter allocates addresses and supplies them. */
export function registerHistoryTools(pi: ExtensionAPI) {
	registerOperation(pi, historyList, (params, ctx) => historyList.execute(params, historyContext(ctx)), HISTORY_NAMESPACE, undefined, "deferred");
	registerOperation(pi, historyRead, (params, ctx) => historyRead.execute(params, historyContext(ctx)), HISTORY_NAMESPACE, undefined, "deferred");
}
