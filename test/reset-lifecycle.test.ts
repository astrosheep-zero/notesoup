import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBoundaryDraft,
	SessionManager,
	ToolDefinition,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { SessionManager as Manager } from "@earendil-works/pi-coding-agent";
import notesoup from "../src/pi/extension.js";
import { BOOT_TYPE, CONTINUATION_TYPE, GUIDANCE_TYPE, RESET_LAST_WORD_TYPE, RESET_MARKER_TYPE, RESET_PROMPT_TYPE } from "../src/pi/entries.js";
import { MANUAL_WIPE_TYPE } from "../src/pi/entries.js";
import { assertBootHistory, toolContext } from "./helpers/extension.js";
import { WARNING_CALL_PROMPTED, warningContent } from "../src/budget/text.js";
import { historyFromSession, nextHistorySeq } from "../src/pi/history.js";
import { buildResetDrafts, LAST_WORD_PREFIX, MAX_LAST_WORD_CHARS, sanitizeLastWord } from "../src/pi/reset/artifacts.js";
import {
	initialResetControl,
	reduceResetControl,
	registerResetLifecycle,
	type ResetBeforeSettleFacts,
	type ResetControlState,
	type ResetTurnEndFacts,
} from "../src/pi/reset/lifecycle.js";

const previousNotesHome = process.env.PI_NOTES_HOME;
const testNotesHome = mkdtempSync(join(tmpdir(), "notesoup-lifecycle-notes-"));
process.env.PI_NOTES_HOME = testNotesHome;
test.after(() => {
	if (previousNotesHome === undefined) delete process.env.PI_NOTES_HOME;
	else process.env.PI_NOTES_HOME = previousNotesHome;
	rmSync(testNotesHome, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

function harness() {
	const sessionManager = Manager.inMemory("/private/tmp/notesoup-lifecycle-test");
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, Command>();
	const sent: Array<{ customType: string; details?: unknown; triggerTurn?: boolean }> = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		registerFlag() {},
		appendEntry(customType: string, data?: unknown) { sessionManager.appendCustomEntry(customType, data); },
		sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean }) {
			sent.push({ customType: message.customType, details: message.details, triggerTurn: options?.triggerTurn });
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
	notesoup(api as unknown as ExtensionAPI);
	const ctx = {
		sessionManager,
		cwd: "/private/tmp",
		model: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		getContextUsage: () => undefined,
		compact: () => assert.fail("the reset path must not call ctx.compact()"),
		abort: () => {},
		isProjectTrusted: () => true,
		ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	const runCommand = async (name: string, args = "") => {
		const command = commands.get(name);
		assert.ok(command, `${name} command is registered`);
		const commandCtx = Object.assign({}, ctx, {
			waitForIdle: async () => {},
			ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
		}) as unknown as ExtensionCommandContext;
		await command.handler(args, commandCtx);
	};
	const callTool = async (name: string, params: Record<string, unknown> = {}): Promise<AgentToolResult<unknown>> => {
		const tool = tools.get(name);
		assert.ok(tool, `${name} is registered`);
		// Pi 1.0 hands a tool the session context plus the nested-call surface; toolContext builds it.
		return tool.execute("call", params, new AbortController().signal, () => {}, toolContext(ctx));
	};
	return { sessionManager, handlers, sent, notices, emit, runCommand, callTool };
}

function resultEntries(results: unknown[]): { entries: SessionBoundaryDraft[]; continue: boolean } {
	let entries: SessionBoundaryDraft[] = [];
	let shouldContinue = false;
	for (const result of results) {
		if (!result || typeof result !== "object") continue;
		const value = result as { entries?: SessionBoundaryDraft[]; continue?: boolean };
		if (value.entries) entries = value.entries;
		if (value.continue !== undefined) shouldContinue = value.continue;
	}
	return { entries, continue: shouldContinue };
}

function appendDrafts(sessionManager: SessionManager, entries: SessionBoundaryDraft[]): void {
	for (const entry of entries) {
		switch (entry.type) {
			case "custom": sessionManager.appendCustomEntry(entry.customType, entry.data); break;
			case "custom_message": sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details); break;
			case "context_edit": sessionManager.appendContextEdit(entry.targetId, entry.replacement); break;
			case "compaction": sessionManager.appendCompaction(entry.summary, entry.firstKeptEntryId, 0, entry.details, true, entry.usage); break;
		}
	}
}

function turnEndFacts(overrides: Partial<ResetTurnEndFacts> = {}): ResetTurnEndFacts {
	return {
		windowId: "pcw:test:window",
		aborted: false,
		overflow: false,
		failed: false,
		enabled: true,
		queued: false,
		automaticResetEnabled: true,
		hardReserveDue: false,
		...overrides,
	};
}

function beforeSettleFacts(overrides: Partial<ResetBeforeSettleFacts> = {}): ResetBeforeSettleFacts {
	return {
		windowId: "pcw:test:window",
		queued: false,
		enabled: true,
		automaticResetEnabled: true,
		aborted: false,
		failed: false,
		...overrides,
	};
}

function fakeBoundaryEvent(entries: SessionBoundaryDraft[] = [], message?: AgentMessage): TurnEndEvent {
	return {
		type: "turn_end",
		entries,
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
		outcome: "completed",
		turnIndex: 0,
		message: message ?? ({ role: "assistant", content: [], timestamp: Date.now() } as unknown as AgentMessage),
		toolResults: [],
		messageEntryId: "assistant-entry",
		toolResultEntryIds: [],
	} as TurnEndEvent;
}

test("public reset boundary drafts one marker, one boot, and one continuation after a tool batch", async () => {
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "before reset" }], timestamp: Date.now() });
	const first = await h.callTool("empty_brain");
	const second = await h.callTool("empty_brain");
	assert.ok(first.content.length > 0 && second.content.length > 0, "both tool calls return normally");

	const toolBatch: SessionBoundaryDraft[] = [{ type: "custom_message", customType: "foreign/tool-batch", content: "tool finished", display: false }];
	const boundary = resultEntries(await h.emit("turn_end", fakeBoundaryEvent(toolBatch)));
	assert.equal(boundary.continue, true, "the whole tool batch continues only after the boundary is committed");
	const markerDrafts = boundary.entries.filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
	const bootDrafts = boundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE);
	assert.equal(markerDrafts.length, 1, "duplicate wipe requests in one turn dedupe");
	assert.equal(bootDrafts.length, 1);
	assert.equal(boundary.entries[0]?.type, "custom_message", "ordinary tool-batch entries precede the reset drafts");
	assert.equal(boundary.entries[1]?.type, "compaction", "native retain-none checkpoint precedes the reset marker");
	assert.equal(boundary.entries[2]?.type, "custom");
	assert.equal(boundary.entries[3]?.type, "custom_message");
	const windowId = (markerDrafts[0] as { data: { windowId: string } }).data.windowId;
	assert.match(windowId, /^pcw:/);
	assert.equal((bootDrafts[0] as { details: { windowId: string } }).details.windowId, windowId);
	const continuationDrafts = boundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE);
	assert.equal(continuationDrafts.length, 1, "the boundary persists exactly one reset message");
	assert.equal(boundary.entries[4]?.type, "custom_message", "the continuation closes the ordered reset shape");
	appendDrafts(h.sessionManager, boundary.entries);
	const branch = h.sessionManager.getBranch();
	assert.deepEqual(branch.filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE).map((entry) => entry.type === "custom" ? entry.data : undefined), [{ windowId }]);
	assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE).length, 1);
});

