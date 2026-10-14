import assert from "node:assert/strict";
import test from "node:test";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import type { CompactionResult } from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { pluginRecordOf, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import { dshFixture } from "./helpers/dsh.js";
import { WINDOW_RECORD } from "../plugins/dsh/window.js";

/** Pin the shared host contract while naming our intentional template-vs-LLM differences. */
function transactionShape(session: Session, from: number, head: number, result?: CompactionResult) {
	const events = session.snapshotEvents().slice(from);
	const records = events.filter((event) => event.type.startsWith("compaction/") || event.type === "user/message");
	for (const event of records) assert.deepEqual(Object.keys(event).sort(), event.type === "user/message" ? ["data", "seq", "sourceEventSeqs", "surfaceOp", "time", "type"] : ["data", "seq", "time", "type"]);
	const start = records[0]!;
	const summary = records[1]!;
	const end = records.at(-1)!;
	assert.equal(start.type, "compaction/start");
	assert.equal(summary.type, "compaction/summary");
	assert.equal(end.type, "compaction/end");
	if (start.type !== "compaction/start" || summary.type !== "compaction/summary" || end.type !== "compaction/end") assert.fail("compaction protocol changed");
	assert.deepEqual(Object.keys(start.data).sort(), ["compactionId", "turn"]);
	assert.deepEqual(Object.keys(end.data).sort(), result ? ["compactionId", "turn"] : ["compactionId", "error", "turn"]);
	assert.equal(summary.data.compactionId, start.data.compactionId);
	assert.equal(end.data.compactionId, start.data.compactionId);
	assert.equal(end.data.turn, start.data.turn);
	assert.equal(typeof start.data.compactionId, "string");
	assert.equal(typeof summary.data.shadowedTokenCount, "number");
	const fields = Object.keys(summary.data).sort();
	const common = ["compactionId", "model", "provider", "shadowedRange", "shadowedSeqs", "shadowedTokenCount", "summary"].sort();
	if (summary.data.provider === "notesoup") {
		assert.deepEqual(fields, common);
		const window = events.map(pluginRecordOf).find((record) => record?.type === WINDOW_RECORD);
		if (result) {
			assert.ok(window);
			assert.deepEqual(Object.keys(window.data as object).sort(), ["boot", "notesDigest", "openedAt", "version", "window", "windowId"]);
			assert.equal(events.find((event) => event.seq === window.seq)?.ignorable, true);
			assert.ok(window.seq > end.seq);
		} else assert.equal(window, undefined);
	} else {
		assert.deepEqual(fields, [...common, "llmStreamCall", "maxTokens", "rawOutput", "usage"].sort());
		assert.equal(summary.data.llmStreamCall, true);
	}
	assert.equal(session.surface.nodes[0], head);
	assert.deepEqual(summary.data.shadowedRange, { start: summary.data.shadowedSeqs[0], end: summary.data.shadowedSeqs.at(-1) });
	if (result) {
		assert.deepEqual(Object.keys(result).sort(), ["compactionId", "endSeq", "shadowedRange", "shadowedSeqs", "shadowedTokenCount", "startSeq", "summary", "summarySeq"]);
		assert.equal(result.startSeq, start.seq);
		assert.equal(result.summarySeq, summary.seq);
		assert.equal(result.endSeq, end.seq);
		assert.deepEqual(result.summary, summary.data.summary);
		const replacement = records[2]!;
		assert.equal(replacement.type, "user/message");
		if (replacement.type !== "user/message") assert.fail("checkpoint message changed");
		assert.deepEqual(Object.keys(replacement.data).sort(), ["content", "id", "role", "source"]);
		assert.deepEqual(replacement.data.source, { kind: "compact-checkpoint", compactionId: start.data.compactionId });
		assert.deepEqual(replacement.surfaceOp, { op: "replace", startSeq: result.shadowedRange.start, endSeq: result.shadowedRange.end });
		assert.deepEqual(replacement.sourceEventSeqs, [start.seq, summary.seq, ...result.shadowedSeqs]);
		assert.equal(replacement.seq, summary.seq + 1, "shadow price must be adjacent to replacement");
		assert.ok(session.surface.nodes.includes(replacement.seq));
	}
	return { types: records.map((event) => event.type), owner: start.data.turn, summaryFields: common, error: typeof end.data.error };
}

async function seedAgents(fixture: Awaited<ReturnType<typeof dshFixture>>) {
	const ours = await fixture.create();
	const native = await fixture.create();
	for (const agent of [ours, native]) {
		agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "long enough for Basic's shrink check. ".repeat(500) }] }));
		await agent.whenIdle();
	}
	return { ours, native };
}

