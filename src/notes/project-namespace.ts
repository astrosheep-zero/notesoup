import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { trySqliteLock } from "../sqlite-lock.js";
import { slugify } from "./paths.js";

export type ProjectMarker = { id: string; path: string };
export type ProjectNamespace = ProjectMarker & { name: string; dir: string };

function errno(error: unknown): string | undefined {
	return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** Normalize the small set of Git remote spellings used by ordinary repositories. */
export function normalizeRemote(value: string): string {
	let text = value.trim();
	const scp = /^(?:[^/@]+)@([^:/]+):(.+)$/.exec(text);
	if (scp) text = `${scp[1]!.toLowerCase()}/${scp[2]}`;
	else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
		try {
			const url = new URL(text);
			const host = url.hostname.toLowerCase();
			const port = url.port.length > 0 ? `:${url.port}` : "";
			text = `${host}${port}${url.pathname}`;
		} catch {
			text = text.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "").replace(/^[^/@]+@/, "");
		}
	} else {
		text = text.replace(/^[^/@]+@/, "");
		const slash = text.indexOf("/");
		if (slash > 0) text = `${text.slice(0, slash).toLowerCase()}${text.slice(slash)}`;
	}
	text = text.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
	return text;
}

function canonicalRoot(cwd: string): string {
	const absolute = resolve(cwd);
	const spelled = gitRoot(absolute) ?? absolute;
	try { return realpathSync(spelled); } catch { return spelled; }
}

function originRemote(root: string): string | undefined {
	let gitDir = join(root, ".git");
	let raw: string;
	try {
		if (!statSync(gitDir).isDirectory()) {
			const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
			if (!pointer) return undefined;
			gitDir = resolve(root, pointer[1]!.trim());
		}
		try { gitDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()); } catch (error) {
			if (errno(error) !== "ENOENT") throw error;
		}
		raw = readFileSync(join(gitDir, "config"), "utf8");
	} catch (error) {
		if (errno(error) === "ENOENT") return undefined;
		throw error;
	}
	let origin = false;
	for (const line of raw.split(/\r?\n/)) {
		const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
		if (section) {
			origin = section[1] === "origin";
			continue;
		}
		if (/^\s*\[/.test(line)) origin = false;
		if (origin) {
			const url = /^\s*url\s*=\s*(.*?)\s*$/.exec(line);
			if (url) return normalizeRemote(url[1]!.replace(/^"(.*)"$/, "$1")) || undefined;
		}
	}
	return undefined;
}

function readMarker(dir: string): ProjectNamespace | undefined {
	let raw: string;
	try { raw = readFileSync(join(dir, ".project"), "utf8"); } catch (error) {
		if (errno(error) === "ENOENT") return undefined;
		throw error;
	}
	try {
		const value = JSON.parse(raw) as Partial<ProjectMarker> | null;
		if (!value || typeof value.id !== "string" || value.id.length === 0 || typeof value.path !== "string" || value.path.length === 0) throw new Error("Expected non-empty id and path");
		return { name: basename(dir), dir, id: value.id, path: value.path };
	} catch (cause) {
		throw new Error(`Invalid project marker at ${join(dir, ".project")}`, { cause });
	}
}

function projectRoot(home: string): string {
	return join(home, "project");
}

/** Read marked project notebooks. Unmarked legacy directories are deliberately omitted. */
export function projectNamespaces(home: string): ProjectNamespace[] {
	const root = projectRoot(home);
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); } catch (error) {
		if (errno(error) === "ENOENT") return [];
		throw error;
	}
	return entries.filter(entry => entry.isDirectory()).map(entry => readMarker(join(root, entry.name))).filter((entry): entry is ProjectNamespace => entry !== undefined).sort((a, b) => a.name.localeCompare(b.name));
}

function updateMarker(namespace: ProjectNamespace, marker: ProjectMarker): ProjectNamespace {
	const markerPath = join(namespace.dir, ".project");
	const temp = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(marker));
		renameSync(temp, markerPath);
	} catch (error) {
		try { rmSync(temp, { force: true }); } catch { /* Preserve the marker update failure. */ }
		throw error;
	}
	return { ...namespace, ...marker };
}

function checkoutMarker(cwd: string): ProjectMarker {
	const path = canonicalRoot(cwd);
	return { id: originRemote(path) ?? path, path };
}

/** Resolve and claim the readable notebook for one repository identity. */
export function resolveProjectNamespace(cwd: string, home: string): ProjectNamespace {
	const expected = checkoutMarker(cwd);
	const current = projectNamespaces(home).find(candidate => candidate.id === expected.id);
	if (current?.path === expected.path) return current;

	const root = projectRoot(home);
	mkdirSync(root, { recursive: true });
	const lockPath = join(home, ".project-claim.sqlite");
	const release = trySqliteLock(lockPath, 5000);
	if (!release) throw new Error(`Timed out waiting for project claim at ${lockPath}`);
	try {
		// The checkout may have gained an origin and a peer may have already adopted it.
		const marker = checkoutMarker(cwd);
		const { id, path } = marker;
		const namespaces = projectNamespaces(home);
		const found = namespaces.find(candidate => candidate.id === id) ?? namespaces.find(candidate => candidate.id === path);
		if (found) return found.id === id && found.path === path ? found : updateMarker(found, marker);

		const base = slugify(basename(path));
		for (let suffix = 0; ; suffix++) {
			const name = suffix === 0 ? base : `${base}-${suffix}`;
			const dir = join(root, name);
			if (lstatSync(dir, { throwIfNoEntry: false })) continue; // Includes unmarked legacy names.
			const staged = mkdtempSync(join(home, ".project-pending-"));
			try {
				writeFileSync(join(staged, ".project"), JSON.stringify(marker));
				renameSync(staged, dir);
			} catch (error) {
				rmSync(staged, { recursive: true, force: true });
				throw error;
			}
			return { name, dir, ...marker };
		}
	} finally {
		release();
	}
}

/** Existing root discovery, including linked worktrees, without invoking Git. */
function gitRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return repositoryRoot(dir);
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function repositoryRoot(dir: string): string {
	let stats;
	try { stats = statSync(join(dir, ".git")); } catch { return dir; }
	if (stats.isDirectory()) return dir;
	let pointer: string;
	try { pointer = readFileSync(join(dir, ".git"), "utf8"); } catch { return dir; }
	const match = /^gitdir:\s*(.+)$/m.exec(pointer);
	if (!match) return dir;
	const parts = resolve(dir, match[1]!.trim()).split(sep);
	const worktrees = parts.lastIndexOf("worktrees");
	if (worktrees <= 0 || worktrees !== parts.length - 2) return dir;
	const common = parts.slice(0, worktrees).join(sep);
	return basename(common) === ".git" ? dirname(common) : dir;
}

export type ProjectReceipt = { project_root?: string; project_siblings?: Array<{ name: string; path: string }> };

/** Display-only context for an explicitly named project notebook. */
export function projectReceipt(home: string, name: string): ProjectReceipt {
	const project = readMarker(join(projectRoot(home), name));
	if (!project) return {};
	const base = slugify(basename(project.path));
	const siblings = projectNamespaces(home).filter(candidate => candidate.name !== name && slugify(basename(candidate.path)) === base);
	return {
		project_root: project.path,
		...(siblings.length === 0 ? {} : { project_siblings: siblings.map(({ name, path }) => ({ name, path })) }),
	};
}

/** Names a project notebook, claiming it when the notes store has not seen this identity. */
export function projectKey(cwd: string, home: string): string {
	return resolveProjectNamespace(cwd, home).name;
}
