import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { ADDRESS_FORMS, assertAddress } from "../notes/address.js";
import { SLUG_PATTERN } from "../notes/paths.js";
import { errorMessage } from "../error-message.js";

/** Read-only diagnostics. Never follows symlinks or acquires/removes a dream lock. */
export function doctor(home: string): string[] {
	const issues: string[] = [];
	const report = (path: string, message: string) => issues.push(`${relative(home, path) || "."}: ${message}`);
	const inspect = (path: string, action: () => void) => {
		try { action(); } catch (error) { report(path, `cannot inspect: ${errorMessage(error)}`); }
	};
	const directory = (path: string): boolean => {
		const stat = lstatSync(path);
		if (stat.isDirectory()) return true;
		report(path, "expected a directory (symlinks are not followed); check its location/type");
		return false;
	};
	const checkNote = (path: string, root: string, project?: string) => {
		const raw = readFileSync(path, "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
		if (!match) { report(path, "missing or unclosed frontmatter; add a valid metadata block"); return; }
		const fields = new Map<string, string>();
		for (const line of match[1]!.split(/\r?\n/)) {
			const field = /^([\w]+):\s*(.*?)\s*$/.exec(line);
			if (!field) continue;
			if (fields.has(field[1]!)) report(path, `duplicate metadata key ${field[1]}; keep one value`);
			fields.set(field[1]!, field[2]!.replace(/^(["'])(.*)\1$/, "$2"));
		}
		for (const [key, valid] of Object.entries({ origin: /^(user|self|external)$/, accessCount: /^\d+$/ })) {
			if (!valid.test(fields.get(key) ?? "")) report(path, `missing/invalid ${key}; repair frontmatter`);
		}
		for (const key of ["createdAt", "updatedAt", "lastAccessed", "crumpledAt"]) {
			if (key === "crumpledAt" && !fields.has(key)) continue;
			const value = fields.get(key);
			if (!value || !Number.isFinite(Date.parse(value))) report(path, `missing/invalid ${key}; use an ISO timestamp`);
		}
		if (fields.has("scope")) report(path, "obsolete scope field; remove it (home determines scope)");
		// Check concrete, code-formatted addresses; examples/globs and prose are not links.
		for (const link of raw.slice(match[0].length).matchAll(/`([^`\n]+)`/g)) {
			const address = link[1]!;
			if (!address.endsWith(".md") || /[<>*?\s]/.test(address)) continue;
			if (!address.startsWith("@") && basename(path) !== "MAP.md") continue;
			try {
				const parsed = assertAddress(address);
				// Relative homes (@self/, @model/) name whoever is running; a static doctor
				// cannot resolve them, so only absolute links are checked.
				if ((parsed.scope === "agent" || parsed.scope === "model") && parsed.who === undefined) continue;
				const targetHome = parsed.scope === "human" ? join(home, "human")
					: parsed.scope === "project" ? project
					: parsed.scope === "agent" ? join(home, "agents", parsed.who!)
					: parsed.scope === "model" ? join(home, "models", parsed.who!)
					: root;
				if (!targetHome) { report(path, `${address}: project context unavailable; use a resolvable reference`); continue; }
				if (!existsSync(join(targetHome, parsed.path))) report(path, `${address}: target missing; update or remove the reference`);
			} catch { report(path, `${address} isn't a note address. ${ADDRESS_FORMS}`); }
		}
	};
	const walk = (dir: string, root: string, project?: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			inspect(path, () => {
				const stat = lstatSync(path);
				if (stat.isSymbolicLink()) report(path, "symlink not inspected; replace with a regular note/directory");
				else if (stat.isDirectory()) walk(path, root, project);
				else if (stat.isFile() && name.endsWith(".md")) checkNote(path, root, project);
				else report(path, "unexpected file in note home; inspect and relocate it");
			});
		}
	};
	inspect(home, () => {
		if (!directory(home)) return;
		for (const name of readdirSync(home)) {
			const path = join(home, name);
			inspect(path, () => {
				if (name === ".dream.lock") {
					const valid = lstatSync(path).isFile() && /^[1-9]\d* [\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\s*$/i.test(readFileSync(path, "utf8"));
					report(path, `${valid ? "lock present" : "malformed lock"}; verify no dream is running before manual removal; liveness not inferred`);
					return;
				}
				if ([".git", "dreams", "snapshots", "trash", ".dream.lock.last-run"].includes(name)) return;
				if (name === "human") { if (directory(path)) walk(path, path); return; }
				if (name === "agents" || name === "models") {
					if (!directory(path)) return;
					for (const slug of readdirSync(path)) {
						const dir = join(path, slug);
						inspect(dir, () => {
							if (!SLUG_PATTERN.test(slug)) report(dir, `invalid ${name.slice(0, -1)} slug; expected [a-z0-9-]`);
							if (!directory(dir)) return;
							walk(dir, dir);
						});
					}
					return;
				}
				if (name === "project" || name === "pi") {
					if (!directory(path)) return;
					const homes = name === "pi" ? join(path, "session") : path;
					if (name === "pi") {
						for (const entry of readdirSync(path)) if (entry !== "session") report(join(path, entry), "unexpected directory; expected pi/session/<id>/");
						if (!existsSync(homes) || !directory(homes)) return;
					}
					for (const id of readdirSync(homes)) {
						const root = join(homes, id);
						inspect(root, () => {
							if (!directory(root)) return;
							if (name === "project" && !/^.+-[\da-f]{8}$/.test(id)) report(root, "invalid project key; expected <name>-<8 hex>");
							walk(root, root, name === "project" ? root : undefined);
						});
					}
					return;
				}
				report(path, "unexpected root entry; expected human/, project/, agents/, models/, pi/session/ or dream artifacts");
			});
		}
	});
	return issues;
}
