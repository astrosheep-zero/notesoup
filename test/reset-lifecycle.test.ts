import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
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
import notesoup from "../plugins/pi/extension.js";
import { BOOT_TYPE, CARRIED_INPUT_TYPE, CONTINUATION_TYPE, GUIDANCE_TYPE, RESET_LAST_WORD_TYPE, RESET_MARKER_TYPE } from "../plugins/pi/entries.js";
import { MANUAL_WIPE_TYPE } from "../plugins/pi/entries.js";
import { assertBootHistory, toolContext } from "./helpers/extension.js";
import { COUNTDOWN_LINE, FORCED_CONTINUATIONS, NORMAL_CONTINUATIONS } from "../src/budget/text.js";
import { commandWarningContent } from "../plugins/pi/text.js";
import { historyFromSession, nextHistorySeq } from "../plugins/pi/history.js";
import { buildResetDrafts, inspectResetTail, LAST_WORD_PREFIX, MAX_LAST_WORD_CHARS, repairResetTail, sanitizeLastWord } from "../plugins/pi/reset/artifacts.js";
import { resetBoundaryCommitted } from "../plugins/pi/reset/committed.js";
import {
	finalizeResetBoundary,
	initialResetControl,
	reduceResetControl,
	registerResetLifecycle,
	type ResetBeforeSettleFacts,
	type ResetControlResult,
	type ResetTurnEndFacts,
} from "../plugins/pi/reset/lifecycle.js";

const previousNotesHome = process.env.NOTESOUP_HOME;
const testNotesHome = mkdtempSync(join(tmpdir(), "notesoup-lifecycle-notes-"));
process.env.NOTESOUP_HOME = testNotesHome;
test.after(() => {
	if (previousNotesHome === undefined) delete process.env.NOTESOUP_HOME;
	else process.env.NOTESOUP_HOME = previousNotesHome;
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
	const toolParameters = (name: string) => {
		const tool = tools.get(name);
		assert.ok(tool, `${name} is registered`);
		return tool.parameters;
	};
	return { sessionManager, handlers, sent, notices, emit, runCommand, callTool, toolParameters };
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

function boundaryIntent(decision: ResetControlResult) {
	assert.ok(decision.effect === "build-boundary", "expected construction intent, not a state transition");
	return decision;
}

function controlState(decision: ResetControlResult) {
	assert.ok(decision.effect !== "build-boundary", "expected a state transition, not construction intent");
	return decision.state;
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
	assert.deepEqual(branch.filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE).map((entry) => entry.type === "custom" ? entry.data : undefined), [{ windowId, origin: "normal" }], "the boundary records the model's own call");
	assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE).length, 1);
});

test("manual /empty spans tool turns and commits the stop at settlement", async () => {
	const h = harness();
	await h.runCommand("empty");
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
	await h.runCommand("empty");
	assert.equal(h.sent.length, 1, "/empty sends one hidden close-out warning and starts a normal turn");
	assert.equal(h.sent[0]?.triggerTurn, true);
	assert.equal(h.sent[0]?.customType, MANUAL_WIPE_TYPE);
	const warning = h.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === MANUAL_WIPE_TYPE);
	assert.ok(warning && warning.type === "custom_message");
	assert.equal(warning.content, commandWarningContent());
	const markers = h.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
	assert.equal(markers.length, 1, "manual command waits for an agent boundary; it does not persist an immediate reset");
});

test("manual /empty with a prompt shows the human's command line in the close-out", async () => {
	const h = harness();
	// Structure and carried values are checked here; exact copy lives in model-facing-text tests.
	await h.runCommand("empty", "Continue reviewing the implementation");
	const warning = h.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === MANUAL_WIPE_TYPE);
	assert.ok(warning?.type === "custom_message", "the close-out warning is persisted");
	const content = String(warning.content);
	const promptLine = "/empty Continue reviewing the implementation";
	const promptIndex = content.indexOf(promptLine);
	assert.ok(promptIndex >= 0, "the human's raw command line reaches the closing model");
	assert.ok(promptIndex > content.indexOf("</notesoup:budget_notice>"), "deferred work is outside the notice");
	assert.ok(content.includes("Then call `empty_brain`. Nothing in between.\n" + COUNTDOWN_LINE), "the countdown immediately follows the reset call");
	assert.equal(content.split(COUNTDOWN_LINE).length - 1, 1, "the notice carries the countdown once");
	// The same original text becomes the new window's task, not a notes-only hint.
	const settle = resultEntries(await h.emit("agent_before_settle", {
		type: "agent_before_settle",
		entries: [],
		outcome: "completed",
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
	}));
	assert.equal(settle.continue, true, "a prompted close-out continues in the fresh window");
	assert.deepEqual(settle.entries.map((entry) => entry.type === "compaction" ? "native-compaction" : (entry as { customType?: string }).customType), [
		"native-compaction",
		RESET_MARKER_TYPE,
		BOOT_TYPE,
		CONTINUATION_TYPE,
		CARRIED_INPUT_TYPE,
	], "the reset tail ends with the carried human input");
	assert.deepEqual(settle.entries.at(-1), { type: "custom_message", customType: CARRIED_INPUT_TYPE, content: "Continue reviewing the implementation", display: true });
});

