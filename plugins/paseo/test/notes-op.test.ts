import assert from "node:assert/strict";
import test from "node:test";
import { notesOpTransformer } from "../client/notes-op-transformer.ts";
import { DIFF_MAX_CHARS, PREVIEW_MAX_CHARS, READ_TEXT_MAX_CHARS, notesOpSchema } from "../shared/notes-op.ts";
import { claudeReadCompleted, claudeReadFailed, claudeUpdateCompleted, claudeWriteCompleted } from "./fixtures/claude-tool-calls.ts";

function toolCall(overrides: Record<string, unknown>) {
  return {
    type: "tool_call" as const,
    callId: "call-1",
    name: "notes_read",
    status: "completed" as const,
    error: null,
    detail: { type: "unknown" as const, input: { address: "@self/foo.md" }, output: {} },
    ...overrides,
  };
}

const transform = (overrides: Record<string, unknown>) => notesOpTransformer.transform({ item: toolCall(overrides) as never });

test("notes_read renders the structured window, marks continuation as truncated", () => {
  const result = transform({
    detail: {
      type: "unknown",
      input: { address: "@self/foo.md" },
      output: { structuredContent: { address: "@self/foo.md", text: "hello note", total_chars: 9999, next_offset_chars: 4000 } },
    },
  });
  const data = notesOpSchema.parse(result!.items[0]!.data);
  assert.deepEqual(data, { op: "read", address: "@self/foo.md", status: "completed", text: "hello note", totalChars: 9999, truncated: true });
});

test("notes_write carries outcome and a clipped content preview", () => {
  const result = transform({
    name: "notes_write",
    detail: {
      type: "unknown",
      input: { address: "session.md", content: "x".repeat(PREVIEW_MAX_CHARS + 10) },
      output: { structuredContent: { address: "session.md", outcome: "created" } },
    },
  });
  const data = notesOpSchema.parse(result!.items[0]!.data);
  assert.equal(data.op, "write");
  assert.equal(data.outcome, "created");
  assert.equal(data.preview!.length, PREVIEW_MAX_CHARS);
  assert.equal(data.truncated, true);
});

test("notes_update carries change kind, rename, and clipped diff", () => {
  const result = transform({
    name: "notes_update",
    detail: {
      type: "unknown",
      input: { address: "@project/a.md" },
      output: { structuredContent: { address: "@project/b.md", change_kind: "moved", rename_from: "@project/a.md", diff: "y".repeat(DIFF_MAX_CHARS + 10) } },
    },
  });
  const data = notesOpSchema.parse(result!.items[0]!.data);
  assert.equal(data.changeKind, "moved");
  assert.equal(data.renamedFrom, "@project/a.md");
  assert.equal(data.diff!.length, DIFF_MAX_CHARS);
  assert.equal(data.truncated, true);
});

test("wire errors and failed calls surface the refusal text", () => {
  const refused = transform({
    detail: { type: "unknown", input: { address: "@self/foo.md" }, output: { structuredContent: { error: "No note at @self/foo.md.", code: "not_found" } } },
  });
  assert.equal(notesOpSchema.parse(refused!.items[0]!.data).error, "No note at @self/foo.md.");

  const failed = transform({
    status: "failed",
    error: { message: "boom" },
    detail: { type: "unknown", input: { address: "@self/foo.md" }, output: { content: [{ type: "text", text: "io failed" }] } },
  });
  assert.equal(notesOpSchema.parse(failed!.items[0]!.data).error, "io failed");
});

test("running calls render from input alone; long reads clip to the card budget", () => {
  const running = transform({ status: "running", detail: { type: "unknown", input: { address: "@human/map.md" }, output: null } });
  assert.deepEqual(notesOpSchema.parse(running!.items[0]!.data), { op: "read", address: "@human/map.md", status: "running" });

  const long = transform({
    detail: { type: "unknown", input: { address: "big.md" }, output: { structuredContent: { address: "big.md", text: "z".repeat(READ_TEXT_MAX_CHARS + 500), total_chars: 50000, next_offset_chars: null } } },
  });
  const data = notesOpSchema.parse(long!.items[0]!.data);
  assert.equal(data.text!.length, READ_TEXT_MAX_CHARS);
  assert.equal(data.truncated, true);
  assert.ok(JSON.stringify(result_items(long)).length < 64 * 1024, "plugin payload stays under the timeline limit");
});

