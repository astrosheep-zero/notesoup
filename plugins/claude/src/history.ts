/** Claude's SDK-facing entry; the persisted wire decoder is shared with the local corpus. */
export { claudeHistoryFromJsonl, readClaudeHistory } from "../../../src/history/claude.js";
export type { ClaudeHistorySource, ClaudeHistoryProjection } from "../../../src/history/claude.js";
