import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { acquireLock, releaseLock } from "../src/dream/lock.js";
import { dreamerDeleteToolDefinition, dreamerWriteToolDefinitions, type DreamerSession, type DreamerSessionFactory } from "../plugins/pi/dream/runner.js";
import { main } from "../plugins/pi/dream/cli.js";

const fixture = () => mkdtempSync(join(tmpdir(), "dream-test-"));

function scriptedSession(run: (handler: (event: any) => void, cwd: string) => void): DreamerSessionFactory {
	return async ({ cwd }) => {
		let handler: (event: any) => void = () => {};
		const session: DreamerSession = {
			subscribe(next) { handler = next; return () => {}; },
			async prompt() { run(handler, cwd); },
			dispose() {},
		};
		return session;
	};
}

async function captureErrors(run: () => Promise<number>): Promise<{ code: number; errors: string[] }> {
	const errors: string[] = [];
	const original = console.error;
	console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
	try { return { code: await run(), errors }; } finally { console.error = original; }
}

test("dream lock refuses existing owners and preserves ownership", () => {
	const home = fixture();
	const lock = join(home, ".dream.lock");
	writeFileSync(lock, "999999 dead-owner");
	const refused = acquireLock(lock);
	assert.equal(refused.held, false);
	assert.equal(refused.reason, "lock gate: lock already exists");
	assert.equal(readFileSync(lock, "utf8"), "999999 dead-owner");

	rmSync(lock);
	const held = acquireLock(lock);
	assert.equal(held.held, true);
	const contender = acquireLock(lock);
	assert.equal(contender.held, false);
	assert.equal(readFileSync(lock, "utf8").trim(), `${process.pid} ${held.token}`);
	writeFileSync(lock, "123 other-owner");
	releaseLock(held);
	assert.equal(readFileSync(lock, "utf8"), "123 other-owner", "release cannot remove a replacement owner");
	const own = acquireLock(lock);
	assert.equal(own.held, false);
	rmSync(lock);
	const released = acquireLock(lock);
	assert.equal(released.held, true);
	releaseLock(released);
	assert.equal(existsSync(lock), false, "release removes the lock this run owns");
});

test("dreamer writes stay inside the notes home, including symlink escapes", async () => {
	const home = fixture();
	const outside = fixture();
	const tools = new Map(dreamerWriteToolDefinitions(home).map((tool) => [tool.name, tool]));
	const ctx = { cwd: home } as any;
	await tools.get("write")!.execute("write", { path: "global/x.md", content: "one" }, undefined, undefined, ctx);
	assert.equal(readFileSync(join(home, "global/x.md"), "utf8"), "one");
	const rejects = async (tool: "write" | "edit", path: string) => {
		const params = tool === "write" ? { path, content: "outside" } : { path, edits: [{ oldText: "one", newText: "outside" }] };
		await assert.rejects(() => tools.get(tool)!.execute("escape", params as any, undefined, undefined, ctx), /dream-test/);
	};
	await rejects("write", "../outside.md");
	await rejects("edit", "/tmp/outside.md");
	symlinkSync(outside, join(home, "escape"));
	await rejects("write", "escape/outside.md");
	assert.equal(existsSync(join(outside, "outside.md")), false);
});

test("dreamer delete is jailed to the notes home and refuses live notes", async () => {
	const home = fixture();
	const outside = fixture();
	mkdirSync(join(home, "global"), { recursive: true });
	const frontmatter = "---\norigin: self\ncreatedAt: 2026-09-01T00:00:00.000+08:00\nupdatedAt: 2026-09-01T00:00:00.000+08:00\nlastAccessed: 2026-09-01T00:00:00.000+08:00\naccessCount: 0\n";
	writeFileSync(join(home, "global/dead.md"), `${frontmatter}crumpledAt: 2026-09-02T00:00:00.000+08:00\n---\ndead\n`);
	writeFileSync(join(home, "global/live.md"), `${frontmatter}---\nlive\n`);
	writeFileSync(join(outside, "keep.md"), "stay");
	const del = dreamerDeleteToolDefinition(home);
	const ctx = { cwd: home } as any;
	await del.execute("d1", { path: "global/dead.md" }, undefined, undefined, ctx);
	assert.equal(existsSync(join(home, "global/dead.md")), false);
	await assert.rejects(() => del.execute("d2", { path: "global/live.md" }, undefined, undefined, ctx), /global\/live\.md/);
	assert.equal(existsSync(join(home, "global/live.md")), true);
	await assert.rejects(() => del.execute("d3", { path: join("..", basename(outside), "keep.md") } as any, undefined, undefined, ctx), /outside the notes home/);
	symlinkSync(join(outside, "keep.md"), join(home, "link.md"));
	await assert.rejects(() => del.execute("d4", { path: "link.md" }, undefined, undefined, ctx), /outside the notes home/);
	assert.equal(existsSync(join(outside, "keep.md")), true);
});

