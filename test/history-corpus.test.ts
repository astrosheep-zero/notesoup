import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { Check } from "typebox/value";
import { localHistoryCorpus, type LocalHistoryRoots } from "../src/history/local.js";
import { parseSessionSelector, type HistoryContext, type HistoryHarness, type HistorySession } from "../src/history/corpus.js";
import { allItems, projectHistory, type DecodedHistoryItem, type HistoryProjection } from "../src/history/history.js";
import { offlineClaudeHead } from "../src/history/claude.js";
import { piHistoryFromJsonl } from "../src/history/pi.js";
import { historyList, historyRead } from "../src/tools/history.js";
import { TOOL_OUTPUT_MAX_BYTES } from "../src/tools/output.js";
import type { Outcome } from "../src/tools/result.js";

const AT = "2026-10-06T01:02:03.000Z";
const CODEX = "019a0000-0000-7000-8000-000000000001";
const WINDOW = "019a0000-0000-7000-8000-000000000010";
const rows = (values: unknown[]) => values.map((value) => JSON.stringify(value) + "\n").join("");
function data<T>(outcome: Outcome<T>): T { assert.ok(outcome.ok, JSON.stringify(outcome)); return outcome.data; }
function refusal(outcome: Outcome<unknown>, code: string): string { assert.ok(!outcome.ok); assert.equal(outcome.error.code, code); return outcome.error.message; }
function projection(text = "needle", role: DecodedHistoryItem["role"] = "user"): HistoryProjection {
	const items: DecodedHistoryItem[] = [1, 2, 3, 4, 5].map((seq) => ({ seq, windowId: "w", role, text: `${text} ${seq}`, createdAt: new Date(Date.parse(AT) + seq * 1000).toISOString() }));
	return projectHistory([{ windowId: "w", items }], 5, new Set(items.map((item) => item.seq)));
}
function descriptor(harness: HistoryHarness, id: string, p = projection()): HistorySession {
	return { harness, id, modifiedAt: 0, load: async () => ({ projection: p }) };
}
function context(sessions: HistorySession[], currentHarness: HistoryHarness = "pi"): HistoryContext {
	return { current: () => projection("current"), corpus: { currentHarness, sessions: async () => sessions } };
}

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "notesoup-history-corpus-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const roots = { pi: join(home, ".pi/agent/sessions"), claude: join(home, ".claude/projects"), codex: join(home, ".codex/sessions") };
	async function put(path: string, content: string | Buffer, modified = 1) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
		await utimes(path, modified, modified);
		return path;
	}
	const piPath = await put(join(roots.pi, "--workspace--", "2026-10-06T01-02-03_pi-one.jsonl"), rows([
		{ type: "session", version: 3, id: "pi-one", cwd: "/workspace", timestamp: AT },
		{ type: "message", id: "u", parentId: null, timestamp: AT, message: { role: "user", content: "😀 Pi NEEDLE" } },
		{ type: "message", id: "a", parentId: "u", timestamp: "2026-10-06T01:02:05Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "needle.md" } }] } },
		{ type: "message", id: "r", parentId: "a", timestamp: "2026-10-06T01:02:06Z", message: { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "needle tool output" }] } },
	]), 10);
	const claudePath = await put(join(roots.claude, "--workspace--", "claude-one.jsonl"), rows([
		{ type: "user", uuid: "c1", parentUuid: null, sessionId: "claude-one", timestamp: "2026-10-06T01:02:04Z", message: { role: "user", content: "Claude needle" } },
		{ type: "system", uuid: "c2", parentUuid: "c1", sessionId: "claude-one", timestamp: "2026-10-06T01:02:07Z", content: "Claude context needle" },
	]), 20);
	const codexText = rows([
		{ type: "session_meta", timestamp: AT, payload: { id: CODEX, cwd: "/workspace", cli_version: "0.160.1", context_window: { window_id: WINDOW } } },
		{ type: "response_item", timestamp: "2026-10-06T01:02:08Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex needle" }] } },
	]);
	const codexPath = await put(join(roots.codex, "2026/10/06", `rollout-2026-10-06T01-02-03-${CODEX}.jsonl.zst`), zstdCompressSync(Buffer.from(codexText)), 30);
	const current = descriptor("pi", "current", projection("current"));
	const corpus = localHistoryCorpus({ home, env: {}, current });
	const ctx: HistoryContext = { current: () => projection("current"), corpus };
	return { home, roots, put, ctx, corpus, piPath, claudePath, codexPath, codexText };
}

