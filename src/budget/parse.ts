/**
 * Scalar guards shared by the budget derivations. Settings and environment values arrive
 * untyped from either host, so numbers, percentages and presence flags are validated here
 * once instead of once per call site.
 */

/** A finite number, from a typed value or an environment string; anything else is unknown. */
export function numberOf(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function positiveNumber(value: unknown): number | undefined {
	const parsed = numberOf(value);
	return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

/** A margin or window is usable only as a positive safe integer. */
export function positiveInteger(value: unknown): number | undefined {
	const parsed = numberOf(value);
	return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** A percentage override is usable only in (0, 100]. */
export function percent(value: unknown): number | undefined {
	const parsed = numberOf(value);
	return parsed !== undefined && parsed > 0 && parsed <= 100 ? parsed : undefined;
}

/** Presence-style flags (DISABLE_*): any value but an explicit no counts as on. */
export function presenceFlag(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const text = value.trim().toLowerCase();
	return text !== "" && text !== "0" && text !== "false" && text !== "no" && text !== "off";
}
