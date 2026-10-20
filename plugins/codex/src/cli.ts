#!/usr/bin/env node
/** One bundled helper for both host surfaces: `mcp` speaks stdio JSON-RPC, `hook <Event>` answers a Codex hook. */
import { runMcp } from "./mcp.js";
import { readHookInput, runHook } from "./hooks.js";

async function main(): Promise<void> {
	const [command, event] = process.argv.slice(2);
	if (command === "mcp") {
		await runMcp();
		return;
	}
	if (command === "hook") {
		const input = await readHookInput(process.stdin);
		const output = await runHook(event, input);
		if (output !== "") process.stdout.write(`${output}\n`);
		return;
	}
	process.stderr.write("usage: notesoup mcp | notesoup hook <SessionStart|SubagentStart|PreCompact>\n");
	process.exitCode = 64;
}

main().catch((error: unknown) => {
	// A hook must not turn its own failure into a host crash; stderr is the only safe channel.
	process.stderr.write(`notesoup: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
