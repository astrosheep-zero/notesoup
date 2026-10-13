import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { currentReset, currentWindowId } from "../window.js";
import { resetBoundaryCommitted } from "./committed.js";
import { errorMessage } from "../../error-message.js";

type BudgetOwner = {
	automaticResetEnabled: (ctx: ExtensionContext) => boolean;
	hardReserveDue: (ctx: ExtensionContext) => boolean;
	consumeTurnEnd: (ctx: ExtensionContext, anchorEntryId: string) => SessionBoundaryDraft[];
	clear: () => void;
};

type ResetOptions = {
	isEnabled: () => boolean;
	budget: BudgetOwner;
	buildReset: (ctx: ExtensionContext, isCurrent: () => boolean, prompt?: string, lastWord?: string) => SessionBoundaryDraft[] | Promise<SessionBoundaryDraft[]>;
	getLifecycleGeneration?: () => number;
	onResetReady?: (ctx: ExtensionContext, drafts: readonly SessionBoundaryDraft[]) => void;
};

function isAbort(message: AgentMessage, outcome: string | undefined, ctx: ExtensionContext): boolean {
	return outcome === "aborted" || (message.role === "assistant" && message.stopReason === "aborted") || ctx.signal?.aborted === true;
}

function isOverflowLike(message: AgentMessage, ctx: ExtensionContext): boolean {
	if (message.role !== "assistant") return false;
	return isContextOverflow(message, ctx.model?.contextWindow) ||
		(ctx.model !== undefined && isRecoverableLength(message, ctx.model.maxTokens));
}

export type ResetRequestSource = "manual" | "automatic";
type ToolResetRequestSource = "automatic" | "tool";
export type ResetRequest =
	| { readonly phase: "none" }
	// The safety reset may change windows before Pi finishes its tool-batch continuation.
	// This run-scoped stop intent survives that change; windowId is the pre-reset window.
	| { readonly phase: "stop-pending"; readonly windowId: string }
	| { readonly phase: "close-out"; readonly windowId: string; readonly source: ResetRequestSource; readonly prompt?: string; readonly lastWord?: string }
	| { readonly phase: "tool-requested"; readonly windowId: string; readonly source: ToolResetRequestSource; readonly lastWord?: string };
export type ResetOverflowPhase = "idle" | "pending" | "pending-spent" | "spent";

export interface ResetControlState {
	readonly request: ResetRequest;
	readonly overflow: ResetOverflowPhase;
}

const NO_REQUEST: ResetRequest = { phase: "none" };

export function initialResetControl(): ResetControlState {
	return { request: NO_REQUEST, overflow: "idle" };
}

/** Facts for a completed turn. Guard values stay lazy to preserve policy resolution order. */
export interface ResetTurnEndFacts {
	readonly windowId: string;
	readonly aborted: boolean;
	readonly overflow: boolean;
	readonly failed: boolean;
	readonly enabled: boolean;
	readonly queued: boolean;
	readonly automaticResetEnabled: boolean;
	readonly hardReserveDue: boolean;
}

/** Facts for the pre-settlement boundary; policy guards stay lazy for the same reason. */
export interface ResetBeforeSettleFacts {
	readonly windowId: string;
	readonly queued: boolean;
	readonly enabled: boolean;
	readonly automaticResetEnabled: boolean;
	readonly aborted: boolean;
	readonly failed: boolean;
}

export type ResetControlEvent =
	| { readonly type: "close_out"; readonly windowId: string; readonly source: ResetRequestSource; readonly prompt?: string }
	| { readonly type: "tool_request"; readonly windowId: string; readonly lastWord?: string }
	| { readonly type: "turn_end"; readonly facts: ResetTurnEndFacts }
	| { readonly type: "before_settle"; readonly facts: ResetBeforeSettleFacts }
	| { readonly type: "settled" }
	| { readonly type: "abort" }
	| { readonly type: "clear" };

export type ResetControlEffect =
	| "none"
	| "close-out-armed"
	| "already-pending"
	| "commit-boundary"
	| "commit-boundary-stop"
	| "stop"
	| "recover-overflow";

export interface ResetControlResult {
	readonly state: ResetControlState;
	readonly effect: ResetControlEffect;
	readonly prompt?: string;
	readonly lastWord?: string;
}

function requestForWindow(request: ResetRequest, windowId: string): ResetRequest {
	return request.phase === "stop-pending" || (request.phase !== "none" && request.windowId === windowId) ? request : NO_REQUEST;
}

