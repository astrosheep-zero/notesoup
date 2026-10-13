import { readFileSync } from "node:fs";
import { resetBoundaryCommitted } from "./reset/committed.js";
import { getCurrentSystemMessage, Type } from "@earendil-works/pi-ai";
import { VERSION, defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerBudget } from "./budget.js";
import { output } from "./tool-result.js";
import { currentReset, currentWindowId, isCheckpointBackedReset, isWindowBoot, isWindowMarker, projectRootWindow, projectWindow, rootWindowId, type WindowMarker } from "./window.js";
import { registerResetLifecycle } from "./reset/lifecycle.js";
import { buildResetDrafts, MAX_LAST_WORD_CHARS, repairResetTail, sanitizeLastWord } from "./reset/artifacts.js";
import { BOOT_TYPE, MANUAL_WIPE_TYPE } from "./entries.js";
import { WARNING_CONTENT } from "../budget/text.js";
import { buildBootMessage, sendBoot, type IncompleteNotesNotifier } from "./boot.js";
import { errorMessage } from "../error-message.js";

function readPackageVersion(): string {
	for (const up of ["../../package.json", "../../../package.json"]) {
		try { const { version } = JSON.parse(readFileSync(new URL(up, import.meta.url), "utf8")) as { version?: string }; if (version) return version; }
		catch { /* try the next candidate */ }
	}
	return "dev";
}

const buildLabel = `v${readPackageVersion()}`;

function branchHasWindowMarker(ctx: ExtensionContext, fromId?: string): boolean {
	return ctx.sessionManager.getBranch(fromId).some((entry) => isWindowMarker(entry));
}

/**
 * Boot entry point for `session_start` / `session_tree`. Ordinary startup ensures one root
 * boot; a reset marker instead asks reset-artifact repair to complete its persisted tail.
 */
async function ensureBoot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	notifyIncompleteNotes?: IncompleteNotesNotifier,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	const reset = currentReset(ctx);
	const windowId = reset?.data.windowId ?? rootWindowId(sessionId);
	const stillCurrent = () => isCurrent() &&
		ctx.signal?.aborted !== true &&
		ctx.sessionManager.getSessionId() === sessionId &&
		currentWindowId(ctx) === windowId;
	if (reset) {
		await repairResetTail(pi, ctx, reset, notifyIncompleteNotes, stillCurrent);
		return;
	}
	if (ctx.sessionManager.buildSessionProjection().messages.some((message) => isWindowBoot(message, windowId))) return;
	const boot = await buildBootMessage(ctx, windowId, undefined, notifyIncompleteNotes, stillCurrent);
	if (!stillCurrent()) return;
	if (ctx.sessionManager.buildSessionProjection().messages.some((message) => isWindowBoot(message, windowId))) return;
	sendBoot(pi, boot);
}

