import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { NotesoupCompactionEngine } from "./engine.js";

export class PreflightError extends Error {
	constructor(readonly code: string, message: string) { super(`notesoup: ${message}`); }
}

/** Probe capabilities and the public loader/registry, not preview-version strings or private hooks. */
export function preflight(ctx: Context): NotesoupCompactionEngine {
	for (const [service, method] of [["systemPrompt", "section"], ["tools", "register"], ["sessionQuery", "readSession"], ["tokenMeter", "measure"], ["llm", "resolveModelInfo"]] as const) {
		const mounted = ctx.get(service) as unknown as Record<string, unknown> | undefined;
		if (typeof mounted?.[method] !== "function") throw new PreflightError("CAPABILITY", `${service}.${method} is unavailable; enable that service in the profile before using notesoup.`);
	}
	const engine = ctx.get("compaction");
	if (!(engine instanceof NotesoupCompactionEngine)) throw new PreflightError("ENGINE", "ctx.compaction must be NotesoupCompactionEngine; disable compaction-basic and enable the notesoup-engine row, then restart dsh.");
	const loader = ctx.get("loader");
	if (loader) {
		if (typeof loader.entries !== "function") throw new PreflightError("CAPABILITY", "loader.entries is unavailable; this profile cannot be checked for two engines.");
		for (const entry of loader.entries()) {
			if ((entry.options.id === "compaction-basic" || /(?:^|\/)dsh-compaction-basic$/.test(entry.options.name)) && !entry.disabled) throw new PreflightError("DOUBLE_ENGINE", "compaction-basic is enabled; set disabled: true on that profile row and restart dsh.");
		}
	}
	for (const [callback, runtime] of ctx.registry.entries()) {
		if (callback.name === "BasicCompactionEngine" && runtime.fibers.length > 0) throw new PreflightError("DOUBLE_ENGINE", "a BasicCompactionEngine fiber is mounted; remove it before starting notesoup.");
	}
	if (!engine.automaticListenerPresent) throw new PreflightError("AUTO_LISTENER", "the automatic reset listener is missing; reload notesoup-engine before sending another request.");
	return engine;
}
