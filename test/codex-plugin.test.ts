import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
import { runHook } from "../plugins/codex/src/hooks.js";
import { writeBinding } from "../plugins/codex/src/identity.js";

/* Producer-shaped synthetic fixtures, not captured/private transcripts.
 * Frozen official rust-v0.160.1, d27764b82f7118f674371e6d6e76271d9d606edb.
 * Legacy records omit ordinals; a Compacted record names the new native window.
 */
const ROOT = "019a0000-0000-7000-8000-000000000001";
const CHILD = "019a0000-0000-7000-8000-000000000002";
const FORK = "019a0000-0000-7000-8000-000000000003";
const W0 = "019a0000-0000-7000-8000-000000000010";
const W1 = "019a0000-0000-7000-8000-000000000011";
const AT = "2026-10-06T01:02:03.000Z";
type Row = Record<string, unknown>;

function runHookCli(cli: string, event: string, payload: unknown, env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, [cli, "hook", event], { env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolveRun(stdout) : reject(new Error(`hook exited ${code}: ${stderr}`)));
		child.stdin.end(JSON.stringify(payload));
	});
}

function repository(): string {
	let root = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(root, "tsconfig.json"))) root = dirname(root);
	return root;
}
const REPO = repository();
const CLI = join(REPO, "plugins/codex/dist/codex/notesoup.js");

const row = (type: string, payload: Row, metadata?: Row): Row => ({ timestamp: AT, type, payload, ...(metadata ? { metadata } : {}) });
function sessionMeta(id = ROOT, extra: Row = {}): Row {
	return { session_id: ROOT, id, timestamp: AT, cwd: "/workspace/native", originator: "codex_cli_rs", cli_version: "0.160.1", source: "cli", model_provider: "openai", base_instructions: { text: "base" }, history_mode: "legacy", context_window: { window_id: W0 }, ...extra };
}
const message = (role: string, text: string): Row => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
/** The host persists SessionStart additionalContext with this provenance; a plain developer message is not evidence. */
const hookContext = (text: string): Row => ({ ...message("developer", text), internal_chat_message_metadata_passthrough: { content_item_kinds: ["hooks.additional_context"] } });
const compact = (window: string, previous: string, number: number): Row => ({ message: "", replacement_history: [], window_number: number, first_window_id: W0, previous_window_id: previous, window_id: window, compaction_response_id: null });
const jsonl = (rows: Row[]): string => rows.map((value) => `${JSON.stringify(value)}\n`).join("");
const nativeName = (thread: string): string => `rollout-2026-10-06T01-02-03-${thread}.jsonl`;

type Fixture = { home: string; transcript: string; cwd: string; data: string };
async function fixture(t: TestContext, thread = ROOT): Promise<Fixture> {
	const home = await mkdtemp(join(tmpdir(), "notesoup-codex-plugin-"));
	const data = await mkdtemp(join(tmpdir(), "notesoup-codex-data-"));
	const day = join(home, "sessions", "2026", "10", "06");
	await mkdir(day, { recursive: true });
	const transcript = join(day, nativeName(thread));
	t.after(() => rm(home, { recursive: true, force: true }));
	t.after(() => rm(data, { recursive: true, force: true }));
	return { home, transcript, cwd: "/workspace/native", data };
}

type Binding = {
	threadId: string;
	rootSessionId: string;
	home: string;
	cwd: string;
	transcriptPath: string;
	agent?: string;
	model?: string;
	agentType?: string;
	windowId?: string;
};
async function bind(data: string, value: Binding): Promise<void> {
	await writeBinding(data, {
		version: 1,
		threadId: value.threadId,
		rootSessionId: value.rootSessionId,
		cwd: value.cwd,
		model: value.model ?? "gpt-5.4",
		agent: value.agent ?? "anonymous",
		home: value.home,
		transcriptPath: value.transcriptPath,
		windowId: value.windowId ?? W0,
		...(value.agentType === undefined ? {} : { agentType: value.agentType }),
		boundAt: AT,
	});
}

type LooseResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
function metaFor(threadId: string, rootSessionId: string, model = "gpt-5.1-codex", windowId = W0): Record<string, unknown> {
	return { threadId, sessionId: rootSessionId, windowId, "x-codex-turn-metadata": { model } };
}

async function call(client: Client, params: Parameters<Client["callTool"]>[0]): Promise<LooseResult> {
	return await client.callTool(params) as unknown as LooseResult;
}

