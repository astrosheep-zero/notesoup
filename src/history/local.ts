/** Local read-only corpus. Wire decoders have no SDK dependencies; DSH supplies its query service. */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { piHistoryFromJsonl } from "./pi.js";
import { claudeHistoryFromJsonl, offlineClaudeHead } from "./claude.js";
import { readCodexHistory } from "./codex.js";
import { sessionIdentity, type HistoryCorpus, type HistoryHarness, type HistorySession, type HistorySessionData } from "./corpus.js";

export type LocalHistoryRoots = Partial<Record<"pi" | "claude" | "codex", string | null>>;
export type LocalHistoryOptions = {
	current: { harness: HistoryHarness; id: string; load(): Promise<HistorySessionData> };
	/** Undefined uses the harness default; null disables that harness's filesystem discovery. */
	roots?: LocalHistoryRoots;
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Available only inside DSH; descriptors load through ctx.sessionQuery.readSession. */
	dshSessions?: () => Promise<HistorySession[]>;
};

function rootsFor(options: LocalHistoryOptions): LocalHistoryRoots {
	const env = options.env ?? process.env;
	const home = options.home ?? env.HOME ?? homedir();
	return {
		pi: options.roots?.pi !== undefined ? options.roots.pi : env.NOTESOUP_HISTORY_PI_ROOT ?? join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "sessions"),
		claude: options.roots?.claude !== undefined ? options.roots.claude : env.NOTESOUP_HISTORY_CLAUDE_ROOT ?? join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects"),
		codex: options.roots?.codex !== undefined ? options.roots.codex : env.NOTESOUP_HISTORY_CODEX_ROOT ?? join(env.CODEX_HOME ?? join(home, ".codex"), "sessions"),
	};
}

/** Match the native layouts, without following symlinks or wandering into subagent/attachment stores. */
async function filesAt(root: string, depth: number): Promise<string[]> {
	let entries;
	try { entries = await readdir(root, { withFileTypes: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const paths: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory() && depth > 0) paths.push(...await filesAt(path, depth - 1));
		else if (entry.isFile() && depth === 0) paths.push(path);
	}
	return paths;
}

async function localSessions(harness: "pi" | "claude" | "codex", root: string): Promise<HistorySession[]> {
	const paths = await filesAt(root, harness === "codex" ? 3 : 1);
	const sessions: HistorySession[] = [];
	for (const path of paths) {
		const name = path.split(/[\\/]/).at(-1)!;
		const id = harness === "pi" ? /^.+_(.+)\.jsonl$/.exec(name)?.[1]
			: harness === "claude" ? /^(.+)\.jsonl$/.exec(name)?.[1]
			: /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/.exec(name)?.[1];
		if (!id) continue;
		let modifiedAt: number;
		try { modifiedAt = (await stat(path)).mtimeMs; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		sessions.push({
			harness, id, modifiedAt,
			async load() {
				if (harness === "codex") return { projection: (await readCodexHistory({ threadId: id, transcriptPath: path })).projection };
				const text = await readFile(path, "utf8");
				if (harness === "pi") return { projection: piHistoryFromJsonl(text, id) };
				const projection = claudeHistoryFromJsonl(text, { sessionId: id, headUuid: offlineClaudeHead(text) });
				const missing = projection.missingAncestors;
				return { projection, ...(missing.length === 0 ? {} : { notice: `Claude history is incomplete: missing ancestor UUID(s): ${missing.slice(0, 5).map((uuid) => JSON.stringify(uuid.slice(0, 160))).join(", ")}. Only confirmed ancestry is returned; disconnected prefixes are excluded.\n\n` }) };
			},
		});
	}
	return sessions;
}

/** Fresh discovery per call; a live binding wins over its persisted descriptor. No transcript writes. */
export function localHistoryCorpus(options: LocalHistoryOptions): HistoryCorpus {
	return {
		currentHarness: options.current.harness,
		async sessions(onlyHarness) {
			const roots = rootsFor(options);
			const discovered: HistorySession[] = [];
			for (const harness of ["pi", "claude", "codex"] as const) {
				if (onlyHarness !== undefined && onlyHarness !== harness) continue;
				const root = roots[harness];
				if (root != null) discovered.push(...await localSessions(harness, root));
			}
			if (options.dshSessions && (onlyHarness === undefined || onlyHarness === "dsh")) discovered.push(...await options.dshSessions());
			discovered.sort((a, b) => b.modifiedAt - a.modifiedAt || sessionIdentity(a).localeCompare(sessionIdentity(b)));
			const unique = new Map<string, HistorySession>();
			for (const session of discovered) if (!unique.has(sessionIdentity(session))) unique.set(sessionIdentity(session), session);
			const current = { ...options.current, modifiedAt: Date.now() };
			if (onlyHarness === undefined || onlyHarness === current.harness) unique.set(sessionIdentity(current), current);
			return [...unique.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || sessionIdentity(a).localeCompare(sessionIdentity(b)));
		},
	};
}
