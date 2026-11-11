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

test("raw and one-pass Unicode-unescaped matching agree across every byte split", async () => {
	// true is a conservative "may match" (the strict decoder still decides); false is a proven miss.
	const cases: [text: string, queries: string[], expected: boolean][] = [
		// `\u006e` decodes to n; the raw escape text is searchable too.
		[String.raw`{"text":"\u006eeedle"}`, ["needle"], true],
		[String.raw`{"text":"\u006eeedle"}`, ["u006eeedle"], true],
		[String.raw`{"text":"\u006eeedle"}`, ["needle u006eeedle"], true],
		// Queries are OR; every token in one query is required.
		[String.raw`{"text":"\u006eeedle"}`, ["absentword", "needle"], true],
		[String.raw`{"text":"\u006eeedle"}`, ["needle absentword"], false],
		// Case folding applies to raw and decoded text alike.
		[String.raw`NEE\u0044LE LONG\u017f CASE\u03a3`, ["needle longs caseς"], true],
		[String.raw`\uD801\uDC00needle`, ["𐐨needle"], true],
		[String.raw`\uD801\uDC00needle`, ["ud801 𐐨needle"], true],
		// Decoding is one pass: producing a backslash does not re-open the following escape.
		[String.raw`\u005cu006eeedle`, ["needle"], false],
		[String.raw`\u005c\u0075\u0030\u0030\u0036\u0065eedle`, ["needle"], false],
		// Two raw backslashes plus an escape decode to one character.
		[String.raw`prefix\\u006eeedle`, ["prefixneedle"], true],
		[String.raw`\u006e\\u0065edle`, ["needle"], true],
		[String.raw`{"arguments":"{\"path\":\"\\u006eeedle\"}"}`, ["needle"], true],
		// Incomplete escapes stay literal; raw hex remains a possible literal hit.
		[String.raw`\u00xz needle\u00`, ["needle u00"], true],
		[String.raw`need\u00xzle`, ["needle"], false],
		[String.raw`\u006e\u00xz`, ["nu00xz"], false],
		[String.raw`\u006e\u00xz`, ["u00xz"], true],
		[String.raw`\u006e\u00`, ["u00"], true],
		// A trailing backslash is flushed as a literal, never merged into a query token.
		[String.raw`\u006e` + "\\", ["absentword"], false],
		// Uppercase `U` is not an escape marker.
		[String.raw`\U006eeedle`, ["needle"], false],
		["LONGſ CASEΣ 你好", ["longs caseς 你好"], true],
	];
	for (const [text, queries, expected] of cases) {
		const bytes = Buffer.from(text), plan = createHistoryPrefilter(queries);
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
