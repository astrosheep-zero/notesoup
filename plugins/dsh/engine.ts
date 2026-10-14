import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type { CommandId } from "@deepseek-ai/dsh-commands/brand";
import { CompactionEngine, CompactionId, ManualCompactionError, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore, type CompactionAgentContext, type CompactionResult, type CompactionTrigger, type ManualCompactAgentContext } from "@deepseek-ai/dsh-compaction";
import { createUserMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord, type Session, type SessionSeq } from "@deepseek-ai/dsh-session";
import { measureBudget, type BudgetConfig } from "./budget.js";
import { selectContinuation, type ResetOrigin } from "../../src/budget/text.js";
import { checkpointText, Windows, WINDOW_RECORD, type NotesConfig } from "./window.js";

export type EngineConfig = NotesConfig & Partial<BudgetConfig>;
export type ResolvedConfig = NotesConfig & BudgetConfig;
function resolveConfig(config: EngineConfig): ResolvedConfig {
	const resolved = { ...config, auto: config.auto ?? true, thresholdRatio: config.thresholdRatio ?? 0.8, headroomTokens: config.headroomTokens ?? 65536 };
	if (typeof resolved.auto !== "boolean" || !Number.isFinite(resolved.thresholdRatio) || resolved.thresholdRatio <= 0 || resolved.thresholdRatio > 1 || !Number.isSafeInteger(resolved.headroomTokens) || resolved.headroomTokens < 0 || (resolved.reminderMarginTokens !== undefined && (!Number.isSafeInteger(resolved.reminderMarginTokens) || resolved.reminderMarginTokens <= 0))) throw Object.assign(new Error("notesoup: auto must be boolean; thresholdRatio must be in (0,1]; headroomTokens must be an integer >=0; reminderMarginTokens must be an integer >0. Fix the notesoup-engine profile row."), { code: "CONFIG" });
	const known = new Set(["auto", "thresholdRatio", "headroomTokens", "reminderMarginTokens", "notesHome", "agentName"]);
	for (const key of Object.keys(config)) if (!known.has(key)) throw Object.assign(new Error(`notesoup: unknown engine parameter ${key}; remove it from the notesoup-engine profile row.`), { code: "CONFIG" });
	return Object.freeze(resolved);
}

/** Durable lock and open-turn owner are separate facts, including after process reload. */
function entryState(session: Session): { turn: number | null; busy: boolean } {
	let turn: number | null = null;
	let start: SessionSeq | undefined;
	let seed = -1;
	for (const event of session.snapshotEvents()) {
		if (event.type === "turn/start") turn = event.data.turn;
		if (event.type === "turn/end") turn = null;
		if (event.type === "session/end-seed") seed = event.seq;
		if (event.type === "compaction/start") start = event.seq;
		if (event.type === "compaction/end") start = undefined;
	}
	return { turn, busy: start !== undefined && start > seed };
}

function range(session: Session): { start: SessionSeq; end: SessionSeq } | null {
	const nodes = session.surface.nodes;
	// Node zero is host-owned even when no system head is present yet.
	if (nodes.length <= 1) return null;
	const start = nodes[1]!;
	const end = nodes.at(-1)!;
	if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) return null;
	return { start, end };
}

