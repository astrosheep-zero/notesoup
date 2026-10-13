import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { CONTINUATION, WARNING_PROMPT, tokenBudgetGuidance } from "../budget/text.js";
import { measureBudget } from "./budget.js";
import { BOOT_SECTION, restoreWarnings } from "./window.js";
import { preflight } from "./engine.js";
import { registerTools } from "./tools.js";

export const name = "notesoup-dsh";
export const inject = ["tools", "sessions", "systemPrompt", "llm", "tokenMeter", "sessionQuery", "compaction"];

declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		"notesoup-budget": { kind: "notesoup-budget"; windowId: string; phase: "reminder" | "warning" };
		"notesoup-continuation": { kind: "notesoup-continuation" };
	}
}

export function apply(ctx: Context): void {
	const engine = preflight(ctx);
	ctx.on("agent/created", async ({ agent, signal }) => {
		preflight(ctx);
		await engine.windows.adopt(agent, signal);
	});
	ctx.systemPrompt.section({ name: BOOT_SECTION, order: 2450, interpolate: false, text: ({ agent }) => agent ? engine.windows.get(agent.session).snapshot.boot : "" });
	// Section providers run before the engine's awaited reset. Refresh the accepted section
	// after the entire assembly waterfall so the same request uses the newly minted boot.
	ctx.on("system-prompt/assemble", async (_assembly, input, next) => {
		const assembly = await next();
		if (input.agent) {
			const boot = assembly.sections.find((section) => section.name === BOOT_SECTION);
			if (!boot) throw Object.assign(new Error("notesoup: boot section was removed; restore notesoup:boot before running this agent."), { code: "BOOT_SECTION" });
			boot.text = engine.windows.get(input.agent.session).snapshot.boot;
		}
		return assembly;
	}, { prepend: true });
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		preflight(ctx);
		if (!signal.aborted && engine.config.auto) {
			const budget = await measureBudget(ctx, agent, engine.config, signal);
			if (budget) {
				const state = engine.windows.get(agent.session);
				const phase = budget.remaining <= budget.warning ? "warning" : budget.remaining <= budget.reminder ? "reminder" : undefined;
				if (phase && !(phase === "warning" ? state.warned : state.reminded || state.warned)) {
					const text = phase === "warning" ? WARNING_PROMPT : tokenBudgetGuidance(budget.countdown, "neuralyze");
					agent.steer(createUserMessage({ content: [{ type: "text", text }], source: { kind: "notesoup-budget", windowId: state.snapshot.windowId, phase } }));
					if (phase === "warning") state.warned = true;
					else state.reminded = true;
				}
			}
		}
		return next();
	});
	ctx.on("agent/turn-stopping", async ({ agent, signal }) => {
		if (signal.aborted) return;
		const result = await engine.compactIfNeeded(agent, "pressure", signal);
		if (result) agent.steer(createUserMessage({ content: [{ type: "text", text: CONTINUATION }], source: { kind: "notesoup-continuation" } }));
	});
	ctx.on("session/event", (session, event) => {
		if (event.type === "turn/end" && event.data.reason.kind !== "completed") {
			const state = engine.windows.get(session);
			state.pendingReset = false;
			restoreWarnings(state, session.snapshotEvents());
		}
	});
	registerTools(ctx, engine);
}
export default { name, inject, apply };
