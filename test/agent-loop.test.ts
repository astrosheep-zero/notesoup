import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentContext } from "@earendil-works/pi-agent-core";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import notesoup, { createNotesoup } from "../src/pi/extension.js";
import { BOOT_TYPE, CONTINUATION_TYPE, GUIDANCE_TYPE, MANUAL_WIPE_TYPE, RESET_MARKER_TYPE, WARNING_TYPE } from "../src/pi/entries.js";
import { CONTEXT_WINDOW_OPEN_TAG } from "../src/boot/text.js";
import { CONTINUATION, WARNING_CONTENT, WARNING_PROMPT } from "../src/pi/reset/text.js";
import { GUIDANCE_OPEN_TAG } from "../src/budget/text.js";

type StreamScript = (request: number, context: AgentContext) => AssistantMessage | Promise<AssistantMessage>;
type Hook = (pi: ExtensionAPI, getSession: () => AgentSession, requests: AgentContext[]) => void;

type Fixture = {
	dir: string;
	notesRoot: string;
	sessionManager: SessionManager;
	session: AgentSession;
	model: Awaited<ReturnType<ModelRuntime["getModels"]>>[number];
	requests: AgentContext[];
	streamContexts: AgentContext[];
	streamSignals: boolean[];
	events: Array<{ type: string; [key: string]: unknown }>;
	notices: string[];
	budgetNotices: () => number;
	close: () => void;
};

async function openFixture(options: {
	compactionEnabled?: boolean;
	keepRecentTokens?: number;
	contextWindow?: number;
	notesRootFile?: boolean;
	systemPrompt?: string;
	tools?: string[];
	codemode?: boolean;
	cwd?: string;
	agentDir?: string;
	notesRoot?: string;
	writeSettings?: boolean;
	defaultCompactionEnabled?: boolean;
	defaultReserveTokens?: number;
	projectSettings?: Record<string, unknown>;
	settingsManager?: SettingsManager | ((model: Fixture["model"]) => SettingsManager);
	manageEnvironment?: boolean;
	projectTrusted?: boolean;
	sessionDir?: string;
	sessionManager?: SessionManager;
	seed?: (sessionManager: SessionManager) => void;
	script: StreamScript;
	hook?: Hook;
}): Promise<Fixture> {
	const dir = options.cwd ?? mkdtempSync(join(tmpdir(), "notesoup-agent-loop-"));
	const ownsDir = options.cwd === undefined;
	const notesRoot = options.notesRoot ?? mkdtempSync(join(tmpdir(), "notesoup-agent-loop-notes-"));
	const ownsNotesRoot = options.notesRoot === undefined;
	const agentDir = options.agentDir ?? dir;
	const managesEnvironment = options.manageEnvironment ?? true;
	const previousDir = managesEnvironment ? process.env.PI_CODING_AGENT_DIR : undefined;
	const previousNotesRoot = managesEnvironment ? process.env.PI_NOTES_HOME : undefined;
	if (managesEnvironment) {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_NOTES_HOME = notesRoot;
	}
	if (options.notesRootFile) {
		rmSync(notesRoot, { recursive: true, force: true });
		writeFileSync(notesRoot, "blocked notes root");
	}
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(dir, "models"),
		refreshOnCreate: false,
	});
	await runtime.setRuntimeApiKey("openai", "scripted-test-key");
	const base = runtime.getModels("openai")[0];
	assert.ok(base, "the installed SDK exposes a scripted model");
	const model = { ...base, contextWindow: options.contextWindow ?? 100_000, maxTokens: 4096 };
	runtime.stream = (() => { throw new Error("unexpected native model request"); }) as typeof runtime.stream;
	runtime.complete = (() => { throw new Error("unexpected native model request"); }) as typeof runtime.complete;
	runtime.streamSimple = (() => { throw new Error("unexpected native model request"); }) as typeof runtime.streamSimple;
	runtime.completeSimple = (() => { throw new Error("unexpected native model request"); }) as typeof runtime.completeSimple;
	if (options.writeSettings !== false) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		compaction: {
			enabled: options.defaultCompactionEnabled ?? options.compactionEnabled ?? true,
			reserveTokens: options.defaultReserveTokens ?? 32_768,
			keepRecentTokens: options.keepRecentTokens ?? 200,
		},
		retry: { enabled: false },
	}));
	if (options.projectSettings !== undefined) {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify(options.projectSettings));
	}
	const settingsManager = typeof options.settingsManager === "function"
		? options.settingsManager(model)
		: options.settingsManager ?? SettingsManager.create(dir, agentDir, { projectTrusted: options.projectTrusted ?? true });
	const requests: AgentContext[] = [];
	const streamContexts: AgentContext[] = [];
	const streamSignals: boolean[] = [];
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const notices: string[] = [];
	let budgetNotices = 0;
	let session!: AgentSession;
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		systemPromptOverride: () => options.systemPrompt ?? "Use the tools as requested.",
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		extensionFactories: [...(options.codemode ? [createCodemodeExtension({ models: false })] : []), options.settingsManager ? createNotesoup({ settingsManager }) : notesoup, (pi) => {
		options.hook?.(pi, () => session, requests);
	}],
	});
	await loader.reload();
	const sessionManager = options.sessionManager ?? (options.sessionDir ? SessionManager.create(dir, options.sessionDir) : SessionManager.inMemory(dir));
	options.seed?.(sessionManager);
	const created = await createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime: runtime,
		model,
		settingsManager,
		sessionManager,
		resourceLoader: loader,
		tools: options.tools ?? ["clear_memory", "notes_write", "get_context_remaining"],
	});
	session = created.session;
	session.subscribe((event) => events.push(event as unknown as { type: string; [key: string]: unknown }));
	session.agent.streamFunction = async (_model, context, streamOptions) => {
		const aborted = streamOptions?.signal?.aborted === true;
		streamContexts.push(context);
		streamSignals.push(aborted);
		if (aborted) {
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [],
				stopReason: "aborted",
				errorMessage: "scripted request aborted",
				timestamp: Date.now(),
				usage: usage(0, 0),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "error", reason: "aborted", error: message });
			stream.end();
			return stream;
		}
		requests.push(context);
		const request = requests.length;
		const message = await options.script(request, context);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: (message.stopReason === "error" || message.stopReason === "aborted" ? "stop" : message.stopReason) as "stop" | "toolUse" | "length" | "deferred", message });
		stream.end();
		return stream;
	};
	await session.bindExtensions({
		uiContext: {
			notify(message: string, type?: "info" | "warning" | "error") {
				if (message.startsWith("notesoup: memory cleared · ")) {
					const windowId = message.split(" · ")[1];
					assert.ok(sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE && (entry.data as { windowId?: string })?.windowId === windowId), "notification follows the reset marker commit");
					assert.ok(sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && (entry.details as { windowId?: string })?.windowId === windowId), "notification follows the reset boot commit");
				}
				if (type === "warning" && /^notesoup: context (?:almost full|running low)/.test(message)) budgetNotices++;
				notices.push(message);
			},
		} as ExtensionUIContext,
	});
	return {
		dir,
		notesRoot,
		sessionManager,
		session,
		model,
		requests,
		streamContexts,
		streamSignals,
		events,
		notices,
		budgetNotices: () => budgetNotices,
		close: () => {
			session.dispose();
			if (managesEnvironment) {
				if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousDir;
				if (previousNotesRoot === undefined) delete process.env.PI_NOTES_HOME;
				else process.env.PI_NOTES_HOME = previousNotesRoot;
			}
			if (ownsDir) rmSync(dir, { recursive: true, force: true });
			if (ownsNotesRoot) rmSync(notesRoot, { recursive: true, force: true });
		},
	};
}

function usage(input: number, output = 1) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(fixture: Fixture, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: fixture.model.api,
		provider: fixture.model.provider,
		model: fixture.model.id,
		content,
		stopReason,
		timestamp: Date.now(),
		usage: usage(100),
		...extra,
	};
}

function text(message: AgentContext | undefined): string {
	return JSON.stringify(message?.messages ?? []);
}

function resetMarkers(fixture: Fixture) {
	return fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
}

function contextRemainingResults(fixture: Fixture): Array<number | null> {
	const results: Array<number | null> = [];
	for (const entry of fixture.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "get_context_remaining") continue;
		const content = (entry.message.content as Array<{ type?: string; text?: string }>).find((part) => part.type === "text")?.text;
		if (content === undefined) continue;
		const value = JSON.parse(content) as { remaining_tokens?: unknown };
		if (typeof value.remaining_tokens === "number" || value.remaining_tokens === null) results.push(value.remaining_tokens);
	}
	return results;
}

function assertFreshRequest(fixture: Fixture, requestIndex: number, oldSentinel: string): void {
	const body = text(fixture.requests[requestIndex]);
	assert.equal(body.includes(oldSentinel), false, "the new provider request excludes the old window transcript");
	assert.ok(body.includes(CONTEXT_WINDOW_OPEN_TAG), "the new provider request includes the fresh context-window boot");
	assert.equal(body.split(CONTINUATION).length - 1, 1, "the fresh window carries exactly one reset message");
}