test("session schemas are optional and non-empty, while the current projection keeps its exact wire shape", async () => {
	for (const operation of [historyList, historyRead]) {
		const params = operation === historyRead ? { seq: 1 } : {};
		assert.equal(Check(operation.parameters, params), true);
		assert.equal(Check(operation.parameters, { ...params, session: "" }), false);
		assert.equal(Check(operation.parameters, { ...params, session: "claude:a" }), true);
	}
	const p = projection();
	const page = await historyList.execute({ limit: 1 }, p);
	assert.ok(Check(historyList.outputSchema, page.ok ? page.data : page));
	assert.equal("session" in data(page).items[0]!, false);
	assert.deepEqual(data(page).page_older, { before_seq: 5 });
	assert.match(historyList.render(page), /^seq 5 \| user/);
	assert.doesNotMatch(historyList.render(page), /session/);
	const read = await historyRead.execute({ seq: 3 }, p);
	assert.equal("session" in data(read), false);
	assert.doesNotMatch(historyRead.render(read), /session/);
});

test("single selectors resolve exact before prefix, prefer the current harness, then fall back across harnesses", async () => {
	const ctx = context([descriptor("pi", "same-long"), descriptor("claude", "same"), descriptor("codex", "other-exact"), descriptor("pi", "exact"), descriptor("pi", "exact-long")]);
	assert.equal(data(await historyRead.execute({ session: "same", seq: 1 }, ctx)).session, "pi:same-long");
	assert.equal(data(await historyRead.execute({ session: "claude:same", seq: 1 }, ctx)).session, "claude:same");
	assert.equal(data(await historyRead.execute({ session: "exact", seq: 1 }, ctx)).session, "pi:exact");
	assert.equal(data(await historyRead.execute({ session: "other-", seq: 1 }, ctx)).session, "codex:other-exact");
	refusal(await historyRead.execute({ session: "absent", seq: 1 }, ctx), "unknown_session");
	refusal(await historyList.execute({ session: "dsh:absent" }, ctx), "unknown_session");
	refusal(await historyRead.execute({ session: "pi:exact", seq: 1 }, projection()), "unknown_session");
	for (const session of ["", "wat:id", "pi:", "pi:a:b"]) {
		refusal(await historyList.execute({ session }, ctx), "invalid_session");
	}
	assert.equal(parseSessionSelector("dsh:a").ok, true);
});

test("ambiguous selectors name at most five qualified candidates and never load a guessed session", async () => {
	const sessions = Array.from({ length: 7 }, (_, index) => ({ ...descriptor("pi", `prefix-${index}`), load: async () => { throw new Error("must not load"); } }));
	const ctx = context(sessions);
	const message = refusal(await historyList.execute({ session: "prefix" }, ctx), "ambiguous_session");
	for (let index = 0; index < 5; index++) assert.ok(message.includes(`pi:prefix-${index}`));
	assert.ok(!message.includes("pi:prefix-5"));
	refusal(await historyRead.execute({ session: "prefix", seq: 1 }, ctx), "ambiguous_session");
	const foreign = context([descriptor("claude", "same"), descriptor("codex", "same")]);
	const across = refusal(await historyList.execute({ session: "same" }, foreign), "ambiguous_session");
	assert.match(across, /claude:same/);
	assert.match(across, /codex:same/);
});