/** Register the context-window runtime and its context-owned commands/tools. */
export function registerContext(pi: ExtensionAPI, settingsManager?: SettingsManager): void {
	let enabled = true;
	let lifecycleGeneration = 0;
	let missingBootNotice: string | undefined;
	const incompleteNotesNotified = new Set<string>();
	const pendingResetNotices = new Set<string>();
	// Announce only a fully committed reset (marker + matching boot + continuation), not a
	// reset request or a partial boot repair.
	const notifyCommittedResets = (ctx: ExtensionContext, addedWindowId?: string) => {
		if (addedWindowId) pendingResetNotices.add(addedWindowId);
		if (pendingResetNotices.size === 0) return;
		const branch = ctx.sessionManager.getBranch();
		for (const windowId of pendingResetNotices) {
			const marker = branch.find((entry): entry is WindowMarker => isWindowMarker(entry) && entry.data.windowId === windowId);
			if (!marker || !isCheckpointBackedReset(ctx, marker) || !resetBoundaryCommitted(ctx, marker.id, windowId)) continue;
			pendingResetNotices.delete(windowId);
			ctx.ui.notify("🥣 Memory cleared", "info");
		}
	};
	pi.on("turn_start", (_event, ctx) => notifyCommittedResets(ctx));
	pi.on("agent_settled", (_event, ctx) => {
		notifyCommittedResets(ctx);
		pendingResetNotices.clear();
	});
	const notifyIncompleteNotes: IncompleteNotesNotifier = (ctx, windowId, snapshot) => {
		if (snapshot.unavailable.length === 0 || incompleteNotesNotified.has(windowId)) return;
		incompleteNotesNotified.add(windowId);
		const homes = snapshot.unavailable.map((home) => home.label).join(", ");
		ctx.ui.notify(`🥣 Some notes didn't load: ${homes}`, "warning");
	};
	const budget = registerBudget(pi, () => enabled, settingsManager);

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++lifecycleGeneration;
		if (!enabled) return;
		missingBootNotice = undefined;
		pendingResetNotices.clear();
		await ensureBoot(pi, ctx, notifyIncompleteNotes, () => generation === lifecycleGeneration && enabled);
	});
	pi.on("session_tree", async (_event, ctx) => {
		const generation = ++lifecycleGeneration;
		missingBootNotice = undefined;
		pendingResetNotices.clear();
		if (enabled) await ensureBoot(pi, ctx, notifyIncompleteNotes, () => generation === lifecycleGeneration && enabled);
	});
	pi.on("session_shutdown", () => {
		lifecycleGeneration++;
		pendingResetNotices.clear();
	});

	// Pi's branch summarizer receives raw entries and bypasses context_with_system. Do not
	// let a summary of a reset branch smuggle erased history back into the destination.
	pi.on("session_before_tree", (event, ctx) => {
		if (!event.preparation.userWantsSummary) return undefined;
		if (!branchHasWindowMarker(ctx) && !branchHasWindowMarker(ctx, event.preparation.targetId)) return undefined;
		ctx.ui.notify("🥣 Branch summary skipped · it would bring back cleared memory", "info");
		return { summary: { summary: "" } };
	});

	// This is the final provider-facing projection. Reset windows cut at their matching boot;
	// root windows only refresh a forked boot identity and retain the copied root transcript.
	pi.on("context_with_system", (event, ctx) => {
		const reset = currentReset(ctx);
		const windowId = reset?.data.windowId ?? rootWindowId(ctx.sessionManager.getSessionId());
		try {
			if (reset) {
				if (!event.messages.some((message) => isWindowBoot(message, windowId))) throw new Error(`Missing boot for context window ${windowId}`);
				return { messages: isCheckpointBackedReset(ctx, reset) ? event.messages : projectWindow(event.messages, windowId) };
			}
			return { messages: projectRootWindow(event.messages, windowId) };
		} catch (error) {
			if (missingBootNotice !== windowId) {
				missingBootNotice = windowId;
				ctx.ui.notify("🥣 Request cancelled · this memory window is broken, run /fresh-window", "error");
			}
			ctx.abort();
			const safeHead = getCurrentSystemMessage(event.messages);
			return { messages: safeHead ? [safeHead] : [] };
		}
	});

	pi.registerCommand("notesoup", {
		description: "Show loaded version/build and toggle notesoup context windows",
		getArgumentCompletions: (prefix) =>
			["on", "off"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
		handler: async (args, cmdCtx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				enabled = true;
				const generation = ++lifecycleGeneration;
				await ensureBoot(pi, cmdCtx, notifyIncompleteNotes, () => generation === lifecycleGeneration && enabled);
			} else if (arg === "off") {
				enabled = false;
				lifecycleGeneration++;
				pendingResetNotices.clear();
				incompleteNotesNotified.clear();
				missingBootNotice = undefined;
				budget.clear();
				resets.clear();
			} else if (arg !== "") {
				cmdCtx.ui.notify("Usage: /notesoup [on|off]", "error");
				return;
			}
			const remaining = budget.statusFor(cmdCtx).remaining;
			cmdCtx.ui.notify(`🥣 notesoup ${enabled ? "on" : "off"} · ${buildLabel} · Pi ${VERSION}${remaining === null ? "" : ` · ${remaining.toLocaleString("en-US")} tokens left`}`, "info");
		},
	});

	const neuralyzeCommand = {
		description: "Flush memory to notes and continue in a fresh window; optional prompt runs there",
		handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
			if (!enabled) {
				cmdCtx.ui.notify("🥣 notesoup is off · run /notesoup on first", "error");
				return;
			}
			const requestedWindowId = currentWindowId(cmdCtx);
			if (!cmdCtx.isIdle() && !cmdCtx.signal) {
				await cmdCtx.waitForIdle();
				if (!enabled || currentWindowId(cmdCtx) !== requestedWindowId) return;
			}
			// Manual wipes close out at settlement, then stop or continue with the prompt. The hidden warning goes out in both cases — triggered when idle,
			// steered into the running turn when busy — so the agent closes out promptly
			// instead of the reset waiting for the whole run.
			const prompt = args.trim() || undefined;
			const armed = resets.closeOut(requestedWindowId, "manual", prompt);
			if (armed === "already-pending") {
				cmdCtx.ui.notify("🥣 Neuralyze already queued · the first prompt is kept", "info");
				return;
			}
			cmdCtx.ui.notify(prompt
				? "🥣 Clearing memory · notes first, then your prompt runs"
				: "🥣 Clearing memory · notes first, then it stops", "info");
			try {
				pi.sendMessage({ customType: MANUAL_WIPE_TYPE, content: WARNING_CONTENT, display: false }, { triggerTurn: true, deliverAs: "steer" });
			} catch (error) {
				resets.clear();
				cmdCtx.ui.notify(`🥣 Couldn't start /fresh-window: ${errorMessage(error)}`, "error");
			}
		},
	};
	pi.registerCommand("neuralyze", neuralyzeCommand);
	pi.registerCommand("fresh-window", neuralyzeCommand);

	pi.registerTool(defineTool({
		name: "neuralyze",
		label: "Neuralyze",
		description: "Clear your in-context memory and start a fresh context window. Your session, notes, and history survive. Pass `last_word` to stick a tiny note on your forehead for after the wipe.",
		parameters: Type.Object({ last_word: Type.Optional(Type.String({ maxLength: MAX_LAST_WORD_CHARS, description: `A tiny sticky note, at most ${MAX_LAST_WORD_CHARS} characters. After the wipe it is slapped on your forehead; longer notes are refused.` })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			if (!enabled) return output({ error: "notesoup is off, so memory can't be cleared; the user can turn it on with `/notesoup on`." });
			const lastWord = sanitizeLastWord(params.last_word);
			const length = lastWord ? Array.from(lastWord).length : 0;
			if (length > MAX_LAST_WORD_CHARS) return output({ error: `last_word is ${length} characters; the sticky note holds ${MAX_LAST_WORD_CHARS}. Shorten it and call again.` });
			return output({ status: resets.request(currentWindowId(ctx), lastWord) }, undefined, true);
		},
	}));

	const resets = registerResetLifecycle(pi, {
		isEnabled: () => enabled,
		buildReset: (ctx, isCurrent, prompt, lastWord) => buildResetDrafts(ctx, notifyIncompleteNotes, isCurrent, prompt, lastWord),
		getLifecycleGeneration: () => lifecycleGeneration,
		onResetReady: (_ctx, drafts) => {
			const boot = drafts.find((draft) => draft.type === "custom_message" && draft.customType === BOOT_TYPE);
			if (boot?.type === "custom_message" && boot.details && typeof boot.details === "object") {
				const windowId = (boot.details as { windowId?: unknown }).windowId;
				if (typeof windowId === "string") pendingResetNotices.add(windowId);
			}
		},
		budget,
	});
	budget.setCloseOut((windowId) => resets.closeOut(windowId, "automatic"));
}