test("real Pi codemode receives typed notes/history outcomes, including expected errors", { timeout: 20000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		codemode: true,
		compactionEnabled: false,
		tools: ["codemode", "notes_write", "notes_read", "notes_list", "history_list", "history_read"],
		script: (request) => {
			if (request === 1) return assistant(fixture, [{ type: "toolCall", id: "structured-smoke", name: "codemode", arguments: { code: `
const written = await tools.notes_write({ address: "smoke.md", content: "A😀界Z" });
const listed = await tools.notes_list({});
const read = await tools.notes_read({ address: "smoke.md", offset_chars: 1, max_chars: 2 });
const refused = await tools.notes_read({ address: "missing.md" });
if ("error" in written || "error" in listed || "error" in read || !("error" in refused)) throw new Error("wrong outcome");
if (read.text !== "😀界" || read.next_offset_chars !== 3) throw new Error("wrong window");
if (refused.code !== "not_found") throw new Error("missing typed refusal");
text({ marker: "TYPED_SMOKE", files: listed.files.map(f => f.address), body: read.text, error: refused.code });
` } }], "toolUse");
			if (request === 2) return assistant(fixture, [{ type: "toolCall", id: "structured-history-smoke", name: "codemode", arguments: { code: `
const page = await tools.history_list({ roles: ["tool"] });
if ("error" in page) throw new Error("history list failed");
const parent = page.items.find(item => item.tool === "codemode");
if (!parent) throw new Error("missing codemode parent");
const read = await tools.history_read({ seq: parent.seq });
if ("error" in read || read.tool !== "codemode") throw new Error("missing typed tool summary");
const calls = read.nested_calls;
if (!calls || !read.text.includes("notes_read [error]")) throw new Error("missing nested refusal evidence");
text({ marker: "HISTORY_SMOKE", calls: calls.call_count, complete: calls.complete });
` } }], "toolUse");
			return assistant(fixture, [{ type: "text", text: "structured smoke complete" }]);
		},
	});
	try {
		await fixture.session.prompt("Exercise the structured tools through real codemode.");
		const results = fixture.sessionManager.getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		assert.equal(results.length, 2, "nested calls are not separate transcript events");
		assert.ok(results.every(result => !result.isError), JSON.stringify(results));
		const output = results.map(result => result.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
		assert.match(output, /TYPED_SMOKE/);
		assert.match(output, /HISTORY_SMOKE/);
		assert.equal(results[0]!.nestedCalls?.calls.length, 4);
		assert.equal(results[0]!.nestedCalls?.complete, true);
	} finally {
		fixture.close();
	}
});

test("real AgentSession: aborted early guidance retries silently with automatic reset disabled", async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		script: (request) => assistant(fixture, [{ type: "text", text: `response ${request}` }], request === 2 ? "aborted" : "stop", { usage: usage(50_000) }),
	});
	try {
		const guidance = () => fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE);
		const notices = () => fixture.budgetNotices();
		await fixture.session.prompt("Establish usage below the reminder line.");
		await fixture.session.waitForIdle();
		assert.equal(guidance().length, 0);
		await fixture.session.prompt("Abort this low-budget request.");
		await fixture.session.waitForIdle();
		assert.equal(guidance().length, 0, "an aborted turn does not commit early guidance");
		assert.equal(notices(), 0, "early guidance never notifies");
		await fixture.session.prompt("Retry successfully.");
		await fixture.session.waitForIdle();
		assert.equal(guidance().length, 1, "the successful retry commits the model guidance");
		assert.equal(notices(), 0, "committed early guidance stays UI-silent");
		await fixture.session.prompt("Continue in the same window.");
		await fixture.session.waitForIdle();
		assert.equal(guidance().length, 1);
		assert.equal(notices(), 0, "later turns cannot toast the early reminder");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: an aborted final warning stays silent until a successful retry commits it", async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: true,
		script: (request, context) => {
			if (request === 1) return assistant(fixture, [{ type: "toolCall", id: "abort-budget-probe-1", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(50_000) });
			if (request === 2) return assistant(fixture, [{ type: "toolCall", id: "abort-budget-probe-2", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(60_000) });
			assert.ok(text(context).includes(WARNING_PROMPT), "the final warning reaches the model on both attempts");
			return assistant(fixture, [{ type: "text", text: `response ${request}` }], request === 3 ? "aborted" : "stop", { usage: usage(60_000) });
		},
	});
	try {
		const warnings = () => fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === WARNING_TYPE);
		const notices = () => fixture.budgetNotices();
		await fixture.session.prompt("Establish usage and reach the final runway.");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 3, "budget probes reach one final-warning attempt");
		assert.equal(warnings().length, 0, "the aborted attempt leaves no durable warning");
		assert.equal(notices(), 0, "an uncommitted warning never notifies");
		await fixture.session.prompt("Retry successfully.");
		await fixture.session.waitForIdle();
		assert.equal(warnings().length, 1, "the successful retry commits one hidden warning");
		assert.equal(resetMarkers(fixture).length, 0, "committing the warning does not authorize a reset at normal stop");
		assert.equal(fixture.requests.length, 4, "the retry settles without a fresh-window continuation");
		assert.equal(notices(), 1, "the committed warning notifies once");
		assert.equal(fixture.notices.some((notice) => notice.includes("Context running low")), false, "early guidance remains UI-silent");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: final warning survives its reset boundary and notifies once", { timeout: 20000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: true,
		script: (request, context) => {
			if (request === 1) return assistant(fixture, [{ type: "toolCall", id: "final-budget-probe-1", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(50_000) });
			if (request === 2) return assistant(fixture, [{ type: "toolCall", id: "final-budget-probe-2", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(60_000) });
			if (request === 3) {
				assert.ok(text(context).includes(WARNING_PROMPT), "the final warning reaches the model");
				return assistant(fixture, [{ type: "toolCall", id: "final-budget-wipe", name: "clear_memory", arguments: {} }], "toolUse", { usage: usage(60_000) });
			}
			return assistant(fixture, [{ type: "text", text: "fresh window ready" }]);
		},
	});
	try {
		assert.equal(fixture.notices.length, 0, "boot is silent");
		await fixture.session.prompt("FINAL_WARNING_RESET_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 4, "two budget probes, close-out tool, and fresh-window request run");
		assertFreshRequest(fixture, 3, "FINAL_WARNING_RESET_SENTINEL");
		assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === WARNING_TYPE).length, 1);
		assert.equal(resetMarkers(fixture).length, 1, "the reset commits in the same boundary as the final warning");
		assert.equal(fixture.budgetNotices(), 1, "the old-window committed warning reaches the UI after reset");
		assert.equal(fixture.notices.filter((notice) => notice.startsWith("notesoup: memory cleared · ")).length, 1, "reset notification remains intact");
		assert.equal(fixture.notices.some((notice) => notice.includes("Context running low")), false, "early guidance stays silent");
		await fixture.session.prompt("Continue after reset.");
		await fixture.session.waitForIdle();
		assert.equal(fixture.budgetNotices(), 1, "later turns cannot repeat the consumed final warning");
		assert.equal(fixture.notices.filter((notice) => notice.startsWith("notesoup: memory cleared · ")).length, 1, "the prior reset notification is also deduplicated");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: explicit tiny-session wipe ignores keepRecentTokens and preserves raw history", async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		keepRecentTokens: 1_000_000,
		script: (request, context) => request === 1
			? assistant(fixture, [{ type: "toolCall", id: "wipe-1", name: "clear_memory", arguments: {} }], "toolUse")
			: assistant(fixture, [{ type: "text", text: "resumed in a new window" }]),
	});
	try {
		assert.equal(fixture.requests.length, 0, "startup boot does not trigger a model request");
		assert.equal(fixture.notices.length, 0, "startup boot is silent");
		await fixture.session.prompt("OLD_CONTEXT_SENTINEL: retain this only in durable history.");
		await fixture.session.waitForIdle();
		assert.equal(fixture.notices.filter((message) => message.includes("memory cleared")).length, 1, "the reset notifies once");
		assert.equal(fixture.requests.length, 2, "the tool starts exactly one continuation");
		assert.ok(text(fixture.requests[0]).includes("OLD_CONTEXT_SENTINEL"));
		assertFreshRequest(fixture, 1, "OLD_CONTEXT_SENTINEL");
		assert.equal(resetMarkers(fixture).length, 1, "explicit wipe does not depend on Pi's compaction keep window");
		const marker = resetMarkers(fixture)[0]!;
		assert.equal(marker.type, "custom");
		assert.deepEqual(Object.keys(marker.data as object), ["windowId"]);
		const windowId = (marker.data as { windowId: string }).windowId;
		const boot = fixture.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId);
		assert.ok(boot && boot.type === "custom_message", "the reset boot is persisted after the marker");
		assert.equal((boot.details as { windowId: string }).windowId, windowId);
		const checkpoint = fixture.sessionManager.getBranch().find((entry) => entry.type === "compaction");
		assert.ok(checkpoint && checkpoint.type === "compaction", "explicit wipe commits a native checkpoint without a summary model call");
		assert.equal(checkpoint.summary, "");
		assert.equal(checkpoint.firstKeptEntryId, checkpoint.id, "the checkpoint retains none of the preceding context");
		assert.ok(JSON.stringify(fixture.sessionManager.getBranch()).includes("OLD_CONTEXT_SENTINEL"), "raw history remains readable");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: manual command spans its tool batch and stops at settlement", { timeout: 20000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		script: (request, context) => {
			if (request === 1) return assistant(fixture, [{ type: "text", text: "before manual reset" }]);
			if (request === 2) {
				assert.ok(text(context).includes(WARNING_PROMPT), "idle /clear-memory sends the shared checkpoint prompt");
				return assistant(fixture, [{ type: "toolCall", id: "manual-note", name: "notes_write", arguments: { address: "manual-a.md", content: "MANUAL_NOTE_ALPHA" } }], "toolUse");
			}
			assert.equal(request, 3, "the close-out turn finishes in the old window");
			assert.ok(text(context).includes("MANUAL_CLOSEOUT_OLD_SENTINEL"), "no reset commits before settlement");
			return assistant(fixture, [{ type: "text", text: "close-out complete" }]);
		},
	});
	try {
		await fixture.session.prompt("MANUAL_CLOSEOUT_OLD_SENTINEL");
		await fixture.session.waitForIdle();
		await fixture.session.prompt("/clear-memory");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 3, "the run stops at settlement instead of continuing in the fresh window");
		assert.equal(resetMarkers(fixture).length, 1);
		const branch = fixture.sessionManager.getBranch();
		const warningIndex = branch.findIndex((entry) => entry.type === "custom_message" && entry.customType === MANUAL_WIPE_TYPE);
		const checkpointIndex = branch.findIndex((entry) => entry.type === "compaction");
		const markerIndex = branch.findIndex((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
		assert.ok(warningIndex >= 0 && warningIndex < checkpointIndex, "the idle warning is durable before the checkpoint");
		const warning = branch[warningIndex];
		assert.ok(warning?.type === "custom_message");
		assert.equal(warning.content, WARNING_CONTENT);
		assert.equal(branch[markerIndex - 1]?.id, branch[checkpointIndex]?.id);
		assert.ok(branch.slice(0, checkpointIndex).some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes_write"), "note write finishes before the checkpoint");
		const marker = resetMarkers(fixture)[0]!;
		assert.equal(marker.type, "custom");
		const windowId = (marker.data as { windowId: string }).windowId;
		const boot = branch.find((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && (entry.details as { windowId?: string } | undefined)?.windowId === windowId);
		assert.ok(boot && boot.type === "custom_message");
		assert.ok(typeof boot.content === "string" && boot.content.includes("manual-a.md"), "fresh boot indexes the completed note");
		assert.equal(boot.display, false);
		assert.equal(JSON.stringify(fixture.sessionManager.buildSessionProjection().messages).includes("MANUAL_CLOSEOUT_OLD_SENTINEL"), false);
		assert.ok(JSON.stringify(branch).includes("MANUAL_CLOSEOUT_OLD_SENTINEL"), "raw history remains intact");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: clear commands append a prompt after continuation and resume once", { timeout: 25000 }, async () => {
	for (const mode of ["clear-memory", "cm", "hard-reserve", "overflow"] as const) {
		let fixture!: Fixture;
		const prompt = 'AFTER_CLEAR_PROMPT /cm "literal text"';
		fixture = await openFixture({
			compactionEnabled: mode === "hard-reserve",
			script: (request, context) => {
				if (request === 1) return assistant(fixture, [{ type: "text", text: "initial work" }]);
				if (request === 2) {
					assert.equal(text(context).includes(prompt), false, "the old window never sees the trailing prompt");
					if (mode === "overflow") return assistant(fixture, [], "error", { errorMessage: "Prompt too long: context exceeds maximum context length" });
					return mode === "hard-reserve"
						? assistant(fixture, [{ type: "toolCall", id: "prompt-note", name: "notes_write", arguments: { address: "prompt-note.md", content: "saved" } }], "toolUse", { usage: usage(80_000) })
						: assistant(fixture, [{ type: "text", text: "notes complete" }]);
				}
				assert.equal(request, 3, "exactly one fresh-window request");
				assert.equal(text(context).includes("PROMPT_RESET_OLD_SENTINEL"), false);
				assert.equal(text(context).split(prompt).length - 1, 1);
				assert.ok(text(context).indexOf(CONTINUATION) < text(context).indexOf(prompt), "wake-up prose precedes the appended prompt");
				return assistant(fixture, [{ type: "text", text: "prompt handled" }]);
			},
		});
		try {
			await fixture.session.prompt("PROMPT_RESET_OLD_SENTINEL");
			await fixture.session.prompt(`/${mode === "clear-memory" ? "clear-memory" : "cm"}   ${prompt}  `);
			await fixture.session.waitForIdle();
			assert.equal(fixture.requests.length, 3);
			assert.equal(resetMarkers(fixture).length, 1);
			const branch = fixture.sessionManager.getBranch();
			const continuationIndex = branch.findIndex((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE);
			const appended = branch[continuationIndex + 1];
			assert.ok(appended?.type === "custom_message");
			assert.equal(appended.customType, "notesoup/reset-prompt");
			assert.equal(appended.content, prompt);
			assert.equal(appended.display, true);
			assert.ok(fixture.notices.some((notice) => notice.includes("memory cleared")));
		} finally {
			fixture.close();
		}
	}
});

test("real AgentSession: whitespace-only /cm clears and stops", { timeout: 20000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		script: (request) => {
			assert.equal(request, 1, "bare alias never starts a fresh-window request");
			return assistant(fixture, [{ type: "text", text: "notes complete" }]);
		},
	});
	try {
		await fixture.session.prompt("/cm   ");
		await fixture.session.waitForIdle();
		assert.equal(resetMarkers(fixture).length, 1);
		assert.equal(fixture.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "notesoup/reset-prompt"), false);
	} finally { fixture.close(); }
});

