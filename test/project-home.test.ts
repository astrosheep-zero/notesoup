import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Check } from "typebox/value";
import { createNotesStore, type NotesIdentity } from "../src/notes/index.js";
import { assertAddress } from "../src/notes/address.js";
import { normalizeRemote, projectKey } from "../src/notes/project-home.js";
import { notesList, notesRead, notesSearch, notesUpdate, notesWrite } from "../src/tools/notes.js";
import { success, type Outcome } from "../src/tools/result.js";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "notesoup-project-home-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "notes");
	const repo = (path: string, origin?: string): string => {
		const cwd = join(root, path);
		mkdirSync(join(cwd, ".git"), { recursive: true });
		writeFileSync(join(cwd, ".git/config"), origin ? `[remote "origin"]\n\turl = ${origin}\n` : "");
		return cwd;
	};
	const marker = (key: string): { id: string; path: string } => JSON.parse(readFileSync(join(home, "project", key, ".project"), "utf8"));
	const identity = (cwd: string): NotesIdentity => ({ home, projectKey: projectKey(cwd, home), sessionId: "session", agent: "test", model: "test" });
	return { root, home, repo, marker, identity };
}

// Each participant imports the real built module and operates on the same disk.
// Optional pauses widen publication/snapshot windows without faking fs outcomes.
const claimWorker = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [cwd, home, control, pause] = process.argv.slice(1);
const sleep = new Int32Array(new SharedArrayBuffer(4));
function wait(name) {
	const deadline = Date.now() + 15000;
	while (!fs.existsSync(join(control, name))) {
		if (Date.now() >= deadline) throw new Error("Worker barrier timed out: " + name);
		Atomics.wait(sleep, 0, 0, 5);
	}
}
function paused() { fs.writeFileSync(join(control, "paused"), ""); wait("continue"); }
if (pause) {
	const mkdir = fs.mkdirSync, readdir = fs.readdirSync, read = fs.readFileSync;
	fs.mkdirSync = function(path, ...args) {
		const result = mkdir(path, ...args);
		if (pause === "publication" && path === join(home, "project", "api")) paused();
		return result;
	};
	fs.readdirSync = function(path, ...args) {
		const result = readdir(path, ...args);
		if (pause === "snapshot" && path === join(home, "project") && args.length === 0) paused();
		return result;
	};
	fs.readFileSync = function(path, ...args) {
		try { return read(path, ...args); } catch (error) {
			if (path === join(home, "project", "api", ".project") && error.code === "ENOENT") fs.writeFileSync(join(control, "missing"), "");
			throw error;
		}
	};
	syncBuiltinESMExports();
}
const { projectKey } = await import(${JSON.stringify(new URL("../src/notes/project-home.js", import.meta.url).href)});
fs.writeFileSync(join(control, "ready"), "");
wait("start");
const key = projectKey(cwd, home);
const dir = join(home, "project", key);
const probe = join(dir, "probe-" + process.pid);
fs.writeFileSync(probe, "usable");
console.log(JSON.stringify({ key, marker: JSON.parse(fs.readFileSync(join(dir, ".project"), "utf8")), probe: fs.readFileSync(probe, "utf8") }));
`;

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${path}`);
		await delay(5);
	}
}

function racer(t: TestContext, root: string, cwd: string, home: string, pause = "") {
	const control = mkdtempSync(join(root, "racer-"));
	const child = spawn(process.execPath, ["--input-type=module", "--eval", claimWorker, cwd, home, control, pause]);
	t.after(() => { if (child.exitCode === null) child.kill(); });
	let stdout = "", stderr = "";
	child.stdout.on("data", chunk => { stdout += chunk; });
	child.stderr.on("data", chunk => { stderr += chunk; });
	const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", code => resolve({ code, stdout, stderr }));
	});
	return {
		result,
		wait: (stage: string) => waitForFile(join(control, stage)),
		release: (stage: string) => writeFileSync(join(control, stage), ""),
	};
}

