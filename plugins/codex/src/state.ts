/** Native Codex facts shared by hook boot and MCP history; no second parser and no invented window. */
import { DEFAULT_BOOT_TOOL_NAMES } from "../../../src/boot/text.js";
import { renderBootBlock, type BootWindowTree } from "../../../src/boot/render.js";
import type { NotesSnapshot } from "../../../src/boot/snapshot.js";
import { readCodexTranscript, type CodexRecord, type CodexTranscriptSource, type CodexTranscriptState } from "./transcript.js";
import { CODEX_PRE_RESET_HINTS, CODEX_WIPE_SENTENCE } from "./text.js";

export type CodexSource = CodexTranscriptSource;

/** The one marker that makes a persisted notesoup boot verifiable in a native window. */
export function bootMarker(threadId: string, windowId: string): string {
	return `<notesoup:codex_window>\nthread: ${threadId}\nwindow: ${windowId}\n</notesoup:codex_window>`;
}

function nativeText(record: CodexRecord): string {
	const payload = record.payload;
	if (record.type !== "response_item" || payload.type !== "message" || payload.role !== "developer") return "";
	const content = payload.content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part !== "object" || part === null) return "";
		const value = part as Record<string, unknown>;
		return value.type === "input_text" && typeof value.text === "string" ? value.text : "";
	}).join("\n");
}

/** Only the host's own hook additionalContext record is boot evidence, never a quoted marker. */
function isHookBoot(record: CodexRecord): boolean {
	const payload = record.payload;
	if (record.type !== "response_item" || payload.type !== "message" || payload.role !== "developer") return false;
	const metadata = payload.internal_chat_message_metadata_passthrough;
	if (typeof metadata !== "object" || metadata === null) return false;
	const kinds = (metadata as Record<string, unknown>).content_item_kinds;
	return Array.isArray(kinds) && kinds.includes("hooks.additional_context");
}

/** Does this exact native window already carry this thread's own host-injected notesoup boot? */
export function findRecordedBoot(records: readonly CodexRecord[], threadId: string, nativeWindowId: string): boolean {
	const marker = bootMarker(threadId, nativeWindowId);
	return records.some((record) =>
		record.owner === threadId
		&& record.windowId === nativeWindowId
		&& isHookBoot(record)
		&& nativeText(record).includes(marker));
}

/** Native windows in append order; seq ranges are omitted rather than approximated from raw records. */
function nativeTree(threadId: string, state: CodexTranscriptState, records: readonly CodexRecord[]): BootWindowTree {
	const ids: string[] = [];
	for (const record of records) {
		if (record.windowId !== undefined && !ids.includes(record.windowId)) ids.push(record.windowId);
	}
	if (state.currentWindowId !== undefined && !ids.includes(state.currentWindowId)) ids.push(state.currentWindowId);
	return {
		trunk: `codex:${threadId}`,
		// The native window UUID is the short name, so the shared `trunk:shortname` rule
		// yields the exact `codex:<thread>:<window>` address history tools serve.
		windows: ids.map((id) => ({ shortName: id, isCurrent: id === state.currentWindowId })),
	};
}

/** Boot text is the shared snapshot plus a native window marker; nothing is fabricated without facts. */
export function renderCodexBoot(input: {
	threadId: string;
	agent: string;
	model: string;
	state: CodexTranscriptState;
	records: readonly CodexRecord[];
	notes: NotesSnapshot;
}): string {
	const { threadId, state } = input;
	const rendered = renderBootBlock({
		agentName: input.agent,
		modelName: input.model,
		tree: nativeTree(threadId, state, input.records),
		notes: input.notes,
		tools: {
			...DEFAULT_BOOT_TOOL_NAMES,
			wipe: "new_context",
			wipeSentence: CODEX_WIPE_SENTENCE,
			preResetHints: CODEX_PRE_RESET_HINTS,
		},
	});
	// A boot without native window facts would be a fabricated tree, so this marker is required.
	return state.currentWindowId === undefined ? rendered : `${rendered}\n\n${bootMarker(threadId, state.currentWindowId)}`;
}

/** One parser and one validation point for both the boot and its dedupe evidence. */
export async function readStartState(source: CodexSource): Promise<{ state: CodexTranscriptState; records: CodexRecord[] }> {
	const result = await readCodexTranscript(source);
	if (result.state.threadId !== source.threadId) throw new Error("Codex transcript belongs to another thread; no notesoup data was used.");
	if (result.state.rootSessionId === "") throw new Error("Codex transcript has no root session attribution.");
	return result;
}

/** A second read after slow work catches a compact/reset that moved the window mid-boot. */
export async function recheckStartState(source: CodexSource, expected: CodexTranscriptState): Promise<void> {
	const result = await readCodexTranscript(source);
	if (result.state.threadId !== expected.threadId || result.state.rootSessionId !== expected.rootSessionId || result.state.currentWindowId !== expected.currentWindowId) {
		throw new Error("the native window changed while notesoup was preparing its boot; no stale snapshot was injected.");
	}
}