test("real AgentSession: streaming clear prompt keeps the first request", { timeout: 20000 }, async () => {
	let fixture!: Fixture;
	let started!: () => void;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	fixture = await openFixture({
		compactionEnabled: false,
		script: async (request, context) => {
			if (request === 1) { started(); await gate; }
			if (request <= 2) assert.equal(text(context).includes("FIRST_RESET_PROMPT"), false);
			if (request === 3) {
				assert.ok(text(context).includes("FIRST_RESET_PROMPT"));
				assert.equal(text(context).includes("IGNORED_RESET_PROMPT"), false);
			}
			assert.ok(request <= 3);
			return assistant(fixture, [{ type: "text", text: "done" }]);
		},
	});
	try {
		const running = fixture.session.prompt("streaming old work");
		await ready;
		await fixture.session.prompt("/cm FIRST_RESET_PROMPT", { streamingBehavior: "steer" });
		await fixture.session.prompt("/clear-memory IGNORED_RESET_PROMPT", { streamingBehavior: "steer" });
		release();
		await running;
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 3);
		assert.equal(resetMarkers(fixture).length, 1);
		assert.ok(fixture.notices.some((notice) => notice.includes("already pending")));
	} finally { release(); fixture.close(); }
});

test("real AgentSession: manual hard-reserve reset stops clean and mixed-tool turns without fresh provider work", { timeout: 20000 }, async () => {
	for (const mixed of [false, true]) {
		let fixture!: Fixture;
		let newUserAllowed = false;
		fixture = await openFixture({
			script: (request) => {
				if (newUserAllowed) return assistant(fixture, [{ type: "text", text: "new user turn handled" }]);
				if (request === 1) return assistant(fixture, [{ type: "text", text: "before wipe" }]);
				assert.equal(request, 2, "no provider work follows the manual safety reset");
				return assistant(fixture, mixed ? [
					{ type: "toolCall", id: "pressure-note", name: "notes_write", arguments: { address: "pressure.md", content: "PRESERVED_PRESSURE_NOTE" } },
					{ type: "toolCall", id: "pressure-wipe", name: "clear_memory", arguments: {} },
				] : [{ type: "text", text: "close-out complete" }], mixed ? "toolUse" : "stop", { usage: usage(80_000) });
			},
		});
		try {
			await fixture.session.prompt("HARD_RESERVE_OLD_SENTINEL");
			await fixture.session.prompt("/clear-memory");
			await fixture.session.waitForIdle();
			assert.equal(fixture.requests.length, 2);
			assert.equal(resetMarkers(fixture).length, 1, "the safety wipe is not repeated at settlement");
			assert.equal(JSON.stringify(fixture.sessionManager.buildSessionProjection().messages).includes("HARD_RESERVE_OLD_SENTINEL"), false);
			assert.ok(fixture.notices.some((notice) => notice.includes("memory cleared")));
			if (mixed) {
				assert.ok(existsSync(join(fixture.notesRoot, "pi", "session", fixture.sessionManager.getSessionId(), "pressure.md")), "the whole tool batch completes before the cut");
				assert.equal(fixture.streamSignals.at(-1), true, "Pi's unavoidable tool follow-up is cancelled before provider work");
			}
			// The stop latch belongs only to this run, not to future user input.
			newUserAllowed = true;
			await fixture.session.prompt("NEW_USER_AFTER_MANUAL_STOP");
			await fixture.session.waitForIdle();
			assert.equal(fixture.requests.length, 3);
			assert.equal(fixture.streamSignals.at(-1), false);
			assert.equal(resetMarkers(fixture).length, 1);
			assert.ok(JSON.stringify(fixture.sessionManager.getBranch()).includes("new user turn handled"));
		} finally {
			fixture.close();
		}
	}
});

