import { WARNING_RUNWAY_TOKENS } from "../budget/constants.js";
import { mergeNotesoupSettings } from "../settings.js";

/**
 * Claude's auto-compact point, derived the way Claude derives it — never a hardcoded percent.
 *
 * Claude compacts at `min(floor((W_eff - out) * pct/100), W_eff - out - 13000)`, where
 * `W_eff` is the resolved auto-compact window, `out` is the output reserve (capped at 20000),
 * and `pct` is CLAUDE_AUTOCOMPACT_PCT_OVERRIDE. This module mirrors those constants so
 * notesoup can resolve the same point from settings and environment alone when the
 * undocumented `usage({breakdown:true})` field is missing.
 */
/** Claude's summary buffer between the output reserve and the auto-compact point. */
export const CLAUDE_AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** Claude's cap on the reserved output tokens; the mod cannot read the model's own value. */
export const CLAUDE_OUTPUT_RESERVE_TOKENS = 20_000;
/** Default slack between Claude's auto-compact point and notesoup's notes-only reset. */
export const DEFAULT_CLAUDE_RESET_MARGIN_TOKENS = 8_192;
/**
 * The percent fallback assumes the classic 200K model window: it is reached only when
 * `usage()` reports no window and no breakdown, and it reproduces the token maths below
 * on that window (about 83.5% / 79.4% / 71.2%).
 */
const ASSUMED_WINDOW_TOKENS = 200_000;

