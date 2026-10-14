import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotesStore, noteIdentity, NoteError, type NotesIdentity } from "../src/notes/index.js";
import { scopeDir } from "../src/notes/paths.js";

function fixture(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "notes-query-homes-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const identity: NotesIdentity = { home, sessionId: "DSH.Run_1+local", projectKey: "current-project", agent: "current-agent", model: "current-model" };
	const foreignIdentity: NotesIdentity = { ...identity, sessionId: "DSH.Run_2+@remote", projectKey: "other-project", agent: "other-agent", model: "other-model" };
	return { home, identity, foreignIdentity, notes: createNotesStore(identity), foreign: createNotesStore(foreignIdentity) };
}

function addresses(rows: { address: string }[]): string[] {
	return rows.map(row => row.address).sort();
}

async function populate(t: test.TestContext) {
	const fixtureData = fixture(t);
	const { notes, foreign, foreignIdentity } = fixtureData;
	const current = ["shared.md", "@project/shared.md", "@human/shared.md", "@self/shared.md", "@model/shared.md"].sort();
	for (const address of current) await notes.write(address, "needle in current home");
	for (const address of ["shared.md", "@project/shared.md", "@self/shared.md", "@model/shared.md"]) await foreign.write(address, "needle in foreign home");
	const all = [...current,
		`@sessions/${foreignIdentity.sessionId}/shared.md`,
		"@projects/other-project/shared.md", "@agents/other-agent/shared.md", "@models/other-model/shared.md",
	].sort();
	return { ...fixtureData, current, all };
}

test("default spellings stay local while explicit ** lists and searches each home once", async (t) => {
	const { notes, current, all, identity } = await populate(t);
	assert.deepEqual(addresses(await notes.list()), current);
	for (const glob of [null, "", "@default"]) {
		assert.deepEqual(addresses(await notes.list({ glob })), current);
		assert.deepEqual(addresses(await notes.search(["needle"], { glob })), current);
	}
	const rows = await notes.list({ glob: "**" });
	assert.deepEqual(addresses(rows), all);
	assert.deepEqual(addresses(await notes.search(["needle"], { glob: "**" })), all);
	assert.equal(new Set(rows.map(row => row.address)).size, rows.length);
	for (const row of rows) assert.equal((await notes.read(row.address))?.body.startsWith("needle"), true, "every result is a real readable address");
	assert.deepEqual(await notes.list({ glob: "@default/**" }), [], "@default is a bare selector, not an address prefix");
	assert.deepEqual(addresses(await notes.list({ glob: "@project/**" })), ["@project/shared.md"]);
	assert.deepEqual(addresses(await notes.list({ glob: "@self/**" })), ["@self/shared.md"]);
	assert.deepEqual(addresses(await notes.list({ glob: "@model/**" })), ["@model/shared.md"]);
	assert.deepEqual(addresses(await notes.list({ glob: `@projects/${identity.projectKey}/**` })), [`@projects/${identity.projectKey}/shared.md`], "explicit current project stays a named read-only address");
});

test("explicit patterns use canonical addresses, with bare-path matching only for the current session", async (t) => {
	const { notes, identity, foreignIdentity, foreign, all } = await populate(t);
	await notes.write("deep/nested.md", "needle nested");
	await foreign.write("deep/nested.md", "needle elsewhere");
	await foreign.write("only-foreign.md", "needle foreign only");
	assert.deepEqual(addresses(await notes.list({ glob: "*.md" })), ["shared.md"]);
	assert.deepEqual(addresses(await notes.list({ glob: "deep/**" })), ["deep/nested.md"]);
	assert.deepEqual(await notes.search(["needle"], { glob: "only-foreign.md" }), [], "foreign sessions get no implicit basename alias");
	assert.deepEqual(addresses(await notes.list({ glob: "**/shared.md" })), all);
	assert.deepEqual(addresses(await notes.list({ glob: "@*/**/shared.md" })), all, "a wildcard head is not mistaken for an unknown reserved head");
	assert.deepEqual(addresses(await notes.list({ glob: `@sessions/${identity.sessionId}/**` })), [
		`@sessions/${identity.sessionId}/deep/nested.md`, `@sessions/${identity.sessionId}/shared.md`,
	].sort(), "explicit session patterns return canonical addresses even for the current session");
	assert.deepEqual(addresses(await notes.list({ glob: "@sessions/*/shared.md" })), [
		`@sessions/${identity.sessionId}/shared.md`, `@sessions/${foreignIdentity.sessionId}/shared.md`,
	].sort());
});