test("manual /empty-brain spans tool turns and commits the stop at settlement", async () => {
	const h = harness();
	await h.runCommand("empty-brain");
	assert.ok(h.sent.some((message) => message.customType === MANUAL_WIPE_TYPE && message.triggerTurn === true), "the idle close-out warning starts a turn");
	const toolCallMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "notes_write", arguments: {} }],
		timestamp: Date.now(),
	} as unknown as AgentMessage;
	const midBatch = resultEntries(await h.emit("turn_end", fakeBoundaryEvent([], toolCallMessage)));
	assert.equal(midBatch.entries.length, 0, "a tool-call turn does not commit a manual close-out");
	const cleanTurn = resultEntries(await h.emit("turn_end", fakeBoundaryEvent()));
	assert.equal(cleanTurn.entries.length, 0, "even a clean turn end only keeps the close-out armed");
	const settle = resultEntries(await h.emit("agent_before_settle", {
		type: "agent_before_settle",
		entries: [],
		outcome: "completed",
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
	}));
	const markers = settle.entries.filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
	assert.equal(markers.length, 1, "the reset commits at settlement");
	assert.equal(settle.continue, false, "a manual wipe does not continue after the reset");
});

test("off stops future automatic/manual reset requests while an existing marker remains authoritative", async () => {
	const h = harness();
	await h.callTool("empty_brain");
	const first = resultEntries(await h.emit("turn_end", fakeBoundaryEvent()));
	assert.ok(first.entries.some((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE));
	appendDrafts(h.sessionManager, first.entries);
	await h.runCommand("notesoup", "off");
	const before = await h.emit("session_before_compact", {
		type: "session_before_compact",
		reason: "manual",
		willRetry: false,
		branchEntries: h.sessionManager.getBranch(),
		preparation: { tokensBefore: 100, firstKeptEntryId: null, keptMessages: [], droppedMessages: [] },
		signal: new AbortController().signal,
	});
	assert.deepEqual(before.at(-1), { cancel: true }, "/compact is canceled when an existing marker would expose old canonical history");
	const afterOff = resultEntries(await h.emit("turn_end", fakeBoundaryEvent()));
	assert.equal(afterOff.entries.length, 0, "off does not create another reset");
	await h.runCommand("notesoup", "on");
	await h.runCommand("empty-brain");
	assert.equal(h.sent.length, 1, "/empty-brain sends one hidden close-out warning and starts a normal turn");
	assert.equal(h.sent[0]?.triggerTurn, true);
	assert.equal(h.sent[0]?.customType, MANUAL_WIPE_TYPE);
	const warning = h.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === MANUAL_WIPE_TYPE);
	assert.ok(warning && warning.type === "custom_message");
	assert.equal(warning.content, warningContent());
	const markers = h.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
	assert.equal(markers.length, 1, "manual command waits for an agent boundary; it does not persist an immediate reset");
});

