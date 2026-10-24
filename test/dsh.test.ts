import assert from "node:assert/strict";
import test from "node:test";
import { createUserMessage, HarnessError, ToolCallId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId, SessionSeq, pluginRecordOf, type SessionEvent } from "@deepseek-ai/dsh-session";
import { allItems, contentText } from "../src/history/history.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectHome } from "../src/notes/project-home.js";
import { renderBootBlock } from "../src/boot/render.js";
import { loadNotesSnapshot } from "../src/boot/snapshot.js";
import { NOTES_PROTOCOL_CLOSE_TAG, WINDOW_IDENTITY_CLOSE_TAG, WINDOW_IDENTITY_OPEN_TAG } from "../src/boot/text.js";
import { notesRead } from "../src/tools/notes.js";
import { success } from "../src/tools/result.js";
import { createNotesStore } from "../src/notes/index.js";
import { dshFixture } from "./helpers/dsh.js";
import { decodeHistory } from "../plugins/dsh/history.js";
import { checkpointSnapshot, notesIdentity, recoverSnapshot, WINDOW_RECORD } from "../plugins/dsh/window.js";
import { measureBudget } from "../plugins/dsh/budget.js";
import { COUNTDOWN_LINE, FORCED_CONTINUATIONS, NORMAL_CONTINUATIONS } from "../src/budget/text.js";
import { preflight } from "../plugins/dsh/engine.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";

function prompt(text: string) { return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }); }
async function run(agent: Agent, text: string): Promise<void> { agent.followup(prompt(text)); await agent.whenIdle(); }
function system(request: { system?: string | { text: string }[] }): string { return typeof request.system === "string" ? request.system : request.system?.map((block) => block.text).join("\n") ?? ""; }
function code(expected: string) { return (error: unknown) => (error as { code?: string })?.code === expected; }

// Critical lifecycle tests exercise the actual loop, DeepSeek HTTP adapter, tool registry,
// token meter and SQLite query service. Only the provider is a scripted Messages server.
test("dsh boot freezes across note writes, rotates before the next wire request, and keeps raw history", async (t) => {
	const { ctx, engine, create, mock } = await dshFixture(t);
	const agent = await create();
	mock.script.push({ tool: "notes_write", input: { address: "handoff", content: "recover me {{literal}}" } }, { tool: "empty_brain", input: {} }, { text: "resumed" });
	await run(agent, "old secret conversation");
	assert.equal(mock.requests.length, 3);
	assert.equal(system(mock.requests[0]!), system(mock.requests[1]!));
	assert.notEqual(system(mock.requests[1]!), system(mock.requests[2]!));
	assert.equal(system(mock.requests[0]!).includes("recover me"), false);
	assert.equal(system(mock.requests[2]!).includes("recover me {{literal}}"), true);
	assert.equal(JSON.stringify(mock.requests[2]!.messages).includes("old secret conversation"), false);
	assert.equal(mock.requests[2]!.messages.length, 1);
	assert.equal(engine.windows.get(agent.session).snapshot.window, 1);
	const events = agent.session.snapshotEvents();
	assert.equal(events.filter((event) => event.type === "compaction/start").length, 1);
	const summary = events.find((event) => event.type === "compaction/summary")!;
	assert.equal(summary.type, "compaction/summary");
	if (summary.type === "compaction/summary") {
		assert.equal(summary.data.provider, "notesoup");
		assert.equal(summary.data.llmStreamCall, undefined);
		assert.equal(summary.data.shadowedSeqs.length, 5);
	}
	const markers = events.map(pluginRecordOf).filter((record) => record?.type === WINDOW_RECORD);
	assert.equal(markers.length, 2);
	const history = await ctx.sessionQuery.readSession(agent.session.id);
	const projection = decodeHistory(agent.session.id, history.events);
	assert.equal(projection.windows.length, 2);
	assert.ok(allItems(projection).some((event) => event.text === "old secret conversation"));
	assert.equal(allItems(projection).filter((event) => event.execution).length, 2);
	assert.ok(mock.requests[0]!.tools?.some((tool) => tool.name === "history_list"));
	assert.equal(mock.requests[0]!.tools?.some((tool) => tool.name === "dream"), false);
});

