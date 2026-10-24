import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "../error-message.js";

/** A successful audit always names a real snapshot, even when the tree was already clean. */
export type AuditResult =
	| { ok: true; commit: string; empty: boolean }
	| { ok: false; error: string };

/** Lock runtime artifacts are not notes and must not appear in snapshots or `git status`. */
const RUNTIME_IGNORE = ".dream.lock*";

/** Add the runtime-artifact pattern to the repository's local exclude, once. */
function ensureRuntimeIgnored(home: string): void {
	try {
		const exclude = join(home, ".git", "info", "exclude");
		const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
		if (current.split(/\r?\n/).includes(RUNTIME_IGNORE)) return;
		mkdirSync(dirname(exclude), { recursive: true });
		const prefix = current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current;
		writeFileSync(exclude, `${prefix}${RUNTIME_IGNORE}\n`);
	} catch { /* best effort: an unignored lock only adds noise to the audit */ }
}

/** Snapshot at begin and end; a repository without HEAD gets an empty baseline commit. */
export function gitCommit(home: string, message: string): AuditResult {
	try {
		if (!existsSync(join(home, ".git"))) {
			execFileSync("git", ["init", "-q"], { cwd: home, stdio: "ignore" });
		}
		ensureRuntimeIgnored(home);
		execFileSync("git", ["add", "-A"], { cwd: home, stdio: "ignore" });
		const clean = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: home, stdio: "ignore" }).status === 0;
		if (!clean || headCommit(home) === undefined) {
			execFileSync("git", ["commit", "-q", ...(clean ? ["--allow-empty"] : []), "-m", message], { cwd: home, stdio: "ignore" });
		}
		const commit = headCommit(home);
		if (commit === undefined) return { ok: false, error: "audit commit produced no snapshot (no HEAD)" };
		return { ok: true, commit, empty: clean };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

/** HEAD sha, or undefined when the repository has no commit yet. */
function headCommit(home: string): string | undefined {
	try {
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return head.length > 0 ? head : undefined;
	} catch { return undefined; }
}