async function connect(t: TestContext, data: string, cli = CLI, notes?: string): Promise<Client> {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [cli, "mcp"],
		env: { ...process.env as Record<string, string>, PLUGIN_DATA: data, ...(notes === undefined ? {} : { NOTESOUP_HOME: notes }) },
		stderr: "pipe",
	});
	const client = new Client({ name: "notesoup-test", version: "1.0.0" }, { capabilities: {} });
	await client.connect(transport);
	t.after(async () => { await client.close(); });
	return client;
}

function textOf(result: LooseResult): string {
	return (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function errorCode(result: LooseResult): string | undefined {
	return result.isError === true && typeof result.structuredContent === "object" && result.structuredContent !== null
		? (result.structuredContent as { code?: string }).code
		: undefined;
}

/* ---------------------------------------------------------------- manifests */

test("portable manifests name the Agent Plugins schema and the bundled stdio helper", () => {
	const plugin = JSON.parse(readFileSync(join(REPO, "plugins/codex/plugin.json"), "utf8"));
	assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
	assert.equal(plugin.name, "notesoup");
	const mcp = JSON.parse(readFileSync(join(REPO, "plugins/codex/mcp.json"), "utf8"));
	assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
	const server = mcp.mcpServers.notesoup;
	assert.equal(server.type, "stdio");
	assert.equal(server.command, "node");
	assert.deepEqual(server.args, ["${PLUGIN_ROOT}/dist/codex/notesoup.js", "mcp"]);
	const hooks = JSON.parse(readFileSync(join(REPO, "plugins/codex/hooks/hooks.json"), "utf8")).hooks;
	for (const event of ["SessionStart", "SubagentStart"]) {
		const handler = hooks[event][0].hooks[0];
		assert.equal(handler.type, "command");
		assert.match(handler.command, /dist\/codex\/notesoup\.js.*hook SessionStart|dist\/codex\/notesoup\.js.*hook SubagentStart/);
		// A required boot must not be spilled/chunked by the host's default 2,500-token cap.
		assert.equal(handler.additionalContextLimit, 0, event);
	}
	assert.match(hooks.PreCompact[0].hooks[0].command, /hook PreCompact/);
	const marketplace = JSON.parse(readFileSync(join(REPO, ".agents/plugins/marketplace.json"), "utf8"));
	assert.equal(marketplace.name, "notesoup");
	const source = marketplace.plugins[0].source;
	assert.equal(source.source, "local");
	const root = resolve(REPO, source.path);
	assert.equal(JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")).name, "notesoup");
	assert.ok(existsSync(join(root, "mcp.json")));
});

test("a copied plugin without src or node_modules still initializes and lists all operations", async (t) => {
	const copy = await mkdtemp(join(tmpdir(), "notesoup-codex-copy-"));
	t.after(() => rm(copy, { recursive: true, force: true }));
	cpSync(join(REPO, "plugins/codex"), copy, {
		recursive: true,
		filter: (source) => !source.startsWith(join(REPO, "plugins/codex/src")),
	});
	assert.equal(existsSync(join(copy, "src")), false);
	assert.equal(existsSync(join(copy, "node_modules")), false);
	const bundle = readFileSync(join(copy, "dist/codex/notesoup.js"), "utf8");
	assert.doesNotMatch(bundle, /from "\.\.\/\.\.\/\.\.\//);
	assert.doesNotMatch(bundle, /plugins\/claude|plugins\/pi|plugins\/dsh/);
	const data = await mkdtemp(join(tmpdir(), "notesoup-codex-copy-data-"));
	t.after(() => rm(data, { recursive: true, force: true }));
	const client = await connect(t, data, join(copy, "dist/codex/notesoup.js"));
	const listed = await client.listTools();
	assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
		"history_list", "history_read", "history_windows",
		"notes_list", "notes_read", "notes_search", "notes_update", "notes_write",
	]);
	for (const tool of listed.tools) {
		const schema = tool.outputSchema as Record<string, unknown> | undefined;
		assert.equal(schema?.type, "object", `${tool.name} outputSchema is an object`);
		assert.ok(Array.isArray(schema?.anyOf), `${tool.name} outputSchema keeps the shared result union`);
	}
	const denied = await call(client, { name: "notes_list", arguments: {}, _meta: metaFor(ROOT, ROOT) });
	assert.equal(denied.isError, true);
	assert.equal(errorCode(denied), "unknown_thread");
	const refusal = await runHookCli(join(copy, "dist/codex/notesoup.js"), "PreCompact", { session_id: ROOT, agent_id: CHILD, transcript_path: null, cwd: "/workspace/native", model: "gpt-5.4", trigger: "manual" }, { ...process.env, PLUGIN_DATA: data });
	assert.match(refusal, /"continue":false/);
	assert.match(refusal, /child post-compact boot/);
});

/* ---------------------------------------------------------------- MCP tools */

test("notes tools use the hook thread as the session notebook and the current turn model as @model", async (t) => {
	const f = await fixture(t);
	await writeFile(f.transcript, jsonl([row("session_meta", sessionMeta())]));
	await bind(f.data, { threadId: ROOT, rootSessionId: ROOT, home: f.home, cwd: f.cwd, transcriptPath: f.transcript });
	const client = await connect(t, f.data, CLI, f.home);
	const meta = metaFor(ROOT, ROOT, "openai/gpt-5.1-codex");
	const written = await call(client, { name: "notes_write", arguments: { address: "state.md", content: "hello native" }, _meta: meta });
	assert.equal(written.isError, undefined);
	assert.match(textOf(written), /state\.md/);
	assert.match(readFileSync(join(f.home, "pi", "session", ROOT, "state.md"), "utf8"), /hello native/);
	const modelNote = await call(client, { name: "notes_write", arguments: { address: "@model/model.md", content: "per model" }, _meta: meta });
	assert.equal(modelNote.isError, undefined);
	assert.match(readFileSync(join(f.home, "models", "gpt-5-1-codex", "model.md"), "utf8"), /per model/);
	const switched = await call(client, { name: "notes_write", arguments: { address: "@model/other.md", content: "another brain" }, _meta: metaFor(ROOT, ROOT, "other/model-x") });
	assert.equal(switched.isError, undefined);
	assert.match(readFileSync(join(f.home, "models", "model-x", "other.md"), "utf8"), /another brain/);
	const read = await call(client, { name: "notes_read", arguments: { address: "state.md" }, _meta: meta });
	assert.equal(read.isError, undefined);
	assert.match(textOf(read), /hello native/);
	assert.equal((read.structuredContent as { text: string }).text, "hello native");
	const listed = await call(client, { name: "notes_list", arguments: { glob: "@model/**" }, _meta: meta });
	assert.match(textOf(listed), /@model\/model\.md/);
});

test("Codex resolves relative cwd against the verified binding, not the MCP process", async (t) => {
	const f = await fixture(t);
	await writeFile(f.transcript, jsonl([row("session_meta", sessionMeta())]));
	const base = join(f.home, "base"), other = join(f.home, "other");
	await mkdir(base);
	await mkdir(other);
	await bind(f.data, { threadId: ROOT, rootSessionId: ROOT, home: f.home, cwd: base, transcriptPath: f.transcript });
	const client = await connect(t, f.data, CLI, f.home);
	const meta = metaFor(ROOT, ROOT);
	const written = await call(client, { name: "notes_write", arguments: { address: "@project/selected", content: "from Codex", cwd: "../other" }, _meta: meta });
	assert.equal(written.isError, undefined, textOf(written));
	assert.equal((written.structuredContent as { project_key: string }).project_key, "other");
	assert.match(readFileSync(join(f.home, "project", "other", "selected.md"), "utf8"), /from Codex/);
	const read = await call(client, { name: "notes_read", arguments: { address: "@project/selected", cwd: "../other" }, _meta: meta });
	assert.equal(read.isError, undefined, textOf(read));
	assert.equal((read.structuredContent as { text: string }).text, "from Codex");
});

test("refusals precede reads and writes: unknown thread, stale root, bad model, bad params", async (t) => {
	const f = await fixture(t);
	await writeFile(f.transcript, jsonl([row("session_meta", sessionMeta())]));
	await bind(f.data, { threadId: ROOT, rootSessionId: ROOT, home: f.home, cwd: f.cwd, transcriptPath: f.transcript });
	const client = await connect(t, f.data, CLI, f.home);
	const unknown = await call(client, { name: "notes_write", arguments: { address: "nope.md", content: "x" }, _meta: metaFor("019a0000-0000-7000-8000-000000000099", "019a0000-0000-7000-8000-000000000099") });
	assert.equal(errorCode(unknown), "unknown_thread");
	assert.equal(existsSync(join(f.home, "pi", "session", "019a0000-0000-7000-8000-000000000099", "nope.md")), false);
	const stale = await call(client, { name: "notes_write", arguments: { address: "nope.md", content: "x" }, _meta: metaFor(ROOT, CHILD) });
	assert.equal(errorCode(stale), "stale_thread_binding");
	assert.equal(existsSync(join(f.home, "pi", "session", ROOT, "nope.md")), false);
	const noModel = await call(client, { name: "notes_list", arguments: {}, _meta: { threadId: ROOT, sessionId: ROOT, windowId: W0 } });
	assert.equal(errorCode(noModel), "missing_model");
	const badParams = await call(client, { name: "notes_read", arguments: { address: 5 }, _meta: metaFor(ROOT, ROOT) });
	assert.equal(errorCode(badParams), "invalid_params");
	assert.match(textOf(badParams), /address/);
});

test("notes refuse stale native windows before any read or write side effect", async (t) => {
	const f = await fixture(t);
	await writeFile(f.transcript, jsonl([row("session_meta", sessionMeta()), row("response_item", message("user", "before"))]));
	const env = { ...process.env, PLUGIN_DATA: f.data, NOTESOUP_HOME: f.home } as NodeJS.ProcessEnv;
	await runHook("SessionStart", startPayload(f), env);
	const client = await connect(t, f.data, CLI, f.home);
	const meta = metaFor(ROOT, ROOT, "gpt-5.1-codex", W0);
	const first = await call(client, { name: "notes_write", arguments: { address: "before.md", content: "kept" }, _meta: meta });
	assert.equal(first.isError, undefined);
	assert.ok(existsSync(join(f.home, "pi", "session", ROOT, "before.md")));
	const writeSchema = (await client.listTools()).tools.find((tool) => tool.name === "notes_write")!.outputSchema as unknown as TSchema;
	assert.equal(Check(writeSchema, first.structuredContent), true, "a success matches the declared output schema");

	// The native checkpoint advances the window while the hook binding and MCP
	// metadata still name W0. Every operation must read the transcript fact.
	appendFileSync(f.transcript, jsonl([row("compacted", compact(W1, W0, 1))]));
	const staleWrite = await call(client, { name: "notes_write", arguments: { address: "after.md", content: "must not land" }, _meta: meta });
	assert.equal(staleWrite.isError, true);
	assert.equal(errorCode(staleWrite), "stale_native_state");
	assert.equal(Check(writeSchema, staleWrite.structuredContent), true, "a refusal matches the same declared output schema");
	assert.equal(Check(writeSchema, { unexpected: true }), false, "an unrelated object is not a shared result");
	assert.equal(existsSync(join(f.home, "pi", "session", ROOT, "after.md")), false);

	const staleRead = await call(client, { name: "notes_read", arguments: { address: "before.md" }, _meta: meta });
	assert.equal(staleRead.isError, true);
	assert.equal(errorCode(staleRead), "stale_native_state");
	assert.doesNotMatch(textOf(staleRead), /kept/);
});

test("history tools serve root and child native ancestry, and refuse stale native facts", async (t) => {
	const f = await fixture(t);
	await writeFile(f.transcript, jsonl([
		row("session_meta", sessionMeta()),
		row("response_item", message("user", "root before")),
		row("compacted", compact(W1, W0, 1)),
		row("response_item", message("user", "root after")),
	]));
	await bind(f.data, { threadId: ROOT, rootSessionId: ROOT, home: f.home, cwd: f.cwd, transcriptPath: f.transcript, windowId: W1 });
	const client = await connect(t, f.data, CLI, f.home);
	const meta = metaFor(ROOT, ROOT, "gpt-5.1-codex", W1);
	const windows = await call(client, { name: "history_windows", arguments: {}, _meta: meta });
	assert.equal(windows.isError, undefined);
	assert.equal((windows.structuredContent as { session_id: string }).session_id, ROOT);
	assert.deepEqual((windows.structuredContent as { windows: Array<{ window_id: string }> }).windows.map((w) => w.window_id), [`codex:${ROOT}:${W0}`, `codex:${ROOT}:${W1}`]);
	const page = await call(client, { name: "history_list", arguments: {}, _meta: meta });
	assert.match(textOf(page), /root after/);
	const read = await call(client, { name: "history_read", arguments: { seq: 4 }, _meta: meta });
	assert.match(textOf(read), /root after/);

	const childPath = join(dirname(f.transcript), nativeName(CHILD));
	await writeFile(childPath, jsonl([
		row("session_meta", sessionMeta(CHILD, { parent_thread_id: ROOT, forked_from_id: ROOT })),
		row("response_item", message("user", "child task")),
	]));
	await bind(f.data, { threadId: CHILD, rootSessionId: ROOT, home: f.home, cwd: f.cwd, transcriptPath: childPath, agent: "worker", agentType: "worker" });
	const childWindows = await call(client, { name: "history_windows", arguments: {}, _meta: metaFor(CHILD, ROOT) });
	assert.equal((childWindows.structuredContent as { session_id: string }).session_id, CHILD);
	assert.match(textOf(childWindows), new RegExp(`codex:${CHILD}`));
	assert.doesNotMatch(textOf(childWindows), new RegExp(`codex:${ROOT}`));

	const other = join(dirname(f.transcript), nativeName("019a0000-0000-7000-8000-000000000077"));
	await writeFile(other, jsonl([row("session_meta", sessionMeta(CHILD, { session_id: "019a0000-0000-7000-8000-000000000088" })), row("response_item", message("user", "elsewhere"))]));
	await bind(f.data, { threadId: CHILD, rootSessionId: ROOT, home: f.home, cwd: f.cwd, transcriptPath: other });
	const stale = await call(client, { name: "history_list", arguments: {}, _meta: metaFor(CHILD, ROOT) });
	assert.equal(stale.isError, true);
});

/* ---------------------------------------------------------------- hooks */

function startPayload(f: Fixture, extra: Row = {}): string {
	return JSON.stringify({ session_id: ROOT, transcript_path: f.transcript, cwd: f.cwd, model: "gpt-5.4", hook_event_name: "SessionStart", source: "startup", permission_mode: "on-request", ...extra });
}

function bootOf(output: string): string {
	const parsed = JSON.parse(output) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }; systemMessage?: string };
	assert.equal(parsed.hookSpecificOutput?.hookEventName, "SessionStart");
	return parsed.hookSpecificOutput?.additionalContext ?? "";
}