test("CLI lists dreamer deletions in the report", async () => {
	const home = fixture();
	const sessionFactory = scriptedSession((handler, cwd) => {
		mkdirSync(join(cwd, "global"), { recursive: true });
		handler({ type: "tool_execution_start", toolName: "delete", args: { path: "global/dead.md" } });
		handler({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "dreamt" }] } });
	});
	const { code, errors } = await captureErrors(() => main(["--notes-home", home, "--force"], { sessionFactory, dreamerSettings: () => ({ warnings: [] }) }));
	assert.equal(code, 0, errors.join("\n"));
	const reports = readdirSync(join(home, "dreams"));
	assert.equal(reports.length, 1);
	assert.match(readFileSync(join(home, "dreams", reports[0]!), "utf8"), /- delete: global\/dead\.md/);
});

test("CLI records a final audit failure and preserves the report", async () => {
	const home = fixture();
	const sessionFactory = scriptedSession((_handler, cwd) => {
		mkdirSync(join(cwd, "global"), { recursive: true });
		writeFileSync(join(cwd, "global/ok.md"), "ok");
		rmSync(join(cwd, ".git"), { recursive: true, force: true });
		writeFileSync(join(cwd, ".git"), "broken");
	});
	const { code, errors } = await captureErrors(() => main(["--notes-home", home, "--force"], { sessionFactory, dreamerSettings: () => ({ warnings: [] }) }));
	assert.notEqual(code, 0);
	assert.ok(errors.some((line) => /final audit failed/.test(line)));
	const reports = readdirSync(join(home, "dreams"));
	assert.equal(reports.length, 1);
	assert.match(readFileSync(join(home, "dreams", reports[0]!), "utf8"), /Final audit failed/);
});

test("CLI commits partial writes when report writing fails", async () => {
	const home = fixture();
	writeFileSync(join(home, "dreams"), "not a directory");
	const sessionFactory = scriptedSession((handler, cwd) => {
		mkdirSync(join(cwd, "global"), { recursive: true });
		writeFileSync(join(cwd, "global/partial.md"), "half");
		handler({ type: "tool_execution_start", toolName: "write", args: { path: "global/partial.md", content: "half" } });
		handler({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Insufficient Balance" } });
	});
	const { code, errors } = await captureErrors(() => main(["--notes-home", home, "--force"], { sessionFactory, dreamerSettings: () => ({ warnings: [] }) }));
	assert.notEqual(code, 0);
	assert.ok(errors.some((line) => /could not write report/.test(line)));
	assert.match(execFileSync("git", ["log", "--format=%s"], { cwd: home, encoding: "utf8" }).trim(), /\(failed\)/);
	assert.equal(execFileSync("git", ["show", "HEAD:global/partial.md"], { cwd: home, encoding: "utf8" }), "half");
});

test("CLI refuses a malformed flag value before creating anything", async () => {
	const numberHome = join(fixture(), "notes");
	const badNumber = await captureErrors(() => main(["--notes-home", numberHome, "--min-hours", "abc"], { dreamerSettings: () => ({ warnings: [] }) }));
	assert.equal(badNumber.code, 1);
	assert.ok(badNumber.errors.some((line) => /--min-hours needs a positive whole number/.test(line)), badNumber.errors.join("\n"));
	assert.equal(existsSync(numberHome), false, "a bad number is refused before the home is created");

	for (const value of ["", "--force"]) {
		const home = join(fixture(), "notes");
		const badHome = await captureErrors(() => main(["--notes-home", value], { dreamerSettings: () => ({ warnings: [] }) }));
		assert.equal(badHome.code, 1, `--notes-home ${JSON.stringify(value)} is refused`);
		assert.ok(badHome.errors.some((line) => /--notes-home needs a directory path/.test(line)), badHome.errors.join("\n"));
		assert.equal(existsSync(home), false, "a flag-looking path never becomes the home");
	}
});