export class NotesoupCompactionEngine extends CompactionEngine {
	static inject = ["llm", "tokenMeter", "sessions"];
	readonly config: ResolvedConfig;
	readonly windows: Windows;
	private readonly lifecycle: { fiber: Context["fiber"] };
	constructor(ctx: Context, config: EngineConfig = {}) {
		super(ctx);
		this.config = resolveConfig(config);
		this.lifecycle = { fiber: ctx.fiber };
		this.windows = new Windows(this.config);
		// Assembly precedes pre-step. Reset here and refresh only our section in index.ts.
		ctx.on("system-prompt/assemble", async (_assembly, input, next) => {
			if (input.agent && input.signal && !input.signal.aborted) {
				preflight(ctx);
				await this.compactIfNeeded(input.agent, "pressure", input.signal);
			}
			return next();
		});
	}
	get automaticListenerPresent(): boolean {
		// Effect diagnostics are a public capability; no Cordis hook-table inspection.
		return this.lifecycle.fiber.getEffects().some((effect) => effect.label === 'ctx.on("system-prompt/assemble")');
	}
	async compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
		signal.throwIfAborted();
		const state = this.windows.get(agent.session);
		// `pendingReset` is the model's own `empty_brain` call. A budget cutoff happens without one,
		// and that difference is the reset's actual origin.
		const modelRequested = state.pendingReset;
		if (!modelRequested) {
			if (!this.config.auto) return null;
			// Context overflow is deliberately left to the host. This adapter owns reserve resets.
			if (trigger === "context-overflow") return null;
			const budget = await measureBudget(this.ctx, agent, this.config, signal);
			if (!budget || budget.remaining > budget.reserve) return null;
		}
		const selected = range(agent.session);
		if (!selected) return null;
		return this.compactRegion(selected.start, selected.end, agent, signal, modelRequested ? "normal" : "forced");
	}
	async compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal, origin: ResetOrigin = "forced"): Promise<CompactionResult> {
		if (entryState(agent.session).turn === null) throw new ManualCompactionError("busy", "notesoup: compactRegion needs an open turn; use compactNow while idle.");
		return this.transaction(start, end, agent, signal, origin);
	}
	compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null> {
		signal.throwIfAborted();
		try {
			return agent.runMaintenance(async (ownerSignal) => {
				const combined = AbortSignal.any([signal, ownerSignal]);
				combined.throwIfAborted();
				if (entryState(agent.session).turn !== null) throw new ManualCompactionError("busy", "notesoup: an open turn remains; wait for the agent to stop, then retry.");
				const selected = range(agent.session);
				if (!selected) return null;
				return this.transaction(selected.start, selected.end, agent, combined, "forced", sourceCommandId, true);
			});
		} catch (error) { throw new ManualCompactionError("busy", "notesoup: wait for the agent to become idle, then retry compactNow.", { cause: error }); }
	}

	/** No model call, no shrink requirement: even a one-message window can be cleared. */
	private async transaction(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal: AbortSignal | undefined, origin: ResetOrigin, sourceCommandId?: CommandId, flush = false): Promise<CompactionResult> {
		const session = agent.session;
		signal?.throwIfAborted();
		const selected = range(session);
		if (!selected || selected.start !== start || selected.end !== end) throw new ManualCompactionError("changed", `notesoup: reset must cover surface positions 1..${session.surface.nodes.length - 1} with balanced tools; retry after the tool batch finishes.`);
		const entry = entryState(session);
		if (entry.busy) throw new ManualCompactionError("busy", "notesoup: a compaction/start has no matching end; reload this session before retrying.");
		const state = this.windows.get(session);
		const previous = state.snapshot;
		const previousContinuation = state.continuation;
		const shadowedSeqs = [...session.surface.nodes.slice(1)];
		const generation = session.surface.contentGeneration;
		const measured = this.ctx.tokenMeter.measure(session);
		const shadowedTokenCount = measured.nodes.slice(1).reduce((sum, node) => sum + node.heuristicTokens, 0);
		const compactionId = CompactionId(randomUUID());
		const lifecycle = { compactionId, turn: entry.turn, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) };
		// Synchronous lock acquisition precedes the snapshot's first await.
		const opened = session.append("compaction/start", lifecycle);
		let landed = false;
		let closing = false;
		let closed = false;
		let result: CompactionResult | undefined;
		let failure: unknown;
		try {
			const next = await this.windows.mint(agent, previous.window + 1, opened.time);
			signal?.throwIfAborted();
			if (session.surface.contentGeneration !== generation || session.surface.nodes.length !== shadowedSeqs.length + 1) throw new ManualCompactionError("changed", "notesoup: the surface changed while opening the next notebook; retry after current work finishes.");
			// Mint BEFORE writing the checkpoint. A rejected append restores the previous notebook.
			// One draw per reset artifact: the checkpoint text and the steered copy share it.
			const continuation = selectContinuation(origin);
			state.snapshot = next;
			state.continuation = continuation;
			const summary: ContentBlock[] = [{ type: "text", text: checkpointText(next, continuation) }];
			const summarized = session.append("compaction/summary", { compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }), summary, shadowedRange: { start, end }, shadowedSeqs, shadowedTokenCount, provider: "notesoup", model: "notes" });
			session.append("user/message", createUserMessage({ content: summary, source: compactCheckpointSource(compactionId, sourceCommandId) }), { surfaceOp: { op: "replace", startSeq: start, endSeq: end }, sourceEventSeqs: [opened.seq, summarized.seq, ...shadowedSeqs] });
			landed = true;
			state.pendingReset = false;
			state.warned = false;
			state.reminded = false;
			closing = true;
			const ended = session.append("compaction/end", lifecycle);
			closed = true;
			result = { compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }), startSeq: opened.seq, summarySeq: summarized.seq, endSeq: ended.seq, summary, shadowedRange: { start, end }, shadowedSeqs, shadowedTokenCount };
			try { appendPluginRecord(session, WINDOW_RECORD, next); }
			catch (error) { this.ctx.logger.warn(`notesoup: window record could not be written; the checkpoint holds ${next.windowId}. ${String(error)}`); }
		} catch (error) {
			if (!landed) { state.snapshot = previous; state.continuation = previousContinuation; }
			failure = error;
			if (!closing) {
				try { session.append("compaction/end", { ...lifecycle, error: String(error) }); closed = true; }
				catch (closeError) { failure = new ManualCompactionError("commit", "notesoup: compaction/end failed; reload the session before another reset.", { cause: closeError }); }
			} else failure = new ManualCompactionError("commit", "notesoup: checkpoint landed but compaction/end failed; reload before another reset.", { cause: error });
		}
		if (flush && closed) {
			try { await this.ctx.sessions.flush(session); }
			catch (error) { if (!failure) failure = new ManualCompactionError("persistence", "notesoup: the reset is in the live log but its disk flush failed; retry the session flush before exiting.", { cause: error }); }
		}
		if (failure) throw failure;
		return result!;
	}
}
export default NotesoupCompactionEngine;

