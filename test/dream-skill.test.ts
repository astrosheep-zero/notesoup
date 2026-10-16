import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(dir, "package.json"))) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error("could not locate package root");
		dir = parent;
	}
	return dir;
}

function discoverSkill(skillsDir: string, name: string) {
	const result = loadSkillsFromDir({ dir: skillsDir, source: "path" });
	assert.deepEqual(result.diagnostics, []);
	const skill = result.skills.find((candidate) => candidate.name === name);
	assert.ok(skill, `Pi's public skill loader discovers ${name}`);
	assert.ok(skill.description.length > 0);
	return skill;
}

test("dream skill is publicly discoverable and resolves the shared playbook", () => {
	const root = packageRoot();
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.deepEqual(manifest.pi.extensions, ["./plugins/pi/index.ts"]);
	assert.equal(manifest.bin, undefined, "the dream CLI is gone; dreams run through the dream_* tools");
	assert.ok(manifest.files.includes("skills"));

	discoverSkill(join(root, "skills"), "memory");
	const skill = discoverSkill(join(root, "skills"), "dream");
	const skillPlaybook = resolve(skill.baseDir, "../../playbook.md");
	const packagePlaybook = resolve(root, "playbook.md");
	assert.equal(skillPlaybook, packagePlaybook);
	const playbook = readFileSync(packagePlaybook, "utf8");
	assert.equal(readFileSync(skillPlaybook, "utf8"), playbook);

});

test("npm tarball keeps the skill's relative playbook path portable after extraction", () => {
	const root = packageRoot();
	const fixture = mkdtempSync(join(tmpdir(), "dream-skill-pack-"));
	try {
		const packed = JSON.parse(execFileSync("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", fixture], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}))[0] as { filename: string; files: Array<{ path: string }> };
		const packedPaths = packed.files.map((file) => file.path);
		assert.ok(packedPaths.includes("skills/dream/SKILL.md"));
		assert.ok(packedPaths.includes("skills/memory/SKILL.md"));
		assert.ok(packedPaths.includes("playbook.md"));
		assert.ok(packedPaths.includes("plugins/pi/index.ts"));

		const extracted = join(fixture, "extracted");
		execFileSync("mkdir", ["-p", extracted]);
		execFileSync("tar", ["-xzf", join(fixture, packed.filename), "-C", extracted]);
		const installedRoot = join(extracted, "package");
		discoverSkill(join(installedRoot, "skills"), "memory");
		const installedSkill = discoverSkill(join(installedRoot, "skills"), "dream");
		const referencedPlaybook = resolve(installedSkill.baseDir, "../../playbook.md");
		assert.equal(referencedPlaybook, resolve(installedRoot, "playbook.md"));
		assert.equal(readFileSync(referencedPlaybook, "utf8"), readFileSync(join(root, "playbook.md"), "utf8"));
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
