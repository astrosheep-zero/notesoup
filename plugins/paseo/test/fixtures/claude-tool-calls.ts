// Source-derived timeline fixtures, not a live UI capture.
// Paseo packages/server/src/server/agent/providers/claude/agent.ts:
// handleToolUseStart -> { input, output: null }; handleToolResult/buildToolOutput
// -> { output: text } on success, null output + raw tool_result in error on failure.
// tool-call-mapper.ts / tool-call-detail-parser.ts keep Notesoup calls as "unknown".
// Receipt strings follow src/tools/notes.ts and plugins/claude/hooks/register.ts.

export const claudeReadCompleted = {
  type: "tool_call",
  callId: "toolu_notes_read",
  name: "mcp__notesoup__notes_read",
  status: "completed",
  error: null,
  detail: {
    type: "unknown",
    input: { address: "@self/foo.md" },
    output: { output: "@self/foo.md\norigin self | created 2026-10-17T10:00:00+08:00 | updated 2026-10-17T10:00:00+08:00 | accessed 2026-10-17T10:00:00+08:00\n\nbody line one\nbody line two" },
  },
} as const;

export const claudeWriteCompleted = {
  type: "tool_call",
  callId: "toolu_notes_write",
  name: "mcp__notesoup__notes_write",
  status: "completed",
  error: null,
  detail: {
    type: "unknown",
    input: { address: "a.md", content: "the new body" },
    output: { output: "overwrote a.md (project pi-context)" },
  },
} as const;

export const claudeUpdateCompleted = {
  type: "tool_call",
  callId: "toolu_notes_update",
  name: "mcp__notesoup__notes_update",
  status: "completed",
  error: null,
  detail: {
    type: "unknown",
    input: { address: "a.md", edits: [{ oldText: "old", newText: "new" }] },
    output: { output: "updated a.md (project pi-context)\ndiff:\n- 1 - old\n+ 1 + new" },
  },
} as const;

export const claudeReadFailed = {
  type: "tool_call",
  callId: "toolu_notes_read",
  name: "mcp__notesoup__notes_read",
  status: "failed",
  error: {
    type: "tool_result",
    tool_use_id: "toolu_notes_read",
    is_error: true,
    content: [{ type: "text", text: "No note at @self/foo.md." }],
  },
  detail: { type: "unknown", input: { address: "@self/foo.md" }, output: null },
} as const;

export const claudeEmptyCompleted = {
  type: "tool_call",
  callId: "toolu_empty_brain",
  name: "mcp__notesoup__empty_brain",
  status: "completed",
  error: null,
  detail: {
    type: "unknown",
    input: { last_word: "bye" },
    output: { output: "Brain will be emptied after this turn. End your turn now; do not call more tools or explain things to the human before the reset." },
  },
} as const;

export const claudeEmptyFailed = {
  type: "tool_call",
  callId: "toolu_empty_brain",
  name: "mcp__notesoup__empty_brain",
  status: "failed",
  error: {
    type: "tool_result",
    tool_use_id: "toolu_empty_brain",
    is_error: true,
    content: "notesoup: only the main agent can empty this brain",
  },
  detail: { type: "unknown", input: {}, output: null },
} as const;