function manualCommit(prompt?: string, lastWord?: string): ResetControlResult {
	const parting = lastWord ? { lastWord } : {};
	return prompt
		? { state: initialResetControl(), effect: "commit-boundary", prompt, ...parting }
		: { state: initialResetControl(), effect: "commit-boundary-stop", ...parting };
}

/** The parting line rides either committing phase; other phases never carry one. */
function requestLastWord(request: ResetRequest): string | undefined {
	return request.phase === "close-out" || request.phase === "tool-requested" ? request.lastWord : undefined;
}

/** Pure reset-control transitions: request phases own close-out, tool commit, and fallback. */
export function reduceResetControl(state: ResetControlState, event: ResetControlEvent): ResetControlResult {
	switch (event.type) {
		case "close_out": {
			const request = state.request;
			const prompt = event.source === "manual" && event.prompt?.trim() ? { prompt: event.prompt.trim() } : {};
			if (request.phase === "stop-pending") return { state, effect: "already-pending" };
			if (request.phase === "tool-requested" && request.windowId === event.windowId) {
				// A manual wipe outranks a pending rollover: close out before committing.
				if (event.source === "manual") {
					return { state: { ...state, request: { phase: "close-out", windowId: event.windowId, source: "manual", ...prompt } }, effect: "close-out-armed" };
				}
				return { state, effect: "already-pending" };
			}
			if (request.phase === "close-out" && request.windowId === event.windowId) {
				if (request.source === "manual" || event.source === "automatic") return { state, effect: "already-pending" };
				return { state: { ...state, request: { ...request, source: "manual", ...prompt } }, effect: "close-out-armed" };
			}
			return { state: { ...state, request: { phase: "close-out", windowId: event.windowId, source: event.source, ...prompt } }, effect: "close-out-armed" };
		}
		case "tool_request": {
			const request = state.request;
			if (request.phase === "stop-pending") return { state, effect: "already-pending" };
			if (request.phase === "tool-requested" && request.windowId === event.windowId) {
				return { state, effect: "already-pending" };
			}
			const parting = event.lastWord ? { lastWord: event.lastWord } : {};
			// A manual close-out must settle so the stop actually lands; the agent's own wipe
			// call during one is only an acknowledgement, never a conversion to a turn-end
			// commit that pi's tool-batch continuation can overrun. A budget close-out still
			// upgrades: context pressure cannot wait for settlement.
			if (request.phase === "close-out" && request.windowId === event.windowId) {
				// The acknowledging call still contributes its last word; the manual commit keeps the wheel.
				if (request.source === "manual") {
					const lastWord = request.lastWord ?? event.lastWord;
					return { state: { ...state, request: { ...request, ...(lastWord ? { lastWord } : {}) } }, effect: "already-pending" };
				}
				return { state: { ...state, request: { phase: "tool-requested", windowId: event.windowId, source: "automatic", ...parting } }, effect: "close-out-armed" };
			}
			return { state: { ...state, request: { phase: "tool-requested", windowId: event.windowId, source: "tool", ...parting } }, effect: "close-out-armed" };
		}
		case "turn_end": {
			const facts = event.facts;
			const request = requestForWindow(state.request, facts.windowId);
			if (facts.aborted) return { state: initialResetControl(), effect: "none" };
			if (request.phase === "stop-pending") return { state: { request, overflow: "idle" }, effect: "none" };
			const manual = request.phase === "close-out" && request.source === "manual";
			if (facts.overflow) {
				const pending = manual ? facts.enabled : !facts.queued && facts.enabled && facts.automaticResetEnabled;
				const spent = state.overflow === "pending-spent" || state.overflow === "spent";
				const overflow: ResetOverflowPhase = pending
					? (spent ? "pending-spent" : "pending")
					: (spent ? "spent" : "idle");
				return { state: { request: manual ? request : NO_REQUEST, overflow }, effect: "none" };
			}
			if (facts.failed) return { state: { request: NO_REQUEST, overflow: state.overflow }, effect: "none" };
			if (!facts.enabled) {
				return { state: { request: NO_REQUEST, overflow: "idle" }, effect: "none" };
			}
			// A direct tool request commits after the whole tool batch. The budget cutoff is
			// a separate hard-reserve safety path; ordinary close-out waits for settlement.
			if (request.phase === "tool-requested" || facts.hardReserveDue) {
				const lastWord = requestLastWord(request);
				if (manual && request.prompt) return manualCommit(request.prompt, lastWord);
				if (manual) return { state: { request: { phase: "stop-pending", windowId: facts.windowId }, overflow: "idle" }, effect: "commit-boundary-stop", ...(lastWord ? { lastWord } : {}) };
				return { state: { request: NO_REQUEST, overflow: "idle" }, effect: "commit-boundary", ...(lastWord ? { lastWord } : {}) };
			}
			return { state: { request, overflow: "idle" }, effect: "none" };
		}
		case "before_settle": {
			const facts = event.facts;
			if (facts.aborted) return { state: initialResetControl(), effect: "none" };
			const request = requestForWindow(state.request, facts.windowId);
			if (request.phase === "stop-pending") {
				if (facts.queued) return { state, effect: "none" };
				// Only retry construction if the safety boundary never committed. Otherwise
				// stop without a second wipe, even if a queued turn subsequently failed.
				if (request.windowId !== facts.windowId) return { state: initialResetControl(), effect: "stop" };
				return { state: initialResetControl(), effect: facts.failed || !facts.enabled ? "none" : "commit-boundary-stop" };
			}
			const manual = request.phase === "close-out" && request.source === "manual";
			if (state.overflow === "pending" || state.overflow === "pending-spent") {
				if (facts.queued) {
					return { state: { ...state, request: facts.failed && !manual ? NO_REQUEST : request }, effect: "none" };
				}
				// An explicit manual wipe is not an automatic recovery/retry. It must still
				// clear on overflow, including when automatic reset is disabled.
				if (manual && facts.enabled) return manualCommit(request.prompt, requestLastWord(request));
				const spent = state.overflow === "pending-spent";
				if (!facts.enabled || !facts.automaticResetEnabled) {
					return { state: { request: facts.failed ? NO_REQUEST : request, overflow: spent ? "spent" : "idle" }, effect: "none" };
				}
				return { state: { request: NO_REQUEST, overflow: "spent" }, effect: spent ? "none" : "recover-overflow" };
			}
			if (facts.failed || !facts.enabled || !manual) {
				return { state: { ...state, request: NO_REQUEST }, effect: "none" };
			}
			if (facts.queued) return { state: { ...state, request }, effect: "none" };
			return manualCommit(request.prompt, requestLastWord(request));
		}
		case "settled":
			return { state: initialResetControl(), effect: "none" };
		case "abort":
		case "clear":
			return { state: initialResetControl(), effect: "none" };
	}
}

