import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { currentReset, currentWindowId } from "../window.js";
import { nextHistorySeq } from "../history.js";
import { resetBoundaryCommitted } from "./committed.js";
import type { ResetOrigin } from "../../budget/text.js";
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
	buildReset: (ctx: ExtensionContext, isCurrent: () => boolean, lastWord: string | undefined, firstSeq: number, origin: ResetOrigin) => SessionBoundaryDraft[] | Promise<SessionBoundaryDraft[]>;
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

export type ResetRequest =
	| { readonly phase: "none" }
	// A hard-reserve reset may precede the end of Pi's tool-batch continuation.
	| { readonly phase: "stop-pending"; readonly windowId: string; readonly tool?: { readonly lastWord?: string } }
	| { readonly phase: "pending"; readonly windowId: string;
		readonly command?: { readonly continueAfterReset: boolean };
		readonly tool?: { readonly lastWord?: string } };
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
	| { readonly type: "command"; readonly windowId: string; readonly continueAfterReset: boolean }
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
	readonly lastWord?: string;
	/** The origin of the boundary this decision commits. Absent means no `empty_brain` call was recorded, so forced. */
	readonly origin?: ResetOrigin;
}

function requestForWindow(request: ResetRequest, windowId: string): ResetRequest {
	return request.phase === "stop-pending" || (request.phase !== "none" && request.windowId === windowId) ? request : NO_REQUEST;
}

function commandCommit(request: Extract<ResetRequest, { phase: "pending" }>): ResetControlResult {
	return {
		state: initialResetControl(),
		effect: request.command?.continueAfterReset ? "commit-boundary" : "commit-boundary-stop",
		...requestDetails(request),
	};
}

/** The tool request itself is the origin fact; the stop latch retains it for construction retry. */
function requestDetails(request: ResetRequest): { origin: ResetOrigin; lastWord?: string } {
	const tool = request.phase === "none" ? undefined : request.tool;
	return { origin: tool ? "normal" : "forced", ...tool };
}

/** Pure transitions: command policy schedules a reset without disguising actual tool calls. */
export function reduceResetControl(state: ResetControlState, event: ResetControlEvent): ResetControlResult {
	switch (event.type) {
		case "command":
		case "tool_request": {
			const current = requestForWindow(state.request, event.windowId);
			if (current.phase === "stop-pending") return { state, effect: "already-pending" };
			const request = current.phase === "pending" ? current : { phase: "pending" as const, windowId: event.windowId };
			if (event.type === "command") {
				if (request.command) return { state, effect: "already-pending" };
				return { state: { ...state, request: { ...request, command: { continueAfterReset: event.continueAfterReset } } }, effect: "close-out-armed" };
			}
			// The call remains a real request even when command policy delays its commit.
			const duplicate = request.tool !== undefined;
			const lastWord = request.tool?.lastWord ?? event.lastWord;
			const tool = duplicate && !request.command ? request.tool : (lastWord ? { lastWord } : {});
			return { state: { ...state, request: { ...request, tool } }, effect: duplicate ? "already-pending" : "close-out-armed" };
		}
		case "turn_end": {
			const facts = event.facts;
			const request = requestForWindow(state.request, facts.windowId);
			if (facts.aborted) return { state: initialResetControl(), effect: "none" };
			if (request.phase === "stop-pending") return { state: { request, overflow: "idle" }, effect: "none" };
			const manual = request.phase === "pending" && request.command !== undefined;
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
			if ((request.phase === "pending" && request.tool && !manual) || facts.hardReserveDue) {
				if (manual && request.command?.continueAfterReset) return commandCommit(request);
				if (manual) return { state: { request: { phase: "stop-pending", windowId: facts.windowId, ...(request.tool ? { tool: request.tool } : {}) }, overflow: "idle" }, effect: "commit-boundary-stop", ...requestDetails(request) };
				return { state: { request: NO_REQUEST, overflow: "idle" }, effect: "commit-boundary", ...requestDetails(request) };
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
				return { state: initialResetControl(), effect: facts.failed || !facts.enabled ? "none" : "commit-boundary-stop", ...requestDetails(request) };
			}
			const manual = request.phase === "pending" && request.command !== undefined;
			if (state.overflow === "pending" || state.overflow === "pending-spent") {
				if (facts.queued) {
					return { state: { ...state, request: facts.failed && !manual ? NO_REQUEST : request }, effect: "none" };
				}
				// An explicit manual wipe is not an automatic recovery/retry. It must still
				// clear on overflow, including when automatic reset is disabled.
				if (manual && facts.enabled) return commandCommit(request);
				const spent = state.overflow === "pending-spent";
				if (!facts.enabled || !facts.automaticResetEnabled) {
					return { state: { request: facts.failed ? NO_REQUEST : request, overflow: spent ? "spent" : "idle" }, effect: "none" };
				}
				return { state: { request: NO_REQUEST, overflow: "spent" }, effect: spent ? "none" : "recover-overflow", ...requestDetails(request) };
			}
			if (facts.failed || !facts.enabled || !manual) {
				return { state: { ...state, request: NO_REQUEST }, effect: "none" };
			}
			if (facts.queued) return { state: { ...state, request }, effect: "none" };
			return commandCommit(request);
		}
		case "settled":
			return { state: initialResetControl(), effect: "none" };
		case "abort":
		case "clear":
			return { state: initialResetControl(), effect: "none" };
	}
}