test("history replay has no structured payload: the rendered text is parsed instead", () => {
  const read = transform({
    detail: { type: "unknown", input: { address: "@self/foo.md" }, output: { content: [{ type: "text", text: "@self/foo.md\norigin self | created 2026-10-15 | updated 2026-10-15\n\nbody line one\nbody line two" }] } },
  });
  assert.equal(notesOpSchema.parse(read!.items[0]!.data).text, "body line one\nbody line two");

  const write = transform({
    name: "notes_write",
    detail: { type: "unknown", input: { address: "a.md", content: "the new body" }, output: { content: [{ type: "text", text: "overwrote a.md (project pi-context)" }] } },
  });
  const writeData = notesOpSchema.parse(write!.items[0]!.data);
  assert.equal(writeData.outcome, "overwrote");
  assert.equal(writeData.preview, "the new body", "replay carries the call arguments, so the content preview comes from input on every path");

  const update = transform({
    name: "notes_update",
    detail: { type: "unknown", input: { address: "a.md" }, output: { content: [{ type: "text", text: "updated a.md\ndiff:\n- 1 - old\n+ 1 + new" }] } },
  });
  const updateData = notesOpSchema.parse(update!.items[0]!.data);
  assert.equal(updateData.changeKind, "body");
  assert.equal(updateData.diff, "- 1 - old\n+ 1 + new");

  const moved = transform({
    name: "notes_update",
    detail: { type: "unknown", input: { address: "a.md" }, output: { content: [{ type: "text", text: "moved a.md -> b.md" }] } },
  });
  assert.equal(notesOpSchema.parse(moved!.items[0]!.data).changeKind, "moved");
});

test("non-notes tools, unknown shapes and missing addresses stay untouched", () => {
  for (const name of ["bash", "mcp__other__notes_read", "mcp__notesoup_extra__notes_write", "mcp__notesoup__notes_list", "mcp__notesoup__mcp__notesoup__notes_read"]) {
    assert.equal(transform({ name }), undefined, name);
  }
  assert.equal(notesOpTransformer.transform({ item: toolCall({ detail: { type: "plain_text", text: "hi" } }) as never }), undefined);
  assert.equal(notesOpTransformer.transform({ item: toolCall({ detail: { type: "unknown", input: {}, output: {} } }) as never }), undefined);
  assert.equal(notesOpTransformer.transform({ item: { type: "user_message", text: "hi" } as never }), undefined);
});

test("Claude completed calls use the adapter's output text for read, write preview and update diff", () => {
  const read = notesOpSchema.parse(transform(claudeReadCompleted)!.items[0]!.data);
  assert.deepEqual(read, { op: "read", address: "@self/foo.md", status: "completed", text: "body line one\nbody line two" });
  assert.deepEqual(notesOpSchema.parse(transform(claudeWriteCompleted)!.items[0]!.data), {
    op: "write", address: "a.md", status: "completed", outcome: "overwrote", preview: "the new body",
  });
  assert.deepEqual(notesOpSchema.parse(transform(claudeUpdateCompleted)!.items[0]!.data), {
    op: "update", address: "a.md", status: "completed", changeKind: "body", diff: "- 1 - old\n+ 1 + new",
  });
});

test("Claude running calls render from input with null output", () => {
  for (const [op, call] of [["read", claudeReadCompleted], ["write", claudeWriteCompleted], ["update", claudeUpdateCompleted]] as const) {
    const running = transform({ ...call, status: "running", detail: { ...call.detail, output: null } });
    assert.deepEqual(notesOpSchema.parse(running!.items[0]!.data), { op, address: call.detail.input.address, status: "running" });
  }
});

test("Claude failures keep raw error content and transport messages instead of parsing them as notes", () => {
  assert.deepEqual(notesOpSchema.parse(transform(claudeReadFailed)!.items[0]!.data), {
    op: "read", address: "@self/foo.md", status: "failed", error: "No note at @self/foo.md.",
  });
  const write = transform({
    ...claudeWriteCompleted, status: "failed",
    detail: { ...claudeWriteCompleted.detail, output: null },
    error: { type: "tool_result", tool_use_id: claudeWriteCompleted.callId, is_error: true, content: "Disk full" },
  });
  assert.deepEqual(notesOpSchema.parse(write!.items[0]!.data), { op: "write", address: "a.md", status: "failed", error: "Disk full" });
  const update = transform({
    ...claudeUpdateCompleted, status: "failed", error: { message: "MCP connection closed" },
    detail: { ...claudeUpdateCompleted.detail, output: null },
  });
  assert.deepEqual(notesOpSchema.parse(update!.items[0]!.data), { op: "update", address: "a.md", status: "failed", error: "MCP connection closed" });
});

function result_items(result: { items: Array<{ data: unknown }> } | undefined) {
  return result!.items.map((item) => item.data);
}

test("a crumple call is marked from the input alone", () => {
  const result = transform({
    name: "notes_update",
    detail: {
      type: "unknown",
      input: { address: "@self/stale.md", crumpled: true },
      output: { structuredContent: { address: "@self/stale.md", change_kind: "metadata" } },
    },
  });
  const data = notesOpSchema.parse(result!.items[0]!.data);
  assert.equal(data.crumpled, true);
  assert.equal(transform({ name: "notes_update", detail: { type: "unknown", input: { address: "@self/a.md", crumpled: false }, output: { structuredContent: { address: "@self/a.md", change_kind: "metadata" } } } })!
    .items[0]!.data.crumpled, undefined);
});
