// Live smoke: render the REAL boot block against the REAL notes homes (~/.agents/notes),
// cwd = the argument or /Users/astrosheep/playground. Imports only plugin/core modules — no test
// side effects, and no Pi session. Needs a TypeScript-aware loader, because the repo's internal
// specifiers use .js for .ts files: run it with tsx (`npx tsx scripts/boot-smoke.mts [cwd]`) or
// with Pi's own jiti (`jiti.import(".../scripts/boot-smoke.mts")`). Plain node cannot resolve it.
import { renderBootBlock } from "../src/boot/render.ts";
import { loadNotesSnapshot, unavailableNotesSnapshot } from "../src/boot/snapshot.ts";
import { DEFAULT_BOOT_TOOL_NAMES } from "../src/boot/text.ts";
import { isFilesystemError } from "../src/notes/index.ts";
import { PI_PRE_RESET_HINTS } from "../plugins/pi/text.ts";
import { agentSlug, modelSlug, notesIdentityFromPi } from "../plugins/pi/notes/adapter.ts";
import { rootWindowId } from "../plugins/pi/window.ts";

const ctx = {
	cwd: process.argv[2] ?? "/Users/astrosheep/playground",
	sessionManager: {
		getSessionName: () => "root",
		getSessionId: () => "smoke-live-check",
		getBranch: () => [],
	},
};
const windowId = rootWindowId(ctx.sessionManager.getSessionId());
const openedAt = Date.now();
let notes;
try {
	notes = await loadNotesSnapshot(notesIdentityFromPi(ctx as never), openedAt);
} catch (error) {
	if (!isFilesystemError(error)) throw error;
	notes = unavailableNotesSnapshot(openedAt);
}
const shortName = (id: string) => id.slice(id.lastIndexOf(":") + 1);
console.log(renderBootBlock({
	agentName: agentSlug(),
	modelName: modelSlug(ctx as never),
	tree: { trunk: windowId.slice(0, windowId.lastIndexOf(":")), windows: [{ shortName: shortName(windowId), isCurrent: true }] },
	notes,
	tools: { ...DEFAULT_BOOT_TOOL_NAMES, preResetHints: PI_PRE_RESET_HINTS },
}));