test("a root boot carries the native window, native reset names, and is deduped by recorded evidence", async (t) => {
	const f = await fixture(t);
	await writeFile(f.transcript, jsonl([row("session_meta", sessionMeta()), row("response_item", message("user", "hello"))]));
	const env = { ...process.env, PLUGIN_DATA: f.data, NOTESOUP_HOME: f.home } as NodeJS.ProcessEnv;
	const first = await runHook("SessionStart", startPayload(f), env);
	const boot = bootOf(first);
	assert.match(boot, /YOUR NOTES/);
	assert.match(boot, new RegExp(`Agent name: anonymous \\(brain: gpt-5-4\\)`));
	assert.match(boot, new RegExp(`codex:${ROOT}`));
	assert.match(boot, new RegExp(`<notesoup:codex_window>\\nthread: ${ROOT}\\nwindow: ${W0}`));
	// The shared trunk:shortname rule renders the same address history tools serve.
	assert.match(boot, new RegExp(`${W0} {4}← you are here`));
	assert.match(boot, /native `new_context`/);
	assert.match(boot, /get_context_remaining/);
	assert.match(boot, /notes_\*/);
	assert.doesNotMatch(boot, /empty_brain/);
	assert.match(boot, /Child limitation/);
	const binding = JSON.parse(readFileSync(join(f.data, "bindings", `${ROOT}.json`), "utf8"));
	assert.equal(binding.rootSessionId, ROOT);
	assert.equal(binding.home, f.home);
	assert.equal(binding.transcriptPath, f.transcript);
	// The host persists SessionStart additionalContext as a developer item; that is the evidence.
	appendFileSync(f.transcript, jsonl([row("response_item", hookContext(boot))]));
	assert.equal(await runHook("SessionStart", startPayload(f, { source: "resume" }), env), "");
});

