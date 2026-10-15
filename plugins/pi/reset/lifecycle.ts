import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { currentReset, currentWindowId } from "../window.js";
import { nextHistorySeq } from "../history.js";
import { resetBoundaryCommitted } from "./committed.js";
import type { ResetOrigin } from "../../../src/budget/text.js";
import { errorMessage } from "../../../src/error-message.js";
import { carriedInputDrafts, isCarriedInputEntry, type CarriedInput } from "./artifacts.js";
import { NEXT_WINDOW_PROMPT_TYPE } from "../entries.js";
import { promptBlock } from "../text.js";

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
	| { readonly phase: "pending"; readonly windowId: string;
		readonly command?: { readonly continueAfterReset: boolean; readonly inputs?: readonly CarriedInput[] };
		readonly tool?: { readonly lastWord?: string } };
export type ResetOverflowPhase = "idle" | "pending" | "pending-spent" | "spent";

export interface ResetControlState {
	readonly request: ResetRequest;
	/** Await settlement after a safety reset; retain its intent to retry if it never committed. */
	readonly stopAfterReset?: ResetBoundaryIntent;
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
	| { readonly type: "command"; readonly windowId: string; readonly continueAfterReset: boolean; readonly input?: CarriedInput }
	| { readonly type: "input"; readonly windowId: string; readonly input: CarriedInput }
	| { readonly type: "tool_request"; readonly windowId: string; readonly lastWord?: string }
	| { readonly type: "turn_end"; readonly facts: ResetTurnEndFacts }
	| { readonly type: "before_settle"; readonly facts: ResetBeforeSettleFacts };

/** Construction intent, not final state: handled inputs can still arrive while notes load. Only `turn-end`
 * may latch a stop; overflow kinds spend recovery; only `overflow-recovery` carries passive run inputs. */
export interface ResetBoundaryIntent {
	readonly effect: "build-boundary";
	readonly boundary: "turn-end" | "settle" | "command-overflow" | "overflow-recovery";
	readonly windowId: string;
	readonly continueAfterReset: boolean;
	readonly origin: ResetOrigin;
	readonly tool?: { readonly lastWord?: string };
}

export type ResetControlResult = ResetBoundaryIntent |
	{ readonly state: ResetControlState; readonly effect: "none" | "close-out-armed" | "already-pending" | "stop" };

function requestForWindow(request: ResetRequest, windowId: string): ResetRequest {
	return request.phase === "pending" && request.windowId === windowId ? request : NO_REQUEST;
}

const spendsOverflow = (boundary: ResetBoundaryIntent["boundary"]) => boundary === "command-overflow" || boundary === "overflow-recovery";

function boundaryIntent(request: ResetRequest, windowId: string, boundary: ResetBoundaryIntent["boundary"]): ResetBoundaryIntent {
	const tool = request.phase === "none" ? undefined : request.tool;
	const continueAfterReset = request.phase === "pending" ? request.command?.continueAfterReset ?? true : true;
	return { effect: "build-boundary", boundary, windowId, tool, continueAfterReset, origin: spendsOverflow(boundary) || !tool ? "forced" : "normal" };
}

/** Resolve once, after a successful current build. No delivery policy is left to the adapter. */
export function finalizeResetBoundary(intent: ResetBoundaryIntent, request: ResetRequest, passiveInputs: readonly CarriedInput[] = []) {
	const inputs = request.phase === "pending" && request.command ? request.command.inputs ?? []
		: intent.boundary === "overflow-recovery" ? passiveInputs : [];
	const resumeModel = intent.continueAfterReset || inputs.length > 0;
	const state: ResetControlState = {
		request: NO_REQUEST,
		...(intent.boundary === "turn-end" && !resumeModel ? { stopAfterReset: intent } : {}),
		overflow: spendsOverflow(intent.boundary) ? "spent" : "idle",
	};
	return { state, inputs, resumeModel };
}

/** Pure transitions: command policy schedules a reset without disguising actual tool calls. */
export function reduceResetControl(state: ResetControlState, event: Extract<ResetControlEvent, { type: "input" | "command" | "tool_request" }>): Extract<ResetControlResult, { state: ResetControlState }>;
export function reduceResetControl(state: ResetControlState, event: ResetControlEvent): ResetControlResult;
export function reduceResetControl(state: ResetControlState, event: ResetControlEvent): ResetControlResult {
	switch (event.type) {
		case "input": {
			const request = requestForWindow(state.request, event.windowId);
			if (request.phase !== "pending" || !request.command) return { state, effect: "none" };
			return { state: { ...state, request: { ...request, command: { ...request.command, inputs: [...(request.command.inputs ?? []), event.input] } } }, effect: "none" };
		}
		case "command":
		case "tool_request": {
			if (state.stopAfterReset) return { state, effect: "already-pending" };
			const current = requestForWindow(state.request, event.windowId);
			const request = current.phase === "pending" ? current : { phase: "pending" as const, windowId: event.windowId };
			if (event.type === "command") {
				if (request.command) return { state, effect: "already-pending" };
				return { state: { ...state, request: { ...request, command: { continueAfterReset: event.continueAfterReset, ...(event.input !== undefined ? { inputs: [event.input] } : {}) } } }, effect: "close-out-armed" };
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
			if (state.stopAfterReset) return { state: { ...state, overflow: "idle" }, effect: "none" };
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
				return boundaryIntent(request, facts.windowId, "turn-end");
			}
			return { state: { request, overflow: "idle" }, effect: "none" };
		}
		case "before_settle": {
			const facts = event.facts;
			if (facts.aborted) return { state: initialResetControl(), effect: "none" };
			const request = requestForWindow(state.request, facts.windowId);
			if (state.stopAfterReset) {
				if (facts.queued) return { state, effect: "none" };
				// A changed window confirms commit: stop without wiping twice. Otherwise retry.
				if (state.stopAfterReset.windowId !== facts.windowId) return { state: initialResetControl(), effect: "stop" };
				if (facts.failed || !facts.enabled) return { state: initialResetControl(), effect: "none" };
				return { ...state.stopAfterReset, boundary: "settle" };
			}
			const manual = request.phase === "pending" && request.command !== undefined;
			if (state.overflow === "pending" || state.overflow === "pending-spent") {
				if (facts.queued) {
					return { state: { ...state, request: facts.failed && !manual ? NO_REQUEST : request }, effect: "none" };
				}
				// An explicit manual wipe is not an automatic recovery/retry. It must still
				// clear on overflow, including when automatic reset is disabled.
				if (manual && facts.enabled) return boundaryIntent(request, facts.windowId, "command-overflow");
				const spent = state.overflow === "pending-spent";
				if (!facts.enabled || !facts.automaticResetEnabled) {
					return { state: { request: facts.failed ? NO_REQUEST : request, overflow: spent ? "spent" : "idle" }, effect: "none" };
				}
				if (spent) return { state: { request: NO_REQUEST, overflow: "spent" }, effect: "none" };
				return boundaryIntent(request, facts.windowId, "overflow-recovery");
			}
			if (facts.failed || !facts.enabled || !manual) {
				return { state: { ...state, request: NO_REQUEST }, effect: "none" };
			}
			if (facts.queued) return { state: { ...state, request }, effect: "none" };
			return boundaryIntent(request, facts.windowId, "settle");
		}
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
	let runInputs: CarriedInput[] = [];
	let commandId: string | undefined;

	// Once input returns handled, Pi no longer owns its original content. If close-out
	// fails/cancels, return that content to the transcript without starting another run.
	const restoreCommandInputs = () => {
		const request = control.request;
		if (request.phase !== "pending" || !request.command?.inputs?.length) return;
		const inputs = request.command.inputs;
		control = { ...control, request: { ...request, command: { ...request.command, inputs: [] } } };
		for (const draft of carriedInputDrafts(inputs)) {
			pi.sendMessage(draft, { triggerTurn: false });
		}
		runInputs.push(...inputs);
	};
	const clear = (preserveInputs = true) => {
		lifecycleGeneration++;
		if (preserveInputs) restoreCommandInputs();
		control = initialResetControl();
		runInputs = [];
		commandId = undefined;
	};
	const resetBoundaryResult = async (entries: SessionBoundaryDraft[], ctx: ExtensionContext, intent: ResetBoundaryIntent) => {
		// Keep command state live while notes load: input arriving during this await must
		// join this very boundary even if its steer cannot reach the closing model.
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
			resetDrafts = await options.buildReset(ctx, isCurrent, intent.tool?.lastWord, firstSeq, intent.origin);
		} catch (error) {
			if (isCurrent()) ctx.ui.notify(`🥣 Brain still full: ${errorMessage(error)}`, "warning");
			return entries.length > 0 ? { entries } : undefined;
		}
		if (!isCurrent()) return entries.length > 0 ? { entries } : undefined;
		const finalized = finalizeResetBoundary(intent, control.request, runInputs);
		control = finalized.state;
		runInputs = [];
		options.onResetReady?.(ctx, resetDrafts);
		return { entries: [...entries, ...resetDrafts, ...carriedInputDrafts(finalized.inputs)], continue: finalized.resumeModel };
	};

	// Pi may start multiple low-level loops while draining follow-ups/recovering.
	// Keep the logical run's inputs until settlement or a successful boundary.
	pi.on("message_end", (event) => {
		if (event.message.role === "user") runInputs.push(event.message.content);
	});
	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || !sessionActive || !options.isEnabled()) return undefined;
		const request = control.request;
		if (request.phase !== "pending" || !request.command || request.windowId !== currentWindowId(ctx)) return undefined;
		const content: CarriedInput = event.images?.length
			? [{ type: "text", text: event.text }, ...event.images]
			: event.text;
		control = reduceResetControl(control, { type: "input", windowId: request.windowId, input: content }).state;
		const steerContent: CarriedInput = event.images?.length
			? [{ type: "text", text: promptBlock(event.text) }, ...event.images]
			: promptBlock(event.text);
		pi.sendMessage({ customType: NEXT_WINDOW_PROMPT_TYPE, content: steerContent, display: false, details: { windowId: request.windowId, commandId } }, { deliverAs: "steer" });
		return { action: "handled" };
	});

	// Boundary continue:false is not a veto of Pi's tool-batch follow-up. Once the
	// safety reset is actually committed, cancel that empty follow-up before provider
	// work. Real queued user input is allowed through and answered before settlement.
	pi.on("context_with_system", (event, ctx) => {
		const request = control.request;
		// Steering can be queued during buildReset's await and arrive after the boundary.
		// It is closing-model context only; originals already live in the carried entries.
		const messages = event.messages.filter((message) => {
			if (message.role !== "custom" || message.customType !== NEXT_WINDOW_PROMPT_TYPE) return true;
			const details = message.details as { windowId?: unknown; commandId?: unknown } | undefined;
			return request.phase === "pending" && request.command !== undefined &&
				request.windowId === currentWindowId(ctx) && details?.windowId === request.windowId && commandId !== undefined && details?.commandId === commandId;
		});
		const filtered = messages.length === event.messages.length ? undefined : { messages };
		const stop = control.stopAfterReset;
		if (!sessionActive || !stop || ctx.hasPendingMessages()) return filtered;
		const marker = currentReset(ctx);
		if (!marker || marker.data.windowId === stop.windowId || !resetBoundaryCommitted(ctx, marker.id, marker.data.windowId)) return filtered;
		const branch = ctx.sessionManager.getBranch();
		const markerIndex = branch.findIndex((entry) => entry.id === marker.id);
		if (branch.slice(markerIndex + 1).some((entry) => (entry.type === "message" && entry.message.role === "user") || isCarriedInputEntry(entry))) return filtered;
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
		if (decision.effect === "build-boundary") return await resetBoundaryResult(entries, ctx, decision);
		if (aborted || (event.outcome === "error" && decision.state.request.phase === "none")) restoreCommandInputs();
		control = decision.state;
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
		if (decision.effect === "build-boundary") return await resetBoundaryResult(event.entries, ctx, decision);
		if (decision.state.request.phase === "none") restoreCommandInputs();
		control = decision.state;
		if (decision.effect === "stop") return { entries: event.entries, continue: false };
		return undefined;
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
		if (ctx.signal?.aborted) clear();
	});
	pi.on("agent_settled", () => {
		clear();
	});
	pi.on("session_start", () => { clear(false); sessionActive = true; });
	pi.on("session_tree", () => { clear(false); });
	pi.on("session_shutdown", () => { clear(false); options.budget.clear(); sessionActive = false; });

	return {
		command(windowId: string, continueAfterReset: boolean, input?: CarriedInput) {
			const decision = reduceResetControl(control, { type: "command", windowId, continueAfterReset, ...(input !== undefined ? { input } : {}) });
			control = decision.state;
			if (decision.effect === "close-out-armed") commandId = randomUUID();
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
