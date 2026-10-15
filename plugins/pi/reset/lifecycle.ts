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
	// A hard-reserve reset may precede the end of Pi's tool-batch continuation.
	| { readonly phase: "stop-pending"; readonly windowId: string; readonly tool?: { readonly lastWord?: string } }
	| { readonly phase: "pending"; readonly windowId: string;
		readonly command?: { readonly continueAfterReset: boolean; readonly inputs?: readonly CarriedInput[] };
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
	| { readonly type: "command"; readonly windowId: string; readonly continueAfterReset: boolean; readonly input?: CarriedInput }
	| { readonly type: "input"; readonly windowId: string; readonly input: CarriedInput }
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

function commandContinues(request: Extract<ResetRequest, { phase: "pending" }>): boolean {
	return request.command?.continueAfterReset === true || (request.command?.inputs?.length ?? 0) > 0;
}

function commandCommit(request: Extract<ResetRequest, { phase: "pending" }>, overflow = false): ResetControlResult {
	return {
		state: { request: NO_REQUEST, overflow: overflow ? "spent" : "idle" },
		effect: commandContinues(request) ? "commit-boundary" : "commit-boundary-stop",
		...requestDetails(request),
		...(overflow ? { origin: "forced" as const } : {}),
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
		case "input": {
			const request = requestForWindow(state.request, event.windowId);
			if (request.phase !== "pending" || !request.command) return { state, effect: "none" };
			return { state: { ...state, request: { ...request, command: { ...request.command, inputs: [...(request.command.inputs ?? []), event.input] } } }, effect: "none" };
		}
		case "command":
		case "tool_request": {
			const current = requestForWindow(state.request, event.windowId);
			if (current.phase === "stop-pending") return { state, effect: "already-pending" };
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
				if (manual && commandContinues(request)) return commandCommit(request);
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
				if (manual && facts.enabled) return commandCommit(request, true);
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
			if (draft.type === "custom_message") pi.sendMessage(draft, { triggerTurn: false });
		}
		runInputs.push(...inputs);
	};
	const clear = (preserveInputs = true) => {
		if (preserveInputs) restoreCommandInputs();
		control = reduceResetControl(control, { type: "clear" }).state;
		runInputs = [];
		commandId = undefined;
	};
	const resetBoundaryResult = async (entries: SessionBoundaryDraft[], ctx: ExtensionContext, decision: ResetControlResult) => {
		// Keep command state live while notes load: input arriving during this await must
		// join this very boundary even if its steer cannot reach the closing model.
		const passiveInputs = decision.effect === "recover-overflow" ? runInputs : [];
		const origin = decision.origin ?? "forced";
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
			resetDrafts = await options.buildReset(ctx, isCurrent, decision.lastWord, firstSeq, origin);
		} catch (error) {
			if (isCurrent()) ctx.ui.notify(`🥣 Brain still full: ${errorMessage(error)}`, "warning");
			return entries.length > 0 ? { entries } : undefined;
		}
		if (!isCurrent()) return entries.length > 0 ? { entries } : undefined;
		const request = control.request;
		const inputs = request.phase === "pending" && request.command ? request.command.inputs ?? [] : passiveInputs;
		control = decision.state;
		if (inputs.length > 0 && control.request.phase === "stop-pending") control = { ...control, request: NO_REQUEST };
		runInputs = [];
		options.onResetReady?.(ctx, resetDrafts);
		return { entries: [...entries, ...resetDrafts, ...carriedInputDrafts(inputs)], continue: inputs.length > 0 || decision.effect !== "commit-boundary-stop" };
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
		if (!sessionActive || request.phase !== "stop-pending" || ctx.hasPendingMessages()) return filtered;
		const marker = currentReset(ctx);
		if (!marker || marker.data.windowId === request.windowId || !resetBoundaryCommitted(ctx, marker.id, marker.data.windowId)) return filtered;
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
		if (decision.effect === "commit-boundary" || decision.effect === "commit-boundary-stop") return await resetBoundaryResult(entries, ctx, decision);
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
		if (decision.effect === "commit-boundary" || decision.effect === "commit-boundary-stop" || decision.effect === "recover-overflow") return await resetBoundaryResult(event.entries, ctx, decision);
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
	pi.on("session_start", () => { lifecycleGeneration++; clear(false); sessionActive = true; });
	pi.on("session_tree", () => { lifecycleGeneration++; clear(false); });
	pi.on("session_shutdown", () => { lifecycleGeneration++; clear(false); options.budget.clear(); sessionActive = false; });

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
