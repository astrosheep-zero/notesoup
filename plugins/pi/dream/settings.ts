import { deriveDreamer, type DreamerSetting } from "../../../src/dream/settings.js";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { mergeNotesoupSettings } from "../../../src/settings.js";

/**
 * Resolve the configurable dreamer model from Pi settings for a CLI invocation: global
 * `~/.pi/agent/settings.json` merged with the project's `.pi/settings.json`, project
 * values winning per key. A settings read failure degrades to no pattern with one warning.
 */
export function readDreamerSettings(cwd = process.cwd()): DreamerSetting {
	try {
		const settingsManager = SettingsManager.create(cwd, undefined, { projectTrusted: true });
		return deriveDreamer(mergeNotesoupSettings(settingsManager.getGlobalSettings(), settingsManager.getProjectSettings()));
	} catch (error) {
		return { warnings: [`notesoup: could not read settings; using the automatic dreamer model (${String(error)}).`] };
	}
}
