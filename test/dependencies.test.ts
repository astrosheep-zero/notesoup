import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { dependencyViolations, moduleReferences } from "./helpers/dependency-graph.js";
import * as entry from "../src/index.js";
import notesoup, { createNotesoup } from "../src/pi/extension.js";

function repository(): string {
	let root = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(root, "tsconfig.json"))) root = dirname(root);
	return root;
}

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);
}

const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 };

test("all shared domains resolve without any direct or transitive SDK, Pi adapter or root entry dependency", () => {
	const root = repository();
	const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
	assert.equal(config.error, undefined);
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
	assert.deepEqual(parsed.errors, []);
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const shared = sources(join(root, "src")).filter((file) => !["pi", "claude", "dsh"].some((adapter) => file.startsWith(join(root, "src", adapter) + "/")) && file !== join(root, "src/index.ts"));
	for (const domain of ["notes", "boot", "history", "budget", "tools", "dream"]) assert.ok(shared.some((file) => file.startsWith(join(root, "src", domain) + "/")), `${domain} is included`);
	assert.deepEqual(dependencyViolations(root, shared, parsed.options, new Set(["typebox"])), []);
	for (const name of ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
		assert.equal(manifest.dependencies?.[name], undefined, `${name} is supplied by the host`);
		assert.equal(manifest.peerDependencies[name], "*", `${name} follows Pi's host dependency contract`);
	}
});

test("each adapter resolves only its own host, shared domains and the public notes entry", () => {
	const root = repository();
	for (const adapter of ["pi", "claude", "dsh"]) {
		const entries = sources(join(root, "src", adapter));
		if (adapter === "claude") entries.push(...sources(join(root, "mods/notesoup/hooks")));
		assert.deepEqual(dependencyViolations(root, entries, options, new Set(["typebox"])), [], adapter);
	}
});

