import type { BootToolNames } from "../boot/text.js";

export const PI_TOOL_NAMES = {
	notes: "notes_*",
	notesList: "notes_list",
	history: "history_*",
	remaining: "get_context_remaining",
	wipe: "clear_memory",
} as const satisfies BootToolNames;
