// Paseo's Pi and Claude adapters use different tool-result envelopes.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Strip only Notesoup's exact MCP server prefix, never another server's. */
export function notesoupToolName(name: string): string {
  const prefix = "mcp__notesoup__";
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function textContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter(isRecord).filter((block) => block.type === "text" && typeof block.text === "string");
  return parts.length > 0 ? parts.map((block) => block.text as string).join("\n") : undefined;
}

/** Pi live/history: content blocks. Claude: buildToolOutput's output field. */
export function resultText(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  return textContent(output.content) ?? (typeof output.output === "string" ? output.output : undefined);
}

/** Claude failures have no output; handleToolResult preserves the raw block in error. */
export function resultError(output: unknown, error: unknown): string {
  return resultText(output)
    ?? (typeof error === "string" ? error : undefined)
    ?? (isRecord(error) ? textContent(error.content) ?? (typeof error.message === "string" ? error.message : undefined) : undefined)
    ?? "failed";
}
