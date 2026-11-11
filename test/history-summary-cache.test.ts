import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { localHistoryCorpus } from "../src/history/local.js";
import { cachedSessionRepresentative, historySummaryCacheRoot } from "../src/history/summary-cache.js";
import { projectHistory, type HistoryProjection } from "../src/history/history.js";
import type { HistoryContext, HistoryCorpus } from "../src/history/corpus.js";
import { historyList, historyRead } from "../src/tools/history.js";
import type { Outcome } from "../src/result.js";

const AT = "2026-10-06T01:02:03.000Z";
const ROOT = "019a0000-0000-7000-8000-000000000001";
const CHILD = "019a0000-0000-7000-8000-000000000002";
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row) + "\n").join("");
function data<T>(result: Outcome<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.data; }
function projection(text: string): HistoryProjection {
	return projectHistory([{ windowId: "w", items: [{ seq: 2, windowId: "w", role: "user", text, createdAt: AT }] }], 2, new Set([2]));
}
function piText(text: string, extra: unknown[] = []): string {
	return jsonl([
		{ type: "session", version: 3, id: "offline", cwd: "/workspace", timestamp: AT },
		{ type: "message", id: "u", parentId: null, timestamp: AT, message: { role: "user", content: text } }, ...extra,
	]);
}
async function fixture(t: TestContext) {
	const home = await fs.mkdtemp(join(tmpdir(), "notesoup-history-summary-"));
	t.after(() => fs.rm(home, { recursive: true, force: true }));
	const roots = { pi: join(home, "pi"), claude: join(home, "claude"), codex: join(home, "codex/sessions") };
	const cacheRoot = join(home, "cache");
	async function put(path: string, content: string | Buffer) {
		await fs.mkdir(dirname(path), { recursive: true });
		await fs.writeFile(path, content);
		return path;
	}
	const piPath = join(roots.pi, "workspace", "2026-10-06_offline.jsonl");
	function corpus(root = cacheRoot): HistoryCorpus {
		return localHistoryCorpus({ roots, home, env: {}, summaryCacheRoot: root, current: { harness: "dsh", id: "live", load: async () => ({ projection: projection("live") }) } });
	}
	function context(root = cacheRoot): HistoryContext { return { current: () => projection("live"), corpus: corpus(root) }; }
	return { home, roots, piPath, cacheRoot, put, corpus, context };
}
function transcriptReads(t: TestContext, paths: string[]) {
	const readFile = fs.readFile;
	const watched = new Set(paths.flatMap((path) => [path, realpathSync(path)]));
	const reads: string[] = [];
	const spy = t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
		if (watched.has(String(args[0]))) reads.push(String(args[0]));
		return readFile(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
	return reads;
}
async function cacheEntries(root: string): Promise<string[]> {
	return (await fs.readdir(root).catch(() => [])).filter((name) => name.endsWith(".json"));
}

test("cache roots follow platform conventions without adding a public setting", () => {
	assert.equal(historySummaryCacheRoot("/home/u", {}, "darwin"), "/home/u/Library/Caches/notesoup/history");
	assert.equal(historySummaryCacheRoot("/home/u", {}, "linux"), "/home/u/.cache/notesoup/history");
	assert.equal(historySummaryCacheRoot("/home/u", { XDG_CACHE_HOME: "/xdg" }, "linux"), "/xdg/notesoup/history");
});

test("a fresh corpus reuses a strict representative without reading the body, preserving caller preview budgets", async (t) => {
	const f = await fixture(t), text = "😀 opening " + "full content ".repeat(600);
	await f.put(f.piPath, piText(text));
	const reads = transcriptReads(t, [f.piPath]);
	const before = await fs.stat(f.piPath);
	const cold = data(await historyList.execute({ session: "pi:*", max_chars_per_item: 5 }, f.context()));
	assert.equal(reads.length, 1);
	const warm = data(await historyList.execute({ session: "pi:*", max_chars_per_item: 16000 }, f.context()));
	assert.equal(reads.length, 1, "a new corpus must read only the cache, not the transcript");
	assert.equal(warm.items.length, 1);
	const item = warm.items[0]!;
	assert.ok(!("folded" in item));
	assert.equal(item.content, text);
	assert.equal(item.session, "pi:offline");
	assert.ok(!("folded" in cold.items[0]!));
	assert.equal(cold.items[0]!.truncated, true);
	const entries = await cacheEntries(f.cacheRoot);
	assert.equal(entries.length, 1);
	const entry = JSON.parse(await fs.readFile(join(f.cacheRoot, entries[0]!), "utf8"));
	assert.equal(entry.event.text, text);
	assert.equal(entry.session, "pi:offline");
	assert.equal(entry.fingerprints.length, 1);
	assert.equal("projection" in entry, false);
	assert.equal((await fs.stat(f.piPath)).mtimeMs, before.mtimeMs);
	assert.equal((await fs.stat(f.piPath)).ctimeMs, before.ctimeMs);
});

test("empty and tool-only sessions cache strict selection, full documents and nested-call summaries", async (t) => {
	const f = await fixture(t);
	const header = { type: "session", version: 3, id: "offline", cwd: "/workspace", timestamp: AT };
	await f.put(f.piPath, jsonl([header]));
	const reads = transcriptReads(t, [f.piPath]);
	const params = { session: "pi:*", max_chars_per_item: 16000 };
	assert.equal(data(await historyList.execute(params, f.context())).items.length, 0);
	assert.equal(data(await historyList.execute(params, f.context())).items.length, 0);
	assert.equal(reads.length, 1);
	await fs.writeFile(f.piPath, jsonl([header, { type: "message", id: "tool", parentId: null, timestamp: AT, message: { role: "toolResult", toolName: "delegate", content: "😀 full output", nestedCalls: { complete: true, calls: [{ id: "nested", name: "read", status: "ok", arguments: { path: "精确.json" }, durationMs: 7 }] } } }]));
	const cold = await historyList.execute(params, f.context());
	assert.match(historyList.render(cold), /full output/);
	assert.match(historyList.render(cold), /精确.json/);
	assert.deepEqual(await historyList.execute(params, f.context()), cold);
	assert.equal(reads.length, 2);
});

test("append, equal-size rewrite with restored mtime, and atomic replacement invalidate summaries", async (t) => {
	const f = await fixture(t);
	await f.put(f.piPath, piText("first"));
	const reads = transcriptReads(t, [f.piPath]);
	const params = { session: "pi:*" };
	await historyList.execute(params, f.context());
	await fs.appendFile(f.piPath, jsonl([{ type: "message", id: "a", parentId: "u", timestamp: AT, message: { role: "assistant", content: "tail" } }]));
	await historyList.execute(params, f.context());
	assert.equal(reads.length, 2);
	const before = await fs.stat(f.piPath);
	const old = await fs.readFile(f.piPath, "utf8");
	await fs.writeFile(f.piPath, old.replace("first", "other"));
	await fs.utimes(f.piPath, before.atime, before.mtime);
	const changed = data(await historyList.execute(params, f.context()));
	assert.equal(reads.length, 4); // one explicit fixture read plus the strict rebuild
	assert.ok(!("folded" in changed.items[0]!));
	assert.equal(changed.items[0]!.content, "other");
	await f.put(f.piPath + ".replacement", piText("third"));
	await fs.rename(f.piPath + ".replacement", f.piPath);
	await fs.utimes(f.piPath, before.atime, before.mtime);
	const replaced = data(await historyList.execute(params, f.context()));
	assert.ok(!("folded" in replaced.items[0]!));
	assert.equal(replaced.items[0]!.content, "third");
	assert.equal(reads.length, 5);
});

test("search, roles, time filters and explicit sessions bypass the summary while empty queries reuse it", async (t) => {
	const f = await fixture(t);
	await f.put(f.piPath, piText("opening", [{ type: "message", id: "a", parentId: "u", timestamp: "2026-10-07T00:00:00Z", message: { role: "assistant", content: "later" } }]));
	const reads = transcriptReads(t, [f.piPath]);
	const ctx = f.context();
	await historyList.execute({ session: "pi:*" }, ctx);
	for (const query of ["", [], ["", ""]]) await historyList.execute({ session: "pi:*", query }, ctx);
	assert.equal(reads.length, 1);
	for (const filters of [{ roles: ["assistant"] as ["assistant"] }, { since: "2026-10-07" }, { until: "2026-10-07" }, { query: "later" }, { session: "pi:offline" }]) {
		const before = reads.length;
		const params = { session: "pi:*", ...filters };
		const result = await historyList.execute(params, ctx);
		assert.ok(reads.length > before, JSON.stringify(params));
		const plain: HistoryContext = { current: () => projection("live"), corpus: { currentHarness: "dsh", sessions: async (harness) => (await f.corpus().sessions(harness)).map(({ loadRepresentative: _cache, ...session }) => session) } };
		assert.deepEqual(result, await historyList.execute(params, plain));
	}
	assert.equal(data(await historyList.execute({ session: "pi:*", since: "2026-10-07" }, ctx)).items.length, 1);
	assert.equal(data(await historyList.execute({ session: "pi:*", until: AT }, ctx)).items.length, 0, "until is exclusive");
});

test("corrupt cache/schema and unwritable roots fall back; a warm cache cannot hide malformed or unsupported transcripts", async (t) => {
	const f = await fixture(t);
	await f.put(f.piPath, piText("opening"));
	const params = { session: "pi:*" };
	const expected = await historyList.execute(params, f.context());
	const [name] = await cacheEntries(f.cacheRoot);
	const path = join(f.cacheRoot, name!);
	const valid = JSON.parse(await fs.readFile(path, "utf8"));
	for (const content of ["not json", "{}", JSON.stringify({ version: "old-decoder" }), JSON.stringify({ ...valid, notice: { invalid: true } }), JSON.stringify({ ...valid, event: { ...valid.event, role: "invented" } })]) {
		await fs.writeFile(path, content);
		assert.deepEqual(await historyList.execute(params, f.context()), expected);
	}
	const blockedRoot = await f.put(join(f.home, "cache-is-a-file"), "not a directory");
	assert.deepEqual(await historyList.execute(params, f.context(blockedRoot)), expected);
	await fs.writeFile(f.piPath, piText("opening") + "malformed committed record\n");
	assert.equal(data(await historyList.execute(params, f.context())).items.length, 0);
	assert.equal((await historyList.execute({ session: "pi:offline" }, f.context())).ok, false);
	assert.equal((await historyRead.execute({ session: "pi:offline", seq: 2 }, f.context())).ok, false);
	await fs.writeFile(f.piPath, piText("opening").replace('"parentId":null', '"parentId":123'));
	assert.equal(data(await historyList.execute(params, f.context())).items.length, 0);
});

test("a cache entry growing beyond 8 MiB after its read is a miss, not a transcript refusal", async (t) => {
	const f = await fixture(t);
	await f.put(f.piPath, piText("opening"));
	const params = { session: "pi:*" };
	const expected = await historyList.execute(params, f.context());
	const [name] = await cacheEntries(f.cacheRoot);
	const cachePath = join(f.cacheRoot, name!);
	const reads = transcriptReads(t, [f.piPath]);
	const open = fs.open;
	const spy = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const file = await open(...args);
		if (String(args[0]) === cachePath) {
			const stat = file.stat.bind(file);
			let calls = 0;
			t.mock.method(file, "stat", async () => {
				if (++calls === 2) await fs.appendFile(cachePath, " ".repeat(8 * 1024 * 1024));
				return stat();
			});
		}
		return file;
	});
	syncBuiltinESMExports();
	t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
	assert.deepEqual(await historyList.execute(params, f.context()), expected);
	assert.equal(reads.length, 1, "otherwise the valid JSON prefix would have been reused despite oversized disk entry");
	assert.ok((await fs.stat(cachePath)).size <= 8 * 1024 * 1024);
});