test("dependency guard follows indirect types, re-exports, dynamic imports and import-type edges through resolved aliases", (t) => {
	const root = mkdtempSync(join(tmpdir(), "context-dependencies-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
	put("package.json", '{"type":"module"}');
	put("src/pi/native.ts", "export type Native = string;");
	put("src/index.ts", 'export * from "./pi/native.js";');
	put("src/notes/bridge.ts", 'export type { Native } from "@native";');
	put("src/notes/identity.ts", 'import type { Native } from "./bridge.js"; export type Identity = Native;');
	put("src/dream/jail.ts", 'export const backend = () => import("../index.js");');
	put("src/boot/snapshot.ts", 'export type Snapshot = import("../pi/native.js").Native;');
	put("src/history/decoder.ts", 'import type { SessionEntry } from "@earendil-works/pi-coding-agent"; export type Entry = SessionEntry;');
	put("src/history/query.ts", 'export type { Entry } from "./decoder.js";');
	const fixtureOptions = { ...options, baseUrl: root, paths: { "@native": ["src/pi/native.ts"] } };
	const violations = dependencyViolations(root, ["src/notes/identity.ts", "src/dream/jail.ts", "src/boot/snapshot.ts", "src/history/query.ts"], fixtureOptions, new Set());
	assert.deepEqual(violations, [
		"src/notes/identity.ts -> src/notes/bridge.ts -> src/pi/native.ts",
		"src/dream/jail.ts -> src/index.ts",
		"src/boot/snapshot.ts -> src/pi/native.ts",
		"src/history/query.ts -> src/history/decoder.ts -> @earendil-works/pi-coding-agent",
	]);
	put("src/boot/snapshot.ts", 'export type Snapshot = import("../dsh/native.js").Native;');
	put("src/dsh/native.ts", "export type Native = string;");
	put("src/history/query.ts", 'export type { Session } from "@deepseek-ai/dsh-session";');
	assert.deepEqual(dependencyViolations(root, ["src/boot/snapshot.ts", "src/history/query.ts"], fixtureOptions, new Set()), [
		"src/boot/snapshot.ts -> src/dsh/native.ts",
		"src/history/query.ts -> @deepseek-ai/dsh-session",
	]);
	put("src/notes/bridge.ts", 'export type { Value as Native } from "./safe.js";');
	put("src/notes/safe.ts", "export type Value = string;");
	assert.deepEqual(dependencyViolations(root, ["src/notes/identity.ts"], fixtureOptions, new Set()), [], "a host-neutral type/re-export chain is allowed");
});

test("adapter policies reject foreign hosts and notes internals, including reachable Claude hooks", (t) => {
	const root = mkdtempSync(join(tmpdir(), "context-adapters-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
	put("package.json", '{"type":"module"}');
	put("src/notes/index.ts", 'export type { Note } from "./store.js";');
	put("src/notes/store.ts", "export type Note = string;");
	const hosts = ["pi", "claude", "dsh"];
	const sdks = ["@earendil-works/pi-coding-agent", "claude-code", "@deepseek-ai/cordis"];
	for (const host of hosts) put(`src/${host}/native.ts`, "export const value = 1;");
	for (const [index, host] of hosts.entries()) {
		const entry = `src/${host}/entry.ts`;
		const check = () => dependencyViolations(root, [entry], options, new Set());
		put(entry, `export type { Note } from "../notes/index.js"; import type { Native } from "${sdks[index]}";`);
		assert.deepEqual(check(), [], `${host} may use its SDK and the notes entry`);
		put(entry, 'export type { Note } from "../notes/store.js";');
		assert.deepEqual(check(), [`${entry} -> src/notes/store.ts`]);
		const other = (index + 1) % hosts.length;
		put(entry, `export { value } from "../${hosts[other]}/native.js";`);
		assert.deepEqual(check(), [`${entry} -> src/${hosts[other]}/native.ts`]);
		put(entry, `export type { Native } from "${sdks[other]}";`);
		assert.deepEqual(check(), [`${entry} -> ${sdks[other]}`]);
	}
	put("src/claude/entry.ts", 'export { value } from "../../mods/notesoup/hooks/register.js";');
	put("mods/notesoup/hooks/register.ts", 'export { value } from "../../../src/pi/native.js";');
	assert.deepEqual(dependencyViolations(root, ["src/claude/entry.ts"], options, new Set()), ["src/claude/entry.ts -> mods/notesoup/hooks/register.ts -> src/pi/native.ts"]);
	put("mods/notesoup/hooks/register.ts", 'export type { Note } from "../../../src/notes/index.js";');
	assert.deepEqual(dependencyViolations(root, ["src/claude/entry.ts"], options, new Set()), []);
	put("src/pi/entry.ts", 'export type { Note } from "@notes-internal";');
	assert.deepEqual(dependencyViolations(root, ["src/pi/entry.ts"], { ...options, baseUrl: root, paths: { "@notes-internal": ["src/notes/store.ts"] } }, new Set()), ["src/pi/entry.ts -> src/notes/store.ts"]);
});

test("runtime cycles are rejected but explicit and implicitly erased type edges are allowed", (t) => {
	const root = mkdtempSync(join(tmpdir(), "context-cycles-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "src/boot"), { recursive: true });
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	writeFileSync(join(root, "src/boot/a.ts"), 'import { b } from "./b.js"; export const a = () => b; export type A = string;');
	const check = () => dependencyViolations(root, ["src/boot/a.ts"], options, new Set());
	writeFileSync(join(root, "src/boot/b.ts"), 'export { a as b } from "./a.js";');
	assert.deepEqual(check(), ["runtime cycle: src/boot/a.ts -> src/boot/b.ts -> src/boot/a.ts"]);
	writeFileSync(join(root, "src/boot/b.ts"), 'export type B = import("./a.js").A; export const b = 1;');
	assert.deepEqual(check(), []);
	writeFileSync(join(root, "src/boot/b.ts"), 'import { A } from "./a.js"; export type B = A; export const b = 1;');
	assert.deepEqual(check(), []);
});

test("AST guard sees every literal module edge, not import-like prose or comments", () => {
	const source = ts.createSourceFile("edges.ts", `
		// import("not-an-edge")
		const prose = 'import("also-not-an-edge")';
		import type { T } from "type-import";
		export type { T } from "type-reexport";
		export * from "reexport";
		type T = import("import-type").T;
		const load = () => import("dynamic-import");
		import legacy = require("import-equals");
		const other = require("require-call");
	`, ts.ScriptTarget.Latest, true);
	assert.deepEqual(moduleReferences(source), ["type-import", "type-reexport", "reexport", "import-type", "dynamic-import", "import-equals", "require-call"]);
});

test("the intentional root exports only the Pi extension and its settings-bound factory", () => {
	assert.deepEqual(Object.keys(entry).sort(), ["createNotesoup", "default"]);
	assert.equal(entry.default, notesoup);
	assert.equal(entry.createNotesoup, createNotesoup);
	assert.equal(typeof entry.createNotesoup(), "function");
});


test("configured extension source and moved dream CLI are executable current entries", async () => {
	const root = repository();
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const entrySource = resolve(root, manifest.pi.extensions[0]);
	assert.ok(existsSync(entrySource), "the manifest entry exists as TypeScript source (Pi loads it directly; plain Node cannot)");
	const built = await import(pathToFileURL(resolve(root, "dist/src/index.js")).href);
	const tools: ToolDefinition[] = [];
	const commands: string[] = [];
	built.default({
		on() {},
		registerTool(tool: ToolDefinition) { tools.push(tool); },
		registerCommand(name: string) { commands.push(name); },
	} as unknown as ExtensionAPI);
	assert.deepEqual(tools.map((tool) => tool.name).sort(), ["empty_brain", "get_context_remaining", "history_list", "history_read", "history_windows", "notes_list", "notes_read", "notes_search", "notes_update", "notes_write"]);
	assert.deepEqual(commands.sort(), ["empty", "fresh-window", "notesoup"]);
	const help = execFileSync(process.execPath, [resolve(root, manifest.bin.dream), "--help"], { cwd: root, encoding: "utf8" });
	assert.ok(help.startsWith("dream doctor [--notes-home <dir>]"));
	assert.ok(help.includes("Default playbook: <installed package root>/playbook.md"));
});
