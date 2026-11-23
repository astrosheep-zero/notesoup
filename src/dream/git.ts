import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "../error-message.js";

/** A successful audit always names a real snapshot, even when the tree was already clean. */
export type AuditResult =
	| { ok: true; commit: string; empty: boolean }
	| { ok: false; error: string };

/** Lock runtime artifacts are not notes and must not appear in snapshots or `git status`. */
const RUNTIME_IGNORE = ["/.dream.lock*", "/.project-claim.sqlite", "/.project-claim.sqlite-*", "/.project-pending-*/"];

/** Install root-only excludes before staging; fail the audit rather than snapshot runtime files. */
function ensureRuntimeIgnored(home: string): void {
	const exclude = join(home, ".git", "info", "exclude");
	const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
	const lines = new Set(current.split(/\r?\n/));
	const missing = RUNTIME_IGNORE.filter(pattern => !lines.has(pattern));
	if (!missing.length) return;
	mkdirSync(dirname(exclude), { recursive: true });
	const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
	appendFileSync(exclude, prefix + missing.join("\n") + "\n");
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