test("dsh same-session reload adopts persisted bytes before first assembly; missing records reconstruct from checkpoints and root system", async (t) => {
	const { engine, create, reload, mock } = await dshFixture(t);
	const agent = await create();
	mock.script.push({ tool: "empty_brain", input: {} }, { text: "after" });
	await run(agent, "before");
	const snapshot = engine.windows.get(agent.session).snapshot;
	await createNotesStore(notesIdentity(agent, engine.config)).write("@self/later", "not in the frozen boot");
	const seed = agent.session.snapshotEvents();
	const resumed = await reload(agent, seed);
	await run(resumed, "continue");
	assert.equal(engine.windows.get(resumed.session).snapshot.boot, snapshot.boot);
	assert.equal(system(mock.requests[2]!), system(mock.requests[1]!));
	const missing = withoutRecords(seed);
	const reconstructed = await reload(resumed, missing);
	await run(reconstructed, "continue again");
	assert.equal(engine.windows.get(reconstructed.session).snapshot.window, 1);
	assert.equal(engine.windows.get(reconstructed.session).snapshot.boot, snapshot.boot);
	assert.equal(system(mock.requests[3]!), system(mock.requests[1]!));
	const root = await create();
	await run(root, "root stays");
	const rootBoot = engine.windows.get(root.session).snapshot.boot;
	await createNotesStore(notesIdentity(root, engine.config)).write("@self/later", "changed again");
	const rootReloaded = await reload(root, withoutRecords(root.session.snapshotEvents()));
	await run(rootReloaded, "resume root");
	assert.equal(engine.windows.get(rootReloaded.session).snapshot.boot, rootBoot);
	assert.equal(engine.windows.get(rootReloaded.session).snapshot.window, 0);
});

test("dsh native fork rebinds boot and notes tools to the child without changing inherited history", async (t) => {
	const { ctx, engine, create, fork, mock } = await dshFixture(t);
	const parent = await create();
	const parentNotes = createNotesStore(notesIdentity(parent, engine.config));
	await parentNotes.write("MAP.md", "- parent-handoff.md — parent's session note");
	await parentNotes.write("parent-handoff.md", "parent-only recovery");
	mock.script.push({ tool: "empty_brain", input: {} }, { text: "after" });
	await run(parent, "inherited conversation before reset");
	const parentSnapshot = engine.windows.get(parent.session).snapshot;
	assert.equal(parentSnapshot.window, 1);
	assert.ok(parentSnapshot.boot.includes("parent-handoff.md"));
	const parentEvents = structuredClone(parent.session.snapshotEvents());

	const childId = "session-native-child";
	const childNotes = createNotesStore({ ...notesIdentity(parent, engine.config), sessionId: childId });
	await childNotes.write("MAP.md", "- child-handoff.md — child's session note");
	await childNotes.write("child-handoff.md", "child-only recovery");
	const child = await fork(parent, childId);
	assert.equal(child.session.header.parentSession, parent.session.id);
	assert.equal(child.session.inheritedEventCount, parentEvents.length);
	const snapshot = engine.windows.get(child.session).snapshot;
	assert.equal(snapshot.window, parentSnapshot.window);
	assert.equal(snapshot.windowId, `dsh:${childId}:1`);
	assert.ok(snapshot.boot.includes(`\ndsh:${childId}\n`));
	assert.ok(snapshot.boot.includes("- child-handoff.md — child's session note"));
	assert.equal(snapshot.boot.includes("parent-handoff.md"), false);
	assert.equal(recoverSnapshot(child.session.ownEvents())?.windowId, snapshot.windowId, "the rebound snapshot is persisted in the child");
	assert.deepEqual(child.session.snapshotEvents().slice(0, parentEvents.length), parentEvents);

	const read = await ctx.tools.execute({ name: "notes_read", arguments: { address: "child-handoff.md" }, agent: child, callId: ToolCallId("fork-note"), signal: new AbortController().signal });
	assert.equal(read.isError, false);
	if (!read.isError) assert.equal((read.value as { text: string }).text, "child-only recovery");
	const history = await ctx.tools.execute({ name: "history_list", arguments: { query: "inherited conversation before reset", roles: ["user"] }, agent: child, callId: ToolCallId("fork-history"), signal: new AbortController().signal });
	assert.equal(history.isError, false);
	if (!history.isError) assert.equal((history.value as { items: unknown[] }).items.length, 1);
	await run(child, "continue in child");
	assert.ok(system(mock.requests.at(-1)!).includes(snapshot.boot));
	assert.equal(engine.windows.get(parent.session).snapshot, parentSnapshot);
	assert.deepEqual(parent.session.snapshotEvents(), parentEvents);
});