/**
 * Tool-only requests commit at turn_end; command policy waits for settlement.
 * Hard reserve may commit earlier while preserving a command's stop latch.
 * Budget warnings carry no lifecycle state. Overflow recovery remains bounded.
 */
export function registerResetLifecycle(pi: ExtensionAPI, options: ResetOptions) {
	let sessionActive = true;
	let lifecycleGeneration = 0;
	let control = initialResetControl();

	const clear = () => { control = reduceResetControl(control, { type: "clear" }).state; };
	const resetBoundaryResult = async (entries: SessionBoundaryDraft[], ctx: ExtensionContext, continueAfterReset: boolean, lastWord: string | undefined, origin: ResetOrigin) => {
		const generation = lifecycleGeneration;
		const outerGeneration = options.getLifecycleGeneration?.();
		const sessionId = ctx.sessionManager.getSessionId();
		const windowId = currentWindowId(ctx);
		const isCurrent = () => sessionActive && lifecycleGeneration === generation &&
			(outerGeneration === undefined || options.getLifecycleGeneration?.() === outerGeneration) && options.isEnabled() &&
			ctx.signal?.aborted !== true && ctx.sessionManager.getSessionId() === sessionId && currentWindowId(ctx) === windowId;
		// The retain-none checkpoint belongs to the old window; capture its successor before notes await.
		const firstSeq = nextHistorySeq(ctx, entries) + 1;
		let resetDrafts: SessionBoundaryDraft[];
		try {
			resetDrafts = await options.buildReset(ctx, isCurrent, lastWord, firstSeq, origin);
		} catch (error) {
			if (isCurrent()) ctx.ui.notify(`🥣 Brain still full: ${errorMessage(error)}`, "warning");
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
		if (decision.effect === "commit-boundary" || decision.effect === "commit-boundary-stop") return await resetBoundaryResult(entries, ctx, decision.effect === "commit-boundary", decision.lastWord, decision.origin ?? "forced");
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
		return await resetBoundaryResult(event.entries, ctx, decision.effect !== "commit-boundary-stop", decision.lastWord, decision.origin ?? "forced");
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!sessionActive) return undefined;
		if (event.signal.aborted) return { cancel: true };
		const markerExists = currentReset(ctx) !== undefined;
		if (options.isEnabled() || markerExists) {
			if (event.reason === "manual") {
				ctx.ui.notify("🥣 No compacting brains here · use /fresh-window", "warning");
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
		command(windowId: string, continueAfterReset: boolean) {
			const decision = reduceResetControl(control, { type: "command", windowId, continueAfterReset });
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