test("input arriving during reset construction survives even when the hidden steer is never delivered", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/notesoup-late-input-test");
	const handlers = new Map<string, Handler>();
	const steers: unknown[] = [];
	const api = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		sendMessage(message: unknown, options: unknown) { steers.push({ message, options }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/private/tmp", sessionManager, model: undefined, hasPendingMessages: () => false,
		isProjectTrusted: () => true, ui: { notify() {} },
	} as unknown as ExtensionContext;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: { automaticResetEnabled: () => true, hardReserveDue: () => false, consumeTurnEnd: () => [], clear() {} },
		async buildReset(ctx, isCurrent, lastWord, firstSeq, origin) {
			await gate;
			return buildResetDrafts(ctx, undefined, isCurrent, lastWord, firstSeq, origin);
		},
	});
	lifecycle.command(`pcw:${sessionManager.getSessionId().slice(0, 8)}:root`, false);
	lifecycle.request(`pcw:${sessionManager.getSessionId().slice(0, 8)}:root`, "handoff");
	const pending = handlers.get("agent_before_settle")!({ ...fakeBoundaryEvent(), type: "agent_before_settle" }, ctx);
	assert.equal(await handlers.get("input")!({ source: "extension", text: "not intercepted" }, ctx), undefined);
	assert.deepEqual(await handlers.get("input")!({ source: "rpc", text: "  first\ninput  " }, ctx), { action: "handled" });
	assert.deepEqual(await handlers.get("input")!({ source: "interactive", text: "second" }, ctx), { action: "handled" });
	release();
	const boundary = resultEntries([await pending]);
	assert.equal(boundary.continue, true, "late input overrides the bare command's stop");
	assert.deepEqual(boundary.entries.slice(-2).map((entry) => entry.type === "custom_message" ? entry.content : null), ["  first\ninput  ", "second"]);
	assert.equal(steers.length, 2, "steers were queued but never delivered by this host");
	appendDrafts(sessionManager, boundary.entries);
	const marker = sessionManager.getBranch().find((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE)!;
	const windowId = (marker as { data: { windowId: string } }).data.windowId;
	assert.equal(resetBoundaryCommitted(ctx, marker.id, windowId), true);
	assert.deepEqual(inspectResetTail(ctx, marker.id, windowId), { boot: true, continuation: true }, "last word and trailing inputs form a complete ordered boundary");
	await repairResetTail(api, ctx, marker as Parameters<typeof repairResetTail>[2]);
	assert.equal(steers.length, 2, "repair never duplicates a complete boundary with carried inputs");
	sessionManager.appendCustomMessageEntry(BOOT_TYPE, "late boot", false, { windowId });
	assert.equal(inspectResetTail(ctx, marker.id, windowId), undefined, "artifacts cannot restart after carried input");
	assert.equal(resetBoundaryCommitted(ctx, marker.id, windowId), true, "later malformed work does not undo a committed prefix");
	sessionManager.appendCompaction("", null, 0);
	const partialMarker = sessionManager.appendCustomEntry(RESET_MARKER_TYPE, { windowId: "partial" });
	sessionManager.appendCustomMessageEntry(BOOT_TYPE, "boot", false, { windowId: "partial" });
	sessionManager.appendCustomMessageEntry(CARRIED_INPUT_TYPE, "too early", true);
	assert.equal(inspectResetTail(ctx, partialMarker, "partial"), undefined, "repair cannot append a continuation after human content");
	assert.equal(resetBoundaryCommitted(ctx, partialMarker, "partial"), false);
});

test("overflow construction reads live run inputs and clear invalidates an unfinished build", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/notesoup-live-passive-input-test");
	const handlers = new Map<string, Handler>();
	const api = { on(name: string, handler: Handler) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
	const ctx = { sessionManager, model: undefined, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
	let release!: (drafts: SessionBoundaryDraft[]) => void;
	let readyCount = 0;
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: { automaticResetEnabled: () => true, hardReserveDue: () => false, consumeTurnEnd: () => [], clear() {} },
		buildReset: () => new Promise<SessionBoundaryDraft[]>((resolve) => { release = resolve; }),
		onResetReady: () => { readyCount++; },
	});
	const user = (content: string) => handlers.get("message_end")!({ message: { role: "user", content } }, ctx);
	const failed = { ...fakeBoundaryEvent(), outcome: "error", message: { role: "assistant", stopReason: "error", errorMessage: "Prompt too long: context exceeds maximum context length" } };
	const recover = async () => {
		await handlers.get("turn_end")!(failed, ctx);
		return handlers.get("agent_before_settle")!({ ...failed, type: "agent_before_settle" }, ctx);
	};
	await user("starting input");
	const building = recover();
	await Promise.resolve();
	await user("delivered during construction");
	release([]);
	const result = resultEntries([await building]);
	assert.equal(result.continue, true);
	assert.deepEqual(result.entries.map((entry) => entry.type === "custom_message" ? entry.content : null), ["starting input", "delivered during construction"]);
	lifecycle.clear();
	await user("old run");
	const stale = recover();
	await Promise.resolve();
	lifecycle.clear();
	await user("new run");
	release([{ type: "custom_message", customType: BOOT_TYPE, content: "stale", display: false }]);
	assert.equal(await stale, undefined, "clearing the run invalidates construction before it can consume new inputs");
	assert.equal(readyCount, 1);
	const current = recover();
	await Promise.resolve();
	release([]);
	const fresh = resultEntries([await current]);
	assert.deepEqual(fresh.entries.map((entry) => entry.type === "custom_message" ? entry.content : null), ["new run"]);
});

