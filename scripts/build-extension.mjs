import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const projections = [
	["skills/memory/SKILL.md", "plugins/claude/skills/memory/SKILL.md"],
	["skills/dream/SKILL.md", "plugins/claude/skills/dream/SKILL.md"],
	["playbook.md", "plugins/claude/playbook.md"],
];
for (const [source, projection] of projections) {
	mkdirSync(dirname(projection), { recursive: true });
	copyFileSync(source, projection);
}

await build({
	entryPoints: ["plugins/codex/src/cli.ts"],
	outfile: "plugins/codex/dist/codex/notesoup.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
});

await build({
	entryPoints: ["plugins/claude/src/helper.ts"],
	outfile: "plugins/claude/dist/claude/helper.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
});