test("manual /empty-brain with a prompt shows the human's command line in the close-out", async () => {
	const h = harness();
	// Assert on values, not on the warning's wording: the command line must survive verbatim
	// and must precede the closing instruction, so the prompt cannot read as this window's task.
	await h.runCommand("empty-brain", "Continue reviewing the implementation");
	const warning = h.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === MANUAL_WIPE_TYPE);
	assert.ok(warning?.type === "custom_message", "the close-out warning is persisted");
	const content = String(warning.content);
	const promptLine = "/empty-brain Continue reviewing the implementation";
	const promptIndex = content.indexOf(promptLine);
	assert.ok(promptIndex >= 0, "the human's raw command line reaches the closing model");
	const closingIndex = content.indexOf(WARNING_CALL_PROMPTED);
	assert.ok(closingIndex > promptIndex, "the closing instruction follows the prompt, so the order stays prompt then act");
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === RESET_PROMPT_TYPE).length, 0, "the prompt itself still waits for the new window");
});

test("reset construction failure preserves incoming and budget drafts without continuation", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/notesoup-reset-failure-test");
	const handlers = new Map<string, Handler[]>();
	const notices: Array<{ message: string; type?: string }> = [];
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager,
		model: undefined,
		signal: undefined,
		hasPendingMessages: () => false,
		ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
	} as unknown as ExtensionContext;
	const budgetDraft: SessionBoundaryDraft = { type: "custom_message", customType: GUIDANCE_TYPE, content: "budget draft", display: false };
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: {
			automaticResetEnabled: () => true,
			hardReserveDue: () => false,
			consumeTurnEnd: () => [budgetDraft],
			clear: () => {},
		},
		buildReset: (_ctx, _isCurrent, prompt) => { assert.equal(prompt, "AFTER_RESET"); throw new Error("synthetic reset construction failure"); },
	});
	lifecycle.closeOut(`pcw:${sessionManager.getSessionId().slice(0, 8)}:root`, "manual", "AFTER_RESET");
	const incoming: SessionBoundaryDraft = { type: "custom_message", customType: "foreign/boundary", content: "foreign draft", display: false };
	const results = [];
	for (const handler of handlers.get("turn_end") ?? []) results.push(await handler(fakeBoundaryEvent([incoming]), ctx));
	for (const handler of handlers.get("agent_before_settle") ?? []) results.push(await handler(fakeBoundaryEvent([]), ctx));
	const result = resultEntries(results);
	assert.deepEqual(result.entries, [incoming, budgetDraft], "already-built drafts survive reset construction failure");
	assert.equal(result.continue, false, "a failed reset does not request continuation");
	assert.equal(notices.at(-1)?.type, "warning");
	assert.match(notices.at(-1)?.message ?? "", /Brain still full/);
	assert.match(notices.at(-1)?.message ?? "", /prompt not sent/);
});

