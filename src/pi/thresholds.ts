import { deriveThresholds, type ResolvedThresholds } from "../budget/policy.js";
import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS } from "../budget/constants.js";
import { mergeNotesoupSettings } from "../settings.js";
import { errorMessage } from "../error-message.js";

/**
 * Read the active compaction reserve, enablement, and notesoup margin settings. This
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
		if (settingsManager) return readThresholdSettingsFromManager(ctx, settingsManager);
		return readThresholdSettingsFromManager(
			ctx,
			SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }),
		);
	} catch (error) {
		return {
			thresholds: {
				reminder: DEFAULT_RESERVE_TOKENS + DEFAULT_REMINDER_MARGIN_TOKENS,
				reserve: DEFAULT_RESERVE_TOKENS,
				warning: DEFAULT_RESERVE_TOKENS + WARNING_RUNWAY_TOKENS,
			},
			automatic: true,
			warnings: [`🥣 Couldn't read settings · using defaults (${errorMessage(error)})`],
		};
	}
}