test("sixteen first claimants converge on one usable home for root and remote identities", async t => {
	for (const remote of [false, true]) await t.test(remote ? "normalized remote across different checkout names" : "canonical root", async t => {
		const { root, home, repo, marker } = fixture(t);
		const cwd = repo("api", remote ? "git@HOST:team/api.git" : undefined);
		const other = remote ? repo("another-name", "https://host/team/api.git") : cwd;
		const racers = Array.from({ length: 16 }, (_, i) => racer(t, root, i % 2 ? other : cwd, home));
		await Promise.all(racers.map(worker => worker.wait("ready")));
		for (const worker of racers) worker.release("start");
		const results = await Promise.all(racers.map(worker => worker.result));
		const keys = results.map(result => {
			assert.equal(result.code, 0, result.stderr);
			const output = JSON.parse(result.stdout);
			assert.equal(output.probe, "usable");
			assert.equal(output.marker.id, remote ? "host/team/api" : cwd);
			return output.key;
		});
		assert.equal(new Set(keys).size, 1);
		assert.deepEqual(readdirSync(join(home, "project")), [keys[0]]);
		assert.equal(marker(keys[0]).id, remote ? "host/team/api" : cwd);
		assert.equal(existsSync(join(home, ".project-claim")), false);
	});
});

test("different concurrent identities retain distinct suffixes", async t => {
	const { root, home, repo } = fixture(t);
	const first = racer(t, root, repo("one/api", "https://host/one/api"), home);
	const second = racer(t, root, repo("two/api", "https://host/two/api"), home);
	await Promise.all([first.wait("ready"), second.wait("ready")]);
	first.release("start"); second.release("start");
	const results = await Promise.all([first.result, second.result]);
	for (const result of results) assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(results.map(result => JSON.parse(result.stdout).key).sort(), ["api", "api-1"]);
	assert.deepEqual(readdirSync(join(home, "project")).sort(), ["api", "api-1"]);
});

test("a claimant waits for another process between directory creation and marker publication", async t => {
	const { root, home, repo } = fixture(t);
	const cwd = repo("api");
	const first = racer(t, root, cwd, home, "publication");
	await first.wait("ready"); first.release("start");
	await first.wait("paused");
	assert.equal(existsSync(join(home, "project/api/.project")), false);
	const second = racer(t, root, cwd, home);
	await second.wait("ready"); second.release("start");
	await delay(100);
	assert.deepEqual(readdirSync(join(home, "project")), ["api"]);
	first.release("continue");
	for (const result of await Promise.all([first.result, second.result])) {
		assert.equal(result.code, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).key, "api");
	}
});

test("a directory appearing after the snapshot waits for its marker before adoption or suffixing", async t => {
	for (const same of [true, false]) await t.test(same ? "adopt matching root as remote" : "suffix a different identity", async t => {
		const { root, home, repo, marker } = fixture(t);
		const cwd = repo("api", "https://host/team/api");
		const worker = racer(t, root, cwd, home, "snapshot");
		await worker.wait("ready"); worker.release("start");
		await worker.wait("paused");
		mkdirSync(join(home, "project/api"));
		worker.release("continue");
		await worker.wait("missing");
		writeFileSync(join(home, "project/api/.project"), JSON.stringify({ id: same ? cwd : "host/other/api", path: "/old/root" }));
		const result = await worker.result;
		assert.equal(result.code, 0, result.stderr);
		const key = same ? "api" : "api-1";
		assert.equal(JSON.parse(result.stdout).key, key);
		assert.deepEqual(marker(key), { id: "host/team/api", path: cwd });
		if (!same) assert.deepEqual(marker("api"), { id: "host/other/api", path: "/old/root" });
	});
});

test("an unfinished claim times out without silently allocating another home", async t => {
	const { root, home, repo } = fixture(t);
	const worker = racer(t, root, repo("api"), home, "snapshot");
	await worker.wait("ready"); worker.release("start");
	await worker.wait("paused");
	mkdirSync(join(home, "project/api"));
	worker.release("continue");
	const result = await worker.result;
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /Timed out waiting for project claim.*api/);
	assert.deepEqual(readdirSync(join(home, "project")), ["api"]);
	assert.equal(existsSync(join(home, ".project-claim")), false);
});