test("a native checkpoint starts a new window; the next session-start boot names it and stays deduped", async (t) => {
	const f = await fixture(t);
	await writeFile(f.transcript, jsonl([
		row("session_meta", sessionMeta()),
		row("response_item", message("user", "old")),
		row("compacted", compact(W1, W0, 1)),
	]));
	const env = { ...process.env, PLUGIN_DATA: f.data, NOTESOUP_HOME: f.home } as NodeJS.ProcessEnv;
	const output = await runHook("SessionStart", startPayload(f, { source: "compact" }), env);
	const boot = bootOf(output);
	assert.match(boot, new RegExp(`window: ${W1}`));
	assert.match(boot, new RegExp(`├─ ${W0}`));
	assert.match(boot, new RegExp(`└─ ${W1} {4}← you are here`));
	appendFileSync(f.transcript, jsonl([row("response_item", hookContext(boot))]));
	assert.equal(await runHook("SessionStart", startPayload(f, { source: "compact" }), env), "");
});

test("a fork gets its own boot instead of inheriting the parent's recorded identity", async (t) => {
	const f = await fixture(t);
	const forkPath = join(dirname(f.transcript), nativeName(FORK));
	const parentBoot = `<notesoup:codex_window>\nthread: ${ROOT}\nwindow: ${W0}\n</notesoup:codex_window>`;
	await writeFile(forkPath, jsonl([
		row("session_meta", sessionMeta(FORK, { forked_from_id: ROOT })),
		row("response_item", hookContext(`Agent name: parent\n\n${parentBoot}`)),
		row("response_item", message("user", "fork task")),
	]));
	await mkdir(join(f.home, "agents", "worker"), { recursive: true });
	await writeFile(join(f.home, "agents", "worker", "MAP.md"), "worker map\n");
	const env = { ...process.env, PLUGIN_DATA: f.data, NOTESOUP_HOME: f.home } as NodeJS.ProcessEnv;
	const output = await runHook("SubagentStart", JSON.stringify({
		session_id: ROOT, agent_id: FORK, agent_type: "worker", transcript_path: forkPath, cwd: f.cwd,
		model: "gpt-5.4", hook_event_name: "SubagentStart", permission_mode: "on-request",
	}), env);
	const parsed = JSON.parse(output) as { hookSpecificOutput?: { additionalContext: string } };
	const boot = parsed.hookSpecificOutput?.additionalContext ?? "";
	assert.match(boot, new RegExp(`thread: ${FORK}`));
	assert.match(boot, new RegExp(`Agent name: worker \\(brain: gpt-5-4\\)`));
	assert.match(boot, /@self — worker only/);
	assert.equal(JSON.parse(readFileSync(join(f.data, "bindings", `${FORK}.json`), "utf8")).rootSessionId, ROOT);
});