test("real AgentSession: manual safety reset answers queued user input once before stopping", { timeout: 20000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		hook: (pi, getSession) => pi.on("tool_call", async (event) => {
			if (event.toolName === "notes_write") await getSession().followUp("PRESSURE_QUEUED_USER_INPUT");
		}),
		script: (request, context) => {
			if (request === 1) return assistant(fixture, [{ type: "text", text: "before wipe" }]);
			if (request === 2) return assistant(fixture, [{ type: "toolCall", id: "queued-pressure-note", name: "notes_write", arguments: { address: "queued-pressure.md", content: "checkpoint" } }], "toolUse", { usage: usage(80_000) });
			assert.equal(text(context).includes("QUEUED_SAFETY_OLD_SENTINEL"), false);
			if (request === 3) {
				assert.equal(text(context).includes("PRESSURE_QUEUED_USER_INPUT"), false, "Pi's tool follow-up precedes followUp queue delivery");
				return assistant(fixture, [{ type: "text", text: "wipe complete; waiting for queued input" }]);
			}
			assert.equal(request, 4);
			assert.equal(text(context).split("PRESSURE_QUEUED_USER_INPUT").length - 1, 1);
			return assistant(fixture, [{ type: "text", text: "queued user input handled" }]);
		},
	});
	try {
		await fixture.session.prompt("QUEUED_SAFETY_OLD_SENTINEL");
		await fixture.session.prompt("/clear-memory");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 4, "queued input is answered once after Pi's tool follow-up, then the stop lands");
		assert.equal(resetMarkers(fixture).length, 1);
		assert.equal(fixture.streamSignals.at(-1), false, "real user input must not be cancelled as an automatic follow-up");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: manual overflow wipes and stops even with automatic reset disabled", { timeout: 20000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		script: (request) => {
			if (request === 1) return assistant(fixture, [{ type: "text", text: "before overflow" }]);
			assert.equal(request, 2, "manual overflow must not trigger a recovery request");
			return assistant(fixture, [], "error", { errorMessage: "Prompt too long: context exceeds maximum context length" });
		},
	});
	try {
		await fixture.session.prompt("MANUAL_OVERFLOW_OLD_SENTINEL");
		await fixture.session.prompt("/clear-memory");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 2);
		assert.equal(resetMarkers(fixture).length, 1);
		assert.equal(JSON.stringify(fixture.sessionManager.buildSessionProjection().messages).includes("MANUAL_OVERFLOW_OLD_SENTINEL"), false);
		assert.ok(fixture.notices.some((notice) => notice.includes("memory cleared")));
	} finally {
		fixture.close();
	}
});

test("real AgentSession: streaming /clear-memory steers a close-out and stops at settlement", { timeout: 20000 }, async () => {
	let fixture!: Fixture;
	let announceStarted!: () => void;
	let releaseResponse!: () => void;
	const started = new Promise<void>((resolve) => { announceStarted = resolve; });
	const gate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	fixture = await openFixture({
		compactionEnabled: false,
		script: async (request, context) => {
			if (request === 1) {
				announceStarted();
				await gate;
				return assistant(fixture, [{ type: "text", text: "current response finished" }]);
			}
			assert.equal(request, 2, "the steered warning gets exactly one close-out turn before the run stops");
			assert.ok(text(context).includes(WARNING_PROMPT), "the busy warning is delivered to the running agent");
			return assistant(fixture, [{ type: "text", text: "close-out complete" }]);
		},
	});
	try {
		const running = fixture.session.prompt("STREAMING_WIPE_OLD_SENTINEL");
		await started;
		await fixture.session.prompt("/clear-memory", { streamingBehavior: "steer" });
		await fixture.session.prompt("/clear-memory", { streamingBehavior: "followUp" });
		assert.equal(fixture.notices.filter((notice) => notice.includes("queued; the agent is asked to close out")).length, 1, "the user is notified once while output is ongoing");
		assert.equal(resetMarkers(fixture).length, 0, "the ongoing turn is not interrupted");
		releaseResponse();
		await running;
		await fixture.session.waitForIdle();
		assert.equal(resetMarkers(fixture).length, 1);
		assert.equal(fixture.requests.length, 2, "the warning closes out and the run stops — no continuation in the fresh window");
		assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === MANUAL_WIPE_TYPE).length, 1, "the busy warning is persisted once");
		assert.equal(JSON.stringify(fixture.sessionManager.buildSessionProjection().messages).includes("STREAMING_WIPE_OLD_SENTINEL"), false);
		assert.ok(fixture.notices.some((notice) => notice.includes("memory cleared")), "the committed boundary has a separate success notice");
	} finally {
		releaseResponse();
		fixture.close();
	}
});

test("real AgentSession: repeated manual commands share one pending window", { timeout: 20000 }, async () => {
	let fixture!: Fixture;
	let announceStarted!: () => void;
	let releaseResponse!: () => void;
	const started = new Promise<void>((resolve) => { announceStarted = resolve; });
	const gate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	fixture = await openFixture({
		compactionEnabled: false,
		script: async (request) => {
			if (request === 1) {
				announceStarted();
				await gate;
			}
			return assistant(fixture, [{ type: "text", text: "close-out complete" }]);
		},
	});
	try {
		const first = fixture.session.prompt("/clear-memory");
		await started;
		const second = fixture.session.prompt("/clear-memory");
		releaseResponse();
		await Promise.all([first, second]);
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 1, "duplicate command waits do not schedule another model request");
		assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === MANUAL_WIPE_TYPE).length, 1, "the same pending-window warning is deduplicated");
		assert.equal(resetMarkers(fixture).length, 1, "normal stop commits exactly one reset");
		assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
	} finally {
		releaseResponse();
		fixture.close();
	}
});

test("real AgentSession: user abort, synthetic aborted response, and generic error never fall back", { timeout: 25000 }, async () => {
	for (const mode of ["ctx-abort", "synthetic-abort", "generic-error"] as const) {
		let fixture!: Fixture;
		let didAbort = false;
		fixture = await openFixture({
			compactionEnabled: false,
			hook: mode === "ctx-abort" ? (pi) => pi.on("context", (_event, ctx) => {
				if (!didAbort) {
					didAbort = true;
					ctx.abort();
				}
			}) : undefined,
			script: (request) => {
				if (request === 1 && mode === "synthetic-abort") return assistant(fixture, [{ type: "text", text: "synthetic aborted" }], "aborted");
				if (request === 1 && mode === "generic-error") return assistant(fixture, [{ type: "text", text: "request failed" }], "error", { errorMessage: "synthetic generic provider failure" });
				return assistant(fixture, [{ type: "text", text: "later user turn" }]);
			},
		});
		try {
			await fixture.session.prompt("/cm SHOULD_NOT_RUN_AFTER_FAILURE");
			await fixture.session.waitForIdle();
			assert.equal(resetMarkers(fixture).length, 0, `${mode} does not force a reset`);
			assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
			assert.equal(fixture.notices.some((notice) => notice.includes("memory cleared")), false);
			if (mode === "ctx-abort") assert.equal(fixture.streamSignals.at(-1), true, "this case aborts the real Pi operation signal");
			else assert.equal(fixture.streamSignals.at(-1), false, "synthetic abort/error is not a user abort signal");
			await fixture.session.prompt("AFTER_UNSUCCESSFUL_CLOSEOUT");
			await fixture.session.waitForIdle();
			assert.equal(resetMarkers(fixture).length, 0, "no pending close-out leaks into a later prompt");
			assert.equal(JSON.stringify(fixture.sessionManager.getBranch()).includes("SHOULD_NOT_RUN_AFTER_FAILURE"), false, "cancelled prompt is never appended");
		} finally {
			fixture.close();
		}
	}
});

test("real AgentSession: steering and follow-up queued during a manual reset are answered before the stop", { timeout: 25000 }, async () => {
	for (const delivery of ["steer", "followUp"] as const) {
		let fixture!: Fixture;
		let announceStarted!: () => void;
		let releaseResponse!: () => void;
		const started = new Promise<void>((resolve) => { announceStarted = resolve; });
		const gate = new Promise<void>((resolve) => { releaseResponse = resolve; });
		fixture = await openFixture({
			compactionEnabled: false,
			script: async (request, context) => {
				if (request === 1) {
					assert.ok(text(context).includes(WARNING_PROMPT));
					announceStarted();
					await gate;
				}
				if (request === 2) {
					assert.ok(text(context).includes(WARNING_PROMPT), `${delivery} is answered in the old window before the reset commits`);
					assert.equal(text(context).split("QUEUED_DURING_FALLBACK").length - 1, 1, `${delivery} is delivered once`);
				}
				return assistant(fixture, [{ type: "text", text: `response ${request}` }]);
			},
		});
		try {
			const command = fixture.session.prompt("/clear-memory");
			await started;
			if (delivery === "steer") fixture.session.steer("QUEUED_DURING_FALLBACK");
			else fixture.session.followUp("QUEUED_DURING_FALLBACK");
			releaseResponse();
			await command;
			await fixture.session.waitForIdle();
			assert.equal(fixture.requests.length, 2, `${delivery} is answered, then the reset commits at settlement with no continuation`);
			assert.equal(resetMarkers(fixture).length, 1, `${delivery} does not duplicate the reset`);
			assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("QUEUED_DURING_FALLBACK")).length, 1);
		} finally {
			releaseResponse();
			fixture.close();
		}
	}
});