test("all single-session recipes preserve the resolved identity, including folded expand and read neighborhood", async () => {
	const p = projectHistory([{ windowId: "w", items: [
		{ seq: 1, windowId: "w", role: "user", text: "first" },
		{ seq: 2, windowId: "w", role: "system", text: "hidden context" },
		{ seq: 3, windowId: "w", role: "user", text: "middle" },
		{ seq: 4, windowId: "w", role: "assistant", text: "last" },
	] }], 4, new Set([1, 2, 3, 4]));
	const ctx = context([descriptor("claude", "target-session", p)]);
	const page = await historyList.execute({ session: "claude:target", limit: 1, after_seq: 1, before_seq: 5 }, ctx);
	assert.deepEqual(data(page).page_older, { session: "claude:target-session", before_seq: 4 });
	const first = await historyList.execute({ session: "target", from: "oldest", limit: 1 }, ctx);
	assert.deepEqual(data(first).page_newer, { session: "claude:target-session", after_seq: 1, from: "oldest" });
	const foldPage = await historyList.execute({ session: "target", limit: 3 }, ctx);
	const expand = /→ expand: (\{[^\n]+\})/.exec(historyList.render(foldPage));
	assert.ok(expand);
	const recipe = JSON.parse(expand[1]!) as { session: string; after_seq: number; before_seq: number; roles: ["context"] };
	assert.equal(recipe.session, "claude:target-session");
	assert.deepEqual(data(await historyList.execute(recipe, ctx)).items.map((item) => "seq" in item ? item.seq : -1), [2]);
	assert.match(historyList.render(foldPage), /session claude:target-session \| seq 1 \| user/);
	const read = await historyRead.execute({ session: "target", seq: 3 }, ctx);
	assert.equal(data(read).session, "claude:target-session");
	assert.match(historyRead.render(read), /^session claude:target-session \| seq 3 \| user/);
	assert.match(historyRead.render(read), /neighborhood.*"session":"claude:target-session"/);
	assert.ok(Check(historyRead.outputSchema, data(read)));
	assert.ok(Check(historyList.outputSchema, data(foldPage)));
});

test("wildcard refusals precede discovery, and read accepts no wildcard selector", async () => {
	const ctx: HistoryContext = { current: () => { throw new Error("must not load current"); }, corpus: { currentHarness: "pi", sessions: async () => { throw new Error("must not discover"); } } };
	for (const query of [undefined, "", [], ["", ""]]) {
		refusal(await historyList.execute({ session: "*", query }, ctx), "missing_query");
	}
	for (const bounds of [{ before_seq: 10 }, { after_seq: 1 }, { before_seq: 10, after_seq: 1 }]) {
		refusal(await historyList.execute({ session: "*", query: "needle", ...bounds }, ctx), "invalid_bounds");
	}
	for (const session of ["*", "pi:*", "cl*", "dsh:pre*suffix"]) {
		refusal(await historyRead.execute({ session, seq: 1 }, ctx), "invalid_session");
	}
	refusal(await historyList.execute({ session: "*", query: "needle", since: "not-a-date" }, ctx), "invalid_time");
});

test("native filesystem discovery decodes three harnesses, compressed Codex, and keeps source bytes/mtime unchanged", async (t) => {
	const f = await fixture(t);
	const paths = [f.piPath, f.claudePath, f.codexPath];
	const before = await Promise.all(paths.map(async (path) => ({ bytes: await readFile(path), time: (await stat(path)).mtimeMs })));
	const sessions = await f.corpus.sessions();
	assert.deepEqual(sessions.map((session) => `${session.harness}:${session.id}`), ["pi:current", `codex:${CODEX}`, "claude:claude-one", "pi:pi-one"]);
	const expected: [string, number, string][] = [["pi:pi-one", 1, "😀 Pi NEEDLE"], ["claude:claude-one", 1, "Claude needle"], [`codex:${CODEX}`, 2, "Codex needle"]];
	for (const [session, seq, text] of expected) {
		const read = await historyRead.execute({ session, seq }, f.ctx);
		assert.equal(data(read).text, text);
		assert.equal(data(read).session, session);
		assert.match(historyRead.render(read), new RegExp(`^session ${session} \\| seq ${seq} \\|`));
	}
	const tool = data(await historyRead.execute({ session: "pi:pi-one", seq: 3 }, f.ctx));
	assert.equal(tool.tool, "read");
	assert.match(tool.text, /needle\.md.*\n--- output ---\nneedle tool output/);
	refusal(await historyRead.execute({ session: "pi:pi-one", seq: 4 }, f.ctx), "not_an_event");
	for (let index = 0; index < paths.length; index++) {
		assert.deepEqual(await readFile(paths[index]!), before[index]!.bytes);
		assert.equal((await stat(paths[index]!)).mtimeMs, before[index]!.time);
	}
});