test("dsh same-session reload keeps frozen bytes and ordinal from a boot written before the tag rename", async (t) => {
	const { engine, create, reload, mock } = await dshFixture(t);
	const agent = await create();
	mock.script.push({ tool: "empty_brain", input: {} }, { text: "after" });
	await run(agent, "before");
	const snapshot = engine.windows.get(agent.session).snapshot;
	assert.ok(snapshot.boot.includes(WINDOW_IDENTITY_OPEN_TAG), "the current boot carries the renamed tag");
	const legacy = withLegacyIdentityTags(withoutRecords(agent.session.snapshotEvents()));
	assert.ok(JSON.stringify(legacy).includes("<context_window>\\nAgent name: dsh"), "the seed reproduces an old-spelling boot");
	await createNotesStore(notesIdentity(agent, engine.config)).write("@self/later", "not in the legacy frozen boot");
	const resumed = await reload(agent, legacy);
	await run(resumed, "continue");
	assert.equal(engine.windows.get(resumed.session).snapshot.boot, snapshot.boot.replaceAll(WINDOW_IDENTITY_OPEN_TAG, "<context_window>").replaceAll(WINDOW_IDENTITY_CLOSE_TAG, "</context_window>"));
	assert.equal(engine.windows.get(resumed.session).snapshot.window, 1, "an old-tag boot still yields its window ordinal");
	assert.equal(engine.windows.get(resumed.session).snapshot.windowId, snapshot.windowId, "and its window id");
});

/**
 * The same seed with the pre-rename identity spelling: boots already on disk carry `context_window`,
 * so a reader that only knows the new tag would silently lose their window numbering.
 */
function withLegacyIdentityTags(events: readonly SessionEvent[]): SessionEvent[] {
	const legacy = (text: string) => text
		.replaceAll(WINDOW_IDENTITY_OPEN_TAG, "<context_window>")
		.replaceAll(WINDOW_IDENTITY_CLOSE_TAG, "</context_window>");
	return events.map((event) => {
		const copy = structuredClone(event) as SessionEvent;
		const message = copy.type === "system/message" ? copy.data.message : copy.type === "user/message" ? copy.data : undefined;
		if (!message) return copy;
		const data = message as { content?: unknown };
		if (typeof data.content === "string") data.content = legacy(data.content);
		else if (Array.isArray(data.content)) for (const block of data.content as Array<{ text?: unknown }>) {
			if (typeof block.text === "string") block.text = legacy(block.text);
		}
		return copy;
	});
}

/** Removal models migration loss: native references and contiguous seqs are remapped. */
function withoutRecords(events: readonly SessionEvent[]): SessionEvent[] {
	const keep = events.filter((event) => !pluginRecordOf(event));
	const seqs = new Map(keep.map((event, index) => [event.seq as number, index]));
	return keep.map((event) => {
		const copy = structuredClone(event) as SessionEvent;
		copy.seq = SessionSeq(seqs.get(event.seq)!);
		if (copy.sourceEventSeqs) copy.sourceEventSeqs = copy.sourceEventSeqs.map((seq) => SessionSeq(seqs.get(seq)!));
		if (copy.surfaceOp && copy.surfaceOp !== "append") copy.surfaceOp = { ...copy.surfaceOp, startSeq: SessionSeq(seqs.get(copy.surfaceOp.startSeq)!), endSeq: SessionSeq(seqs.get(copy.surfaceOp.endSeq)!) };
		if (copy.type === "compaction/summary") {
			copy.data.shadowedSeqs = copy.data.shadowedSeqs.map((seq) => SessionSeq(seqs.get(seq)!));
			copy.data.shadowedRange = { start: SessionSeq(seqs.get(copy.data.shadowedRange.start)!), end: SessionSeq(seqs.get(copy.data.shadowedRange.end)!) };
		}
		return copy;
	});
}

