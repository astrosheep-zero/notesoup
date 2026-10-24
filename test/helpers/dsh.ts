import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Agents, { type Agent, type CreateAgentOptions } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Llm from "@deepseek-ai/dsh-llm";
import * as DeepSeek from "@deepseek-ai/dsh-llm-deepseek-api-key";
import Sessions, { buildForkSeed, SessionId, SessionLogOffset, type SessionEvent } from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Meter from "@deepseek-ai/dsh-token-meter";
import Query from "@deepseek-ai/dsh-session-query-sqlite";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import NotesoupEngine, { type EngineConfig } from "../../plugins/dsh/engine.js";
import notesoup from "../../plugins/dsh/index.js";
import { messagesServer } from "./dsh-messages.js";

export async function dshFixture(t: TestContext, config: EngineConfig = {}) {
	const directory = await mkdtemp(join(tmpdir(), "ns-dsh-test-"));
	const mock = await messagesServer();
	const ctx = new Context();
	const fibers: { dispose(): Promise<void> }[] = [];
	t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await mock.close(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
	ctx.provide("launchEnvironment", createLaunchEnvironmentSnapshot([{ source: "process", values: { DEEPSEEK_API_KEY: "mock-key" } }]));
	fibers.push(await ctx.plugin(Sessions));
	fibers.push(await ctx.plugin(Projections));
	fibers.push(await ctx.plugin(Agents));
	fibers.push(await ctx.plugin(Llm));
	fibers.push(await ctx.plugin(SystemPrompt, { includeRuntimeContext: false }));
	fibers.push(await ctx.plugin(Tools, {}));
	fibers.push(await ctx.plugin(Meter, {}));
	fibers.push(await ctx.plugin(Query, { path: ":memory:" }));
	fibers.push(await ctx.plugin(DeepSeek, { baseURL: mock.url, models: [{ id: "mock-flash", name: "Mock", contextWindow: 200000, maxTokens: 8192 }] } as never));
	const engineFiber = await ctx.plugin(NotesoupEngine, { notesHome: join(directory, "notes"), ...config });
	fibers.push(engineFiber);
	assert.ok(ctx.compaction instanceof NotesoupEngine);
	const engine = ctx.compaction;
	fibers.push(await ctx.plugin(notesoup));
	fibers.push(await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 }));
	let count = 0;
	const handles = new Map<Agent, { dispose(): Promise<void> }>();
	const make = async (options: CreateAgentOptions) => {
		const handle = await ctx.agents.create({ agentOptions: { provider: "deepseek-official", model: "mock-flash" }, ...options });
		fibers.push(handle);
		handles.set(handle.agent, handle);
		return handle.agent;
	};
	const create = (seed?: readonly SessionEvent[], id = `session-test-${++count}`) => make({ sessionId: SessionId(id), meta: { cwd: directory }, ...(seed ? { seed } : {}) });
	const reload = async (agent: Agent, seed = agent.session.snapshotEvents()) => {
		await handles.get(agent)!.dispose();
		return create(seed, agent.session.id);
	};
	const fork = (agent: Agent, id = `session-test-${++count}`) => {
		const events = agent.session.snapshotEvents();
		return make({
			sessionId: SessionId(id),
			meta: { cwd: directory, parentSession: agent.session.id, isSeeded: true },
			seed: buildForkSeed(events, events.at(-1)!.seq),
			inheritedEventCount: SessionLogOffset(events.length),
		});
	};
	return { ctx, engine, engineFiber, directory, mock, create, reload, fork };
}
