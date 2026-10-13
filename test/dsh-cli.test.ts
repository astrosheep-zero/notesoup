import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { messagesServer } from "./helpers/dsh-messages.js";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const system = (request: { system?: string | { text: string }[] }) => typeof request.system === "string" ? request.system : request.system?.map((block) => block.text).join("\n") ?? "";

test("dsh profile loads our rows and a second process restores the on-disk window", { timeout: 45000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "notesoup-dsh-cli-"));
	const mock = await messagesServer();
	t.after(async () => { await mock.close(); await rm(directory, { recursive: true, force: true }); });
	const home = join(directory, "home");
	const profile = join(home, "profiles", "notesoup-test");
	await mkdir(profile, { recursive: true });
	await writeFile(join(home, "cordis.patch.yml"), "[]\n");
	await writeFile(join(profile, "cordis.yml"), "[]\n");
	await writeFile(join(profile, "package.json"), JSON.stringify({ name: "notesoup-test", private: true, version: "0.0.0", dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }));
	const example = await readFile(join(repository, "docs/dsh.profile.patch.yml"), "utf8");
	const patch = example
		.replace("'notesoup/dsh/engine'", `'${pathToFileURL(join(repository, "dist/src/dsh/engine.js")).href}'`)
		.replace("'notesoup/dsh'", `'${pathToFileURL(join(repository, "dist/src/dsh/index.js")).href}'`)
		.replace("# notesHome: /absolute/path/to/notes", `notesHome: ${join(directory, "notes")}`);
	await writeFile(join(profile, "cordis.patch.yml"), patch + "\n- id: session-title-llm\n  disabled: true\n");
	const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: "mock-key", DEEPSEEK_BASE_URL: mock.url, DSH_TOOLS_MODE: "native" };
	const cli = resolve(repository, "node_modules/@deepseek-ai/dsh/lib/bin.js");
	mock.script.push({ tool: "neuralyze", input: {} }, { text: "after reset" });
	const first = await exec(process.execPath, [cli, "--profile", "notesoup-test", "old conversation"], { cwd: directory, env, timeout: 20000 });
	assert.equal(mock.requests.length, 2, first.stderr);
	assert.equal(mock.requests[1]!.messages.length, 1);
	assert.notEqual(system(mock.requests[0]!), system(mock.requests[1]!));
	const sessionPaths = await readdir(join(home, "sessions"), { recursive: true });
	const sessionId = sessionPaths.map((entry) => entry.split("/").at(-1)!).find((entry) => entry.startsWith("session-"))!;
	assert.ok(sessionId, JSON.stringify(sessionPaths));
	mock.script.push({ text: "reloaded" });
	const second = await exec(process.execPath, [cli, "--profile", "notesoup-test", "--session-id", sessionId, "resume"], { cwd: directory, env, timeout: 20000 });
	assert.equal(mock.requests.length, 3, second.stderr);
	assert.equal(system(mock.requests[2]!), system(mock.requests[1]!));
	assert.equal(JSON.stringify(mock.requests[2]!.messages).includes("old conversation"), false);
});