export class PreflightError extends Error {
	constructor(readonly code: string, message: string) { super(`notesoup: ${message}`); }
}

/** Probe capabilities and the public loader/registry, not preview-version strings or private hooks. */
export function preflight(ctx: Context): NotesoupCompactionEngine {
	for (const [service, method] of [["systemPrompt", "section"], ["tools", "register"], ["sessionQuery", "readSession"], ["tokenMeter", "measure"], ["llm", "resolveModelInfo"]] as const) {
		const mounted = ctx.get(service) as unknown as Record<string, unknown> | undefined;
		if (typeof mounted?.[method] !== "function") throw new PreflightError("CAPABILITY", `${service}.${method} is unavailable; enable that service in the profile before using notesoup.`);
	}
	const engine = ctx.get("compaction");
	if (!(engine instanceof NotesoupCompactionEngine)) throw new PreflightError("ENGINE", "ctx.compaction must be NotesoupCompactionEngine; disable compaction-basic and enable the notesoup-engine row, then restart dsh.");
	const loader = ctx.get("loader");
	if (loader) {
		if (typeof loader.entries !== "function") throw new PreflightError("CAPABILITY", "loader.entries is unavailable; this profile cannot be checked for two engines.");
		for (const entry of loader.entries()) {
			if ((entry.options.id === "compaction-basic" || /(?:^|\/)dsh-compaction-basic$/.test(entry.options.name)) && !entry.disabled) throw new PreflightError("DOUBLE_ENGINE", "compaction-basic is enabled; set disabled: true on that profile row and restart dsh.");
		}
	}
	for (const [callback, runtime] of ctx.registry.entries()) {
		if (callback.name === "BasicCompactionEngine" && runtime.fibers.length > 0) throw new PreflightError("DOUBLE_ENGINE", "a BasicCompactionEngine fiber is mounted; remove it before starting notesoup.");
	}
	if (!engine.automaticListenerPresent) throw new PreflightError("AUTO_LISTENER", "the automatic reset listener is missing; reload notesoup-engine before sending another request.");
	return engine;
}