test("live bindings always replace offline cache descriptors", async (t) => {
	const f = await fixture(t);
	await f.put(f.piPath, piText("offline"));
	await historyList.execute({ session: "pi:*" }, f.context());
	const reads = transcriptReads(t, [f.piPath]);
	let liveReads = 0;
	const current = { harness: "pi" as const, id: "offline", load: async () => { liveReads++; return { projection: projection("live version") }; }, loadRepresentative: async () => { throw new Error("must not use any cached capability for current"); } };
	const corpus = localHistoryCorpus({ roots: f.roots, summaryCacheRoot: f.cacheRoot, current });
	for (let i = 0; i < 2; i++) {
		const page = data(await historyList.execute({ session: "*" }, { current: () => projection("live version"), corpus }));
		assert.ok(!("folded" in page.items[0]!));
		assert.equal(page.items[0]!.content, "live version");
	}
	assert.equal(liveReads, 2);
	assert.equal(reads.length, 0);
});

test("strict Claude branch selection and missing-ancestor notices survive cached previews", async (t) => {
	const f = await fixture(t), path = join(f.roots.claude, "workspace", "offline-claude.jsonl");
	const row = (uuid: string, parentUuid: string | null, content: string) => ({ type: "user", uuid, parentUuid, sessionId: "offline-claude", timestamp: AT, message: { role: "user", content } });
	await f.put(path, jsonl([row("old", null, "excluded branch"), row("selected", "missing", "selected topic")]));
	const reads = transcriptReads(t, [path]);
	const cold = await historyList.execute({ session: "claude:*" }, f.context());
	const warm = await historyList.execute({ session: "claude:*" }, f.context());
	assert.deepEqual(warm, cold);
	assert.equal(reads.length, 1);
	assert.match(data(warm).notice!, /missing ancestor/);
	assert.doesNotMatch(historyList.render(warm), /excluded branch/);
	assert.match(historyList.render(warm), /selected topic/);
});