test("reset seq is captured before asynchronous construction and counts only consuming drafts", async () => {
	const h = harness();
	const handlers = new Map<string, Handler>();
	const api = { on(name: string, handler: Handler) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
	const ctx = { sessionManager: h.sessionManager, model: undefined, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
	const targetId = h.sessionManager.appendMessage({ role: "user", content: "recorded", timestamp: Date.now() });
	const budgetDraft: SessionBoundaryDraft = { type: "custom_message", customType: GUIDANCE_TYPE, content: "pending budget", display: false };
	const incoming: SessionBoundaryDraft[] = [
		{ type: "custom", customType: "foreign/metadata" },
		{ type: "context_edit", targetId, replacement: null },
		{ type: "custom_message", customType: "foreign/message", content: "pending", display: false },
		{ type: "compaction", summary: "pending checkpoint", firstKeptEntryId: null },
	];
	const before = historyFromSession(ctx).highestSeq;
	let capturedSeq: number | undefined;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: { automaticResetEnabled: () => true, hardReserveDue: () => false, consumeTurnEnd: () => [budgetDraft], clear() {} },
		async buildReset(_ctx, _isCurrent, _prompt, _lastWord, firstSeq) {
			capturedSeq = firstSeq;
			await pending;
			return [];
		},
	});
	lifecycle.request(`pcw:${h.sessionManager.getSessionId().slice(0, 8)}:root`);
	const result = handlers.get("turn_end")!(fakeBoundaryEvent(incoming), ctx);
	assert.equal(capturedSeq, before + 5, "three consuming pending drafts, the old checkpoint and the next slot");
	h.sessionManager.appendCustomMessageEntry("foreign/during-await", "later", false);
	release();
	await result;
	assert.equal(capturedSeq, before + 5, "snapshot latency must not recalculate the window's first seq");
	appendDrafts(h.sessionManager, [...incoming, budgetDraft]);
	assert.equal(nextHistorySeq(ctx), historyFromSession(ctx).highestSeq + 1);
});

test("a stale async reset is discarded after a lifecycle switch without staging a notice", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/notesoup-stale-reset-test");
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager,
		model: undefined,
		signal: undefined,
		hasPendingMessages: () => false,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	let resolveBuild!: (drafts: SessionBoundaryDraft[]) => void;
	const pendingBuild = new Promise<SessionBoundaryDraft[]>((resolve) => { resolveBuild = resolve; });
	let readyCount = 0;
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: {
			automaticResetEnabled: () => true,
			hardReserveDue: () => false,
			consumeTurnEnd: () => [],
			clear: () => {},
		},
		buildReset: () => pendingBuild,
		onResetReady: () => { readyCount++; },
	});
	const windowId = `pcw:${sessionManager.getSessionId().slice(0, 8)}:root`;
	lifecycle.request(windowId);
	const incoming: SessionBoundaryDraft = { type: "custom_message", customType: "foreign/boundary", content: "preserve me", display: false };
	const turnEnd = handlers.get("turn_end")?.[0];
	const sessionTree = handlers.get("session_tree")?.[0];
	assert.ok(turnEnd && sessionTree);
	const pending = turnEnd(fakeBoundaryEvent([incoming]), ctx);
	await sessionTree({}, ctx);
	resolveBuild([{ type: "custom_message", customType: BOOT_TYPE, content: "stale", display: false }]);
	const result = resultEntries([await pending]);
	assert.deepEqual(result.entries, [incoming], "a switched lifecycle keeps incoming drafts but discards stale reset drafts");
	assert.equal(result.continue, false);
	assert.equal(readyCount, 0, "stale reset work cannot stage a success notice");
});

test("a queued success clears an overflow failure before settle recovery can reset", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/notesoup-queued-overflow-test");
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager,
		model: { contextWindow: 100_000, maxTokens: 4_096 },
		signal: undefined,
		hasPendingMessages: () => false,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	let resetCount = 0;
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: {
			automaticResetEnabled: () => true,
			hardReserveDue: () => false,
			consumeTurnEnd: () => [],
			clear: () => {},
		},
		buildReset: () => {
			resetCount += 1;
			return [];
		},
	});

	const failed = fakeBoundaryEvent();
	failed.message = { ...failed.message, stopReason: "error", errorMessage: "Prompt too long: context exceeds maximum context length" } as unknown as AgentMessage;
	const turnEnd = handlers.get("turn_end")?.[0];
	const beforeSettle = handlers.get("agent_before_settle")?.[0];
	assert.ok(turnEnd && beforeSettle);
	await turnEnd(failed, ctx);
	const queued = {
		...failed,
		type: "agent_before_settle",
		outcome: "error",
		context: { ...failed.context, pendingMessages: [{ role: "user", content: [{ type: "text", text: "queued success" }], timestamp: Date.now() }] },
	};
	assert.equal(await beforeSettle(queued, ctx), undefined, "a queued message defers overflow recovery");

	const success = fakeBoundaryEvent();
	await turnEnd(success, ctx);
	const settled = { ...queued, context: { ...queued.context, pendingMessages: [] }, outcome: "completed" };
	assert.equal(await beforeSettle(settled, ctx), undefined, "the successful queued turn clears the stale recovery");
	assert.equal(resetCount, 0);
});