/**
 * Own close-out requests at Pi's public turn and pre-settlement boundaries. Manual and budget
 * close-outs remain armed across note/tool turns. Only manual close-outs commit at a
 * successful agent_before_settle; budget warnings alone never authorize a reset.
 * A hard-reserve safety reset can commit earlier, but preserves a
 * run-scoped manual stop and cancels an otherwise automatic fresh-window request through
 * the public abort API. Direct tool requests commit at turn_end and continue normally.
 * Overflow recovery remains bounded.
 */
export function registerResetLifecycle(pi: ExtensionAPI, options: ResetOptions) {
	let sessionActive = true;
	let lifecycleGeneration = 0;
	let control = initialResetControl();

	const clear = () => { control = reduceResetControl(control, { type: "clear" }).state; };
	const resetBoundaryResult = async (entries: SessionBoundaryDraft[], ctx: ExtensionContext, continueAfterReset: boolean, prompt?: string, lastWord?: string) => {
		const generation = lifecycleGeneration;
		const outerGeneration = options.getLifecycleGeneration?.();
		const sessionId = ctx.sessionManager.getSessionId();
		const windowId = currentWindowId(ctx);
		const isCurrent = () => sessionActive && lifecycleGeneration === generation &&
			(outerGeneration === undefined || options.getLifecycleGeneration?.() === outerGeneration) && options.isEnabled() &&
			ctx.signal?.aborted !== true && ctx.sessionManager.getSessionId() === sessionId && currentWindowId(ctx) === windowId;
		let resetDrafts: SessionBoundaryDraft[];
		try {
			resetDrafts = await options.buildReset(ctx, isCurrent, prompt, lastWord);
		} catch (error) {
			if (isCurrent()) ctx.ui.notify(`🥣 Couldn't clear memory: ${errorMessage(error)}${prompt ? " · your prompt was not sent" : ""}`, "warning");
			return entries.length > 0 ? { entries } : undefined;
		}
		if (!isCurrent()) return entries.length > 0 ? { entries } : undefined;
		options.onResetReady?.(ctx, resetDrafts);
		return { entries: [...entries, ...resetDrafts], continue: continueAfterReset };
	};

	// Boundary continue:false is not a veto of Pi's tool-batch follow-up. Once the
	// safety reset is actually committed, cancel that empty follow-up before provider
	// work. Real queued user input is allowed through and answered before settlement.
	pi.on("context_with_system", (event, ctx) => {
		const request = control.request;
		if (!sessionActive || request.phase !== "stop-pending" || ctx.hasPendingMessages()) return undefined;
		const marker = currentReset(ctx);
		if (!marker || marker.data.windowId === request.windowId || !resetBoundaryCommitted(ctx, marker.id, marker.data.windowId)) return undefined;
		const branch = ctx.sessionManager.getBranch();
		const markerIndex = branch.findIndex((entry) => entry.id === marker.id);
		if (branch.slice(markerIndex + 1).some((entry) => entry.type === "message" && entry.message.role === "user")) return undefined;
		ctx.abort();
		const system = getCurrentSystemMessage(event.messages);
		return { messages: system ? [system] : [] };
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!sessionActive) return undefined;
		const aborted = isAbort(event.message, event.outcome, ctx);
		const stagedBudgetEntries = options.budget.consumeTurnEnd(ctx, event.messageEntryId);
		const budgetEntries = options.isEnabled() && !aborted && event.outcome !== "error" ? stagedBudgetEntries : [];
		const entries = [...(event.entries ?? []), ...budgetEntries];
		const decision = reduceResetControl(control, {
			type: "turn_end",
			facts: {
				windowId: currentWindowId(ctx),
				aborted,
				overflow: aborted ? false : isOverflowLike(event.message, ctx),
				failed: event.outcome === "error",
				enabled: options.isEnabled(),
				get queued() { return event.context.pendingMessages.length > 0 || ctx.hasPendingMessages(); },
				get automaticResetEnabled() { return options.budget.automaticResetEnabled(ctx); },
				get hardReserveDue() { return options.budget.hardReserveDue(ctx); },
			},
		});
		control = decision.state;
		if (decision.effect === "commit-boundary" || decision.effect === "commit-boundary-stop") return await resetBoundaryResult(entries, ctx, decision.effect === "commit-boundary", decision.prompt, decision.lastWord);
		return entries.length > 0 ? { entries } : undefined;
	});

	pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx) => {
		if (!sessionActive) return undefined;
		const decision = reduceResetControl(control, {
			type: "before_settle",
			facts: {
				windowId: currentWindowId(ctx),
				get queued() { return event.context.pendingMessages.length > 0 || ctx.hasPendingMessages(); },
				get enabled() { return options.isEnabled(); },
				get automaticResetEnabled() { return options.budget.automaticResetEnabled(ctx); },
				aborted: event.outcome === "aborted" || ctx.signal?.aborted === true,
				failed: event.outcome === "error",
			},
		});
		control = decision.state;
		if (decision.effect === "stop") return { entries: event.entries, continue: false };
		if (decision.effect !== "commit-boundary" && decision.effect !== "commit-boundary-stop" && decision.effect !== "recover-overflow") return undefined;
		return await resetBoundaryResult(event.entries, ctx, decision.effect !== "commit-boundary-stop", decision.prompt, decision.lastWord);
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!sessionActive) return undefined;
		if (event.signal.aborted) return { cancel: true };
		const markerExists = currentReset(ctx) !== undefined;
		if (options.isEnabled() || markerExists) {
			if (event.reason === "manual") {
				ctx.ui.notify("🥣 /compact is off while notesoup is on · use /fresh-window", "warning");
			}
			return { cancel: true };
		}
		return undefined;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.signal?.aborted) control = reduceResetControl(control, { type: "abort" }).state;
	});
	pi.on("agent_settled", () => {
		control = reduceResetControl(control, { type: "settled" }).state;
	});
	pi.on("session_start", () => { lifecycleGeneration++; clear(); sessionActive = true; });
	pi.on("session_tree", () => { lifecycleGeneration++; clear(); });
	pi.on("session_shutdown", () => { lifecycleGeneration++; clear(); options.budget.clear(); sessionActive = false; });

	return {
		closeOut(windowId: string, source: ResetRequestSource, prompt?: string) {
			const decision = reduceResetControl(control, { type: "close_out", windowId, source, prompt });
			control = decision.state;
			return decision.effect;
		},
		request(windowId: string, lastWord?: string) {
			const decision = reduceResetControl(control, { type: "tool_request", windowId, ...(lastWord ? { lastWord } : {}) });
			control = decision.state;
			return decision.effect === "already-pending" ? "rollover_already_pending" : "rollover_requested";
		},
		clear,
	};
}
