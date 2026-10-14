import type {} from "@deepseek-ai/dsh-token-meter";
import type { Context } from "@deepseek-ai/cordis";
import type { CompactionAgentContext } from "@deepseek-ai/dsh-compaction";
import { estimateToolsTokens } from "@deepseek-ai/dsh-token-meter/estimate";
import type { LlmResolvedModelInfo } from "@deepseek-ai/dsh-llm";
import { deriveThresholds, remainingBudget } from "../../src/budget/policy.js";

export type BudgetConfig = { auto: boolean; thresholdRatio: number; headroomTokens: number; reminderMarginTokens?: number };
export type Budget = { used: number; contextWindow: number; reserve: number; resetAt: number; remaining: number; countdown: number; warning: number; reminder: number };

/** The host's ratio and output/headroom reserves are one reset line, not competing policies. */
export async function measureBudget(ctx: Context, agent: CompactionAgentContext, config: BudgetConfig, signal?: AbortSignal): Promise<Budget | null> {
	const route = agent.session.requestHeader()?.config ?? agent.options;
	if (!route.provider || !route.model) return null;
	const info: LlmResolvedModelInfo = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
	const contextWindow = info.context?.contextWindow;
	if (!contextWindow) return null;
	const output = agent.session.requestHeader()?.config.maxTokens ?? (agent.options as { maxTokens?: number }).maxTokens ?? info.defaultMaxTokens ?? 0;
	const resetAt = Math.floor(Math.min(contextWindow * config.thresholdRatio, contextWindow - output - config.headroomTokens));
	if (resetAt <= 0) throw Object.assign(new Error(`notesoup: contextWindow=${contextWindow}, maxTokens=${output}, headroomTokens=${config.headroomTokens} leave resetAt=${resetAt}; reduce maxTokens or headroomTokens in the profile patch.`), { code: "BUDGET_CONFIG" });
	const reserve = contextWindow - resetAt;
	const { thresholds } = deriveThresholds(reserve, { reminderMarginTokens: config.reminderMarginTokens });
	const measured = ctx.tokenMeter.measure(agent.session);
	// alpha.2 carries a provider-usage anchor across a surface replacement. Until
	// this window receives its own response, use the meter's current surface price.
	const events = agent.session.snapshotEvents();
	let used = measured.totalTokens;
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]!;
		if (event.type === "assistant/message") break;
		if (event.type === "user/message" && event.data.source.kind === "compact-checkpoint") { used = measured.surfaceTokens + estimateToolsTokens(agent.session.requestHeader()); break; }
	}
	const remaining = Math.max(0, contextWindow - used);
	return { used, contextWindow, reserve, resetAt, remaining, countdown: remainingBudget(remaining, reserve)!, warning: thresholds.warning, reminder: thresholds.reminder };
}
