/** A read-only history corpus: identity/discovery is separate from loading a projection. */
import { failure, success, type Outcome } from "../tools/result.js";
import type { HistoryProjection } from "./history.js";

export type HistoryHarness = "pi" | "claude" | "codex" | "dsh";
export type HistorySessionData = { projection: HistoryProjection; notice?: string };
export type HistorySession = {
	harness: HistoryHarness;
	id: string;
	modifiedAt: number;
	load(): Promise<HistorySessionData>;
};
export type HistoryCorpus = {
	currentHarness: HistoryHarness;
	sessions(harness?: HistoryHarness): Promise<HistorySession[]>;
};
/** A lazy current projection preserves native host checks, without requiring it for a foreign read. */
export type HistoryContext = HistoryProjection | { current(): HistoryProjection | Promise<HistoryProjection>; corpus: HistoryCorpus };
export type SessionSelector = { harness?: HistoryHarness; id: string; wildcard: boolean };
const HARNESSES = new Set<string>(["pi", "claude", "codex", "dsh"]);

export function sessionIdentity(session: Pick<HistorySession, "harness" | "id">): string {
	return `${session.harness}:${session.id}`;
}

export function parseSessionSelector(value: string): Outcome<SessionSelector> {
	const colon = value.indexOf(":");
	const harness = colon < 0 ? undefined : value.slice(0, colon);
	const id = colon < 0 ? value : value.slice(colon + 1);
	if (id.length === 0 || id.includes(":") || (harness !== undefined && !HARNESSES.has(harness))) {
		return failure("invalid_session", "Pass a session ID or prefix, optionally prefixed by pi:, claude:, codex:, or dsh:.");
	}
	return success({ ...(harness === undefined ? {} : { harness: harness as HistoryHarness }), id, wildcard: id.includes("*") });
}

/** '*' is the only metacharacter; all other characters match literally. */
export function matchesSession(session: HistorySession, selector: SessionSelector): boolean {
	if (selector.harness !== undefined && selector.harness !== session.harness) return false;
	const escaped = selector.id.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${escaped}$`).test(session.id);
}

export async function resolveSession(corpus: HistoryCorpus | undefined, selector: SessionSelector): Promise<Outcome<HistorySession>> {
	if (corpus === undefined) return failure("unknown_session", "This host supplied no cross-session history corpus.");
	const matching = (pool: HistorySession[]) => {
		const exact = pool.filter((session) => session.id === selector.id);
		return exact.length ? exact : pool.filter((session) => session.id.startsWith(selector.id));
	};
	let matches: HistorySession[];
	if (selector.harness !== undefined) matches = matching((await corpus.sessions(selector.harness)).filter((session) => session.harness === selector.harness));
	else {
		matches = matching((await corpus.sessions(corpus.currentHarness)).filter((session) => session.harness === corpus.currentHarness));
		if (matches.length === 0) matches = matching((await corpus.sessions()).filter((session) => session.harness !== corpus.currentHarness));
	}
	if (matches.length === 0) return failure("unknown_session", `No local session matches ${JSON.stringify(selector.harness ? `${selector.harness}:${selector.id}` : selector.id)}.`);
	if (matches.length > 1) return failure("ambiguous_session", `Session selector is ambiguous: ${matches.slice(0, 5).map(sessionIdentity).join(", ")}${matches.length > 5 ? ` (${matches.length - 5} more)` : ""}. Pass a longer ID or a harness-qualified ID.`);
	return success(matches[0]!);
}

export async function loadHistorySession(session: HistorySession): Promise<Outcome<HistorySessionData>> {
	try { return success(await session.load()); }
	catch (error) {
		return failure("history_unavailable", `Cannot read session ${sessionIdentity(session)}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function currentHistory(context: HistoryContext): HistoryProjection | Promise<HistoryProjection> {
	return "current" in context ? context.current() : context;
}