test("real AgentSession: a reset survives all notes-home read failures with an incomplete boot", { timeout: 15000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		notesRootFile: true,
		script: (request) => request === 1
			? assistant(fixture, [{ type: "toolCall", id: "wipe-notes-failure", name: "clear_memory", arguments: {} }], "toolUse")
			: assistant(fixture, [{ type: "text", text: "resumed despite notes failure" }]),
	});
	try {
		await fixture.session.prompt("NOTES_FAILURE_RESET_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 2, "the failed notes index does not cancel the continuation");
		assertFreshRequest(fixture, 1, "NOTES_FAILURE_RESET_SENTINEL");
		assert.equal(resetMarkers(fixture).length, 1, "one reset marker is committed");
		const marker = resetMarkers(fixture)[0]!;
		assert.equal(marker.type, "custom");
		const windowId = (marker.data as { windowId: string }).windowId;
		const boot = fixture.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId);
		assert.ok(boot && boot.type === "custom_message");
		const bootText = typeof boot.content === "string" ? boot.content : JSON.stringify(boot.content);
		assert.ok(bootText.includes("THE HUMAN · @human"));
		assert.equal(bootText.match(/This drawer wouldn't open/g)?.length, 5, "each failed section gets one recovery line");
		assert.ok(bootText.includes("<context_window_protocol>"));
	} finally {
		fixture.close();
	}
});

test("real AgentSession: reset projection drops legacy message shapes but keeps raw history and equal/backwards new timestamps", { timeout: 15000 }, async () => {
	let fixture!: Fixture;
	const legacyTimestamp = Date.now();
	const legacyTexts = [
		"OLD_BASH_EXECUTION",
		"OLD_TOOL_RESULT",
		"OLD_COMPACTION_SUMMARY_WRAPPER",
		"OLD_BRANCH_SUMMARY",
	];
	fixture = await openFixture({
		compactionEnabled: false,
		seed: (sessionManager) => {
			type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];
			sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "OLD_USER_BEFORE_LEGACY_ENTRIES" }], timestamp: legacyTimestamp } as unknown as AppendableMessage);
			sessionManager.appendMessage({ role: "bashExecution", command: legacyTexts[0], output: legacyTexts[0], exitCode: 0, cancelled: false, truncated: false, timestamp: legacyTimestamp } as unknown as AppendableMessage);
			sessionManager.appendMessage({ role: "toolResult", content: [{ type: "text", text: legacyTexts[1] }], toolCallId: "legacy-tool", toolName: "bash", isError: false, timestamp: legacyTimestamp } as unknown as AppendableMessage);
			const compactionParent = sessionManager.getLeafId();
			sessionManager.appendCompaction(legacyTexts[2], compactionParent, 123, { legacy: true }, true);
			sessionManager.branchWithSummary(sessionManager.getLeafId(), legacyTexts[3], { legacy: true }, true);
		},
		script: (request, context) => {
			if (request === 1) return assistant(fixture, [{ type: "toolCall", id: "wipe-legacy", name: "clear_memory", arguments: {} }], "toolUse");
			if (request === 2) {
				const body = text(context);
				for (const legacy of legacyTexts) assert.equal(body.includes(legacy), false, `${legacy} is cut from the reset projection`);
				return assistant(fixture, [{ type: "toolCall", id: "new-timestamp", name: "notes_write", arguments: { address: "equal-timestamp.md", content: "NEW_EQUAL_BACKWARDS_MESSAGE" } }], "toolUse", { timestamp: legacyTimestamp - 1 });
			}
			const body = text(context);
			for (const legacy of legacyTexts) assert.equal(body.includes(legacy), false, `${legacy} stays absent after another fresh-window turn`);
			assert.ok(body.includes("NEW_EQUAL_BACKWARDS_MESSAGE"), "a new message with an equal/backwards timestamp survives the projection");
			const newAssistant = context.messages.find((message) => message.role === "assistant" && JSON.stringify(message).includes("NEW_EQUAL_BACKWARDS_MESSAGE"));
			assert.equal(newAssistant?.timestamp, legacyTimestamp - 1, "projection preserves the new message timestamp");
			return assistant(fixture, [{ type: "text", text: "legacy projection clean" }]);
		},
	});
	try {
		await fixture.session.prompt("NEW_WINDOW_PROJECTION_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 3, "the fresh window accepts one additional new-window tool turn");
		assert.equal(resetMarkers(fixture).length, 1);
		const raw = JSON.stringify(fixture.sessionManager.getBranch());
		for (const legacy of legacyTexts) assert.ok(raw.includes(legacy), `${legacy} remains in durable raw history`);
	} finally {
		fixture.close();
	}
});