test("abort during reset construction restores handled input at settlement, once", async () => {
	const sessionManager = Manager.inMemory("/private/tmp/notesoup-cancelled-build-test");
	const handlers = new Map<string, Handler>();
	const sent: Array<{ message: { customType: string; content: unknown; display: boolean }; options?: { triggerTurn?: boolean } }> = [];
	const api = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		sendMessage(message: typeof sent[number]["message"], options?: typeof sent[number]["options"]) { sent.push({ message, options }); },
	} as unknown as ExtensionAPI;
	const controller = new AbortController();
	const ctx = { sessionManager, signal: controller.signal, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const lifecycle = registerResetLifecycle(api, {
		isEnabled: () => true,
		budget: { automaticResetEnabled: () => false, hardReserveDue: () => false, consumeTurnEnd: () => [], clear() {} },
		async buildReset() { await gate; return []; },
	});
	const windowId = `pcw:${sessionManager.getSessionId().slice(0, 8)}:root`;
	lifecycle.command(windowId, false);
	const building = handlers.get("agent_before_settle")!({ ...fakeBoundaryEvent(), type: "agent_before_settle" }, ctx);
	assert.deepEqual(await handlers.get("input")!({ source: "rpc", text: "cancelled during construction" }, ctx), { action: "handled" });
	controller.abort();
	release();
	assert.equal(await building, undefined, "aborted construction must not commit a reset");
	await handlers.get("agent_settled")!({}, ctx);
	await handlers.get("agent_settled")!({}, ctx);
	const restored = sent.filter((item) => item.message.customType === CARRIED_INPUT_TYPE);
	assert.deepEqual(restored, [{ message: { type: "custom_message", customType: CARRIED_INPUT_TYPE, content: "cancelled during construction", display: true }, options: { triggerTurn: false } }]);
	// A later command in the same window must not revive the cancelled command's steer.
	lifecycle.command(windowId, false);
	const stale = { role: "custom", ...sent[0]!.message };
	assert.deepEqual(await handlers.get("context_with_system")!({ messages: [stale] }, ctx), { messages: [] });
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
		buildReset: () => { throw new Error("synthetic reset construction failure"); },
	});
	lifecycle.command(`pcw:${sessionManager.getSessionId().slice(0, 8)}:root`, true);
	const incoming: SessionBoundaryDraft = { type: "custom_message", customType: "foreign/boundary", content: "foreign draft", display: false };
	const results = [];
	for (const handler of handlers.get("turn_end") ?? []) results.push(await handler(fakeBoundaryEvent([incoming]), ctx));
	for (const handler of handlers.get("agent_before_settle") ?? []) results.push(await handler(fakeBoundaryEvent([]), ctx));
	const result = resultEntries(results);
	assert.deepEqual(result.entries, [incoming, budgetDraft], "already-built drafts survive reset construction failure");
	assert.equal(result.continue, false, "a failed reset does not request continuation");
	assert.equal(notices.at(-1)?.type, "warning");
	assert.match(notices.at(-1)?.message ?? "", /Brain still full/);
	assert.match(notices.at(-1)?.message ?? "", /synthetic reset construction failure/);
	assert.doesNotMatch(notices.at(-1)?.message ?? "", /prompt not sent/);
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
		async buildReset(_ctx, _isCurrent, _lastWord, firstSeq) {
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

test("reset-control: command policy deduplicates, spans turns, and retains a real tool request", () => {
	const windowId = "pcw:test:window";
	const first = reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false });
	assert.equal(first.effect, "close-out-armed");
	assert.deepEqual(first.state.request, { phase: "pending", windowId, command: { continueAfterReset: false } });
	const duplicate = reduceResetControl(first.state, { type: "command", windowId, continueAfterReset: false });
	assert.equal(duplicate.effect, "already-pending");
	const noteTurn = reduceResetControl(first.state, { type: "turn_end", facts: turnEndFacts() });
	assert.equal(noteTurn.effect, "none");
	assert.deepEqual(controlState(noteTurn).request, first.state.request, "note/tool turns do not consume close-out");
	const tool = reduceResetControl(controlState(noteTurn), { type: "tool_request", windowId });
	assert.equal(tool.effect, "close-out-armed", "the first tool call is recorded without changing settlement policy");
	assert.deepEqual(tool.state.request, { phase: "pending", windowId, command: { continueAfterReset: false }, tool: {} });
	const decision = reduceResetControl(tool.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(decision.effect, "build-boundary", "construction intent has no final state to install");
	const commit = finalizeResetBoundary(boundaryIntent(decision), tool.state.request);
	assert.equal(commit.resumeModel, false, "a manual close-out commits at settlement and stops");
	assert.deepEqual(commit.state, initialResetControl());
});