test("dsh compaction parity: open-turn and idle transactions match Basic's event and replacement contract", async (t) => {
	const fixture = await dshFixture(t);
	const { ours, native } = await seedAgents(fixture);
	const child = fixture.ctx.isolate("compaction");
	const fiber = await child.plugin(BasicCompactionEngine, { auto: false });
	t.after(() => fiber.dispose());
	const basic = child.compaction;
	const oursHead = ours.session.surface.nodes[0]!;
	const nativeHead = native.session.surface.nodes[0]!;
	ours.session.append("turn/start", { turn: 2 });
	native.session.append("turn/start", { turn: 2 });
	const oursFrom = ours.session.seq;
	const nativeFrom = native.session.seq;
	fixture.mock.script.push({ text: "checkpoint ".repeat(1000) });
	const oursResult = await fixture.engine.compactRegion(ours.session.surface.nodes[1]!, ours.session.surface.nodes.at(-1)!, ours);
	const nativeResult = await basic.compactRegion(native.session.surface.nodes[1]!, native.session.surface.nodes.at(-1)!, native);
	assert.equal(oursResult.shadowedSeqs.length, 2);
	assert.equal(nativeResult.shadowedSeqs.length, 2);
	assert.equal(ours.session.surface.nodes.length, 2);
	assert.equal(native.session.surface.nodes.length, 2);
	assert.equal(transactionShape(ours.session, oursFrom, oursHead, oursResult).owner, 2);
	assert.deepEqual(transactionShape(ours.session, oursFrom, oursHead, oursResult), transactionShape(native.session, nativeFrom, nativeHead, nativeResult));
	ours.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
	native.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
	// Add enough fresh text for Basic's idle shrink requirement, without another model turn.
	for (const agent of [ours, native]) agent.session.append("user/message", createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "idle input ".repeat(500) }] }), { surfaceOp: "append" });
	const oursIdle = ours.session.seq;
	const nativeIdle = native.session.seq;
	fixture.mock.script.push({ text: "checkpoint" });
	const oursManual = await fixture.engine.compactNow(ours, new AbortController().signal);
	const nativeManual = await basic.compactNow(native, new AbortController().signal);
	assert.ok(oursManual && nativeManual);
	assert.equal(oursManual.shadowedSeqs.length, 2);
	assert.equal(nativeManual.shadowedSeqs.length, 1, "Basic retains the last node; notesoup intentionally retains none");
	assert.equal(ours.session.surface.nodes.length, 2);
	assert.equal(native.session.surface.nodes.length, 3);
	assert.equal(transactionShape(ours.session, oursIdle, oursHead, oursManual).owner, null);
	assert.deepEqual(transactionShape(ours.session, oursIdle, oursHead, oursManual), transactionShape(native.session, nativeIdle, nativeHead, nativeManual));
	assert.equal(fixture.mock.requests.length, 4, "only Basic calls the model during these two transactions");
});

test("dsh compaction parity: rejected checkpoint closes the bracket and leaves node zero and surface intact", async (t) => {
	const fixture = await dshFixture(t);
	const { ours, native } = await seedAgents(fixture);
	const child = fixture.ctx.isolate("compaction");
	const fiber = await child.plugin(BasicCompactionEngine, { auto: false });
	t.after(() => fiber.dispose());
	const fail = new Error("injected checkpoint rejection");
	const shapes = [];
	for (const [agent, engine] of [[ours, fixture.engine], [native, child.compaction]] as const) {
		agent.session.append("turn/start", { turn: 2 });
		const surface = [...agent.session.surface.nodes];
		const from = agent.session.seq;
		const append = agent.session.append.bind(agent.session);
		t.mock.method(agent.session, "append", (...args: unknown[]) => { if (args[0] === "user/message") throw fail; return (append as (...args: unknown[]) => SessionEvent)(...args); });
		if (agent === native) fixture.mock.script.push({ text: "checkpoint" });
		await assert.rejects(engine.compactRegion(surface[1]!, surface.at(-1)!, agent), (error) => error === fail);
		assert.deepEqual(agent.session.surface.nodes, surface);
		shapes.push(transactionShape(agent.session, from, surface[0]!));
		t.mock.restoreAll();
		agent.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
	}
	assert.deepEqual(shapes[0], shapes[1]);
	assert.equal(fixture.engine.windows.get(ours.session).snapshot.window, 0);
});
