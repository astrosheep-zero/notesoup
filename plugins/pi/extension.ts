import { VERSION, type ExtensionAPI, type ExtensionFactory, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerHistoryTools } from "./history-tools.js";
import { registerNotesTools } from "./notes/tools.js";
import { registerContext } from "./runtime.js";

function registerNotesoup(pi: ExtensionAPI, settingsManager?: SettingsManager): void {
	const [major, minor] = VERSION.split(".").map(Number);
	if (!(major > 0 || (major === 0 && minor >= 87))) {
		throw new Error(`notesoup requires Pi >= 0.87.0; running ${VERSION}. Upgrade Pi and restart the process; /reload only reloads extensions.`);
	}
	registerContext(pi, settingsManager);
	registerHistoryTools(pi);
	registerNotesTools(pi);
}

/**
 * Create an extension factory bound to an SDK settings authority. The host must pass
 * the same manager to createAgentSession and to this factory's resource loader.
 */
export function createNotesoup(options: { settingsManager?: SettingsManager } = {}): ExtensionFactory {
	return (pi) => registerNotesoup(pi, options.settingsManager);
}

/** The Pi-discovered extension keeps the standard file-backed settings behavior. */
export default function notesoup(pi: ExtensionAPI): void {
	registerNotesoup(pi);
}