test("reset-control: command settlement policy preserves a pending tool request", () => {
	const windowId = "pcw:test:window";
	const tool = reduceResetControl(initialResetControl(), { type: "tool_request", windowId });
	const manual = reduceResetControl(tool.state, { type: "command", windowId, continueAfterReset: false });
	assert.equal(manual.effect, "close-out-armed", "the user's stop intent outranks the pending rollover");
	assert.deepEqual(manual.state.request, { phase: "pending", windowId, command: { continueAfterReset: false }, tool: {} });
	assert.equal(reduceResetControl(manual.state, { type: "turn_end", facts: turnEndFacts() }).effect, "none", "the converted request no longer commits at turn end");
	const intent = boundaryIntent(reduceResetControl(manual.state, { type: "before_settle", facts: beforeSettleFacts() }));
	assert.equal(finalizeResetBoundary(intent, manual.state.request).resumeModel, false);
});

test("reset-control: duplicate commands preserve policy and both call orders retain the tool's last word", () => {
	const windowId = "pcw:test:window";
	const command = { type: "command" as const, windowId, continueAfterReset: true };
	const call = { type: "tool_request" as const, windowId, lastWord: "pick up here" };
	const first = reduceResetControl(initialResetControl(), command);
	const duplicate = reduceResetControl(first.state, { ...command, continueAfterReset: false });
	assert.equal(duplicate.effect, "already-pending");
	assert.deepEqual(duplicate.state, first.state);
	const commandThenTool = reduceResetControl(first.state, call);
	const toolThenCommand = reduceResetControl(reduceResetControl(initialResetControl(), call).state, command);
	assert.deepEqual(commandThenTool.state, toolThenCommand.state);
	const repeated = reduceResetControl(commandThenTool.state, { ...call, lastWord: "do not replace" });
	assert.equal(repeated.effect, "already-pending");
	assert.deepEqual(repeated.state, commandThenTool.state);
	assert.equal(reduceResetControl(repeated.state, { type: "turn_end", facts: turnEndFacts() }).effect, "none");
	const intent = boundaryIntent(reduceResetControl(repeated.state, { type: "before_settle", facts: beforeSettleFacts() }));
	assert.equal(intent.tool?.lastWord, "pick up here");
	const commit = finalizeResetBoundary(intent, repeated.state.request);
	assert.equal(commit.resumeModel, true, "explicit continue policy does not require delivery contents");
	assert.deepEqual(commit.inputs, []);
});

test("reset-control: a tool request needs no prior budget warning", () => {
	const windowId = "pcw:test:window";
	const requested = reduceResetControl(initialResetControl(), { type: "tool_request", windowId });
	assert.equal(requested.effect, "close-out-armed");
	assert.deepEqual(requested.state.request, { phase: "pending", windowId, tool: {} });
	const intent = boundaryIntent(reduceResetControl(requested.state, { type: "turn_end", facts: turnEndFacts() }));
	assert.equal(finalizeResetBoundary(intent, requested.state.request).resumeModel, true);
});

test("reset-control: fallback is normal-stop only; hard reserve remains safety", () => {
	const windowId = "pcw:test:window";
	const manual = reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false }).state;
	const intent = boundaryIntent(reduceResetControl(manual, { type: "before_settle", facts: beforeSettleFacts() }));
	const fallback = finalizeResetBoundary(intent, manual.request);
	assert.equal(fallback.resumeModel, false, "manual close-out stops after the reset is committed");
	assert.deepEqual(fallback.state, initialResetControl());

	const automatic = initialResetControl();
	const normalStop = reduceResetControl(automatic, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(normalStop.effect, "none", "ignoring a budget warning and answering normally must not wipe memory");
	assert.deepEqual(controlState(normalStop), initialResetControl());
	const disabledAuto = reduceResetControl(automatic, { type: "before_settle", facts: beforeSettleFacts({ automaticResetEnabled: false }) });
	assert.equal(disabledAuto.effect, "none");
	assert.deepEqual(controlState(disabledAuto), initialResetControl());

	const safety = reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ hardReserveDue: true }) });
	assert.equal(finalizeResetBoundary(boundaryIntent(safety), automatic.request).resumeModel, true);
	for (const outcome of [{ failed: true }, { aborted: true }]) {
		const notNormalStop = reduceResetControl(manual, { type: "before_settle", facts: beforeSettleFacts(outcome) });
		assert.equal(notNormalStop.effect, "none");
		assert.deepEqual(controlState(notNormalStop), initialResetControl());
	}
});

