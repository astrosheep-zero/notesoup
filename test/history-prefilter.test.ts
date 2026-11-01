import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createHistoryPrefilter, historyFileMayMatch } from "../src/history/prefilter.js";

async function* chunks(bytes: Buffer, width: number) {
	for (let offset = 0; offset < bytes.length; offset += width) yield bytes.subarray(offset, offset + width);
}

test("streaming tokens preserve Unicode iu matching at every UTF-8 split and across files", async () => {
	const cases = [
		["LONGſ CASEΣ K 𐐀 你好", ["longs caseς k 𐐨 你好"], true],
		["beta --- alpha", ["alpha beta"], true],
		["beta --- alpha", ["alpha beta missing"], false],
		["unrelated --- NEEDLE", ["nohit", "needle"], true],
		["NEEDLE", ["nohit needle", "absentword"], false],
		["NEEDLE", ["need.*le"], true],
	] as const;
	for (const [text, queries, expected] of cases) {
		const plan = createHistoryPrefilter(queries), bytes = Buffer.from(text);
		for (let width = 1; width <= bytes.length; width++) assert.equal(await plan(chunks(bytes, width)), expected, `${JSON.stringify(queries)} at ${width}`);
		assert.equal(await plan(chunks(Buffer.from("no match here"), 1)), false, "token bits must not leak between files");
		assert.equal(await plan(chunks(bytes, 1)), expected, "the compiled plan is reusable");
	}
});

test("only EOF proves a miss, while errors after tokens or a fallback still propagate", async () => {
	let finished = false;
	async function* late() {
		yield Buffer.from("unrelated");
		yield Buffer.from("needle");
		finished = true;
	}
	assert.equal(await createHistoryPrefilter(["needle"])(late()), true);
	assert.equal(finished, true);
	async function* broken() { yield Buffer.from("needle"); throw new Error("read failed"); }
	for (const queries of [["absentword"], ["needle"], ["😀"]]) await assert.rejects(createHistoryPrefilter(queries)(broken()), /read failed/);
});

test("incremental Unicode unescaping matches the old prefilter at every byte split", async () => {
	const presentation = `Codex unknown arguments not recorded output nested calls complete incomplete terminal ms image audio items null
		copied subagent inference prefix omitted child-local history starts at native ordinal copied model context
		does not prove original parent event addresses compaction boundary replacement_history is an inference checkpoint
		not new conversation events opaque content omitted not recovered plaintext MCP completion without a recorded raw call
		FunctionCallOutput display without raw output encrypted content unavailable world_state snapshot patch omitted from
		the text projection not a newly spoken message native structured retained context not newly spoken dialogue`;
	const prior = (text: string, queries: readonly string[]) => {
		const normalized = text.replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
		return queries.some((query) => (query.match(/[\p{L}\p{N}_-]+/gu) ?? []).every((token) => {
			const parts = /^\d+ms$/iu.test(token) ? [token.slice(0, -2), "ms"] : [token];
			return parts.every((part) => {
				const literal = new RegExp(part, "iu");
				return literal.test(text) || literal.test(normalized) || literal.test(presentation);
			});
		}));
	};
	const cases: [string, string[]][] = [
		[String.raw`{"text":"\u006eeedle"}`, ["needle"]],
		[String.raw`{"text":"\u006eeedle"}`, ["u006eeedle"]],
		[String.raw`{"text":"\u006eeedle"}`, ["needle u006eeedle"]],
		[String.raw`{"text":"\u006eeedle"}`, ["absentword", "needle"]],
		[String.raw`{"text":"\u006eeedle"}`, ["needle absentword"]],
		[String.raw`NEE\u0044LE LONG\u017f CASE\u03a3`, ["needle longs caseς"]],
		[String.raw`\uD801\uDC00needle`, ["𐐨needle"]],
		[String.raw`\uD801\uDC00needle`, ["ud801 𐐨needle"]],
		[String.raw`\u005cu006eeedle`, ["needle"]],
		[String.raw`\u005c\u0075\u0030\u0030\u0036\u0065eedle`, ["needle"]],
		[String.raw`prefix\\u006eeedle`, ["prefixneedle"]],
		[String.raw`\u006e\\u0065edle`, ["needle"]],
		[String.raw`{"arguments":"{\"path\":\"\\u006eeedle\"}"}`, ["needle"]],
		[String.raw`\u00xz needle\u00`, ["needle u00"]],
		[String.raw`need\u00xzle`, ["needle"]],
		[String.raw`\u006e\u00xz`, ["nu00xz"]],
		[String.raw`\u006e\u00xz`, ["u00xz"]],
		[String.raw`\u006e\u00`, ["u00"]],
		[String.raw`\u006e` + "\\", ["absentword"]],
		[String.raw`\U006eeedle`, ["needle"]],
		["LONGſ CASEΣ 你好", ["longs caseς 你好"]],
	];
	for (const [text, queries] of cases) {
		const bytes = Buffer.from(text), plan = createHistoryPrefilter(queries), expected = prior(text, queries);
		for (let cut = 1; cut < bytes.length; cut++) {
			async function* split() { yield bytes.subarray(0, cut); yield bytes.subarray(cut); }
			assert.equal(await plan(split()), expected, `${JSON.stringify({ text, queries })} split ${cut}`);
		}
		assert.equal(await plan(chunks(bytes, 1)), expected, JSON.stringify({ text, queries }));
	}
});