test("reset-control: close-out phases deduplicate, span turns, and a tool call only acknowledges a manual close-out", () => {
	const windowId = "pcw:test:window";
	const first = reduceResetControl(initialResetControl(), { type: "close_out", windowId, source: "manual" });
	assert.equal(first.effect, "close-out-armed");
	assert.deepEqual(first.state.request, { phase: "close-out", windowId, source: "manual" });
	const duplicate = reduceResetControl(first.state, { type: "close_out", windowId, source: "manual" });
	assert.equal(duplicate.effect, "already-pending");
	const noteTurn = reduceResetControl(first.state, { type: "turn_end", facts: turnEndFacts() });
	assert.equal(noteTurn.effect, "none");
	assert.deepEqual(noteTurn.state.request, first.state.request, "note/tool turns do not consume close-out");
	const tool = reduceResetControl(noteTurn.state, { type: "tool_request", windowId });
	assert.equal(tool.effect, "already-pending", "the agent's wipe call must not convert a manual close-out into a turn-end commit pi can overrun");
	assert.deepEqual(tool.state.request, { phase: "close-out", windowId, source: "manual" });
	const commit = reduceResetControl(tool.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(commit.effect, "commit-boundary-stop", "a manual close-out commits at settlement and stops");
	assert.deepEqual(commit.state, initialResetControl());
});

test("reset-control: manual close-out converts a pending tool request into a settle stop", () => {
	const windowId = "pcw:test:window";
	const tool = reduceResetControl(initialResetControl(), { type: "tool_request", windowId });
	const manual = reduceResetControl(tool.state, { type: "close_out", windowId, source: "manual" });
	assert.equal(manual.effect, "close-out-armed", "the user's stop intent outranks the pending rollover");
	assert.deepEqual(manual.state.request, { phase: "close-out", windowId, source: "manual" });
	assert.equal(reduceResetControl(manual.state, { type: "turn_end", facts: turnEndFacts() }).effect, "none", "the converted request no longer commits at turn end");
	assert.equal(reduceResetControl(manual.state, { type: "before_settle", facts: beforeSettleFacts() }).effect, "commit-boundary-stop");
	const automatic = reduceResetControl(tool.state, { type: "close_out", windowId, source: "automatic" });
	assert.equal(automatic.effect, "already-pending", "an automatic close-out must not displace a pending tool commit");
});

test("reset-control: a tool call upgrades a budget close-out for a turn-end commit", () => {
	const windowId = "pcw:test:window";
	const budget = reduceResetControl(initialResetControl(), { type: "close_out", windowId, source: "automatic" }).state;
	const upgraded = reduceResetControl(budget, { type: "tool_request", windowId });
	assert.equal(upgraded.effect, "close-out-armed");
	assert.deepEqual(upgraded.state.request, { phase: "tool-requested", windowId, source: "automatic" }, "context pressure cannot wait for settlement");
	const commit = reduceResetControl(upgraded.state, { type: "turn_end", facts: turnEndFacts() });
	assert.equal(commit.effect, "commit-boundary", "the budget rollover continues in the fresh window");
});

test("reset-control: fallback is normal-stop only; hard reserve remains safety", () => {
	const windowId = "pcw:test:window";
	const manual = reduceResetControl(initialResetControl(), { type: "close_out", windowId, source: "manual" }).state;
	const fallback = reduceResetControl(manual, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(fallback.effect, "commit-boundary-stop", "manual close-out stops after the reset is committed");
	assert.deepEqual(fallback.state, initialResetControl());

	const automatic = reduceResetControl(initialResetControl(), { type: "close_out", windowId, source: "automatic" }).state;
	const normalStop = reduceResetControl(automatic, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(normalStop.effect, "none", "ignoring a budget warning and answering normally must not wipe memory");
	assert.deepEqual(normalStop.state, initialResetControl());
	const disabledAuto = reduceResetControl(automatic, { type: "before_settle", facts: beforeSettleFacts({ automaticResetEnabled: false }) });
	assert.equal(disabledAuto.effect, "none");
	assert.deepEqual(disabledAuto.state, initialResetControl());

	const safety = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ hardReserveDue: true }) });
	assert.equal(safety.effect, "commit-boundary");
	for (const outcome of [{ failed: true }, { aborted: true }]) {
		const notNormalStop = reduceResetControl(manual, { type: "before_settle", facts: beforeSettleFacts(outcome) });
		assert.equal(notNormalStop.effect, "none");
		assert.deepEqual(notNormalStop.state, initialResetControl());
	}
	assert.deepEqual(reduceResetControl(manual, { type: "settled" }).state, initialResetControl());
});