test("real AgentSession: successive resets and a mixed tool batch cut only after every tool result", async () => {
	for (const scenario of ["successive", "mixed"] as const) {
		let fixture!: Fixture;
		fixture = await openFixture({
			compactionEnabled: false,
			script: (request) => {
				if (scenario === "successive" && request < 3) return assistant(fixture, [{ type: "toolCall", id: `wipe-${request}`, name: "clear_memory", arguments: {} }], "toolUse");
				if (scenario === "mixed" && request === 1) return assistant(fixture, [
					{ type: "toolCall", id: "wipe-1", name: "clear_memory", arguments: {} },
					{ type: "toolCall", id: "note-1", name: "notes_write", arguments: { address: "batch.md", content: "MIXED_BATCH_NOTE" } },
				], "toolUse");
				return assistant(fixture, [{ type: "text", text: "fresh completion" }]);
			},
		});
		try {
			await fixture.session.prompt(`OLD_${scenario.toUpperCase()}_SENTINEL`);
			await fixture.session.waitForIdle();
			const expected = scenario === "successive" ? 2 : 1;
			assert.equal(resetMarkers(fixture).length, expected);
			assert.equal(fixture.requests.length, expected + 1);
			assertFreshRequest(fixture, fixture.requests.length - 1, `OLD_${scenario.toUpperCase()}_SENTINEL`);
			if (scenario === "mixed") {
				const branch = fixture.sessionManager.getBranch();
				const markerIndex = branch.findIndex((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
				assert.ok(markerIndex > 0, "the marker follows the completed tool batch");
				assert.ok(branch.slice(0, markerIndex).some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes_write"), "notes_write completes before the cut");
				assert.ok(existsSync(join(fixture.notesRoot, "pi", "session", fixture.sessionManager.getSessionId(), "batch.md")));
			}
		} finally {
			fixture.close();
		}
	}
});

test("real AgentSession: two retain-none checkpoints survive session-file reopen", { timeout: 20000 }, async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "notesoup-persisted-session-"));
	let fixture!: Fixture;
	let sessionFile = "";
	let sessionId = "";
	fixture = await openFixture({
		compactionEnabled: false,
		sessionDir,
		script: (request) => request < 3
			? assistant(fixture, [{ type: "toolCall", id: `persisted-wipe-${request}`, name: "clear_memory", arguments: {} }], "toolUse")
			: assistant(fixture, [{ type: "text", text: "second reset window complete" }]),
	});
	try {
		await fixture.session.prompt("PERSISTED_OLD_WINDOW_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 3, "two explicit requests and one final continuation, with no summary-model request");
		assert.equal(resetMarkers(fixture).length, 2);
		assertFreshRequest(fixture, 2, "PERSISTED_OLD_WINDOW_SENTINEL");
		const branch = fixture.sessionManager.getBranch();
		const checkpoints = branch.filter((entry) => entry.type === "compaction");
		assert.equal(checkpoints.length, 2);
		const markers = resetMarkers(fixture);
		assert.equal(markers[0]?.parentId, checkpoints[0]?.id);
		assert.equal(markers[1]?.parentId, checkpoints[1]?.id);
		assert.equal(checkpoints[0]?.type === "compaction" ? checkpoints[0].firstKeptEntryId : undefined, checkpoints[0]?.id);
		assert.equal(checkpoints[1]?.type === "compaction" ? checkpoints[1].firstKeptEntryId : undefined, checkpoints[1]?.id);
		sessionFile = fixture.sessionManager.getSessionFile() ?? "";
		sessionId = fixture.sessionManager.getSessionId();
		assert.ok(sessionFile && existsSync(sessionFile), "the SDK persisted the real session file");
	} finally {
		fixture.close();
	}
	try {
		const reopened = SessionManager.open(sessionFile, sessionDir);
		assert.equal(reopened.getSessionId(), sessionId);
		const branch = reopened.getBranch();
		assert.equal(branch.filter((entry) => entry.type === "compaction").length, 2);
		assert.equal(branch.filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE).length, 2);
		assert.ok(JSON.stringify(branch).includes("PERSISTED_OLD_WINDOW_SENTINEL"), "raw history survives disk reopen");
		const canonical = reopened.buildSessionProjection().messages;
		assert.equal(JSON.stringify(canonical).includes("PERSISTED_OLD_WINDOW_SENTINEL"), false, "disk-loaded canonical context agrees with the fresh request");
		assert.ok(canonical.some((message) => message.role === "compactionSummary"), "the accepted empty-summary wrapper survives reload");
		const system = getCurrentSystemMessage(canonical);
		assert.ok(JSON.stringify(system).includes("Use the tools as requested."), "the complete system prompt survives the checkpoint");
		assert.ok(system?.toolsAdded?.some((tool) => tool.name === "clear_memory"), "the active tool loadout survives reopen");
		const reopenedMarkers = branch.filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
		const latestMarker = reopenedMarkers.at(-1);
		const previousMarker = reopenedMarkers[0];
		assert.ok(latestMarker?.type === "custom" && previousMarker?.type === "custom");
		const latestWindowId = (latestMarker.data as { windowId: string }).windowId;
		const previousWindowId = (previousMarker.data as { windowId: string }).windowId;
		const latestBoot = branch.find((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && (entry.details as { windowId?: string } | undefined)?.windowId === latestWindowId);
		assert.ok(latestBoot && latestBoot.type === "custom_message" && typeof latestBoot.content === "string");
		assert.ok(latestBoot.content.includes(`Previous context window id: ${previousWindowId}`));
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("real AgentSession: steering and follow-up are delivered exactly once in the fresh window", async () => {
	for (const deliverAs of ["steer", "followUp"] as const) {
		let fixture!: Fixture;
		fixture = await openFixture({
			compactionEnabled: false,
			hook: (pi, getSession) => {
				pi.on("tool_call", async (event) => {
					if ((event as { toolName?: string }).toolName !== "clear_memory") return;
					if (deliverAs === "steer") await getSession().steer("QUEUED_ONCE");
					else await getSession().followUp("QUEUED_ONCE");
				});
			},
			script: (request) => request === 1
				? assistant(fixture, [{ type: "toolCall", id: "wipe-queue", name: "clear_memory", arguments: {} }], "toolUse")
				: assistant(fixture, [{ type: "text", text: "queued message handled" }]),
		});
		try {
			await fixture.session.prompt(`OLD_${deliverAs}_SENTINEL`);
			await fixture.session.waitForIdle();
			assert.equal(fixture.requests.length, 2, `${deliverAs} does not duplicate the resumed request`);
			assertFreshRequest(fixture, 1, `OLD_${deliverAs}_SENTINEL`);
			assert.equal(text(fixture.requests[1]).split("QUEUED_ONCE").length - 1, 1, `${deliverAs} arrives once in the new window`);
			const queued = fixture.sessionManager.getBranch().filter((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("QUEUED_ONCE"));
			assert.equal(queued.length, 1, `${deliverAs} has one durable user message`);
		} finally {
			fixture.close();
		}
	}
});

test("real AgentSession: hidden or missing reset boots refuse to move the boundary", { timeout: 15000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		script: () => assistant(fixture, [{ type: "text", text: "scripted acknowledgement" }]),
	});
	try {
		await fixture.session.prompt("ROOT_BEFORE_HIDDEN_BOOT");
		await fixture.session.waitForIdle();
		await fixture.session.prompt("/clear-memory");
		await fixture.session.waitForIdle();
		await fixture.session.prompt("VALID_POST_MARKER_WORK");
		await fixture.session.waitForIdle();

		const marker = resetMarkers(fixture)[0];
		assert.ok(marker && marker.type === "custom");
		const windowId = (marker.data as { windowId: string }).windowId;
		const boot = fixture.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId);
		assert.ok(boot && boot.type === "custom_message");
		fixture.sessionManager.appendContextEdit(boot.id, null);
		const bootCount = () => fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId).length;
		assert.equal(bootCount(), 1);

		await fixture.session.reload();
		assert.equal(bootCount(), 1, "a raw boot hidden by context_edit is not replaced at the tail");
		const requestsBeforeRefusal = fixture.requests.length;
		await fixture.session.prompt("MISSING_PROJECTED_BOOT_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(bootCount(), 1, "a refused active window never receives a replacement boot");
		assert.ok(fixture.requests.length <= requestsBeforeRefusal, "the normal provider request is not generated from a shortened window");
		const safeContext = fixture.streamContexts.at(-1);
		assert.ok(safeContext, "the SDK may still invoke the stream function with an aborted signal");
		assert.ok(safeContext.messages.every((message) => message.role === "system"), "a refused request receives system-only safe context");
		assert.equal(fixture.streamSignals.at(-1), true, "the refused request is aborted before provider work");
		assert.ok(JSON.stringify(fixture.sessionManager.getBranch()).includes("VALID_POST_MARKER_WORK"), "raw post-marker work remains durable");
	} finally {
		fixture.close();
	}

	let missingRaw!: Fixture;
	missingRaw = await openFixture({
		compactionEnabled: false,
		seed: (sessionManager) => {
			sessionManager.appendCustomEntry(RESET_MARKER_TYPE, { windowId: "pcw:missing:boot" });
			sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "RAW_POST_MARKER_WORK" }], timestamp: Date.now() });
		},
		script: () => assistant(missingRaw, [{ type: "text", text: "must not be called normally" }]),
	});
	try {
		assert.equal(missingRaw.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE).length, 0, "post-marker conversation blocks startup repair");
		await missingRaw.session.prompt("MISSING_RAW_BOOT_SENTINEL");
		await missingRaw.session.waitForIdle();
		assert.equal(missingRaw.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE).length, 0, "later conversation without a boot is refused, not repaired");
		assert.equal(missingRaw.streamSignals.at(-1), true);
		assert.ok(missingRaw.streamContexts.at(-1)?.messages.every((message) => message.role === "system"));
	} finally {
		missingRaw.close();
	}
});

test("real AgentSession: the complete system message and a changed tool loadout survive the reset projection", async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		systemPrompt: ["SYSTEM_SECTION_ALPHA", "SYSTEM_SECTION_BETA", "SYSTEM_TOOLS_SECTION", "SYSTEM_LOADOUT_SECTION"].join("\n"),
		tools: ["clear_memory"],
		script: (request, context) => {
			const systemText = JSON.stringify(context.messages.filter((message) => message.role === "system"));
			const currentSystem = getCurrentSystemMessage(context.messages);
			const effectiveToolNames = (currentSystem?.toolsAdded ?? []).map((tool) => tool.name).sort();
			assert.ok(systemText.includes("SYSTEM_SECTION_ALPHA"));
			assert.ok(systemText.includes("SYSTEM_SECTION_BETA"));
			assert.ok(systemText.includes("SYSTEM_TOOLS_SECTION"));
			assert.ok(systemText.includes("SYSTEM_LOADOUT_SECTION"));
			if (request === 1) {
				assert.deepEqual(effectiveToolNames, ["clear_memory"]);
				fixture.session.setActiveToolsByName(["clear_memory", "get_context_remaining"]);
				return assistant(fixture, [{ type: "toolCall", id: "wipe-system", name: "clear_memory", arguments: {} }], "toolUse");
			}
			assert.deepEqual(effectiveToolNames, ["get_context_remaining", "clear_memory"]);
			assert.ok(JSON.stringify(context.messages).includes(CONTEXT_WINDOW_OPEN_TAG));
			return assistant(fixture, [{ type: "text", text: "all system sections survived" }]);
		},
	});
	try {
		await fixture.session.prompt("SYSTEM_LOADOUT_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 2);
		assertFreshRequest(fixture, 1, "SYSTEM_LOADOUT_SENTINEL");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: overflow and recoverable length reset and retry once; repeated failure is bounded", { timeout: 15000 }, async () => {
	for (const failure of ["overflow", "length"] as const) {
		let fixture!: Fixture;
		fixture = await openFixture({
			script: (request) => {
				if (request === 1 && failure === "overflow") return assistant(fixture, [{ type: "text", text: "overflow response" }], "error", { errorMessage: "Prompt too long: context exceeds maximum context length" });
				if (request === 1) return assistant(fixture, [{ type: "text", text: "truncated" }], "length", { usage: usage(99_000, 1) });
				return assistant(fixture, [{ type: "text", text: "recovered" }]);
			},
		});
		try {
			await fixture.session.prompt(`RECOVER_${failure}_SENTINEL`);
			await fixture.session.waitForIdle();
			assert.equal(resetMarkers(fixture).length, 1, `${failure} performs one reset`);
			assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1, `${failure} commits one native reset checkpoint`);
			assert.equal(fixture.requests.length, 2, `${failure} resumes once`);
			assertFreshRequest(fixture, 1, `RECOVER_${failure}_SENTINEL`);
		} finally {
			fixture.close();
		}
	}

	let repeated!: Fixture;
	repeated = await openFixture({
		script: (request) => assistant(repeated, [{ type: "text", text: `overflow-${request}` }], "error", { errorMessage: "Prompt too long: context exceeds maximum context length" }),
	});
	try {
		await repeated.session.prompt("REPEATED_OVERFLOW_SENTINEL");
		await repeated.session.waitForIdle();
		assert.equal(resetMarkers(repeated).length, 1, "repeated overflow does not create repeated windows");
		assert.equal(repeated.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1, "bounded overflow recovery commits one retain-none checkpoint");
		assert.equal(repeated.requests.length, 2, "repeated overflow stops after one recovery request");
	} finally {
		repeated.close();
	}
});