test("a stuck claim lock has a bounded timeout and is never stolen", async t => {
	const { root, home, repo } = fixture(t);
	mkdirSync(join(home, ".project-claim"), { recursive: true });
	const worker = racer(t, root, repo("api"), home);
	await worker.wait("ready"); worker.release("start");
	const result = await worker.result;
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /Timed out waiting for project claim.*\.project-claim/);
	assert.deepEqual(readdirSync(join(home, "project")), []);
	assert.equal(existsSync(join(home, ".project-claim")), true);
});

test("malformed marker evidence refuses instead of becoming an unmarked legacy home", t => {
	const { home, repo } = fixture(t);
	const cwd = repo("api");
	mkdirSync(join(home, "project/api"), { recursive: true });
	for (const raw of ["{", "null", "{}", '{"id":"repo","path":""}']) {
		writeFileSync(join(home, "project/api/.project"), raw);
		assert.throws(() => projectKey(cwd, home), /Invalid project marker.*api/);
		assert.equal(readFileSync(join(home, "project/api/.project"), "utf8"), raw);
		assert.deepEqual(readdirSync(join(home, "project")), ["api"]);
		assert.equal(existsSync(join(home, ".project-claim")), false);
	}
});

function data<T>(result: Outcome<T>): T {
	if (!result.ok) assert.fail(result.error.message);
	return result.data;
}

function refused(result: Outcome<unknown>): string {
	if (result.ok) assert.fail("expected refusal");
	return result.error.message;
}

test("origin identity normalizes https, scp and port-less ssh without invoking Git", t => {
	const { home, repo, marker } = fixture(t);
	for (const remote of ["https://user:secret@GitHub.COM/team/api.git/", "git@GitHub.COM:team/api.git", "ssh://git@GitHub.COM/team/api.git"]) {
		assert.equal(normalizeRemote(remote), "github.com/team/api");
	}
	assert.equal(normalizeRemote("ssh://git@EXAMPLE.com:2222/team/api.git"), "example.com:2222/team/api");
	const first = repo("one/api", "git@GitHub.COM:team/api.git");
	const second = repo("two/renamed", "https://github.com/team/api.git");
	assert.equal(projectKey(first, home), "api");
	assert.equal(projectKey(second, home), "api");
	assert.deepEqual(marker("api"), { id: "github.com/team/api", path: second });
});

test("same-basename repositories get readable suffixes and unmarked legacy names are taken", t => {
	const { home, repo } = fixture(t);
	const first = repo("one/x", "https://host/one/x");
	const second = repo("two/x", "https://host/two/x");
	assert.equal(projectKey(first, home), "x");
	assert.equal(projectKey(second, home), "x-1");
	mkdirSync(join(home, "project", "legacy"));
	writeFileSync(join(home, "project", "legacy", "keep.md"), "old notes");
	assert.equal(projectKey(repo("legacy"), home), "legacy-1");
	assert.equal(readFileSync(join(home, "project", "legacy", "keep.md"), "utf8"), "old notes");
});

test("linked worktrees and nested directories share the main checkout home and origin", t => {
	const { root, home, repo, marker } = fixture(t);
	const main = repo("api", "ssh://git@HOST/team/api.git");
	const worktree = join(root, "worktree");
	mkdirSync(worktree);
	mkdirSync(join(main, ".git/worktrees/wt"), { recursive: true });
	writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git/worktrees/wt")}\n`);
	writeFileSync(join(main, ".git/worktrees/wt/commondir"), "../..\n");
	assert.equal(projectKey(main, home), "api");
	assert.equal(projectKey(join(worktree, "missing/subdir"), home), "api");
	assert.deepEqual(marker("api"), { id: "host/team/api", path: main });
});