test("reset-control: manual stop survives a hard-reserve reset across windows without a second wipe", () => {
	const windowId = "pcw:test:window";
	const manual = reduceResetControl(initialResetControl(), { type: "close_out", windowId, source: "manual" }).state;
	const safety = reduceResetControl(manual, { type: "turn_end", facts: turnEndFacts({ hardReserveDue: true }) });
	assert.equal(safety.effect, "commit-boundary-stop");
	assert.deepEqual(safety.state.request, { phase: "stop-pending", windowId });
	const freshWindowId = "pcw:test:fresh";
	assert.equal(reduceResetControl(safety.state, { type: "tool_request", windowId: freshWindowId }).effect, "already-pending");
	assert.equal(reduceResetControl(safety.state, { type: "close_out", windowId: freshWindowId, source: "automatic" }).effect, "already-pending");
	const queued = reduceResetControl(safety.state, { type: "before_settle", facts: beforeSettleFacts({ windowId: freshWindowId, queued: true }) });
	assert.deepEqual(queued.state, safety.state);
	const freshTurn = reduceResetControl(queued.state, { type: "turn_end", facts: turnEndFacts({ windowId: freshWindowId, hardReserveDue: true }) });
	assert.equal(freshTurn.effect, "none");
	const stop = reduceResetControl(freshTurn.state, { type: "before_settle", facts: beforeSettleFacts({ windowId: freshWindowId }) });
	assert.equal(stop.effect, "stop", "the safety boundary already wiped; settlement must only stop");
	assert.deepEqual(stop.state, initialResetControl());
	assert.equal(reduceResetControl(safety.state, { type: "before_settle", facts: beforeSettleFacts() }).effect, "commit-boundary-stop", "a failed safety construction may be retried before settlement");
	assert.deepEqual(reduceResetControl(safety.state, { type: "abort" }).state, initialResetControl());
});

test("reset-control: manual overflow keeps stop intent while queued work supersedes the failure", () => {
	const windowId = "pcw:test:window";
	const manual = reduceResetControl(initialResetControl(), { type: "close_out", windowId, source: "manual" }).state;
	const overflow = reduceResetControl(manual, { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true, queued: true, automaticResetEnabled: false }) });
	assert.deepEqual(overflow.state.request, manual.request);
	const deferred = reduceResetControl(overflow.state, { type: "before_settle", facts: beforeSettleFacts({ failed: true, queued: true, automaticResetEnabled: false }) });
	assert.deepEqual(deferred.state, overflow.state);
	assert.equal(reduceResetControl(overflow.state, { type: "before_settle", facts: beforeSettleFacts({ failed: true, automaticResetEnabled: false }) }).effect, "commit-boundary-stop", "manual overflow resets but does not retry the model");
	const success = reduceResetControl(deferred.state, { type: "turn_end", facts: turnEndFacts() });
	assert.deepEqual(success.state.request, manual.request, "a successful queued turn clears only the overflow, not the manual wipe");
	assert.equal(success.state.overflow, "idle");
	assert.equal(reduceResetControl(success.state, { type: "before_settle", facts: beforeSettleFacts() }).effect, "commit-boundary-stop");
});

test("reset-control: abort and lifecycle transitions clear every pending phase", () => {
	const windowId = "pcw:test:window";
	const pending = reduceResetControl(initialResetControl(), { type: "close_out", windowId, source: "manual" }).state;
	const aborted = reduceResetControl(pending, { type: "turn_end", facts: turnEndFacts({ aborted: true }) });
	assert.equal(aborted.effect, "none");
	assert.deepEqual(aborted.state, initialResetControl());
	assert.deepEqual(reduceResetControl(pending, { type: "clear" }).state, initialResetControl());
	assert.deepEqual(reduceResetControl(pending, { type: "settled" }).state, initialResetControl());
});

test("reset-control: overflow recovery is armed at turn_end and spent exactly once at settle", () => {
	const armed = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) });
	assert.deepEqual(armed.state, { request: { phase: "none" }, overflow: "pending" });

	const recovered = reduceResetControl(armed.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(recovered.effect, "recover-overflow", "the first settle commits the bounded recovery");
	assert.deepEqual(recovered.state, { request: { phase: "none" }, overflow: "spent" });

	const repeated = reduceResetControl(recovered.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(repeated.effect, "none", "a spent recovery is never retried");

	const rearmed = reduceResetControl(recovered.state, { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) });
	assert.deepEqual(rearmed.state, { request: { phase: "none" }, overflow: "pending-spent" });
	const bounded = reduceResetControl(rearmed.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(bounded.effect, "none", "a second failure chain stays bounded to the spent attempt");
	assert.deepEqual(bounded.state, { request: { phase: "none" }, overflow: "spent" });
});