test("wildcard query merges every role chronologically, limits from either end, and returns no folds/cursors", async (t) => {
	const { ctx } = await fixture(t);
	const result = await historyList.execute({ session: "*", query: ["", "nEeDlE"], limit: 20 }, ctx);
	const page = data(result);
	assert.deepEqual(page.items.map((item) => "role" in item ? [item.session, item.seq, item.role] : null), [
		["pi:pi-one", 1, "user"], ["claude:claude-one", 1, "user"], ["pi:pi-one", 3, "tool"], ["claude:claude-one", 2, "context"], [`codex:${CODEX}`, 2, "assistant"],
	]);
	assert.equal(page.page_older, null);
	assert.equal(page.page_newer, null);
	const newest = data(await historyList.execute({ session: "*", query: "needle", limit: 2 }, ctx));
	assert.deepEqual(newest.items, page.items.slice(-2));
	const oldest = data(await historyList.execute({ session: "*", query: "needle", limit: 2, from: "oldest" }, ctx));
	assert.deepEqual(oldest.items, page.items.slice(0, 2));
	const filtered = data(await historyList.execute({ session: "*", query: "needle", roles: ["tool", "context"], since: "2026-10-06T01:02:05", until: "2026-10-06T01:02:07Z" }, ctx));
	assert.deepEqual(filtered.items.map((item) => "role" in item ? item.role : "folded"), ["tool"]);
	const harness = data(await historyList.execute({ session: "claude:*", query: "needle" }, ctx));
	assert.ok(harness.items.every((item) => "session" in item && item.session === "claude:claude-one"));
	assert.equal(data(await historyList.execute({ session: "pi:absent*", query: "needle" }, ctx)).items.length, 0);
	assert.ok(Check(historyList.outputSchema, page));
	assert.match(historyList.render(result), /session pi:pi-one \| seq 1 \| user/);
});

test("query offsets and text continuation retain cross-session identity and Unicode coordinates", async (t) => {
	const { ctx } = await fixture(t);
	const page = data(await historyList.execute({ session: "pi:*", query: "NEEDLE", roles: ["user"], max_chars_per_item: 3 }, ctx));
	const hit = page.items[0]!;
	assert.ok("seq" in hit);
	assert.equal(hit.offset_chars, 5);
	assert.equal(hit.content, "NEE");
	const read = data(await historyRead.execute({ session: hit.session, seq: hit.seq, offset_chars: hit.offset_chars, max_chars: 3 }, ctx));
	assert.equal(read.text, hit.content);
	assert.equal(read.next_offset_chars, 8);
	const tail = data(await historyRead.execute({ session: read.session, seq: hit.seq, offset_chars: read.next_offset_chars! }, ctx));
	assert.equal(tail.text, "DLE");
	assert.equal(tail.session, "pi:pi-one");
});

test("wildcard glob metacharacters other than * stay literal, with deterministic timestamp ties", async () => {
	const ctx = context([descriptor("pi", "a.b"), descriptor("pi", "axb"), descriptor("claude", "a.b")]);
	const page = data(await historyList.execute({ session: "a.*", query: "needle", limit: 500 }, ctx));
	assert.ok(page.items.every((item) => "session" in item && ["pi:a.b", "claude:a.b"].includes(item.session!)));
	assert.deepEqual(page.items.slice(0, 2).map((item) => "session" in item ? item.session : ""), ["claude:a.b", "pi:a.b"]);
});

test("root overrides/env homes are hermetic, missing roots are empty, and foreign reads never require the current projection", async (t) => {
	const f = await fixture(t);
	const roots: LocalHistoryRoots = { pi: f.roots.pi, claude: null, codex: null };
	const current = { harness: "dsh" as const, id: "unreadable", load: async () => { throw new Error("current unavailable"); } };
	const ctx: HistoryContext = { current: () => { throw new Error("must not read current"); }, corpus: localHistoryCorpus({ roots, env: {}, home: join(f.home, "absent"), current }) };
	assert.equal(data(await historyRead.execute({ session: "pi:pi-one", seq: 1 }, ctx)).session, "pi:pi-one");
	assert.equal(data(await historyList.execute({ session: "pi:*", query: "needle" }, ctx)).items.length, 2);
	const env = { PI_CODING_AGENT_DIR: dirname(f.roots.pi), CLAUDE_CONFIG_DIR: dirname(f.roots.claude), CODEX_HOME: dirname(f.roots.codex) };
	const configured = localHistoryCorpus({ current, home: join(f.home, "absent"), env });
	assert.equal((await configured.sessions()).length, 4);
	const explicit = localHistoryCorpus({ current, home: join(f.home, "absent"), env: { NOTESOUP_HISTORY_PI_ROOT: f.roots.pi, NOTESOUP_HISTORY_CLAUDE_ROOT: f.roots.claude, NOTESOUP_HISTORY_CODEX_ROOT: f.roots.codex } });
	assert.equal((await explicit.sessions()).length, 4);
	refusal(await historyRead.execute({ session: "dsh:unreadable", seq: 1 }, ctx), "history_unavailable");
});