test("only Codex inheritance, not Unicode escapes, forces conservative fallback", async () => {
	for (const text of [String.raw`{"text":"\u006eeedle"}`, String.raw`{"arguments":"{\"value\":\"\\u006eeedle\"}"}`]) {
		for (let width = 1; width < text.length; width++) {
			assert.equal(await createHistoryPrefilter(["needle"])(chunks(Buffer.from(text), width)), true);
			assert.equal(await createHistoryPrefilter(["absentword"])(chunks(Buffer.from(text), width)), false);
		}
	}
	const base = Buffer.from('{"history_base":{"thread_id":"parent"}}');
	for (let width = 1; width < base.length; width++) {
		const plan = createHistoryPrefilter(["ancestralneedle"]);
		assert.equal(await plan(chunks(base, width), true), true);
		assert.equal(await plan(chunks(base, width)), false);
	}
});

test("generated presentation, compact durations, and queries without safe tokens never false-negative", async () => {
	for (const queries of [[], [""], ["😀"], [".*"], ["Codex unknown arguments"], ["absentword", "😀"]]) {
		assert.equal(await createHistoryPrefilter(queries)(chunks(Buffer.from("unrelated"), 1)), true, JSON.stringify(queries));
	}
	for (const query of ["25ms", "25MS", "output 25ms"]) {
		const plan = createHistoryPrefilter([query]);
		assert.equal(await plan(chunks(Buffer.from('{"duration_ms":25}'), 1)), true, query);
		assert.equal(await plan(chunks(Buffer.from('{"duration_ms":26}'), 1)), false, query);
	}
	assert.equal(await createHistoryPrefilter(["output absentword"])(chunks(Buffer.from("unrelated"), 1)), false);
});

test("plain and zstd streams propagate unavailable/malformed input and enforce stored and decoded budgets", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "notesoup-prefilter-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const plain = join(home, "transcript.jsonl"), compressed = plain + ".zst";
	const text = "unrelated ".repeat(8192);
	await writeFile(plain, text);
	await writeFile(compressed, zstdCompressSync(Buffer.from(text)));
	for (const path of [plain, compressed]) {
		assert.equal(await historyFileMayMatch(path, createHistoryPrefilter(["needle"]), true, text.length), false);
		assert.equal(await historyFileMayMatch(path, createHistoryPrefilter(["unrelated"]), true, text.length), true);
		await assert.rejects(historyFileMayMatch(path, createHistoryPrefilter(["needle"]), true, text.length - 1), /size limit exceeded/);
		await assert.rejects(historyFileMayMatch(path, createHistoryPrefilter(["😀"]), true, text.length - 1), /size limit exceeded/);
	}
	await writeFile(compressed, "not zstd");
	await assert.rejects(historyFileMayMatch(compressed, createHistoryPrefilter(["needle"]), true, text.length));
	await assert.rejects(historyFileMayMatch(home, createHistoryPrefilter(["needle"]), true), /not a regular file/);
	await assert.rejects(historyFileMayMatch(join(home, "missing"), createHistoryPrefilter(["needle"])), /ENOENT/);
});

test("arbitrarily long backslash runs retain only bounded normalization input", async (t) => {
	const block = Buffer.alloc(64 * 1024, 92), count = 4096;
	let largest = 0, consumed = 0;
	const replace = RegExp.prototype[Symbol.replace];
	Object.defineProperty(RegExp.prototype, Symbol.replace, { value: function (this: RegExp, ...args: Parameters<typeof replace>) {
		largest = Math.max(largest, args[0].length);
		return replace.apply(this, args);
	} });
	t.after(() => { Object.defineProperty(RegExp.prototype, Symbol.replace, { value: replace }); });
	async function* run(suffix: string) {
		yield Buffer.from("n");
		for (let index = 0; index < count; index++) { consumed++; yield block; }
		yield Buffer.from(suffix);
	}
	assert.equal(await createHistoryPrefilter(["needle"])(run("u0065edle")), true);
	assert.equal(await createHistoryPrefilter(["needle"])(run("u00x5edle")), false);
	assert.equal(consumed * block.length, 512 * 1024 * 1024);
	assert.ok(largest <= block.length + 6, `largest normalization input: ${largest}`);
});

test("a large miss scans bounded strings rather than a complete transcript or line", async (t) => {
	const block = Buffer.alloc(64 * 1024, 120), count = 4096;
	let consumed = 0, largest = 0;
	const original = RegExp.prototype.test;
	t.mock.method(RegExp.prototype, "test", function (this: RegExp, text: string) {
		if (this.source === "absentword") largest = Math.max(largest, text.length);
		return original.call(this, text);
	});
	async function* large() {
		for (let index = 0; index < count; index++) { consumed++; yield block; }
	}
	assert.equal(await createHistoryPrefilter(["absentword"])(large()), false);
	assert.equal(consumed * block.length, 256 * 1024 * 1024);
	assert.ok(largest <= block.length + '"history_base"'.length, `largest regex input: ${largest}`);
});
