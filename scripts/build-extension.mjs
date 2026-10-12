import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const projections = [
	["skills/memory/SKILL.md", "mods/notesoup/skills/memory/SKILL.md"],
	["skills/dream/SKILL.md", "mods/notesoup/skills/dream/SKILL.md"],
	["playbook.md", "mods/notesoup/playbook.md"],
];
for (const [source, projection] of projections) {
	mkdirSync(dirname(projection), { recursive: true });
	copyFileSync(source, projection);
}

await build({
	entryPoints: ["src/claude/helper.ts"],
	outfile: "mods/notesoup/dist/claude/helper.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
});