test("reset-control: a queued turn defers recovery and its success supersedes the failure", () => {
	const armed = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }).state;
	const deferred = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ queued: true }) });
	assert.equal(deferred.effect, "none");
	assert.deepEqual(deferred.state, armed, "a queued message leaves the overflow chain armed");

	const success = reduceResetControl(armed, { type: "turn_end", facts: turnEndFacts() });
	assert.deepEqual(success.state, initialResetControl(), "a successful queued turn clears the stale failure");
});

test("reset-control: disabled mode and explicit aborts disarm overflow without a recovery", () => {
	const armed = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }).state;

	const disabled = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ enabled: false }) });
	assert.equal(disabled.effect, "none");
	assert.deepEqual(disabled.state, { request: { phase: "none" }, overflow: "idle" });

	const automaticOff = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ automaticResetEnabled: false }) });
	assert.equal(automaticOff.effect, "none");
	assert.deepEqual(automaticOff.state, { request: { phase: "none" }, overflow: "idle" });

	const aborted = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ aborted: true }) });
	assert.equal(aborted.effect, "none");
	assert.deepEqual(aborted.state, { request: { phase: "none" }, overflow: "idle" });
});

test("reset-control: lazy guards preserve overflow policy ordering", () => {
	const calls = { queued: 0, automatic: 0, hardReserve: 0 };
	const facts: ResetTurnEndFacts = {
		windowId: "pcw:test:window",
		aborted: false,
		overflow: true,
		failed: true,
		enabled: true,
		get queued() { calls.queued += 1; return false; },
		get automaticResetEnabled() { calls.automatic += 1; return true; },
		get hardReserveDue() { calls.hardReserve += 1; return true; },
	};
	reduceResetControl(initialResetControl(), { type: "turn_end", facts });
	assert.deepEqual(calls, { queued: 1, automatic: 1, hardReserve: 0 }, "overflow checks never consult hard-reserve policy");

	const settleCalls = { queued: 0, enabled: 0, automatic: 0 };
	const settleFacts: ResetBeforeSettleFacts = {
		windowId: "pcw:test:window",
		get queued() { settleCalls.queued += 1; return true; },
		get enabled() { settleCalls.enabled += 1; return true; },
		get automaticResetEnabled() { settleCalls.automatic += 1; return true; },
		aborted: false,
		failed: false,
	};
	const pendingOverflow = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }).state;
	reduceResetControl(pendingOverflow, { type: "before_settle", facts: settleFacts });
	assert.deepEqual(settleCalls, { queued: 1, enabled: 0, automatic: 0 }, "queued settle checks no further overflow policy");
});

test("a committed reset places incoming and budget drafts before marker -> boot -> continuation", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/notesoup-reset-ordering-test");
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/private/tmp",
		isProjectTrusted: () => true,
		sessionManager,
		model: undefined,
		signal: undefined,
		hasPendingMessages: () => false,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const budgetDraft: SessionBoundaryDraft = { type: "custom_message", customType: GUIDANCE_TYPE, content: "budget draft", display: false };
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: {
			automaticResetEnabled: () => true,
			hardReserveDue: () => false,
			consumeTurnEnd: () => [budgetDraft],
			clear: () => {},
		},
		buildReset: (ctx, isCurrent, prompt, lastWord, firstSeq) => buildResetDrafts(ctx, undefined, isCurrent, prompt, lastWord, firstSeq),
	});
	lifecycle.request(`pcw:${sessionManager.getSessionId().slice(0, 8)}:root`);
	const incoming: SessionBoundaryDraft = { type: "custom_message", customType: "foreign/boundary", content: "incoming", display: false };
	const results = [];
	for (const handler of handlers.get("turn_end") ?? []) results.push(await handler(fakeBoundaryEvent([incoming]), ctx));
	const result = resultEntries(results);
	assert.equal(result.continue, true);
	const customTypes = (entries: readonly { readonly type: string; readonly customType?: string }[]) => entries.map((entry) => {
		if (entry.type === "compaction") return "native-compaction";
		assert.ok(entry.type === "custom" || entry.type === "custom_message", "the boundary only carries expected reset drafts here");
		return entry.customType;
	});
	assert.deepEqual(customTypes(result.entries), [
		"foreign/boundary",
		GUIDANCE_TYPE,
		"native-compaction",
		RESET_MARKER_TYPE,
		BOOT_TYPE,
		CONTINUATION_TYPE,
	], "ordinary and budget drafts precede the closed reset shape");
	appendDrafts(sessionManager, result.entries);
	const branch = sessionManager.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
	assert.ok(markerIndex > 0);
	assert.equal(branch[markerIndex - 1]?.type, "compaction", "the checkpoint is directly before the marker");
	const checkpoint = branch[markerIndex - 1];
	assert.ok(checkpoint?.type === "compaction");
	assert.equal(checkpoint.summary, "");
	assert.equal(checkpoint.firstKeptEntryId, checkpoint.id, "Pi materializes null as retain-none");
	const projection = historyFromSession(ctx);
	const boot = branch.find((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE);
	assert.ok(boot?.type === "custom_message");
	assertBootHistory(String(boot.content), projection);
	assert.equal(projection.windows[0]!.items.at(-1)!.seq, projection.windows[1]!.items[0]!.seq - 1, "the old window includes its checkpoint slot");
	assert.equal(nextHistorySeq(ctx), projection.highestSeq + 1);
	assert.deepEqual(customTypes(branch.slice(markerIndex)), [
		RESET_MARKER_TYPE,
		BOOT_TYPE,
		CONTINUATION_TYPE,
	], "the persisted reset shape remains marker -> boot -> continuation");
});

