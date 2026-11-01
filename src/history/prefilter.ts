/** Conservative streaming proof-of-miss. A possible hit still needs the normal strict decoder. */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import * as zlib from "node:zlib";
import { CODEX_TRANSCRIPT_MAX_BYTES } from "./codex-transcript.js";

const PRESENTATION = `Codex unknown arguments not recorded output nested calls complete incomplete terminal ms image audio items null
	copied subagent inference prefix omitted child-local history starts at native ordinal copied model context
	does not prove original parent event addresses compaction boundary replacement_history is an inference checkpoint
	not new conversation events opaque content omitted not recovered plaintext MCP completion without a recorded raw call
	FunctionCallOutput display without raw output encrypted content unavailable world_state snapshot patch omitted from
	the text projection not a newly spoken message native structured retained context not newly spoken dialogue`;
const HISTORY_BASE = '"history_base"';
export type HistoryPrefilter = (chunks: AsyncIterable<Uint8Array>, codex?: boolean) => Promise<boolean>;

/** Compile literal Unicode case matching once, then keep only per-file token bits and a bounded tail. */
export function createHistoryPrefilter(queries: readonly string[]): HistoryPrefilter {
	let overlap = HISTORY_BASE.length;
	const alternatives = queries.map((query) => (query.match(/[\p{L}\p{N}_-]+/gu) ?? []).flatMap((token) => {
		const parts = /^\d+ms$/iu.test(token) ? [token.slice(0, -2), "ms"] : [token];
		return parts.map((part) => {
			overlap = Math.max(overlap, part.length);
			return new RegExp(part, "iu");
		}).filter((literal) => !literal.test(PRESENTATION));
	}));
	// No safe tokens (or generated text alone) cannot prove a miss.
	const fallback = !alternatives.length || alternatives.some((tokens) => tokens.length === 0);
	return async (chunks, codex = false) => {
		const decoder = new StringDecoder("utf8");
		const seen = alternatives.map((tokens) => tokens.map(() => false));
		let rawTail = "", normalizedTail = "", pending = "", possible = fallback;
		// Unlike /\\+u(hex{4})/, this cannot backtrack quadratically over a long invalid run.
		const escapes = /\\+(?:u([0-9a-fA-F]{0,4}))?/g;
		const scan = (chunk: string, final = false) => {
			const raw = rawTail + chunk, source = pending + chunk;
			const needsNormalization = pending.length > 0 || chunk.includes("\\u") || chunk.endsWith("\\");
			pending = "";
			const decoded = needsNormalization ? source.replace(escapes, (match, hex: string | undefined, offset: number) => {
				if (hex?.length === 4) return String.fromCharCode(Number.parseInt(hex, 16));
				// Tokens cannot include backslashes: an unresolved run needs only one separator,
				// plus at most 'u' and three hex digits, even if it spans arbitrarily many chunks.
				const literal = hex === undefined ? "\\" : `\\u${hex}`;
				if (!final && offset + match.length === source.length) { pending = literal; return ""; }
				return literal;
			}) : chunk;
			const normalized = decoded === chunk && normalizedTail === rawTail ? raw : normalizedTail + decoded;
			if (codex && raw.includes(HISTORY_BASE)) possible = true;
			else possible = alternatives.some((tokens, index) => {
				const bits = seen[index]!;
				for (let token = 0; token < tokens.length; token++) bits[token] ||= tokens[token]!.test(raw) || (normalized !== raw && tokens[token]!.test(normalized));
				return bits.every(Boolean);
			});
			rawTail = raw.slice(-overlap);
			normalizedTail = normalized.slice(-overlap);
		};
		for await (const chunk of chunks) if (!possible) scan(decoder.write(chunk));
		if (!possible) scan(decoder.end(), true);
		return possible;
	};
}

/** The byte budget comes from the strict Codex reader; Pi/Claude have no such native limit. */
export async function historyFileMayMatch(path: string, prefilter: HistoryPrefilter, codex = false, maxBytes = codex ? CODEX_TRANSCRIPT_MAX_BYTES : Infinity): Promise<boolean> {
	if (codex) {
		const info = await stat(path);
		if (!info.isFile() || info.size > maxBytes) throw new Error("Unavailable Codex transcript: read size limit exceeded or not a regular file");
	}
	// Native Codex compression is zstd; no decoded file or full Buffer is materialized.
	const compressed = codex && path.endsWith(".jsonl.zst");
	if (compressed && typeof zlib.createZstdDecompress !== "function") throw new Error("Compressed Codex rollouts require Node >=22.15 (createZstdDecompress)");
	const input = createReadStream(path);
	const consume = async (chunks: AsyncIterable<Buffer>) => {
		let size = 0;
		async function* bounded() {
			for await (const chunk of chunks) {
				size += chunk.length;
				if (size > maxBytes) throw new Error("Unavailable Codex transcript: decoded size limit exceeded");
				yield chunk;
			}
		}
		return prefilter(bounded(), codex);
	};
	return compressed ? pipeline(input, zlib.createZstdDecompress(), consume) : pipeline(input, consume);
}
