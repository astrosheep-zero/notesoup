#!/usr/bin/env node
import { finishDream } from "../../../src/dream/report.js";
import type { DreamerSetting } from "../../../src/dream/settings.js";
import type { DreamResult } from "../../../src/dream/result.js";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, failLock, lastRunPath, releaseLock } from "../../../src/dream/lock.js";
import { materialGate, timeGate } from "../../../src/dream/gates.js";
import { runDreamer, type DreamerSessionFactory } from "./runner.js";
import { gitCommit } from "../../../src/dream/git.js";
import { readDreamerSettings } from "./settings.js";
import { doctor } from "../../../src/dream/doctor.js";
import { notesRoot } from "../notes/adapter.js";
import { errorMessage } from "../../../src/error-message.js";

function args(argv: string[]) { const out: Record<string, string | boolean> = {}; for (let i=0;i<argv.length;i++) { const a=argv[i]!; if (a === "--force" || a === "--help") out[a.slice(2)] = true; else if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? ""; } return out; }

/** A positive whole-number flag, or undefined when the value is not one. */
function wholeNumberArg(raw: string | boolean | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A directory flag that must carry a real path, not a missing or flag-looking value. */
function directoryArg(raw: string | boolean | undefined): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" || raw.trim() === "" || raw.startsWith("--")) return undefined;
	return raw;
}
function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) { if (existsSync(join(dir, "package.json"))) return dir; const parent = dirname(dir); if (parent === dir) throw new Error("could not locate installed package root"); dir = parent; }
}

/** Injection seams used by tests; production uses the defaults. */
export type DreamDependencies = {
	sessionFactory?: DreamerSessionFactory;
	dreamerSettings?: (cwd?: string) => DreamerSetting;
	runDreamer?: typeof runDreamer;
};

export async function main(argv = process.argv.slice(2), deps: DreamDependencies = {}): Promise<number> {
	if (argv[0] === "doctor") {
		const options = args(argv.slice(1));
		if (options.help) { console.log("dream doctor [--notes-home <dir>] — read-only diagnostics; no model or repairs"); return 0; }
		const home = directoryArg(options["notes-home"]);
		if (options["notes-home"] !== undefined && home === undefined) { console.error("dream: --notes-home needs a directory path"); return 1; }
		const root = resolve(home ?? notesRoot());
		const issues = doctor(root);
		console.log(issues.length ? issues.join("\n") : `dream doctor: OK (${root})`);
		return issues.length ? 1 : 0;
	}
	const a = args(argv); if (a.help) { console.log("dream doctor [--notes-home <dir>] — read-only diagnostics\ndream --notes-home <dir> [--min-hours 24] [--min-sessions 3] [--force] [--dreamer <model pattern>] [--playbook <path>]\nDreamer model: --dreamer wins, else notesoup.dreamer from settings, else the automatic model. Default playbook: <installed package root>/playbook.md; --playbook overrides it."); return 0; }
	// Validate every value flag before anything is created or gated on: a typo must refuse
	// loudly instead of reading as "the last dream is too recent" and exiting successfully.
	const homeArg = directoryArg(a["notes-home"]);
	const minHours = wholeNumberArg(a["min-hours"]);
	const minSessions = wholeNumberArg(a["min-sessions"]);
	const badArg = a["notes-home"] !== undefined && homeArg === undefined ? "--notes-home needs a directory path"
		: a["min-hours"] !== undefined && minHours === undefined ? "--min-hours needs a positive whole number"
		: a["min-sessions"] !== undefined && minSessions === undefined ? "--min-sessions needs a positive whole number"
		: undefined;
	if (badArg) { console.error(`dream: ${badArg}`); return 1; }
	const home = resolve(homeArg ?? notesRoot()); process.env.PI_NOTES_HOME = home; mkdirSync(home, { recursive: true });
	const lockPath = join(home, ".dream.lock"); const stampPath = lastRunPath(lockPath);
	const time = timeGate(stampPath, minHours ?? 24); console.log(time.reason); if (!a.force && !time.ok) return 0;
	const since = existsSync(stampPath) ? statSync(stampPath).mtimeMs : 0;
	const material = materialGate(home, since, minSessions ?? 3); console.log(material.reason); if (!a.force && !material.ok) return 0;
	let lock; try { lock = acquireLock(lockPath); } catch (e) { console.log(`lock gate: ${errorMessage(e)}`); return 0; } if (!lock.held) { console.log(lock.reason); return 0; }
	const stamp = new Date(lock.startedAt).toISOString().replace(/[:.]/g, "-"); const reportPath = join(home, "dreams", `${stamp}.md`);
	let succeeded = false;
	try {
		// CLI --dreamer wins over settings; settings win over the automatic model fallback.
		let modelPattern: string | undefined;
		if (a.dreamer) modelPattern = String(a.dreamer);
		else {
			const settings = (deps.dreamerSettings ?? readDreamerSettings)();
			for (const warning of settings.warnings) console.error(warning);
			modelPattern = settings.pattern;
		}

		// The baseline snapshot is required: without it the human gate has nothing to inspect.
		const baseline = gitCommit(home, `baseline ${stamp}`);
		if (!baseline.ok) { console.error(`dream: baseline audit failed: ${baseline.error}`); return 1; }

		const defaultBook = join(packageRoot(), "playbook.md");
		const playbookPath = String(a.playbook ?? defaultBook);
		let result: DreamResult;
		try {
			const playbook = readFileSync(playbookPath, "utf8");
			result = await (deps.runDreamer ?? runDreamer)(playbook, home, { modelPattern, sessionFactory: deps.sessionFactory });
		} catch (e) {
			const message = errorMessage(e);
			console.error(message);
			return finishDream(home, stamp, reportPath, true, message, []);
		}
		if (result.error) {
			console.error(result.error);
			return finishDream(home, stamp, reportPath, true, result.error, result.writes);
		}
		const code = finishDream(home, stamp, reportPath, false, result.report, result.writes);
		if (code === 0) { succeeded = true; console.log(reportPath); }
		return code;
	} finally {
		// Only the holder's own lock is released; a successor's lock is never touched.
		if (succeeded) releaseLock(lock); else failLock(lock);
	}
}

function isEntryPoint(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try { return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isEntryPoint()) main().then((code) => { process.exitCode = code; });