test("DSH service descriptors participate in resolution/search only when supplied; a live descriptor wins over disk", async (t) => {
	const f = await fixture(t);
	const corpus = localHistoryCorpus({ home: f.home, env: {}, current: descriptor("pi", "pi-one", projection("live needle")), dshSessions: async () => [descriptor("dsh", "dsh-one", projection("DSH needle", "system"))] });
	const ctx: HistoryContext = { current: () => projection(), corpus };
	assert.equal(data(await historyRead.execute({ session: "dsh:dsh", seq: 1 }, ctx)).session, "dsh:dsh-one");
	assert.equal(data(await historyRead.execute({ session: "pi-one", seq: 1 }, ctx)).text, "live needle 1");
	const page = data(await historyList.execute({ session: "dsh:*", query: "needle" }, ctx));
	assert.equal(page.items.length, 5);
	assert.ok(page.items.every((item) => "role" in item && item.role === "context"));
	assert.equal((await corpus.sessions()).filter((session) => session.harness === "pi" && session.id === "pi-one").length, 1);
});

test("oversized cross-session reads/searches obey both wire budgets and retain canonical identities", async () => {
	const p = projection("😀".repeat(40_000));
	const ctx = context([descriptor("codex", "long-id", p)]);
	const list = await historyList.execute({ session: "*", query: "😀", max_chars_per_item: 50_000, limit: 500 }, ctx);
	const page = data(list);
	assert.ok(Buffer.byteLength(JSON.stringify(page)) <= TOOL_OUTPUT_MAX_BYTES);
	assert.ok(Buffer.byteLength(historyList.render(list)) <= TOOL_OUTPUT_MAX_BYTES);
	assert.equal(page.items.length, 1);
	assert.equal(page.page_older, null);
	assert.equal(page.page_newer, null);
	const item = page.items[0]!;
	assert.ok("seq" in item && item.truncated);
	assert.equal(item.session, "codex:long-id");
	const read = await historyRead.execute({ session: item.session, seq: item.seq, max_chars: 50_000 }, ctx);
	assert.ok(Buffer.byteLength(JSON.stringify(data(read))) <= TOOL_OUTPUT_MAX_BYTES);
	assert.ok(Buffer.byteLength(historyRead.render(read)) <= TOOL_OUTPUT_MAX_BYTES);
	assert.equal(data(read).session, "codex:long-id");
	assert.ok(data(read).next_offset_chars! > 0);
});

test("qualified lookup and current-harness matches do not inspect unrelated roots", async (t) => {
	const f = await fixture(t);
	const notDirectory = join(f.home, "not-a-directory");
	await writeFile(notDirectory, "unrelated root must not be traversed");
	const current = descriptor("pi", "current");
	const ctx: HistoryContext = { current: () => projection(), corpus: localHistoryCorpus({ current, roots: { pi: f.roots.pi, claude: notDirectory, codex: null }, env: {} }) };
	assert.equal(data(await historyRead.execute({ session: "pi-one", seq: 1 }, ctx)).session, "pi:pi-one");
	assert.equal(data(await historyRead.execute({ session: "pi:pi-one", seq: 1 }, ctx)).session, "pi:pi-one");
	assert.equal(data(await historyList.execute({ session: "pi:*", query: "needle" }, ctx)).items.length, 7);
});