test("real AgentSession: concurrent trusted projects keep reserve and automatic policy isolated", { timeout: 20000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "notesoup-shared-agent-"));
	const notesRoot = mkdtempSync(join(tmpdir(), "notesoup-shared-notes-"));
	const cwdAutomatic = mkdtempSync(join(tmpdir(), "notesoup-project-automatic-"));
	const cwdModel = mkdtempSync(join(tmpdir(), "notesoup-project-model-"));
	const cwdSession = mkdtempSync(join(tmpdir(), "notesoup-project-session-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		compaction: { enabled: true, reserveTokens: 70_000, keepRecentTokens: 200 },
		retry: { enabled: false },
	}));
	let automatic!: Fixture;
	let modelInvalidated!: Fixture;
	let sessionInvalidated!: Fixture;
	const script = (fixture: () => Fixture, highUsage: { next: boolean }) => () => {
		const response = assistant(fixture(), [{ type: "text", text: "policy isolation response" }], "stop", { usage: usage(highUsage.next ? 85_000 : 100) });
		highUsage.next = false;
		return response;
	};
	const automaticUsage = { next: true };
	const modelUsage = { next: true };
	const sessionUsage = { next: true };
	try {
		// All three sessions share one stable global settings root. Only their trusted
		// project settings differ, so this cannot pass by rotating PI_CODING_AGENT_DIR.
		automatic = await openFixture({
			contextWindow: 100_000,
			cwd: cwdAutomatic,
			agentDir,
			notesRoot,
			writeSettings: false,
			projectSettings: { compaction: { enabled: true, reserveTokens: 20_000 } },
			script: script(() => automatic, automaticUsage),
		});
		modelInvalidated = await openFixture({
			contextWindow: 100_000,
			cwd: cwdModel,
			agentDir,
			notesRoot,
			writeSettings: false,
			projectSettings: { compaction: { enabled: false, reserveTokens: 80_000 } },
			script: script(() => modelInvalidated, modelUsage),
		});
		sessionInvalidated = await openFixture({
			contextWindow: 100_000,
			cwd: cwdSession,
			agentDir,
			notesRoot,
			writeSettings: false,
			projectSettings: { compaction: { enabled: false, reserveTokens: 80_000 } },
			script: script(() => sessionInvalidated, sessionUsage),
		});

		await Promise.all([
			automatic.session.prompt("AUTOMATIC_POLICY_PROJECT"),
			modelInvalidated.session.prompt("MODEL_POLICY_PROJECT"),
			sessionInvalidated.session.prompt("SESSION_POLICY_PROJECT"),
		]);
		await Promise.all([automatic.session.waitForIdle(), modelInvalidated.session.waitForIdle(), sessionInvalidated.session.waitForIdle()]);
		assert.equal(resetMarkers(automatic).length, 1, "the low reserve and enabled project resets automatically");
		assert.equal(automatic.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE).length, 1, "the automatic reset persists exactly one continuation");
		assert.equal(resetMarkers(modelInvalidated).length, 0, "the high reserve and disabled project does not reset");
		assert.equal(resetMarkers(sessionInvalidated).length, 0, "the second high reserve and disabled session does not reset");

		writeFileSync(join(cwdModel, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 20_000 } }));
		modelUsage.next = true;
		const changedModel = { ...modelInvalidated.model, id: `${modelInvalidated.model.id}-changed` };
		modelInvalidated.model = changedModel;
		await modelInvalidated.session.setModel(changedModel, { persist: false });
		await modelInvalidated.session.prompt("MODEL_POLICY_AFTER_INVALIDATION");
		await modelInvalidated.session.waitForIdle();
		assert.equal(resetMarkers(modelInvalidated).length, 1, "model_select invalidates the instance policy cache");

		writeFileSync(join(cwdSession, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 20_000 } }));
		sessionUsage.next = true;
		await sessionInvalidated.session.reload();
		await sessionInvalidated.session.prompt("SESSION_POLICY_AFTER_INVALIDATION");
		await sessionInvalidated.session.waitForIdle();
		assert.equal(resetMarkers(sessionInvalidated).length, 1, "session reload invalidates the instance policy cache");
	} finally {
		sessionInvalidated?.close();
		modelInvalidated?.close();
		automatic?.close();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(notesRoot, { recursive: true, force: true });
		rmSync(cwdAutomatic, { recursive: true, force: true });
		rmSync(cwdModel, { recursive: true, force: true });
		rmSync(cwdSession, { recursive: true, force: true });
	}
});

test("real AgentSession: injected settings managers own live policy and ignore conflicting default files", { timeout: 20000 }, async () => {
	const firstManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 80_000 } });
	const secondManager = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 20_000 } });
	const defaultAgentDir = mkdtempSync(join(tmpdir(), "notesoup-injected-default-agent-"));
	const notesRoot = mkdtempSync(join(tmpdir(), "notesoup-injected-notes-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousNotesRoot = process.env.PI_NOTES_HOME;
	writeFileSync(join(defaultAgentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, reserveTokens: 1_000 } }));
	process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
	process.env.PI_NOTES_HOME = notesRoot;
	let first!: Fixture;
	let second!: Fixture;
	const firstHighUsage = { next: false };
	const secondHighUsage = { next: false };
	const script = (getFixture: () => Fixture, highUsage: { next: boolean }) => (request: number) => {
		const fixture = getFixture();
		if (request === 1) {
			highUsage.next = false;
			return assistant(fixture, [{ type: "toolCall", id: "remaining", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(20_000) });
		}
		// Leave 20k free: above the low reserve plus the 16k warning runway.
		const input = highUsage.next ? 80_000 : 100;
		highUsage.next = false;
		return assistant(fixture, [{ type: "text", text: "scripted policy response" }], "stop", { usage: usage(input) });
	};
	try {
		first = await openFixture({
			contextWindow: 100_000,
			agentDir: defaultAgentDir,
			notesRoot,
			writeSettings: false,
			defaultCompactionEnabled: false,
			defaultReserveTokens: 1_000,
			settingsManager: firstManager,
			manageEnvironment: false,
			tools: ["get_context_remaining"],
			script: script(() => first, firstHighUsage),
		});
		second = await openFixture({
			contextWindow: 100_000,
			agentDir: defaultAgentDir,
			notesRoot,
			writeSettings: false,
			defaultCompactionEnabled: true,
			defaultReserveTokens: 95_000,
			settingsManager: secondManager,
			manageEnvironment: false,
			tools: ["get_context_remaining"],
			script: script(() => second, secondHighUsage),
		});

		await Promise.all([first.session.prompt("INJECTED_FIRST"), second.session.prompt("INJECTED_SECOND")]);
		await Promise.all([first.session.waitForIdle(), second.session.waitForIdle()]);
		assert.deepEqual(contextRemainingResults(first), [0], "the injected high reserve reaches the warning line in the real tool result");
		assert.ok((contextRemainingResults(second)[0] ?? 0) > 0, "the second injected reserve produces a distinct real tool result");
		assert.equal(resetMarkers(first).length, 1, "enabled injected policy resets at the first session's reserve");
		assert.equal(resetMarkers(second).length, 0, "disabled injected policy does not inherit the first session's reset decision");

		firstHighUsage.next = true;
		firstManager.setCompactionEnabled(false);
		firstManager.applyOverrides({ compaction: { reserveTokens: 90_000 } });
		await first.session.prompt("INJECTED_LIVE_DISABLE");
		await first.session.waitForIdle();
		assert.equal(resetMarkers(first).length, 1, "a public setter disables the next turn without reload");
		assert.equal(resetMarkers(second).length, 0, "the second live manager remains unchanged");

		firstHighUsage.next = true;
		firstManager.setCompactionEnabled(true);
		firstManager.applyOverrides({ compaction: { reserveTokens: 1_000 } });
		await first.session.prompt("INJECTED_LIVE_ENABLE_LOW_RESERVE");
		await first.session.waitForIdle();
		assert.equal(resetMarkers(first).length, 1, "live enablement and a lower reserve apply on the next turn");

		firstHighUsage.next = true;
		firstManager.applyOverrides({ compaction: { reserveTokens: 80_000 } });
		await first.session.prompt("INJECTED_LIVE_HIGH_RESERVE");
		await first.session.waitForIdle();
		assert.equal(resetMarkers(first).length, 2, "a live reserve increase drives the next reset decision");
	} finally {
		second?.close();
		first?.close();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousNotesRoot === undefined) delete process.env.PI_NOTES_HOME;
		else process.env.PI_NOTES_HOME = previousNotesRoot;
		rmSync(defaultAgentDir, { recursive: true, force: true });
		rmSync(notesRoot, { recursive: true, force: true });
	}
});

