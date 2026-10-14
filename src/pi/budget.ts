import { DEFAULT_BOOT_TOOL_NAMES } from "../boot/text.js";
import { remainingBudget, type ResolvedThresholds } from "../budget/policy.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { GUIDANCE_TYPE, WARNING_TYPE } from "./entries.js";
import { warningContent } from "../budget/text.js";
import { readThresholdSettings, type ThresholdSettingsResolution } from "./thresholds.js";
import { currentWindowId, hasWindowMessage, windowUsage } from "./window.js";
import { tokenBudgetGuidance } from "../budget/text.js";
import { arrangeAnchoredReminders, type AnchorDetails } from "./anchored.js";
import { output } from "./tool-result.js";

/** Remaining tokens in the provider's active window, or null without a usable estimate. */
function remainingTokens(ctx: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "model">): number | null {
	const usage = windowUsage(ctx);
	return !usage || usage.tokens === null ? null : Math.max(0, usage.contextWindow - usage.tokens);
}

export function registerBudget(
	pi: ExtensionAPI,
	isEnabled: () => boolean,
	settingsManager?: SettingsManager,
) {
	let cachedPolicy: { thresholds: ResolvedThresholds; automatic: boolean } | undefined;
	const notifiedWarnings = new Set<string>();
	const resolvePolicy = (ctx: ExtensionContext): ThresholdSettingsResolution => {
		if (!settingsManager && cachedPolicy) return { ...cachedPolicy, warnings: [] };
		const resolution = readThresholdSettings(ctx, settingsManager);
		for (const warning of resolution.warnings) {
			if (notifiedWarnings.has(warning)) continue;
			notifiedWarnings.add(warning);
			ctx.ui.notify(warning, "warning");
		}
		if (!settingsManager) cachedPolicy = { thresholds: resolution.thresholds, automatic: resolution.automatic };
		return resolution;
	};
	const thresholdsFor = (ctx: ExtensionContext): ResolvedThresholds => resolvePolicy(ctx).thresholds;
	const automaticResetEnabled = (ctx: ExtensionContext): boolean => resolvePolicy(ctx).automatic;
	const hardReserveDue = (ctx: ExtensionContext): boolean => {
		if (!automaticResetEnabled(ctx)) return false;
		const usage = windowUsage(ctx);
		return usage !== undefined && usage.tokens !== null && usage.contextWindow - usage.tokens <= thresholdsFor(ctx).reserve;
	};
	let pendingGuidance: { windowId: string; content: string } | undefined;
	let pendingWarning: { windowId: string; content: string } | undefined;
	const notifiedWindows = new Set<string>();

	const clearStaged = () => {
		pendingGuidance = undefined;
		pendingWarning = undefined;
	};
	const resetForTransition = () => {
		clearStaged();
		notifiedWindows.clear();
		cachedPolicy = undefined;
		notifiedWarnings.clear();
	};

	const consumeTurnEnd = (ctx: ExtensionContext, anchorEntryId: string): SessionBoundaryDraft[] => {
		const staged = [
			pendingGuidance ? { ...pendingGuidance, customType: GUIDANCE_TYPE } : undefined,
			pendingWarning ? { ...pendingWarning, customType: WARNING_TYPE } : undefined,
		];
		clearStaged();
		const windowId = currentWindowId(ctx);
		const drafts = staged.filter((draft): draft is NonNullable<typeof draft> => draft !== undefined && draft.windowId === windowId);
		return drafts.map((draft) => ({
			type: "custom_message" as const,
			customType: draft.customType,
			content: draft.content,
			display: false,
			details: { anchorEntryId } satisfies AnchorDetails,
		}));
	};

	pi.on("session_start", (_event, ctx) => { resetForTransition(); thresholdsFor(ctx); });
	pi.on("session_tree", resetForTransition);
	pi.on("model_select", resetForTransition);
	pi.on("session_shutdown", resetForTransition);
	pi.on("agent_settled", clearStaged);
	pi.on("context", (event, ctx) => {
		if (!isEnabled()) return undefined;
		// Durable reminders return to the slot where the model first read them.
		const messages = arrangeAnchoredReminders(event.messages, ctx);
		const result = (extra?: { customType: string; content: string }) => {
			if (!extra) return messages === event.messages ? undefined : { messages };
			return { messages: [...messages, { role: "custom" as const, ...extra, display: false, timestamp: Date.now() }] };
		};
		// Each crossing reaches the model in the request that crosses it, with the count
		// measured for that request, and persists the same text at its successful turn_end.
		// Without automatic reset nothing gets cleared, so there is nothing to remind about.
		if (!automaticResetEnabled(ctx)) return result();
		const remaining = remainingTokens(ctx);
		if (remaining === null) return result();
		const windowId = currentWindowId(ctx);
		const { reminder, warning } = thresholdsFor(ctx);
		if (remaining <= warning) {
			if (hasWindowMessage(ctx, WARNING_TYPE)) return result();
			// The critical close-out starts at reserve + runway, not at the hard reserve.
			// Another request in the same turn re-sends the staged text instead of re-measuring.
			pendingGuidance = undefined;
			if (pendingWarning?.windowId !== windowId) pendingWarning = { windowId, content: warningContent() };
			// Notify when injected, not after tools finish or a reset has already committed.
			// An aborted request does not undo the low-budget condition or repeat the toast.
			if (!notifiedWindows.has(windowId)) {
				notifiedWindows.add(windowId);
				ctx.ui.notify("🥣 Brain almost full · taking notes", "warning");
			}
			return result({ customType: WARNING_TYPE, content: pendingWarning.content });
		}
		if (hasWindowMessage(ctx, WARNING_TYPE) || pendingWarning?.windowId === windowId) return result();
		if (hasWindowMessage(ctx, GUIDANCE_TYPE)) return result();
		if (pendingGuidance?.windowId !== windowId) {
			if (remaining > reminder) return result();
			pendingGuidance = { windowId, content: tokenBudgetGuidance(remainingBudget(remaining, warning) ?? 0, DEFAULT_BOOT_TOOL_NAMES.wipe) };
		}
		return result({ customType: GUIDANCE_TYPE, content: pendingGuidance.content });
	});

	pi.registerTool(defineTool({
		name: "get_context_remaining",
		label: "Get context remaining",
		description: "Return estimated context tokens left before your memory is wiped; null when Pi cannot estimate usage.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			// The countdown the model sees ends at the warning line (reserve + runway);
			// the runway below it is overdraft the model never sees. See budget/constants.ts.
			const remaining = remainingTokens(ctx);
			return output({ remaining_tokens: remainingBudget(remaining, thresholdsFor(ctx as ExtensionContext).warning) });
		},
	}));

	return {
		automaticResetEnabled,
		hardReserveDue,
		consumeTurnEnd,
		/** The same close-out countdown the model sees, for user-facing status; null when usage is unknown. */
		statusFor: (ctx: ExtensionContext): { remaining: number | null } => ({ remaining: remainingBudget(remainingTokens(ctx), thresholdsFor(ctx).warning) }),
		clear: () => { clearStaged(); notifiedWindows.clear(); },
	};
}
