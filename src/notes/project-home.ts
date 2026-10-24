import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { slugify } from "./paths.js";

export type ProjectMarker = { id: string; path: string };
export type ProjectHome = ProjectMarker & { name: string; dir: string };

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

function readMarker(dir: string): ProjectHome | undefined {
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

/** Read marked project homes. Unmarked legacy directories are deliberately omitted. */
export function projectHomes(home: string): ProjectHome[] {
	const root = projectRoot(home);
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); } catch (error) {
		if (errno(error) === "ENOENT") return [];
		throw error;
	}
	return entries.filter(entry => entry.isDirectory()).map(entry => readMarker(join(root, entry.name))).filter((entry): entry is ProjectHome => entry !== undefined).sort((a, b) => a.name.localeCompare(b.name));
}

function updateMarker(home: ProjectHome, marker: ProjectMarker): ProjectHome {
	const markerPath = join(home.dir, ".project");
	const temp = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(marker));
		renameSync(temp, markerPath);
	} catch (error) {
		try { rmSync(temp, { force: true }); } catch { /* Preserve the marker update failure. */ }
		throw error;
	}
	return { ...home, ...marker };
}

const claimSleep = new Int32Array(new SharedArrayBuffer(4));

function awaitClaim<T>(path: string, attempt: () => T | undefined): T {
	const deadline = performance.now() + 5_000;
	for (;;) {
		const result = attempt();
		if (result !== undefined) return result;
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw new Error(`Timed out waiting for project claim at ${path}`);
		Atomics.wait(claimSleep, 0, 0, Math.min(10, remaining));
	}
}

/** Resolve and claim the readable home for one repository identity. */
export function resolveProjectHome(cwd: string, home: string): ProjectHome {
	mkdirSync(projectRoot(home), { recursive: true });
	// Serialize the scan as well as publication: an unmarked directory seen under
	// this lock is legacy, not another resolver between mkdir and marker write.
	const lock = join(home, ".project-claim");
	awaitClaim(lock, () => {
		try { mkdirSync(lock); return true; } catch (error) {
			if (errno(error) === "EEXIST") return undefined;
			throw error;
		}
	});
	try { return claimProjectHome(cwd, home); } finally { rmdirSync(lock); }
}

function claimProjectHome(cwd: string, home: string): ProjectHome {
	const root = canonicalRoot(cwd);
	const remote = originRemote(root);
	const id = remote ?? root;
	const markerRoot = projectRoot(home);
	mkdirSync(markerRoot, { recursive: true });
	const homes = projectHomes(home);
	let found = homes.find(candidate => candidate.id === id);
	if (!found && remote) {
		found = homes.find(candidate => candidate.id === root);
		if (found) found = updateMarker(found, { id: remote, path: root });
	}
	if (found) {
		if (found.path !== root) found = updateMarker(found, { id: found.id, path: root });
		return found;
	}

	const base = slugify(basename(root));
	// The claim lock makes this a stable snapshot of legacy, unmarked names.
	const taken = new Set(readdirSync(markerRoot));
	for (let suffix = 0; ; suffix++) {
		const name = suffix === 0 ? base : `${base}-${suffix}`;
		if (taken.has(name)) continue;
		const dir = join(markerRoot, name);
		try {
			mkdirSync(dir);
		} catch (error) {
			if (errno(error) !== "EEXIST") throw error;
			// A writer outside this protocol may have won after the snapshot.
			// Never mistake its incomplete publication for a different identity.
			let winner = awaitClaim(join(dir, ".project"), () => readMarker(dir));
			if (winner.id !== id && !(remote && winner.id === root)) continue;
			if (winner.id !== id || winner.path !== root) winner = updateMarker(winner, { id, path: root });
			return winner;
		}
		return updateMarker({ name, dir, id, path: root }, { id, path: root });
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

/** Display-only context for an explicitly named project home. */
export function projectReceipt(home: string, name: string): ProjectReceipt {
	const project = readMarker(join(projectRoot(home), name));
	if (!project) return {};
	const base = slugify(basename(project.path));
	const siblings = projectHomes(home).filter(candidate => candidate.name !== name && slugify(basename(candidate.path)) === base);
	return {
		project_root: project.path,
		...(siblings.length === 0 ? {} : { project_siblings: siblings.map(({ name, path }) => ({ name, path })) }),
	};
}

/** Names a project home, claiming it when the notes home has not seen this identity. */
export function projectKey(cwd: string, home: string): string {
	return resolveProjectHome(cwd, home).name;
}