test("dsh transaction keeps node zero, resets tiny spans, refuses partial spans, and rolls back a failed checkpoint", async (t) => {
	const { engine, create, mock } = await dshFixture(t);
	const agent = await create();
	await run(agent, "one");
	const session = agent.session;
	const head = session.surface.nodes[0]!;
	const previous = engine.windows.get(session).snapshot;
	session.append("turn/start", { turn: 2 });
	const nodes = [...session.surface.nodes];
	await assert.rejects(engine.compactRegion(nodes[0]!, nodes.at(-1)!, agent), code("changed"));
	assert.equal(engine.windows.get(session).snapshot, previous);
	const append = session.append.bind(session);
	let observedWindow: number | undefined;
	t.mock.method(session, "append", (...args: unknown[]) => {
		if (args[0] === "user/message") {
			observedWindow = engine.windows.get(session).snapshot.window;
			throw new HarnessError("injected", "CHECKPOINT_FAIL");
		}
		return (append as (...args: unknown[]) => unknown)(...args);
	});
	await assert.rejects(engine.compactRegion(nodes[1]!, nodes.at(-1)!, agent), code("CHECKPOINT_FAIL"));
	assert.equal(observedWindow, 1);
	assert.equal(engine.windows.get(session).snapshot, previous);
	assert.deepEqual(session.surface.nodes, nodes);
	assert.equal(session.snapshotEvents().at(-1)!.type, "compaction/end");
	t.mock.restoreAll();
	const result = await engine.compactRegion(nodes[1]!, nodes.at(-1)!, agent);
	assert.equal(result.shadowedSeqs.length, 2);
	assert.equal(session.surface.nodes.length, 2);
	assert.equal(session.surface.nodes[0], head);
	assert.equal(engine.windows.get(session).snapshot.window, 1);
	assert.equal(mock.requests.length, 1);
	const checkpoint = session.eventAt(session.surface.nodes[1]!)!;
	assert.equal(checkpointSnapshot(checkpoint)?.window, 1);
	const tiny = await engine.compactRegion(session.surface.nodes[1]!, session.surface.nodes[1]!, agent);
	assert.equal(tiny.shadowedSeqs.length, 1);
	assert.equal(engine.windows.get(session).snapshot.window, 2);
	session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
});

test("dsh cancellation preserves the notebook; a close failure leaves a durable lock and landed boot recoverable", async (t) => {
	const { engine, create } = await dshFixture(t);
	const agent = await create();
	await run(agent, "one");
	const session = agent.session;
	session.append("turn/start", { turn: 2 });
	const snapshot = engine.windows.get(session).snapshot;
	const cancelled = AbortSignal.abort(new HarnessError("cancel", "CANCELLED"));
	await assert.rejects(engine.compactRegion(session.surface.nodes[1]!, session.surface.nodes.at(-1)!, agent, cancelled), code("CANCELLED"));
	assert.equal(engine.windows.get(session).snapshot, snapshot);
	const append = session.append.bind(session);
	let closeAttempts = 0;
	t.mock.method(session, "append", (...args: unknown[]) => {
		if (args[0] === "compaction/end") { closeAttempts++; throw new Error("close failed"); }
		return (append as (...args: unknown[]) => unknown)(...args);
	});
	await assert.rejects(engine.compactRegion(session.surface.nodes[1]!, session.surface.nodes.at(-1)!, agent), code("commit"));
	assert.equal(closeAttempts, 1);
	assert.equal(engine.windows.get(session).snapshot.window, 1);
	assert.equal(recoverSnapshot(session.snapshotEvents())?.window, 1);
	t.mock.restoreAll();
	await assert.rejects(engine.compactRegion(session.surface.nodes[1]!, session.surface.nodes.at(-1)!, agent), code("busy"));
	session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
});

