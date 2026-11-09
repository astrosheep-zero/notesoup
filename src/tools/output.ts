/** Tool output budgets and default window sizes. */
export const TOOL_OUTPUT_MAX_BYTES = 32 * 1024;
/** The per-call limit as the model reads it in refusals. */
export const TOOL_OUTPUT_LIMIT = `${TOOL_OUTPUT_MAX_BYTES / 1024} KB`;
export const DEFAULT_READ_WINDOW_CHARS = 12000;
export const MAX_READ_WINDOW_CHARS = 50000;
export const HISTORY_PREVIEW_CHARS = 1200;