test("cross-session Claude gaps are visible even on an empty page, budgeted, and outside document offsets", async (t) => {
	const f = await fixture(t);
	await f.put(f.claudePath, rows([{ type: "assistant", uuid: "head", parentUuid: "missing", sessionId: "claude-one", timestamp: AT, message: { role: "assistant", content: "😀needle" + "x".repeat(50_000) } }]));
	const empty = await historyList.execute({ session: "claude:claude-one", query: "absent" }, f.ctx);
	assert.equal(data(empty).items.length, 0);
	assert.match(data(empty).notice!, /missing ancestor.*"missing"/);
	assert.match(historyList.render(empty), /Only confirmed ancestry.*\n\nNo events/);
	const list = await historyList.execute({ session: "claude:*", query: "needle", max_chars_per_item: 50_000 }, f.ctx);
	assert.ok(Buffer.byteLength(JSON.stringify(data(list))) <= TOOL_OUTPUT_MAX_BYTES);
	assert.ok(Buffer.byteLength(historyList.render(list)) <= TOOL_OUTPUT_MAX_BYTES);
	const hit = data(list).items[0]!;
	assert.ok("seq" in hit);
	assert.equal(hit.offset_chars, 1);
	const read = await historyRead.execute({ session: hit.session, seq: hit.seq, offset_chars: hit.offset_chars, max_chars: 50_000 }, f.ctx);
	assert.match(data(read).notice!, /history is incomplete/);
	assert.ok(data(read).text.startsWith("needle"));
	assert.ok(!data(read).text.includes("missing ancestor"));
	assert.ok(Buffer.byteLength(JSON.stringify(data(read))) <= TOOL_OUTPUT_MAX_BYTES);
	assert.ok(Buffer.byteLength(historyRead.render(read)) <= TOOL_OUTPUT_MAX_BYTES);
});

test("invalid persisted sessions refuse visibly instead of fabricating a successful partial corpus", async (t) => {
	const f = await fixture(t);
	await f.put(join(f.roots.pi, "--workspace--", "2026-10-06_broken.jsonl"), "not-json\n");
	const message = refusal(await historyList.execute({ session: "pi:*", query: "needle" }, f.ctx), "history_unavailable");
	assert.match(message, /pi:broken/);
	refusal(await historyRead.execute({ session: "pi:broken", seq: 1 }, f.ctx), "history_unavailable");
});

test("offline Pi follows persisted parent links, preserves branch seq holes and rejects corrupt ancestry", async () => {
	const base = { type: "session", version: 3, id: "branch", timestamp: AT };
	const entry = (id: string, parentId: string | null, content: string) => ({ type: "message", id, parentId, timestamp: AT, message: { role: "user", content } });
	const text = rows([base, entry("root", null, "root"), entry("left", "root", "left"), entry("right", "root", "right")]);
	const p = piHistoryFromJsonl(text + '{"partial":', "branch");
	assert.deepEqual(allItems(p).map((item) => [item.seq, item.text]), [[1, "root"], [3, "right"]]);
	refusal(await historyRead.execute({ seq: 2 }, p), "not_on_branch");
	assert.throws(() => piHistoryFromJsonl(rows([base, entry("gap", "missing", "gap")]), "branch"), /missing parent/);
	assert.throws(() => piHistoryFromJsonl(text + "bad\n", "branch"), /malformed Pi/);
	assert.throws(() => piHistoryFromJsonl(text, "wrong"), /different session/);
});

test("offline Claude requires one evidenced leaf, accounts for logical compact links, and never guesses among branches", () => {
	const user = (uuid: string, parentUuid: string | null) => ({ type: "user", uuid, parentUuid, sessionId: "s", message: { role: "user", content: "text" } });
	assert.equal(offlineClaudeHead(rows([user("u", null), user("a", "u")])), "a");
	assert.equal(offlineClaudeHead(rows([user("u", null), { type: "system", uuid: "b", parentUuid: null, logicalParentUuid: "u", subtype: "compact_boundary" }, user("a", "b")])), "a");
	assert.equal(offlineClaudeHead(rows([user("u", null), user("preserved", null), { type: "system", uuid: "b", parentUuid: null, logicalParentUuid: "u", subtype: "compact_boundary", compactMetadata: { preservedSegment: { headUuid: "preserved", tailUuid: "preserved" } } }, user("a", "b")])), "a");
	assert.throws(() => offlineClaudeHead(rows([user("u", null), user("left", "u"), user("right", "u")])), /2 possible heads/);
	assert.throws(() => offlineClaudeHead(""), /0 possible heads/);
});
