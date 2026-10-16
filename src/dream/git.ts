import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "../error-message.js";

/**
 * Outcome of one audit commit. `ok: true` always carries a real `commit` snapshot;
 * `empty: true` only means no files changed (an empty baseline commit or no commit was
 * needed). `ok: false` means the audit layer could not guarantee a snapshot.
 */
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

/**
 * Git audit layer for a dream: one commit at dream_begin (baseline) and one at dream_end,
 * so the human reviews `git show` instead of trusting a report, and rollback is `git revert`. The caller decides how loud a failure is; this function only reports it.
 * A clean tree on an established repository commits nothing; a repository with no HEAD
 * gets an empty baseline commit, because an audit run with no snapshot is not a success.
 */
export function gitCommit(home: string, message: string): AuditResult {
	try {
		if (!existsSync(join(home, ".git"))) {
			execFileSync("git", ["init", "-q"], { cwd: home, stdio: "ignore" });
		}
		ensureRuntimeIgnored(home);
		execFileSync("git", ["add", "-A"], { cwd: home, stdio: "ignore" });
		let clean = false;
		try {
			execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: home, stdio: "ignore" });
			clean = true; // clean tree — no empty commit on an established repository
		} catch { clean = false; }
		const before = headCommit(home);
		if (!clean) {
			execFileSync("git", ["commit", "-q", "-m", message], { cwd: home, stdio: "ignore" });
		} else if (before === undefined) {
			// A newly initialized repository has no snapshot at all; give the audit one.
			execFileSync("git", ["commit", "-q", "--allow-empty", "-m", message], { cwd: home, stdio: "ignore" });
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
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: home, encoding: "utf8" }).trim();
		return head.length > 0 ? head : undefined;
	} catch { return undefined; }
}