test("a moved checkout reuses its remote home and updates only the display root", async t => {
	const { root, home, repo, marker, identity } = fixture(t);
	const old = repo("api", "https://host/team/api.git");
	await createNotesStore(identity(old)).write("@project/decision", "keep me");
	const moved = join(root, "new-name");
	renameSync(old, moved);
	const current = identity(moved);
	assert.equal(current.projectKey, "api");
	assert.deepEqual(marker("api"), { id: "host/team/api", path: moved });
	assert.equal((await createNotesStore(current).read("@project/decision"))?.body, "keep me");
	assert.equal(projectKey(moved, home), "api");
});

test("adding origin adopts the canonical path identity without orphaning notes", async t => {
	const { home, repo, marker, identity } = fixture(t);
	const cwd = repo("api");
	await createNotesStore(identity(cwd)).write("@project/decision", "still here");
	assert.deepEqual(marker("api"), { id: cwd, path: cwd });
	writeFileSync(join(cwd, ".git/config"), '[remote "backup"]\nurl = https://host/wrong\n[remote "origin"]\nurl = git@HOST:team/api.git\n');
	assert.equal(projectKey(cwd, home), "api");
	assert.deepEqual(marker("api"), { id: "host/team/api", path: cwd });
	assert.equal((await createNotesStore(identity(cwd)).read("@project/decision"))?.body, "still here");
});

test("named projects read/list/search with root and sibling receipts, without touching stored bytes", async t => {
	const { home, repo, identity } = fixture(t);
	const first = repo("one/api", "https://host/one/backend");
	const second = repo("two/api", "https://host/two/service");
	const own = identity(first);
	const other = identity(second);
	await createNotesStore(own).write("@project/decision", "needle first");
	await createNotesStore(other).write("@project/decision", "needle second");
	const address = "@projects/api-1/decision.md";
	const file = join(home, "project/api-1/decision.md");
	const before = readFileSync(file, "utf8");
	const read = data(await notesRead.execute({ address }, own));
	assert.equal(read.text, "needle second");
	assert.equal(read.project_root, second);
	assert.deepEqual(read.project_siblings, [{ name: "api", path: first }]);
	assert.equal(Check(notesRead.outputSchema, read), true);
	assert.match(notesRead.render(success(read)), /Same-basename projects: api \(/);
	const listed = data(await notesList.execute({ glob: "@projects/*/**" }, own));
	assert.deepEqual(listed.files.map(row => [row.address, row.project_root]).sort(), [["@projects/api-1/decision.md", second], ["@projects/api/decision.md", first]].sort());
	assert.equal(Check(notesList.outputSchema, listed), true);
	const searched = data(await notesSearch.execute({ glob: "@projects/api-1/**", query: "needle" }, own));
	assert.equal(searched.files[0]?.project_root, second);
	assert.equal(Check(notesSearch.outputSchema, searched), true);
	assert.equal(readFileSync(file, "utf8"), before, "named-home reads never rewrite access metadata");
});

test("named project writes, edits, crumples and both move endpoints refuse, including the current home", async t => {
	const { repo, identity } = fixture(t);
	const own = identity(repo("api"));
	await createNotesStore(own).write("@project/decision", "body");
	const address = "@projects/api/decision";
	for (const result of [
		await notesWrite.execute({ address, content: "replacement" }, own),
		await notesUpdate.execute({ address, edits: [{ oldText: "body", newText: "changed" }] }, own, () => ""),
		await notesUpdate.execute({ address, crumpled: true }, own, () => ""),
		await notesUpdate.execute({ address, rename_to: "@project/moved" }, own, () => ""),
		await notesUpdate.execute({ address: "@project/decision", rename_to: "@projects/api/moved" }, own, () => ""),
	]) assert.match(refused(result), /read-only; use @project\//);
	assert.equal(data(await notesRead.execute({ address }, own)).text, "body");
	assert.throws(() => assertAddress("@projects/api/../decision"));
	assert.throws(() => assertAddress("@projects/api"));
});
