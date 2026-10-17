import { deriveThresholds, type ResolvedThresholds } from "../../src/budget/policy.js";
import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RESERVE_TOKENS } from "../../src/budget/constants.js";
import { mergeNotesoupSettings } from "../../src/settings.js";
import { errorMessage } from "../../src/error-message.js";

/**
 * Read the active compaction reserve, enablement, and notesoup budget settings. This
 * function deliberately has no cache: the budget owner supplies the invocation-scoped
 * cache so two live notesoup instances cannot share mutable policy state.
 */
export type ThresholdSettingsResolution = {
	thresholds: ResolvedThresholds;
	automatic: boolean;
	warnings: string[];
};

function readThresholdSettingsFromManager(ctx: ExtensionContext, settingsManager: SettingsManager): ThresholdSettingsResolution {
	// Resolve the active provider/model override from the public settings API.
	const model = ctx.model;
	const compaction = settingsManager.getCompactionSettings(model ? { provider: model.provider, id: model.id } : undefined);
	const derived = deriveThresholds(
		compaction.reserveTokens,
		mergeNotesoupSettings(settingsManager.getGlobalSettings(), settingsManager.getProjectSettings()),
	);
	return { thresholds: derived.thresholds, automatic: compaction.enabled, warnings: derived.warnings };
}

/**
 * Resolve policy from either the explicitly supplied SDK authority or Pi's default
 * file-backed settings. The caller owns diagnostics and any lifecycle caching.
 */
export function readThresholdSettings(ctx: ExtensionContext, settingsManager?: SettingsManager): ThresholdSettingsResolution {
	try {
		const manager = settingsManager ?? SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		return readThresholdSettingsFromManager(ctx, manager);
	} catch (error) {
		return {
			// The same derivation over Pi's default reserve, so the fallback cannot drift from it.
			thresholds: deriveThresholds(DEFAULT_RESERVE_TOKENS, {}).thresholds,
			automatic: true,
			warnings: [`🥣 Couldn't read settings · using defaults (${errorMessage(error)})`],
		};
	}
}