test("reset-control: manual stop survives a hard-reserve reset across windows without a second wipe", () => {
	const windowId = "pcw:test:window";
	const manual = reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false }).state;
	const decision = reduceResetControl(manual, { type: "turn_end", facts: turnEndFacts({ hardReserveDue: true }) });
	assert.equal(decision.effect, "build-boundary", "construction does not install the stop latch");
	const safety = finalizeResetBoundary(boundaryIntent(decision), manual.request);
	assert.equal(safety.resumeModel, false);
	assert.deepEqual(safety.state.request, { phase: "none" });
	assert.deepEqual(safety.state.stopAfterReset, decision);
	const freshWindowId = "pcw:test:fresh";
	assert.equal(reduceResetControl(safety.state, { type: "tool_request", windowId: freshWindowId }).effect, "already-pending");
	assert.equal(reduceResetControl(safety.state, { type: "command", windowId: freshWindowId, continueAfterReset: false }).effect, "already-pending");
	const queued = reduceResetControl(safety.state, { type: "before_settle", facts: beforeSettleFacts({ windowId: freshWindowId, queued: true }) });
	assert.deepEqual(controlState(queued), safety.state);
	const freshTurn = reduceResetControl(controlState(queued), { type: "turn_end", facts: turnEndFacts({ windowId: freshWindowId, hardReserveDue: true }) });
	assert.equal(freshTurn.effect, "none");
	const stop = reduceResetControl(controlState(freshTurn), { type: "before_settle", facts: beforeSettleFacts({ windowId: freshWindowId }) });
	assert.equal(stop.effect, "stop", "the safety boundary already wiped; settlement must only stop");
	assert.deepEqual(controlState(stop), initialResetControl());
	const uncommitted = boundaryIntent(reduceResetControl(safety.state, { type: "before_settle", facts: beforeSettleFacts() }));
	assert.equal(uncommitted.continueAfterReset, false, "same-window retry retains the stop policy");
	const retried = finalizeResetBoundary(uncommitted, safety.state.request);
	assert.equal(retried.resumeModel, false);
	assert.deepEqual(retried.state, initialResetControl(), "settle retry consumes the stop latch");
	const retry = boundaryIntent(reduceResetControl(manual, { type: "before_settle", facts: beforeSettleFacts() }));
	assert.equal(finalizeResetBoundary(retry, manual.request).resumeModel, false, "a failed safety construction leaves the command available for settlement retry");
	assert.deepEqual(controlState(reduceResetControl(safety.state, { type: "before_settle", facts: beforeSettleFacts({ windowId: freshWindowId, aborted: true }) })), initialResetControl());
});

test("reset-control: one safety intent finalizes stop or continuation from live command originals", () => {
	const windowId = "pcw:test:window";
	const pending = reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false }).state;
	const intent = boundaryIntent(reduceResetControl(pending, { type: "turn_end", facts: turnEndFacts({ hardReserveDue: true }) }));
	assert.deepEqual(pending.request, { phase: "pending", windowId, command: { continueAfterReset: false } });
	const stopped = finalizeResetBoundary(intent, pending.request, ["passive run input"]);
	assert.equal(stopped.resumeModel, false);
	assert.deepEqual(stopped.inputs, [], "a command boundary never replays passive run input");
	assert.deepEqual(stopped.state.stopAfterReset, intent);

	const live = reduceResetControl(pending, { type: "input", windowId, input: "late original" }).state;
	const continued = finalizeResetBoundary(intent, live.request, ["passive run input"]);
	assert.equal(continued.resumeModel, true);
	assert.deepEqual(continued.inputs, ["late original"]);
	assert.deepEqual(continued.state, initialResetControl(), "late originals prevent installing the stop latch");
	assert.equal(intent.continueAfterReset, false, "delivery does not rewrite explicit command policy");
	assert.deepEqual(live.request, { phase: "pending", windowId, command: { continueAfterReset: false, inputs: ["late original"] } }, "finalization is pure");
});

