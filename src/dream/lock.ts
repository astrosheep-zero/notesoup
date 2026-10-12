import { randomUUID } from "node:crypto";
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";

export type LockState = {
	path: string;
	held: boolean;
	reason?: string;
	startedAt: number;
	/** mtime of the last-run sidecar before this run took the lock; failLock restores it. */
	priorStampMtime?: number;
	/** Random identity written into the lock file; cleanup only removes the lock it wrote. */
	token?: string;
};

/**
 * The scheduler's last-run timestamp lives in a sidecar beside the lock, never in the
 * lock file itself: acquiring, releasing or cleaning up the lock touches only the PID
 * marker, so lock lifecycle does not destroy the timestamp the time gate reads.
 */
export function lastRunPath(lockPath: string): string {
	return `${lockPath}.last-run`;
}

function readText(path: string): string | undefined {
	try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function ownsLock(lock: LockState): boolean {
	if (!lock.held || !lock.token) return false;
	return readText(lock.path)?.trim() === `${process.pid} ${lock.token}`;
}

/**
 * Acquire the dream lock with Git-style exclusive existence locking: one O_CREAT|O_EXCL
 * creation. An existing path refuses acquisition regardless of its contents, PID, or age,
 * and is never read for permission, replaced, or removed. There is no automatic stale
 * recovery; a crash-left lock is human cleanup after confirming no dream is running.
 */
export function acquireLock(path: string): LockState {
	const now = Date.now();
	// The sidecar's mtime is the scheduler's timestamp; a missing one means no prior dream.
	let priorStampMtime: number | undefined;
	try { priorStampMtime = statSync(lastRunPath(path)).mtimeMs; } catch { /* no sidecar yet */ }
	const token = randomUUID();
	try {
		writeFileSync(path, `${process.pid} ${token}`, { flag: "wx" });
	} catch {
		return { path, held: false, reason: "lock gate: lock already exists", startedAt: now };
	}
	// Only a held lock advances the scheduler timestamp.
	try { writeFileSync(lastRunPath(path), new Date(now).toISOString()); } catch { /* advisory */ }
	return { path, held: true, startedAt: now, priorStampMtime, token };
}

/** Release only the lock this run acquired. Idempotent: repeated cleanup does nothing. */
export function releaseLock(lock: LockState): void {
	if (!lock.held) return;
	if (ownsLock(lock)) { try { unlinkSync(lock.path); } catch { /* best effort */ } }
	lock.held = false;
}

/**
 * A failed run must not advance the scheduler: restore the previous timestamp, or remove
 * the one this run wrote when there was none. Only this run's own marker is removed, and
 * the state is marked released so a later cleanup attempt is harmless.
 */
export function failLock(lock: LockState): void {
	if (!lock.held) return;
	if (ownsLock(lock)) {
		const stampPath = lastRunPath(lock.path);
		if (lock.priorStampMtime === undefined) { try { unlinkSync(stampPath); } catch { /* best effort */ } }
		else { try { utimesSync(stampPath, new Date(), new Date(lock.priorStampMtime)); } catch { /* best effort */ } }
		try { unlinkSync(lock.path); } catch { /* best effort */ }
	}
	lock.held = false;
}