export type ClaudeLimitSource = "auto-compact" | "window" | "percent";
export type ClaudeLimits = {
	/** Which field produced the point: Claude's own threshold, a computed window, or the percent fallback. */
	readonly source: ClaudeLimitSource;
	/** False when automatic compaction is off, so the point sits at the hard window instead. */
	readonly autoCompact: boolean;
	/** Which measured field the points are expressed in. */
	readonly unit: "tokens" | "percent";
	/** Claude's effective auto-compact point. */
	readonly native: number;
	/** Where notesoup resets: native minus the reset margin. */
	readonly reset: number;
	/** Where the one warning per window fires: reset minus the warning runway. */
	readonly warn: number;
	readonly resetMargin: number;
	readonly warningRunway: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Numbers may arrive typed or as environment strings; anything else is unknown. */
function numberOf(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}
function positiveNumberOf(value: unknown): number | undefined {
	const parsed = numberOf(value);
	return parsed !== undefined && parsed > 0 ? parsed : undefined;
}
/** A margin is usable only as a positive integer, matching Pi's budget policy. */
function positiveIntegerOf(value: unknown): number | undefined {
	const parsed = numberOf(value);
	return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
/** Claude accepts a percent override only in (0, 100]. */
function percentOf(value: unknown): number | undefined {
	const parsed = numberOf(value);
	return parsed !== undefined && parsed > 0 && parsed <= 100 ? parsed : undefined;
}
/** Presence-style flags (DISABLE_AUTO_COMPACT): any value but an explicit no counts as on. */
function flagOn(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const text = value.trim().toLowerCase();
	return text !== "" && text !== "0" && text !== "false" && text !== "no" && text !== "off";
}
function settingFlag(settings: unknown, key: string): boolean | undefined {
	if (!isObject(settings)) return undefined;
	const value = settings[key];
	return typeof value === "boolean" ? value : undefined;
}

/**
 * The configured auto-compact window, smallest first: CLAUDE_CODE_AUTO_COMPACT_WINDOW,
 * modelSettings.<model>.autoCompactWindow, then the top-level autoCompactWindow. Taking the
 * smallest present value keeps notesoup's reset ahead of whichever one Claude would use.
 */
function configuredWindow(settings: unknown, env: Record<string, unknown>, model: unknown): number | undefined {
	const windows: number[] = [];
	const fromEnv = positiveNumberOf(env.autoCompactWindow);
	if (fromEnv !== undefined) windows.push(fromEnv);
	if (typeof model === "string" && model.length > 0 && isObject(settings)) {
		const modelSettings = isObject(settings.modelSettings) ? settings.modelSettings : {};
		const perModel = modelSettings[model];
		if (isObject(perModel)) {
			const value = positiveNumberOf(perModel.autoCompactWindow);
			if (value !== undefined) windows.push(value);
		}
	}
	if (isObject(settings)) {
		const value = positiveNumberOf(settings.autoCompactWindow);
		if (value !== undefined) windows.push(value);
	}
	return windows.length === 0 ? undefined : Math.min(...windows);
}

function tokenLimits(source: ClaudeLimitSource, autoCompact: boolean, native: number, resetMargin: number, warningRunway: number): ClaudeLimits {
	const tokens = Math.max(0, Math.floor(native));
	const reset = Math.max(0, tokens - resetMargin);
	return {
		source, autoCompact, unit: "tokens",
		native: tokens, reset, warn: Math.max(0, reset - warningRunway), resetMargin, warningRunway,
	};
}

/** The percent fallback: the same reserves expressed as points of ASSUMED_WINDOW_TOKENS. */
function percentLimits(autoCompact: boolean, pct: number | undefined, resetMargin: number, warningRunway: number): ClaudeLimits {
	const base = 100 * (1 - (CLAUDE_OUTPUT_RESERVE_TOKENS + CLAUDE_AUTOCOMPACT_BUFFER_TOKENS) / ASSUMED_WINDOW_TOKENS);
	const native = pct === undefined ? base : Math.min(pct, base);
	const reset = Math.max(0, native - (resetMargin / ASSUMED_WINDOW_TOKENS) * 100);
	return {
		source: "percent", autoCompact, unit: "percent",
		native, reset, warn: Math.max(0, reset - (warningRunway / ASSUMED_WINDOW_TOKENS) * 100), resetMargin, warningRunway,
	};
}

/**
 * Resolve the points from whatever the host could read. Every field is undocumented-adjacent,
 * so a missing or malformed one degrades to the next source and finally to the percent
 * fallback; resolution never throws. `facts` is deliberately unknown: it crosses the mod
 * helper boundary, where nothing is typed.
 */
export function resolveClaudeLimits(facts: unknown): ClaudeLimits {
	const root = isObject(facts) ? facts : {};
	const usage = isObject(root.usage) ? root.usage : {};
	const breakdown = isObject(root.breakdown) ? root.breakdown : {};
	const env = isObject(root.env) ? root.env : {};
	const settings = root.settings;

	const margins = mergeNotesoupSettings(settings, undefined);
	const resetMargin = positiveIntegerOf(margins.resetMarginTokens) ?? DEFAULT_CLAUDE_RESET_MARGIN_TOKENS;
	const warningRunway = positiveIntegerOf(margins.warningRunwayTokens) ?? WARNING_RUNWAY_TOKENS;

	const autoCompact = settingFlag(settings, "autoCompactEnabled") !== false
		&& !flagOn(env.disableAutoCompact)
		&& breakdown.isAutoCompactEnabled !== false;
	const pct = percentOf(env.pctOverride);

	// (a) Claude's own point. It already includes the window, model settings and CLI flag; only
	// the percent override is applied separately, on the window-after-output-reserve it is
	// minted from (threshold + summary buffer).
	const threshold = positiveNumberOf(breakdown.autoCompactThreshold);
	if (autoCompact && threshold !== undefined) {
		const native = pct === undefined ? threshold : Math.min(Math.floor((threshold + CLAUDE_AUTOCOMPACT_BUFFER_TOKENS) * (pct / 100)), threshold);
		if (native > 0) return tokenLimits("auto-compact", true, native, resetMargin, warningRunway);
	}

	// (b) The same point computed from the reported window plus settings and environment.
	const window = positiveNumberOf(usage.window);
	if (window !== undefined) {
		const configured = configuredWindow(settings, env, breakdown.model);
		const effective = Math.min(configured ?? window, window);
		const native = autoCompact
			? effective - CLAUDE_OUTPUT_RESERVE_TOKENS - CLAUDE_AUTOCOMPACT_BUFFER_TOKENS
			: effective - CLAUDE_OUTPUT_RESERVE_TOKENS;
		if (native > 0) return tokenLimits("window", autoCompact, native, resetMargin, warningRunway);
	}

	// (c) Nothing usable but percentages.
	return percentLimits(autoCompact, pct, resetMargin, warningRunway);
}