test("reset-control: manual overflow keeps stop intent while queued work supersedes the failure", () => {
	const windowId = "pcw:test:window";
	const manual = reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false }).state;
	const overflow = controlState(reduceResetControl(manual, { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true, queued: true, automaticResetEnabled: false }) }));
	assert.deepEqual(overflow.request, manual.request);
	const deferred = controlState(reduceResetControl(overflow, { type: "before_settle", facts: beforeSettleFacts({ failed: true, queued: true, automaticResetEnabled: false }) }));
	assert.deepEqual(deferred, overflow);
	const stopIntent = boundaryIntent(reduceResetControl(overflow, { type: "before_settle", facts: beforeSettleFacts({ failed: true, automaticResetEnabled: false }) }));
	assert.equal(finalizeResetBoundary(stopIntent, overflow.request).resumeModel, false, "manual overflow resets but does not retry the model");
	const success = controlState(reduceResetControl(deferred, { type: "turn_end", facts: turnEndFacts() }));
	assert.deepEqual(success.request, manual.request, "a successful queued turn clears only the overflow, not the manual wipe");
	assert.equal(success.overflow, "idle");
	const successIntent = boundaryIntent(reduceResetControl(success, { type: "before_settle", facts: beforeSettleFacts() }));
	assert.equal(finalizeResetBoundary(successIntent, success.request).resumeModel, false);
	const prompted = reduceResetControl(manual, { type: "input", windowId, input: "answer after reset" }).state;
	const called = reduceResetControl(prompted, { type: "tool_request", windowId, lastWord: "saved" }).state;
	const failed = controlState(reduceResetControl(called, { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true, automaticResetEnabled: false }) }));
	const decision = reduceResetControl(failed, { type: "before_settle", facts: beforeSettleFacts({ failed: true, automaticResetEnabled: false }) });
	assert.equal(failed.overflow, "pending", "construction alone does not spend overflow recovery");
	const retryIntent = boundaryIntent(decision);
	assert.equal(retryIntent.origin, "forced", "an overflowing close-out is forced even after a tool request");
	assert.equal(retryIntent.tool?.lastWord, "saved");
	const retry = finalizeResetBoundary(retryIntent, failed.request, ["passive input is not command-owned"]);
	assert.equal(retry.resumeModel, true, "manual input continues even when automatic reset is disabled");
	assert.deepEqual(retry.inputs, ["answer after reset"]);
	assert.equal(retry.state.overflow, "spent", "manual recovery spends the same bounded attempt");
});

test("reset-control: explicit abort clears a pending request at turn end or settlement", () => {
	const windowId = "pcw:test:window";
	const pending = reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false }).state;
	const aborted = reduceResetControl(pending, { type: "turn_end", facts: turnEndFacts({ aborted: true }) });
	assert.equal(aborted.effect, "none");
	assert.deepEqual(controlState(aborted), initialResetControl());
	assert.deepEqual(controlState(reduceResetControl(pending, { type: "before_settle", facts: beforeSettleFacts({ aborted: true }) })), initialResetControl());
});

test("reset-control: overflow recovery is armed at turn_end and spent exactly once at settle", () => {
	const armed = controlState(reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }));
	assert.deepEqual(armed, { request: { phase: "none" }, overflow: "pending" });

	const intent = boundaryIntent(reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts() }));
	assert.equal(armed.overflow, "pending", "failed construction would leave recovery unspent");
	assert.equal(intent.boundary, "overflow-recovery");
	const recovered = finalizeResetBoundary(intent, armed.request, ["failed run's user input"]);
	assert.equal(recovered.resumeModel, true);
	assert.deepEqual(recovered.inputs, ["failed run's user input"]);
	assert.deepEqual(recovered.state, { request: { phase: "none" }, overflow: "spent" });

	const repeated = reduceResetControl(recovered.state, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(repeated.effect, "none", "a spent recovery is never retried");

	const rearmed = controlState(reduceResetControl(recovered.state, { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }));
	assert.deepEqual(rearmed, { request: { phase: "none" }, overflow: "pending-spent" });
	const bounded = reduceResetControl(rearmed, { type: "before_settle", facts: beforeSettleFacts() });
	assert.equal(bounded.effect, "none", "a second failure chain stays bounded to the spent attempt");
	assert.deepEqual(controlState(bounded), { request: { phase: "none" }, overflow: "spent" });
});

test("reset-control: a queued turn defers recovery and its success supersedes the failure", () => {
	const armed = controlState(reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }));
	const deferred = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ queued: true }) });
	assert.equal(deferred.effect, "none");
	assert.deepEqual(controlState(deferred), armed, "a queued message leaves the overflow chain armed");

	const success = reduceResetControl(armed, { type: "turn_end", facts: turnEndFacts() });
	assert.deepEqual(controlState(success), initialResetControl(), "a successful queued turn clears the stale failure");
});