test("raced rebuilds and summaries larger than 8 MiB are returned normally but not admitted", async (t) => {
	const f = await fixture(t);
	await f.put(f.piPath, "source");
	let loads = 0;
	const raced = async () => {
		loads++;
		await fs.appendFile(f.piPath, "x");
		return { data: { projection: projection("strict result") } };
	};
	for (let i = 0; i < 2; i++) assert.equal((await cachedSessionRepresentative({ harness: "pi", id: "offline" }, f.piPath, f.cacheRoot, raced)).event!.text, "strict result");
	assert.equal(loads, 2);
	assert.deepEqual(await cacheEntries(f.cacheRoot), []);
	const huge = "x".repeat(8 * 1024 * 1024);
	await cachedSessionRepresentative({ harness: "pi", id: "offline" }, f.piPath, f.cacheRoot, async () => ({ data: { projection: projection(huge) } }));
	assert.deepEqual(await cacheEntries(f.cacheRoot), []);
});

function codexRow(type: string, payload: unknown, ordinal: number) { return { timestamp: AT, type, payload, ordinal }; }
function codexMeta(id: string, extra: Record<string, unknown> = {}) { return { id, cwd: "/workspace", cli_version: "0.160.1", history_mode: "paginated", context_window: { window_id: "019a0000-0000-7000-8000-000000000010" }, ...extra }; }
function codexName(id: string) { return `rollout-2026-10-06T01-02-03-${id}.jsonl`; }
function codexMessage(text: string) { return { type: "message", role: "user", content: [{ type: "input_text", text }] }; }

