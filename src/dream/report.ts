import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gitCommit } from "./git.js";
import type { DreamWrite } from "./result.js";
import { errorMessage } from "../error-message.js";

function writeList(writes: DreamWrite[]): string {
	return writes.length ? writes.map((w) => `- ${w.tool}: ${w.path}`).join("\n") : "- no changes";
}

/** Best-effort filesystem step; returns the failure message instead of throwing. */
function attempt(action: () => void): string | undefined {
	try { action(); return undefined; }
	catch (error) { return errorMessage(error); }
}

/**
 * Close one dream: record the report, then run the final audit commit. The audit always
 * runs even when the report cannot be written, and a failed audit is appended to the
 * report (when it exists) as well as named on stderr, so neither failure hides the other.
 */
export function finishDream(home: string, stamp: string, reportPath: string, failed: boolean, body: string, writes: DreamWrite[]): number {
	const header = failed ? `# Dream ${stamp} (failed)` : `# Dream ${stamp}`;
	let reportError = attempt(() => { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, `${header}\n\n${body}\n\n${writeList(writes)}\n`); });
	const audit = gitCommit(home, `dream ${stamp}${failed ? " (failed)" : ""}`);
	if (!audit.ok) {
		console.error(`dream: final audit failed: ${audit.error}`);
		reportError ??= attempt(() => appendFileSync(reportPath, `\n## Final audit failed\n\n${audit.error}\n`));
	}
	if (reportError) console.error(`dream: could not write report at ${reportPath}: ${reportError}`);
	return failed || !audit.ok || reportError !== undefined ? 1 : 0;
}