test("reset-control: disabled mode and explicit aborts disarm overflow without a recovery", () => {
	const armed = controlState(reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }));

	const disabled = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ enabled: false }) });
	assert.equal(disabled.effect, "none");
	assert.deepEqual(controlState(disabled), { request: { phase: "none" }, overflow: "idle" });

	const automaticOff = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ automaticResetEnabled: false }) });
	assert.equal(automaticOff.effect, "none");
	assert.deepEqual(controlState(automaticOff), { request: { phase: "none" }, overflow: "idle" });

	const aborted = reduceResetControl(armed, { type: "before_settle", facts: beforeSettleFacts({ aborted: true }) });
	assert.equal(aborted.effect, "none");
	assert.deepEqual(controlState(aborted), { request: { phase: "none" }, overflow: "idle" });
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
	const pendingOverflow = controlState(reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }));
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
		buildReset: (ctx, isCurrent, lastWord, firstSeq, origin) => buildResetDrafts(ctx, undefined, isCurrent, lastWord, firstSeq, origin),
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
	assert.equal(refused.isError, true, "an oversized note fails the tool call so the host flags it");
	assert.match(JSON.stringify(refused), /error/, "an oversized note is refused, not truncated");
	assert.match(JSON.stringify(refused), new RegExp(`${MAX_LAST_WORD_CHARS + 1} characters`), "the refusal names the actual size and the limit");
	const refusedAstral = await over.callTool("empty_brain", { last_word: "\u{1F41F}".repeat(MAX_LAST_WORD_CHARS + 1) });
	assert.match(JSON.stringify(refusedAstral), new RegExp(`${MAX_LAST_WORD_CHARS + 1} characters`), "the guard counts code points, not UTF-16 units");
	const untouched = resultEntries(await over.emit("turn_end", fakeBoundaryEvent()));
	assert.equal(untouched.entries.filter((entry) => entry.type === "custom_message" && entry.customType === RESET_LAST_WORD_TYPE).length, 0, "a refused call requests no reset");
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "before reset" }], timestamp: Date.now() });
	await h.callTool("empty_brain", { last_word: "   " });
	const boundary = resultEntries(await h.emit("turn_end", fakeBoundaryEvent()));
	assert.equal(boundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === RESET_LAST_WORD_TYPE).length, 0, "a blank last word persists no entry");
});

test("empty_brain's schema admits whitespace-wrapped notes and leaves length to the handler", async () => {
	const parameters = harness().toolParameters("empty_brain");
	const padded = " ".repeat(300) + "x";
	assert.equal(Check(parameters, { last_word: padded }), true, "300 spaces plus x is admitted by the schema");
	assert.equal(Check(parameters, { last_word: "x".repeat(MAX_LAST_WORD_CHARS + 1) }), true, "the schema does not pre-empt the handler's code-point limit");
	assert.equal(Check(parameters, { last_word: 42 }), false, "a genuine type violation is still refused by the schema");
	const h = harness();
	h.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "before reset" }], timestamp: Date.now() });
	await h.callTool("empty_brain", { last_word: padded });
	const boundary = resultEntries(await h.emit("turn_end", fakeBoundaryEvent()));
	const lastWords = boundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === RESET_LAST_WORD_TYPE);
	assert.deepEqual(lastWords[0], { type: "custom_message", customType: RESET_LAST_WORD_TYPE, content: `${LAST_WORD_PREFIX}x`, display: true }, "the handler records the trimmed note");
});

test("reset-control: a tool request carries its last word to the turn-end commit", () => {
	const windowId = "pcw:test:window";
	const armed = reduceResetControl(initialResetControl(), { type: "tool_request", windowId, lastWord: "the shoes were loyal" });
	assert.equal(armed.effect, "close-out-armed");
	assert.deepEqual(armed.state.request, { phase: "pending", windowId, tool: { lastWord: "the shoes were loyal" } });
	const intent = boundaryIntent(reduceResetControl(armed.state, { type: "turn_end", facts: turnEndFacts() }));
	assert.equal(intent.tool?.lastWord, "the shoes were loyal");
	assert.equal(finalizeResetBoundary(intent, armed.state.request).resumeModel, true);
});

test("reset-control: a call and a command keep their facts in either order", () => {
	const windowId = "pcw:test:window";
	// The call first, then the command: the conversion must not erase the call it outranks.
	const toolFirst = reduceResetControl(initialResetControl(), { type: "tool_request", windowId, lastWord: "the shoes were loyal" });
	const converted = reduceResetControl(toolFirst.state, { type: "command", windowId, continueAfterReset: false });
	assert.equal(converted.effect, "close-out-armed");
	assert.deepEqual(converted.state.request, { phase: "pending", windowId, command: { continueAfterReset: false }, tool: { lastWord: "the shoes were loyal" } });
	const stop = boundaryIntent(reduceResetControl(converted.state, { type: "before_settle", facts: beforeSettleFacts() }));
	assert.equal(finalizeResetBoundary(stop, converted.state.request).resumeModel, false);
	assert.equal(stop.origin, "normal", "a command arriving after a model wipe does not rewrite it as forced");
	assert.equal(stop.tool?.lastWord, "the shoes were loyal", "the call's parting line survives the conversion");

	// The command first, then the call: the acknowledgement records the call and keeps stopping.
	const commandFirst = reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false });
	const acknowledged = reduceResetControl(commandFirst.state, { type: "tool_request", windowId, lastWord: "tell them I was funny" });
	assert.equal(acknowledged.effect, "close-out-armed");
	assert.deepEqual(acknowledged.state.request, { phase: "pending", windowId, command: { continueAfterReset: false }, tool: { lastWord: "tell them I was funny" } });
	const settled = boundaryIntent(reduceResetControl(acknowledged.state, { type: "before_settle", facts: beforeSettleFacts() }));
	assert.equal(finalizeResetBoundary(settled, acknowledged.state.request).resumeModel, false);
	assert.equal(settled.origin, "normal", "the command-first order records the same origin");
	assert.equal(settled.tool?.lastWord, "tell them I was funny");
});

