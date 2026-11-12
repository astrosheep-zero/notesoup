/** Parse a slash-command cap: decimal k/m suffixes, whole tokens, or off. */
export function parseContextCap(value: string): number | null | undefined {
	const text = value.trim().toLowerCase();
	if (text === "off") return null;
	const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text);
	if (!match) return undefined;
	const tokens = Number(match[1]) * (match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1);
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}