test("dsh preflight rejects a native engine, enabled competing row and missing automatic listener", async (t) => {
	const { ctx, engine, engineFiber } = await dshFixture(t);
	assert.doesNotThrow(() => preflight(ctx));
	const child = ctx.isolate("compaction");
	const basic = await child.plugin(BasicCompactionEngine, {});
	t.after(() => basic.dispose());
	assert.throws(() => preflight(child), code("ENGINE"));
	assert.throws(() => preflight(ctx), code("DOUBLE_ENGINE"));
	await basic.dispose();
	const get = ctx.get.bind(ctx);
	const probe = { get: (name: string) => name === "loader" ? { entries: () => [{ options: { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" }, disabled: false }] } : get(name), registry: ctx.registry } as unknown as typeof ctx;
	assert.throws(() => preflight(probe), code("DOUBLE_ENGINE"));
	// Unloading removes listener effects; checking through the engine's context exposes absence.
	await engineFiber.dispose();
	assert.equal(engine.automaticListenerPresent, false);
	const absentListener = { get: (name: string) => name === "compaction" ? engine : get(name), registry: ctx.registry } as unknown as typeof ctx;
	assert.throws(() => preflight(absentListener), code("AUTO_LISTENER"));
});

test("dsh budget follows configured host reserve, close-out tool runs across steps, and hard reserve resets on normal stop", async (t) => {
	const { ctx, engine, create, mock } = await dshFixture(t, { thresholdRatio: 0.7, headroomTokens: 32768 });
	const agent = await create();
	await run(agent, "measure");
	const budget = await measureBudget(ctx, agent, engine.config);
	assert.equal(budget?.resetAt, 140000);
	assert.equal(budget?.reserve, 60000);
	assert.equal(budget?.warning, 76384);
	assert.equal(budget?.reminder, 84576);
	assert.equal(budget?.countdown, Math.max(0, 140000 - budget!.used));
	mock.script.push({ tool: "notes_write", input: { address: "handoff", content: "checkpoint", }, inputTokens: 125000 }, { tool: "empty_brain", input: {} }, { text: "fresh" });
	await run(agent, "continue");
	assert.equal(engine.windows.get(agent.session).snapshot.window, 1);
	assert.equal(agent.session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "notesoup-budget" && event.data.source.phase === "warning").length, 1);
	const dshWarning = agent.session.snapshotEvents().find((event) => event.type === "user/message" && event.data.source.kind === "notesoup-budget" && event.data.source.phase === "warning");
	assert.ok(dshWarning && dshWarning.type === "user/message");
	assert.ok(contentText(dshWarning.data.content).endsWith(COUNTDOWN_LINE), "the dsh notice ends with the shared countdown line");
	mock.script.push({ text: "hard", inputTokens: 145000 }, { text: "recovered" });
	await run(agent, "hard reserve");
	assert.equal(engine.windows.get(agent.session).snapshot.window, 2);
	assert.equal(mock.requests.length, 6);
});

test("dsh draws one reset paragraph for its origin and reuses it for the steered copy", async (t) => {
	const random = Math.random;
	Math.random = () => 0;
	try {
		const { engine, create, mock } = await dshFixture(t, { thresholdRatio: 0.7, headroomTokens: 32768 });
		const agent = await create();
		// The model's own empty_brain call opens the normal handoff.
		mock.script.push({ tool: "empty_brain", input: {} }, { text: "fresh" });
		await run(agent, "model asked");
		const modelCheckpoint = agent.session.eventAt(agent.session.surface.nodes[1]!)!;
		if (modelCheckpoint.type !== "user/message") assert.fail("a reset must write a checkpoint message");
		const modelText = contentText(modelCheckpoint.data.content);
		assert.ok(modelText.endsWith(`${NORMAL_CONTINUATIONS[0]}\n</notesoup-continuation>`), "the model's call draws the normal pool");
		assert.equal(FORCED_CONTINUATIONS.some((line) => modelText.includes(line)), false);

		// A budget cutoff happens without a call, and its one draw serves both representations.
		mock.script.push({ text: "hard", inputTokens: 145000 }, { text: "recovered" });
		await run(agent, "nobody asked");
		assert.equal(engine.windows.get(agent.session).snapshot.window, 2);
		const checkpoints = agent.session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "compact-checkpoint");
		assert.equal(checkpoints.length, 2);
		const budgetCheckpoint = checkpoints[1]!;
		if (budgetCheckpoint.type !== "user/message") assert.fail("the budget reset must write a checkpoint message");
		const budgetText = contentText(budgetCheckpoint.data.content);
		assert.ok(budgetText.endsWith(`${FORCED_CONTINUATIONS[0]}\n</notesoup-continuation>`), "a budget cutoff draws the forced pool");
		assert.equal(NORMAL_CONTINUATIONS.some((line) => budgetText.includes(line)), false);
		const steered = agent.session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "notesoup-continuation").at(-1);
		assert.ok(steered && steered.type === "user/message", "the budget reset steers its continuation");
		assert.equal(contentText(steered.data.content), FORCED_CONTINUATIONS[0], "the steered copy is the same artifact, never a second draw");
	} finally {
		Math.random = random;
	}
});

test("dsh explicit resets survive auto:false; shared tool reads and expected errors keep their codes", async (t) => {
	const { ctx, engine, create, mock } = await dshFixture(t, { auto: false });
	const agent = await create();
	mock.script.push({ tool: "empty_brain", input: {} }, { text: "fresh" });
	await run(agent, "keep raw history");
	assert.equal(engine.windows.get(agent.session).snapshot.window, 1);
	assert.equal(engine.automaticListenerPresent, true);
	const call = (name: string, args: unknown) => ctx.tools.execute({ name, arguments: args, agent, callId: ToolCallId(`test-${name}`), signal: new AbortController().signal });
	const list = await call("history_list", { query: "keep raw", roles: ["user"] });
	assert.equal(list.isError, false);
	if (!list.isError) {
		const data = list.value as { items: { seq: number }[] };
		assert.equal(data.items.length, 1);
		const read = await call("history_read", { seq: data.items[0]!.seq, offset_chars: 5, max_chars: 3 });
		assert.equal(read.isError, false);
		if (!read.isError) assert.equal((read.value as { text: string }).text, "raw");
	}
	const missing = await call("history_list", { window_id: "missing" });
	assert.equal(missing.isError, true);
	if (missing.isError) assert.equal(missing.error.info?.code, "unknown_window_id");
	const invalid = await call("notes_read", { address: "anything", max_chars: 0 });
	assert.equal(invalid.isError, true);
	if (invalid.isError) assert.equal(invalid.error.info?.code, "INVALID_PARAMS");
	const written = await call("notes_write", { address: "@project/decision", content: "the decision" });
	assert.equal(written.isError, false);
	const note = await call("notes_read", { address: "@project/decision", offset_chars: 4, max_chars: 8 });
	assert.equal(note.isError, false);
	if (!note.isError) assert.equal((note.value as { text: string }).text, "decision");
	const identity = notesIdentity(agent, engine.config);
	assert.equal(identity.projectKey, resolveProjectHome(agent.session.header.cwd!, identity.home).name);
	const marker = JSON.parse(await readFile(join(identity.home, "project", identity.projectKey, ".project"), "utf8"));
	assert.equal(typeof marker.id, "string");
	const foreignRoot = await mkdtemp(join(tmpdir(), "ns-dsh-foreign-"));
	t.after(() => rm(foreignRoot, { recursive: true, force: true }));
	const foreign = resolveProjectHome(foreignRoot, identity.home);
	await createNotesStore({ ...identity, projectKey: foreign.name }).write("@project/reference", "foreign paper");
	const foreignFile = join(foreign.dir, "reference.md");
	const before = await readFile(foreignFile, "utf8");
	const address = `@projects/${foreign.name}/reference`;
	const foreignRead = await call("notes_read", { address });
	assert.equal(foreignRead.isError, false);
	if (!foreignRead.isError) {
		assert.equal((foreignRead.value as { project_root: string }).project_root, foreign.path);
		const shared = await notesRead.execute({ address }, identity);
		assert.ok(shared.ok);
		assert.deepEqual(foreignRead.value, shared.data);
		assert.equal(foreignRead.content[0]?.type, "text");
		assert.equal((foreignRead.content[0] as { text: string }).text, notesRead.render(success(shared.data)));
	}
	assert.equal(await readFile(foreignFile, "utf8"), before);
	const refused = await call("notes_write", { address, content: "no overwrite" });
	assert.equal(refused.isError, true);
	if (refused.isError) assert.equal(refused.error.info?.code, "invalid_scope");
	const snapshot = engine.windows.get(agent.session).snapshot;
	const sharedBoot = renderBootBlock({ agentName: identity.agent, modelName: identity.model, tree: { trunk: `dsh:${agent.session.id}`, windows: [{ shortName: "0", isCurrent: false }, { shortName: "1", isCurrent: true }] }, notes: await loadNotesSnapshot(identity, snapshot.openedAt), tools: { notes: "notes_*", notesList: "notes_list", history: "history_*", remaining: "get_context_remaining", wipe: "empty_brain" } });
	// The shared protocol, including the pinned-page instructions, is used verbatim inside host framing.
	assert.ok(snapshot.boot.includes(sharedBoot.split("YOUR NOTES")[0]!));
	const blocked = ctx.on("tools/post-execute", async (exec, _result, next) => exec.name === "empty_brain" ? { kind: "block", feedback: [{ type: "text", text: "blocked" }] } : next());
	mock.script.push({ tool: "empty_brain", input: {} }, { text: "request refused" });
	await run(agent, "refused clear");
	assert.equal(engine.windows.get(agent.session).snapshot.window, 1);
	blocked();
	assert.equal(agent.session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "notesoup-budget").length, 0);
});

test("dsh idle reset flushes; an async changed surface and persistence failure do not claim rollback after landing", async (t) => {
	const { ctx, engine, create } = await dshFixture(t);
	const agent = await create();
	await run(agent, "original");
	const previous = engine.windows.get(agent.session).snapshot;
	const mint = engine.windows.mint.bind(engine.windows);
	t.mock.method(engine.windows, "mint", async (...args: Parameters<typeof mint>) => {
		const snapshot = await mint(...args);
		agent.session.append("user/message", prompt("racing input"), { surfaceOp: "append" });
		return snapshot;
	});
	await assert.rejects(engine.compactNow(agent, new AbortController().signal), code("changed"));
	assert.equal(engine.windows.get(agent.session).snapshot, previous);
	assert.equal(agent.session.surface.nodes.length, 4);
	t.mock.restoreAll();
	let flushes = 0;
	const stop = ctx.on("session/flush", () => { flushes++; throw new Error("disk failure"); });
	await assert.rejects(engine.compactNow(agent, new AbortController().signal), code("persistence"));
	assert.equal(flushes, 1);
	assert.equal(engine.windows.get(agent.session).snapshot.window, 1);
	assert.equal(agent.session.surface.nodes.length, 2);
	stop();
	const result = await engine.compactNow(agent, new AbortController().signal);
	assert.equal(result?.shadowedSeqs.length, 1);
	assert.equal(engine.windows.get(agent.session).snapshot.window, 2);
});

test("dsh abort during mint leaves the previous boot and balanced lock; budget refuses impossible reserves", async (t) => {
	const { ctx, engine, create } = await dshFixture(t);
	const agent = await create();
	await run(agent, "original");
	const previous = engine.windows.get(agent.session).snapshot;
	const mint = engine.windows.mint.bind(engine.windows);
	const cancel = new AbortController();
	t.mock.method(engine.windows, "mint", async (...args: Parameters<typeof mint>) => {
		const snapshot = await mint(...args);
		cancel.abort(new HarnessError("cancel", "CANCELLED"));
		return snapshot;
	});
	await assert.rejects(engine.compactNow(agent, cancel.signal), code("CANCELLED"));
	assert.equal(engine.windows.get(agent.session).snapshot, previous);
	assert.equal(agent.session.surface.nodes.length, 3);
	assert.equal(agent.session.snapshotEvents().at(-1)?.type, "compaction/end");
	t.mock.restoreAll();
	await assert.rejects(measureBudget(ctx, agent, { ...engine.config, headroomTokens: 200000 }), code("BUDGET_CONFIG"));
	const unknown = { session: agent.session, options: {} };
	const empty = Session.create(SessionId("session-unknown"));
	assert.equal(await measureBudget(ctx, { ...unknown, session: empty }, engine.config), null);
});