test("reset-control: the origin is the empty_brain call, independent of command policy", () => {
	const windowId = "pcw:test:window";
	const tool = reduceResetControl(initialResetControl(), { type: "tool_request", windowId });
	assert.equal(boundaryIntent(reduceResetControl(tool.state, { type: "turn_end", facts: turnEndFacts() })).origin, "normal", "the model's own call is a normal reset");


	const manual = reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false }).state;
	assert.equal(boundaryIntent(reduceResetControl(manual, { type: "before_settle", facts: beforeSettleFacts() })).origin, "forced", "a command close-out with no call is a system reset");
	const acknowledged = reduceResetControl(manual, { type: "tool_request", windowId }).state;
	assert.equal(boundaryIntent(reduceResetControl(acknowledged, { type: "before_settle", facts: beforeSettleFacts() })).origin, "normal", "a manual close-out the model actually wipes is normal but still stops");

	assert.equal(boundaryIntent(reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ hardReserveDue: true }) })).origin, "forced", "the hard cutoff happens without a call");
	const intent = boundaryIntent(reduceResetControl(acknowledged, { type: "turn_end", facts: turnEndFacts({ hardReserveDue: true }) }));
	assert.equal(intent.origin, "normal", "an acknowledged call survives the hard cutoff it was armed against");
	const safety = finalizeResetBoundary(intent, acknowledged.request);
	assert.deepEqual(safety.state.stopAfterReset?.tool, {}, "the recorded call survives into the run-scoped stop latch");
	assert.equal(boundaryIntent(reduceResetControl(safety.state, { type: "before_settle", facts: beforeSettleFacts() })).origin, "normal", "a retried safety construction keeps the recorded origin");

	const overflow = controlState(reduceResetControl(initialResetControl(), { type: "turn_end", facts: turnEndFacts({ overflow: true, failed: true }) }));
	assert.equal(boundaryIntent(reduceResetControl(overflow, { type: "before_settle", facts: beforeSettleFacts() })).origin, "forced", "overflow recovery has no call behind it");
});

test("a committed reset records its origin and draws that pool exactly once", async () => {
	const random = Math.random;
	Math.random = () => 0;
	try {
		const asked = harness();
		await asked.callTool("empty_brain");
		const askedBoundary = resultEntries(await asked.emit("turn_end", fakeBoundaryEvent()));
		const askedMarker = askedBoundary.entries.find((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
		assert.ok(askedMarker?.type === "custom");
		assert.deepEqual(Object.keys(askedMarker.data as object), ["windowId", "origin"]);
		assert.equal((askedMarker.data as { origin?: string }).origin, "normal");
		const askedLine = askedBoundary.entries.find((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE);
		assert.ok(askedLine?.type === "custom_message");
		assert.equal(askedLine.content, NORMAL_CONTINUATIONS[0]);

		const commanded = harness();
		await commanded.runCommand("empty");
		const commandedBoundary = resultEntries(await commanded.emit("agent_before_settle", {
			type: "agent_before_settle",
			entries: [],
			outcome: "completed",
			context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
		}));
		const commandedMarker = commandedBoundary.entries.find((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
		assert.ok(commandedMarker?.type === "custom");
		assert.equal((commandedMarker.data as { origin?: string }).origin, "forced", "the human's command is a system reset, not a model call");
		const commandedLine = commandedBoundary.entries.find((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE);
		assert.ok(commandedLine?.type === "custom_message");
		assert.equal(commandedLine.content, FORCED_CONTINUATIONS[0]);
	} finally {
		Math.random = random;
	}
});

test("reset-control: a command retains tool calls with or without a last word and still stops at settlement", () => {
	const windowId = "pcw:test:window";
	const manual = reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false });
	const ack = reduceResetControl(manual.state, { type: "tool_request", windowId, lastWord: "tell them I was funny" });
	assert.equal(ack.effect, "close-out-armed", "the tool request is recorded independently of command policy");
	assert.deepEqual(ack.state.request, { phase: "pending", windowId, command: { continueAfterReset: false }, tool: { lastWord: "tell them I was funny" } });
	const silentAck = reduceResetControl(reduceResetControl(initialResetControl(), { type: "command", windowId, continueAfterReset: false }).state, { type: "tool_request", windowId });
	assert.deepEqual(silentAck.state.request, { phase: "pending", windowId, command: { continueAfterReset: false }, tool: {} }, "a call with no last word is still a real tool request");
	const intent = boundaryIntent(reduceResetControl(ack.state, { type: "before_settle", facts: beforeSettleFacts() }));
	assert.equal(finalizeResetBoundary(intent, ack.state.request).resumeModel, false);
	assert.equal(intent.tool?.lastWord, "tell them I was funny");
});
