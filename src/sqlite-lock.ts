/** The open transaction is the lock. Never unlink the database, even after a crash. */
export function trySqliteLock(path: string, waitMs: 0 | 5000): (() => void) | undefined {
	const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
	if (!sqlite?.DatabaseSync) throw new Error("Notesoup locks require built-in node:sqlite (Node 22.13+).");
	const db = new sqlite.DatabaseSync(path);
	try {
		db.exec(`PRAGMA busy_timeout = ${waitMs}; BEGIN IMMEDIATE`);
	} catch (error) {
		db.close();
		if (error instanceof Error && "errcode" in error && error.errcode === 5) return undefined; // SQLITE_BUSY
		throw error;
	}
	return () => db.close(); // Closing rolls back the empty transaction.
}