test("a empty_brain last word lands as a visible entry after the continuation", async () => {
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "before reset" }], timestamp: Date.now() });
	await h.callTool("empty_brain", { last_word: "feed the ants" });
	const boundary = resultEntries(await h.emit("turn_end", fakeBoundaryEvent()));
	const lastWords = boundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === RESET_LAST_WORD_TYPE);
	assert.equal(lastWords.length, 1, "the boundary persists exactly one parting line");
	assert.deepEqual(lastWords[0], { type: "custom_message", customType: RESET_LAST_WORD_TYPE, content: `${LAST_WORD_PREFIX}feed the ants`, display: true });
	const continuationIndex = boundary.entries.findIndex((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE);
	assert.ok(boundary.entries.indexOf(lastWords[0]!) > continuationIndex, "the parting line follows the continuation");
});

test("empty_brain trims the last word, refuses an oversized one, and a blank persists no entry", async () => {
	assert.equal(sanitizeLastWord("  hi  "), "hi");
	assert.equal(sanitizeLastWord("   "), undefined);
	assert.equal(sanitizeLastWord(undefined), undefined);
	const over = harness();
	over.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "before reset" }], timestamp: Date.now() });
	const refused = await over.callTool("empty_brain", { last_word: "x".repeat(MAX_LAST_WORD_CHARS + 1) });
	assert.match(JSON.stringify(refused), /error/, "an oversized note is refused, not truncated");
	const untouched = resultEntries(await over.emit("turn_end", fakeBoundaryEvent()));
	assert.equal(untouched.entries.filter((entry) => entry.type === "custom_message" && entry.customType === RESET_LAST_WORD_TYPE).length, 0, "a refused call requests no reset");
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "before reset" }], timestamp: Date.now() });
	await h.callTool("empty_brain", { last_word: "   " });
	const boundary = resultEntries(await h.emit("turn_end", fakeBoundaryEvent()));
	assert.equal(boundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === RESET_LAST_WORD_TYPE).length, 0, "a blank last word persists no entry");
});

test("reset-control: a tool request carries its last word to the turn-end commit", () => {
	const windowId = "pcw:test:window";
	const armed = reduceResetControl(initialResetControl(), { type: "tool_request", windowId, lastWord: "the shoes were loyal" });
	assert.equal(armed.effect, "close-out-armed");
	assert.deepEqual(armed.state.request, { phase: "tool-requested", windowId, source: "tool", lastWord: "the shoes were loyal" });
	const commit = reduceResetControl(armed.state, { type: "turn_end", facts: turnEndFacts() });
	assert.equal(commit.effect, "commit-boundary");
	assert.equal(commit.lastWord, "the shoes were loyal");
});

test("reset-control: a manual close-out adopts the acknowledging call's last word and still stops at settlement", () => {
	const windowId = "pcw:test:window";
	const manual = reduceResetControl(initialResetControl(), { type: "close_out", windowId, source: "manual" });
	const ack = reduceResetControl(manual.state, { type: "tool_request", windowId, lastWord: "tell them I was funny" });
	assert.equal(ack.effect, "already-pending", "the acknowledgement never converts the manual close-out");
	assert.deepEqual(ack.state.request, { phase: "close-out", windowId, source: "manual", lastWord: "tell them I was funny" });
	const silentAck = reduceResetControl(reduceResetControl(initialResetControl(), { type: "close_out", windowId, source: "manual" }).state, { type: "tool_request", windowId });
	assert.deepEqual(silentAck.state.request, { phase: "close-out", windowId, source: "manual" }, "no new key without a last word");
	const commit = reduceResetControl(ack.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(commit.effect, "commit-boundary-stop");
	assert.equal(commit.lastWord, "tell them I was funny");
});