test("Codex cache fingerprints actual archived compressed ancestors and revalidates source discovery ambiguity/missing files", async (t) => {
	const f = await fixture(t);
	const ancestor = jsonl([codexRow("session_meta", codexMeta(ROOT), 0), codexRow("response_item", codexMessage("parent topic"), 1)]);
	const ancestorPath = join(f.home, "codex/archived_sessions", codexName(ROOT) + ".zst");
	const ancestorFile = ancestor + jsonl([codexRow("response_item", codexMessage("EXCLUDED PARENT SUFFIX"), 2)]);
	await f.put(ancestorPath, zstdCompressSync(Buffer.from(ancestorFile)));
	const childPath = join(f.roots.codex, "2026/10/06", codexName(CHILD));
	await f.put(childPath, jsonl([
		codexRow("session_meta", codexMeta(CHILD, { history_base: { thread_id: ROOT, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(ancestor) }, forked_from_id: ROOT, forked_from_ordinal_exclusive: 2 }), 2),
		codexRow("response_item", codexMessage("child topic"), 3),
	]));
	const reads = transcriptReads(t, [childPath, ancestorPath]);
	const params = { session: `codex:${CHILD}*` };
	const cold = await historyList.execute(params, f.context());
	assert.equal(data(cold).items.length, 1);
	assert.match(historyList.render(cold), /parent topic/);
	assert.equal(reads.length, 2);
	assert.deepEqual(await historyList.execute(params, f.context()), cold);
	assert.equal(reads.length, 2, "neither root nor ancestor body is reread on a warm hit");
	assert.doesNotMatch(historyList.render(cold), /EXCLUDED/);
	const [name] = await cacheEntries(f.cacheRoot);
	const cachePath = join(f.cacheRoot, name!);
	const entry = JSON.parse(await fs.readFile(cachePath, "utf8"));
	assert.deepEqual(entry.fingerprints.map((source: { path: string }) => source.path), [realpathSync(childPath), realpathSync(ancestorPath)]);
	assert.deepEqual(entry.lineageSources.map((source: { path: string }) => source.path), [realpathSync(ancestorPath)]);
	for (const incomplete of [{ fingerprints: entry.fingerprints.slice(0, 1) }, { lineageSources: [] }, { fingerprints: entry.fingerprints.slice(1) }]) {
		await fs.writeFile(cachePath, JSON.stringify({ ...entry, ...incomplete }));
		const before: number = reads.length;
		assert.deepEqual(await historyList.execute(params, f.context()), cold);
		assert.equal(reads.length, before + 2, "incomplete root/ancestor fingerprint or lineage witness must miss");
	}
	const beforeEdit = reads.length;
	await fs.writeFile(ancestorPath, zstdCompressSync(Buffer.from(ancestorFile.replace("parent topic", "edited topic"))));
	const updated = await historyList.execute(params, f.context());
	assert.match(historyList.render(updated), /edited topic/);
	assert.equal(reads.length, beforeEdit + 2);
	const duplicatePath = join(f.roots.codex, "2026/10/07", codexName(ROOT));
	await f.put(duplicatePath, ancestor);
	assert.equal(data(await historyList.execute(params, f.context())).items.length, 0, "new ambiguous discovery must invalidate a warm child summary");
	const explicit = await historyList.execute({ session: `codex:${CHILD}` }, f.context());
	assert.ok(!explicit.ok);
	assert.equal(explicit.error.code, "history_unavailable");
	await fs.unlink(duplicatePath);
	assert.match(historyList.render(await historyList.execute(params, f.context())), /edited topic/);
	await fs.unlink(ancestorPath);
	assert.equal(data(await historyList.execute(params, f.context())).items.length, 0);
});