test("named session reads leave bytes untouched and explicit session mutations refuse both endpoints", async (t) => {
	const { identity, foreignIdentity, notes, foreign } = fixture(t);
	await notes.write("local.md", "local body");
	await foreign.write("foreign.md", "foreign body", { origin: "user" });
	const foreignAddress = `@sessions/${foreignIdentity.sessionId}/foreign.md`;
	const currentAddress = `@sessions/${identity.sessionId}/local.md`;
	const foreignFile = join(scopeDir("session", foreignIdentity), "foreign.md");
	const currentFile = join(scopeDir("session", identity), "local.md");
	const beforeForeign = readFileSync(foreignFile, "utf8");
	const beforeCurrent = readFileSync(currentFile, "utf8");
	const read = (await notes.read(foreignAddress))!;
	assert.equal(read.body, "foreign body");
	assert.equal(read.meta.accessCount, 0);
	assert.equal(read.meta.project, foreignIdentity.projectKey);
	assert.equal(read.resolvedScope, "session");
	assert.equal((await notes.read(currentAddress))?.body, "local body");
	assert.deepEqual(noteIdentity(identity, foreignAddress), { address: foreignAddress });
	assert.equal(await notes.read(`@sessions/${foreignIdentity.sessionId}/missing.md`), undefined);
	const readOnly = (error: unknown) => error instanceof NoteError && error.code === "invalid_scope";
	await assert.rejects(() => notes.write(foreignAddress, "overwritten"), readOnly);
	await assert.rejects(() => notes.write(currentAddress, "overwritten"), readOnly);
	await assert.rejects(() => notes.update(foreignAddress, undefined, { crumpled: true }), readOnly);
	await assert.rejects(() => notes.rename(foreignAddress, "stolen.md"), readOnly);
	await assert.rejects(() => notes.rename("local.md", currentAddress), readOnly);
	await assert.rejects(() => notes.update("local.md", [{ oldText: "local", newText: "changed" }], { renameTo: foreignAddress }), readOnly);
	assert.equal(readFileSync(foreignFile, "utf8"), beforeForeign);
	assert.equal(readFileSync(currentFile, "utf8"), beforeCurrent);
	assert.equal((await notes.read("local.md"))?.meta.accessCount, 1, "the bare current-session alias retains ordinary access accounting");
	await assert.rejects(() => notes.read("@sessions/../escape.md"), (error: unknown) => error instanceof NoteError && error.code === "invalid_address");
	await assert.rejects(() => notes.list({ glob: "@sessions/bad:id/**" }), readOnly);
	assert.equal(readFileSync(foreignFile, "utf8"), beforeForeign);
});

test("named project reads and relative identity rendering survive global enumeration of unmarked homes", async (t) => {
	const { home, identity, notes } = fixture(t);
	const project = join(home, "project", "another-project");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, ".project"), JSON.stringify({ id: "remote/project", path: "/workspace/another" }));
	writeFileSync(join(project, "decision.md"), "needle project");
	const legacy = join(home, "project", "legacy-project");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "legacy.md"), "needle legacy");
	await notes.write("@self/agent.md", "needle agent");
	await notes.write("@model/model.md", "needle model");
	assert.deepEqual(addresses(await notes.list({ glob: "**" })), [
		"@projects/another-project/decision.md", "@projects/legacy-project/legacy.md", "@self/agent.md", "@model/model.md",
	].sort());
	const address = "@projects/another-project/decision.md";
	const before = readFileSync(join(project, "decision.md"), "utf8");
	assert.equal((await notes.read(address))?.body, "needle project");
	assert.equal(readFileSync(join(project, "decision.md"), "utf8"), before);
	assert.deepEqual(noteIdentity(identity, address), { address, project_root: "/workspace/another" });
	assert.equal(noteIdentity(identity, `@agents/${identity.agent}/agent.md`).address, "@self/agent.md");
	assert.equal(noteIdentity(identity, `@models/${identity.model}/model.md`).address, "@model/model.md");
	await assert.rejects(() => notes.write(address, "no"), (error: unknown) => error instanceof NoteError && error.code === "invalid_scope");
});

test("global status isolates every failed namespace and reserved heads do not scan unrelated homes", async (t) => {
	const { home, notes } = fixture(t);
	await notes.write("@human/available.md", "needle");
	mkdirSync(join(home, "pi"), { recursive: true });
	for (const root of ["pi/session", "project", "agents", "models"]) writeFileSync(join(home, root), "not a directory");
	const expected = { homesUnavailable: ["@sessions", "@projects", "@agents", "@models"] };
	const listed = await notes.listWithStatus({ glob: "**" });
	assert.deepEqual(addresses(listed.rows), ["@human/available.md"]);
	assert.deepEqual(listed.status, expected);
	assert.deepEqual((await notes.searchWithStatus(["needle"], { glob: "**" })).status, expected);
	assert.deepEqual((await notes.listWithStatus({ glob: "@human/**" })).status.homesUnavailable, []);
	await assert.rejects(() => notes.list({ glob: "**" }), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR");
});

test("global status reports failed enumerated homes individually and keeps readable siblings", async (t) => {
	if (process.getuid?.() === 0 || process.platform === "win32") return t.skip("chmod 000 does not refuse this user's reads");
	const { notes, foreignIdentity, current, home, all } = await populate(t);
	const failed = [scopeDir("session", foreignIdentity), scopeDir("project", foreignIdentity)];
	for (const dir of failed) chmodSync(dir, 0o000);
	try {
		const result = await notes.listWithStatus({ glob: "**" });
		const unavailable = [`@sessions/${foreignIdentity.sessionId}`, "@projects/other-project"];
		assert.deepEqual(result.status.homesUnavailable, unavailable);
		assert.deepEqual(addresses(result.rows), all.filter(address => !unavailable.some(prefix => address.startsWith(`${prefix}/`))));
		assert.deepEqual((await notes.searchWithStatus(["needle"], { glob: "**" })).status.homesUnavailable, unavailable);
		assert.deepEqual(addresses(await notes.list()), current, "local defaults do not enumerate unreadable foreign homes");
		// A namespace scan must not read project marker files or let one bad marker abort its siblings.
		chmodSync(failed[1]!, 0o755);
		writeFileSync(join(home, "project/other-project/.project"), "{}");
		chmodSync(join(home, "project/other-project/.project"), 0o000);
		assert.deepEqual((await notes.listWithStatus({ glob: "@projects/*/**" })).status.homesUnavailable, []);
	} finally {
		for (const dir of failed) chmodSync(dir, 0o755);
	}
});
