import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One held dream lock; only the holder that wrote the token removes it. */
export type DreamLock = { path: string; token: string };

/** The per-project lock file in the notes home; `.dream.lock*` is excluded from the Git audit. */
export function dreamLockPath(home: string, project: string): string {
	return join(home, `.dream.lock.${project}`);
}

/**
 * Git-style exclusive existence lock: one O_CREAT|O_EXCL creation. An existing lock refuses,
 * whatever its age; a crash-left lock is removed by hand after confirming no dream runs.
 */
export function acquireDreamLock(path: string): DreamLock | undefined {
	const token = `${process.pid} ${randomUUID()}`;
	try { writeFileSync(path, token, { flag: "wx" }); } catch { return undefined; }
	return { path, token };
}

/** Release only a lock this holder wrote; repeated release is harmless. */
export function releaseDreamLock(lock: DreamLock): void {
	try {
		if (readFileSync(lock.path, "utf8") === lock.token) unlinkSync(lock.path);
	} catch { /* already gone */ }
}
