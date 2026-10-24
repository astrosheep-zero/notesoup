import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { notesList, notesRead, notesSearch, notesUpdate, notesWrite } from "../../../src/tools/notes.js";
import { historyList, historyRead, historyWindows, type HistoryTextWrapper } from "../../../src/tools/history.js";
import { readClaudeHistory, type ClaudeHistorySource } from "./history.js";
import { loadNotesSnapshot } from "../../../src/boot/snapshot.js";
import { renderBootBlock } from "../../../src/boot/render.js";
import type { BootToolNames } from "../../../src/boot/text.js";
import { selectContinuation } from "../../../src/budget/text.js";
import { claudeHistoryGapNotice, claudeHistoryUnconfirmedSeq, CLAUDE_HISTORY_UNKNOWN_PREVIOUS, CLAUDE_HISTORY_UNKNOWN_WINDOW, CLAUDE_HISTORY_UNAVAILABLE_SENTENCE, CLAUDE_WARNING_PROMPT } from "./text.js";
import { resolveClaudeLimits } from "./thresholds.js";
import { projectKey, snapshotNotesIdentity, type NotesIdentity } from "../../../src/notes/index.js";
import type { Operation } from "../../../src/tools/result.js";
import { notesToolContext, type NotesToolContext } from "../../../src/tools/notes-context.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
export type ClaudeIdentityInput = Readonly<{ home: string; sessionId: string; cwd: string; agent: string; model: string }>;
/** Only rendered text and success cross the helper boundary; business data stays inside. */
export type ClaudeToolResult = { text: string; ok: boolean };
type BoundOperation<TContext extends readonly unknown[]> = {
	readonly description: string;
	readonly parameters: TSchema;
	call(params: unknown, ...context: TContext): Promise<ClaudeToolResult>;
};

function identity(input: ClaudeIdentityInput): NotesIdentity {
	if (!input || typeof input !== "object" || typeof input.cwd !== "string") throw new Error("invalid identity");
	return snapshotNotesIdentity({ home: input.home, sessionId: input.sessionId, projectKey: projectKey(input.cwd, input.home), agent: input.agent, model: input.model });
}