test("child PreCompact stops before native history is cut; root PreCompact is transparent", async (t) => {
	const f = await fixture(t);
	const env = { ...process.env, PLUGIN_DATA: f.data, NOTESOUP_HOME: f.home } as NodeJS.ProcessEnv;
	const child = JSON.parse(await runHook("PreCompact", JSON.stringify({
		session_id: ROOT, turn_id: "turn-1", agent_id: CHILD, agent_type: "worker", transcript_path: null,
		cwd: f.cwd, hook_event_name: "PreCompact", model: "gpt-5.4", trigger: "auto",
	}), env));
	assert.equal(child.continue, false);
	assert.match(child.stopReason, /child post-compact boot/);
	assert.match(child.stopReason, /Save a handoff note/);
	assert.equal(await runHook("PreCompact", JSON.stringify({
		session_id: ROOT, turn_id: "turn-1", transcript_path: null, cwd: f.cwd,
		hook_event_name: "PreCompact", model: "gpt-5.4", trigger: "manual",
	}), env), "");
});

test("missing native facts or plugin data produce an actionable warning, never a fabricated boot", async (t) => {
	const f = await fixture(t);
	const env = { ...process.env, PLUGIN_DATA: f.data, NOTESOUP_HOME: f.home } as NodeJS.ProcessEnv;
	const warning = JSON.parse(await runHook("SessionStart", startPayload(f), env)) as { systemMessage?: string };
	assert.match(warning.systemMessage ?? "", /no boot injected/);
	assert.match(warning.systemMessage ?? "", /0\.160\.1/);
	const noData = JSON.parse(await runHook("SessionStart", startPayload(f), { ...process.env, NOTESOUP_HOME: f.home })) as { systemMessage?: string };
	assert.match(noData.systemMessage ?? "", /PLUGIN_DATA/);
	await writeFile(f.transcript, "not json\n");
	const broken = JSON.parse(await runHook("SessionStart", startPayload(f), env)) as { systemMessage?: string };
	assert.match(broken.systemMessage ?? "", /no boot injected/);
});