test("real AgentSession: injected model overrides select the active model's reserve", { timeout: 20000 }, async () => {
	let settingsManager!: SettingsManager;
	let modelBId = "";
	const notesRoot = mkdtempSync(join(tmpdir(), "notesoup-model-override-notes-"));
	const previousNotesRoot = process.env.PI_NOTES_HOME;
	process.env.PI_NOTES_HOME = notesRoot;
	let fixture!: Fixture;
	fixture = await openFixture({
		contextWindow: 100_000,
		notesRoot,
		settingsManager: (model) => {
			modelBId = `${model.id}-changed`;
			settingsManager = SettingsManager.inMemory({
				compaction: {
					enabled: false,
					reserveTokens: 10_000,
					modelOverrides: {
						[`${model.provider}/${model.id}`]: { reserveTokens: 70_000 },
						[`${model.provider}/${modelBId}`]: { reserveTokens: 1_000 },
					},
				},
			});
			return settingsManager;
		},
		manageEnvironment: false,
		tools: ["get_context_remaining"],
		script: (request) => request === 1 || request === 3
			? assistant(fixture, [{ type: "toolCall", id: `remaining-${request}`, name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(30_000) })
			: assistant(fixture, [{ type: "text", text: "scripted model override response" }], "stop", { usage: usage(1_000) }),
	});
	try {
		await fixture.session.prompt("MODEL_OVERRIDE_A");
		await fixture.session.waitForIdle();
		assert.deepEqual(contextRemainingResults(fixture), [0], "model-a's high reserve reaches zero in the real tool result");

		const changedModel = { ...fixture.model, id: modelBId };
		fixture.model = changedModel;
		await fixture.session.setModel(changedModel, { persist: false });
		await fixture.session.prompt("MODEL_OVERRIDE_B");
		await fixture.session.waitForIdle();
		const results = contextRemainingResults(fixture);
		assert.equal(results.length, 2);
		assert.ok((results[1] ?? 0) > 0, "model-b's lower reserve is selected for the next real tool result");
	} finally {
		fixture.close();
		if (previousNotesRoot === undefined) delete process.env.PI_NOTES_HOME;
		else process.env.PI_NOTES_HOME = previousNotesRoot;
		rmSync(notesRoot, { recursive: true, force: true });
	}
});

test("real AgentSession: persisted budget warning re-arms after a later abort/error", { timeout: 30000 }, async () => {
	for (const mode of ["ctx-abort", "generic-error"] as const) {
		let fixture!: Fixture;
		let warningTurnStarted!: () => void;
		let releaseWarningTurn!: () => void;
		let didAbort = false;
		const warningStarted = new Promise<void>((resolve) => { warningTurnStarted = resolve; });
		const warningGate = new Promise<void>((resolve) => { releaseWarningTurn = resolve; });
		fixture = await openFixture({
			compactionEnabled: true,
			hook: mode === "ctx-abort" ? (pi, _getSession, requests) => pi.on("context", (_event, ctx) => {
				if (!didAbort && requests.length === 3) {
					didAbort = true;
					ctx.abort();
				}
			}) : undefined,
			script: async (request, context) => {
				if (request === 1) return assistant(fixture, [{ type: "toolCall", id: "rearm-probe-1", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(50_000) });
				if (request === 2) return assistant(fixture, [{ type: "toolCall", id: "rearm-probe-2", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(60_000) });
				if (request === 3) {
					assert.ok(text(context).includes(WARNING_PROMPT), "the low-budget request carries the close-out warning");
					warningTurnStarted();
					await warningGate;
					return assistant(fixture, [{ type: "toolCall", id: "rearm-note", name: "notes_write", arguments: { address: "warning-rearm.md", content: "DURABLE_WARNING_CHECKPOINT" } }], "toolUse", { usage: usage(60_000) });
				}
				if (request === 4 && mode === "generic-error") {
					assert.equal(text(context).split(WARNING_PROMPT).length - 1, 1, "the durable warning is not injected a second time");
					assert.ok(text(context).includes("REARM_QUEUED_FOLLOWUP"));
					return assistant(fixture, [{ type: "text", text: "ordinary provider failure" }], "error", { errorMessage: "synthetic non-overflow failure", usage: usage(60_000) });
				}
				return assistant(fixture, [{ type: "text", text: `normal response ${request}` }], "stop", { usage: usage(60_000) });
			},
		});
		try {
			const initialTurn = fixture.session.prompt(`REARM_${mode}_INITIAL`);
			await warningStarted;
			fixture.session.steer("REARM_QUEUED_FOLLOWUP");
			releaseWarningTurn();
			await initialTurn;
			await fixture.session.waitForIdle();
			const afterFailure = fixture.sessionManager.getBranch();
			assert.equal(afterFailure.filter((entry) => entry.type === "custom_message" && entry.customType === WARNING_TYPE).length, 1, "the warning was persisted exactly once before the failed follow-up");
			assert.ok(existsSync(join(fixture.notesRoot, "pi", "session", fixture.sessionManager.getSessionId(), "warning-rearm.md")), "the preceding note/tool turn completed");
			assert.equal(resetMarkers(fixture).length, 0, `${mode} itself must not reset`);
			assert.equal(afterFailure.filter((entry) => entry.type === "compaction").length, 0);
			const failedContext = fixture.streamContexts[3];
			assert.ok(failedContext);
			assert.equal(text(failedContext).split(WARNING_PROMPT).length - 1, 1, "the persisted warning appears once, without duplicate injection");
			assert.equal(text(failedContext).split("REARM_QUEUED_FOLLOWUP").length - 1, 1, "queued follow-up reaches the failed request once");
			assert.equal(fixture.streamSignals.at(-1), mode === "ctx-abort", "the abort case cancels Pi's real signal; the error case does not");

			await fixture.session.prompt("REARM_AFTER_FAILED_TURN");
			await fixture.session.waitForIdle();
			assert.equal(resetMarkers(fixture).length, 0, "a later normal stop still does not authorize a budget reset");
			assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === WARNING_TYPE).length, 1, "re-arming does not duplicate the durable warning");
			assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
			assert.ok(text(fixture.requests.at(-1)).includes(`REARM_${mode}_INITIAL`), "the original task survives settlement");
		} finally {
			releaseWarningTurn();
			fixture.close();
		}
	}
});

test("real AgentSession: warning precedes a durable checkpoint, including failed writes and an ignored warning", { timeout: 20000 }, async () => {
	for (const scenario of ["checkpoint", "write-error", "ignored-warning"] as const) {
		let fixture!: Fixture;
		fixture = await openFixture({
			compactionEnabled: true,
			script: (request, context) => {
				if (request === 3) {
					assert.ok(text(context).includes(GUIDANCE_OPEN_TAG), "the warning remains in its hidden guidance wrapper");
					assert.ok(text(context).includes(WARNING_PROMPT), "the shared close-out warning reaches the provider before checkpoint choice");
				}
				if (request === 1) return assistant(fixture, [{ type: "toolCall", id: "budget-probe-1", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(50_000) });
				if (request === 2) return assistant(fixture, [{ type: "toolCall", id: "budget-probe-2", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(60_000) });
				if (request === 3 && scenario !== "ignored-warning") return assistant(fixture, [{ type: "toolCall", id: "checkpoint", name: "notes_write", arguments: {
					address: scenario === "write-error" ? "../invalid.md" : "checkpoint.md",
					content: "CHECKPOINT_SENTINEL",
				} }], "toolUse", { usage: usage(60_000) });
				if (request === 4 && scenario !== "ignored-warning") return assistant(fixture, [{ type: "toolCall", id: "wipe-after-checkpoint", name: "clear_memory", arguments: {} }], "toolUse", { usage: usage(60_000) });
				return assistant(fixture, [{ type: "text", text: scenario === "ignored-warning" ? "warning intentionally ignored" : "checkpoint and wipe complete" }], "stop", { usage: usage(60_000) });
			},
		});
		try {
			await fixture.session.prompt(`WARNING_${scenario.toUpperCase()}_SENTINEL`);
			await fixture.session.waitForIdle();
			const branch = fixture.sessionManager.getBranch();
			assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE).length, 1, "one early reminder is durable");
			assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === WARNING_TYPE).length, 1, "one critical warning is durable");
			const noteFile = join(fixture.notesRoot, "pi", "session", fixture.sessionManager.getSessionId(), "checkpoint.md");
			if (scenario === "checkpoint") {
				assert.equal(resetMarkers(fixture).length, 1);
				assert.equal(existsSync(noteFile), true, "a successful checkpoint reaches the notes store before reset");
				assert.ok(text(fixture.requests.at(-1)).includes("checkpoint.md"), "the fresh boot indexes the successful checkpoint");
			} else if (scenario === "write-error") {
				assert.equal(resetMarkers(fixture).length, 1);
				assert.equal(existsSync(noteFile), false, "a failed checkpoint does not create a note");
				assert.ok(branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes_write" && entry.message.isError && entry.message.content.some((part) => part.type === "text" && part.text.startsWith("error: invalid_address: "))), "the failed write persists its coded refusal as an error result");
			} else {
				assert.equal(resetMarkers(fixture).length, 0, "an ignored warning must not erase the task at normal stop");
				assert.equal(fixture.requests.length, 3, "settlement must not manufacture a fresh-window request");
				assert.equal(branch.filter((entry) => entry.type === "compaction").length, 0);
				assert.equal(existsSync(noteFile), false);
				await fixture.session.prompt("Continue the same task.");
				await fixture.session.waitForIdle();
				assert.equal(resetMarkers(fixture).length, 0);
				assert.ok(text(fixture.requests.at(-1)).includes(`WARNING_${scenario.toUpperCase()}_SENTINEL`));
				assert.equal(text(fixture.requests.at(-1)).split(WARNING_PROMPT).length - 1, 1, "the persisted warning remains visible without duplicate injection");
			}
		} finally {
			fixture.close();
		}
	}
});