/** The first schema violation, named by parameter so the model can fix that one field. */
function paramProblem(schema: TSchema, params: unknown): string {
	// A false subschema reports "schema is false"; its parent's additionalProperties error names the field instead.
	const first = Errors(schema, params).find((error) => error.keyword !== "boolean");
	if (!first) return "unrecognized shape";
	const extra = first.keyword === "additionalProperties" ? `: ${(first.params as { additionalProperties: string[] }).additionalProperties.join(", ")}` : "";
	const field = first.instancePath.replace(/^\//, "").replaceAll("/", ".");
	return `${field ? `${field} ` : ""}${first.message}${extra}`;
}

/** Bind shared execution/rendering to a host context; dispatch validates parameters before calling. */
function boundOperation<TParams extends TSchema, TData, TContext extends readonly unknown[]>(
	operation: Operation<TParams, TData, TContext>,
): BoundOperation<TContext> {
	return {
		description: operation.description,
		parameters: operation.parameters,
		async call(params, ...context) {
			// The same business outcome and the same renderer as the Pi tool; only the envelope differs.
			const outcome = await operation.execute(params as Static<TParams>, ...context);
			return { text: operation.render(outcome), ok: outcome.ok };
		},
	};
}

const OPERATIONS: Record<string, BoundOperation<[NotesToolContext]>> = {
	notes_write: boundOperation(notesWrite),
	notes_update: boundOperation(notesUpdate),
	notes_read: boundOperation(notesRead),
	notes_list: boundOperation(notesList),
	notes_search: boundOperation(notesSearch),
};

const HISTORY_OPERATIONS = {
	history_list: boundOperation(historyList),
	history_read: boundOperation(historyRead),
	history_windows: boundOperation(historyWindows),
};
function historySource(value: unknown, sessionId: string): ClaudeHistorySource {
	if (!value || typeof value !== "object") throw new Error("Claude history transcript_path is unavailable");
	const source = value as ClaudeHistorySource;
	if (source.sessionId !== sessionId) throw new Error("Claude history binding belongs to a different session");
	return source;
}

export async function dispatch(request: unknown): Promise<unknown> {
	if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("malformed request");
	const value = request as Record<string, unknown>;
	if (value.op === "schemas") return [...Object.entries(OPERATIONS), ...Object.entries(HISTORY_OPERATIONS)].map(([name, operation]) => ({ name, description: operation.description, inputSchema: JSON.parse(JSON.stringify(operation.parameters)) }));
	// The shared reset prose lives here, not in the sandboxed hooks module, so Pi and Claude
	// cannot drift apart. The hooks module caches one copy per session.
	if (value.op === "texts") return { warning: CLAUDE_WARNING_PROMPT, historyUnavailableSentence: CLAUDE_HISTORY_UNAVAILABLE_SENTENCE };
	// The caller draws once per artifact and caches the answer; text reads never draw.
	if (value.op === "continuation") {
		if (value.origin !== "normal" && value.origin !== "forced") throw new Error("invalid reset origin");
		return { text: selectContinuation(value.origin) };
	}
	// Threshold derivation crosses the boundary as raw facts: everything the engine could
	// read, unvalidated. resolveClaudeLimits guards every field and never throws.
	if (value.op === "limits") return resolveClaudeLimits(value.facts);
	if (value.op === "tool") {
		if (typeof value.tool !== "string" || (!Object.hasOwn(OPERATIONS, value.tool) && !Object.hasOwn(HISTORY_OPERATIONS, value.tool))) throw new Error("unknown tool");
		const operation = Object.hasOwn(OPERATIONS, value.tool) ? OPERATIONS[value.tool]! : HISTORY_OPERATIONS[value.tool as keyof typeof HISTORY_OPERATIONS];
		// Refuse before any operation can act: a rejected shape never reaches a write.
		if (!Check(operation.parameters, value.params)) throw new Error(`invalid ${value.tool} parameters: ${paramProblem(operation.parameters, value.params)}`);
		const id = identity(value.identity as ClaudeIdentityInput);
		if (Object.hasOwn(HISTORY_OPERATIONS, value.tool)) {
			const tool = value.tool as keyof typeof HISTORY_OPERATIONS;
			const projection = await readClaudeHistory(historySource(value.history, id.sessionId));
			const notice = claudeHistoryGapNotice(projection.missingAncestors);
			const wrapText: HistoryTextWrapper = (text) => notice + text;
			let params = value.params;
			if (projection.missingAncestors.length > 0) {
				// An unknown segment is not evidence for the window before the current
				// one. Resolve the exact ordinal, never array adjacency across a gap.
				if ((params as { window_id?: string }).window_id === "@previous") {
					const previous = projection.currentWindowOrdinal === undefined ? undefined : `claude:${id.sessionId}:${projection.currentWindowOrdinal - 1}`;
					if (!projection.windows.some((window) => window.windowId === previous)) {
						return { ok: false, text: wrapText(CLAUDE_HISTORY_UNKNOWN_PREVIOUS) };
					}
					params = { ...params as object, window_id: previous };
				}
				if (value.tool === "history_read") {
					const { seq } = params as { seq: number };
					if (seq <= projection.highestSeq && !projection.branchSeqs.has(seq)) {
						return { ok: false, text: wrapText(claudeHistoryUnconfirmedSeq(seq)) };
					}
				}
			}
			const result = tool === "history_windows"
				? await HISTORY_OPERATIONS[tool].call(params, projection, id.sessionId, wrapText)
				: await HISTORY_OPERATIONS[tool].call(params, projection, wrapText);
			return { ...result, text: wrapText(result.text) };
		}
		return OPERATIONS[value.tool]!.call(value.params, notesToolContext(id, (value.identity as ClaudeIdentityInput).cwd));
	}
	if (value.op === "history_state") {
		const id = identity(value.identity as ClaudeIdentityInput);
		const projection = await readClaudeHistory(historySource(value.history, id.sessionId));
		if (projection.currentWindowOrdinal === undefined) throw new Error(CLAUDE_HISTORY_UNKNOWN_WINDOW);
		return { window: projection.currentWindowOrdinal };
	}
	if (value.op === "boot") {
		const id = identity(value.identity as ClaudeIdentityInput);
		if (!value.tools || typeof value.tools !== "object") throw new Error("invalid boot tools");
		const window = value.window ?? 0;
		if (typeof window !== "number" || !Number.isSafeInteger(window) || window < 0) throw new Error("invalid context window");
		const snapshot = await loadNotesSnapshot(id, typeof value.openedAt === "number" ? value.openedAt : Date.now());
		const windowId = (index: number) => `claude:${id.sessionId}:${index}`;
		const trunk = `claude:${id.sessionId}`;
		const tree = { trunk, windows: Array.from({ length: window + 1 }, (_, index) => ({ shortName: String(index), isCurrent: index === window })) };
		const rendered = renderBootBlock({ agentName: id.agent, modelName: id.model, tree, notes: snapshot, tools: value.tools as BootToolNames });
		// Retained Claude boots are restored by their full current/previous ids.
		return `${rendered}\nCurrent context window id: ${windowId(window)}${window > 0 ? `\nPrevious context window id: ${windowId(window - 1)}` : ""}`;
	}
	throw new Error("unknown operation");
}
function safeError(error: unknown): string { return error instanceof Error && error.message ? error.message.replace(/[\r\n].*$/s, "") : "helper request failed"; }
export async function handleLine(line: string): Promise<string> {
	if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) return JSON.stringify({ ok: false, error: "request too large" });
	try { const result = await dispatch(JSON.parse(line)); const response = JSON.stringify({ ok: true, result }); return Buffer.byteLength(response, "utf8") <= MAX_RESPONSE_BYTES ? response : JSON.stringify({ ok: false, error: "response too large" }); }
	catch (error) { return JSON.stringify({ ok: false, error: safeError(error) }); }
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	process.stdin.setEncoding("utf8"); let input = "";
	process.stdin.on("data", (chunk) => { input += chunk; });
	process.stdin.on("end", async () => { process.stdout.write(`${await handleLine(input.trim())}\n`); });
}
